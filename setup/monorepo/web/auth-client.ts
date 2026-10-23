import { createAuthClient } from "better-auth/react";

import { apiUrl } from "./api-origin.ts";

/**
 * The Better Auth handler is mounted by the API program, not by this app, so
 * this client reads the same origin the Eden client does — left to itself it
 * would call this app's own, which serves no auth routes at all.
 */
export const authClient = createAuthClient({ baseURL: apiUrl });
