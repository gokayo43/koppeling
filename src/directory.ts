import type { Catalogue, Operation } from "./catalogue";
import { copy } from "./copy";
import { searchIndex, type SearchIndex } from "./find";

/** How many of an area's operation names its one line carries. */
const AREA_LINE_NAMES = 10;

interface Area<Actor> {
  readonly name: string;
  readonly summary: string;
  readonly operations: readonly Operation<Actor>[];
}

/** A catalogue as the tools read it, built once: by area, by name, and for `find`. */
export interface Directory<Actor> {
  readonly operations: readonly Operation<Actor>[];
  readonly areas: ReadonlyMap<string, Area<Actor>>;
  readonly byName: ReadonlyMap<string, Operation<Actor>>;
  readonly search: SearchIndex<Actor>;
}

/** An operation's name without its area, where the name starts with it. */
function leafOf(operation: Operation<never>): string {
  const { name, area } = operation;
  return name.startsWith(`${area}.`) ? name.slice(area.length + 1) : name;
}

export function toDirectory<Actor>(catalogue: Catalogue<Actor>): Directory<Actor> {
  const leaves = catalogue.operations.map((operation) => ({ operation, leaf: leafOf(operation) }));
  const grouped = new Map<string, { operation: Operation<Actor>; leaf: string }[]>();
  for (const entry of leaves) {
    grouped.set(entry.operation.area, [...(grouped.get(entry.operation.area) ?? []), entry]);
  }
  const areas = new Map(
    Array.from(grouped, ([name, entries]) => [
      name,
      {
        name,
        summary: summaryOf(entries.map(({ leaf }) => leaf)),
        operations: entries.map(({ operation }) => operation),
      },
    ]),
  );
  return {
    operations: catalogue.operations,
    areas,
    byName: new Map(catalogue.operations.map((operation) => [operation.name, operation])),
    search: searchIndex(leaves),
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
