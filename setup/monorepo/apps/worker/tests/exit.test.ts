import { expect, test } from "bun:test";

/**
 * What `docker-compose.yml`'s `x-no-healthcheck` on the `worker` service points
 * at. The waiver claims there is nothing for a probe to talk to, and this is the
 * half of that claim a test can hold: the program has no failure it survives
 * indefinitely, so the container being up *is* the report — which is only true
 * while a tick that keeps failing still ends the process. Put a `catchAll` back
 * around the loop and this test stops finishing, which is exactly what the
 * waiver would have stopped being true.
 */
const PROGRAM = new URL("../src/main.ts", import.meta.url).pathname;
const PACKAGE = new URL("..", import.meta.url).pathname;

/**
 * The spawn is given longer than the retries it has to sit through (a second,
 * then two), and the case longer than the spawn — so a loop that survives fails
 * on the assertion rather than on bun's own five-second bound.
 */
const SPAWN_PATIENCE = 15_000;
const CASE_PATIENCE = 30_000;

test(
  "a tick that cannot reach the database ends the process",
  async () => {
    const proc = Bun.spawn(["bun", PROGRAM], {
      cwd: PACKAGE,
      env: {
        PATH: process.env["PATH"] ?? "",
        // Addresses nothing answers on, so every attempt's schema probe fails.
        DATABASE_URL: "postgres://probe:probe@127.0.0.1:1/probe",
        REDIS_URL: "redis://127.0.0.1:1",
      },
      // The failure report is on stdout, not stderr: the composition root
      // installs `Logger.json` and removes runMain's pretty logger, so what a
      // dying worker leaves behind is one JSON record where `docker logs`
      // collects it. Reading the wrong stream here would assert against an
      // empty string and pass on anything.
      stdout: "pipe",
      stderr: "ignore",
      timeout: SPAWN_PATIENCE,
      // SIGKILL rather than the default SIGTERM, because this program handles
      // SIGTERM: `BunRuntime.runMain` takes it as a shutdown and leaves 0
      // behind, which is exactly the answer a loop that never failed would have
      // given.
      killSignal: "SIGKILL",
    });

    const said = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // The tick's own failure, named: it is what says the process ended because
    // the probe could not reach the database, rather than for any other reason
    // that also exits.
    expect(said).toContain('"logLevel":"ERROR"');
    expect(said).toContain("DbError");
    // Set only if the timeout above had to kill it, which is the rest of the
    // assertion: a program that had to be killed was still running, whatever
    // the tick did.
    expect(proc.signalCode).toBeNull();
    expect(code).not.toBe(0);
  },
  CASE_PATIENCE,
);
