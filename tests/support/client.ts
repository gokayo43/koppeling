/** An MCP client that reaches a door's `handle` in process, bearing one token. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { RESOURCE } from "./identity";

export async function clientOf(
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
