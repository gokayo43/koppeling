// oxlint-disable no-console -- stdout is this script's interface: it is a CLI whose whole output is what it derived
/**
 * Runs a command with this worktree's own world, deriving it first if needed.
 *
 *   bun scripts/worktree.ts <cmd>                 # derive and layer
 *   bun scripts/worktree.ts --provision <cmd>     # ...and make sure the database exists
 *   bun scripts/worktree.ts --ports <cmd>         # ...and claim the ports it will bind
 *
 * In the PRIMARY checkout it runs the command against that checkout's own
 * world — same database, same ports — and refuses only one thing: a `.env`
 * whose origins are not this machine over plain http. In a LINKED
 * worktree it derives a database name, free dev ports inside this branch's
 * block, and layers them over the primary checkout's .env for the command it
 * runs. Nobody has to remember a setup step: the first command in a new
 * worktree is the setup step.
 *
 * `--provision` is asked for by the commands that reach the database: it starts
 * the dev compose infrastructure if it is down and creates the derived database
 * if it is missing. `--ports` is asked for by the one command that binds them,
 * and it is the only reason a port is claimed, checked or reported — a
 * migration that took a port hostage would be claiming what it never binds.
 * Everything else — the suite, which runs on an in-process PGlite, and
 * `db:generate`, which never connects — goes through neither, so a worktree
 * runs its tests on a machine with no Docker daemon at all.
 *
 * The env is layered in-process rather than written somewhere Bun picks up
 * automatically, because Bun skips `.env.local` when NODE_ENV=test — which
 * `bun test` sets — and `--env-file` replaces `.env` rather than adding to it.
 */
import { parseEnv } from "node:util";

import {
  compose,
  type DevStack,
  devStack,
  POSTGRES_SERVICE,
  type ProcessEnv,
  psql,
  sharedEnv,
} from "./dev-stack.ts";
import { deployedOrigins, foreignOriginFiles, ORIGINS_FILE } from "./origins.ts";
import {
  basePort,
  databaseName,
  databaseUrl,
  freePort,
  inBlock,
  PORTS_PER_WORKTREE,
} from "./worktree-env.ts";

/** The worktree's record of the ports it claimed. Written beside its checkout, never committed. */
const ENV_FILE = ".env.worktree";

/** Where a browser reaches a dev server here, which is the only origin a checkout may name. */
function devOrigin(port: number | string): string {
  return `http://127.0.0.1:${port}`;
}

/** The port an origin names, where it names one — a URL with no port names its scheme's. */
function portOf(origin: string | undefined): string | undefined {
  if (origin === undefined || !URL.canParse(origin)) return undefined;
  const { port } = new URL(origin);
  return port === "" ? undefined : port;
}

/** Started alongside Postgres where the shape has one: it is part of the dev stack being up. */
const INFRASTRUCTURE = [POSTGRES_SERVICE, "redis"];

async function isFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    // In use by something else on this box, which is the answer being asked for.
    return false;
  }
}

function stderr(run: { stderr: Buffer }): string {
  return run.stderr.toString().trim();
}

/**
 * The dev infrastructure has to be up, and accepting connections, before a
 * database can be made on it. Starting it is part of the same "you should not
 * have to remember this" — and `--wait` is the difference between that and a
 * cold start racing the first `createdb`.
 */
async function ensureInfrastructure(stack: DevStack): Promise<void> {
  const known = await compose(stack, "config", "--services");
  if (known.exitCode !== 0) {
    throw new Error(`could not read ${stack.root}/docker-compose.yml: ${stderr(known)}`);
  }
  const declared = new Set(
    known.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim()),
  );
  const wanted = INFRASTRUCTURE.filter((service) => declared.has(service));
  if (!wanted.includes(POSTGRES_SERVICE)) {
    throw new Error("docker compose declares no postgres service");
  }
  const up = await compose(stack, "up", "-d", "--wait", ...wanted);
  if (up.exitCode !== 0) throw new Error(`could not start ${wanted.join(", ")}: ${stderr(up)}`);
}

async function ensureDatabase(stack: DevStack, database: string): Promise<void> {
  const exists = await psql(stack, `select 1 from pg_database where datname = '${database}'`);
  // A query that failed says nothing about whether the database is there, and
  // reading its empty stdout as "missing" turns a broken connection into a
  // confusing `createdb` error.
  if (exists.exitCode !== 0) throw new Error(`could not reach postgres: ${stderr(exists)}`);
  if (exists.stdout.toString().trim() === "1") return;
  const created = await compose(
    stack,
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "createdb",
    "-U",
    stack.user,
    database,
  );
  if (created.exitCode !== 0) throw new Error(`could not create ${database}: ${stderr(created)}`);
}

interface World {
  /** The database this worktree talks to, whether or not it exists yet. */
  readonly database: string;
  /** The port range this branch's name picks, for the line that reports it. */
  readonly block: string;
  /** What the worktree claimed and what the next command must reuse. */
  readonly ports: Record<string, string>;
  /** Everything the command being run should see, ports included. */
  readonly env: Record<string, string>;
}

/**
 * The ports this worktree already claimed, if it has run before.
 *
 * A port is probed once, on the first run, and then it is this worktree's —
 * because the second command in a worktree usually runs while the first is
 * still serving, and re-probing would step over the running server onto a
 * different port. The web app would then be told an API address nothing
 * answers on. Deleting the file is how a worktree asks for new ports.
 */
async function claimedPorts(path: string): Promise<ProcessEnv> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseEnv(await file.text()) : {};
}

function claimText(branch: string, ports: Record<string, string>): string {
  return [
    `# The ports the '${branch}' worktree claimed, written by scripts/worktree.ts.`,
    "# Delete this file to be given new ones; the next command writes it again.",
    ...Object.entries(ports).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

/**
 * A port this worktree may keep. A claim is only good for the block the branch
 * name picks now: switching branches inside a worktree leaves the old one
 * behind, and reusing it would put two worktrees on one port — each serving the
 * other's database to whoever reached it first.
 */
function keptPort(base: number, claimed: string | undefined): number | undefined {
  const port = Number(claimed);
  return claimed !== undefined && Number.isInteger(port) && inBlock(base, port) ? port : undefined;
}

/**
 * Refuses rather than moves. The port has been reported, written down and — in
 * the monorepo — baked into the web app's API URL, so quietly serving somewhere
 * else would make every one of those a lie, and starting anyway would leave
 * half a stack up.
 */
async function verifyFree(branch: string, ports: Record<string, string>): Promise<void> {
  for (const [name, port] of Object.entries(ports)) {
    if (await isFree(Number(port))) continue;
    throw new Error(
      `${name} ${port} belongs to the '${branch}' worktree, but something is already listening on it — stop that, or delete ${ENV_FILE} to claim another`,
    );
  }
}

async function derive(
  stack: DevStack,
  branch: string,
  wantsPorts: boolean,
  shared: ProcessEnv,
): Promise<World> {
  const url = shared["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      `no DATABASE_URL in ${stack.root}/.env — copy the line from .env.example and fill it in`,
    );
  }

  const database = databaseName(stack.app, branch);
  const base = basePort(branch);
  const block = `${base}-${base + PORTS_PER_WORKTREE - 1}`;
  const env = { DATABASE_URL: databaseUrl(url, database) };
  if (!wantsPorts) return { database, block, ports: {}, env };

  const claimed = await claimedPorts(`${stack.top}/${ENV_FILE}`);
  const dev = keptPort(base, claimed["DEV_PORT"]) ?? (await freePort(base, isFree));
  const ports: World["ports"] = { DEV_PORT: String(dev) };
  // SITE_URL travels with the port in every shape, because it otherwise comes
  // from the primary checkout's `.env` and names the primary's: the browser
  // reaches this worktree's own server, the app compares that origin against
  // the one it was given, and sign-in is a 403 with no allow-origin header —
  // the same wrong-port mismatch a worktree's derived database exists to stop,
  // one layer up.
  const bound: World["env"] = {
    ...env,
    DEV_PORT: String(dev),
    SITE_URL: devOrigin(dev),
  };

  // PORT only where a standalone API reads it. It is a well-known name that dev
  // servers claim for themselves — setting it in the single-app shape made Nitro
  // bind it and quietly ignore the port this had already reported, and in the
  // monorepo the web app's dev script drops it for the same reason.
  //
  // The API's two origins travel with it for the same reason SITE_URL travels
  // with the dev port: VITE_API_URL puts this worktree's browser on the
  // primary's API and so on the primary's database, and PUBLIC_API_URL makes
  // this worktree's auth issue URLs for it.
  if (stack.monorepo) {
    const api =
      keptPort(base, claimed["PORT"]) ??
      (await freePort(base, async (port) => port !== dev && (await isFree(port))));
    const apiOrigin = devOrigin(api);
    ports["PORT"] = String(api);
    Object.assign(bound, {
      PORT: String(api),
      VITE_API_URL: apiOrigin,
      PUBLIC_API_URL: apiOrigin,
    });
  }

  await verifyFree(branch, ports);
  return { database, block, ports, env: bound };
}

const argv = Bun.argv.slice(2);
const flagCount = argv.findIndex((arg) => !arg.startsWith("--"));
const flags = new Set(argv.slice(0, flagCount === -1 ? argv.length : flagCount));
for (const flag of flags) {
  if (flag !== "--provision" && flag !== "--ports") throw new Error(`unknown flag ${flag}`);
}
const [executable, ...args] = argv.slice(flags.size);
if (executable === undefined) {
  throw new Error("usage: bun scripts/worktree.ts [--provision] [--ports] <command> [args...]");
}

const stack = await devStack();
const shared = await sharedEnv(stack);
let childEnv: ProcessEnv = process.env;

// Before anything is derived, provisioned or started: everything that comes
// through here is a dev command, and a checkout naming a deployment is one none
// of them can serve. Out of the files rather than the environment, which where
// dev-stack.ts's gitPlaces() finds no repository is the deployment's own.
const named = await foreignOriginFiles(stack.root, Object.keys(await deployedOrigins(stack.root)));
if (named.length > 0) {
  const where = named.map(([file, keys]) => `${keys.join(" and ")} in ${file}`).join(", ");
  throw new Error(
    `${where}: a dev command serves this machine over plain http and nothing else — where a deployment answers belongs in ${ORIGINS_FILE}, which only the containers read`,
  );
}

if (stack.branch === undefined) {
  // The primary checkout derives one thing, and only for the command that binds
  // a port: the dev server takes that port from here and the app takes its
  // origin from here, so the two cannot drift into a browser reaching a server
  // the app does not believe in. DEV_PORT names it where the port `.env` asks
  // for is taken — vite refuses that port rather than sliding off the origin —
  // and with no DEV_PORT this hands back what `.env` already said. Either way
  // they are one value rather than two that happen to agree.
  const port = flags.has("--ports")
    ? (process.env["DEV_PORT"] ?? portOf(shared["SITE_URL"]))
    : undefined;
  if (port !== undefined) {
    childEnv = { ...process.env, DEV_PORT: port, SITE_URL: devOrigin(port) };
    if (process.env["DEV_PORT"] !== undefined) console.log(`· dev on ${devOrigin(port)}`);
  }
} else {
  // The primary checkout's .env under everything, the shell over it — a
  // variable somebody exported on purpose still wins — and this worktree's own
  // world over both.
  const world = await derive(stack, stack.branch, flags.has("--ports"), {
    ...shared,
    ...process.env,
  });
  childEnv = { ...shared, ...process.env, ...world.env };

  if (flags.has("--provision")) {
    await ensureInfrastructure(stack);
    await ensureDatabase(stack, world.database);
  }
  const claimed = Object.values(world.ports);
  if (claimed.length > 0) {
    await Bun.write(`${stack.top}/${ENV_FILE}`, claimText(stack.branch, world.ports));
  }
  console.log(
    `· worktree '${stack.branch}': database ${world.database}${claimed.length > 0 ? `, ports ${claimed.join("/")} in ${world.block}` : ""}`,
  );
}

const child = Bun.spawn([executable, ...args], {
  env: childEnv,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await child.exited);
