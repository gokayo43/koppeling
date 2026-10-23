import { z } from "zod";

// A real trust boundary: the process environment is untyped input from the
// deploy. Parsing it once here means every other module reads a value that has
// already been proven present and well-shaped.
//
// Only what every program on this layer needs — the HTTP server and the worker
// both load this module, so a variable that only the HTTP edge uses is parsed
// where it is used instead (see auth.ts), and the worker's container stays
// free of secrets it has no business holding.
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  // Loopback unless the deploy asks for more — CLAUDE.md, Gotchas, for why
  // that is the default and Dockerfile.api for the one caller that overrides it.
  HOST: z.string().min(1).default("127.0.0.1"),
  // Unset means "no telemetry": the integration stays inert rather than
  // failing, so a local checkout runs with no accounts anywhere.
  SENTRY_DSN: z.string().optional(),
});

export const env = Env.parse(process.env);
