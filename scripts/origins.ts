/**
 * Where a run is reachable, and which keys say so.
 *
 * One file answers the second half: `deploy.env`, the origins a deployment
 * answers at. Its keys are the list every other reader works from — the rule
 * below, the preview's isolation, `env-wiring.test.ts` — so a repo that grows a
 * third origin declares it once and everything that has to know follows. That
 * only holds while the file is origins and nothing else, which is why reading
 * it is also where that contract is enforced.
 */
import { parseEnv } from "node:util";

import type { ProcessEnv } from "./dev-stack.ts";

/** The name compose falls back to, and the shape a preview's own file copies. */
export const ORIGINS_FILE = "deploy.env";

/** A bare origin: what a browser sends as `Origin`, with nothing appended. */
function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.href === `${url.origin}/`;
}

/**
 * The origins a deployment answers at, by key, out of the checkout at `root`.
 * The production image carries this file too — `.dockerignore` keeps `.env` out
 * of the build context and lets this one through — so it is readable wherever a
 * command runs.
 *
 * Every dev command reads it before doing anything, so what it refuses it has
 * to refuse in words. This is also the only place that knows the file is a
 * contract rather than a bag of values: a key in it that is not an origin turns
 * the rule below into one that forbids a deployment's own configuration, and
 * the diagnostic would name the wrong file to edit.
 */
export async function deployedOrigins(root: string): Promise<Record<string, string>> {
  const path = `${root}/${ORIGINS_FILE}`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `no ${path} — it names the origins a deployment answers at, and every dev command reads it for the keys a checkout's env may then not name; restore it from git`,
    );
  }

  const origins: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(await file.text()))) {
    if (value === undefined || !isOrigin(value)) {
      throw new Error(
        `${key} in ${path} is not an origin — ${ORIGINS_FILE} holds the origins a deployment answers at and nothing else, because every key in it is one a checkout's env may then only name on this machine; other deployment configuration belongs in docker-compose.yml, under the service that reads it`,
      );
    }
    origins[key] = value;
  }
  if (Object.keys(origins).length === 0) {
    throw new Error(
      `${path} declares no origins — it is what says which keys are origins at all, so an empty one leaves every checkout's env unchecked`,
    );
  }
  return origins;
}

/** 127.0.0.0/8 written out as a literal. `127.example.com` is a domain, not this machine. */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/** Where a hostname is this machine under one of its names rather than a place. */
function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    LOOPBACK_IPV4.test(host)
  );
}

/**
 * The origin keys in one env file that no dev server here could answer at:
 * somewhere other than this machine, or this machine over a scheme nothing here
 * speaks.
 *
 * A checkout's env is its own dev environment — every command in front of it
 * runs here — and this box is a deploy target as well, so the deployed origins
 * are a file the containers read and nothing else. Standing in a checkout's env
 * they are an API that refuses the browser in front of it with no allow-origin
 * header, or a session cookie marked `Secure` that a plaintext dev server can
 * never hand over: both of them silent, and neither of them anything the app
 * itself can tell apart from a deployment. The scheme is half of that second
 * one and carries no hostname with it, which is why it is read here rather than
 * inferred: this template ships no local certificate, so `https` on loopback is
 * the same discarded cookie with the right host in front of it.
 *
 * A value that is not a URL at all is not this function's business — the app
 * parses its own environment and names the key.
 */
export function foreignOrigins(env: ProcessEnv, keys: Iterable<string>): string[] {
  return [...keys].filter((key) => {
    const value = env[key];
    if (value === undefined || !URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol !== "http:" || !isLoopback(url.hostname);
  });
}

/** `.env.example` is a copy waiting to be made, and `.env.enc` is ciphertext. */
const NEVER_LOADED = new Set([".env.example", ".env.enc"]);

/**
 * Every env file in the checkout at `root` that names an origin no dev server
 * here could answer at, with the keys that do it — the path included, because
 * the developer has to be told which file to edit.
 *
 * All of them, rather than whichever one would win: Bun loads `.env`,
 * `.env.local` and `.env.<NODE_ENV>`, vite adds `.env.<mode>.local`, and the
 * two do not agree on the order — with one key in both, Bun takes `.env.local`
 * and vite takes `.env.development` (measured, bun 1.3 / vite 8). A wrapper
 * that fronts both cannot name one winner, and does not have to: a deployed
 * origin in any file a checkout loads is the state this refuses, whether or not
 * another file happens to cover it today.
 */
export async function foreignOriginFiles(
  root: string,
  keys: Iterable<string>,
): Promise<[string, string[]][]> {
  const named = [...keys];
  const names = [...new Bun.Glob(".env*").scanSync({ cwd: root, dot: true })].toSorted();
  const files = await Promise.all(
    names
      .filter((name) => !NEVER_LOADED.has(name))
      .map(async (name): Promise<[string, string[]]> => [
        `${root}/${name}`,
        foreignOrigins(parseEnv(await Bun.file(`${root}/${name}`).text()), named),
      ]),
  );
  return files.filter(([, foreign]) => foreign.length > 0);
}
