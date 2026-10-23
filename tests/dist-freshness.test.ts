import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPackage } from "../bin/build";

// dist/ is committed, because a host installs this repo by git ref and builds
// nothing (CLAUDE.md). A source change whose build was never committed ships
// nothing, so the committed artifacts are what this compares.
test("dist/ is exactly what a fresh build of this tree produces", async () => {
  const parent = await mkdtemp(join(tmpdir(), "koppeling-dist-"));
  const fresh = join(parent, "dist");
  const committed = join(import.meta.dir, "..", "dist");
  try {
    await buildPackage(fresh);
    const built = (await readdir(fresh)).toSorted();
    expect((await readdir(committed)).toSorted()).toEqual(built);
    for (const artifact of built) {
      expect(await Bun.file(join(committed, artifact)).text()).toBe(
        await Bun.file(join(fresh, artifact)).text(),
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);
