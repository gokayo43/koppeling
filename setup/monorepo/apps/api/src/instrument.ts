import * as Sentry from "@sentry/bun";

import { env } from "./env.ts";

// Inert unless the deploy supplies a DSN: a local checkout and a CI run reach no
// third party and need no account.
if (env.SENTRY_DSN !== undefined) {
  Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

export { Sentry };
