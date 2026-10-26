import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Effect } from "effect";

import type { Operation } from "./catalogue";
import { copy } from "./copy";
import type { Directory } from "./directory";
import { find, FIND_MAX_LENGTH, FIND_MAX_WORDS, stems } from "./find";
import type { Json, JsonObject } from "./json";
import { call, refusal, unknownOperation, type Answer, type Session } from "./run";

const answer = (structured: JsonObject): Answer => ({
  text: JSON.stringify(structured),
  structured,
});

function summaryLine(operation: Operation<never>): string | null {
  return operation.description?.split("\n", 1)[0] ?? null;
}

function list(directory: Directory<never>, area: string | undefined): Answer {
  if (area === undefined) {
    return answer({
      areas: Array.from(directory.areas.values(), (entry) => ({
        name: entry.name,
        summary: entry.summary,
        operations: entry.operations.length,
      })),
    });
  }
  const entry = directory.areas.get(area);
  if (entry === undefined) return refusal(copy.unknownArea(area, [...directory.areas.keys()]));
  return answer({
    area: entry.name,
    operations: entry.operations.map((operation) => ({
      name: operation.name,
      kind: operation.kind,
      summary: summaryLine(operation),
    })),
  });
}

/** A description's line that starts with `Gevolg:` states what the operation changes. */
const SIDE_EFFECT = /^Gevolg:\s*(.+)$/m;

function describe(directory: Directory<never>, name: string): Answer {
  const operation = directory.byName.get(name);
  if (operation === undefined) return unknownOperation(directory, name);
  return answer({
    name: operation.name,
    area: operation.area,
    kind: operation.kind,
    description: operation.description ?? null,
    sideEffect: operation.description?.match(SIDE_EFFECT)?.[1] ?? null,
    input: operation.input,
    output: operation.output ?? null,
  });
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
    operations: found.map((operation) => ({
      name: operation.name,
      area: operation.area,
      kind: operation.kind,
      summary: summaryLine(operation),
    })),
  });
}

function result(answered: Answer): CallToolResult {
  return {
    content: [{ type: "text", text: answered.text }],
    ...(answered.structured === undefined ? {} : { structuredContent: answered.structured }),
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
  describe: fromJsonSchema<{ name: string }>({
    type: "object",
    properties: { name: text(copy.tools.describe.name) },
    required: ["name"],
    additionalProperties: false,
  }),
  run: fromJsonSchema<{ name: string; input?: Json }>({
    type: "object",
    properties: { name: text(copy.tools.run.name), input: { description: copy.tools.run.input } },
    required: ["name"],
    additionalProperties: false,
  }),
};

interface Handlers {
  readonly list: (area: string | undefined) => Answer;
  readonly find: (words: string) => Answer;
  readonly describe: (name: string) => Answer;
  readonly read: (name: string, input: Json | undefined) => Promise<Answer>;
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
    ({ name }) => result(handlers.describe(name)),
  );
  server.registerTool(
    "read",
    { ...tools.read, inputSchema: SCHEMAS.run, annotations: { readOnlyHint: true } },
    async ({ name, input }) => result(await handlers.read(name, input)),
  );
  server.registerTool(
    "write",
    {
      ...tools.write,
      inputSchema: SCHEMAS.run,
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
    describe: (name) => describe(directory, name),
    read: (name, input) => Effect.runPromise(call(session, "read", name, input)),
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
    describe: refused,
    read: async () => refused(),
    write: async () => refused(),
  });
}
