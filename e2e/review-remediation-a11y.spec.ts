/**
 * REVIEW REMEDIATION — accessibility and layout of the Review surfaces, in a
 * real browser (2026-11-27).
 *
 *   1. Keyboard-only decision: Tab into the decision radio group, arrows and
 *      Space to choose, Tab to the rationale, type, Tab to submit, Enter — and
 *      the decision is read back from the DATABASE (as the acceptance spec
 *      does), so a page that merely looks right cannot pass.
 *   2. Dialog focus on the review page (Escalate, Pause, Request independent
 *      review, Reassign): initial focus on the first field, Tab / Shift+Tab
 *      stay inside, Escape closes, focus returns to the opener.
 *   3. Layout at desktop 1440, tablet 768, phone 390 AND at a 200 % browser
 *      zoom equivalent (see ZOOM_200 below): no horizontal overflow; nothing
 *      of the assistant launcher over any visible control of the page at five
 *      scroll positions (F-23); the Inbox view navigation is one control with
 *      no clipped label; the Review tool cards are whole-card links with a
 *      pointer, hover and a visible keyboard focus ring.
 *
 * Screenshots go to the test's output directory (testInfo.outputPath).
 *
 * Session, SQL and sign-in helpers follow e2e/review-remediation-acceptance.spec.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
  personalWorkspaceId,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

function apiDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, "services", "api");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not find the workspace root for services/api.");
}

/** A parameterised statement against the stack's disposable database (the e2e helpers' own pattern). */
function sql(query: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const script = `
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(${JSON.stringify(query)}, ${JSON.stringify(params)});
      process.stdout.write(JSON.stringify(r.rows));
      await c.end();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: apiDir(), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]");
}

async function signIn(page: Page, s: GuestSession): Promise<void> {
  await clearTestRateLimits();
  await answerCookieBanner(page);
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(s.email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

type Team = { owner: GuestSession; member: GuestSession; teamId: string };
let team: Team | null = null;

/** A Team-plan owner's Personal Workspace with one ACTIVE member. */
async function teamOfTwo(): Promise<Team> {
  const owner = await createGuestSession({ plan: "TEAM" });
  const member = await createGuestSession();
  const teamId = await personalWorkspaceId(owner.api);
  sql(
    `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'MEMBER', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [teamId, member.userId],
  );
  const switched = await member.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
  expect(switched.ok(), await switched.text()).toBe(true);
  return { owner, member, teamId };
}

/** A record in the workspace with a review workflow, assigned to `assignee` and started. */
async function startedReview(t: Team, assignee: GuestSession, title: string): Promise<{ workflowId: string; evidenceId: string }> {
  const ev = sql(
    `INSERT INTO evidence (type, owner_user_id, team_id, organization_id, status, title, updated_at)
     SELECT 'PHOTO', $1, t.id, t.organization_id, 'SIGNED', $3, now() FROM teams t WHERE t.id = $2 RETURNING id`,
    [t.owner.userId, t.teamId, title],
  );
  const evidenceId = String(ev[0]!.id);
  const wf = sql(
    `INSERT INTO evidence_review_workflows (evidence_id, team_id, workspace_type, status, updated_at)
     VALUES ($1, $2, 'TEAM', 'NOT_STARTED', now()) RETURNING id`,
    [evidenceId, t.teamId],
  );
  const workflowId = String(wf[0]!.id);
  const assigned = await t.owner.api.post(`/v1/reviewer-ops/reviews/${workflowId}/assign`, {
    data: { teamId: t.teamId, assignedToUserId: assignee.userId },
  });
  expect(assigned.status(), await assigned.text()).toBe(200);
  const started = await assignee.api.post(`/v1/reviewer-ops/reviews/${workflowId}/start`, { data: { teamId: t.teamId } });
  expect(started.status(), await started.text()).toBe(200);
  return { workflowId, evidenceId };
}

const statusOf = (workflowId: string) =>
  String(sql(`SELECT status FROM evidence_review_workflows WHERE id = $1`, [workflowId])[0]!.status);
const decisionRows = (workflowId: string) =>
  sql(
    `SELECT round, stage::text AS stage, decision::text AS decision, reviewer_user_id, rationale
       FROM workflow_review_decisions WHERE workflow_id = $1 ORDER BY decided_at`,
    [workflowId],
  );

// ---------------------------------------------------------------------------
// Viewports
// ---------------------------------------------------------------------------

type Layout = {
  label: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
};

/**
 * 200 % BROWSER ZOOM, EMULATED EXACTLY (WCAG 1.4.4 / 1.4.10).
 *
 * Chromium's browser zoom (Ctrl +) at 200 % on a 1280×800 window does two
 * things and only two things to the page: the layout viewport becomes
 * 1280/2 × 800/2 = 640×400 CSS px (so `window.innerWidth` is 640 and every
 * width media query evaluates against 640), and one CSS px is drawn with
 * 2 device px (`window.devicePixelRatio` becomes 2 on a 1× display).
 * A desktop (`isMobile: false`, so the viewport meta is ignored, as on a
 * desktop browser) context with a 640×400 CSS-px viewport and
 * `deviceScaleFactor: 2` reproduces both: Playwright applies it through
 * CDP `Emulation.setDeviceMetricsOverride({ width: 640, height: 400,
 * deviceScaleFactor: 2, mobile: false })`, and the screenshot is 1280×800
 * device px — the zoomed window. The test asserts innerWidth === 640 and
 * devicePixelRatio === 2 before measuring.
 *
 * Rejected alternatives: `Emulation.setPageScaleFactor` is PINCH zoom (the
 * layout viewport and media queries do not change); CSS `zoom` on <html>
 * leaves media queries and `innerWidth` at 1280; Ctrl+= is a browser-UI
 * shortcut that headless Chromium does not implement; a plain 640 px
 * viewport at DPR 1 is a narrow window, not zoom.
 */
const ZOOM_200: Layout = { label: "zoom200-equiv-1280x800", viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 };

const LAYOUTS: Layout[] = [
  { label: "desktop-1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { label: "tablet-768", viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1 },
  { label: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
  ZOOM_200,
];

async function contextFor(browser: Browser, testInfo: TestInfo, layout: Layout): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: layout.viewport,
    deviceScaleFactor: layout.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
  });
}

// ---------------------------------------------------------------------------
// Keyboard helpers
// ---------------------------------------------------------------------------

/** Press Tab (or Shift+Tab) until the focused element matches `selector`. */
async function tabUntil(page: Page, selector: string, max = 250, shift = false): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const hit = await page.evaluate((sel) => Boolean(document.activeElement?.matches(sel)), selector);
    if (hit) return;
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Tab never reached ${selector}`);
}

const focusedMatches = (page: Page, selector: string) =>
  page.evaluate((sel) => Boolean(document.activeElement?.matches(sel)), selector);
const focusedInside = (page: Page, selector: string) =>
  page.evaluate((sel) => Boolean(document.querySelector(sel)?.contains(document.activeElement)), selector);

// ---------------------------------------------------------------------------
// Geometry probes (run in the page)
// ---------------------------------------------------------------------------

type Probe = {
  innerWidth: number;
  dpr: number;
  docOverflowPx: number;
  launcherVisible: number;
  inlineEntryVisible: number;
  overlaps: string[];
};

/** Overflow + launcher overlap at the CURRENT scroll position. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const inView = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    // Everything the floating assistant draws while its panel is closed.
    const floaters = Array.from(document.querySelectorAll(".assistant-dock *")).filter(visible);
    const launcherVisible = Array.from(document.querySelectorAll(".assistant-launcher")).filter(visible).length;
    const controls = Array.from(
      document.querySelectorAll(
        "main a[href], main button, main input:not([type=hidden]), main textarea, main select, main [role=radio], main [role=combobox], main [role=tab], main [contenteditable=true]",
      ),
    ).filter((el) => visible(el) && !el.closest(".assistant-dock") && inView(el.getBoundingClientRect()));
    const overlaps: string[] = [];
    for (const f of floaters) {
      const a = f.getBoundingClientRect();
      for (const c of controls) {
        const b = c.getBoundingClientRect();
        if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) {
          overlaps.push(`${f.className || f.tagName} over ${(c.textContent || c.getAttribute("aria-label") || c.tagName).trim().slice(0, 40)}`);
        }
      }
    }
    return {
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      docOverflowPx: document.documentElement.scrollWidth - window.innerWidth,
      launcherVisible,
      inlineEntryVisible: Array.from(document.querySelectorAll("[data-assistant-inline-entry]")).filter(visible).length,
      overlaps,
    };
  });
}

/** Scroll every scroller of the page to `fraction` of its range. */
async function scrollTo(page: Page, fraction: number): Promise<void> {
  await page.evaluate((f) => {
    const scrollers: Element[] = [document.scrollingElement ?? document.documentElement];
    let el: Element | null = document.querySelector("main");
    while (el) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) scrollers.push(el);
      el = el.parentElement;
    }
    for (const s of scrollers) s.scrollTop = Math.round(f * (s.scrollHeight - s.clientHeight));
  }, fraction);
  await page.waitForTimeout(150);
}

/** The Inbox view navigation: ONE visible control, no clipped label. */
async function inboxViewNav(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const row = document.querySelector("[data-inbox-view-tabs]");
    const menu = document.querySelector("[data-inbox-view-menu]");
    const out = {
      rowVisible: shown(row),
      menuVisible: shown(menu),
      rowHiddenPx: 0,
      clipped: [] as string[],
      menuValueClipped: false,
    };
    if (row && out.rowVisible) {
      const nr = row.getBoundingClientRect();
      out.rowHiddenPx = (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth;
      for (const a of Array.from(row.querySelectorAll("a"))) {
        const r = a.getBoundingClientRect();
        const label = (a.textContent ?? "").trim();
        const inside = r.left >= nr.left - 0.5 && r.right <= nr.right + 0.5 && r.top >= nr.top - 0.5 && r.bottom <= nr.bottom + 0.5;
        const textCut = a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1;
        if (!inside || textCut) out.clipped.push(label);
      }
    }
    if (menu && out.menuVisible) {
      const value = menu.querySelector(".app-listbox__value-text") as HTMLElement | null;
      out.menuValueClipped = Boolean(value && value.scrollWidth > value.clientWidth + 1);
    }
    return out;
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
}

// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

test.beforeAll(async () => {
  await clearTestRateLimits();
  team = await teamOfTwo();
});

test.afterAll(async () => {
  if (team) for (const s of [team.owner, team.member]) await disposeSession(s);
  team = null;
});

test("1 — keyboard only: choose, write the rationale and record a decision; the database has it", async ({ page }, testInfo) => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "A11y — keyboard decision");
  await signIn(page, t.member);
  await page.goto(`/reviewer-ops/${workflowId}`);
  await expect(page.locator("[data-decision-form]")).toBeVisible({ timeout: 30_000 });
  await page.locator("body").focus();

  // Tab reaches the group: focus lands on the first ENABLED choice (no choice yet).
  await tabUntil(page, "[data-decision-choice]");
  const firstEnabled = await page.evaluate(
    () => (document.querySelector('[data-decision-choice-allowed="true"]') as HTMLElement | null)?.dataset.decisionChoice ?? null,
  );
  expect(await focusedMatches(page, `[data-decision-choice="${firstEnabled}"]`)).toBe(true);

  // Arrows move AND select; Left comes back; Space selects the focused one.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('[data-decision-choice][aria-checked="true"]')).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(`[data-decision-choice="${firstEnabled}"]`)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await expect(page.locator('[data-decision-choice="APPROVE"]')).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Tab");
  expect(await focusedMatches(page, "[data-decision-form-rationale]")).toBe(true);
  await page.keyboard.type("Keyboard-only decision: metadata and hash are consistent.");
  await page.keyboard.press("Tab"); // optional category
  expect(await focusedMatches(page, "[data-decision-form-reason]")).toBe(true);
  await page.keyboard.press("Tab");
  expect(await focusedMatches(page, "[data-decision-form-submit]")).toBe(true);
  await shot(page, testInfo, "keyboard-decision-before-submit");
  await page.keyboard.press("Enter");

  await expect.poll(() => statusOf(workflowId), { timeout: 20_000 }).toBe("APPROVED_INTERNAL");
  const rows = decisionRows(workflowId);
  expect(rows.map((r) => [r.round, r.stage, r.decision, r.reviewer_user_id])).toEqual([[0, "FIRST", "APPROVE", t.member.userId]]);
  await shot(page, testInfo, "keyboard-decision-after-submit");
});

test("2 — review page dialogs: initial focus, Tab contained, Escape closes, focus returns to the opener", async ({ page }, testInfo) => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "A11y — dialogs");
  await signIn(page, t.member);
  await page.goto(`/reviewer-ops/${workflowId}`);
  await expect(page.locator("[data-decision-form]")).toBeVisible({ timeout: 30_000 });

  const cases = [
    { opener: '[data-reviewer-action="escalate"]', dialog: '[data-matter-modal="reviewer-escalate"]', initial: "[data-reviewer-escalate-reason]" },
    { opener: '[data-reviewer-action="pause"]', dialog: '[data-matter-modal="reviewer-reason-pause"]', initial: "[data-reviewer-reason-modal] textarea" },
    {
      opener: '[data-reviewer-action="request_independent_review"]',
      dialog: '[data-matter-modal="reviewer-request-independent"]',
      initial: "[data-reviewer-request-independent-note]",
    },
    { opener: '[data-reviewer-action="reassign"]', dialog: '[data-matter-modal="reviewer-reassign"]', initial: "[data-reviewer-reassign-picker]" },
  ];
  const tested: string[] = [];
  for (const c of cases) {
    if ((await page.locator(`${c.opener}:visible`).count()) === 0) continue;
    await page.locator("body").focus();
    await tabUntil(page, c.opener);
    await page.keyboard.press("Enter");
    await expect(page.locator(c.dialog)).toBeVisible();
    await expect.poll(() => focusedMatches(page, c.initial), { timeout: 5_000 }).toBe(true);
    await shot(page, testInfo, `dialog-${c.dialog.replace(/\W+/g, "-")}-open`);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(await focusedInside(page, c.dialog), `Tab ${i + 1} left ${c.dialog}`).toBe(true);
    }
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusedInside(page, c.dialog), `Shift+Tab ${i + 1} left ${c.dialog}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(c.dialog)).toHaveCount(0);
    expect(await focusedMatches(page, c.opener), `focus back on ${c.opener}`).toBe(true);
    tested.push(c.opener);
  }
  testInfo.annotations.push({ type: "dialogs-tested", description: tested.join(", ") });
  expect(tested.length, "at least Escalate and Pause are offered to the assigned reviewer").toBeGreaterThanOrEqual(2);
});

for (const layout of LAYOUTS) {
  test(`3 — layout at ${layout.label}: no overflow, the assistant never covers a control, clear view navigation, clickable tools`, async ({ browser }, testInfo) => {
    const t = team!;
    const { workflowId } = await startedReview(t, t.owner, `A11y — layout ${layout.label}`);
    const context = await contextFor(browser, testInfo, layout);
    const page = await context.newPage();
    try {
      await signIn(page, t.owner);
      const pages: Array<{ name: string; path: string; ready: string }> = [
        { name: "inbox", path: "/review", ready: "[data-review-inbox]" },
        { name: "review", path: `/reviewer-ops/${workflowId}`, ready: "[data-decision-form], [data-review-page-header]" },
        { name: "settings", path: "/review/settings", ready: "[data-review-page-header]" },
        { name: "monitoring", path: "/reviewer-ops/sla", ready: "[data-review-page-header]" },
        { name: "external", path: "/review/external", ready: "[data-review-page-header]" },
        { name: "challenged", path: "/review/disagreements", ready: "[data-review-page-header]" },
      ];
      for (const p of pages) {
        await page.goto(p.path);
        await expect(page.locator(p.ready).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(300);
        const first = await probe(page);
        if (layout === ZOOM_200) {
          // The emulation IS 200 % zoom of a 1280×800 window (see ZOOM_200).
          expect(first.innerWidth).toBe(640);
          expect(first.dpr).toBe(2);
        }
        expect(first.docOverflowPx, `${p.name}: horizontal overflow`).toBeLessThanOrEqual(1);
        // F-23 — Review pages carry the inline entry and no floating launcher.
        expect(first.launcherVisible, `${p.name}: floating launcher`).toBe(0);
        expect(first.inlineEntryVisible, `${p.name}: inline assistant entry`).toBeGreaterThanOrEqual(1);
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
          await scrollTo(page, f);
          const at = await probe(page);
          expect(at.overlaps, `${p.name} at ${f * 100}% scroll`).toEqual([]);
          expect(at.docOverflowPx).toBeLessThanOrEqual(1);
          if (f === 0 || f === 1) await shot(page, testInfo, `${layout.label}-${p.name}-scroll${f * 100}`);
        }
        await scrollTo(page, 0);

        if (p.name === "inbox") {
          const nav = await inboxViewNav(page);
          // One control at a time: the row at ≥ 1024 CSS px, the menu below.
          expect(nav.rowVisible !== nav.menuVisible, "exactly one view control").toBe(true);
          expect(nav.rowVisible).toBe(layout.viewport.width >= 1024);
          expect(nav.rowHiddenPx).toBeLessThanOrEqual(0);
          expect(nav.clipped, "clipped view labels").toEqual([]);
          expect(nav.menuValueClipped).toBe(false);

          const cards = page.locator("[data-review-tool-link]");
          const count = await cards.count();
          testInfo.annotations.push({ type: `${layout.label}-tool-cards`, description: String(count) });
          for (let i = 0; i < count; i += 1) {
            const card = cards.nth(i);
            const geometry = await card.evaluate((a) => {
              const row = a.closest("[data-review-tool]")!.getBoundingClientRect();
              const r = a.getBoundingClientRect();
              return { cursor: getComputedStyle(a).cursor, coversRow: r.width >= row.width - 1 && r.height >= row.height - 1, href: a.getAttribute("href") };
            });
            expect(geometry.cursor).toBe("pointer");
            expect(geometry.coversRow, "the whole card is the link").toBe(true);
          }
          if (count > 0 && layout.label === "desktop-1440") {
            const card = cards.first();
            await card.scrollIntoViewIfNeeded();
            const before = await card.evaluate((a) => getComputedStyle(a).backgroundColor);
            await card.hover();
            await expect.poll(() => card.evaluate((a) => getComputedStyle(a).backgroundColor)).not.toBe(before);
            await page.mouse.move(0, 0);
            await page.locator("body").focus();
            await tabUntil(page, "[data-review-tool-link]");
            const ring = await page.evaluate(() => {
              const cs = getComputedStyle(document.activeElement as Element);
              return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
            });
            expect(ring.style).not.toBe("none");
            expect(ring.width).toBeGreaterThanOrEqual(2);
            await shot(page, testInfo, `${layout.label}-tool-card-focus`);
            const href = (await page.evaluate(() => (document.activeElement as HTMLAnchorElement).getAttribute("href")))!;
            await page.keyboard.press("Enter");
            await page.waitForURL((u) => u.pathname === href.split("?")[0], { timeout: 30_000 });
          }
        }
      }
    } finally {
      await context.close();
    }
  });
}
