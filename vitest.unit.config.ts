import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "unit",
    include: [
      "tests/unit/**/*.test.ts",
      "lib/**/*.test.ts",
      "components/**/*.test.{ts,tsx}",
      "sidecar/src/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
