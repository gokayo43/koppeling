/** A JSON value: what crosses the door in either direction. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

/** A JSON Schema, which is itself a JSON object. */
export type JsonSchema = JsonObject;

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !isJsonArray(value);
}

export function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

/**
 * The JSON a program's own value becomes, as `JSON.stringify` would write it,
 * except that a `bigint` becomes its decimal string and a `Map` or `Set` keeps
 * its entries: a tRPC program on superjson returns all three, and
 * `JSON.stringify` throws on the first and writes `{}` for the other two.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a program's answer is any JavaScript value; this is where it becomes JSON
export function toJson(value: unknown): Json {
  return walk(value, undefined);
}

/** How deep {@link boundedJson} follows a value before it writes `null` instead. */
const BOUND_DEPTH = 12;

/**
 * {@link toJson} for a value the program did not mean as an answer (a
 * refusal's details): an `Error` becomes its message, a value met again
 * inside itself becomes `null`, and so does anything deeper than
 * {@link BOUND_DEPTH}, so a looping or endless object cannot exhaust the stack.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever object a program attached; this is where it becomes JSON
export function boundedJson(value: unknown): Json {
  return walk(value, { depth: 0, around: new Set() });
}

/** Where a bounded walk is: how deep, and the objects it is inside. */
interface Bound {
  readonly depth: number;
  readonly around: ReadonlySet<object>;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- toJson's input, passed on
function walk(value: unknown, bound: Bound | undefined): Json {
  if (typeof value === "string" || typeof value === "boolean") return value;
  // JSON has no negative zero: JSON.stringify writes -0 as 0.
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return null;
  if (bound === undefined) return objectToJson(value, undefined);
  if (value instanceof Error) return value.message;
  if (bound.depth >= BOUND_DEPTH || bound.around.has(value)) return null;
  return objectToJson(value, { depth: bound.depth + 1, around: new Set(bound.around).add(value) });
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- the object half of toJson's input, which is any JavaScript object
function objectToJson(value: object, bound: Bound | undefined): Json {
  if (Array.isArray(value)) return value.map((item) => walk(item, bound));
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), walk(item, bound)]));
  }
  if (value instanceof Set) return Array.from(value, (item) => walk(item, bound));
  if ("toJSON" in value && typeof value.toJSON === "function") {
    // oxlint-disable-next-line typescript/no-unsafe-call -- a value's own JSON form (Date, decimal.js), whatever its declared signature
    const own: unknown = value.toJSON();
    return walk(own, bound);
  }
  const entries: [string, Json][] = [];
  for (const [key, item] of Object.entries(value)) {
    const kind = typeof item;
    if (kind !== "undefined" && kind !== "function" && kind !== "symbol") {
      entries.push([key, walk(item, bound)]);
    }
  }
  return Object.fromEntries(entries);
}
