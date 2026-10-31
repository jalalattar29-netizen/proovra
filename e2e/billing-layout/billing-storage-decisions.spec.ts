/**
 * BILLING DECISIONS (2026-10-31) — the new storage states, in a real browser.
 *
 * The render tests pin what these lines say. Whether they fit a phone, and stay
 * readable on either colour scheme, is a fact about the rendered page.
 *
 * The API is answered in-process with the SERVER's own DTO shapes; this proves
 * the page, not the provider.
 */

import { expect, test, type Page } from "@playwright/test";

import { billingProjection, installBillingApi } from "./_fixtures";

const addon = (overrides: Record<string, unknown>) => ({
  id: "addon-1",
  addonKey: "TEAM_100_GB",
  label: "+100 GB",
  storageLabel: "100 GB",
  status: "ACTIVE",
  billingCycle: "MONTHLY",
  legacyOneTime: false,
  endsWithPlan: true,
  canCancel: true,
  canRecheck: false,
  canAbandon: false,
  attemptReference: "SA-1",
  paymentProvider: "STRIPE",
  providerReference: null,
  createdAtUtc: "2026-10-01T00:00:00.000Z",
  activatedAtUtc: "2026-10-01T00:00:00.000Z",
  currentPeriodEndUtc: "2026-11-20T00:00:00.000Z",
  priceCents: 999,
  currency: "EUR",
  ...overrides,
});

async function openWithStorage(page: Page) {
  await installBillingApi(page);
  const projection = billingProjection();
  projection.storageAddons = {
    offers: [],
    legacyWorkspaces: [
      {
        name: "An unusually long older workspace name that must wrap on a phone",
        addonCount: 1,
        addonLabel: "100 GB",
        usedLabel: "12 GB",
        limitLabel: "200 GB",
        planLabel: "100 GB",
        limitReached: false,
        monthly: [{ currency: "EUR", cents: 999 }],
      },
    ],
    active: [
      addon({ id: "ending", ending: true, endsAtUtc: "2026-11-20T00:00:00.000Z", endingReason: "PLAN_CHANGE" }),
      addon({
        id: "legacy",
        status: "PAST_DUE",
        legacyWorkspace: true,
        legacyWorkspaceName: "An unusually long older workspace name that must wrap on a phone",
      }),
    ],
  };
  await page.route(/\/v1\/billing\/accounts\/[A-Z]+\/[^/]+(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projection) }),
  );
  await page.goto("/billing");
  await page.waitForSelector("[data-billing-addon-legacy]", { timeout: 30_000 });
}

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { name: "desktop-1440", width: 1440, height: 1000 },
    { name: "mobile-390", width: 390, height: 844 },
  ]) {
    test(`storage states fit and stay readable at ${viewport.name} in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWithStorage(page);

      await expect(page.locator("[data-billing-addon-ending-reason='PLAN_CHANGE']")).toContainText("will not renew");
      await expect(page.locator("[data-billing-addon-legacy]")).toContainText("older workspace");
      await expect(page.locator("[data-billing-storage-legacy-workspaces]")).toContainText("Separate from the storage above");
      await expect(page.locator("[data-billing-storage-legacy-usage]")).toContainText("12 GB of 200 GB");

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);

      const measured = await page.evaluate(() => {
        const opaque = (el: Element | null): string => {
          for (let at = el; at; at = at.parentElement) {
            const fill = getComputedStyle(at).backgroundColor;
            const alpha = fill.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1];
            if (fill !== "transparent" && (alpha === undefined || Number(alpha) > 0.5)) return fill;
          }
          return "rgb(255, 255, 255)";
        };
        return Array.from(
          document.querySelectorAll(
            "[data-billing-addon-legacy], [data-billing-addon-ending-reason], [data-billing-storage-legacy-usage]",
          ),
        ).map((el) => {
          const box = el.getBoundingClientRect();
          return {
            color: getComputedStyle(el).color,
            fill: opaque(el),
            right: box.right,
            width: box.width,
          };
        });
      });
      expect(measured.length).toBe(3);
      for (const line of measured) {
        expect(line.right, "stays on screen").toBeLessThanOrEqual(viewport.width);
        expect(line.width).toBeGreaterThan(0);
        const [high, low] = [luminance(line.color), luminance(line.fill)].sort((a, b) => b - a);
        expect((high! + 0.05) / (low! + 0.05), "readable against its surface").toBeGreaterThanOrEqual(4.5);
      }
      await page.locator("[data-billing-addon-legacy]").first().screenshot({
        path: `test-results/billing-storage-${viewport.name}-${colorScheme}.png`,
      });
    });
  }
}
