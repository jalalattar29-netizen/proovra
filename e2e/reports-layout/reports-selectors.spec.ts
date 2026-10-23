/**
 * REPORTS SELECTORS — the chosen value is readable in full (2026-10-23).
 *
 * The defect: a long selected label on Reports ("Newest captured first",
 * "First report not yet issued", "Missing for latest report", the German and
 * Arabic equivalents) rendered as its first words and an ellipsis — the sort
 * trigger had a fixed 190px basis, and the canonical listbox trigger clipped
 * its value on one line. Its menu was clamped to the trigger, so the options
 * were cut the same way.
 *
 * Every case selects the LONGEST option of every Reports selector through the
 * URL, at every supported width, in English, German and Arabic (RTL), and
 * measures the real boxes:
 *
 *   1. no trigger value is clipped (its text box is not wider than what shows);
 *   2. no trigger leaves the viewport or overlaps another control;
 *   3. the page never scrolls sideways;
 *   4. each open menu is at least as wide as its trigger, inside the viewport,
 *      and none of its options is clipped;
 *   5. the trigger keeps its accessible name, Escape closes the menu and gives
 *      focus back, and a click outside closes it.
 *
 * The copy is the product's copy — nothing is shortened to pass.
 */

import { expect, test, type Page } from "@playwright/test";

import { openReports, VIEWPORTS, type ReportsLocale } from "./_fixtures";

const LONGEST =
  "?status=not_available&report=report_update_failed&package=package_missing&entitlement=entitlement_unavailable&sort=oldest";

const LOCALES: ReadonlyArray<{ locale: ReportsLocale; dir: "ltr" | "rtl" }> = [
  { locale: "en", dir: "ltr" },
  { locale: "de", dir: "ltr" },
  { locale: "ar", dir: "rtl" },
];

const TRIGGERS = "[data-reports-toolbar] .app-listbox__trigger, [data-reports-advanced-panel] .app-listbox__trigger";

type TriggerBox = {
  name: string;
  text: string;
  clipped: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

async function measureTriggers(page: Page): Promise<TriggerBox[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((t) => t.offsetParent !== null)
      .map((t) => {
        const value = t.querySelector<HTMLElement>(".app-listbox__value-text");
        const r = t.getBoundingClientRect();
        const labelledby = t.getAttribute("aria-labelledby");
        const name =
          t.getAttribute("aria-label") ??
          (labelledby ? (document.getElementById(labelledby)?.textContent ?? "") : "");
        return {
          name: name.trim(),
          text: (value?.textContent ?? "").trim(),
          // A clipped value has a content box wider (or taller, if it was
          // forced to one line) than the box that shows it.
          clipped: value ? value.scrollWidth > value.clientWidth + 1 : false,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });
  }, TRIGGERS);
}

/**
 * The two states measured: the DEFAULT page (only the sort selector, holding
 * "Newest captured first" — the reported defect) and every selector holding
 * its longest option with Advanced filters open.
 */
const STATES = [
  { name: "default", search: "", selectors: 1 },
  { name: "longest", search: LONGEST, selectors: 5 },
] as const;

for (const { locale, dir } of LOCALES) {
  for (const vp of VIEWPORTS) {
    for (const state of STATES) test(`${locale} @ ${vp.name} (${state.name}): every selected value is readable and nothing overflows`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openReports(page, locale, state.search);
      if (state.selectors > 1) await page.waitForSelector("[data-reports-advanced-panel]:not([hidden])");
      expect(await page.evaluate(() => document.documentElement.getAttribute("dir"))).toBe(dir);

      const boxes = await measureTriggers(page);
      // Status, report, package and entitlement in Advanced; sort in the toolbar.
      expect(boxes.length, "every Reports selector is on screen").toBe(state.selectors);
      for (const b of boxes) {
        expect(b.name, "each selector has an accessible name").not.toBe("");
        expect(b.text.length, `${b.name} shows its value`).toBeGreaterThan(0);
        expect(b.clipped, `${b.name}: "${b.text}" is clipped`).toBe(false);
        expect(b.left, `${b.name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
        expect(b.right, `${b.name} ends inside the viewport`).toBeLessThanOrEqual(vp.width + 0.5);
      }
      // No two controls overlap.
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
        }
      }
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sideways, "the page never scrolls sideways").toBeLessThanOrEqual(0);
    });
  }
}

for (const { locale } of LOCALES) {
  for (const vp of [VIEWPORTS[2], VIEWPORTS[4]]) {
    test(`${locale} @ ${vp.name}: each open menu fits its longest option and is at least its trigger's width`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openReports(page, locale, LONGEST);
      await page.waitForSelector("[data-reports-advanced-panel]:not([hidden])");
      const count = await page.locator(TRIGGERS).count();
      for (let i = 0; i < count; i += 1) {
        const trigger = page.locator(TRIGGERS).nth(i);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const popup = page.locator(".app-listbox__popup");
        await expect(popup).toBeVisible();
        const m = await page.evaluate(() => {
          const pop = document.querySelector<HTMLElement>(".app-listbox__popup")!;
          const pr = pop.getBoundingClientRect();
          const trig = document.querySelector<HTMLElement>('.app-listbox__trigger[aria-expanded="true"]')!;
          const tr = trig.getBoundingClientRect();
          const clipped = Array.from(pop.querySelectorAll<HTMLElement>(".app-listbox__option-label")).filter(
            (o) => o.scrollWidth > o.clientWidth + 1,
          ).map((o) => o.textContent);
          return { popLeft: pr.left, popRight: pr.right, popWidth: pr.width, trigWidth: tr.width, clipped };
        });
        expect(m.popWidth, "menu ≥ trigger width").toBeGreaterThanOrEqual(m.trigWidth - 1);
        expect(m.popLeft, "menu inside the viewport").toBeGreaterThanOrEqual(0);
        expect(m.popRight, "menu inside the viewport").toBeLessThanOrEqual(vp.width + 0.5);
        expect(m.clipped, "no option is clipped").toEqual([]);
        // Escape closes and returns focus to the trigger.
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      // Click outside closes.
      await page.locator(TRIGGERS).first().click();
      await expect(page.locator(".app-listbox__popup")).toBeVisible();
      await page.mouse.click(2, vp.height - 2);
      await expect(page.locator(".app-listbox__popup")).toHaveCount(0);
    });
  }
}

test("keyboard: a selector opens with ArrowDown, moves, selects with Enter, and the full new value shows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReports(page, "en", "?report=report_ready");
  const report = page.getByRole("combobox", { name: "Report" });
  await report.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".app-listbox__popup")).toBeVisible();
  // Move to the last option ("First report not yet issued") and choose it.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-listbox__popup")).toHaveCount(0);
  await expect(report).toContainText("First report not yet issued");
  const [b] = (await measureTriggers(page)).filter((t) => t.name === "Report");
  expect(b!.clipped).toBe(false);
});
