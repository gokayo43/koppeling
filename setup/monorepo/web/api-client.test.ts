import { expect, test } from "bun:test";

import { freshProcess } from "./fresh-process.ts";

const MODULE = new URL("../src/lib/api-client.ts", import.meta.url).href;

// The bug this stands against is a silent one: the session is a cookie on the
// site's domain, the API is a different origin, and a cross-origin fetch that
// does not ask for credentials sends none. Every call would be answered as if
// nobody were signed in, while signing in itself kept working — Better Auth's
// client asks on its own behalf — so the first symptom is data that is missing
// rather than an error anyone can see.
test("an Eden call carries the session cookie to the other origin", async () => {
  const asked = await freshProcess(`
    const asked = [];
    globalThis.fetch = async (_input, init) => {
      asked.push(init);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const { api } = await import(${JSON.stringify(MODULE)});
    await api.health.get();
    console.log(JSON.stringify(asked.map((init) => init?.credentials)));
  `);

  expect(asked).toBe(`["include"]`);
});
