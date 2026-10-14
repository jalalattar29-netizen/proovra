/**
 * OPERATIONS — THE 2026-10-12 CONTRACT, IN A REAL ENGINE.
 *
 * The production build, an intercepted API (`_fixtures.ts`), and only the
 * properties the contract changed:
 *
 *   * (2026-10-14) the queue opens on lifecycle ALL in the flat list, and
 *     the grouped sections read the UNRESOLVED set they partition;
 *   * the KPI cards' predicate is UNRESOLVED (open, acknowledged or
 *     suppressed) and is SENT, for the list and the grouped read alike;
 *   * every KPI opens the list with the predicate that counted it — the
 *     "Resolved · all time" card opens status RESOLVED;
 *   * an unreadable summary renders Unavailable, never 0 or an all-clear, and
 *     starts no re-check; a bounded one renders "at least N";
 *   * a refused re-check says WHICH refusal it was, and offers "Try again"
 *     only when asking again can help;
 *   * Workspace Health renders UNKNOWN with its reason, never Healthy, and
 *     says when its alert list is capped;
 *   * a legacy `?incidentId=` link opens the drawer.
 *
 * Every expected sentence is READ from the shared dictionary.
 */
import { test, expect, type Page } from "@playwright/test";

import { fillOperationsCopy, operationsDict } from "../../packages/shared/src/i18n";
import {
  envelopeFor,
  installApi,
  observedOpsCalls,
  openOperations,
  showAllConditions,
  showGroupedQueue,
} from "./_fixtures";

const EN = operationsDict.en;

const listReads = () =>
  observedOpsCalls().filter((c) => c.method === "GET" && c.path.endsWith("/v1/ops/incidents") && c.query.includes("sort="));
const groupReads = () =>
  observedOpsCalls().filter(
    (c) => c.method === "GET" && c.path.endsWith("/v1/ops/incident-groups") && !c.query.includes("resolvedWithinDays"),
  );

test("the queue opens on EVERY lifecycle state; the grouped sections read the unresolved set they partition", async ({ page }) => {
  await openOperations(page, "team-admin");
  // The default presentation is the flat "All conditions" list, lifecycle ALL.
  await expect(page.locator('[data-ops-view="flat"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => listReads().length).toBeGreaterThan(0);
  expect(listReads().at(-1)!.query).toContain("status=ALL");
  // The address stays clean: the defaults are not written into the URL.
  expect(new URL(page.url()).searchParams.get("status")).toBeNull();
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  // The status control says "All" — no hidden unresolved filter — and the
  // Unresolved card says what it counts.
  await expect(page.locator("[data-ops-controls]")).toContainText(EN.statusAll);
  await expect(page.locator("[data-ops-controls]")).not.toContainText(EN.statusUnresolvedDefault);
  await showGroupedQueue(page);
  expect(new URL(page.url()).searchParams.get("view")).toBe("grouped");
  await expect.poll(() => groupReads().length).toBeGreaterThan(0);
  expect(groupReads().at(-1)!.query).toContain("status=UNRESOLVED");
  await expect(page.locator('[data-ops-metric="open"]')).toContainText(EN.metrics.open.note);
  // Resolved history is its OWN section, never mixed into the two above.
  const resolvedInActive = page.locator(
    '[data-ops-section="action-required"] [data-ops-group-status="RESOLVED"], [data-ops-section="monitoring"] [data-ops-group-status="RESOLVED"]',
  );
  await expect(resolvedInActive).toHaveCount(0);
});

test("the Resolved · all time card opens status RESOLVED; Critical opens UNRESOLVED + CRITICAL", async ({ page }) => {
  await openOperations(page, "team-admin");
  await showAllConditions(page);
  await page.locator('[data-ops-metric="resolved"]').click();
  await expect.poll(() => listReads().at(-1)?.query ?? "").toContain("status=RESOLVED");
  await expect(page.locator('[data-ops-metric="resolved"]')).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("status")).toBe("RESOLVED");

  await page.locator('[data-ops-metric="critical"]').click();
  await expect.poll(() => listReads().at(-1)?.query ?? "").toContain("severity=CRITICAL");
  expect(listReads().at(-1)!.query).toContain("status=UNRESOLVED");
});

test("an unreadable summary is Unavailable — no 0, no all-clear, no automatic re-check", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "unknown-summary" });
  await expect(page.locator("[data-ops-summary-unavailable]")).toHaveText(EN.metricsUnavailableNote);
  const values = await page.locator("[data-ops-metric]").evaluateAll((cards) =>
    cards.map((c) => c.getAttribute("data-ops-metric-value")),
  );
  expect(values.length).toBeGreaterThan(0);
  expect(values.every((v) => v === "—")).toBe(true);
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator('[data-ops-empty="preparing"]')).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(observedOpsCalls().filter((c) => c.method === "POST" && c.path.endsWith("/workspace-reconcile"))).toHaveLength(0);
});

test("a bounded summary reads 'at least N'", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "bounded-summary" });
  await expect(page.locator('[data-ops-metric="open"]')).toHaveAttribute(
    "data-ops-metric-value",
    fillOperationsCopy(EN.metricAtLeast, { n: "5,000" }),
  );
  await expect(page.locator("[data-ops-summary-floor]")).toHaveText(EN.metricsFloorNote);
});

async function pressRefresh(page: Page) {
  await page.locator("[data-ops-refresh]").click();
  await expect(page.locator("[data-ops-mutation-error]")).toBeVisible({ timeout: 15_000 });
}

test("a TEMPORARY re-check refusal says so and offers Try again", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "reconcile-temporary" });
  await pressRefresh(page);
  await expect(page.locator("[data-ops-mutation-error]")).toContainText(EN.errors.checkTemporary);
  await expect(page.locator("[data-ops-mutation-error]")).not.toContainText("data store");
  await expect(page.locator("[data-ops-mutation-retry]")).toBeVisible();
});

test("a schema mismatch shows the deployment copy and NO Try again", async ({ page }) => {
  await openOperations(page, "team-admin", { scenario: "reconcile-schema" });
  await pressRefresh(page);
  await expect(page.locator("[data-ops-mutation-error]")).toContainText(EN.errors.checkDeployment);
  await expect(page.locator("[data-ops-mutation-retry]")).toHaveCount(0);
});

async function openHealth(page: Page, scenario?: "health-unknown") {
  await openOperations(page, "team-admin", scenario ? { scenario } : {});
  // Workspace Health needs its own capability; grant it on this envelope only.
  await page.route("**/v1/platform/context", (route) => {
    const env = envelopeFor("team-admin") as { capabilities: Record<string, boolean> };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...env, capabilities: { ...env.capabilities, WORKSPACE_HEALTH_VIEW: true } }),
    });
  });
  await page.goto("/operations/health", { waitUntil: "domcontentloaded" });
}

test("Workspace Health renders UNKNOWN with its reason, never Healthy", async ({ page }) => {
  await openHealth(page, "health-unknown");
  await expect(page.locator("[data-wsh-state]")).toHaveAttribute("data-wsh-state", "UNKNOWN", { timeout: 30_000 });
  await expect(page.locator("[data-wsh-state-reason]")).toHaveText(EN.health.unknownReason.NEVER_RUN);
  await expect(page.locator("body")).not.toContainText(EN.health.state.HEALTHY);
  await expect(page.locator("[data-wsh-alerts-empty]")).toHaveText(EN.health.alertsEmptyUnconfirmed);
});

test("Workspace Health renders ATTENTION, canonical labels, and a capped alert list", async ({ page }) => {
  await openHealth(page);
  await expect(page.locator("[data-wsh-state]")).toHaveAttribute("data-wsh-state", "ATTENTION", { timeout: 30_000 });
  await expect(page.locator("body")).toContainText(EN.health.factUnresolved);
  await expect(page.locator("body")).toContainText(EN.health.factUntriaged);
  await expect(page.locator("[data-wsh-alerts-incomplete]")).toBeVisible();
});

test("a legacy ?incidentId= link opens the drawer and normalises the address", async ({ page }) => {
  const id = "55555555-5555-4555-8555-000000000001";
  // Not `openOperations`: it presses "All conditions", which the open drawer
  // (the very thing under test) correctly covers.
  await installApi(page, "team-admin", {});
  await page.goto(`/operations?incidentId=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(`[data-ops-inspector="${id}"]`)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("incident")).toBe(id);
  expect(new URL(page.url()).searchParams.get("incidentId")).toBeNull();
});
