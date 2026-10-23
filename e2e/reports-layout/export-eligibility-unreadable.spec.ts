/**
 * AN UNREADABLE EXPORT-ELIGIBILITY ANSWER NEVER TAKES THE PAGE DOWN
 * (2026-10-23).
 *
 * Reproduced in this project's own fixture: a body without a recognised
 * `outcome` (here `{ items: [] }`, what an unintercepted route answered) made
 * GovernedExportAction index its tone table with `undefined`, the render
 * threw, and the whole Reports page fell to the global 500 screen — every
 * row, for one row's check. The response is now READ at the fetch boundary:
 * an unreadable answer is an unavailable check, the export stays disabled,
 * and the rest of the page keeps working.
 */

import { expect, test } from "@playwright/test";

import { openReports } from "./_fixtures";

for (const [name, body] of [
  ["a list instead of a verdict", { items: [] }],
  ["an unknown verdict", { outcome: "SOMETHING_NEW", reason: "x", lifecycleState: null }],
  ["no body at all", null],
] as const) {
  test(`${name}: the page stays up, each export is disabled and says why`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 1366, height: 900 });
    await openReports(page, "en", "", body);

    // Not the global error screen; the list and its rows are there.
    await expect(page.locator("body")).not.toContainText("Something went wrong on our end");
    await expect(page.locator("[data-reports-list]")).toBeVisible();
    expect(pageErrors, "no uncaught render error").toEqual([]);

    // Every governed export resolves to the unavailable state — never enabled.
    const unavailable = page.locator("[data-governed-export-error]");
    await expect(unavailable.first()).toBeVisible();
    await expect(unavailable.first()).toContainText("cannot read");
    await expect(page.locator('[data-governed-export-allowed="true"]')).toHaveCount(0);
  });
}

test("a readable ALLOWED answer still enables the exports (the fix is not a blanket refusal)", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await openReports(page, "en");
  await expect(page.locator("[data-governed-export-error]")).toHaveCount(0);
  await expect(page.locator('[data-governed-export-allowed="true"]').first()).toBeVisible();
});
