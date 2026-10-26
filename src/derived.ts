import { copy } from "./copy";
import { wordsOf } from "./find";
import type { JsonSchema } from "./json";
import { properties } from "./schema";

/** What an operation does, as far as its kind or its HTTP method says. */
export type Action = "read" | "post" | "put" | "patch" | "delete" | "run";

/** How many of the input's field names the derived line carries. */
const LINE_FIELDS = 8;

/**
 * The line the door writes for an operation the program wrote none for: what
 * it does, the words of its name and the names of its input's fields, so
 * `admin.products.id.put` with `id, name, price, sku` reads as what it is.
 */
export function derivedLine(action: Action, name: string, fields: readonly string[]): string {
  const shown = fields.slice(0, LINE_FIELDS);
  const rest = fields.length - shown.length;
  return copy.derivedLine(
    action,
    wordsOf(name).join(" "),
    rest > 0 ? [...shown, copy.andMore(rest)] : shown,
  );
}

/** The names of a schema's fields, through its combinations, each once. */
export function fieldNames(schema: JsonSchema): string[] {
  return [...new Set(properties(schema).map(([name]) => name))];
}
