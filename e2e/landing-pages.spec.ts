/**
 * Phase 1 — browser-visible smoke test. Replaces (functionally) the
 * 20-line `scripts/e2e-web-smoke.mjs` which fails on cold-start in
 * dev mode because it doesn't wait for Next.js's first compile.
 *
 * Playwright's `page.goto()` waits for `load` by default, which is
 * exactly the warming behaviour we want.
 */
import { test, expect } from "@playwright/test";

const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/login",
  "/register",
  "/verify",
] as const;

test.describe("public landing surfaces @critical", () => {
  for (const path of PUBLIC_ROUTES) {
    test(`GET ${path} renders without error`, async ({ page }) => {
      const resp = await page.goto(path, { waitUntil: "load" });
      expect(resp?.ok(), `expected 2xx from ${path}, got ${resp?.status()}`).toBe(true);
      // Every public surface inherits the shared root layout title.
      await expect(page).toHaveTitle(/PROOVRA/i);
    });
  }

  test("authed pages render auth-gated shell when unauthenticated", async ({
    page,
  }) => {
    // /(app)/* pages render an 18KB SPA shell that hydrates and
    // either redirects to /login or renders a "Sign in" gate. We do
    // NOT assert that the data is present (because no session) — we
    // just assert the page loaded cleanly.
    const resp = await page.goto("/home");
    expect(resp?.ok()).toBe(true);
  });
});
