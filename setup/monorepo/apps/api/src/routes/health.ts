import { Effect } from "effect";
import { Elysia } from "elysia";

import { Db } from "../db/client.ts";
import { Cache } from "../db/redis.ts";
import { handle } from "../handle.ts";

/**
 * Readiness for the container healthcheck and the uptime probe. 200 says this
 * instance can serve: both datastores answered, and the database carries the
 * schema this code queries — so an app that started before its migrations ran
 * reports degraded rather than healthy. Anything else answers 503, so the
 * orchestrator stops routing here rather than serving errors from this instance.
 */
export const health = new Elysia().get("/health", () =>
  handle(
    Effect.gen(function* () {
      const database = yield* Db;
      const cache = yield* Cache;
      yield* Effect.all([database.ping, cache.ping], { concurrency: "unbounded" });
      return { status: "ok" } as const;
    }),
  ),
);
