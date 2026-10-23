import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { getRouter } from "~/router.tsx";
import { withRouteLog } from "~/server/route-log.ts";

// Replaces the Start plugin's default server entry. It exists for one line: the
// capacity gate needs the app to say which routes it serves and how many
// requests each has taken, and the outermost fetch is the last place a request
// is still whole. `getRouter` is passed rather than called — with ROUTE_LOG
// unset nothing here is built and the handler goes through untouched.
export default {
  fetch: withRouteLog(createStartHandler(defaultStreamHandler), getRouter),
};
