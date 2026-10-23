import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./db.ts";
import { env } from "./env.ts";
import * as schema from "./schema.ts";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  baseURL: env.SITE_URL,
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
});
