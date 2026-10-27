import { JSONSchema, Schema } from "effect";
import * as AST from "effect/SchemaAST";

import { isJsonArray, isJsonObject, toJson, type Json, type JsonSchema } from "./json";

/** The symbol every TypeBox schema carries its kind under. */
export const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * A program's schema as the door offers it: as JSON Schema, or, where the
 * program's schema language cannot write it as one (an Effect `DateFromSelf`,
 * a zod `z.date()`), the reason, which the boot report names.
 */
export type Described = { readonly schema: JsonSchema } | { readonly undescribable: string };

/**
 * Which side of a schema the door describes: what a program takes (`input`),
 * or what it answers (`output`), which a transform makes differ.
 */
export type Side = "input" | "output";

/**
 * A program's own schema for one value, as JSON Schema, from `side`: Effect
 * Schema through `JSONSchema.make` (its encoded side for an input, its type
 * side for an output), TypeBox as it is (it is JSON Schema already), and
 * anything implementing Standard JSON Schema (zod 4, ArkType, Valibot) through
 * its own converter for that side. A schema in any other language throws,
 * naming `owner`, so a host learns at boot which operation the door cannot
 * read.
 */
export function describeSchema(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a program's validator, in whichever schema language the program chose
  schema: unknown,
  owner: string,
  side: Side,
): Described {
  let converted: Json | undefined;
  try {
    converted = convert(schema, side);
  } catch (cause) {
    return {
      undescribable: String(cause instanceof Error ? cause.message : cause)
        .split("\n", 2)
        .join(" "),
    };
  }
  if (converted === undefined) {
    throw new Error(
      `${owner}: its schema is not Effect Schema 3, TypeBox or a Standard JSON Schema (zod 4; Effect 4 through Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))), so the koppeling cannot read it`,
    );
  }
  if (!isJsonObject(converted))
    return { undescribable: `it converts to ${JSON.stringify(converted)}` };
  // The dialect a converter names (Effect 3 writes draft-07) goes: the door
  // shows every schema as 2020-12, the dialect MCP reads, whose
  // unevaluatedProperties closing writes.
  const { $schema: _dialect, ...shown } = converted;
  return { schema: shown };
}

/** The schema in JSON Schema, or `undefined` when it is in no language the door reads. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- describeSchema's input, passed on
function convert(schema: unknown, side: Side): Json | undefined {
  if (Schema.isSchema(schema)) {
    return toJson(
      JSONSchema.make(side === "input" ? definedPart(schema) : Schema.typeSchema(schema)),
    );
  }
  // An Effect 4 schema is a function, so a function is looked into as well.
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) {
    return undefined;
  }
  if (TYPEBOX_KIND in schema) return toJson(schema);
  return standardJsonSchema(schema, side);
}

/**
 * An Effect input whose encoded side is `X | undefined` (`Schema.UndefinedOr`,
 * or a default filled in when the input is left out) says the input may be
 * left out, which `acceptsOmitted` reads from the program's validator. JSON
 * Schema has no `undefined`, and `JSONSchema.make` writes the encoded side, so
 * the schema the door writes is the encoded `X`'s.
 */
function definedPart<A, I, R>(schema: Schema.Schema<A, I, R>) {
  let ast = schema.ast;
  while (AST.isTransformation(ast)) ast = ast.from;
  if (!AST.isUnion(ast)) return schema;
  const defined = ast.types.filter((member) => !AST.isUndefinedKeyword(member));
  return defined.length === ast.types.length ? schema : Schema.make(AST.Union.make(defined));
}

/** The schema's input side through its own Standard JSON Schema converter, if it has one. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- any object that may carry the Standard JSON Schema property
function standardJsonSchema(schema: object, side: Side): Json | undefined {
  if (!("~standard" in schema)) return undefined;
  const props = schema["~standard"];
  if (typeof props !== "object" || props === null || !("jsonSchema" in props)) return undefined;
  const converter = props.jsonSchema;
  if (typeof converter !== "object" || converter === null) return undefined;
  const write =
    side === "input"
      ? "input" in converter
        ? converter.input
        : undefined
      : "output" in converter
        ? converter.output
        : undefined;
  if (typeof write !== "function") return undefined;
  const written: unknown = write.call(converter, { target: "draft-2020-12" });
  const json = toJson(written);
  return "vendor" in props && props.vendor === "effect" ? withoutDroppedOpenness(json) : json;
}

/**
 * Effect 4 writes `additionalProperties: true` on a struct, yet its decoding
 * drops every key the struct does not name (measured on 4.0.5, and pinned in
 * tests/effect4.test.ts), so the door reads that `true` as a struct that names
 * its keys and leaves it to closing; a record's schema stays.
 */
function withoutDroppedOpenness(json: Json): Json {
  if (isJsonArray(json)) return json.map((item) => withoutDroppedOpenness(item));
  if (!isJsonObject(json)) return json;
  return Object.fromEntries(
    Object.entries(json).flatMap(([key, value]): [string, Json][] =>
      key === "additionalProperties" && value === true && "properties" in json
        ? []
        : [[key, withoutDroppedOpenness(value)]],
    ),
  );
}

/**
 * Whether a program's own validator takes an omitted value, asked through
 * Standard Schema's `validate` as tRPC itself asks it. A validator that
 * answers only later (a `Promise`, for an asynchronous check) is taken to
 * accept it, so the program's own parse decides, as it did before the door
 * chose; one that throws takes it no more than one that answers issues.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a program's validator, in whichever schema language the program chose
export function acceptsOmitted(schema: unknown): boolean {
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) return false;
  const standard = "~standard" in schema ? schema["~standard"] : undefined;
  if (typeof standard !== "object" || standard === null || !("validate" in standard)) return false;
  const { validate } = standard;
  if (typeof validate !== "function") return false;
  let result: unknown;
  try {
    result = validate.call(standard, undefined);
  } catch {
    return false;
  }
  if (result instanceof Promise) return true;
  return typeof result === "object" && result !== null && !("issues" in result && result.issues);
}

/** Whether a schema takes an object and nothing else: an object's, or an `allOf` of such. */
export function takesObject(schema: JsonSchema): boolean {
  if (schema["type"] === "object") return true;
  const parts = schema["allOf"];
  return (
    isJsonArray(parts) &&
    parts.length > 0 &&
    parts.every((part) => isJsonObject(part) && takesObject(part))
  );
}

/**
 * Several schemas one value must satisfy at once, as one: `allOf` of them, or
 * the reasons when any of them cannot be written; `undefined` for none.
 */
export function allOf(parts: readonly Described[]): Described | undefined {
  const reasons = parts.flatMap((part) => ("undescribable" in part ? [part.undescribable] : []));
  if (reasons.length) return { undescribable: reasons.join("; ") };
  const schemas = parts.flatMap((part) => ("schema" in part ? [part.schema] : []));
  const [only, ...more] = schemas;
  if (only === undefined) return undefined;
  return { schema: more.length ? { allOf: [only, ...more] } : only };
}

/**
 * A schema's properties, its own and those of its `allOf`, `anyOf` and `oneOf`
 * parts, each with its schema: the fields an object of it may carry.
 */
export function properties(schema: JsonSchema): [string, JsonSchema][] {
  const own = schema["properties"];
  const named: [string, JsonSchema][] = isJsonObject(own)
    ? Object.entries(own).flatMap(([name, child]) => (isJsonObject(child) ? [[name, child]] : []))
    : [];
  const parts = ["allOf", "anyOf", "oneOf"].flatMap((key) => {
    const list = schema[key];
    return isJsonArray(list) ? list.filter(isJsonObject) : [];
  });
  return [...named, ...parts.flatMap(properties)];
}
