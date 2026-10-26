import type { Operation } from "./catalogue";
import type { JsonSchema } from "./json";
import { properties } from "./schema";

/** The most operations one `find` answers. */
export const FIND_LIMIT = 10;

/**
 * The longest phrasing and the most distinct words one `find` takes: a
 * phrasing is a sentence, and scoring costs words times operations.
 */
export const FIND_MAX_LENGTH = 200;
export const FIND_MAX_WORDS = 20;

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

/**
 * What each word counts once more when the words name an area or a leaf
 * whole: an exact name ranks above the same word met inside another name
 * ("stock" inside "restock"), however rare that other word is.
 */
const WHOLE_WEIGHT = WEIGHTS.name;

/** The shortest stem a prefix match may take, so "in" does not match "inventory". */
const MIN_PREFIX = 4;

/** The shortest shared start that makes two words cousins. */
const COGNATE_PREFIX = 5;

/** The words of a text: split on anything but letters and digits and at camelCase humps, lower-cased. */
export function wordsOf(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words of a text that say something, stopwords dropped, each reduced to a stem. */
export function stems(text: string): string[] {
  return wordsOf(text)
    .filter((word) => !STOPWORDS.has(word))
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

type Words = { readonly [F in Field]: readonly string[] };

/**
 * A catalogue's operations as `find` searches them, built once: each
 * operation's words per field, and how many operations carry each word.
 */
export interface SearchIndex<Actor> {
  readonly entries: readonly { readonly operation: Operation<Actor>; readonly words: Words }[];
  readonly carrying: ReadonlyMap<string, number>;
}

/** The index of `operations`, each searched by its name without its area (`leaf`). */
export function searchIndex<Actor>(
  operations: readonly { readonly operation: Operation<Actor>; readonly leaf: string }[],
): SearchIndex<Actor> {
  const entries = operations.map(({ operation, leaf }) => ({
    operation,
    words: {
      name: stems(leaf),
      area: stems(operation.area),
      description: operation.written ? stems(operation.description) : [],
      input: stems(fieldNames(operation.input).join(" ")),
    },
  }));
  const carrying = new Map<string, number>();
  for (const { words } of entries) {
    for (const word of new Set(FIELDS.flatMap((field) => words[field]))) {
      carrying.set(word, (carrying.get(word) ?? 0) + 1);
    }
  }
  return { entries, carrying };
}

/** The property names of a schema, two levels deep, through its combinations. */
function fieldNames(schema: JsonSchema, depth = 0): string[] {
  if (depth > 2) return [];
  const own = properties(schema);
  return [
    ...own.map(([name]) => name),
    ...own.flatMap(([, child]) => fieldNames(child, depth + 1)),
  ];
}

/**
 * The asked words that name an operation's area or its leaf whole, every word
 * of it asked: "stock" names the area "stock", and "product categories list"
 * the area "product-categories", while it only shares "categories" with
 * "admin.products.categories.get".
 */
function namedWhole(own: Words, asked: ReadonlySet<string>): Set<string> {
  const named = new Set<string>();
  for (const words of [own.area, own.name]) {
    if (words.length > 0 && words.every((word) => asked.has(word))) {
      for (const word of words) named.add(word);
    }
  }
  return named;
}

/**
 * The operations whose words best meet `words`, best first, at most
 * {@link FIND_LIMIT}, and none that meets none of them. A word counts in each
 * field it meets, by that field's weight and by how rare its match is among the
 * operations, so a word every operation carries ranks nothing; and once more
 * where it helps name an area or a leaf whole.
 */
export function find<Actor>(index: SearchIndex<Actor>, words: string): Operation<Actor>[] {
  const query = [...new Set(stems(words))];
  const rarity = (word: string) =>
    Math.log(1 + index.entries.length / Math.max(index.carrying.get(word) ?? 0, 1));
  const asked = new Set(query);
  const scored = index.entries.map(({ operation, words: own }) => {
    let score = 0;
    for (const word of query) {
      for (const field of FIELDS) {
        let best = 0;
        for (const candidate of own[field]) {
          best = Math.max(best, WEIGHTS[field] * closeness(word, candidate) * rarity(candidate));
        }
        score += best;
      }
    }
    for (const word of namedWhole(own, asked)) score += WHOLE_WEIGHT * rarity(word);
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
