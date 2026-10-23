import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { Effect } from "effect";

import { env } from "./env.ts";
import { DbError } from "./errors.ts";
import { schemaProbe } from "./probe.ts";
import * as schema from "./schema.ts";

// Better Auth's Drizzle adapter takes an instance directly rather than through
// a layer, so the client is a module singleton and the Effect service below
// accepts it instead of opening a second pool.
const client = new SQL(env.DATABASE_URL);

export const db = drizzle({ client, schema });

/** The database as an Effect service: the same instance, with typed failures. */
export class Db extends Effect.Service<Db>()("Db", {
  succeed: {
    db,
    /** Round-trips the schema probe: the connection is live and carries this schema. */
    ping: Effect.tryPromise({
      try: () => schemaProbe(db),
      catch: (cause) => new DbError({ cause }),
    }),
  },
}) {}
