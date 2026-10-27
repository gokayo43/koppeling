import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Effect } from "effect";

import { refusal, type Answer } from "./answer";
import type { Operation } from "./catalogue";
import { copy } from "./copy";
import type { Directory, Offered } from "./directory";
import { find, FIND_MAX_LENGTH, FIND_MAX_WORDS, stems } from "./find";
import type { Json, JsonObject, JsonSchema } from "./json";
import { PAGE_SIZE, pageKey, paged, type Produced } from "./pages";
import { call, unknownOperation, type Session } from "./run";
import { properties } from "./schema";

const answer = (structured: JsonObject): Answer => ({
  text: JSON.stringify(structured),
  structured,
});

/**
 * One operation as `list` and `find` show it: a write with its hints, since a
 * read changes nothing whichever way they read.
 */
function entry(operation: Operation<never>) {
  const { name, kind, destructive, idempotent, description } = operation;
  return {
    name,
    kind,
    ...(kind === "write" ? { destructive, idempotent } : {}),
    summary: description.split("\n", 1)[0] ?? "",
  };
}

function list(directory: Directory<never>, area: string | undefined): Answer {
  if (area === undefined) {
    return answer({
      areas: Array.from(directory.areas.values(), (each) => ({
        name: each.name,
        summary: each.summary,
        operations: each.operations.length,
      })),
    });
  }
  const found = directory.areas.get(area);
  if (found === undefined) return refusal(copy.unknownArea(area, [...directory.areas.keys()]));
  return answer({
    area: found.name,
    operations: found.operations.map(entry),
  });
}

/** A description's line that starts with `Gevolg:` states what the operation changes. */
const SIDE_EFFECT = /^Gevolg:\s*(.+)$/m;

/**
 * The longest output schema `describe` carries in the whole operation; a
 * longer one is named by its length and answered on its own with `part:
 * "output"`. The probe saw a describe of 203 000 characters, nearly all of it
 * an inlined output schema.
 */
const OUTPUT_BOUND = 10_000;

/** The names a program's own paging fields go by. */
const PAGING = new Set([
  "limit",
  "offset",
  "page",
  "pageSize",
  "page_size",
  "perPage",
  "per_page",
  "cursor",
  "take",
  "skip",
]);

/** The input's own paging fields, by path: `limit`, or `query.page` one level down. */
function pagingFields(input: JsonSchema): string[] {
  const fields = properties(input).flatMap(([name, child]) => [
    ...(PAGING.has(name) ? [name] : []),
    ...properties(child).flatMap(([inner]) => (PAGING.has(inner) ? [`${name}.${inner}`] : [])),
  ]);
  return [...new Set(fields)];
}

function described({ operation, awaits }: Offered<never>, part: "output" | undefined): Produced {
  const output = operation.output ?? null;
  if (part === "output") {
    const whole = JSON.stringify(output);
    return { whole, fitting: { text: whole, structured: { output } } };
  }
  const outputText = JSON.stringify(output);
  const long = outputText.length > OUTPUT_BOUND;
  const structured: JsonObject = {
    name: operation.name,
    area: operation.area,
    kind: operation.kind,
    ...(awaits.length > 0 ? { scope: awaits.join(" ") } : {}),
    destructive: operation.destructive,
    idempotent: operation.idempotent,
    description: operation.description,
    sideEffect: operation.description.match(SIDE_EFFECT)?.[1] ?? null,
    input: operation.input,
    paging: pagingFields(operation.input),
    output: long ? null : output,
    ...(long ? { outputOmitted: copy.outputOmitted(outputText.length) } : {}),
  };
  return { whole: JSON.stringify(structured), fitting: answer(structured) };
}

function describe<Actor>(
  session: Session<Actor>,
  name: string,
  part: "output" | undefined,
  vervolg: string | undefined,
): Effect.Effect<Answer> {
  const offered = session.directory.byName.get(name);
  if (offered === undefined) return Effect.succeed(unknownOperation(session.directory, name));
  return paged(
    session.pages,
    pageKey(String(session.claims.sub), "describe", name, part ?? null),
    vervolg,
    Effect.sync(() => described(offered, part)),
  );
}

function findAnswer(directory: Directory<never>, words: string): Answer {
  if (new Set(stems(words)).size > FIND_MAX_WORDS) {
    return refusal(copy.tooManyWords(FIND_MAX_WORDS));
  }
  const found = find(directory.search, words);
  if (found.length === 0) {
    return answer({
      operations: [],
      message: copy.nothingFound(words, [...directory.areas.keys()]),
    });
  }
  return answer({
    operations: found.map((operation) => ({ ...entry(operation), area: operation.area })),
  });
}

/**
 * The longest answer whose value also goes as `structuredContent`: a quarter
 * of a page. A client may pass the model both copies, so a 39 000-character
 * answer sent twice reached it as 78 000; above this, the text alone.
 */
const STRUCTURED_BELOW = PAGE_SIZE / 4;

function result(answered: Answer): CallToolResult {
  const structured = answered.text.length < STRUCTURED_BELOW ? answered.structured : undefined;
  return {
    content: [
      { type: "text", text: answered.text },
      ...(answered.note === undefined ? [] : [{ type: "text" as const, text: answered.note }]),
    ],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(answered.isError ? { isError: true } : {}),
  };
}

const text = (description: string) => ({ type: "string", description });

/**
 * The five tools' input schemas, built once: a schema built per request is a
 * validator compiled per request, which the SDK keeps (measured: 15 KB of
 * heap per request until they moved here).
 */
const SCHEMAS = {
  list: fromJsonSchema<{ area?: string }>({
    type: "object",
    properties: { area: text(copy.tools.list.area) },
    additionalProperties: false,
  }),
  find: fromJsonSchema<{ words: string }>({
    type: "object",
    properties: { words: { ...text(copy.tools.find.words), maxLength: FIND_MAX_LENGTH } },
    required: ["words"],
    additionalProperties: false,
  }),
  describe: fromJsonSchema<{ name: string; part?: "output"; vervolg?: string }>({
    type: "object",
    properties: {
      name: text(copy.tools.describe.name),
      part: { type: "string", enum: ["output"], description: copy.tools.describe.part },
      vervolg: text(copy.tools.run.vervolg),
    },
    required: ["name"],
    additionalProperties: false,
  }),
  read: fromJsonSchema<{ name: string; input?: Json; vervolg?: string }>({
    type: "object",
    properties: {
      name: text(copy.tools.run.name),
      input: { description: copy.tools.run.input },
      vervolg: text(copy.tools.run.vervolg),
    },
    required: ["name"],
    additionalProperties: false,
  }),
  write: fromJsonSchema<{ name: string; input?: Json }>({
    type: "object",
    properties: { name: text(copy.tools.run.name), input: { description: copy.tools.run.input } },
    required: ["name"],
    additionalProperties: false,
  }),
};

interface Handlers {
  readonly list: (area: string | undefined) => Answer;
  readonly find: (words: string) => Answer;
  readonly describe: (
    name: string,
    part: "output" | undefined,
    vervolg: string | undefined,
  ) => Promise<Answer>;
  readonly read: (
    name: string,
    input: Json | undefined,
    vervolg: string | undefined,
  ) => Promise<Answer>;
  readonly write: (name: string, input: Json | undefined) => Promise<Answer>;
}

/** The five tools on one server, in the order a person works. */
function registered(instructions: string, handlers: Handlers): McpServer {
  const server = new McpServer({ name: "koppeling", version: "1" }, { instructions });
  const tools = copy.tools;
  server.registerTool(
    "list",
    { ...tools.list.labels, inputSchema: SCHEMAS.list, annotations: { readOnlyHint: true } },
    ({ area }) => result(handlers.list(area)),
  );
  server.registerTool(
    "find",
    { ...tools.find.labels, inputSchema: SCHEMAS.find, annotations: { readOnlyHint: true } },
    ({ words }) => result(handlers.find(words)),
  );
  server.registerTool(
    "describe",
    {
      ...tools.describe.labels,
      inputSchema: SCHEMAS.describe,
      annotations: { readOnlyHint: true },
    },
    async ({ name, part, vervolg }) => result(await handlers.describe(name, part, vervolg)),
  );
  server.registerTool(
    "read",
    { ...tools.read, inputSchema: SCHEMAS.read, annotations: { readOnlyHint: true } },
    async ({ name, input, vervolg }) => result(await handlers.read(name, input, vervolg)),
  );
  server.registerTool(
    "write",
    {
      ...tools.write,
      inputSchema: SCHEMAS.write,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ name, input }) => result(await handlers.write(name, input)),
  );
  return server;
}

/** The MCP server for one request as the session's person. */
export function mcpServer<Actor>(session: Session<Actor>, instructions: string): McpServer {
  const { directory } = session;
  return registered(instructions, {
    list: (area) => list(directory, area),
    find: (words) => findAnswer(directory, words),
    describe: (name, part, vervolg) => Effect.runPromise(describe(session, name, part, vervolg)),
    read: (name, input, vervolg) => Effect.runPromise(call(session, "read", name, input, vervolg)),
    write: (name, input) => Effect.runPromise(call(session, "write", name, input)),
  });
}

/**
 * The MCP server for a person the program refused: the same five tools, each
 * answering the program's sentence, which the instructions carry too, so a
 * program that shows no HTTP status still shows the person why.
 */
export function refusalServer(sentence: string): McpServer {
  const refused = () => refusal(sentence);
  return registered(sentence, {
    list: refused,
    find: refused,
    describe: async () => refused(),
    read: async () => refused(),
    write: async () => refused(),
  });
}
