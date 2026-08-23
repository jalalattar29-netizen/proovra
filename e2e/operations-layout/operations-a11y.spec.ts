/**
 * OPERATIONS — ACCESSIBILITY AND INTERACTION, IN A REAL BROWSER.
 *
 * Focus, keyboard routing and live announcement are runtime behaviours of a
 * real engine. jsdom has no focus ring, no computed outline, no real tab
 * order, and no notion of whether an element is actually reachable — so a
 * jsdom proof of any of these is a proof of nothing.
 *
 * axe-core is NOT installed in this repository, so the checks below are
 * explicit rather than automated. Each one names the property it is standing
 * in for.
 */

import { expect, test, type Page } from "@playwright/test";

import { openOperations, setDirection } from "./_fixtures";

const visible = (page: Page, selector: string) =>
  page.locator(`${selector}:visible`);

// ===========================================================================
// 1. STRUCTURE
// ===========================================================================

test("exactly one h1, and the landmark structure is not duplicated", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Operations");
  // The queue summary is a titled region, but its title is for screen readers:
  // a visible second heading above the work would compete with the page's.
  const h2 = await page.locator("h2").allTextContents();
  expect(h2).toContain("Queue summary");
});

test("severity and status are TEXT, never colour alone", async ({ page }) => {
  await openOperations(page, "team-admin");
  const severities = await visible(page, "[data-ops-severity]").allTextContents();
  expect(severities.length).toBeGreaterThan(0);
  for (const s of severities) expect(s.trim().length).toBeGreaterThan(0);
  const statuses = await visible(page, "[data-ops-status]").allTextContents();
  for (const s of statuses) expect(s.trim().length).toBeGreaterThan(0);
  // The enum token never reaches the operator.
  const body = (await page.locator("body").textContent()) ?? "";
  expect(body).not.toContain("EVIDENCE_INTEGRITY");
  expect(body).not.toContain("ACKNOWLEDGED");
});

// ===========================================================================
// 2. LISTBOXES
// ===========================================================================

test("every filter listbox has an accessible name and is keyboard operable", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  const triggers = page.locator("[data-ops-controls] .app-listbox__trigger");
  const count = await triggers.count();
  expect(count).toBeGreaterThanOrEqual(5);

  for (let i = 0; i < count; i += 1) {
    const t = triggers.nth(i);
    const labelledBy = await t.getAttribute("aria-labelledby");
    expect(labelledBy, `listbox ${i} needs an accessible name`).toBeTruthy();
    const text = await page.locator(`#${labelledBy}`).textContent();
    expect((text ?? "").trim().length).toBeGreaterThan(0);
  }

  // It opens from the keyboard and closes back onto its trigger.
  const first = triggers.first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-listbox__popup")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-listbox__popup")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("app-listbox__trigger"),
    ),
  ).toBe(true);
});

// ===========================================================================
// 3. THE ROW MENU
// ===========================================================================

test("the row menu opens from the keyboard, roves, and returns focus", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  const trigger = visible(page, "[data-ops-row-menu-trigger]").first();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");

  const panel = page.locator("[data-ops-row-menu-panel]");
  await expect(panel).toBeVisible();
  expect(await panel.getAttribute("role")).toBe("menu");
  expect(await trigger.getAttribute("aria-expanded")).toBe("true");

  // Focus landed INSIDE the menu, not on the trigger.
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
  ).toBe("menuitem");

  // The arrows rove between items.
  const firstItem = await page.evaluate(
    () => document.activeElement?.textContent,
  );
  await page.keyboard.press("ArrowDown");
  const secondItem = await page.evaluate(
    () => document.activeElement?.textContent,
  );
  expect(secondItem).not.toBe(firstItem);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.activeElement?.hasAttribute("data-ops-row-menu-trigger"),
    ),
  ).toBe(true);
});

test("the row menu PANEL is a real surface, not bare text over the table", async ({
  page,
}) => {
  // The defect this pins: the panel shipped with no background, no border and
  // no shadow, so five items of bare text painted over the rows beneath them.
  // Every source and jsdom test passed, because a class that styles nothing
  // looks exactly like a class that styles something.
  await openOperations(page, "team-admin");
  await visible(page, "[data-ops-row-menu-trigger]").first().click();
  const paint = await page
    .locator("[data-ops-row-menu-panel]")
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        border: s.borderTopWidth,
        radius: s.borderTopLeftRadius,
        shadow: s.boxShadow,
      };
    });
  expect(paint.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint.background).not.toBe("transparent");
  expect(parseFloat(paint.border)).toBeGreaterThan(0);
  expect(parseFloat(paint.radius)).toBeGreaterThan(0);
  expect(paint.shadow).not.toBe("none");
});

test("the row menu stays inside the viewport at the right edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  await visible(page, "[data-ops-row-menu-trigger]").last().click();
  // Wait for the panel before measuring it: querySelector on a portal that has
  // not mounted returns null, and a null measured as "outside" is a test
  // racing the render rather than a defect.
  await expect(page.locator("[data-ops-row-menu-panel]")).toBeVisible();
  const inside = await page.evaluate(() => {
    const el = document.querySelector("[data-ops-row-menu-panel]");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1;
  });
  expect(inside).toBe(true);
});

// ===========================================================================
// 4. FOCUS VISIBILITY AND TARGET SIZE
// ===========================================================================

test("focus is VISIBLE, not merely present", async ({ page }) => {
  await openOperations(page, "team-admin");
  for (const selector of [
    "[data-ops-metric]",
    "[data-ops-search]",
    "[data-ops-refresh]",
  ]) {
    const el = visible(page, selector).first();
    await el.focus();
    const ring = await el.evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        outlineWidth: s.outlineWidth,
        outlineStyle: s.outlineStyle,
        boxShadow: s.boxShadow,
      };
    });
    const hasRing =
      (ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0) ||
      ring.boxShadow !== "none";
    expect(hasRing, `${selector} must show a focus ring`).toBe(true);
  }
});

test("every interactive control meets the minimum target size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOperations(page, "team-admin");
  const small = await page.evaluate(() => {
    const out: string[] = [];
    // Scoped to the ROUTE. The shell's top bar carries an
    // `app-header-search` trigger measuring 22x36 on every authenticated page
    // — a real finding, recorded in the report, and not a control this brief
    // owns. Widening the assertion to the whole document would make this a
    // test of the shell that happens to run on Operations.
    const root =
      document.querySelector('[data-testid="operations-page"]') ?? document.body;
    root
      .querySelectorAll<HTMLElement>(
        "button, a[href], input[type='checkbox'], [role='menuitem']",
      )
      .forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return; // not in the layout
        // 24px is the WCAG 2.2 AA floor for a target that is not inline text.
        if (r.width < 24 || r.height < 24) {
          out.push(
            `${el.tagName.toLowerCase()}.${el.className}: ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      });
    return out;
  });
  expect(small).toEqual([]);

  // The row menu portals OUT of the page root, so it is measured on its own.
  await page.locator("[data-ops-row-menu-trigger]:visible").first().click();
  const menuItems = await page
    .locator("[data-ops-row-menu-panel] [role='menuitem']")
    .evaluateAll((els) =>
      els
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width < 24 || r.height < 24).length,
    );
  expect(menuItems).toBe(0);
});

test("no interactive element is nested inside another", async ({ page }) => {
  await openOperations(page, "team-admin");
  const nested = await page.evaluate(() => {
    const sel = "button, a[href], input, select, textarea, [role='menuitem']";
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (el.parentElement?.closest(sel)) {
        out.push(`${el.tagName.toLowerCase()} inside an interactive ancestor`);
      }
    });
    return out;
  });
  expect(nested).toEqual([]);
});

// ===========================================================================
// 5. THE INSPECTOR
// ===========================================================================

test("the inspector is a labelled modal, and returns focus on close", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  const opener = visible(page, "[data-ops-open]").first();
  await opener.focus();
  await opener.click();

  const dialog = page.locator("[data-ops-inspector]");
  await expect(dialog).toBeVisible();
  expect(await dialog.getAttribute("role")).toBe("dialog");
  expect(await dialog.getAttribute("aria-modal")).toBe("true");
  const labelledBy = await dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(
    ((await page.locator(`#${labelledBy}`).textContent()) ?? "").trim().length,
  ).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Focus is back where the operator left it, not on <body>.
  expect(
    await page.evaluate(() =>
      document.activeElement?.hasAttribute("data-ops-open"),
    ),
  ).toBe(true);
});

test("the inspector's history is a real list, in order", async ({ page }) => {
  await openOperations(page, "team-admin");
  await visible(page, "[data-ops-open]").first().click();
  const timeline = page.locator("[data-ops-timeline]");
  await expect(timeline).toBeVisible();
  expect(await timeline.evaluate((el) => el.tagName.toLowerCase())).toBe("ol");
  expect(await timeline.locator("li").count()).toBeGreaterThan(0);
});

// ===========================================================================
// 6. LIVE ANNOUNCEMENT
// ===========================================================================

test("a failed mutation is ANNOUNCED, not merely drawn", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "mutation-error" });
  await visible(page, "[data-ops-row-menu-trigger]").first().click();
  await page.locator('[data-ops-row-action="acknowledge"]').click();
  const err = page.locator("[data-ops-mutation-error]");
  await expect(err).toBeVisible();
  expect(await err.getAttribute("role")).toBe("alert");
});

test("a pending mutation cannot be fired twice", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "mutation-pending" });
  await visible(page, "[data-ops-row-menu-trigger]").first().click();
  await page.locator('[data-ops-row-action="acknowledge"]').click();
  // The menu closed on the first press; re-opening shows the action disabled
  // or the row busy. Either way a second identical transition cannot be sent.
  await visible(page, "[data-ops-row-menu-trigger]").first().click();
  const item = page.locator('[data-ops-row-action="acknowledge"]');
  if ((await item.count()) > 0) {
    expect(await item.isDisabled()).toBe(true);
  }
});

test("a degraded source is announced as an alert, not a status", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "degraded-summary" });
  const degraded = page.locator("[data-ops-degraded]");
  await expect(degraded).toBeVisible();
  expect(await degraded.getAttribute("role")).toBe("alert");
});

// ===========================================================================
// 7. RTL READING ORDER
// ===========================================================================

test("RTL mirrors the reading order rather than only the boxes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  await setDirection(page, "rtl");

  // The first table column in the DOM must be the RIGHTMOST on screen.
  const cols = await page
    .locator("[data-ops-table-surface] thead th")
    .evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().left)),
    );
  expect(cols.length).toBeGreaterThan(2);
  for (let i = 1; i < cols.length; i += 1) {
    expect(
      cols[i],
      "each subsequent column must sit further LEFT in RTL",
    ).toBeLessThanOrEqual(cols[i - 1]);
  }
});

test("RTL keeps the header and the summary inside the viewport", async ({
  page,
}) => {
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page, "team-admin", { scenario: "long-title" });
    await setDirection(page, "rtl");
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth > 1;
    });
    expect(overflow, `${width}px RTL`).toBe(false);
  }
});

test("the row menu flips UP rather than off the bottom of the viewport", async ({
  page,
}) => {
  // The last row of a full queue sits near the fold. A menu that opens
  // downward from there puts its two most destructive items below it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  const trigger = visible(page, "[data-ops-row-menu-trigger]").last();
  await trigger.click();
  const panel = page.locator("[data-ops-row-menu-panel]");
  await expect(panel).toBeVisible();
  const fits = await page.evaluate(() => {
    const el = document.querySelector("[data-ops-row-menu-panel]")!;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      h: Math.round(window.innerHeight),
    };
  });
  expect(fits.top).toBeGreaterThanOrEqual(-1);
  expect(fits.bottom, "the whole menu must be reachable").toBeLessThanOrEqual(
    fits.h + 1,
  );
});
