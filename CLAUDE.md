# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

A library, not an app: it serves nothing on its own, listens on nothing and owns
no data. A host program mounts it to offer its own operations over MCP to the
signed-in office person's agent. The hosts are gokayo43/nfp-elysia (Elysia),
A1M4N3/wmstcs (tRPC), and later A1M4N3/Bedrijfs-Portaal, which is also the
identity provider whose JWTs every koppeling verifies (its tRPC move is
A1M4N3/Bedrijfs-Portaal#627). Work tracking is GitHub issues in
`gokayo43/koppeling`.

- `CONTEXT.md`: the glossary.
- `README.md`: the consumer contract, the exported interface stated in full.

## Layout

- `src/catalogue.ts`: the operation type and the one function every adapter
  ends in; it holds every name to MCP's characters and to uniqueness, sorts,
  and collects what the boot report names.
- `src/adapters/trpc.ts`, `src/adapters/elysia.ts`: a program to a catalogue.
  Plain TypeScript; the door imports neither (the boundaries rule says so).
- `src/schema.ts`: a program's schema, in Effect Schema, TypeBox or Standard
  JSON Schema, to JSON Schema.
- `src/find.ts`: the ranking behind `find`.
- `src/tools.ts`: the four tools and the MCP server for one request.
- `src/auth.ts`, `src/door.ts`: the bearer check and `koppeling()`, the HTTP
  edge, in Effect.
- `src/copy.ts`: every sentence a person may read, in Dutch.
- `tests/fixtures/`: a warehouse router shaped like wmstcs's and an API app
  shaped like nfp-elysia's, with invented values only; the suite and
  `bin/walk.ts` both run them.

## How it is built

`bun run build` is `bin/build.ts`: tsdown writes `dist/index.js` and one
rolled-up `dist/index.d.ts`, both committed, because a host installs this repo
by git ref and builds nothing (STACK.md, Built exports).
`tests/dist-freshness.test.ts` builds into a directory of its own and compares,
which is why CI does not pass `build: true`. There is no `prepare` script:
`bun run hooks` installs the git hooks after a clone.

## Gotchas

- **tRPC's `router._def.procedures`, `_def.type`, `_def.inputs`, `_def.output`
  and `_def.meta` are internals, not a published API**, written against
  `@trpc/server` 11.19.0. The ecosystem (OpenAPI generators, tRPC panels) reads
  them the same way, and `src/adapters/trpc.ts` checks their shape and fails the
  boot when a release moves them. Re-run the suite on every tRPC bump. A router
  with lazy sub-routers fails the boot: their procedures exist only once loaded.
- **Elysia finds a request's path by searching for `/` from index 11 of its
  URL**, so a request built on a short origin (`http://x`) answers 404 on every
  route; the adapter builds on `http://localhost`.
- **The JWKS URL is separate from the issuer** because a host beside the
  portal (the warehouse, on the same garage box) cannot fetch the portal's
  public hostname: Cloudflare's Bot Fight Mode on garagetcs.nl challenges a bare
  HTTP client. It fetches the key set over the garage network while every token
  still names the public origin as `iss`.
- **The portal issues no JWT access tokens yet.** Its OAuth provider (Better
  Auth's `oidcProvider`) hands out opaque tokens, and a koppelingstoken is
  opaque too; the move that brings the `jwt` plugin is
  A1M4N3/Bedrijfs-Portaal#620. Until then no host can verify a portal token here.
- **`knip` cannot load its config from a worktree under `.claude/`**: knip hands
  jiti `process.cwd()` as a file name, so jiti looks for a tsconfig from the
  parent directory and finds the main checkout's. Run it from `src/` with
  `../node_modules/.bin/knip --directory ..`; CI's checkout is unaffected.
- **No real figure anywhere**, fixtures included: every price, count and name in
  `tests/fixtures/` is invented.
