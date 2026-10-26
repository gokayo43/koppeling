import { Effect } from "effect";

import { refusal, type Answer } from "./answer";
import { copy } from "./copy";
import { isJsonArray, type Json } from "./json";

/**
 * The most characters one answer carries: Claude Code sets a tool result
 * above about 50 000 characters aside instead of reading it (measured in the
 * API door's probe), and a page leaves room for the line that follows it.
 */
export const PAGE_SIZE = 40_000;

/** How long the door keeps a long answer for its next pages. */
const KEPT_MS = 10 * 60_000;

/**
 * The most characters the door keeps, over every person's long answers
 * together: about 40 MB as JavaScript holds text. An answer longer than this
 * is never kept, so each of its pages runs its read again.
 */
const KEPT_CHARACTERS = 20_000_000;

/**
 * The long answers of one door, kept so that each page comes from one run of
 * the program. Each is held under a key naming the person, the tool, the
 * operation, its input and the answer's own fingerprint, so one person's
 * continuation never reads another person's answer.
 */
export class Pages {
  readonly #kept = new Map<string, { readonly text: string; readonly until: number }>();
  #characters = 0;

  get(key: string): string | undefined {
    this.#expire();
    return this.#kept.get(key)?.text;
  }

  keep(key: string, text: string): void {
    this.#expire();
    if (text.length > KEPT_CHARACTERS || this.#kept.has(key)) return;
    for (const [oldest, { text: held }] of this.#kept) {
      if (this.#characters + text.length <= KEPT_CHARACTERS) break;
      this.#kept.delete(oldest);
      this.#characters -= held.length;
    }
    this.#kept.set(key, { text, until: Date.now() + KEPT_MS });
    this.#characters += text.length;
  }

  #expire(): void {
    const now = Date.now();
    for (const [key, { text, until }] of this.#kept) {
      if (until > now) break;
      this.#kept.delete(key);
      this.#characters -= text.length;
    }
  }
}

/** What a tool produced for one call: a text to answer whole or in pages, or a final answer. */
export type Produced =
  | {
      /** The whole answer as text, paged when it is longer than a page. */
      readonly whole: string;
      /** What the tool answers when it fits on one page. */
      readonly fitting: Answer;
    }
  | { readonly final: Answer };

/** The key of one call's long answer: the person, the tool, the operation and its arguments. */
export function pageKey(sub: string, tool: string, name: string, args: Json | undefined): string {
  return JSON.stringify([sub, tool, name, canonical(args)]);
}

/**
 * One call's answer, paged: without `vervolg` the first page of what
 * `produce` makes, with it the page it names, from the answer the door kept,
 * or, once the door no longer keeps it, from a new run, whose answer must be
 * the same text: where the data changed in between, the door says so and
 * answers the new answer's first page, since pages of two answers put
 * together would be neither.
 */
export function paged(
  pages: Pages,
  key: string,
  vervolg: string | undefined,
  produce: Effect.Effect<Produced>,
): Effect.Effect<Answer> {
  if (vervolg === undefined) {
    return Effect.flatMap(produce, (made) => firstOf(pages, key, made, false));
  }
  const token = /^([A-Za-z0-9_-]{22})\.([1-9]\d{0,5})$/.exec(vervolg);
  const [, print, number] = token ?? [];
  if (print === undefined || number === undefined) {
    return Effect.succeed(refusal(copy.badContinuation));
  }
  const page = Number(number);
  const held = pages.get(`${key}${print}`);
  if (held !== undefined) return Effect.succeed(pageOf(held, print, page));
  return Effect.gen(function* () {
    const made = yield* produce;
    if ("final" in made) return made.final;
    if ((yield* fingerprint(made.whole)) !== print) return yield* firstOf(pages, key, made, true);
    pages.keep(`${key}${print}`, made.whole);
    return pageOf(made.whole, print, page);
  });
}

function firstOf(
  pages: Pages,
  key: string,
  made: Produced,
  changed: boolean,
): Effect.Effect<Answer> {
  if ("final" in made) return Effect.succeed(made.final);
  if (made.whole.length <= PAGE_SIZE && !changed) return Effect.succeed(made.fitting);
  return Effect.map(fingerprint(made.whole), (print) => {
    pages.keep(`${key}${print}`, made.whole);
    const first = pageOf(made.whole, print, 1);
    return changed ? { ...first, note: `${copy.answerChanged} ${first.note ?? ""}` } : first;
  });
}

/** Page `page` of `whole`, with the line that says which it is and how to ask for the next. */
function pageOf(whole: string, print: string, page: number): Answer {
  const starts = pageStarts(whole);
  const start = starts[page - 1];
  if (start === undefined) return refusal(copy.badContinuation);
  const text = whole.slice(start, starts[page] ?? whole.length);
  const last = page === starts.length;
  return {
    text,
    note: last
      ? copy.lastPage(starts.length)
      : copy.nextPage(page, starts.length, `${print}.${page + 1}`),
  };
}

/**
 * Where each page of `whole` starts: every {@link PAGE_SIZE} characters, or
 * one earlier where that would split a character outside the Basic
 * Multilingual Plane in two (its two UTF-16 halves on two pages).
 */
function pageStarts(whole: string): number[] {
  const starts = [0];
  let at = 0;
  while (at + PAGE_SIZE < whole.length) {
    let end = at + PAGE_SIZE;
    const before = whole.charCodeAt(end - 1);
    if (before >= 0xd800 && before <= 0xdbff) end -= 1;
    starts.push(end);
    at = end;
  }
  return starts;
}

/**
 * A short fingerprint of an answer's text, to tell whether a new run answered
 * the same: 22 base64url characters (132 bits) of its SHA-256, through Web
 * Crypto, since the bundle imports no runtime built-in.
 */
function fingerprint(text: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return btoa(String.fromCharCode(...digest))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .slice(0, 22);
  });
}

/** JSON with every object's keys in order, so the same input always makes the same key. */
function canonical(value: Json | undefined): Json | null {
  if (value === undefined || value === null || typeof value !== "object") return value ?? null;
  if (isJsonArray(value)) return value.map((item) => canonical(item));
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}
