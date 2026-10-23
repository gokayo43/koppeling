// What a checkout is allowed to say about where it runs, and what the file that
// decides which keys say it has to be. The rule is one predicate over two things
// a browser reads — the scheme and the host — and both halves have shipped as
// bugs, so both are named here by input.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployedOrigins, foreignOriginFiles, foreignOrigins } from "./origins.ts";

/** A checkout with the env files a case needs and nothing else. */
let root = "";

async function checkout(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "origins-"));
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(root, name), text)));
  return root;
}

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

/** What deploy.env declares in the monorepo shape; the single app declares the first alone. */
const KEYS = ["SITE_URL", "PUBLIC_API_URL"];

describe("what a checkout may say about where it runs", () => {
  // Every name this machine answers to, because a developer types the one they
  // like and each of them is the same machine to the browser.
  test.each([
    "http://localhost:5180",
    "http://app.localhost:5180",
    "http://[::1]:5180",
    "http://127.0.0.1:5180",
    "http://127.0.0.2:3001",
  ])("%s is this checkout's own dev origin", (value) => {
    expect(foreignOrigins({ SITE_URL: value }, KEYS)).toEqual([]);
  });

  test.each(["https://shop.example.com", "http://shop.example.com", "http://127.example.com"])(
    "%s is a place, not this machine",
    (value) => {
      expect(foreignOrigins({ SITE_URL: value }, KEYS)).toEqual(["SITE_URL"]);
    },
  );

  // The scheme is the other half of the rule, and the half the bug was: Better
  // Auth marks the session cookie `Secure` off it, so a dev server that never
  // speaks TLS hands back a cookie the browser drops — sign-in answers 200, the
  // row exists, and the app renders signed out. This template ships no local
  // certificate, so a loopback host under https is that failure with the right
  // hostname in front of it.
  test.each(["https://127.0.0.1:5180", "https://localhost:5180"])(
    "%s is refused for its scheme: a dev server here serves plain http",
    (value) => {
      expect(foreignOrigins({ SITE_URL: value }, KEYS)).toEqual(["SITE_URL"]);
    },
  );

  test("every key that names one is reported, and no other key is looked at", () => {
    const env = {
      SITE_URL: "http://127.0.0.1:5180",
      PUBLIC_API_URL: "https://api.shop.example.com",
      VITE_API_URL: "https://api.shop.example.com",
    };

    expect(foreignOrigins(env, KEYS)).toEqual(["PUBLIC_API_URL"]);
  });

  // A key the shape does not declare and a value the app will refuse itself are
  // both somebody else's answer: this one is only about where the URL points.
  test.each([undefined, "", "not-a-url"])("%p is not this rule's business", (value) => {
    expect(foreignOrigins({ SITE_URL: value }, KEYS)).toEqual([]);
  });
});

const DEPLOYED = "SITE_URL=https://shop.example.com\n";
const DEV = "SITE_URL=http://127.0.0.1:5180\n";

describe("which of a checkout's files the rule is asked of", () => {
  // Bun has already loaded `.env`, `.env.local` and `.env.<NODE_ENV>` into this
  // process before the wrapper's first line, and vite loads `.env.<mode>.local`
  // as well. A rule that read `.env` alone let every one of the others hand the
  // child a deployed origin with exit 0 and nothing printed — the silent
  // sign-in failure, through the file `.gitignore` exists to allow.
  test.each([".env.local", ".env.development", ".env.production.local", ".env.test"])(
    "a deployed origin in %s is named, not walked past",
    async (name) => {
      const at = await checkout({ ".env": DEV, deploy: "", [name]: DEPLOYED });

      expect(await foreignOriginFiles(at, ["SITE_URL"])).toEqual([[join(at, name), ["SITE_URL"]]]);
    },
  );

  test("every file that names one is reported, so no second edit is needed", async () => {
    const at = await checkout({ ".env": DEPLOYED, ".env.local": DEPLOYED });

    expect(await foreignOriginFiles(at, ["SITE_URL"])).toEqual([
      [join(at, ".env"), ["SITE_URL"]],
      [join(at, ".env.local"), ["SITE_URL"]],
    ]);
  });

  // `.env.example` is a copy waiting to be made and ships the loopback pair;
  // `.env.enc` is ciphertext, and parsing it as env is reading noise.
  test("the two files nothing loads are not read", async () => {
    const at = await checkout({ ".env": DEV, ".env.example": DEPLOYED, ".env.enc": DEPLOYED });

    expect(await foreignOriginFiles(at, ["SITE_URL"])).toEqual([]);
  });

  test("a checkout whose files all name this machine has nothing to report", async () => {
    const at = await checkout({ ".env": DEV, ".env.local": "SITE_URL=http://localhost:5180\n" });

    expect(await foreignOriginFiles(at, ["SITE_URL"])).toEqual([]);
  });
});

describe("what the file that declares the origin keys has to be", () => {
  test("the origins it declares are what comes back", async () => {
    const at = await checkout({
      "deploy.env": "# where this answers\nSITE_URL=https://shop.example.com\n",
    });

    expect(await deployedOrigins(at)).toEqual({ SITE_URL: "https://shop.example.com" });
  });

  // Reachable on any checkout of a commit that predates the file — a bisect, an
  // old branch — and it is on the path of every dev command, so it answers in
  // the same words as the missing DATABASE_URL beside it rather than in errno.
  test("a checkout without one says which file and what it is for", async () => {
    const at = await checkout({ ".env": DEV });

    expect(deployedOrigins(at)).rejects.toThrow(/deploy\.env — it names the origins/);
  });

  // The key list IS this file's keys, so a file that parses to none makes the
  // rule a no-op: the exact state it exists to refuse, passing in silence.
  test("one that declares no origins is refused rather than believed", async () => {
    const at = await checkout({ "deploy.env": "# everything below was cut\n" });

    expect(deployedOrigins(at)).rejects.toThrow(/declares no origins/);
  });

  // A deployment env var that is not an origin — a Sentry DSN is the one that
  // already exists on these services — would otherwise become a key a checkout
  // may only set to loopback, and the rule would refuse a dev environment while
  // naming the wrong file to fix.
  test.each([
    ["SENTRY_DSN", "https://abc123@o1.ingest.sentry.io/42"],
    ["FEATURE_FLAGS", "beta"],
    ["SITE_URL", "https://shop.example.com/app"],
  ])("%s, which is not an origin, is refused where it is declared", async (key, value) => {
    const at = await checkout({
      "deploy.env": `SITE_URL=https://shop.example.com\n${key}=${value}\n`,
    });

    expect(deployedOrigins(at)).rejects.toThrow(new RegExp(`${key} in .* is not an origin`));
  });
});
