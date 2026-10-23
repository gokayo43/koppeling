import { ENDPOINT, EVERY_METHOD, type Route, type Served } from "@gokayo43/dev-config/route-log.ts";
import type { AnyRouter, Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";

import { env } from "./env.ts";

/**
 * This app's half of the capacity gate's route-coverage floor. The protocol —
 * the endpoint, the two lists it answers, the spelling of a catch-all method,
 * and why coverage is the difference between two fetches — is declared once in
 * `@gokayo43/dev-config/route-log.ts`, which is where everything imported above
 * comes from and where the argument for the design lives.
 */

/**
 * What this module reads of a registered route. `AnyRoute` is generic in every
 * position, so each of these arrives as `any` from the router's registry — the
 * shape is stated once here and narrowed at the one place the registry is read,
 * rather than trusted afresh at every use.
 */
interface Registered {
  readonly fullPath: string;
  readonly isRoot: boolean;
  readonly options: {
    readonly component?: unknown;
    readonly server?: { readonly handlers?: unknown };
  };
}

/**
 * The methods a route declares a server handler for. Start accepts the map and
 * a function returning one, and reads them exactly this way — a reader that
 * knew only the map form would report no methods for a route that serves
 * several.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion -- what arrives here is a value the route wrote and the router stored without ever typing: one of two shapes Start accepts, told apart the only way a callback can be told from a map, and — in the function form — handing back whatever that route passed its `createHandlers`. There is no schema to parse it into that is not a schema for somebody else's callback, so the shape is asserted once, here, and the refusal below is what stands in for a parse */
function methodsOf(declared: unknown, path: string): string[] {
  const handlers =
    typeof declared === "function"
      ? (declared as (opts: { createHandlers: (given: unknown) => unknown }) => unknown)({
          createHandlers: (given) => given,
        })
      : declared;
  if (typeof handlers !== "object" || handlers === null) {
    // Refused rather than skipped. A route missing from the table is one the
    // floor silently stops covering, which is worse than one the gate fails
    // on — and the gate has a surface for exactly this: an app that cannot
    // answer its route log does not answer it at all.
    throw new Error(
      `${path} declares server handlers this instrument cannot read (${typeof handlers}) — the route table is what the capacity floor is measured against, so it cannot leave the route out`,
    );
  }
  return Object.keys(handlers).map((method) => {
    const upper = method.toUpperCase();
    return upper === "ANY" ? EVERY_METHOD : upper;
  });
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion */

/**
 * Every route the app serves, enumerated from the router's own registry rather
 * than from a list somebody maintains: a route added under `src/routes/` is in
 * the floor the moment it exists, which is the only way a floor stays one.
 *
 * A route's methods are what it declares handlers for, plus GET when it has a
 * component — the router renders the page for a GET no handler claimed. One
 * rule, so a route that declares both is named once per method it can answer.
 */
function routeTable(router: AnyRouter): Route[] {
  // `AnyRoute` is generic in every position, so the registry's values are `any`
  // and this is the one place the shape above is claimed of them.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- see above
  const registry = Object.values(router.routesById) as unknown as Registered[];
  return registry.flatMap((route) => {
    // The root is the layout every match includes and never what answers a URL
    // on its own. It carries the app shell's component, so reporting it would
    // name `/` twice and hold the ramp to a route no request can reach.
    if (route.isRoot) return [];
    const methods = new Set(
      route.options.server?.handlers === undefined
        ? []
        : methodsOf(route.options.server.handlers, route.fullPath),
    );
    if (route.options.component !== undefined) methods.add("GET");
    return [...methods].map((method) => ({ method, path: route.fullPath }));
  });
}

/**
 * Counted on the way in rather than after the response, so that the tally a
 * request produces is committed before its response leaves — the gate reads the
 * counters over HTTP, and a hook that ran a turn later would leave the end of
 * the ramp unrecorded. A route that then fails still counts: it was reached,
 * which is all a floor claims.
 *
 * Which route that is, is the router's answer and not this module's: it is put
 * the same question Start's own request handler puts. `**` among the params is
 * Start's mark for a route that matched a prefix of the path rather than the
 * whole of it — Start refuses to run a server handler on such a match and falls
 * through to the app router, so counting the route would credit a handler that
 * never ran.
 *
 * The path goes to the router as it arrived. Start rewrites it first, but only
 * a router configured with `rewrite` or a `basepath` rewrites to anything else
 * — and a project that configures one moves every route out from under this
 * counter at once, which the floor reports as every route uncovered rather than
 * as anything quiet.
 */
function countInto(tally: Map<string, Served>, router: AnyRouter, request: Request): void {
  const { pathname } = new URL(request.url);
  // A tuple, in the router's declared order: the matched chain, the raw params,
  // and the route that answers — the chain is the layout stack and not an
  // answer, so only the last two are read.
  const [, routeParams, foundRoute] = router.getMatchedRoutes(pathname);
  const matched = foundRoute as Registered | undefined;
  if (matched === undefined || routeParams["**"] !== undefined) return;

  const method = request.method.toUpperCase();
  const key = `${method} ${matched.fullPath}`;
  tally.set(key, {
    method,
    path: matched.fullPath,
    count: (tally.get(key)?.count ?? 0) + 1,
  });
}

/**
 * The instrument, wrapped around the Start request handler in `src/server.ts`.
 *
 * The router arrives as a thunk rather than an instance because a deployment
 * must not pay for one: unset, this is not a wrapper with an idle branch but
 * the handler itself, so nothing is built, nothing sits on the request path and
 * no endpoint is served. The tally belongs to the wrapper for the same reason —
 * it is the state of one instrument, it lives exactly as long as one, and two
 * of them in a process count their own traffic rather than each other's.
 */
export function withRouteLog(
  handler: RequestHandler<Register>,
  createRouter: () => AnyRouter,
): RequestHandler<Register> {
  if (!env.ROUTE_LOG) return handler;

  // One router, asked only which route a path belongs to. `getMatchedRoutes` is
  // a pure read of the route tree, so the per-request router Start builds for
  // rendering has nothing to add to the answer.
  const router = createRouter();
  const tally = new Map<string, Served>();

  return (request, options) => {
    // The endpoint is answered before the router is ever asked, so it is in no
    // route tree and the gate's own two fetches move no counter.
    if (new URL(request.url).pathname === ENDPOINT) {
      return Response.json({ routeTable: routeTable(router), counts: [...tally.values()] });
    }
    countInto(tally, router, request);
    return handler(request, options);
  };
}
