import { Effect } from "effect";
import { JWTPayload } from "jose";
import { AnyElysia } from "elysia";
import { AnyTRPCRouter, inferRouterContext } from "@trpc/server";
//#region src/json.d.ts
/** A JSON value: what crosses the door in either direction. */
type Json = null | boolean | number | string | readonly Json[] | JsonObject;
interface JsonObject {
  readonly [key: string]: Json;
}
/** A JSON Schema, which is itself a JSON object. */
type JsonSchema = JsonObject;
//#endregion
//#region src/catalogue.d.ts
/** `read` changes nothing; `write` changes data, so the person is asked first. */
type Kind = "read" | "write";
/** What a program answered: its value, or its own refusal sentence. */
type Outcome = {
  readonly value: Json;
} | {
  readonly refusal: string;
};
/** One callable thing a program declares, as the door offers it. */
interface Operation<Actor> {
  readonly name: string;
  /** The first segment of the name: a router key, or a path's first segment. */
  readonly area: string;
  readonly kind: Kind;
  readonly description: string | undefined;
  readonly input: JsonSchema;
  readonly output: JsonSchema | undefined;
  /**
   * Runs the operation once, as `actor`, through the program's own code path.
   * A refusal the program states is an outcome; anything thrown is a failure
   * the program did not mean to show.
   */
  readonly run: (actor: Actor, input: Json | undefined) => Promise<Outcome>;
}
/** One operation the boot report names, and why. */
interface Note {
  readonly name: string;
  readonly reason: string;
}
/** A program's operations, derived from the program itself at boot. */
interface Catalogue<Actor> {
  /** In name order. */
  readonly operations: readonly Operation<Actor>[];
  /** What the program declares that the door does not offer. */
  readonly skipped: readonly Note[];
  /** Operations offered whose input or output the door could not write as JSON Schema. */
  readonly undescribed: readonly Note[];
}
//#endregion
//#region src/adapters/elysia.d.ts
interface ElysiaOptions<Actor> {
  /** The headers that make the app's own auth accept a request as `actor`. */
  readonly credential: (actor: Actor) => {
    readonly [header: string]: string;
  };
  /** The path prefix the door serves, such as `/api/v1`; the whole app when absent. */
  readonly mount?: string;
}
/**
 * The catalogue of an Elysia 1.4 app's routes under `mount`: each named by its
 * path's segments and its method, and run through `app.handle` with the
 * actor's credential, so the route's own auth and validation run as for any
 * client. WebSocket routes are skipped and named in the boot report.
 */
export declare function fromElysia<Actor>(app: AnyElysia, options: ElysiaOptions<Actor>): Catalogue<Actor>;
//#endregion
//#region src/adapters/trpc.d.ts
interface TrpcOptions<Router extends AnyTRPCRouter, Actor> {
  /** The router's context for one call as `actor`: the same context the UI's requests get. */
  readonly contextFor: (actor: Actor) => inferRouterContext<Router> | Promise<inferRouterContext<Router>>;
}
/**
 * The catalogue of a tRPC v11 router: every query and mutation, named by its
 * path. Subscriptions are skipped and named in the boot report.
 */
export declare function fromTrpcRouter<Router extends AnyTRPCRouter, Actor>(router: Router, options: TrpcOptions<Router, Actor>): Catalogue<Actor>;
//#endregion
//#region src/auth.d.ts
/** The identity provider whose tokens the door accepts: the portal, for every koppeling. */
interface Identity {
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
//#endregion
//#region src/door.d.ts
/** Who a token's person is to the program, or the program's sentence for why they may not come in. */
type ActorDecision<Actor> = {
  readonly actor: Actor;
} | {
  readonly refusal: string;
};
interface KoppelingOptions<Actor> {
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
interface BootReport {
  /** How many operations each area offers. */
  readonly areas: {
    readonly [area: string]: number;
  };
  readonly skipped: readonly Note[];
  readonly undescribed: readonly Note[];
}
interface Koppeling {
  /** Answers one MCP request at the door's URL: a POST, and 405 for any other method. */
  readonly handle: (request: Request) => Promise<Response>;
  /** Answers the protected resource metadata document, at the URL a 401 names. */
  readonly metadata: (request: Request) => Response;
  readonly report: BootReport;
}
/**
 * The door: an MCP server over Streamable HTTP, stateless, that offers the
 * catalogue through four tools to whoever the bearer token names.
 */
export declare function koppeling<Actor>(options: KoppelingOptions<Actor>): Koppeling;
//#endregion
export type { ActorDecision, BootReport, Catalogue, ElysiaOptions, Identity, Json, JsonObject, JsonSchema, Kind, Koppeling, KoppelingOptions, Note, Operation, Outcome, TrpcOptions };