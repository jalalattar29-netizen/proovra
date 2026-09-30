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

/**
 * The widest viewport that still renders the CARDS; one pixel above it the
 * table renders. `@media (max-width: 1199px)` in `intake-links.css`, set by
 * 67368b23 (2026-09-05) when the table was regrouped into seven columns. It
 * was 900px before that commit.
 */
const TABLE_CUTOVER = 1199;

/** The seven grouped columns 67368b23 introduced, in order. */
const COLUMNS = [
  "request",
  "identity",
  "delivery",
  "status",
  "timeline",
  "submissions",
  "actions",
] as const;

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
        // `.ilk-status__value` was retired by 67368b23; the delivery and
        // activity values it selected are both `.ilk-state-text` now.
        "[data-intake-links-row-delivery], .ilk-state-text, .ilk-expiry, .ilk-relative",
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
          // The table renders only where seven columns still fit; below that the
          // cards take over rather than the table scrolling inside its frame.
          //
          // The cutover was 900px. 67368b23 (2026-09-05, "simplify link results
          // hierarchy") regrouped the table into seven wider columns and moved
          // it to 1199px on purpose — "the table hands over to the cards at
          // 1199px" — so 1024px is now a card width.
          expect(r.table).toBe(vp.width > TABLE_CUTOVER);
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
          // ONE probe, at every width. Lifecycle no longer has a folded twin
          // to fall back to, and reading for one would hide its loss.
          lifecycle: el
            .querySelector("[data-intake-links-row-link-state]")
            ?.getAttribute("data-intake-links-row-link-state"),
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

  /*
   * WHAT THIS TEST USED TO SAY, AND WHY IT CHANGED.
   *
   * It was "nothing is dropped at the medium fold — it is restated": at 1024px
   * the ten-column table hid its Channel and Latest columns and restated them
   * through `[data-fold="channel"]` inside a surviving cell, while Lifecycle
   * kept a column of its own.
   *
   * 67368b23 (2026-09-05, "simplify link results hierarchy") retired that
   * mechanism on purpose: "The old surface answered the same shortfall by
   * HIDING two columns below 1500px — worse, since a hidden column is a fact
   * the operator cannot see". There are seven grouped columns now, NONE is
   * hidden at any table width, the channel lives in the Delivery cell and the
   * latest-activity date in the Timeline cell, and 1024px renders the cards.
   *
   * The guarantee is the same one — no fact is lost at the narrowest layout —
   * and it is asserted directly, at the narrowest TABLE and on the card that
   * replaced the medium table.
   */
  test("nothing is dropped at the narrowest table, and nothing is restated", async ({
    page,
  }) => {
    await page.setViewportSize({ width: TABLE_CUTOVER + 1, height: 800 });
    await openIntakeLinks(page, "organization");
    const table = await page.evaluate((columns) => {
      const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
      const row = wide.querySelector(
        '[data-intake-links-row-id="r-archived-submitted"]',
      ) as HTMLElement;
      const painted = (el: Element | null) => {
        if (!el) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return (
          getComputedStyle(el as HTMLElement).display !== "none" &&
          r.width > 0 &&
          r.height > 0
        );
      };
      const life = row.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      const delivery = row.querySelector('td[data-col="delivery"]') as HTMLElement;
      const status = row.querySelector('td[data-col="status"]') as HTMLElement;
      const timeline = row.querySelector('td[data-col="timeline"]') as HTMLElement;
      return {
        tableShowing: getComputedStyle(wide).display !== "none",
        columnOrder: Array.from(row.querySelectorAll("td")).map((td) =>
          td.getAttribute("data-col"),
        ),
        paintedColumns: columns.filter((c) =>
          painted(row.querySelector(`td[data-col="${c}"]`)),
        ),
        headings: Array.from(wide.querySelectorAll("thead th")).filter((th) =>
          painted(th),
        ).length,
        // The retired columns and the retired restatements. Absence is the
        // assertion: nothing is hidden, so nothing needs restating.
        retired: row.querySelectorAll(
          'td[data-col="channel"], td[data-col="latest"], td[data-col="lifecycle"], td[data-col="expires"], [data-fold="channel"], [data-fold="lifecycle"], [data-fold="latest"]',
        ).length,
        channelLabel: painted(delivery.querySelector(".ilk-delivery__channel-label"))
          ? delivery
              .querySelector(".ilk-delivery__channel-label")
              ?.textContent?.trim()
          : null,
        latest: painted(timeline.querySelector(".ilk-relative"))
          ? (timeline.querySelector(".ilk-relative")?.textContent?.trim() ?? "")
          : "",
        timelineKeys: Array.from(
          timeline.querySelectorAll(".ilk-timeline__key"),
        ).map((k) => k.textContent?.trim()),
        lifecycleColumn: life.closest("td")?.getAttribute("data-col"),
        lifecyclePainted: painted(life),
        lifecycleText: life.textContent?.trim(),
        lifecycleCount: row.querySelectorAll("[data-intake-links-row-link-state]")
          .length,
        lifecycleInDelivery: delivery.querySelectorAll(
          "[data-intake-links-row-link-state]",
        ).length,
        deliveryCount: row.querySelectorAll("[data-intake-links-row-delivery]")
          .length,
        activityCount: row.querySelectorAll(
          "[data-intake-links-row-session-state]",
        ).length,
        deliveryNames: Array.from(
          delivery.querySelectorAll(".app-visually-hidden"),
        ).map((n) => n.textContent),
        statusNames: Array.from(
          status.querySelectorAll(".app-visually-hidden"),
        ).map((n) => n.textContent),
      };
    }, COLUMNS as unknown as string[]);

    // Seven columns, in order, every one of them painted — none folds away.
    expect(table.tableShowing).toBe(true);
    expect(table.columnOrder).toEqual([...COLUMNS]);
    expect(table.paintedColumns).toEqual([...COLUMNS]);
    expect(table.headings).toBe(COLUMNS.length);
    expect(table.retired).toBe(0);

    // The two facts that used to fold are stated in the open, where they now
    // live: the channel in Delivery, the latest activity in Timeline.
    expect(table.channelLabel).toBe("SMS");
    expect(table.latest.length).toBeGreaterThan(0);
    expect(table.timelineKeys).toEqual(["Latest", "Expires"]);

    // Lifecycle is stated once — in the Status column, which 67368b23 made its
    // one home ("a filled badge over quiet toned text") — and never restated
    // in Delivery. Each of the other two axes is stated once as well.
    expect(table.lifecycleColumn).toBe("status");
    expect(table.lifecyclePainted).toBe(true);
    expect(table.lifecycleText).toBe("Archived");
    expect(table.lifecycleCount).toBe(1);
    expect(table.lifecycleInDelivery).toBe(0);
    expect(table.deliveryCount).toBe(1);
    expect(table.activityCount).toBe(1);
    // The visible "Delivery" / "Activity" keys became the column heading and
    // an assistive name on each subordinate value (same commit: "the
    // subordinate lines are named for assistive technology").
    expect(table.deliveryNames).toEqual(["Delivery status: "]);
    expect(table.statusNames).toEqual(["Contributor activity: "]);

    // 1024px — the width this test measured the medium table at — is the card
    // now, and the card drops nothing either.
    await page.setViewportSize({ width: 1024, height: 800 });
    await openIntakeLinks(page, "organization");
    const card = await page.evaluate(() => {
      const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
      const el = narrow.querySelector(
        '[data-intake-links-card-id="r-archived-submitted"]',
      ) as HTMLElement;
      const painted = (node: Element | null) => {
        if (!node) return false;
        const r = (node as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        cardsShowing: getComputedStyle(narrow).display !== "none",
        channelLabel: painted(el.querySelector(".ilk-delivery__channel-label"))
          ? el.querySelector(".ilk-delivery__channel-label")?.textContent?.trim()
          : null,
        latestPainted: painted(el.querySelector(".ilk-relative")),
        expiryPainted: painted(
          el.querySelector("[data-intake-links-row-expiry-date]"),
        ),
        lifecycleText: el
          .querySelector("[data-intake-links-row-link-state]")
          ?.textContent?.trim(),
        lifecycleCount: el.querySelectorAll("[data-intake-links-row-link-state]")
          .length,
        deliveryCount: el.querySelectorAll("[data-intake-links-row-delivery]")
          .length,
        activityCount: el.querySelectorAll(
          "[data-intake-links-row-session-state]",
        ).length,
        folds: el.querySelectorAll(
          '[data-fold="channel"], [data-fold="lifecycle"], [data-fold="latest"]',
        ).length,
      };
    });
    expect(card.cardsShowing).toBe(true);
    expect(card.channelLabel).toBe("SMS");
    expect(card.latestPainted).toBe(true);
    expect(card.expiryPainted).toBe(true);
    expect(card.lifecycleText).toBe("Archived");
    expect(card.lifecycleCount).toBe(1);
    expect(card.deliveryCount).toBe(1);
    expect(card.activityCount).toBe(1);
    expect(card.folds).toBe(0);
  });

  /*
   * This was "Delivery & activity carries only those two, at every width",
   * read through `.ilk-status__key` / `.ilk-status__line` / `.ilk-status__value`
   * — the two visibly-keyed lines of the old shared cell.
   *
   * 67368b23 (2026-09-05) split that cell in two: Delivery is its own column
   * (channel over provider state) and Activity moved under the lifecycle badge
   * in Status. The keyed lines are gone; each value is `.ilk-state-text` with
   * an assistive name. So "only those two" became "each cell carries exactly
   * its own facts, once", which is what is asserted — for every row, at every
   * table width, with the renderer itself pinned rather than skipped.
   */
  test("Delivery and Status each carry exactly their own facts, at every width", async ({
    page,
  }) => {
    for (const width of [1440, 1280, TABLE_CUTOVER + 1, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");
      const measured = await page.evaluate(() => {
        const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
        if (getComputedStyle(wide).display === "none") return null;
        const count = (host: Element, sel: string) =>
          host.querySelectorAll(sel).length;
        const names = (host: Element) =>
          Array.from(host.querySelectorAll(".app-visually-hidden")).map(
            (n) => n.textContent,
          );
        return Array.from(
          wide.querySelectorAll<HTMLElement>("tr[data-intake-links-row-id]"),
        ).map((row) => {
          const delivery = row.querySelector(
            'td[data-col="delivery"]',
          ) as HTMLElement;
          const status = row.querySelector('td[data-col="status"]') as HTMLElement;
          return {
            delivery: {
              delivery: count(delivery, "[data-intake-links-row-delivery]"),
              activity: count(delivery, "[data-intake-links-row-session-state]"),
              lifecycle: count(delivery, "[data-intake-links-row-link-state]"),
              values: count(delivery, ".ilk-state-text"),
              names: names(delivery),
            },
            status: {
              delivery: count(status, "[data-intake-links-row-delivery]"),
              activity: count(status, "[data-intake-links-row-session-state]"),
              lifecycle: count(status, "[data-intake-links-row-link-state]"),
              values: count(status, ".ilk-state-text"),
              names: names(status),
            },
            // Nothing outside those two cells states any of the three.
            rowTotal: count(
              row,
              "[data-intake-links-row-delivery], [data-intake-links-row-session-state], [data-intake-links-row-link-state]",
            ),
          };
        });
      });
      // The table is shown exactly above the cutover — a width is never
      // silently skipped.
      expect(measured !== null, `${width}px renderer`).toBe(width > TABLE_CUTOVER);
      if (!measured) continue;
      expect(measured.length, `${width}px`).toBeGreaterThan(0);
      for (const row of measured) {
        // Delivery: the provider state, named, and nothing else.
        expect(row.delivery, `${width}px delivery cell`).toEqual({
          delivery: 1,
          activity: 0,
          lifecycle: 0,
          values: 1,
          names: ["Delivery status: "],
        });
        // Status: the lifecycle badge over ONE named activity value.
        expect(row.status, `${width}px status cell`).toEqual({
          delivery: 0,
          activity: 1,
          lifecycle: 1,
          values: 1,
          names: ["Contributor activity: "],
        });
        expect(row.rowTotal, `${width}px`).toBe(3);
      }
    }
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
  // 1280 and 1200 were added when the cutover moved to 1199px (67368b23): at
  // 1024 and 768 the German values are now measured in the CARDS, so without
  // these two widths nothing would measure them in the table's columns at all.
  for (const width of [1280, TABLE_CUTOVER + 1, 1024, 768]) {
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

  // 1280 joins 1024 for the same reason as above: 1024 is the cards now.
  for (const width of [1280, 1024]) {
    test(`German-length values fit in RTL too @ ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization", { rows: GERMAN_ROWS });
      await setDirection(page, "rtl");
      expect(await horizontalOverflow(page)).toBe(0);
      expect(await cellEscapes(page)).toEqual([]);
      expect(await badgeCollisions(page)).toEqual([]);
    });
  }

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

// ===========================================================================
// The 1199px cutover (900px until 67368b23, 2026-09-05)
// ===========================================================================

test.describe("the table/card cutover", () => {
  /** Everything one record states, from whichever renderer is showing. */
  async function factsAt(page: Page, width: number) {
    await page.setViewportSize({ width, height: 900 });
    await openIntakeLinks(page, "organization");
    return page.evaluate(() => {
      const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
      const narrow = document.querySelector(".ilk-records--narrow") as HTMLElement;
      const tableShowing = getComputedStyle(wide).display !== "none";
      const cardsShowing = getComputedStyle(narrow).display !== "none";
      const host = tableShowing ? wide : narrow;
      const el = host.querySelector(
        '[data-intake-links-row-id="r-archived-submitted"], [data-intake-links-card-id="r-archived-submitted"]',
      ) as HTMLElement;
      const attr = (name: string) =>
        el.querySelector(`[${name}]`)?.getAttribute(name) ?? null;
      return {
        tableShowing,
        cardsShowing,
        lifecycle: attr("data-intake-links-row-link-state"),
        activity: attr("data-intake-links-row-session-state"),
        delivery: attr("data-intake-links-row-delivery"),
        expiry: (
          el.querySelector(
            "[data-intake-links-row-expiry-date]",
          ) as HTMLElement | null
        )?.textContent?.trim() ?? null,
        // The identifying copy, so "the same facts" is not just three enums.
        title: (
          el.querySelector(".ilk-row__title") as HTMLElement | null
        )?.textContent?.trim() ?? null,
        recipient: (el.textContent ?? "").includes("•••"),
        // Exactly one lifecycle statement, whichever renderer is showing.
        lifecycleCount: el.querySelectorAll("[data-intake-links-row-link-state]")
          .length,
        rowCount: host.querySelectorAll(
          "[data-intake-links-row-id], [data-intake-links-card-id]",
        ).length,
      };
    });
  }

  // The cutover was 901/900. 67368b23 (2026-09-05) moved it to 1200/1199 with
  // the seven-column regrouping: "the table hands over to the cards at 1199px".
  test("1200px is the table, 1199px is the cards, and never both", async ({
    page,
  }) => {
    const above = await factsAt(page, TABLE_CUTOVER + 1);
    const below = await factsAt(page, TABLE_CUTOVER);

    expect(above.tableShowing).toBe(true);
    expect(above.cardsShowing).toBe(false);
    expect(below.tableShowing).toBe(false);
    expect(below.cardsShowing).toBe(true);
  });

  test("nothing is lost crossing the cutover", async ({ page }) => {
    // Measured either side of the REAL cutover. At the retired 901/900 pair
    // both reads came from the cards, which compared a renderer with itself.
    const above = await factsAt(page, TABLE_CUTOVER + 1);
    const below = await factsAt(page, TABLE_CUTOVER);
    expect(above.tableShowing).toBe(true);
    expect(below.cardsShowing).toBe(true);

    // The three axes, the expiry date and the record's identity survive the
    // switch unchanged — the cards are a different renderer, not a smaller
    // subset.
    expect(below.lifecycle).toBe(above.lifecycle);
    expect(below.activity).toBe(above.activity);
    expect(below.delivery).toBe(above.delivery);
    expect(below.expiry).toBe(above.expiry);
    expect(below.title).toBe(above.title);
    expect(below.recipient).toBe(above.recipient);
    expect(below.rowCount).toBe(above.rowCount);

    // And each states its lifecycle exactly once.
    expect(above.lifecycleCount).toBe(1);
    expect(below.lifecycleCount).toBe(1);
  });

  test("the table fits wherever it is shown", async ({ page }) => {
    // The reason the cutover moved: seven columns stopped fitting. At every
    // width where the table renders it must fit its own frame without a
    // sideways scroller.
    //
    // The widths were [1440, 1280, 1024, 940, 901]; since 67368b23 the table
    // is not rendered below 1200px, so the narrow end of the list is now the
    // 1200–1279px band down to the cutover itself.
    for (const width of [1440, 1280, 1279, 1240, TABLE_CUTOVER + 1]) {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");
      const measured = await page.evaluate(() => {
        const wide = document.querySelector(".ilk-records--wide") as HTMLElement;
        if (getComputedStyle(wide).display === "none") return null;
        const table = wide.querySelector("table") as HTMLElement;
        return {
          tableWidth: table.getBoundingClientRect().width,
          frameWidth: wide.getBoundingClientRect().width,
          scroller: wide.scrollWidth - wide.clientWidth,
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      expect(measured, `${width}px shows no table`).not.toBeNull();
      expect(measured!.tableWidth, `${width}px`).toBeLessThanOrEqual(
        measured!.frameWidth + 1,
      );
      expect(measured!.scroller, `${width}px scrolls sideways`).toBeLessThanOrEqual(1);
      expect(measured!.documentOverflow, `${width}px`).toBe(0);
    }
  });
});
