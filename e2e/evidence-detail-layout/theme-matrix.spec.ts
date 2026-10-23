/**
 * THEME MATRIX — Evidence ID at 390, 768, 1366 and 1920 px under the OS light
 * AND dark preference (2026-10-23).
 *
 * The product app ships one (light) theme; only the platform-admin console
 * has dark rules. So the property under a dark OS preference is that the page
 * stays ONE coherent theme — the same computed page, control and text colours
 * as under light, never a half-dark mix — and that nothing overflows. Each
 * state is screenshotted for review.
 */

import { expect, test } from "@playwright/test";

import { EVIDENCE_ID, installApi } from "./_fixtures";

const WIDTHS = [390, 768, 1366, 1920] as const;

async function paint(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const css = (sel: string, prop: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop) : null;
    };
    return {
      body: css("body", "background-color"),
      text: css("h1", "color"),
      strip: css("[data-evidence-attention-strip]", "background-color"),
      trigger: css(".evidence-detail-sidebar", "background-color"),
      triggerText: css(".evidence-detail-sidebar", "color"),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const width of WIDTHS) {
  test(`${width}px: light and dark OS preferences render the same coherent theme`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const out: Record<string, Awaited<ReturnType<typeof paint>>> = {};
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await installApi(page, "organization");
      await page.goto(`/evidence/${EVIDENCE_ID}`);
      await page.waitForSelector("[data-evidence-attention-strip]", { timeout: 30_000 });
      out[scheme] = await paint(page);
      expect(out[scheme]!.overflow, `${scheme} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/theme-evidence-${scheme}-${width}.png`, fullPage: false });
    }
    expect(out.dark).toEqual(out.light);
  });
}
