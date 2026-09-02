/**
 * Playwright config for the admin control-plane verification matrix.
 *
 * Separate from apps/web/playwright.config.ts on purpose: that one targets the
 * Home acceptance suite on different ports with different prerequisites, and
 * merging them would make each suite's failure look like the other's.
 *
 * The servers are NOT started here. They need a migrated database and a seeded
 * fixture, and a config that silently starts a half-configured server produces
 * a suite that fails for reasons that have nothing to do with the pages:
 *
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node apps/web/scripts/dev-admin-fixture.mjs
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // The matrix walks 47 routes inside a single test body, so the per-test
  // budget is large by construction. The body sets its own timeout too.
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  // Serial: every worker would drive the same dev server, and a Next dev
  // server compiling four routes at once is the slowest possible arrangement.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Four levels up: this file sits in apps/web/e2e/admin-control-plane, so
  // three landed in apps/ and scattered artifacts into the wrong tree.
  outputDir: "../../../../artifacts/admin-matrix/playwright",
  use: {
    baseURL: process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3311",
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
});
