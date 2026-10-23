import { expect } from "bun:test";

/**
 * Runs a script in a Bun process of its own and hands back what it printed.
 *
 * Both facts these tests are about — which API the browser talks to, and what a
 * call to it carries — are settled when a module is first evaluated, and every
 * test file in a run shares one module registry. So a case that needs its own
 * environment asks for its own process, and a stub that would otherwise answer
 * for every other suite's fetch dies with it.
 */
export async function freshProcess(
  script: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const printed = (await new Response(proc.stdout).text()).trim();

  expect(await proc.exited).toBe(0);
  return printed;
}
