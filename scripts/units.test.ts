// The reporting layer: the unit files, and the one script they call. Nothing
// here installs, enables or starts anything — the units are read for the
// command lines they declare, and those command lines are then run directly,
// the way systemd would run them.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = new URL(".", import.meta.url).pathname;

function beside(name: string): Promise<string> {
  return Bun.file(join(SCRIPTS, name)).text();
}

/** A directive's words, split the way systemd splits a command line. */
async function directive(unit: string, key: string): Promise<string[]> {
  const found = new RegExp(`^${key}=(.*)$`, "m").exec(await beside(unit));
  expect(found, `${unit} declares no ${key}=`).not.toBeNull();
  return (found?.[1] ?? "").split(/\s+/).filter((word) => word !== "");
}

/** What follows a flag on a command line. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

const JOBS = ["backup.service", "restore-drill.service"];

describe("how a job gets reported", () => {
  // The watchdog knows a job by one name and 404s on any other, so the run
  // that succeeded and the run that failed have to arrive under the same slug.
  // The wrong implementation is `OnFailure=...@%n.service`, which names the
  // unit — and it fails where nobody is watching, in the handler for a job that
  // has already failed.
  test.each(JOBS)("%s reports success and failure under one slug", async (unit) => {
    const [, route, slug] = await directive(unit, "ExecStartPost");
    expect(route).toBe("heartbeat");
    expect(slug).toBeTruthy();
    expect((await directive(unit, "OnFailure"))[0]).toBe(
      `project-template-notify-failure@${slug}.service`,
    );
  });

  // A heartbeat has to mean THE SCHEDULED RUN happened. ExecStartPost= is what
  // makes it mean that: measured on systemd 255, it runs only when ExecStart
  // exited 0, and nothing but the unit can start it.
  test.each(JOBS)("%s heartbeats through the notifier that ships beside it", async (unit) => {
    const [program] = await directive(unit, "ExecStartPost");
    expect(program).toBe("/opt/project-template/scripts/notify.sh");
    expect(await Bun.file(join(SCRIPTS, "notify.sh")).exists()).toBe(true);
  });

  // An instance each, which is also what makes systemd hand the handler
  // MONITOR_UNIT: it withholds those variables when several services trigger
  // one handler.
  test("the two jobs do not share a handler instance", async () => {
    const [backup, drill] = await Promise.all(JOBS.map((u) => directive(u, "OnFailure")));
    expect(backup?.[0]).not.toBe(drill?.[0]);
  });

  // %i is the slug; the failed unit's own name arrives in MONITOR_UNIT, which
  // systemd expands here (measured). %I would unescape the slug on the way in,
  // turning every `-` into a `/`, and name a job the watchdog has never heard
  // of.
  test("the handler passes the slug and the unit systemd names", async () => {
    const argv = await directive("notify-failure@.service", "ExecStart");
    expect(argv[0]).toBe("/opt/project-template/scripts/notify.sh");
    expect(argv.slice(1)).toEqual(["failure", "%i", "${MONITOR_UNIT}"]);
    expect(argv).not.toContain("%I");
  });

  // systemd's unit namespace is the whole box and every repo scaffolded from
  // this one ships a handler, so the template goes in under this project's
  // name — and an OnFailure= naming anything else is a dependency that never
  // resolves.
  test("the handler the OnFailure lines name is the one the README installs", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    expect(readme).toContain("project-template-notify-failure@.service");
  });
});

describe("the drill the timer runs", () => {
  // Ownership is the flag. Under --project the drill decides from the stack's
  // own state, and the first run to find the scratch stack already up — which
  // is every run after a failed one — hands a full copy of production back to
  // nobody and leaves it on the disk.
  test("is handed a scratch stack of its own to own", async () => {
    const argv = await directive("restore-drill.service", "ExecStart");
    expect(argv[0]).toBe("/opt/project-template/scripts/restore-drill.sh");
    expect(valueOf(argv, "--scratch-project")).toBe("project-template-drill");
    expect(argv).not.toContain("--project");
  });

  // A RuntimeDirectory= here is what split the lock in two: the unit locks in
  // the directory systemd made it, a person locks in their session's, and the
  // one collision worth catching — the timer against a hand run — goes
  // uncaught. The drill locks beside the checkout instead, which both resolve.
  test("is given no runtime directory of its own to lock in", async () => {
    expect(await beside("restore-drill.service")).not.toContain("RuntimeDirectory=");
  });
});

describe("the notifier itself", () => {
  let home = "";
  let log = "";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "notify-"));
    log = join(home, "curl.log");
    // argv and stdin kept apart: which of the two the token arrives in is the
    // point of the whole arrangement.
    await writeFile(
      join(home, "curl"),
      `#!/usr/bin/env bash\nprintf "argv %s\\n" "$*" >> "${log}"\n` +
        `while IFS= read -r line; do printf "stdin %s\\n" "$line" >> "${log}"; done\n` +
        `exit "\${FAKE_CURL_FAILS:-0}"\n`,
      { mode: 0o755 },
    );
    // No `name:`. The notifier must not care: it runs when a job has already
    // failed, and a stack guard exiting underneath it would swallow the alert.
    await writeFile(join(home, "docker-compose.yml"), "services:\n  postgres:\n    image: pg\n");
  });

  async function notify(args: string[], env: Record<string, string> = {}) {
    await rm(log, { force: true });
    const run = Bun.spawn(["bash", join(SCRIPTS, "notify.sh"), ...args], {
      env: {
        ...process.env,
        PATH: `${home}:${process.env["PATH"] ?? ""}`,
        REPO_DIR: home,
        COMPOSE_FILE: join(home, "docker-compose.yml"),
        HEARTBEAT_URL: "",
        HEARTBEAT_TOKEN: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    const file = Bun.file(log);
    const sent = (await file.exists()) ? await file.text() : "";
    const lines = sent.split("\n").filter((line) => line !== "");
    return {
      exitCode,
      out: `${stdout}${stderr}`,
      argv: lines.filter((line) => line.startsWith("argv ")).join("\n"),
      stdin: lines.filter((line) => line.startsWith("stdin ")).join("\n"),
      posted: lines.length > 0,
    };
  }

  const watched = { HEARTBEAT_URL: "https://watch.example/api", HEARTBEAT_TOKEN: "s3cret" };

  // This runs as ExecStartPost=. A watchdog that blackholes packets hangs an
  // unbounded curl until the job's own TimeoutStartSec kills it, and systemd
  // then fails a unit whose ExecStart succeeded — a page for a backup that
  // worked. Measured: unbounded gives Result=timeout, bounded Result=success.
  // The wrong implementation is the one with no bound at all.
  test("every ping is bounded, so a blackholed watchdog cannot fail the job", async () => {
    const { argv } = await notify(["heartbeat", "shop-backup"], watched);
    expect(argv).toContain("--connect-timeout 10");
    expect(argv).toContain("--max-time 30");
  });

  test("a heartbeat is a POST to the slug's heartbeat route", async () => {
    const { exitCode, argv } = await notify(["heartbeat", "shop-backup"], watched);
    expect(exitCode).toBe(0);
    expect(argv).toContain("https://watch.example/api/heartbeat/shop-backup");
    // Nothing to carry, so the method is named rather than implied.
    expect(argv).toContain("-X POST");
    expect(argv).not.toContain("--data");
  });

  // --data is a POST on its own. Sending both is how a request ends up
  // declaring a method twice and meaning it once.
  test("a failure carries the unit as its body, and does not name a method too", async () => {
    const { exitCode, argv } = await notify(
      ["failure", "shop-drill", "project-template-restore-drill.service"],
      watched,
    );
    expect(exitCode).toBe(0);
    expect(argv).toContain("https://watch.example/api/failure/shop-drill");
    expect(argv).toContain("--data project-template-restore-drill.service");
    expect(argv).not.toContain("-X POST");
  });

  // systemd withholds MONITOR_UNIT when one handler serves several jobs, and
  // before 251 there is no such variable at all. Withholding the alert to
  // protect the body is backwards — the slug already names the job.
  test("a failure with no unit named is still reported", async () => {
    const { exitCode, argv } = await notify(["failure", "shop-drill"], watched);
    expect(exitCode).toBe(0);
    expect(argv).toContain("https://watch.example/api/failure/shop-drill");
    expect(argv).toContain("-X POST");
  });

  // It runs after a job has already failed. Sourcing the stack helpers made a
  // compose file with no `name:` exit 2 here, and the alert was never sent.
  test("a compose file that names no project does not stop the alert", async () => {
    const { exitCode, argv } = await notify(["failure", "shop-backup"], watched);
    expect(exitCode).toBe(0);
    expect(argv).toContain("/failure/shop-backup");
  });

  // The bearer is a secret and a command line is public: every local user's
  // `ps` reads it for as long as the request is open.
  test("the token travels on stdin and never on the command line", async () => {
    const { stdin, argv } = await notify(["heartbeat", "shop-backup"], watched);
    expect(stdin).toContain("authorization: Bearer s3cret");
    expect(argv).not.toContain("s3cret");
    expect(argv).not.toContain("authorization");
  });

  // `-H @-` takes the line as it stands. A transport that parses what it is
  // handed — curl's own --config route reads a quoted value as C-ish text —
  // ends the value early at an unescaped `"` and sends a bearer that is wrong
  // rather than missing, and a 401 nobody traces back to the token.
  test("a token holding curl's own metacharacters arrives whole", async () => {
    const { stdin } = await notify(["heartbeat", "shop-backup"], {
      ...watched,
      HEARTBEAT_TOKEN: 'a"b\\c',
    });
    expect(stdin).toBe('stdin authorization: Bearer a"b\\c');
  });

  test("the watchdog can be configured from .env rather than the environment", async () => {
    const settings = join(home, ".env");
    await writeFile(settings, "HEARTBEAT_URL=https://from-dotenv.example\nHEARTBEAT_TOKEN=t0k\n");
    try {
      const { exitCode, argv, stdin } = await notify(["heartbeat", "shop-backup"]);
      expect(exitCode).toBe(0);
      expect(argv).toContain("https://from-dotenv.example/heartbeat/shop-backup");
      expect(stdin).toContain("Bearer t0k");
    } finally {
      await rm(settings, { force: true });
    }
  });

  test.each([
    ["neither", {}],
    ["a url with no token", { HEARTBEAT_URL: watched.HEARTBEAT_URL }],
    ["a token with no url", { HEARTBEAT_TOKEN: watched.HEARTBEAT_TOKEN }],
  ])("a box configured with %s posts nothing", async (_which, env) => {
    const { exitCode, posted } = await notify(["heartbeat", "shop-backup"], env);
    expect(exitCode).toBe(0);
    expect(posted).toBe(false);
  });

  // The job did its work. A watchdog that cannot be reached is the watchdog's
  // problem, and the alert for a heartbeat that never arrived is the same alert.
  test("a ping that does not land is said out loud and fails nothing", async () => {
    const { exitCode, out } = await notify(["heartbeat", "shop-backup"], {
      ...watched,
      FAKE_CURL_FAILS: "7",
    });
    expect(exitCode).toBe(0);
    expect(out).toContain("did not reach");
  });

  // The routes are literals in unit files. A typo would otherwise be a POST to
  // a path the watchdog 404s — for ever, and in silence, since a ping that does
  // not land is not fatal here.
  test("a route that is neither is refused before anything is sent", async () => {
    const { exitCode, out, posted } = await notify(["heartbeta", "shop-backup"], watched);
    expect(exitCode).toBe(2);
    expect(out).toContain("is not a route");
    expect(posted).toBe(false);
  });
});
