import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Cause, Data, Effect } from "effect";
import type { JWTPayload } from "jose";

import type { Catalogue, Operation } from "./catalogue";
import { copy } from "./copy";
import { find, FIND_MAX_LENGTH, FIND_MAX_WORDS, stems } from "./find";
import type { Json, JsonObject } from "./json";

/** How many of an area's operation names its one line carries. */
const AREA_LINE_NAMES = 10;

interface Area<Actor> {
  readonly name: string;
  readonly summary: string;
  readonly operations: readonly Operation<Actor>[];
}

/** A catalogue as the four tools read it: by area and by name. */
export interface Directory<Actor> {
  readonly operations: readonly Operation<Actor>[];
  readonly areas: ReadonlyMap<string, Area<Actor>>;
  readonly byName: ReadonlyMap<string, Operation<Actor>>;
}

export function toDirectory<Actor>(catalogue: Catalogue<Actor>): Directory<Actor> {
  const grouped = new Map<string, Operation<Actor>[]>();
  for (const operation of catalogue.operations) {
    grouped.set(operation.area, [...(grouped.get(operation.area) ?? []), operation]);
  }
  const areas = new Map(
    Array.from(grouped, ([name, operations]) => [
      name,
      { name, summary: summaryOf(name, operations), operations },
    ]),
  );
  return {
    operations: catalogue.operations,
    areas,
    byName: new Map(catalogue.operations.map((operation) => [operation.name, operation])),
  };
}

/** An area's one line: the names of its operations, the area itself left off. */
function summaryOf(area: string, operations: readonly Operation<never>[]): string {
  const leaves = operations.map(({ name }) =>
    name.startsWith(`${area}.`) ? name.slice(area.length + 1) : name,
  );
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

interface Answer {
  readonly text: string;
  readonly structured?: JsonObject;
  readonly isError?: true;
}

const refusal = (text: string): Answer => ({ text, isError: true });
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

/** The refusal for a name no operation has: the canonical list to pick from. */
function unknownOperation(directory: Directory<never>, name: string): Answer {
  const area = [...directory.areas.values()].find((entry) => name.startsWith(`${entry.name}.`));
  return refusal(
    area === undefined
      ? copy.unknownOperationArea(name, [...directory.areas.keys()])
      : copy.unknownOperation(
          name,
          area.operations.map((operation) => operation.name),
        ),
  );
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
  if (new Set(stems(words)).size > FIND_MAX_WORDS)
    return refusal(copy.tooManyWords(FIND_MAX_WORDS));
  const found = find(directory.operations, words);
  if (found.length === 0)
    return answer({
      operations: [],
      message: copy.nothingFound(words, [...directory.areas.keys()]),
    });
  return answer({
    operations: found.map((operation) => ({
      name: operation.name,
      area: operation.area,
      kind: operation.kind,
      summary: summaryLine(operation),
    })),
  });
}

class OperationFailed extends Data.TaggedError("OperationFailed")<{
  readonly name: string;
  readonly cause: unknown;
}> {}

/**
 * Runs the named operation once, as `actor`. The program's refusal comes back
 * as a tool error carrying its sentence; a failure it did not mean to show is
 * logged and answered with the door's generic sentence, so a database's words
 * never reach the person.
 */
export function call<Actor>(
  directory: Directory<Actor>,
  actor: Actor,
  claims: JWTPayload,
  name: string,
  input: Json | undefined,
): Effect.Effect<Answer> {
  const operation = directory.byName.get(name);
  if (operation === undefined) return Effect.succeed(unknownOperation(directory, name));
  return Effect.tryPromise({
    try: () => operation.run(actor, input),
    catch: (cause) => new OperationFailed({ name, cause }),
  }).pipe(
    Effect.map((outcome) =>
      "refusal" in outcome
        ? { outcome: "refusal" as const, answered: refusal(outcome.refusal) }
        : {
            outcome: "value" as const,
            answered: {
              text: JSON.stringify(outcome.value),
              structured: { result: outcome.value },
            },
          },
    ),
    Effect.catchTag("OperationFailed", (failure) =>
      Effect.logError(`Operation ${failure.name} failed`, Cause.die(failure.cause)).pipe(
        Effect.as({ outcome: "failure" as const, answered: refusal(copy.internalError) }),
      ),
    ),
    Effect.tap(({ outcome }) =>
      operation.kind === "write" ? audit(name, claims, outcome) : Effect.void,
    ),
    Effect.map(({ answered }) => answered),
  );
}

/**
 * The one line every `call` of a write leaves: which operation, for whom, and
 * whether the program answered a value, refused, or failed.
 */
function audit(operation: string, claims: JWTPayload, outcome: "value" | "refusal" | "failure") {
  const name = claims["name"];
  return Effect.logInfo("koppeling write").pipe(
    Effect.annotateLogs({
      operation,
      sub: claims.sub ?? null,
      name: typeof name === "string" ? name : null,
      outcome,
    }),
  );
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
 * The MCP server for one request as `actor`: the four tools, in the order a
 * person works, and the instructions.
 */
export function mcpServer<Actor>(
  directory: Directory<Actor>,
  instructions: string,
  actor: Actor,
  claims: JWTPayload,
): McpServer {
  const server = new McpServer({ name: "koppeling", version: "1" }, { instructions });
  const tools = copy.tools;
  server.registerTool(
    "list",
    {
      title: tools.list.title,
      description: tools.list.description,
      inputSchema: fromJsonSchema<{ area?: string }>({
        type: "object",
        properties: { area: text(tools.list.area) },
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ area }) => result(list(directory, area)),
  );
  server.registerTool(
    "find",
    {
      title: tools.find.title,
      description: tools.find.description,
      inputSchema: fromJsonSchema<{ words: string }>({
        type: "object",
        properties: { words: { ...text(tools.find.words), maxLength: FIND_MAX_LENGTH } },
        required: ["words"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ words }) => result(findAnswer(directory, words)),
  );
  server.registerTool(
    "describe",
    {
      title: tools.describe.title,
      description: tools.describe.description,
      inputSchema: fromJsonSchema<{ name: string }>({
        type: "object",
        properties: { name: text(tools.describe.name) },
        required: ["name"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ name }) => result(describe(directory, name)),
  );
  server.registerTool(
    "call",
    {
      title: tools.call.title,
      description: tools.call.description,
      inputSchema: fromJsonSchema<{ name: string; input?: Json }>({
        type: "object",
        properties: { name: text(tools.call.name), input: { description: tools.call.input } },
        required: ["name"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ name, input }) =>
      result(await Effect.runPromise(call(directory, actor, claims, name, input))),
  );
  return server;
}
