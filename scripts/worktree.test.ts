// The wrapper as the deploy runs it. Every other caller is a checkout with git
// in front of it; the production image is not, and it is the one that carries
// the migrate service.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { basePort, inBlock, PORTS_PER_WORKTREE } from "./worktree-env.ts";

const WRAPPER = new URL("./worktree.ts", import.meta.url).pathname;
const BRANCH = "feat/claims";

const SHARED_ENV = "DATABASE_URL=postgres://shop:pw@127.0.0.1:5432/shop";

/**
 * The deployed origins every fixture carries, because declaring them is what
 * makes a key an origin key: the wrapper reads this file for the list it holds
 * a checkout's `.env` to, and the production image carries it as well.
 */
const DEPLOYED = [
  "SITE_URL=https://shop.example.com",
  "PUBLIC_API_URL=https://api.shop.example.com",
];

/** A tree with no git at all, which is the shape the production image runs in. */
let work = "";
/** A primary checkout with one linked worktree, which is where all the rest happens. */
let linked = "";
let checkout = "";

/**
 * A primary checkout, its `.env`, and one worktree on `branch`. Every case
 * needs the same four commands; what they differ in is the package.json, the
 * environment the primary carries, and the branch name that picks the ports.
 */
/** The package.json a fixture writes: a name, and workspaces where the shape has them. */
interface Manifest {
  readonly name: string;
  readonly workspaces?: string[];
}

async function fixture(
  branch: string,
  pkg: Manifest,
  env: string[],
): Promise<{ root: string; linked: string }> {
  const root = await mkdtemp(join(tmpdir(), "worktree-"));
  const primary = join(root, "primary");
  const derived = join(root, "linked");

  await $`git init -q -b main ${primary}`.quiet();
  await writeFile(join(primary, "package.json"), JSON.stringify(pkg));
  await writeFile(join(primary, ".env"), `${env.join("\n")}\n`);
  await writeFile(join(primary, "deploy.env"), `${DEPLOYED.join("\n")}\n`);
  await $`git -C ${primary} add -A`.quiet();
  await $`git -C ${primary} -c user.email=a@b -c user.name=t commit -qm fixture`.quiet();
  await $`git -C ${primary} worktree add -q -b ${branch} ${derived}`.quiet();
  return { root, linked: derived };
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "worktree-plain-"));
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "shop" }));
  await writeFile(join(work, "deploy.env"), `${DEPLOYED.join("\n")}\n`);
  ({ root: checkout, linked } = await fixture(BRANCH, { name: "shop" }, [SHARED_ENV]));
});

afterAll(async () => {
  await Promise.all([
    rm(work, { recursive: true, force: true }),
    rm(checkout, { recursive: true, force: true }),
  ]);
});

/** Runs the wrapper over a command, in a worktree, and hands back what it printed. */
async function derive(
  args: string[],
  {
    at = linked,
    run = "/bin/true",
    env = {},
  }: { at?: string; run?: string; env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([process.execPath, WRAPPER, ...args, run], {
    cwd: at,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, out: `${stdout}${stderr}` };
}

/** The ports the run reported, in the order it printed them. */
function reported(out: string): number[] {
  return (/ports ([\d/]+) in /.exec(out)?.[1] ?? "").split("/").map(Number);
}

// `.dockerignore` drops `.git` and the oven/bun runtime carries no git binary,
// so the image answers neither "here is the repository" nor "not a git
// repository" — and a wrapper that read that as an error would take the deploy's
// migrate service down with it.
test("a tree with no git at all runs the command, like any primary checkout", async () => {
  const run = Bun.spawn([process.execPath, WRAPPER, "/bin/echo", "ran"], {
    cwd: work,
    // No git on PATH at all; the command being run is named absolutely.
    env: { PATH: "/nonexistent" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect(`${stdout}${stderr}`.trim()).toBe("ran");
  expect(exitCode).toBe(0);
});

test("the ports it claims are inside the block its branch name picks", async () => {
  const { exitCode, out } = await derive(["--ports"]);
  expect(exitCode).toBe(0);
  const base = basePort(BRANCH);
  for (const port of reported(out)) expect(inBlock(base, port)).toBe(true);
});

// The claim outlives the branch: switching inside a worktree leaves the old
// one behind, and reusing it puts two worktrees on one port — each serving the
// other's database to whoever reached it first.
test("a claim from another block is discarded rather than reused", async () => {
  const claim = join(linked, ".env.worktree");
  const strayBase = basePort("some-other-branch");
  await writeFile(claim, `DEV_PORT=${strayBase}\n`);

  const { exitCode, out } = await derive(["--ports"]);
  expect(exitCode).toBe(0);
  const [port] = reported(out);
  expect(port).not.toBe(strayBase);
  expect(inBlock(basePort(BRANCH), port ?? 0)).toBe(true);
  expect(await readFile(claim, "utf8")).toContain(`DEV_PORT=${port}`);
});

// A port that moves quietly makes the line that reported it a lie — and in the
// monorepo it is baked into the web app's API URL as well.
test("a claimed port that something else is holding is refused, not moved", async () => {
  const base = basePort(BRANCH);
  await writeFile(join(linked, ".env.worktree"), `DEV_PORT=${base}\n`);
  const holder = Bun.listen({ hostname: "127.0.0.1", port: base, socket: { data() {} } });
  try {
    const { exitCode, out } = await derive(["--ports"]);
    expect(exitCode).not.toBe(0);
    expect(out).toContain(`DEV_PORT ${base} belongs to the '${BRANCH}' worktree`);
  } finally {
    holder.stop(true);
  }
});

// Ports are claimed by the command that binds them and by nothing else: a
// migration holding one would be keeping what it never uses.
test("without --ports nothing is claimed and nothing is reported", async () => {
  await rm(join(linked, ".env.worktree"), { force: true });
  const { exitCode, out } = await derive([]);
  expect(exitCode).toBe(0);
  expect(out).toContain("database shop_wt_feat_claims");
  expect(out).not.toContain("ports");
  expect(await Bun.file(join(linked, ".env.worktree")).exists()).toBe(false);
});

/** What the wrapper handed the command it ran, read out of `env`'s own output. */
function handed(out: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1];
}

// Measured in a real worktree before this: the API read the primary checkout's
// `.env`, so its auth issued URLs for the primary's API and its allow-list held
// the primary's origin — the browser on this worktree's own port got no
// allow-origin header back and a 403 on sign-in. The same contamination the
// derived database exists to prevent, one layer up from it.
//
// A fixture of its own, with a workspaces package.json, because the origins are
// derived only where a standalone API reads them.
test("a monorepo worktree derives its own origins, not the primary's", async () => {
  const branch = "feat/origins";
  const { root, linked: derived } = await fixture(
    branch,
    { name: "shop", workspaces: ["apps/*"] },
    [
      SHARED_ENV,
      "SITE_URL=http://127.0.0.1:5180",
      "PUBLIC_API_URL=http://127.0.0.1:3001",
      "VITE_API_URL=http://127.0.0.1:3001",
    ],
  );

  try {
    const { exitCode, out } = await derive(["--ports"], { at: derived, run: "/usr/bin/env" });
    const [dev, api] = reported(out);

    expect(exitCode).toBe(0);
    expect(inBlock(basePort(branch), dev ?? 0)).toBe(true);
    expect(handed(out, "SITE_URL")).toBe(`http://127.0.0.1:${dev}`);
    expect(handed(out, "PUBLIC_API_URL")).toBe(`http://127.0.0.1:${api}`);
    expect(handed(out, "VITE_API_URL")).toBe(`http://127.0.0.1:${api}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The state a deploy step used to ask for, on a box that is both deploy target
// and checkout — this template's premise: the deployed origins copied into
// `.env`. Dev then served a 403 with no diagnostic anywhere, and the half-edited
// half of it was the only one anything downstream caught, at the API's boot and
// only in the monorepo. origins.test.ts has the rule itself, input by input;
// this is the run that proves the wrapper asks it of the file, before anything
// is derived or started, and answers with somewhere to put them.
test("a .env naming a deployment is refused, and says where those origins belong", async () => {
  const { root } = await fixture("feat/deployed", { name: "shop" }, [SHARED_ENV, ...DEPLOYED]);

  try {
    const { exitCode, out } = await derive([], { at: join(root, "primary") });

    expect(exitCode).not.toBe(0);
    expect(out).toContain("SITE_URL and PUBLIC_API_URL");
    expect(out).toContain("deploy.env");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The last slot is a port like any other; starting the next search one past it
// searched an empty range and left the worktree unable to derive at all.
test("a claim on the block's last port still leaves the block usable", async () => {
  const base = basePort(BRANCH);
  await writeFile(join(linked, ".env.worktree"), `DEV_PORT=${base + PORTS_PER_WORKTREE - 1}\n`);
  const { exitCode, out } = await derive(["--ports"]);
  expect(exitCode).toBe(0);
  expect(reported(out)[0]).toBe(base + PORTS_PER_WORKTREE - 1);
});

// The single-app sibling of the monorepo case above, and the same failure: the
// worktree binds the DEV_PORT this derived and the app kept the primary's
// SITE_URL, so Better Auth compared the browser's origin against a port this
// worktree does not serve and answered 403 on every sign-in. One shape had the
// derivation and the other did not; the port and the origin it names are one
// value now, in both.
test("a single-app worktree derives its own SITE_URL, not the primary's", async () => {
  const branch = "feat/site";
  const { root, linked: derived } = await fixture(branch, { name: "shop" }, [
    SHARED_ENV,
    "SITE_URL=http://127.0.0.1:5180",
  ]);

  try {
    const { exitCode, out } = await derive(["--ports"], { at: derived, run: "/usr/bin/env" });
    const [dev] = reported(out);

    expect(exitCode).toBe(0);
    expect(handed(out, "SITE_URL")).toBe(`http://127.0.0.1:${dev}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The primary checkout is where the two used to be written down twice: a port
// vite picked and an origin `.env` stated. `bun run dev` asks for --ports, and
// what it gets back is one number wearing both hats — so a port that is taken
// stops the dev server (vite's strictPort) instead of moving it off the origin
// the app hands the browser.
test("the primary checkout's dev port and its origin are one number", async () => {
  const { root } = await fixture("feat/primary", { name: "shop" }, [
    SHARED_ENV,
    "SITE_URL=http://127.0.0.1:5180",
  ]);
  const at = join(root, "primary");

  try {
    const own = await derive(["--ports"], { at, run: "/usr/bin/env" });
    expect(own.exitCode).toBe(0);
    expect(handed(own.out, "DEV_PORT")).toBe("5180");
    expect(handed(own.out, "SITE_URL")).toBe("http://127.0.0.1:5180");

    // DEV_PORT is the answer when the port `.env` asks for is taken, and the
    // origin follows it rather than staying where the file left it.
    const moved = await derive(["--ports"], {
      at,
      run: "/usr/bin/env",
      env: { DEV_PORT: "5188" },
    });
    expect(moved.exitCode).toBe(0);
    expect(handed(moved.out, "SITE_URL")).toBe("http://127.0.0.1:5188");
    expect(moved.out).toContain("· dev on http://127.0.0.1:5188");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Nothing binds a port, so nothing is derived — the migrate service runs the
// package script through here inside the production image, where the
// environment is the deployment's own and a loopback origin over it would be
// this wrapper handing a deployment the one value it must never have.
test("a command that binds nothing gets the environment it came with", async () => {
  const { root } = await fixture("feat/quiet", { name: "shop" }, [
    SHARED_ENV,
    "SITE_URL=http://127.0.0.1:5180",
  ]);

  try {
    const { exitCode, out } = await derive([], {
      at: join(root, "primary"),
      run: "/usr/bin/env",
      env: { SITE_URL: "https://shop.example.com" },
    });

    expect(exitCode).toBe(0);
    expect(handed(out, "SITE_URL")).toBe("https://shop.example.com");
    expect(handed(out, "DEV_PORT")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
