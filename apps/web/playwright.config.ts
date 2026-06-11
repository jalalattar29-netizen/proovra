/**
 * Phase IA-home-acceptance — Playwright config for the Home V2 acceptance
 * suite.
 *
 * Prereqs (NOT started by this config — they require a DB + secrets the
 * CI/local operator must provide):
 *   1. Postgres up + migrated.
 *   2. `DEV_AUTH_ENABLED=true` + `AUTH_JWT_SECRET=<secret>` in the API env.
 *   3. `pnpm --filter proovra-api seed:home-personas` has been run.
 *   4. API server on API_BASE (default http://localhost:4000).
 *   5. Web dev server on WEB_BASE (default http://localhost:3000).
 *
 * Run:  pnpm --filter proovra-web exec playwright test e2e/home-v2-acceptance.spec.ts
 */

import { defineConfig, devices } from "@playwright/test";

const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: WEB_BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
