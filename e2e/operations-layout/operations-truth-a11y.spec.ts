/**
 * OPERATIONS TRUTH — THE ACCESSIBILITY AND LANGUAGE MATRIX, IN A REAL ENGINE.
 *
 * The workbench's copy is the shared Operations dictionary (en / de / ar), and
 * the simple page is three sections. What jsdom cannot answer is whether that
 * page reflows, reads right-to-left, survives 200% zoom and announces what it
 * did. Every expected string here is READ from the dictionary the page renders
 * from, so a translation change cannot make this pass or fail by accident.
 *
 * Widths 320 / 375 / 768 / 1024 / 1440, in English, German and Arabic:
 *   * the page never scrolls horizontally;
 *   * the heading and the three section titles are in the reader's language;
 *   * Arabic is right-to-left at the document root.
 * 200% zoom (a 1440-pixel window at 200% is a 720-pixel layout viewport):
 *   * no horizontal scroll; the drawer opens, fits, closes on Escape and
 *     returns focus to what opened it.
 * Live announcement:
 *   * acknowledging a condition is announced in the polite live region, in
 *     the reader's language.
 * Light theme only: a dark colour-scheme preference changes nothing.
 */
import { test, expect, type Page } from "@playwright/test";

import { fillOperationsCopy, operationsDict } from "../../packages/shared/src/i18n";
import {
  hasHorizontalOverflow,
  openOperations,
  showAllConditions,
  showGroupedQueue,
} from "./_fixtures";

const LOCALES = ["en", "de", "ar"] as const;
const WIDTHS = [320, 375, 768, 1024, 1440] as const;

async function useLocale(page: Page, locale: (typeof LOCALES)[number]) {
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem("proovra-locale", l);
      window.localStorage.setItem("proovra-locale-mode", "manual");
    } catch {
      /* storage unavailable: the page stays in English and the test says so */
    }
  }, locale);
}

for (const locale of LOCALES) {
  const copy = operationsDict[locale];
  for (const width of WIDTHS) {
    test(`simple page at ${width}px in ${locale}: no horizontal scroll, sections in the reader's language`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await useLocale(page, locale);
      await openOperations(page, "team-admin");
      await showGroupedQueue(page);

      await expect(page.locator("h1").first()).toHaveText(copy.pageTitle);
      await expect(page.locator('[data-ops-section="action-required"] h2')).toHaveText(copy.sectionActionRequired);
      await expect(page.locator('[data-ops-section="monitoring"] h2')).toHaveText(copy.sectionMonitoring);
      await expect(page.locator('[data-ops-section="recently-resolved"] h2')).toHaveText(copy.sectionRecentlyResolved);
      expect(await page.evaluate(() => document.documentElement.dir)).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(await hasHorizontalOverflow(page), `horizontal scroll at ${width}px in ${locale}`).toBe(false);
    });
  }
}

test("200% zoom: the page reflows, the drawer fits, Escape closes it and focus returns", async ({ page }) => {
  // A 1440 x 900 window at 200%: the layout viewport is 720 x 450 CSS px.
  await page.setViewportSize({ width: 720, height: 450 });
  await openOperations(page, "team-admin");
  await showAllConditions(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);

  const opener = page.locator("[data-ops-open]:visible").first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator("[data-ops-inspector]");
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box, "the drawer is laid out").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(721);
  expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
});

for (const locale of LOCALES) {
  test(`acknowledging is announced in the live region, in ${locale}`, async ({ page }) => {
    await useLocale(page, locale);
    await openOperations(page, "team-admin");
    await showAllConditions(page);
    await page.locator("[data-ops-open]:visible").first().click();
    const drawer = page.locator("[data-ops-inspector]");
    await expect(drawer).toBeVisible();
    await drawer.locator('[data-ops-action="acknowledge"]').click();
    const live = page.locator("[data-ops-live]");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveText(operationsDict[locale].announceAcknowledged);
  });
}

test("a dark colour-scheme preference does not switch the workbench to a dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openOperations(page, "team-admin");
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(100);
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).toBe(light);
});

// ===========================================================================
// The user-visible truths these findings were about, in the shipped bundle.
// ===========================================================================

test("OPS-030 Stop notifying asks why, confirms, and sends the reason", async ({ page }) => {
  await openOperations(page, "team-admin");
  await showAllConditions(page);
  await page.locator("[data-ops-open]:visible").first().click();
  const drawer = page.locator("[data-ops-inspector]");
  await drawer.locator('[data-ops-action="suppress"]').click();
  const confirm = drawer.locator('[data-ops-action="suppress-confirm"]');
  await expect(confirm).toBeDisabled();
  await drawer.locator("[data-ops-suppress-reason-input]").fill("Planned maintenance window");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const modal = page.locator('[data-confirm-action-modal="ops-suppress-confirm"]');
  await expect(modal).toBeVisible();
  const [sent] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && /\/v1\/ops\/incidents\/[^/]+\/suppress$/.test(new URL(r.url()).pathname)),
    modal.getByRole("button", { name: operationsDict.en.stopNotifying }).click(),
  ]);
  expect(JSON.parse(sent.postData() ?? "{}")).toMatchObject({ reason: "Planned maintenance window" });
});

test("OPS-011 a bulk run the server reports COMPLETED is counted as done", async ({ page }) => {
  await openOperations(page, "team-admin");
  await showAllConditions(page);
  const marks = page.locator("[data-ops-table-surface] [data-ops-row-mark]");
  const ids = [await marks.nth(0).getAttribute("data-ops-row-mark"), await marks.nth(1).getAttribute("data-ops-row-mark")];
  await marks.nth(0).check();
  await marks.nth(1).check();
  await page.route("**/v1/ops/bulk-actions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: "run-1", status: "COMPLETED", items: ids.map((targetId) => ({ targetId, status: "COMPLETED" })) }),
    }),
  );
  await page.locator('[data-ops-bulk-action="acknowledge"]').click();
  await expect(page.locator("[data-ops-bulk-outcome]")).toHaveText(
    fillOperationsCopy(operationsDict.en.bulkUpdated, { done: 2, total: 2 }),
  );
});

test("OPS-036 a failed grouped read is unavailable, never '0 groups' and never clear", async ({ page }) => {
  await openOperations(page, "team-admin");
  await showGroupedQueue(page);
  await page.route(/\/v1\/ops\/incident-groups\?/, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal" } }) }),
  );
  await page.locator("[data-ops-refresh]").click();
  await expect(page.locator("[data-ops-groups-unavailable]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-ops-section="action-required"]')).toHaveCount(0);
  await expect(page.getByText(/0 groups/)).toHaveCount(0);
});
