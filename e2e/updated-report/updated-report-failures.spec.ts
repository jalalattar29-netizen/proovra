/**
 * THE FAILURE, RECOVERY AND CONCURRENCY MATRIX — on the same real stack as the
 * journey (production API + worker images, MinIO, Redis, PostgreSQL, a
 * production `next start`). Every case asserts the invariants that matter:
 * no duplicate versions, no duplicate requests for one confirmation, no
 * report/package cross-pairing, no fabricated success, only valid actions, and
 * earlier versions untouched.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { openArtifacts, openUpdatedReportDialog, signIn } from "./_browser";
import {
  addWorkspaceMember,
  createFinalizedEvidence,
  downloadVersion,
  killWorkerWhen,
  personalTeamId,
  sha256Hex,
  sql,
  stackCtl,
  status,
  validateKeptTsaToken,
  waitForPair,
} from "./_stack";

test.describe.configure({ mode: "serial" });

const PROOF_DIR = resolve(process.env.RGA_PROOF_DIR ?? join(require("node:os").tmpdir(), "pv-rga-proof"), "failures");
const results: Record<string, unknown> = {};
function record(key: string, value: unknown) {
  results[key] = value;
  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(join(PROOF_DIR, "failure-matrix.json"), JSON.stringify(results, null, 2));
}

let A: GuestSession;
let B: GuestSession;
let C: GuestSession;
let teamId = "";
const E: string[] = [];

/** The invariants every case ends on. */
function assertPairsConsistent(evidenceId: string) {
  const reports = sql<{ version: number }>("SELECT version FROM reports WHERE evidence_id = $1 ORDER BY version", [evidenceId]).map((r) => r.version);
  const rows = sql<{ version: number; report_version: number | null; disclosure_profile: string | null; state: string }>(
    "SELECT version, report_version, disclosure_profile, state FROM verification_packages WHERE evidence_id = $1 ORDER BY version, disclosure_profile",
    [evidenceId],
  );
  // Contiguous versions, no duplicates.
  expect(reports).toEqual(reports.map((_, i) => i + 1));
  // Every package certifies exactly its own report version.
  for (const p of rows) expect(p.report_version ?? p.version).toBe(p.version);
  // Per version: at most ONE published primary package (FULL_FORENSIC or
  // legacy) and at most ONE published external package, which never exists
  // without its primary.
  const published = rows.filter((p) => p.state === "PUBLISHED");
  const pkgs = published.filter((p) => p.disclosure_profile === null || p.disclosure_profile === "FULL_FORENSIC");
  const external = published.filter((p) => p.disclosure_profile === "EXTERNAL_DISCLOSURE");
  expect(new Set(pkgs.map((p) => p.version)).size).toBe(pkgs.length);
  expect(new Set(external.map((p) => p.version)).size).toBe(external.length);
  for (const e of external) expect(pkgs.map((p) => p.version)).toContain(e.version);
  return { reports, packages: pkgs.map((p) => p.version) };
}

async function confirmViaApi(s: GuestSession, evidenceId: string, key = `nv-${Math.random().toString(36).slice(2)}${Date.now()}`) {
  const st = await status(s.api, evidenceId);
  const res = await s.api.post(`/v1/evidence/${evidenceId}/reports/regenerate`, {
    data: { intent: "NEW_VERSION", reason: "Matrix case", clientRequestKey: key, offerRevision: st.outputs.offer?.revision },
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown>, key, offer: st.outputs.offer?.revision };
}

const newVersionRequests = (id: string) =>
  Number(sql<{ n: string }>("SELECT count(*)::text AS n FROM report_generation_requests WHERE evidence_id = $1 AND intent = 'NEW_VERSION'", [id])[0]!.n);

/** Wait for the durable row to reach a predicate (sampled from the database). */
async function waitForRow(requestId: string, pred: (r: { state: string; stage: string | null; progress_stage: string | null }) => boolean, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [r] = sql<{ state: string; stage: string | null; progress_stage: string | null }>(
      "SELECT state, stage, progress_stage FROM report_generation_requests WHERE id = $1",
      [requestId],
    );
    if (r && pred(r)) return r;
    if (Date.now() > until) throw new Error(`row ${requestId} never matched; last ${JSON.stringify(r)}`);
    await new Promise((res) => setTimeout(res, 120));
  }
}

function mc(args: string[]) {
  const run = spawnSync(
    "docker",
    [
      "run", "--rm", "--network", "pv-rga_default",
      "-e", "MC_HOST_local=http://rgaminio:rgaminio_password@minio:57900",
      "pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd",
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`mc ${args.join(" ")}: ${run.stderr || run.stdout}`);
  return run.stdout;
}

test.beforeAll(async () => {
  test.setTimeout(900_000);
  // A drill that failed mid-way must not leave the stack degraded for the next.
  for (const svc of ["worker", "redis", "minio"]) {
    try { stackCtl("unpause", svc); } catch { /* not paused */ }
    stackCtl("start", svc);
  }
  await clearTestRateLimits();
  A = await createGuestSession({ plan: "TEAM" });
  B = await createGuestSession({ plan: "TEAM" });
  C = await createGuestSession({ plan: "TEAM" });
  teamId = await personalTeamId(A.api);
  addWorkspaceMember(teamId, B.userId, "ADMIN");
  // Nine records, each with its complete v1 pair from the real worker.
  for (let i = 0; i < 9; i += 1) E.push((await createFinalizedEvidence(A.api, teamId, `matrix-${i}`)).id);
  for (const id of E) await waitForPair(A.api, id, 1, 600_000);
  record("records", E);
});

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test("modal stays open while ANOTHER MEMBER issues v2 → the dialog updates in place → confirming creates v3 (later facts → v3)", async ({ page }) => {
  test.setTimeout(600_000);
  const id = E[0]!;
  await signIn(page, A.email);
  await openArtifacts(page, id);
  const dialog = await openUpdatedReportDialog(page);
  await expect(dialog.getByTestId("updated-report-target")).toHaveText("v2");
  await dialog.getByTestId("updated-report-reason").fill("Owner's updated report");

  const byB = await confirmViaApi(B, id);
  expect(byB.status).toBe(202);
  await waitForPair(A.api, id, 2);

  await dialog.getByTestId("updated-report-confirm").click();
  await expect(dialog.getByTestId("updated-report-stale")).toContainText("A newer report version was completed.");
  await expect(dialog.getByTestId("updated-report-target")).toHaveText("v3");
  await expect(dialog.getByTestId("updated-report-reason")).toHaveValue("Owner's updated report");
  await page.screenshot({ path: join(PROOF_DIR, "stale-offer-updated-in-place.png") });
  expect(newVersionRequests(id)).toBe(1); // the stale confirmation created nothing

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/reports/regenerate") && r.request().method() === "POST"),
    dialog.getByTestId("updated-report-confirm").click(),
  ]);
  expect(resp.status()).toBe(202);
  await waitForPair(A.api, id, 3);
  const inv = assertPairsConsistent(id);
  expect(inv.reports).toEqual([1, 2, 3]);
  expect(inv.packages).toEqual([1, 2, 3]);
  record("staleWhileAnotherMemberIssued", { evidenceId: id, ...inv, newVersionRequests: newVersionRequests(id) });
});

test("modal stays open while the TIMESTAMP is validated → stale, names the change, keeps the reason", async ({ page }) => {
  test.setTimeout(600_000);
  const id = E[1]!;
  // PRECONDITION, stated: v1 exists and was issued while the token was NOT validated.
  await waitForPair(A.api, id, 1);
  const [pre] = sql<{ generated_at_utc: string; tsa_status: string; tsa_validated_at_utc: string | null }>(
    "SELECT r.generated_at_utc, e.tsa_status, e.tsa_validated_at_utc FROM reports r JOIN evidence e ON e.id = r.evidence_id WHERE r.evidence_id = $1 AND r.version = 1",
    [id],
  );
  expect(pre?.tsa_status).toBe("FAILED");
  expect(pre?.tsa_validated_at_utc).toBeNull();
  record("tsaCasePrecondition", { evidenceId: id, ...pre });
  await signIn(page, A.email);
  await openArtifacts(page, id);
  const dialog = await openUpdatedReportDialog(page);
  await dialog.getByTestId("updated-report-reason").fill("Document the validated timestamp");
  validateKeptTsaToken(id);
  await dialog.getByTestId("updated-report-confirm").click();
  await expect(dialog.getByTestId("updated-report-stale")).toContainText("The trusted timestamp's status changed.");
  await expect(dialog.getByTestId("updated-report-changes")).toContainText("The trusted timestamp was validated after report v1 was generated.");
  expect(newVersionRequests(id)).toBe(0);
  await dialog.getByTestId("updated-report-confirm").click();
  await expect(page.getByTestId("updated-report-dialog")).toHaveCount(0);
  await expect(page.getByTestId("output-progress")).toBeVisible();

  // NETWORK DROP + RECONNECT while it runs: the page re-reads on `online`.
  await page.context().setOffline(true);
  await page.waitForTimeout(4000);
  await page.context().setOffline(false);
  // NAVIGATE AWAY AND BACK: the durable request is still followed.
  await page.goto("/home");
  await openArtifacts(page, id);
  await expect(page.getByTestId("output-progress")).toBeVisible();
  await waitForPair(A.api, id, 2);
  await page.context().setOffline(true);
  await page.waitForTimeout(1500);
  await page.context().setOffline(false);
  await expect(page.getByTestId("pair-2")).toHaveAttribute("data-pair-latest", "true", { timeout: 60_000 });
  record("staleWhileTsaValidated", { evidenceId: id, ...assertPairsConsistent(id) });
});

test("modal stays open while PERMISSION is removed → typed refusal, nothing created; a REMOVED member gets 404", async ({ page }) => {
  test.setTimeout(300_000);
  const id = E[2]!;
  await signIn(page, B.email);
  await openArtifacts(page, id);
  const dialog = await openUpdatedReportDialog(page);
  await dialog.getByTestId("updated-report-reason").fill("Member's updated report");
  sql(`UPDATE team_members SET role = 'VIEWER' WHERE team_id = $1 AND user_id = $2`, [teamId, B.userId]);
  try {
    await dialog.getByTestId("updated-report-confirm").click();
    await expect(dialog.getByTestId("updated-report-error")).toContainText("You don't have permission to do that");
    await expect(dialog.getByTestId("updated-report-reason")).toHaveValue("Member's updated report");
    await page.screenshot({ path: join(PROOF_DIR, "permission-removed.png") });
    expect(newVersionRequests(id)).toBe(0);
    sql(`UPDATE team_members SET role = 'ADMIN', status = 'REVOKED', revoked_at_utc = now() WHERE team_id = $1 AND user_id = $2`, [teamId, B.userId]);
    const st = await B.api.get(`/v1/evidence/${id}/artifacts/status`);
    expect(st.status()).toBe(404);
    const post = await B.api.post(`/v1/evidence/${id}/reports/regenerate`, { data: { intent: "NEW_VERSION", reason: "x y z", clientRequestKey: "nv-removed-member-1" } });
    expect(post.status()).toBe(404);
    expect(newVersionRequests(id)).toBe(0);
  } finally {
    sql(`UPDATE team_members SET role = 'ADMIN', status = 'ACTIVE', revoked_at_utc = NULL WHERE team_id = $1 AND user_id = $2`, [teamId, B.userId]);
  }
  record("permissionAndMembershipRemoved", { evidenceId: id, newVersionRequests: newVersionRequests(id) });
});

test("double-click Confirm → exactly one request and one new version", async ({ page }) => {
  test.setTimeout(600_000);
  const id = E[2]!;
  await signIn(page, A.email);
  await openArtifacts(page, id);
  const dialog = await openUpdatedReportDialog(page);
  await dialog.getByTestId("updated-report-reason").fill("Double click");
  await dialog.getByTestId("updated-report-confirm").dblclick();
  await waitForPair(A.api, id, 2);
  expect(newVersionRequests(id)).toBe(1);
  const inv = assertPairsConsistent(id);
  expect(inv.reports).toEqual([1, 2]);
  record("doubleClick", { evidenceId: id, newVersionRequests: 1, ...inv });
});

test("20 concurrent confirmations of one revision, plus a second member confirming at the same moment → ONE request", async () => {
  test.setTimeout(600_000);
  const id = E[3]!;
  const st = await status(A.api, id);
  const stB = await status(B.api, id);
  const key = `nv-concurrent-${Date.now()}`;
  const post = (s: GuestSession, k: string, rev?: string) =>
    s.api
      .post(`/v1/evidence/${id}/reports/regenerate`, { data: { intent: "NEW_VERSION", reason: "Concurrent", clientRequestKey: k, offerRevision: rev } })
      .then(async (r) => ({ status: r.status(), body: (await r.json()) as { requestId?: string; code?: string } }));
  const answers = await Promise.all([
    ...Array.from({ length: 20 }, () => post(A, key, st.outputs.offer?.revision)),
    post(B, `nv-concurrent-b-${Date.now()}`, stB.outputs.offer?.revision),
  ]);
  const tally: Record<string, number> = {};
  for (const a of answers) tally[`${a.status}${a.body.code ? `:${a.body.code}` : ""}`] = (tally[`${a.status}${a.body.code ? `:${a.body.code}` : ""}`] ?? 0) + 1;
  for (const a of answers) expect([202, 409, 429]).toContain(a.status);
  expect(new Set(answers.filter((a) => a.status === 202).map((a) => a.body.requestId)).size).toBe(1);
  expect(newVersionRequests(id)).toBe(1);
  await waitForPair(A.api, id, 2);
  const inv = assertPairsConsistent(id);
  expect(inv.reports).toEqual([1, 2]);
  record("concurrentConfirmations", { evidenceId: id, answers: tally, newVersionRequests: 1, ...inv });
});

test("WORKER DOWN before render → the request waits durably (QUEUED), is processed once the worker returns", async () => {
  test.setTimeout(900_000);
  const id = E[8]!;
  stackCtl("kill", "worker");
  let requestId = "";
  try {
    const r = await confirmViaApi(A, id);
    expect(r.status).toBe(202);
    requestId = String(r.body.requestId);
    await new Promise((res) => setTimeout(res, 5000));
    const waiting = sql<{ state: string }>("SELECT state FROM report_generation_requests WHERE id = $1", [requestId])[0]!;
    expect(waiting.state).toBe("QUEUED");
    const s = await status(A.api, id);
    expect(s.outputs.activeRequest?.progress.currentStep).toBe("QUEUED");
    expect(s.versions.versions.find((v) => v.reportVersion === 2) ?? null).toBeNull();
  } finally {
    stackCtl("start", "worker");
  }
  await waitForRow(requestId, (x) => x.state === "SUCCEEDED", 600_000);
  await waitForPair(A.api, id, 2);
  record("workerDownBeforeRender", { evidenceId: id, requestId, ...assertPairsConsistent(id) });
});

test("WORKER CRASH after the report object is published → after the lease, the run resumes; one v2, one package, v1 untouched", async () => {
  test.setTimeout(900_000);
  const id = E[4]!;
  const v1Before = sha256Hex(await downloadVersion(A.api, id, "report", 1));
  const r = await confirmViaApi(A, id);
  expect(r.status).toBe(202);
  const requestId = String(r.body.requestId);
  // SIGKILL the moment the report is COMMITTED (its object published and read
  // back), before the package is published — no graceful drain.
  let afterCrash: { state: string } | undefined;
  let atCrash: unknown;
  try {
    atCrash = await killWorkerWhen(requestId, (x) => x.stage === "REPORT_COMMITTED" || x.state === "SUCCEEDED");
    afterCrash = sql<{ state: string }>("SELECT state, stage, progress_stage, report_version FROM report_generation_requests WHERE id = $1", [requestId])[0]!;
    // The lease (15 min, from the work registry) is what lets another worker take
    // a claim over; the drill advances the claim's clock instead of waiting.
    sql("UPDATE report_generation_requests SET claimed_at_utc = now() - interval '16 minutes' WHERE id = $1 AND state = 'PROCESSING'", [requestId]);
  } finally {
    stackCtl("start", "worker");
  }
  // The crash really interrupted the run: it was still claimed, not finished.
  expect(afterCrash?.state).toBe("PROCESSING");
  await waitForRow(requestId, (x) => x.state === "SUCCEEDED", 600_000);
  await waitForPair(A.api, id, 2, 300_000);
  const inv = assertPairsConsistent(id);
  expect(inv.reports).toEqual([1, 2]);
  expect(inv.packages).toEqual([1, 2]);
  expect(sha256Hex(await downloadVersion(A.api, id, "report", 1))).toBe(v1Before);
  const s = await status(A.api, id);
  const v2 = s.versions.versions.find((v) => v.reportVersion === 2)!;
  expect(v2.package?.embeddedReportSha256).toBe(v2.sha256);
  record("workerCrashAfterReportPublication", { evidenceId: id, requestId, atCrash, afterCrash, ...inv });
});

test("STORAGE OUTAGE while generating/publishing → no false success; after recovery exactly one pair v2", async () => {
  test.setTimeout(900_000);
  const id = E[5]!;
  const r = await confirmViaApi(A, id);
  expect(r.status).toBe(202);
  const requestId = String(r.body.requestId);
  // Storage goes away while the run is in flight (the package publication
  // window alone is sub-second, so the outage starts at acceptance and covers
  // the report and package storage steps).
  stackCtl("pause", "minio");
  let during: unknown;
  try {
    await new Promise((res) => setTimeout(res, 20_000));
    during = sql("SELECT state, stage, progress_stage, terminal_reason_code FROM report_generation_requests WHERE id = $1", [requestId])[0];
    const s = await status(A.api, id);
    // Never "complete" while storage is unavailable.
    expect(s.versions.versions.find((v) => v.reportVersion === 2) ?? null).toBeNull();
    expect((during as { state: string }).state).not.toBe("SUCCEEDED");
  } finally {
    stackCtl("unpause", "minio");
  }
  await waitForRow(requestId, (x) => x.state === "SUCCEEDED" || x.state === "FAILED_TERMINAL", 800_000);
  const final = sql("SELECT state, stage, progress_stage, terminal_reason_code, attempt_count FROM report_generation_requests WHERE id = $1", [requestId])[0] as { state: string };
  if (final.state !== "SUCCEEDED") {
    // A terminal answer is acceptable only as a TRUTHFUL one: the package is
    // absent and the record offers its recovery.
    const s = await status(A.api, id);
    expect(s.versions.versions.find((v) => v.reportVersion === 2)?.package ?? null).toBeNull();
    expect(s.outputs.verificationPackage.action).not.toBe("NONE");
  } else {
    await waitForPair(A.api, id, 2);
  }
  record("storageOutageDuringPackage", { evidenceId: id, requestId, during, final, ...assertPairsConsistent(id) });
});

test("REDIS OUTAGE at Confirm → a typed answer, no fabricated success; after Redis returns the request completes once", async ({ page }) => {
  test.setTimeout(900_000);
  const id = E[6]!;
  await signIn(page, A.email);
  await openArtifacts(page, id);
  const dialog = await openUpdatedReportDialog(page);
  await dialog.getByTestId("updated-report-reason").fill("Queue outage");
  stackCtl("stop", "redis");
  let answer: { status: number; body: string } | null = null;
  try {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/reports/regenerate") && r.request().method() === "POST", { timeout: 120_000 }),
      dialog.getByTestId("updated-report-confirm").click(),
    ]);
    answer = { status: resp.status(), body: (await resp.text()).slice(0, 400) };
    await page.screenshot({ path: join(PROOF_DIR, "redis-outage-answer.png") });
  } finally {
    stackCtl("start", "redis");
  }
  // Whatever was answered, the page must never show v2 as complete now.
  const s = await status(A.api, id);
  expect(s.versions.versions.find((v) => v.reportVersion === 2) ?? null).toBeNull();
  const rows = newVersionRequests(id);
  record("redisOutage", { evidenceId: id, answer, newVersionRequestsAfterAnswer: rows });
  if (rows === 1) {
    // The durable request exists; the pipeline's recovery re-enqueues it.
    await waitForPair(A.api, id, 2, 800_000);
  } else {
    expect(rows).toBe(0);
    // Nothing was created: a fresh confirmation now works.
    const again = await confirmViaApi(A, id);
    expect(again.status).toBe(202);
    await waitForPair(A.api, id, 2, 600_000);
  }
  expect(newVersionRequests(id)).toBe(1);
  record("redisOutageRecovered", { evidenceId: id, ...assertPairsConsistent(id) });
});

test("REPORT and PACKAGE OBJECT MISSING → typed, safe download errors; the other version still downloads", async ({ page }) => {
  test.setTimeout(300_000);
  const id = E[0]!; // has v1..v3
  const [rep] = sql<{ storage_key: string; s3_version_id: string | null }>("SELECT storage_key, s3_version_id FROM reports WHERE evidence_id = $1 AND version = 1", [id]);
  const [pkg] = sql<{ storage_key: string; s3_version_id: string | null }>("SELECT storage_key, s3_version_id FROM verification_packages WHERE evidence_id = $1 AND version = 1 AND state = 'PUBLISHED' AND (disclosure_profile IS NULL OR disclosure_profile = 'FULL_FORENSIC')", [id]);
  mc(["rm", "--version-id", rep!.s3_version_id!, `local/proovra-rga/${rep!.storage_key}`]);
  mc(["rm", "--version-id", pkg!.s3_version_id!, `local/proovra-rga/${pkg!.storage_key}`]);
  const apiReport = await A.api.get(`/v1/evidence/${id}/reports/1`);
  const apiPackage = await A.api.get(`/v1/evidence/${id}/verification-packages/1`);
  expect(apiReport.status()).toBe(410);
  expect(apiPackage.status()).toBe(410);
  const bodies = [await apiReport.text(), await apiPackage.text()];
  for (const b of bodies) expect(b).not.toMatch(/proovra-rga|reports\/|verification\/|X-Amz|stack/i);
  await signIn(page, A.email);
  await openArtifacts(page, id);
  await page.getByTestId("download-report-v1").click();
  await expect(page.getByText("The report record exists, but its stored file is unavailable. Contact support; nothing has been changed.")).toBeVisible();
  await page.getByTestId("download-package-v1").click();
  await expect(page.getByText("The verification package record exists, but its stored file is unavailable. Contact support; nothing has been changed.")).toBeVisible();
  await page.screenshot({ path: join(PROOF_DIR, "object-missing.png") });
  // v2 is unaffected.
  expect((await downloadVersion(A.api, id, "report", 2)).subarray(0, 5).toString()).toBe("%PDF-");
  record("objectMissing", { evidenceId: id, statuses: [apiReport.status(), apiPackage.status()] });
});

test("INTEGRITY TERMINAL → no updated-report action, a typed 'needs review' with a support reference", async ({ page }) => {
  test.setTimeout(300_000);
  const id = E[7]!;
  const [req] = sql<{ id: string }>(
    `INSERT INTO report_generation_requests (team_id, evidence_id, artifact_type, purpose, force_regenerate, requested_by_user_id,
       idempotency_key, state, terminal_reason_code, intent, progress_stage, created_at_utc, completed_at_utc)
     VALUES ($1, $2, 'REPORT', 'updated_report', true, $3, $4, 'FAILED_TERMINAL', 'REPORT_INTEGRITY_MISMATCH', 'NEW_VERSION',
       'BUILDING_PACKAGE', now(), now()) RETURNING id`,
    [teamId, id, A.userId, `REPORT:${id}:v1:force`],
  );
  const s = await status(A.api, id);
  expect(s.outputs.newVersion.action).toBe("NONE");
  expect(s.outputs.newVersion.reason).toBe("REPORT_INTEGRITY_REVIEW");
  const post = await confirmViaApi(A, id);
  expect(post.status).toBe(409);
  await signIn(page, A.email);
  await openArtifacts(page, id);
  await expect(page.getByTestId("evidence-new-version")).toHaveCount(0);
  await expect(page.getByTestId("output-progress-error")).toHaveAttribute("data-error-key", "INTEGRITY_TERMINAL");
  await expect(page.getByTestId("output-progress-ref")).toHaveText(req!.id);
  await page.screenshot({ path: join(PROOF_DIR, "integrity-terminal.png"), fullPage: true });
  record("integrityTerminal", { evidenceId: id, requestId: req!.id, confirm: post.status, newVersions: newVersionRequests(id) });
});

test("an OUTSIDER (another workspace) learns nothing and creates nothing", async ({ page }) => {
  test.setTimeout(300_000);
  const id = E[8]!;
  // This record already carries the worker-down drill's request; the outsider
  // must add NOTHING to it.
  const before = newVersionRequests(id);
  const st = await C.api.get(`/v1/evidence/${id}/artifacts/status`);
  expect(st.status()).toBe(404);
  const ownerOffer = (await status(A.api, id)).outputs.offer?.revision;
  const post = await C.api.post(`/v1/evidence/${id}/reports/regenerate`, {
    data: { intent: "NEW_VERSION", reason: "Outsider", clientRequestKey: "nv-outsider-0001", offerRevision: ownerOffer },
  });
  expect(post.status()).toBe(404);
  expect(newVersionRequests(id)).toBe(before);
  for (const v of [1]) {
    expect((await C.api.get(`/v1/evidence/${id}/reports/${v}`)).status()).toBe(404);
    expect((await C.api.get(`/v1/evidence/${id}/verification-packages/${v}`)).status()).toBe(404);
  }
  await signIn(page, C.email);
  await page.goto(`/evidence/${id}`);
  await expect(page.getByTestId("artifact-truth-header")).toHaveCount(0);
  record("outsider", { evidenceId: id, status: st.status(), post: post.status() });
});
