import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // tsconfig.json excludes test/, so point the resolver at the lint tsconfig, which
  // covers src + test + scripts and inherits the same `@/*` paths.
  plugins: [tsconfigPaths({ projects: ["tsconfig.eslint.json"] })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Deterministic, offline embeddings for every test (incl. buildCtx-based ones).
    env: { MEMORY_EMBED_PROVIDER: "local-null" },
  },
});
