import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "src-tauri/target/**",
      "dist/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".vitest-cache/**",
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
  // TODO(@dennis, A2): enable eslint-plugin-neverthrow `must-use-result` per
  // CLAUDE.md C11 once the first Result-returning function exists in A2
  // (keychain wrapper). Currently no-op because no Results exist yet.
);
