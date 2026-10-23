/**
 * A stand-in identity provider: signing keys generated per case, tokens minted
 * with them, and its key set served by replacing `fetch` for its one URL, the
 * true external boundary the door reaches it through.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";

export const ISSUER = "https://portal.example";
export const JWKS_URL = "https://portal.internal/api/auth/jwks";
export const RESOURCE = "https://wms.example/api/mcp";

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" },
  };
}

export async function identityProvider() {
  const keys: SigningKey[] = [await signingKey("first")];
  const served = { count: 0, reachable: true };
  const original = globalThis.fetch;
  const fake = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== JWKS_URL) throw new Error(`The suite reached for ${url}, which no case serves`);
    if (!served.reachable) throw new TypeError("fetch failed");
    served.count += 1;
    return Response.json({ keys: keys.map((key) => key.jwk) });
  };
  globalThis.fetch = Object.assign(fake, { preconnect: original.preconnect });
  return {
    served,
    /** Starts signing with a new key, which the key set serves from now on. */
    async rotate(kid: string) {
      keys.push(await signingKey(kid));
    },
    async token(
      claims: JWTPayload = {},
      options: {
        readonly kid?: string;
        readonly expiresIn?: number;
        readonly audience?: string;
        readonly issuer?: string;
      } = {},
    ) {
      const key = keys.find((candidate) => candidate.kid === (options.kid ?? keys.at(-1)?.kid));
      if (key === undefined) throw new Error(`no key ${options.kid ?? ""}`);
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sub: "person-1", ...claims })
        .setProtectedHeader({ alg: "ES256", kid: key.kid })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? RESOURCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresIn ?? 300))
        .sign(key.privateKey);
    },
    [Symbol.dispose]() {
      globalThis.fetch = original;
    },
  };
}
