/**
 * STRUCTURAL RESPONSIVE / RTL / LOCALIZATION GATE — /intake-links.
 *
 * Every property here is a LAYOUT property: does the page scroll sideways, does
 * a cell escape its column, do two chips overlap, is the table replaced rather
 * than squeezed, does the wizard keep one scroller, does a phone number stay
 * readable when the document flips to RTL, and — the question the fixed
 * percentage grid raises — does a German-length or user-generated value still
 * fit the column it was measured for in English.
 *
 * jsdom answers `0` to all of it. These run against the PRODUCTION build under
 * Chromium, and capture no images.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  DIRECTIONS,
  GERMAN_ROWS,
  LONG,
  VIEWPORTS,
  openIntakeLinks,
  openWizard,
  setDirection,
  type IntakeContext,
} from "./_fixtures";

const CONTEXTS: IntakeContext[] = ["personal", "organization", "enterprise"];

const ROOT = '[data-testid="intake-links-page"]';

// ---------------------------------------------------------------------------
// Measurement primitives — all computed in the page, by the real engine
// ---------------------------------------------------------------------------

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** Elements whose painted box escapes the viewport horizontally. */
async function escapedElements(page: Page, root = ROOT): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const host = document.querySelector(sel);
    if (!host) return ["<no surface>"];
    for (const el of Array.from(host.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1) {
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} [${Math.round(r.left)}..${Math.round(r.right)}] vw=${vw}`,
        );
      }
    }
    return out;
  }, root);
}

/** Content that escapes its own table cell or card. */
async function cellEscapes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
    const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
    const showing =
      getComputedStyle(wide).display !== "none" ? wide : narrow;
    const containers = Array.from(
      showing.querySelectorAll<HTMLElement>("td, .ilk-card"),
    );
    for (const c of containers) {
      const cr = c.getBoundingClientRect();
      for (const el of Array.from(c.querySelectorAll<HTMLElement>("*"))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > cr.right + 1 || r.left < cr.left - 1) {
          out.push(
            `${c.getAttribute("data-col") ?? "card"}: ${(el.textContent ?? "").trim().slice(0, 40)}`,
          );
        }
      }
    }
    return out;
  });
}

/** Status chips whose painted boxes intersect. */
async function badgeCollisions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
    const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
    const showing = getComputedStyle(wide).display !== "none" ? wide : narrow;
    const chips = Array.from(
      showing.querySelectorAll<HTMLElement>(".app-status-badge, .app-chip"),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    for (let i = 0; i < chips.length; i += 1) {
      for (let j = i + 1; j < chips.length; j += 1) {
        const a = chips[i].getBoundingClientRect();
        const b = chips[j].getBoundingClientRect();
        if (
          a.left < b.right - 0.5 &&
          b.left < a.right - 0.5 &&
          a.top < b.bottom - 0.5 &&
          b.top < a.bottom - 0.5
        ) {
          out.push(
            `${chips[i].textContent?.trim()} ∩ ${chips[j].textContent?.trim()}`,
          );
        }
      }
    }
    return out;
  });
}

/**
 * Text that has been broken one word per line.
 *
 * Measured, not guessed: a run is fragmented when its box is barely wider than
 * its longest single word while carrying several words — which is exactly what
 * a column too narrow for its content produces.
 */
async function fragmentedRuns(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
    const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
    const showing = getComputedStyle(wide).display !== "none" ? wide : narrow;
    const measure = document.createElement("span");
    measure.style.position = "absolute";
    measure.style.visibility = "hidden";
    measure.style.whiteSpace = "nowrap";
    document.body.appendChild(measure);

    for (const el of Array.from(
      showing.querySelectorAll<HTMLElement>(
        "[data-intake-links-row-delivery], .ilk-status__text, .ilk-expiry, .ilk-relative",
      ),
    )) {
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const text = (el.textContent ?? "").trim();
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) continue;
      measure.style.font = cs.font;
      const widths = words.map((w) => {
        measure.textContent = w;
        return measure.getBoundingClientRect().width;
      });
      const longest = Math.max(...widths);
      const box = el.getBoundingClientRect().width;
      // Room for at most one average word beyond the longest = fragmenting.
      const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
      if (box < longest + avg * 0.9) {
        out.push(`${text.slice(0, 40)} @ ${Math.round(box)}px`);
      }
    }
    measure.remove();
    return out;
  });
}

/** Which records renderer the cascade is actually showing. */
async function renderers(page: Page): Promise<{ table: boolean; cards: boolean }> {
  return page.evaluate(() => {
    const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
    const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
    return {
      table: getComputedStyle(wide).display !== "none",
      cards: getComputedStyle(narrow).display !== "none",
    };
  });
}

/** Interactive targets smaller than the 24px minimum. */
async function smallTargets(page: Page, root = ROOT): Promise<string[]> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel) as HTMLElement;
    const out: string[] = [];
    for (const el of Array.from(
      host.querySelectorAll<HTMLElement>(
        'button, a[href], [role="combobox"], [role="menuitem"], input',
      ),
    )) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const target =
        el instanceof HTMLInputElement &&
        (el.type === "radio" || el.type === "checkbox")
          ? (el.closest("label") ?? el)
          : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 24 || r.width < 24) {
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out;
  }, root);
}

// ===========================================================================
// The responsive matrix
// ===========================================================================

for (const context of CONTEXTS) {
  test.describe(`${context} — responsive matrix`, () => {
    for (const dir of DIRECTIONS) {
      for (const vp of VIEWPORTS) {
        test(`${dir} @ ${vp.name}: contained, unbroken, one renderer`, async ({
          page,
        }) => {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await openIntakeLinks(page, context, {
            workspaceName: context === "personal" ? undefined : LONG.workspace,
          });
          await setDirection(page, dir);

          expect(await horizontalOverflow(page)).toBe(0);
          expect(await escapedElements(page)).toEqual([]);
          expect(await cellEscapes(page)).toEqual([]);
          expect(await badgeCollisions(page)).toEqual([]);
          expect(await fragmentedRuns(page)).toEqual([]);
          expect(await smallTargets(page)).toEqual([]);

          // Exactly one records renderer, and the right one for the width.
          const r = await renderers(page);
          expect(r.table).toBe(!r.cards);
          expect(r.table).toBe(vp.width > 760);
        });
      }
    }

    test(`${context}: KPI reflow matches the declared grid`, async ({ page }) => {
      const expected: Record<string, number> = {
        "1440": 7,
        "1280": 7,
        "1024": 4,
        "768": 3,
        "430": 2,
        "390": 2,
      };
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openIntakeLinks(page, context);
        const rows = await page.evaluate(() => {
          const byTop: Record<number, number[]> = {};
          for (const c of Array.from(
            document.querySelectorAll<HTMLElement>(".ilk-kpi"),
          )) {
            const r = c.getBoundingClientRect();
            (byTop[Math.round(r.top)] ||= []).push(Math.round(r.height));
          }
          return Object.values(byTop);
        });
        // First row width matches the declared column count…
        expect(rows[0].length, `${vp.name} columns`).toBe(expected[vp.name]);
        // …and every row is internally equal-height.
        for (const heights of rows) {
          expect(new Set(heights).size, `${vp.name} heights`).toBe(1);
        }
      }
    });
  });
}

// ===========================================================================
// One data mapping drives both renderers
// ===========================================================================

test.describe("one row model, two renderers", () => {
  test("the card states the same facts the row does", async ({ page }) => {
    const read = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");
      return page.evaluate(() => {
        const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
        const narrow = document.querySelector(
          ".ilk-records--narrow",
        ) as HTMLElement;
        const showing =
          getComputedStyle(wide).display !== "none" ? wide : narrow;
        const el = showing.querySelector(
          '[data-intake-links-row-id="r-archived-submitted"], [data-intake-links-card-id="r-archived-submitted"]',
        ) as HTMLElement;
        return {
          lifecycle:
            el
              .querySelector("[data-intake-links-row-link-state]")
              ?.getAttribute("data-intake-links-row-link-state") ??
            el
              .querySelector("[data-intake-links-row-link-state-folded]")
              ?.getAttribute("data-intake-links-row-link-state-folded"),
          activity: el
            .querySelector("[data-intake-links-row-session-state]")
            ?.getAttribute("data-intake-links-row-session-state"),
          delivery: el
            .querySelector("[data-intake-links-row-delivery]")
            ?.getAttribute("data-intake-links-row-delivery"),
        };
      });
    };
    const wide = await read(1440);
    const narrow = await read(390);
    expect(wide).toEqual({
      lifecycle: "ARCHIVED",
      activity: "SUBMITTED",
      delivery: "QUEUED",
    });
    expect(narrow).toEqual(wide);
  });

  test("nothing is dropped at the medium fold — it is restated", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openIntakeLinks(page, "organization");
    const folded = await page.evaluate(() => {
      const row = document.querySelector(
        '.ilk-records--wide [data-intake-links-row-id="r-archived-submitted"]',
      ) as HTMLElement;
      const visible = (el: Element | null) =>
        Boolean(el) && getComputedStyle(el as HTMLElement).display !== "none";
      return {
        channelColumn: visible(row.querySelector('td[data-col="channel"]')),
        lifecycleColumn: visible(row.querySelector('td[data-col="lifecycle"]')),
        channelFold: visible(row.querySelector('[data-fold="channel"]')),
        lifecycleFold: visible(row.querySelector('[data-fold="lifecycle"]')),
        text: row.textContent ?? "",
      };
    });
    expect(folded.channelColumn).toBe(false);
    expect(folded.lifecycleColumn).toBe(false);
    // Both values survive, in the cells that remain.
    expect(folded.channelFold).toBe(true);
    expect(folded.lifecycleFold).toBe(true);
    expect(folded.text).toContain("SMS");
    expect(folded.text).toContain("Archived");
  });
});

// ===========================================================================
// RTL specifics
// ===========================================================================

test.describe("RTL", () => {
  for (const width of [1440, 390]) {
    test(`@ ${width}: mirrors logically and keeps technical runs readable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization", { workspaceName: LONG.workspace });
      await setDirection(page, "rtl");

      const measured = await page.evaluate(() => {
        const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
        const narrow = document.querySelector(
          ".ilk-records--narrow",
        ) as HTMLElement;
        const showing =
          getComputedStyle(wide).display !== "none" ? wide : narrow;
        const ltrRuns = Array.from(
          showing.querySelectorAll<HTMLElement>(".ilk-ltr"),
        ).map((el) => getComputedStyle(el).unicodeBidi);
        const kpi = document.querySelector(".ilk-kpi") as HTMLElement;
        const kr = kpi.getBoundingClientRect();
        const rail = getComputedStyle(kpi, "::before");
        const search = document.querySelector(".app-search-icon") as HTMLElement;
        const input = document.querySelector(".app-search-input") as HTMLElement;
        return {
          ltrRuns,
          // In RTL the rail sits on the START edge — the right.
          railInsetInlineStart: rail.insetInlineStart,
          kpiTextAlign: getComputedStyle(kpi).textAlign,
          searchIconRightOfInput:
            search.getBoundingClientRect().left >
            input.getBoundingClientRect().left,
          kpiWidth: kr.width,
        };
      });

      expect(measured.ltrRuns.length).toBeGreaterThan(0);
      for (const bidi of measured.ltrRuns) expect(bidi).toBe("plaintext");
      expect(measured.railInsetInlineStart).toBe("0px");
      expect(measured.kpiTextAlign).toBe("start");
      // The leading icon follows the text edge, which in RTL is the right.
      expect(measured.searchIconRightOfInput).toBe(true);

      expect(await horizontalOverflow(page)).toBe(0);
      expect(await escapedElements(page)).toEqual([]);
      expect(await cellEscapes(page)).toEqual([]);
    });
  }

  test("no physical left/right dependency survives in the route stylesheet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    // Measured, not grepped: flip the document and assert the surface's own
    // boxes mirror rather than staying put.
    const before = await page.evaluate(() => {
      const el = document.querySelector(".app-page-header__icon") as HTMLElement;
      return el.getBoundingClientRect().left;
    });
    await setDirection(page, "rtl");
    const after = await page.evaluate(() => {
      const el = document.querySelector(".app-page-header__icon") as HTMLElement;
      return el.getBoundingClientRect().left;
    });
    expect(after).toBeGreaterThan(before + 200);
  });
});

// ===========================================================================
// The wizard, at every width and both directions
// ===========================================================================

test.describe("wizard geometry", () => {
  for (const dir of DIRECTIONS) {
    for (const vp of VIEWPORTS) {
      test(`${dir} @ ${vp.name}: one scroller, reachable head and foot`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openIntakeLinks(page, "organization");
        await setDirection(page, dir);
        await openWizard(page);

        const measured = await page.evaluate(() => {
          const dlg = document.querySelector(
            '[data-testid="intake-link-create-wizard"]',
          ) as HTMLElement;
          const vh = document.documentElement.clientHeight;
          const vw = document.documentElement.clientWidth;
          const head = dlg.querySelector(".app-dialog__head") as HTMLElement;
          const foot = dlg.querySelector(".app-dialog__footer") as HTMLElement;
          const scrollers = Array.from(
            dlg.querySelectorAll<HTMLElement>("*"),
          ).filter((el) => {
            const cs = getComputedStyle(el);
            return (
              (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
              el.scrollHeight > el.clientHeight + 1
            );
          });
          const r = dlg.getBoundingClientRect();
          const hr = head.getBoundingClientRect();
          const fr = foot.getBoundingClientRect();
          const stepper = dlg.querySelector(
            "[data-intake-link-stepper]",
          ) as HTMLElement;
          const current = stepper.querySelector(
            '[aria-current="step"]',
          ) as HTMLElement;
          return {
            fits: r.height <= vh + 1 && r.width <= vw + 1,
            headVisible: hr.top >= -1 && hr.bottom <= vh + 1,
            footVisible: fr.top >= -1 && fr.bottom <= vh + 1,
            scrollerCount: scrollers.length,
            scrollerIsBody: scrollers.every((s) =>
              s.className.includes("app-dialog__body"),
            ),
            currentStepVisible:
              current.getBoundingClientRect().width > 0 &&
              current.getBoundingClientRect().right <= vw + 1,
            docOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          };
        });

        expect(measured.fits).toBe(true);
        expect(measured.headVisible).toBe(true);
        expect(measured.footVisible).toBe(true);
        expect(measured.scrollerCount).toBeLessThanOrEqual(1);
        expect(measured.scrollerIsBody).toBe(true);
        expect(measured.currentStepVisible).toBe(true);
        expect(measured.docOverflow).toBe(0);
        expect(
          await escapedElements(page, '[data-testid="intake-link-create-wizard"]'),
        ).toEqual([]);
        expect(
          await smallTargets(page, '[data-testid="intake-link-create-wizard"]'),
        ).toEqual([]);
      });
    }
  }

  test("a long custom sender and a long consent stay inside the dialog", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);
    await page.click("[data-intake-link-wizard-next]");
    await page.click('[data-intake-link-sender-card-input="CUSTOM"]');
    await page.fill('[data-intake-link-sender-custom-name="true"]', LONG.sender);
    await page.click('[data-intake-link-delivery-method-input="EMAIL"]');
    await page.fill("[data-intake-link-email]", LONG.email);
    await page.click("[data-intake-link-wizard-next]");
    await page.fill(
      "[data-intake-link-consent]",
      "I confirm that these files are mine to share and that I understand they will be recorded. ".repeat(
        20,
      ),
    );
    await page.click("[data-intake-link-wizard-next]");

    expect(await horizontalOverflow(page)).toBe(0);
    expect(
      await escapedElements(page, '[data-testid="intake-link-create-wizard"]'),
    ).toEqual([]);

    const preview = await page.evaluate(() => {
      const body = document.querySelector(
        '[data-intake-link-preview-body="true"]',
      ) as HTMLElement;
      return {
        overflowX: body.scrollWidth - body.clientWidth,
        containsLongEmail: (
          document.querySelector('[data-intake-link-preview-studio="true"]')
            ?.textContent ?? ""
        ).includes("claims-department"),
      };
    });
    expect(preview.overflowX).toBe(0);
    expect(preview.containsLongEmail).toBe(true);
  });
});

// ===========================================================================
// Localization — the fixed-percentage grid must not be an English contract
// ===========================================================================

test.describe("localization: long translated and user-generated values", () => {
  for (const width of [1024, 768]) {
    test(`German-length values fit the same columns @ ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization", {
        rows: GERMAN_ROWS,
        workspaceName: LONG.workspace,
      });

      expect(await horizontalOverflow(page)).toBe(0);
      expect(await cellEscapes(page)).toEqual([]);
      expect(await badgeCollisions(page)).toEqual([]);
      expect(await fragmentedRuns(page)).toEqual([]);
    });
  }

  test("German-length values fit in RTL too", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openIntakeLinks(page, "organization", { rows: GERMAN_ROWS });
    await setDirection(page, "rtl");
    expect(await horizontalOverflow(page)).toBe(0);
    expect(await cellEscapes(page)).toEqual([]);
    expect(await badgeCollisions(page)).toEqual([]);
  });

  test("a doubled text scale still contains every column", async ({ page }) => {
    // Browser text scaling is the accessibility case the fixed grid most
    // plausibly breaks: the columns are percentages of the table, but the text
    // inside them is not.
    await page.setViewportSize({ width: 1280, height: 900 });
    await openIntakeLinks(page, "organization");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => r(null))),
    );
    expect(await horizontalOverflow(page)).toBe(0);
    expect(await cellEscapes(page)).toEqual([]);
    expect(await badgeCollisions(page)).toEqual([]);
  });
});
