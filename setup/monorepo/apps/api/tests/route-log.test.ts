import { beforeEach, expect, test } from "bun:test";

import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { z } from "zod";

// The flag is read once, when the module is first evaluated, so it is set before
// the import rather than after: a static import would already have run.
process.env["ROUTE_LOG"] = "true";
const { createRouteLog } = await import("~/route-log.ts");

// app.ts's own shape — the counter first so it sees every route, the endpoint
// around the finished app — with two routes standing in for whatever the
// project grows: one parameterised, one registered for every method. A fresh
// instrument per test, which is what a per-call tally buys: an absolute count
// is a stronger assertion than a difference between two of them.
function instrument() {
  const { routeLog, routeLogEndpoint } = createRouteLog();
  return routeLogEndpoint(
    new Elysia()
      .use(routeLog)
      .use(cors({ origin: "http://localhost", credentials: true }))
      .all("/api/auth/*", () => "session")
      .get("/health", () => ({ status: "ok" }))
      .get("/presets/:id", ({ params }) => params.id),
  );
}

let app = instrument();

beforeEach(() => {
  app = instrument();
});

/**
 * The wire shape the capacity gate reads, parsed rather than asserted: this
 * endpoint exists for a consumer outside this repo, so a response that stopped
 * matching should fail here rather than downstream.
 */
const Report = z.object({
  routeTable: z.array(z.object({ method: z.string(), path: z.string() })),
  counts: z.array(z.object({ method: z.string(), path: z.string(), count: z.number() })),
});
type Report = z.infer<typeof Report>;

/** What the gate fetches, twice per run. */
async function report(): Promise<Report> {
  return Report.parse(await (await app.handle(new Request("http://localhost/__route-log"))).json());
}

async function get(path: string): Promise<number> {
  return (await app.handle(new Request(`http://localhost${path}`))).status;
}

function count({ counts }: Report, method: string, path: string): number {
  return counts.find((served) => served.method === method && served.path === path)?.count ?? 0;
}

test("the endpoint names every route the app serves, and never itself", async () => {
  // Exactly, in registration order: the floor is measured against this list, so
  // a route missing from it is a route nothing can ever hold to the ramp — and
  // the endpoint's own /__route-log is an instrument rather than one of them.
  expect((await report()).routeTable).toEqual([
    { method: "OPTIONS", path: "/" },
    { method: "OPTIONS", path: "/*" },
    { method: "ALL", path: "/api/auth/*" },
    { method: "GET", path: "/health" },
    { method: "GET", path: "/presets/:id" },
  ]);
});

test("a route that answers a request is counted, once per request", async () => {
  expect(await get("/health")).toBe(200);
  expect(await get("/health")).toBe(200);

  expect(count(await report(), "GET", "/health")).toBe(2);
});

// Only the router knows which route answered a URL, and a gate that guessed
// would credit coverage to a route that served nothing.
test("a hit is recorded against the route the router matched, not the URL asked", async () => {
  expect(await get("/presets/42")).toBe(200);

  const after = await report();
  expect(count(after, "GET", "/presets/:id")).toBe(1);
  expect(after.counts.some(({ path }) => path === "/presets/42")).toBe(false);
});

test("a route registered for every method is counted under the one that reached it", async () => {
  expect(await get("/api/auth/get-session")).toBe(200);

  expect(count(await report(), "GET", "/api/auth/*")).toBe(1);
});

test("a request that matched no route is not coverage", async () => {
  expect(await get("/nothing-here")).toBe(404);

  expect((await report()).counts).toEqual([]);
});

test("the instrument does not measure itself", async () => {
  await report();

  expect((await report()).counts).toEqual([]);
});

// The deployment shape: unset, this is not a plugin with an idle handler and an
// endpoint answering 404 — it is a plugin with no handlers and no endpoint at
// all. A subprocess because the flag is read at import, and every test file in
// a run shares one module registry.
test("unset, the app carries no instrument at all", async () => {
  const module = new URL("../src/route-log.ts", import.meta.url).href;
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        const { Elysia } = await import("elysia");
        const { createRouteLog } = await import(${JSON.stringify(module)});
        const { routeLog, routeLogEndpoint } = createRouteLog();
        const app = routeLogEndpoint(new Elysia().use(routeLog).get("/health", () => "ok"));
        await app.handle(new Request("http://localhost/health"));
        console.log((await app.handle(new Request("http://localhost/__route-log"))).status);
      `,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ROUTE_LOG: "false" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );

  expect((await new Response(proc.stdout).text()).trim()).toBe("404");
  expect(await proc.exited).toBe(0);
});
