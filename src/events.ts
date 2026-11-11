import { Cause, Effect } from "effect";
import type { JWTPayload } from "jose";

import type { KoppelingEvent } from "./door";

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

/** The person a read or write event names, as the token's claims name them. */
export function personOf(claims: JWTPayload) {
  const text = (key: string) => {
    const value = claims[key];
    return typeof value === "string" ? value : null;
  };
  return { sub: text("sub"), name: text("name"), via: text("via") };
}
