import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { Data, Effect } from "effect";
import type { JWTPayload } from "jose";

import { bearerVerifier } from "./auth";
import type { Catalogue, Note, Operation } from "./catalogue";
import { copy } from "./copy";
import { admitted, instructionsFor, toDirectory } from "./directory";
import { reporter } from "./events";
import { Pages } from "./pages";
import { mcpServer, refusalServer } from "./tools";

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
 * `operation` is null when the sign-in failed (the key set, or `actorFor`).
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
 * Who a token's person is to the program, with the operations they may use
 * (every one when `allows` is absent), or the program's sentence for why they
 * may not come in.
 */
export type ActorDecision<Actor> =
  | {
      readonly actor: Actor;
      /** Whether the person may use `operation`: the door lists, finds, describes and runs only those. */
      readonly allows?: (operation: Operation<Actor>) => boolean;
    }
  | { readonly refusal: string };

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

/**
 * The host's `actorFor`, or its `allows`, failed: the token verified, but its
 * person could not be looked up.
 */
class PersonUnreachable extends Data.TaggedError("PersonUnreachable")<{
  readonly cause: unknown;
}> {}

/**
 * Whether a request's body is JSON-RPC, as every MCP message is: a refused
 * person's program is answered in MCP, so it can show the refusal, and
 * anything else with a plain 403.
 */
async function isJsonRpc(request: Request): Promise<boolean> {
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return false;
  }
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "jsonrpc" in message &&
        message.jsonrpc === "2.0",
    )
  );
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
  const personal = (allows: ((operation: Operation<Actor>) => boolean) | undefined) => {
    if (allows === undefined) return { directory: operations, instructions };
    const directory = admitted(operations, allows);
    return { directory, instructions: instructionsFor(options.glossary, directory) };
  };

  /**
   * Only POST: the door keeps no session, so it has no stream to open on a GET
   * and none to end on a DELETE.
   */
  const handle = (request: Request) =>
    request.method !== "POST"
      ? Promise.resolve(new Response(null, { status: 405, headers: { Allow: "POST" } }))
      : Effect.runPromise(
          verify(request).pipe(
            Effect.flatMap((claims) =>
              Effect.tryPromise({
                try: async () => options.actorFor(claims),
                catch: (cause) => new PersonUnreachable({ cause }),
              }).pipe(
                Effect.flatMap((decision): Effect.Effect<Response, Refused | PersonUnreachable> =>
                  "refusal" in decision
                    ? Effect.fail(new Refused({ sentence: decision.refusal }))
                    : Effect.try({
                        try: () => personal(decision.allows),
                        catch: (cause) => new PersonUnreachable({ cause }),
                      }).pipe(
                        Effect.flatMap((part) =>
                          Effect.promise(() =>
                            serve(request, () =>
                              mcpServer(
                                {
                                  directory: part.directory,
                                  actor: decision.actor,
                                  claims,
                                  report,
                                  pages,
                                },
                                part.instructions,
                              ),
                            ),
                          ),
                        ),
                      ),
                ),
              ),
            ),
            Effect.catchTags({
              Unauthenticated: ({ sentence, tokenGiven }) =>
                Effect.succeed(
                  refusalResponse(401, sentence, {
                    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"${tokenGiven ? ', error="invalid_token"' : ""}`,
                  }),
                ),
              Refused: ({ sentence }) =>
                Effect.promise(async () =>
                  (await isJsonRpc(request))
                    ? serve(request, () => refusalServer(sentence))
                    : refusalResponse(403, sentence),
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
          ),
        );

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
