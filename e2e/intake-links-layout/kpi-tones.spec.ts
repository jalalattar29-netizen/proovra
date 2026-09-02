/**
 * THE TWO METRICS THAT LEAD THE STRIP.
 *
 * `Total links` is the figure every other figure is a subset of, and it was
 * slate — the quietest thing on a row of seven. `Active` is the one that can
 * still take work, and it wore the brand purple, which says "headline" rather
 * than "attention".
 *
 * Read from the rendered cards, because a tone name is only a promise until
 * the cascade resolves it.
 */

import { expect, test } from "@playwright/test";

import { openIntakeLinks } from "./_fixtures";

const BRAND_PURPLE = "rgb(109, 40, 217)";
const REFERENCE_ORANGE = "rgb(234, 88, 12)";

test("Total links leads in brand purple; Active is the attention orange", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openIntakeLinks(page);
  await page.waitForSelector("[data-intake-links-kpi]");

  const cards = await page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>("[data-intake-links-kpi]")).map((c) => {
        const value = c.querySelector<HTMLElement>(".ilk-kpi__value");
        return [
          c.getAttribute("data-intake-links-kpi"),
          {
            tone: c.getAttribute("data-ilk-tone"),
            // The rail and the number both read `--ilk-tone`.
            rail: getComputedStyle(c).getPropertyValue("--ilk-tone").trim(),
            valueColor: value ? getComputedStyle(value).color : null,
          },
        ];
      }),
    ),
  );

  expect(cards.total, "the Total links card must render").toBeTruthy();
  expect(cards.total.tone).toBe("indigo");
  expect(cards.active.tone).toBe("orange");

  // Resolved, not merely named.
  if (cards.total.valueColor) expect(cards.total.valueColor).toBe(BRAND_PURPLE);
  if (cards.active.valueColor) expect(cards.active.valueColor).toBe(REFERENCE_ORANGE);

  // And the retired burnt orange is nowhere in this pair.
  for (const key of ["total", "active"]) {
    expect(cards[key].valueColor).not.toBe("rgb(194, 65, 12)");
    expect(cards[key].valueColor).not.toBe("rgb(168, 102, 18)");
  }
});
