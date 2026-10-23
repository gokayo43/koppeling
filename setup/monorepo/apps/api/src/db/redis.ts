import { RedisClient } from "bun";
import { Effect } from "effect";

import { env } from "../env.ts";
import { RedisError } from "../errors.ts";

// Cache, locks, queues and cross-process state. Like the database pool, the
// connection is a process-level resource that main.ts closes on shutdown.
//
// The connect timeout is what keeps the health route honest: the probe has a
// deadline, so a Redis that is merely unreachable has to surface as a failure
// rather than as a request that never answers.
export const redis = new RedisClient(env.REDIS_URL, { connectionTimeout: 2_000 });

export class Cache extends Effect.Service<Cache>()("Cache", {
  succeed: {
    ping: Effect.tryPromise({
      try: () => redis.ping(),
      catch: (cause) => new RedisError({ cause }),
    }),
  },
}) {}
