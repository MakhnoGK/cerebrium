import swc from "unplugin-swc";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["tsconfig.json"] }), swc.vite()],
  test: {
    globals: true,
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["packages/kernel/test/setup.ts"],
    globalSetup: ["packages/kernel/test/pg-global-setup.ts"],
    // Deterministic, offline embeddings for every test (incl. buildCtx-based ones).
    env: { MEMORY_EMBED_PROVIDER: "local-null" },
  },
});
