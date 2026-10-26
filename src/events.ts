import { Cause, Effect } from "effect";
import type { JWTPayload } from "jose";

import type { KoppelingEvent, WriteOutcome } from "./door";

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
