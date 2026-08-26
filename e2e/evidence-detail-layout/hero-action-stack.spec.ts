/**
 * The record actions belong to the HEADER, beside the title.
 *
 * They were first built into the download toolbar, which put "Edit name" and
 * "Lock" on the same line as the record's two primary outputs. Geometry is the
 * only thing that can prove where they ended up, so this asserts the boxes:
 * the stack shares the title block's row and starts to its right, and the
 * downloads sit BELOW it rather than beside it.
 */
import { test, expect } from "@playwright/test";
import { installApi } from "./_fixtures";

test("the action stack sits BESIDE the title, above the downloads", async ({ page }) => {
  await installApi(page, "organization", {});
  await page.goto("/evidence/11111111-1111-4111-8111-111111111111");
  await page.waitForSelector('[data-evidence-action="copy-verification-link"]');

  const title = await page.locator(".evidence-detail-hero-main").boundingBox();
  const stack = await page.locator(".evidence-detail-hero-icon-actions").boundingBox();
  const dl = await page.locator('[data-evidence-action="download-report"]').boundingBox();

  // Beside: the stack starts to the right of the title block and shares its row.
  expect(stack!.x).toBeGreaterThan(title!.x);
  expect(stack!.y).toBeLessThan(title!.y + title!.height);
  // Above: the downloads are below the stack, not beside it.
  expect(dl!.y).toBeGreaterThan(stack!.y);

  // Dark fill, white text.
  const c = await page.locator('[data-evidence-action="copy-verification-link"]').evaluate((e) => {
    const s = getComputedStyle(e);
    return { bg: s.backgroundColor, fg: s.color };
  });
  expect(c.bg).toBe("rgb(23, 32, 51)");
  expect(c.fg).toBe("rgb(248, 250, 252)");

  // No horizontal overflow at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
