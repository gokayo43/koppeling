import { defineConfig } from "drizzle-kit";

// drizzle-kit is used for `generate` only, which never connects, so there are no
// credentials here. Migrations are applied by src/server/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/schema.ts",
  out: "./drizzle",
});
