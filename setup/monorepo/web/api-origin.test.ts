import { expect, test } from "bun:test";

import { freshProcess } from "./fresh-process.ts";

const MODULE = new URL("../src/lib/api-origin.ts", import.meta.url).href;

/** The origin this module resolves to for a browser built with that value, or none. */
async function apiUrlWith(set: string | undefined): Promise<string> {
  const env = { ...process.env };
  delete env["VITE_API_URL"];
  if (set !== undefined) env["VITE_API_URL"] = set;

  return await freshProcess(`console.log((await import(${JSON.stringify(MODULE)})).apiUrl)`, env);
}

// The bug this stands against: a browser bundle built from whatever `.env`
// happens to hold. A deploying checkout's holds the deployed origin, and under
// a VITE_ name that is a `bun run dev` building a browser client that calls
// production — the Eden one and the auth one, which read the same constant.
test("with nothing set, the browser clients talk to the API this checkout runs", async () => {
  expect(new URL(await apiUrlWith(undefined)).hostname).toBe("127.0.0.1");
});

// The callers that do set it are the image build and scripts/worktree.ts.
test("and take the origin they are given when there is one", async () => {
  expect(await apiUrlWith("http://127.0.0.1:31337")).toBe("http://127.0.0.1:31337");
});
