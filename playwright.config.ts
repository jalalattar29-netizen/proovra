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
      testDir: "./e2e",
      testIgnore: "point7/**",
      use: { ...devices["Desktop Chrome"] },
    },
    /**
     * PHASE 12 — POINT 7: the product-behaviour browser matrix.
     *
     * Its own project because it needs its own stack (a disposable
     * PostgreSQL 16 + Redis + MinIO on dedicated ports, addressed through
     * `P7_DATABASE_URL`, `WEB_BASE` and `API_BASE`) and its own run
     * identifier — see `e2e/point7/_global-setup.ts`. Kept out of the Phase-1
     * project above via `testIgnore` so the two never share a database.
     *
     * Serial for the same reason the Phase-1 project is: the specs seed
     * overlapping tenant namespaces in one database, and cross-tenant
     * assertions must not race another spec's fixtures.
     */
    {
      name: "point7",
      testDir: "./e2e/point7",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  globalSetup: process.env.POINT7 ? "./e2e/point7/_global-setup.ts" : undefined,
  globalTeardown: process.env.POINT7
    ? "./e2e/point7/_global-teardown.ts"
    : undefined,
});
