#!/usr/bin/env bun
// oxlint-disable no-console -- stdout is this program's interface: a scaffolder is a CLI a human is watching, and there is no logger to route it through
//
// Turns this template into a project. Run once:
//
//   bun run setup
//
// Non-interactive (what a scripted check uses):
//
//   bun run setup --name my-app --hostname my-app.example.com --shape monorepo --worker --yes
//
// Every step up to the region pass is idempotent, so a run that dies partway (a
// network blip during `bun add`) can simply be repeated. The last step removes
// the scaffolder itself: a scaffolded repo should read as if it were written by
// hand.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import {
  API_DEPS,
  DB_DEV_DEPS,
  DEV_CONFIG,
  EDEN_DEPS,
  rootDevDependencies,
  SERVER_DEPS,
  WEB_DEPS,
  WEB_DEV_DEPS,
  WORKER_DEPS,
} from "./setup/dependencies.ts";
import monorepoScripts from "./setup/monorepo/root-scripts.json";

// Three labels, the ones ~/claude-shared/queue.md defines, because everything
// else is already recorded somewhere better: an open issue with no label is new,
// and GitHub's own close reasons say how a closed one ended. What is left is what
// nothing else carries: an agreed direction with no date, a commitment whose body
// names the event that makes it due, and an issue the owner has seen and not
// decided.
const LABELS = [
  ["roadmap", "5319E7", "Agreed direction, not yet scheduled"],
  ["commitment", "0052CC", "A committed follow-up; the body states its Trigger"],
  ["parked", "BFD4F2", "Seen by the owner, undecided, not to be raised again"],
] as const;

/** gh truncates at --limit and exits 0; a repo with more labels than this needs a bigger one. */
const LABEL_LIMIT = 200;

const refused = (results: { exitCode: number }[]): number =>
  results.filter(({ exitCode }) => exitCode !== 0).length;

/**
 * What GitHub seeds a new repo with. Only these are deleted: they are a
 * taxonomy nobody drains and the reason this function exists, and deleting a
 * label takes it off every issue that carries it — so a label somebody added
 * deliberately is reported instead.
 */
const GITHUB_STARTER_LABELS = new Set([
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
]);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".output",
  ".nitro",
  ".tanstack",
  "dist",
  "coverage",
]);
const SKIP_FILES = new Set(["bun.lock", "setup.ts"]);

/**
 * The region pass additionally leaves `setup/` alone: it is staging content
 * that expandToMonorepo copies out and removeScaffolder deletes, so its markers
 * are resolved where they land, not where they are kept.
 */
const REGION_SKIP_DIRS = new Set([...SKIP_DIRS, "setup"]);

const REGION_MARKER = /^\s*(?:#|\/\/|<!--) scaffold:([a-z-]+)(?: -->)?\s*$/;
/**
 * Anything comment-shaped that mentions a region, including malformed markers.
 * Horizontal space only: `\s` would cross a newline, so a bare comment line
 * above an unrelated `scaffold:` key would read as one.
 */
const REGION_MENTION = /(?:#|\/\/|<!--)[ \t]*scaffold:/;

/** This repo's own workflow names a job `scaffold`; removeScaffolder deletes it. */
const REGION_SWEEP_SKIP = ".github/workflows/template.yml";

const SHAPES = ["single", "monorepo"] as const;

type Shape = (typeof SHAPES)[number];

interface Answers {
  slug: string;
  hostname: string;
  shape: Shape;
  worker: boolean;
}

const args = new Map<string, string>();
const flags = new Set<string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const arg = Bun.argv[i];
  if (arg === undefined || !arg.startsWith("--")) continue;
  const name = arg.slice(2);
  const next = Bun.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    args.set(name, next);
    i++;
  } else {
    flags.add(name);
  }
}
const nonInteractive = flags.has("yes");

function ask(question: string, fallback: string): string {
  if (nonInteractive) return fallback;
  const answer = prompt(`${question} [${fallback}]`);
  return answer === null || answer.trim() === "" ? fallback : answer.trim();
}

function askYesNo(question: string, fallback: boolean): boolean {
  if (nonInteractive) return fallback;
  const answer = prompt(`${question} [${fallback ? "Y/n" : "y/N"}]`);
  if (answer === null || answer.trim() === "") return fallback;
  return answer.trim().toLowerCase().startsWith("y");
}

function collectAnswers(): Answers {
  const slug = (args.get("name") ?? ask("Project name (kebab-case)", "my-app")).trim();
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`'${slug}' is not a kebab-case name`);
  }
  const shapeInput =
    args.get("shape") ??
    (askYesNo("Add a standalone Elysia API (Bun workspaces monorepo)?", false)
      ? "monorepo"
      : "single");
  const shape = SHAPES.find((each) => each === shapeInput);
  if (shape === undefined) {
    throw new Error(`unknown shape '${shapeInput}' — expected ${SHAPES.join(" or ")}`);
  }
  return {
    slug,
    hostname: args.get("hostname") ?? ask("Public hostname", `${slug}.example.com`),
    shape,
    worker:
      shape === "monorepo" &&
      (flags.has("worker") || askYesNo("Add a background worker program?", false)),
  };
}

async function* walk(dir: string, skipDirs: ReadonlySet<string>): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // A symlink to a directory is neither a directory to descend nor a file to
    // read, and node_modules grows them once dependencies are installed.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* walk(join(dir, entry.name), skipDirs);
    } else if (!SKIP_FILES.has(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Rewrites the template's own name out of every file that mentions it. */
async function renamePlaceholders({ slug, hostname }: Answers): Promise<void> {
  const db = slug.replaceAll("-", "_");
  for await (const path of walk(".", SKIP_DIRS)) {
    const before = await Bun.file(path).text();
    // Hostname first: it contains the slug, so the narrower replacement has to
    // win before the broader one rewrites its prefix.
    const after = before
      .replaceAll("project-template.example.com", hostname)
      .replaceAll("project-template", slug)
      .replaceAll("project_template", db);
    if (after !== before) await Bun.write(path, after);
  }
  const nginx = `infra/nginx/${slug}.conf`;
  if (await exists("infra/nginx/project-template.conf")) {
    await $`mv infra/nginx/project-template.conf ${nginx}`.quiet();
  }
}

/**
 * A JSON object as it comes off disk. The scaffolder runs before a single
 * dependency is installed — that is what it installs — so there is no schema
 * library in front of these files, and the narrowing below is the parse: every
 * reader of one of these throws on the first value that is not what it says.
 */
// oxlint-disable-next-line typescript/no-restricted-types, anti-slop/no-unsafe-dictionary-type -- see above
type JsonObject = Record<string, unknown>;

/* oxlint-disable anti-slop/no-unknown-parameters -- see JsonObject above */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * Narrowed rather than asserted. `json()` hands back `any`, and a file on disk
 * is untrusted input like any other — a package.json that is a JSON array
 * would otherwise be edited as an object and written back unrecognisable.
 */
async function readPackageJson(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await Bun.file(path).text());
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/**
 * The scripts block. This template ships one whose every value is a command, so
 * both a missing block and a non-command value are a broken tree rather than a
 * case to handle — and silently dropping the odd one out would edit a script
 * out of somebody's package.json without saying so.
 */
function scriptsOf(pkg: JsonObject): Record<string, string> {
  const scripts = pkg["scripts"];
  if (!isRecord(scripts)) throw new Error("package.json has no scripts block");
  return Object.fromEntries(
    Object.entries(scripts).map(([name, command]) => {
      if (typeof command !== "string") {
        throw new Error(`package.json scripts.${name} is not a command`);
      }
      return [name, command];
    }),
  );
}

async function writeJson(path: string, value: JsonObject): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Which scaffold regions this project keeps, by tag. A tag missing here is a mistake. */
type RegionDecisions = Record<string, boolean>;

/** Which scaffold regions this project keeps. A tag missing here is a mistake. */
function regionDecisions(answers: Answers): RegionDecisions {
  return {
    template: false,
    single: answers.shape === "single",
    monorepo: answers.shape === "monorepo",
    worker: answers.worker,
  };
}

/**
 * Resolves every scaffold region in the tree, so the scaffolded files read as
 * if the alternatives had never existed. Regions decide what an executable
 * workflow says, so every failure is loud: a tag nobody declared, a region left
 * open, or a marker still standing when the pass is done.
 */
async function resolveRegions(answers: Answers): Promise<void> {
  const decisions = regionDecisions(answers);

  for await (const path of walk(".", REGION_SKIP_DIRS)) {
    const lines = (await Bun.file(path).text()).split("\n");
    if (!lines.some((line) => REGION_MARKER.test(line))) continue;

    const kept: string[] = [];
    const open: string[] = [];
    for (const line of lines) {
      const tag = REGION_MARKER.exec(line)?.[1];
      if (tag !== undefined) {
        if (!(tag in decisions)) throw new Error(`${path}: unknown scaffold tag '${tag}'`);
        if (open.at(-1) === tag) open.pop();
        else open.push(tag);
        continue;
      }
      if (open.every((each) => decisions[each] === true)) kept.push(line);
    }
    if (open.length > 0) throw new Error(`${path}: unclosed scaffold region '${open.at(-1)}'`);
    await Bun.write(path, kept.join("\n"));
  }

  // A marker the strict regex did not recognise — a missing space, a trailing
  // word — resolves to nothing and ships as a comment about a region that is no
  // longer there. Catching the loose form is what makes the strict one safe.
  for await (const path of walk(".", REGION_SKIP_DIRS)) {
    if (path === REGION_SWEEP_SKIP) continue;
    if (REGION_MENTION.test(await Bun.file(path).text())) {
      throw new Error(`${path}: a scaffold marker survived the region pass`);
    }
  }
}

/** Moves the single-app tree under apps/web and lays down apps/api next to it. */
async function expandToMonorepo(answers: Answers): Promise<void> {
  if (!(await exists("apps/web/package.json"))) {
    await $`mkdir -p apps/web`.quiet();
    for (const path of ["src", "tests", "vite.config.ts"]) {
      if (await exists(path)) await $`mv ${path} apps/web/`.quiet();
    }
    await $`cp -R setup/monorepo/apps/api apps/api`.quiet();
    if (answers.worker) await $`cp -R setup/monorepo/apps/worker apps/worker`.quiet();
    await $`cp -R setup/monorepo/root/. .`.quiet();
    await $`cp setup/monorepo/web/api-origin.ts apps/web/src/lib/api-origin.ts`.quiet();
    await $`cp setup/monorepo/web/api-client.ts apps/web/src/lib/api-client.ts`.quiet();
    await $`cp setup/monorepo/web/auth-client.ts apps/web/src/lib/auth-client.ts`.quiet();
    await $`cp setup/monorepo/web/vite-env.d.ts apps/web/src/vite-env.d.ts`.quiet();
    await $`cp setup/monorepo/web/index.tsx apps/web/src/routes/index.tsx`.quiet();
    await $`cp setup/monorepo/web/package.json apps/web/package.json`.quiet();
    await $`cp setup/monorepo/web/tsconfig.json apps/web/tsconfig.json`.quiet();
    await $`cp setup/monorepo/web/api-origin.test.ts apps/web/tests/api-origin.test.ts`.quiet();
    await $`cp setup/monorepo/web/api-client.test.ts apps/web/tests/api-client.test.ts`.quiet();
    await $`cp setup/monorepo/web/fresh-process.ts apps/web/tests/fresh-process.ts`.quiet();

    // The database moves into the API program: the web app reaches it over Eden.
    await rm("apps/web/src/server", { recursive: true, force: true });
    // With it goes the web app's server entry, which existed to carry the
    // capacity gate's route log: in this shape the API is what the gate boots
    // and ramps, and it has a route log of its own.
    await rm("apps/web/src/server.ts", { force: true });
    await rm("apps/web/tests/route-log.test.ts", { force: true });
    await rm("apps/web/src/routes/api.health.ts", { force: true });
    await rm("apps/web/src/routes/api.auth.$.ts", { force: true });
    await rm("apps/web/tests/schema.test.ts", { force: true });
    await rm("apps/web/tests/migrate.test.ts", { force: true });
    await rm("drizzle.config.ts", { force: true });
    await rm("Dockerfile", { force: true });
  }

  if (!answers.worker) await rm("Dockerfile.worker", { force: true });
}

async function writeRootPackageJson(answers: Answers, bunVersion: string): Promise<void> {
  const pkg = await readPackageJson("package.json");
  pkg["name"] = answers.slug;
  pkg["packageManager"] = `bun@${bunVersion}`;
  const scripts = scriptsOf(pkg);
  delete scripts["setup"];
  if (answers.shape === "monorepo") {
    pkg["workspaces"] = ["apps/*"];
    // These live beside the tree they drive rather than in this file, so the
    // scaffolder and the test that holds them to turbo.json read one copy: two
    // spellings of the same script block is the disagreement setup.test.ts
    // exists to make impossible. `typecheck:root` in there is the root
    // workspace's own lane — knip.ts and scripts/ belong to no package, so turbo
    // can only reach them as a root task, and it cannot be called `typecheck`
    // because that is the script standing in front of turbo.
    Object.assign(scripts, monorepoScripts);
  }
  pkg["scripts"] = scripts;
  await writeJson("package.json", pkg);
}

/**
 * Every call carries `--exact`, even though `bunfig.toml` already sets
 * `saveExact`. Exact pins are the whole version policy, and a scaffold observed
 * on a GitHub runner wrote carets from the same tree that writes exact versions
 * locally — so the scaffolder states the pin at the call site rather than
 * inheriting it from a file whose scope depends on the environment.
 */
async function installDependencies(answers: Answers): Promise<void> {
  if (answers.shape === "single") {
    await $`bun add --exact ${[...WEB_DEPS, ...SERVER_DEPS]}`;
    await $`bun add --exact -d ${rootDevDependencies.single}`;
    return;
  }
  const apiPackage = `${answers.slug}-api@workspace:*`;
  await $`bun add --exact -d ${rootDevDependencies.monorepo}`;
  await $`bun add --cwd apps/web --exact ${[...WEB_DEPS, ...EDEN_DEPS]}`;
  await $`bun add --cwd apps/web --exact -d ${WEB_DEV_DEPS}`;
  await $`bun add --cwd apps/api --exact ${API_DEPS}`;
  // dev-config as well, because apps/api imports its `route-log.ts` for the
  // wire protocol it shares with the capacity gate — a type-only import, so
  // none of it reaches a bundle, but a package a workspace imports is a package
  // that workspace declares. In the single shape the root already has it.
  await $`bun add --cwd apps/api --exact -d ${[...DB_DEV_DEPS, DEV_CONFIG]}`;
  await $`bun add --cwd apps/web --exact ${apiPackage}`;
  if (answers.worker) {
    await $`bun add --cwd apps/worker --exact ${WORKER_DEPS}`;
    await $`bun add --cwd apps/worker --exact ${apiPackage}`;
  }
}

/** Pins the runtime image to the Bun that produced bun.lock. */
async function pinBunVersion(bunVersion: string): Promise<void> {
  for (const path of ["Dockerfile", "Dockerfile.web", "Dockerfile.api", "Dockerfile.worker"]) {
    if (!(await exists(path))) continue;
    const text = await Bun.file(path).text();
    await Bun.write(path, text.replace(/^ARG BUN_VERSION=.*$/m, `ARG BUN_VERSION=${bunVersion}`));
  }
}

/**
 * Makes the repo's labels the two this project uses. GitHub seeds every new
 * repo with bug/enhancement/duplicate and friends, which are a taxonomy nobody
 * drains, and they crowd out the pair that mean something here.
 *
 * There are two reasons to skip, both about this machine rather than the repo:
 * no remote, or no authenticated gh. Anything after that is a failure the
 * caller is told about, counted rather than swallowed under a tidy summary.
 */
async function reconcileLabels(): Promise<void> {
  const remote = await $`git remote get-url origin`.quiet().nothrow();
  if (remote.exitCode !== 0) {
    console.log("· no git remote — skipping issue labels");
    return;
  }
  const gh = await $`gh auth status`.quiet().nothrow();
  if (gh.exitCode !== 0) {
    console.log("· gh is not authenticated — skipping issue labels");
    return;
  }

  const existing = await $`gh label list --limit ${LABEL_LIMIT} --json name`.quiet().nothrow();
  if (existing.exitCode !== 0) {
    throw new Error(`could not read the repo's labels: ${existing.stderr.toString().trim()}`);
  }
  const listed: unknown = existing.json();
  if (!Array.isArray(listed)) throw new Error("gh label list did not return a list");
  /* oxlint-disable anti-slop/no-unknown-parameters -- gh's JSON, parsed the only way this program can: see JsonObject above */
  const names = listed.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry["name"] === "string" ? [entry["name"]] : [],
  );
  /* oxlint-enable anti-slop/no-unknown-parameters */
  // gh stops at --limit and exits 0, so a truncated listing reads as a short
  // one — and this function deletes based on what it read.
  if (names.length >= LABEL_LIMIT) {
    throw new Error(
      `gh returned ${names.length} labels at its --limit of ${LABEL_LIMIT} — raise it`,
    );
  }
  const present = new Set(names);
  const canon = new Set<string>(LABELS.map(([name]) => name));

  // --force so a label whose colour or description has drifted is brought back
  // to the canon one; `present` is then only about what has to be deleted.
  const writes = await Promise.all(
    LABELS.map(([name, color, description]) =>
      $`gh label create ${name} --color ${color} --description ${description} --force`
        .quiet()
        .nothrow(),
    ),
  );

  // Deleting a label strips it from every issue that carries it, and this runs
  // against whatever `origin` happens to be. So only GitHub's own starter set
  // is deleted — the labels this function exists to clear — and anything else
  // outside the vocabulary is reported for a human to decide about.
  const extra = [...present].filter((name) => !canon.has(name));
  const starters = extra.filter((name) => GITHUB_STARTER_LABELS.has(name));
  const deliberate = extra.filter((name) => !GITHUB_STARTER_LABELS.has(name));
  const deletes = await Promise.all(
    starters.map((name) => $`gh label delete ${name} --yes`.quiet().nothrow()),
  );

  const refusedWrites = refused(writes);
  const refusedDeletes = refused(deletes);
  const failed = refusedWrites + refusedDeletes;
  const summary = `${writes.length - refusedWrites} written, ${deletes.length - refusedDeletes} deleted`;
  console.log(
    failed === 0
      ? `· labels reconciled: ${summary}`
      : `· labels reconciled: ${summary}, ${failed} failed — check 'gh label list'`,
  );
  if (deliberate.length > 0) {
    console.log(`· labels outside the vocabulary, left alone: ${deliberate.join(", ")}`);
  }
}

/**
 * Installs the scaffolded repo's workflows — whatever `setup/` holds, rather
 * than a list that has to be kept in step with it. They ship there because
 * GitHub runs anything in `.github/workflows`, and this repo has no
 * dependencies to gate until the scaffolder has run.
 *
 * A file named `<name>.<shape>.yml` belongs to that shape and installs as
 * `<name>.yml`; anything else installs under its own name. Two whole workflows
 * rather than one carrying a region per differing line: a workflow is
 * executable, the form linted here has to be a form GitHub would run, and a key
 * two shapes need different values for cannot be written twice in one `with:`.
 */
async function installWorkflows(shape: Shape): Promise<void> {
  for (const name of new Bun.Glob("*.yml").scanSync("setup")) {
    const owner = SHAPES.find((each) => name.endsWith(`.${each}.yml`));
    if (owner !== undefined && owner !== shape) continue;
    const target = owner === undefined ? name : name.replace(`.${owner}.yml`, ".yml");
    if (await exists(`.github/workflows/${target}`)) continue;
    await $`mv setup/${name} .github/workflows/${target}`.quiet();
  }
}

async function removeScaffolder(): Promise<void> {
  // The config is repaired before anything is deleted: the other order has a
  // window where setup.ts is gone and tsconfig.json still points at it, which
  // is the one state a repeated run cannot fix.
  //
  // The scaffolder was in the typed project so the linter saw it with the same
  // compiler options as everything else; with the file gone, so is the entry.
  //
  // The entry is matched with its comma rather than as a literal: `include` is
  // one line or seven depending on whether the longest path in it fits inside
  // oxfmt's print width, and a scaffolder that only knew one spelling would
  // stop with the file it had just refused to edit.
  const tsconfig = await Bun.file("tsconfig.json").text();
  const without = tsconfig.replace(/,\s*"setup\.ts"/, "");
  if (without.includes("setup.ts")) throw new Error("tsconfig.json still lists setup.ts");
  await Bun.write("tsconfig.json", without);

  await rm("setup", { recursive: true, force: true });
  await rm("setup.ts", { force: true });
  await rm("setup.test.ts", { force: true });
  await rm("tsconfig.setup.json", { force: true });
  // This repo's own CI scaffolds the template; a scaffolded repo has no use for it.
  await rm(".github/workflows/template.yml", { force: true });
}

/**
 * The names the conf this run just wrote serves — read back out of it, so the
 * DNS instruction below states what was installed rather than a second belief
 * about it. The monorepo's file carries a block for the API's own hostname; the
 * single-app one does not, and neither shape is spelled out here.
 */
async function servedHostnames(slug: string): Promise<string[]> {
  const conf = await Bun.file(`infra/nginx/${slug}.conf`).text();
  return [...conf.matchAll(/^\s*server_name\s+([^;]+);/gm)].flatMap(([, names]) =>
    names === undefined ? [] : names.trim().split(/\s+/),
  );
}

const answers = collectAnswers();
const bunVersion = (await $`bun --version`.text()).trim();

console.log(`\n→ scaffolding ${answers.slug} (${answers.shape}) at ${answers.hostname}\n`);

await installWorkflows(answers.shape);
// The template's own lefthook.yml gates the scaffolder, which is all this repo
// can typecheck; the scaffolded repo has an app to gate, so it ships this one.
await $`cp setup/root/lefthook.yml lefthook.yml`.quiet();
await renamePlaceholders(answers);
if (answers.shape === "monorepo") await expandToMonorepo(answers);
await writeRootPackageJson(answers, bunVersion);
await installDependencies(answers);
await pinBunVersion(bunVersion);
await $`bunx lefthook install`.nothrow();
await $`bun run db:generate`.nothrow();
// The Start plugin writes routeTree.gen.ts during a build and nothing commits
// it, so without this the first `bun run check` and the first `git commit` in a
// brand-new repo both report missing route types — in code this scaffolder just
// wrote. Inside the resumable half deliberately: a build that fails leaves a
// tree the whole run can simply be repeated over.
await $`bun run build`;
// Regions resolve after the network steps. They are the one part of this
// program that cannot be repeated — the markers are gone afterwards — and a run
// that dies in `bun add` has to stay resumable.
await resolveRegions(answers);
await reconcileLabels();
await removeScaffolder();
// package.json was rewritten by hand above; oxfmt owns its key order.
await $`bunx oxfmt .`.quiet().nothrow();

const hostnames = await servedHostnames(answers.slug);
const listed = hostnames.map((name) => `  ${name}`).join("\n");
const certificate =
  hostnames.length > 1 ? "one origin certificate covering both" : "the origin certificate";

// Content here, no layout: the renderer below indents what wraps. No step edits
// an origin: `.env.example` ships a checkout's own and deploy.env the hostname
// answered above, and the containers read only the second — so a box that is
// both a deploy target and a checkout needs no swap in either direction.
const steps = [
  `cp .env.example .env  and fill POSTGRES_PASSWORD / BETTER_AUTH_SECRET
(openssl rand -base64 32) and the password in DATABASE_URL — URL-safe or
percent-encoded there — then commit the encrypted copy:
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --armor -o .env.enc .env`,
  `bun run check && bun test`,
  `sudo docker compose build && sudo docker compose up -d`,
  `install infra/nginx/${answers.slug}.conf into /etc/nginx/sites-enabled and
reload nginx, then point these at this box in Cloudflare (proxied, Full
(strict)):
${listed}
${certificate} goes at the paths that file names.`,
  `install the backup, restore-drill and failure-notifier units into
/etc/systemd/system under this project's name and enable both timers — README's
"Backups" has the loop that does it, what BACKUP_AGE_KEY has to name and what
HEARTBEAT_URL turns on; run scripts/restore-drill.sh to prove it`,
  `before real users arrive: scripts/preview.sh then scripts/preview-capacity.sh
for the number, and set "lifecycle": "live" in package.json — CLAUDE.md's
"Going live" says what that one word turns on`,
];

/** Numbers a step and indents everything under it to the width of its label. */
function numbered(step: string, index: number): string {
  const label = `  ${index + 1}. `;
  return step
    .split("\n")
    .map((line, position) => (position === 0 ? label : " ".repeat(label.length)) + line)
    .join("\n");
}

console.log(`
Scaffolded, and built once — the generated route types are in place, so
\`bun run check\` and the pre-commit hook are green as this stands.

Next:

${steps.map(numbered).join("\n")}
`);
