/** A request's session built in a case, with the events it reports kept for the case to read. */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JWTPayload } from "jose";

import { instructionsFor, type Directory } from "../../src/directory";
import { reporter, type KoppelingEvent } from "../../src/events";
import type { Session } from "../../src/run";
import { mcpServer } from "../../src/tools";

export function sessionOf<Actor>(
  directory: Directory<Actor>,
  actor: Actor,
  claims: JWTPayload = { sub: "person-1", name: "Beheerder Een", via: "Claude" },
): { readonly session: Session<Actor>; readonly events: KoppelingEvent[] } {
  const events: KoppelingEvent[] = [];
  return {
    session: { directory, actor, claims, report: reporter((event) => events.push(event)) },
    events,
  };
}

/** An MCP client connected in memory to the session's server. */
export async function connected<Actor>(directory: Directory<Actor>, actor: Actor, glossary = "") {
  const { session, events } = sessionOf(directory, actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcpServer(session, instructionsFor(glossary, directory)).connect(serverSide);
  const client = new Client({ name: "koppeling-test", version: "1" });
  await client.connect(clientSide);
  return {
    client,
    events,
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };
}
