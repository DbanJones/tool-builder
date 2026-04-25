import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 15000,
  },
});
