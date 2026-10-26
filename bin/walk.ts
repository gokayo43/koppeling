#!/usr/bin/env bun
/**
 * bin/walk.ts: how an agent meets the fixture programs through the door.
 *
 *     bun run walk
 *
 * Starts both fixture doors in memory, connects an MCP client to each, and for
 * every phrasing in tests/fixtures/phrasings.txt prints what `find` answers
 * and what `list` answers for the area of find's first operation (the area an
 * agent would open next), or the areas when find found nothing. Plain text,
 * one block per phrasing, read in full by a person rather than by a test.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { instructionsFor, type Directory } from "../src/directory";
import { reporter } from "../src/events";
import { mcpServer } from "../src/tools";
import {
  apiCaller,
  apiDirectory,
  warehouseAdmin,
  warehouseDirectory,
} from "../tests/fixtures/doors";
import { glossary } from "../tests/fixtures/warehouse";

async function connect<Actor>(directory: Directory<Actor>, words: string, actor: Actor) {
  const session = { directory, actor, claims: walker, report: reporter(undefined) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcpServer(session, instructionsFor(words, directory)).connect(serverSide);
  const client = new Client({ name: "walk", version: "1" });
  await client.connect(clientSide);
  return client;
}

const walker = { sub: "walk", name: "bin/walk.ts", via: "bin/walk.ts" };
const warehouse = warehouseDirectory();
const api = apiDirectory();
const doors = [
  { name: "warehouse", client: await connect(warehouse, glossary, warehouseAdmin) },
  { name: "api", client: await connect(api, "", apiCaller) },
];

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const Found = z.object({
  operations: z.array(
    z.object({
      name: z.string(),
      area: z.string(),
      kind: z.string(),
      summary: z.string().nullable(),
    }),
  ),
  message: z.string().optional(),
});

const phrasings = (
  await Bun.file(new URL("../tests/fixtures/phrasings.txt", import.meta.url)).text()
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const out: string[] = [];
for (const phrasing of phrasings) {
  out.push(`== ${phrasing}`);
  for (const door of doors) {
    const answer = await door.client.callTool({ name: "find", arguments: { words: phrasing } });
    const found = Found.parse(answer.structuredContent);
    out.push(`-- ${door.name}: find`);
    const operations = found.operations;
    if (operations.length === 0) out.push(`   ${found.message ?? ""}`);
    operations.forEach((operation, rank) =>
      out.push(`   ${rank + 1}. ${operation.name} (${operation.kind}) ${operation.summary ?? ""}`),
    );
    const area = operations[0]?.area;
    const listed = await door.client.callTool({
      name: "list",
      arguments: area === undefined ? {} : { area },
    });
    out.push(`-- ${door.name}: list ${area ?? "(no area)"}`);
    out.push(
      ...textOf(listed)
        .split("\n")
        .map((line) => `   ${line}`),
    );
  }
  out.push("");
}
process.stdout.write(`${out.join("\n")}\n`);
for (const door of doors) await door.client.close();
