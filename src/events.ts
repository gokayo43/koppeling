import { Cause, Effect } from "effect";
import type { JWTPayload } from "jose";

/**
 * What a write came to: the program's value, its refusal, a failure before the
 * program was reached (nothing changed), or `unknown`: the program was reached
 * and its answer was lost or late, so the change may have been made.
 */
export type WriteOutcome = "value" | "refusal" | "failure" | "unknown";

/**
 * What the door tells the host's logger. `write`: one per call of a write
 * operation, naming the person and the program acting for them. `failure`: a
 * failure the person was answered with the door's own sentence for; its
 * `operation` is null when the sign-in failed (the key set, or `actorFor`).
 */
export type KoppelingEvent =
  | {
      readonly kind: "write";
      readonly operation: string;
      readonly sub: string | null;
      readonly name: string | null;
      readonly via: string | null;
      readonly outcome: WriteOutcome;
    }
  | { readonly kind: "failure"; readonly operation: string | null; readonly cause: unknown };

export type Report = (event: KoppelingEvent) => Effect.Effect<void>;

/** The host's logger, or Effect's own when the host names none. */
export function reporter(log: ((event: KoppelingEvent) => void) | undefined): Report {
  if (log !== undefined) return (event) => Effect.sync(() => log(event));
  return (event) =>
    event.kind === "write"
      ? Effect.logInfo("koppeling write").pipe(
          Effect.annotateLogs({
            operation: event.operation,
            sub: event.sub,
            name: event.name,
            via: event.via,
            outcome: event.outcome,
          }),
        )
      : Effect.logError(
          event.operation === null
            ? "koppeling sign-in failed"
            : `koppeling ${event.operation} failed`,
          Cause.die(event.cause),
        );
}

/** The write event for `operation`, its person read from the token's claims. */
export function writeEvent(
  operation: string,
  claims: JWTPayload,
  outcome: WriteOutcome,
): KoppelingEvent {
  const text = (key: string) => {
    const value = claims[key];
    return typeof value === "string" ? value : null;
  };
  return {
    kind: "write",
    operation,
    sub: text("sub"),
    name: text("name"),
    via: text("via"),
    outcome,
  };
}
