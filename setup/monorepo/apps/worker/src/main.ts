import { BunRuntime } from "@effect/platform-bun";
import { Effect, Schedule } from "effect";
import { Db } from "project-template-api/db/client.ts";
import { AppLayer } from "project-template-api/runtime.ts";

/**
 * In-process periodic work. `Schedule` owns the cadence, so the loop is
 * interruptible and testable against a TestClock instead of a real sleep; jobs
 * that must survive a restart and retry per item belong in BullMQ instead.
 *
 * BunRuntime.runMain wires SIGINT/SIGTERM to fiber interruption, so the loop and
 * every scoped resource wind down cleanly on `docker compose stop`.
 *
 * A tick that keeps failing ends the process, which is this container's whole
 * liveness signal — `apps/worker/tests/exit.test.ts` is that contract, and
 * docker-compose.yml's healthcheck waiver names it.
 */
const tick = Effect.gen(function* () {
  const database = yield* Db;
  yield* database.ping;
  yield* Effect.logInfo("worker tick");
});

// Three attempts, a second then two apart, before a tick is allowed to fail. A
// datastore that blinks for a moment is not worth restarting a container over,
// and three seconds is long enough to tell a blink from an outage while staying
// far inside the cadence below — so a tick never overlaps the next one.
const program = tick.pipe(
  Effect.retry(Schedule.exponential("1 second").pipe(Schedule.intersect(Schedule.recurs(2)))),
  Effect.repeat(Schedule.spaced("60 seconds")),
  Effect.provide(AppLayer),
);

BunRuntime.runMain(program);
