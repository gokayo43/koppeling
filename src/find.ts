import type { Operation } from "./catalogue";
import { isJsonArray, isJsonObject, type JsonSchema } from "./json";

/** The most operations one `find` answers. */
export const FIND_LIMIT = 10;

/**
 * Words that say nothing about which operation is meant, in the two languages
 * a person here asks in. Without them "welke bestellingen moeten nog" would
 * rank on "moeten" as much as on "bestellingen".
 */
const STOPWORDS = new Set(
  (
    "de het een en of van voor op in naar met aan bij uit om over tot als dat die dit deze wat welk welke " +
    "wie waar hoe hoeveel hebben heeft hebt is zijn was moet moeten mag kan kunnen worden wordt nog al " +
    "er we wij ik je jij u ons onze mijn alle alles niet geen ook maar dan ander andere " +
    "staan staat ligt liggen gaat gaan komt komen wil willen graag even nu " +
    "the a an and or of for on in to with at by from as that this these those what which who where how " +
    "many much is are was be been has have do does can should must all any not no"
  ).split(" "),
);

/** How much a word found in each field counts; the name and the description say the most. */
const WEIGHTS = { name: 3, description: 2, area: 2, input: 1 } as const;
type Field = keyof typeof WEIGHTS;
const FIELDS: readonly Field[] = ["name", "description", "area", "input"];

/** The shortest stem a prefix match may take, so "in" does not match "inventory". */
const MIN_PREFIX = 4;

/** The shortest shared start that makes two words cousins. */
const COGNATE_PREFIX = 5;

/**
 * The words of a text: split on anything but letters and digits and at
 * camelCase humps, lower-cased, stopwords dropped, each reduced to a stem.
 */
export function stems(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !STOPWORDS.has(word))
    .map(stem);
}

/**
 * A light stem for Dutch and English: the past participle's "ge-" and the
 * plural, tense and inflection endings go, so "gepickt" meets "picked",
 * "getelde" meets "tel", "bestellingen" meets "bestelling" and "leveranciers"
 * meets "leverancier".
 */
function stem(word: string): string {
  let base = word.length >= 6 && word.startsWith("ge") ? word.slice(2) : word;
  for (const ending of ["ingen", "en", "es", "ed", "de", "te", "s", "t", "d", "e"]) {
    if (base.endsWith(ending) && base.length - ending.length >= 3) {
      base =
        ending === "ingen" ? `${base.slice(0, -ending.length)}ing` : base.slice(0, -ending.length);
      break;
    }
  }
  return base;
}

/**
 * How well a query stem meets an operation's stem: the same; one a prefix of
 * the other; one inside the other (a Dutch compound such as "verzendlabel");
 * or the two sharing most of the shorter one's start, which is how a Dutch
 * word meets its English cousin ("locatie" and "location").
 */
function closeness(query: string, word: string): number {
  if (query === word) return 1;
  const [short, long] = query.length <= word.length ? [query, word] : [word, query];
  if (short.length < MIN_PREFIX) return 0;
  if (long.startsWith(short)) return 0.6;
  if (long.includes(short)) return 0.4;
  let shared = 0;
  while (shared < short.length && short[shared] === long[shared]) shared += 1;
  return shared >= COGNATE_PREFIX && shared >= short.length * 0.7 ? 0.4 : 0;
}

type Index = { readonly [F in Field]: readonly string[] };

function indexOf(operation: Operation<never>): Index {
  const leaf = operation.name.slice(operation.area.length);
  return {
    name: stems(leaf),
    area: stems(operation.area),
    description: stems(operation.description ?? ""),
    input: stems(fieldNames(operation.input).join(" ")),
  };
}

/** The property names of a schema, two levels deep, through allOf and anyOf. */
function fieldNames(schema: JsonSchema, depth = 0): string[] {
  if (depth > 2) return [];
  const properties = schema["properties"];
  const own = isJsonObject(properties) ? Object.entries(properties) : [];
  const nested = own.flatMap(([, child]) =>
    isJsonObject(child) ? fieldNames(child, depth + 1) : [],
  );
  const combined = [schema["allOf"], schema["anyOf"]].flatMap((list) =>
    isJsonArray(list)
      ? list.flatMap((part) => (isJsonObject(part) ? fieldNames(part, depth) : []))
      : [],
  );
  return [...own.map(([name]) => name), ...nested, ...combined];
}

/**
 * The operations whose words best meet `words`, best first, at most
 * {@link FIND_LIMIT}, and none that meets none of them. A word counts in each
 * field it meets, by that field's weight and by how rare its match is among the
 * operations, so a word every operation carries ranks nothing.
 */
export function find<Actor>(
  operations: readonly Operation<Actor>[],
  words: string,
): Operation<Actor>[] {
  const query = [...new Set(stems(words))];
  const indexed = operations.map((operation) => ({ operation, index: indexOf(operation) }));
  const rarities = new Map<string, number>();
  const rarity = (word: string) => {
    const known = rarities.get(word);
    if (known !== undefined) return known;
    const carrying = indexed.filter(({ index }) =>
      FIELDS.some((field) => index[field].includes(word)),
    ).length;
    const computed = Math.log(1 + operations.length / Math.max(carrying, 1));
    rarities.set(word, computed);
    return computed;
  };
  const scored = indexed.map(({ operation, index }) => {
    let score = 0;
    for (const word of query) {
      for (const field of FIELDS) {
        let best = 0;
        for (const candidate of index[field]) {
          best = Math.max(best, WEIGHTS[field] * closeness(word, candidate) * rarity(candidate));
        }
        score += best;
      }
    }
    return { operation, score };
  });
  return scored
    .filter(({ score }) => score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score || (left.operation.name < right.operation.name ? -1 : 1),
    )
    .slice(0, FIND_LIMIT)
    .map(({ operation }) => operation);
}
