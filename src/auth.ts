import { Data, Effect } from "effect";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import { copy } from "./copy";

/** The identity provider whose tokens the door accepts: the portal, for every koppeling. */
export interface Identity {
  /** The `iss` every token must carry: the provider's public origin. */
  readonly issuer: string;
  /**
   * Where the provider's signing keys are fetched; `<issuer>/.well-known/jwks.json`
   * when absent. Separate from `issuer` so a host beside the provider can fetch
   * them over its own network while tokens still name the public origin.
   */
  readonly jwksUrl?: string;
  /** The authorization server the metadata document sends a client to for its sign-in. */
  readonly authorizationServer: string;
}

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
 * Verifies a request's bearer as a JWT from `identity` for `audience`: its
 * signature against the provider's key set (cached, and fetched again for a
 * key id it has not seen), its `iss`, its `aud`, `exp` and `nbf`.
 */
export function bearerVerifier(identity: Identity, audience: string) {
  const jwksUrl =
    identity.jwksUrl ?? `${identity.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  return (request: Request): Effect.Effect<JWTPayload, Unauthenticated | KeysUnreachable> => {
    const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
    if (token === undefined) {
      return Effect.fail(new Unauthenticated({ sentence: copy.noBearer, tokenGiven: false }));
    }
    return Effect.tryPromise({
      try: () => jwtVerify(token, keys, { issuer: identity.issuer, audience }),
      catch: (cause) =>
        !(cause instanceof errors.JOSEError) || KEYS_FAILED.has(cause.code)
          ? new KeysUnreachable({ cause })
          : new Unauthenticated({ sentence: copy.badBearer, tokenGiven: true }),
    }).pipe(Effect.map(({ payload }) => payload));
  };
}
