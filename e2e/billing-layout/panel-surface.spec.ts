/**
 * THE BILLING PANELS HAVE AN EDGE.
 *
 * Measured before this pass: every panel painted rgba(255, 255, 255, 0.92) —
 * the shell frosts `--surface-card` across the whole content area — over an
 * `.app-shell-v2` ground of rgb(247, 248, 252), with a 1px rgba(15,23,42,0.09)
 * border. Seven levels of luminance and a 9% edge is not an edge, and Billing's
 * page is paler than the Operations and Notifications pages where the same card
 * reads correctly.
 *
 * An earlier pass moved these onto `--shadow-card` / `--radius-card` and they
 * still dissolved, so the EDGE takes the step rather than the fill. This pins
 * the token, not a hex: `--border-strong` is one canonical stop above
 * `--border-default`, and if either token moves this still passes for the right
 * reason.
 */

import { expect, test } from "@playwright/test";

import { openBilling } from "./_fixtures";

test("the named Billing panels are separated from the page by the canonical stronger edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openBilling(page);
  await page.waitForSelector("[data-billing-capabilities]");

  const measured = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const strong = root.getPropertyValue("--border-strong").trim();
    const def = root.getPropertyValue("--border-default").trim();

    const rgba = (v: string) => {
      const m = v.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(",").map((s) => Number.parseFloat(s.trim()));
      return parts.length === 4 ? parts[3] : 1;
    };

    const panels = Array.from(document.querySelectorAll<HTMLElement>(".bill-panel")).map(
      (p) => {
        const cs = getComputedStyle(p);
        return {
          border: cs.borderTopColor,
          width: cs.borderTopWidth,
          radius: cs.borderTopLeftRadius,
          shadow: cs.boxShadow !== "none",
        };
      },
    );
    const history = document.querySelector<HTMLElement>("[data-billing-history]");
    return {
      panels,
      historyBorder: history ? getComputedStyle(history).borderTopColor : null,
      historyTag: history ? history.tagName + "." + history.className : null,
      historyWidth: history ? getComputedStyle(history).borderTopWidth : null,
      strongAlpha: rgba(strong),
      defaultAlpha: rgba(def),
    };
  });

  expect(measured.panels.length, "Evidence, Storage and Plan capabilities").toBeGreaterThan(2);
  expect(
    measured.strongAlpha!,
    "--border-strong must actually be a step up, or this change is cosmetic",
  ).toBeGreaterThan(measured.defaultAlpha!);

  const expected = `rgba(15, 23, 42, ${measured.strongAlpha})`;
  for (const p of measured.panels) {
    expect(p.border, "the panel wears the stronger canonical edge").toBe(expected);
    expect(p.width).toBe("1px");
    // Untouched by this pass: still a card, not a slab.
    expect(p.radius).toBe("14px");
    expect(p.shadow, "the soft card shadow stays").toBe(true);
  }
  expect(measured.historyBorder, "Billing history shares the edge").toBe(expected);
});
