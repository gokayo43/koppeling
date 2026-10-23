import { Data } from "effect";

/** The database refused or failed a statement. */
export class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}
