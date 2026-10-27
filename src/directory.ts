import type { Catalogue, Operation } from "./catalogue";
import { scopeTokens } from "./challenge";
import { copy } from "./copy";
import type { Admission } from "./door";
import { searchIndex, type SearchIndex } from "./find";

/** How many of an area's operation names its one line carries. */
const AREA_LINE_NAMES = 10;

interface Area<Actor> {
  readonly name: string;
  readonly summary: string;
  readonly operations: readonly Operation<Actor>[];
}

/** An operation as one person meets it: with the scope tokens their login must carry to run it. */
export interface Offered<Actor> {
  readonly operation: Operation<Actor>;
  /** Empty for an operation the person may run now. */
  readonly awaits: readonly string[];
}

/** A catalogue as the tools read it, built once: by area, by name, and for `find`. */
export interface Directory<Actor> {
  readonly operations: readonly Operation<Actor>[];
  readonly areas: ReadonlyMap<string, Area<Actor>>;
  readonly byName: ReadonlyMap<string, Offered<Actor>>;
  readonly search: SearchIndex<Actor>;
}

/** An operation's name without its area, where the name starts with it. */
function leafOf(operation: Operation<never>): string {
  const { name, area } = operation;
  return name.startsWith(`${area}.`) ? name.slice(area.length + 1) : name;
}

export function toDirectory<Actor>(catalogue: Catalogue<Actor>): Directory<Actor> {
  const { operations } = catalogue;
  return assembled(
    operations.map((operation) => ({ operation, awaits: [] })),
    searchIndex(operations.map((operation) => ({ operation, leaf: leafOf(operation) }))),
  );
}

/**
 * The part of `directory` one person may use: the operations `allows`
 * admits, by area, by name and for `find`, each with the scope tokens it
 * awaits. An answer that is not exactly `true`, `false` or `{ scope }` with a
 * valid scope throws, naming the operation: a lookup missing its key, or a
 * falsy stand-in for `false`, would otherwise offer and run it. The search
 * keeps the whole catalogue's word counts, so a word's rarity, and with it the
 * ranking, is the same for everyone; no operation outside the part is named
 * by it.
 */
export function admitted<Actor>(
  directory: Directory<Actor>,
  allows: (operation: Operation<Actor>) => Admission,
): Directory<Actor> {
  const kept: Offered<Actor>[] = [];
  for (const operation of directory.operations) {
    const admission: unknown = allows(operation);
    if (admission === false) continue;
    if (admission === true) {
      kept.push({ operation, awaits: [] });
      continue;
    }
    const owner = `allows for "${operation.name}"`;
    const scope =
      typeof admission === "object" && admission !== null && "scope" in admission
        ? admission.scope
        : undefined;
    if (typeof scope !== "string") {
      throw new Error(`${owner} answered neither true, false nor { scope } with a scope string`);
    }
    kept.push({ operation, awaits: scopeTokens(scope, owner) });
  }
  const keep = new Set(kept.map(({ operation }) => operation));
  return assembled(kept, {
    entries: directory.search.entries.filter(({ operation }) => keep.has(operation)),
    carrying: directory.search.carrying,
  });
}

function assembled<Actor>(
  offered: readonly Offered<Actor>[],
  search: SearchIndex<Actor>,
): Directory<Actor> {
  const operations = offered.map(({ operation }) => operation);
  const grouped = new Map<string, Operation<Actor>[]>();
  for (const operation of operations) {
    grouped.set(operation.area, [...(grouped.get(operation.area) ?? []), operation]);
  }
  const areas = new Map(
    Array.from(grouped, ([name, members]) => [
      name,
      { name, summary: summaryOf(members.map(leafOf)), operations: members },
    ]),
  );
  return {
    operations,
    areas,
    byName: new Map(offered.map((entry) => [entry.operation.name, entry])),
    search,
  };
}

/** An area's one line: the names of its operations, the area left off. */
function summaryOf(leaves: readonly string[]): string {
  const shown = leaves.slice(0, AREA_LINE_NAMES).join(", ");
  const rest = leaves.length - AREA_LINE_NAMES;
  return rest > 0 ? `${shown} en ${rest} meer` : shown;
}

/** The server's instructions: the host's glossary, then the outline of every area. */
export function instructionsFor(glossary: string, directory: Directory<never>): string {
  const outline = copy.outline(
    Array.from(directory.areas.values(), (area) =>
      copy.areaLine(area.name, area.operations.length, area.summary),
    ),
  );
  return [glossary.trim(), outline].filter(Boolean).join("\n\n");
}

/**
 * The names a person most likely meant by a name no operation has: those that
 * share its longest dotted start, or none when not even its first segment is
 * any operation's.
 */
export function neighbours(directory: Directory<never>, name: string): string[] {
  const segments = name.split(".");
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const start = `${segments.slice(0, length).join(".")}.`;
    const near = directory.operations.filter((operation) => operation.name.startsWith(start));
    if (near.length > 0) return near.map((operation) => operation.name);
  }
  return [];
}
