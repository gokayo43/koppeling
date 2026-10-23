import { Data } from "effect";

/** The database refused or failed a statement. */
export class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}

/** Redis refused or failed a command. */
export class RedisError extends Data.TaggedError("RedisError")<{ readonly cause: unknown }> {}

/** The requested entity does not exist. */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}
