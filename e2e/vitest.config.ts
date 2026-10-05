import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["**/*.test.ts"],
    // feature-toggles.test.ts redeploys the API; no other file may run meanwhile.
    fileParallelism: false,
  },
});
