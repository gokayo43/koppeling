import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Source maps are uploaded only when the deploy supplies a token, so a local or
// CI build reaches no third party and needs no account.
const sentryAuthToken = process.env["SENTRY_AUTH_TOKEN"];
const sentryOrg = process.env["SENTRY_ORG"];
const sentryProject = process.env["SENTRY_PROJECT"];
const uploadSourcemaps =
  sentryAuthToken !== undefined && sentryOrg !== undefined && sentryProject !== undefined;

const devPort = process.env["DEV_PORT"];

// TanStack Start emits an SSR handler bundle; nitro() turns it into a runnable
// server under .output/ — there is no hand-rolled adapter. React Compiler runs
// as a Babel preset over the Rolldown pipeline, which is the only path
// @vitejs/plugin-react 6 exposes: it no longer accepts a `babel` option.
export default defineConfig({
  // tsconfig's `paths` is a compiler fact; the dev server resolves imports
  // itself and knows nothing about it. The build happened to work without this
  // and `bun run dev` did not — every `~/` import failed at request time — and
  // CI never noticed because CI only ever builds.
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  // DEV_PORT is the port scripts/worktree.ts derived, and SITE_URL is the origin
  // it derived from the same number — so this port is the one the app tells the
  // browser to come to. strictPort always, because vite's own fallback moves the
  // server and nothing moves the origin with it: the browser then reaches a
  // server the app does not recognise, and every sign-in is a 403 with no
  // allow-origin header. Refusing to start says which port is taken; the wrapper
  // takes DEV_PORT for the answer, and derives the origin to match.
  server: {
    port: Number(devPort ?? 5180),
    host: "127.0.0.1",
    strictPort: true,
  },
  // `bun` is a runtime builtin with no package behind it, so Rolldown fails the
  // build rather than leaving the import alone. Drizzle's bun-sql driver imports
  // it, which is what makes this server bundle require Bun — Nitro's own output
  // is a plain node-server.
  build: { rolldownOptions: { external: ["bun"] }, sourcemap: uploadSourcemaps },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
    nitro(),
    ...(uploadSourcemaps
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: sentryOrg,
            project: sentryProject,
          }),
        ]
      : []),
  ],
});
