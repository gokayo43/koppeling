// Nothing this repo starts may listen on every interface unless a container
// asked it to. The why is CLAUDE.md's first Gotcha; this file is what keeps it
// true. What can be started here is started, and what it bound is read back out
// of the kernel; what only a container or a dev server starts is read out of
// the image, and out of the config, as the thing that builds it would read them.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessEnv } from "./dev-stack.ts";
import { webPath } from "./web-app.ts";

function freePort(): number {
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = socket;
  socket.stop(true);
  return port;
}

/**
 * The addresses a listener on this port is bound to, as the kernel has them.
 *
 * Read rather than probed. A probe from somewhere else needs an interface this
 * machine might not have, and a firewall that does not drop it — and it answers
 * "unreachable" the same way for a narrow bind and a filtered one, so it passes
 * when it should fail. This answers with the address itself.
 */
function listening(port: number): string[] {
  const ss = Bun.spawnSync(["ss", "-H", "-tln", `sport = :${port}`]);
  if (!ss.success) {
    throw new Error(`ss could not be asked what is listening: ${ss.stderr.toString().trim()}`);
  }
  return ss.stdout
    .toString()
    .split("\n")
    .flatMap((line) => line.trim().split(/\s+/).slice(3, 4))
    .filter((address) => address.endsWith(`:${port}`))
    .map((address) => address.slice(0, -`:${port}`.length).replace(/^\[|\]$/g, ""));
}

let started: Bun.Subprocess | undefined;
let sandbox: string | undefined;

afterEach(async () => {
  started?.kill();
  started = undefined;
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

/**
 * Waits for the server to be listening, then says where.
 *
 * Two identical reads in a row: a listener set is a snapshot, and a program that
 * binds several addresses does it in several syscalls, so a read taken between
 * them reports half an answer. `Bun.serve` binds once, which makes this
 * theoretical today and cheap enough never to think about again.
 */
async function boundAddresses(server: Bun.Subprocess, port: number): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let previous = "";
  for (;;) {
    const bound = listening(port).join(" ");
    if (bound !== "" && bound === previous) return bound.split(" ");
    previous = bound;
    // exitCode, not killed: a process that died on its own is the case worth
    // naming, and it otherwise spends the whole deadline looking like a slow boot.
    if (server.exitCode !== null) {
      throw new Error(`the server exited with ${server.exitCode} before it listened`);
    }
    if (Date.now() > deadline) throw new Error(`nothing listened on ${port} within 10s`);
    // oxlint-disable-next-line anti-slop/no-real-timers -- what is being waited on is another process reaching a bind(2), and no clock this test could inject is the one that process is on; the 100ms is how often the kernel's listener table is re-read, not an interval the assertions are about
    await Bun.sleep(100);
  }
}

/**
 * The `start` script that runs the Nitro output, out of the package.json that
 * owns it. Read rather than written out, because this file is what has to hold
 * whatever that script currently says.
 */
async function nitroStart(): Promise<string> {
  const path = await webPath("apps/web/package.json", "package.json");
  const start = /"start": "([^"]*)"/.exec(await Bun.file(path).text())?.[1];
  if (start === undefined) throw new Error(`${path} declares no start script`);
  return start;
}

/**
 * That script, run for real, against a stand-in for the built output: Nitro's
 * server takes its bind address from `HOST` and binds every interface without
 * one (verified 2026-08-08 against nitro 3.0.260610-beta, which prints
 * "all interfaces"), and `Bun.serve` does the same, so what is left to prove is
 * the only part this repo owns — that the script supplies the address when the
 * environment does not, and defers when it does.
 */
async function serveOutput(
  host: string | undefined,
): Promise<{ server: Bun.Subprocess; port: number; script: string }> {
  const port = freePort();
  const script = await nitroStart();
  sandbox = await mkdtemp(join(tmpdir(), "start-"));
  await mkdir(join(sandbox, ".output", "server"), { recursive: true });
  await writeFile(
    join(sandbox, ".output", "server", "index.mjs"),
    'Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response("ok") });\n',
  );
  await writeFile(
    join(sandbox, "package.json"),
    `${JSON.stringify({ name: "start-probe", scripts: { start: script } })}\n`,
  );

  const env: ProcessEnv = { ...process.env, PORT: String(port) };
  delete env["HOST"];
  if (host !== undefined) env["HOST"] = host;
  started = Bun.spawn(["bun", "run", "start"], {
    cwd: sandbox,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { server: started, port, script };
}

test("the start script keeps the browser app on loopback", async () => {
  const { server, port, script } = await serveOutput(undefined);

  // The script under test is the one that boots the built server, not some
  // other `start` that happened to be first.
  expect(script).toContain(".output/server/index.mjs");
  expect(await boundAddresses(server, port)).toEqual(["127.0.0.1"]);
});

// `::1` rather than the `0.0.0.0` a container sets, because what has to be
// proven here is only that the environment outranks the default — and proving
// it with a wildcard would put this machine's every interface behind a test
// server for as long as the test runs. The container's own value is held to
// below, where it is written.
test("...and gives way to the HOST a container sets", async () => {
  const { server, port } = await serveOutput("::1");

  expect(await boundAddresses(server, port)).toEqual(["::1"]);
});

/**
 * Every instruction the built image ends up carrying: the last stage, and
 * everything it inherits from the stage it was built `FROM`, back to the base.
 *
 * `FROM deps AS runtime` — the shape the API and worker images here use —
 * carries deps's `ENV` and `EXPOSE` into the image, so reading the last stage
 * alone would answer for an image docker does not build: it would miss an
 * address that is inherited and miss a port that is.
 */
interface Stage {
  readonly lines: string[];
  /** What it was built FROM, which is another stage here or an image from outside. */
  readonly base: string | undefined;
}

function imageInstructions(dockerfile: string): string[] {
  const stages = new Map<string, Stage>();
  let current: Stage | undefined;

  for (const line of dockerfile.split("\n").map((each) => each.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    const words = line.split(/\s+/);
    if (words[0]?.toUpperCase() !== "FROM") {
      current?.lines.push(line);
      continue;
    }
    // `FROM <base> AS <name>`, or an unnamed stage nothing can inherit from.
    // Flags first: `FROM --platform=$BUILDPLATFORM base AS name` is ordinary,
    // and counting words without dropping them reads the platform as the base.
    const parts = words.filter((word) => !word.startsWith("--"));
    current = { lines: [], base: parts[1] };
    stages.set(parts[3] ?? `stage ${stages.size}`, current);
  }
  if (current === undefined) throw new Error("this Dockerfile declares no FROM");

  const image: string[] = [];
  // A base that names no stage in this file is the image it all rests on, and
  // the walk ends there. Bounded anyway: a Dockerfile cannot name a later stage
  // as its base, and nothing here has to trust that to terminate.
  for (let stage: Stage | undefined = current, hop = 0; stage !== undefined; hop++) {
    image.unshift(...stage.lines);
    if (hop > stages.size)
      throw new Error("this Dockerfile's stages refer to each other in a loop");
    stage = stage.base === undefined ? undefined : stages.get(stage.base);
  }
  return image;
}

const isExpose = (line: string): boolean => /^EXPOSE\s/i.test(line);
const setsWideHost = (line: string): boolean => /^ENV\s.*\bHOST=0\.0\.0\.0(\s|$)/i.test(line);

/**
 * The end of the rule a running test cannot reach: a container's CMD is not
 * what CI or a dev box starts. Dropping `HOST=0.0.0.0` from an image is a
 * green-healthcheck outage — the in-container probe calls localhost and passes
 * while the published port answers nothing — so the images are read instead.
 *
 * An `ENV` instruction, never a comment saying one belongs there. An image that
 * EXPOSEs a port is one that serves; one that exposes none binds nothing and
 * needs no address.
 */
test("every image that serves a port binds every interface inside it", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const images = await Promise.all(
    [...new Bun.Glob("Dockerfile*").scanSync(root)].map(async (name) => ({
      name,
      image: imageInstructions(await Bun.file(join(root, name)).text()),
    })),
  );
  const serving = images.filter(({ image }) => image.some(isExpose));

  expect(serving).not.toBeEmpty();
  expect(serving.filter(({ image }) => !image.some(setsWideHost)).map(({ name }) => name)).toEqual(
    [],
  );
});

/**
 * The third binder, and the only one whose address is a literal in a config
 * file rather than something a script or an image supplies. `host: true` there
 * is vite's spelling of every interface, and it would put every worktree's dev
 * server — and its derived database — on the network without a word.
 *
 * The config is imported rather than read, because only the value vite ends up
 * with settles it: a pin left behind in a comment reads exactly like a live one.
 * In a subprocess because importing it instantiates the plugin chain, which has
 * no business in this suite's module registry — and because a dynamic import
 * here would be `any`, which this repo's lint refuses.
 */
test("the dev server is pinned to loopback", async () => {
  const path = await webPath("apps/web/vite.config.ts", "vite.config.ts");
  const read = Bun.spawn(
    [
      "bun",
      "-e",
      `console.log(JSON.stringify((await import(${JSON.stringify(path)})).default.server?.host))`,
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "inherit" },
  );

  expect((await new Response(read.stdout).text()).trim()).toBe('"127.0.0.1"');
  expect(await read.exited).toBe(0);
});
// scaffold:monorepo

/**
 * The API is the other program that binds, and it states the rule in code: a
 * zod default in `apps/api/src/env.ts`. The datastore URLs below point at a
 * port nothing serves — it binds before it talks to either.
 */
function serveApi(host: string | undefined): { server: Bun.Subprocess; port: number } {
  const port = freePort();
  const env: ProcessEnv = {
    ...process.env,
    DATABASE_URL: "postgres://probe:probe@127.0.0.1:1/probe",
    REDIS_URL: "redis://127.0.0.1:1",
    SITE_URL: "https://probe.example.com",
    PUBLIC_API_URL: "https://api.probe.example.com",
    BETTER_AUTH_SECRET: "probe-secret-that-is-long-enough-32",
    PORT: String(port),
  };
  delete env["HOST"];
  if (host !== undefined) env["HOST"] = host;
  started = Bun.spawn(["bun", new URL("../apps/api/src/main.ts", import.meta.url).pathname], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { server: started, port };
}

test("the api binds loopback and nothing else", async () => {
  const { server, port } = serveApi(undefined);

  expect(await boundAddresses(server, port)).toEqual(["127.0.0.1"]);
});

test("...and it too gives way to HOST", async () => {
  const { server, port } = serveApi("::1");

  expect(await boundAddresses(server, port)).toEqual(["::1"]);
});
// scaffold:monorepo
