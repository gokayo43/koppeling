import { expect, test } from "bun:test";

import { initTRPC } from "@trpc/server";
import { Schema } from "effect4";

import { fromTrpcRouter } from "../src/index";

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
  expect(await move?.run(null, { code: "SKU-1", toShelf: "B1", quantity: 2 })).toEqual({
    value: { code: "SKU-1", toShelf: "B1", quantity: 2 },
  });
  expect(await move?.run(null, { code: "SKU-1", toShelf: "B1", quantity: "twee" })).toHaveProperty(
    "refusal",
  );
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
