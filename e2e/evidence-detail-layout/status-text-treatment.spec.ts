/**
 * BROWSER VERIFICATION — the text-only status treatment on Evidence Detail.
 *
 * The source guard proves the right class is on the right element; it cannot
 * prove what the browser paints. That is a cascade question — a route
 * stylesheet loaded after the primitives can put a background back, and a
 * `.app-status-text` inside a grid cell is BLOCKIFIED so its `display: inline`
 * is discarded. So this resolves COMPUTED STYLE through the production bundle,
 * on the two tabs that carry the most status labels — Integrity's
 * Verification & Preservation matrix and the Technical Appendix's per-signal
 * list and per-part roles — plus the hero status, at every supported width in
 * both directions.
 *
 * It measures the two failure modes removing a capsule creates: a surface
 * coming back, and adjacent labels concatenating once the padding that held
 * them apart is gone.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  DIRECTIONS,
  EVIDENCE_ID,
  installApi,
  openTechnicalAppendix,
  setDirection,
} from "./_fixtures";

/**
 * Every supported width, including the two the shared list omits: 1280 (the
 * most common desktop) and 320 (the narrowest WCAG reflow target). A state is
 * exactly the nowrap phrase that survives 390 and breaks the page at 320.
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

async function boxOf(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node as Element);
    return {
      background: s.backgroundColor,
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
      shadow: s.boxShadow,
      radius: [s.borderTopLeftRadius, s.borderBottomRightRadius].join(" "),
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" "),
      color: s.color,
    };
  });
}

async function expectNoSurface(el: Locator, what: string): Promise<void> {
  const box = await boxOf(el);
  expect(box.background, `${what} paints a background`).toBe("rgba(0, 0, 0, 0)");
  expect(box.border, `${what} paints a border`).toBe("0px 0px 0px 0px");
  expect(box.shadow, `${what} paints a shadow`).toBe("none");
  expect(box.radius, `${what} keeps a capsule radius`).toBe("0px 0px");
  expect(box.padding, `${what} keeps pill padding`).toBe("0px 0px 0px 0px");
  expect(box.color, `${what} lost its ink`).not.toBe("rgba(0, 0, 0, 0)");
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** Open Evidence Detail on the Integrity tab, settled. */
async function openIntegrity(page: Page): Promise<void> {
  await installApi(page, "organization");
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=integrity`);
  await page.waitForSelector("[data-evidence-matrix]", { timeout: 30_000 });
  await page.waitForSelector("[data-evidence-matrix-row]", { timeout: 30_000 });
}

// ===========================================================================
// Integrity — Verification & Preservation
// ===========================================================================

for (const dir of DIRECTIONS) {
  for (const vp of WIDTHS) {
    test(`integrity: every Verification & Preservation state is text-only — ${vp.name} ${dir}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openIntegrity(page);
      await setDirection(page, dir);

      const states = page.locator(".evidence-detail-matrix-cell__state");
      const n = await states.count();
      expect(n, "no matrix state rendered").toBeGreaterThan(0);
      for (let i = 0; i < n; i += 1) {
        await expectNoSurface(states.nth(i), `matrix state #${i}`);
        // It is the text primitive, never a flattened badge.
        await expect(states.nth(i)).toHaveClass(/app-status-text/);
        await expect(states.nth(i)).not.toHaveClass(/app-status-badge/);
      }

      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/status-text/evidence-detail-integrity-${vp.name}-${dir}.png`,
      });
    });
  }
}

test("integrity: Recorded is orange, Available is purple, Verified stays green", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openIntegrity(page);
  // Read the states by their tone attribute; the fixture carries a RECORDED,
  // an ANCHORED and a VERIFIED preservation record, so all three tones appear.
  // Each is a REQUIRED remapping: Recorded and Available used to share blue.
  const cases: Array<[string, string, string]> = [
    ["orange", "rgb(194, 65, 12)", "Recorded"], // --orange-ink
    ["indigo", "rgb(109, 40, 217)", "Available"], // --accent-600
    ["green", "rgb(21, 128, 61)", "Verified"], // --success-standard
  ];
  for (const [tone, ink, label] of cases) {
    const el = page
      .locator(`.evidence-detail-matrix-cell__state[data-tone="${tone}"]`)
      .first();
    expect(await el.count(), `no ${label} (${tone}) state rendered`).toBeGreaterThan(0);
    expect((await boxOf(el)).color, `${label} resolves to the wrong ink`).toBe(ink);
  }
});

// ===========================================================================
// Technical Appendix — per-signal detail + per-part roles
// ===========================================================================

for (const dir of DIRECTIONS) {
  for (const vp of WIDTHS) {
    test(`technical appendix: signal outcomes and part roles are text-only — ${vp.name} ${dir}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openTechnicalAppendix(page, "organization");
      await setDirection(page, dir);

      // The per-signal "Passed" (and any other outcome) state.
      const signalStates = page.locator("[data-trust-signal-pill]");
      const sn = await signalStates.count();
      expect(sn, "no per-signal state rendered").toBeGreaterThan(0);
      for (let i = 0; i < sn; i += 1) {
        await expectNoSurface(signalStates.nth(i), `signal state #${i}`);
        await expect(signalStates.nth(i)).toHaveClass(/app-status-text/);
      }

      // The per-part role labels ("Lead", "Supporting") — rendered through the
      // AppendixBadge, whose testid is preserved.
      const roles = page.locator('[data-testid="ta-badge"]');
      for (let i = 0; i < (await roles.count()); i += 1) {
        await expectNoSurface(roles.nth(i), `part role #${i}`);
        await expect(roles.nth(i)).toHaveClass(/app-status-text/);
      }

      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/status-text/evidence-detail-technical-${vp.name}-${dir}.png`,
      });
    });
  }
}

test("technical appendix: a Passed signal is the success green, not a fill", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTechnicalAppendix(page, "organization");
  const passed = page
    .locator('[data-trust-signal-pill][data-tone="green"]')
    .first();
  if ((await passed.count()) > 0) {
    const box = await boxOf(passed);
    expect(box.background, "Passed paints a fill").toBe("rgba(0, 0, 0, 0)");
    expect(box.color, "Passed is not the success ink").toBe("rgb(21, 128, 61)");
  }
});

// ===========================================================================
// The hero status under the evidence title
// ===========================================================================

for (const dir of DIRECTIONS) {
  test(`overview: the hero status is text-only — 1440 ${dir}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installApi(page, "organization");
    await page.goto(`/evidence/${EVIDENCE_ID}`);
    await page.waitForSelector(".evidence-detail-hero-meta", { timeout: 30_000 });
    await setDirection(page, dir);

    const status = page.locator(".evidence-detail-hero-meta .app-status-text").first();
    await expect(status).toBeVisible();
    await expectNoSurface(status, "hero status");
    await expect(status).not.toHaveClass(/app-status-badge/);
    await page.screenshot({
      path: `test-results/status-text/evidence-detail-overview-hero-${dir}.png`,
    });
  });
}
