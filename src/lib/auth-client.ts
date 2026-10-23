import { createAuthClient } from "better-auth/react";

/** Same-origin: the Better Auth handler is mounted at /api/auth/* by the route. */
export const authClient = createAuthClient();
