// What the preview scripts would ask the daemon to do, without a daemon: a
// `docker` on PATH that records its arguments, and a repo of its own to run in.
//
// `down -v` deletes volumes, so the only question that matters there is which
// project it is aimed at: the preview's, always, whatever the environment says.
// And a preview isolates the stack it previews only through the env file it
// writes, so that file is written for real here and read back as a file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { deployedOrigins } from "./origins.ts";

const DOWN = new URL("./preview-down.sh", import.meta.url).pathname;

let repo = "";
let bin = "";
let log = "";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "preview-"));
  bin = await mkdtemp(join(tmpdir(), "fakebin-"));
  log = join(repo, "docker.log");
  await writeFile(
    join(repo, "docker-compose.yml"),
    "name: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n",
  );
  await writeFile(join(repo, ".env"), "POSTGRES_PASSWORD=hunter2\n");
  // Records what it was asked to do and talks to nothing.
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${log}"\n`);
  await chmod(join(bin, "docker"), 0o755);
});

afterAll(async () => {
  await Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(bin, { recursive: true, force: true }),
  ]);
});

// An inherited PROJECT naming the deployed stack pointed `down -v` at
// production's volumes — the database included — in one word no one would look
// at twice.
test("the preview teardown cannot be aimed at another stack by the environment", async () => {
  const run = Bun.spawn(["bash", DOWN], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      REPO_DIR: repo,
      PROJECT: "shop",
      COMPOSE_PROJECT_NAME: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
  const asked = await readFile(log, "utf8");
  expect(asked).toContain("-p shop-preview down -v");
  expect(asked).not.toContain("-p shop down");
});

const PREVIEW = new URL("./preview.sh", import.meta.url).pathname;
const COMPOSE = new URL("../docker-compose.yml", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

/** A real run of preview.sh against the fake daemon, and what it said. */
async function preview(env: Record<string, string> = {}, args: string[] = []) {
  const run = Bun.spawn(["bash", PREVIEW, ...args], {
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, REPO_DIR: repo, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { exitCode, out: `${stdout}${stderr}` };
}

// Where the identity comes from is restore-drill.sh's rule, and this script
// asks it rather than keeping a second copy of the answer — early, so a
// --restore that could never decrypt says so before the images are built and
// not after. The fixture .env names no BACKUP_AGE_KEY.
test("a restoring preview with no identity anywhere is refused before it builds", async () => {
  const { exitCode, out } = await preview({}, ["--restore"]);
  expect(exitCode).toBe(2);
  expect(out).toContain("no age identity");
  expect(out).not.toContain("building the images");
});

/** The text of the env file such a run leaves behind. */
async function writtenText(env: Record<string, string> = {}): Promise<string> {
  expect((await preview(env)).exitCode).toBe(0);
  return await readFile(join(repo, "preview.env"), "utf8");
}

/** That file, parsed the way compose reads it. */
async function written(): Promise<Record<string, string | undefined>> {
  return parseEnv(await writtenText());
}

/** Every variable the compose file resolves at interpolation time. */
function interpolated(compose: string): Set<string> {
  return new Set(
    [...compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap(([, name]) => name ?? []),
  );
}

// Those origins reach the containers only because this file stands in
// deploy.env's place, and it does that by naming itself. Naming anything else —
// or nothing — leaves the preview's containers and its browser bundle running at
// the deployed origins, which is production wearing the preview's ports.
test("the preview names its own file as the one the containers read", async () => {
  expect((await written())["ORIGINS_ENV"]).toBe("preview.env");
  expect(interpolated(await Bun.file(COMPOSE).text())).toContain("ORIGINS_ENV");
});

// One file, two jobs, and a key that does neither is the whole of what can go
// wrong. As compose's --env-file it answers the ports, and a key compose does
// not interpolate is a value it resolves from the developer's own .env instead.
// As the containers' env_file it stands in for deploy.env entirely — not a
// layer over it — so an origin key missing here is a container with no origin
// at all, and one deploy.env does not declare is an origin nothing serves. The
// ports land inside the containers too, by the same env_file; that is inert,
// because what a container reads of its environment is the keys its own env.ts
// parses, and no port key is one of them.
test("the preview writes an origin for every key the containers read, and ports for compose", async () => {
  const keys = Object.keys(await written());
  const origins = Object.keys(await deployedOrigins(ROOT));
  const reads = interpolated(await Bun.file(COMPOSE).text());

  expect(origins.filter((key) => !keys.includes(key))).toEqual([]);
  expect(keys.filter((key) => !origins.includes(key) && !reads.has(key))).toEqual([]);
});

// compose resolves a variable from the process environment before any
// --env-file, so this one key — the only one carrying the preview's origins —
// silently outranks the file the preview just wrote, and the containers come up
// at whatever it names while the ports stay the preview's. stack.sh refuses an
// inherited COMPOSE_PROJECT_NAME for the same reason; this is the same refusal.
test("an inherited ORIGINS_ENV stops the preview rather than repointing it", async () => {
  const { exitCode, out } = await preview({ ORIGINS_ENV: "deploy.env" });

  expect(exitCode).toBe(2);
  expect(out).toContain("ORIGINS_ENV is set in the environment");
});

// Two parsers read this file — compose's env_file and, where a web image bakes
// its API origin into the bundle, a grep that keeps whatever the line holds —
// and they disagree about quotes and trailing space. The values are the
// script's own, so the way one gets a shape they read differently is an input:
// a port with a space in it lands in an origin nothing answers at.
test.each(["5190 ", "51 90", "51x", "-1"])(
  "a preview port of %p is refused before anything is written",
  async (port) => {
    const { exitCode, out } = await preview({ PREVIEW_WEB_PORT: port });

    expect(exitCode).toBe(2);
    expect(out).toContain("PREVIEW_WEB_PORT must be a port number");
  },
);

test("what it writes is one plain KEY=value per line, which both parsers read alike", async () => {
  const lines = (await writtenText())
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));

  expect(lines).not.toBeEmpty();
  expect(lines.filter((line) => !/^[A-Z][A-Z0-9_]*=\S*$/.test(line))).toEqual([]);
});
