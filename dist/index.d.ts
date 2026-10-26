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
/**
 * What a program answered: its value, its own refusal sentence with whatever
 * structured details it gave (a list of the values it accepts), or a failure
 * after the program was reached, when whatever it was asked to change may have
 * changed.
 */
type Outcome = {
  readonly value: Json;
} | {
  readonly refusal: string;
  readonly details?: Json;
} | {
  readonly failed: unknown;
};
/** One callable thing a program declares, as the door offers it. */
interface Operation<Actor> {
  readonly name: string;
  /** The part of the program it belongs to: by default its name's first segment. */
  readonly area: string;
  readonly kind: Kind;
  /**
   * The program's own words, or, where it wrote none, one line the door
   * derived from the name's words and the input's fields.
   */
  readonly description: string;
  /** Whether `description` is the program's own words rather than the door's line. */
  readonly written: boolean;
  /** Whether running it may destroy data: delete, or overwrite what cannot be had back. */
  readonly destructive: boolean;
  /** Whether running it again with the same input changes nothing more. */
  readonly idempotent: boolean;
  /** Every object that names its keys is closed: a call carrying any other key is refused. */
  readonly input: JsonSchema;
  readonly output: JsonSchema | undefined;
  /**
   * Runs the operation once, as `actor`, through the program's own code path,
   * giving up when `signal` aborts. A throw is a failure before the program
   * was reached, so nothing changed.
   */
  readonly run: (actor: Actor, input: Json | undefined, signal: AbortSignal) => Promise<Outcome>;
}
/**
 * What a program may say to the door about one operation, as a tRPC
 * procedure's `meta.koppeling` or an Elysia route's `detail.koppeling`, each
 * overriding what the door would derive; `false` there withholds the
 * operation instead.
 */
interface KoppelingMeta {
  readonly description?: string;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
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
declare module "elysia" {
  interface DocumentDecoration {
    /**
     * What the route says to the koppeling, over what the door derives; `false`
     * keeps the route from it, and the door names it in its boot report.
     */
    koppeling?: false | KoppelingMeta;
  }
}
interface ElysiaOptions<Actor> {
  /** The headers that make the app's own auth accept a request as `actor`. */
  readonly credential: (actor: Actor) => {
    readonly [header: string]: string;
  };
  /** The path prefix the door serves, such as `/api/v1`; the whole app when absent. */
  readonly mount?: string;
  /**
   * The area a route belongs to, from its name's segments (its path under the
   * mount, a `:param` by its name); the first segment when absent. The
   * operation's name does not change.
   */
  readonly area?: (segments: readonly string[]) => string;
}
/**
 * The catalogue of an Elysia 1.4 app's routes under `mount`: each named by its
 * path's segments and its method, and run through `app.handle` with the
 * actor's credential, so the route's own auth and validation run as for any
 * client. WebSocket routes, the routes the program withholds from the door
 * (`detail.koppeling: false`) and those it hides from its own documentation
 * (`detail.hide`) are skipped and named in the boot report.
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
 * path. A mutation is destructive and not idempotent, a query neither
 * destroys nor repeats anything, unless `meta.koppeling` says otherwise.
 * Subscriptions and the procedures the program withholds from the door
 * (`meta.koppeling: false`) are skipped and named in the boot report.
 */
export declare function fromTrpcRouter<Router extends AnyTRPCRouter, Actor>(router: Router, options: TrpcOptions<Router, Actor>): Catalogue<Actor>;
//#endregion
//#region src/door.d.ts
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
/**
 * What a write came to: the program's value, its refusal, a failure before the
 * program was reached (nothing changed), or `unknown`: the program was reached
 * and its answer was lost or late, so the change may have been made.
 */
type WriteOutcome = "value" | "refusal" | "failure" | "unknown";
/**
 * What the door tells the host's logger. `write`: one per call of a write
 * operation, naming the person and the program acting for them. `failure`: a
 * failure the person was answered with the door's own sentence for; its
 * `operation` is null when the sign-in failed (the key set, or `actorFor`).
 */
type KoppelingEvent = {
  readonly kind: "write";
  readonly operation: string;
  readonly sub: string | null;
  readonly name: string | null;
  readonly via: string | null;
  readonly outcome: WriteOutcome;
} | {
  readonly kind: "failure";
  readonly operation: string | null;
  readonly cause: unknown;
};
/**
 * Who a token's person is to the program, with the operations they may use
 * (every one when `allows` is absent), or the program's sentence for why they
 * may not come in.
 */
type ActorDecision<Actor> = {
  readonly actor: Actor;
  /** Whether the person may use `operation`: the door lists, finds, describes and runs only those. */
  readonly allows?: (operation: Operation<Actor>) => boolean;
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
  /** The host's logger for every write and every failure; Effect's own logger when absent. */
  readonly log?: (event: KoppelingEvent) => void;
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
 * catalogue through five tools to whoever the bearer token names.
 */
export declare function koppeling<Actor>(options: KoppelingOptions<Actor>): Koppeling;
//#endregion
//#region src/glossary.d.ts
interface GlossaryOptions {
  /** The most characters the glossary may take, the closing line included. */
  readonly limit: number;
}
/**
 * A program's glossary (its CONTEXT.md) as the door's opening words: one line
 * per `##` section, its heading, the first sentence of its own text where it
 * has one, and the names of its `###` terms. Lines are kept in order while
 * they fit within `limit`; a closing line names the sections left out.
 */
export declare function glossaryFrom(markdown: string, options: GlossaryOptions): string;
//#endregion
export type { ActorDecision, BootReport, Catalogue, ElysiaOptions, GlossaryOptions, Identity, Json, JsonObject, JsonSchema, Kind, Koppeling, KoppelingEvent, KoppelingMeta, KoppelingOptions, Note, Operation, Outcome, TrpcOptions, WriteOutcome };