/**
 * WHAT DECIDES THE WIDTH OF A BILLING PANEL.
 *
 * `.bill-row` is a two-column grid, and several of its children render nothing
 * for a given account — `EnterpriseContractCard` returns null without a
 * contract, which is every self-serve account. Plan capabilities was therefore
 * a half-width card sitting directly above a full-width Billing history, and
 * looked like a mistake rather than a pair with a missing half.
 *
 * The fix is a track count that follows what rendered. This spec measures the
 * consequence — that the two sections share their edges at every width, and
 * that nothing states a width to make them — because the stylesheet can be
 * read but the grid can only be resolved.
 */

import { expect, test } from "@playwright/test";

import { openBilling, WIDTHS } from "./_fixtures";

/** Necessary categories only. The banner overlays the surfaces measured here. */
const ANSWERED_CONSENT = JSON.stringify({
  categories: ["necessary"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-08-29T19:14:00.000Z",
  consentId: "fixture-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  lastConsentTimestamp: "2026-08-29T19:14:00.000Z",
  expirationTime: 4102444800000,
});

for (const viewport of WIDTHS) {
  test(`${viewport.name}: Plan capabilities and Billing history share their edges`, async ({
    page,
  }) => {
    await page.addInitScript((v) => {
      document.cookie = `cc_cookie=${encodeURIComponent(v as string)};path=/`;
    }, ANSWERED_CONSENT);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openBilling(page);
    await page.waitForSelector("[data-billing-capabilities]");

    const measured = await page.evaluate(() => {
      const box = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      return {
        capabilities: box("[data-billing-capabilities]"),
        history: box("[data-billing-history]"),
        fits:
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      };
    });

    expect(measured.capabilities, "Plan capabilities must render").not.toBeNull();
    expect(measured.history, "Billing history must render").not.toBeNull();
    expect(measured.capabilities!.left).toBe(measured.history!.left);
    expect(measured.capabilities!.right).toBe(measured.history!.right);
    expect(measured.fits, "the page must not scroll sideways").toBe(true);
  });
}

test("the width is the grid's; height is still the content's", async ({ page }) => {
  await page.addInitScript((v) => {
    document.cookie = `cc_cookie=${encodeURIComponent(v as string)};path=/`;
  }, ANSWERED_CONSENT);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openBilling(page);
  await page.waitForSelector("[data-billing-capabilities]");

  const measured = await page.evaluate(() => {
    const caps = document.querySelector<HTMLElement>("[data-billing-capabilities]")!;
    const history = document.querySelector<HTMLElement>("[data-billing-history]")!;
    const style = getComputedStyle(caps);
    return {
      capsHeight: Math.round(caps.getBoundingClientRect().height),
      historyHeight: Math.round(history.getBoundingClientRect().height),
      // A width the PANEL states would survive the row changing shape; a width
      // the row hands it would not.
      declaredWidth: caps.style.width || "",
      minWidth: style.minWidth,
    };
  });

  expect(measured.declaredWidth, "no inline width").toBe("");
  // `min-width: 0` is the grid child's licence to SHRINK, not a floor. What
  // would be a floor is a positive one, and that is what must not be here.
  expect(
    Number.parseFloat(measured.minWidth),
    "no positive floor propping the panel open",
  ).toBe(0);
  // Matching WIDTH was the ask. A card of two rows must not be stretched to the
  // height of a payment table to look like its neighbour.
  expect(
    measured.capsHeight,
    "the capabilities card must not have been stretched to match",
  ).toBeLessThan(measured.historyHeight);
});
