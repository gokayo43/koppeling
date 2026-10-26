import { defineConfig, type Rolldown } from "tsdown";

/**
 * The keys Effect 3 claims on `globalThis`: its store of global values and
 * its current fiber, the only two (every other `globalThis` use in
 * `effect/dist/esm` reads a builtin). Under Effect's names, the bundled copy
 * and a host's own Effect 3 would share one store, each running effects the
 * other made and logging "Executing an Effect versioned …" on every step, so
 * the bundled copy declares them under its own. Its `Symbol.for` type
 * identifiers stay Effect's: they are how a host's schema is recognised.
 */
const OWN_GLOBALS = [
  {
    module: "effect/dist/esm/GlobalValue.js",
    effect: "const globalStoreId = `effect/GlobalValue`;",
    own: "const globalStoreId = `koppeling/GlobalValue`;",
  },
  {
    module: "effect/dist/esm/internal/fiber.js",
    effect: 'export const currentFiberURI = "effect/FiberCurrent";',
    own: 'export const currentFiberURI = "koppeling/FiberCurrent";',
  },
] as const;

/** Renames each of {@link OWN_GLOBALS} where Effect declares it, and fails the build where Effect moved one. */
function ownGlobals(): Rolldown.Plugin {
  const renamed = new Set<string>();
  return {
    name: "koppeling-own-effect-globals",
    transform(code, id) {
      const global = OWN_GLOBALS.find(({ module }) => id.endsWith(`/node_modules/${module}`));
      if (global === undefined) return null;
      if (code.split(global.effect).length !== 2) {
        throw new Error(
          `${global.module} no longer declares ${global.effect}: re-read Effect's globals`,
        );
      }
      renamed.add(global.module);
      return code.replace(global.effect, global.own);
    },
    generateBundle() {
      const missing = OWN_GLOBALS.filter(({ module }) => !renamed.has(module));
      if (missing.length) {
        throw new Error(
          `The bundle took none of ${missing.map(({ module }) => module).join(", ")}: re-read Effect's globals`,
        );
      }
    },
  };
}

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
    onlyImport: ["@modelcontextprotocol/server", "jose", "@trpc/server", "elysia"],
    alwaysBundle: ["effect"],
    onlyBundle: ["effect"],
  },
  plugins: [ownGlobals()],
  // Nothing here is published to a registry: a host installs the git repo.
  publint: false,
  attw: false,
});
