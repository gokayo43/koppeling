import { copy } from "./copy";
import type { Json, JsonSchema } from "./json";
import type { Described } from "./schema";

/** `read` changes nothing; `write` changes data, so the person is asked first. */
export type Kind = "read" | "write";

/** What a program answered: its value, or its own refusal sentence. */
export type Outcome = { readonly value: Json } | { readonly refusal: string };

/** One callable thing a program declares, as the door offers it. */
export interface Operation<Actor> {
  readonly name: string;
  /** The part of the program it belongs to: by default its name's first segment. */
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

/** An operation as an adapter derives it, before the catalogue places it. */
export type Declared<Actor> = Omit<Operation<Actor>, "input" | "output"> & {
  readonly input: Described;
  readonly output: Described | undefined;
};

/** One operation the boot report names, and why. */
export interface Note {
  readonly name: string;
  readonly reason: string;
}

/** A program's operations, derived from the program itself at boot. */
export interface Catalogue<Actor> {
  /** In name order. */
  readonly operations: readonly Operation<Actor>[];
  /** What the program declares that the door does not offer. */
  readonly skipped: readonly Note[];
  /** Operations offered whose input or output the door could not write as JSON Schema. */
  readonly undescribed: readonly Note[];
}

/** What `describe` shows for a schema the door could not write. */
const UNDESCRIBED: JsonSchema = { description: copy.undescribedSchema };

/** MCP's name rule, which every operation name is held to. */
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_NAME_LENGTH = 128;

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

/**
 * The catalogue of `declared`, in name order. A name or area outside MCP's
 * characters, or a name two operations share, throws, naming it: each is a
 * program the door would otherwise offer wrongly, and the boot is where a host
 * can fix it.
 */
export function catalogue<Actor>(
  declared: readonly Declared<Actor>[],
  skipped: readonly Note[],
): Catalogue<Actor> {
  const seen = new Set<string>();
  for (const { name, area } of declared) {
    if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
      throw new Error(`"${name}" is not a valid operation name (letters, digits, _, - and .)`);
    }
    if (!NAME.test(area) || area.length > MAX_NAME_LENGTH) {
      throw new Error(`"${area}" is not a valid area name (letters, digits, _, - and .)`);
    }
    if (seen.has(name)) throw new Error(`Two operations are both named "${name}"`);
    seen.add(name);
  }
  const undescribed: Note[] = [];
  const schemaOf = (name: string, part: string, described: Described): JsonSchema => {
    if ("schema" in described) return described.schema;
    undescribed.push({ name, reason: `${part}: ${described.undescribable}` });
    return UNDESCRIBED;
  };
  const operations = declared
    .map((operation) => ({
      ...operation,
      input: schemaOf(operation.name, "input", operation.input),
      output:
        operation.output === undefined
          ? undefined
          : schemaOf(operation.name, "output", operation.output),
    }))
    .toSorted(byName);
  return {
    operations,
    skipped: skipped.toSorted(byName),
    undescribed: undescribed.toSorted(byName),
  };
}

/** An operation's area when its program names none: the first segment of its name. */
export function firstSegment(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}
