import { expect, test } from "bun:test";

import { Effect, Fiber, HashMap, Logger, TestClock, TestContext } from "effect";
import { Elysia } from "elysia";

import { copy } from "../src/copy";
import { toDirectory } from "../src/directory";
import { reporter } from "../src/events";
import { fromElysia } from "../src/index";
import { Pages } from "../src/pages";
import { call, OPERATION_TIME_LIMIT } from "../src/run";
import { credential } from "./fixtures/api";
import { apiCaller, warehouseAdmin, warehouseDirectory, warehousePicker } from "./fixtures/doors";
import { sessionOf } from "./support/session";

const claims = { sub: "person-7", name: "Beheerder Een", via: "Claude" };

test("every write leaves one event naming the operation, the person, the program and the outcome", async () => {
  const run = async (
    actor: typeof warehouseAdmin,
    name: string,
    input: Parameters<typeof call>[3],
  ) => {
    const { session, events } = sessionOf(warehouseDirectory(), actor, claims);
    await Effect.runPromise(call(session, "write", name, input));
    return events.filter((event) => event.kind === "write");
  };

  expect(
    await run(warehouseAdmin, "counting.countRow", {
      shelfCode: "A3",
      sku: "S",
      quantity: 2,
      idempotencyKey: "k",
    }),
  ).toEqual([
    {
      kind: "write",
      operation: "counting.countRow",
      sub: "person-7",
      name: "Beheerder Een",
      via: "Claude",
      outcome: "value",
    },
  ]);
  expect((await run(warehousePicker, "suppliers.delete", { supplierId: 1 }))[0]).toMatchObject({
    outcome: "refusal",
  });
  expect((await run(warehouseAdmin, "orders.ship", { orderId: 9999 }))[0]).toMatchObject({
    outcome: "unknown",
  });
});

test("a read leaves no write event", async () => {
  const { session, events } = sessionOf(warehouseDirectory(), warehouseAdmin, claims);
  await Effect.runPromise(call(session, "read", "inventory.bySku", { sku: "S" }));

  expect(events).toEqual([]);
});

test("without a host logger the write event goes to Effect's logger, annotated", async () => {
  const lines: { readonly message: string; readonly annotations: ReadonlyMap<string, unknown> }[] =
    [];
  const captured = Logger.make(({ message, annotations }) => {
    lines.push({
      message: JSON.stringify(message),
      annotations: new Map(HashMap.toEntries(annotations)),
    });
  });
  const session = {
    directory: warehouseDirectory(),
    actor: warehouseAdmin,
    claims,
    report: reporter(undefined),
    pages: new Pages(),
  };
  await Effect.runPromise(
    call(session, "write", "printer.printShelve", { shelfCode: "A3" }).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, captured)),
    ),
  );

  expect(
    lines.map(({ message, annotations }) => [message, Object.fromEntries(annotations)]),
  ).toEqual([
    [
      JSON.stringify(["koppeling write"]),
      {
        operation: "printer.printShelve",
        sub: "person-7",
        name: "Beheerder Een",
        via: "Claude",
        outcome: "value",
      },
    ],
  ]);
});

/** An app whose route answers a stream that never ends, and records that it was reached. */
function neverEnding(reached: string[]) {
  const stream = () => {
    reached.push("reached");
    return new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return toDirectory(
    fromElysia(new Elysia().get("/api/v1/events", stream).post("/api/v1/events", stream), {
      credential,
      mount: "/api/v1",
    }),
  );
}

test("an operation that does not finish within the time limit is given up on, and a write's outcome is unknown", async () => {
  const reached: string[] = [];
  const { session, events } = sessionOf(neverEnding(reached), apiCaller, claims);
  const answers = await Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* Effect.fork(call(session, "read", "events.get", {}));
      const write = yield* Effect.fork(call(session, "write", "events.post", {}));
      yield* TestClock.adjust(OPERATION_TIME_LIMIT);
      return [yield* Fiber.join(read), yield* Fiber.join(write)];
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

  expect(answers.map((answered) => answered.text)).toEqual([copy.readTimedOut, copy.writeTimedOut]);
  expect(reached).toEqual(["reached", "reached"]);
  expect(events).toEqual([
    {
      kind: "write",
      operation: "events.post",
      sub: "person-7",
      name: "Beheerder Een",
      via: "Claude",
      outcome: "unknown",
    },
  ]);
});
