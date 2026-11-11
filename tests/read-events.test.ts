/**
 * The read event, graded through the public door with a recording `log`: one
 * per run of a read, none for a call that runs nothing. A read past the time
 * limit is graded in run.test.ts, on Effect's test clock, which the door's own
 * runtime does not take; a read awaiting a scope in door.test.ts.
 */
import { expect, setSystemTime, test } from "bun:test";

import type { Client } from "@modelcontextprotocol/client";
import { initTRPC } from "@trpc/server";

import { fromTrpcRouter, type JsonObject } from "../src/index";
import { KEPT_MS } from "../src/pages";
import { warehousePicker } from "./fixtures/doors";
import { clientOf } from "./support/client";
import { recordingDoor, warehouseDoor } from "./support/door";
import { identityProvider } from "./support/identity";

const person = { sub: "person-1", name: "Beheerder Een", via: "Claude" };

type Idp = Awaited<ReturnType<typeof identityProvider>>;

/** A client of `door`, signed in as `person` for an hour. */
const signedIn = async (
  idp: Idp,
  door: { readonly handle: (request: Request) => Promise<Response> },
) =>
  clientOf(
    door.handle,
    await idp.token({ name: person.name, via: person.via }, { expiresIn: 3600 }),
    "modern",
  );

/**
 * Reads the warehouse fixture has none of: one that throws, and one whose
 * answer runs to several pages.
 */
function edgeDoor() {
  const t = initTRPC.context<object>().create();
  const reached: string[] = [];
  const router = t.router({
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
  const recorded = recordingDoor(fromTrpcRouter(router, { contextFor: () => ({}) }), () => ({
    actor: null,
  }));
  return { ...recorded, reached };
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
  using idp = await identityProvider();
  const { door, events } = warehouseDoor();
  const client = await signedIn(idp, door);
  const answered = await read(client, "inventory.bySku", { sku: "SKU-1" });

  expect(answered.isError).toBeFalsy();
  expect(events).toEqual([
    { kind: "read", operation: "inventory.bySku", ...person, outcome: "value" },
  ]);
  await client.close();
});

test("a read the program refuses reports one read event with its refusal", async () => {
  using idp = await identityProvider();
  const { door, invoked, events } = warehouseDoor(() => ({ actor: warehousePicker }));
  const client = await signedIn(idp, door);
  const refused = await read(client, "bestellingen.list");

  expect(refused.isError).toBe(true);
  expect(invoked).toEqual(["bestellingen.list"]);
  expect(events).toEqual([
    { kind: "read", operation: "bestellingen.list", ...person, outcome: "refusal" },
  ]);
  await client.close();
});

test("a read whose program throws reports its failure event and then its read event, as a failed write does", async () => {
  // The likeliest wrong reads a reached program's failure as `unknown`, which
  // a read cannot be, or drops the failure event the host logs the cause from.
  using idp = await identityProvider();
  const { door, reached, events } = edgeDoor();
  const client = await signedIn(idp, door);
  await read(client, "broken");

  expect(reached).toEqual(["broken"]);
  expect(
    events.map((event) =>
      event.kind === "failure" ? { kind: event.kind, operation: event.operation } : event,
    ),
  ).toEqual([
    { kind: "failure", operation: "broken" },
    { kind: "read", operation: "broken", ...person, outcome: "failure" },
  ]);
  await client.close();
});

test("a read refused for a key its input does not name runs nothing and reports one read event, a failure", async () => {
  using idp = await identityProvider();
  const { door, invoked, events } = warehouseDoor();
  const client = await signedIn(idp, door);
  const refused = await read(client, "orders.list", { stauts: "processing" });

  expect(refused.isError).toBe(true);
  expect(invoked).toEqual([]);
  expect(events).toEqual([
    { kind: "read", operation: "orders.list", ...person, outcome: "failure" },
  ]);
  await client.close();
});

test("a next page answered from the kept answer reports nothing, and one the door runs the read again for reports one event", async () => {
  // The likeliest wrong reports in the paging step, once per page, rather
  // than once per run of the program.
  using idp = await identityProvider();
  const { door, reached, events } = edgeDoor();
  const client = await signedIn(idp, door);
  const token = continuation(await read(client, "long"));
  expect(token).toBeDefined();
  await read(client, "long", {}, token);

  expect(reached).toEqual(["long"]);
  expect(events).toHaveLength(1);

  setSystemTime(new Date(Date.now() + KEPT_MS + 60_000));
  try {
    await read(client, "long", {}, token);
  } finally {
    setSystemTime();
  }
  expect(reached).toEqual(["long", "long"]);
  expect(events).toEqual([
    { kind: "read", operation: "long", ...person, outcome: "value" },
    { kind: "read", operation: "long", ...person, outcome: "value" },
  ]);
  await client.close();
});

test("a call that names no operation or one of the other kind runs nothing and reports nothing", async () => {
  using idp = await identityProvider();
  const { door, invoked, events } = warehouseDoor();
  const client = await signedIn(idp, door);
  await read(client, "inventory.bySkuu", { sku: "SKU-1" });
  await read(client, "printer.printShelve", { shelfCode: "A3" });
  await client.callTool({
    name: "write",
    arguments: { name: "inventory.bySku", input: { sku: "SKU-1" } },
  });

  expect(invoked).toEqual([]);
  expect(events).toEqual([]);
  await client.close();
});
