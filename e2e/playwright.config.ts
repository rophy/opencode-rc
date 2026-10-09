import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.UI_URL || "http://opencode-rc-ui:8080",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      testIgnore: /revocation\.spec\.ts/,
    },
    // Revokes Alice, the only user with a dev session: runs after every other test.
    {
      name: "revocation",
      use: { browserName: "chromium" },
      testMatch: /revocation\.spec\.ts/,
      dependencies: ["chromium"],
    },
  ],
});
