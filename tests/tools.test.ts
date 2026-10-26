import { expect, test } from "bun:test";

import type { Client } from "@modelcontextprotocol/client";
import { Elysia } from "elysia";
import { z } from "zod";

import { copy } from "../src/copy";
import { toDirectory } from "../src/directory";
import { fromElysia } from "../src/index";
import { credential } from "./fixtures/api";
import {
  apiCaller,
  apiDirectory,
  warehouseAdmin,
  warehouseDirectory,
  warehousePicker,
} from "./fixtures/doors";
import { glossary, type WarehouseActor } from "./fixtures/warehouse";
import { connected } from "./support/session";

/** The warehouse door, recording the path of every procedure the door ran. */
async function warehouse(actor: WarehouseActor = warehouseAdmin) {
  const invoked: string[] = [];
  const door = await connected(
    warehouseDirectory((path) => invoked.push(path)),
    actor,
    glossary,
  );
  return { ...door, invoked };
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (result: Called) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

test("the door offers exactly five tools, in a fixed order, read-only where they read", async () => {
  await using door = await warehouse();
  const { tools } = await door.client.listTools();

  expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
    ["list", { readOnlyHint: true }],
    ["find", { readOnlyHint: true }],
    ["describe", { readOnlyHint: true }],
    ["read", { readOnlyHint: true }],
    ["write", { readOnlyHint: false, destructiveHint: true }],
  ]);
  const write = tools.find((tool) => tool.name === "write");
  expect(write?.description).toContain("Een write wijzigt gegevens: vraag de persoon eerst");
  for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
});

test("read runs only reads and write only writes, each refusal naming the right tool", async () => {
  await using door = await warehouse();
  const asWrite = await door.client.callTool({
    name: "write",
    arguments: { name: "inventory.bySku", input: { sku: "S" } },
  });
  const asRead = await door.client.callTool({
    name: "read",
    arguments: { name: "suppliers.delete", input: { supplierId: 1 } },
  });

  expect(asWrite.isError).toBe(true);
  expect(textOf(asWrite)).toBe(copy.wrongTool("inventory.bySku", "read"));
  expect(textOf(asRead)).toBe(copy.wrongTool("suppliers.delete", "write"));
  expect(door.invoked).toEqual([]);
});

test("the instructions are the host's glossary followed by every area with its count", async () => {
  await using door = await warehouse();
  const instructions = door.client.getInstructions() ?? "";

  expect(instructions.startsWith(`${glossary}\n\n`)).toBe(true);
  expect(instructions).toContain(
    "- counting (4 operaties): completeShelf, countRow, skuRefusal, worklist",
  );
  expect(instructions).toContain(
    "- orders (10 operaties): cancel, claimPicking, get, list, pickupSchedule, releasePicking, reprintLabel, ship, shippingQueue, updatePicking",
  );
  const outline = instructions.slice(glossary.length + 2).split("\n");
  expect(outline.filter((line) => line.startsWith("- "))).toHaveLength(7);
});

test("list without an area answers the areas; with an exact one, its operations", async () => {
  await using door = await warehouse();
  const areas = await door.client.callTool({ name: "list", arguments: {} });
  const listed = z
    .object({
      areas: z.array(z.object({ name: z.string(), summary: z.string(), operations: z.number() })),
    })
    .parse(areas.structuredContent);
  expect(listed.areas).toContainEqual({
    name: "printer",
    summary: "printBarcodeLabel, printBatchStickers, printShelve, printSticker, status",
    operations: 5,
  });

  const printer = await door.client.callTool({ name: "list", arguments: { area: "printer" } });
  expect(printer.structuredContent).toEqual({
    area: "printer",
    operations: [
      {
        name: "printer.printBarcodeLabel",
        kind: "write",
        destructive: true,
        idempotent: false,
        summary: "Print een barcodelabel met een vrije tekst.",
      },
      {
        name: "printer.printBatchStickers",
        kind: "write",
        destructive: true,
        idempotent: false,
        summary: "Print stickers voor meerdere sku's tegelijk.",
      },
      {
        name: "printer.printShelve",
        kind: "write",
        destructive: true,
        idempotent: false,
        summary: "Print het label van een plank.",
      },
      {
        name: "printer.printSticker",
        kind: "write",
        destructive: true,
        idempotent: false,
        summary: "Print een productsticker voor een sku.",
      },
      {
        name: "printer.status",
        kind: "read",
        summary: "Of de labelprinter aan staat en papier heeft.",
      },
    ],
  });
});

test("an area that is not exactly one is refused with the list of areas, however close", async () => {
  await using door = await warehouse();
  for (const area of ["Printer", "printers", "print", " printer"]) {
    const refused = await door.client.callTool({ name: "list", arguments: { area } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      copy.unknownArea(area, [
        "bestellingen",
        "counting",
        "inventory",
        "orders",
        "printer",
        "suppliers",
        "warehouseRelocation",
      ]),
    );
  }
});

test("describe answers the whole operation, its side-effect line included", async () => {
  await using door = await warehouse();
  const described = await door.client.callTool({
    name: "describe",
    arguments: { name: "counting.countRow" },
  });

  expect(described.structuredContent).toMatchObject({
    name: "counting.countRow",
    area: "counting",
    kind: "write",
    destructive: true,
    idempotent: false,
    sideEffect: "de voorraad van die plank wordt de telling.",
    input: {
      type: "object",
      required: ["shelfCode", "sku", "quantity", "idempotencyKey"],
    },
    output: null,
  });
  const bySku = await door.client.callTool({
    name: "describe",
    arguments: { name: "inventory.bySku" },
  });
  expect(bySku.structuredContent).toMatchObject({
    sideEffect: null,
    output: { type: "object", required: ["sku", "total", "shelves"] },
  });
});

test("an operation the program wrote no line for is described by the door's line, and listed with it", async () => {
  await using door = await connected(apiDirectory(), apiCaller);
  const described = await door.client.callTool({
    name: "describe",
    arguments: { name: "product-categories.id.get" },
  });
  const listed = await door.client.callTool({
    name: "list",
    arguments: { area: "product-categories" },
  });

  expect(described.structuredContent).toMatchObject({
    kind: "read",
    destructive: false,
    idempotent: true,
    description: "Leest: product categories id. Invoer: id.",
  });
  expect(listed.structuredContent).toEqual({
    area: "product-categories",
    operations: [
      { name: "product-categories.get", kind: "read", summary: "Leest: product categories." },
      {
        name: "product-categories.id.get",
        kind: "read",
        summary: "Leest: product categories id. Invoer: id.",
      },
    ],
  });
});

test("call answers the program's value as text and as structured content", async () => {
  await using door = await warehouse();
  const result = await door.client.callTool({
    name: "read",
    arguments: { name: "inventory.lastKnownPlaces", input: { sku: "SKU-1" } },
  });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({
    result: [{ shelf: "B1", seenAt: "2026-01-02T00:00:00.000Z" }],
  });
  expect(JSON.parse(textOf(result))).toEqual([{ shelf: "B1", seenAt: "2026-01-02T00:00:00.000Z" }]);
});

test("an input the program's schema rejects answers a tool error carrying the schema's message", async () => {
  await using door = await warehouse();
  const result = await door.client.callTool({
    name: "read",
    arguments: { name: "orders.get", input: { orderId: "1001" } },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe('Expected number, actual "1001"');
  expect(result.structuredContent).toMatchObject({
    refusal: 'Expected number, actual "1001"',
    details: { issues: [{ path: ["orderId"], message: 'Expected number, actual "1001"' }] },
  });
});

test("a misnamed field is refused before the program runs, naming the unknown keys and the allowed ones there", async () => {
  // The program's own validator drops an unknown key without a word, so
  // "statsu" was answered as if no status had been asked for.
  await using door = await warehouse();
  const misnamed = await door.client.callTool({
    name: "read",
    arguments: { name: "orders.list", input: { statsu: "processing" } },
  });

  expect(misnamed.isError).toBe(true);
  expect(door.invoked).toEqual([]);
  const strays = [{ at: "input", unknown: ["statsu"], allowed: ["status", "page"] }];
  expect(textOf(misnamed)).toBe(copy.strayKeys(strays));
  expect(misnamed.structuredContent).toEqual({ refusal: copy.strayKeys(strays), details: strays });

  const correct = await door.client.callTool({
    name: "read",
    arguments: { name: "orders.list", input: { status: "processing" } },
  });
  expect(correct.isError).toBeFalsy();
  expect(door.invoked).toEqual(["orders.list"]);
});

test("a write refused for a stray key still leaves its one write event, as a failure", async () => {
  // Every write leaves one event; the refusal before the program ran left none.
  await using door = await warehouse();
  const refused = await door.client.callTool({
    name: "write",
    arguments: { name: "suppliers.delete", input: { supplierID: 1 } },
  });

  expect(refused.isError).toBe(true);
  expect(door.invoked).toEqual([]);
  expect(door.events).toEqual([
    {
      kind: "write",
      operation: "suppliers.delete",
      sub: "person-1",
      name: "Beheerder Een",
      via: "Claude",
      outcome: "failure",
    },
  ]);
});

test("a misnamed query field on an Elysia route is refused at its part, and a correct one passes", async () => {
  const invoked: string[] = [];
  await using door = await connected(
    apiDirectory((route) => invoked.push(route)),
    apiCaller,
  );
  const misnamed = await door.client.callTool({
    name: "read",
    arguments: { name: "products.get", input: { query: { serach: "rem" } } },
  });

  expect(misnamed.isError).toBe(true);
  expect(invoked).toEqual([]);
  expect(textOf(misnamed)).toBe(
    copy.strayKeys([{ at: "input.query", unknown: ["serach"], allowed: ["search", "page"] }]),
  );
  const correct = await door.client.callTool({
    name: "read",
    arguments: { name: "products.get", input: { query: { search: "rem" } } },
  });
  expect(correct.structuredContent).toEqual({ result: { data: [] } });
  expect(invoked).toEqual(["/api/v1/products/"]);
});

test("a program's own refusal answers a tool error with the program's sentence, and its guard ran", async () => {
  await using door = await warehouse(warehousePicker);
  const result = await door.client.callTool({
    name: "write",
    arguments: { name: "suppliers.delete", input: { supplierId: 1 } },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe("Alleen voor admin");
  expect(door.invoked).toEqual(["suppliers.delete"]);
});

test("an unknown name is answered with the canonical list and runs nothing", async () => {
  await using door = await warehouse();
  const inArea = await door.client.callTool({
    name: "write",
    arguments: { name: "printer.print", input: {} },
  });
  expect(inArea.isError).toBe(true);
  expect(textOf(inArea)).toBe(
    copy.unknownOperation("printer.print", [
      "printer.printBarcodeLabel",
      "printer.printBatchStickers",
      "printer.printShelve",
      "printer.printSticker",
      "printer.status",
    ]),
  );
  const noArea = await door.client.callTool({ name: "describe", arguments: { name: "voorraad" } });
  expect(textOf(noArea)).toBe(
    copy.unknownOperationArea("voorraad", [
      "bestellingen",
      "counting",
      "inventory",
      "orders",
      "printer",
      "suppliers",
      "warehouseRelocation",
    ]),
  );
  for (const name of ["Inventory.bySku", "inventory.bysku", "inventory.bySku ", "bySku"]) {
    expect(
      (await door.client.callTool({ name: "read", arguments: { name, input: { sku: "S" } } }))
        .isError,
    ).toBe(true);
  }
  expect(door.invoked).toEqual([]);
});

test("find executes nothing", async () => {
  await using door = await warehouse();
  for (const words of [
    "zet order op gepickt",
    "verplaats",
    "print label",
    "verwijder leverancier",
    "x",
  ]) {
    await door.client.callTool({ name: "find", arguments: { words } });
  }
  expect(door.invoked).toEqual([]);
});

test("find refuses words past 200 characters or 20 distinct words, and searches nothing", async () => {
  await using door = await warehouse();
  const long = await door.client.callTool({
    name: "find",
    arguments: { words: "plank ".repeat(34) },
  });
  expect(long.isError).toBe(true);
  expect(textOf(long)).toContain("200");

  const many = Array.from(
    { length: 21 },
    (_, index) => `zoek${String.fromCharCode(97 + index)}m`,
  ).join(" ");
  const wide = await door.client.callTool({ name: "find", arguments: { words: many } });
  expect(wide.isError).toBe(true);
  expect(textOf(wide)).toBe(copy.tooManyWords(20));

  const twenty = Array.from(
    { length: 20 },
    (_, index) => `zoek${String.fromCharCode(97 + index)}m`,
  ).join(" ");
  expect(
    (await door.client.callTool({ name: "find", arguments: { words: twenty } })).isError,
  ).toBeFalsy();
  expect(door.invoked).toEqual([]);
});

test("a find that meets nothing says so and names the areas", async () => {
  await using door = await warehouse();
  const result = await door.client.callTool({ name: "find", arguments: { words: "offerte" } });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({
    operations: [],
    message: copy.nothingFound("offerte", [
      "bestellingen",
      "counting",
      "inventory",
      "orders",
      "printer",
      "suppliers",
      "warehouseRelocation",
    ]),
  });
});

test("a write that fails inside the program runs once and says the change may have been made", async () => {
  await using door = await warehouse();
  const result = await door.client.callTool({
    name: "write",
    arguments: { name: "orders.ship", input: { orderId: 9999 } },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(copy.writeUncertain);
  expect(textOf(result)).not.toContain("ECONNREFUSED");
  expect(door.invoked).toEqual(["orders.ship"]);
  expect(
    door.events.map((event) => [event.kind, "outcome" in event ? event.outcome : null]),
  ).toEqual([
    ["failure", null],
    ["write", "unknown"],
  ]);
});

test("an Elysia write that recorded its change and then failed to answer says the change may have been made", async () => {
  const ledger: string[] = [];
  const app = new Elysia()
    .post("/api/v1/refunds", ({ status }) => {
      ledger.push("refund");
      return status(500, "after commit");
    })
    .post("/api/v1/credits", () => {
      ledger.push("credit");
      return new Response("{not json", { headers: { "content-type": "application/json" } });
    });
  await using door = await connected(
    toDirectory(fromElysia(app, { credential, mount: "/api/v1" })),
    apiCaller,
  );
  for (const name of ["refunds.post", "credits.post"]) {
    const result = await door.client.callTool({ name: "write", arguments: { name, input: {} } });
    expect(textOf(result)).toBe(copy.writeUncertain);
  }
  expect(ledger).toEqual(["refund", "credit"]);
  expect(
    door.events
      .filter((event) => event.kind === "write")
      .map((event) => "outcome" in event && event.outcome),
  ).toEqual(["unknown", "unknown"]);
});

test("find indexes a name without its area wherever the host draws areas", async () => {
  const app = new Elysia()
    .get("/api/admin/products/:id", () => 1)
    .get("/api/admin/orders", () => 1);
  const directory = toDirectory(
    fromElysia(app, { credential, mount: "/api", area: (segments) => segments[1] ?? "" }),
  );
  await using door = await connected(directory, apiCaller);
  const found = await door.client.callTool({ name: "find", arguments: { words: "admin" } });

  expect(found.structuredContent).toMatchObject({
    operations: [{ name: "admin.orders.get" }, { name: "admin.products.id.get" }],
  });
  expect(door.client.getInstructions()).toContain("- orders (1 operatie): admin.orders.get");
});

test("an Elysia route that fails with a 5xx answers the door's sentence, and its body stays out", async () => {
  const invoked: string[] = [];
  await using door = await connected(
    apiDirectory((route) => invoked.push(route)),
    apiCaller,
    "",
  );
  const result = await door.client.callTool({
    name: "read",
    arguments: { name: "orders.fail.get", input: {} },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(copy.internalError);
  expect(textOf(result)).not.toContain("database unavailable");
  expect(invoked).toEqual(["/api/v1/orders/fail"]);
});

test("an Elysia route's answer and refusal pass through call", async () => {
  await using door = await connected(apiDirectory(), apiCaller, "");
  const found = await door.client.callTool({
    name: "read",
    arguments: { name: "products.id.get", input: { params: { id: 4 } } },
  });
  expect(found.structuredContent).toEqual({ result: { id: 4, name: "Product", price: 10 } });

  const refused = await door.client.callTool({
    name: "read",
    arguments: { name: "vehicles.lookup.get", input: { query: { license_plate: "00-XX-00" } } },
  });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toBe(
    'HTTP 404: {"error":{"code":"plate_not_found","message":"Kenteken niet gevonden"}}',
  );
  expect(refused.structuredContent).toEqual({
    refusal: textOf(refused),
    details: { error: { code: "plate_not_found", message: "Kenteken niet gevonden" } },
  });
});
