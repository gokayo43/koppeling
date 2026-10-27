import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isLegacyRequest,
  isSpecType,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { Data, Effect } from "effect";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

import { bearerVerifier, Unauthenticated } from "./auth";
import type { Catalogue, Note, Operation } from "./catalogue";
import { copy } from "./copy";
import { admitted, instructionsFor, toDirectory } from "./directory";
import { reporter } from "./events";
import { Pages } from "./pages";
import { mcpServer, refusalServer } from "./tools";

/**
 * The identity provider whose tokens the door accepts: the portal, for every
 * koppeling. Its signing keys are fetched from `jwksUrl`, or handed over as
 * `keys` by a host that holds them itself; never both.
 */
export type Identity = {
  /** The `iss` every token must carry: the provider's public origin. */
  readonly issuer: string;
  /** The authorization server the metadata document sends a client to for its sign-in. */
  readonly authorizationServer: string;
} & (
  | {
      /**
       * Where the provider's signing keys are fetched; `<issuer>/.well-known/jwks.json`
       * when absent. Separate from `issuer` so a host beside the provider can fetch
       * them over its own network while tokens still name the public origin.
       */
      readonly jwksUrl?: string;
      readonly keys?: never;
    }
  | {
      /**
       * The provider's signing keys as the host holds them (jose's
       * `createLocalJWKSet`, or a key set of its own), so the door fetches
       * nothing to verify a token. A host that is the provider passes its own.
       */
      readonly keys: JWTVerifyGetKey;
      readonly jwksUrl?: never;
    }
);

/**
 * What a write came to: the program's value, its refusal, a failure before the
 * program was reached (nothing changed), or `unknown`: the program was reached
 * and its answer was lost or late, so the change may have been made.
 */
export type WriteOutcome = "value" | "refusal" | "failure" | "unknown";

/**
 * What the door tells the host's logger. `write`: one per call of a write
 * operation, naming the person and the program acting for them. `failure`: a
 * failure the person was answered with the door's own sentence for; its
 * `operation` is null when the sign-in failed (the key set, `actorFor` or `allows`).
 */
export type KoppelingEvent =
  | {
      readonly kind: "write";
      readonly operation: string;
      readonly sub: string | null;
      readonly name: string | null;
      readonly via: string | null;
      readonly outcome: WriteOutcome;
    }
  | { readonly kind: "failure"; readonly operation: string | null; readonly cause: unknown };

/**
 * Whether a person may use an operation. `true`: yes. `false`: the door hides
 * it from them. `{ scope }`: they may see it (the outline, `list` and `find`
 * show it, `describe` names the scope) but run it only once their login
 * carries `scope`, an OAuth scope or several split by one space; a `read` or
 * `write` of it is answered 403 `insufficient_scope` naming the scope, on which
 * their program signs in again asking for it, and nothing is run.
 */
export type Admission = boolean | { readonly scope: string };

/**
 * Who a token's person is to the program, with the operations they may use
 * (every one when `allows` is absent); or the program's sentence for why they
 * may not come in (`refusal`, answered in MCP for their program to show); or
 * its sentence for why this token must go through the sign-in again before it
 * comes in (`signIn`, answered 401 `invalid_token`, on which their program
 * signs in again).
 */
export type ActorDecision<Actor> =
  | {
      readonly actor: Actor;
      /** What the person may do with `operation`; the door offers only what it admits. */
      readonly allows?: (operation: Operation<Actor>) => Admission;
    }
  | { readonly refusal: string }
  | { readonly signIn: string };

export interface KoppelingOptions<Actor> {
  readonly catalogue: Catalogue<Actor>;
  /** The program's own words, which the server's instructions open with. */
  readonly glossary: string;
  readonly resource: {
    /** This door's public URL: what every token's `aud` must be. */
    readonly url: string;
    readonly scopes: readonly string[];
  };
  readonly identity: Identity;
  readonly actorFor: (claims: JWTPayload) => ActorDecision<Actor> | Promise<ActorDecision<Actor>>;
  /** The host's logger for every write and every failure; Effect's own logger when absent. */
  readonly log?: (event: KoppelingEvent) => void;
}

export interface BootReport {
  /** How many operations each area offers. */
  readonly areas: { readonly [area: string]: number };
  readonly skipped: readonly Note[];
  readonly undescribed: readonly Note[];
}

export interface Koppeling {
  /** Answers one MCP request at the door's URL: a POST, and 405 for any other method. */
  readonly handle: (request: Request) => Promise<Response>;
  /** Answers the protected resource metadata document, at the URL a 401 names. */
  readonly metadata: (request: Request) => Response;
  readonly report: BootReport;
}

class Refused extends Data.TaggedError("Refused")<{ readonly sentence: string }> {}

/** A `read` or `write` of an operation the person may run only once their login carries `scopes`. */
class ScopeAwaited extends Data.TaggedError("ScopeAwaited")<{
  readonly scopes: readonly string[];
}> {}

/**
 * The host's `actorFor`, or its `allows`, failed: the token verified, but its
 * person could not be looked up.
 */
class PersonUnreachable extends Data.TaggedError("PersonUnreachable")<{
  readonly cause: unknown;
}> {}

/**
 * A request body's JSON-RPC messages, as every MCP message is, or undefined
 * for a body that is not JSON-RPC: a refused person's program is answered in
 * MCP, so it can show the refusal, and anything else with a plain 403.
 */
async function jsonRpcMessages(request: Request): Promise<readonly unknown[] | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return undefined;
  }
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const jsonRpc =
    messages.length > 0 &&
    messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "jsonrpc" in message &&
        message.jsonrpc === "2.0",
    );
  return jsonRpc ? messages : undefined;
}

/**
 * The scopes the `read` and `write` calls among `messages` await: those
 * `scopes` holds for the operations they name. The door is stateless, so each
 * POST carries its own messages and is answered 403 before any of them runs.
 * The SDK's own per-tool `scopeChallenge` was not taken: it names the metadata
 * document only from an `AuthInfo`, whose `clientId` no koppeling token carries.
 */
function scopesAwaited(
  messages: readonly unknown[],
  scopes: ReadonlyMap<string, string>,
): readonly string[] {
  const awaited = messages.flatMap((message) => {
    if (!isSpecType.CallToolRequest(message)) return [];
    const { name: tool, arguments: args } = message.params;
    const operation = args?.["name"];
    const scope =
      (tool === "read" || tool === "write") && typeof operation === "string"
        ? scopes.get(operation)
        : undefined;
    return scope === undefined ? [] : scope.split(" ");
  });
  return [...new Set(awaited)];
}

/**
 * `text` as an RFC 6750 §3 `error_description`, which allows one or more of
 * printable ASCII but `"` and `\`: letters lose their accents, anything else
 * is dropped, and a text with nothing left gives no parameter.
 */
function errorDescription(text: string): readonly string[] {
  const kept = text
    .normalize("NFKD")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, "")
    .trim();
  return kept ? [`error_description="${kept}"`] : [];
}

const refusalResponse = (
  status: number,
  sentence: string,
  headers: { readonly [name: string]: string } = {},
) => Response.json({ error: sentence }, { status, headers });

/**
 * A 2025-era request (the `initialize` handshake and what follows it) is
 * served the way the portal's door serves Claude Desktop today; a 2026-07-28
 * request goes to the SDK's own per-request handler.
 */
async function serve(request: Request, server: () => McpServer): Promise<Response> {
  if (await isLegacyRequest(request)) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server().connect(transport);
    return transport.handleRequest(request);
  }
  const modern = createMcpHandler(server, { legacy: "reject" });
  try {
    return await modern.fetch(request);
  } finally {
    await modern.close();
  }
}

/**
 * The door: an MCP server over Streamable HTTP, stateless, that offers the
 * catalogue through five tools to whoever the bearer token names.
 */
export function koppeling<Actor>(options: KoppelingOptions<Actor>): Koppeling {
  const operations = toDirectory(options.catalogue);
  const instructions = instructionsFor(options.glossary, operations);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(options.resource.url));
  const verify = bearerVerifier(options.identity, options.resource.url);
  const report = reporter(options.log);
  const pages = new Pages();
  const document = {
    resource: options.resource.url,
    authorization_servers: [options.identity.authorizationServer],
    scopes_supported: options.resource.scopes,
    bearer_methods_supported: ["header"],
  };

  /** The part of the door a person may use, and its outline; the whole door without `allows`. */
  const personal = (allows: ((operation: Operation<Actor>) => Admission) | undefined) => {
    if (allows === undefined) return { directory: operations, instructions };
    const directory = admitted(operations, allows);
    return { directory, instructions: instructionsFor(options.glossary, directory) };
  };

  /** A `WWW-Authenticate` challenge (RFC 6750 §3) naming the metadata document, then `params`. */
  const challenge = (...params: readonly string[]) => ({
    "WWW-Authenticate": [`Bearer resource_metadata="${metadataUrl}"`, ...params].join(", "),
  });

  /** One POST, verified and answered as its person, or refused with the status that says why. */
  const answer = (request: Request) =>
    Effect.gen(function* () {
      const claims = yield* verify(request);
      const decision = yield* Effect.tryPromise({
        try: async () => options.actorFor(claims),
        catch: (cause) => new PersonUnreachable({ cause }),
      });
      if ("refusal" in decision) return yield* new Refused({ sentence: decision.refusal });
      if ("signIn" in decision) {
        return yield* new Unauthenticated({ sentence: decision.signIn, tokenGiven: true });
      }
      const part = yield* Effect.try({
        try: () => personal(decision.allows),
        catch: (cause) => new PersonUnreachable({ cause }),
      });
      if (part.directory.scopes.size > 0) {
        const messages = yield* Effect.promise(() => jsonRpcMessages(request));
        const scopes = scopesAwaited(messages ?? [], part.directory.scopes);
        if (scopes.length > 0) return yield* new ScopeAwaited({ scopes });
      }
      return yield* Effect.promise(() =>
        serve(request, () =>
          mcpServer(
            { directory: part.directory, actor: decision.actor, claims, report, pages },
            part.instructions,
          ),
        ),
      );
    }).pipe(
      Effect.catchTags({
        Unauthenticated: ({ sentence, tokenGiven }) =>
          Effect.succeed(
            refusalResponse(
              401,
              sentence,
              tokenGiven
                ? challenge('error="invalid_token"', ...errorDescription(sentence))
                : challenge(),
            ),
          ),
        ScopeAwaited: ({ scopes }) =>
          Effect.succeed(
            refusalResponse(
              403,
              copy.scopeAwaited(scopes),
              challenge('error="insufficient_scope"', `scope="${scopes.join(" ")}"`),
            ),
          ),
        Refused: ({ sentence }) =>
          Effect.promise(async () =>
            (await jsonRpcMessages(request)) === undefined
              ? refusalResponse(403, sentence)
              : serve(request, () => refusalServer(sentence)),
          ),
        PersonUnreachable: ({ cause }) =>
          report({ kind: "failure", operation: null, cause }).pipe(
            Effect.as(refusalResponse(503, copy.personUnreachable)),
          ),
        KeysUnreachable: ({ cause }) =>
          report({ kind: "failure", operation: null, cause }).pipe(
            Effect.as(refusalResponse(503, copy.keysUnreachable)),
          ),
      }),
    );

  /**
   * Only POST: the door keeps no session, so it has no stream to open on a GET
   * and none to end on a DELETE.
   */
  const handle = (request: Request) =>
    request.method === "POST"
      ? Effect.runPromise(answer(request))
      : Promise.resolve(new Response(null, { status: 405, headers: { Allow: "POST" } }));

  const metadata = (request: Request) =>
    request.method === "GET" || request.method === "HEAD"
      ? Response.json(document)
      : new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

  const boot: BootReport = {
    areas: Object.fromEntries(
      Array.from(operations.areas.values(), (area) => [area.name, area.operations.length]),
    ),
    skipped: options.catalogue.skipped,
    undescribed: options.catalogue.undescribed,
  };

  return { handle, metadata, report: boot };
}
