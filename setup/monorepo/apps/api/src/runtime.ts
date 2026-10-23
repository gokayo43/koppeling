import { Layer, Logger, ManagedRuntime } from "effect";

import { Db } from "./db/client.ts";
import { Cache } from "./db/redis.ts";

/**
 * The composition root: every service the program owns, plus the logger,
 * composed once. One line of JSON per log record on stdout — docker logs is the
 * sink — so the HTTP edge and any long-running job log identically.
 *
 * `Logger.json` only replaces the *default* logger. `BunRuntime.runMain`
 * installs a second, pretty one of its own, so a daemon on this layer would
 * otherwise print every record twice: once as JSON and once as prose.
 */
export const AppLayer = Layer.mergeAll(
  Logger.json,
  Logger.remove(Logger.prettyLoggerDefault),
  Db.Default,
  Cache.Default,
);

/** Every service a program on this runtime may ask for. */
export type AppServices = Layer.Layer.Success<typeof AppLayer>;

export const runtime = ManagedRuntime.make(AppLayer);
