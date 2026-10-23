import { JSONSchema, Schema } from "effect";
import * as AST from "effect/SchemaAST";

import { isJsonObject, toJson, type Json, type JsonSchema } from "./json";

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * A program's schema as the door offers it: as JSON Schema, or, where the
 * program's schema language cannot write it as one (an Effect `DateFromSelf`,
 * a zod `z.date()`), the reason, which the boot report names.
 */
export type Described = { readonly schema: JsonSchema } | { readonly undescribable: string };

/**
 * A program's own schema for one value, as JSON Schema: Effect Schema through
 * `JSONSchema.make`, TypeBox as it is (it is JSON Schema already), and anything
 * implementing Standard JSON Schema (zod 4, ArkType, Valibot) through its own
 * converter. A schema in any other language throws, naming `owner`, so a host
 * learns at boot which operation the door cannot read.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a program's validator, in whichever schema language the program chose
export function describeSchema(schema: unknown, owner: string): Described {
  let converted: Json | undefined;
  try {
    converted = convert(schema);
  } catch (cause) {
    return {
      undescribable: String(cause instanceof Error ? cause.message : cause)
        .split("\n", 2)
        .join(" "),
    };
  }
  if (converted === undefined) {
    throw new Error(
      `${owner}: its schema is not Effect Schema, TypeBox or a Standard JSON Schema (zod 4), so the koppeling cannot read it`,
    );
  }
  if (!isJsonObject(converted))
    return { undescribable: `it converts to ${JSON.stringify(converted)}` };
  return { schema: converted };
}

/** The schema in JSON Schema, or `undefined` when it is in no language the door reads. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- describeSchema's input, passed on
function convert(schema: unknown): Json | undefined {
  if (Schema.isSchema(schema)) return toJson(JSONSchema.make(definedPart(schema)));
  if (typeof schema !== "object" || schema === null) return undefined;
  if (TYPEBOX_KIND in schema) return toJson(schema);
  return standardJsonSchema(schema);
}

/**
 * An Effect input whose encoded side is `X | undefined` (`Schema.UndefinedOr`,
 * or a default filled in when the input is left out) says the input may be
 * left out, which the door's `call` already allows. JSON Schema has no
 * `undefined`, and `JSONSchema.make` writes the encoded side, so the schema the
 * door writes is the encoded `X`'s.
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
function standardJsonSchema(schema: object): Json | undefined {
  if (!("~standard" in schema)) return undefined;
  const props = schema["~standard"];
  if (typeof props !== "object" || props === null || !("jsonSchema" in props)) return undefined;
  const converter = props.jsonSchema;
  if (typeof converter !== "object" || converter === null || !("input" in converter)) {
    return undefined;
  }
  const input = converter.input;
  if (typeof input !== "function") return undefined;
  const written: unknown = input.call(converter, { target: "draft-2020-12" });
  return toJson(written);
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
