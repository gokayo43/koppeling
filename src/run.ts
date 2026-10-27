import { Data, Duration, Effect } from "effect";
import type { JWTPayload } from "jose";

import { refusal, type Answer } from "./answer";
import type { Kind, Outcome } from "./catalogue";
import { strayKeys } from "./closed";
import { copy } from "./copy";
import { neighbours, type Directory } from "./directory";
import type { WriteOutcome } from "./door";
import { writeEvent, type Report } from "./events";
import type { Json } from "./json";
import { pageKey, paged, type Pages, type Produced } from "./pages";

/**
 * How long one operation may take before the door gives up on it. A program
 * that streams (an event stream) or hangs would otherwise hold the call, and
 * the agent waiting on it, open without end.
 */
export const OPERATION_TIME_LIMIT = Duration.seconds(60);

/** One request's person and what the door answers through. */
export interface Session<Actor> {
  readonly directory: Directory<Actor>;
  readonly actor: Actor;
  readonly claims: JWTPayload;
  readonly report: Report;
  /** The door's long answers, kept for their next pages. */
  readonly pages: Pages;
}

/** The refusal for a name no operation has: the names it most likely meant, or the areas. */
export function unknownOperation(directory: Directory<never>, name: string): Answer {
  const near = neighbours(directory, name);
  return refusal(
    near.length > 0
      ? copy.unknownOperation(name, near)
      : copy.unknownOperationArea(name, [...directory.areas.keys()]),
  );
}

interface Settled {
  readonly outcome: WriteOutcome;
  readonly produced: Produced;
}

const settled = (outcome: WriteOutcome, final: Answer): Settled => ({
  outcome,
  produced: { final },
});

class NotReached extends Data.TaggedError("NotReached")<{ readonly cause: unknown }> {}
class TimedOut extends Data.TaggedError("TimedOut") {}

/**
 * Runs the named operation once, as the session's person, through the tool
 * of its kind: a read through `read`, a write through `write`. The program's
 * refusal comes back as a tool error carrying its sentence. An operation the
 * person may run only once their login carries a scope is refused before
 * anything runs: the second layer behind the door's HTTP 403, which answers
 * such a call before it reaches here. An omitted input runs as the
 * operation's `omittedInput`. A failure is reported and
 * answered with the door's own sentence, so a database's words never reach
 * the person; for a write that reached the program, that sentence says the
 * change may have been made. Every write leaves one write event.
 *
 * A read's answer longer than a page comes in pages, `vervolg` naming the
 * next (`paged`); a write's comes whole, since a write is never run again.
 */
export function call<Actor>(
  session: Session<Actor>,
  tool: Kind,
  name: string,
  given: Json | undefined,
  vervolg?: string,
): Effect.Effect<Answer> {
  const offered = session.directory.byName.get(name);
  if (offered === undefined) return Effect.succeed(unknownOperation(session.directory, name));
  const { operation, awaits } = offered;
  if (awaits.length > 0) return Effect.succeed(refusal(copy.scopeAwaited(awaits)));
  if (operation.kind !== tool) return Effect.succeed(refusal(copy.wrongTool(name, operation.kind)));
  const write = operation.kind === "write";
  const input = given === undefined ? operation.omittedInput : given;
  const strays = strayKeys(operation.input, input);
  if (strays.length) {
    const refused = refusal(
      copy.strayKeys(strays),
      strays.map(({ at, unknown, allowed }) => ({ at, unknown, allowed })),
    );
    return write
      ? session.report(writeEvent(name, session.claims, "failure")).pipe(Effect.as(refused))
      : Effect.succeed(refused);
  }
  const failed = (cause: unknown, reached: boolean) =>
    session
      .report({ kind: "failure", operation: name, cause })
      .pipe(
        Effect.as(
          settled(
            reached ? "unknown" : "failure",
            refusal(write && reached ? copy.writeUncertain : copy.internalError),
          ),
        ),
      );
  const settle = Effect.tryPromise({
    try: (signal) => operation.run(session.actor, input, signal),
    catch: (cause) => new NotReached({ cause }),
  }).pipe(
    Effect.timeoutFail({ duration: OPERATION_TIME_LIMIT, onTimeout: () => new TimedOut() }),
    Effect.flatMap((outcome: Outcome) => {
      if ("value" in outcome) {
        const value = outcome.value;
        const whole = JSON.stringify(value);
        return Effect.succeed({
          outcome: "value" as const,
          produced: { whole, fitting: { text: whole, structured: { result: value } } },
        });
      }
      if ("refusal" in outcome) {
        return Effect.succeed(settled("refusal", refusal(outcome.refusal, outcome.details)));
      }
      return failed(outcome.failed, true);
    }),
    Effect.catchTags({
      NotReached: ({ cause }) => failed(cause, false),
      TimedOut: () =>
        Effect.succeed(settled("unknown", refusal(write ? copy.writeTimedOut : copy.readTimedOut))),
    }),
  );
  if (write) {
    return settle.pipe(
      Effect.tap(({ outcome }) => session.report(writeEvent(name, session.claims, outcome))),
      Effect.map(({ produced }) => ("final" in produced ? produced.final : produced.fitting)),
    );
  }
  return paged(
    session.pages,
    pageKey(String(session.claims.sub), "read", name, input),
    vervolg,
    settle.pipe(Effect.map(({ produced }) => produced)),
  );
}
