/**
 * STRUCTURAL RESPONSIVE / RTL VERIFICATION — /search.
 *
 * WHY A REAL BROWSER
 * ---------------------------------------------------------------------------
 * Every property here is a LAYOUT property: does anything overflow, does
 * anything escape its container, do two controls overlap, does the typeahead
 * paint above the panel that would otherwise clip it, is a target big enough to
 * hit, does the Inspector stay inside its column, does a long value wrap
 * instead of pushing the row wide, does a UUID stay readable when the document
 * flips to RTL.
 *
 * jsdom answers `0` to every one of those questions. It has no layout engine,
 * no cascade beyond the declarations it is handed, and no stacking model — so a
 * jsdom "proof" of geometry is a proof of nothing. These run against the
 * PRODUCTION build under Chromium.
 *
 * Screenshots are deliberately absent: this is a structural gate, not a visual
 * one. It answers "is anything broken", never "does it look right".
 */

import { expect, test, type Page } from "@playwright/test";

import {
  DIRECTIONS,
  VIEWPORTS,
  openSearch,
  setDirection,
  type LayoutContext,
} from "./_fixtures";

// ---------------------------------------------------------------------------
// Measurement primitives — all computed in the page, by the real engine
// ---------------------------------------------------------------------------

/** Does the document scroll sideways? The single loudest responsive defect. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** Elements whose box escapes the viewport horizontally. */
async function escapedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const root = document.querySelector("[data-search-page]");
    if (!root) return ["<no console>"];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // A 1px rounding tolerance: sub-pixel layout is not a defect.
      if (r.left < -1 || r.right > vw + 1) {
        out.push(
          `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}] vw=${vw}`,
        );
      }
    }
    return out;
  });
}

/** Interactive controls whose boxes intersect one another. */
async function overlappingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector("[data-search-page]");
    if (!root) return ["<no console>"];
    const controls = Array.from(
      root.querySelectorAll<HTMLElement>("button, a[href], input, [role='option']"),
    ).filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      // An overlay is SUPPOSED to sit over things; it is measured separately.
      if (el.closest(".app-anchored-overlay")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const out: string[] = [];
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i] as HTMLElement;
        const b = controls[j] as HTMLElement;
        // Nesting is not overlap — a link inside a row shares its box legally.
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 1 && overlapY > 1) {
          out.push(
            `${a.tagName}.${a.className} ∩ ${b.tagName}.${b.className} (${Math.round(overlapX)}×${Math.round(overlapY)})`,
          );
        }
      }
    }
    return out.slice(0, 10);
  });
}

/** Boxes of two elements, for containment assertions. */
async function containment(
  page: Page,
  childSel: string,
  parentSel: string,
): Promise<{ ok: boolean; detail: string } | null> {
  return page.evaluate(
    ([c, p]) => {
      const child = document.querySelector(c) as HTMLElement | null;
      const parent = document.querySelector(p) as HTMLElement | null;
      if (!child || !parent) return null;
      const rc = child.getBoundingClientRect();
      const rp = parent.getBoundingClientRect();
      const ok = rc.left >= rp.left - 1 && rc.right <= rp.right + 1;
      return {
        ok,
        detail: `child[${Math.round(rc.left)}..${Math.round(rc.right)}] parent[${Math.round(rp.left)}..${Math.round(rp.right)}]`,
      };
    },
    [childSel, parentSel] as const,
  );
}

// ===========================================================================
// The matrix: three widths, two directions
// ===========================================================================

const CONTEXT: LayoutContext = "admin"; // the widest surface: every panel on

for (const viewport of VIEWPORTS) {
  for (const dir of DIRECTIONS) {
    test.describe(`${viewport.name}px ${dir}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openSearch(page, CONTEXT);
        await setDirection(page, dir);
      });

      test("the page does not scroll sideways", async ({ page }) => {
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      });

      test("nothing escapes the viewport", async ({ page }) => {
        expect(await escapedElements(page)).toEqual([]);
      });

      test("no two controls overlap", async ({ page }) => {
        expect(await overlappingControls(page)).toEqual([]);
      });

      test("the Inspector stays inside the workspace grid", async ({ page }) => {
        // Select a row first — the Inspector replaces the guidance column.
        await page.locator("[data-search-result-row]").first().click();
        await page.waitForSelector("[data-search-inspector]");
        const result = await containment(
          page,
          "[data-search-inspector]",
          ".search-workspace__grid",
        );
        expect(result, "the Inspector or the grid did not render").not.toBeNull();
        expect(result?.ok, result?.detail).toBe(true);
      });

      test("result geometry survives selection", async ({ page }) => {
        const list = page.locator("[data-search-results]");
        const before = await list.boundingBox();
        await page.locator("[data-search-result-row]").first().click();
        await page.waitForSelector("[data-search-inspector]");
        const after = await list.boundingBox();
        expect(before, "no result list").not.toBeNull();
        expect(after, "the result list vanished on selection").not.toBeNull();
        // The list may narrow when the Inspector opens on a wide viewport; it
        // may never disappear, and it may never overflow.
        expect(after!.width).toBeGreaterThan(0);
        expect(after!.x + after!.width).toBeLessThanOrEqual(viewport.width + 1);
      });

      test("the typeahead paints above the panels that would clip it", async ({ page }) => {
        // The canonical query field, named rather than guessed: the first
        // `input` on the page is a filter checkbox at some widths, and a
        // stacking gate that measured the wrong control would pass blindly.
        const input = page.locator("[data-search-input]").first();
        await input.click();
        await input.fill("incident");
        // The suggest fetch is debounced; wait for the overlay it produces.
        await page.waitForSelector("[data-search-typeahead]", { timeout: 15_000 });
        const overlay = page.locator(".app-anchored-overlay").first();
        await expect(overlay).toBeVisible();
        const onTop = await page.evaluate(() => {
          const o = document.querySelector(
            ".app-anchored-overlay",
          ) as HTMLElement | null;
          if (!o) return null;
          const r = o.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + 4),
          );
          return hit ? o.contains(hit) : null;
        });
        expect(onTop, "the typeahead rendered with no box").not.toBeNull();
        expect(onTop, "something painted over the typeahead").toBe(true);
      });

      test("every visible control meets a usable target size", async ({ page }) => {
        const small = await page.evaluate(() => {
          const root = document.querySelector("[data-search-page]");
          if (!root) return ["<no console>"];
          const out: string[] = [];
          for (const el of Array.from(
            root.querySelectorAll<HTMLElement>("button, a[href], input[type='checkbox']"),
          )) {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") continue;
            // The EFFECTIVE target, not the painted box.
            //
            // A checkbox styled to 18px inside a `<label>` is not an 18px
            // target: the label is clickable and is what a finger lands on.
            // Measuring the input would report a defect that does not exist —
            // and, worse, would be "fixed" by inflating a control that is
            // correctly sized.
            const target =
              el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox"
                ? (el.closest("label") ?? el)
                : el;
            const r = target.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            // 24px is the floor for a pointer target that sits inside text.
            // The recovery control is held to 44 separately, below.
            if (r.height < 24) {
              out.push(
                `${el.tagName}.${el.className} target=${target.tagName}.${(target as HTMLElement).className} h=${Math.round(r.height)}`,
              );
            }
          }
          return out;
        });
        expect(small).toEqual([]);
      });

      test("long values wrap instead of widening their row", async ({ page }) => {
        // Row 1 carries a 128-character filename. It must not push the list
        // wider than the column it lives in.
        const detail = await containment(
          page,
          "[data-search-result-row]",
          "[data-search-results]",
        );
        expect(detail, "no result row").not.toBeNull();
        expect(detail?.ok, detail?.detail).toBe(true);
      });

      test("UUIDs and timestamps stay left-to-right", async ({ page }) => {
        await page.locator("[data-search-result-row]").first().click();
        await page.waitForSelector("[data-search-inspector]");
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of Array.from(
            document.querySelectorAll<HTMLElement>(".search-pointer"),
          )) {
            const s = getComputedStyle(el);
            const text = (el.textContent ?? "").trim();
            // A UUID reversed by the paragraph direction is unreadable and, in
            // an evidence console, actively misleading — an operator copies it.
            if (!/^[0-9a-f-]{20,}$/i.test(text)) continue;
            if (s.direction !== "ltr") out.push(`${text.slice(0, 12)}… dir=${s.direction}`);
          }
          return out;
        });
        expect(bad).toEqual([]);
      });
    });
  }
}

// ===========================================================================
// Capability-conditional geometry
// ===========================================================================

test.describe("optional panels leave no gap", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}px — a non-admin's operator strip occupies no space`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSearch(page, "organization");
      const height = await page.evaluate(() => {
        const strip = document.querySelector(
          "[data-search-admin-strip]",
        ) as HTMLElement | null;
        if (!strip) return 0;
        return strip.getBoundingClientRect().height;
      });
      // An empty capability slot may exist in the DOM; it may not reserve a
      // track. Two pixels of tolerance for a border-box rounding.
      expect(height).toBeLessThanOrEqual(2);
    });

    test(`${viewport.name}px — the Enterprise Inspector reflows without overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSearch(page, "enterprise");
      await page.locator("[data-search-result-row]").first().click();
      await page.waitForSelector("[data-search-inspector]");
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      expect(await escapedElements(page)).toEqual([]);
    });
  }
});

// ===========================================================================
// Recovery — the one control held to 44px, and the dialog it can open
// ===========================================================================

test.describe("recovery control geometry", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}px — the recovery target is at least 44px and is contained`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSearch(page, "admin", {
        readiness: {
          state: "STALLED",
          indexedCount: 3,
          outstandingCount: 9,
          resultsAreComplete: false,
          runStatus: null,
          canRecover: true,
        },
      });
      const button = page.locator("[data-search-readiness-recover]").first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, "the recovery control has no box").not.toBeNull();
      // An operator action reached under stress, often on a touch device.
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    });
  }

  test("the focused control shows a visible indicator", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSearch(page, "admin", {
      readiness: {
        state: "STALLED",
        indexedCount: 3,
        outstandingCount: 9,
        resultsAreComplete: false,
        runStatus: null,
        canRecover: true,
      },
    });
    const visible = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-search-readiness-recover]",
      ) as HTMLElement | null;
      if (!el) return null;
      el.focus();
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== "none" && parseFloat(s.outlineWidth || "0") > 0) ||
        (s.boxShadow !== "none" && s.boxShadow.trim().length > 0);
      return { focused: document.activeElement === el, ring };
    });
    expect(visible, "the recovery control did not render").not.toBeNull();
    expect(visible?.focused).toBe(true);
    expect(visible?.ring, "a focused control with no visible indicator").toBe(true);
  });
});

// ===========================================================================
// POLISH — the type label's real painted shape
//
// jsdom reports no computed background, no radius and no box. Every assertion
// here needs a layout engine and a real cascade, which is the whole reason this
// project exists.
// ===========================================================================

test.describe("type labels are compact filled rectangles", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}px — filled background, white text, small radius`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSearch(page, "admin");

      const measured = await page.evaluate(() => {
        const el = document.querySelector(
          "[data-search-result-type]",
        ) as HTMLElement | null;
        if (!el) return null;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          background: s.backgroundColor,
          color: s.color,
          radius: parseFloat(s.borderTopLeftRadius),
          transform: s.textTransform,
          width: r.width,
          height: r.height,
        };
      });

      expect(measured, "no type label rendered").not.toBeNull();
      // SOLID: a real colour, not the soft tint the state chips wear.
      expect(measured!.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(measured!.background).not.toBe("transparent");
      // WHITE text on it.
      expect(measured!.color).toBe("rgb(255, 255, 255)");
      // A RECTANGLE. `.app-status-badge` is 999px; a capsule this size would
      // report roughly half its own height.
      expect(measured!.radius).toBeLessThanOrEqual(6);
      expect(measured!.radius).toBeLessThan(measured!.height / 2);
      expect(measured!.transform).toBe("uppercase");
      // Compact: content-sized, never a slab.
      expect(measured!.height).toBeLessThanOrEqual(28);
      expect(measured!.width).toBeLessThanOrEqual(140);
    });
  }

  test("the Inspector label is content-sized, not a full-width field", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSearch(page, "admin");
    await page.locator("[data-search-result-row]").first().click();
    await page.waitForSelector("[data-search-inspector]");

    const measured = await page.evaluate(() => {
      const badge = document.querySelector(
        "[data-search-inspector-type]",
      ) as HTMLElement | null;
      const panel = document.querySelector(
        "[data-search-inspector]",
      ) as HTMLElement | null;
      if (!badge || !panel) return null;
      return {
        badge: badge.getBoundingClientRect().width,
        panel: panel.getBoundingClientRect().width,
        background: getComputedStyle(badge).backgroundColor,
        color: getComputedStyle(badge).color,
      };
    });

    expect(measured, "the Inspector rendered no type label").not.toBeNull();
    // THE DEFECT IN THE REFERENCE SCREENSHOT: a grid item stretches to its
    // column unless told otherwise, so the label filled the panel and read as
    // an input field. It must be a small fraction of the panel.
    expect(measured!.badge).toBeLessThan(measured!.panel * 0.5);
    // …and it is the same filled label as the row's.
    expect(measured!.color).toBe("rgb(255, 255, 255)");
    expect(measured!.background).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("every type renders at the same height", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSearch(page, "admin");
    const heights = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-search-result-type]"),
      ).map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThan(1);
    expect(new Set(heights).size, `heights differ: ${heights.join(",")}`).toBe(1);
  });

  test("selecting a row does not resize its type label", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSearch(page, "admin");
    const first = page.locator("[data-search-result-type]").first();
    const before = await first.boundingBox();
    await page.locator("[data-search-result-row]").first().click();
    await page.waitForSelector("[data-search-inspector]");
    const after = await first.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.round(after!.height)).toBe(Math.round(before!.height));
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
  });
});

// ===========================================================================
// POLISH — the recovery action occupies its own row
// ===========================================================================

test.describe("the recovery action is below the copy", () => {
  for (const viewport of VIEWPORTS) {
    for (const dir of DIRECTIONS) {
      test(`${viewport.name}px ${dir} — the action row sits under the explanation`, async ({
        page,
      }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await openSearch(page, "admin", {
          readiness: {
            state: "STALLED",
            indexedCount: 3,
            outstandingCount: 9,
            resultsAreComplete: false,
            runStatus: null,
            canRecover: true,
          },
        });
        await setDirection(page, dir);

        const geometry = await page.evaluate(() => {
          const body = document.querySelector(
            ".search-readiness-panel__body",
          ) as HTMLElement | null;
          const actions = document.querySelector(
            "[data-search-readiness-actions]",
          ) as HTMLElement | null;
          if (!body || !actions) return null;
          const rb = body.getBoundingClientRect();
          const ra = actions.getBoundingClientRect();
          return { bodyBottom: rb.bottom, actionsTop: ra.top, actionsHeight: ra.height };
        });

        expect(geometry, "the panel did not render both blocks").not.toBeNull();
        // BELOW, not beside and not inside: the action row starts at or after
        // the explanation ends. Inline placement — the defect — would put the
        // control's top well above the paragraph's bottom.
        expect(geometry!.actionsTop).toBeGreaterThanOrEqual(
          geometry!.bodyBottom - 1,
        );
        expect(geometry!.actionsHeight).toBeGreaterThan(0);
        // And the page still does not scroll sideways with it.
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      });
    }
  }
});
