import { treaty } from "@elysiajs/eden";
import type { App } from "project-template-api";

import { apiUrl } from "./api-origin.ts";

/**
 * The typed client for the API program. `App` is the server's own type, so a
 * route rename is a compile error here rather than a 404 in production — there
 * is no codegen step and no OpenAPI document to drift.
 *
 * `credentials` is what the deployed shape costs: the API is a different origin
 * than this app, and fetch carries cookies to another origin only when the
 * request asks. Left at the default, every call here would arrive without the
 * session and be answered as if nobody were signed in — and it would look
 * healthy, because Better Auth's client asks on its own behalf, so signing in
 * would still work.
 */
export const api = treaty<App>(apiUrl, { fetch: { credentials: "include" } });
