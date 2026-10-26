import { expect, test } from "bun:test";

import { initTRPC } from "@trpc/server";
import { Schema } from "effect4";

import { strayKeys } from "../src/closed";
import { fromTrpcRouter } from "../src/index";

/** A signal no case aborts, for a run the case lets finish. */
const unaborted = new AbortController().signal;

const t = initTRPC.context<object>().create();

const router = t.router({
  shelves: t.router({
    move: t.procedure
      // What an Effect 4 host hands `.input()`: the schema made both a Standard
      // Schema, which tRPC validates with, and a Standard JSON Schema, which the
      // door describes it with.
      .input(
        Schema.toStandardJSONSchemaV1(
          Schema.toStandardSchemaV1(
            Schema.Struct({ code: Schema.String, toShelf: Schema.String, quantity: Schema.Int }),
          ),
        ),
      )
      .mutation(({ input }) => input),
  }),
});

test("an Effect 4 input handed over as a Standard JSON Schema is described, and tRPC still validates it", async () => {
  const [move] = fromTrpcRouter(router, { contextFor: () => ({}) }).operations;

  expect(move?.input).toMatchObject({
    type: "object",
    required: ["code", "toShelf", "quantity"],
    properties: { code: { type: "string" }, quantity: { type: "integer" } },
  });
  expect(await move?.run(null, { code: "SKU-1", toShelf: "B1", quantity: 2 }, unaborted)).toEqual({
    value: { code: "SKU-1", toShelf: "B1", quantity: 2 },
  });
  expect(
    await move?.run(null, { code: "SKU-1", toShelf: "B1", quantity: "twee" }, unaborted),
  ).toHaveProperty("refusal");
});

test("an Effect 4 input handed over as a Standard Schema alone fails the boot, saying what to hand over", () => {
  const validatorOnly = t.router({
    get: t.procedure
      .input(Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.Int })))
      .query(() => 1),
  });

  expect(() => fromTrpcRouter(validatorOnly, { contextFor: () => ({}) })).toThrow(
    "toStandardJSONSchemaV1",
  );
});

test("an Effect 4 struct is shown closed, since Effect drops a key it does not name, and a stray key is refused", async () => {
  // Effect 4 writes additionalProperties: true for a struct yet drops the
  // keys it does not name when it decodes; showing it open would let a
  // misnamed field through unanswered, as the probe saw.
  const Shelf = Schema.Struct({ code: Schema.String, place: Schema.Struct({ row: Schema.Int }) });
  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(Shelf));
  expect(await standard["~standard"].validate({ code: "A", place: { row: 1 }, extra: 1 })).toEqual({
    value: { code: "A", place: { row: 1 } },
  });
  const [put] = fromTrpcRouter(t.router({ put: t.procedure.input(standard).mutation(() => 1) }), {
    contextFor: () => ({}),
  }).operations;

  expect(put?.input).toMatchObject({
    additionalProperties: false,
    properties: { place: { additionalProperties: false } },
  });
  expect(strayKeys(put?.input ?? {}, { code: "A", place: { row: 1, rij: 2 } })).toEqual([
    { at: "input.place", unknown: ["rij"], allowed: ["row"] },
  ]);
});
