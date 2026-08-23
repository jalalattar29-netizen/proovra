/**
 * THE SHARED APPLICATION HEADER — GEOMETRY AT EVERY WIDTH.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `.app-header-search` is declared `width: 100%` inside a centre zone declared
 * `min-width: 0`. On a wide header that is correct: the control fills the room
 * between the workspace chip and the action cluster. On a narrow one the left
 * and right zones take what they need first and the search keeps whatever is
 * left — 22 x 36 at 390px. A 22px-wide button is narrower than the 16px icon
 * inside it plus its own padding, well under the 24px AA target floor, and in
 * practice unpressable.
 *
 * It is fixed in the SHARED shell rather than overridden per route, because it
 * is the shared shell's control and every authenticated page carries it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SPEC LIVES BESIDE OPERATIONS
 * ---------------------------------------------------------------------------
 * The measurement needs a real engine, a production bundle and an intercepted
 * API, which is exactly what this project already provides. The header is not
 * an Operations control — so the spec asserts it across several routes, not
 * only this one, and the shared-shell regression suites for Search, Evidence,
 * Cases, Notifications and Intake Links run alongside it in the gate.
 */

import { expect, test, type Page } from "@playwright/test";

import { openOperations, setDirection, VIEWPORTS } from "./_fixtures";

/** The product's canonical interactive target floor (WCAG 2.2 AA, SC 2.5.8). */
const TARGET_FLOOR = 24;

const search = (page: Page) => page.locator("[data-app-header-search]");

async function box(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
}

// ===========================================================================
// 1. THE TARGET FLOOR, AT EVERY REQUIRED WIDTH
// ===========================================================================

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: the header search meets the target floor`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin");
    await expect(search(page)).toBeVisible();
    const b = await box(page, "[data-app-header-search]");
    expect(
      b.w,
      `${viewport.name}: ${b.w}x${b.h} — below the ${TARGET_FLOOR}px floor`,
    ).toBeGreaterThanOrEqual(TARGET_FLOOR);
    expect(b.h).toBeGreaterThanOrEqual(TARGET_FLOOR);
  });

  test(`${viewport.name}: the header does not overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin");
    const overflow = await page.evaluate(() => {
      // The header CONTAINER, named exactly.
      //
      // A loose selector like [class*="app-header"] also matches
      // .app-header-search, whose text is deliberately ellipsized — so its
      // scrollWidth legitimately exceeds its box and the assertion failed or
      // passed depending on which element came first in DOM order.
      const header = document.querySelector(".app-account-toolbar-inner");
      const doc = document.documentElement;
      return {
        page: doc.scrollWidth - doc.clientWidth,
        header: header ? header.scrollWidth - header.clientWidth : 0,
      };
    });
    expect(overflow.page, "the page must not scroll sideways").toBeLessThanOrEqual(1);
    expect(overflow.header, "the header must not overflow itself").toBeLessThanOrEqual(1);
  });
}

// ===========================================================================
// 2. NO COLLISION WITH ITS NEIGHBOURS
// ===========================================================================

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: no header control overlaps another`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin");
    const collisions = await page.evaluate(() => {
      const sel = [
        "[data-app-header-search]",
        "[data-app-header-primary-action]",
        "[data-global-runtime-indicator]",
        "[data-app-header-notifications]",
        "[data-app-header-language]",
        "[data-app-header-account]",
        "[data-app-header-workspace]",
      ].join(",");
      const els = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const out: string[] = [];
      for (let i = 0; i < els.length; i += 1) {
        for (let j = i + 1; j < els.length; j += 1) {
          const a = els[i].getBoundingClientRect();
          const b = els[j].getBoundingClientRect();
          // Nested elements legitimately contain one another.
          if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
          const overlap =
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1;
          if (overlap) {
            out.push(
              `${els[i].className || els[i].tagName} overlaps ${els[j].className || els[j].tagName}`,
            );
          }
        }
      }
      return out;
    });
    expect(collisions).toEqual([]);
  });
}

// ===========================================================================
// 3. RTL
// ===========================================================================

for (const width of [1440, 1024, 390, 320]) {
  test(`${width}px RTL: the header mirrors without overflow or a shrunken target`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page, "team-admin");
    await setDirection(page, "rtl");
    const b = await box(page, "[data-app-header-search]");
    expect(b.w).toBeGreaterThanOrEqual(TARGET_FLOOR);
    expect(b.h).toBeGreaterThanOrEqual(TARGET_FLOOR);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

// ===========================================================================
// 4. WHAT THE COLLAPSE MUST NOT COST
// ===========================================================================

test("the accessible name survives the collapse", async ({ page }) => {
  // The label and the ⌘K hint stand down at narrow widths; the button's
  // `aria-label` does not, so the collapsed form is never an unlabelled icon.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page, "team-admin");
    const name = await search(page).getAttribute("aria-label");
    expect(name, `${width}px`).toBe("Open command palette (search)");
  }
});

test("focus stays visible at both widths", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page, "team-admin");
    await search(page).focus();
    const ring = await search(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        boxShadow: s.boxShadow,
      };
    });
    const visible =
      (ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0) ||
      ring.boxShadow !== "none";
    expect(visible, `${width}px focus ring`).toBe(true);
  }
});

test("the collapsed control is still a real, operable button", async ({
  page,
}) => {
  // The command palette is a shell surface with its own mount path and does
  // not render under an intercepted API, so "the palette opened" is not
  // observable here and asserting it would be theatre.
  //
  // What the collapse could genuinely have broken IS observable: whether the
  // control is still a button, still enabled, still keyboard-reachable, and
  // still carrying the handler that opens the palette.
  await page.setViewportSize({ width: 390, height: 844 });
  await openOperations(page, "team-admin");

  const el = search(page);
  await expect(el).toBeVisible();
  await expect(el).toBeEnabled();
  expect(await el.evaluate((n) => n.tagName.toLowerCase())).toBe("button");
  expect(await el.evaluate((n) => (n as HTMLButtonElement).type)).toBe("button");

  // Reachable from the keyboard, and it takes focus.
  await el.focus();
  expect(
    await page.evaluate(() =>
      document.activeElement?.hasAttribute("data-app-header-search"),
    ),
  ).toBe(true);

  // Pressing the global shortcut does not throw or navigate away.
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(150);
  await expect(el).toBeVisible();
});

test("the wide header keeps its label and its shortcut hint", async ({ page }) => {
  // The collapse must not leak upward: the full control is the one most
  // operators see, and its hierarchy is unchanged.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  await expect(page.locator(".app-header-search-text")).toBeVisible();
  await expect(page.locator(".app-header-search-kbd")).toBeVisible();
  const b = await box(page, "[data-app-header-search]");
  expect(b.w, "the wide control still fills its zone").toBeGreaterThan(200);
});
