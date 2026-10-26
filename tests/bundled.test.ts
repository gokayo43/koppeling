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

/**
 * Runs `script` as a host program would: in a directory of its own, with the
 * built package installed as it is shipped and `effect` resolving to `effect`,
 * the name of an installed copy (an alias such as `effect4`).
 */
async function asHost(effect: string, script: string) {
  const host = await mkdtemp(join(tmpdir(), "koppeling-host-"));
  try {
    const modules = join(host, "node_modules");
    await mkdir(join(modules, "koppeling", "dist"), { recursive: true });
    await cp(join(ROOT, "dist"), join(modules, "koppeling", "dist"), { recursive: true });
    await cp(join(ROOT, "package.json"), join(modules, "koppeling", "package.json"));
    await mkdir(join(modules, "@modelcontextprotocol"), { recursive: true });
    await mkdir(join(modules, "@trpc"), { recursive: true });
    for (const [name, real] of [
      ["effect", effect],
      ["jose", "jose"],
      ["@modelcontextprotocol/server", "@modelcontextprotocol/server"],
      ["@trpc/server", "@trpc/server"],
    ] as const) {
      await symlink(join(ROOT, "node_modules", real), join(modules, name), "dir");
    }
    await writeFile(join(host, "host.ts"), script);
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
    return { out, error, code };
  } finally {
    await rm(host, { recursive: true, force: true });
  }
}

test("the built package loads and derives a catalogue in a host whose effect is Effect 4", async () => {
  // A dist that imported its Effect from the host failed here at load:
  // "module 'effect' does not provide an export named 'JSONSchema'".
  const { out, error, code } = await asHost(
    "effect4",
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

  expect(error).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({
    hostEffect4: true,
    input: { type: "object", required: ["code"], additionalProperties: false },
  });
}, 30_000);

/**
 * A host on its own Effect 3 that serves five tool calls through the door and
 * runs its own effects, importing its Effect and the package in `order`.
 */
const sharedRuntimeHost = (order: "host first" | "package first") => `
const [host, door] = ${
  order === "host first"
    ? `[await import("effect"), await import("koppeling")]`
    : `await Promise.all([import("koppeling")]).then(async ([door]) => [await import("effect"), door])`
};
const { exportJWK, generateKeyPair, SignJWT } = await import("jose");
const { initTRPC } = await import("@trpc/server");

const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
globalThis.fetch = Object.assign(async () => Response.json({ keys: [jwk] }), {
  preconnect: globalThis.fetch.preconnect,
});
const resource = "https://wms.example/api/mcp";
const token = await new SignJWT({ sub: "person-1" })
  .setProtectedHeader({ alg: "ES256", kid: "k" })
  .setIssuer("https://portal.example")
  .setAudience(resource)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);
const t = initTRPC.context<object>().create();
const Shelf = host.Schema.Struct({ code: host.Schema.String });
const router = t.router({
  shelves: t.router({
    get: t.procedure.input(host.Schema.standardSchemaV1(Shelf)).query(({ input }) => input),
    move: t.procedure.mutation(() => 1),
  }),
});
const koppeling = door.koppeling({
  catalogue: door.fromTrpcRouter(router, { contextFor: () => ({}) }),
  glossary: "",
  resource: { url: resource, scopes: [] },
  identity: { issuer: "https://portal.example", jwksUrl: "https://portal.internal/jwks", authorizationServer: "https://portal.example" },
  actorFor: () => ({ actor: null }),
});
const calls = [
  ["list", {}],
  ["find", { words: "shelves" }],
  ["describe", { name: "shelves.get" }],
  ["read", { name: "shelves.get", input: { code: "A1" } }],
  ["write", { name: "shelves.move" }],
];
for (const [index, [name, args]] of calls.entries()) {
  const response = await koppeling.handle(
    new Request(resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  if (response.status !== 200) throw new Error("status " + response.status);
  await response.text();
  await host.Effect.runPromise(
    host.Schema.decodeUnknown(Shelf)({ code: "B" + index }).pipe(
      host.Effect.tap(() => host.Effect.sleep("1 millis")),
      host.Effect.flatMap((shelf) => host.Effect.log("host effect " + index + " " + shelf.code)),
    ),
  );
}
console.log("done");
`;

for (const order of ["host first", "package first"] as const) {
  test(`the built package and a host's own Effect 3 run side by side without a version warning, ${order}`, async () => {
    // Both copies read Effect's one global store, so each ran effects the
    // other made and logged "Executing an Effect versioned 3.22.1 with a
    // Runtime of version 3.22.3" on every step.
    const { out, error, code } = await asHost("effect3host", sharedRuntimeHost(order));

    expect(code).toBe(0);
    expect(out + error).not.toContain("Executing an Effect versioned");
    expect(out).toContain("host effect 4 B4");
    expect(out.trim().endsWith("done")).toBe(true);
  }, 30_000);
}
