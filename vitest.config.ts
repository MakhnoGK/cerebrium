import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import swc from "unplugin-swc";

export default defineConfig({
  // tsconfig.json excludes test/, so point the resolver at the lint tsconfig, which
  // covers src + test + scripts and inherits the same `@/*` paths.
  plugins: [tsconfigPaths({ projects: ["tsconfig.eslint.json"] }), swc.vite()],
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // Deterministic, offline embeddings for every test (incl. buildCtx-based ones).
    env: { MEMORY_EMBED_PROVIDER: "local-null" },
  },
});
