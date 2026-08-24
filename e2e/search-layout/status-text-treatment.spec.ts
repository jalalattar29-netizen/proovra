/**
 * BROWSER VERIFICATION — the text-only status treatment on Search and Cases.
 *
 * WHY THIS CANNOT BE A SOURCE TEST
 * ---------------------------------------------------------------------------
 * The source guard (`apps/web/__tests__/status-text-treatment.test.ts`) proves
 * the right CLASS is on the right element and the right rule is in the
 * stylesheet. It cannot prove what a browser actually paints, because that is
 * a question about the cascade: a route stylesheet loaded after the primitives
 * can put a background back, a `.app-status-text` inside a flex parent gets
 * BLOCKIFIED so its `display: inline` is silently discarded, and a removed
 * padding either leaves the words correctly spaced or leaves them touching.
 *
 * So this resolves COMPUTED STYLE through the real production bundle, and it
 * measures the two failure modes removing a capsule actually creates:
 *
 *   1. A surface comes back — a background, a border, a shadow, a radius, or
 *      leftover pill padding.
 *   2. Adjacent states CONCATENATE. The capsule's padding used to hold them
 *      apart; with it gone, "Matched title" and "Matched summary" can render as
 *      one run-together phrase.
 *
 * Both are checked at every supported width in both directions, because a
 * status that fits at 1440 is exactly the thing that overflows at 320.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { DIRECTIONS, openSearch, setDirection } from "./_fixtures";

/**
 * Every width the product supports, INCLUDING the two the shared fixture list
 * omits. 1280 is the most common desktop and 320 is the narrowest reflow
 * target in WCAG 1.4.10 — a status label is exactly the kind of nowrap phrase
 * that survives 390 and breaks the page at 320.
 */
const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 900 },
  { name: "1024", width: 1024, height: 800 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
  { name: "375", width: 375, height: 812 },
  { name: "320", width: 320, height: 800 },
] as const;

type Box = { background: string; border: string; shadow: string; radius: string; padding: string; color: string; fontSize: string };

/** The computed properties that decide whether an element is a capsule. */
async function boxOf(el: Locator): Promise<Box> {
  return el.evaluate((node) => {
    const s = getComputedStyle(node as Element);
    return {
      background: s.backgroundColor,
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
      shadow: s.boxShadow,
      radius: [s.borderTopLeftRadius, s.borderBottomRightRadius].join(" "),
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" "),
      color: s.color,
      fontSize: s.fontSize,
    };
  });
}

/**
 * Assert a label renders at its restored compact size, not the parent's.
 *
 * This is the regression this whole pass exists to catch: `font: inherit` made
 * a 12px status balloon to the 16px of its container. The size is read as a
 * COMPUTED px value from the production bundle, so an inherited size or a
 * dropped `data-size` fails here rather than only looking wrong.
 */
async function expectSize(el: Locator, px: string, what: string): Promise<void> {
  const box = await boxOf(el);
  expect(box.fontSize, `${what} is ${box.fontSize}, expected ${px}`).toBe(px);
}

/**
 * Assert an element paints NO surface of its own.
 *
 * `rgba(0, 0, 0, 0)` is what a browser reports for "no background" — checking
 * for the absence of a `background` declaration in source would not catch a
 * colour inherited from a rule written somewhere else.
 */
async function expectNoSurface(el: Locator, what: string): Promise<void> {
  const box = await boxOf(el);
  expect(box.background, `${what} paints a background`).toBe("rgba(0, 0, 0, 0)");
  expect(box.border, `${what} paints a border`).toBe("0px 0px 0px 0px");
  expect(box.shadow, `${what} paints a shadow`).toBe("none");
  expect(box.radius, `${what} keeps a capsule radius`).toBe("0px 0px");
  expect(box.padding, `${what} keeps pill padding`).toBe("0px 0px 0px 0px");
  // The ink is still there. A status stripped of its colour as well as its
  // capsule would pass every assertion above and be a regression.
  expect(box.color, `${what} lost its ink`).not.toBe("rgba(0, 0, 0, 0)");
}

/** The page must never scroll sideways because a status stopped fitting. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/**
 * Adjacent labels must not touch.
 *
 * Measured as a real GAP between rendered boxes rather than as the presence of
 * a `gap` declaration: a `gap` on a parent that is not a flex container does
 * nothing at all, and that is the mistake this catches.
 */
async function expectSeparated(els: Locator, what: string): Promise<void> {
  const n = await els.count();
  if (n < 2) return;
  const boxes = [];
  for (let i = 0; i < n; i += 1) {
    const b = await els.nth(i).boundingBox();
    expect(b, `${what} #${i} did not render`).not.toBeNull();
    boxes.push(b!);
  }
  for (let i = 1; i < boxes.length; i += 1) {
    const prev = boxes[i - 1]!;
    const cur = boxes[i]!;
    // Same visual line? Then there must be real horizontal space between them.
    // Different line (the row wrapped)? That is a valid separation too.
    const sameLine = Math.abs(prev.y - cur.y) < Math.min(prev.height, cur.height) / 2;
    if (!sameLine) continue;
    const gap = Math.min(
      Math.abs(cur.x - (prev.x + prev.width)),
      Math.abs(prev.x - (cur.x + cur.width)),
    );
    expect(gap, `${what} #${i - 1} and #${i} are touching — they read as one phrase`).toBeGreaterThanOrEqual(2);
  }
}

// ===========================================================================
// /search
// ===========================================================================

for (const dir of DIRECTIONS) {
  for (const vp of WIDTHS) {
    test(`search: statuses and match reasons are text-only — ${vp.name} ${dir}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // Row 2 of the fixture carries `["in_trash","archived","locked"]`, so the
      // status slot is populated and the secondary signals render beside it.
      await openSearch(page, "organization");
      await setDirection(page, dir);

      const status = page.locator("[data-search-result-status]").first();
      await expect(status).toBeVisible();
      await expectNoSurface(status, "search result status");
      // Restored to the 12px the status badge always was, not the 16px it
      // ballooned to when it inherited the result row.
      await expectSize(status, "12px", "search result status");
      // It is the TEXT primitive, not a flattened badge.
      await expect(status).toHaveClass(/app-status-text/);
      await expect(status).not.toHaveClass(/app-status-badge/);

      // The TYPE label deliberately keeps its fill. If this ever reports no
      // background, the change over-reached: a classification and a state are
      // different claims and this is what keeps them distinguishable.
      const type = page.locator(".search-type-badge").first();
      await expect(type).toBeVisible();
      const typeBox = await boxOf(type);
      expect(typeBox.background, "the type label lost its fill").not.toBe("rgba(0, 0, 0, 0)");

      // Match reasons: text-only, and readable as separate phrases.
      const reasons = page.locator(".search-match-reason");
      if ((await reasons.count()) > 0) {
        for (let i = 0; i < (await reasons.count()); i += 1) {
          await expectNoSurface(reasons.nth(i), `match reason #${i}`);
        }
        await expectSeparated(reasons, "match reasons");
      }

      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/status-text/search-results-statuses-${vp.name}-${dir}.png`,
        fullPage: false,
      });
    });
  }
}

test("search: the Inspector's lifecycle label is text, and carries no colour-only dot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSearch(page, "organization");
  // Selecting a row opens the Inspector, which is where the lifecycle label is.
  await page.locator("[data-search-result-row]").first().click();
  const life = page.locator("[data-search-inspector-lifecycle]");
  if ((await life.count()) > 0) {
    await expectNoSurface(life.first(), "inspector lifecycle");
    // The dot went with the capsule: it was a second rendering of the tone the
    // word already carries.
    expect(await life.first().locator(".app-status-badge__dot").count()).toBe(0);
  }
  await page.screenshot({
    path: "test-results/status-text/search-inspector-lifecycle.png",
  });
});

// ===========================================================================
// /cases — the list, and the Copilot rows on a case
// ===========================================================================

const CASE_ID = "c1000000-0000-4000-8000-000000000001";

/**
 * The Cases LIST, with one case per lifecycle state.
 *
 * Every state is present in one render, so a tone that is only reachable
 * through an uncommon status cannot escape the sweep — which is exactly how a
 * capsule survives a change like this.
 */
const CASE_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "ARCHIVED",
  "CLOSED",
] as const;

/** The ink each state must resolve to, as the browser reports it. */
const REQUIRED_INK: Record<string, string> = {
  OPEN: "rgb(21, 128, 61)", // --success-standard #15803D
  INVESTIGATING: "rgb(109, 40, 217)", // --accent-600 #6D28D9
  ON_HOLD: "rgb(109, 40, 217)", // --accent-600 #6D28D9
  RESOLVED: "rgb(194, 65, 12)", // --orange-ink #C2410C
  ARCHIVED: "rgb(220, 38, 38)", // --error #DC2626
  CLOSED: "rgb(15, 23, 42)", // --ink-primary #0F172A
};

async function openCasesList(page: Page): Promise<void> {
  const { envelopeFor } = await import("./_fixtures");
  const base = envelopeFor("organization");
  const envelope = {
    ...base,
    capabilities: {
      ...(base.capabilities as Record<string, boolean>),
      CASES_VIEW: true,
      CASES_MANAGE: true,
      EVIDENCE_VIEW: true,
    },
  };
  // Shaped as the real `MatterQueueItem` the `/v1/cases/matter-queue` envelope
  // projects — every field the row consumes, so the fixture cannot pass by
  // rendering an empty table.
  const items = CASE_STATUSES.map((status, i) => ({
    id: `c1000000-0000-4000-8000-00000000000${i}`,
    name: `Incident review ${status.toLowerCase()}`,
    referenceNumber: `CASE-00${i}`,
    status,
    priority: "P2",
    ownerUserId: "u-1",
    teamId: base.workspace ? (base.workspace as { id: string }).id : null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-20T11:22:33.456Z",
    // One case with no records ("Not started") and one with an artifact gap
    // ("Needs attention"); the rest are "Ready", so more than one readiness
    // state is on screen at once.
    linkedEvidenceCount: i === 0 ? 0 : 3,
    activeAssignmentCount: 0,
    openIncidentCount: 0,
    activeWorkflowCount: 0,
    overdueWorkflowCount: 0,
    governanceBlockerCount: 0,
    activeLegalHoldCount: 0,
    evidenceGapCount: i === 1 ? 1 : 0,
    riskScore: null,
    riskLevel: null,
    riskReasonCodes: [],
    recommendedAction: null,
    latestActivityAtUtc: "2026-08-20T11:22:33.456Z",
  }));
  const queueEnvelope = {
    generatedAt: "2026-08-20T12:00:00.000Z",
    workspace: {
      teamId: (base.workspace as { id: string }).id,
      role: "OWNER",
    },
    items,
    total: items.length,
  };

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "u-1", email: "operator@example.invalid" });
    }
    if (path.endsWith("/v1/cases/matter-queue")) return json(queueEnvelope);
    return json({});
  });
  await page.goto("/cases");
  await page.waitForSelector("[data-matter-queue-row]", { timeout: 30_000 });
}

for (const dir of DIRECTIONS) {
  for (const vp of WIDTHS) {
    test(`cases list: status and readiness are text-only — ${vp.name} ${dir}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openCasesList(page);
      await setDirection(page, dir);

      const statuses = page.locator('[data-matter-queue-row-chip="status"]');
      const count = await statuses.count();
      expect(count, "no case status rendered").toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        await expectNoSurface(statuses.nth(i), `case status #${i}`);
        // 12px, the status size — not the 16px table row it sits in.
        await expectSize(statuses.nth(i), "12px", `case status #${i}`);
      }

      const readiness = page.locator("[data-matter-queue-row-readiness]");
      for (let i = 0; i < (await readiness.count()); i += 1) {
        await expectNoSurface(readiness.nth(i), `readiness #${i}`);
        // Readiness was 11.5px, and stays smaller than the status beside it.
        await expectSize(readiness.nth(i), "11.5px", `readiness #${i}`);
      }

      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/status-text/cases-list-statuses-${vp.name}-${dir}.png`,
      });
    });
  }
}

test("cases list: every lifecycle state resolves to its REQUIRED canonical ink", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCasesList(page);
  for (const status of CASE_STATUSES) {
    const el = page.locator(`[data-matter-queue-row-chip="status"][data-status="${status}"]`);
    await expect(el, `${status} did not render`).toHaveCount(1);
    const box = await boxOf(el);
    expect(box.color, `${status} resolves to the wrong ink`).toBe(REQUIRED_INK[status]);
  }
  // RESOLVED is not OPEN's green and ARCHIVED is not CLOSED's ink. These two
  // collapses are the specific defects the remapping fixes.
  expect(REQUIRED_INK.RESOLVED).not.toBe(REQUIRED_INK.OPEN);
  expect(REQUIRED_INK.ARCHIVED).not.toBe(REQUIRED_INK.CLOSED);
});
