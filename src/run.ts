import { Data, Duration, Effect } from "effect";
import type { JWTPayload } from "jose";

import type { Kind, Outcome } from "./catalogue";
import { copy } from "./copy";
import { neighbours, type Directory } from "./directory";
import { writeEvent, type Report, type WriteOutcome } from "./events";
import type { Json, JsonObject } from "./json";

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
}

export interface Answer {
  readonly text: string;
  readonly structured?: JsonObject;
  readonly isError?: true;
}

export const refusal = (text: string): Answer => ({ text, isError: true });

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
  readonly answered: Answer;
}

const settled = (outcome: WriteOutcome, answered: Answer): Settled => ({ outcome, answered });

class NotReached extends Data.TaggedError("NotReached")<{ readonly cause: unknown }> {}
class TimedOut extends Data.TaggedError("TimedOut") {}

/**
 * Runs the named operation once, as the session's person, through the tool
 * of its kind: a read through `read`, a write through `write`. The program's
 * refusal comes back as a tool error carrying its sentence. A failure is
 * reported and answered with the door's own sentence, so a database's words
 * never reach the person; for a write that reached the program, that sentence
 * says the change may have been made. Every write leaves one write event.
 */
export function call<Actor>(
  session: Session<Actor>,
  tool: Kind,
  name: string,
  input: Json | undefined,
): Effect.Effect<Answer> {
  const operation = session.directory.byName.get(name);
  if (operation === undefined) return Effect.succeed(unknownOperation(session.directory, name));
  if (operation.kind !== tool) return Effect.succeed(refusal(copy.wrongTool(name, operation.kind)));
  const write = operation.kind === "write";
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
  return Effect.tryPromise({
    try: (signal) => operation.run(session.actor, input, signal),
    catch: (cause) => new NotReached({ cause }),
  }).pipe(
    Effect.timeoutFail({ duration: OPERATION_TIME_LIMIT, onTimeout: () => new TimedOut() }),
    Effect.flatMap((outcome: Outcome) => {
      if ("value" in outcome) {
        const value = outcome.value;
        return Effect.succeed(
          settled("value", { text: JSON.stringify(value), structured: { result: value } }),
        );
      }
      if ("refusal" in outcome) return Effect.succeed(settled("refusal", refusal(outcome.refusal)));
      return failed(outcome.failed, true);
    }),
    Effect.catchTags({
      NotReached: ({ cause }) => failed(cause, false),
      TimedOut: () =>
        Effect.succeed(settled("unknown", refusal(write ? copy.writeTimedOut : copy.readTimedOut))),
    }),
    Effect.tap(({ outcome }) =>
      write ? session.report(writeEvent(name, session.claims, outcome)) : Effect.void,
    ),
    Effect.map(({ answered }) => answered),
  );
}
