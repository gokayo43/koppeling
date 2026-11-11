/** A door built in a case, keeping what it asked `actorFor` and every event it reported. */
import {
  fromTrpcRouter,
  koppeling,
  type ActorDecision,
  type Catalogue,
  type Json,
  type KoppelingEvent,
} from "../../src/index";
import { warehouseAdmin } from "../fixtures/doors";
import { contextFor, glossary, warehouseRouter, type WarehouseActor } from "../fixtures/warehouse";
import { ISSUER, JWKS_URL, RESOURCE } from "./identity";

export function recordingDoor<Actor>(
  catalogue: Catalogue<Actor>,
  decide: () => ActorDecision<Actor>,
) {
  const asked: unknown[] = [];
  const events: KoppelingEvent[] = [];
  const door = koppeling({
    catalogue,
    glossary,
    resource: { url: RESOURCE, scopes: ["koppeling"] },
    identity: { issuer: ISSUER, jwksUrl: JWKS_URL, authorizationServer: ISSUER },
    actorFor: (claims) => {
      asked.push(claims);
      return decide();
    },
    log: (event) => events.push(event),
  });
  return { door, asked, events };
}

/** The warehouse fixture behind a recording door, counting what it ran. */
export function warehouseDoor(
  decide: () => ActorDecision<WarehouseActor> = () => ({ actor: warehouseAdmin }),
) {
  const invoked: string[] = [];
  const recorded = recordingDoor(
    fromTrpcRouter(
      warehouseRouter((path) => invoked.push(path)),
      { contextFor },
    ),
    decide,
  );
  return { ...recorded, invoked };
}

/** One JSON-RPC message posted to the door, bearing `token` when given. */
export const jsonRpcPost = (
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
