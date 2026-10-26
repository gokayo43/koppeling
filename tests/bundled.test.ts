import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTRPC } from "@trpc/server";
import { Schema } from "effect3host";
import { Elysia } from "elysia";

// oxlint-disable-next-line boundaries/no-unknown-dependencies -- the built artifact a host installs is what this suite loads
import { fromElysia, fromTrpcRouter } from "../dist/index.js";

/**
 * dist/ carries its own Effect 3, so a host may run any Effect or none. A
 * host's own Effect 3 schemas, from another install, are still read as
 * Effect schemas: Effect keys its type identifiers with `Symbol.for`.
 */
const ROOT = join(import.meta.dir, "..");

test("the built package reads a host's Effect 3 schema from another install of Effect 3", () => {
  // The likeliest wrong recognises a schema by its own copy's classes, so a
  // host's schema from its own install is "no language the door reads".
  const Shelf = Schema.Struct({ code: Schema.String, quantity: Schema.Int });
  const t = initTRPC.context<object>().create();
  const router = t.router({
    move: t.procedure.input(Schema.standardSchemaV1(Shelf)).mutation(() => 1),
  });
  const [move] = fromTrpcRouter(router, { contextFor: () => ({}) }).operations;
  const app = new Elysia().get("/api/shelves", () => ({ code: "A1", quantity: 1 }), {
    // Elysia types a response as TypeBox or a Standard Schema; a plain Effect
    // schema reaches it untyped, which is the case this pins.
    response: Object(Shelf),
  });
  const [shelves] = fromElysia(app, { credential: () => ({}), mount: "/api" }).operations;

  expect(move?.input).toMatchObject({ type: "object", required: ["code", "quantity"] });
  expect(shelves?.output).toMatchObject({ type: "object", required: ["code", "quantity"] });
});

test("the built package loads and derives a catalogue in a host whose effect is Effect 4", async () => {
  // A dist that imported its Effect from the host failed here at load:
  // "module 'effect' does not provide an export named 'JSONSchema'".
  const host = await mkdtemp(join(tmpdir(), "koppeling-host-"));
  try {
    const modules = join(host, "node_modules");
    await mkdir(join(modules, "koppeling", "dist"), { recursive: true });
    await cp(join(ROOT, "dist"), join(modules, "koppeling", "dist"), { recursive: true });
    await cp(join(ROOT, "package.json"), join(modules, "koppeling", "package.json"));
    await mkdir(join(modules, "@modelcontextprotocol"), { recursive: true });
    await mkdir(join(modules, "@trpc"), { recursive: true });
    for (const [name, real] of [
      ["effect", "effect4"],
      ["jose", "jose"],
      ["@modelcontextprotocol/server", "@modelcontextprotocol/server"],
      ["@trpc/server", "@trpc/server"],
    ] as const) {
      await symlink(join(ROOT, "node_modules", real), join(modules, name), "dir");
    }
    await writeFile(
      join(host, "host.ts"),
      `
import { initTRPC } from "@trpc/server";
import { Schema } from "effect";
import { fromTrpcRouter } from "koppeling";

const t = initTRPC.context<object>().create();
const Shelf = Schema.Struct({ code: Schema.String });
const router = t.router({
  move: t.procedure
    .input(Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(Shelf)))
    .mutation(() => 1),
});
const [move] = fromTrpcRouter(router, { contextFor: () => ({}) }).operations;
console.log(JSON.stringify({ hostEffect4: "toStandardJSONSchemaV1" in Schema, input: move?.input }));
`,
    );
    const child = Bun.spawn([process.execPath, "host.ts"], {
      cwd: host,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(error).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      hostEffect4: true,
      input: { type: "object", required: ["code"], additionalProperties: false },
    });
  } finally {
    await rm(host, { recursive: true, force: true });
  }
}, 30_000);
