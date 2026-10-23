/**
 * Every package the scaffolder installs, and which shape gets it. Data only —
 * importing this file runs nothing, which is what lets `setup.test.ts` read the
 * same lists `setup.ts` hands to `bun add` instead of parsing them back out of
 * the scaffolder's source.
 *
 * Versions are absent by design: `bun add --exact` resolves each name at
 * scaffold time under the seven-day release-age policy, so a new repo starts on
 * today's versions. The two entries that state one say why they have to.
 */

// A commit, not a tag: a tag can be repointed, and the repo contract refuses
// any git dependency whose ref is not one.
export const DEV_CONFIG = "github:gokayo43/dev-config#55e57c943d8de9e6120d3fd1a7daf7a70315c581"; // v0.50.0

export const WEB_DEPS = [
  "@tanstack/react-start",
  "@tanstack/react-router",
  "@tanstack/react-router-ssr-query",
  "@tanstack/react-query",
  "@tanstack/react-form",
  "react",
  "react-dom",
  "@base-ui/react",
  "clsx",
  "tailwind-merge",
  "lucide-react",
  "sonner",
  "@fontsource-variable/inter",
  "better-auth",
  "zod",
  "@sentry/tanstackstart-react",
  "posthog-js",
];

/** Only the single-app shape serves its own data; in the monorepo these move to the API. */
export const SERVER_DEPS = ["drizzle-orm", "effect"];

/** The gate itself: one copy at the root, whatever the shape. */
const GATE_DEV_DEPS = [
  DEV_CONFIG,
  "typescript",
  "oxlint",
  "oxlint-tsgolint",
  "oxfmt",
  "knip",
  "eslint-plugin-boundaries",
  "eslint-import-resolver-typescript",
  "lefthook",
  "@commitlint/cli",
  "@commitlint/config-conventional",
  "@types/bun",
];

/** Whatever builds or tests the browser app; lives beside it in the monorepo. */
export const WEB_DEV_DEPS = [
  "vite",
  "nitro",
  "@vitejs/plugin-react",
  "@rolldown/plugin-babel",
  "@babel/core",
  "@types/babel__core",
  "babel-plugin-react-compiler",
  "@tailwindcss/vite",
  "tailwindcss",
  "tw-animate-css",
  "@sentry/vite-plugin",
  "@types/react",
  "@types/react-dom",
  "fast-check",
];

/** Migration generation and the in-process Postgres the schema tests run on. */
export const DB_DEV_DEPS = ["drizzle-kit", "@electric-sql/pglite"];

/**
 * What CI's mutation lane runs on.
 *
 * The core is the one entry here that states a version: left to resolve it
 * takes 10, outside the `^9.0.0` peer range `@hughescr/stryker-bun-runner`
 * declares. Stated outright rather than as a range, because `--exact` pins what
 * it resolved and writes a range through to package.json untouched.
 */
const MUTATION_DEV_DEPS = ["@stryker-mutator/core@9.6.1", "@hughescr/stryker-bun-runner"];

export const API_DEPS = [
  "elysia",
  "@elysiajs/cors",
  "effect",
  "drizzle-orm",
  "better-auth",
  "zod",
  "@sentry/bun",
];
export const WORKER_DEPS = ["effect", "@effect/platform-bun"];

/**
 * The monorepo's task runner. Only that shape has a task graph to run: a single
 * package is `bun run` scripts and nothing else.
 */
const MONOREPO_DEV_DEPS = ["turbo"];
export const EDEN_DEPS = ["@elysiajs/eden"];

/**
 * What each shape installs at the repository root, dev side. Composed here
 * rather than at the call site because it answers a question two files ask: the
 * scaffolder asks what to install, and `setup.test.ts` asks which shape carries
 * the mutation lane's runner. The monorepo's other dependencies go into a
 * workspace, and `installDependencies` is where that lands.
 */
export const rootDevDependencies = {
  single: [...GATE_DEV_DEPS, ...WEB_DEV_DEPS, ...DB_DEV_DEPS, ...MUTATION_DEV_DEPS],
  monorepo: [...GATE_DEV_DEPS, ...MONOREPO_DEV_DEPS],
};
