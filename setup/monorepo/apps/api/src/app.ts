import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { auth, authEnv } from "./auth.ts";
import { createRouteLog } from "./route-log.ts";
import { health } from "./routes/health.ts";

// One instrument, so the endpoint reports the tally the counter fills. The
// counter goes first, because an Elysia hook covers what is registered after it
// and it has to see every route; the endpoint that reports it goes last, around
// the finished app, because it reports that app's route table.
const { routeLog, routeLogEndpoint } = createRouteLog();

/**
 * Order is the interface here. Elysia attaches a route-lifecycle hook —
 * `onBeforeHandle`, `onAfterHandle`, `onAfterResponse` and the rest — to the
 * routes registered after it, and to no others: added to a finished app, one
 * fires for nothing at all, `{ as: "global" }` included (verified 2026-08-08
 * against elysia 1.4.29). Only the hooks that run before routing, `onRequest`
 * among them, are unaffected.
 *
 * So anything that needs the matched route or the response — per-route metrics,
 * latency, tracing spans, auth telemetry — has to be registered here, at the
 * head, and nothing at all is exported for one to be attached to later. The
 * failure it would otherwise meet is silent: the hook typechecks, runs, and
 * records nothing, and the first sign is a dashboard that stays empty.
 */
const composed = routeLogEndpoint(
  new Elysia()
    .use(routeLog)
    // The browser sends the session cookie cross-origin, so the allowlist is
    // the site itself and credentials are on — a wildcard origin would forbid
    // both.
    .use(cors({ origin: authEnv.SITE_URL, credentials: true }))
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(health),
);

/** Starts serving on the given address. The composed app goes no further than this. */
export function serve(options: { readonly port: number; readonly hostname: string }): void {
  composed.listen(options);
}

/** Stops accepting connections; main.ts winds the services down after it. */
export async function stop(): Promise<void> {
  await composed.stop();
}

/** What the Eden client in apps/web is typed against. No codegen, no OpenAPI. */
export type App = typeof composed;
