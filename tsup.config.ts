import { defineConfig } from "tsup";

// Native/wasm packages must not be bundled — they resolve their own binaries and
// wasm assets from node_modules at runtime (better-sqlite3 .node, sqlite-vec, the
// onnxruntime behind @huggingface/transformers, and the tree-sitter wasm grammars).
const external = [
  "better-sqlite3",
  "sqlite-vec",
  "@huggingface/transformers",
  "web-tree-sitter",
  "tree-sitter-wasms",
];

export default defineConfig({
  entry: [
    "src/server.ts",
    "src/daemon.ts",
    "src/stats-cli.ts",
    "src/service-cli.ts",
    "src/read-worker.ts",
    "src/embed-worker.ts",
  ],
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
