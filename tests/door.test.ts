import { expect, setSystemTime, test } from "bun:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet } from "jose";

import { copy } from "../src/copy";
import {
  fromTrpcRouter,
  koppeling,
  type ActorDecision,
  type Admission,
  type Identity,
  type Json,
  type KoppelingEvent,
} from "../src/index";
import { warehouseAdmin } from "./fixtures/doors";
import { contextFor, glossary, warehouseRouter, type WarehouseActor } from "./fixtures/warehouse";
import { identityProvider, ISSUER, JWKS_URL, RESOURCE } from "./support/identity";

/** A door over the warehouse fixture that counts what it asked `actorFor` and what it ran. */
function warehouseDoor(
  decide: () => ActorDecision<WarehouseActor> = () => ({ actor: warehouseAdmin }),
) {
  const asked: unknown[] = [];
  const invoked: string[] = [];
  const events: KoppelingEvent[] = [];
  const door = koppeling({
    catalogue: fromTrpcRouter(
      warehouseRouter((path) => invoked.push(path)),
      { contextFor },
    ),
    glossary,
    resource: { url: RESOURCE, scopes: ["koppeling"] },
    identity: { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER },
    actorFor: (claims) => {
      asked.push(claims);
      return decide();
    },
    log: (event) => events.push(event),
  });
  return { door, asked, invoked, events };
}

const METADATA_URL = "https://wms.example/.well-known/oauth-protected-resource/api/mcp";

const jsonRpcPost = (
  token: string | undefined,
  message: { readonly method: string; readonly params?: Json },
) =>
  new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
  });

const mcpPost = (token: string | undefined) =>
  jsonRpcPost(token, {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe", version: "1" },
    },
  });

async function clientOf(
  handle: (request: Request) => Promise<Response>,
  token: string,
  era: "legacy" | "modern",
) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => handle(new Request(String(url), init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "door-test", version: "1" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(transport);
  return client;
}

for (const era of ["legacy", "modern"] as const) {
  test(`a valid token reaches call, over the ${era} protocol`, async () => {
    using idp = await identityProvider();
    const { door, asked, invoked } = warehouseDoor();
    const client = await clientOf(door.handle, await idp.token(), era);

    expect(client.getInstructions()).toStartWith(glossary);
    const result = await client.callTool({
      name: "read",
      arguments: { name: "inventory.bySku", input: { sku: "SKU-1" } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      result: { sku: "SKU-1", total: 7, shelves: [{ shelf: "A3", quantity: 7 }] },
    });
    expect(invoked).toEqual(["inventory.bySku"]);
    expect(asked.length).toBeGreaterThan(0);
    await client.close();
  });
}

test("a request without a bearer answers 401 naming the metadata document", async () => {
  const { door, asked } = warehouseDoor();
  const response = await door.handle(mcpPost(undefined));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="https://wms.example/.well-known/oauth-protected-resource/api/mcp"',
  );
  expect(asked).toEqual([]);
});

test("a token for another resource is refused before actorFor is asked", async () => {
  using idp = await identityProvider();
  const { door, asked } = warehouseDoor();
  const response = await door.handle(
    mcpPost(await idp.token({}, { audience: "https://other.example/api/mcp" })),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect(asked).toEqual([]);
});

test("an expired token is refused", async () => {
  using idp = await identityProvider();
  const { door, asked } = warehouseDoor();
  const response = await door.handle(mcpPost(await idp.token({}, { expiresIn: -60 })));

  expect(response.status).toBe(401);
  expect(asked).toEqual([]);
});

test("a token from another issuer is refused", async () => {
  using idp = await identityProvider();
  const { door, asked } = warehouseDoor();
  const response = await door.handle(
    mcpPost(await idp.token({}, { issuer: "https://elsewhere.example" })),
  );

  expect(response.status).toBe(401);
  expect(asked).toEqual([]);
});

test("an unknown key id fetches the key set once more, and then verifies", async () => {
  using idp = await identityProvider();
  const { door } = warehouseDoor();
  const start = Date.now();
  try {
    expect((await door.handle(mcpPost(await idp.token()))).status).toBe(200);
    expect(idp.served.count).toBe(1);

    await idp.rotate("second");
    // A token with the new key within the refetch cool-down is refused
    // without a fetch; past it (5 s) the door fetches once and verifies.
    setSystemTime(new Date(start + 1_000));
    expect((await door.handle(mcpPost(await idp.token({}, { kid: "second" })))).status).toBe(401);
    expect(idp.served.count).toBe(1);
    setSystemTime(new Date(start + 6_000));
    expect(await door.handle(mcpPost(await idp.token({}, { kid: "second" })))).toHaveProperty(
      "status",
      200,
    );
    expect(idp.served.count).toBe(2);

    expect(await door.handle(mcpPost(await idp.token({}, { kid: "second" })))).toHaveProperty(
      "status",
      200,
    );
    expect(idp.served.count).toBe(2);
  } finally {
    setSystemTime();
  }
});

test("a person the host refuses is served MCP that says why, in its instructions and every tool", async () => {
  using idp = await identityProvider();
  const sentence = "Koppel eerst je magazijnaccount: plak dit nummer bij je profiel.";
  const { door, invoked } = warehouseDoor(() => ({ refusal: sentence }));
  const client = await clientOf(door.handle, await idp.token(), "legacy");

  expect(client.getInstructions()).toBe(sentence);
  for (const [name, args] of [
    ["list", {}],
    ["find", { words: "voorraad" }],
    ["describe", { name: "inventory.bySku" }],
    ["read", { name: "inventory.bySku", input: { sku: "S" } }],
    ["write", { name: "suppliers.delete", input: { supplierId: 1 } }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: sentence }]);
  }
  expect(invoked).toEqual([]);
  await client.close();
});

test("a refused person's request that is not MCP at all answers 403 with the host's sentence", async () => {
  using idp = await identityProvider();
  const { door } = warehouseDoor(() => ({ refusal: "Je hebt geen toegang tot het magazijn." }));
  const response = await door.handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${await idp.token()}`, "content-type": "text/plain" },
      body: "hallo",
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Je hebt geen toegang tot het magazijn." });
});

test("a token without exp, or without sub, is refused before actorFor is asked", async () => {
  using idp = await identityProvider();
  const { door, asked } = warehouseDoor();
  for (const without of ["exp", "sub"] as const) {
    const response = await door.handle(
      mcpPost(await idp.token({ name: "x" }, { without: [without] })),
    );
    expect(response.status).toBe(401);
  }
  expect(asked).toEqual([]);
});

test("the host's logger receives each write, with its person and program, and each failure", async () => {
  using idp = await identityProvider();
  const events: KoppelingEvent[] = [];
  const door = koppeling({
    catalogue: fromTrpcRouter(warehouseRouter(), { contextFor }),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity: { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER },
    actorFor: () => ({ actor: warehouseAdmin }),
    log: (event) => events.push(event),
  });
  const client = await clientOf(
    door.handle,
    await idp.token({ name: "Beheerder Een", via: "Claude" }),
    "modern",
  );
  await client.callTool({
    name: "write",
    arguments: { name: "printer.printShelve", input: { shelfCode: "A3" } },
  });
  await client.callTool({
    name: "write",
    arguments: { name: "orders.ship", input: { orderId: 9999 } },
  });
  await client.callTool({
    name: "read",
    arguments: { name: "inventory.bySku", input: { sku: "S" } },
  });

  expect(
    events.map((event) =>
      event.kind === "write" ? event : { kind: event.kind, operation: event.operation },
    ),
  ).toEqual([
    {
      kind: "write",
      operation: "printer.printShelve",
      sub: "person-1",
      name: "Beheerder Een",
      via: "Claude",
      outcome: "value",
    },
    { kind: "failure", operation: "orders.ship" },
    {
      kind: "write",
      operation: "orders.ship",
      sub: "person-1",
      name: "Beheerder Een",
      via: "Claude",
      outcome: "unknown",
    },
  ]);
  await client.close();
});

test("an actorFor that rejects answers 503 with the door's sentence, not the host's error", async () => {
  using idp = await identityProvider();
  const door = koppeling({
    catalogue: fromTrpcRouter(warehouseRouter(), { contextFor }),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity: { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER },
    actorFor: async () => {
      throw new Error("connect ECONNREFUSED 10.8.0.1:3306");
    },
  });
  const response = await door.handle(mcpPost(await idp.token()));
  const body = await response.text();

  expect(response.status).toBe(503);
  expect(body).toBe(JSON.stringify({ error: copy.personUnreachable }));
  expect(body).not.toContain("ECONNREFUSED");
});

test("a key set the door cannot fetch answers 503, not 401", async () => {
  using idp = await identityProvider();
  idp.served.reachable = false;
  const { door, asked } = warehouseDoor();
  const response = await door.handle(mcpPost(await idp.token()));

  expect(response.status).toBe(503);
  expect(asked).toEqual([]);
});

test("a door given the host's keys verifies with them and fetches nothing", async () => {
  // The likeliest wrong still builds the remote key set and asks it, so the
  // host's self-fetch stays; the provider is unreachable here, so any fetch
  // answers 503.
  using idp = await identityProvider();
  idp.served.reachable = false;
  const keys = createLocalJWKSet(idp.jwks());
  await idp.rotate("unheld");
  const door = koppeling({
    catalogue: fromTrpcRouter(warehouseRouter(), { contextFor }),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity: { issuer: ISSUER, keys, authorizationServer: ISSUER },
    actorFor: () => ({ actor: warehouseAdmin }),
  });

  expect((await door.handle(mcpPost(await idp.token({}, { kid: "first" })))).status).toBe(200);
  const unheld = await door.handle(mcpPost(await idp.token({}, { kid: "unheld" })));
  expect(unheld.status).toBe(401);
  expect(unheld.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect(idp.served.count).toBe(0);
});

// A host gives the door its keys or where to fetch them, never both: the
// likeliest wrong makes both optional, so a host passing both cannot tell
// which one the door uses. The type carries the check, so `tsc` grades it.
// @ts-expect-error -- keys and jwksUrl are two answers to one question
const bothKeysAndUrl: Identity = {
  issuer: ISSUER,
  keys: createLocalJWKSet({ keys: [] }),
  jwksUrl: JWKS_URL,
  authorizationServer: ISSUER,
};
void bothKeysAndUrl;

test("a method other than POST answers 405 without asking for a token", async () => {
  const { door } = warehouseDoor();
  const response = await door.handle(
    new Request(RESOURCE, { headers: { accept: "text/event-stream" } }),
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
});

test("the protected resource metadata document names the portal, the resource and the scopes", async () => {
  const { door } = warehouseDoor();
  const response = door.metadata(
    new Request("https://wms.example/.well-known/oauth-protected-resource/api/mcp"),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ["koppeling"],
    bearer_methods_supported: ["header"],
  });
  expect(door.metadata(new Request(RESOURCE, { method: "POST" })).status).toBe(405);
});

test("the boot report counts each area's operations and names what was skipped", () => {
  const { door } = warehouseDoor();

  expect(door.report).toEqual({
    areas: {
      bestellingen: 7,
      counting: 4,
      inventory: 4,
      orders: 10,
      printer: 5,
      suppliers: 7,
      warehouseRelocation: 4,
    },
    skipped: [{ name: "orders.onChange", reason: "subscription, which the door does not serve" }],
    undescribed: [],
  });
});

test("a person is offered only what the host's allows admits: listed, found, described and run", async () => {
  // The likeliest wrong filters the list alone, so a name the person was not
  // shown still runs when typed, or still answers describe and find.
  using idp = await identityProvider();
  const { door, invoked } = warehouseDoor(() => ({
    actor: warehouseAdmin,
    allows: (operation) => operation.area !== "suppliers" && operation.name !== "orders.cancel",
  }));
  const client = await clientOf(door.handle, await idp.token(), "modern");

  expect(client.getInstructions()).not.toContain("- suppliers");
  const areas = await client.callTool({ name: "list", arguments: {} });
  expect(JSON.stringify(areas.structuredContent)).not.toContain("suppliers");
  const orders = await client.callTool({ name: "list", arguments: { area: "orders" } });
  expect(JSON.stringify(orders.structuredContent)).not.toContain("orders.cancel");
  const found = await client.callTool({ name: "find", arguments: { words: "leverancier" } });
  expect(JSON.stringify(found.structuredContent)).not.toContain("suppliers.");
  const described = await client.callTool({
    name: "describe",
    arguments: { name: "suppliers.delete" },
  });
  expect(described.isError).toBe(true);

  const refused = await client.callTool({
    name: "write",
    arguments: { name: "orders.cancel", input: { orderId: 1 } },
  });
  expect(refused.isError).toBe(true);
  const text = refused.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  expect(text.join("")).toStartWith(
    'Onbekende operatie "orders.cancel". Kies een naam uit deze lijst:',
  );
  expect(text.join("")).not.toContain('"orders.cancel",');
  expect(invoked).toEqual([]);
  await client.close();
});

test("an allows that throws answers 503 with the door's sentence, as an actorFor that rejects does", async () => {
  using idp = await identityProvider();
  const { door } = warehouseDoor(() => ({
    actor: warehouseAdmin,
    allows: () => {
      throw new Error("permissions table unreachable");
    },
  }));
  const response = await door.handle(mcpPost(await idp.token()));

  expect(response.status).toBe(503);
  expect(await response.text()).toBe(JSON.stringify({ error: copy.personUnreachable }));
});

test("a host's signIn answers 401 invalid_token with its sentence, the header's copy kept to RFC 6750's characters", async () => {
  // The likeliest wrong answers it in MCP as a refusal is answered, which no
  // client signs in again on; the next copies the sentence into the header
  // as it is, where its quotes end the value early.
  using idp = await identityProvider();
  const sentence =
    'Wissel je "koppelingstoken" eerst in bij https://portal.example/koppeling\\inwisselen, één keer.';
  const { door, invoked } = warehouseDoor(() => ({ signIn: sentence }));
  const response = await door.handle(mcpPost(await idp.token()));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="Wissel je koppelingstoken eerst in bij https://portal.example/koppelinginwisselen, een keer."`,
  );
  expect(await response.json()).toEqual({ error: sentence });
  expect(invoked).toEqual([]);
});

test("an operation under a scope is listed and described with it, and its read or write answers 403 insufficient_scope, running nothing", async () => {
  // The likeliest wrong hides it as allows' false does, so the person's
  // program never learns that signing in again would give it; the next
  // refuses it inside MCP, where no client signs in again.
  using idp = await identityProvider();
  const { door, invoked, events } = warehouseDoor(() => ({
    actor: warehouseAdmin,
    allows: (operation) => {
      if (operation.name === "orders.get") return { scope: "orders:lezen" };
      if (operation.name === "orders.cancel") return { scope: "orders:schrijven orders:lezen" };
      return true;
    },
  }));
  const token = await idp.token();
  const client = await clientOf(door.handle, token, "modern");

  const listed = await client.callTool({ name: "list", arguments: { area: "orders" } });
  expect(JSON.stringify(listed.structuredContent)).toContain('"orders.cancel"');
  expect(JSON.stringify(listed.structuredContent)).toContain('"orders.get"');
  const found = await client.callTool({ name: "find", arguments: { words: "order annuleren" } });
  expect(JSON.stringify(found.structuredContent)).toContain('"orders.cancel"');
  const described = await client.callTool({ name: "describe", arguments: { name: "orders.get" } });
  expect(described.structuredContent).toMatchObject({ name: "orders.get", scope: "orders:lezen" });
  const unscoped = await client.callTool({
    name: "read",
    arguments: { name: "inventory.bySku", input: { sku: "SKU-1" } },
  });
  expect(unscoped.isError).toBeFalsy();
  const stepUp = await client
    .callTool({ name: "write", arguments: { name: "orders.cancel", input: { orderId: 1 } } })
    .then(
      () => "answered",
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever the client rejected with
      (error: unknown) => String(error),
    );
  expect(stepUp).toBe(
    'InsufficientScopeError: Insufficient scope: required "orders:schrijven orders:lezen"',
  );
  expect(invoked).toEqual(["inventory.bySku"]);
  await client.close();

  const call = (tool: "read" | "write", name: string, input: Json) =>
    door.handle(
      jsonRpcPost(token, {
        method: "tools/call",
        params: { name: tool, arguments: { name, input } },
      }),
    );
  const read = await call("read", "orders.get", { orderId: 1 });
  expect(read.status).toBe(403);
  expect(read.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${METADATA_URL}", error="insufficient_scope", scope="orders:lezen"`,
  );
  expect(await read.json()).toEqual({ error: copy.scopeAwaited(["orders:lezen"]) });
  const write = await call("write", "orders.cancel", { orderId: 1 });
  expect(write.status).toBe(403);
  expect(write.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${METADATA_URL}", error="insufficient_scope", scope="orders:schrijven orders:lezen"`,
  );
  expect(invoked).toEqual(["inventory.bySku"]);
  expect(events).toEqual([]);
});

test("a scope outside RFC 6750's characters answers 503 and reports which operation allows gave it to", async () => {
  using idp = await identityProvider();
  const { door, events } = warehouseDoor(() => ({
    actor: warehouseAdmin,
    allows: (operation) => (operation.name === "orders.get" ? { scope: 'orders "lezen"' } : true),
  }));
  const response = await door.handle(mcpPost(await idp.token()));

  expect(response.status).toBe(503);
  expect(events).toMatchObject([{ kind: "failure", operation: null }]);
  expect(String(events[0]?.kind === "failure" && events[0].cause)).toContain('"orders.get"');
});

test("an allows answer that is neither true, false nor a scope string answers 503 and runs nothing", async () => {
  // The likeliest wrong reads anything but true and false as { scope }, so
  // { scope: undefined } (a lookup missing its key) stores no scope and the
  // operation runs, and 0 is listed and run where the old filter hid it.
  using idp = await identityProvider();
  const token = await idp.token();
  const answers: readonly unknown[] = [{ scope: undefined }, 0];
  for (const answer of answers) {
    const { door, invoked, events } = warehouseDoor(() => ({
      actor: warehouseAdmin,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an answer its type forbids, as a cast or a missing key gives one
      allows: (operation) => (operation.area === "suppliers" ? (answer as Admission) : true),
    }));
    const response = await door.handle(
      jsonRpcPost(token, {
        method: "tools/call",
        params: {
          name: "write",
          arguments: { name: "suppliers.delete", input: { supplierId: 1 } },
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(invoked).toEqual([]);
    expect(events).toMatchObject([{ kind: "failure", operation: null }]);
    expect(String(events[0]?.kind === "failure" && events[0].cause)).toContain('"suppliers.');
  }
});

test("a body past the SDK's 4 MiB is answered 413 having read no further, at a door that awaits a scope and for a refused person alike", async () => {
  // The likeliest wrong reads the whole body before the SDK's own limit
  // applies, so an endless body holds the door's memory until it dies; this one
  // ends at 16 MiB so the unbounded read finishes.
  using idp = await identityProvider();
  const token = await idp.token();
  const CHUNK = 64 * 1024;
  const decisions: readonly (() => ActorDecision<WarehouseActor>)[] = [
    () => ({
      actor: warehouseAdmin,
      allows: (operation) =>
        operation.name === "orders.cancel" ? { scope: "orders:schrijven" } : true,
    }),
    () => ({ refusal: "Je hebt geen toegang tot het magazijn." }),
  ];
  for (const decide of decisions) {
    const { door } = warehouseDoor(decide);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 16 * 1024 * 1024) return controller.close();
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
    });
    const response = await door.handle(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: endless,
      }),
    );

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(4 * 1024 * 1024 + 4 * CHUNK);
  }
});

test("a body that is no JSON reaches the SDK as its text, which answers it in its own words", async () => {
  using idp = await identityProvider();
  const { door, invoked } = warehouseDoor();
  const response = await door.handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await idp.token()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: '{"jsonrpc": "2.0", "id": 1, "method": "tools/ca',
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  expect(invoked).toEqual([]);
});
