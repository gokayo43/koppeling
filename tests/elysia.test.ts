import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { Schema } from "effect";
import { Elysia, t, type AnyElysia } from "elysia";
import { array, constantFrom, integer, property, tuple, uniqueArray } from "fast-check";

import { copy } from "../src/copy";
import { fromElysia } from "../src/index";
import { apiApp, credential, type ApiActor } from "./fixtures/api";
import { apiCaller } from "./fixtures/doors";

/** A signal no case aborts, for a run the case lets finish. */
const unaborted = new AbortController().signal;

const MCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];
type Route = readonly [Method, readonly string[]];
const WORDS = ["orders", "items", "p1", "fit~list"] as const;

/** Routes under `/api`, whose segments may be words or `:p<position>` parameters. */
const routes = uniqueArray(
  tuple(
    constantFrom(...METHODS),
    array(integer({ min: 0, max: WORDS.length }), { minLength: 1, maxLength: 4 }).map((picks) =>
      picks.map((pick, position) => WORDS[pick] ?? `:p${position}`),
    ),
  ),
  { selector: ([method, segments]) => `${method} /${segments.join("/")}`, maxLength: 12 },
);

function appOf(declared: readonly Route[]) {
  const app = new Elysia({ prefix: "/api" });
  for (const [method, segments] of declared)
    app.route(method, `/${segments.join("/")}`, () => "ok");
  return new Elysia().get("/health", () => "ok").use(app);
}

/** The name the rule gives a route: its segments, parameters by name, then its method. */
const nameOf = ([method, segments]: Route) =>
  [
    ...segments.map((segment) => segment.replace(/^:/, "").replaceAll(/[^A-Za-z0-9_-]/g, "_")),
    method.toLowerCase(),
  ].join(".");

const derive = (declared: readonly Route[]) =>
  fromElysia(appOf(declared), { credential, mount: "/api" });

test("every route under the mount is one operation with a unique MCP name, or the boot names the clash", () => {
  check(
    property(routes, (declared) => {
      const expected = declared.map(nameOf);
      if (new Set(expected).size < expected.length) {
        expect(() => derive(declared)).toThrow("Two operations are both named");
        return;
      }
      const derived = derive(declared);
      expect(derived.operations.map(({ name }) => name)).toEqual(expected.toSorted());
      for (const operation of derived.operations) {
        const [method] = declared[expected.indexOf(operation.name)] ?? [];
        expect(operation.name).toMatch(MCP_NAME);
        expect(operation.kind).toBe(method === "GET" || method === "HEAD" ? "read" : "write");
        expect(operation.area).toBe(operation.name.split(".")[0] ?? "");
      }
    }),
  );
});

test("two derivations of one app agree, in order", () => {
  check(
    property(routes, (declared) => {
      const attempt = () => {
        try {
          return { names: derive(declared).operations.map(({ name }) => name) };
        } catch (error) {
          return { refused: String(error) };
        }
      };
      expect(attempt()).toEqual(attempt());
    }),
  );
});

const api = () => fromElysia(apiApp(), { credential, mount: "/api/v1" });
const operation = (name: string) => {
  const found = api().operations.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

test("routes outside the mount are not the door's, and WebSocket routes are skipped and named", () => {
  const derived = api();

  expect(derived.operations.some(({ name }) => name.startsWith("health"))).toBe(false);
  expect(derived.skipped).toEqual([
    { name: "live.ws", reason: "a WebSocket route, which the door does not serve" },
    { name: "orders.honeypot.post", reason: "hidden by the program" },
  ]);
});

test("the input composes the route's params, query and body, and the output is its 200 response", () => {
  expect(operation("vehicles.lookup.lookup_id.selection.post").input).toEqual({
    type: "object",
    properties: {
      params: {
        type: "object",
        required: ["lookup_id"],
        properties: { lookup_id: { type: "string" } },
        additionalProperties: false,
      },
      query: { type: "object", additionalProperties: true, description: copy.undeclaredPart },
      body: {
        type: "object",
        required: ["option_index"],
        properties: { option_index: { type: "number" } },
        additionalProperties: false,
      },
    },
    required: ["params", "body"],
    additionalProperties: false,
  });
  expect(operation("vehicles.compatibility.get").input).toMatchObject({ required: [] });
  expect(operation("vehicles.lookup.get").input).toMatchObject({ required: ["query"] });
  expect(operation("orders.token.get").input).toMatchObject({
    properties: { params: { properties: { token: { type: "string" } }, required: ["token"] } },
  });
  expect(operation("products.id.get").output).toMatchObject({
    type: "object",
    required: ["id", "name", "price"],
  });
  expect(operation("orders.post").input).toMatchObject({
    properties: { body: { anyOf: [{ type: "object" }, {}] } },
  });
  expect(operation("orders.post").input["properties"]).not.toHaveProperty(
    "body.unevaluatedProperties",
  );
});

test("a part the route declares no schema for is shown open and not required, a body only where the method carries one", () => {
  // The likeliest wrong shape closes every part: a handler that reads a query
  // or a body it never declared would then be refused what it reads.
  const app = new Elysia().get("/api/v1/tree", () => 1).post("/api/v1/notes", () => 1);
  const [notes, tree] = fromElysia(app, { credential, mount: "/api/v1" }).operations;

  expect(tree?.input).toEqual({
    type: "object",
    properties: {
      query: { type: "object", additionalProperties: true, description: copy.undeclaredPart },
    },
    required: [],
    additionalProperties: false,
  });
  expect(notes?.input).toEqual({
    type: "object",
    properties: {
      query: { type: "object", additionalProperties: true, description: copy.undeclaredPart },
      body: { description: copy.undeclaredPart },
    },
    required: [],
    additionalProperties: false,
  });
});

test("a response map without 200 describes its lowest 2xx, or no output when it has none", () => {
  expect(operation("vehicles.picks.post").output).toMatchObject({
    type: "object",
    required: ["pick_id"],
  });
  expect(operation("vehicles.retired.get").output).toBeUndefined();
});

test("an area function groups operations without renaming them, held to the name rule", () => {
  const app = new Elysia({ prefix: "/api" })
    .get("/admin/products/:id", () => 1)
    .get("/admin/orders", () => 1)
    .get("/vehicles/tree", () => 1);
  const derived = fromElysia(app, {
    credential,
    mount: "/api",
    area: (segments) =>
      segments[0] === "admin" ? `admin.${segments[1] ?? ""}` : (segments[0] ?? ""),
  });

  expect(derived.operations.map(({ name, area }) => `${name} ${area}`)).toEqual([
    "admin.orders.get admin.orders",
    "admin.products.id.get admin.products",
    "vehicles.tree.get vehicles",
  ]);
  expect(() =>
    fromElysia(app, { credential, mount: "/api", area: () => "beheer producten" }),
  ).toThrow('"beheer producten" is not a valid area name');
});

test("a route the program hides from its own documentation is skipped and named", () => {
  expect(api().operations.some(({ name }) => name === "orders.honeypot.post")).toBe(false);
  expect(api().skipped).toContainEqual({
    name: "orders.honeypot.post",
    reason: "hidden by the program",
  });
});

test("summary and description become the operation's line and its detail", () => {
  expect(operation("vehicles.lookup.get").description).toBe(
    "License plate vehicle lookup\nResolves a Dutch license plate to its vehicle.",
  );
  expect(operation("orders.fail.get").description).toBeUndefined();
});

test("a guard's schema is composed with the route's own", () => {
  const app = new Elysia({ prefix: "/api" }).guard(
    { query: t.Object({ shop: t.String() }) },
    (guarded) => guarded.get("/stock", () => 1, { query: t.Object({ sku: t.String() }) }),
  );
  const [stock] = fromElysia(app, { credential, mount: "/api" }).operations;

  expect(stock?.input).toMatchObject({
    properties: { query: { allOf: [{ required: ["sku"] }, { required: ["shop"] }] } },
    required: ["query"],
  });
});

test("a 5xx answer is a failure after the program was reached, not a refusal it answers", async () => {
  const outcome = await operation("orders.fail.get").run(apiCaller, {}, unaborted);

  expect("failed" in outcome && String(outcome.failed)).toBe(
    "Error: HTTP 500: database unavailable",
  );
});

test("a 4xx answer's JSON body comes back as the refusal's details, and a text body as none", async () => {
  expect(
    await operation("vehicles.lookup.get").run(
      apiCaller,
      { query: { license_plate: "00-XX-00" } },
      unaborted,
    ),
  ).toEqual({
    refusal: 'HTTP 404: {"error":{"code":"plate_not_found","message":"Kenteken niet gevonden"}}',
    details: { error: { code: "plate_not_found", message: "Kenteken niet gevonden" } },
  });
  expect(await operation("vehicles.retired.get").run(apiCaller, {}, unaborted)).toEqual({
    refusal: "HTTP 410: Gone",
  });
});

test("a call goes through the app's own auth with the actor's credential", async () => {
  const product = operation("products.id.get");

  expect(await product.run(apiCaller, { params: { id: 4 } }, unaborted)).toEqual({
    value: { id: 4, name: "Product", price: 10 },
  });
  expect(
    await product.run({ key: "someone-else" } satisfies ApiActor, { params: { id: 4 } }, unaborted),
  ).toEqual({
    refusal: "HTTP 401: Unauthorized",
  });
});

test("query values, arrays among them, and a JSON body reach the route as a client sends them", async () => {
  const seen: unknown[] = [];
  const app = new Elysia({ prefix: "/api" })
    .get("/search", ({ query }) => query, {
      query: t.Object({ q: t.String(), tag: t.Array(t.String()) }),
    })
    .post("/notes/:id", ({ params, body }) => {
      seen.push(body);
      return params;
    });
  const derived = fromElysia(app, { credential, mount: "/api" });
  const [notes, search] = derived.operations;

  expect(
    await search?.run(apiCaller, { query: { q: "uitlaat", tag: ["a", "b"] } }, unaborted),
  ).toEqual({
    value: { q: "uitlaat", tag: ["a", "b"] },
  });
  expect(
    await notes?.run(apiCaller, { params: { id: "a/b" }, body: { text: "hoi" } }, unaborted),
  ).toEqual({
    value: { id: "a/b" },
  });
  expect(seen).toEqual([{ text: "hoi" }]);
});

test("a missing path parameter or an input that is not an object is refused before the app is asked", async () => {
  const invoked: string[] = [];
  const derived = fromElysia(
    apiApp((route) => invoked.push(route)),
    { credential, mount: "/api/v1" },
  );
  const token = derived.operations.find(({ name }) => name === "orders.token.get");

  expect(await token?.run(apiCaller, {}, unaborted)).toEqual({
    refusal: "De invoer mist params.token, dat in het pad staat.",
  });
  expect(await token?.run(apiCaller, "ord-1", unaborted)).toHaveProperty("refusal");
  expect(invoked).toEqual([]);
});

test("named models are read from the app's definitions, never through its compiling models getter", () => {
  const models = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `nfp.m${index}`,
      t.Object({ [`field${index}`]: t.String() }),
    ]),
  );
  const app = new Elysia({ prefix: "/api" }).model(models);
  for (const name of Object.keys(models)) {
    app.post(`/${name.replace("nfp.", "")}`, ({ body }) => body, {
      body: name,
      response: { 200: name },
    });
  }
  let reads = 0;
  Object.defineProperty(app, "models", {
    get: () => {
      reads += 1;
      return undefined;
    },
  });
  const derived = fromElysia(app, { credential, mount: "/api" });

  expect(reads).toBe(0);
  expect(derived.operations.find(({ name }) => name === "m3.post")?.input).toMatchObject({
    properties: { body: { required: ["field3"] } },
  });
});

test("a path parameter that is empty, '.' or '..' is refused, so a call never reaches another route", async () => {
  const ran: string[] = [];
  const app = new Elysia()
    .post("/outside", () => ran.push("POST /outside"))
    .post("/api/v1/admin/refund", () => ran.push("POST /api/v1/admin/refund"))
    .post("/api/v1/orders/:a/:b/refund", () => ran.push("POST /api/v1/orders/:a/:b/refund"));
  const refund = fromElysia(app, { credential, mount: "/api/v1" }).operations.find(
    ({ name }) => name === "orders.a.b.refund.post",
  );
  for (const params of [
    { a: "..", b: "admin" },
    { a: "..", b: ".." },
    { a: ".", b: "x" },
    { a: "", b: "x" },
  ]) {
    expect(await refund?.run(apiCaller, { params }, unaborted)).toHaveProperty("refusal");
  }
  expect(
    await refund?.run(apiCaller, { params: { a: "../..", b: "x" } }, unaborted),
  ).toHaveProperty("value");
  expect(ran).toEqual(["POST /api/v1/orders/:a/:b/refund"]);
});

test("a path parameter equal to a static sibling route's segment is refused, so that route never runs", async () => {
  const ran: string[] = [];
  const app = new Elysia()
    .get("/api/v1/orders/:id", ({ params }) => {
      ran.push(`order ${params.id}`);
      return params.id;
    })
    .get(
      "/api/v1/orders/export",
      () => {
        ran.push("export");
        return "every order";
      },
      { detail: { koppeling: false } },
    );
  const [order] = fromElysia(app, { credential, mount: "/api/v1" }).operations;

  expect(order?.name).toBe("orders.id.get");
  expect(await order?.run(apiCaller, { params: { id: "export" } }, unaborted)).toHaveProperty(
    "refusal",
  );
  expect(await order?.run(apiCaller, { params: { id: "exports" } }, unaborted)).toEqual({
    value: "exports",
  });
  expect(await order?.run(apiCaller, { params: { id: "export2" } }, unaborted)).toEqual({
    value: "export2",
  });
  expect(ran).toEqual(["order exports", "order export2"]);
});

/**
 * An app where `GET`/`HEAD /api/v1/orders/:id` and `GET /api/v1/orders/:id/lines/:line`
 * sit beside siblings Elysia's router prefers for some values; every handler
 * answers its own name, so the app itself says which route a path reaches.
 */
function siblingApp() {
  const ran: string[] = [];
  const answer = (route: string) => () => {
    ran.push(route);
    return route;
  };
  const app = new Elysia()
    .get("/api/v1/orders/:id", answer("order"))
    .head("/api/v1/orders/:id", answer("order head"))
    .get("/api/v1/orders/:id/lines/:line", answer("line"))
    .get("/api/v1/orders/export/:format?", answer("export"), { detail: { koppeling: false } })
    .get("/api/v1/orders/files/*", answer("files"), { detail: { koppeling: false } })
    .get("/api/v1/orders/a b", answer("spaced"), { detail: { koppeling: false } })
    .get("/api/v1/orders/report", answer("report"), { detail: { hide: true } });
  return { app, ran };
}

/** What Elysia itself runs for a request, by the handler's own name. */
async function reachedBy(app: AnyElysia, method: string, path: string, ran: string[]) {
  ran.length = 0;
  await app.handle(new Request(`http://localhost${path}`, { method }));
  return ran[0];
}

test("a path parameter that would reach another route, by Elysia's own router, is refused", async () => {
  const { app, ran } = siblingApp();
  const byName = new Map(
    fromElysia(app, { credential, mount: "/api/v1" }).operations.map((op) => [op.name, op]),
  );
  const run = async (name: string, params: { readonly [key: string]: string }) => {
    ran.length = 0;
    const outcome = await byName.get(name)?.run(apiCaller, { params }, unaborted);
    return { outcome, ran: [...ran] };
  };
  const orders = (id: string) => `/api/v1/orders/${encodeURIComponent(id)}`;

  // An optional-parameter sibling, an encoded static one and a plain static one:
  // Elysia itself sends these ids elsewhere, so the door refuses them, for GET
  // and for HEAD, and runs nothing.
  for (const id of ["export", "a b", "report"]) {
    expect(await reachedBy(app, "GET", orders(id), ran)).not.toBe("order");
    expect(await run("orders.id.get", { id })).toEqual({
      outcome: { refusal: copy.routedElsewhere(["id"]) },
      ran: [],
    });
    expect((await run("orders.id.head", { id })).outcome).toHaveProperty("refusal");
  }
  // A wildcard sibling shorter than the route catches it at depth.
  expect(await reachedBy(app, "GET", "/api/v1/orders/files/lines/3", ran)).toBe("files");
  expect(await run("orders.id.lines.line.get", { id: "files", line: "3" })).toEqual({
    outcome: { refusal: copy.routedElsewhere(["id"]) },
    ran: [],
  });
  // Elysia answers HEAD with a matching GET route before its own HEAD route,
  // so the HEAD handler is never what runs here, and the door says so.
  expect(await reachedBy(app, "HEAD", orders("exports"), ran)).toBe("order");
  expect((await run("orders.id.head", { id: "exports" })).outcome).toHaveProperty("refusal");
  // Values no sibling spells go through to the operation's own route.
  for (const id of ["exports", "export2", "files", "a-b"]) {
    expect(await reachedBy(app, "GET", orders(id), ran)).toBe("order");
    expect(await run("orders.id.get", { id })).toEqual({
      outcome: { value: "order" },
      ran: ["order"],
    });
  }
  expect(await run("orders.id.lines.line.get", { id: "1001", line: "3" })).toEqual({
    outcome: { value: "line" },
    ran: ["line"],
  });
});

test("an app built with aot: false is checked against the router it routes with", async () => {
  const ran: string[] = [];
  const answer = (route: string) => () => {
    ran.push(route);
    return route;
  };
  const app = new Elysia({ aot: false })
    .get("/api/v1/orders/:id", answer("order"))
    .get("/api/v1/orders/export/:format?", answer("export"), { detail: { koppeling: false } })
    .get("/api/v1/orders/a b", answer("spaced"), { detail: { koppeling: false } });
  const [order] = fromElysia(app, { credential, mount: "/api/v1" }).operations;

  expect(order?.name).toBe("orders.id.get");
  for (const id of ["export", "a b"]) {
    expect(await order?.run(apiCaller, { params: { id } }, unaborted)).toEqual({
      refusal: copy.routedElsewhere(["id"]),
    });
  }
  expect(await order?.run(apiCaller, { params: { id: "exports" } }, unaborted)).toEqual({
    value: "order",
  });
  expect(ran).toEqual(["order"]);
});

test("a parameterised route the door cannot find in Elysia's router fails the boot, naming it", () => {
  const app = new Elysia().get("/api/v1/orders/:id", () => "order");
  // An app whose routes live where the door does not look: its router answers
  // nothing for the route's own path.
  Object.defineProperty(app.router, "http", { value: { find: () => null } });

  expect(() => fromElysia(app, { credential, mount: "/api/v1" })).toThrow(
    "Elysia route GET /api/v1/orders/:id",
  );
});

test("a route the program withholds from the door is skipped and named, apart from hidden ones", () => {
  const app = new Elysia({ prefix: "/api" })
    .post("/tokens", () => 1, { detail: { koppeling: false } })
    .get("/docs", () => 1, { detail: { hide: true } })
    .get("/stock", () => 1);
  const derived = fromElysia(app, { credential, mount: "/api" });

  expect(derived.operations.map(({ name }) => name)).toEqual(["stock.get"]);
  expect(derived.skipped).toEqual([
    { name: "docs.get", reason: "hidden by the program" },
    { name: "tokens.post", reason: "withheld by the program" },
  ]);
});

test("a response that is an Effect 3 schema, plain or as a Standard Schema, is the output", () => {
  const Item = Schema.Struct({ id: Schema.Number });
  const app = new Elysia({ prefix: "/api" })
    // Elysia types a response as TypeBox or a Standard Schema; a plain Effect
    // schema reaches it untyped, which is the case this pins.
    .get("/plain", () => ({ id: 1 }), { response: Object(Item) })
    .get("/standard", () => ({ id: 1 }), { response: Schema.standardSchemaV1(Item) });
  for (const route of fromElysia(app, { credential, mount: "/api" }).operations) {
    expect(route.output).toMatchObject({ type: "object", required: ["id"] });
  }
});

test("a route naming a model the app does not have fails the boot, naming the route", () => {
  // A model name is checked against the app's models by its type too, which
  // is the check this case is about at run time.
  // @ts-expect-error -- names a model the app does not declare
  const app = new Elysia({ prefix: "/api" }).get("/x", () => 1, { response: { 200: "nope" } });

  expect(() => fromElysia(app, { credential, mount: "/api" })).toThrow(
    'Elysia route GET /api/x (response 200): names a model "nope"',
  );
});
