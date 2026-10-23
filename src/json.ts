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
  if (typeof value === "string" || typeof value === "boolean") return value;
  // JSON has no negative zero: JSON.stringify writes -0 as 0.
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null) return objectToJson(value);
  return null;
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- the object half of toJson's input, which is any JavaScript object
function objectToJson(value: object): Json {
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), toJson(item)]));
  }
  if (value instanceof Set) return Array.from(value, (item) => toJson(item));
  if ("toJSON" in value && typeof value.toJSON === "function") {
    // oxlint-disable-next-line typescript/no-unsafe-call -- a value's own JSON form (Date, decimal.js), whatever its declared signature
    const own: unknown = value.toJSON();
    return toJson(own);
  }
  const entries: [string, Json][] = [];
  for (const [key, item] of Object.entries(value)) {
    const kind = typeof item;
    if (kind !== "undefined" && kind !== "function" && kind !== "symbol") {
      entries.push([key, toJson(item)]);
    }
  }
  return Object.fromEntries(entries);
}
