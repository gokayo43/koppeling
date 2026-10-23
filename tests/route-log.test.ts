import { beforeEach, expect, test } from "bun:test";

import type { Register } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";

// env.ts parses the process environment once, when it is first evaluated, so
// this comes before the import rather than after: a static import would already
// have run. The three beside the flag are what the app needs in order to exist
// — nothing here opens a connection, and a value that could reach a real
// database is the last thing this file wants.
const ENVIRONMENT = {
  ROUTE_LOG: "true",
  DATABASE_URL: "postgres://route-log:route-log@127.0.0.1:1/route-log",
  SITE_URL: "http://localhost",
  BETTER_AUTH_SECRET: "route-log-not-a-secret-route-log-not",
};
Object.assign(process.env, ENVIRONMENT);
const { withRouteLog } = await import("~/server/route-log.ts");

const MODULE = new URL("../src/server/route-log.ts", import.meta.url).href;
const ROOT = new URL("..", import.meta.url).pathname;

/** Every request the wrapper handed on, so a test can say it was handed on. */
const handed: Request[] = [];

/** A fresh instrument over the same routes: its tally starts empty and is nobody else's. */
function instrument(): RequestHandler<Register> {
  return withRouteLog(
    (request) => {
      handed.push(request);
      return new Response("handled");
    },
    () => createRouter({ routeTree: root.addChildren([index, health, auth, webhooks, things]) }),
  );
}

// A real router over the shapes this project's routes take: a page, a server
// route, a splat, a route registered for every method, and the handler form
// Start accepts as a function. Real matching, real route tree — only the
// handler being wrapped is a stand-in, since Start's own needs the build's
// virtual modules to run.
const root = createRootRoute();
const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
const health = createRoute({
  getParentRoute: () => root,
  path: "/api/health",
  server: { handlers: { GET: () => new Response("ok") } },
});
const auth = createRoute({
  getParentRoute: () => root,
  path: "/api/auth/$",
  server: { handlers: { GET: () => new Response("ok"), POST: () => new Response("ok") } },
});
const webhooks = createRoute({
  getParentRoute: () => root,
  path: "/webhooks",
  server: { handlers: { ANY: () => new Response("ok") } },
});
const things = createRoute({
  getParentRoute: () => root,
  path: "/things",
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({ GET: () => new Response("ok"), DELETE: () => new Response("ok") }),
  },
});

let app = instrument();

beforeEach(() => {
  app = instrument();
});

interface Report {
  readonly routeTable: { readonly method: string; readonly path: string }[];
  readonly counts: { readonly method: string; readonly path: string; readonly count: number }[];
}

/** What the gate fetches, twice per run. */
async function report(): Promise<Report> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape declared above is this file's statement of the wire protocol; a parser here would be a second one, and the assertions below are what hold the app to it
  return (await (await app(new Request("http://localhost/__route-log"))).json()) as Report;
}

async function send(method: string, path: string): Promise<Response> {
  return await app(new Request(`http://localhost${path}`, { method }));
}

function count({ counts }: Report, method: string, path: string): number {
  return counts.find((served) => served.method === method && served.path === path)?.count ?? 0;
}

// A route table that quietly omits a route is a floor that quietly stops
// covering it. The gate's surface for an app that cannot answer is the same one
// either way: no route log.
test("a handlers block this instrument cannot read is refused, not skipped", () => {
  // Its own root: `addChildren` takes once per route, so a second tree over the
  // one above would silently be the one above.
  const brokenRoot = createRootRoute();
  const brokenRoute = createRoute({
    getParentRoute: () => brokenRoot,
    path: "/unreadable",
    // Not a shape Start can read either; whatever this repo meant by it, the
    // floor cannot be measured against it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fixture IS the unreadable value: the assertion is how a shape the type refuses gets past the compiler and into the reader this case is about
    server: { handlers: 7 as never },
  });
  const broken = withRouteLog(
    () => new Response("handled"),
    () => createRouter({ routeTree: brokenRoot.addChildren([brokenRoute]) }),
  );

  expect(() => broken(new Request("http://localhost/__route-log"))).toThrow(
    "/unreadable declares server handlers this instrument cannot read",
  );
});

test("the endpoint names every route with every method it can answer", async () => {
  // Exactly: the floor is measured against this list, so a route missing from
  // it is a route nothing can ever hold to the ramp. A page route answers GET,
  // a server route the methods it declares handlers for — in either spelling —
  // and a route registered for every method is named the way the gate reads it,
  // so whichever method the ramp uses covers it.
  expect((await report()).routeTable).toEqual([
    { method: "GET", path: "/" },
    { method: "GET", path: "/api/health" },
    { method: "GET", path: "/api/auth/$" },
    { method: "POST", path: "/api/auth/$" },
    { method: "ALL", path: "/webhooks" },
    { method: "GET", path: "/things" },
    { method: "DELETE", path: "/things" },
  ]);
});

test("the instrument is in no route table, including its own", async () => {
  expect((await report()).routeTable.some(({ path }) => path === "/__route-log")).toBe(false);
});

test("a route that answers a request is counted, once per request", async () => {
  await send("GET", "/api/health");
  await send("GET", "/api/health");

  expect(count(await report(), "GET", "/api/health")).toBe(2);
});

test("the request still reaches the app the wrapper is measuring", async () => {
  const before = handed.length;
  expect(await (await send("GET", "/")).text()).toBe("handled");

  expect(handed.slice(before).map(({ url }) => url)).toEqual(["http://localhost/"]);
});

// Only the router knows which route answered a URL, and a gate that guessed
// would credit coverage to a route that served nothing.
test("a hit is recorded against the route the router matched, not the URL asked", async () => {
  await send("GET", "/api/auth/sign-in");

  const after = await report();
  expect(count(after, "GET", "/api/auth/$")).toBe(1);
  expect(after.counts.some(({ path }) => path === "/api/auth/sign-in")).toBe(false);
});

// The table names it ALL; the count names the method that arrived. That pairing
// is what lets the gate credit a catch-all with whichever method reached it.
test("a route registered for every method is counted under the one that reached it", async () => {
  await send("POST", "/webhooks");

  expect(count(await report(), "POST", "/webhooks")).toBe(1);
});

test("a request that matched no route is not coverage", async () => {
  await send("GET", "/nothing-here");

  expect((await report()).counts).toEqual([]);
});

// Start runs a route's server handler only on an exact match; a path that
// carries on past the route it matched falls through to the app router instead.
// Counting it would credit a handler that never ran.
test("a route matched on a prefix of the path is not counted", async () => {
  await send("GET", "/api/health/and-then-some");

  expect((await report()).counts).toEqual([]);
});

test("the instrument does not measure itself", async () => {
  await report();

  expect((await report()).counts).toEqual([]);
});

/** A `bun -e` program in this project, under the same environment as above. */
async function subprocess(source: string, routeLog: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", source], {
    cwd: ROOT,
    env: { ...process.env, ...ENVIRONMENT, ROUTE_LOG: routeLog },
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return stdout.trim();
}

// The claim the gate actually rests on, so it is made against the app's own
// router and its own generated route tree rather than against the fixture
// above. In a subprocess: importing the router pulls every route module and
// component into this process, and each unrendered one would then count against
// the suite's coverage floor — a floor about whether code was tested, answered
// by whatever an instrument's test happened to import.
test("the app's own routes are the ones the endpoint reports", async () => {
  const reported = await subprocess(
    `
      const { getRouter } = await import("${ROOT}src/router.tsx");
      const { withRouteLog } = await import(${JSON.stringify(MODULE)});
      const app = withRouteLog(() => new Response("handled"), getRouter);
      await app(new Request("http://localhost/api/auth/sign-in"));
      console.log(await (await app(new Request("http://localhost/__route-log"))).text());
    `,
    "true",
  );

  expect(JSON.parse(reported)).toEqual({
    routeTable: [
      { method: "GET", path: "/" },
      { method: "GET", path: "/login" },
      { method: "GET", path: "/api/health" },
      { method: "GET", path: "/api/auth/$" },
      { method: "POST", path: "/api/auth/$" },
    ],
    counts: [{ method: "GET", path: "/api/auth/$", count: 1 }],
  });
});

// The deployment shape: unset, this is not a wrapper with an idle branch — it
// is the handler itself, so no router is ever built and no endpoint exists. A
// subprocess because the flag is read at import, and every test file in a run
// shares one module registry.
test("unset, the app carries no instrument at all", async () => {
  const printed = await subprocess(
    `
      const { withRouteLog } = await import(${JSON.stringify(MODULE)});
      const handler = () => new Response("handled");
      const wrapped = withRouteLog(handler, () => { throw new Error("a router was built"); });
      console.log(wrapped === handler);
      console.log(await (await wrapped(new Request("http://localhost/__route-log"))).text());
    `,
    "false",
  );

  expect(printed.split("\n")).toEqual(["true", "handled"]);
});
