// What this file reconciles is the scaffolder's cross-tree agreements: facts
// spread over files that cannot see each other, where every disagreement passes
// every other gate this repo has.
//
// The monorepo shape is driven by Turborepo, and four trees have to agree for
// that to be true: the root scripts in setup/monorepo/root-scripts.json, the
// task graph in setup/monorepo/root/turbo.json, the per-app scripts in the
// staged workspaces, and what those apps read out of the process environment. A
// scaffold that declares a lane nothing routes through, routes a lane nothing
// declares, or hands a dev server an environment turbo has already stripped
// builds, typechecks and tests green either way.
//
// The mutation lane is three declarations, and the shapes disagree about it on
// purpose: the `with:` block of the CI a shape installs, the dev dependencies
// the scaffolder resolves for it, and the `domain` boundaries element the lane
// reads to know what to mutate.
//
// It reads the staged tree rather than a scaffolded one because a real scaffold
// resolves the whole dependency set over the network; that end-to-end run is
// .github/workflows/template.yml's job. Everything it compares is imported
// rather than parsed — the JSON manifests, the dependency table, dev-config's
// own constant — so a file that has moved is a type error before it is a
// failing test, and there is no second spelling for a test to drift from. The
// workflows are the exception: YAML has no import, so they are parsed the way
// template.yml parses the one it ships.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { mutationLaneDependencies } from "@gokayo43/dev-config/knip.base.ts";

import singleOxlintrc from "./.oxlintrc.json";
import { rootDevDependencies } from "./setup/dependencies.ts";
import apiPackage from "./setup/monorepo/apps/api/package.json";
import workerPackage from "./setup/monorepo/apps/worker/package.json";
import rootScripts from "./setup/monorepo/root-scripts.json";
import monorepoOxlintrc from "./setup/monorepo/root/.oxlintrc.json";
import turbo from "./setup/monorepo/root/turbo.json";
import webPackage from "./setup/monorepo/web/package.json";

const at = (path: string): string => join(import.meta.dir, path);

const staged = [
  ["setup/monorepo/apps/api", Object.keys(apiPackage.scripts)],
  ["setup/monorepo/apps/worker", Object.keys(workerPackage.scripts)],
  ["setup/monorepo/web", Object.keys(webPackage.scripts)],
] as const;

const taskNames = Object.keys(turbo.tasks);

/**
 * The one shape a fan-out root script may take. Strict on purpose: `turbo build`
 * is turbo's documented shorthand and would run the same lane, but a parse loose
 * enough to accept it is loose enough to read nothing at all out of a script
 * that stopped using turbo — and a cross-tree test that reads nothing agrees
 * with everything. A flag is refused for the same reason: `--filter` narrows the
 * fan-out to something other than what the graph says.
 */
const FAN_OUT =
  /^(?:bun scripts\/worktree\.ts(?: --[a-z-]+)+ )?turbo run (?<tasks>[\w:-]+(?: [\w:-]+)*)$/;

const mentionsTurbo = Object.entries(rootScripts).filter(([, command]) =>
  /\bturbo\b/.test(command),
);

/** Scripts that reach for turbo without taking the one shape above. */
const malformed = mentionsTurbo
  .filter(([, command]) => !FAN_OUT.test(command))
  .map(([name, command]) => `${name}: ${command}`);

/**
 * Every task the root scripts hand to turbo. A root task is written `//#name` in
 * turbo.json and named plainly on the command line, so both spellings count as
 * declaring it.
 */
const fanOut = mentionsTurbo.flatMap(
  ([, command]) => FAN_OUT.exec(command)?.groups?.["tasks"]?.split(" ") ?? [],
);

const declares = (task: string): boolean =>
  taskNames.includes(task) || taskNames.includes(`//#${task}`);

/** Tasks a workspace actually ships a script for — the ones turbo can fan out to. */
const provided = (task: string): boolean => staged.some(([, scripts]) => scripts.includes(task));

/**
 * Every environment variable the monorepo's own programs read: the `process.env`
 * reads and the keys of the zod schemas that parse it. No VITE_ key can appear —
 * the browser reads those through `import.meta.env`, and turbo's framework
 * inference passes them through on a package that depends on vite.
 */
const appEnvKeys = await (async (): Promise<string[]> => {
  const files = [
    ...new Bun.Glob("setup/monorepo/apps/**/src/**/*.ts").scanSync(import.meta.dir),
    "vite.config.ts",
  ];
  const keys = new Set<string>();
  for (const file of files) {
    const source = await Bun.file(at(file)).text();
    for (const read of source.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) {
      if (read[1] !== undefined) keys.add(read[1]);
    }
    for (const schema of source.matchAll(/z\.object\(\{([\s\S]*?)\}\)/g)) {
      for (const key of (schema[1] ?? "").matchAll(/^\s*([A-Z][A-Z0-9_]{2,}):/gm)) {
        if (key[1] !== undefined) keys.add(key[1]);
      }
    }
  }
  return [...keys].sort();
})();

/** Every key `scripts/worktree.ts` puts into the environment it hands the command. */
const derivedEnvKeys = await (async (): Promise<string[]> => {
  const source = await Bun.file(at("scripts/worktree.ts")).text();
  const opened = source.indexOf("async function derive(");
  const closed = source.indexOf("\n}\n", opened);
  if (opened === -1 || closed === -1) {
    throw new Error("worktree.ts: derive() is not where this test reads it");
  }
  const keys = source
    .slice(opened, closed)
    .matchAll(/(?:^|[{,\s])([A-Z][A-Z0-9_]{2,})\s*:|\["([A-Z][A-Z0-9_]{2,})"\]/gm);
  return [...new Set([...keys].flatMap((m) => [m[1], m[2]].filter((k) => k !== undefined)))].sort();
})();

describe("the monorepo shape's root scripts drive turbo", () => {
  test("every script that reaches for turbo takes the fan-out shape", () => {
    expect(malformed).toEqual([]);
  });

  test("something is actually handed to turbo", () => {
    expect(fanOut.length).toBeGreaterThan(0);
  });

  test("turbo.json declares every task the root scripts hand it", () => {
    expect(fanOut.filter((task) => !declares(task))).toEqual([]);
  });

  test("every package lane turbo.json declares is one a root script routes", () => {
    const unrouted = taskNames
      .filter((name) => !name.startsWith("//#") && name !== "transit" && provided(name))
      .filter((task) => !fanOut.includes(task));
    expect(unrouted).toEqual([]);
  });

  test("turbo.json declares no package task no staged workspace provides", () => {
    // A root task (`//#…`) answers for the root workspace, and `transit` is a
    // pure graph node with no script anywhere — it is what carries a change in
    // one workspace's SOURCE into the hash of its dependents' lanes, which is
    // the whole of the web's typecheck being the API-contract check.
    const orphans = taskNames
      .filter((name) => !name.startsWith("//#") && name !== "transit")
      .filter((task) => !provided(task));
    expect(orphans).toEqual([]);
  });
});

describe("the dev servers keep the environment they are started with", () => {
  // turbo runs in strict env mode: a variable a task does not declare is not in
  // the process it spawns. `dev` is what `bun run dev` reaches through
  // scripts/worktree.ts, which derives this worktree's database and ports and
  // hands them down — so anything missing here is a dev server reading undefined
  // where the wrapper had just put the right answer.
  const passed = turbo.tasks.dev.passThroughEnv;

  test("it passes every variable the monorepo's programs read", () => {
    expect(appEnvKeys.filter((key) => !passed.includes(key))).toEqual([]);
  });

  test("it passes every variable a worktree derives", () => {
    const browserOnly = (key: string): boolean => key.startsWith("VITE_");
    expect(derivedEnvKeys.filter((key) => !browserOnly(key) && !passed.includes(key))).toEqual([]);
  });

  test("it passes nothing no program reads", () => {
    expect(passed.filter((key) => !appEnvKeys.includes(key))).toEqual([]);
  });
});

/**
 * What a shape's CI asks the shared gate for. Parsed rather than matched,
 * because a `mutation-lane: true` under the wrong key is a workflow that reads
 * to a human exactly like one that turns the lane on.
 */
const asks = async (workflow: string): Promise<Record<string, unknown>> => {
  const parsed = Bun.YAML.parse(await Bun.file(at(workflow)).text());
  const check = (parsed as { jobs: { check: { with?: Record<string, unknown> } } }).jobs.check;
  return check.with ?? {};
};

const declaresDomain = (elements: readonly { type: string }[]): boolean =>
  elements.some((element) => element.type === "domain");

/** Whether a dev-dependency list carries the lane's runner, at whatever version it pins. */
const installsTheRunner = (declared: readonly string[]): boolean =>
  mutationLaneDependencies.every((name) =>
    declared.some((entry) => entry === name || entry.startsWith(`${name}@`)),
  );

const shapes = [
  {
    shape: "single",
    workflow: "setup/ci.single.yml",
    domain: declaresDomain(singleOxlintrc.settings["boundaries/elements"]),
    packages: installsTheRunner(rootDevDependencies.single),
  },
  {
    shape: "monorepo",
    workflow: "setup/ci.monorepo.yml",
    domain: declaresDomain(monorepoOxlintrc.settings["boundaries/elements"]),
    packages: installsTheRunner(rootDevDependencies.monorepo),
  },
] as const;

describe("the mutation lane is turned on exactly where it can run", () => {
  test("every repo scaffolded in the single shape runs it on its own pull requests", async () => {
    expect((await asks("setup/ci.single.yml"))["mutation-lane"]).toBe(true);
  });

  for (const { shape, workflow, domain, packages } of shapes) {
    test(`the ${shape} shape agrees with itself about the lane`, async () => {
      const on = (await asks(workflow))["mutation-lane"] === true;
      expect({ packages, domain }).toEqual({ packages: on, domain: on });
    });
  }
});
