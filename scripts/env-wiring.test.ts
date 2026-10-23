// Where this repo runs, in the files that decide it: `deploy.env` the origins a
// deployment answers at, `.env.example` a checkout's own, docker-compose.yml
// which of the two the containers are handed. Nothing makes them agree by
// itself, so each is held here to the thing that makes its value reach
// anything — a dev server that is really listening, an API that really answers
// there, a hostname nginx really serves.
//
// `deploy.env` is what declares the origin keys, and nothing else does: the
// lists below are its keys, so a repo that adds a third origin is checked on it
// without a line changing here.
import { expect, test } from "bun:test";
import { parseEnv } from "node:util";

import type { ProcessEnv } from "./dev-stack.ts";
import { deployedOrigins, ORIGINS_FILE } from "./origins.ts";
import { webPath } from "./web-app.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE = new URL("../docker-compose.yml", import.meta.url).pathname;
const EXAMPLE = new URL("../.env.example", import.meta.url).pathname;
const NGINX = new URL("../infra/nginx", import.meta.url).pathname;
// scaffold:monorepo
const DEPLOY = new URL(`../${ORIGINS_FILE}`, import.meta.url).pathname;
const DOCKERFILE = new URL("../Dockerfile.web", import.meta.url).pathname;
const API_ENV = new URL("../apps/api/src/env.ts", import.meta.url).href;
const API_ORIGIN = new URL("../apps/web/src/lib/api-origin.ts", import.meta.url).href;
// scaffold:monorepo

/** Every first capture of a global pattern, in the order they appear. */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap(([, first]) => (first === undefined ? [] : [first]));
}

/**
 * The origins file a caller that names none gets: the deployed one. A file may
 * say it more than once — the containers' fallback and the build's are
 * separate — and every mention has to be the same file, which is what one
 * answer means.
 */
function originsFile(text: string, pattern: RegExp): string {
  const files = [...new Set(captures(text, pattern))];
  const [file] = files;
  if (file === undefined || files.length > 1) {
    throw new Error(`one default origins file, or the ends disagree: ${files.join(", ")}`);
  }
  return file;
}

// A second origins file would be a second answer to "where is this deployed",
// and the one nothing checks is the one that goes stale.
test("the containers read the origins file this repo keeps", async () => {
  expect(originsFile(await Bun.file(COMPOSE).text(), /\$\{ORIGINS_ENV:-([^}]+)\}/g)).toBe(
    ORIGINS_FILE,
  );
});

// scaffold:monorepo
// The containers read their origins from one file and the browser bundle is
// built from another, and the deploy names neither — both fall back to their own
// default. Two defaults that drifted apart is an API answering at one origin and
// a bundle calling the other, which is a 403 on every call with no allow-origin
// header and nothing in either log saying why.
test("the containers and the bundle fall back to the same origins file", async () => {
  expect(originsFile(await Bun.file(DOCKERFILE).text(), /^ARG ORIGINS_ENV=(\S+)$/gm)).toBe(
    ORIGINS_FILE,
  );
});

/** Every VITE_-prefixed name a file mentions, in any position. */
function named(text: string): string[] {
  return [...text.matchAll(/\bVITE_[A-Z0-9_]+/g)].map(([name]) => name);
}

test("nothing the deploy resolves is a name vite would hand the browser", async () => {
  const files = await Promise.all([Bun.file(COMPOSE).text(), Bun.file(DOCKERFILE).text()]);

  // The build's variable has to be spelled VITE_ for vite to inline it; what it
  // resolves from must not be, or a checkout's own `.env` is one place its
  // value can come from.
  expect(files.flatMap((text) => captures(text, /\$\{(VITE_[A-Z0-9_]+)/g))).toEqual([]);
});

test("a name the deploy's build sets is not a key the shipped env declares", async () => {
  const names = named(await Bun.file(DOCKERFILE).text());
  const shipped = parseEnv(await Bun.file(EXAMPLE).text());

  // Non-empty, so this cannot pass by finding nothing to check.
  expect(names).not.toBeEmpty();
  expect(names.filter((name) => name in shipped)).toEqual([]);
});

/** The key the web image's build greps the browser bundle's API origin out of. */
function builtFrom(dockerfile: string): string {
  const [key, ...rest] = captures(dockerfile, /grep -m1 '\^([A-Z0-9_]+)=/g);
  if (key === undefined || rest.length > 0) {
    throw new Error("the web image takes its API origin from exactly one key");
  }
  return key;
}

// That build reads the file as text — one grepped line, cut at the first `=` —
// rather than sourcing it, so what it bakes into the bundle is the line and not
// a parse of it. A key the file does not declare is an empty origin in every
// call the browser makes; a quoted or padded value is the quotes and the
// padding, which every parser here would have taken off before anyone noticed.
test("what the web image bakes into the bundle is a line that file declares", async () => {
  const origins = await deployedOrigins(ROOT);

  expect(Object.keys(origins)).toContain(builtFrom(await Bun.file(DOCKERFILE).text()));
  expect(captures(await Bun.file(DEPLOY).text(), /^([A-Z0-9_]+=.*)$/gm)).toEqual(
    Object.entries(origins).map(([key, value]) => `${key}=${value}`),
  );
});
// scaffold:monorepo

/** The shipped nginx config, one text per file. */
async function confs(): Promise<string[]> {
  const paths = [...new Bun.Glob("*.conf").scanSync({ cwd: NGINX, absolute: true })];
  return await Promise.all(paths.map((path) => Bun.file(path).text()));
}

/** The hostnames those files have a server block for. */
async function served(): Promise<Set<string>> {
  return new Set(
    (await confs()).flatMap((conf) =>
      captures(conf, /^\s*server_name\s+([^;]+);/gm).flatMap((names) => names.trim().split(/\s+/)),
    ),
  );
}

/** The origins a deployment is pointed at, each with the key that carries it. */
async function deployed(): Promise<[string, URL][]> {
  return Object.entries(await deployedOrigins(ROOT)).map(([key, value]) => [key, new URL(value)]);
}

// A path, a trailing slash — which is what a copied address bar gives you — or
// an uppercase scheme all parse and boot, and then match no browser's `Origin`
// header. Comparing against `url.origin` catches every one of them: it is
// exactly the string a browser sends. The half of this CI and a preview cannot
// see is the deployed browser's: it is the only client that goes through nginx,
// and what shipped once was an origin carrying a path, which the browser clients
// read differently — infra/nginx says how, at the block that exists because of it.
test("what a deployment answers at is a bare origin", async () => {
  const origins = await deployed();

  expect(origins.filter(([, url]) => url.href !== `${url.origin}/`).map(([key]) => key)).toEqual(
    [],
  );
});

// And a hostname nginx has no server block for is a deployment nothing routes to.
test("...on hostnames the shipped nginx config serves", async () => {
  const origins = await deployed();
  const hosts = await served();

  expect(origins.filter(([, url]) => !hosts.has(url.hostname)).map(([key]) => key)).toEqual([]);
});

/** What a module answers in a process of its own, whose environment is the one given. */
async function printed(script: string, env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", script], { env, stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim();

  expect(await proc.exited).toBe(0);
  return out;
}

/** A module asked what it exports, rather than a copy of the value being kept here. */
function reads(path: string, expression: string): string {
  return `console.log((await import(${JSON.stringify(path)})).${expression})`;
}

// Every file that answers "where does this run in dev" answers on its own terms
// and reads no other: the port the dev server listens on, the origin
// `.env.example` hands a checkout — and in the monorepo the port apps/api binds
// and the origin the browser's clients fall back to. What shipped here was the
// deployed origin, and Better Auth reads `Secure` off its scheme, so sign-in
// answered 200, wrote its row, and handed back a cookie the browser dropped on
// the floor, with nothing logged anywhere. A disagreement the other way round is
// a dev browser calling a port nothing serves, or an API refusing the browser in
// front of it with no allow-origin header and a 403 that names no cause.
test("the answers to where this runs in dev are one answer", async () => {
  const env: ProcessEnv = { ...process.env };
  delete env["DEV_PORT"];
  // scaffold:monorepo
  // apps/api parses its whole environment at import and this asks it one
  // question, so the datastores point at a port nothing serves: it binds before
  // it talks to either.
  delete env["PORT"];
  delete env["VITE_API_URL"];
  env["DATABASE_URL"] = "postgres://probe:probe@127.0.0.1:1/probe";
  env["REDIS_URL"] = "redis://127.0.0.1:1";
  // scaffold:monorepo
  const shipped = parseEnv(await Bun.file(EXAMPLE).text());
  const webConfig = await webPath("apps/web/vite.config.ts", "vite.config.ts");
  const devPort = await printed(reads(webConfig, "default.server?.port"), env);

  expect(shipped["SITE_URL"]).toBe(`http://127.0.0.1:${devPort}`);
  // scaffold:monorepo
  const apiPort = await printed(reads(API_ENV, "env.PORT"), env);
  const fallback = await printed(reads(API_ORIGIN, "apiUrl"), env);

  expect(fallback).toBe(`http://127.0.0.1:${apiPort}`);
  expect(shipped["PUBLIC_API_URL"]).toBe(fallback);
  // scaffold:monorepo
});

// scaffold:monorepo
/**
 * What a server block adds to every response it produces, directive and all.
 *
 * To the end of the line rather than the first `;`: every value here contains
 * one — `max-age=31536000; includeSubDomains` — and stopping at it would
 * compare the halves in front, where an HSTS shortened to nothing and a policy
 * that dropped `always` both look unchanged.
 *
 * A directive wrapped across lines, or one trailing a comment after its `;`, is
 * not matched at all. Written into both blocks it is simply uncompared; written
 * into one, the blocks differ by it and this fails — which is the way round
 * that matters.
 */
function addedHeaders(block: string): string[] {
  return captures(block, /^\s*add_header\s+(.+);\s*$/gm).toSorted();
}

// nginx inherits add_header into nothing: a block that does not repeat the set
// simply does not send it. The two blocks are written out by hand for that
// reason, and this is what keeps a header added to one of them — or weakened on
// one hostname, which is the same drift wearing the other's name — from being a
// difference nothing else would report.
test("every server block sends the same security headers", async () => {
  const blocks = (await confs()).flatMap((conf) => conf.split(/^server \{/m).slice(1));

  expect(blocks.length).toBeGreaterThan(1);
  expect([...new Set(blocks.map((block) => addedHeaders(block).join("; ")))]).toHaveLength(1);
});
// scaffold:monorepo
