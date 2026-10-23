import { z } from "zod";

// A real trust boundary: the process environment is untyped input from the
// deploy. Parsing it once here means every other server module reads a value
// that has already been proven present and well-shaped.
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  SITE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // Unset means "no telemetry": both integrations stay inert rather than
  // failing, so a local checkout runs with no accounts anywhere.
  SENTRY_DSN: z.string().optional(),
  // The capacity gate's instrument, and nothing else's: set, the server entry
  // counts what each route takes and serves the tally. No deployment sets it.
  ROUTE_LOG: z.stringbool().default(false),
});

export const env = Env.parse(process.env);
