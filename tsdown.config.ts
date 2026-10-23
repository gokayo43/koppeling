import { defineConfig } from "tsdown";

/**
 * The package as a host installs it: one ESM bundle and one rolled-up
 * declaration file under `dist/`, both committed (CLAUDE.md says why).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
  // A dependency or peer is an import, never bundled; this is the list the
  // emitted bundle may name at all, so a dependency added without a ruling
  // fails the build. The peers are imported for their types alone.
  deps: {
    onlyImport: ["@modelcontextprotocol/server", "effect", "jose", "@trpc/server", "elysia"],
  },
  // Nothing here is published to a registry: a host installs the git repo.
  publint: false,
  attw: false,
});
