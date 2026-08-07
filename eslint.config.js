import js from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".tmp", "coverage", "test/fixtures"] },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // noUncheckedIndexedAccess makes the non-null assertion the idiomatic way to
      // consume a just-checked index/first row; banning it would fight the compiler.
      "@typescript-eslint/no-non-null-assertion": "off",
      // DB rows and JSON details are legitimately stringified into template errors.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // `env || "default"` must coalesce empty strings too — `??` would let an empty
      // env var through. Keep ?? mandatory for object/nullable operands.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
      // Provider stubs and MCP tool handlers are async by interface contract; not every
      // implementation needs an await.
      "@typescript-eslint/require-await": "off",
      // Allow `_`-prefixed intentional discards and dropping a key via rest-destructure.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Path aliases are the import contract: `@/…` for src, `@test/…` for test. A
    // parent-relative import resolves differently per tool (tsc, vitest, each IDE's
    // language server) and is what makes modules "not found" in some editors. Sibling
    // `./…` imports stay legal — they never cross a folder, so no alias applies.
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*", "../**"],
              message:
                "Use a path alias instead of a parent-relative import: '@/…' for src, '@test/…' for test.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests exercise error paths and cast raw rows freely; keep the strong async and
    // any rules, relax the ones that only add ceremony to fixtures.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Tests cast dynamic tool JSON to `any` and poke fields; that ergonomics is fine
      // in fixtures, unlike production code where the no-any rule stays on.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    files: ["**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", __filename: "readonly" },
    },
  },
  {
    files: ["src/core/**/*.ts", "src/domain/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/application/*",
                "@/presentation/*",
                "@/tools/*",
                "@/db/*",
                "@/code/*",
                "@/embeddings/*",
                "@/rerank/*",
                "@/consolidation/*",
                "@/runtime/*",
                "@/infrastructure/*",
              ],
              message: "core/domain are the innermost layers — they may not import outward.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/application/**/*.ts",
      "src/db/**/*.ts",
      "src/code/**/*.ts",
      "src/embeddings/**/*.ts",
      "src/rerank/**/*.ts",
      "src/consolidation/**/*.ts",
      "src/runtime/**/*.ts",
      "src/infrastructure/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/presentation/*", "@/tools/*"],
              message:
                "delivery is the outermost layer — depend on @/application or @/domain/ports instead.",
            },
          ],
        },
      ],
    },
  },
  prettierRecommended,
);
