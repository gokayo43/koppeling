import { expect, test } from "bun:test";

// A fresh process per case: the environment is read once, when the module is
// first evaluated, and what is under test here is a program refusing to start.
const MODULE = new URL("../src/auth.ts", import.meta.url).href;

/** Loads the auth module against a working environment with these values changed. */
async function boot(
  overrides: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "-e", `await import(${JSON.stringify(MODULE)})`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://probe:probe@127.0.0.1:1/probe",
      REDIS_URL: "redis://127.0.0.1:1",
      SITE_URL: "https://probe.example.com",
      PUBLIC_API_URL: "https://api.probe.example.com",
      BETTER_AUTH_SECRET: "probe-secret-that-is-long-enough-32",
      ...overrides,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

// The control the two below rest on: with nothing changed this environment
// loads, so a refusal there is the value under test and not the harness.
test("the probe environment loads", async () => {
  expect((await boot({})).exitCode).toBe(0);
});

/**
 * Every way of spelling something that is not this deployment's origin.
 *
 * The first four never reach a browser at all — a value that is no URL, a host
 * that is not one, a scheme nothing serves, a bare path. The rest do: each
 * parses, boots, and then matches no `Origin` header a browser will ever send,
 * so CORS answers without an allow-origin and every call is a 403 nobody can
 * read a cause out of. A copied address bar is where the trailing slash comes
 * from, which makes it the likeliest of them.
 */
const refused = [
  "",
  "not-a-url",
  "http://127.999.0.1",
  "htp://api.probe.example.com",
  "/api",
  "?tenant=a",
  "#section",
  "https://api.probe.example.com/api",
  "https://api.probe.example.com?tenant=a",
  "https://api.probe.example.com#section",
  "https://api.probe.example.com/",
  "HTTPS://api.probe.example.com",
  "https://user:secret@api.probe.example.com",
];

test.each(refused)("PUBLIC_API_URL=%s stops the boot, naming the key", async (value) => {
  const { exitCode, stderr } = await boot({ PUBLIC_API_URL: value });

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("PUBLIC_API_URL");
});

test.each(refused)("SITE_URL=%s stops the boot, naming the key", async (value) => {
  const { exitCode, stderr } = await boot({ SITE_URL: value });

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("SITE_URL");
});

// The other half of the rule, and pairs rather than values because the two are
// read together: a deployment's, the loopback one `.env.example` ships, and the
// bracketed IPv6 form a run bound to ::1 would report.
test.each([
  ["https://probe.example.com", "https://api.probe.example.com"],
  ["http://127.0.0.1:5180", "http://127.0.0.1:3001"],
  ["http://[::1]:5180", "http://[::1]:3001"],
])("the pair %s / %s is one this program starts on", async (site, api) => {
  expect((await boot({ SITE_URL: site, PUBLIC_API_URL: api })).exitCode).toBe(0);
});
