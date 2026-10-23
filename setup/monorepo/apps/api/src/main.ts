import { serve, stop } from "./app.ts";
import { client } from "./db/client.ts";
import { redis } from "./db/redis.ts";
import { env } from "./env.ts";
import { runtime } from "./runtime.ts";

serve({ port: env.PORT, hostname: env.HOST });

/**
 * Stop accepting first, then wind everything down: in-flight fibers finish
 * against services that are still alive, and each pool closes exactly once.
 *
 * Every close is inside the try and `process.exit` is in the finally, because
 * the exit is load-bearing rather than tidy: a Redis client whose connection
 * failed holds the event loop open even after `close()`, so a process that
 * merely stops working reaches SIGKILL instead of exiting. A throwing close
 * used to skip it — and with Sentry loaded, its unhandled-rejection handler
 * turns the resulting rejection into a warning rather than a crash, so the
 * container hangs silently until the orchestrator gives up on it.
 */
const shutdown = async (): Promise<void> => {
  let code = 0;
  try {
    await stop();
    await runtime.dispose();
    await client.close();
    redis.close();
  } catch (error) {
    // oxlint-disable-next-line no-console -- the logger's runtime is one of the things being disposed here
    console.error("shutdown failed", error);
    code = 1;
  } finally {
    process.exit(code);
  }
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
