import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { user } from "./schema.ts";

/**
 * What a health check has to prove. Reaching Postgres is not the claim worth
 * making: `select 1` answers just as happily from a database with no tables in
 * it, so an app that booted before its migrations ran reports itself healthy.
 * Reading a migrated table's own columns fails loudly instead — a missing table
 * and a dropped column both surface here — which is what makes a health 200 an
 * assertion that the schema module is the schema the database has.
 *
 * Its own module rather than a helper in `schema.ts`, for two reasons that
 * point the same way: that file is a declaration the coverage gate is told to
 * ignore, and every one of its exports is handed to drizzle and to Better Auth
 * as the schema itself.
 *
 * Typed against drizzle's driver-independent database, so the deployed app can
 * hand it Bun's SQL pool and the suite can hand it PGlite, and the statement
 * they run is the same one.
 */
/**
 * Drizzle's own second type argument: the schema map it was built with, whose
 * keys are whatever a caller passed. It is the boundary this module is typed
 * against rather than a dictionary of ours, and narrowing it here would name
 * one caller's schema and refuse every other.
 */
// oxlint-disable-next-line typescript/no-restricted-types, anti-slop/no-unsafe-dictionary-type -- see above
type DrizzleSchema = Record<string, unknown>;

export const schemaProbe = async (
  database: PgDatabase<PgQueryResultHKT, DrizzleSchema>,
): Promise<void> => {
  await database.select().from(user).limit(1).execute();
};
