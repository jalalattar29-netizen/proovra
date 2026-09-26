/**
 * REPORT / VERIFICATION-PACKAGE RECOVERY — the real processor against live
 * PostgreSQL 16.
 *
 * The 2026-09-26 audit reproduced three defects with this exact harness:
 *
 *   AUDIT-A  the BullMQ retry of a request whose package failed ended
 *            SUCCEEDED "generated" with no package and no package build
 *            attempt (`REPORT_ALREADY_GENERATED` was swallowed as success);
 *   AUDIT-B  the stranded-request reconciler closed that request as
 *            SUCCEEDED because a newer REPORT existed, without asking about
 *            the package;
 *   AUDIT-C  every retry of a forced request minted another report version
 *            (v2, v3, v4 …) while its package kept failing.
 *
 * These cases pin the corrected contract:
 *
 *   * a package-only recovery embeds the EXACT stored report bytes, after
 *     verifying them, and never mints a report version;
 *   * one request commits at most one report version, however often it is
 *     retried, and a retry resumes from the durable stage it reached;
 *   * a request is SUCCEEDED only when the outputs it owns exist as a PAIR at
 *     the same version;
 *   * the stored report is never replaced silently — a missing, unverifiable
 *     or altered report is an explicit terminal state.
 *
 * WHAT IS REAL: PostgreSQL, the processor, the report-generation authority,
 * the reconciler, `createVerificationPackage` (a real ZIP, streamed), the
 * staging → canonical publication. WHAT IS DOUBLED: object storage (an
 * in-process map, see the partial-failure suite for why), the Chromium PDF
 * renderer (deterministic bytes that DIFFER on every render, so "the package
 * holds the stored bytes, not a re-render" is observable), and one
 * controllable failure seam in front of the real package builder.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { readZipEntries } from "./_zip-entries.js";

/** Failure seams, all off by default. Test doubles, not production switches. */
const seam = vi.hoisted(() => ({
  packageBuildFailures: 0,
  packageBuildCalls: 0,
  /** Fail the HEAD that follows the report PUT inside the report transaction. */
  reportHeadFailures: 0,
  /** Fail reading the ORIGINAL evidence object (prepare and package streaming). */
  evidenceReadFailures: 0,
  renderCount: 0,
  /** When set and resolving true, the next evidence-original read fails once. */
  evidenceReadGate: null as null | (() => Promise<boolean>),
}));

vi.mock("../../../worker/src/verification-package.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    createVerificationPackage: (...a: unknown[]) => Promise<unknown>;
  };
  return {
    ...actual,
    createVerificationPackage: async (...args: unknown[]) => {
      seam.packageBuildCalls += 1;
      if (seam.packageBuildFailures > 0) {
        seam.packageBuildFailures -= 1;
        throw new Error("ACC_PACKAGE_BUILD_FAILED");
      }
      return actual.createVerificationPackage(...args);
    },
  };
});

vi.mock("../../../worker/src/report-v2/build-report-pdf.js", () => {
  const render = () => {
    seam.renderCount += 1;
    return Buffer.from(`%PDF-1.7 recovery fixture render #${seam.renderCount} ${randomUUID()}\n`);
  };
  return {
    buildReportPdfV2: async () => render(),
    buildReportPdfV2WithSignatureOutcome: async () => ({
      status: "UNSIGNED_OPT_OUT" as const,
      pdf: render(),
      warning: "PDF signing is not exercised by this case.",
    }),
  };
});

const storage = vi.hoisted(() => {
  const objects = new Map<
    string,
    { body: Buffer; contentType: string; metadata: Record<string, string> | null; checksumSha256: string | null }
  >();
  const served: string[] = [];
  return { objects, served, at: (bucket: string, key: string) => `${bucket}/${key}` };
});

vi.mock("../../../worker/src/storage.js", () => {
  const notFound = (key: string) => {
    const err = new Error(`NoSuchKey: ${key}`) as Error & { name: string; $metadata: unknown };
    err.name = "NoSuchKey";
    err.$metadata = { httpStatusCode: 404 };
    return err;
  };
  const b64 = (body: Buffer) => createHash("sha256").update(body).digest("base64");
  const put = (bucket: string, key: string, body: Buffer, contentType: string, metadata?: Record<string, unknown>) =>
    storage.objects.set(storage.at(bucket, key), {
      body: Buffer.from(body),
      contentType,
      metadata: (metadata as Record<string, string>) ?? null,
      checksumSha256: b64(body),
    });
  const isEvidenceOriginal = (key: string) => key.startsWith("evidence/");
  return {
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, unknown> }) => {
      storage.served.push("putObjectBuffer");
      if (!Buffer.isBuffer(p.body) || p.body.length <= 0) throw new Error("putObjectBuffer: body must be a non-empty Buffer");
      put(p.bucket, p.key, p.body, p.contentType, p.metadata);
      return { etag: `"${p.body.length}"` };
    },
    putObjectFromFile: async (p: { bucket: string; key: string; filePath: string; contentType: string; metadata?: Record<string, unknown> }) => {
      storage.served.push("putObjectFromFile");
      const { readFile } = await import("node:fs/promises");
      put(p.bucket, p.key, await readFile(p.filePath), p.contentType, p.metadata);
      return { etag: "staged" };
    },
    copyObject: async (p: { sourceBucket: string; sourceKey: string; destBucket: string; destKey: string; contentType?: string; metadata?: Record<string, unknown> }) => {
      storage.served.push("copyObject");
      const o = storage.objects.get(storage.at(p.sourceBucket, p.sourceKey));
      if (!o) throw notFound(p.sourceKey);
      put(p.destBucket, p.destKey, o.body, p.contentType ?? o.contentType, p.metadata);
      return { copied: true };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      storage.served.push("getObjectStream");
      if (isEvidenceOriginal(p.key) && seam.evidenceReadFailures > 0) {
        seam.evidenceReadFailures -= 1;
        throw new Error("ACC_EVIDENCE_READ_FAILED");
      }
      if (isEvidenceOriginal(p.key) && seam.evidenceReadGate && (await seam.evidenceReadGate())) {
        seam.evidenceReadGate = null;
        throw new Error("ACC_EVIDENCE_STREAM_FAILED");
      }
      const o = storage.objects.get(storage.at(p.bucket, p.key));
      if (!o) throw notFound(p.key);
      const { Readable } = await import("node:stream");
      return Readable.from([o.body]);
    },
    getObjectRange: async (p: { bucket: string; key: string; range?: string }) => {
      const o = storage.objects.get(storage.at(p.bucket, p.key));
      if (!o) throw notFound(p.key);
      const m = /bytes=(\d+)-(\d+)/.exec(p.range ?? "");
      return m ? o.body.subarray(Number(m[1]), Number(m[2]) + 1) : o.body;
    },
    headObject: async (p: { bucket: string; key: string }) => {
      storage.served.push("headObject");
      if (p.key.startsWith("reports/") && seam.reportHeadFailures > 0) {
        seam.reportHeadFailures -= 1;
        throw new Error("ACC_REPORT_HEAD_FAILED");
      }
      const o = storage.objects.get(storage.at(p.bucket, p.key));
      if (!o) throw notFound(p.key);
      return {
        sizeBytes: o.body.length,
        contentType: o.contentType,
        etag: `"${o.body.length}"`,
        metadata: o.metadata,
        checksumSha256: o.checksumSha256,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    listObjects: async () => [],
    deleteObject: async (p: { bucket: string; key: string }) => {
      storage.served.push("deleteObject");
      storage.objects.delete(storage.at(p.bucket, p.key));
      return { deleted: true };
    },
    applyObjectRetention: async () => ({ applied: false, reason: "object_lock_disabled" as const }),
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "object_lock_disabled" as const }),
    verifyObjectLockConfiguration: async () => ({ mode: "disabled" as const }),
  };
});

const FIXTURE_SIGNING_KEY_ID = "recovery-fixture-key";
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("report / package recovery (real processor, live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let processor: typeof import("../../../worker/src/processor.js");
  let authority: typeof import("../../../worker/src/report-generation-authority.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../../worker/src/processor.js");
    authority = await import("../../../worker/src/report-generation-authority.js");

    const { teamId } = harness.fixtures.teamA;
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const owner = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { ownerUserId: true } });
    const ent = await prisma.entitlement.findFirst({ where: { userId: owner.ownerUserId }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "PRO" } });
    else await prisma.entitlement.create({ data: { userId: owner.ownerUserId, plan: "PRO" } });
    await prisma.signingKey.upsert({
      where: { keyId_version: { keyId: FIXTURE_SIGNING_KEY_ID, version: 1 } },
      create: {
        keyId: FIXTURE_SIGNING_KEY_ID,
        version: 1,
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture-local-only-not-a-real-key\n-----END PUBLIC KEY-----\n",
      },
      update: {},
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(() => {
    seam.packageBuildFailures = 0;
    seam.packageBuildCalls = 0;
    seam.reportHeadFailures = 0;
    seam.evidenceReadFailures = 0;
    seam.evidenceReadGate = null;
  });

  /** A fresh SIGNED record in workspace A with its original in storage. */
  async function signedEvidence(): Promise<{ evidenceId: string; teamId: string; originalSha: string }> {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const body = Buffer.from(`recovery original ${randomUUID()}\n`);
    const originalSha = sha256Hex(body);
    const ev = await prisma.evidence.create({
      data: {
        title: "Recovery fixture",
        type: "PHOTO",
        status: "CREATED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
      },
      select: { id: true },
    });
    const storageKey = `evidence/${ev.id}/original.txt`;
    const { putObjectBuffer } = await import("../../../worker/src/storage.js");
    await putObjectBuffer({ bucket: process.env.S3_BUCKET!, key: storageKey, body, contentType: "text/plain" });
    await prisma.evidence.update({
      where: { id: ev.id },
      data: {
        status: "SIGNED",
        signedAtUtc: new Date(),
        signatureBase64: "ZmFrZS1zaWduYXR1cmUtZm9yLXJlY292ZXJ5",
        signingKeyId: FIXTURE_SIGNING_KEY_ID,
        signingKeyVersion: 1,
        fingerprintHash: "7".repeat(64),
        fingerprintCanonicalJson: JSON.stringify({ recovery: ev.id }),
        storageBucket: process.env.S3_BUCKET!,
        storageKey,
        mimeType: "text/plain",
        sizeBytes: BigInt(body.length),
        fileSha256: originalSha,
      },
    });
    return { evidenceId: ev.id, teamId, originalSha };
  }

  async function request(input: {
    evidenceId: string;
    teamId: string;
    forceRegenerate?: boolean;
    artifactType?: "REPORT" | "VERIFICATION_PACKAGE";
    reportVersion?: number | null;
    purpose?: string;
  }): Promise<string> {
    const row = await prisma.reportGenerationRequest.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        artifactType: input.artifactType ?? "REPORT",
        purpose: input.purpose ?? "evidence_completed",
        forceRegenerate: input.forceRegenerate ?? false,
        requestedByMachineId: "recovery-integration",
        expectedPolicyVersion: 0,
        idempotencyKey: `RECOVERY-TEST:${randomUUID()}`,
        state: "QUEUED",
        ...(input.reportVersion != null ? { reportVersion: input.reportVersion } : {}),
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function run(requestId: string, attemptsMade = 0): Promise<unknown> {
    try {
      await processor.processGenerateReport({
        id: `report-${requestId}`,
        name: "GenerateReportJob",
        attemptsMade,
        data: { commandId: requestId, traceId: "recovery", schemaVersion: 1 },
        opts: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
        queueName: "report",
        discard: () => undefined,
        updateProgress: async () => undefined,
        log: async () => undefined,
      } as never);
      return null;
    } catch (err) {
      return err;
    }
  }

  async function state(evidenceId: string, requestId?: string) {
    const reports = await prisma.report.findMany({
      where: { evidenceId },
      orderBy: { version: "asc" },
      select: { version: true, storageBucket: true, storageKey: true, verificationPackageVersion: true, pdfSha256: true } as never,
    }) as unknown as Array<{ version: number; storageBucket: string; storageKey: string; verificationPackageVersion: number | null; pdfSha256: string | null }>;
    const packages = await prisma.verificationPackage.findMany({
      where: { evidenceId },
      orderBy: { version: "asc" },
      select: { version: true, storageBucket: true, storageKey: true, reportVersion: true, reportSha256: true } as never,
    }) as unknown as Array<{ version: number; storageBucket: string; storageKey: string; reportVersion: number | null; reportSha256: string | null }>;
    const req = requestId
      ? await prisma.reportGenerationRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { state: true, terminalReasonCode: true, reportVersion: true, stage: true } as never,
        }) as unknown as { state: string; terminalReasonCode: string | null; reportVersion: number | null; stage: string | null }
      : null;
    return { reports, packages, req };
  }

  const stored = (bucket: string, key: string) => storage.objects.get(storage.at(bucket, key))?.body ?? null;

  /** The report PDF inside a package, and the package's own manifest claims. */
  function packageReportBytes(pkg: { storageBucket: string; storageKey: string }, version: number): Buffer {
    const zip = stored(pkg.storageBucket, pkg.storageKey);
    expect(zip, "package object must be durable in storage").toBeTruthy();
    const entries = readZipEntries(zip!);
    const name = [...entries.keys()].find((k) => k.endsWith(`proovra-verification-report-v${version}.pdf`));
    expect(name, `package must carry the report v${version} PDF; entries: ${[...entries.keys()].join(", ")}`).toBeTruthy();
    return entries.get(name!)!;
  }

  async function tsaColumns(evidenceId: string) {
    return prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { tsaStatus: true, tsaGenTimeUtc: true, tsaMessageImprint: true, tsaTokenBase64: true },
    });
  }

  // -------------------------------------------------------------------------
  // AUDIT-A
  // -------------------------------------------------------------------------
  it("AUDIT-A: the retry after a package failure builds the package for the SAME report version", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const tsaBefore = await tsaColumns(evidenceId);
    const id = await request({ evidenceId, teamId });

    seam.packageBuildFailures = 1;
    expect(await run(id, 0), "the package failure must surface").toBeTruthy();
    const afterFailure = await state(evidenceId, id);
    expect(afterFailure.req!.state).toBe("FAILED_RETRYABLE");
    expect(afterFailure.reports.map((r) => r.version)).toEqual([1]);
    expect(afterFailure.packages).toEqual([]);
    expect(afterFailure.req!.reportVersion, "the committed version is durable on the request").toBe(1);
    expect(afterFailure.req!.stage).toBe("REPORT_COMMITTED");

    const callsBefore = seam.packageBuildCalls;
    expect(await run(id, 1)).toBeNull();
    const after = await state(evidenceId, id);
    expect(seam.packageBuildCalls - callsBefore, "the retry must actually build the package").toBe(1);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.reports.map((r) => r.version), "no second report version").toEqual([1]);
    expect(after.packages.map((p) => p.version)).toEqual([1]);
    expect(after.packages[0]!.reportVersion).toBe(1);
    expect(after.reports[0]!.verificationPackageVersion).toBe(1);

    const reportBytes = stored(after.reports[0]!.storageBucket, after.reports[0]!.storageKey)!;
    expect(after.reports[0]!.pdfSha256).toBe(sha256Hex(reportBytes));
    expect(after.packages[0]!.reportSha256).toBe(sha256Hex(reportBytes));
    expect(sha256Hex(packageReportBytes(after.packages[0]!, 1)), "the package embeds the STORED report bytes").toBe(
      sha256Hex(reportBytes),
    );
    expect(await tsaColumns(evidenceId), "no TSA authority was contacted").toEqual(tsaBefore);
  });

  // -------------------------------------------------------------------------
  // AUDIT-B
  // -------------------------------------------------------------------------
  it("AUDIT-B: the reconciler never closes a request whose package is missing", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.packageBuildFailures = 1;
    await run(id, 0);
    expect((await state(evidenceId, id)).req!.state).toBe("FAILED_RETRYABLE");

    const enqueued: string[] = [];
    await authority.reconcileStrandedReportRequests({
      enqueue: async (rid: string) => {
        enqueued.push(rid);
        return { enqueued: true };
      },
      batchSize: 500,
    });
    const after = await state(evidenceId, id);
    expect(after.req!.state, "a report without its package is not a completed request").not.toBe("SUCCEEDED");
    expect(enqueued).toContain(id);
    expect(after.packages).toEqual([]);
  });

  it("the reconciler DOES close a request whose committed pair exists (crash after publication, before the terminal write)", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    expect(await run(id, 0)).toBeNull();
    // Simulate the process dying between the package commit and the terminal write.
    await prisma.reportGenerationRequest.update({
      where: { id },
      data: { state: "FAILED_RETRYABLE", completedAtUtc: null, terminalReasonCode: "SIMULATED_CRASH" },
    });
    await authority.reconcileStrandedReportRequests({ enqueue: async () => ({ enqueued: true }), batchSize: 500 });
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.reports.map((r) => r.version)).toEqual([1]);
    expect(after.packages.map((p) => p.version)).toEqual([1]);
  });

  it("a retry after the package was published but before the terminal write completes without new artifacts", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    expect(await run(id, 0)).toBeNull();
    await prisma.reportGenerationRequest.update({
      where: { id },
      data: { state: "FAILED_RETRYABLE", completedAtUtc: null },
    });
    const calls = seam.packageBuildCalls;
    expect(await run(id, 1)).toBeNull();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.reports.map((r) => r.version)).toEqual([1]);
    expect(after.packages.map((p) => p.version)).toEqual([1]);
    expect(seam.packageBuildCalls).toBe(calls);
  });

  // -------------------------------------------------------------------------
  // AUDIT-C
  // -------------------------------------------------------------------------
  it("AUDIT-C: a forced request commits exactly ONE report version however often its package fails", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const first = await request({ evidenceId, teamId });
    expect(await run(first, 0)).toBeNull();
    expect((await state(evidenceId)).reports.map((r) => r.version)).toEqual([1]);

    const forced = await request({ evidenceId, teamId, forceRegenerate: true, purpose: "operator_regenerate" });
    seam.packageBuildFailures = 3;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await run(forced, attempt)).toBeTruthy();
      const s = await state(evidenceId, forced);
      expect(s.reports.map((r) => r.version), `attempt ${attempt} must not mint another version`).toEqual([1, 2]);
      expect(s.req!.state).toBe("FAILED_RETRYABLE");
      expect(s.req!.reportVersion).toBe(2);
    }
    expect(await run(forced, 3)).toBeNull();
    const done = await state(evidenceId, forced);
    expect(done.req!.state).toBe("SUCCEEDED");
    expect(done.reports.map((r) => r.version)).toEqual([1, 2]);
    expect(done.packages.map((p) => p.version)).toEqual([1, 2]);
    const v2 = done.reports.find((r) => r.version === 2)!;
    expect(sha256Hex(packageReportBytes(done.packages[1]!, 2))).toBe(sha256Hex(stored(v2.storageBucket, v2.storageKey)!));
  });

  // -------------------------------------------------------------------------
  // PACKAGE-ONLY RECOVERY (D1)
  // -------------------------------------------------------------------------
  /** A REPORTED record whose report v1 exists and whose package never did. */
  async function reportWithoutPackage() {
    const ev = await signedEvidence();
    const id = await request(ev);
    seam.packageBuildFailures = 1;
    await run(id, 0);
    // The historical shape: the request was closed while the package was missing.
    await prisma.reportGenerationRequest.update({
      where: { id },
      data: { state: "SUCCEEDED", completedAtUtc: new Date(), terminalReasonCode: "generated" },
    });
    const s = await state(ev.evidenceId);
    expect(s.reports.map((r) => r.version)).toEqual([1]);
    expect(s.packages).toEqual([]);
    return { ...ev, report: s.reports[0]! };
  }

  it("package-only recovery embeds the verified stored report and mints no report version", async () => {
    const { evidenceId, teamId, report } = await reportWithoutPackage();
    const tsaBefore = await tsaColumns(evidenceId);
    const reportBytes = stored(report.storageBucket, report.storageKey)!;
    const renders = seam.renderCount;

    const id = await request({ evidenceId, teamId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, purpose: "operator_regenerate" });
    expect(await run(id, 0)).toBeNull();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.reports.map((r) => r.version)).toEqual([1]);
    expect(seam.renderCount, "the report is not re-rendered").toBe(renders);
    expect(after.packages.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1]]);
    expect(after.packages[0]!.reportSha256).toBe(sha256Hex(reportBytes));
    expect(sha256Hex(packageReportBytes(after.packages[0]!, 1))).toBe(sha256Hex(reportBytes));
    expect(stored(report.storageBucket, report.storageKey)!.equals(reportBytes), "the stored report is untouched").toBe(true);

    const custody = await prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "VERIFICATION_PACKAGE_GENERATED" },
      select: { payload: true },
    });
    expect(custody).toHaveLength(1);
    expect(custody[0]!.payload).toMatchObject({ version: 1, reportVersion: 1, reportSha256: sha256Hex(reportBytes), recovery: true });
    expect(await tsaColumns(evidenceId)).toEqual(tsaBefore);
  });

  it("the automatic completion retry (non-force, no target) recovers the package for the latest report", async () => {
    const { evidenceId, teamId } = await reportWithoutPackage();
    const id = await request({ evidenceId, teamId, purpose: "lifecycle_recovery" });
    expect(await run(id, 0)).toBeNull();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.reports.map((r) => r.version)).toEqual([1]);
    expect(after.packages.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1]]);
  });

  it("an ALTERED stored report is never embedded or replaced: explicit terminal integrity failure", async () => {
    const { evidenceId, teamId, report } = await reportWithoutPackage();
    const key = storage.at(report.storageBucket, report.storageKey);
    const original = storage.objects.get(key)!;
    // Bytes changed behind the recorded hash (the storage checksum is left as
    // it was recorded at upload, as a real store would keep it).
    storage.objects.set(key, { ...original, body: Buffer.from("%PDF-1.7 tampered\n") });

    const id = await request({ evidenceId, teamId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1 });
    expect(await run(id, 0)).toBeTruthy();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
    expect(after.req!.terminalReasonCode).toBe("REPORT_INTEGRITY_MISMATCH");
    expect(after.packages).toEqual([]);
    expect(after.reports.map((r) => r.version), "no replacement report").toEqual([1]);
    const incidents = await prisma.operationalIncident.count({
      where: { teamId, fingerprint: { startsWith: `REPORT:${evidenceId}:` }, status: "OPEN" },
    });
    expect(incidents).toBeGreaterThan(0);
  });

  it("a MISSING stored report is an explicit terminal state, not a replacement", async () => {
    const { evidenceId, teamId, report } = await reportWithoutPackage();
    storage.objects.delete(storage.at(report.storageBucket, report.storageKey));
    const id = await request({ evidenceId, teamId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1 });
    expect(await run(id, 0)).toBeTruthy();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
    expect(after.req!.terminalReasonCode).toBe("REPORT_OBJECT_MISSING");
    expect(after.packages).toEqual([]);
    expect(after.reports.map((r) => r.version)).toEqual([1]);
  });

  it("a legacy report with no recorded hash is verified against the checksum storage recorded at upload", async () => {
    const { evidenceId, teamId, report } = await reportWithoutPackage();
    await prisma.report.updateMany({ where: { evidenceId, version: 1 }, data: { pdfSha256: null } as never });
    const id = await request({ evidenceId, teamId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1 });
    expect(await run(id, 0)).toBeNull();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("SUCCEEDED");
    expect(after.packages[0]!.reportSha256).toBe(sha256Hex(stored(report.storageBucket, report.storageKey)!));
  });

  it("a legacy report with NO recorded hash anywhere cannot be verified and is escalated, not embedded", async () => {
    const { evidenceId, teamId, report } = await reportWithoutPackage();
    await prisma.report.updateMany({ where: { evidenceId, version: 1 }, data: { pdfSha256: null } as never });
    const key = storage.at(report.storageBucket, report.storageKey);
    storage.objects.set(key, { ...storage.objects.get(key)!, checksumSha256: null });
    const id = await request({ evidenceId, teamId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1 });
    expect(await run(id, 0)).toBeTruthy();
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
    expect(after.req!.terminalReasonCode).toBe("REPORT_INTEGRITY_UNVERIFIABLE");
    expect(after.packages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // VERSION PAIRING (W4)
  // -------------------------------------------------------------------------
  it("report v2 with only package v1 is NOT complete: the completion path builds package v2, never report v3", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    expect(await run(await request({ evidenceId, teamId }), 0)).toBeNull();
    const forced = await request({ evidenceId, teamId, forceRegenerate: true, purpose: "operator_regenerate" });
    seam.packageBuildFailures = 1;
    await run(forced, 0);
    await prisma.reportGenerationRequest.update({ where: { id: forced }, data: { state: "SUCCEEDED" } });
    let s = await state(evidenceId);
    expect(s.reports.map((r) => r.version)).toEqual([1, 2]);
    expect(s.packages.map((p) => p.version)).toEqual([1]);

    const id = await request({ evidenceId, teamId, purpose: "lifecycle_recovery" });
    expect(await run(id, 0)).toBeNull();
    s = await state(evidenceId, id);
    expect(s.req!.state).toBe("SUCCEEDED");
    expect(s.reports.map((r) => r.version)).toEqual([1, 2]);
    expect(s.packages.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1], [2, 2]]);
  });

  // -------------------------------------------------------------------------
  // CRASH / RESTART BOUNDARIES
  // -------------------------------------------------------------------------
  it("failure BEFORE version reservation: the retry produces exactly v1", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.evidenceReadFailures = 1;
    expect(await run(id, 0)).toBeTruthy();
    let s = await state(evidenceId, id);
    expect(s.reports).toEqual([]);
    expect(s.req!.reportVersion).toBeNull();
    expect(await run(id, 1)).toBeNull();
    s = await state(evidenceId, id);
    expect(s.req!.state).toBe("SUCCEEDED");
    expect(s.reports.map((r) => r.version)).toEqual([1]);
    expect(s.packages.map((p) => p.version)).toEqual([1]);
  });

  it("failure AFTER the report upload but BEFORE the report commit: the retry reuses v1 and the row describes the stored bytes", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.reportHeadFailures = 1;
    expect(await run(id, 0)).toBeTruthy();
    let s = await state(evidenceId, id);
    expect(s.reports, "the transaction rolled back").toEqual([]);
    expect(s.req!.reportVersion).toBeNull();
    expect(await run(id, 1)).toBeNull();
    s = await state(evidenceId, id);
    expect(s.req!.state).toBe("SUCCEEDED");
    expect(s.reports.map((r) => r.version)).toEqual([1]);
    const v1 = s.reports[0]!;
    expect(v1.pdfSha256).toBe(sha256Hex(stored(v1.storageBucket, v1.storageKey)!));
    expect(sha256Hex(packageReportBytes(s.packages[0]!, 1))).toBe(v1.pdfSha256);
  });

  it("failure DURING package streaming (evidence read after the report commit): the retry resumes at the package for the committed version", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    // Armed only once report v1 is committed, so the read that fails is the
    // one the package builder makes while streaming the original into the ZIP.
    seam.evidenceReadGate = async () => (await prisma.report.count({ where: { evidenceId } })) > 0;
    expect(await run(id, 0)).toBeTruthy();
    seam.evidenceReadGate = null;
    let s = await state(evidenceId, id);
    expect(s.req!.state).toBe("FAILED_RETRYABLE");
    expect(s.req!.stage).toBe("REPORT_COMMITTED");
    expect(s.reports.map((r) => r.version)).toEqual([1]);
    expect(s.packages).toEqual([]);
    expect(await run(id, 1)).toBeNull();
    s = await state(evidenceId, id);
    expect(s.reports.map((r) => r.version)).toEqual([1]);
    expect(s.packages.map((p) => p.version)).toEqual([1]);
    expect(s.req!.stage).toBe("PACKAGE_PUBLISHED");
    expect(s.req!.state).toBe("SUCCEEDED");
  });
});
