import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/types/**"],
    },
  },
});
