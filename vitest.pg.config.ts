import { globSync, readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// The ordinary suites rerun against Postgres (`npm run test:pg`), minus the files that
// declare themselves SQLite-only on their first line.
const sqliteOnly = globSync(["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"]).filter(
  (file) => readFileSync(file, "utf8").startsWith("// sqlite-only:"),
);

export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: ["**/node_modules/**", ...sqliteOnly],
      env: { CEREBRIUM_TEST_BACKEND: "postgres" },
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
