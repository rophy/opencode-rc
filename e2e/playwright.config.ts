import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.GATEWAY_URL || "http://gateway:8080",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
