// Where the preview ramp would send its load, without a daemon and without k6.
//
// A load generator aimed at the wrong port is a load test against production,
// so the questions here are the ones asked before any traffic exists: does it
// refuse when the stack it measures is not up, and when it is, does it reach
// the route this repo's own CI ramps, on the port the preview published it on.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RAMP = new URL("./preview-capacity.sh", import.meta.url).pathname;

/** The ports preview.sh claimed, which is all this script reads back out. */
const PREVIEW_ENV = "WEB_PORT=5190\nAPI_PORT=5191\n";

/**
 * The shipped workflow, in the two shapes it comes in. The single shape names
 * neither input and takes check.yml's defaults, so the ramp has to reach the
 * same place from a file that says nothing.
 */
const SHIPPED = {
  single: "jobs:\n  check:\n    with:\n      database: true\n      capacity-path: /, /login\n",
  monorepo: [
    "jobs:",
    "  check:",
    "    with:",
    "      database: true",
    "      health-url: http://localhost:3001/health",
    "      capacity-path: /api/auth/get-session",
    "",
  ].join("\n"),
};

/** What `compose ps --format json` says: one line per container, ports and all. */
function published(target: number, host: number): string {
  return JSON.stringify({
    Service: "web",
    Publishers: [{ URL: "127.0.0.1", TargetPort: target, PublishedPort: host, Protocol: "tcp" }],
  });
}

let repo = "";
let bin = "";

/**
 * A `docker` that answers the two questions this script asks and talks to
 * nothing: whether any container is running, and where the ports went. The
 * listing goes through a quoted heredoc so the JSON reaches stdout exactly as
 * written — `printf` with an escaped argument does not.
 */
async function fakeDocker(running: string, ps: string): Promise<void> {
  await writeFile(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'for arg in "$@"; do',
      `  if [ "$arg" = "--quiet" ]; then printf '%s' '${running}'; exit 0; fi`,
      "done",
      "cat <<'PS_EOF'",
      ps,
      "PS_EOF",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "docker"), 0o755);
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function ramp(...args: string[]): Promise<Ran> {
  const run = Bun.spawn(["bash", RAMP, ...args], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      REPO_DIR: repo,
      // The two the guard exists to ignore: neither may reach the deployed stack.
      PROJECT: "shop",
      COMPOSE_PROJECT_NAME: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { code: await run.exited, stdout, stderr };
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "capacity-"));
  bin = await mkdtemp(join(tmpdir(), "fakebin-"));
  await writeFile(
    join(repo, "docker-compose.yml"),
    "name: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n",
  );
  // The dev stack's own ports, which compose loads first and which this ramp
  // must never end up measuring.
  await writeFile(join(repo, ".env"), "POSTGRES_PASSWORD=hunter2\nWEB_PORT=5180\nAPI_PORT=5181\n");
});

afterAll(async () => {
  await Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(bin, { recursive: true, force: true }),
  ]);
});

/** The tree as it is once a preview is up and the repo has its CI. */
async function ready(workflow: keyof typeof SHIPPED, target: number, host: number): Promise<void> {
  await fakeDocker("c0ffee", published(target, host));
  await writeFile(join(repo, "preview.env"), PREVIEW_ENV);
  await Bun.write(join(repo, ".github", "workflows", "ci.yml"), SHIPPED[workflow]);
}

test("with no preview started, it refuses and names the script that starts one", async () => {
  await fakeDocker("", "");
  await rm(join(repo, "preview.env"), { force: true });

  const run = await ramp("--dry-run");
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("scripts/preview.sh");
});

// The file outlives a stack somebody took down by hand, so its presence is not
// the question — a running container is.
test("with the ports recorded but nothing running, it refuses too", async () => {
  await fakeDocker("", "");
  await writeFile(join(repo, "preview.env"), PREVIEW_ENV);

  const run = await ramp("--dry-run");
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("nothing of 'shop-preview' is running");
});

test("with no shipped workflow, there is no record of what to ramp", async () => {
  await fakeDocker("c0ffee", published(3000, 5190));
  await writeFile(join(repo, "preview.env"), PREVIEW_ENV);
  await rm(join(repo, ".github"), { recursive: true, force: true });

  const run = await ramp("--dry-run");
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("no record of what this repo's CI ramps");
});

// The workflow says which port of the app answers; compose says where the
// preview published it. Neither this script nor its caller has to know which
// shape the repo is.
test("the shipped workflow's health route, on the port the preview published", async () => {
  await ready("monorepo", 3001, 5191);

  const run = await ramp("--dry-run");
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(run.stdout).toContain("would ramp shop-preview: http://127.0.0.1:5191/health");
  expect(run.stdout).toContain("/api/auth/get-session");
  // The dev stack's ports are in .env; a ramp that read those would be
  // measuring whatever else is on this box.
  expect(run.stdout).not.toContain(":5180");
  expect(run.stdout).not.toContain(":5181");
});

// A workflow that names neither input takes check.yml's defaults, so the ramp
// has to reach the same route from a file that says nothing about it.
test("a workflow that names no health route falls back to the one check.yml would use", async () => {
  await ready("single", 3000, 5190);

  const run = await ramp("--dry-run");
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(run.stdout).toContain("would ramp shop-preview: http://127.0.0.1:5190/api/health");
  expect(run.stdout).toContain("/, /login");
});

// The app's port and the preview's are different numbers by design; picking the
// wrong one is a ramp against nothing, or against something else entirely.
test("a preview that publishes no such port says so rather than ramping the wrong one", async () => {
  await ready("monorepo", 9999, 5191);

  const run = await ramp("--dry-run");
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("publishes port 3001");
});
