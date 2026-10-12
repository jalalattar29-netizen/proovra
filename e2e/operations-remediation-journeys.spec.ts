/**
 * OPERATIONS REMEDIATION — EXECUTED BROWSER JOURNEYS (API + web, real
 * accounts, real database). Interception is used ONLY where a server failure
 * or a network race has to be forced; every other answer is the real API's.
 *
 *   A  PRO Personal: a report failure on a Personal record is remediated from
 *      Operations (202 QUEUED); a second click collapses onto the live work,
 *      and exactly ONE canonical output request exists.
 *   B  Acknowledging the only CRITICAL condition leaves Workspace Health
 *      CRITICAL.
 *   C  Five RESOLVED conditions under two sources: the all-time KPI says 5,
 *      "Resolved in the last 7 days" shows the two sources, and the default
 *      queue shows none of them.
 *   D  An unreadable summary renders as unavailable — never 0, never clear.
 *   E  Switching workspace while the previous workspace's reads are still in
 *      flight: the late answers never appear under the new workspace.
 *   F  A remediation answer that lands after the drawer moved to another
 *      condition is not attached to the new one.
 *   G  Enterprise roll-up: a workspace the admin cannot read makes coverage
 *      incomplete, and an unreadable one is "Unavailable", never 0.
 *   H  A denied switch into another tenant's workspace writes no condition
 *      there.
 *   I  Billing contradiction: the exact Billing link for the payer.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  SESSION_PASSWORD,
  clearTestRateLimits,
  createGuestSession,
  makeApi,
  provisionEnterpriseOrg,
  type GuestSession,
} from "./helpers/api-client";

test.describe.configure({ mode: "serial" });

const API_DIR = resolve(__dirname, "..", "services", "api");

/** One SQL statement against the stack's own disposable database. */
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
  const run = spawnSync(process.execPath, ["-e", script], { cwd: API_DIR, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]");
}

async function signIn(page: Page, email: string) {
  await clearTestRateLimits();
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
  const reject = page.getByRole("button", { name: "Reject all" });
  if (await reject.isVisible().catch(() => false)) await reject.click();
}

function personalSpaceOf(userId: string): string {
  const row = sql("SELECT id FROM teams WHERE owner_user_id = $1 AND is_personal = true", [userId])[0];
  expect(row, "the account has a Personal Space").toBeTruthy();
  return String(row!.id);
}

/**
 * A SIGNED Personal record stored with team_id NULL — the exact shape OPS-01
 * concerns — with no output request queued yet, so no worker run can race the
 * failure state this journey starts from.
 */
function seedSignedPersonalRecord(ownerUserId: string): string {
  const row = sql(
    `INSERT INTO evidence (type, owner_user_id, team_id, status, title, updated_at)
     VALUES ('PHOTO', $1, NULL, 'SIGNED', 'E2E ops remediation record', now()) RETURNING id`,
    [ownerUserId],
  );
  return String(row[0]!.id);
}

type Seed = {
  sourceId: string;
  category: string;
  severity?: string;
  status?: string;
  fingerprint?: string;
  title?: string;
  evidenceId?: string | null;
};

/** One condition, written as the canonical writers write it (scope WORKSPACE). */
function seedCondition(teamId: string, o: Seed): string {
  const row = sql(
    `INSERT INTO operational_incidents
       (team_id, scope, source_id, category, severity, status, fingerprint, title, safe_summary,
        related_evidence_id, resolved_at_utc, updated_at)
     VALUES ($1, 'WORKSPACE', $2, $3::"IncidentCategory", $4::"IncidentSeverity", $5::"IncidentStatus", $6, $7, $8,
             $9, CASE WHEN $5 = 'RESOLVED' THEN now() ELSE NULL END, now())
     RETURNING id`,
    [
      teamId,
      o.sourceId,
      o.category,
      o.severity ?? "HIGH",
      o.status ?? "OPEN",
      o.fingerprint ?? `e2e-ops-rem:${randomUUID()}`,
      o.title ?? `E2E condition ${randomUUID().slice(0, 8)}`,
      "E2E remediation journey",
      o.evidenceId ?? null,
    ],
  );
  return String(row[0]!.id);
}

async function openCondition(page: Page, id: string) {
  await page.goto(`/operations?incident=${encodeURIComponent(id)}`);
  await expect(page.locator("[data-ops-inspector]")).toBeVisible({ timeout: 30_000 });
}

test.describe("Operations remediation — executed browser journeys", () => {
  test("A. PRO Personal: remediation from Operations is accepted, and concurrent clicks are deduplicated", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    const reportCondition = (ev: string) =>
      seedCondition(space, {
        sourceId: "pipeline.report_generation_failed",
        category: "REPORT",
        fingerprint: `REPORT:${ev}:v1:UNCLASSIFIED`,
        evidenceId: ev,
      });

    // 1. The UI path: the drawer offers the canonical recovery and the API
    //    accepts it for a Personal record (team_id NULL).
    const ev = seedSignedPersonalRecord(s.userId);
    const id = reportCondition(ev);
    await signIn(page, s.email);
    await openCondition(page, id);
    const recover = page.locator('[data-ops-remediate="report.regenerate_artifacts"]');
    await expect(recover).toBeVisible();
    await recover.click();
    await page
      .locator('[data-confirm-action-modal="ops-remediate-confirm"]')
      .getByRole("button", { name: /Recover report or package/ })
      .click();
    await expect(page.locator('[data-ops-remediation-result="QUEUED"]')).toBeVisible({ timeout: 20_000 });
    expect(sql("SELECT count(*)::int AS n FROM report_generation_requests WHERE evidence_id = $1", [ev])[0]!.n).toBe(1);

    // 2. A double click is two requests in flight at once. Both reach the
    //    real API together; exactly one is queued, the other collapses onto
    //    it, and one canonical output request exists.
    const ev2 = seedSignedPersonalRecord(s.userId);
    const id2 = reportCondition(ev2);
    const api = await makeApi(s.token);
    const fire = () =>
      api.post(`/v1/ops/incidents/${id2}/remediate`, {
        data: { teamId: space, actionId: "report.regenerate_artifacts" },
      });
    const answers = await Promise.all([fire(), fire()]);
    const results = await Promise.all(
      answers.map(async (r) => ((await r.json()) as { remediation: { result: string } }).remediation.result),
    );
    await api.dispose();
    // The durable writer elects ONE request: both clicks are accepted onto it
    // (QUEUED / ALREADY_IN_PROGRESS), or — if a live worker already finished
    // the first attempt — the second is answered from that request's state.
    // Never a second request, never a failure.
    expect(results).toContain("QUEUED");
    for (const r of results) expect(["QUEUED", "ALREADY_IN_PROGRESS", "ALREADY_SATISFIED", "NOT_ELIGIBLE"]).toContain(r);
    expect(sql("SELECT count(*)::int AS n FROM report_generation_requests WHERE evidence_id = $1", [ev2])[0]!.n).toBe(1);
  });

  test("B. acknowledging the only CRITICAL condition leaves Workspace Health CRITICAL", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    const id = seedCondition(space, { sourceId: "review.escalation_storm", category: "GOVERNANCE", severity: "CRITICAL" });

    await signIn(page, s.email);
    await openCondition(page, id);
    await page.locator('[data-ops-action="acknowledge"]').click();
    await expect.poll(() => sql("SELECT status FROM operational_incidents WHERE id = $1", [id])[0]!.status).toBe("ACKNOWLEDGED");

    await page.goto("/operations/health");
    await expect(page.locator(".wsh__state[data-wsh-state]")).toHaveAttribute("data-wsh-state", "CRITICAL", { timeout: 30_000 });
  });

  test("C. five resolved conditions under two sources: 5 all-time, two recent groups, none in the default queue", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    for (let i = 0; i < 5; i++) {
      seedCondition(space, {
        sourceId: i < 3 ? "review.escalation_storm" : "identity.runtime_block",
        category: i < 3 ? "GOVERNANCE" : "IDENTITY_SECURITY",
        status: "RESOLVED",
        title: `E2E resolved ${i}`,
      });
    }
    await signIn(page, s.email);
    await page.goto("/operations");
    await expect(page.locator('[data-ops-metric="resolved"]')).toHaveAttribute("data-ops-metric-value", "5", { timeout: 30_000 });
    await expect(page.locator('[data-ops-metric="open"]')).toHaveAttribute("data-ops-metric-value", "0");
    const recent = page.locator('[data-ops-section="recently-resolved"]');
    await expect(recent.locator("[data-ops-group]")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-ops-section="action-required"] [data-ops-group]')).toHaveCount(0);
  });

  test("D. an unreadable summary renders as unavailable — never 0 and never clear", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    seedCondition(space, { sourceId: "review.escalation_storm", category: "GOVERNANCE", severity: "CRITICAL" });
    await signIn(page, s.email);
    // The server's own unavailable shape: counts null, complete false.
    await page.route("**/v1/ops/summary?**", async (route: Route) => {
      const real = await route.fetch();
      const body = (await real.json()) as { summary: Record<string, unknown> };
      for (const k of ["open", "critical", "high", "warning", "info", "acknowledged", "assignedToMe", "unassigned", "slaBreached", "slaAtRisk", "slaOnTrack", "slaUntracked", "resolved"]) {
        body.summary[k] = null;
      }
      Object.assign(body.summary, { complete: false, incompleteReason: "SOURCE_FAILED", mayAssertAllClear: false, groups: [] });
      await route.fulfill({ response: real, json: body });
    });
    await page.goto("/operations");
    await expect(page.locator("[data-ops-summary-state]")).toHaveAttribute("data-ops-summary-state", "unknown", { timeout: 30_000 });
    await expect(page.locator("[data-ops-summary-unavailable]")).toBeVisible();
    await expect(page.locator('[data-ops-metric-value="0"]')).toHaveCount(0);
  });

  test("E. late answers for the previous workspace never appear under the new one", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const personal = personalSpaceOf(s.userId);
    const org = provisionEnterpriseOrg(s, "E2E Ops Switch Org");
    const alpha = `ALPHA-${randomUUID().slice(0, 8)}`;
    const bravo = `BRAVO-${randomUUID().slice(0, 8)}`;
    seedCondition(personal, { sourceId: "review.escalation_storm", category: "GOVERNANCE", title: alpha });
    seedCondition(org.workspaceId, { sourceId: "review.escalation_storm", category: "GOVERNANCE", title: bravo });

    await signIn(page, s.email);
    const api = await makeApi(s.token);
    await api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: personal } });
    await api.dispose();
    await page.goto("/operations");
    await page.locator('[data-ops-view="flat"]').click();
    await expect(page.getByText(alpha).first()).toBeVisible({ timeout: 30_000 });

    // From now on the PERSONAL workspace's reads answer 6 seconds late.
    await page.route("**/v1/ops/**", async (route: Route) => {
      if (route.request().url().includes(personal)) await new Promise((r) => setTimeout(r, 6_000));
      await route.continue();
    });
    await page.reload();
    await page.locator('[data-ops-view="flat"]').click();
    await page.getByRole("button", { name: /Open workspace switcher/ }).click();
    await page.locator(`[data-context-option="${org.workspaceId}"]`).click();
    const proceed = page.locator("[data-context-switch-confirm-proceed]");
    if (await proceed.isVisible().catch(() => false)) await proceed.click();

    await page.locator('[data-ops-view="flat"]').click();
    await expect(page.getByText(bravo).first()).toBeVisible({ timeout: 30_000 });
    // Let every delayed personal answer land, then look again.
    await page.waitForTimeout(8_000);
    await expect(page.getByText(alpha)).toHaveCount(0);
    await expect(page.getByText(bravo).first()).toBeVisible();
  });

  test("F. a remediation answer that lands after the drawer moved is not attached to the new condition", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    const ev = seedSignedPersonalRecord(s.userId);
    const first = seedCondition(space, {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${ev}:v1:UNCLASSIFIED`,
      evidenceId: ev,
    });
    const second = seedCondition(space, { sourceId: "review.escalation_storm", category: "GOVERNANCE" });

    await signIn(page, s.email);
    await page.route("**/remediate", async (route: Route) => {
      await new Promise((r) => setTimeout(r, 5_000));
      await route.continue();
    });
    await openCondition(page, first);
    await page.locator('[data-ops-remediate="report.regenerate_artifacts"]').click();
    await page
      .locator('[data-confirm-action-modal="ops-remediate-confirm"]')
      .getByRole("button", { name: /Recover report or package/ })
      .click();
    // Move the drawer to another condition while the request is in flight.
    await page.goto(`/operations?incident=${second}`);
    await expect(page.locator("[data-ops-inspector]")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(7_000);
    await expect(page.locator("[data-ops-remediation-result]")).toHaveCount(0);
  });

  test("G. Enterprise roll-up: an unreadable workspace makes coverage incomplete and is never shown as 0", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const org = provisionEnterpriseOrg(s, "E2E Ops Rollup Org");
    seedCondition(org.workspaceId, { sourceId: "review.escalation_storm", category: "GOVERNANCE", severity: "CRITICAL" });
    // A second workspace in the organization that this admin is NOT a member of.
    const other = await createGuestSession({ plan: "FREE" });
    sql(
      `INSERT INTO teams (name, owner_user_id, organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ('E2E unreadable workspace', $1, $2, 'ORGANIZATION', 'ENTERPRISE', 'ACTIVE', now())`,
      [other.userId, org.organizationId],
    );
    await signIn(page, s.email);
    // The organization surfaces are the Enterprise workspace's: act from it.
    const switched = await page.request.post(`${process.env.API_BASE ?? "http://localhost:8081"}/v1/platform/context/switch-workspace`, {
      headers: { authorization: `Bearer ${s.token}` },
      data: { workspaceId: org.workspaceId },
    });
    expect(switched.status()).toBeLessThan(300);
    await page.goto(`/organizations/${org.organizationId}/admin/readiness`);
    const totals = page.locator("[data-rollup-totals]");
    await expect(totals).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-rollup-partial]")).toBeVisible();

    // An UNREADABLE summary for the readable workspace (forced): Unavailable, never 0.
    await page.route("**/v1/orgs/*/operations/rollup", async (route: Route) => {
      const real = await route.fetch();
      const body = (await real.json()) as {
        workspaces: Array<{ coverage: string; summary: Record<string, unknown> }>;
        coverage: Record<string, unknown>;
      };
      for (const w of body.workspaces) {
        w.coverage = "UNKNOWN";
        for (const k of ["open", "critical", "high", "warning", "info", "unassigned"]) w.summary[k] = null;
      }
      body.coverage.workspacesUnknown = body.workspaces.length;
      body.coverage.complete = false;
      await route.fulfill({ response: real, json: body });
    });
    await page.reload();
    const row = page.locator(`[data-rollup-workspace="${org.workspaceId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Unavailable/i);
    await expect(row).not.toContainText(/\b0 unresolved\b/);
  });

  test("H. a denied switch into another tenant's workspace writes no condition there", async () => {
    const owner = await createGuestSession({ plan: "PRO" });
    const org = provisionEnterpriseOrg(owner, "E2E Ops Target Org");
    const outsider = await createGuestSession({ plan: "FREE" });
    const before = sql("SELECT count(*)::int AS n FROM operational_incidents WHERE team_id = $1", [org.workspaceId])[0]!.n;
    const res = await outsider.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: org.workspaceId } });
    expect(res.status()).toBe(403);
    await new Promise((r) => setTimeout(r, 1_500));
    const after = sql("SELECT count(*)::int AS n FROM operational_incidents WHERE team_id = $1", [org.workspaceId])[0]!.n;
    expect(after).toBe(before);
  });

  test("I. a storage add-on billing contradiction links the payer to the exact Billing card", async ({ page }) => {
    const s = await createGuestSession({ plan: "PRO" });
    const space = personalSpaceOf(s.userId);
    const id = seedCondition(space, {
      sourceId: "billing.dependent_cancellation_failed",
      category: "STORAGE",
      fingerprint: `billing_dependent_cancellation:${randomUUID()}`,
    });
    await signIn(page, s.email);
    await openCondition(page, id);
    const link = page.locator("[data-ops-remediation-link]");
    await expect(link).toHaveAttribute("href", "/billing?workspace=personal#billing-action-required");
    // Operations never offers a Resolve for it: Billing truth closes it.
    await expect(page.locator('[data-ops-action="resolve"]')).toHaveCount(0);
  });
});
