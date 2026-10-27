import type { AnyElysia } from "elysia";

import {
  catalogue,
  firstSegment,
  koppelingMeta,
  type Catalogue,
  type KoppelingMeta,
  type Declared,
  type Note,
  type Outcome,
} from "../catalogue";
import { copy } from "../copy";
import { derivedLine, fieldNames, type Action } from "../derived";
import {
  isJsonArray,
  isJsonObject,
  toJson,
  type Json,
  type JsonObject,
  type JsonSchema,
} from "../json";
import { allOf, describeSchema, TYPEBOX_KIND, type Described, type Side } from "../schema";

declare module "elysia" {
  interface DocumentDecoration {
    /**
     * What the route says to the koppeling, over what the door derives; `false`
     * keeps the route from it, and the door names it in its boot report.
     */
    koppeling?: false | KoppelingMeta;
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
    const owner = `Elysia route ${route.method} ${route.path}`;
    const meta = koppelingMeta(field(detail, "koppeling"), `${owner}: detail.koppeling`);
    if (meta === "withheld") {
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
    const method = route.method;
    const schemas = new Map(PARTS.map((part) => [part, partSchema(app, hooks, part, owner)]));
    schemas.set("params", schemas.get("params") ?? pathParameters(segments));
    const own = ownStore(app, route.method, route.path, owner);
    declared.push({
      name,
      area: options.area?.(named) ?? firstSegment(name),
      kind: method === "GET" || method === "HEAD" ? "read" : "write",
      ...lineOf(meta.description ?? description(hooks), method, named, schemas),
      ...hints(method, meta),
      input: inputSchema(schemas, carriesBody(method)),
      omittedInput: {},
      output: responseSchema(app, hooks, owner),
      run: (actor, input, signal) =>
        request(
          app,
          { app, method, path: route.path, own, headers: options.credential(actor) },
          input,
          signal,
        ),
    });
  }
  return catalogue(declared, skipped);
}

/**
 * What a method says about a route, the HTTP way: GET and HEAD change
 * nothing, PUT replaces and DELETE deletes, each to the same end however
 * often, and POST and PATCH may change more each time. Any other method is
 * taken to be the riskiest; `detail.koppeling` overrides either hint.
 */
function hints(method: string, meta: KoppelingMeta) {
  const safe = method === "GET" || method === "HEAD";
  const derived =
    safe || method === "PUT" || method === "DELETE" || method === "POST" || method === "PATCH"
      ? {
          destructive: method === "DELETE",
          idempotent: safe || method === "PUT" || method === "DELETE",
        }
      : { destructive: true, idempotent: false };
  return {
    destructive: meta.destructive ?? derived.destructive,
    idempotent: meta.idempotent ?? derived.idempotent,
  };
}

const ACTIONS = new Map<string, Action>([
  ["GET", "read"],
  ["HEAD", "read"],
  ["POST", "post"],
  ["PUT", "put"],
  ["PATCH", "patch"],
  ["DELETE", "delete"],
]);

/** The route's written line, or the door's from its path's words and its declared fields. */
function lineOf(
  written: string | undefined,
  method: string,
  named: readonly string[],
  schemas: ReadonlyMap<Part, Described | undefined>,
) {
  if (written !== undefined) return { description: written, written: true };
  const fields = PARTS.flatMap((part) => {
    const schema = schemas.get(part);
    return schema !== undefined && "schema" in schema ? fieldNames(schema.schema) : [];
  });
  return {
    description: derivedLine(ACTIONS.get(method) ?? "run", named.join("."), [...new Set(fields)]),
    written: false,
  };
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
      .map((schema) => resolved(app, schema, `${owner} (${part})`, "input")),
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

const carriesBody = (method: string) => method !== "GET" && method !== "HEAD";

/**
 * A part the route declares no schema for, which its handler may still read:
 * the door passes it on as it is, so it shows it open. An undeclared query is
 * an object of any keys; an undeclared body any value.
 */
const UNDECLARED = {
  query: { type: "object", additionalProperties: true, description: copy.undeclaredPart },
  body: { description: copy.undeclaredPart },
} as const satisfies { readonly [P in "query" | "body"]: JsonSchema };

/**
 * The route's parts as one object: `{ params, query, body }`, each as the
 * route declares it, and a query, and a body where the method carries one,
 * open where it declares none.
 */
function inputSchema(
  schemas: ReadonlyMap<Part, Described | undefined>,
  withBody: boolean,
): Described {
  const present: [Part, JsonSchema][] = [];
  const required: Part[] = [];
  const reasons: string[] = [];
  for (const part of PARTS) {
    const described = schemas.get(part);
    if (described === undefined) {
      if (part === "query" || (part === "body" && withBody)) present.push([part, UNDECLARED[part]]);
      continue;
    }
    if ("undescribable" in described) {
      reasons.push(`${part}: ${described.undescribable}`);
      continue;
    }
    present.push([part, described.schema]);
    if (part !== "query" || requires(described.schema)) required.push(part);
  }
  if (reasons.length) return { undescribable: reasons.join("; ") };
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(present),
      required,
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
  if (!isStatusMap(response)) return resolved(app, response, `${owner} (response)`, "output");
  const [status] = Object.keys(response)
    .filter((key) => /^2\d\d$/.test(key))
    .toSorted();
  return status === undefined
    ? undefined
    : resolved(app, field(response, status), `${owner} (response ${status})`, "output");
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
function resolved(app: AnyElysia, schema: unknown, owner: string, side: Side): Described {
  if (typeof schema !== "string") return describeSchema(schema, owner, side);
  const model = field(field(field(app, "definitions"), "type"), schema);
  if (model === undefined)
    throw new Error(`${owner}: names a model "${schema}" the app does not have`);
  return describeSchema(model, owner, side);
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
  readonly app: AnyElysia;
  readonly method: string;
  readonly path: string;
  /** The route's own store in Elysia's router; undefined for a route without parameters. */
  readonly own: Reached;
  readonly headers: { readonly [header: string]: string };
}

/** What a path reaches in the app: a static route's index, or a parameterised route's store. */
type Reached = number | object | undefined;

/**
 * Whether the app answers through its generated handler, Elysia's default, or
 * through its dynamic one (`aot: false`), which keeps every route, static ones
 * included, in `router.dynamic` instead.
 */
const compiled = (app: AnyElysia) => app.config.aot !== false;

/**
 * The route Elysia itself sends `method` and `path` to, read from its own
 * router in the order its handler asks (Elysia 1.4.30). The generated handler
 * (`composeGeneralHandler`): a static route first, where HEAD falls back to
 * GET or ALL; then the parameterised routes, where HEAD tries GET before its
 * own, then ALL. The dynamic handler (`createDynamicHandler`): the method,
 * then ALL.
 */
function reached(app: AnyElysia, method: string, path: string): Reached {
  if (!compiled(app)) {
    const router = app.router.dynamic;
    return (router.find(method, path) ?? router.find("ALL", path))?.store;
  }
  const decoded = path.split("/").map((segment) => decodeURIComponent(segment));
  for (const [template, methods] of Object.entries(app.router.static)) {
    const segments = template.split("/");
    if (
      segments.length !== decoded.length ||
      segments.some((segment, i) => segment !== decoded[i])
    ) {
      continue;
    }
    const index =
      methods[method] ?? (method === "HEAD" ? (methods["GET"] ?? methods["ALL"]) : methods["ALL"]);
    if (index !== undefined) return index;
  }
  const router = app.router.http;
  const found =
    (method === "HEAD" ? router.find("GET", path) : null) ??
    router.find(method, path) ??
    router.find("ALL", path);
  return found?.store;
}

/** A path parameter value no route spells, to find a route's own store by. */
const PROBE = "koppeling-probe-3f9c";

/**
 * The route's own store in the router Elysia answers it through, found by a
 * path only it matches; undefined for a route without parameters, which no
 * value can send elsewhere. A parameterised route the door cannot find there
 * fails the boot: without it, no call's path could be checked.
 */
function ownStore(app: AnyElysia, method: string, path: string, owner: string): Reached {
  if (!path.includes(":") && !path.includes("*")) return undefined;
  const probe = path
    .split("/")
    .map((segment) => (segment.startsWith(":") || segment === "*" ? PROBE : segment))
    .join("/");
  const store = (compiled(app) ? app.router.http : app.router.dynamic).find(method, probe)?.store;
  if (store === undefined) {
    throw new Error(
      `${owner}: the door cannot find this route in Elysia's router (router.http, or router.dynamic when aot is false), so it cannot check where a call's path leads`,
    );
  }
  return store;
}

async function request(
  app: AnyElysia,
  target: Target,
  input: Json | undefined,
  signal: AbortSignal,
): Promise<Outcome> {
  if (!isJsonObject(input)) return { refusal: copy.inputNotObject };
  const url = urlOf(target, input["params"], input["query"]);
  if ("refusal" in url) return url;
  const headers = new Headers(target.headers);
  const body = input["body"];
  const sendsBody = body !== undefined && carriesBody(target.method);
  if (sendsBody) headers.set("content-type", "application/json");
  const response = await app.handle(
    new Request(url.href, {
      method: target.method,
      headers,
      signal,
      ...(sendsBody ? { body: JSON.stringify(body) } : {}),
    }),
  );
  // From here the program has been reached. A 5xx is the program failing, and
  // its body can carry a stack or a database's words, so it is a failure the
  // door answers with its own sentence; so is an answer that cannot be read.
  // A 4xx is the program's refusal and goes back as it is.
  try {
    const text = await bodyOf(response, signal);
    if (response.status >= 500) return { failed: new Error(`HTTP ${response.status}: ${text}`) };
    const json = response.headers.get("content-type")?.includes("json") === true;
    if (!response.ok) {
      const refusal = `HTTP ${response.status}: ${text}`;
      const details = json ? parsedOrNothing(text) : undefined;
      return details === undefined ? { refusal } : { refusal, details };
    }
    if (text === "") return { value: null };
    if (!json) return { value: text };
    const parsed: unknown = JSON.parse(text);
    return { value: toJson(parsed) };
  } catch (cause) {
    return { failed: cause };
  }
}

/** A refusal's JSON body as data, or nothing when it does not parse: its text still goes back. */
function parsedOrNothing(text: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return toJson(parsed);
  } catch {
    return undefined;
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
  const values = new Map<string, string>();
  for (const segment of target.path.split("/")) {
    if (!segment.startsWith(":")) continue;
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
    values.set(name, encoded);
  }
  const path = pathOf(target.path, (name) => values.get(name));
  if (target.own !== undefined && reached(target.app, target.method, path) !== target.own) {
    return { refusal: copy.routedElsewhere(culprits(target, values)) };
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(isJsonObject(query) ? query : {})) {
    for (const item of isJsonArray(value) ? value : [value]) search.append(key, textOf(item));
  }
  const queryString = search.size ? `?${search.toString()}` : "";
  return { href: `${ORIGIN}${path}${queryString}` };
}

/** A route's path with each parameter's value put in, an optional one left out when it has none. */
function pathOf(template: string, valueOf: (name: string) => string | undefined): string {
  return template
    .split("/")
    .flatMap((segment) => {
      if (!segment.startsWith(":")) return [segment];
      const value = valueOf(parameterName(segment));
      return value === undefined ? [] : [value];
    })
    .join("/");
}

/**
 * The parameters whose value alone sends the call elsewhere, the others left
 * at a value no route spells; all of them when only their combination does.
 */
function culprits(target: Target, values: ReadonlyMap<string, string>): string[] {
  const names = [...values.keys()];
  const alone = names.filter(
    (name) =>
      reached(
        target.app,
        target.method,
        pathOf(target.path, (other) => (other === name ? values.get(other) : PROBE)),
      ) !== target.own,
  );
  return alone.length ? alone : names;
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
