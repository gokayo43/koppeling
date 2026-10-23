// oxlint-disable no-console -- a one-shot CLI program; stdout is its only interface
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

// drizzle-kit's own `migrate` command cannot drive the bun-sql driver — it only
// knows pg/postgres/neon/vercel — so applying migrations is this program, and
// drizzle-kit is used for `generate` alone.
//
// It reads DATABASE_URL directly rather than src/server/env.ts: the compose
// migrate service is deliberately given the database and nothing else, and the
// app's env contract would demand secrets a migration has no business holding.
const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new SQL(url);
try {
  await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
} catch (cause) {
  // This program's own error surface. The exit code is what compose's
  // `service_completed_successfully` reads, and this line is what `docker logs`
  // shows whoever has to fix it — rather than an unhandled rejection whose
  // wording belongs to whichever driver version is installed.
  console.error("migrations failed:", cause);
  process.exit(1);
}
await client.close();
console.log("migrations applied");
