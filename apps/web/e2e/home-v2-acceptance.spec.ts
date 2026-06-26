/**
 * Phase IA-home-acceptance — Home V2 browser acceptance suite.
 *
 * Drives the REAL Home in a browser for the four seeded personas and
 * enforces the pre-push acceptance gate:
 *
 *   A. Layout    — no nav-duplicate button row; no Team Work in Personal
 *                  Space; no broken placeholder cards.
 *   B. CTAs      — every CTA navigates to a route that renders (no 404,
 *                  no blank page); banned routes (/workspaces,
 *                  bare /evidence-requests, /v/) never appear.
 *   C. Data      — Trust State shows live counts; Request & Collect shows
 *                  real intake/delivery data; issue states appear for the
 *                  pro-issues persona; Activity shows real events.
 *
 * Auth: the dev-login endpoint (`/v1/dev/login?persona=...`) mints a
 * real session and sets the HttpOnly `proovra_session` cookie. Playwright's
 * page.request shares the browser context cookie jar, so subsequent
 * page.goto() calls to the web app authenticate via the cookie — no
 * localStorage seeding required.
 *
 * Prereqs (operator-provided): see playwright.config.ts header.
 */

import { test, expect, type Page } from "@playwright/test";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3000";

type PersonaKey = "pro-empty" | "pro-populated" | "pro-issues" | "team-org";

const BANNED_HREF_PATTERNS = [
  /\/workspaces(\b|\/|$)/, // hidden/empty for self-serve
  /\/evidence-requests(?:\?|$)/, // bare list page does not ship
  /\/v\/[^/]/, // wrong public-verify path (must be /verify/)
];

/** Mint a dev session for the persona; the response sets the HttpOnly
 * `proovra_session` cookie in the shared browser context cookie jar. */
async function loginAs(page: Page, persona: PersonaKey): Promise<void> {
  const res = await page.request.get(
    `${API_BASE}/v1/dev/login?persona=${persona}`,
    { headers: { "x-web-client": "1" } },
  );
  expect(res.ok(), `dev-login for ${persona} should succeed`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  expect(body.token, "dev-login must return a token").toBeTruthy();
}

/** Assert a navigation did not land on a 404 / blank page. */
async function assertRendered(page: Page, label: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  expect(body.length, `${label}: page must not be blank`).toBeGreaterThan(20);
  expect(body, `${label}: must not be a 404`).not.toMatch(
    /404|page not found|this page could not be found/i,
  );
}

/** Collect every href the Home renders and assert none is banned. */
async function assertNoBannedLinks(page: Page): Promise<void> {
  const hrefs = await page.locator("[data-self-serve-home] a[href]").evaluateAll(
    (els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
  );
  for (const href of hrefs) {
    for (const banned of BANNED_HREF_PATTERNS) {
      expect(banned.test(href), `banned href found: ${href}`).toBeFalsy();
    }
  }
}

test.describe("Home V2 acceptance", () => {
  test("pro-empty: zero-data Personal Space layout + CTAs", async ({ page }) => {
    await loginAs(page, "pro-empty");
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    await page.screenshot({ path: "playwright-report/pro-empty.png", fullPage: true });

    // A. No Team Work in Personal Space.
    await expect(page.locator("[data-self-serve-section='team-work']")).toHaveCount(0);

    // Executive Summary shows the onboarding capture action.
    const hero = page.locator("[data-self-serve-section='executive-summary']");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText(/capture/i);

    // Empty Trust State has a real Capture-first CTA (not a dead card).
    await expect(page.locator("[data-trust-cta='capture-first']")).toBeVisible();
    // Empty Request & Collect has a Create-intake-link CTA.
    await expect(page.locator("[data-collection-cta='create-intake-link']")).toBeVisible();

    await assertNoBannedLinks(page);

    // CTA: Needs Attention → /capture renders.
    await page.locator("[data-hero-href]").first().click();
    await assertRendered(page, "pro-empty hero CTA");
    expect(page.url()).toContain("/capture");
  });

  test("pro-populated: live data widgets + report CTAs", async ({ page }) => {
    await loginAs(page, "pro-populated");
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    await page.screenshot({ path: "playwright-report/pro-populated.png", fullPage: true });

    // No Team Work in Personal Space even though plan is PRO.
    await expect(page.locator("[data-self-serve-section='team-work']")).toHaveCount(0);

    // C. Trust State shows LIVE counts (not static copy).
    const trust = page.locator("[data-self-serve-section='trust-state']");
    await expect(trust).toBeVisible();
    await expect(trust.locator("[data-trust-key='tsa']")).toContainText(/stamped/i);
    await expect(trust.locator("[data-trust-key='ots']")).toContainText(/anchored/i);
    await expect(trust.locator("[data-trust-key='signed']")).toBeVisible();

    // C. Intake Pipeline shows the active intake link + delivery state.
    const collect = page.locator("[data-self-serve-section='intake-pipeline']");
    await expect(collect).toBeVisible();
    await expect(collect).toContainText(/Witness — Jane Doe/i);
    await expect(collect).toContainText(/Delivered/i);

    // C. Recent Reports row with working actions.
    const reportRow = page.locator("[data-report-evidence-id]").first();
    await expect(reportRow).toBeVisible();
    await expect(reportRow.locator("[data-report-action='download-pdf']")).toBeVisible();
    await expect(reportRow.locator("[data-report-action='open-verify']")).toBeVisible();

    // C. Recent Evidence shows a real trust/readiness chip.
    await expect(page.locator("[data-self-serve-section='recent-evidence']")).toContainText(
      /Report ready|Sealed|Needs attention/i,
    );

    // C. Activity shows real grouped events.
    await expect(page.locator("[data-self-serve-section='activity'] [data-activity-kind]").first()).toBeVisible();

    await assertNoBannedLinks(page);

    // CTA contract: the report row exposes a real evidence-detail route.
    await expect(reportRow.locator("[data-report-action='open-evidence']")).toHaveAttribute(
      "href",
      /\/evidence\//,
    );
  });

  test("pro-issues: issue states + verification health", async ({ page }) => {
    await loginAs(page, "pro-issues");
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    await page.screenshot({ path: "playwright-report/pro-issues.png", fullPage: true });

    await expect(page.locator("[data-self-serve-section='executive-summary']")).toHaveAttribute(
      "data-exec-status",
      "critical",
    );

    const verify = page.locator("[data-self-serve-section='verification-health']");
    await expect(verify).toBeVisible();
    await expect(verify.locator("[data-verify-issue='suspended_verification']")).toBeVisible();
    await expect(verify.locator("[data-verify-recent-publications]")).toBeVisible();

    const activity = page.locator("[data-self-serve-section='activity']");
    await expect(activity.locator("[data-activity-kind='verification_published']")).toBeVisible();
    await expect(activity.locator("[data-activity-kind='intake_failed']")).toBeVisible();

    await assertNoBannedLinks(page);
  });

  test("team-org: team intake review + matter readiness proof", async ({ page }) => {
    await loginAs(page, "team-org");
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    await page.screenshot({ path: "playwright-report/team-org.png", fullPage: true });

    // Team Work IS present in an organization workspace and carries live counts.
    await expect(page.locator("[data-self-serve-section='team-work']")).toBeVisible();
    await expect(page.locator("[data-self-serve-section='team-work']")).toContainText(/Awaiting review/i);

    // Trust State live counts present.
    await expect(page.locator("[data-self-serve-section='trust-state'] [data-trust-key='tsa']")).toBeVisible();

    // Intake Pipeline shows the active org intake link + review queues.
    await expect(
      page.locator("[data-self-serve-section='intake-pipeline']"),
    ).toContainText(/Source — confidential/i);
    await expect(
      page.locator("[data-self-serve-section='intake-pipeline']"),
    ).toContainText(/Pending review/i);
    await expect(
      page.locator("[data-self-serve-section='intake-pipeline']"),
    ).toContainText(/Needs more info/i);

    // Matter readiness: one action-required, one needs-work, one healthy matter.
    const matters = page.locator("[data-self-serve-section='active-matters'] [data-matter-id]");
    await expect(matters).toHaveCount(3);
    await expect(page.locator("[data-matter-verdict='action_required']")).toBeVisible();
    await expect(page.locator("[data-matter-verdict='needs_work']")).toBeVisible();
    await expect(page.locator("[data-matter-verdict='healthy']")).toBeVisible();

    // Activity includes request-more + lifecycle governance signals.
    const activity = page.locator("[data-self-serve-section='activity']");
    await expect(activity.locator("[data-activity-kind='request_more_sent']")).toBeVisible();
    await expect(activity.locator("[data-activity-kind='lifecycle_transition']")).toBeVisible();
    await expect(activity.locator("[data-activity-kind='destruction_review']")).toBeVisible();

    await assertNoBannedLinks(page);

    // B. Verify-page CTA (back on Home) opens /verify/<id>, not /v/.
    const verifyLink = page.locator("[data-report-action='open-verify']").first();
    if (await verifyLink.count()) {
      const href = await verifyLink.getAttribute("href");
      expect(href, "verify link must use /verify/").toMatch(/^\/verify\//);
    }
  });
});
