import { expect, test } from "bun:test";

/**
 * What `docker-compose.yml`'s `x-no-healthcheck` on the `migrate` service points
 * at. The waiver claims the container has no steady state to probe, and this is
 * that claim: the program applies the migrations and returns, so by the time
 * anything could knock on it the process is gone. A `migrate` that grew a retry
 * loop or a listener would answer a probe — and would also hang this test,
 * which is the shape the assertions below take.
 *
 * The success path needs a live Postgres and is proved in CI by the database
 * job, which runs the migrations for real; what is left here is that neither
 * failure keeps the process alive, and that each one ended for the reason the
 * case is about rather than for some other reason that also exits.
 */
const PROGRAM = new URL("../src/db/migrate.ts", import.meta.url).pathname;
const PACKAGE = new URL("..", import.meta.url).pathname;

/**
 * Long enough that a slow machine is not the reason, short enough to notice —
 * and the case is given longer than the spawn, so a program that never returns
 * fails on the assertion rather than on bun's own five-second bound.
 */
const SPAWN_PATIENCE = 15_000;
const CASE_PATIENCE = 30_000;

async function run(env: Record<string, string>): Promise<{ code: number | null; said: string }> {
  const proc = Bun.spawn(["bun", PROGRAM], {
    cwd: PACKAGE,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdout: "ignore",
    stderr: "pipe",
    timeout: SPAWN_PATIENCE,
    // SIGKILL rather than the default SIGTERM, so that a program which grew a
    // handler for it cannot answer the timeout with a tidy 0 and look like one
    // that had finished.
    killSignal: "SIGKILL",
  });
  const said = await new Response(proc.stderr).text();
  const code = await proc.exited;
  // Set only if the timeout above had to kill it, which is the whole assertion:
  // a program that had to be killed is one a healthcheck could have talked to.
  expect(proc.signalCode).toBeNull();
  return { code, said };
}

test(
  "the migration program refuses to start without a database to migrate",
  async () => {
    const { code, said } = await run({});
    expect(said).toContain("DATABASE_URL is not set");
    expect(code).toBe(1);
  },
  CASE_PATIENCE,
);

test(
  "the migration program ends rather than waiting for a database that is not there",
  async () => {
    const { code, said } = await run({ DATABASE_URL: "postgres://probe:probe@127.0.0.1:1/probe" });
    // The program's own line, not the driver's: what a connection refusal is
    // called changes with the Bun that runs it, and this case is about the
    // migration ending rather than about anyone's wording for a closed port.
    expect(said).toContain("migrations failed:");
    expect(code).toBe(1);
  },
  CASE_PATIENCE,
);
