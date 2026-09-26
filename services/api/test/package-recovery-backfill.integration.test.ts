/**
 * HISTORICAL PACKAGE RECOVERY — discovery and approval-gated execution,
 * against live PostgreSQL 16 (the local integration stack; never production).
 *
 *   * the dry run classifies MISSING / FAILED / MISMATCHED gaps with the same
 *     decision every surface renders, excludes what must not be recovered,
 *     estimates storage (labelled as an estimate) and plans bounded batches;
 *   * it WRITES NOTHING — every table it could touch is fingerprinted before
 *     and after, and the object store double has no write methods at all;
 *   * it is deterministic (same plan hash on a re-run) and bounded/resumable;
 *   * execution refuses without the explicit environment switch, without a
 *     complete approval, and when the plan changed since it was approved;
 *   * an approved execution goes through the canonical executor with the
 *     named operator's own permission: package-only requests at the stored
 *     report version, no report requests, no new report versions, audited,
 *     and a second run of the same approval is refused (plan changed).
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** A read-only object store: the dry run has nothing to write with. */
const store = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; checksumSha256: string | null }>(),
  reads: 0,
}));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const notFound = (key: string) => {
    const err = new Error(`NoSuchKey: ${key}`) as Error & { name: string; $metadata: unknown };
    err.name = "NoSuchKey";
    err.$metadata = { httpStatusCode: 404 };
    return err;
  };
  return {
    ...actual,
    headObject: async (p: { bucket: string; key: string }) => {
      store.reads += 1;
      const o = store.objects.get(`${p.bucket}/${p.key}`);
      if (!o) throw notFound(p.key);
      return {
        sizeBytes: o.body.length,
        checksumSha256: o.checksumSha256,
        contentType: "application/pdf",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      store.reads += 1;
      const o = store.objects.get(`${p.bucket}/${p.key}`);
      if (!o) throw notFound(p.key);
      const { Readable } = await import("node:stream");
      return Readable.from([o.body]);
    },
  };
});

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sha256B64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");

describe("historical package recovery — dry run and approved execution (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/reports/package-recovery-backfill.service.js");
  const created: string[] = [];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/reports/package-recovery-backfill.service.js");
    for (const t of [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId]) {
      await prisma.team.update({ where: { id: t }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }

    const A = harness.fixtures.teamA.teamId;
    const B = harness.fixtures.teamB.teamId;
    // Each case is a record with a stored report; the store holds the bytes.
    ids.missing = await record(A, { reports: [1] });
    ids.mismatched = await record(A, { reports: [1, 2], packages: [1] });
    ids.failed = await record(A, { reports: [1], packageRequest: "FAILED_RETRYABLE" });
    ids.escalated = await record(A, { reports: [1], packageRequest: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted" });
    ids.objectMissing = await record(A, { reports: [1], storeObject: false });
    ids.unverifiable = await record(A, { reports: [1], recordHash: false, storeChecksum: false });
    ids.altered = await record(A, { reports: [1], alteredBytes: true });
    ids.trashed = await record(A, { reports: [1], lifecycleState: "TRASHED" });
    ids.complete = await record(A, { reports: [1], packages: [1] });
    ids.otherWorkspace = await record(B, { reports: [1] });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  async function record(
    teamId: string,
    o: {
      reports: number[];
      packages?: number[];
      packageRequest?: string;
      terminalReasonCode?: string;
      storeObject?: boolean;
      recordHash?: boolean;
      storeChecksum?: boolean;
      alteredBytes?: boolean;
      lifecycleState?: string;
    },
  ): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const ev = await prisma.evidence.create({
      data: {
        title: "Backfill fixture",
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: (o.lifecycleState ?? "ACTIVE") as never,
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        sizeBytes: 40_000n,
      },
      select: { id: true },
    });
    created.push(ev.id);
    for (const v of o.reports) {
      const bytes = Buffer.from(`%PDF-1.7 backfill fixture ${ev.id} v${v}\n`);
      const key = `reports/${ev.id}/v${v}.pdf`;
      if (o.storeObject !== false) {
        // Altered in place: same length, one byte different — only a full
        // hash can see it.
        const served = Buffer.from(bytes);
        if (o.alteredBytes) served[served.length - 2] = served[served.length - 2]! ^ 0x01;
        store.objects.set(`b/${key}`, {
          body: served,
          checksumSha256: o.storeChecksum === false ? null : sha256B64(served),
        });
      }
      await prisma.report.create({
        data: {
          evidenceId: ev.id,
          version: v,
          storageBucket: "b",
          storageKey: key,
          generatedAtUtc: new Date(Date.now() - (10 - v) * 60_000),
          sizeBytes: BigInt(bytes.length),
          pdfSha256: o.recordHash === false ? null : sha256Hex(bytes),
        },
      });
    }
    for (const v of o.packages ?? []) {
      await prisma.verificationPackage.create({
        data: {
          evidenceId: ev.id,
          version: v,
          storageBucket: "b",
          storageKey: `verification/${ev.id}/v${v}.zip`,
          generatedAtUtc: new Date(Date.now() - (10 - v) * 60_000 + 1_000),
          sizeBytes: 77_000n,
          reportVersion: v,
        },
      });
    }
    if (o.packageRequest) {
      const latest = Math.max(...o.reports);
      await prisma.reportGenerationRequest.create({
        data: {
          teamId,
          evidenceId: ev.id,
          artifactType: "VERIFICATION_PACKAGE",
          purpose: "operator_regenerate",
          forceRegenerate: false,
          requestedByMachineId: "backfill-test",
          expectedPolicyVersion: 0,
          idempotencyKey: `ARTIFACT:${ev.id}:v${latest}:${randomUUID()}`,
          state: o.packageRequest,
          terminalReasonCode: o.terminalReasonCode ?? null,
          reportVersion: latest,
          stage: "REPORT_COMMITTED",
        },
      });
    }
    return ev.id;
  }

  /** A content fingerprint of every table the backfill could touch. */
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = [
      "evidence",
      "reports",
      "verification_packages",
      "report_generation_requests",
      "admin_audit_logs",
      "operational_incidents",
    ];
    const out: Record<string, string> = {};
    for (const t of tables) {
      const exists = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`,
      );
      if (!exists[0]?.ok) continue;
      const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint; h: string | null }>>(
        `SELECT COUNT(*) AS n, md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))) AS h FROM ${t} x`,
      );
      out[t] = `${row!.n}:${row!.h}`;
    }
    return out;
  }

  const byId = (plan: Awaited<ReturnType<typeof svc.discoverPackageRecoveryCandidates>>) =>
    new Map(plan.candidates.map((c) => [c.evidenceId, c]));

  it("classifies MISSING / FAILED / MISMATCHED, excludes what must not run, and estimates storage", async () => {
    const plan = await svc.discoverPackageRecoveryCandidates({
      workspaceId: harness.fixtures.teamA.teamId,
      storageCheck: "head",
      batchSize: 2,
    });
    const c = byId(plan);
    expect(c.get(ids.missing)).toMatchObject({ category: "MISSING", disposition: "RECOVER", reportVersion: 1, reportStorage: "VERIFIABLE_RECORDED_HASH" });
    // The estimate: original evidence + the report it embeds.
    expect(BigInt(c.get(ids.missing)!.estimatedPackageBytes!)).toBeGreaterThan(40_000n);
    expect(c.get(ids.mismatched)).toMatchObject({ category: "MISMATCHED", disposition: "RECOVER", reportVersion: 2, olderPackageVersion: 1, estimatedPackageBytes: "77000" });
    expect(c.get(ids.failed)).toMatchObject({ category: "FAILED", disposition: "RETRY" });
    expect(c.get(ids.escalated)).toMatchObject({ disposition: "EXCLUDED", exclusionReason: "ESCALATED_TO_OPERATOR" });
    expect(c.get(ids.objectMissing)).toMatchObject({ disposition: "EXCLUDED", exclusionReason: "REPORT_OBJECT_MISSING" });
    expect(c.get(ids.unverifiable)).toMatchObject({ disposition: "EXCLUDED", exclusionReason: "REPORT_INTEGRITY_UNVERIFIABLE" });
    expect(c.get(ids.trashed)).toMatchObject({ disposition: "EXCLUDED", exclusionReason: "EVIDENCE_TRASHED" });
    // A complete pair is not a gap; another workspace is out of scope.
    expect(c.has(ids.complete)).toBe(false);
    expect(c.has(ids.otherWorkspace)).toBe(false);

    const mine = plan.candidates.filter((x) => created.includes(x.evidenceId));
    expect(mine.every((x) => x.workspaceId === harness.fixtures.teamA.teamId)).toBe(true);
    expect(plan.storageEstimate.label).toBe("ESTIMATE");
    expect(plan.batches.every((b) => b.evidenceIds.length <= 2)).toBe(true);
    const planned = new Set(plan.batches.flatMap((b) => b.evidenceIds));
    for (const k of ["missing", "mismatched", "failed"]) expect(planned.has(ids[k]!)).toBe(true);
    for (const k of ["escalated", "objectMissing", "unverifiable", "trashed"]) expect(planned.has(ids[k]!)).toBe(false);
    const ws = plan.workspaces.find((w) => w.workspaceId === harness.fixtures.teamA.teamId)!;
    expect(ws.recover + ws.retry).toBeGreaterThanOrEqual(3);

    const md = svc.renderPackageRecoveryPlanMarkdown(plan);
    expect(md).toContain(plan.planHash);
    expect(md).toContain("Estimated additional storage");
    expect(md).toContain("(estimate;");
    expect(md).toContain("ESCALATED_TO_OPERATOR");
  });

  it("a full check hashes the stored bytes and catches an altered report the HEAD check cannot", async () => {
    const head = byId(await svc.discoverPackageRecoveryCandidates({ workspaceId: harness.fixtures.teamA.teamId, storageCheck: "head" }));
    expect(head.get(ids.altered)).toMatchObject({ disposition: "RECOVER", reportStorage: "VERIFIABLE_RECORDED_HASH" });
    const full = byId(await svc.discoverPackageRecoveryCandidates({ workspaceId: harness.fixtures.teamA.teamId, storageCheck: "full" }));
    expect(full.get(ids.altered)).toMatchObject({ disposition: "EXCLUDED", exclusionReason: "REPORT_INTEGRITY_MISMATCH" });
    expect(full.get(ids.missing)).toMatchObject({ disposition: "RECOVER", reportStorage: "VERIFIED" });
  });

  it("the dry run writes NOTHING: every table it could touch is identical before and after", async () => {
    const before = await fingerprint();
    const readsBefore = store.reads;
    await svc.discoverPackageRecoveryCandidates({ storageCheck: "full", maxRecords: 5_000 });
    await svc.discoverPackageRecoveryCandidates({ workspaceId: harness.fixtures.teamA.teamId, storageCheck: "head" });
    expect(await fingerprint()).toEqual(before);
    // It did read the store — and the store double has no write method at all.
    expect(store.reads).toBeGreaterThan(readsBefore);
  });

  it("is deterministic and bounded: the same data gives the same plan hash; pages resume without gaps", async () => {
    const A = harness.fixtures.teamA.teamId;
    const one = await svc.discoverPackageRecoveryCandidates({ workspaceId: A });
    const two = await svc.discoverPackageRecoveryCandidates({ workspaceId: A });
    expect(two.planHash).toBe(one.planHash);
    expect(two.runId).not.toBe(one.runId);

    const all = one.candidates.map((c) => c.evidenceId);
    const first = await svc.discoverPackageRecoveryCandidates({ workspaceId: A, maxRecords: 3, pageSize: 2 });
    expect(first.candidates).toHaveLength(3);
    expect(first.truncated).toBe(true);
    const rest = await svc.discoverPackageRecoveryCandidates({ workspaceId: A, afterEvidenceId: first.nextCursor });
    expect([...first.candidates, ...rest.candidates].map((c) => c.evidenceId)).toEqual(all);
    // The bounds are clamped, never trusted.
    expect(svc.normalizeDryRunParameters({ maxRecords: 10_000_000, pageSize: 0, batchSize: -3 })).toMatchObject({
      maxRecords: 50_000,
      pageSize: 1,
      batchSize: 1,
    });
  });

  it("execution refuses without the switch, without a complete approval, and on a changed plan — writing nothing", async () => {
    const A = harness.fixtures.teamA.teamId;
    const plan = await svc.discoverPackageRecoveryCandidates({ workspaceId: A });
    const approval = {
      planHash: plan.planHash,
      parameters: plan.parameters,
      approvedBy: "Workspace owner",
      approvedAtUtc: new Date().toISOString(),
      reference: "TEST-APPROVAL-1",
      operators: { [A]: harness.fixtures.teamA.ownerUserId },
      pauseBetweenBatchesMs: 0,
    };
    const before = await fingerprint();
    const on = { [svc.PACKAGE_RECOVERY_EXECUTE_ENV]: svc.PACKAGE_RECOVERY_EXECUTE_ENV_VALUE };

    expect(await svc.executePackageRecoveryPlan(approval, {})).toEqual({ kind: "refused", reason: "EXECUTION_NOT_ENABLED" });
    expect(await svc.executePackageRecoveryPlan({ ...approval, reference: " " }, on)).toEqual({ kind: "refused", reason: "APPROVAL_INCOMPLETE" });
    expect(await svc.executePackageRecoveryPlan(null, on)).toEqual({ kind: "refused", reason: "APPROVAL_INCOMPLETE" });
    const stale = await svc.executePackageRecoveryPlan({ ...approval, planHash: "0".repeat(64) }, on);
    expect(stale).toMatchObject({ kind: "refused", reason: "PLAN_CHANGED" });
    expect(await fingerprint()).toEqual(before);
  });

  it("an approved execution uses the named operator's own permission, requests packages only, and cannot be replayed", async () => {
    const A = harness.fixtures.teamA.teamId;
    const on = { [svc.PACKAGE_RECOVERY_EXECUTE_ENV]: svc.PACKAGE_RECOVERY_EXECUTE_ENV_VALUE };
    const plan = await svc.discoverPackageRecoveryCandidates({ workspaceId: A });
    const base = {
      planHash: plan.planHash,
      parameters: plan.parameters,
      approvedBy: "Workspace owner",
      approvedAtUtc: new Date().toISOString(),
      reference: "TEST-APPROVAL-2",
      pauseBetweenBatchesMs: 0,
    };

    // A viewer holds no evidence.generate_report: the canonical check says no.
    const denied = await svc.executePackageRecoveryPlan({ ...base, operators: { [A]: harness.fixtures.teamA.viewerUserId } }, on);
    expect(denied.kind).toBe("executed");
    if (denied.kind !== "executed") return;
    expect(denied.results.find((r) => r.evidenceId === ids.missing)).toMatchObject({ reason: "PERMISSION_DENIED" });

    const reportsBefore = await prisma.report.count({ where: { evidenceId: { in: created } } });
    const reportRequestsBefore = await prisma.reportGenerationRequest.count({
      where: { evidenceId: { in: created }, artifactType: "REPORT" },
    });
    const run = await svc.executePackageRecoveryPlan({ ...base, operators: { [A]: harness.fixtures.teamA.ownerUserId } }, on);
    expect(run.kind).toBe("executed");
    if (run.kind !== "executed") return;
    const r = new Map(run.results.map((x) => [x.evidenceId, x]));
    expect(["ENQUEUED", "QUEUE_UNAVAILABLE"]).toContain(r.get(ids.missing)!.outcome);
    expect(["ENQUEUED", "QUEUE_UNAVAILABLE"]).toContain(r.get(ids.mismatched)!.outcome);
    // Excluded records were never attempted.
    expect(r.has(ids.escalated)).toBe(false);
    expect(r.has(ids.objectMissing)).toBe(false);

    // Package-only requests, at the stored report's version.
    for (const [k, v] of [["missing", 1], ["mismatched", 2]] as const) {
      const req = await prisma.reportGenerationRequest.findFirst({
        where: { evidenceId: ids[k], artifactType: "VERIFICATION_PACKAGE", requestedByUserId: harness.fixtures.teamA.ownerUserId },
        orderBy: { createdAtUtc: "desc" },
        select: { reportVersion: true, intent: true },
      });
      expect(req).toMatchObject({ reportVersion: v, intent: "RECOVER" });
    }
    expect(await prisma.report.count({ where: { evidenceId: { in: created } } })).toBe(reportsBefore);
    expect(
      await prisma.reportGenerationRequest.count({ where: { evidenceId: { in: created }, artifactType: "REPORT" } }),
    ).toBe(reportRequestsBefore);

    // Audited, per record, with the plan and the approval.
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "report.package_recovery_backfill.request", resourceId: ids.missing },
      orderBy: { createdAt: "desc" },
      select: { metadata: true, userId: true },
    });
    expect(audit?.userId).toBe(harness.fixtures.teamA.ownerUserId);
    expect(audit?.metadata).toMatchObject({ planHash: plan.planHash, approvalReference: "TEST-APPROVAL-2" });

    // The same approval cannot run twice: the work in flight changed the plan.
    const again = await svc.executePackageRecoveryPlan({ ...base, operators: { [A]: harness.fixtures.teamA.ownerUserId } }, on);
    expect(again).toMatchObject({ kind: "refused", reason: "PLAN_CHANGED" });
  });
});
