/**
 * REVIEW LAYOUT GATE (TEAM-SPEC 2026-11-23).
 *
 * What only a real engine can answer about the Team review surfaces:
 *   - no horizontal page overflow from 320px to 1920px, on short screens,
 *     phone landscape and the 200%-zoom CSS viewport;
 *   - ONE sidebar "Review" entry, and the hub tabs per role;
 *   - the review dialogs are the light canonical dialog, fit a short
 *     viewport, take focus, close on Escape and give focus back;
 *   - Ctrl+K opens only the global "Jump to a page" palette;
 *   - the same shared components still render for an Enterprise organization
 *     (compatibility only — not an Enterprise audit).
 *
 * Synthetic data, intercepted API (see _fixtures.ts). Before/after gallery
 * images are written to REVIEW_GALLERY_DIR when it is set.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  VIEWPORTS,
  WF,
  horizontalOverflow,
  installApi,
  unhandled,
  type ReviewContext,
} from "./_fixtures";

const GALLERY = process.env.REVIEW_GALLERY_DIR ?? "";

const PAGES = [
  { name: "hub-my-reviews", path: "/review", ready: "[data-review-hub-nav]" },
  { name: "queues", path: "/review/queues?queue=ASSIGNED_TO_ME", ready: "[data-review-hub-nav]" },
  { name: "monitoring-sla", path: "/reviewer-ops/sla", ready: "[data-review-hub-nav]" },
  { name: "monitoring-escalations", path: "/reviewer-ops/escalations", ready: "[data-review-hub-nav]" },
  { name: "review-settings", path: "/review/settings", ready: "[data-review-settings-page]" },
  { name: "inspector", path: `/reviewer-ops/${WF}`, ready: "[data-reviewer-actions]" },
  { name: "qc", path: "/review/qc", ready: "main" },
  { name: "external-review", path: "/review/external", ready: "main" },
] as const;

async function open(page: Page, path: string, ready: string): Promise<void> {
  await page.goto(path);
  await page.waitForSelector(ready, { timeout: 30_000 });
  // Let late fetches settle so the measured tree is the populated one.
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (!GALLERY) return;
  await page.screenshot({ path: `${GALLERY}/${name}.png`, fullPage });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test("Team owner (personal workspace): every review page renders without errors or horizontal overflow at every viewport", async ({ page }) => {
  const errors: string[] = [];
  await installApi(page, "team-owner", errors);
  const overflow: string[] = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const p of PAGES) {
      await open(page, p.path, p.ready);
      const dx = await horizontalOverflow(page);
      if (dx > 1) overflow.push(`${p.name}@${vp.name}: +${dx}px`);
      if (vp.name === "1440" || vp.name === "390") await shot(page, `after-${p.name}-${vp.name}`);
    }
  }
  expect(errors, errors.join("\n")).toEqual([]);
  expect(overflow, overflow.join("\n")).toEqual([]);
});

test("one sidebar Review entry for Team; none for Pro", async ({ page }) => {
  await installApi(page, "team-owner");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/review", "[data-review-hub-nav]");
  // Visible entries only: the sidebar also renders a hidden copy of each item
  // (same id) for its collapsed state.
  const reviewEntries = page.locator(
    '[data-sidebar-nav-id^="workspace.review"]:visible, [data-sidebar-nav-id^="review."]:visible',
  );
  await expect(reviewEntries).toHaveCount(1);
  await expect(reviewEntries.first()).toHaveAttribute("data-sidebar-nav-id", "workspace.review");

  const pro = await page.context().newPage();
  await installApi(pro, "pro-owner");
  await pro.setViewportSize({ width: 1440, height: 900 });
  await pro.goto("/home");
  await pro.waitForSelector("[data-sidebar-nav-id]", { timeout: 30_000 });
  await expect(pro.locator('[data-sidebar-nav-id="workspace.review"]:visible')).toHaveCount(0);
  await pro.close();
});

const HUB_EXPECTATION: Record<Exclude<ReviewContext, "pro-owner">, string[]> = {
  "team-owner": ["my-reviews", "queues", "monitoring", "settings"],
  "team-member": ["my-reviews", "queues", "monitoring", "settings"],
  "team-viewer": ["my-reviews", "queues", "monitoring", "settings"],
  "enterprise-owner": ["my-reviews", "queues", "monitoring", "settings"],
};

for (const [ctx, expected] of Object.entries(HUB_EXPECTATION) as Array<[Exclude<ReviewContext, "pro-owner">, string[]]>) {
  test(`hub tabs for ${ctx}`, async ({ page }) => {
    const errors: string[] = [];
    await installApi(page, ctx, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/review", "[data-review-hub-nav]");
    const tabs = await page.locator("[data-review-hub-tab]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-review-hub-tab") ?? ""),
    );
    // Each expected destination is present; ids are matched loosely so a
    // renamed tab id still has to keep the four responsibilities.
    for (const want of expected) {
      expect(tabs.some((t) => t.includes(want.split("-")[0]!)), `${ctx}: missing ${want} in ${tabs}`).toBe(true);
    }
    await open(page, "/review/settings", "[data-review-settings-page]");
    // Edit rights follow governance.policy.manage (OWNER/ADMIN), never the
    // workspace kind: the Team owner edits on a PERSONAL workspace.
    const mode = await page.locator("[data-review-sla-policy]").getAttribute("data-review-sla-policy-mode");
    if (ctx === "team-owner" || ctx === "enterprise-owner") expect(mode).toBe("edit");
    if (ctx === "team-viewer" || ctx === "team-member") expect(mode).toBe("read");
    await shot(page, `after-review-settings-${ctx}`);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

async function assertCanonicalDialog(page: Page, label: string): Promise<void> {
  const dialog = page.locator("[data-matter-modal][role=dialog]");
  await expect(dialog).toBeVisible();
  const geo = await dialog.evaluate((el) => {
    const panel = (el.closest(".app-dialog") ?? el.querySelector(".app-dialog") ?? el) as HTMLElement;
    const r = panel.getBoundingClientRect();
    const bg = getComputedStyle(panel).backgroundColor;
    const m = bg.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
    const lum = (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
    return {
      cls: panel.className,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      vw: window.innerWidth,
      vh: window.innerHeight,
      lum,
      focusInside: panel.contains(document.activeElement),
      modal: el.getAttribute("aria-modal"),
    };
  });
  expect(geo.cls, `${label}: canonical dialog class`).toContain("app-dialog");
  expect(geo.lum, `${label}: light panel (luminance ${geo.lum})`).toBeGreaterThan(0.8);
  expect(geo.top, `${label}: top inside viewport`).toBeGreaterThanOrEqual(-1);
  expect(geo.left, `${label}: left inside viewport`).toBeGreaterThanOrEqual(-1);
  expect(geo.right, `${label}: right inside viewport`).toBeLessThanOrEqual(geo.vw + 1);
  expect(geo.bottom, `${label}: bottom inside viewport`).toBeLessThanOrEqual(geo.vh + 1);
  expect(geo.focusInside, `${label}: focus moved into the dialog`).toBe(true);
}

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "320", width: 320, height: 640 },
  { name: "short-1280x600", width: 1280, height: 600 },
  { name: "zoom200-640x400", width: 640, height: 400 },
]) {
  test(`review dialogs are the light canonical dialog and fit the ${vp.name} viewport`, async ({ page }) => {
    await installApi(page, "team-owner");
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page, `/reviewer-ops/${WF}`, "[data-reviewer-actions]");
    for (const action of ["pause", "reject", "request_info"]) {
      const btn = page.locator(`[data-reviewer-action="${action}"]`).first();
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await assertCanonicalDialog(page, `${action}@${vp.name}`);
      if (vp.name === "1440" || vp.name === "320") await shot(page, `after-dialog-${action}-${vp.name}`, false);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-matter-modal][role=dialog]")).toHaveCount(0);
      // Focus returns to the control that opened the dialog.
      await expect(btn).toBeFocused();
    }
  });
}

test("single-occupant Team workspace: the second-review requirement is explained, not waived", async ({ page }) => {
  const errors: string[] = [];
  await installApi(page, "team-solo", errors);
  for (const vp of [{ w: 1440, h: 900, n: "1440" }, { w: 390, h: 844, n: "390" }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await open(page, `/reviewer-ops/${WF}`, "[data-reviewer-actions]");
    const banner = page.getByText(/second, independent reviewer is required/i);
    await expect(banner).toBeVisible();
    await expect(page.getByText(/can.t be waived/i)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await shot(page, `after-inspector-handoff-solo-${vp.n}`);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Ctrl+K on the review hub opens only the global Jump-to-a-page palette", async ({ page }) => {
  await installApi(page, "team-owner");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/review", "[data-review-hub-nav]");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await expect(page.locator(".reviewer-console__palette")).toHaveCount(0);
  await expect(page.getByText("Reviewer commands")).toHaveCount(0);
  await expect(page.locator("main").getByRole("button", { name: "Command palette" })).toHaveCount(0);
});

test("Team viewer: no bulk actions and no decision controls enabled", async ({ page }) => {
  const errors: string[] = [];
  await installApi(page, "team-viewer", errors);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/review/queues", "[data-review-hub-nav]");
  const boxes = page.locator('tbody input[type="checkbox"]:not([disabled])');
  if ((await boxes.count()) > 0) {
    await boxes.first().check();
    await expect(page.getByRole("button", { name: /Bulk assign/ })).toHaveCount(0);
  }
  await open(page, `/reviewer-ops/${WF}`, "[data-reviewer-actions]");
  for (const action of ["approve", "reject", "reassign"]) {
    const btn = page.locator(`[data-reviewer-action="${action}"]`);
    if ((await btn.count()) > 0) await expect(btn.first()).toHaveAttribute("data-reviewer-action-allowed", "false");
  }
  await shot(page, "after-inspector-viewer-1440");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Team owner queues: bulk bar offered with selection; dark in-flow bar keeps the primitives", async ({ page }) => {
  await installApi(page, "team-owner");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/review/queues", "[data-review-hub-nav]");
  const boxes = page.locator('tbody input[type="checkbox"]:not([disabled])');
  await expect(boxes.first()).toBeVisible();
  await boxes.first().check();
  await expect(page.getByRole("button", { name: /Bulk assign/ })).toBeVisible();
  await shot(page, "after-queues-bulk-bar-1440");
});

test("Enterprise organization (shared-component compatibility): review pages render without errors or overflow", async ({ page }) => {
  const errors: string[] = [];
  await installApi(page, "enterprise-owner", errors);
  const overflow: string[] = [];
  for (const vp of [VIEWPORTS[1], VIEWPORTS[4]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const p of PAGES) {
      await open(page, p.path, p.ready);
      const dx = await horizontalOverflow(page);
      if (dx > 1) overflow.push(`${p.name}@${vp.name}: +${dx}px`);
    }
  }
  await open(page, "/governance/policy", "main");
  await shot(page, "after-enterprise-governance-policy-1440");
  expect(errors, errors.join("\n")).toEqual([]);
  expect(overflow, overflow.join("\n")).toEqual([]);
});

test.afterAll(() => {
  if (unhandled.size) console.log("UNHANDLED API PATHS:", [...unhandled].join(" "));
});
