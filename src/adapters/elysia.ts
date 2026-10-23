import type { AnyElysia } from "elysia";

import { catalogue, type Catalogue, type Declared, type Note, type Outcome } from "../catalogue";
import { copy } from "../copy";
import {
  isJsonArray,
  isJsonObject,
  toJson,
  type Json,
  type JsonObject,
  type JsonSchema,
} from "../json";
import { allOf, describeSchema, type Described } from "../schema";

export interface ElysiaOptions<Actor> {
  /** The headers that make the app's own auth accept a request as `actor`. */
  readonly credential: (actor: Actor) => { readonly [header: string]: string };
  /** The path prefix the door serves, such as `/api/v1`; the whole app when absent. */
  readonly mount?: string;
}

type Part = "params" | "query" | "body";
const PARTS: readonly Part[] = ["params", "query", "body"];

/**
 * Elysia finds a request's path by searching for the first `/` from index 11
 * of its URL, so an origin shorter than that loses the path's start and every
 * route answers 404 (measured on 1.4.30 with `http://x`).
 */
const ORIGIN = "http://localhost";

/**
 * The catalogue of an Elysia 1.4 app's routes under `mount`: each named by its
 * path's segments and its method, and run through `app.handle` with the
 * actor's credential, so the route's own auth and validation run as for any
 * client. WebSocket routes are skipped and named in the boot report.
 */
export function fromElysia<Actor>(app: AnyElysia, options: ElysiaOptions<Actor>): Catalogue<Actor> {
  const mount = (options.mount ?? "").replace(/\/+$/, "");
  const declared: Declared<Actor>[] = [];
  const skipped: Note[] = [];
  for (const route of app.routes) {
    if (!route.path.startsWith(`${mount}/`)) continue;
    const segments = route.path.slice(mount.length).split("/").filter(Boolean);
    const name = [...segments.map(nameSegment), route.method.toLowerCase()].join(".");
    if (route.method === "WS") {
      skipped.push({ name, reason: "a WebSocket route, which the door does not serve" });
      continue;
    }
    if (segments.length === 0) {
      skipped.push({ name, reason: `the mount itself, which names no area` });
      continue;
    }
    const owner = `Elysia route ${route.method} ${route.path}`;
    const hooks: unknown = route.hooks;
    const schemas = new Map(PARTS.map((part) => [part, partSchema(app, hooks, part, owner)]));
    schemas.set("params", schemas.get("params") ?? pathParameters(segments));
    const method = route.method;
    declared.push({
      name,
      kind: method === "GET" || method === "HEAD" ? "read" : "write",
      description: description(hooks),
      input: inputSchema(schemas),
      output: responseSchema(app, hooks, owner),
      run: (actor, input) =>
        request(app, { method, path: route.path, headers: options.credential(actor) }, input),
    });
  }
  return catalogue(declared, skipped);
}

function nameSegment(segment: string): string {
  return segment
    .replace(/^:/, "")
    .replace(/\?$/, "")
    .replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

/** The route's own schema for one part, with each guard's beside it. */
function partSchema(
  app: AnyElysia,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Elysia types a route's hooks as any; read through field()
  hooks: unknown,
  part: Part,
  owner: string,
): Described | undefined {
  const own = field(hooks, part);
  const guards = field(hooks, "standaloneValidator");
  return allOf(
    [own, ...(Array.isArray(guards) ? guards.map((guard) => field(guard, part)) : [])]
      .filter((schema) => schema !== undefined)
      .map((schema) => resolved(app, schema, `${owner} (${part})`)),
  );
}

/** What a path's `:name` segments ask for when the route declares no params schema. */
function pathParameters(segments: readonly string[]): Described | undefined {
  const names = segments.filter((segment) => segment.startsWith(":")).map(parameterName);
  if (names.length === 0) return undefined;
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      required: names,
    },
  };
}

function parameterName(segment: string): string {
  return segment.slice(1).replace(/\?$/, "");
}

/** The route's parts as one object: `{ params, query, body }`, each as the route declares it. */
function inputSchema(schemas: ReadonlyMap<Part, Described | undefined>): Described {
  const present: [Part, JsonSchema][] = [];
  const reasons: string[] = [];
  for (const part of PARTS) {
    const described = schemas.get(part);
    if (described === undefined) continue;
    if ("schema" in described) present.push([part, described.schema]);
    else reasons.push(`${part}: ${described.undescribable}`);
  }
  if (reasons.length) return { undescribable: reasons.join("; ") };
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(present),
      required: present
        .filter(([part, schema]) => part !== "query" || requires(schema))
        .map(([part]) => part),
      additionalProperties: false,
    },
  };
}

function requires(schema: JsonSchema): boolean {
  const required = schema["required"];
  return (isJsonArray(required) && required.length > 0) || isJsonArray(schema["allOf"]);
}

function responseSchema(
  app: AnyElysia,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the route's hooks, as above
  hooks: unknown,
  owner: string,
): Described | undefined {
  const response = field(hooks, "response");
  if (response === undefined) return undefined;
  const single = typeof response === "string" || field(response, "200") === undefined;
  const schema = single ? response : field(response, "200");
  return resolved(app, schema, `${owner} (response 200)`);
}

/** A schema the route names by model, looked up the way Elysia looks it up. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route's schema, in whichever language the app wrote it
function resolved(app: AnyElysia, schema: unknown, owner: string): Described {
  if (typeof schema !== "string") return describeSchema(schema, owner);
  const model = field(app.models, schema);
  if (model === undefined)
    throw new Error(`${owner}: names a model "${schema}" the app does not have`);
  return describeSchema(field(model, "schema"), owner);
}

/** `detail.summary` as the operation's line and `detail.description` below it. */
function description(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the route's hooks, as above
  hooks: unknown,
): string | undefined {
  const detail = field(hooks, "detail");
  const lines = [field(detail, "summary"), field(detail, "description")]
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

interface Target {
  readonly method: string;
  readonly path: string;
  readonly headers: { readonly [header: string]: string };
}

async function request(app: AnyElysia, target: Target, input: Json | undefined): Promise<Outcome> {
  const parts = input === undefined ? {} : input;
  if (!isJsonObject(parts)) return { refusal: copy.inputNotObject };
  const url = urlOf(target.path, parts["params"], parts["query"]);
  if ("refusal" in url) return url;
  const headers = new Headers(target.headers);
  const body = parts["body"];
  const carriesBody = body !== undefined && target.method !== "GET" && target.method !== "HEAD";
  if (carriesBody) headers.set("content-type", "application/json");
  const response = await app.handle(
    new Request(url.href, {
      method: target.method,
      headers,
      ...(carriesBody ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await response.text();
  if (!response.ok) return { refusal: `HTTP ${response.status}: ${text}` };
  if (text === "") return { value: null };
  if (!response.headers.get("content-type")?.includes("json")) return { value: text };
  const parsed: unknown = JSON.parse(text);
  return { value: toJson(parsed) };
}

function urlOf(
  path: string,
  params: Json | undefined,
  query: Json | undefined,
): { readonly href: string } | { readonly refusal: string } {
  const given: JsonObject = isJsonObject(params) ? params : {};
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment.startsWith(":")) {
      segments.push(segment);
      continue;
    }
    const name = parameterName(segment);
    const value = given[name];
    if (value === undefined) {
      if (segment.endsWith("?")) continue;
      return { refusal: copy.missingPathParameter(name) };
    }
    segments.push(encodeURIComponent(textOf(value)));
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(isJsonObject(query) ? query : {})) {
    for (const item of isJsonArray(value) ? value : [value]) search.append(key, textOf(item));
  }
  const queryString = search.size ? `?${search.toString()}` : "";
  return { href: `${ORIGIN}${segments.join("/")}${queryString}` };
}

function textOf(value: Json): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- reads one key of a loosely typed Elysia structure
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const entry: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return entry;
}
