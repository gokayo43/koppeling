import { expect, test } from "bun:test";

import { Effect, HashMap, Logger } from "effect";

import { call } from "../src/tools";
import { warehouseAdmin, warehouseDirectory, warehousePicker } from "./fixtures/doors";

const claims = { sub: "person-7", name: "Beheerder Een" };

/** Runs one call with the logger captured, answering the audit lines it wrote. */
async function audited(
  ...[actor, name, input]: [typeof warehouseAdmin, string, Parameters<typeof call>[4]]
) {
  const lines: { readonly message: string; readonly annotations: ReadonlyMap<string, unknown> }[] =
    [];
  const captured = Logger.make(({ message, annotations }) => {
    lines.push({
      message: JSON.stringify(message),
      annotations: new Map(HashMap.toEntries(annotations)),
    });
  });
  await Effect.runPromise(
    call(warehouseDirectory(), actor, claims, name, input).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, captured)),
    ),
  );
  return lines
    .filter(({ message }) => message.includes("koppeling write"))
    .map(({ message, annotations }) => ({ message, annotations: Object.fromEntries(annotations) }));
}

test("every call of a write writes one audit line naming the operation, the person and the outcome", async () => {
  expect(
    await audited(warehouseAdmin, "counting.countRow", {
      shelfCode: "A3",
      sku: "S",
      quantity: 2,
      idempotencyKey: "k",
    }),
  ).toEqual([
    {
      message: JSON.stringify(["koppeling write"]),
      annotations: {
        operation: "counting.countRow",
        sub: "person-7",
        name: "Beheerder Een",
        outcome: "value",
      },
    },
  ]);
  expect(
    (await audited(warehousePicker, "suppliers.delete", { supplierId: 1 }))[0]?.annotations,
  ).toMatchObject({
    outcome: "refusal",
  });
  expect(
    (await audited(warehouseAdmin, "orders.ship", { orderId: 9999 }))[0]?.annotations,
  ).toMatchObject({
    outcome: "failure",
  });
});

test("a read writes no audit line", async () => {
  expect(await audited(warehouseAdmin, "inventory.bySku", { sku: "S" })).toEqual([]);
});
