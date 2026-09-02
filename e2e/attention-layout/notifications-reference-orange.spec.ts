/**
 * THE REFERENCE ORANGE, READ FROM THE CARD THAT DEFINES IT.
 *
 * The product had three oranges doing one job: `--warning-ink` (#B45309),
 * `--orange-ink` (#C2410C) and `--orange-500` (#EA580C). Operations "High",
 * the Home warning states, the Settings warning confirm and the Billing
 * over-limit row painted the middle one, which reads burnt — closer to brown
 * than to caution.
 *
 * The Notifications severity card is the authority: "High / Important, not
 * urgent." resolves `--app-metric-tone` to `--orange-500`. This file pins that
 * card so the value the rest of the product now follows cannot move without
 * this failing first.
 */

import { expect, test } from "@playwright/test";

import { installApi } from "./_fixtures";

test("the High card is the orange every warning surface follows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installApi(page, "personal-pro", { metricScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-notifications-metric='high']");

  const card = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-notifications-metric='high']")!;
    const value = el.querySelector<HTMLElement>(".app-metric-card__value")!;
    const label = el.querySelector<HTMLElement>(".app-metric-card__label")!;
    const meta = el.querySelector<HTMLElement>(".app-metric-card__meta")!;
    const root = getComputedStyle(document.documentElement);
    return {
      label: label.textContent?.trim(),
      meta: meta.textContent?.trim(),
      tone: getComputedStyle(el).getPropertyValue("--app-metric-tone").trim(),
      valueColor: getComputedStyle(value).color,
      orange500: root.getPropertyValue("--orange-500").trim(),
      orangeInk: root.getPropertyValue("--orange-ink").trim(),
      toneOrange: root.getPropertyValue("--tone-orange").trim(),
    };
  });

  // The element this whole pass is calibrated against.
  expect(card.label).toBe("High");
  expect(card.meta).toBe("Important, not urgent.");

  // It resolves `--orange-500`, and that is #EA580C.
  expect(card.orange500.toUpperCase()).toBe("#EA580C");
  expect(card.tone.toUpperCase()).toBe("#EA580C");
  expect(card.valueColor).toBe("rgb(234, 88, 12)");

  // The shared tone alias follows the card rather than the retired ink, which
  // is what makes Operations High and this card the same colour.
  expect(card.toneOrange.toUpperCase()).toBe("#EA580C");
  expect(
    card.orangeInk.toUpperCase(),
    "--orange-ink still exists for its own job; it is simply no longer the semantic warning",
  ).toBe("#C2410C");
});
