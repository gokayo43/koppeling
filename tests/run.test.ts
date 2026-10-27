import { expect, test } from "bun:test";

import { initTRPC } from "@trpc/server";
import { Effect, Fiber, HashMap, Logger, Schema, TestClock, TestContext } from "effect";
import { Elysia } from "elysia";
import { z } from "zod";

import { copy } from "../src/copy";
import { admitted, toDirectory } from "../src/directory";
import { reporter } from "../src/events";
import { fromElysia, fromTrpcRouter } from "../src/index";
import { isJsonObject } from "../src/json";
import { Pages } from "../src/pages";
import { call, OPERATION_TIME_LIMIT } from "../src/run";
import { credential } from "./fixtures/api";
import {
  apiCaller,
  apiDirectory,
  warehouseAdmin,
  warehouseDirectory,
  warehousePicker,
} from "./fixtures/doors";
import { sketched } from "./support/operations";
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

test("an omitted input is {} for an operation whose input is an object, and stays omitted for any other", async () => {
  // The likeliest wrong validates nothing in place of {}, so an operation
  // whose every field is optional is refused for being left out.
  const t = initTRPC.context<object>().create();
  const seen: unknown[] = [];
  const router = t.router({
    optional: t.procedure
      .input(z.object({ entity: z.string().optional() }))
      .query(({ input }) => (seen.push(input), "optional")),
    required: t.procedure.input(z.object({ entity: z.string() })).query(() => "required"),
    text: t.procedure.input(z.string().optional()).query(({ input }) => (seen.push(input), "text")),
    none: t.procedure.query(() => "none"),
  });
  const { session } = sessionOf(
    toDirectory(fromTrpcRouter(router, { contextFor: () => ({}) })),
    null,
    claims,
  );
  const read = (name: string) => Effect.runPromise(call(session, "read", name, undefined));

  expect((await read("optional")).structured).toEqual({ result: "optional" });
  expect((await read("text")).structured).toEqual({ result: "text" });
  expect((await read("none")).structured).toEqual({ result: "none" });
  expect(seen).toEqual([{}, undefined]);
  const missing = await read("required");
  expect(missing.isError).toBe(true);
  expect(missing.structured).toMatchObject({
    details: { issues: [{ path: ["entity"] }] },
  });
});

test("a read or write of an operation awaiting a scope is refused where it is dispatched, running nothing and logging no write", async () => {
  // The likeliest wrong leaves the refusal to the door's HTTP pre-check alone,
  // so a call that check reads differently from the MCP server still runs.
  const ran: string[] = [];
  const directory = admitted(
    toDirectory(
      sketched(
        [
          { name: "orders.cancel", kind: "write" },
          { name: "orders.get", kind: "read" },
        ],
        ran,
      ),
    ),
    (operation) => ({ scope: operation.kind === "write" ? "orders:schrijven" : "orders:lezen" }),
  );
  const { session, events } = sessionOf(directory, null, claims);

  const write = await Effect.runPromise(call(session, "write", "orders.cancel", {}));
  const read = await Effect.runPromise(call(session, "read", "orders.get", {}));

  expect(write).toEqual({ text: copy.scopeAwaited(["orders:schrijven"]), isError: true });
  expect(read).toEqual({ text: copy.scopeAwaited(["orders:lezen"]), isError: true });
  expect(ran).toEqual([]);
  expect(events).toEqual([]);
});

test("an omitted input runs with what the program takes: nothing where it accepts nothing, {} where it takes only an object", async () => {
  // The likeliest wrong re-derives the default from the shown schema, which
  // has lost that an input may be left out: an omittable object is then run
  // with {} and refused for its required field, a stack of object inputs
  // (allOf, no top-level type) is run with nothing, and a procedure with no
  // input starts receiving {}.
  const t = initTRPC.context<object>().create();
  const raw: unknown[] = [];
  const seen: unknown[] = [];
  const router = t.router({
    undefinedOr: t.procedure
      .input(Schema.standardSchemaV1(Schema.UndefinedOr(Schema.Struct({ page: Schema.Int }))))
      .query(({ input }) => (seen.push(input), "undefinedOr")),
    zodOptional: t.procedure
      .input(z.object({ page: z.number() }).optional())
      .query(({ input }) => (seen.push(input), "zodOptional")),
    stacked: t.procedure
      .input(z.object({ a: z.string().optional() }))
      .input(z.object({ b: z.string().optional() }))
      .query(({ input }) => (seen.push(input), "stacked")),
    none: t.procedure
      .use(async ({ getRawInput, next }) => (raw.push(await getRawInput()), next()))
      .query(() => "none"),
  });
  const catalogue = fromTrpcRouter(router, { contextFor: () => ({}) });
  const { session } = sessionOf(toDirectory(catalogue), null, claims);
  const read = (name: string) => Effect.runPromise(call(session, "read", name, undefined));

  for (const name of ["undefinedOr", "zodOptional", "stacked", "none"]) {
    expect((await read(name)).structured).toEqual({ result: name });
  }
  expect(seen).toEqual([undefined, undefined, {}]);
  expect(raw).toEqual([undefined]);
  expect(
    Object.fromEntries(catalogue.operations.map(({ name, omittedInput }) => [name, omittedInput])),
  ).toEqual({ none: undefined, stacked: {}, undefinedOr: undefined, zodOptional: undefined });
  expect(apiDirectory().operations.every(({ omittedInput }) => isJsonObject(omittedInput))).toBe(
    true,
  );
});
