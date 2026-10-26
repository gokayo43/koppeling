import type { AnyElysia } from "elysia";

import {
  catalogue,
  firstSegment,
  type Catalogue,
  type Declared,
  type Note,
  type Outcome,
} from "../catalogue";
import { copy } from "../copy";
import {
  isJsonArray,
  isJsonObject,
  toJson,
  type Json,
  type JsonObject,
  type JsonSchema,
} from "../json";
import { allOf, describeSchema, TYPEBOX_KIND, type Described } from "../schema";

declare module "elysia" {
  interface DocumentDecoration {
    /** `false` keeps this route from the koppeling: the door skips it and names it in its boot report. */
    koppeling?: boolean;
  }
}

export interface ElysiaOptions<Actor> {
  /** The headers that make the app's own auth accept a request as `actor`. */
  readonly credential: (actor: Actor) => { readonly [header: string]: string };
  /** The path prefix the door serves, such as `/api/v1`; the whole app when absent. */
  readonly mount?: string;
  /**
   * The area a route belongs to, from its name's segments (its path under the
   * mount, a `:param` by its name); the first segment when absent. The
   * operation's name does not change.
   */
  readonly area?: (segments: readonly string[]) => string;
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
 * client. WebSocket routes, the routes the program withholds from the door
 * (`detail.koppeling: false`) and those it hides from its own documentation
 * (`detail.hide`) are skipped and named in the boot report.
 */
export function fromElysia<Actor>(app: AnyElysia, options: ElysiaOptions<Actor>): Catalogue<Actor> {
  const mount = (options.mount ?? "").replace(/\/+$/, "");
  const declared: Declared<Actor>[] = [];
  const skipped: Note[] = [];
  for (const route of app.routes) {
    if (!route.path.startsWith(`${mount}/`)) continue;
    const segments = route.path.slice(mount.length).split("/").filter(Boolean);
    const named = segments.map(nameSegment);
    const name = [...named, route.method.toLowerCase()].join(".");
    const hooks: unknown = route.hooks;
    if (route.method === "WS") {
      skipped.push({ name, reason: "a WebSocket route, which the door does not serve" });
      continue;
    }
    const detail = field(hooks, "detail");
    if (field(detail, "koppeling") === false) {
      skipped.push({ name, reason: "withheld by the program" });
      continue;
    }
    if (field(detail, "hide") === true) {
      skipped.push({ name, reason: "hidden by the program" });
      continue;
    }
    if (segments.length === 0) {
      skipped.push({ name, reason: `the mount itself, which names no area` });
      continue;
    }
    const owner = `Elysia route ${route.method} ${route.path}`;
    const schemas = new Map(PARTS.map((part) => [part, partSchema(app, hooks, part, owner)]));
    schemas.set("params", schemas.get("params") ?? pathParameters(segments));
    const method = route.method;
    const reserved = reservedValues(app.routes, route);
    declared.push({
      name,
      area: options.area?.(named) ?? firstSegment(name),
      kind: method === "GET" || method === "HEAD" ? "read" : "write",
      description: description(hooks),
      input: inputSchema(schemas),
      output: responseSchema(app, hooks, owner),
      run: (actor, input, signal) =>
        request(
          app,
          { method, path: route.path, reserved, headers: options.credential(actor) },
          input,
          signal,
        ),
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
  if (!isStatusMap(response)) return resolved(app, response, `${owner} (response)`);
  const [status] = Object.keys(response)
    .filter((key) => /^2\d\d$/.test(key))
    .toSorted();
  return status === undefined
    ? undefined
    : resolved(app, field(response, status), `${owner} (response ${status})`);
}

/**
 * Whether a route's `response` maps status codes to schemas rather than being
 * one schema: a schema is a model's name, a TypeBox schema or a Standard
 * Schema, and a map is none of those.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the route's response, as the app wrote it
function isStatusMap(response: unknown): response is object {
  return (
    typeof response === "object" &&
    response !== null &&
    !(TYPEBOX_KIND in response) &&
    !("~standard" in response)
  );
}

/**
 * A schema the route names by model, read from the app's own definitions.
 * Not through `app.models`: that getter compiles a validator for every model
 * on each read (CLAUDE.md, Gotchas, has the measurement).
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route's schema, in whichever language the app wrote it
function resolved(app: AnyElysia, schema: unknown, owner: string): Described {
  if (typeof schema !== "string") return describeSchema(schema, owner);
  const model = field(field(field(app, "definitions"), "type"), schema);
  if (model === undefined)
    throw new Error(`${owner}: names a model "${schema}" the app does not have`);
  return describeSchema(model, owner);
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
  /** Per path parameter, the values that would reach a static sibling route instead. */
  readonly reserved: ReadonlyMap<string, ReadonlySet<string>>;
  readonly headers: { readonly [header: string]: string };
}

const isParameter = (segment: string) => segment.startsWith(":") || segment === "*";

/**
 * For each of a route's path parameters, the values its sibling routes spell
 * as a static segment at that position. Elysia's router prefers a static
 * segment to a parameter, so a call with such a value would run the sibling
 * (perhaps withheld, hidden or guarded otherwise) under this operation's name.
 * A sibling answers the same method, has as many segments, and agrees with
 * this route wherever both are static.
 */
function reservedValues(
  routes: readonly { readonly method: string; readonly path: string }[],
  route: { readonly method: string; readonly path: string },
): ReadonlyMap<string, ReadonlySet<string>> {
  const own = route.path.split("/");
  const reserved = new Map<string, Set<string>>();
  for (const sibling of routes) {
    if (sibling.method !== route.method && sibling.method !== "ALL") continue;
    const theirs = sibling.path.split("/");
    if (theirs.length !== own.length) continue;
    const agrees = own.every(
      (segment, index) =>
        isParameter(segment) || isParameter(theirs[index] ?? "") || segment === theirs[index],
    );
    if (!agrees) continue;
    own.forEach((segment, index) => {
      const value = theirs[index] ?? "";
      if (!segment.startsWith(":") || isParameter(value)) return;
      const name = parameterName(segment);
      reserved.set(name, (reserved.get(name) ?? new Set()).add(value));
    });
  }
  return reserved;
}

async function request(
  app: AnyElysia,
  target: Target,
  input: Json | undefined,
  signal: AbortSignal,
): Promise<Outcome> {
  const parts = input === undefined ? {} : input;
  if (!isJsonObject(parts)) return { refusal: copy.inputNotObject };
  const url = urlOf(target, parts["params"], parts["query"]);
  if ("refusal" in url) return url;
  const headers = new Headers(target.headers);
  const body = parts["body"];
  const carriesBody = body !== undefined && target.method !== "GET" && target.method !== "HEAD";
  if (carriesBody) headers.set("content-type", "application/json");
  const response = await app.handle(
    new Request(url.href, {
      method: target.method,
      headers,
      signal,
      ...(carriesBody ? { body: JSON.stringify(body) } : {}),
    }),
  );
  // From here the program has been reached. A 5xx is the program failing, and
  // its body can carry a stack or a database's words, so it is a failure the
  // door answers with its own sentence; so is an answer that cannot be read.
  // A 4xx is the program's refusal and goes back as it is.
  try {
    const text = await bodyOf(response, signal);
    if (response.status >= 500) return { failed: new Error(`HTTP ${response.status}: ${text}`) };
    if (!response.ok) return { refusal: `HTTP ${response.status}: ${text}` };
    if (text === "") return { value: null };
    if (!response.headers.get("content-type")?.includes("json")) return { value: text };
    const parsed: unknown = JSON.parse(text);
    return { value: toJson(parsed) };
  } catch (cause) {
    return { failed: cause };
  }
}

/** A response's body, read until `signal` aborts, which cancels a stream that never ends. */
async function bodyOf(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const cancel = () => void reader.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      // Bun hands a stream's chunks on as they were enqueued, a string included.
      const part: unknown = chunk.value;
      if (typeof part === "string") text += part;
      else if (part instanceof Uint8Array) text += decoder.decode(part, { stream: true });
      else throw new TypeError("A response body chunk that is neither text nor bytes");
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function urlOf(
  target: Target,
  params: Json | undefined,
  query: Json | undefined,
): { readonly href: string } | { readonly refusal: string } {
  const given: JsonObject = isJsonObject(params) ? params : {};
  const segments: string[] = [];
  for (const segment of target.path.split("/")) {
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
    // encodeURIComponent leaves "." and ".." as they are, and a URL resolves
    // them, so such a value would send the call to another route, outside
    // the mount included; an empty one would join its neighbours.
    const encoded = encodeURIComponent(textOf(value));
    if (encoded === "" || encoded === "." || encoded === "..") {
      return { refusal: copy.badPathParameter(name) };
    }
    if (target.reserved.get(name)?.has(encoded)) {
      return { refusal: copy.reservedPathParameter(name, encoded) };
    }
    segments.push(encoded);
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
