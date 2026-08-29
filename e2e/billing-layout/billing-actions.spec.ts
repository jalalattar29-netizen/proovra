/**
 * BILLING — action weight, card pairing, and a status column of words.
 *
 * The render tests already pin what this page SAYS. These pin what jsdom
 * cannot report: where the two allowance actions land relative to each other,
 * whether the history status column paints capsules, and what colour a
 * purchase button actually is once the stylesheet has run.
 */

import { expect, test } from "@playwright/test";

import { WIDTHS, openBilling } from "./_fixtures";

const rgb = (value: string) =>
  ((value.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number]);

const isDarkInk = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) < 80;
const isViolet = ([r, g, b]: [number, number, number]) => b > r + 40 && b > g + 40;

async function paint(locator: ReturnType<typeof test.step> extends never ? never : any) {
  return locator.evaluate((el: HTMLElement) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color, image: cs.backgroundImage };
  });
}

test.describe("billing — the plan card's two actions", () => {
  test("they are separated, aligned, and weighted differently", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);

    const primary = page.locator("[data-billing-plan-management]");
    const secondary = page.locator("[data-billing-start-subscription]");
    await expect(primary).toBeVisible();
    await expect(secondary).toBeVisible();

    const a = (await primary.boundingBox())!;
    const b = (await secondary.boundingBox())!;

    // Separated by the spacing scale, not touching.
    const gap = b.x - (a.x + a.width);
    expect(gap, "the two plan actions must not touch").toBeGreaterThanOrEqual(8);
    expect(gap, "and must not drift apart").toBeLessThanOrEqual(24);

    // One row: same height, same baseline.
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);

    // The purchase is dark ink with a white label; the explain action keeps the
    // product accent. Two different acts, two different weights.
    const sec = await paint(secondary);
    expect(isDarkInk(rgb(sec.bg)), "Start Team subscription must be dark ink").toBe(
      true,
    );
    expect(rgb(sec.fg).every((c) => c > 240), "its label must be white").toBe(true);
  });

  test("the purchase action does not turn violet on hover", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);

    const secondary = page.locator("[data-billing-start-subscription]");
    await secondary.hover();
    const after = await paint(secondary);
    expect(
      isViolet(rgb(after.bg)),
      "hover must be a dark neutral step, never the secondary treatment's violet",
    ).toBe(false);
    expect(isDarkInk(rgb(after.bg)) || Math.max(...rgb(after.bg)) < 110).toBe(true);
    expect(rgb(after.fg).every((c) => c > 240), "the label stays white").toBe(true);
  });
});

test.describe("billing — the allowance pair", () => {
  test("Evidence and Storage land their actions on ONE baseline", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);

    const credits = page.locator("[data-billing-buy-credits]");
    const storage = page.locator("[data-billing-manage-storage]");
    await expect(credits).toBeVisible();
    await expect(storage).toBeVisible();

    const a = (await credits.boundingBox())!;
    const b = (await storage.boundingBox())!;

    // THE POINT. Evidence lists five figures and Storage lists two, so before
    // the card body took the slack these landed at different heights and the
    // row read as one finished card beside one that had stopped early.
    expect(
      Math.abs(a.y - b.y),
      "the two allowance actions must sit on the same baseline",
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1);

    // Both are the same act, so both carry the same weight.
    for (const [name, locator] of [
      ["Buy credits", credits],
      ["Add storage", storage],
    ] as const) {
      const p = await paint(locator);
      expect(isDarkInk(rgb(p.bg)), `${name} must be dark ink`).toBe(true);
      expect(rgb(p.fg).every((c) => c > 240), `${name} label must be white`).toBe(
        true,
      );
    }
  });

  test("no fixed height clips either card", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);
    const strays = await page.evaluate(() => {
      const out: string[] = [];
      for (const panel of Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-billing-row="allowances"] .bill-panel',
        ),
      )) {
        if (panel.scrollHeight > panel.clientHeight + 1) out.push(panel.className);
      }
      return out;
    });
    expect(strays, "an allowance card is clipping its own content").toEqual([]);
  });
});

test.describe("billing — history status", () => {
  test("statuses are words, with no capsule behind them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);

    const statuses = page.locator("[data-billing-history-status]");
    expect(await statuses.count()).toBeGreaterThan(0);

    for (let i = 0; i < (await statuses.count()); i++) {
      const cell = statuses.nth(i);
      const p = await cell.evaluate((el: HTMLElement) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          border: cs.borderTopWidth,
          radius: cs.borderTopLeftRadius,
          shadow: cs.boxShadow,
          text: el.innerText,
        };
      });
      expect(p.bg, `"${p.text}" still has a filled surface`).toBe("rgba(0, 0, 0, 0)");
      expect(p.border, `"${p.text}" still has a capsule border`).toBe("0px");
      expect(p.shadow, `"${p.text}" still has a shadow`).toBe("none");
    }
  });

  test("each status keeps its own meaning, and says it in words", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);

    const tone = async (status: string) =>
      rgb(
        await page
          .locator(`[data-billing-history-status="${status}"]`)
          .first()
          .evaluate((el: HTMLElement) => getComputedStyle(el).color),
      );

    // Pending is the product's amber — warmer than it is blue. Failed is red.
    // Paid is green. Abandoned is neutral: nothing went wrong and no money
    // moved, so it is not an error tone.
    const pending = await tone("PENDING");
    expect(pending[0], "pending must be the warm amber").toBeGreaterThan(pending[2]);
    expect(pending[1], "amber, not red").toBeGreaterThan(pending[2]);

    const failed = await tone("FAILED");
    expect(failed[0]).toBeGreaterThan(failed[1]);
    expect(failed[0]).toBeGreaterThan(failed[2]);

    const paid = await tone("SUCCEEDED");
    expect(paid[1], "paid must be green").toBeGreaterThan(paid[0]);

    // And the words are there regardless of colour.
    await expect(page.locator('[data-billing-history-status="ABANDONED"]')).toContainText(
      /Abandoned/i,
    );
  });
});

test.describe("billing — support", () => {
  test("Get help is the accent action, in white", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBilling(page);
    const help = page.locator("[data-billing-support-action]");
    await expect(help).toBeVisible();
    const p = await paint(help);
    expect(isViolet(rgb(p.bg)), "Get help must carry the product accent").toBe(true);
    expect(rgb(p.fg).every((c) => c > 240), "its label must be white").toBe(true);
  });
});

test.describe("billing — responsive", () => {
  for (const { name, width, height } of WIDTHS) {
    test(`${name}: the page does not scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openBilling(page);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(0);
    });
  }

  test("the history header stays readable at 390", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBilling(page);
    // The card header is a flex row and the re-check button does not shrink, so
    // the title block was squeezed to 16px and "Billing history" rendered one
    // character per line, with its subtitle doing the same underneath. Nothing
    // overflowed the document, so the geometry check above saw nothing wrong —
    // which is exactly why this measures the title's own box.
    const width = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
        (e) =>
          e.children.length === 0 && e.textContent?.trim() === "Billing history",
      );
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    });
    expect(
      width,
      "the history title must have room for its own words",
    ).toBeGreaterThan(110);
  });

  test("the allowance cards stack rather than squeeze on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBilling(page);
    const credits = (await page.locator("[data-billing-buy-credits]").boundingBox())!;
    const storage = (await page
      .locator("[data-billing-manage-storage]")
      .boundingBox())!;
    // Stacked: one clearly below the other, and each action still full-width
    // enough to be a real target.
    expect(storage.y).toBeGreaterThan(credits.y + credits.height);
    expect(credits.height).toBeGreaterThanOrEqual(40);
  });
});
