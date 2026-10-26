import { closed } from "./closed";
import { copy } from "./copy";
import type { Json, JsonSchema } from "./json";
import type { Described } from "./schema";

/** `read` changes nothing; `write` changes data, so the person is asked first. */
export type Kind = "read" | "write";

/**
 * What a program answered: its value, its own refusal sentence with whatever
 * structured details it gave (a list of the values it accepts), or a failure
 * after the program was reached, when whatever it was asked to change may have
 * changed.
 */
export type Outcome =
  | { readonly value: Json }
  | { readonly refusal: string; readonly details?: Json }
  | { readonly failed: unknown };

/** One callable thing a program declares, as the door offers it. */
export interface Operation<Actor> {
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

/** An operation as an adapter derives it, before the catalogue places it. */
export type Declared<Actor> = Omit<Operation<Actor>, "input" | "output"> & {
  readonly input: Described;
  readonly output: Described | undefined;
};

/**
 * What a program may say to the door about one operation, as a tRPC
 * procedure's `meta.koppeling` or an Elysia route's `detail.koppeling`, each
 * overriding what the door would derive; `false` there withholds the
 * operation instead.
 */
export interface KoppelingMeta {
  readonly description?: string;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
}

const META_KEYS = new Set(["description", "destructive", "idempotent"]);

/**
 * A procedure's or route's `koppeling` value: `withheld` for `false`, what it
 * says otherwise. Anything but `false`, nothing or an object of the door's
 * own keys fails the boot, naming `owner`: a misspelled hint the door ignored
 * would describe the operation wrongly with nothing to say so.
 */
export function koppelingMeta(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the program's own meta, whatever it wrote there
  value: unknown,
  owner: string,
): "withheld" | KoppelingMeta {
  if (value === false) return "withheld";
  if (value === undefined) return {};
  const fail = (why: string) =>
    new Error(
      `${owner} ${why}; it is false, or an object of description (text), destructive and idempotent (true or false)`,
    );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(`is ${JSON.stringify(value)}`);
  }
  const meta: { description?: string; destructive?: boolean; idempotent?: boolean } = {};
  for (const [key, given] of Object.entries(value)) {
    if (!META_KEYS.has(key)) throw fail(`names "${key}"`);
    if (key === "description" && typeof given === "string") {
      if (given.trim()) meta.description = given.trim();
    } else if (key === "destructive" && typeof given === "boolean") meta.destructive = given;
    else if (key === "idempotent" && typeof given === "boolean") meta.idempotent = given;
    else throw fail(`gives ${key} as ${JSON.stringify(given)}`);
  }
  return meta;
}

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
      input: closed(schemaOf(operation.name, "input", operation.input)),
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
