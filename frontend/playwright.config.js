import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [["line"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_FRONTEND_URL || "http://127.0.0.1:5174",
    extraHTTPHeaders: { "X-User-Id": process.env.PLAYWRIGHT_USER_ID || "1" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
