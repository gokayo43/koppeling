import { afterAll, beforeAll, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { schemaProbe } from "~/server/probe.ts";
import { account, session, user } from "~/server/schema.ts";

// Real SQL, in-process: the generated migrations run against a live Postgres
// engine, so a schema that drifts from the tables the code queries fails here
// rather than at deploy time.
const client = new PGlite();
const db = drizzle(client);

beforeAll(async () => {
  // Resolved from this file, not the working directory, so the suite behaves the
  // same run from the repo root as from a workspace.
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
});

// An open PGlite keeps the loop alive: bun test then exits non-zero with every
// test passing, which reads exactly like a broken suite.
afterAll(async () => {
  await client.close();
  // The other half of the same trap. PGlite's Postgres is a WASM program that
  // ends its startup by calling exit(99) — emscripten writes that number
  // straight into this process's exit code, and bun's runner only overwrites it
  // when something failed. Put back, and only that number: any other non-zero
  // code here belongs to something this file has no business clearing.
  if (process.exitCode === 99) process.exitCode = 0;
});

test("the generated migrations produce the schema the code queries", async () => {
  await db.insert(user).values({ id: "u1", name: "Ada", email: "ada@example.com" });

  const rows = await db.select().from(user).where(eq(user.email, "ada@example.com"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe("Ada");
  // Defaulted columns are what a hand-edited migration silently drops.
  expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  // A $defaultFn is applied by drizzle on insert, not by Postgres — it is only
  // correct if the column reached the INSERT statement.
  expect(rows[0]?.emailVerified).toBe(false);
});

test("deleting an identity takes its sessions and accounts with it", async () => {
  await db.insert(user).values({ id: "u2", name: "Grace", email: "grace@example.com" });
  await db.insert(session).values({
    id: "s1",
    userId: "u2",
    token: "session-token",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(account).values({
    id: "a1",
    userId: "u2",
    accountId: "grace@example.com",
    providerId: "credential",
  });

  await db.delete(user).where(eq(user.id, "u2"));

  // Orphaned sessions are live credentials: the cascade is a security property,
  // not a tidiness one.
  expect(await db.select().from(session)).toHaveLength(0);
  expect(await db.select().from(account)).toHaveLength(0);
});

// A database is only serveable once the migrations have run, and the health
// route says this instance can serve. `select 1` — what the probe used to be —
// answers from a database with no tables in it at all, so an app that came up
// before its migrations reported itself healthy and the CI boot gate agreed.
test("the schema probe refuses a database the migrations never touched", async () => {
  const empty = new PGlite();
  try {
    // Resolved to a string either way, so a probe that wrongly *answers* fails
    // this assertion rather than slipping past a rejection matcher.
    const outcome = await schemaProbe(drizzle(empty)).then(
      () => "the probe answered",
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is `unknown` by the language's contract: `then`'s second argument receives whatever was thrown, and stringifying it is what the assertion below matches on
      (error: unknown) => String(error),
    );

    // Matched on the statement rather than the outcome: this separates
    // "rejected because the table is not there" from "rejected at all", which
    // a probe that failed for any other reason would also satisfy. Drizzle owns
    // the wording, so a drizzle upgrade can break this line — deliberately.
    expect(outcome).toMatch(/Failed query: select .* from "user"/);
  } finally {
    await empty.close();
  }
});

test("the schema probe answers against the migrated database", async () => {
  // Resolving is the claim: the probe reads a migrated table's own columns, so
  // anything the database is missing arrives as a rejection instead — awaited
  // here, where it fails this case with the database's own message.
  //
  // `expect(…).resolves` would say it more directly and cannot be used: bun
  // types that chain as returning void, so awaiting it is a type error and not
  // awaiting it leaves the assertion running after the case has ended.
  expect(await schemaProbe(db)).toBeUndefined();
});
