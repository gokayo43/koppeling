#!/usr/bin/env bun
/**
 * bin/build.ts: build the package as a host installs it.
 *
 *     bun run build
 *
 * tsdown writes the bundle and the rolled-up declaration into a staging
 * directory, and `dist/` is replaced only once that succeeded, so a failed
 * build never leaves a half-written artifact set staged for the next commit.
 * Exported as a function because the suite builds into a directory of its own
 * and compares the result with what `dist/` has committed.
 */
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * tsdown exits 0 while printing a declaration diagnostic on stdout (measured in
 * gokayo43/tcs-configurator-package on a TS2688), so its log is the gate.
 */
const hasTypeScriptDiagnostic = (log: string) => log.includes("error TS");

export async function buildPackage(outDir: string): Promise<string> {
  const staging = `${outDir}.building`;
  try {
    await rm(staging, { recursive: true, force: true });
    const child = Bun.spawn([join(ROOT, "node_modules/.bin/tsdown"), "--out-dir", staging], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const log = out + error;
    if (code !== 0 || hasTypeScriptDiagnostic(log)) throw new Error(`tsdown failed\n${log}`);
    await rm(outDir, { recursive: true, force: true });
    await rename(staging, outDir);
    return log;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(await buildPackage(join(ROOT, "dist")));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
