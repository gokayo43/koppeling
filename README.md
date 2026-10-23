# koppeling

A program's own declared operations, offered over MCP to the signed-in office
person's agent, as that person. The catalogue is derived from the program at
boot: a tRPC v11 router's queries and mutations, or an Elysia 1.4 app's routes.
A procedure or route added, changed or removed is offered, changed or gone the
next time the program boots, with nothing else to keep up.

## Install

A host installs the repository by commit; `dist/` is committed, so nothing is
built at the host.

```json
"koppeling": "git+ssh://git@github.com/gokayo43/koppeling.git#<sha>"
```

`@modelcontextprotocol/server`, `effect` and `jose` come with it. `@trpc/server`
(`^11`), `elysia` (`^1.4`), `zod` (`^4`) and `@sinclair/typebox` (`^0.34`) are
optional peers: the host already has the ones its program is written in.

## The interface

This is the whole of it.

```ts
import { fromElysia, fromTrpcRouter, koppeling } from "koppeling";

// A tRPC v11 router: every query and mutation, named by its path.
const catalogue = fromTrpcRouter(appRouter, {
  contextFor: (actor) => ({ session: { user: actor } }), // the context the UI's requests get
});

// Or an Elysia 1.4 app: every route under `mount`, named by its path and method.
const catalogue = fromElysia(app, {
  credential: (actor) => ({ authorization: `Bearer ${actor.apiKey}` }), // headers the app's own auth accepts
  mount: "/api/v1", // optional; the whole app when absent
});

const door = koppeling({
  catalogue,
  glossary: "Magazijn. Woorden: ...", // the server's instructions open with it
  resource: {
    url: "https://wms.example/api/mcp", // this door's public URL; every token's `aud`
    scopes: ["koppeling"],
  },
  identity: {
    issuer: "https://portal.example", // every token's `iss`
    jwksUrl: "http://portal.lan/api/auth/jwks", // optional; `<issuer>/.well-known/jwks.json` when absent
    authorizationServer: "https://portal.example",
  },
  actorFor: async (claims) => ({ actor: await personFor(claims.sub) }), // or { refusal: "Dutch sentence" }
});

door.handle(request); // Promise<Response>: the MCP endpoint, mounted at resource.url
door.metadata(request); // Response: the protected resource metadata document
door.report; // { areas: { [area]: count }, skipped: Note[], undescribed: Note[] }
```

Mount `door.handle` at `resource.url` (it answers a POST, and 405 to any other
method, since it keeps no session), and `door.metadata` at the URL a 401 names, which is
`resource.url` with `/.well-known/oauth-protected-resource` put before its path
(RFC 9728): `https://wms.example/.well-known/oauth-protected-resource/api/mcp`.

The types: `Catalogue<Actor>`, `Operation<Actor>`, `Kind` (`"read" | "write"`),
`Outcome`, `Note` (`{ name, reason }`), `ActorDecision<Actor>`, `Identity`,
`KoppelingOptions<Actor>`, `Koppeling`, `BootReport`, `ElysiaOptions<Actor>`,
`TrpcOptions<Router, Actor>`, `Json`, `JsonObject`, `JsonSchema`.

## What an agent sees

Four tools, always these, in this order:

| Tool       | Takes            | Answers                                                                                                        |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `list`     | `area?`          | No area: every area with its line and operation count. An exact area: its operations with name, kind and line. |
| `find`     | `words`          | Up to ten operations whose name, area, description and input field names best meet the words. Runs nothing.    |
| `describe` | `name`           | The whole operation: kind, description, side-effect line, input schema, output schema.                         |
| `call`     | `name`, `input?` | Runs the operation once as the person; its value as text and as `structuredContent: { result }`.               |

`list`, `find` and `describe` are annotated read-only; `call` is destructive,
and its description tells the agent that a `write` operation changes data and
that it asks the person first. The server's instructions are the host's
glossary followed by an outline of every area with its count and the names of
its first ten operations.

A name or area that is not exactly one the door has is refused with the list
to pick from: the areas, or the operations of the area the name starts with.
Nothing ever resolves a near miss on its own.

### Where an operation's words come from

- tRPC: the name is the path (`orders.updatePicking`), the area its first key,
  `kind` is `read` for a query and `write` for a mutation, the description is
  `meta.description`, the input is the `.input()` parsers' JSON Schema (`allOf`
  when there are several), the output is `.output()`'s.
- Elysia: the name is the path's segments under the mount, a `:param` by its
  name, then the method (`vehicles.lookup.get`,
  `vehicles.lookup.lookup_id.selection.post`); `kind` is `read` for GET and
  HEAD; the description is `detail.summary` then `detail.description`; the
  input is `{ params, query, body }`, each as the route (and any guard)
  declares it, a model named by string resolved from the app's models; the
  output is the `response` map's 200 entry.
- The first line of a description is the operation's line in `list` and
  `find`. A line that starts with `Gevolg:` is its side-effect line, which
  `describe` answers as `sideEffect`.
- Schemas are converted from Effect Schema (`JSONSchema.make`, the encoded
  side; an input whose encoded side is `X | undefined` is described as `X` and
  may be left out), TypeBox (as it is) and Standard JSON Schema (zod 4). A
  schema in any other language fails the boot, naming the operation. A schema
  its own language cannot write as JSON Schema (an Effect `DateFromSelf`, a
  zod `z.date()`) is described as such, the operation is still offered, and
  the boot report names it under `undescribed`.

### What `call` answers

- The program's value, as JSON: a `bigint` as its decimal string, a `Map` as an
  object, a `Set` as an array, anything with `toJSON` (a `Date`, a decimal) as
  that.
- A refusal the program states is a tool error carrying the program's own
  sentence: for tRPC every `TRPCError` but `INTERNAL_SERVER_ERROR` (its input
  parser's message included), for Elysia every answer that is not 2xx, as
  `HTTP <status>: <body>`.
- A failure the program did not mean to show (for tRPC an
  `INTERNAL_SERVER_ERROR`, which is what tRPC wraps an unexpected throw in) is
  logged and answered with the door's own sentence, so a database's words never
  reach the person.
- The operation runs at most once per `call`. The door retries nothing.

## Sign-in

Every request carries a bearer JWT from the identity provider (the portal). The
door verifies its signature against the provider's key set, cached and fetched
again for a key id it has not seen (no more often than every 30 seconds, jose's
cool-down), and checks `iss` against `identity.issuer`, `aud` against
`resource.url`, `exp` and `nbf`. Only then does it ask `actorFor(claims)`.

| Request                                  | Answer                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| No bearer                                | 401, `WWW-Authenticate: Bearer resource_metadata="<metadata url>"` |
| A bearer that does not verify            | 401, the same header with `error="invalid_token"`                  |
| The provider's key set cannot be fetched | 503                                                                |
| `actorFor` answers `{ refusal }`         | 403, `{ "error": "<refusal>" }`                                    |

The metadata document names the resource, the authorization server, the
scopes and `bearer_methods_supported: ["header"]`. The door checks no scope
itself: `actorFor` receives the claims, `scope` among them, and decides. A throw
from `actorFor` rejects `handle`'s promise, for the host's framework to answer
as its own failure.

## Protocol

`@modelcontextprotocol/server` 2.3.1, the SDK's stable v2 line. A 2026-07-28
request (`server/discover`, per-request `_meta`) goes to the SDK's per-request
handler; a 2025-era request (`initialize`, protocol 2025-11-25 back to
2024-10-07) is served stateless over `WebStandardStreamableHTTPServerTransport`
with `enableJsonResponse`, the shape Claude Desktop already uses with the
portal's door.

## Developing

```sh
bun install
bun run hooks   # the git hooks
bun run check   # format, lint, typecheck, knip
bun test
bun run build   # rewrites dist/, which is committed
bun run walk    # how the fixture programs meet the phrasings in tests/fixtures/phrasings.txt
```
