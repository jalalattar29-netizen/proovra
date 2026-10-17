/**
 * THE REFERENCE ORANGE, READ FROM THE NOTIFICATIONS SURFACE THAT PAINTS IT.
 *
 * The product had three oranges doing one job: `--warning-ink` (#B45309),
 * `--orange-ink` (#C2410C) and `--orange-500` (#EA580C). Operations "High",
 * the Home warning states, the Settings warning confirm and the Billing
 * over-limit row painted the middle one, which reads burnt — closer to brown
 * than to caution.
 *
 * The Notifications "High" severity used to be pinned through its metric card
 * ("High / Important, not urgent."). That card is gone (2026-10-17): the page
 * is an inbox, not a dashboard, and severity survives as ROW METADATA. The
 * authority therefore moved with it — a High row's tone badge resolves
 * `--ops-tone-high` to `--orange-500` (notifications.css), and so does the
 * row's own severity rail. This file pins that badge, plus the root tokens, so
 * the value the rest of the product follows cannot move without this failing
 * first.
 */

import { expect, test } from "@playwright/test";

import { installApi } from "./_fixtures";

test("a High row's badge is the orange every warning surface follows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installApi(page, "personal-pro", { metricScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector('[data-inbox-item-tone="high"]', { timeout: 15_000 });

  const probe = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-inbox-item-tone="high"]')!;
    const badge = row.querySelector<HTMLElement>('[data-tone-chip="high"]')!;
    const root = getComputedStyle(document.documentElement);
    return {
      badgeText: badge.textContent?.trim(),
      badgeColor: getComputedStyle(badge).color,
      rail: getComputedStyle(row).borderLeftColor,
      orange500: root.getPropertyValue("--orange-500").trim(),
      orangeInk: root.getPropertyValue("--orange-ink").trim(),
      toneOrange: root.getPropertyValue("--tone-orange").trim(),
      // The card that used to carry this pin must not quietly come back.
      metricCards: document.querySelectorAll("[data-notifications-metric]").length,
    };
  });

  // The element this whole pass is now calibrated against.
  expect(probe.metricCards).toBe(0);
  expect(probe.badgeText).toBe("HIGH");

  // It resolves `--orange-500`, and that is #EA580C.
  expect(probe.orange500.toUpperCase()).toBe("#EA580C");
  expect(probe.badgeColor).toBe("rgb(234, 88, 12)");
  expect(probe.rail).toBe("rgb(234, 88, 12)");

  // The shared tone alias follows the same value rather than the retired ink,
  // which is what makes Operations High and a High notification one colour.
  expect(probe.toneOrange.toUpperCase()).toBe("#EA580C");
  expect(
    probe.orangeInk.toUpperCase(),
    "--orange-ink still exists for its own job; it is simply no longer the semantic warning",
  ).toBe("#C2410C");
});
