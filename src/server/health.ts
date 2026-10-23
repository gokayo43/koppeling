import { Effect } from "effect";

import { Db } from "./db.ts";
import { runtime } from "./runtime.ts";

/** What this endpoint answers with, and the only thing `json` below serialises. */
interface Health {
  readonly status: "ok" | "degraded";
}

const json = (status: number, body: Health): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Readiness for the container healthcheck and the uptime probe. 200 says this
 * instance can serve: the database answered *and* it carries the schema this
 * code queries, so an app that started before its migrations ran reports
 * degraded rather than healthy. Anything else answers 503, so an orchestrator
 * stops routing here instead of serving errors from it.
 */
export const healthResponse = (): Promise<Response> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Db;
      yield* database.ping;
      return json(200, { status: "ok" });
    }).pipe(
      Effect.catchTag("DbError", (error) =>
        Effect.logError("health: the schema probe failed", error).pipe(
          Effect.as(json(503, { status: "degraded" })),
        ),
      ),
    ),
  );
