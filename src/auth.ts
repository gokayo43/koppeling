import { Data, Effect } from "effect";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import { copy } from "./copy";
import type { Identity } from "./door";

export class Unauthenticated extends Data.TaggedError("Unauthenticated")<{
  readonly sentence: string;
  readonly tokenGiven: boolean;
}> {}

export class KeysUnreachable extends Data.TaggedError("KeysUnreachable")<{
  readonly cause: unknown;
}> {}

/**
 * jose's codes for a key set it could not fetch or read, as opposed to a token
 * it refused; anything that is not a jose error at all is the fetch failing.
 */
const KEYS_FAILED = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"]);

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * How long after one fetch of the key set the next may happen. The portal
 * signs with a new key the moment it rotates, so a token with an unknown key
 * id is refused for at most this long after a rotation, and such tokens can
 * make the door ask the portal at most once in this long (jose's default, 30
 * seconds, refused valid tokens for half a minute).
 */
const REFETCH_COOLDOWN_MS = 5_000;

/**
 * Verifies a request's bearer as a JWT from `identity` for `audience`: its
 * signature against the provider's key set (cached, and fetched again for a
 * key id it has not seen), its `iss`, its `aud`, `nbf`, and that it carries
 * an `exp` and a `sub`: a token that never expires, or names no person, is
 * not one the portal signs.
 */
export function bearerVerifier(identity: Identity, audience: string) {
  const jwksUrl =
    identity.jwksUrl ?? `${identity.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const keys = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: REFETCH_COOLDOWN_MS });
  return (request: Request): Effect.Effect<JWTPayload, Unauthenticated | KeysUnreachable> => {
    const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
    if (token === undefined) {
      return Effect.fail(new Unauthenticated({ sentence: copy.noBearer, tokenGiven: false }));
    }
    return Effect.tryPromise({
      try: () =>
        jwtVerify(token, keys, {
          issuer: identity.issuer,
          audience,
          requiredClaims: ["exp", "sub"],
        }),
      catch: (cause) =>
        !(cause instanceof errors.JOSEError) || KEYS_FAILED.has(cause.code)
          ? new KeysUnreachable({ cause })
          : new Unauthenticated({ sentence: copy.badBearer, tokenGiven: true }),
    }).pipe(Effect.map(({ payload }) => payload));
  };
}
