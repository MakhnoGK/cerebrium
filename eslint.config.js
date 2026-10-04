import js from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

const TS = ["**/*.ts", "**/*.mts"];
const within = (...dirs) => dirs.flatMap((dir) => TS.map((glob) => `${dir}/${glob}`));

// Path aliases are the import contract. A parent-relative import resolves differently per
// tool (tsc, vitest, each IDE's language server) and is what makes modules "not found" in
// some editors. Sibling `./…` imports stay legal — they never cross a folder.
const PARENT_RELATIVE = {
  group: ["../*", "../**"],
  message:
    "Use a path alias instead of a parent-relative import: '@/…' inside the kernel, '@cerebrium/…' from an app, '@test/…' for kernel test helpers.",
};
const CONTRACTS_BOUNDARY = {
  group: ["@/*", "@cerebrium/kernel/*", "@host/*", "@plugin/*", "@test/*", "@scripts/*"],
  message: "contracts are the wire both sides share — they depend on nothing else in the repo.",
};
const KERNEL_BOUNDARY = {
  group: ["@host/*", "@plugin/*", "@cerebrium/kernel/*"],
  message: "the kernel may not depend on an app, and names its own modules as '@/…'.",
};
const HOST_BOUNDARY = {
  group: ["@/*", "@plugin/*"],
  message: "the host reaches the kernel as '@cerebrium/kernel/…' and may not depend on the plugin.",
};
const DASHBOARD_API_BOUNDARY = {
  group: ["@/*", "@host/*", "@plugin/*"],
  message: "the dashboard backend talks to the kernel over its socket, never to its internals.",
};
const DASHBOARD_WEB_BOUNDARY = {
  group: ["@/*", "@cerebrium/kernel/*", "@host/*", "@plugin/*"],
  message: "the browser app reaches Cerebrium only through the dashboard API.",
};
const PLUGIN_BOUNDARY = {
  group: ["@/*", "@host/*"],
  message: "the plugin reaches the kernel as '@cerebrium/kernel/…' and may not depend on the host.",
};
const CORE_INWARD = {
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
};
const NO_DELIVERY = {
  group: ["@/presentation/*", "@/tools/*"],
  message: "delivery is the outermost layer — depend on @/application or @/domain/ports instead.",
};
const DELIVERY_VIA_USE_CASES = {
  group: [
    "@/db/*",
    "@/application/services/*",
    "@/application/services",
    "@/application/retrieval",
    "@/application/retrieval/*",
    "@/code/*",
    "@/embeddings/*",
    "@/consolidation/*",
  ],
  message:
    "delivery may not reach the kernel directly — resolve a use-case token from @/application/use-cases instead.",
};

// Each block names every pattern that applies to its files: a later block's rule replaces an
// earlier one for the same file rather than adding to it.
const restrict = (...patterns) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { patterns }],
});
const KERNEL = "packages/kernel/src";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/node_modules",
      ".tmp",
      "coverage",
      "**/test/fixtures",
      // The `claude-code` module types exist only inside a Claude Code session.
      "apps/plugin/install/claude-mod/hooks/register.ts",
      "apps/plugin/install/claude-mod/tests",
      "apps/plugin/install/claude-mod/.claude-plugin/types",
    ],
  },
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
  { files: within("packages/contracts"), rules: restrict(PARENT_RELATIVE, CONTRACTS_BOUNDARY) },
  { files: within("packages/kernel"), rules: restrict(PARENT_RELATIVE, KERNEL_BOUNDARY) },
  { files: within("apps/host"), rules: restrict(PARENT_RELATIVE, HOST_BOUNDARY) },
  { files: within("apps/plugin"), rules: restrict(PARENT_RELATIVE, PLUGIN_BOUNDARY) },
  {
    files: within("apps/dashboard-api"),
    rules: {
      ...restrict(PARENT_RELATIVE, DASHBOARD_API_BOUNDARY),
      // A Nest module is a decorated class with nothing in its body.
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },
  {
    // The browser app has its own compiler settings (DOM, JSX).
    files: within("apps/dashboard-web"),
    languageOptions: {
      parserOptions: {
        project: ["./apps/dashboard-web/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: restrict(PARENT_RELATIVE, DASHBOARD_WEB_BOUNDARY),
  },
  {
    // Tests exercise error paths and cast raw rows freely; keep the strong async and
    // any rules, relax the ones that only add ceremony to fixtures.
    files: ["**/test/**/*.ts"],
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
    files: within(`${KERNEL}/core`, `${KERNEL}/domain`),
    rules: restrict(PARENT_RELATIVE, KERNEL_BOUNDARY, CORE_INWARD),
  },
  {
    files: within(
      `${KERNEL}/application`,
      `${KERNEL}/db`,
      `${KERNEL}/code`,
      `${KERNEL}/embeddings`,
      `${KERNEL}/rerank`,
      `${KERNEL}/consolidation`,
      `${KERNEL}/runtime`,
      `${KERNEL}/infrastructure`,
    ),
    rules: restrict(PARENT_RELATIVE, KERNEL_BOUNDARY, NO_DELIVERY),
  },
  {
    files: within(`${KERNEL}/presentation`),
    rules: restrict(PARENT_RELATIVE, KERNEL_BOUNDARY, DELIVERY_VIA_USE_CASES),
  },
  prettierRecommended,
);
