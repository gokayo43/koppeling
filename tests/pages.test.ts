import { expect, setSystemTime, test } from "bun:test";

import type { Client } from "@modelcontextprotocol/client";
import { Effect } from "effect";

import { catalogue, type Kind } from "../src/catalogue";
import { copy } from "../src/copy";
import { toDirectory } from "../src/directory";
import type { Json } from "../src/json";
import { PAGE_SIZE, pageKey, paged, Pages, type Produced } from "../src/pages";
import { connected } from "./support/session";

type Called = Awaited<ReturnType<Client["callTool"]>>;
const blocks = (result: Called) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

/**
 * A long answer of invented rows: about 300 000 characters of JSON, with
 * accents and characters outside the Basic Multilingual Plane, so a page that
 * ended inside a surrogate pair would split a character in two.
 */
function longAnswer(edition: number): Json {
  return Array.from({ length: 2400 }, (_, index) => ({
    id: index,
    edition,
    name: `Remschijf ${index} voor één model 🚗 met een omschrijving die lang genoeg is`,
    tags: ["voorrem", "achterrem", `maat-${index % 40}`],
  }));
}

/** A door over one long read, one long write and one operation whose output schema is long. */
function longDoor() {
  const ran: string[] = [];
  const state = { edition: 1 };
  const operation = (name: string, kind: Kind, value: () => Json) => ({
    name,
    area: "catalog",
    kind,
    description: `${name}.`,
    written: true,
    destructive: false,
    idempotent: kind === "read",
    input: { schema: { type: "object", properties: { limit: { type: "integer" } } } },
    output: {
      schema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: name === "catalog.schema" ? 4000 : 1 }, (_, index) => [
            `field${index}`,
            { type: "string", description: `Veld ${index} van het antwoord.` },
          ]),
        ),
      },
    },
    run: async () => {
      ran.push(name);
      return { value: value() };
    },
  });
  const directory = toDirectory(
    catalogue(
      [
        operation("catalog.all", "read", () => longAnswer(state.edition)),
        operation("catalog.import", "write", () => longAnswer(state.edition)),
        operation("catalog.schema", "read", () => null),
      ],
      [],
    ),
  );
  return { directory, ran, state };
}

/** Reads every page of one answer through `tool`, following each page's continuation. */
async function readAll(client: Client, tool: string, args: { [key: string]: Json }) {
  const pages: string[] = [];
  let next: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const result = await client.callTool({
      name: tool,
      arguments: next === undefined ? args : { ...args, vervolg: next },
    });
    expect(result.isError).toBeFalsy();
    const [page, note] = blocks(result);
    pages.push(page ?? "");
    next = note?.match(/vervolg "([^"]+)"/)?.[1];
    if (next === undefined) return { pages, last: note };
  }
  throw new Error("no last page");
}

test("an answer longer than a page is read whole across pages, byte for byte, from one run", async () => {
  // The likeliest wrong cuts the answer at the page size, or slices the
  // program's answer again for every page, from a fresh run.
  const { directory, ran } = longDoor();
  await using door = await connected(directory, null);
  const { pages, last } = await readAll(door.client, "read", { name: "catalog.all", input: {} });
  const whole = JSON.stringify(longAnswer(1));

  expect(whole.length).toBeGreaterThan(290_000);
  expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(whole.length / PAGE_SIZE));
  for (const page of pages) expect(page.length).toBeLessThanOrEqual(PAGE_SIZE);
  expect(pages.join("")).toBe(whole);
  for (const page of pages) expect(page).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  expect(last).toBe(copy.lastPage(pages.length));
  expect(ran).toEqual(["catalog.all"]);
});

test("a continuation the door no longer holds runs the read again and still answers the right page", async () => {
  const { directory, ran } = longDoor();
  await using door = await connected(directory, null);
  const first = await door.client.callTool({
    name: "read",
    arguments: { name: "catalog.all", input: {} },
  });
  const token = blocks(first)[1]?.match(/vervolg "([^"]+)"/)?.[1] ?? "";
  setSystemTime(new Date(Date.now() + 11 * 60_000));
  try {
    const rest = await readAll(door.client, "read", {
      name: "catalog.all",
      input: {},
      vervolg: token,
    });
    expect([blocks(first)[0], ...rest.pages].join("")).toBe(JSON.stringify(longAnswer(1)));
  } finally {
    setSystemTime();
  }
  expect(ran).toEqual(["catalog.all", "catalog.all"]);
});

test("when the data changed before a re-run, the door says so and starts the new answer over", async () => {
  // Pages of two different answers put together would be neither.
  const { directory, state } = longDoor();
  await using door = await connected(directory, null);
  const first = await door.client.callTool({
    name: "read",
    arguments: { name: "catalog.all", input: {} },
  });
  const token = blocks(first)[1]?.match(/vervolg "([^"]+)"/)?.[1] ?? "";
  state.edition = 2;
  setSystemTime(new Date(Date.now() + 11 * 60_000));
  try {
    const again = await door.client.callTool({
      name: "read",
      arguments: { name: "catalog.all", input: {}, vervolg: token },
    });
    const [page, note] = blocks(again);
    expect(page).toBe(JSON.stringify(longAnswer(2)).slice(0, page?.length));
    expect(note).toStartWith(copy.answerChanged);
  } finally {
    setSystemTime();
  }
});

test("a continuation that is no token of this read is refused, and runs nothing", async () => {
  const { directory, ran } = longDoor();
  await using door = await connected(directory, null);
  const refused = await door.client.callTool({
    name: "read",
    arguments: { name: "catalog.all", input: {}, vervolg: "verzonnen" },
  });

  expect(refused.isError).toBe(true);
  expect(blocks(refused).join("")).toBe(copy.badContinuation);
  expect(ran).toEqual([]);
});

test("a write's answer over the page size comes back whole, and the write runs once", async () => {
  const { directory, ran } = longDoor();
  await using door = await connected(directory, null);
  const written = await door.client.callTool({
    name: "write",
    arguments: { name: "catalog.import", input: {} },
  });

  expect(blocks(written)).toEqual([JSON.stringify(longAnswer(1))]);
  expect(written.structuredContent).toBeUndefined();
  expect(ran).toEqual(["catalog.import"]);
});

test("describe answers the input whole and a long output schema by its length, and part output answers it whole across pages", async () => {
  // The probe saw a describe of 203 000 characters, its output schema inlined.
  const { directory } = longDoor();
  await using door = await connected(directory, null);
  const described = await door.client.callTool({
    name: "describe",
    arguments: { name: "catalog.schema" },
  });
  const output = directory.byName.get("catalog.schema")?.output;
  const outputText = JSON.stringify(output);

  expect(blocks(described).join("").length).toBeLessThan(PAGE_SIZE);
  expect(described.structuredContent).toMatchObject({
    input: { properties: { limit: { type: "integer" } } },
    output: null,
    outputOmitted: copy.outputOmitted(outputText.length),
    paging: ["limit"],
  });
  const { pages } = await readAll(door.client, "describe", {
    name: "catalog.schema",
    part: "output",
  });
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("")).toBe(outputText);

  const small = await door.client.callTool({
    name: "describe",
    arguments: { name: "catalog.all" },
  });
  expect(small.structuredContent).toMatchObject({ output: { type: "object" } });
});

test("one person's continuation never reads another's kept answer: it runs the read as them", async () => {
  // The likeliest wrong keys the kept answer by its fingerprint alone, so a
  // token seen in someone else's transcript reads their answer.
  const pages = new Pages();
  const runs: string[] = [];
  const produce = (person: string) =>
    Effect.sync((): Produced => {
      runs.push(person);
      const whole = JSON.stringify(longAnswer(person === "a" ? 1 : 2));
      return { whole, fitting: { text: whole } };
    });
  const first = await Effect.runPromise(
    paged(pages, pageKey("a", "read", "catalog.all", {}), undefined, produce("a")),
  );
  const token = first.note?.match(/vervolg "([^"]+)"/)?.[1];
  const other = await Effect.runPromise(
    paged(pages, pageKey("b", "read", "catalog.all", {}), token, produce("b")),
  );

  expect(runs).toEqual(["a", "b"]);
  expect(other.note).toStartWith(copy.answerChanged);
  expect(other.text).toBe(JSON.stringify(longAnswer(2)).slice(0, other.text.length));
});

test("the kept answers stay within their bound: the oldest goes first, and one past the bound is never kept", () => {
  const pages = new Pages();
  const eight = "x".repeat(8_000_000);
  pages.keep("first", eight);
  pages.keep("second", eight);
  pages.keep("third", eight);

  expect(pages.get("first")).toBeUndefined();
  expect(pages.get("second")).toBe(eight);
  expect(pages.get("third")).toBe(eight);
  pages.keep("huge", "x".repeat(20_000_001));
  expect(pages.get("huge")).toBeUndefined();
  expect(pages.get("third")).toBe(eight);
});

test("an answer carries its value as structured content only under a quarter of a page, and as text alone above", async () => {
  // Sent as both, a 39 000-character answer reached the agent as 78 000.
  const sized = (name: string, length: number) => ({
    name,
    area: "sizes",
    kind: "read" as const,
    description: `${name}.`,
    written: true,
    destructive: false,
    idempotent: true,
    input: { schema: { type: "object", properties: {} } },
    output: undefined,
    run: async () => ({ value: "x".repeat(length - 2) }),
  });
  const quarter = PAGE_SIZE / 4;
  const directory = toDirectory(
    catalogue([sized("sizes.under", quarter - 1), sized("sizes.at", quarter)], []),
  );
  await using door = await connected(directory, null);
  const under = await door.client.callTool({ name: "read", arguments: { name: "sizes.under" } });
  const at = await door.client.callTool({ name: "read", arguments: { name: "sizes.at" } });

  expect(blocks(under).join("").length).toBe(quarter - 1);
  expect(under.structuredContent).toEqual({ result: "x".repeat(quarter - 3) });
  expect(blocks(at)).toEqual([JSON.stringify("x".repeat(quarter - 2))]);
  expect(at.structuredContent).toBeUndefined();
});
