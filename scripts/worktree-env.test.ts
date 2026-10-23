// Beside the module rather than under tests/, because the monorepo shape moves
// tests/ into apps/web and these scripts stay at the root in both shapes.
import { describe, expect, test } from "bun:test";

import {
  basePort,
  databaseName,
  databasePrefix,
  databaseUrl,
  freePort,
  inBlock,
  PORTS_PER_WORKTREE,
  sweepPlan,
  worktreeSlug,
} from "./worktree-env.ts";

describe("naming a worktree's world", () => {
  test("a branch becomes something Postgres and a human can both read", () => {
    expect(worktreeSlug("feat/Add-Thing")).toBe("feat_add_thing");
    expect(worktreeSlug("release/2026.08")).toBe("release_2026_08");
  });

  test("a slug never starts with a digit, because an identifier may not", () => {
    expect(worktreeSlug("123-fix")).toBe("w_123_fix");
    expect(worktreeSlug("2026.08")).toBe("w_2026_08");
  });

  test("punctuation never leaks out as a leading, trailing or doubled separator", () => {
    expect(worktreeSlug("--wip--")).toBe("wip");
    expect(worktreeSlug("a//b")).toBe("a_b");
    expect(worktreeSlug("///")).toBe("w_");
  });

  test("a derived database says whose it is, so nothing else is a candidate to drop", () => {
    expect(databaseName("shop", "feat/one")).toBe("shop_wt_feat_one");
    expect(databaseName("shop", "feat/one").startsWith(databasePrefix("shop"))).toBe(true);
  });

  // Postgres truncates at 63 bytes without a word, which is how two worktrees
  // end up sharing one database and nobody finds out until the data mixes.
  test("a long name is cut to what Postgres will actually store", () => {
    expect(databaseName("a".repeat(40), "b".repeat(40))).toHaveLength(63);
  });

  test("two branches of one app never share a database", () => {
    expect(databaseName("shop", "feat/one")).not.toBe(databaseName("shop", "feat/two"));
  });

  // Cutting alone gives both of these the same name — the collision the cut is
  // there to survive, arriving only for branches nobody reads closely.
  test("two branches too long to fit still get a database each", () => {
    const [one, two] = [`feat/${"a".repeat(80)}x`, `feat/${"a".repeat(80)}y`];
    expect(databaseName("shop", one)).not.toBe(databaseName("shop", two));
    expect(databaseName("shop", one)).toHaveLength(63);
  });

  test("the same branch always lands on the same name", () => {
    expect(databaseName("shop", "feat/one")).toBe(databaseName("shop", "feat/one"));
  });
});

describe("pointing the connection string at that database", () => {
  test("the database is replaced and nothing else is", () => {
    expect(databaseUrl("postgres://u:p@h:5432/app", "app_wt_one")).toBe(
      "postgres://u:p@h:5432/app_wt_one",
    );
  });

  test("query parameters survive, because sslmode is not optional where it is set", () => {
    expect(databaseUrl("postgres://u:p@h:5432/app?sslmode=require", "app_wt_one")).toBe(
      "postgres://u:p@h:5432/app_wt_one?sslmode=require",
    );
  });

  // A URL with no path has nothing that looks like a database name, and the
  // obvious regex eats the host instead — which is a connection to nowhere.
  test("a URL with no database at all keeps its host", () => {
    expect(databaseUrl("postgres://u:p@h:5432?sslmode=require", "app_wt_one")).toBe(
      "postgres://u:p@h:5432/app_wt_one?sslmode=require",
    );
  });

  test("a trailing slash is a database name of nothing, not a second path segment", () => {
    expect(databaseUrl("postgres://u:p@h:5432/", "app_wt_one")).toBe(
      "postgres://u:p@h:5432/app_wt_one",
    );
  });

  test("a percent-encoded password comes through untouched", () => {
    expect(databaseUrl("postgres://u:p%2Fw@h:5432/app", "app_wt_one")).toBe(
      "postgres://u:p%2Fw@h:5432/app_wt_one",
    );
  });

  test("something that is not a URL says so without printing the password", () => {
    expect(() => databaseUrl("host=localhost password=hunter2", "app_wt_one")).toThrow(
      /percent-encoded/,
    );
  });
});

describe("sweeping the databases whose branch is gone", () => {
  test("a branch that is gone is dropped and one that is still there is kept", () => {
    const databases = ["shop_wt_feat_one", "shop_wt_feat_two"];
    expect(sweepPlan("shop", databases, ["main", "feat/two"])).toEqual({
      drop: ["shop_wt_feat_one"],
      keep: ["shop_wt_feat_two"],
    });
  });

  // The dev database, a database somebody made by hand beside it, and whatever
  // else shares the Postgres. None of them are this program's to drop.
  test("nothing outside this app's worktrees is even considered", () => {
    const databases = ["shop", "shop_staging", "postgres", "other_wt_feat_one"];
    expect(sweepPlan("shop", databases, [])).toEqual({ drop: [], keep: [] });
  });

  // A branch long enough to be cut is exactly the case a sweeper that read the
  // branch back out of the database name would drop while it was live.
  test("a branch too long to fit in a database name is still recognised as live", () => {
    const branch = `feat/${"a".repeat(80)}`;
    const database = databaseName("shop", branch);
    expect(sweepPlan("shop", [database], [branch])).toEqual({ drop: [], keep: [database] });
  });
});

/**
 * What a promise did, as one comparable value. `expect(...).rejects` returns
 * nothing to await in bun:test, and an assertion the test cannot wait for is an
 * assertion the runner may never see — so the rejection is caught here, and a
 * promise that resolves fails the comparison rather than passing quietly.
 */
async function outcome(work: Promise<unknown>): Promise<string> {
  return await work.then(
    (value) => `resolved with ${String(value)}`,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is `unknown` by the language's contract: `then`'s second argument receives whatever was thrown, and the `instanceof` below is where it becomes a string
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("finding ports", () => {
  test("a branch starts at the same block every time", () => {
    expect(basePort("feat/one")).toBe(basePort("feat/one"));
    expect(basePort("feat/one") % PORTS_PER_WORKTREE).toBe(0);
  });

  test("the block sits above the ephemeral range and inside the port space", () => {
    for (const branch of ["main", "feat/one", "feat/two", "release/2026.08", "x"]) {
      expect(basePort(branch)).toBeGreaterThanOrEqual(20_000);
      expect(basePort(branch)).toBeLessThan(60_000);
    }
  });

  test("different branches usually start apart", () => {
    const bases = new Set(["a", "b", "c", "d", "e", "f"].map(basePort));
    expect(bases.size).toBe(6);
  });

  // The derived port is a guess about a machine; what the probe accepts is what
  // gets used and what gets reported.
  test("a taken port is stepped over", async () => {
    const taken = new Set([20_000, 20_001, 20_002]);
    expect(await freePort(20_000, async (port) => !taken.has(port))).toBe(20_003);
  });

  test("a free port is taken as it stands", async () => {
    expect(await freePort(30_000, async () => true)).toBe(30_000);
  });

  // Every search starts at the block, whatever the last one found: starting one
  // past a port that happened to be the block's last slot searches nothing.
  test("the search always covers the whole block", async () => {
    const taken = new Set([30_009]);
    expect(await freePort(30_000, async (port) => !taken.has(port))).toBe(30_000);
    expect(inBlock(30_000, await freePort(30_000, async (port) => port > 30_005))).toBe(true);
  });

  test("a port outside the block is not one of this worktree's", () => {
    expect(inBlock(30_000, 30_000)).toBe(true);
    expect(inBlock(30_000, 30_009)).toBe(true);
    expect(inBlock(30_000, 30_010)).toBe(false);
    expect(inBlock(30_000, 29_999)).toBe(false);
  });

  // Wandering out of the block would land on the ports another branch is
  // deterministically about to claim, which is the collision being avoided.
  test("a full block fails loudly rather than spilling into the next one", async () => {
    expect(await outcome(freePort(30_000, async () => false))).toBe(
      "no free port left in 30000-30009, this worktree's block",
    );
  });
});
