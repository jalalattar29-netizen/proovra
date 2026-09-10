/**
 * PHASE 6 §13/§16/§19 — THE OPERATOR JOURNEYS, IN A REAL BROWSER.
 *
 * A registry entry is not runtime proof. These drive the console the way an
 * operator does: sign in, filter, drill down, read the breadcrumb, come back,
 * and check that what they had is still there.
 *
 * Prerequisites, the same ones the sibling admin specs take:
 *   node services/api/scripts/dev-admin-fixture-api.mjs --api-port=8199 …
 *   node apps/web/scripts/dev-admin-fixture.mjs --port=3331 --api-port=8199
 */

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  passwordSignInCount,
  resetPasswordSignInCount,
  signInAsFixtureUser,
} from "./_fixture-login";

const WEB = process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3331";
const PASSWORD = "fixture-local-only-password";
const PLATFORM_ADMIN = "platform-admin@fixture.local";

/**
 * ONE REAL SIGN-IN FOR THE WHOLE FILE, THEN ISOLATED CONTEXTS FROM IT.
 *
 * Every test here used to perform its own password login. The API limits
 * logins to ten per IP per sixty seconds (`auth:email-login:ip:<ip>`), and the
 * whole suite reaches it as 127.0.0.1, so seven logins from this file alone
 * spent most of the shared allowance — two of these tests then failed with
 * HTTP 429 RATE_LIMITED before reaching a single product assertion.
 *
 * These are information-architecture tests: breadcrumbs, headings, navigation
 * geometry. They need an authenticated Platform Admin; they do not need to
 * re-prove password authentication seven times. `admin-journey-console.spec.ts`
 * remains the authority for the real sign-in journey and is untouched.
 *
 * So the password login happens ONCE, in `beforeAll`, and its storage state
 * seeds a fresh context per test. Playwright still gives every test its own
 * context, cookies and storage, and still closes it — isolation is unchanged
 * and no test depends on another running first.
 *
 * The state file is written to the OS temp directory, never into the
 * repository, and holds only what Playwright serialises for the session.
 */
const STORAGE_STATE = path.join(
  os.tmpdir(),
  `proovra-admin-phase6-state-${process.pid}.json`,
);

test.beforeAll(async ({ browser }) => {
  resetPasswordSignInCount();
  /*
   * `storageState: undefined` on purpose. `test.use({ storageState })` below
   * also applies to contexts created from the `browser` fixture, so without
   * this the sign-in context tries to read the very file it exists to write.
   */
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  try {
    await signInAsFixtureUser(page, PLATFORM_ADMIN, { web: WEB, password: PASSWORD });
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await context.close();
  }
});

test.afterAll(async () => {
  /*
   * The contract, proven by the fixture rather than by counting source text:
   * this file performs exactly one password login however its helpers are
   * arranged. If someone reintroduces a per-test sign-in, this fails here
   * instead of surfacing as a 429 in an unrelated shard days later.
   */
  expect(
    passwordSignInCount(),
    "admin journey tests must authenticate once, not per test — the login limiter is shared by the whole suite",
  ).toBe(1);
  await fs.rm(STORAGE_STATE, { force: true });
});

test.use({ storageState: STORAGE_STATE });

function collectConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/**
 * Console noise that is not a page defect.
 *
 * A 4xx logged by the browser is a correctly-refused request on a
 * workspace-scoped surface opened without a workspace; failing on it would be
 * asserting that a correct refusal is a bug. A script error, a hydration
 * mismatch or a 5xx still fails.
 */
function fatalOnly(errors: string[]) {
  return errors.filter(
    (e) =>
      !/favicon|ResizeObserver|Download the React DevTools/i.test(e) &&
      !/status of 40[0-9]/i.test(e),
  );
}

const crumbs = (page: Page) => page.locator('nav[aria-label="Breadcrumb"] li');

test.describe("PHASE 6 — Admin information architecture", () => {
  test("every section of the console is reachable and renders one H1", async ({ page }) => {
    const errors = collectConsole(page);

    const sections = [
      "/admin",
      "/admin/customers",
      "/admin/evidence-ops",
      "/admin/identity",
      "/admin/security",
      "/admin/platform-health",
      "/admin/platform/runbooks",
      "/admin/dashboard",
    ];
    for (const href of sections) {
      await page.goto(`${WEB}${href}`, { waitUntil: "networkidle", timeout: 90_000 });
      await expect(page.locator("main"), `${href}: no main content`).toBeVisible({
        timeout: 30_000,
      });
      // §14 — exactly one canonical page H1.
      const h1 = page.locator("main h1");
      expect(await h1.count(), `${href}: expected exactly one H1`).toBe(1);
    }

    const hydration = errors.filter((e) =>
      /hydrat|did not match|Text content does not match/i.test(e),
    );
    expect(hydration, "hydration errors across the console").toEqual([]);
    expect(fatalOnly(errors), "console errors across the console").toEqual([]);
  });

  test("Runbooks are reachable without anything being broken first", async ({ page }) => {
    /*
     * §9 — an operator tool must not be discoverable only after a failure.
     * The catalog was the twelfth entry of a thirteen-entry Operations
     * section; it is a top-level destination now.
     */
    await page.goto(`${WEB}/admin`, { waitUntil: "networkidle", timeout: 90_000 });
    const link = page.locator('a[href="/admin/platform/runbooks"]').first();
    await expect(link, "Runbooks is not offered in navigation").toBeVisible({ timeout: 20_000 });
    await link.click();
    await page.waitForURL(/\/admin\/platform\/runbooks$/, { timeout: 30_000 });
    await expect(page.locator("main")).toBeVisible();
  });

  test("the runbook READER has a breadcrumb that names it and leads back", async ({ page }) => {
    /*
     * §6 — the defect this phase found. The reader matched the catalog by
     * prefix and no contextual rule claimed it, so it rendered the CATALOG's
     * breadcrumb: nothing naming the runbook, nothing back to the catalog, on
     * the one surface an operator reaches mid-incident.
     */
    await page.goto(`${WEB}/admin/platform/runbooks/tsa-timestamp-failure`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });

    const texts = await crumbs(page).allInnerTexts();
    expect(texts.length, "the runbook reader has no breadcrumb").toBeGreaterThanOrEqual(3);

    const back = page.locator(
      'nav[aria-label="Breadcrumb"] a[href="/admin/platform/runbooks"]',
    );
    await expect(back, "no crumb returns to the runbook catalog").toHaveCount(1);

    const last = texts[texts.length - 1]!.trim();
    expect(last.length, "the final crumb is empty").toBeGreaterThan(0);
    expect(last, "the final crumb is the type name, not the document").not.toBe("Runbook");
  });

  test("customer investigation: filter, drill down, return with the filter intact", async ({
    page,
  }) => {
    /*
     * §7/§13 — the journey this phase exists for. The assertion that matters
     * is the last one: the return lands on the FILTERED list, not on page one
     * of everything.
     */
    await page.goto(`${WEB}/admin/customers?search=Northwind`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });

    const row = page.locator("table tbody tr").first();
    await expect(row, "the filtered customer list has no rows to open").toBeVisible({
      timeout: 30_000,
    });
    await row.click();
    await page.waitForURL(/\/admin\/customers\/[^/?]+/, { timeout: 30_000 });

    expect(page.url(), "the list state did not travel to the detail").toContain("back=");

    /*
     * Wait for the RECORD, not for the route.
     *
     * The crumb can only name the customer once the page has fetched it, and
     * reading the crumbs the instant the URL changes reads them mid-load —
     * where the honest fallback is still showing. Waiting on the heading is
     * waiting on the same fetch the crumb depends on.
     */
    await expect(page.locator("main h1")).toHaveText(/Northwind/, { timeout: 30_000 });

    const texts = await crumbs(page).allInnerTexts();
    expect(texts.length, "the customer detail has no breadcrumb").toBeGreaterThanOrEqual(3);
    const lastCrumb = texts[texts.length - 1]!.trim();
    expect(
      lastCrumb,
      "the final crumb is the type name, not the customer",
    ).not.toBe("Customer");
    expect(lastCrumb, "the final crumb does not name this customer").toContain("Northwind");

    const back = page
      .locator('nav[aria-label="Breadcrumb"] a[href^="/admin/customers"]')
      .last();
    await expect(back, "no return crumb to the customer directory").toBeVisible();
    const backHref = await back.getAttribute("href");
    expect(backHref, "the return crumb dropped the filter").toContain("search=Northwind");

    await back.click();
    await page.waitForURL(/\/admin\/customers\?/, { timeout: 30_000 });
    expect(page.url(), "the operator did not return to the filtered list").toContain(
      "search=Northwind",
    );
  });

  test("the breadcrumb is a labelled landmark and the current item is marked", async ({
    page,
  }) => {
    // §16 — semantic nav, aria-current, a visible current item.
    await page.goto(`${WEB}/admin/customers`, { waitUntil: "networkidle", timeout: 90_000 });

    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(1);
    const current = page.locator('[aria-current="page"]');
    expect(await current.count(), "nothing is marked as the current page").toBeGreaterThan(0);
  });

  test("navigation holds at a phone width without pushing the page sideways", async ({
    page,
  }) => {
    // §16 — 320px is the floor this console has to hold.
    await page.setViewportSize({ width: 320, height: 720 });
    for (const href of ["/admin", "/admin/customers", "/admin/platform/runbooks"]) {
      await page.goto(`${WEB}${href}`, { waitUntil: "networkidle", timeout: 90_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${href}: the page scrolls horizontally at 320px`).toBeLessThanOrEqual(2);
    }
  });

  test("a missing entity is a dead record, not a dead end", async ({ page }) => {
    /*
     * §15 — the breadcrumb must survive a record that is gone, and the
     * operator must still have a way back to the collection. The entity crumb
     * falls back to the type name rather than going blank.
     */
    await page.goto(`${WEB}/admin/customers/00000000-0000-4000-8000-00000000dead`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });

    const back = page.locator('nav[aria-label="Breadcrumb"] a[href^="/admin/customers"]');
    await expect(back, "a missing record left no way back to the collection").toHaveCount(1);
    for (const t of await crumbs(page).allInnerTexts()) {
      expect(t.trim().length, "an empty crumb breaks the chain").toBeGreaterThan(0);
    }
  });
});
