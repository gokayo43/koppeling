import { Layer, Logger, ManagedRuntime } from "effect";

import { Db } from "./db.ts";

/**
 * The composition root. Every server module reaches the outside world through a
 * service in this layer, and `runtime.runPromise` at a route handler is the only
 * place an Effect leaves the Effect world.
 */
const AppLayer = Layer.mergeAll(Logger.json, Db.Default);

export const runtime = ManagedRuntime.make(AppLayer);
