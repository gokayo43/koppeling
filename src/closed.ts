import { isJsonArray, isJsonObject, type Json, type JsonObject, type JsonSchema } from "./json";

/**
 * Closed inputs: the input schema the door shows names every key an object
 * may carry, and a call whose input carries any other key is refused before
 * the program runs. A program's own validator drops such a key without a word
 * (zod's default object, Effect's `onExcessProperty: "ignore"`, Elysia's
 * `normalize`), so a misspelled filter would otherwise be answered as if it
 * had not been asked.
 *
 * An object the program declares open stays open: a record (`additionalProperties`
 * as a schema, `patternProperties`), an object that allows more
 * (`additionalProperties: true` or `{}`), and an alternative that takes
 * anything (`{}`). Only an object that names its keys (`properties`) is closed.
 */

const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

/** Where a schema keeps the schemas of the values below it. */
const BY_KEY = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SINGLE = ["items", "additionalProperties"] as const;

/** Keys that describe a schema without restricting what it takes. */
const ANNOTATIONS = new Set(["title", "description", "$comment", "default", "examples"]);

/**
 * `schema` with every object that names its keys closed: by
 * `additionalProperties: false`, or, where its keys come from `allOf`,
 * `anyOf`, `oneOf` or `$ref` as well, by `unevaluatedProperties: false`, which
 * JSON Schema evaluates across them (closing each part would refuse its
 * siblings' keys).
 */
export function closed(schema: JsonSchema): JsonSchema {
  return close(schema, false);
}

/** `part`: the schema is one of a combination's parts, which the combination closes. */
function close(schema: JsonSchema, part: boolean): JsonSchema {
  const below: [string, Json][] = [];
  for (const key of BY_KEY) {
    const map = schema[key];
    if (isJsonObject(map)) {
      below.push([
        key,
        Object.fromEntries(
          Object.entries(map).map(([name, child]) => [name, closeAny(child, false)]),
        ),
      ]);
    }
  }
  for (const key of SINGLE) {
    const child = schema[key];
    if (isJsonObject(child)) below.push([key, close(child, false)]);
  }
  const prefix = schema["prefixItems"];
  if (isJsonArray(prefix))
    below.push(["prefixItems", prefix.map((child) => closeAny(child, false))]);
  for (const key of COMBINATORS) {
    const parts = schema[key];
    if (isJsonArray(parts)) below.push([key, parts.map((child) => closeAny(child, true))]);
  }
  const rewritten: JsonSchema = { ...schema, ...Object.fromEntries(below) };
  if (part || !namesKeys(schema) || declaresOpenness(schema) || hasOpenPart(schema)) {
    return rewritten;
  }
  const combined = COMBINATORS.some((key) => isJsonArray(schema[key])) || "$ref" in schema;
  return { ...rewritten, [combined ? "unevaluatedProperties" : "additionalProperties"]: false };
}

const closeAny = (child: Json, part: boolean): Json =>
  isJsonObject(child) ? close(child, part) : child;

/** Whether a schema names an object's keys, itself or through a combination's parts. */
function namesKeys(schema: JsonSchema): boolean {
  return (
    isJsonObject(schema["properties"]) ||
    COMBINATORS.some((key) => partsOf(schema, key).some(namesKeys))
  );
}

/** Whether the schema says itself which keys beyond its own an object may carry. */
function declaresOpenness(schema: JsonSchema): boolean {
  return (
    "additionalProperties" in schema ||
    "patternProperties" in schema ||
    "unevaluatedProperties" in schema
  );
}

/**
 * Whether a combination's part takes keys the combination does not name: a
 * part that is open, or an alternative that takes anything at all.
 */
function hasOpenPart(schema: JsonSchema): boolean {
  return COMBINATORS.some((key) =>
    partsOf(schema, key).some(
      (part) =>
        isOpen(part) ||
        (key !== "allOf" && Object.keys(part).every((name) => ANNOTATIONS.has(name))),
    ),
  );
}

function partsOf(schema: JsonSchema, key: (typeof COMBINATORS)[number]): JsonSchema[] {
  const parts = schema[key];
  return isJsonArray(parts) ? parts.filter(isJsonObject) : [];
}

/** A schema that lets an object carry keys it does not name. */
function isOpen(schema: JsonSchema): boolean {
  const more = schema["additionalProperties"];
  const unevaluated = schema["unevaluatedProperties"];
  return (
    (more !== undefined && more !== false) ||
    (unevaluated !== undefined && unevaluated !== false) ||
    "patternProperties" in schema ||
    hasOpenPart(schema)
  );
}

/** One place in an input whose object carries keys its schema does not name. */
export interface Stray {
  /** Where, as `input`, `input.body` or `input.lines[0]`. */
  readonly at: string;
  readonly unknown: readonly string[];
  readonly allowed: readonly string[];
}

/**
 * Every place in `value` where an object carries a key the closed `schema`
 * does not name there, outermost first. Where a combination's parts disagree
 * the keys of all of them are allowed, so a refusal is never wrong; a `$ref`
 * the door cannot resolve allows any key.
 */
export function strayKeys(schema: JsonSchema, value: Json | undefined): Stray[] {
  if (value === undefined) return [];
  const strays: Stray[] = [];
  visit([{ schema, scope: [schema] }], value, "input", strays);
  return strays;
}

/** A schema met at one place, with the schemas around it that may hold its `$ref` targets. */
interface Met {
  readonly schema: JsonSchema;
  readonly scope: readonly JsonSchema[];
}

function visit(met: readonly Met[], value: Json, at: string, strays: Stray[]): void {
  const here = met.flatMap((entry) => expand(entry));
  if (isJsonArray(value)) {
    value.forEach((item, index) => {
      const below = here.flatMap(({ schema, scope }) => {
        const prefix = schema["prefixItems"];
        const positional = isJsonArray(prefix) ? prefix[index] : undefined;
        const child = isJsonObject(positional) ? positional : schema["items"];
        return isJsonObject(child) ? [{ schema: child, scope }] : [];
      });
      if (below.length) visit(below, item, `${at}[${index}]`, strays);
    });
    return;
  }
  if (!isJsonObject(value)) return;
  const allowed = new Set(here.flatMap(({ schema }) => Object.keys(propertiesOf(schema))));
  const isClosed =
    here.some(
      ({ schema }) =>
        schema["additionalProperties"] === false || schema["unevaluatedProperties"] === false,
    ) && !here.some(({ schema }) => isOpen(schema));

  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (isClosed && unknown.length) strays.push({ at, unknown, allowed: [...allowed] });
  for (const [key, item] of Object.entries(value)) {
    const below = here.flatMap(({ schema, scope }) =>
      childSchemas(schema, key).map((child) => ({ schema: child, scope })),
    );
    if (below.length) visit(below, item, `${at}.${key}`, strays);
  }
}

/** The schemas a key's value meets under `schema`: its property, or what a record gives every key. */
function childSchemas(schema: JsonSchema, key: string): JsonSchema[] {
  const own = propertiesOf(schema)[key];
  if (own !== undefined) return isJsonObject(own) ? [own] : [];
  const patterns = schema["patternProperties"];
  const matching = isJsonObject(patterns)
    ? Object.entries(patterns).flatMap(([pattern, child]) =>
        isJsonObject(child) && matches(pattern, key) ? [child] : [],
      )
    : [];
  const more = schema["additionalProperties"];
  return matching.length ? matching : isJsonObject(more) ? [more] : [];
}

function matches(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, "u").test(key);
  } catch {
    // A pattern JavaScript cannot compile is one the door cannot judge a key by.
    return true;
  }
}

function propertiesOf(schema: JsonSchema): JsonObject {
  const properties = schema["properties"];
  return isJsonObject(properties) ? properties : {};
}

/**
 * The schemas that apply at one place: the schema itself, its combinations'
 * parts and what its `$ref` points to, each followed once.
 */
function expand(met: Met, seen: ReadonlySet<JsonSchema> = new Set()): Met[] {
  if (seen.has(met.schema)) return [];
  const visited = new Set(seen).add(met.schema);
  const scope = holdsDefinitions(met.schema) ? [met.schema, ...met.scope] : met.scope;
  const own: Met = { schema: met.schema, scope };
  const parts = COMBINATORS.flatMap((key) => partsOf(met.schema, key)).map((schema) => ({
    schema,
    scope,
  }));
  const target = resolve(met.schema["$ref"], scope);
  const referred = target === undefined ? [] : [{ schema: target, scope }];
  return [own, ...[...parts, ...referred].flatMap((next) => expand(next, visited))];
}

const holdsDefinitions = (schema: JsonSchema) => "$defs" in schema || "definitions" in schema;

/**
 * A local `$ref` (`#/$defs/Name`, `#/definitions/Name`, or any pointer below
 * them) against the nearest schema around it that holds it. The door builds
 * one input schema out of several documents, so `#` is the document a part
 * came from, which is the nearest one holding definitions.
 */
function resolve(
  reference: Json | undefined,
  scope: readonly JsonSchema[],
): JsonSchema | undefined {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  const path = reference
    .slice(2)
    .split("/")
    .map((segment) => decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const root of scope) {
    let node: Json | undefined = root;
    for (const segment of path) node = isJsonObject(node) ? node[segment] : undefined;
    if (isJsonObject(node)) return node;
  }
  return undefined;
}
