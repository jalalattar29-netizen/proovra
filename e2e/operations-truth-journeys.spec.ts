/**
 * OPERATIONS TRUTH — EXECUTED JOURNEYS (API + worker + MinIO + web), nothing mocked.
 *
 * Journey A — a report fails for real, and Operations carries it to recovery.
 *
 *   1. A PRO record is created through the product. Its report job runs in
 *      the real worker and fails for a real reason: the storage it reads and
 *      writes is down until every automatic retry is spent.
 *   2. When the durable budget is spent, ONE condition is raised in the record
 *      owner's workspace, keyed by the report version it was producing and a
 *      closed error class (never the raw message), naming the record.
 *   3. Storage comes back. In the browser, Operations opens that condition
 *      from its deep link. The drawer names the exact record, links to its
 *      Artifacts tab, and offers ONE action: the audited supersession, since
 *      a plain recovery would collapse onto the exhausted terminal.
 *   4. The click goes through the API, which accepts it (202) and queues
 *      durable work. The worker builds the report; its object is read back
 *      from storage through the product's signed URL.
 *   5. Refresh asks for a new check of the sources. The condition closes
 *      because the report at that version now exists, and not before. The
 *      page shows it under Recently resolved without a reload, and the
 *      condition's history reads opened → recovery requested → resolved.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import {
  SESSION_PASSWORD,
  clearTestRateLimits,
  createGuestSession,
  makeApi,
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
  // The consent banner sits over the bottom-right of every page on a first
  // visit. Answer it the privacy-preserving way so it covers nothing.
  const reject = page.getByRole("button", { name: "Reject all" });
  if (await reject.isVisible().catch(() => false)) await reject.click();
}

/** The account's Personal Space: the workspace a Personal record and its payer conditions live in. */
function personalSpaceOf(userId: string): string {
  const row = sql("SELECT id FROM teams WHERE owner_user_id = $1 AND is_personal = true", [userId])[0];
  expect(row, "the account has a Personal Space").toBeTruthy();
  return String(row!.id);
}

/** A real record, through the product's own create → upload → complete path. */
async function createRecord(s: GuestSession, label: string): Promise<string> {
  const bytes = `${label} ${Date.now()}\n`;
  const sha = createHash("sha256").update(bytes).digest("base64");
  const md5 = createHash("md5").update(bytes).digest("base64");
  const created = await s.api.post("/v1/evidence", {
    data: { type: "PHOTO", mimeType: "text/plain", originalFileName: "note.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { id: string }).id;
  const partRes = await s.api.post(`/v1/evidence/${id}/parts`, {
    data: { partIndex: 0, mimeType: "text/plain", originalFileName: "note.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
  });
  expect(partRes.ok(), await partRes.text()).toBe(true);
  const part = (await partRes.json()) as { upload: { putUrl: string } };
  const put = await fetch(part.upload.putUrl, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "text/plain", "x-amz-checksum-sha256": sha, "Content-MD5": md5 },
  });
  expect(put.ok, `PUT ${put.status}`).toBe(true);
  const done = await s.api.post(`/v1/evidence/${id}/complete`, { data: {} });
  expect(done.ok(), await done.text()).toBe(true);
  return id;
}

/** The signed URL the product hands out, followed to the stored object. */
async function download(token: string, path: string): Promise<Buffer> {
  const api = await makeApi(token);
  const res = await api.get(path);
  expect(res.status(), await res.text()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  await api.dispose();
  const file = await fetch(url);
  expect(file.ok, `GET stored object ${file.status}`).toBe(true);
  return Buffer.from(await file.arrayBuffer());
}

/**
 * THE STORAGE THE STACK RUNS ON, taken down and brought back. `minio` is the
 * container `playwright-e2e.yml` starts; a local stack names its own.
 */
const MINIO_CONTAINER = process.env.E2E_MINIO_CONTAINER ?? "minio";
function storage(verb: "kill" | "start") {
  const run = spawnSync("docker", [verb, MINIO_CONTAINER], { encoding: "utf8", timeout: 120_000 });
  if (run.status !== 0) throw new Error(`docker ${verb} ${MINIO_CONTAINER}: ${run.error?.message ?? run.stderr}`);
}
async function storageBack() {
  storage("start");
  const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
  await expect
    .poll(async () => (await fetch(`${endpoint}/minio/health/live`).catch(() => null))?.ok ?? false, { timeout: 60_000 })
    .toBe(true);
}

test.describe("Journey A — report failure to recovery, through Operations", () => {
  let A: GuestSession;
  let evidenceId = "";
  let incidentId = "";
  let workspaceId = "";

  test.afterAll(async () => {
    // Never leave the stack without storage for the next spec.
    await storageBack();
  });

  test("a real report job fails in the worker and raises one exact condition", async () => {
    // The durable budget is 12 claims across lifecycle-recovery ticks; the
    // stack runs that tick every 20s (playwright-e2e.yml), so exhaustion is
    // minutes, not the production 5-minute cadence times twelve.
    test.setTimeout(720_000);
    await clearTestRateLimits();
    A = await createGuestSession({ plan: "PRO" });

    evidenceId = await createRecord(A, "operations journey A");
    // The record is complete and its report job is queued; the storage it
    // must read and write goes away until the retries are spent.
    storage("kill");

    // The worker's own durable answer: terminal, for the closed reason.
    await expect
      .poll(
        () =>
          sql(
            "SELECT state, terminal_reason_code FROM report_generation_requests WHERE evidence_id = $1 AND artifact_type = 'REPORT' ORDER BY created_at_utc DESC LIMIT 1",
            [evidenceId],
          )[0] ?? null,
        { timeout: 600_000, intervals: [3000] },
      )
      .toMatchObject({ state: "FAILED_TERMINAL", terminal_reason_code: "retry_budget_exhausted" });
    await storageBack();

    await expect
      .poll(
        () =>
          sql(
            "SELECT id, team_id, scope, status, fingerprint, title, safe_summary, source_id FROM operational_incidents WHERE related_evidence_id = $1",
            [evidenceId],
          ),
        { timeout: 60_000, intervals: [1000] },
      )
      .toHaveLength(1);
    const row = sql(
      "SELECT id, team_id, scope, status, fingerprint, title, safe_summary, source_id FROM operational_incidents WHERE related_evidence_id = $1",
      [evidenceId],
    )[0]!;
    incidentId = String(row.id);
    workspaceId = String(row.team_id);
    // In the owner's workspace, not unscoped; keyed by version and a closed class.
    expect(row).toMatchObject({ scope: "WORKSPACE", status: "OPEN", source_id: "pipeline.report_generation_failed" });
    expect(String(row.fingerprint)).toBe(`REPORT:${evidenceId}:v1:RETRY_BUDGET_EXHAUSTED`);
    expect(String(row.title)).toBe(`Report v1 stopped after its retry budget was exhausted — record ${evidenceId.slice(0, 8)}`);
    expect(String(row.safe_summary)).not.toMatch(/arn:|bucket|stack|at \w+ \(/i);
    const member = sql(
      "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2",
      [workspaceId, A.userId],
    );
    expect(member, "the condition lands in a workspace the owner belongs to").toHaveLength(1);
    expect(sql("SELECT count(*)::int AS n FROM reports WHERE evidence_id = $1", [evidenceId])[0]!.n).toBe(0);
  });

  test("Operations offers the canonical recovery; the worker builds the report; the condition resolves in the page", async ({ page }) => {
    test.setTimeout(480_000);
    await signIn(page, A.email);

    await page.goto(`/operations?incident=${incidentId}`);
    const drawer = page.locator(`[data-ops-inspector="${incidentId}"]`);
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(drawer).toContainText(`Report v1 stopped after its retry budget was exhausted — record ${evidenceId.slice(0, 8)}`);
    // The affected resource is the exact record, and it opens that record.
    const affected = drawer.locator("[data-ops-affected-link]");
    await expect(affected).toHaveText(`Evidence record ${evidenceId.slice(0, 8)}`);
    await expect(affected).toHaveAttribute("href", `/evidence/${evidenceId}`);
    await expect(drawer.locator("[data-ops-status]")).toHaveAttribute("data-ops-status", "OPEN");

    // The exact record, on the tab that owns the fix.
    const link = drawer.locator("[data-ops-remediation-link]");
    await expect(link).toHaveAttribute("href", `/evidence/${evidenceId}?tab=artifacts`);

    // ONE canonical action. The durable budget is spent, so a plain recovery
    // would collapse onto the terminal and do nothing: only the audited
    // supersession is offered.
    const actions = drawer.locator("[data-ops-remediate]");
    await expect(actions.first()).toBeVisible();
    const offered = await actions.evaluateAll((els) => els.map((e) => e.getAttribute("data-ops-remediate")));
    expect(offered).toEqual(["report.supersede_failed_generation"]);
    const actionId = "report.supersede_failed_generation";
    const reasonBox = drawer.locator(`[data-ops-remediate-reason="${actionId}"]`);
    const reason = "storage outage over";
    if (await reasonBox.count()) await reasonBox.fill(reason);

    const before = sql("SELECT count(*)::int AS n FROM report_generation_requests WHERE evidence_id = $1", [evidenceId])[0]!.n as number;
    await drawer.locator(`[data-ops-remediate="${actionId}"]`).click();
    const confirm = page.locator('[data-confirm-action-modal="ops-remediate-confirm"]');
    await expect(confirm).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/v1/ops/incidents/${incidentId}/remediate`) && r.request().method() === "POST"),
      confirm.getByRole("button", { name: "Retry after exhausted failure" }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(202);
    await expect(drawer.locator("[data-ops-remediation-result]")).toHaveAttribute("data-ops-remediation-result", "QUEUED");

    // Durable work exists for this record, and the worker completes it.
    await expect
      .poll(() => sql("SELECT count(*)::int AS n FROM report_generation_requests WHERE evidence_id = $1", [evidenceId])[0]!.n, {
        timeout: 30_000,
      })
      .toBeGreaterThan(before);
    await expect
      .poll(() => sql("SELECT version FROM reports WHERE evidence_id = $1 ORDER BY version", [evidenceId]).map((r) => r.version), {
        timeout: 240_000,
        intervals: [2000],
      })
      .toEqual([1]);
    const pdf = await download(A.token, `/v1/evidence/${evidenceId}/report/latest`);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Until the source is checked again the condition is still open: a
    // queued job is not recovery.
    expect(sql("SELECT status FROM operational_incidents WHERE id = $1", [incidentId])[0]!.status).not.toBe("RESOLVED");

    // The drawer is modal: Escape closes it, and only then is the page's own
    // "Check again" reachable.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.locator("[data-ops-refresh]").click();
    await expect
      .poll(() => sql("SELECT status FROM operational_incidents WHERE id = $1", [incidentId])[0]!.status, {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe("RESOLVED");
    // The page itself moves it, without a reload: out of Action required and
    // Monitoring, into Recently resolved, and counted as resolved.
    const group = '[data-ops-group="pipeline.report_generation_failed"]';
    await expect(page.locator(`[data-ops-section="recently-resolved"] ${group}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-ops-section="action-required"] ${group}`)).toHaveCount(0);
    await expect(page.locator(`[data-ops-section="monitoring"] ${group}`)).toHaveCount(0);
    await expect(page.locator('[data-ops-metric="open"]')).toContainText("0");
    await expect(page.locator('[data-ops-metric="resolved"]')).toContainText("1");
    // The exact condition, opened again, reads RESOLVED and keeps its record.
    await page.goto(`/operations?incident=${incidentId}`);
    const closed = page.locator(`[data-ops-inspector="${incidentId}"]`);
    await expect(closed).toBeVisible({ timeout: 30_000 });
    await expect(closed.locator("[data-ops-status]").first()).toHaveAttribute("data-ops-status", "RESOLVED");
    await expect(closed.locator("[data-ops-remediate]")).toHaveCount(0);
    await expect(closed.locator("[data-ops-affected-link]")).toHaveAttribute("href", `/evidence/${evidenceId}`);

    const history = sql(
      "SELECT event_type FROM operational_incident_events WHERE incident_id = $1 ORDER BY created_at ASC",
      [incidentId],
    ).map((r) => String(r.event_type));
    const queued = history.indexOf("remediation_queued");
    expect(queued, history.join(",")).toBeGreaterThan(0);
    expect(history.slice(queued + 1).some((e) => /resolv/i.test(e)), history.join(",")).toBe(true);
    // One condition for the record, before and after.
    expect(sql("SELECT count(*)::int AS n FROM operational_incidents WHERE related_evidence_id = $1", [evidenceId])[0]!.n).toBe(1);
  });
});

// ===========================================================================
// Journey B — a storage add-on the payment provider still bills.
//
// PayPal is played by a local stub (the API reaches it through
// PAYPAL_API_BASE, which `playwright-e2e.yml` points here). Local state says
// the add-on must stop; the provider has not stopped it. Operations raises the
// condition in the PAYER's workspace, refuses a manual Resolve while the
// provider may still be charging, and links to Billing. The payer retries from
// Billing, the provider confirms, the local obligation is CONFIRMED, and the
// condition closes from source truth — one condition, one add-on, throughout.
// ===========================================================================

/**
 * Ask for a NEW check and wait until it has run. Explicit re-checks are
 * spaced (OPERATIONS_EXPLICIT_RECHECK_MIN_MS); this waits past that bound and
 * proves a run happened, so "still open" is an answer, not a missed check.
 */
async function recheck(page: Page, teamId: string) {
  const runs = () =>
    Number(
      sql("SELECT count(*)::int AS n FROM governance_reconciliation_runs WHERE team_id = $1 AND kind = 'WORKSPACE_OPERATIONS'", [teamId])[0]!.n,
    );
  const before = runs();
  await page.waitForTimeout(2_200);
  await page.locator("[data-ops-refresh]").click();
  await expect.poll(runs, { timeout: 30_000 }).toBeGreaterThan(before);
}

const PAYPAL_STUB_PORT = Number(process.env.E2E_PAYPAL_STUB_PORT ?? 8399);

test.describe("Journey B — billing/storage mismatch, through Operations and Billing", () => {
  let P: GuestSession;
  let space = "";
  let addonId = "";
  let subscriptionRef = "";
  let incidentId = "";
  let server: Server;
  const provider = { stopped: false, cancels: 0 };

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.method === "POST" && url === "/v1/oauth2/token") return send(200, { access_token: "e2e-stub-token" });
      const cancel = /^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/.exec(url);
      if (req.method === "POST" && cancel) {
        provider.cancels += 1;
        return provider.stopped ? send(204) : send(503, { name: "SERVICE_UNAVAILABLE" });
      }
      const read = /^\/v1\/billing\/subscriptions\/([^/]+)$/.exec(url);
      if (req.method === "GET" && read) {
        return send(200, { id: read[1], status: provider.stopped ? "CANCELLED" : "ACTIVE" });
      }
      return send(404, { name: "RESOURCE_NOT_FOUND" });
    });
    await new Promise<void>((ok) => server.listen(PAYPAL_STUB_PORT, "127.0.0.1", () => ok()));
  });
  test.afterAll(async () => {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  });

  test("the provider and local state disagree; the payer's workspace shows it; Resolve is refused", async ({ page }) => {
    test.setTimeout(300_000);
    await clearTestRateLimits();
    P = await createGuestSession({ plan: "PRO" });
    space = personalSpaceOf(P.userId);
    expect(space).toBeTruthy();

    // FIXTURE, in the shape storage-activation writes it: PayPal activated an
    // add-on PROOVRA refused to grant (status FAILED), so stopping the charge
    // is owed, and the provider has not confirmed it.
    subscriptionRef = `I-E2E${Date.now()}`;
    addonId = String(
      sql(
        `INSERT INTO workspace_storage_addons
           (owner_user_id, team_id, addon_key, extra_storage_bytes, billing_cycle, status, payment_provider,
            external_subscription_id, updated_at, dependent_cancellation_state,
            dependent_cancellation_requested_at_utc, dependent_cancellation_next_retry_at_utc,
            dependent_cancellation_attempt_count, dependent_cancellation_reason_code)
         VALUES ($1, NULL, 'PERSONAL_50_GB', 53687091200, 'MONTHLY', 'FAILED', 'PAYPAL', $2, now(),
                 'PENDING', now() - interval '2 hours', now() + interval '6 hours', 0, 'UNGRANTABLE_PROVIDER_ACTIVE')
         RETURNING id`,
        [P.userId, subscriptionRef],
      )[0]!.id,
    );

    await signIn(page, P.email);
    await page.goto("/operations");
    await page.locator("[data-ops-refresh]").click();
    const fingerprint = `billing_dependent_cancellation:${addonId}`;
    await expect
      .poll(() => sql("SELECT id FROM operational_incidents WHERE fingerprint = $1", [fingerprint]), { timeout: 60_000 })
      .toHaveLength(1);
    const row = sql("SELECT id, team_id, status, title, safe_summary FROM operational_incidents WHERE fingerprint = $1", [fingerprint])[0]!;
    incidentId = String(row.id);
    // The PAYER's workspace — this person's Personal Space — and a title that
    // says what the obligation's state is.
    expect(row).toMatchObject({ team_id: space, status: "OPEN" });
    expect(String(row.title)).toBe("Storage add-on cancellation in progress");
    expect(String(row.safe_summary)).toContain("You pay for this add-on on your personal account");

    await page.goto(`/operations?incident=${incidentId}`);
    const drawer = page.locator(`[data-ops-inspector="${incidentId}"]`);
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    // No hand-close while the provider may still be charging, in the page ...
    await expect(drawer.locator('[data-ops-action="resolve"]')).toHaveCount(0);
    await expect(drawer.locator("[data-ops-remediation-link]")).toHaveAttribute("href", "/billing");
    // ... or behind it.
    const refused = await P.api.post(`/v1/ops/incidents/${incidentId}/resolve`, {
      data: { teamId: space, resolutionNote: "looks fine" },
    });
    expect(refused.status()).toBe(409);
    expect(["CONDITION_STILL_ACTIVE", "CONDITION_NOT_DIRECTLY_RESOLVABLE"]).toContain(
      ((await refused.json()) as { error: { code: string } }).error.code,
    );
    expect(sql("SELECT status FROM operational_incidents WHERE id = $1", [incidentId])[0]!.status).toBe("OPEN");
  });

  test("a failed retry keeps it owed and open; the provider confirms; the condition closes from source truth", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, P.email);
    await page.goto(`/operations?incident=${incidentId}`);
    const drawer = page.locator(`[data-ops-inspector="${incidentId}"]`);
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await drawer.locator("[data-ops-remediation-link]").click();
    await page.waitForURL(/\/billing/, { timeout: 30_000 });

    // The provider is still unreachable. A failed attempt is not a reason to
    // stop owing the cancellation, and the condition does not close.
    const retry = page.locator("[data-billing-addon-retry-action]");
    await expect(retry).toBeVisible({ timeout: 30_000 });
    let before = provider.cancels;
    await retry.click();
    await expect.poll(() => provider.cancels, { timeout: 30_000 }).toBeGreaterThan(before);
    await expect
      .poll(
        () =>
          sql(
            "SELECT dependent_cancellation_state, dependent_cancellation_reason_code FROM workspace_storage_addons WHERE id = $1",
            [addonId],
          )[0],
        { timeout: 30_000 },
      )
      .toEqual({ dependent_cancellation_state: "RETRY_SCHEDULED", dependent_cancellation_reason_code: "UNGRANTABLE_PROVIDER_ACTIVE" });
    await page.goto("/operations");
    await recheck(page, space);
    expect(sql("SELECT status FROM operational_incidents WHERE id = $1", [incidentId])[0]!.status).toBe("OPEN");

    // The provider stops it.
    provider.stopped = true;
    await page.goto("/billing");
    await expect(retry).toBeVisible({ timeout: 30_000 });
    before = provider.cancels;
    await retry.click();
    await expect
      .poll(
        () =>
          sql("SELECT dependent_cancellation_state FROM workspace_storage_addons WHERE id = $1", [addonId])[0]!
            .dependent_cancellation_state,
        { timeout: 60_000 },
      )
      .toBe("CONFIRMED");
    expect(provider.cancels).toBeGreaterThan(before);

    await page.goto("/operations");
    await recheck(page, space);
    await expect
      .poll(() => sql("SELECT status FROM operational_incidents WHERE id = $1", [incidentId])[0]!.status, { timeout: 60_000 })
      .toBe("RESOLVED");
    await expect(page.locator(`[data-ops-table-surface] [data-ops-row="${incidentId}"]`)).toHaveCount(0, { timeout: 30_000 });

    // One condition and one add-on, throughout.
    expect(
      sql("SELECT count(*)::int AS n FROM operational_incidents WHERE fingerprint = $1", [`billing_dependent_cancellation:${addonId}`])[0]!.n,
    ).toBe(1);
    expect(sql("SELECT count(*)::int AS n FROM workspace_storage_addons WHERE external_subscription_id = $1", [subscriptionRef])[0]!.n).toBe(1);
    const history = sql("SELECT event_type FROM operational_incident_events WHERE incident_id = $1 ORDER BY created_at", [incidentId]).map(
      (r) => String(r.event_type),
    );
    expect(history.some((e) => /resolv/i.test(e)), history.join(",")).toBe(true);
  });
});

// ===========================================================================
// Journey C — trusted timestamp and OpenTimestamps conditions stay truthful.
//
// No timestamp authority or Bitcoin calendar is reachable from a disposable
// stack, so the record's proof columns are set the way those services leave
// them; everything else — discovery, the probe, the page, the link — is the
// product. A failed proof opens a condition linked to the record's Integrity
// tab. A token that was stored but never validated is NOT recovery, and an OTS
// proof that is merely pending is NOT recovery; each stays open through a
// fresh check. Only a validated token, and only an anchored proof, close them.
// ===========================================================================

test.describe("Journey C — TSA/OTS truth, through Operations", () => {
  let T: GuestSession;
  let teamId = "";
  let evidenceId = "";

  test("a failed timestamp opens; an unvalidated token does not close it; a validated one does", async ({ page }) => {
    test.setTimeout(300_000);
    await clearTestRateLimits();
    T = await createGuestSession({ plan: "PRO" });
    teamId = personalSpaceOf(T.userId);
    evidenceId = await createRecord(T, "operations journey C");

    // The authority refused the timestamp.
    sql("UPDATE evidence SET tsa_status = 'FAILED', tsa_validated_at_utc = NULL WHERE id = $1", [evidenceId]);
    await signIn(page, T.email);
    await page.goto("/operations");
    await recheck(page, teamId);
    const tsa = () => sql("SELECT id, status FROM operational_incidents WHERE fingerprint = $1", [`tsa_failure:${evidenceId}`]);
    await expect.poll(() => tsa().length, { timeout: 30_000 }).toBe(1);
    const incidentId = String(tsa()[0]!.id);

    // The drawer links the record's Integrity tab, and the link lands there.
    await page.goto(`/operations?incident=${incidentId}`);
    const drawer = page.locator(`[data-ops-inspector="${incidentId}"]`);
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    const link = drawer.locator("[data-ops-remediation-link]");
    await expect(link).toHaveAttribute("href", `/evidence/${evidenceId}?tab=integrity`);
    await link.click();
    await page.waitForURL(new RegExp(`/evidence/${evidenceId}\\?tab=integrity`), { timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Integrity" })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

    // A token on the row that was never validated is not a recovered timestamp.
    sql("UPDATE evidence SET tsa_status = 'STAMPED', tsa_validated_at_utc = NULL WHERE id = $1", [evidenceId]);
    await page.goto("/operations");
    await recheck(page, teamId);
    expect(tsa()[0]!.status).toBe("OPEN");

    // A validated token is.
    sql("UPDATE evidence SET tsa_status = 'STAMPED', tsa_validated_at_utc = now() WHERE id = $1", [evidenceId]);
    await recheck(page, teamId);
    await expect.poll(() => tsa()[0]!.status, { timeout: 30_000 }).toBe("RESOLVED");
  });

  test("a failed OTS anchor opens; pending stays open; only an anchored proof closes it", async ({ page }) => {
    test.setTimeout(300_000);
    sql("UPDATE evidence SET ots_status = 'FAILED', ots_anchored_at_utc = NULL, ots_bitcoin_txid = NULL WHERE id = $1", [evidenceId]);
    await signIn(page, T.email);
    await page.goto("/operations");
    await recheck(page, teamId);
    const ots = () => sql("SELECT id, status FROM operational_incidents WHERE fingerprint = $1", [`ots_failure:${evidenceId}`]);
    await expect.poll(() => ots().length, { timeout: 30_000 }).toBe(1);
    const incidentId = String(ots()[0]!.id);
    await page.goto(`/operations?incident=${incidentId}`);
    await expect(page.locator(`[data-ops-inspector="${incidentId}"] [data-ops-remediation-link]`)).toHaveAttribute(
      "href",
      `/evidence/${evidenceId}?tab=integrity`,
    );

    // Pending is not anchored.
    sql("UPDATE evidence SET ots_status = 'PENDING' WHERE id = $1", [evidenceId]);
    await page.goto("/operations");
    await recheck(page, teamId);
    expect(ots()[0]!.status).toBe("OPEN");

    // Anchored, with its transaction, is.
    sql(
      "UPDATE evidence SET ots_status = 'ANCHORED', ots_anchored_at_utc = now(), ots_bitcoin_txid = $2 WHERE id = $1",
      [evidenceId, "c".repeat(64)],
    );
    await recheck(page, teamId);
    await expect.poll(() => ots()[0]!.status, { timeout: 30_000 }).toBe("RESOLVED");
    // One condition per proof, throughout.
    expect(sql("SELECT count(*)::int AS n FROM operational_incidents WHERE related_evidence_id = $1 AND fingerprint LIKE '%_failure:%'", [evidenceId])[0]!.n).toBe(2);
  });
});
