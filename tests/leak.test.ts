import { expect, test } from "bun:test";

import { fromTrpcRouter, koppeling } from "../src/index";
import { warehouseAdmin } from "./fixtures/doors";
import { contextFor, glossary, warehouseRouter } from "./fixtures/warehouse";
import { identityProvider, ISSUER, JWKS_URL, RESOURCE } from "./support/identity";

const toolsCall = (token: string, id: number) =>
  new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "list", arguments: {} },
    }),
  });

// A door that kept anything per request would grow with the requests it
// served; the per-request server it builds must be collected whole.
test("a door's heap does not grow with the requests it answers", async () => {
  using idp = await identityProvider();
  const door = koppeling({
    catalogue: fromTrpcRouter(warehouseRouter(), { contextFor }),
    glossary,
    resource: { url: RESOURCE, scopes: [] },
    identity: { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER },
    actorFor: () => ({ actor: warehouseAdmin }),
  });
  const token = await idp.token({ name: "Beheerder" });
  const serve = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const response = await door.handle(toolsCall(token, index));
      expect(response.status).toBe(200);
      await response.text();
    }
  };
  await serve(200);
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  await serve(2000);
  Bun.gc(true);
  const perRequest = (process.memoryUsage().heapUsed - before) / 2000;

  expect(perRequest).toBeLessThan(1500);
}, 60_000);
