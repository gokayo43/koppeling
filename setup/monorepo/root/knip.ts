import { base } from "@gokayo43/dev-config/knip.base.ts";
import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ...base,
  workspaces: {
    // The worktree scripts live at the root and are run by the root's package
    // scripts, so the root workspace is not empty any more. The programs
    // themselves are inferred from those scripts; a directory-wide entry would
    // hide every unused export in the modules beside them.
    ".": { entry: ["scripts/*.test.ts"], project: ["scripts/**/*.ts"] },
    "apps/web": {
      entry: ["src/routes/**/*.{ts,tsx}", "tests/**/*.test.ts"],
      // .css is in `project` so the Tailwind and font imports in styles.css are
      // followed; without it those packages read as unused.
      project: ["src/**/*.{ts,tsx,css}", "tests/**/*.ts"],
    },
    "apps/api": {
      entry: ["tests/**/*.test.ts"],
      project: ["src/**/*.ts", "tests/**/*.ts"],
    },
    // scaffold:worker
    "apps/worker": {
      entry: ["tests/**/*.test.ts"],
      project: ["src/**/*.ts", "tests/**/*.ts"],
    },
    // scaffold:worker
  },
};

export default config;
