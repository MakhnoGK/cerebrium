import { defineConfig, type Options } from "tsup";

// A Claude Code plugin is copied into the plugin cache without node_modules, so every
// dependency is inlined and only node builtins stay external.
export const PLUGIN_BUILD = {
  entry: { server: "apps/plugin/src/plugin-server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "apps/plugin/dist",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  noExternal: [/.*/],
  // Inlined CommonJS dependencies call require() on node builtins, which ESM output lacks.
  banner: {
    js: 'import { createRequire as __cerebriumRequire } from "node:module"; const require = __cerebriumRequire(import.meta.url);',
  },
} satisfies Options;

export default defineConfig(PLUGIN_BUILD);
