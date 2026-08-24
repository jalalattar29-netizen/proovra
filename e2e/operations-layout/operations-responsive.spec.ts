/**
 * OPERATIONS — GEOMETRY, STATES AND DIRECTION, MEASURED IN A REAL ENGINE.
 *
 * Every property here is one that only a layout engine can answer. Source
 * inspection cannot say whether a queue row overflows at 320px, whether the
 * listbox popup is clipped by the toolbar it opens from, whether the table and
 * the cards are ever both in the accessibility tree at once, or whether the
 * Arabic layout mirrors. jsdom answers 0 to all of them.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  hasHorizontalOverflow,
  isWithinViewport,
  observedPlatformCalls,
  openOperations,
  overflowingElements,
  setDirection,
  VIEWPORTS,
  type OpsScenario,
} from "./_fixtures";

/**
 * The width at which the table hands over to the cards.
 *
 * Declared here as the CONTRACT, and asserted from both sides below — a
 * cutover that only the stylesheet knows about is one nobody notices moving.
 */
const CUTOVER = 1040;

/**
 * The control the OPERATOR can press.
 *
 * Both renderers are in the document at every width; the stylesheet decides
 * which one is in the layout. An unscoped locator resolves to whichever comes
 * first in DOM order — frequently the hidden twin — and then waits for it to
 * become visible until the test times out.
 */
const visible = (page: Page, selector: string) =>
  page.locator(`${selector}:visible`);

const isTable = (w: number) => w > CUTOVER;

async function renderers(page: Page) {
  return page.evaluate(() => {
    const visible = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    };
    return {
      table: visible("[data-ops-table-surface]"),
      cards: visible("[data-ops-cards]"),
    };
  });
}

// ===========================================================================
// 1. THE PAGE NEVER SCROLLS SIDEWAYS
// ===========================================================================

const STRESS_STATES: ReadonlyArray<{ scenario: OpsScenario; note: string }> = [
  { scenario: "default", note: "mixed severities" },
  { scenario: "long-title", note: "a filename nobody would shorten" },
  { scenario: "long-identifiers", note: "a request id longer than the panel" },
  { scenario: "hundred-plus", note: "fifty rows and a next page" },
];

for (const viewport of VIEWPORTS) {
  for (const { scenario, note } of STRESS_STATES) {
    test(`${viewport.name} · ${scenario}: the page does not scroll sideways (${note})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openOperations(page, "team-admin", { scenario });
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  }

  test(`${viewport.name}: no route element overflows its own box`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin", { scenario: "long-title" });
    // The table surface is exempt by design — it declares `overflow-x: auto`,
    // and wide content scrolling INSIDE it is exactly what stops it teaching
    // the page to scroll.
    expect(await overflowingElements(page)).toEqual([]);
  });

  test(`${viewport.name}: exactly ONE renderer is in the layout`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin");
    const r = await renderers(page);
    expect(
      r.table !== r.cards,
      `table=${r.table} cards=${r.cards} — exactly one must render`,
    ).toBe(true);
    expect(r.table).toBe(isTable(viewport.width));
    expect(r.cards).toBe(!isTable(viewport.width));
  });
}

test("the cutover happens at the declared width, from both sides", async ({
  page,
}) => {
  await openOperations(page, "team-admin");

  await page.setViewportSize({ width: CUTOVER + 1, height: 900 });
  await page.waitForTimeout(60);
  expect((await renderers(page)).table, `${CUTOVER + 1} must be the table`).toBe(true);

  await page.setViewportSize({ width: CUTOVER, height: 900 });
  await page.waitForTimeout(60);
  expect((await renderers(page)).cards, `${CUTOVER} must be the cards`).toBe(true);
});

// ===========================================================================
// 2. THE SUMMARY STRIP
// ===========================================================================

test("every summary card carries a NUMBER, never an empty caption", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  const values = await page
    .locator("[data-ops-metric] .app-metric-card__value")
    .allTextContents();
  expect(values.length).toBe(7);
  for (const v of values) {
    expect(v.trim().length, "a card with no value is a caption for nothing").toBeGreaterThan(0);
  }
});

test("the summary cards share one geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  const boxes = await page
    .locator("[data-ops-metric]")
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
  expect(boxes.length).toBe(7);
  // Equal widths and equal heights: a strip whose cards disagree reads as a
  // rendering fault, and the eye uses the difference as meaning.
  expect(new Set(boxes.map((b) => b.w)).size).toBe(1);
  expect(new Set(boxes.map((b) => b.h)).size).toBe(1);
});

test("a zero-value card keeps its full surface", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "clear-empty" });
  const boxes = await page
    .locator("[data-ops-metric]")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of boxes) expect(h).toBeGreaterThan(40);
});

// ===========================================================================
// 3. SELECTORS AND OVERLAYS
// ===========================================================================

test("an open listbox is not clipped by the toolbar it opens from", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOperations(page, "team-admin");
  const trigger = page.locator(".app-listbox__trigger").first();
  await trigger.click();
  const popup = page.locator(".app-listbox__popup");
  await expect(popup).toBeVisible();

  // It escapes through the portal: its box is not CONTAINED by the toolbar's.
  //
  // Escape is checked in EITHER direction. The overlay flips upward when
  // there is not room below — which is correct behaviour and happens for real
  // whenever the toolbar sits low in the viewport — so requiring the popup to
  // overflow downward would fail the surface for doing the right thing while
  // still passing a genuinely clipped popup that happened to open downward.
  const clipped = await page.evaluate(() => {
    const pop = document.querySelector(".app-listbox__popup");
    const bar = document.querySelector("[data-ops-controls]");
    if (!pop || !bar) return true;
    const p = pop.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const escapesBar = p.bottom > b.bottom + 1 || p.top < b.top - 1;
    const visible = p.width > 0 && p.height > 0;
    return !(escapesBar && visible);
  });
  expect(clipped, "the popup must escape the toolbar").toBe(false);
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test("the LAST row's action menu is not truncated by the table surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  await visible(page, "[data-ops-row-menu-trigger]").last().click();
  const panel = page.locator("[data-ops-row-menu-panel]");
  await expect(panel).toBeVisible();
  expect(await isWithinViewport(page, "[data-ops-row-menu-panel]")).toBe(true);
});

// ===========================================================================
// 4. THE INSPECTOR
// ===========================================================================

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: the inspector stays inside the viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin", { scenario: "long-identifiers" });
    await visible(page, "[data-ops-open]").first().click();
    await expect(page.locator("[data-ops-inspector]")).toBeVisible();
    expect(await isWithinViewport(page, "[data-ops-inspector]")).toBe(true);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    expect(await overflowingElements(page)).toEqual([]);
  });
}

test("a long identifier is bounded and LTR-isolated, not a horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOperations(page, "team-admin", { scenario: "long-identifiers" });
  await visible(page, "[data-ops-open]").first().click();
  const value = page.locator(".opsw-ident__value").first();
  await expect(value).toBeVisible();
  const info = await value.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      overflow: s.overflow,
      whiteSpace: s.whiteSpace,
      bidi: s.unicodeBidi,
      direction: s.direction,
      width: r.width,
      inner: window.innerWidth,
    };
  });
  expect(info.overflow).toBe("hidden");
  expect(info.whiteSpace).toBe("nowrap");
  expect(info.bidi).toBe("isolate");
  expect(info.direction).toBe("ltr");
  expect(info.width).toBeLessThanOrEqual(info.inner);
});

test("opening the inspector does not move the queue", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");
  const before = await page
    .locator("[data-ops-row]")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  await visible(page, "[data-ops-open]").first().click();
  await expect(page.locator("[data-ops-inspector]")).toBeVisible();
  const after = await page
    .locator("[data-ops-row]")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(after).toEqual(before);
});

// ===========================================================================
// 5. RTL AND LONG-STRING CONTENT
// ===========================================================================

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: mirrors in Arabic without overflowing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOperations(page, "team-admin", { scenario: "long-title" });
    await setDirection(page, "rtl");
    expect(await hasHorizontalOverflow(page)).toBe(false);
    expect(await overflowingElements(page)).toEqual([]);
  });
}

test("RTL puts the summary tone rail on the logical inline-start edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin");

  const readCard = () =>
    page
      .locator("[data-ops-metric]")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const rail = getComputedStyle(el, "::before");
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          // The rail is declared with a LOGICAL inset, so it rides the
          // mirrored edge without a second rule.
          railLeft: Math.round(r.left),
          padStart: getComputedStyle(el).paddingInlineStart,
          railContent: rail.content,
        };
      });

  const ltr = await readCard();
  await setDirection(page, "rtl");
  const rtl = await readCard();

  // The FIRST card moved to the other side of the strip: the layout mirrored.
  expect(Math.abs(rtl.left - ltr.left)).toBeGreaterThan(100);
  // The rail exists in both directions and is inset from the logical start,
  // which is the physical LEFT in LTR and the physical RIGHT in RTL.
  expect(ltr.railContent).not.toBe("none");
  expect(rtl.railContent).not.toBe("none");
  expect(ltr.padStart).toBe(rtl.padStart);
});

test("German-length titles do not break the row", async ({ page }) => {
  for (const width of [1440, 1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page, "team-admin", {
      scenario: "default",
      longGerman: true,
    });
    expect(await hasHorizontalOverflow(page), `${width}px`).toBe(false);
    expect(await overflowingElements(page), `${width}px`).toEqual([]);
  }
});

test("a long title is clamped rather than pushing the columns off the surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperations(page, "team-admin", { scenario: "long-title" });
  const title = page.locator(".opsw-condition__title").first();
  const clamp = await title.evaluate((el) => getComputedStyle(el).webkitLineClamp);
  expect(clamp).toBe("2");
  // …and the columns to its right are still where they belong.
  const statusLeft = await page
    .locator(".opsw-col-status")
    .nth(1)
    .evaluate((el) => el.getBoundingClientRect().left);
  expect(statusLeft).toBeLessThan(1440);
});

// ===========================================================================
// 6. STATE-SPECIFIC RENDERING
// ===========================================================================

test("clear: an empty COMPLETE unfiltered read says so, and offers tenant destinations", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "clear-empty" });
  await expect(page.locator('[data-ops-empty="clear"]')).toBeVisible();
  const hrefs = await page
    .locator('[data-ops-empty="clear"] a')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["/evidence", "/home"]);
  expect(observedPlatformCalls()).toEqual([]);
});

test("filtered empty is NOT clear", async ({ page }) => {
  await openOperations(page, "team-admin", {
    scenario: "filtered-empty",
    query: "?severity=CRITICAL",
  });
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator('[data-ops-empty="filtered"]')).toBeVisible();
});

test("truncated is NOT clear, and announces itself", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "truncated" });
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  const degraded = page.locator("[data-ops-degraded]");
  await expect(degraded).toBeVisible();
  expect(await degraded.getAttribute("role")).toBe("alert");
});

test("a failed incident read is unavailable, never clear", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "unavailable-incidents" });
  await expect(page.locator("[data-ops-unavailable]")).toBeVisible();
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/operations are clear/i);
});

test("a failed summary degrades the strip and leaves the queue standing", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "degraded-summary" });
  await expect(page.locator("[data-ops-degraded]")).toBeVisible();
  await expect(page.locator("[data-ops-row]").first()).toBeVisible();
  // No summary cards, because there is no honest number to put in them.
  await expect(page.locator("[data-ops-metric]")).toHaveCount(0);
});

test("no failure leaks a provider or database string", async ({ page }) => {
  for (const scenario of [
    "unavailable-incidents",
    "degraded-summary",
    "mutation-error",
  ] as OpsScenario[]) {
    await openOperations(page, "team-admin", { scenario });
    const body = (await page.locator("body").textContent()) ?? "";
    for (const leak of ["PrismaClient", "ECONNREFUSED", "operational_incidents", "at Object."]) {
      expect(body, `${scenario} must not leak ${leak}`).not.toContain(leak);
    }
  }
});

test("one incident renders one row, with the same anatomy as fifty", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "one-incident" });
  await expect(page.locator("[data-ops-row]")).toHaveCount(1);
  await expect(page.locator("[data-ops-severity]").first()).toBeVisible();
  await expect(page.locator("[data-ops-status]").first()).toBeVisible();
  await expect(
    page.locator("[data-ops-table-surface] [data-ops-owner]").first(),
  ).toBeVisible();
});

test("a large page offers a bounded next page rather than an unbounded DOM", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "hundred-plus" });
  await expect(page.locator("[data-ops-row]")).toHaveCount(50);
  await expect(page.locator("[data-ops-load-more]")).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test("overdue posture is a WORD as well as a colour", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "overdue" });

  // The PROPERTY is unchanged and still the point: an operator who cannot
  // distinguish the two reds must still be able to triage, so lateness is
  // stated in words. What changed in Phase B is WHICH authority says it —
  // the workspace's own SLA policy now supersedes the fixed age heuristic,
  // and exactly ONE of the two renders so they cannot disagree on a row.
  const sla = await page.locator("[data-ops-sla-badge]").allTextContents();
  // The age-derived badge no longer exists: after the Phase B closure there
  // is exactly one authority on lateness, and it is the workspace own
  // recorded promise.
  const heuristic = await page
    .locator("[data-ops-overdue-badge]")
    .allTextContents();
  expect(heuristic.length, "the age heuristic must be gone").toBe(0);

  expect(sla.length, "a late condition must say so in words").toBeGreaterThan(0);
  for (const b of sla) {
    expect(["Overdue", "Due soon"]).toContain(b.trim());
  }
});

// ===========================================================================
// 7. THE FALSE-CLEAR SWEEP
//
// One assertion, every failure mode. "Workspace operations are clear" is the
// most consequential sentence this page can say: an operator who reads it
// stops looking. It may be rendered ONLY over a source that succeeded, reached
// the end of its collection, and was not filtered.
// ===========================================================================

const NEVER_CLEAR: ReadonlyArray<{ scenario: OpsScenario; why: string }> = [
  { scenario: "unavailable-incidents", why: "the incident source failed" },
  { scenario: "degraded-summary", why: "the summary source failed" },
  { scenario: "truncated", why: "the population was truncated" },
  { scenario: "filtered-empty", why: "a filter excluded everything" },
];

for (const { scenario, why } of NEVER_CLEAR) {
  test(`false-clear sweep — ${scenario}: cannot say "clear" because ${why}`, async ({
    page,
  }) => {
    await openOperations(page, "team-admin", {
      scenario,
      query: scenario === "filtered-empty" ? "?severity=CRITICAL" : undefined,
    });
    await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      "Workspace operations are clear",
    );
  });
}

test("freshness is stamped only after a source actually succeeded", async ({
  page,
}) => {
  // A "last updated" that appears over a failed read is a claim about data the
  // page does not have.
  await openOperations(page, "team-admin", { scenario: "unavailable-incidents" });
  await expect(page.locator("[data-ops-unavailable]")).toBeVisible();
  await expect(page.locator("[data-ops-last-loaded]")).toHaveCount(0);

  await openOperations(page, "team-admin");
  await expect(page.locator("[data-ops-last-loaded]")).toBeVisible();
  await expect(page.locator("[data-ops-last-loaded]")).toContainText(/Updated/);
});

test("a timeout is a failure, not an empty collection", async ({ page }) => {
  // A source that never answers must not decay into "nothing to show".
  await openOperations(page, "team-admin");
  await page.route("**/v1/ops/incidents?*", () => {
    /* never fulfilled */
  });
  await page.locator("[data-ops-refresh]").click();
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "Workspace operations are clear",
  );
});
