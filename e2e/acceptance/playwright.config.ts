/**
 * The fresh-enterprise acceptance journey. Runs only against e2e/acceptance/stack.mjs:
 *   npx playwright test --config e2e/acceptance/playwright.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

// The isolation preflight and the API helpers read this; default it to the acceptance stack.
process.env.API_BASE ??= "http://localhost:8391";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "../../.p7tmp/acceptance-report.json" }]],
  outputDir: "../../.p7tmp/acceptance-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.WEB_BASE ?? "http://localhost:3511",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
});
