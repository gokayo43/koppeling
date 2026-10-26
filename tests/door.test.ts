import { expect, setSystemTime, test } from "bun:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { copy } from "../src/copy";
import { fromTrpcRouter, koppeling, type ActorDecision, type KoppelingEvent } from "../src/index";
import { warehouseAdmin } from "./fixtures/doors";
import { contextFor, glossary, warehouseRouter, type WarehouseActor } from "./fixtures/warehouse";
import { identityProvider, ISSUER, JWKS_URL, RESOURCE } from "./support/identity";

/** A door over the warehouse fixture that counts what it asked `actorFor` and what it ran. */
function warehouseDoor(
  decide: () => ActorDecision<WarehouseActor> = () => ({ actor: warehouseAdmin }),
) {
  const asked: unknown[] = [];
  const invoked: string[] = [];
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
  });
  return { door, asked, invoked };
}

const mcpPost = (token: string | undefined) =>
  new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    }),
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
