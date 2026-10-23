import { expect, test } from "bun:test";

// What app.ts does not export is what enforces the ordering rule stated above
// its composition: with no Elysia instance in reach, a route-lifecycle hook
// cannot be attached to the finished app, where it would fire for nothing.
//
// A fresh process, because importing this module opens the program's pools —
// and a namespace read there is the real export surface rather than a guess at
// it from the source.
test("app.ts hands out no framework instance", async () => {
  const module = new URL("../src/app.ts", import.meta.url).href;
  const proc = Bun.spawn(
    ["bun", "-e", `console.log(Object.keys(await import(${JSON.stringify(module)})).sort())`],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://probe:probe@127.0.0.1:1/probe",
        REDIS_URL: "redis://127.0.0.1:1",
        SITE_URL: "https://probe.example.com",
        PUBLIC_API_URL: "https://api.probe.example.com",
        BETTER_AUTH_SECRET: "probe-secret-that-is-long-enough-32",
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );

  expect((await new Response(proc.stdout).text()).trim()).toBe('[ "serve", "stop" ]');
  expect(await proc.exited).toBe(0);
});
