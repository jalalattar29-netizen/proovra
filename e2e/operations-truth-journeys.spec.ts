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
  const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
  const live = async () => (await fetch(`${endpoint}/minio/health/live`).catch(() => null))?.ok ?? false;
  const waitLive = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await live()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };
  storage("start");
  // Docker Desktop occasionally leaves a killed-then-started container with
  // its port published and nothing answering. A restart is the remedy; the
  // assertion below is unchanged.
  if (!(await waitLive(30_000))) {
    const run = spawnSync("docker", ["restart", MINIO_CONTAINER], { encoding: "utf8", timeout: 120_000 });
    if (run.status !== 0) throw new Error(`docker restart ${MINIO_CONTAINER}: ${run.error?.message ?? run.stderr}`);
  }
  await expect.poll(live, { timeout: 60_000 }).toBe(true);
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

// ===========================================================================
// Journey D — a queue failure is the platform's condition, not a customer's.
//
// A real storage outage makes a real report job spend its BullMQ attempts and
// land in the failed set. The Operations scheduler's own tick (run once, from
// `services/api/scripts/e2e-operations-sweep.ts`) records ONE PLATFORM
// condition for the queue. The Platform Admin sees it in the platform incident
// console and in the queue inventory; the customer whose record it was sees no
// platform row, no invented storm, and is refused the queue console. Replay
// refuses what it must: a COMPLETED job (409 job_completed), and a failed
// signing-bearing job without step-up (401 STEP_UP_REQUIRED) — neither starts
// work. A second tick does not duplicate the condition.
//
// Eligible replay-once and the queue condition's recovery (no final failure in
// the last hour) are proven against real BullMQ workers in
// services/api/test/operations-truth-platform.integration.test.ts (OPS-022,
// OPS-024); an hour-long window is not something a browser journey can wait out.
// ===========================================================================

/** One tick of the Operations scheduler, in its own process, against this stack. */
function runSchedulerTick(): { ok: boolean } {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-operations-sweep.ts"], {
    cwd: API_DIR,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (run.status !== 0) throw new Error(`scheduler tick failed: ${run.stderr || run.stdout}`);
  const line = run.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
  return JSON.parse(line) as { ok: boolean };
}

/** The ids in one BullMQ state set of the stack's Redis. */
function bullIds(queue: string, state: "completed" | "failed"): string[] {
  const script = `
    const Redis = require("ioredis");
    (async () => {
      const r = new Redis(process.env.REDIS_URL);
      const ids = await r.zrange(${JSON.stringify(`bull:${queue}:${state}`)}, 0, -1);
      process.stdout.write(JSON.stringify(ids));
      r.disconnect();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: API_DIR, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`redis read failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]") as string[];
}

test.describe("Journey D — queue failures belong to the platform, not the customer", () => {
  test("a real final failure is ONE platform condition the Platform Admin sees and the customer does not; replay refuses what it must", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await clearTestRateLimits();
    const customer = await createGuestSession({ plan: "PRO" });
    const admin = await createGuestSession({ plan: "PRO" });
    sql("UPDATE users SET platform_role = 'admin' WHERE id = $1", [admin.userId]);
    const customerSpace = personalSpaceOf(customer.userId);
    const adminSpace = personalSpaceOf(admin.userId);

    // A real outage: the record completes, then storage goes away while its
    // report job runs, and BullMQ spends every attempt. Storage stays down
    // while the failure is observed: the durable reconciler re-drives a
    // FAILED_RETRYABLE request, which takes its job back out of the failed
    // set, so the observation is made while the cause is still true.
    const evidenceId = await createRecord(customer, "operations journey D");
    storage("kill");
    let failedJobId = "";
    const platformRows = () =>
      sql("SELECT id, scope, team_id, status, title FROM operational_incidents WHERE fingerprint = 'platform:job_failure:report'");
    let condition: Record<string, unknown> = {};
    try {
      await expect
        .poll(
          async () => {
            const req = sql("SELECT id FROM report_generation_requests WHERE evidence_id = $1 ORDER BY created_at_utc LIMIT 1", [evidenceId])[0];
            if (!req) return false;
            failedJobId = `report-${req.id}`;
            // The Platform Admin's own failed-job listing, not a side channel.
            const listed = (await (await admin.api.get(`/v1/operations/queues/report/failed?teamId=${adminSpace}&limit=50`)).json()) as {
              jobs: Array<{ jobId: string }>;
            };
            return listed.jobs.some((j) => j.jobId === failedJobId);
          },
          { timeout: 240_000, intervals: [2000] },
        )
        .toBe(true);

      // The scheduler's tick — the only writer of platform conditions.
      expect(runSchedulerTick().ok).toBe(true);
      expect(platformRows()).toHaveLength(1);
      condition = platformRows()[0]!;
      expect(condition).toMatchObject({ scope: "PLATFORM", team_id: null });
      expect(["OPEN", "ACKNOWLEDGED"]).toContain(String(condition.status));

      // The Platform Admin sees it: in the platform incident console ...
      const adminList = await admin.api.get("/v1/admin/incidents?category=WORKER&limit=100");
      expect(adminList.status(), await adminList.text()).toBe(200);
      expect(JSON.stringify(await adminList.json())).toContain(String(condition.id));
      // ... in the browser — the platform console names the source and the
      // queue, and the row is platform-wide, never a customer's workspace ...
      await signIn(page, admin.email);
      await page.goto("/admin/operations");
      const row = page.getByRole("row").filter({ hasText: "Background jobs failing" }).filter({ hasText: "Job report" });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row).toContainText("Platform-wide");
      // ... and in the queue inventory.
      const inventory = (await (await admin.api.get(`/v1/operations/queues?teamId=${adminSpace}`)).json()) as {
        queues: Array<{ queueName: string; counts: { failed: number } }>;
      };
      expect(inventory.queues.find((q) => q.queueName === "report")!.counts.failed).toBeGreaterThan(0);
    } finally {
      await storageBack();
    }

    // The customer whose record it was sees no platform row and no storm ...
    const customerList = (await (await customer.api.get(`/v1/ops/incidents?teamId=${customerSpace}`)).json()) as {
      incidents: Array<{ id: string; title: string; category: string }>;
    };
    expect(customerList.incidents.map((i) => i.id)).not.toContain(String(condition.id));
    expect(customerList.incidents.filter((i) => /storm|background jobs failing/i.test(i.title))).toEqual([]);
    // ... and is refused the platform's consoles.
    expect((await customer.api.get(`/v1/operations/queues?teamId=${customerSpace}`)).status()).toBe(403);
    expect((await customer.api.get("/v1/admin/incidents")).status()).toBe(403);

    // Replay refuses a COMPLETED job, and starts nothing.
    const completed = bullIds("search-indexing", "completed");
    expect(completed.length).toBeGreaterThan(0);
    const done = completed[0]!;
    const replayDone = await admin.api.post(`/v1/operations/queues/search-indexing/jobs/${encodeURIComponent(done)}/replay`, {
      data: { teamId: adminSpace, reason: "journey D: completed jobs are not replayed" },
    });
    expect(replayDone.status(), await replayDone.text()).toBe(409);
    expect(((await replayDone.json()) as { error: { code: string } }).error.code).toBe("job_completed");
    expect(bullIds("search-indexing", "completed")).toContain(done);

    // A failed report job carries signing: replay demands step-up first.
    const replaySigned = await admin.api.post(`/v1/operations/queues/report/jobs/${encodeURIComponent(failedJobId)}/replay`, {
      data: { teamId: adminSpace, reason: "journey D: signing-bearing replay" },
    });
    expect(replaySigned.status(), await replaySigned.text()).toBe(401);
    expect(((await replaySigned.json()) as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");

    // A second tick re-observes the same condition; it never duplicates it.
    expect(runSchedulerTick().ok).toBe(true);
    expect(platformRows()).toHaveLength(1);
  });
});

// ===========================================================================
// Journey E — the Enterprise roll-up is the authorized union of ORIGINAL
// conditions, and every action lands on the original.
//
// The organization is provisioned through the product's own sales-led
// authority (`provisionEnterpriseOrg` → `provisionEnterpriseCustomer`). There
// is no self-service way to add workspaces to it, so two more are fixture rows
// in the shape provisioning writes: one the owner belongs to, and one owned by
// someone else that the owner may not read. Conditions are seeded in all three.
// ===========================================================================

function orgWorkspace(orgId: string, ownerUserId: string, name: string): string {
  const id = String(
    sql(
      `INSERT INTO teams (name, owner_user_id, organization_id, workspace_kind, is_personal, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $3, 'ORGANIZATION', false, 'ENTERPRISE', 'ACTIVE', now()) RETURNING id`,
      [name, ownerUserId, orgId],
    )[0]!.id,
  );
  sql(`INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'OWNER', 'ACTIVE')`, [id, ownerUserId]);
  return id;
}

function seedCondition(teamId: string, severity: "CRITICAL" | "HIGH", label: string): string {
  return String(
    sql(
      `INSERT INTO operational_incidents (team_id, scope, source_id, category, severity, status, fingerprint, title, safe_summary, updated_at)
       VALUES ($1, 'WORKSPACE', 'governance.policy_condition', 'GOVERNANCE', $2::"IncidentSeverity", 'OPEN', $3, $4, 'A governance policy condition that needs a decision.', now())
       RETURNING id`,
      [teamId, severity, `journey-e:${label}:${Date.now()}`, `Policy decision needed — ${label}`],
    )[0]!.id,
  );
}

test.describe("Journey E — Enterprise roll-up, drilldown and action on the original", () => {
  test("totals equal the authorized union; filters and pages; the drilldown opens and acts on the original", async ({ page }) => {
    test.setTimeout(300_000);
    await clearTestRateLimits();
    const owner = await createGuestSession({ plan: "PRO" });
    const other = await createGuestSession({ plan: "PRO" });
    const org = provisionEnterpriseOrg(owner, `Ops Journey E ${Date.now()}`);
    const w1 = org.workspaceId;
    const w2 = orgWorkspace(org.organizationId, owner.userId, "journey-e-w2");
    const w3 = orgWorkspace(org.organizationId, other.userId, "journey-e-w3");

    const own = [seedCondition(w1, "CRITICAL", "w1-a"), seedCondition(w1, "HIGH", "w1-b"), seedCondition(w2, "HIGH", "w2-a")];
    const hidden = [seedCondition(w3, "CRITICAL", "w3-a"), seedCondition(w3, "HIGH", "w3-b")];

    // The roll-up counts the workspaces this person may read — never w3.
    const rollup = await owner.api.get(`/v1/orgs/${org.organizationId}/operations/rollup`);
    expect(rollup.status(), await rollup.text()).toBe(200);
    const r = (await rollup.json()) as {
      totals: { open: number; critical: number; high: number };
      workspaces: Array<{ workspaceId: string }>;
    };
    expect(r.totals).toMatchObject({ open: 3, critical: 1, high: 2 });
    expect(r.workspaces.map((w) => w.workspaceId).sort()).toEqual([w1, w2].sort());

    // The list is the original conditions, filterable and paged.
    const list = async (qs: string) => {
      const res = await owner.api.get(`/v1/orgs/${org.organizationId}/operations/incidents?${qs}`);
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as {
        incidents: Array<{ id: string; workspaceId: string }>;
        pagination: { nextCursor: string | null };
      };
    };
    const first = await list("limit=2");
    expect(first.incidents).toHaveLength(2);
    expect(first.pagination.nextCursor).toBeTruthy();
    const second = await list(`limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor!)}`);
    const all = [...first.incidents, ...second.incidents].map((i) => i.id);
    expect(all.sort()).toEqual([...own].sort());
    for (const id of hidden) expect(all).not.toContain(id);
    expect((await list("severity=CRITICAL")).incidents.map((i) => i.id)).toEqual([own[0]]);
    expect((await list(`workspaceId=${w2}`)).incidents.map((i) => i.id)).toEqual([own[2]]);
    expect((await list(`workspaceId=${w3}`)).incidents).toEqual([]);
    expect((await list("status=OPEN")).incidents).toHaveLength(3);
    expect((await list("sourceId=governance.policy_condition")).incidents).toHaveLength(3);

    // In the browser: the readiness page shows the union and drills into the
    // ORIGINAL condition in its own workspace.
    // The organization surfaces belong to the Enterprise workspace experience:
    // the owner works from the organization's workspace, as a person would.
    const switched = await owner.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: w1 } });
    expect(switched.ok(), await switched.text()).toBe(true);
    await signIn(page, owner.email);
    await page.goto(`/organizations/${org.organizationId}/admin/readiness`);
    await expect(page.locator("[data-rollup-totals]")).toContainText("3 unresolved conditions", { timeout: 30_000 });
    await expect(page.locator("[data-rollup-incident]")).toHaveCount(3);
    for (const id of hidden) await expect(page.locator(`[data-rollup-incident="${id}"]`)).toHaveCount(0);
    await page.locator(`[data-rollup-open="${own[2]}"]`).click();
    await page.waitForURL(new RegExp(`/operations\\?incident=${own[2]}`), { timeout: 30_000 });
    const drawer = page.locator(`[data-ops-inspector="${own[2]}"]`);
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(drawer).toContainText("Policy decision needed — w2-a");

    // The action runs on the original row; no copy exists anywhere.
    await drawer.locator('[data-ops-action="acknowledge"]').click();
    await expect
      .poll(() => sql("SELECT status FROM operational_incidents WHERE id = $1", [own[2]])[0]!.status, { timeout: 30_000 })
      .toBe("ACKNOWLEDGED");
    const fingerprint = String(sql("SELECT fingerprint FROM operational_incidents WHERE id = $1", [own[2]])[0]!.fingerprint);
    expect(sql("SELECT count(*)::int AS n FROM operational_incidents WHERE fingerprint = $1", [fingerprint])[0]!.n).toBe(1);

    // Someone outside the organization learns nothing.
    for (const path of [`/v1/orgs/${org.organizationId}/operations/rollup`, `/v1/orgs/${org.organizationId}/operations/incidents`]) {
      expect([403, 404]).toContain((await other.api.get(path)).status());
    }
  });
});

// ===========================================================================
// Journey F — every Operations read and action, called directly, answers what
// the canonical capability decision says.
//
// For each actor the server's own capability envelope for the workspace
// (`GET /v1/platform/context` after switching to it) is read first; then the
// Operations API is called directly — read, acknowledge, resolve, suppress,
// assign — each on its own fresh condition. An action is accepted exactly when
// the envelope grants its capability. A member who is refused gets 403; anyone
// who is not an ACTIVE member learns nothing (404). Some outcomes are also
// fixed independently of the envelope, so the matrix cannot pass by both
// sides agreeing on something wrong: the owner may do everything, a viewer may
// only read, and a revoked, expired or outside actor may do nothing.
// ===========================================================================

type OpsCaps = {
  OPERATIONS_VIEW: boolean;
  OPERATIONS_ACKNOWLEDGE: boolean;
  OPERATIONS_RESOLVE: boolean;
  OPERATIONS_SUPPRESS: boolean;
  OPERATIONS_ASSIGN: boolean;
};
const NO_CAPS: OpsCaps = {
  OPERATIONS_VIEW: false,
  OPERATIONS_ACKNOWLEDGE: false,
  OPERATIONS_RESOLVE: false,
  OPERATIONS_SUPPRESS: false,
  OPERATIONS_ASSIGN: false,
};

/** The capability envelope this actor gets for this workspace — or none. */
async function envelopeCaps(s: GuestSession, workspaceId: string): Promise<OpsCaps> {
  const switched = await s.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId } });
  if (!switched.ok()) return NO_CAPS;
  const res = await s.api.get("/v1/platform/context");
  if (!res.ok()) return NO_CAPS;
  const body = (await res.json()) as { capabilities?: Record<string, boolean> };
  expect(JSON.stringify(body), "the envelope is for the workspace switched to").toContain(workspaceId);
  const c = body.capabilities ?? {};
  return {
    OPERATIONS_VIEW: c.OPERATIONS_VIEW === true,
    OPERATIONS_ACKNOWLEDGE: c.OPERATIONS_ACKNOWLEDGE === true,
    OPERATIONS_RESOLVE: c.OPERATIONS_RESOLVE === true,
    OPERATIONS_SUPPRESS: c.OPERATIONS_SUPPRESS === true,
    OPERATIONS_ASSIGN: c.OPERATIONS_ASSIGN === true,
  };
}

/** Call every Operations read and action directly; return what was accepted. */
async function exercise(s: GuestSession, workspaceId: string): Promise<{ accepted: OpsCaps; statuses: number[] }> {
  const statuses: number[] = [];
  const ok = (status: number) => {
    statuses.push(status);
    return status === 200;
  };
  const fresh = () => seedCondition(workspaceId, "HIGH", `journey-f-${Math.random().toString(36).slice(2, 8)}`);
  const read = await s.api.get(`/v1/ops/incidents?teamId=${workspaceId}`);
  const ack = await s.api.post(`/v1/ops/incidents/${fresh()}/ack`, { data: { teamId: workspaceId } });
  const resolve = await s.api.post(`/v1/ops/incidents/${fresh()}/resolve`, {
    data: { teamId: workspaceId, resolutionNote: "Decided by the workspace: accepted as policy." },
  });
  const suppress = await s.api.post(`/v1/ops/incidents/${fresh()}/suppress`, {
    data: { teamId: workspaceId, reason: "Planned maintenance window" },
  });
  const assign = await s.api.post(`/v1/ops/incidents/${fresh()}/assign`, {
    data: { teamId: workspaceId, assigneeUserId: s.userId },
  });
  return {
    accepted: {
      OPERATIONS_VIEW: ok(read.status()),
      OPERATIONS_ACKNOWLEDGE: ok(ack.status()),
      OPERATIONS_RESOLVE: ok(resolve.status()),
      OPERATIONS_SUPPRESS: ok(suppress.status()),
      OPERATIONS_ASSIGN: ok(assign.status()),
    },
    statuses,
  };
}

test.describe("Journey F — the permission matrix, by direct API call", () => {
  test("every actor's reads and actions match the canonical capability decision", async () => {
    test.setTimeout(600_000);
    await clearTestRateLimits();
    const owner = await createGuestSession({ plan: "PRO" });
    const org = provisionEnterpriseOrg(owner, `Ops Journey F ${Date.now()}`);
    const w = org.workspaceId;

    const member = async (role: "ADMIN" | "MEMBER" | "VIEWER", extra: { status?: string; expired?: boolean } = {}) => {
      await clearTestRateLimits();
      const s = await createGuestSession({ plan: "PRO" });
      sql(
        `INSERT INTO team_members (team_id, user_id, role, status, access_expires_at_utc)
         VALUES ($1, $2, $3::"TeamRole", $4::"TeamMemberStatus", $5)`,
        [w, s.userId, role, extra.status ?? "ACTIVE", extra.expired ? new Date(Date.now() - 86_400_000).toISOString() : null],
      );
      return s;
    };
    const admin = await member("ADMIN");
    const plain = await member("MEMBER");
    const viewer = await member("VIEWER");
    const revoked = await member("MEMBER", { status: "REVOKED" });
    const expired = await member("MEMBER", { expired: true });
    await clearTestRateLimits();
    const platformAdmin = await createGuestSession({ plan: "PRO" });
    sql("UPDATE users SET platform_role = 'admin' WHERE id = $1", [platformAdmin.userId]);
    const otherTenant = await createGuestSession({ plan: "PRO" });

    const ALL: OpsCaps = {
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
      OPERATIONS_ASSIGN: true,
    };
    const matrix: Array<{ who: string; s: GuestSession; fixed?: OpsCaps; outsider?: boolean }> = [
      { who: "owner", s: owner, fixed: ALL },
      { who: "admin", s: admin },
      { who: "member", s: plain },
      { who: "viewer", s: viewer, fixed: { ...NO_CAPS, OPERATIONS_VIEW: true } },
      // A revoked member is refused explicitly (403): they were a member and
      // already know the workspace exists. Only strangers get 404.
      { who: "revoked member", s: revoked, fixed: NO_CAPS },
      { who: "expired member", s: expired, fixed: NO_CAPS },
      { who: "platform admin (not a member)", s: platformAdmin, fixed: NO_CAPS, outsider: true },
      { who: "another tenant", s: otherTenant, fixed: NO_CAPS, outsider: true },
    ];
    const results: Record<string, unknown> = {};
    for (const row of matrix) {
      const caps = await envelopeCaps(row.s, w);
      const { accepted, statuses } = await exercise(row.s, w);
      results[row.who] = { caps, accepted, statuses };
      expect(accepted, `${row.who}: enforcement equals the capability decision`).toEqual(caps);
      if (row.fixed) expect(caps, `${row.who}: the decision itself`).toEqual(row.fixed);
      // Refusals: 404 for anyone who is not an ACTIVE member, 403 for a member.
      for (const status of statuses.filter((x) => x !== 200)) {
        expect(row.outsider ? [404] : [403, 404], `${row.who}: refusal status`).toContain(status);
      }
    }
    // The member roles between owner and viewer are decided by the role
    // policy, not by this test; they are still never MORE than the owner.
    for (const who of ["admin", "member"]) {
      const caps = (results[who] as { caps: OpsCaps }).caps;
      expect(caps.OPERATIONS_VIEW, `${who} may read`).toBe(true);
    }

    // FREE: a Personal Space with no workbench.
    await clearTestRateLimits();
    const free = await createGuestSession({ plan: "FREE" });
    const freeSpace = personalSpaceOf(free.userId);
    const freeCaps = await envelopeCaps(free, freeSpace);
    expect(freeCaps).toEqual(NO_CAPS);
    const freeRun = await exercise(free, freeSpace);
    expect(freeRun.accepted).toEqual(NO_CAPS);

    // A plan grant: in force, the grant decides; expired, it decides nothing.
    await clearTestRateLimits();
    const granted = await createGuestSession({ plan: "FREE" });
    const grantedSpace = personalSpaceOf(granted.userId);
    const grantId = String(
      sql(
        `INSERT INTO plan_grants (user_id, plan, source, reason, granted_by_user_id, expires_at_utc, idempotency_key, updated_at)
         VALUES ($1, 'TEAM', 'INTERNAL_TEST', 'journey F', $2, now() + interval '1 day', $3, now()) RETURNING id`,
        [granted.userId, platformAdmin.userId, `journey-f-${granted.userId}`],
      )[0]!.id,
    );
    const inForce = await envelopeCaps(granted, grantedSpace);
    expect((await exercise(granted, grantedSpace)).accepted, "grant in force: enforcement equals the decision").toEqual(inForce);
    sql("UPDATE plan_grants SET granted_at_utc = now() - interval '2 days', expires_at_utc = now() - interval '1 minute' WHERE id = $1", [grantId]);
    const lapsed = await envelopeCaps(granted, grantedSpace);
    expect(lapsed, "an expired grant grants nothing").toEqual(freeCaps);
    expect((await exercise(granted, grantedSpace)).accepted).toEqual(lapsed);

    // A suspended organization: its members, owner included, may do nothing.
    sql("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [org.organizationId]);
    try {
      const suspended = await envelopeCaps(owner, w);
      const run = await exercise(owner, w);
      expect(run.accepted, "suspended: enforcement equals the decision").toEqual(suspended);
      expect(run.accepted.OPERATIONS_ACKNOWLEDGE || run.accepted.OPERATIONS_RESOLVE || run.accepted.OPERATIONS_SUPPRESS || run.accepted.OPERATIONS_ASSIGN).toBe(false);
    } finally {
      sql("UPDATE organizations SET status = 'ACTIVE' WHERE id = $1", [org.organizationId]);
    }
  });
});
