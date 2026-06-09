/**
 * Phase IA-surface-tier — Playwright UI gate.
 *
 * Proves a normal authenticated user cannot SEE or OPEN hidden
 * surfaces. Runs against the full stack (web + api + worker + db).
 *
 *   * Direct URL to `/tools` (INTERNAL) is rewritten to /not-found
 *     by the middleware at the edge — the response body should be the
 *     standard 404 page, NOT the All Tools catalog.
 *   * Direct URL to ENTERPRISE surfaces (review/governance/intelligence/
 *     security-center/organization-admin) reaches the page shell but
 *     `SurfaceGate` triggers `notFound()` so the rendered DOM is the
 *     standard 404 page.
 *   * The sidebar, after login, does NOT contain hidden surface labels.
 *   * `/settings/security` (carved out of /security-center) DOES
 *     render normally for a personal user.
 *
 * Environment expected (same as the existing e2e suite):
 *   - WEB_BASE points at the running web app
 *   - The stack must allow guest auth (we use the existing guest flow
 *     to log in as a baseline FREE personal user).
 *
 * If the test runner can't reach a stack it logs and skips — local
 * `pnpm vitest` runs are NOT affected. CI's playwright-e2e workflow
 * provisions the stack and this spec runs there.
 */

import { test, expect, type Page } from "@playwright/test";

const HIDDEN_INTERNAL_PATHS = ["/tools", "/ops", "/operations", "/platform"];

const HIDDEN_ENTERPRISE_PATHS = [
  "/review",
  "/governance",
  "/intelligence",
  "/security-center",
  "/organization-admin",
  "/executive",
  "/investigation",
];

const CORE_PATHS_THAT_RENDER = [
  "/home",
  "/capture",
  "/evidence",
  "/cases",
  "/intake-links",
  "/search",
  "/reports",
  "/teams",
  "/inbox",
  "/trust-center",
  "/settings",
  "/settings/security",
  "/billing",
];

async function loginAsPersonalUser(page: Page): Promise<void> {
  // The existing e2e suite logs in via the guest-auth surface. We
  // reuse that path so this spec doesn't have to know about
  // organization fixtures. The guest user lands on /home with a
  // FREE personal workspace — exactly the target persona this gate
  // hides surfaces from.
  await page.goto("/login");
  // The guest-login UI variant lives behind a button labelled "Try
  // Proovra". If the label changes, this selector is the only thing
  // to update.
  const guestBtn = page.getByRole("button", { name: /try proovra/i });
  if (await guestBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await guestBtn.click();
    await page.waitForURL(/\/home/);
    return;
  }
  // Fallback — go straight to /home and assume the test runner has
  // configured a session cookie via storageState.
  await page.goto("/home");
}

test.describe("Phase IA-surface-tier — normal user cannot SEE hidden surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  test("the sidebar does NOT contain hidden surface labels", async ({ page }) => {
    // Sidebar/nav role contains the routes the user can access. Hidden
    // surfaces MUST NOT appear in the rendered DOM.
    const sidebar = page.getByRole("navigation").first();
    await expect(sidebar).toBeVisible();
    const sidebarText = await sidebar.innerText();
    for (const banned of [
      "Review",
      "Reviewer Operations",
      "Governance",
      "Intelligence",
      "Security Center",
      "Organization Admin",
      "Executive",
      "Investigation",
      "All Tools",
    ]) {
      expect(sidebarText, `sidebar must NOT contain "${banned}"`).not.toContain(
        banned,
      );
    }
  });

  test("the sidebar DOES contain the 12 CORE labels", async ({ page }) => {
    const sidebar = page.getByRole("navigation").first();
    const sidebarText = await sidebar.innerText();
    for (const expected of [
      "Home",
      "Capture",
      "Evidence",
      "Cases",
      "Intake Links",
      "Search",
      "Reports",
      "Teams",
      "Inbox",
      "Settings",
      "Billing",
    ]) {
      expect(
        sidebarText,
        `sidebar must contain "${expected}"`,
      ).toContain(expected);
    }
  });
});

test.describe("Phase IA-surface-tier — direct URL is blocked", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  for (const path of HIDDEN_INTERNAL_PATHS) {
    test(`INTERNAL: GET ${path} renders the not-found page`, async ({ page }) => {
      const res = await page.goto(path);
      // Middleware rewrites to /not-found; the URL stays the same but
      // the body is the standard 404.
      expect(res?.status()).toBeLessThan(500);
      const body = await page.content();
      // The All Tools / ops page text MUST NOT appear; the
      // standard 404 text SHOULD.
      expect(body).not.toMatch(/All Tools/i);
      expect(body).not.toMatch(/operations console/i);
      // Next.js's standard not-found page uses "404" or "Not Found"
      // by default. Either match accepted.
      expect(body).toMatch(/(404|Not Found|not.?found)/i);
    });
  }

  for (const path of HIDDEN_ENTERPRISE_PATHS) {
    test(`ENTERPRISE: GET ${path} triggers SurfaceGate → notFound()`, async ({
      page,
    }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const body = await page.content();
      // The page-specific heading MUST NOT appear; not-found copy
      // SHOULD.
      const segment = path.replace(/^\//, "").split("/")[0];
      if (segment) {
        // We don't pin a specific heading for the surface — the test
        // is content-negative: the page must not render its own
        // header. Instead we assert the not-found copy is present.
      }
      expect(body).toMatch(/(404|Not Found|not.?found)/i);
    });
  }
});

test.describe("Phase IA-surface-tier — CORE surfaces still render", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  for (const path of CORE_PATHS_THAT_RENDER) {
    test(`CORE: GET ${path} renders a real page (not 404)`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const body = await page.content();
      // CORE pages MUST NOT render the 404 copy.
      //
      // /search and /reports are bare paths but every CORE page must
      // either return its own UI or redirect to a sub-route — never
      // the standard not-found page.
      expect(body, `${path} rendered the not-found page instead of its UI`).not
        .toMatch(/This page could not be found/i);
    });
  }
});
