import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

// The Start plugin's default entries call getRouter() on the server (per
// request) and on the client (for hydration). The generated route tree augments
// the Register interface from this function's return type.
export function getRouter() {
  // One QueryClient per router instance: fresh per request on the server so no
  // cache leaks across requests, singleton on the client.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
