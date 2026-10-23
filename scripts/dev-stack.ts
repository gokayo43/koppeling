/**
 * The dev compose stack, and which checkout owns it.
 *
 * A linked worktree has no `.env` and no compose project of its own — those
 * belong to the primary checkout, and a worktree borrows them. So every caller
 * here asks one question ("which checkout am I in, and what is it called?") and
 * gets one answer back, rather than each rediscovering a piece of it.
 */
import { dirname } from "node:path";
import { parseEnv } from "node:util";

import { $ } from "bun";

/** Some hosts only reach the daemon socket through sudo; the deploy box is one. */
const DOCKER = process.env["DOCKER"] ?? "docker";

/** The one service every shape declares, and the only one a database is made on. */
export const POSTGRES_SERVICE = "postgres";

/**
 * An environment as a process is given one: every value optional, because that
 * is what `process.env` and a parsed env file both are. Named because several
 * modules pass one around, and an anonymous open dictionary at each of them is
 * the same contract written down four times.
 */
export type ProcessEnv = Record<string, string | undefined>;

/** No repository means no worktree to be in and no primary checkout to borrow from. */
const OUTSIDE_A_REPO = { top: process.cwd(), root: process.cwd(), branch: undefined } as const;

export interface DevStack {
  /** This checkout's top level: where a worktree's own files are written. */
  readonly top: string;
  /** The primary checkout: where docker-compose.yml and .env live. */
  readonly root: string;
  /** The branch of the linked worktree the caller is in; undefined in the primary checkout. */
  readonly branch: string | undefined;
  /** The project's package name — `<app>` in every derived name. */
  readonly app: string;
  /** The compose Postgres superuser, which the compose file names after the app. */
  readonly user: string;
  /** Whether this repo is Bun workspaces, which is what makes a second port worth deriving. */
  readonly monorepo: boolean;
}

/**
 * Resolved from git, and from git alone. Outside a repository there is no
 * worktree to be in and no primary checkout to borrow from — gitPlaces() below
 * says when that happens, and why it is a case at all.
 */
export async function devStack(): Promise<DevStack> {
  const places = await gitPlaces();
  if (places === undefined) return { ...(await namesAt(process.cwd())), ...OUTSIDE_A_REPO };
  const [top, dir, common] = places;
  const linked = dir !== common;
  const [names, branch] = await Promise.all([namesAt(top), linked ? branchName() : undefined]);
  return { ...names, top, root: linked ? dirname(common) : top, branch };
}

/**
 * The three paths that say which checkout this is, in one call. `undefined`
 * means there is nothing here for git to answer about — no repository, or no
 * git at all. Both are the production image: `.dockerignore` drops `.git`, the
 * runtime carries no git binary, and the migrate service still runs the package
 * script that comes through here.
 *
 * Any OTHER failure is raised rather than read as "no repository": a broken
 * index or a directory git refuses to own would otherwise be answered with the
 * primary checkout's database, which is the one database a worktree must never
 * silently be given.
 */
async function gitPlaces(): Promise<[string, string, string] | undefined> {
  const run =
    await $`git rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir`
      .quiet()
      .nothrow();
  if (run.exitCode !== 0) {
    const message = run.stderr.toString().trim();
    if (/not a git repository|command not found/i.test(message)) return undefined;
    throw new Error(`git could not say which checkout this is: ${message}`);
  }
  const [top, dir, common] = run.stdout.toString().trim().split("\n");
  if (top === undefined || dir === undefined || common === undefined) {
    throw new Error(`git rev-parse answered with ${run.stdout.toString().trim()}`);
  }
  return [top, dir, common];
}

/**
 * A detached HEAD has no branch to name a world after, and every detached
 * worktree would answer `HEAD` — one shared database that `worktree:clean` then
 * drops while they are all still using it.
 */
async function branchName(): Promise<string> {
  const run = await $`git rev-parse --abbrev-ref HEAD`.quiet().nothrow();
  const branch = run.stdout.toString().trim();
  if (run.exitCode !== 0 || branch === "HEAD") {
    throw new Error(
      "this worktree is on a detached HEAD — check out a branch: the derived database and ports are named after one",
    );
  }
  return branch;
}

async function namesAt(root: string): Promise<{ app: string; user: string; monorepo: boolean }> {
  const parsed: unknown = await Bun.file(`${root}/package.json`).json();
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    throw new Error(`${root}/package.json has no name`);
  }
  const { name } = parsed;
  if (typeof name !== "string" || name === "") {
    throw new Error(`${root}/package.json has no name`);
  }
  return { app: name, user: name.replaceAll("-", "_"), monorepo: "workspaces" in parsed };
}

/**
 * A compose command against the dev stack. Always from the primary checkout:
 * compose interpolates `.env` from its working directory, and a worktree has
 * none — running it from the worktree fails on the first `${POSTGRES_PASSWORD}`
 * rather than on anything to do with the command.
 */
export function compose(stack: DevStack, ...args: string[]) {
  // raw, because DOCKER is a command line — "sudo docker" on hosts that only
  // reach the daemon that way — and has to split into words.
  return $`${{ raw: DOCKER }} compose ${args}`.cwd(stack.root).quiet().nothrow();
}

/** A single-value query on the dev Postgres, as its own superuser. */
export function psql(stack: DevStack, sql: string) {
  return compose(stack, "exec", "-T", POSTGRES_SERVICE, "psql", "-U", stack.user, "-tAc", sql);
}

/**
 * The primary checkout's `.env`, parsed. It is the shared configuration a
 * worktree layers its own database and ports over — never edited, only read.
 */
export async function sharedEnv(stack: DevStack): Promise<ProcessEnv> {
  const file = Bun.file(`${stack.root}/.env`);
  return (await file.exists()) ? parseEnv(await file.text()) : {};
}
