import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { z } from "zod";

import { sharedCookieDomain } from "./cookie-domain.ts";
import { db } from "./db/client.ts";
import * as schema from "./db/schema.ts";

/**
 * An origin, spelled the way a browser spells one — the choke point where every
 * other spelling stops.
 *
 * The scheme is load-bearing twice over: Better Auth reads `Secure` off it, and
 * cookie-domain.ts reasons about hosts sitting under one another. A path is
 * worse than useless, because every client of these two values appends its own
 * — `https://api.example.com/api` parses, boots, and takes the auth surface
 * with it, since Better Auth reads a base URL that already carries a path as
 * the whole mount point and stops appending its own, leaving `/api/auth/*` on
 * 404 and `/api/*` answering routes nothing calls.
 *
 * The rest of what this refuses is the same failure in quieter clothes. A
 * trailing slash — which is what a copied address bar gives you — an uppercase
 * scheme, or embedded credentials all parse, boot, and then match no browser's
 * `Origin` header, so CORS sends nothing back and every call is a 403 with no
 * allow-origin in sight. Comparing against `url.origin` catches all three at
 * once: it is exactly the string a browser will send.
 *
 * `URL.canParse` first, so a value that is not a URL at all fails as this key
 * rather than as a stack trace from inside the check. And not `z.httpUrl()`,
 * whose hostname rule is a dotted domain (zod 4.4.3) — it rejects `localhost`
 * and `127.0.0.1`, which is dev, a preview and CI's boot gate.
 */
const HttpUrl = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && value === url.origin;
}, "must be a bare http(s) origin: scheme and host exactly as a browser spells it, with no path, query, fragment, credentials or trailing slash");

const AuthEnv = z.object({
  SITE_URL: HttpUrl,
  // Where this program answers publicly. Every caller says so: the deploy and a
  // preview from their compose file, a checkout from its `.env`, CI in the
  // start command its own workflow spells.
  PUBLIC_API_URL: HttpUrl,
  BETTER_AUTH_SECRET: z.string().min(32),
});

export const authEnv = AuthEnv.parse(process.env);

const cookieDomain = sharedCookieDomain(authEnv.SITE_URL, authEnv.PUBLIC_API_URL);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  /**
   * This program's own origin, not the site's: every URL Better Auth mints is
   * this plus its base path — a verification link, an OAuth callback — and one
   * built from the site's hostname would land on the web app, which serves no
   * auth routes. It is also what decides `Secure` on every cookie, from the
   * scheme alone (better-auth 1.6.25, `createCookieGetter`), so a deployment's
   * cookies are secure and a loopback run's are still usable, with no flag to
   * keep in step.
   */
  baseURL: authEnv.PUBLIC_API_URL,
  secret: authEnv.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  // The browser is on the site's origin and this program is not, so that origin
  // is trusted by name; Better Auth adds baseURL's own.
  trustedOrigins: [authEnv.SITE_URL],
  advanced: {
    // Enabled only with a domain to give it: Better Auth otherwise falls back
    // to baseURL's hostname, which here is the API's own — the exact scoping
    // that loses the cookie.
    crossSubDomainCookies:
      cookieDomain === undefined ? { enabled: false } : { enabled: true, domain: cookieDomain },
  },
});
