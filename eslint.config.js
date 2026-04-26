import tseslint from "typescript-eslint";

// `eslint-plugin-neverthrow@1.1.4` (the only published version, dated 2022)
// uses an old `@typescript-eslint` parserServices API that throws "types not
// available" when paired with `@typescript-eslint@8`. CLAUDE.md C11 mandates
// the `must-use-result` rule; until a compatible plugin lands (or we fork
// and patch), enforcement is convention + code review only. Tracked in
// docs/drift-log.md as drift from C11.

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "src-tauri/target/**",
      "dist/**",
      "apps/marketing/**",
      "sidecar/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".vitest-cache/**",
      "next-env.d.ts",
      "*.config.js",
      "*.config.ts",
      "*.config.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
