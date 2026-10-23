import type { Served } from "@gokayo43/dev-config/route-log.ts";
import { type AnyElysia, Elysia } from "elysia";
import { z } from "zod";

// Parsed here rather than in env.ts, which carries only what every program on
// this layer needs: this one is the HTTP edge's alone, and the worker loads
// env.ts too.
const { ROUTE_LOG } = z.object({ ROUTE_LOG: z.stringbool().default(false) }).parse(process.env);

/**
 * This app's half of the capacity gate's route-coverage floor. The protocol —
 * the two lists it answers, and why coverage is the difference between two
 * fetches of them — is declared once in `@gokayo43/dev-config/route-log.ts`,
 * which is where the type above comes from and where the argument for the
 * design lives.
 *
 * The path is written out rather than imported from there, and that is the
 * whole difference from the single-app shape. This program runs from source
 * under Bun, so a value imported here is resolved on every boot — which would
 * make a config package a runtime dependency of the API, and a
 * production-only install would fail to start over a string. The single shape
 * imports the same constant because Nitro inlines it at build time and the
 * package is gone from the output entirely. Same rule, read against what each
 * program actually does: db-gate's shell writes it out for the same reason.
 */

/** `ENDPOINT` in `@gokayo43/dev-config/route-log.ts`. */
const ENDPOINT = "/__route-log";

/** Both halves of the instrument, sharing the one tally they are about. */
export interface RouteLog {
  /** Counts what the router hands to each route. Used before anything it should see. */
  readonly routeLog: Elysia;
  /** Reports the finished app's table and the tally. Applied to that app, not used as a plugin. */
  readonly routeLogEndpoint: <T extends AnyElysia>(app: T) => T;
}

/**
 * Counted on the way in rather than after the response, so that the tally a
 * request produces is committed before its response leaves — the gate reads the
 * counters over HTTP, and a hook that ran a turn later would leave the end of
 * the ramp unrecorded. A route that then fails still counts: it was reached,
 * which is all a floor claims. A request that matched no route never gets here,
 * so a 404 is not coverage.
 *
 * Two things the counter cannot see, both of which have to be waived in the
 * gate's route-allowlist rather than fixed here:
 *
 * - a handler that answers before the request reaches a route. `@elysiajs/cors`
 *   short-circuits every OPTIONS this way, including one to a route the app
 *   registered itself, so those routes can be ramped and still never appear.
 * - anything registered after the plugin is used, which is why it goes first in
 *   app.ts — the comment above the composition there has what that ordering
 *   rule costs when it is missed.
 *
 * The tally belongs to this call rather than to the module: it is the state of
 * one instrument, it lives exactly as long as one, and two of them in a process
 * count their own traffic rather than each other's.
 *
 * Unset, the plugin has no handlers and the endpoint is never registered, so a
 * deployment carries nothing on its request path.
 */
export function createRouteLog(): RouteLog {
  const tally = new Map<string, Served>();

  const routeLog = ROUTE_LOG
    ? new Elysia({ name: "route-log" }).onBeforeHandle({ as: "global" }, ({ request, route }) => {
        // The instrument does not measure itself: the gate fetches this very
        // route twice per run, and neither fetch is the ramp's traffic.
        if (route === ENDPOINT) return;
        const key = `${request.method} ${route}`;
        tally.set(key, {
          method: request.method,
          path: route,
          count: (tally.get(key)?.count ?? 0) + 1,
        });
      })
    : new Elysia({ name: "route-log" });

  // Applied to the finished app rather than used as a plugin, because it
  // reports the table that app ended up with and so has to be given it. The
  // app's type comes back unchanged, so the endpoint is invisible to the Eden
  // client `App` is for, and the route leaves itself out of what it reports.
  const routeLogEndpoint = <T extends AnyElysia>(app: T): T => {
    if (ROUTE_LOG) {
      app.get(ENDPOINT, () => ({
        routeTable: app.routes
          .filter(({ path }) => path !== ENDPOINT)
          .map(({ method, path }) => ({ method, path })),
        counts: [...tally.values()],
      }));
    }
    return app;
  };

  return { routeLog, routeLogEndpoint };
}
