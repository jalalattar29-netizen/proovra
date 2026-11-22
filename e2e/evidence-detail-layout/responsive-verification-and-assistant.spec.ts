/**
 * BROWSER REGRESSION — two responsive defects reported on 2026-11-22.
 *
 * 1. VERIFICATION & PRESERVATION. The Bitcoin anchoring cell's label collapsed
 *    into a column of single letters and its green "✓ Verified by PROOVRA
 *    against Bitcoin" state ran across the neighbouring cards. Cause: the cell
 *    head was a NON-WRAPPING flex row whose state was `flex: none`, so a long
 *    state kept its full width and squeezed the label (allowed to shrink to 0)
 *    down to its narrowest break; the state then overflowed the card. The grid
 *    also chose its column count from the VIEWPORT, not the width the card
 *    actually has beside the sidebar.
 *
 * 2. ASSISTANT PANEL. The panel's height cap ignored the application header:
 *    its top could rise to ~44px (desktop) or ~24px (phone) from the viewport
 *    top, inside the 72px sticky header band, which paints above the dock
 *    (header z-index 90 vs dock 50), so the close button sat under the header.
 *    The transcript's 8rem minimum could also push the composer out of a
 *    short panel.
 *
 * Geometry only exists in a real engine, so both are measured in Chromium
 * against the production bundle with the API intercepted (no network).
 */

import { expect, test, type Page } from "@playwright/test";

import { EVIDENCE_ID, installApi, makeWorkspace } from "./_fixtures";

type Viewport = { name: string; width: number; height: number };

const VIEWPORTS: Viewport[] = [
  { name: "320", width: 320, height: 720 },
  { name: "375", width: 375, height: 812 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  // A short desktop, a phone in landscape, and 200% browser zoom of a
  // 1280x900 window (the CSS viewport halves; layout is what zoom changes).
  { name: "short-desktop", width: 1280, height: 600 },
  { name: "mobile-landscape", width: 844, height: 390 },
  { name: "zoom-200", width: 640, height: 450 },
];

/** A long state, the way a translation or a future status could read. */
const LONG_STATE = "Verified by PROOVRA against Bitcoin main chain, confirmations recorded";

function withVerifiedAnchor(): unknown {
  const workspace = makeWorkspace() as Record<string, unknown>;
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const ots = record.ots as Record<string, unknown> | undefined;
    if (ots && typeof ots === "object" && "verification" in ots) {
      record.ots = {
        ...ots,
        verification: "CHAIN_VERIFIED",
        tone: "success",
        secondaryStatus: null,
        // The shape readOtsAnchoringView accepts as an independent main-chain
        // check (shared/ots-anchoring `readChainView`).
        chain: {
          status: "VERIFIED",
          failureCode: null,
          blockHeight: 812345,
          blockHash: null,
          blockTimeUtc: "2026-07-04T05:10:00.000Z",
          confirmations: 1450,
          minConfirmations: 6,
          checkedAtUtc: "2026-11-22T09:15:00.000Z",
          verifiedAtUtc: "2026-11-22T09:15:00.000Z",
          verifier: "fixture-node",
        },
      };
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(workspace);
  return workspace;
}

async function openIntegrity(page: Page, longState: boolean): Promise<void> {
  await installApi(page, "organization");
  // The shared fixture answers /me without the `user` wrapper, so the app sees
  // no session and never mounts the assistant. A signed-in user here.
  await page.route(/\/v1\/(users|auth)\/me(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "user-1", email: "reviewer@example.invalid", displayName: "Reviewer" } }),
    }),
  );
  const body = JSON.stringify(withVerifiedAnchor());
  // Registered after installApi, so it answers the workspace request first.
  await page.route("**/review-workspace**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body }),
  );
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=integrity`);
  await page.waitForSelector('[data-evidence-section="verification-preservation"] [data-evidence-matrix]', {
    timeout: 30_000,
  });
  await expect(
    page.locator('[data-evidence-matrix-row="Bitcoin anchoring"] .evidence-detail-matrix-cell__state'),
    "the fixture really renders the chain-verified state",
  ).toContainText("✓ Verified by PROOVRA against Bitcoin");
  if (longState) {
    // The label comes from the shared vocabulary; a longer translation or a
    // long timezone name is simulated in the rendered text the CSS lays out.
    await page.evaluate(
      ({ state, when }) => {
        const row = (name: string) =>
          document.querySelector(`[data-evidence-matrix-row="${name}"]`);
        const s = row("Bitcoin anchoring")?.querySelector(".evidence-detail-matrix-cell__state");
        if (s) s.textContent = `✓ ${state}`;
        const v = row("Bitcoin anchoring last updated")?.querySelector(".evidence-detail-matrix-cell__value");
        if (v) v.textContent = when;
      },
      {
        state: LONG_STATE,
        when: "Wednesday, 4 July 2026, 07:53:39 (Coordinated Universal Time · America/Argentina/ComodRivadavia)",
      },
    );
  }
}

async function measureMatrix(page: Page) {
  return page.evaluate(() => {
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-evidence-section="verification-preservation"] .evidence-detail-matrix-cell',
      ),
    );
    const inside = (inner: DOMRect, outer: DOMRect) =>
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1;
    const overlap = (a: DOMRect, b: DOMRect) =>
      !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
    const problems: string[] = [];
    let bitcoinFound = false;
    for (const cell of cells) {
      const name = cell.getAttribute("data-evidence-matrix-row") ?? "?";
      if (name === "Bitcoin anchoring") bitcoinFound = true;
      const label = cell.querySelector<HTMLElement>(".evidence-detail-matrix-cell__label");
      const state = cell.querySelector<HTMLElement>(".evidence-detail-matrix-cell__state");
      const value = cell.querySelector<HTMLElement>(".evidence-detail-matrix-cell__value");
      const cr = cell.getBoundingClientRect();
      if (cell.scrollWidth > cell.clientWidth + 1) problems.push(`${name}: cell overflows horizontally`);
      for (const [what, el] of [["label", label], ["state", state], ["value", value]] as const) {
        if (!el) continue;
        if (!inside(el.getBoundingClientRect(), cr)) problems.push(`${name}: ${what} leaves its card`);
      }
      if (label) {
        const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 1.4 * parseFloat(getComputedStyle(label).fontSize);
        const lines = Math.round(label.getBoundingClientRect().height / lineHeight);
        const words = (label.textContent ?? "").trim().split(/\s+/).length;
        if (lines > words) problems.push(`${name}: label wraps into ${lines} lines for ${words} words (letter column)`);
      }
      if (label && state && overlap(label.getBoundingClientRect(), state.getBoundingClientRect())) {
        problems.push(`${name}: label and state overlap`);
      }
    }
    return {
      cells: cells.length,
      bitcoinFound,
      problems,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

test.describe("Verification & Preservation — the matrix never collapses a label or spills a state", () => {
  for (const vp of VIEWPORTS) {
    for (const longState of [false, true]) {
      test(`${vp.name} · ${longState ? "long" : "standard"} verified state`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openIntegrity(page, longState);
        const m = await measureMatrix(page);
        expect(m.bitcoinFound, "the Bitcoin anchoring cell renders").toBe(true);
        expect(m.cells).toBeGreaterThan(5);
        expect(m.problems).toEqual([]);
        expect(m.pageOverflow, "no horizontal page overflow").toBeLessThanOrEqual(1);
      });
    }
  }

  test("1280 with the sidebar expanded narrows the content and the grid follows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openIntegrity(page, true);
    const rail = page.locator(".app-sidebar-v2").first();
    if (await rail.count()) await rail.hover();
    await page.waitForTimeout(400);
    const m = await measureMatrix(page);
    expect(m.problems).toEqual([]);
    expect(m.pageOverflow).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// THE ASSISTANT PANEL
// ---------------------------------------------------------------------------

const LONG_ANSWER =
  "Capture evidence from the Capture page: add files or record your screen, review the readiness list, then sign. " +
  "PROOVRA records the SHA-256 fingerprint, requests a trusted timestamp and anchors the record, and the report lists every step it could verify.";

async function openAssistant(page: Page) {
  await page.route("**/v1/ai/availability**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { available: true, decision: "ALLOWED", groundedAnswersAvailable: true } }),
    }),
  );
  await page.route("**/v1/ai/chat**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { status: "ok", summary: LONG_ANSWER, warnings: [], suggestions: ["Open Capture", "Read the verification guide"], flags: [], legalDisclaimer: "" },
      }),
    }),
  );
  await page.locator(".assistant-launcher").click();
  await page.waitForSelector("[data-assistant-panel]");
}

async function measurePanel(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-assistant-panel]")!;
    const close = panel.querySelector<HTMLElement>(".assistant-panel__close")!;
    const composer = panel.querySelector<HTMLElement>(".assistant-composer")!;
    const header = document.querySelector<HTMLElement>(".app-shell-v2-header-slot");
    const pr = panel.getBoundingClientRect();
    const cr = close.getBoundingClientRect();
    const kr = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
    const disclosure = panel.querySelector<HTMLElement>(".assistant-panel__disclosure");
    const dr = disclosure?.getBoundingClientRect();
    return {
      // The advisory disclosure is meaningful text: never under the composer.
      disclosureClear: !dr || (dr.top >= pr.top - 1 && dr.bottom <= kr.top + 1),
      vw: window.innerWidth,
      vh: window.innerHeight,
      panel: { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right },
      headerBottom: header ? header.getBoundingClientRect().bottom : 0,
      closeOnTop: Boolean(hit && (hit === close || close.contains(hit))),
      composerInside: kr.top >= pr.top - 1 && kr.bottom <= pr.bottom + 1 && kr.bottom <= window.innerHeight + 1,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function expectPanelFits(page: Page): Promise<void> {
  const m = await measurePanel(page);
  expect(m.panel.top, "panel stays below the application header").toBeGreaterThanOrEqual(m.headerBottom - 1);
  expect(m.panel.top).toBeGreaterThanOrEqual(-1);
  expect(m.panel.bottom).toBeLessThanOrEqual(m.vh + 1);
  expect(m.panel.left).toBeGreaterThanOrEqual(-1);
  expect(m.panel.right).toBeLessThanOrEqual(m.vw + 1);
  expect(m.closeOnTop, "the close button is the topmost element at its centre").toBe(true);
  expect(m.composerInside, "the composer is inside the panel and the viewport").toBe(true);
  expect(m.disclosureClear, "the advisory disclosure is fully visible above the composer").toBe(true);
  expect(m.pageOverflow, "no horizontal page overflow").toBeLessThanOrEqual(1);
}

test.describe("Assistant panel on Evidence Detail — bounds and an unobstructed close button", () => {
  // Evidence Detail is a sensitive route: the assistant shows its opening
  // questions AND the "off on this page" notice, its tallest empty state.
  for (const vp of VIEWPORTS) {
    test(`${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openIntegrity(page, false);
      await openAssistant(page);
      // Asking from a sensitive route shows the "off on this page" notice
      // beside the opening questions: the panel's tallest empty state.
      await page.locator(".assistant-suggestion").first().click();
      await expect(page.locator("[data-assistant-state]")).toBeVisible();
      await expectPanelFits(page);
      await page.locator(".assistant-panel__close").click();
      await expect(page.locator("[data-assistant-panel]")).toHaveCount(0);
    });
  }
});

test.describe("Assistant panel with a long conversation — fits, and the transcript scrolls", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // A route the assistant answers on (Evidence Detail is sensitive).
      await installApi(page, "organization");
      await page.route(/\/v1\/(users|auth)\/me(\?|$)/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: { id: "user-1", email: "reviewer@example.invalid", displayName: "Reviewer" } }),
        }),
      );
      await page.goto("/home");
      await page.waitForSelector(".assistant-launcher", { timeout: 30_000 });
      await openAssistant(page);

      const field = page.locator(".assistant-composer__field");
      for (let i = 0; i < 6; i += 1) {
        await expect(field).toBeEnabled();
        await field.fill(`Question ${i + 1}: how do I capture and verify evidence?`);
        await field.press("Enter");
        await expect(page.locator('.assistant-msg[data-role="assistant"]')).toHaveCount(i + 1);
      }

      await expectPanelFits(page);

      const log = await page.locator(".assistant-log").evaluate((el) => ({
        scrollable: el.scrollHeight > el.clientHeight + 1,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(log.overflowY).toBe("auto");
      expect(log.scrollable, "six long answers need the transcript to scroll").toBe(true);

      await page.locator(".assistant-panel__close").click();
      await expect(page.locator("[data-assistant-panel]")).toHaveCount(0);
    });
  }
});
