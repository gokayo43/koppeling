import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Cause, Data, Effect } from "effect";
import type { JWTPayload } from "jose";

import { bearerVerifier, type Identity } from "./auth";
import type { Catalogue, Note } from "./catalogue";
import { copy } from "./copy";
import { instructionsFor, mcpServer, toDirectory } from "./tools";

/** Who a token's person is to the program, or the program's sentence for why they may not come in. */
export type ActorDecision<Actor> = { readonly actor: Actor } | { readonly refusal: string };

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

const refusalResponse = (
  status: number,
  sentence: string,
  headers: { readonly [name: string]: string } = {},
) => Response.json({ error: sentence }, { status, headers });

/**
 * The door: an MCP server over Streamable HTTP, stateless, that offers the
 * catalogue through four tools to whoever the bearer token names.
 */
export function koppeling<Actor>(options: KoppelingOptions<Actor>): Koppeling {
  const operations = toDirectory(options.catalogue);
  const instructions = instructionsFor(options.glossary, operations);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(options.resource.url));
  const verify = bearerVerifier(options.identity, options.resource.url);
  const document = {
    resource: options.resource.url,
    authorization_servers: [options.identity.authorizationServer],
    scopes_supported: options.resource.scopes,
    bearer_methods_supported: ["header"],
  };

  const serverFor = (actor: Actor) => mcpServer(operations, instructions, actor);

  /**
   * A 2025-era request (the `initialize` handshake and what follows it) is
   * served the way the portal's door serves Claude Desktop today; a 2026-07-28
   * request goes to the SDK's own per-request handler.
   */
  const serve = async (request: Request, actor: Actor): Promise<Response> => {
    if (await isLegacyRequest(request)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await serverFor(actor).connect(transport);
      return transport.handleRequest(request);
    }
    const modern = createMcpHandler(() => serverFor(actor), { legacy: "reject" });
    try {
      return await modern.fetch(request);
    } finally {
      await modern.close();
    }
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
            Effect.flatMap((claims) => Effect.promise(async () => options.actorFor(claims))),
            Effect.flatMap((decision) =>
              "refusal" in decision
                ? Effect.fail(new Refused({ sentence: decision.refusal }))
                : Effect.promise(() => serve(request, decision.actor)),
            ),
            Effect.catchTags({
              Unauthenticated: ({ sentence, tokenGiven }) =>
                Effect.succeed(
                  refusalResponse(401, sentence, {
                    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"${tokenGiven ? ', error="invalid_token"' : ""}`,
                  }),
                ),
              Refused: ({ sentence }) => Effect.succeed(refusalResponse(403, sentence)),
              KeysUnreachable: ({ cause }) =>
                Effect.logError(
                  "The identity provider's key set could not be read",
                  Cause.die(cause),
                ).pipe(Effect.as(refusalResponse(503, copy.keysUnreachable))),
            }),
          ),
        );

  const metadata = (request: Request) =>
    request.method === "GET" || request.method === "HEAD"
      ? Response.json(document)
      : new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

  const report: BootReport = {
    areas: Object.fromEntries(
      Array.from(operations.areas.values(), (area) => [area.name, area.operations.length]),
    ),
    skipped: options.catalogue.skipped,
    undescribed: options.catalogue.undescribed,
  };

  return { handle, metadata, report };
}
