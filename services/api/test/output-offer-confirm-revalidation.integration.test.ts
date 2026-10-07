/**
 * RGA-02 — CONFIRM-TIME OFFER REVALIDATION, proven through the REAL route
 * (`POST /v1/evidence/:id/reports/regenerate`) against live PostgreSQL 16 + Redis.
 *
 * Each case reads the signed offer from `GET /artifacts/status` (what a
 * confirmation dialog shows), changes ONE thing the way it changes in the
 * product, then confirms with the revision it was shown. The server must refuse
 * (409 OUTPUT_OFFER_STALE, naming what changed) and create NOTHING — no request
 * row, no job — or, for permission/membership, refuse with its typed answer.
 * The unchanged case is accepted exactly once; a replay with the same client key
 * is answered from the first request.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Status = {
  outputs: {
    newVersion: { action: string; reason: string | null; currentVersion: number | null; nextVersion: number | null };
    offer: { revision: string; operation: string; targetVersion: number | null; reasonRequired: boolean; creditEffect: { kind: string } } | null;
    freshness: { hasNewerFacts: boolean; changes: Array<{ code: string }> };
    trust: { tsa: { status: string | null; validated: boolean }; ots: { status: string | null } };
    activeRequest: { requestId: string; state: string; progress: { currentStep: string } } | null;
  };
  versions: { versions: Array<{ reportVersion: number; latest: boolean; package: { version: number } | null }> };
};

describe("RGA-02 confirm-time offer revalidation (live PostgreSQL 16 + Redis, real route)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let offerSvc: typeof import("../src/services/reports/output-offer.service.js");
  let recovery: typeof import("../src/services/reports/output-recovery.service.js");
  const SHA = "a".repeat(64);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    offerSvc = await import("../src/services/reports/output-offer.service.js");
    recovery = await import("../src/services/reports/output-recovery.service.js");
    for (const t of [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId]) {
      const team = await prisma.team.update({
        where: { id: t },
        data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never,
        select: { organizationId: true },
      });
      await prisma.organization.update({ where: { id: team.organizationId }, data: { status: "ACTIVE" } as never });
    }
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  /** A REPORTED record with the complete pair v1, issued while TSA was NOT validated and OTS pending. */
  async function seedV1(team: "teamA" | "teamB" = "teamA"): Promise<string> {
    const evidenceId = randomUUID();
    const f = harness.fixtures[team];
    const org = (await prisma.team.findUnique({ where: { id: f.teamId }, select: { organizationId: true } }))!.organizationId;
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        ownerUserId: f.ownerUserId,
        teamId: f.teamId,
        organizationId: org,
        type: "DOCUMENT",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        latestReportVersion: 1,
        tsaStatus: "FAILED",
        tsaFailureCode: "tsa_trust_anchor_unconfigured",
        otsStatus: "PENDING",
        sizeBytes: BigInt(4096),
        updatedAt: new Date(),
      } as never,
    });
    const generatedAtUtc = new Date(Date.now() - 120_000);
    await prisma.report.create({
      data: {
        evidenceId, version: 1, storageBucket: "b", storageKey: `reports/${evidenceId}/v1/x.pdf`,
        generatedAtUtc, sizeBytes: BigInt(1024), pdfSha256: SHA, s3VersionId: "v1", issueKind: "FIRST_ISSUE",
        custodyThroughSequence: 0,
      } as never,
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId, version: 1, storageBucket: "b", storageKey: `verification/${evidenceId}/v1/x.zip`,
        generatedAtUtc, reportVersion: 1, reportSha256: SHA, sizeBytes: BigInt(2048),
      } as never,
    });
    return evidenceId;
  }

  async function status(evidenceId: string, token = harness.fixtures.teamA.ownerToken): Promise<Status> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/artifacts/status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Status;
  }

  async function confirm(
    evidenceId: string,
    body: Record<string, unknown>,
    token = harness.fixtures.teamA.ownerToken,
  ) {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/evidence/${evidenceId}/reports/regenerate`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ intent: "NEW_VERSION", reason: "Document later verification facts", clientRequestKey: `nv-${randomUUID()}`, ...body }),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  const requestCount = (evidenceId: string) => prisma.reportGenerationRequest.count({ where: { evidenceId } });

  async function expectStale(evidenceId: string, revision: string, change: string, token?: string) {
    const before = await requestCount(evidenceId);
    const r = await confirm(evidenceId, { offerRevision: revision }, token);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe("OUTPUT_OFFER_STALE");
    expect(r.body.changes as string[]).toContain(change);
    expect(((r.body.details as { changeMessages: string[] }).changeMessages ?? []).length).toBeGreaterThan(0);
    expect(await requestCount(evidenceId)).toBe(before);
    return r.body.changes as string[];
  }

  it("the status read carries a signed offer bound to the record, with server-derived freshness", async () => {
    const id = await seedV1();
    const s = await status(id);
    expect(s.outputs.newVersion.action).toBe("CREATE_NEW_VERSION");
    expect(s.outputs.offer?.operation).toBe("NEW_VERSION");
    expect(s.outputs.offer?.targetVersion).toBe(2);
    expect(s.outputs.offer?.reasonRequired).toBe(true);
    expect(s.outputs.offer?.creditEffect.kind).toBe("NONE");
    expect(s.outputs.offer?.revision).toMatch(/^ofr1\./);
    expect(s.outputs.trust.tsa).toMatchObject({ status: "FAILED", validated: false });
    expect(s.outputs.freshness.hasNewerFacts).toBe(false);
    expect(s.versions.versions.map((v) => [v.reportVersion, v.latest, v.package?.version])).toEqual([[1, true, 1]]);
  });

  it("an unchanged confirmation is ACCEPTED once; the same client key replays it; the replayed OFFER with a new key is stale", async () => {
    const id = await seedV1();
    const s = await status(id);
    const key = `nv-${randomUUID()}`;
    const first = await confirm(id, { offerRevision: s.outputs.offer!.revision, clientRequestKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.operation).toBe("NEW_VERSION");
    expect(first.body.requestId).toBeTruthy();
    const again = await confirm(id, { offerRevision: s.outputs.offer!.revision, clientRequestKey: key });
    expect(again.status).toBe(202);
    expect(again.body.requestId).toBe(first.body.requestId);
    expect(await requestCount(id)).toBe(1);
    await expectStale(id, s.outputs.offer!.revision, "REQUEST_STATE_CHANGED");
    const after = await status(id);
    expect(after.outputs.activeRequest?.requestId).toBe(first.body.requestId);
    expect(after.outputs.newVersion.reason).toBe("IN_PROGRESS");
  });

  it("TSA becomes validated while the dialog is open → stale (TSA_CHANGED); freshness then names it", async () => {
    const id = await seedV1();
    const s = await status(id);
    await prisma.evidence.update({
      where: { id },
      data: { tsaStatus: "STAMPED", tsaValidatedAtUtc: new Date(), tsaFailureCode: null } as never,
    });
    await expectStale(id, s.outputs.offer!.revision, "TSA_CHANGED");
    const fresh = await status(id);
    expect(fresh.outputs.freshness.changes.map((c) => c.code)).toContain("TSA_VALIDATED_AFTER_REPORT");
    expect(fresh.outputs.trust.tsa.validated).toBe(true);
  });

  it("OTS becomes anchored → stale (OTS_CHANGED)", async () => {
    const id = await seedV1();
    const s = await status(id);
    await prisma.evidence.update({
      where: { id },
      data: { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsAnchorCheck: "PROOF_STRUCTURE" } as never,
    });
    await expectStale(id, s.outputs.offer!.revision, "OTS_CHANGED");
    expect((await status(id)).outputs.freshness.changes.map((c) => c.code)).toContain("OTS_ANCHORED_AFTER_REPORT");
  });

  it("the latest report advances (another member issued v2) → stale (LATEST_REPORT_CHANGED)", async () => {
    const id = await seedV1();
    const s = await status(id);
    const at = new Date();
    await prisma.report.create({
      data: { evidenceId: id, version: 2, storageBucket: "b", storageKey: `reports/${id}/v2/x.pdf`, generatedAtUtc: at, sizeBytes: BigInt(1024), pdfSha256: "b".repeat(64), issueKind: "UPDATED_REPORT", previousReportVersion: 1 } as never,
    });
    await prisma.verificationPackage.create({
      data: { evidenceId: id, version: 2, storageBucket: "b", storageKey: `verification/${id}/v2/x.zip`, generatedAtUtc: at, reportVersion: 2, reportSha256: "b".repeat(64), sizeBytes: BigInt(2048) } as never,
    });
    await expectStale(id, s.outputs.offer!.revision, "LATEST_REPORT_CHANGED");
  });

  it("another output request begins → stale (REQUEST_STATE_CHANGED); it completing changes it again", async () => {
    const id = await seedV1();
    const s = await status(id);
    const row = await prisma.reportGenerationRequest.create({
      data: {
        teamId: harness.fixtures.teamA.teamId, evidenceId: id, artifactType: "VERIFICATION_PACKAGE", purpose: "package_recovery",
        requestedByUserId: harness.fixtures.teamA.adminUserId, idempotencyKey: `PKG:${id}:${randomUUID()}`, state: "QUEUED",
        reportVersion: 1, intent: "RECOVER",
      } as never,
    });
    await expectStale(id, s.outputs.offer!.revision, "REQUEST_STATE_CHANGED");
    const during = await status(id);
    await prisma.reportGenerationRequest.update({ where: { id: row.id }, data: { state: "SUCCEEDED", completedAtUtc: new Date() } as never });
    await expectStale(id, during.outputs.offer!.revision, "REQUEST_STATE_CHANGED");
  });

  it("a technical terminal appears for an attempt beyond v1 → stale", async () => {
    const id = await seedV1();
    const s = await status(id);
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: harness.fixtures.teamA.teamId, evidenceId: id, artifactType: "REPORT", purpose: "updated_report", forceRegenerate: true,
        requestedByUserId: harness.fixtures.teamA.ownerUserId, idempotencyKey: `REPORT:${id}:v1:force`, state: "FAILED_TERMINAL",
        terminalReasonCode: "RENDER_TIMEOUT", intent: "NEW_VERSION",
      } as never,
    });
    await expectStale(id, s.outputs.offer!.revision, "REQUEST_STATE_CHANGED");
  });

  it("permission removed while open → 403 typed refusal; membership removed → 404; neither creates anything", async () => {
    const id = await seedV1();
    const adminId = harness.fixtures.teamA.adminUserId;
    const s = await status(id, harness.fixtures.teamA.adminToken);
    expect(s.outputs.offer).not.toBeNull();
    const member = await prisma.teamMember.findFirst({ where: { teamId: harness.fixtures.teamA.teamId, userId: adminId } });
    try {
      await prisma.teamMember.update({ where: { id: member!.id }, data: { role: "VIEWER" } as never });
      const before = await requestCount(id);
      const denied = await confirm(id, { offerRevision: s.outputs.offer!.revision }, harness.fixtures.teamA.adminToken);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("GENERATION_NOT_PERMITTED");
      await prisma.teamMember.update({ where: { id: member!.id }, data: { role: member!.role, status: "REVOKED", revokedAtUtc: new Date() } as never });
      const gone = await confirm(id, { offerRevision: s.outputs.offer!.revision }, harness.fixtures.teamA.adminToken);
      expect(gone.status).toBe(404);
      expect(await requestCount(id)).toBe(before);
    } finally {
      await prisma.teamMember.update({ where: { id: member!.id }, data: { role: member!.role, status: "ACTIVE", revokedAtUtc: null } as never });
    }
  });

  it("the binding re-derives callerMayGenerate: a revision minted while permitted is stale once it is not (service level)", async () => {
    const id = await seedV1();
    const loaded = (await recovery.loadEvidenceOutputFacts({ evidenceIds: [id], callerUserId: harness.fixtures.teamA.adminUserId, includeNewVersionEstimate: true })).get(id)!;
    const reportable = await offerSvc.loadReportableFacts(id);
    const shown = offerSvc.buildOutputOfferBinding(loaded, reportable, harness.fixtures.teamA.adminUserId);
    const { revision } = offerSvc.signOutputOffer(shown);
    const changed = { ...shown, callerMayGenerate: false };
    const check = offerSvc.checkOutputOffer(revision, changed);
    expect(check).toEqual({ ok: false, changes: ["PERMISSION_CHANGED"] });
  });

  it("plan eligibility changes → stale (ELIGIBILITY_CHANGED or the action is withdrawn)", async () => {
    const id = await seedV1();
    const s = await status(id);
    try {
      await prisma.team.update({ where: { id: harness.fixtures.teamA.teamId }, data: { billingPlan: "FREE" } as never });
      const before = await requestCount(id);
      const r = await confirm(id, { offerRevision: s.outputs.offer!.revision });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("OUTPUT_OFFER_STALE");
      expect(r.body.changes as string[]).toEqual(expect.arrayContaining(["ACTIONS_CHANGED"]));
      expect(await requestCount(id)).toBe(before);
    } finally {
      await prisma.team.update({ where: { id: harness.fixtures.teamA.teamId }, data: { billingPlan: "TEAM" } as never });
    }
  });

  it("the storage effect changes → stale (STORAGE_CHANGED)", async () => {
    const id = await seedV1();
    const s = await status(id);
    await prisma.verificationPackage.updateMany({
      where: { evidenceId: id, version: 1 },
      data: { sizeBytes: BigInt(9_999_999) },
    });
    await expectStale(id, s.outputs.offer!.revision, "STORAGE_CHANGED");
  });

  it("an EXPIRED offer is refused even when nothing else changed", async () => {
    const id = await seedV1();
    const loaded = (await recovery.loadEvidenceOutputFacts({ evidenceIds: [id], callerUserId: harness.fixtures.teamA.ownerUserId, includeNewVersionEstimate: true })).get(id)!;
    const reportable = await offerSvc.loadReportableFacts(id);
    const old = offerSvc.signOutputOffer(
      offerSvc.buildOutputOfferBinding(loaded, reportable, harness.fixtures.teamA.ownerUserId),
      Date.now() - 16 * 60 * 1000,
    );
    const changes = await expectStale(id, old.revision, "OFFER_EXPIRED");
    expect(changes).toEqual(["OFFER_EXPIRED"]);
  });

  it("evidence substitution, cross-workspace substitution and a tampered revision are refused", async () => {
    const a1 = await seedV1();
    const a2 = await seedV1();
    const b1 = await seedV1("teamB");
    const sA1 = await status(a1);
    await expectStale(a2, sA1.outputs.offer!.revision, "SUBJECT_MISMATCH");
    const sB1 = await status(b1, harness.fixtures.teamB.ownerToken);
    await expectStale(a1, sB1.outputs.offer!.revision, "SUBJECT_MISMATCH");
    // Another person's revision for the same record.
    const sAdmin = await status(a1, harness.fixtures.teamA.adminToken);
    await expectStale(a1, sAdmin.outputs.offer!.revision, "SUBJECT_MISMATCH");
    const parts = sA1.outputs.offer!.revision.split(".");
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    await expectStale(a1, tampered, "OFFER_INVALID");
  });

  it("an updated report WITHOUT a revision is refused (OUTPUT_OFFER_REQUIRED) and creates nothing", async () => {
    const id = await seedV1();
    const r = await confirm(id, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("OUTPUT_OFFER_REQUIRED");
    expect(await requestCount(id)).toBe(0);
  });

  it("20 concurrent confirmations of one revision create exactly ONE request and one target version", async () => {
    const id = await seedV1();
    const s = await status(id);
    const key = `nv-${randomUUID()}`;
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => confirm(id, { offerRevision: s.outputs.offer!.revision, clientRequestKey: key })),
    );
    const accepted = answers.filter((a) => a.status === 202);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    // Every other answer is a safe refusal: a replay of the same request, the
    // now-stale offer, or the rate limit — never a second request.
    for (const a of answers) expect([202, 409, 429]).toContain(a.status);
    expect(new Set(accepted.map((a) => a.body.requestId)).size).toBe(1);
    expect(await requestCount(id)).toBe(1);
    const rows = await prisma.reportGenerationRequest.findMany({ where: { evidenceId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intent).toBe("NEW_VERSION");
  });
});
