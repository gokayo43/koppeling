import { Cause, Effect } from "effect";
import type { JWTPayload } from "jose";

import type { Kind } from "./catalogue";
import type { KoppelingEvent, WriteOutcome } from "./door";

export type Report = (event: KoppelingEvent) => Effect.Effect<void>;

/** The host's logger, or Effect's own when the host names none. */
export function reporter(log: ((event: KoppelingEvent) => void) | undefined): Report {
  if (log !== undefined) return (event) => Effect.sync(() => log(event));
  return (event) =>
    event.kind === "failure"
      ? Effect.logError(
          event.operation === null
            ? "koppeling sign-in failed"
            : `koppeling ${event.operation} failed`,
          Cause.die(event.cause),
        )
      : Effect.logInfo(`koppeling ${event.kind}`).pipe(
          Effect.annotateLogs({
            operation: event.operation,
            sub: event.sub,
            name: event.name,
            via: event.via,
            outcome: event.outcome,
          }),
        );
}

/**
 * The event of one run of `operation`, of the tool's kind, its person read from
 * the token's claims. A read changes nothing, so a read whose answer was lost
 * or late came to a failure.
 */
export function runEvent(
  kind: Kind,
  operation: string,
  claims: JWTPayload,
  outcome: WriteOutcome,
): KoppelingEvent {
  const text = (key: string) => {
    const value = claims[key];
    return typeof value === "string" ? value : null;
  };
  const person = { operation, sub: text("sub"), name: text("name"), via: text("via") };
  return kind === "write"
    ? { kind, ...person, outcome }
    : { kind, ...person, outcome: outcome === "unknown" ? "failure" : outcome };
}
