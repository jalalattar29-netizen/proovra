/**
 * Phase IA-home-acceptance — Home V2 browser acceptance suite.
 *
 * Drives the REAL Home in a browser for the three seeded personas and
 * enforces the pre-push acceptance gate:
 *
 *   A. Layout    — no nav-duplicate button row; no Team Work in Personal
 *                  Space; no broken placeholder cards.
 *   B. CTAs      — every CTA navigates to a route that renders (no 404,
 *                  no blank page); banned routes (/workspaces,
 *                  bare /evidence-requests, /v/) never appear.
 *   C. Data      — Trust State shows live counts; Request & Collect shows
 *                  real intake/delivery data; Submissions appears for the
 *                  team-org persona; Activity shows real events.
 *
 * Auth: the dev-login endpoint (`/v1/dev/login?persona=...`) mints a
 * real session token; we seed it into localStorage as the web app
 * expects (`proovra-token`) before loading /home.
 *
 * Prereqs (operator-provided): see playwright.config.ts header.
 */

import { test, expect, type Page } from "@playwright/test";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3000";

type PersonaKey = "pro-empty" | "pro-populated" | "team-org";

const BANNED_HREF_PATTERNS = [
  /\/workspaces(\b|\/|$)/, // hidden/empty for self-serve
  /\/evidence-requests(?:\?|$)/, // bare list page does not ship
  /\/v\/[^/]/, // wrong public-verify path (must be /verify/)
];

/** Mint a dev session for the persona and inject it into the web origin. */
async function loginAs(page: Page, persona: PersonaKey): Promise<void> {
  const res = await page.request.get(
    `${API_BASE}/v1/dev/login?persona=${persona}`,
    { headers: { "x-web-client": "1" } },
  );
  expect(res.ok(), `dev-login for ${persona} should succeed`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  expect(body.token, "dev-login must return a token").toBeTruthy();

  // Seed the token the way the web app reads it (localStorage), then load.
  await page.addInitScript((token) => {
    window.localStorage.setItem("proovra-token", token);
  }, body.token);
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

    // A. No nav-duplicate button row in the header.
    const headerLinks = await page.locator("[data-self-serve-home] header a").count();
    expect(headerLinks, "header must have no button row").toBe(0);

    // A. No Team Work in Personal Space.
    await expect(page.locator("[data-self-serve-section='team-work']")).toHaveCount(0);

    // Needs Attention shows the onboarding capture action.
    const hero = page.locator("[data-self-serve-section='needs-attention']");
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

    // C. Request & Collect shows the active intake link + delivery state.
    const collect = page.locator("[data-self-serve-section='request-and-collect']");
    await expect(collect).toBeVisible();
    await expect(collect.locator("[data-collection-id]")).toHaveCount(1);
    await expect(collect.locator("[data-delivery-status='DELIVERED']")).toBeVisible();

    // C. Recent Reports row with working actions.
    const reportRow = page.locator("[data-report-evidence-id]").first();
    await expect(reportRow).toBeVisible();
    await expect(reportRow.locator("[data-report-action='download-pdf']")).toBeVisible();
    await expect(reportRow.locator("[data-report-action='open-verify']")).toBeVisible();

    // C. Recent Evidence shows a real verification chip.
    await expect(
      page.locator("[data-self-serve-section='recent-evidence'] [data-evidence-verification]").first(),
    ).toBeVisible();

    // C. Activity shows real grouped events.
    await expect(page.locator("[data-self-serve-section='activity'] [data-activity-kind]").first()).toBeVisible();

    await assertNoBannedLinks(page);

    // CTA: Open report → evidence detail renders.
    await reportRow.locator("[data-report-action='open-evidence']").click();
    await assertRendered(page, "pro-populated open report");
    expect(page.url()).toMatch(/\/evidence\//);
  });

  test("team-org: submissions + collection + verify-page CTA", async ({ page }) => {
    await loginAs(page, "team-org");
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    await page.screenshot({ path: "playwright-report/team-org.png", fullPage: true });

    // F. Pending submission appears on Home.
    const submissions = page.locator("[data-self-serve-section='submissions-to-review']");
    await expect(submissions).toBeVisible();
    const firstSubmission = submissions.locator("[data-submission-id]").first();
    await expect(firstSubmission).toBeVisible();

    // Team Work IS present in an organization workspace.
    await expect(page.locator("[data-self-serve-section='team-work']")).toBeVisible();

    // Trust State live counts present.
    await expect(page.locator("[data-self-serve-section='trust-state'] [data-trust-key='tsa']")).toBeVisible();

    // Request & Collect shows the active org intake link.
    await expect(
      page.locator("[data-self-serve-section='request-and-collect'] [data-collection-id]").first(),
    ).toBeVisible();

    await assertNoBannedLinks(page);

    // F. Review CTA opens the working evidence-request detail (NOT a bare list).
    await firstSubmission.locator("[data-submission-action='review']").click();
    await assertRendered(page, "team-org review submission");
    expect(page.url(), "review must open /evidence-requests/<id>").toMatch(
      /\/evidence-requests\/[0-9a-f-]+/,
    );

    // B. Verify-page CTA (back on Home) opens /verify/<id>, not /v/.
    await page.goto(`${WEB_BASE}/home`);
    await page.waitForSelector("[data-self-serve-home-state='ready']");
    const verifyLink = page.locator("[data-report-action='open-verify']").first();
    if (await verifyLink.count()) {
      const href = await verifyLink.getAttribute("href");
      expect(href, "verify link must use /verify/").toMatch(/^\/verify\//);
    }
  });
});
