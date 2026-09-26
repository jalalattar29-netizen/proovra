/**
 * THE ARTIFACT ACTION CONTRACT — over real HTTP, against live PostgreSQL 16.
 *
 * Approved decisions D1–D6 (2026-09-26), asserted where the product decides
 * them: `GET /v1/evidence/:id/artifacts/status` (what a surface may offer) and
 * `POST /v1/evidence/:id/reports/regenerate` (what the server does when it is
 * taken). The worker is not involved here; the rows it would write are
 * written directly, so every state in the decision matrix is reachable
 * deterministically.
 *
 *   A  both READY               no recovery verb; separate CREATE_NEW_VERSION
 *                               with versions and a storage ESTIMATE
 *   B  package, no report       consistency review, no verb
 *   C  report, no package       RECOVER the package only; POST builds a
 *                               PACKAGE-ONLY request, never a new report
 *   E  package failed (retry)   RETRY the package
 *   F  no report, failed        RETRY; exhausted → ESCALATED_TO_OPERATOR
 *   G  work in flight           no verb, progress + poll interval, the older
 *                               version stays downloadable
 *   K  newer attempt exhausted  disclosed beside the READY report; no dead
 *                               button, no new version
 *   v2/v1 pairing               package v1 does not complete report v2
 *   restrictions                legal hold (new version only), trash,
 *                               suspended organization, not finalized,
 *                               integrity failed
 *   D5                          viewer 403, outsider 404, zero side effects
 *   D6                          idempotency key, lost-response replay,
 *                               rate limits
 *   D3                          operator supersession needs a reason
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Output = {
  state: string;
  generation: string;
  action: string;
  actionUnavailableReason: string | null;
  operation: string | null;
  version: number | null;
  latestAvailableVersion: number | null;
};
type Status = {
  outputs: {
    report: Output;
    verificationPackage: Output;
    newVersion: {
      action: string;
      reason: string | null;
      currentVersion: number | null;
      nextVersion: number | null;
      estimate: { estimatedBytes: string; basis: string; fitsStorage: boolean | null } | null;
    };
    pollIntervalMs: number | null;
  };
  report: { available: boolean; version: number | null };
  verificationPackage: { available: boolean; version: number | null };
};

describe("artifact action contract (live PostgreSQL 16, real HTTP)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 180_000);

  const createdEvidence: string[] = [];

  afterAll(async () => {
    // Leave nothing for another suite's global sweeps to find.
    if (createdEvidence.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: createdEvidence } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await clearRates();
  });

  const A = () => harness.fixtures.teamA;

  async function evidence(
    over: { status?: string; lifecycleState?: string; teamId?: string; ownerUserId?: string } = {},
  ): Promise<string> {
    const teamId = over.teamId ?? A().teamId;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: "Action contract fixture",
        type: "PHOTO",
        status: (over.status ?? "REPORTED") as never,
        lifecycleState: (over.lifecycleState ?? "ACTIVE") as never,
        teamId,
        organizationId: team.organizationId,
        ownerUserId: over.ownerUserId ?? team.ownerUserId,
        sizeBytes: 5_000n,
      },
      select: { id: true },
    });
    createdEvidence.push(row.id);
    return row.id;
  }

  async function report(evidenceId: string, version: number, at = new Date()) {
    await prisma.report.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `reports/${evidenceId}/v${version}.pdf`,
        generatedAtUtc: at,
        sizeBytes: 1_000n,
      },
    });
  }
  async function pkg(evidenceId: string, version: number) {
    await prisma.verificationPackage.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `verification/${evidenceId}/v${version}.zip`,
        generatedAtUtc: new Date(),
        sizeBytes: 9_000n,
        reportVersion: version,
      },
    });
  }
  async function request(
    evidenceId: string,
    state: string,
    over: { artifactType?: string; terminalReasonCode?: string | null; createdAtUtc?: Date; forceRegenerate?: boolean } = {},
  ) {
    return prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId,
        artifactType: over.artifactType ?? "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: over.forceRegenerate ?? false,
        requestedByMachineId: "contract-test",
        expectedPolicyVersion: 0,
        idempotencyKey: `CONTRACT:${randomUUID()}`,
        state,
        terminalReasonCode: over.terminalReasonCode ?? null,
        ...(over.createdAtUtc ? { createdAtUtc: over.createdAtUtc } : {}),
      },
      select: { id: true },
    });
  }

  const get = (token: string, url: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (token: string, id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/reports/regenerate`,
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: body,
    });
  async function status(id: string, token = A().ownerToken): Promise<Status> {
    const res = await get(token, `/v1/evidence/${id}/artifacts/status`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Status;
  }
  const requestCount = (evidenceId: string) =>
    prisma.reportGenerationRequest.count({ where: { evidenceId } });

  // -------------------------------------------------------------------------
  // THE DECISION MATRIX
  // -------------------------------------------------------------------------
  it("A — both READY: no recovery verb; CREATE_NEW_VERSION is separate, with versions and an estimate", async () => {
    const id = await evidence();
    await report(id, 1);
    await pkg(id, 1);
    const s = await status(id);
    expect(s.outputs.report).toMatchObject({ state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED" });
    expect(s.outputs.verificationPackage).toMatchObject({ state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED" });
    expect(s.outputs.newVersion).toMatchObject({ action: "CREATE_NEW_VERSION", currentVersion: 1, nextVersion: 2 });
    expect(s.outputs.newVersion.estimate).toMatchObject({ estimatedBytes: "10000", basis: "PREVIOUS_PAIR" });
    expect(s.outputs.pollIntervalMs).toBeNull();

    // Nothing to recover: no request row, and the answer says so.
    const res = await post(A().ownerToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "NOTHING_TO_RECOVER", reason: "NOT_REQUIRED" });
    expect(await requestCount(id)).toBe(0);
  });

  it("C — report READY, package missing: RECOVER the package only; the POST creates a package-only request", async () => {
    const id = await evidence();
    await report(id, 1);
    const s = await status(id);
    expect(s.outputs.report).toMatchObject({ action: "NONE", actionUnavailableReason: "NOT_REQUIRED" });
    expect(s.outputs.verificationPackage).toMatchObject({
      state: "ELIGIBLE_NOT_GENERATED",
      action: "RECOVER",
      operation: "PACKAGE_RECOVERY",
    });
    expect(s.outputs.newVersion).toMatchObject({ action: "NONE", reason: "PAIR_INCOMPLETE" });

    const res = await post(A().ownerToken, id);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ operation: "PACKAGE_RECOVERY", outcome: "ENQUEUED" });
    const rows = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: id },
      select: { artifactType: true, reportVersion: true, forceRegenerate: true, intent: true },
    });
    expect(rows).toEqual([{ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, forceRegenerate: false, intent: "RECOVER" }]);
  });

  it("E — package failed retryably: RETRY the package, re-running the same request", async () => {
    const id = await evidence();
    await report(id, 1);
    const failed = await request(id, "FAILED_RETRYABLE", { terminalReasonCode: "VERIFICATION_PACKAGE_INCOMPLETE_STORE" });
    const s = await status(id);
    expect(s.outputs.verificationPackage).toMatchObject({ action: "RETRY", operation: "PACKAGE_RECOVERY" });
    expect(s.outputs.pollIntervalMs).toBe(30_000);
    const res = await post(A().ownerToken, id, { intent: "RETRY" });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ requestId: failed.id });
    expect(await requestCount(id), "no second request identity").toBe(1);
  });

  it("F — no report: retryable failure offers RETRY; an exhausted technical failure escalates with no button", async () => {
    const id = await evidence({ status: "SIGNED" });
    await request(id, "FAILED_RETRYABLE", { terminalReasonCode: "RENDER_TIMEOUT" });
    expect((await status(id)).outputs.report).toMatchObject({ action: "RETRY" });

    const id2 = await evidence({ status: "SIGNED" });
    await request(id2, "FAILED_TERMINAL", { terminalReasonCode: "retry_budget_exhausted" });
    const s = await status(id2);
    expect(s.outputs.report).toMatchObject({
      state: "TERMINAL_FAILURE",
      action: "NONE",
      actionUnavailableReason: "ESCALATED_TO_OPERATOR",
    });
    const before = await requestCount(id2);
    const res = await post(A().ownerToken, id2);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ outcome: "NOT_RECOVERABLE", reason: "ESCALATED_TO_OPERATOR" });
    expect(await requestCount(id2)).toBe(before);
  });

  it("G — a new version in flight: no verb, progress and a poll interval, and the older version stays downloadable", async () => {
    const id = await evidence();
    await report(id, 1, new Date(Date.now() - 60_000));
    await pkg(id, 1);
    await request(id, "PROCESSING", { forceRegenerate: true });
    const s = await status(id);
    expect(s.outputs.report).toMatchObject({ state: "READY", generation: "PROCESSING", action: "NONE", actionUnavailableReason: "IN_PROGRESS" });
    expect(s.outputs.verificationPackage).toMatchObject({ state: "READY", action: "NONE", actionUnavailableReason: "IN_PROGRESS" });
    expect(s.outputs.newVersion).toMatchObject({ action: "NONE", reason: "IN_PROGRESS" });
    expect(s.outputs.pollIntervalMs).toBe(3_000);
    expect(s.report).toMatchObject({ available: true, version: 1 });
    expect(s.verificationPackage).toMatchObject({ available: true, version: 1 });
  });

  it("K — a newer attempt exhausted beside a READY report: disclosed, escalated, no dead button, no new version", async () => {
    const id = await evidence();
    await report(id, 1, new Date(Date.now() - 60_000));
    await pkg(id, 1);
    await request(id, "FAILED_TERMINAL", { forceRegenerate: true, terminalReasonCode: "retry_budget_exhausted" });
    const s = await status(id);
    expect(s.outputs.report).toMatchObject({ state: "READY", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" });
    expect(s.outputs.newVersion).toMatchObject({ action: "NONE", reason: "ESCALATED_TO_OPERATOR" });
    expect(s.report.available).toBe(true);
    const res = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": `k-${randomUUID()}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "ESCALATED_TO_OPERATOR" });
  });

  it("B — a package with no report is a consistency case for review, not a regeneration", async () => {
    const id = await evidence();
    await pkg(id, 1);
    const s = await status(id);
    expect(s.outputs.report).toMatchObject({ action: "NONE", actionUnavailableReason: "CONSISTENCY_REVIEW_REQUIRED" });
    expect(s.outputs.verificationPackage.action).toBe("NONE");
  });

  it("report v2 with only package v1: the package output is NOT READY; v1 stays reachable by version; the latest download says so", async () => {
    const id = await evidence();
    await report(id, 1, new Date(Date.now() - 120_000));
    await pkg(id, 1);
    await report(id, 2, new Date(Date.now() - 60_000));
    const s = await status(id);
    expect(s.outputs.verificationPackage).toMatchObject({
      state: "ELIGIBLE_NOT_GENERATED",
      action: "RECOVER",
      version: null,
      latestAvailableVersion: 1,
    });
    expect(s.verificationPackage.available).toBe(false);
    const latest = await get(A().ownerToken, `/v1/evidence/${id}/verification-package`);
    expect(latest.statusCode).toBe(409);
    expect(latest.json()).toMatchObject({ latestAvailablePackageVersion: 1, latestReportVersion: 2 });
  });

  // -------------------------------------------------------------------------
  // RESTRICTIONS
  // -------------------------------------------------------------------------
  it("legal hold: recovery of a missing package is still offered; a new version is not", async () => {
    const id = await evidence();
    await report(id, 1);
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: A().teamId,
        evidenceId: id,
        scope: "EVIDENCE",
        status: "ACTIVE",
        title: "Contract test hold",
        reason: "contract test",
        placedByUserId: (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { ownerUserId: true } })).ownerUserId,
      } as never,
    });
    const s = await status(id);
    expect(s.outputs.verificationPackage.action).toBe("RECOVER");
    await pkg(id, 1);
    const s2 = await status(id);
    expect(s2.outputs.newVersion).toMatchObject({ action: "NONE", reason: "LEGAL_HOLD_ACTIVE" });
    const res = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": `k-${randomUUID()}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "LEGAL_HOLD_ACTIVE" });
  });

  it("trashed, not finalized and integrity-failed records offer nothing, each with its reason", async () => {
    const trashed = await evidence({ lifecycleState: "TRASHED" });
    await report(trashed, 1);
    expect((await status(trashed)).outputs.verificationPackage).toMatchObject({
      action: "NONE",
      actionUnavailableReason: "EVIDENCE_TRASHED",
    });
    const res = await post(A().ownerToken, trashed);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "EVIDENCE_TRASHED" });

    const draft = await evidence({ status: "CREATED" });
    expect((await status(draft)).outputs.report).toMatchObject({ action: "NONE", actionUnavailableReason: "NOT_FINALIZED" });

    const broken = await evidence({ status: "FAILED_HASH_MISMATCH" });
    expect((await status(broken)).outputs.report).toMatchObject({ action: "NONE", actionUnavailableReason: "INTEGRITY_FAILED" });
    expect((await post(A().ownerToken, broken)).statusCode).toBe(409);
  });

  it("a suspended organization withdraws every action with WORKSPACE_SUSPENDED", async () => {
    const id = await evidence();
    await report(id, 1);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "SUSPENDED" } });
    try {
      expect((await status(id)).outputs.verificationPackage).toMatchObject({
        action: "NONE",
        actionUnavailableReason: "WORKSPACE_SUSPENDED",
      });
    } finally {
      await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "ACTIVE" } });
    }
  });

  it("a Personal workspace record gets the same contract", async () => {
    const P = harness.fixtures.personal;
    await prisma.team.update({ where: { id: P.teamId }, data: { billingPlan: "PRO", billingStatus: "ACTIVE" } }).catch(() => null);
    const personalOwner = (await prisma.team.findUniqueOrThrow({ where: { id: P.teamId }, select: { ownerUserId: true } })).ownerUserId;
    const ent = await prisma.entitlement.findFirst({ where: { userId: personalOwner }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "PRO" } });
    else await prisma.entitlement.create({ data: { userId: personalOwner, plan: "PRO" } });
    const id = await evidence({ teamId: P.teamId });
    await report(id, 1);
    const s = await status(id, P.token);
    expect(s.outputs.verificationPackage).toMatchObject({ action: "RECOVER", operation: "PACKAGE_RECOVERY" });
  });

  // -------------------------------------------------------------------------
  // D5 — 403 for a reader without the permission, 404 for everyone else
  // -------------------------------------------------------------------------
  it("D5 — a viewer gets 403, an outsider 404 (same as a missing id), and neither leaves any trace", async () => {
    const id = await evidence();
    await report(id, 1);
    const before = await requestCount(id);

    const viewerStatus = await status(id, A().viewerToken);
    expect(viewerStatus.outputs.verificationPackage).toMatchObject({ action: "NONE", actionUnavailableReason: "PERMISSION_DENIED" });

    const viewer = await post(A().viewerToken, id);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toMatchObject({ code: "GENERATION_NOT_PERMITTED" });

    const outsider = await post(harness.fixtures.teamB.ownerToken, id);
    const missing = await post(harness.fixtures.teamB.ownerToken, randomUUID());
    expect(outsider.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(outsider.body).toBe(missing.body);

    expect(await requestCount(id)).toBe(before);
    expect(await prisma.report.count({ where: { evidenceId: id } })).toBe(1);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: id } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // D6 — explicit new version: idempotency, replay, limits
  // -------------------------------------------------------------------------
  it("D6 — a new version needs an idempotency key; a repeat after a lost response creates nothing new", async () => {
    const id = await evidence();
    await report(id, 1, new Date(Date.now() - 60_000));
    await pkg(id, 1);

    const noKey = await post(A().ownerToken, id, { intent: "NEW_VERSION" });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(await requestCount(id)).toBe(0);

    const key = `nv-${randomUUID()}`;
    const first = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": key });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ operation: "NEW_VERSION", outcome: "ENQUEUED" });
    const firstId = (first.json() as { requestId: string }).requestId;

    // The response is lost; meanwhile the work completes and v2 exists.
    await prisma.reportGenerationRequest.update({ where: { id: firstId }, data: { state: "SUCCEEDED" } });
    await report(id, 2);
    await pkg(id, 2);

    const replay = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": key });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ outcome: "REPLAYED", requestId: firstId });
    expect(await requestCount(id), "no second version request").toBe(1);
  });

  it("D6 — concurrent web and mobile recovery clicks produce ONE request", async () => {
    const id = await evidence();
    await report(id, 1);
    const [a, b] = await Promise.all([post(A().ownerToken, id), post(A().adminToken, id)]);
    expect([a.statusCode, b.statusCode].every((c) => c === 202)).toBe(true);
    expect(await requestCount(id)).toBe(1);
  });

  it("D6 — per-record new-version rate limit answers 429 and creates nothing", async () => {
    const prev = process.env.NEW_VERSION_RATE_LIMIT_PER_RECORD;
    process.env.NEW_VERSION_RATE_LIMIT_PER_RECORD = "1";
    try {
      const id = await evidence();
      await report(id, 1, new Date(Date.now() - 60_000));
      await pkg(id, 1);
      const first = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": `a-${randomUUID()}` });
      expect(first.statusCode).toBe(202);
      await prisma.reportGenerationRequest.updateMany({ where: { evidenceId: id }, data: { state: "SUCCEEDED" } });
      const second = await post(A().ownerToken, id, { intent: "NEW_VERSION" }, { "idempotency-key": `b-${randomUUID()}` });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(await requestCount(id)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.NEW_VERSION_RATE_LIMIT_PER_RECORD;
      else process.env.NEW_VERSION_RATE_LIMIT_PER_RECORD = prev;
    }
  });

  // -------------------------------------------------------------------------
  // D3 — operator supersession of an exhausted technical failure
  // -------------------------------------------------------------------------
  it("D3 — only an operator with a stated reason starts a new request beside an exhausted failure", async () => {
    const id = await evidence();
    await report(id, 1);
    // The package recovery was exhausted.
    const exhausted = await prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId: id,
        artifactType: "VERIFICATION_PACKAGE",
        purpose: "operator_regenerate",
        forceRegenerate: false,
        requestedByMachineId: "contract-test",
        expectedPolicyVersion: 0,
        idempotencyKey: `VERIFICATION_PACKAGE:${id}:v1`,
        state: "FAILED_TERMINAL",
        terminalReasonCode: "retry_budget_exhausted",
        reportVersion: 1,
      },
      select: { id: true },
    });
    expect((await status(id)).outputs.verificationPackage).toMatchObject({
      action: "NONE",
      actionUnavailableReason: "ESCALATED_TO_OPERATOR",
    });
    // A customer click cannot do it.
    expect((await post(A().ownerToken, id)).statusCode).toBe(409);

    const incident = await prisma.operationalIncident.create({
      data: {
        teamId: A().teamId,
        scope: "WORKSPACE",
        category: "PACKAGE",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: `PACKAGE:${id}:RETRY_BUDGET_EXHAUSTED`,
        title: "Package retry budget exhausted",
        safeSummary: "Exhausted.",
        relatedEvidenceId: id,
      } as never,
      select: { id: true },
    });
    const remediate = (token: string, body: Record<string, unknown>) =>
      harness.app.inject({
        method: "POST",
        url: `/v1/ops/incidents/${incident.id}/remediate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { teamId: A().teamId, actionId: "report.supersede_failed_generation", ...body },
      });

    expect((await remediate(A().ownerToken, {})).statusCode, "a reason is required").toBe(400);
    expect((await remediate(A().viewerToken, { reason: "viewer attempt" })).statusCode).toBe(403);
    const ok = await remediate(A().ownerToken, { reason: "Storage outage resolved; retrying once." });
    expect(ok.statusCode, ok.body).toBe(202);

    const rows = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: id },
      orderBy: { createdAtUtc: "asc" },
      select: { id: true, state: true, idempotencyKey: true, artifactType: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(exhausted.id);
    expect(rows[0]!.state, "the failed request is kept as history").toBe("FAILED_TERMINAL");
    expect(rows[1]!).toMatchObject({ artifactType: "VERIFICATION_PACKAGE", idempotencyKey: `VERIFICATION_PACKAGE:${id}:v1:s1` });

    const audits = await prisma.adminAuditLog.findMany({
      where: { action: "operations.remediation.report.supersede_failed_generation", resourceId: incident.id },
      orderBy: { createdAt: "asc" },
    });
    const success = audits.find((a) => a.outcome === "success");
    expect(success, "the supersession is audited").toBeTruthy();
    expect(JSON.stringify(success!.metadata)).toContain("Storage outage resolved");
    const timeline = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: incident.id, eventType: "remediation_queued" },
    });
    expect(timeline.safeMessage).toContain("Storage outage resolved");
  });

  it("D3 — an integrity failure is never superseded by an operator", async () => {
    const id = await evidence();
    await report(id, 1);
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId: id,
        artifactType: "VERIFICATION_PACKAGE",
        purpose: "operator_regenerate",
        requestedByMachineId: "contract-test",
        expectedPolicyVersion: 0,
        idempotencyKey: `VERIFICATION_PACKAGE:${id}:v1`,
        state: "FAILED_TERMINAL",
        terminalReasonCode: "REPORT_INTEGRITY_MISMATCH",
        reportVersion: 1,
      },
    });
    expect((await status(id)).outputs.verificationPackage).toMatchObject({
      action: "NONE",
      actionUnavailableReason: "REPORT_INTEGRITY_REVIEW",
    });
    const { requestOutputRecovery } = await import("../src/services/reports/output-recovery.service.js");
    const owner = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { ownerUserId: true } })).ownerUserId;
    const r = await requestOutputRecovery({
      evidenceId: id,
      actorUserId: owner,
      purpose: "operator_regenerate",
      regenerateReason: "test",
      operatorSupersede: true,
    });
    expect(r.kind).toBe("declined");
    expect(await requestCount(id)).toBe(1);
  });
});
