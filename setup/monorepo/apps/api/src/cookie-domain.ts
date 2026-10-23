/** 127.0.0.0/8 written out as a literal. `127.example.com` is a domain, not this machine. */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/** Where a hostname is this machine under one of its names rather than a place. */
function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    LOOPBACK_IPV4.test(host)
  );
}

/**
 * The `Domain` a session cookie has to carry for the web app to see one this
 * program set — or undefined where there is nothing to widen.
 *
 * The deployed shape is two hostnames: the web app on its own, this program on
 * `api.<that one>` (infra/nginx). A cookie set without a domain belongs to the
 * host that set it, so the web app would never see the session it was just
 * signed in for. Naming the parent host widens it to both, and a host may name
 * only a domain it sits under — which is the relationship tested here.
 *
 * What widening costs is worth stating plainly: the cookie goes to every
 * current and future host under the site's name, not to those two alone, so a
 * subdomain added later is one more place the session is sent. What that is not
 * is a cross-site cookie — `SameSite` stays `lax`, the auth routes check the
 * request's origin against the trusted list, and CORS confines everything else
 * to requests a browser would send anyway and hides the answers.
 *
 * Undefined is for having nothing to widen: a loopback pair, whichever names it
 * is spelled with, is one machine on two ports, and a `Domain` naming either is
 * one the browser drops.
 *
 * Everything else throws, at boot rather than at the first sign-in. One side on
 * this machine and the other not is a half-edited `.env`, and two real
 * hostnames that do not nest are outside the one topology infra/nginx serves —
 * a site behind `www.` in front of the same `api.` is the way in. Either would
 * otherwise leave the program answering sign-ins that succeed and leave the
 * browser signed out.
 */
export function sharedCookieDomain(site: string, api: string): string | undefined {
  const siteHost = new URL(site).hostname;
  const apiHost = new URL(api).hostname;
  const siteIsHere = isLoopback(siteHost);
  const apiIsHere = isLoopback(apiHost);

  if (siteIsHere !== apiIsHere) {
    throw new Error(
      `${site} and ${api} are not the same environment: one of them is this machine and the other is somewhere else`,
    );
  }
  if (siteIsHere) return undefined;
  if (apiHost === siteHost) return undefined;
  if (apiHost.endsWith(`.${siteHost}`)) return siteHost;

  throw new Error(
    `no cookie can reach both ${site} and ${api}: the API's hostname has to sit under the site's, as infra/nginx serves it`,
  );
}
