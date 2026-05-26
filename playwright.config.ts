/**
 * Playwright E2E config — Phase 1 trust surface hardening.
 *
 * These tests run against a fully-running stack (API + worker + web +
 * Postgres + Redis + MinIO). They are NOT mocks. They are the
 * regression gate for:
 *
 *   * critical evidence flows (create → upload → sign)
 *   * public verify privacy posture (no PII leakage)
 *   * rate-limit semantics (429 + Retry-After)
 *   * auth surface (guest, login, expired session)
 *   * landing-page reachability (browser-visible 200)
 *
 * Treat any failure here as a release blocker.
 *
 * Environment expected:
 *   - WEB_BASE=http://localhost:3000
 *   - API_BASE=http://localhost:8081
 *   - The CI workflow `playwright-e2e.yml` provisions these.
 */
import { defineConfig, devices } from "@playwright/test";

const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Phase 1 tests are deliberately small and serial — they share an
  // empty audit DB and we want deterministic ordering for the
  // public-verify privacy spec. CI parallelism can come later when
  // each spec stops creating evidence in the same workspace.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report" }]]
    : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
