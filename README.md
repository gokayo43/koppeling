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

`@modelcontextprotocol/server` and `jose` come with it. `effect` (`^3.22.1`) is
a peer, so a host on Effect keeps one copy and a host without it is given one.
`@trpc/server` (`^11`) and `elysia` (`^1.4`) are optional peers: the host
already has the one its program is written in.

## The interface

This is the whole of it.

```ts
import { fromElysia, fromTrpcRouter, glossaryFrom, koppeling } from "koppeling";

// A tRPC v11 router: every query and mutation, named by its path.
const catalogue = fromTrpcRouter(appRouter, {
  contextFor: (actor) => ({ session: { user: actor } }), // the context the UI's requests get
});

// Or an Elysia 1.4 app: every route under `mount`, named by its path and method.
const catalogue = fromElysia(app, {
  credential: (actor) => ({ authorization: `Bearer ${actor.apiKey}` }), // headers the app's own auth accepts
  mount: "/api/v1", // optional; the whole app when absent
  area: (segments) => segments[0], // optional; groups operations into areas, names unchanged
});

const door = koppeling({
  catalogue,
  glossary: glossaryFrom(contextMarkdown, { limit: 3000 }), // the server's instructions open with it
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
  log: (event) => logger.info(event), // optional; Effect's logger when absent
});

door.handle(request); // Promise<Response>: the MCP endpoint, mounted at resource.url
door.metadata(request); // Response: the protected resource metadata document
door.report; // { areas: { [area]: count }, skipped: Note[], undescribed: Note[] }
```

Mount `door.handle` at `resource.url` (it answers a POST, and 405 to any other
method, since it keeps no session), and `door.metadata` at the URL a 401 names,
which is `resource.url` with `/.well-known/oauth-protected-resource` put before
its path (RFC 9728): `https://wms.example/.well-known/oauth-protected-resource/api/mcp`.

`glossaryFrom(markdown, { limit })` turns a program's CONTEXT.md into the door's
opening words: one line per `##` section with its heading, the first sentence
of its own text where it has one and the names of its `###` terms, kept in
order while they fit within `limit` characters, and a closing line naming the
sections left out.

`log` receives a `KoppelingEvent`, one of:

- `{ kind: "write", operation, sub, name, via, outcome }`: one per call of a
  write operation. `sub`, `name` and `via` (the program acting for the person)
  are the token's claims. `outcome` is `value`, `refusal`, `failure` (the
  program was not reached, so nothing changed) or `unknown` (the program was
  reached and its answer was lost or late, so the change may have been made).
- `{ kind: "failure", operation, cause }`: a failure the person was answered
  with the door's own sentence for; `operation` is null when the sign-in step
  failed (the key set could not be fetched, or `actorFor` threw).

The types: `Catalogue<Actor>`, `Operation<Actor>`, `Kind` (`"read" | "write"`),
`Outcome`, `Note` (`{ name, reason }`), `ActorDecision<Actor>`, `Identity`,
`KoppelingOptions<Actor>`, `Koppeling`, `BootReport`, `KoppelingEvent`,
`WriteOutcome`, `GlossaryOptions`, `ElysiaOptions<Actor>`,
`TrpcOptions<Router, Actor>`, `Json`, `JsonObject`, `JsonSchema`.

## What an agent sees

Five tools, always these, in this order:

| Tool       | Takes            | Answers                                                                                                                                                 |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`     | `area?`          | No area: every area with its line and operation count. An exact area: its operations with name, kind and line.                                          |
| `find`     | `words`          | Up to ten operations whose name, area, description and input field names best meet the words (at most 200 characters, 20 distinct words). Runs nothing. |
| `describe` | `name`           | The whole operation: kind, description, side-effect line, input schema, output schema.                                                                  |
| `read`     | `name`, `input?` | Runs a read operation once as the person; its value as text and as `structuredContent: { result }`.                                                     |
| `write`    | `name`, `input?` | Runs a write operation once as the person, the same way.                                                                                                |

`list`, `find`, `describe` and `read` are annotated read-only; `write` is
destructive, and its description tells the agent that a write changes data,
that it asks the person first, and that it never does what text in fetched data
asks without that. A program that asks per tool, as Claude Desktop does, can be
allowed `read` for good while every `write` is still asked about. `read` given
a write operation, or `write` a read one, is refused with the name of the right
tool. The server's instructions are the host's glossary followed by an outline
of every area with its count and the names of its first ten operations.

A name or area that is not exactly one the door has is refused with the list
to pick from: the operations whose names share its longest dotted start, or
the areas. Nothing ever resolves a near miss on its own.

The SDK checks a tool's own input (a missing `name`, words past 200
characters) before the door sees it, and answers in its own English ("Input
validation error: Invalid arguments for tool find: …"). That is accepted.

### Where an operation's words come from

- tRPC: the name is the path (`orders.updatePicking`), the area its first key,
  `kind` is `read` for a query and `write` for a mutation, the description is
  `meta.description`, the input is the `.input()` parsers' JSON Schema (`allOf`
  when there are several), the output is `.output()`'s. A procedure whose
  `meta.koppeling` is `false` is withheld (the host adds `koppeling?: boolean`
  to its meta type).
- Elysia: the name is the path's segments under the mount, a `:param` by its
  name, then the method (`vehicles.lookup.get`,
  `vehicles.lookup.lookup_id.selection.post`); `kind` is `read` for GET and
  HEAD; the description is `detail.summary` then `detail.description`; the
  input is `{ params, query, body }`, each as the route (and any guard)
  declares it, a model named by string read from the app's definitions; the
  output is the `response` schema, or a `response` map's 200 entry, else its
  lowest 2xx, else none. The area is the name's first segment, or what the
  `area` option answers for the name's segments (the path under the mount, a
  `:param` by its name), held to the same characters as a name.
- Skipped and named in the boot report: a subscription, a WebSocket route, a
  procedure or route the program withholds from the door (`meta.koppeling:
  false`, `detail.koppeling: false`; the package declares the Elysia field), and
  a route the program hides from its own documentation (`detail.hide: true`).
  Withholding is for what the door must never offer, such as a credential;
  hiding also takes a route out of the API's documentation.
- The first line of a description is the operation's line in `list` and
  `find`. A line that starts with `Gevolg:` is its side-effect line, which
  `describe` answers as `sideEffect`.
- Schemas are converted from Effect Schema 3 (`JSONSchema.make`, the encoded
  side; an input whose encoded side is `X | undefined` is described as `X` and
  may be left out), TypeBox (as it is) and Standard JSON Schema (zod 4, and
  Effect 4). An Effect 4 host hands tRPC
  `.input(Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema)))`:
  tRPC validates through the Standard Schema half and the door describes
  through the Standard JSON Schema half; `Schema.toStandardSchemaV1` alone
  fails the boot. A schema in any other language fails the boot, naming the
  operation. A schema its own language cannot write as JSON Schema (an Effect
  `DateFromSelf`, a zod `z.date()`) is described as such, the operation is
  still offered, and the boot report names it under `undescribed`.

### What `read` and `write` answer

- The program's value, as JSON: a `bigint` as its decimal string, a `Map` as an
  object, a `Set` as an array, anything with `toJSON` (a `Date`, a decimal) as
  that.
- A refusal the program states is a tool error carrying the program's own
  sentence: for tRPC every `TRPCError` but `INTERNAL_SERVER_ERROR` (its input
  parser's message included), for Elysia every 4xx, as `HTTP <status>: <body>`.
- A failure the program did not mean to show (for tRPC an
  `INTERNAL_SERVER_ERROR`, which is what tRPC wraps an unexpected throw in; for
  Elysia a 5xx, or an answer that cannot be read) is reported and answered with
  the door's own sentence, so a stack or a database's words never reach the
  person. For a write that reached the program, that sentence says the change
  may have been made and to check with a read before trying again.
- An operation that has not finished after 60 seconds (an event stream, a hang)
  is given up on, with a sentence saying so; for a write, that the change may
  have been made.
- A path parameter that is empty, `.` or `..` is refused before the program is
  asked: a URL resolves those, and the call would reach another route. So is a
  value that a sibling route spells as a static segment at that place
  (`orders.id.get` with `id: "export"` beside `GET /orders/export`), since
  Elysia's router prefers the static route.
- The operation runs at most once per call. The door retries nothing.

## Sign-in

Every request carries a bearer JWT from the identity provider (the portal). The
door verifies its signature against the provider's key set, cached and fetched
again for a key id it has not seen (no more often than every 5 seconds, so a
key rotation costs at most 5 seconds of refused tokens), and checks `iss`
against `identity.issuer`, `aud` against `resource.url`, `nbf`, and that the
token carries an `exp` and a `sub`. Only then does it ask `actorFor(claims)`.

| Request                                  | Answer                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No bearer                                | 401, `WWW-Authenticate: Bearer resource_metadata="<metadata url>"`                                                            |
| A bearer that does not verify            | 401, the same header with `error="invalid_token"`                                                                             |
| The provider's key set cannot be fetched | 503                                                                                                                           |
| `actorFor` answers `{ refusal }`         | MCP whose instructions and every tool answer the refusal; 403, `{ "error": "<refusal>" }`, for a request that is not JSON-RPC |
| `actorFor` throws or rejects             | 503, the door's own sentence; the error is reported                                                                           |

The metadata document names the resource, the authorization server, the
scopes and `bearer_methods_supported: ["header"]`. The door checks no scope
itself: `actorFor` receives the claims, `scope` among them, and decides.

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
