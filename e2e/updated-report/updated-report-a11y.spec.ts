/**
 * ARTIFACTS & VERSIONS — accessibility, responsive, RTL, colour-scheme and
 * reduced-motion proof, in a real browser on the real stack.
 *
 * axe-core is not a dependency of this repository (see
 * e2e/operations-layout/operations-a11y.spec.ts), so the checks are explicit
 * and structural: accessible names, ARIA wiring, keyboard-only operation, focus
 * trap and restoration, computed contrast, and layout geometry (no horizontal
 * scroll, no clipped action) at 320 px, tablet, desktop and the 125 % / 200 %
 * zoom-equivalent CSS widths (WCAG 1.4.10 reflow).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { openArtifacts, openUpdatedReportDialog, signIn } from "./_browser";
import { createFinalizedEvidence, personalTeamId, validateKeptTsaToken, waitForPair } from "./_stack";

test.describe.configure({ mode: "serial" });

const SHOTS = resolve(process.env.RGA_PROOF_DIR ?? join(require("node:os").tmpdir(), "pv-rga-proof"), "a11y");
mkdirSync(SHOTS, { recursive: true });

let A: GuestSession;
let evidenceId = "";

test.beforeAll(async () => {
  test.setTimeout(600_000);
  await clearTestRateLimits();
  A = await createGuestSession({ plan: "TEAM" });
  const teamId = await personalTeamId(A.api);
  evidenceId = (await createFinalizedEvidence(A.api, teamId, "a11y")).id;
  await waitForPair(A.api, evidenceId, 1);
  validateKeptTsaToken(evidenceId); // newer facts → the freshness notice renders
});

/** Geometry: no horizontal page scroll, every visible action fully on screen. */
async function assertReflow(page: Page) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scroll = document.documentElement.scrollWidth;
    const clipped: string[] = [];
    const scope = document.querySelectorAll(
      "[data-testid='artifact-truth-header'] button, [data-testid='matched-version-history'] button, [data-testid='output-progress'] button, [data-testid='updated-report-dialog'] button, [data-testid='updated-report-dialog'] textarea",
    );
    for (const el of Array.from(scope)) {
      const b = (el as HTMLElement).getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.left < -1 || b.right > vw + 1) clipped.push(`${(el as HTMLElement).innerText || el.getAttribute("aria-label") || el.tagName} [${Math.round(b.left)}..${Math.round(b.right)} of ${vw}]`);
    }
    return { vw, scroll, clipped };
  });
  expect(r.clipped, JSON.stringify(r)).toEqual([]);
  expect(r.scroll, JSON.stringify(r)).toBeLessThanOrEqual(r.vw + 1);
}

/** WCAG relative-luminance contrast of an element's text against its painted background. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return 0;
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    let bgEl: HTMLElement | null = el;
    let bg = [255, 255, 255, 0];
    while (bgEl) {
      const c = parse(getComputedStyle(bgEl).backgroundColor);
      if ((c[3] ?? 1) > 0.5) {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    const fg = parse(getComputedStyle(el).color);
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (l1! + 0.05) / (l2! + 0.05);
  }, selector);
}

test("keyboard only: reach the action, open the dialog, focus is trapped, Escape closes and focus returns", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, A.email);
  await openArtifacts(page, evidenceId);
  const action = page.getByTestId("evidence-new-version");
  await expect(action).toHaveAccessibleName("Generate updated report");
  await action.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("updated-report-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAccessibleName("Generate report v2");
  await expect(dialog.getByTestId("updated-report-reason")).toBeFocused();
  // Tab cycles inside the dialog only.
  const inside: boolean[] = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    inside.push(await page.evaluate(() => !!document.activeElement?.closest("[data-testid='updated-report-dialog']")));
  }
  expect(inside.every(Boolean)).toBe(true);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid='updated-report-dialog']"))).toBe(true);
  }
  // Invalid reason → described, invalid, announced.
  await dialog.getByTestId("updated-report-reason").focus();
  await page.keyboard.type("  ");
  await page.keyboard.press("Tab");
  const reason = dialog.getByTestId("updated-report-reason");
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  const describedBy = (await reason.getAttribute("aria-describedby")) ?? "";
  expect(describedBy.split(" ").length).toBe(2);
  await expect(page.locator(`#${describedBy.split(" ")[1]!.replace(/:/g, "\\:")}`)).toHaveAttribute("role", "alert");
  await expect(dialog.getByTestId("updated-report-confirm")).toBeDisabled();
  await page.screenshot({ path: join(SHOTS, "dialog-invalid-reason.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
});

test("names, roles and live regions: every control is named, no interactive control is nested in another", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, A.email);
  await openArtifacts(page, evidenceId);
  const report = await page.evaluate(() => {
    const roots = document.querySelectorAll("[data-testid='artifact-truth-header'], [data-testid='matched-version-history'], [data-testid='output-progress']");
    const unnamed: string[] = [];
    const nested: string[] = [];
    for (const root of Array.from(roots)) {
      for (const el of Array.from(root.querySelectorAll("button, a[href], textarea, input, select"))) {
        const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").trim();
        if (!name) unnamed.push(el.outerHTML.slice(0, 80));
        if (el.parentElement?.closest("button, a[href]")) nested.push(el.outerHTML.slice(0, 80));
      }
    }
    return { unnamed, nested };
  });
  expect(report).toEqual({ unnamed: [], nested: [] });
  await expect(page.getByTestId("truth-freshness")).toHaveAttribute("role", "status");
  await expect(page.locator("#rga-truth-title")).toHaveRole("heading");
  await expect(page.locator("#rga-truth-title")).toContainText("Report v1");
  await expect(page.getByRole("heading", { name: "Artifacts & Versions" })).toBeVisible();
  // Every artifact text meets WCAG AA (4.5:1) in the light theme.
  for (const sel of ["[data-testid='truth-tsa']", "[data-testid='truth-report-generated']", "[data-testid='pair-1-report'] .rga-pair__meta", ".rga-truth__fresh strong", ".rga-history__sub"]) {
    expect(await contrastOf(page, sel), sel).toBeGreaterThanOrEqual(4.5);
  }
});

for (const vp of [
  { name: "320px", width: 320, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
  // Browser zoom at a 1280 px window is the same CSS width (WCAG reflow).
  { name: "zoom-125", width: 1024, height: 900 },
  { name: "zoom-200", width: 640, height: 800 },
]) {
  test(`responsive ${vp.name}: no horizontal scroll, no clipped action, dialog fits`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await signIn(page, A.email);
    await openArtifacts(page, evidenceId);
    await assertReflow(page);
    await page.screenshot({ path: join(SHOTS, `artifacts-${vp.name}.png`), fullPage: true });
    const dialog = await openUpdatedReportDialog(page);
    await dialog.getByTestId("updated-report-reason").fill("Document the validated timestamp for the reviewer");
    await assertReflow(page);
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(vp.width);
    // The footer actions stay reachable (the body scrolls, not the actions).
    await expect(dialog.getByTestId("updated-report-confirm")).toBeInViewport();
    await page.screenshot({ path: join(SHOTS, `dialog-${vp.name}.png`) });
  });
}

test("long strings and RTL: content wraps, logical layout mirrors, nothing overflows", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, A.email);
  await openArtifacts(page, evidenceId);
  await page.evaluate(() => {
    document.documentElement.setAttribute("dir", "rtl");
    // Pseudo-localisation: every text node of the surface ~2.5× longer.
    const roots = document.querySelectorAll("[data-testid='artifact-truth-header'], [data-testid='matched-version-history']");
    for (const r of Array.from(roots)) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue && n.nodeValue.trim().length > 3) n.nodeValue = `${n.nodeValue} — ${n.nodeValue} ${n.nodeValue}`;
      }
    }
  });
  await assertReflow(page);
  const dir = await page.evaluate(() => {
    const header = document.querySelector("[data-testid='artifact-truth-header'] .rga-truth__head")!;
    const icon = header.querySelector(".rga-truth__icon")!.getBoundingClientRect();
    const copy = header.querySelector(".rga-truth__copy")!.getBoundingClientRect();
    return { iconIsRight: icon.left > copy.left };
  });
  expect(dir.iconIsRight).toBe(true);
  await page.screenshot({ path: join(SHOTS, "rtl-long-strings.png"), fullPage: true });
  const dialog = await openUpdatedReportDialog(page);
  await dialog.getByTestId("updated-report-reason").fill("سبب التقرير المحدث: توثيق الطابع الزمني الذي تم التحقق منه");
  await assertReflow(page);
  await page.screenshot({ path: join(SHOTS, "rtl-dialog.png") });
});

test("light-only contract and reduced motion: a dark OS preference changes nothing; no motion", async ({ page }) => {
  test.setTimeout(300_000);
  // PROOVRA is light-only. Advertising a dark preference is NOT dark-mode
  // support being tested: it proves the surfaces keep the approved light
  // tokens instead of rendering an unsupported half-dark interface.
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await signIn(page, A.email);
  await openArtifacts(page, evidenceId);
  const surfaces = ["[data-testid='artifact-truth-header']", "[data-testid='matched-version-history']"];
  const paint = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { surface: cs.getPropertyValue("--rga-surface").trim(), ink: cs.getPropertyValue("--rga-ink").trim(), bg: cs.backgroundColor };
    }, sel);
  const darkPref = await Promise.all(surfaces.map(paint));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const lightPref = await Promise.all(surfaces.map(paint));
  expect(darkPref).toEqual(lightPref);
  for (const p of darkPref) expect(p?.surface).toBe("#ffffff");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const sel of ["[data-testid='truth-tsa']", ".rga-truth__fresh strong"]) {
    expect(await contrastOf(page, sel), `light contract ${sel}`).toBeGreaterThanOrEqual(4.5);
  }
  const dialog = await openUpdatedReportDialog(page);
  expect(await contrastOf(page, "[data-testid='updated-report-dialog'] .rga-dialog__title"), "dialog title").toBeGreaterThanOrEqual(4.5);
  expect(await contrastOf(page, "[data-testid='updated-report-dialog'] .rga-dialog__lede"), "dialog lede").toBeGreaterThanOrEqual(4.5);
  const motion = await page.evaluate(() => getComputedStyle(document.querySelector(".rga-dialog-overlay")!).backdropFilter);
  expect(motion === "none" || motion === "").toBe(true);
  await page.screenshot({ path: join(SHOTS, "light-under-dark-preference.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
