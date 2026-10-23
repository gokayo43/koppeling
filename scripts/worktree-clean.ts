// oxlint-disable no-console -- stdout is this script's interface: it is a CLI whose whole output is what it dropped
/**
 * Drops the worktree databases whose branch is gone.
 *
 *   bun run worktree:clean          # says what it would do and does it
 *
 * Never automatic and never silent: a database is the one thing in a worktree
 * world that outlives `git worktree remove`, and dropping one is not
 * recoverable, so this is a thing a person or an agent runs on purpose and
 * reads the output of. Only databases carrying the `<app>_wt_` prefix this
 * tooling creates are ever candidates — a database somebody made by hand beside
 * the dev one is not this program's to drop.
 */
import { $ } from "bun";

import { compose, devStack, POSTGRES_SERVICE, psql } from "./dev-stack.ts";
import { sweepPlan } from "./worktree-env.ts";

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const stack = await devStack();

// psql truncates nothing at `-tA`, and the shell in between never sees a name:
// the query is one column, one row each.
const listed = await psql(stack, "select datname from pg_database where not datistemplate");
if (listed.exitCode !== 0) {
  throw new Error(`could not list databases: ${listed.stderr.toString().trim()}`);
}

// Interpolated, not written inline: Bun Shell parses `(` as its own syntax.
const format = "--format=%(refname:short)";
const branches = await $`git for-each-ref ${format} refs/heads`.text();

const { drop, keep } = sweepPlan(stack.app, lines(listed.stdout.toString()), lines(branches));

for (const name of drop) {
  const dropped = await compose(
    stack,
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "dropdb",
    "-U",
    stack.user,
    name,
  );
  console.log(
    dropped.exitCode === 0
      ? `dropped  ${name}`
      : `FAILED   ${name}: ${dropped.stderr.toString().trim()}`,
  );
}
for (const name of keep) console.log(`kept     ${name} (branch still exists)`);

if (drop.length === 0 && keep.length === 0) console.log("no worktree databases");
