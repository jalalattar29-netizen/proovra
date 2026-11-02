/**
 * Captures for the merged visual fixes and the invalid baseline pages, on the
 * company the journey built. Run after S01..S16 with ACCEPT_RESUME=1. The page is
 * scrolled to its end and back first, because reveal-on-scroll sections stay blank
 * in a full-page capture otherwise.
 *
 *   CAPTURE_DIR=<folder> ACCEPT_RESUME=1 npx playwright test --config e2e/acceptance/playwright.config.ts visual-capture
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { loadState, newProfile, switchWorkspace, type JourneyState } from "./lib/journey";

const s: JourneyState = loadState();
const OUT = process.env.CAPTURE_DIR ?? resolve(__dirname, "..", "..", ".p7tmp", "visual");
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

const name = (route: string, width: number) =>
  `${route.replace(/^\//, "").replace(/\[|\]/g, "").replace(/[^a-z0-9]+/gi, "-") || "root"}__${width}.jpg`;

/** Walk the page so reveal-on-scroll content renders, then return to the top. */
export async function walk(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.7));
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
}

async function capture(page: Page, label: string, url: string, width: number): Promise<void> {
  await page.goto("about:blank"); // A hash-only change would not remount the page.
  await page.goto(url);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  await walk(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`${label} @${width} final=${new URL(page.url()).pathname} overflowX=${overflow}`);
  // html and body clip overflow, so a full-page image wider than the viewport would show nothing a person sees.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: resolve(OUT, name(label, width)), fullPage: true, clip: { x: 0, y: 0, width, height }, type: "jpeg", quality: 72 });
}

async function asPerson(browser: Browser, key: string, width: number, height: number) {
  const { context, page } = await newProfile(browser, s.people[key]);
  await page.setViewportSize({ width, height });
  await page.goto("/home");
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await switchWorkspace(page, "Claims Investigations");
  return { context, page };
}

const DESKTOP: Array<[string, string?]> = [
  ["/operations/batch-analysis"], ["/operations/quotas"], ["/workspaces"], ["/governance"], ["/cases"],
  ["/cases/[id]", `/cases/${s.facts.caseId}`], ["/security-center"], ["/governance/lifecycle"],
];
const ORG_TABS = ["", "overview", "members", "roles", "departments", "governance", "governance/external-reviewers", "retention", "audit", "bulk-invite", "reports", "readiness", "security", "domains", "trust", "billing", "integrations", "access-reviews"];
const MOBILE = ["/evidence", "/home", "/investigation", "/investigation/timeline", "/pricing", "/legal/data-retention", "/security-center/identity/sessions"];

test("desktop 1440", async ({ browser }) => {
  const a = await asPerson(browser, "admin", 1440, 900);
  for (const [label, url] of DESKTOP) await capture(a.page, label, url ?? label, 1440);
  await a.context.close();
  const o = await asPerson(browser, "owner", 1440, 900);
  for (const tab of ORG_TABS) {
    await capture(o.page, `/organizations/[id]/admin${tab ? `/${tab}` : ""}`, `/organizations/${s.orgId}/admin${tab ? `/${tab}` : ""}`, 1440);
  }
  for (const step of ["company", "invite", "billing", "security", "retention", "legalHolds", "finish"]) {
    await capture(o.page, `/organizations/[id]/setup-${step}`, `/organizations/${s.orgId}/setup#${step}`, 1440);
  }
  await o.context.close();
});

test("mobile 390", async ({ browser }) => {
  const a = await asPerson(browser, "analyst", 390, 844);
  for (const route of MOBILE) await capture(a.page, route, route, 390);
  await a.page.goto("/home");
  await a.page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await a.page.screenshot({ path: resolve(OUT, "header-assistant-closed__390.jpg"), type: "jpeg", quality: 72 });
  await a.page.getByRole("button", { name: "Open assistant" }).click();
  await a.page.waitForTimeout(900);
  await a.page.screenshot({ path: resolve(OUT, "assistant-open__390.jpg"), type: "jpeg", quality: 72 });
  await a.context.close();
  const o = await asPerson(browser, "owner", 390, 844);
  await capture(o.page, "/security-center/identity/sessions", "/security-center/identity/sessions", 390);
  await o.context.close();
});

test("keyboard opens a listbox and the focus ring shows", async ({ browser }) => {
  const o = await asPerson(browser, "owner", 1440, 900);
  await o.page.goto(`/organizations/${s.orgId}/setup#security`);
  const trigger = o.page.locator('[data-input="mfa-level"]');
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await o.page.screenshot({ path: resolve(OUT, "listbox-trigger-focus__1440.jpg"), type: "jpeg", quality: 80 });
  await o.page.keyboard.press("Enter");
  await o.page.waitForTimeout(300);
  await expect(o.page.getByRole("option").first()).toBeVisible();
  await o.page.keyboard.press("ArrowDown");
  const style = await o.page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const c = getComputedStyle(e);
    return { tag: e.tagName, role: e.getAttribute("role"), outline: `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor}`, boxShadow: c.boxShadow };
  });
  console.log("listbox focus", JSON.stringify(style));
  await o.page.screenshot({ path: resolve(OUT, "listbox-keyboard-focus__1440.jpg"), type: "jpeg", quality: 80 });
  await o.context.close();
});

const PUBLIC = [
  "/", "/for-government", "/for-insurance", "/for-investigations", "/platform", "/why-proovra", "/technology",
  "/for-lawyers", "/for-journalism", "/for-compliance", "/trust", "/about", "/verify", "/verify/demo",
  "/audit-transparency", "/trust-center/ai-disclosure", "/trust-center/status",
];
const SIGNED_IN = [
  "/investigation/relationships", "/review/queues", "/operations", "/people", "/step-up/idp", "/step-up/passkey",
  "/intelligence", "/redaction/policy", "/reviewer-ops/escalations", "/security-center/sso", "/security-center/identity/scim",
];

test("recapture the pages whose baseline images were invalid", async ({ browser }) => {
  const RE = resolve(OUT, "recapture");
  mkdirSync(RE, { recursive: true });
  const shoot = async (page: Page, label: string, url: string, width: number) => {
    await page.goto("about:blank");
    await page.goto(url);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    await walk(page);
    await page.waitForTimeout(400);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`recapture ${label} @${width} final=${new URL(page.url()).pathname} h=${height}`);
    await page.screenshot({ path: resolve(RE, name(label, width)), fullPage: true, clip: { x: 0, y: 0, width, height }, type: "jpeg", quality: 70 });
  };
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const anon = await newProfile(browser);
    await anon.page.setViewportSize({ width, height });
    for (const route of PUBLIC) await shoot(anon.page, route, route, width);
    await anon.context.close();
  }
  const o = await asPerson(browser, "owner", 1440, 900);
  for (const route of SIGNED_IN) await shoot(o.page, route, route, 1440);
  await shoot(o.page, "/organizations/[id]", `/organizations/${s.orgId}`, 1440);
  await shoot(o.page, "/teams/[id]", `/teams/${s.workspaceId ?? ""}`, 1440);
  await o.context.close();
  const a = await asPerson(browser, "admin", 1440, 900);
  await shoot(a.page, "/evidence/[id]", `/evidence/${s.facts.evidenceId}`, 1440);
  await a.context.close();
});
