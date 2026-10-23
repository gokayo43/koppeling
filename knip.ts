import { base } from "@gokayo43/dev-config/knip.base.ts";
import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ...base,
  // The module entry comes from `exports`, the build and the walk from the
  // scripts that run them.
  entry: ["tests/**/*.test.ts"],
  project: ["src/**/*.ts", "bin/**/*.ts", "tests/**/*.ts"],
};

export default config;
