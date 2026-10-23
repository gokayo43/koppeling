/**
 * How a linked worktree's isolated world is named. Pure, so the naming rules
 * are testable without a repo, a database or a free port.
 *
 * Everything is derived from one string — the worktree's branch — so two
 * worktrees never have to agree on anything, and the same branch always lands
 * on the same names.
 */

/** Postgres truncates identifiers at 63 bytes, silently, which is how two worktrees end up sharing one database. */
const IDENTIFIER_LIMIT = 63;

/**
 * What marks a database as this tooling's to drop. `<app>` alone would also
 * match a database a person made by hand beside the dev one, and the sweeper
 * would take it.
 */
const DERIVED_INFIX = "_wt_";

/** Where derived dev ports live: above the ephemeral range Linux hands out, below 65535. */
const PORT_FLOOR = 20_000;
const PORT_CEILING = 60_000;

/** Ports a worktree may claim, all of them inside one block, so two branches cannot drift into each other. */
export const PORTS_PER_WORKTREE = 10;

/**
 * A branch name reduced to what Postgres and a human can both read: lowercase,
 * `_` for anything else, no leading digit, no repeated or trailing separators.
 * `feat/Add-Thing` and `feat/add_thing` collapse together, which is the right
 * trade — a collision is two worktrees sharing a database, and a branch pair
 * that differs only in punctuation is not a real pair.
 */
export function worktreeSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" || /^[0-9]/.test(slug) ? `w_${slug}` : slug;
}

/** The prefix every database this tooling owns carries, and nothing else does. */
export function databasePrefix(app: string): string {
  return `${worktreeSlug(app)}${DERIVED_INFIX}`;
}

/**
 * `<app>_wt_<branch>`, kept inside Postgres's 63 bytes. A name that would
 * overflow is cut and given a hash of the whole slug, because the cut alone
 * makes two long branches the same database — the collision this function
 * exists to prevent, arriving only for the branches nobody looks at closely.
 */
export function databaseName(app: string, branch: string): string {
  const prefix = databasePrefix(app);
  const full = `${prefix}${worktreeSlug(branch)}`;
  if (full.length <= IDENTIFIER_LIMIT) return full;
  const suffix = `_${hash(full).toString(36)}`;
  return `${full.slice(0, IDENTIFIER_LIMIT - suffix.length)}${suffix}`;
}

/**
 * This worktree's database in the shared connection string's own terms: same
 * host, same credentials, a database of its own.
 *
 * Parsed rather than pattern-matched. A URL with no path at all —
 * `postgres://user:pw@host:5432?sslmode=require` — has nothing that looks like
 * a database name, and the obvious regex eats the host instead.
 */
export function databaseUrl(shared: string, database: string): string {
  let url: URL;
  try {
    url = new URL(shared);
  } catch {
    // Deliberately without the value: it carries a password.
    throw new Error(
      "DATABASE_URL is not a URL — a password with reserved characters has to be percent-encoded",
    );
  }
  url.pathname = `/${database}`;
  return url.href;
}

/**
 * Where this worktree's ports live. Deterministic, so a worktree comes back to
 * the same block across restarts, and spread out, so two branches rarely start
 * in the same place — the probe decides which port inside the block is used.
 */
export function basePort(branch: string): number {
  const span = (PORT_CEILING - PORT_FLOOR) / PORTS_PER_WORKTREE;
  return PORT_FLOOR + (hash(worktreeSlug(branch)) % span) * PORTS_PER_WORKTREE;
}

/** Whether a port belongs to the block a branch's name picks. */
export function inBlock(base: number, port: number): boolean {
  return port >= base && port < base + PORTS_PER_WORKTREE;
}

/**
 * The first free port in this worktree's block. Deriving a port is a guess
 * about a machine's state, so the guess is checked — and the search always
 * starts at the block, never at wherever the last port landed: starting one
 * past a port that happened to be the block's last slot searches an empty
 * range, and a worktree that wandered past the end would land in the block
 * another branch is deterministically about to claim.
 */
export async function freePort(
  base: number,
  free: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let port = base; port < base + PORTS_PER_WORKTREE; port++) {
    if (await free(port)) return port;
  }
  throw new Error(
    `no free port left in ${base}-${base + PORTS_PER_WORKTREE - 1}, this worktree's block`,
  );
}

export interface Sweep {
  readonly drop: readonly string[];
  readonly keep: readonly string[];
}

/**
 * Which of the databases on the dev Postgres belong to a branch that is gone.
 *
 * Both sides of the comparison go through `databaseName`, rather than the
 * database names being parsed back into branches: the derivation is lossy —
 * punctuation collapses and long names are cut and hashed — so a name that came
 * out of it cannot be read backwards, and a sweeper that tried would drop the
 * databases of exactly the longest-named branches, which are still live.
 */
export function sweepPlan(
  app: string,
  databases: readonly string[],
  branches: readonly string[],
): Sweep {
  const prefix = databasePrefix(app);
  const live = new Set(branches.map((branch) => databaseName(app, branch)));
  const derived = databases.filter((name) => name.startsWith(prefix));
  return {
    drop: derived.filter((name) => !live.has(name)),
    keep: derived.filter((name) => live.has(name)),
  };
}

/** FNV-1a: short, stable across runs, and not a security claim — it names things. */
function hash(text: string): number {
  let value = 2_166_136_261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  return value;
}
