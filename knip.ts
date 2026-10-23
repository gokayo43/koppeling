import { base, mutationLaneDependencies } from "@gokayo43/dev-config/knip.base.ts";
import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ...base,
  ignoreDependencies: [...mutationLaneDependencies],
  // The programs under scripts/ are inferred from the package scripts that run
  // them; only their tests and src/server/migrate.ts have to be named — knip
  // reads the db:migrate script but stops at the worktree wrapper in front of
  // it. Naming scripts/ as a whole would make every module in there an entry,
  // and an entry's unused exports are never reported.
  entry: [
    "src/routes/**/*.{ts,tsx}",
    "src/server/migrate.ts",
    "tests/**/*.test.ts",
    "scripts/*.test.ts",
  ],
  // .css is in `project` so the Tailwind and font imports in styles.css are
  // followed; without it those packages read as unused.
  project: ["src/**/*.{ts,tsx,css}", "tests/**/*.ts", "scripts/**/*.ts"],
};

export default config;
