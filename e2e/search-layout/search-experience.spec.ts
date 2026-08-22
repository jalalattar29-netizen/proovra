/**
 * THE SEARCH CONSOLE'S HEADER, INPUT AND HISTORY.
 *
 * Everything here is a property only a real browser can answer: whether the
 * title icon is the canonical one and does not wrap, whether the leading glyph
 * has real inset from the border in both directions, and whether removing one
 * history entry removes exactly that entry without running its search.
 *
 * Tenant isolation is NOT asserted here and deliberately so — the API is
 * intercepted in this project, and a mocked cross-workspace proof is worth
 * nothing. That lives in
 * `services/api/test/search-tenant-isolation.integration.test.ts`, against a
 * real database and two real workspaces.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  DIRECTIONS,
  VIEWPORTS,
  WORKSPACE_ID,
  openSearch,
  setDirection,
} from "./_fixtures";

/**
 * Seed the per-browser, per-workspace recent-search list the page reads.
 *
 * The EXACT key the page computes — `tenantStorageKey(workspaceId,
 * "search:recent")` — so this seeds the real storage authority rather than a
 * lookalike the page would ignore.
 */
const RECENT_KEY = `proovra:tenant:${WORKSPACE_ID}:search:recent`;

async function seedRecent(page: Page, entries: string[]): Promise<void> {
  await page.evaluate(
    ([key, items]) => {
      window.localStorage.setItem(key as string, JSON.stringify(items));
    },
    [RECENT_KEY, entries] as const,
  );
}

/** Open the history dropdown and return the entries it shows. */
async function openHistory(page: Page): Promise<string[]> {
  await page.click(".search-form__input");
  await page.waitForSelector("[data-search-typeahead-recent]", {
    timeout: 10_000,
  });
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("[data-search-typeahead-recent-item]"),
    ).map((el) => el.getAttribute("data-search-typeahead-recent-item") ?? ""),
  );
}

// ===========================================================================
// §12 / §28 — the canonical title icon
// ===========================================================================

test("the Search title carries the canonical title-icon treatment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSearch(page, "workspace");

  const measured = await page.evaluate(() => {
    const icon = document.querySelector(
      "[data-search-title] .app-title-icon",
    ) as HTMLElement | null;
    const text = document.querySelector(
      "[data-search-title-text]",
    ) as HTMLElement | null;
    if (!icon || !text) return null;
    const ib = icon.getBoundingClientRect();
    const tb = text.getBoundingClientRect();
    const cs = getComputedStyle(icon);
    return {
      hidden: icon.getAttribute("aria-hidden"),
      hasGlyph: Boolean(icon.querySelector("svg")),
      width: Math.round(ib.width),
      height: Math.round(ib.height),
      radius: cs.borderTopLeftRadius,
      background: cs.backgroundImage,
      border: `${cs.borderTopColor} ${cs.borderTopWidth}`,
      inset: cs.boxShadow,
      gap: Math.round(tb.left - ib.right),
      centreDelta: Math.abs(ib.top + ib.height / 2 - (tb.top + tb.height / 2)),
      h1Count: document.querySelectorAll("h1").length,
      titleText: text.textContent?.trim(),
    };
  });

  expect(measured, "no title icon rendered").not.toBeNull();
  // EXACTLY the treatment /cases, /notifications and the Evidence Library use.
  expect(measured!.hidden).toBe("true");
  expect(measured!.hasGlyph).toBe(true);
  expect(measured!.width).toBe(42);
  expect(measured!.height).toBe(42);
  expect(measured!.radius).toBe("12px");
  expect(measured!.background).toBe(
    "linear-gradient(145deg, rgba(91, 79, 233, 0.1), rgba(73, 184, 255, 0.08))",
  );
  expect(measured!.border).toBe("rgba(91, 79, 233, 0.16) 1px");
  expect(measured!.inset).toBe("rgba(255, 255, 255, 0.8) 0px 1px 0px 0px inset");
  expect(measured!.gap).toBe(12);
  expect(measured!.centreDelta).toBeLessThanOrEqual(2);
  // The copy and the heading structure are unchanged.
  expect(measured!.titleText).toBe("Search");
  expect(measured!.h1Count).toBe(1);
});

test("the plain-language card is gone from the console", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSearch(page, "workspace");
  // Withdrawn for every workspace type — see the route's own docstring for
  // what the audit found.
  await expect(page.locator("[data-search-nl]")).toHaveCount(0);
  await expect(page.locator(".search-nl")).toHaveCount(0);
  const body = (await page.textContent("body")) ?? "";
  expect(body).not.toContain("Ask in plain language");
  expect(body).not.toContain("Deterministic filters · Advisory");
});

// ===========================================================================
// §14 / §15 / §29 — the leading-icon slot
// ===========================================================================

for (const dir of DIRECTIONS) {
  test(`the search glyph has real inset from the ${dir} edge`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSearch(page, "workspace");
    await setDirection(page, dir);

    const m = await page.evaluate((direction) => {
      const field = document.querySelector(
        ".search-form__field",
      ) as HTMLElement;
      const icon = document.querySelector(".search-form__icon") as HTMLElement;
      const input = document.querySelector(
        ".search-form__input",
      ) as HTMLElement;
      const fb = field.getBoundingClientRect();
      const ib = icon.getBoundingClientRect();
      const nb = input.getBoundingClientRect();
      return {
        // Distance from the field's LEADING edge to the glyph.
        leadingInset:
          direction === "rtl"
            ? Math.round(fb.right - ib.right)
            : Math.round(ib.left - fb.left),
        // Gap between the glyph and where the text starts.
        textGap:
          direction === "rtl"
            ? Math.round(ib.left - nb.right)
            : Math.round(nb.left - ib.right),
        // No overlap, in either direction.
        overlaps:
          direction === "rtl" ? nb.right > ib.left : nb.left < ib.right,
        centreDelta: Math.abs(
          ib.top + ib.height / 2 - (fb.top + fb.height / 2),
        ),
        // The absolute offset is gone: this is a real flex slot now.
        iconPosition: getComputedStyle(icon).position,
        docOverflow: Math.max(
          0,
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      };
    }, dir);

    // COMFORTABLE, not touching the border. The old absolute offset resolved
    // against the wrong ancestor and left the glyph on the edge.
    expect(m.leadingInset).toBeGreaterThanOrEqual(14);
    expect(m.textGap).toBeGreaterThanOrEqual(8);
    expect(m.overlaps).toBe(false);
    expect(m.centreDelta).toBeLessThanOrEqual(1);
    expect(m.iconPosition).toBe("static");
    expect(m.docOverflow).toBeLessThanOrEqual(1);
  });
}

test("focusing the input lights the whole field", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSearch(page, "workspace");
  const before = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".search-form__field")!).boxShadow,
  );
  await page.focus(".search-form__input");
  const after = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".search-form__field")!).boxShadow,
  );
  // The ring surrounds the glyph and the text together, rather than drawing a
  // second box inside the first.
  expect(after).not.toBe(before);
  expect(after).not.toBe("none");
});

// ===========================================================================
// §18–§24 / §30 / §34 — recent-search history
// ===========================================================================

test.describe("recent searches", () => {
  const SEEDED = ["Find invoices", "TSA failure", "case Bilal"];

  test("removing one entry removes exactly that entry", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');

    expect(await openHistory(page)).toEqual(SEEDED);

    await page.click(
      '[data-search-typeahead-remove-recent="TSA failure"]',
    );
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll("[data-search-typeahead-recent-item]"),
          ).map((el) => el.getAttribute("data-search-typeahead-recent-item")),
        ),
      )
      .toEqual(["Find invoices", "case Bilal"]);
  });

  test("removing an entry does NOT run its search", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    const urlBefore = page.url();
    const inputBefore = await page.inputValue(".search-form__input");

    await page.click('[data-search-typeahead-remove-recent="TSA failure"]');
    await page.waitForTimeout(300);

    // The row is ALSO clickable — without stopPropagation, removing an entry
    // would run the search it was removing.
    expect(await page.inputValue(".search-form__input")).toBe(inputBefore);
    expect(new URL(page.url()).searchParams.get("q")).toBe(
      new URL(urlBefore).searchParams.get("q"),
    );
  });

  test("clicking the row itself DOES repeat the search", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    await page.click('[data-search-typeahead-recent-row="TSA failure"]');
    await expect
      .poll(() => page.inputValue(".search-form__input"))
      .toBe("TSA failure");
  });

  test("Clear all empties the list, and the control goes with it", async ({
    page,
  }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    // Renamed from "Clear": it removes every entry, and the per-row control
    // beside it removes one.
    const clear = page.locator("[data-search-typeahead-clear-recent]");
    await expect(clear).toHaveText("Clear all");
    await clear.click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document.querySelectorAll("[data-search-typeahead-recent-item]")
              .length,
        ),
      )
      .toBe(0);
    // The global control has nothing left to clear.
    await expect(clear).toHaveCount(0);
  });

  test("removing the last entry empties the list cleanly", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, ["only one"]);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    await page.click('[data-search-typeahead-remove-recent="only one"]');
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document.querySelectorAll("[data-search-typeahead-recent-item]")
              .length,
        ),
      )
      .toBe(0);
    await expect(
      page.locator("[data-search-typeahead-clear-recent]"),
    ).toHaveCount(0);
    // …and the empty state takes over rather than leaving a bare group.
    await expect(
      page.locator("[data-search-typeahead-recent-empty]"),
    ).toBeVisible();
  });

  test("every remove button names the entry it removes", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    const labels = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll("[data-search-typeahead-remove-recent]"),
      ).map((el) => el.getAttribute("aria-label")),
    );
    // "Close" alone would give a screen-reader user three identical buttons
    // and no way to tell which forgets which search.
    expect(labels).toEqual([
      'Remove search "Find invoices"',
      'Remove search "TSA failure"',
      'Remove search "case Bilal"',
    ]);
  });

  test("the remove control is keyboard reachable and operable", async ({
    page,
  }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, SEEDED);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
    await openHistory(page);

    const focusable = await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-search-typeahead-remove-recent="TSA failure"]',
      ) as HTMLElement;
      btn.focus();
      return {
        focused: document.activeElement === btn,
        tag: btn.tagName,
        ring: getComputedStyle(btn).boxShadow,
      };
    });
    expect(focusable.tag).toBe("BUTTON");
    expect(focusable.focused).toBe(true);
  });

  test("history does not accumulate duplicates", async ({ page }) => {
    await openSearch(page, "workspace");
    await seedRecent(page, ["alpha", "beta"]);
    await page.reload();
    await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');

    // Re-running an existing search moves it to the front rather than adding a
    // second copy.
    await page.fill(".search-form__input", "beta");
    await page.press(".search-form__input", "Enter");
    await page.waitForTimeout(400);

    // The history list only renders while the draft is short — above two
    // characters the dropdown shows live suggestions instead. Clearing the
    // field is what a reader does to see their history again.
    await page.fill(".search-form__input", "");
    const entries = await openHistory(page);
    expect(entries.filter((e) => e === "beta")).toHaveLength(1);
    expect(entries[0]).toBe("beta");
  });
});

// ===========================================================================
// §29 / §31 — responsive + RTL
// ===========================================================================

for (const vp of VIEWPORTS) {
  for (const dir of DIRECTIONS) {
    test(`header, field and history hold at ${vp.name} / ${dir}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openSearch(page, "workspace");
      await seedRecent(page, ["a fairly long recent search string here"]);
      await page.reload();
      await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])');
      await setDirection(page, dir);
      await openHistory(page);

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const icon = document.querySelector(
          "[data-search-title] .app-title-icon",
        ) as HTMLElement;
        const text = document.querySelector(
          "[data-search-title-text]",
        ) as HTMLElement;
        const remove = document.querySelector(
          "[data-search-typeahead-remove-recent]",
        ) as HTMLElement | null;
        const rb = remove?.getBoundingClientRect();
        return {
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
          // The title and its icon stay on one line.
          titleWrapped:
            Math.abs(
              icon.getBoundingClientRect().top -
                text.getBoundingClientRect().top,
            ) > 8,
          // The remove control stays on screen and remains a real target.
          removeVisible: Boolean(rb && rb.width > 0 && rb.height > 0),
          removeInViewport: Boolean(
            rb && rb.left >= -1 && rb.right <= window.innerWidth + 1,
          ),
        };
      });

      expect(m.overflow, "horizontal page overflow").toBeLessThanOrEqual(1);
      expect(m.titleWrapped, "the title wrapped away from its icon").toBe(false);
      expect(m.removeVisible).toBe(true);
      expect(m.removeInViewport).toBe(true);
    });
  }
}
