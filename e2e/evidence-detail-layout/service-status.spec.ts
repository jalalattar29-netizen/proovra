/**
 * EVIDENCE DETAIL UNDER EVERY SERVICE STATE — in a real browser.
 *
 * The defect: a full-width "Runtime is in degraded mode … the data on this
 * page may be partial or stale" panel above healthy evidence, driven by a
 * platform readiness rollup. jsdom suites prove the component tree; this proves
 * the RENDERED page, with the production bundle and stylesheet:
 *
 *   * no platform diagnostic panel above the record, under any status;
 *   * a real generation incident is one line beside Regenerate in Artifacts,
 *     and the existing report download stays enabled;
 *   * the header carries the one global status control, silent when healthy;
 *   * a failed status read is "Status unavailable" in the header, never a
 *     warning on the record and never an all-clear;
 *   * navigating between tabs neither duplicates the notice nor re-polls;
 *   * the page recovers when the next poll succeeds;
 *   * no horizontal overflow at phone width with a notice showing.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

import { installApi } from "./_fixtures";

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const PANEL = /degraded mode|partial or stale|subsystem\(s\)|Failing subsystems/i;

const caps = (over: Record<string, string> = {}) => ({
  uploads: "HEALTHY",
  artifactGeneration: "HEALTHY",
  downloads: "HEALTHY",
  search: "HEALTHY",
  reviewAutomation: "HEALTHY",
  ...over,
});

type StatusAnswer = { status: number; body: unknown };

/** Installs the fixture API, then answers /v1/runtime/status from `next()`. */
async function serve(page: Page, next: () => StatusAnswer, context: "personal" | "organization" = "personal") {
  await installApi(page, context);
  const reads: string[] = [];
  // Registered after installApi, so it takes precedence for this path.
  await page.route("**/v1/runtime/status", async (route: Route) => {
    reads.push(new Date().toISOString());
    const a = next();
    await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  return reads;
}

async function openArtifacts(page: Page) {
  await page.goto(`/evidence/${EVIDENCE}`);
  await page.waitForSelector(".evidence-detail-hero");
  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.waitForSelector('[data-evidence-section="latest-artifacts"]');
}

test("healthy: no panel on the record, no notice in Artifacts, no header status control", async ({ page }) => {
  await serve(page, () => ({ status: 200, body: { status: "HEALTHY", capabilities: caps(), checkedAt: new Date().toISOString() } }));
  await openArtifacts(page);
  await page.waitForTimeout(1200);
  expect(await page.locator("body").innerText()).not.toMatch(PANEL);
  await expect(page.locator("[data-service-notice]")).toHaveCount(0);
  await expect(page.locator("[data-service-status-indicator]")).toHaveCount(0);
});

test("generation degraded: one line beside Regenerate, download stays enabled, header says 'Service issue'", async ({ page }) => {
  await serve(page, () => ({
    status: 200,
    body: { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED" }), checkedAt: new Date().toISOString() },
  }));
  await openArtifacts(page);
  const notice = page.locator('[data-service-notice="artifactGeneration"]');
  await expect(notice).toHaveCount(1, { timeout: 5000 });
  await expect(notice).toContainText("generation is delayed");
  await expect(notice).not.toContainText(/stale|corrupt|incomplete|partial/i);
  // Beside the control it affects.
  expect(await notice.evaluate((n) => Boolean(n.closest('[data-evidence-section="reports-ready-actions"]')))).toBe(true);
  // Nothing above the record.
  expect(await page.locator(".evidence-detail-shell").evaluate((s) => s.firstElementChild?.getAttribute("data-service-notice") ?? null)).toBeNull();
  expect(await page.locator("body").innerText()).not.toMatch(PANEL);
  // The existing report is still downloadable.
  await expect(page.locator('[data-evidence-artifact-download="report"]')).toBeEnabled();
  await expect(page.locator('[data-evidence-action="download-report"]')).toBeEnabled();
  // The one global control.
  const chip = page.locator("[data-service-status-indicator]");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-service-status-indicator", "ISSUE");
  await chip.getByRole("button").click();
  await expect(page.locator("[data-service-status-dropdown]")).toContainText("Report and package generation is delayed");
  // No admin destination offered to this user.
  const hrefs = await page.locator("[data-service-status-dropdown] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.filter((h) => h?.startsWith("/admin"))).toEqual([]);
});

test("tab navigation neither duplicates the notice nor re-polls the status", async ({ page }) => {
  const reads = await serve(page, () => ({
    status: 200,
    body: { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED" }) },
  }));
  await openArtifacts(page);
  await expect(page.locator('[data-service-notice="artifactGeneration"]')).toHaveCount(1, { timeout: 5000 });
  for (const tab of ["Overview", "Integrity", "Artifacts", "Custody", "Artifacts"]) {
    await page.getByRole("tab", { name: tab }).click();
  }
  await expect(page.locator('[data-service-notice="artifactGeneration"]')).toHaveCount(1);
  await expect(page.locator("[data-service-status-indicator]")).toHaveCount(1);
  expect(reads.length).toBe(1);
});

test("a failed status read: nothing on the record, 'Status unavailable' in the header — then recovery on the next poll", async ({ page }) => {
  await page.clock.install();
  let fail = true;
  await serve(page, () =>
    fail
      ? { status: 503, body: { message: "unavailable" } }
      : { status: 200, body: { status: "HEALTHY", capabilities: caps() } },
  );
  await openArtifacts(page);
  await page.clock.runFor(1_500);
  await expect(page.locator('[data-service-status-indicator="UNKNOWN"]')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator("[data-service-notice]")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(PANEL);
  // The service recovers; the next 60s poll clears the header control.
  fail = false;
  await page.clock.runFor(61_000);
  await expect(page.locator("[data-service-status-indicator]")).toHaveCount(0, { timeout: 5000 });
});

test("phone width with a notice showing: no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, () => ({
    status: 200,
    body: { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED", downloads: "UNAVAILABLE" }) },
  }));
  await openArtifacts(page);
  await expect(page.locator('[data-service-notice="downloads"]')).toHaveCount(1, { timeout: 5000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});

test("an organization member without operational access gets the service indicator, not a permanently pending operator pill", async ({ page }) => {
  await serve(
    page,
    () => ({ status: 200, body: { status: "DEGRADED", capabilities: caps({ search: "DEGRADED" }) } }),
    "organization",
  );
  await openArtifacts(page);
  await expect(page.locator("[data-service-status-indicator]")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator("[data-global-runtime-indicator]")).toHaveCount(0);
  // Search is unrelated to this record: nothing on the record.
  await expect(page.locator("[data-service-notice]")).toHaveCount(0);
});
