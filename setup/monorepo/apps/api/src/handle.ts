import { Cause, Effect } from "effect";
import { status } from "elysia";

import type { DbError, NotFound, RedisError } from "./errors.ts";
import { Sentry } from "./instrument.ts";
import { runtime, type AppServices } from "./runtime.ts";

/**
 * The single seam between Elysia and Effect: a route body is an Effect, and this
 * renders its typed failures onto the wire. Every failure the domain can carry
 * to the edge is named below, so the compiler rejects a route whose error
 * channel grows a tag this map does not answer for.
 *
 * Failures leave as Elysia `status()` values rather than plain objects, which is
 * what keeps them out of the success type: Eden sorts them into the treaty
 * client's `error` channel instead of widening `data` into a union the caller
 * has to narrow by shape.
 */
type RouteFailure = DbError | RedisError | NotFound;

// A datastore outage and a defect are the same thing to a caller: the request
// cannot be served. Both answer 503 so the client retries instead of caching a
// lie, and both are reported rather than swallowed.
const unavailable = (cause: unknown) =>
  Effect.logError("request failed", cause).pipe(
    Effect.zipRight(Effect.sync(() => Sentry.captureException(cause))),
    Effect.as(status(503, { error: "unavailable" })),
  );

export function handle<A>(effect: Effect.Effect<A, RouteFailure, AppServices>) {
  return runtime.runPromise(
    effect.pipe(
      Effect.catchTags({
        NotFound: (error) => Effect.succeed(status(404, { error: `${error.what} not found` })),
        DbError: unavailable,
        RedisError: unavailable,
      }),
      Effect.tapDefect((cause) => Effect.sync(() => Sentry.captureException(Cause.squash(cause)))),
    ),
  );
}
