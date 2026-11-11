/**
 * The read event, graded through the public door with a recording `log`: one
 * per run of a read, none for a call that runs nothing. A read past the time
 * limit is graded in run.test.ts, on Effect's test clock, which the door's own
 * runtime does not take.
 */
import { expect, setSystemTime, test } from "bun:test";

import type { Client } from "@modelcontextprotocol/client";
import { initTRPC } from "@trpc/server";

import {
  fromTrpcRouter,
  koppeling,
  type ActorDecision,
  type JsonObject,
  type KoppelingEvent,
} from "../src/index";
import { warehouseAdmin, warehousePicker } from "./fixtures/doors";
import { contextFor, glossary, warehouseRouter, type WarehouseActor } from "./fixtures/warehouse";
import { clientOf } from "./support/client";
import { identityProvider, ISSUER, JWKS_URL, RESOURCE } from "./support/identity";

const person = { sub: "person-1", name: "Beheerder Een", via: "Claude" };
const identity = { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER };

/** The warehouse fixture behind a door whose `log` keeps every event. */
async function warehouse(
  decide: () => ActorDecision<WarehouseActor> = () => ({ actor: warehouseAdmin }),
) {
  const idp = await identityProvider();
  const invoked: string[] = [];
  const events: KoppelingEvent[] = [];
  const door = koppeling({
    catalogue: fromTrpcRouter(
      warehouseRouter((path) => invoked.push(path)),
      { contextFor },
    ),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity,
    actorFor: decide,
    log: (event) => events.push(event),
  });
  const token = await idp.token({ name: person.name, via: person.via });
  const client = await clientOf(door.handle, token, "modern");
  return {
    door,
    token,
    client,
    invoked,
    events,
    async [Symbol.asyncDispose]() {
      await client.close();
      idp[Symbol.dispose]();
    },
  };
}

/**
 * Reads the warehouse fixture has none of: one that throws, and one whose
 * answer runs to several pages.
 */
function edges(reached: string[]) {
  const t = initTRPC.context<object>().create();
  return t.router({
    broken: t.procedure.query(() => {
      reached.push("broken");
      throw new Error("connect ECONNREFUSED 10.0.0.9:3306");
    }),
    long: t.procedure.query(() => {
      reached.push("long");
      return Array.from({ length: 2000 }, (_, index) => ({
        id: index,
        name: `Remschijf ${index} met een omschrijving die lang genoeg is`,
      }));
    }),
  });
}

async function edgeDoor() {
  const idp = await identityProvider();
  const reached: string[] = [];
  const events: KoppelingEvent[] = [];
  const door = koppeling({
    catalogue: fromTrpcRouter(edges(reached), { contextFor: () => ({}) }),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity,
    actorFor: () => ({ actor: null }),
    log: (event) => events.push(event),
  });
  const token = await idp.token({ name: person.name, via: person.via }, { expiresIn: 3600 });
  const client = await clientOf(door.handle, token, "modern");
  return {
    client,
    reached,
    events,
    async [Symbol.asyncDispose]() {
      await client.close();
      idp[Symbol.dispose]();
    },
  };
}

const read = (client: Client, name: string, input: JsonObject = {}, vervolg?: string) =>
  client.callTool({
    name: "read",
    arguments: { name, input, ...(vervolg === undefined ? {} : { vervolg }) },
  });

const continuation = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .match(/vervolg "([^"]+)"/)?.[1];

test("a read that answers reports one read event, naming the person and the program and nothing of the input or output", async () => {
  // The likeliest wrong reports the read as a write, or carries the call's
  // input or answer in the event.
  await using door = await warehouse();
  const answered = await read(door.client, "inventory.bySku", { sku: "SKU-1" });

  expect(answered.isError).toBeFalsy();
  expect(door.events).toEqual([
    { kind: "read", operation: "inventory.bySku", ...person, outcome: "value" },
  ]);
});

test("a read the program refuses reports one read event with its refusal", async () => {
  await using door = await warehouse(() => ({ actor: warehousePicker }));
  const refused = await read(door.client, "bestellingen.list");

  expect(refused.isError).toBe(true);
  expect(door.invoked).toEqual(["bestellingen.list"]);
  expect(door.events).toEqual([
    { kind: "read", operation: "bestellingen.list", ...person, outcome: "refusal" },
  ]);
});

test("a read whose program throws reports its failure event and then its read event, as a failed write does", async () => {
  // The likeliest wrong reads a reached program's failure as `unknown`, which
  // a read cannot be, or drops the failure event the host logs the cause from.
  await using door = await edgeDoor();
  await read(door.client, "broken");

  expect(door.reached).toEqual(["broken"]);
  expect(
    door.events.map((event) =>
      event.kind === "failure" ? { kind: event.kind, operation: event.operation } : event,
    ),
  ).toEqual([
    { kind: "failure", operation: "broken" },
    { kind: "read", operation: "broken", ...person, outcome: "failure" },
  ]);
});

test("a read refused for a key its input does not name runs nothing and reports one read event, a failure", async () => {
  await using door = await warehouse();
  const refused = await read(door.client, "orders.list", { stauts: "processing" });

  expect(refused.isError).toBe(true);
  expect(door.invoked).toEqual([]);
  expect(door.events).toEqual([
    { kind: "read", operation: "orders.list", ...person, outcome: "failure" },
  ]);
});

test("a next page answered from the kept answer reports nothing, and one the door runs the read again for reports one event", async () => {
  // The likeliest wrong reports in the paging step, once per page, rather
  // than once per run of the program.
  await using door = await edgeDoor();
  const first = await read(door.client, "long");
  const token = continuation(first);
  expect(token).toBeDefined();
  await read(door.client, "long", {}, token);

  expect(door.reached).toEqual(["long"]);
  expect(door.events).toHaveLength(1);

  setSystemTime(new Date(Date.now() + 11 * 60_000));
  try {
    await read(door.client, "long", {}, token);
  } finally {
    setSystemTime();
  }
  expect(door.reached).toEqual(["long", "long"]);
  expect(door.events).toEqual([
    { kind: "read", operation: "long", ...person, outcome: "value" },
    { kind: "read", operation: "long", ...person, outcome: "value" },
  ]);
});

test("a call that names no operation or one of the other kind runs nothing and reports nothing", async () => {
  await using door = await warehouse();
  await read(door.client, "inventory.bySkuu", { sku: "SKU-1" });
  await read(door.client, "printer.printShelve", { shelfCode: "A3" });
  await door.client.callTool({
    name: "write",
    arguments: { name: "inventory.bySku", input: { sku: "SKU-1" } },
  });

  expect(door.invoked).toEqual([]);
  expect(door.events).toEqual([]);
});

test("a read of an operation awaiting a scope runs nothing and reports nothing", async () => {
  await using door = await warehouse(() => ({
    actor: warehouseAdmin,
    allows: (operation) => (operation.name === "orders.get" ? { scope: "orders:lezen" } : true),
  }));
  const response = await door.door.handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${door.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read", arguments: { name: "orders.get", input: { orderId: 1 } } },
      }),
    }),
  );

  expect(response.status).toBe(403);
  expect(door.invoked).toEqual([]);
  expect(door.events).toEqual([]);
});
