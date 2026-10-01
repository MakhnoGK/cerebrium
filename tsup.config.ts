import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const WORKSPACES = [
  "packages/contracts",
  "packages/kernel",
  "apps/host",
  "apps/plugin",
  "apps/dashboard-api",
];

// tsup externalizes only the root package.json's dependencies on its own, and those are
// declared per workspace. The workspaces themselves are source and must be bundled.
const declared = WORKSPACES.flatMap((dir) => {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}).filter((name) => !name.startsWith("@cerebrium/"));

// Native/wasm packages must not be bundled — they resolve their own binaries and
// wasm assets from node_modules at runtime (better-sqlite3 .node, sqlite-vec, the
// onnxruntime behind @huggingface/transformers, and the tree-sitter wasm grammars).
const external = [
  ...new Set([
    ...declared,
    "better-sqlite3",
    "sqlite-vec",
    "@huggingface/transformers",
    "web-tree-sitter",
    "tree-sitter-wasms",
  ]),
];

export default defineConfig({
  entry: {
    server: "apps/plugin/src/server.ts",
    daemon: "apps/host/src/daemon.ts",
    runner: "apps/host/src/runner.ts",
    "stats-cli": "apps/host/src/stats-cli.ts",
    "service-cli": "apps/host/src/service-cli.ts",
    "read-worker": "apps/host/src/read-worker.ts",
    "code-worker": "apps/host/src/code-worker.ts",
    "embed-worker": "apps/host/src/embed-worker.ts",
    healthcheck: "apps/host/src/healthcheck.ts",
    "import-sqlite": "apps/host/src/import-sqlite.ts",
    dashboard: "apps/dashboard-api/src/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  // Each bin is a self-contained bundle at the dist root, so import.meta.url resolves
  // to dist/ at runtime — copy-assets place migrations there to match.
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  external,
});
