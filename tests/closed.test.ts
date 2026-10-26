import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { JSONSchema, Schema } from "effect";
import {
  constantFrom,
  dictionary,
  letrec,
  nat,
  property,
  record,
  tuple,
  type Arbitrary,
} from "fast-check";
import { z } from "zod";

import { closed, strayKeys } from "../src/closed";
import { toJson, type Json, type JsonObject, type JsonSchema } from "../src/json";
import { describeSchema } from "../src/schema";

/** What a program's zod input becomes as the door reads it. */
function shown(schema: z.ZodType): JsonSchema {
  const described = describeSchema(schema, "test");
  if (!("schema" in described)) throw new Error(described.undescribable);
  return closed(described.schema);
}

/** A schema tree as a program would declare one: objects naming their keys, records, lists, text. */
type Node =
  | { readonly kind: "text" }
  | { readonly kind: "object"; readonly fields: { readonly [name: string]: Node } }
  | { readonly kind: "record"; readonly of: Node }
  | { readonly kind: "list"; readonly of: Node };

const FIELD = constantFrom("a", "b", "sku", "lines", "status");
const STRAY = "statsu";

const { node } = letrec<{ node: Node }>((tie) => ({
  node: constantFrom("text", "object", "record", "list").chain((kind): Arbitrary<Node> => {
    if (kind === "text") return constantFrom({ kind: "text" as const });
    if (kind === "object") {
      return dictionary(FIELD, tie("node"), { maxKeys: 3, depthIdentifier: "tree" }).map(
        (fields) => ({ kind: "object" as const, fields }),
      );
    }
    return tie("node").map((of) => ({ kind, of }));
  }),
}));

/** The JSON Schema zod writes for `node` as an input: objects without `additionalProperties`. */
function schemaOf(tree: Node): JsonSchema {
  if (tree.kind === "text") return { type: "string" };
  if (tree.kind === "list") return { type: "array", items: schemaOf(tree.of) };
  if (tree.kind === "record") {
    return {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: schemaOf(tree.of),
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(tree.fields).map(([name, child]) => [name, schemaOf(child)]),
    ),
  };
}

interface Place {
  readonly at: string;
  readonly tree: Node;
  /** The value with one more key at this place. */
  readonly strayed: Json;
}

/** A value every key of which the tree names, and each place in it an object sits. */
function valueOf(tree: Node, at: string): { readonly value: Json; readonly places: Place[] } {
  if (tree.kind === "text") return { value: "x", places: [] };
  if (tree.kind === "list") {
    const item = valueOf(tree.of, `${at}[0]`);
    return {
      value: [item.value],
      places: item.places.map((place) => ({ ...place, strayed: [place.strayed] })),
    };
  }
  const entries: [string, Node][] =
    tree.kind === "record" ? [["k", tree.of]] : Object.entries(tree.fields);
  const children = entries.map(([name, child]) => ({ name, ...valueOf(child, `${at}.${name}`) }));
  const value: JsonObject = Object.fromEntries(children.map((child) => [child.name, child.value]));
  return {
    value,
    places: [
      { at, tree, strayed: { ...value, [STRAY]: "x" } },
      ...children.flatMap(({ name, places }) =>
        places.map((place) => ({ ...place, strayed: { ...value, [name]: place.strayed } })),
      ),
    ],
  };
}

test("only a key the shown schema does not name is refused, at its place, and never under a record", () => {
  // The likeliest wrong checks: refusing nothing (today's door), refusing
  // inside a record, or checking the outermost object alone.
  check(
    property(
      record({ fields: dictionary(FIELD, node, { maxKeys: 3 }) }).chain(({ fields }) => {
        const tree: Node = { kind: "object", fields };
        return tuple(constantFrom(tree), nat({ max: valueOf(tree, "input").places.length - 1 }));
      }),
      ([tree, pick]) => {
        const schema = closed(schemaOf(tree));
        const { value, places } = valueOf(tree, "input");
        expect(strayKeys(schema, value)).toEqual([]);

        const place = places[pick];
        if (place === undefined) throw new Error("no place picked");
        expect(strayKeys(schema, place.strayed)).toEqual(
          place.tree.kind === "object"
            ? [{ at: place.at, unknown: [STRAY], allowed: Object.keys(place.tree.fields) }]
            : [],
        );
      },
    ),
  );
});

test("an object that names its keys is closed, nested too, and a record or a loose object stays open", () => {
  const schema = shown(
    z.object({
      sku: z.string(),
      shelf: z.object({ code: z.string() }),
      lines: z.array(z.object({ quantity: z.number() })),
      counts: z.record(z.string(), z.number()),
      extra: z.looseObject({ note: z.string() }),
    }),
  );

  expect(schema).toMatchObject({
    additionalProperties: false,
    properties: {
      shelf: { additionalProperties: false },
      lines: { items: { additionalProperties: false } },
      counts: { additionalProperties: { type: "number" } },
      extra: { additionalProperties: {} },
    },
  });
  expect(
    strayKeys(schema, {
      sku: "S",
      shelf: { code: "A1" },
      lines: [{ quantity: 1 }],
      counts: { anything: 1 },
      extra: { note: "n", more: true },
    }),
  ).toEqual([]);
});

test("keys from several inputs or alternatives are allowed together, and the whole is closed once", () => {
  // Closing each part on its own would refuse its siblings' keys: tRPC merges
  // two inputs into one object, and an alternative's keys are the union's.
  const merged = closed({
    allOf: [
      { type: "object", properties: { orderId: { type: "number" } } },
      { type: "object", properties: { note: { type: "string" } } },
    ],
  });
  expect(merged).toMatchObject({ unevaluatedProperties: false });
  expect(merged["allOf"]).toEqual([
    { type: "object", properties: { orderId: { type: "number" } } },
    { type: "object", properties: { note: { type: "string" } } },
  ]);
  expect(strayKeys(merged, { orderId: 1, note: "n" })).toEqual([]);
  expect(strayKeys(merged, { orderId: 1, nota: "n" })).toEqual([
    { at: "input", unknown: ["nota"], allowed: ["orderId", "note"] },
  ]);

  const either = shown(
    z.discriminatedUnion("by", [
      z.object({ by: z.literal("sku"), sku: z.string() }),
      z.object({ by: z.literal("ean"), ean: z.string() }),
    ]),
  );
  expect(strayKeys(either, { by: "sku", sku: "S" })).toEqual([]);
  expect(strayKeys(either, { by: "sku", skus: "S" })).toEqual([
    { at: "input", unknown: ["skus"], allowed: ["by", "sku", "ean"] },
  ]);
});

test("an alternative that takes anything leaves the object open", () => {
  const loose = closed({
    anyOf: [{ type: "object", properties: { items: { type: "array" } } }, {}],
  });

  expect(loose).not.toHaveProperty("unevaluatedProperties");
  expect(strayKeys(loose, { anything: 1 })).toEqual([]);
});

test("a key is judged through a $ref into the definitions of the document it came from", () => {
  const Shelf = Schema.Struct({ code: Schema.String }).annotations({ identifier: "Shelf" });
  const effect = JSONSchema.make(Schema.Struct({ shelf: Shelf }));
  const wrapped = closed({
    type: "object",
    properties: { body: toJson(effect) },
  });

  expect(strayKeys(wrapped, { body: { shelf: { code: "A1" } } })).toEqual([]);
  expect(strayKeys(wrapped, { body: { shelf: { kode: "A1" } } })).toEqual([
    { at: "input.body.shelf", unknown: ["kode"], allowed: ["code"] },
  ]);
  expect(
    strayKeys(closed({ type: "object", properties: { x: { $ref: "#/$defs/Gone" } } }), {
      x: { anything: 1 },
    }),
  ).toEqual([]);
});

test("a $ref the door cannot resolve, or a conditional, leaves its object open rather than refusing its keys", () => {
  // The likeliest wrong collects allowed keys from the parts it resolved
  // alone, so the keys of the part it could not read are refused.
  const based = closed({
    allOf: [{ $ref: "Base" }, { properties: { extra: { type: "string" } } }],
  });
  expect(strayKeys(based, { baseField: 1, extra: "x" })).toEqual([]);

  const conditional = closed({
    type: "object",
    properties: { kind: { type: "string" } },
    if: { properties: { kind: { const: "sku" } } },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's own keyword, never awaited
    then: { properties: { sku: { type: "string" } } },
  });
  expect(strayKeys(conditional, { kind: "sku", sku: "S" })).toEqual([]);
  const dependent = closed({
    type: "object",
    properties: { card: { type: "string" } },
    dependentSchemas: { card: { properties: { expiry: { type: "string" } } } },
  });
  expect(strayKeys(dependent, { card: "c", expiry: "e" })).toEqual([]);
});
