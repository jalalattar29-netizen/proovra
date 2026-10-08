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
  /**
   * Runs at the HEAD that verifies a just-published package (after the PUT,
   * before the DB commit) — the window a concurrent commit or a moved report
   * baseline lands in.
   */
  packageVerifyHook: null as null | ((key: string) => Promise<void>),
  /**
   * ET-SM-02 — runs once at the HEAD that verifies a just-published REPORT
   * (after the PUT, before the commit transaction): the window in which a
   * concurrent integrity rejection, trash or destruction lands.
   */
  reportPublishedHook: null as null | ((key: string) => Promise<void>),
  /**
   * Runs once just before a run takes its RENDER SNAPSHOT (after the payload
   * was prepared) — the window production's OTS initialization committed in.
   */
  beforeRenderSnapshot: null as null | (() => Promise<void>),
  /**
   * Runs once just AFTER the run took its render snapshot — the window in
   * which the record advances while the report renders and packages build.
   */
  afterRenderSnapshot: null as null | (() => Promise<void>),
  /** Fail the render-input gate this many times, exactly as production did. */
  renderInputFailures: 0,
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

/**
 * The renderer above is a FIXTURE, not a report, so the post-render TEXT check
 * (worker output-verification) is doubled with it. The render-input check and
 * the read-back verification of every staged package (seal, registered seal
 * key, profile rules, record facts) stay real.
 */
vi.mock("../../../worker/src/output-verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../worker/src/output-verification.js")>();
  return {
    ...actual,
    assertRenderedReport: async () => {},
    assertRenderInputs: (...args: Parameters<typeof actual.assertRenderInputs>) => {
      if (seam.renderInputFailures > 0) {
        seam.renderInputFailures -= 1;
        throw new actual.OutputVerificationError("REPORT_RENDER_INPUT_INCONSISTENT", [
          { check: "OTS_STATE", detail: "record PENDING, payload UNAVAILABLE" },
        ]);
      }
      return actual.assertRenderInputs(...args);
    },
    loadRecordSnapshot: async (evidenceId: string) => {
      const fn = seam.beforeRenderSnapshot;
      seam.beforeRenderSnapshot = null;
      if (fn) await fn();
      const snapshot = await actual.loadRecordSnapshot(evidenceId);
      const after = seam.afterRenderSnapshot;
      seam.afterRenderSnapshot = null;
      if (after) await after();
      return snapshot;
    },
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

/**
 * Destruction is not exercised by this suite. The worker processor it imports
 * owns the purge path, whose port (2026-09-29) talks to the S3 client directly
 * rather than through the storage.js double above — so it is doubled here to
 * FAIL LOUDLY if ever reached, instead of silently reaching ambient storage.
 */
vi.mock("../../../worker/src/governance/destruction-storage-port.js", () => {
  const unreachable = async () => {
    throw new Error("destruction storage is not part of this suite");
  };
  return {
    workerEvidenceDestructionStorage: {
      listObjectVersions: unreachable,
      deleteObjectVersion: unreachable,
    },
  };
});

vi.mock("../../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../worker/src/storage.js")>();
  const { publicationS3Double } = await import("../helpers/publication-s3-double.js");
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
    // THE PUBLICATION BOUNDARY (2026-09-29): reports and packages are sent by
    // publishImmutableArtifact straight on the S3 client. The pure normalizers
    // are the real ones; Object Lock is off, as the fixture environment says.
    s3: publicationS3Double(storage, {
      // "Uploaded, then the read-back failed": the bytes are stored, the report
      // is not yet proven, so nothing may commit.
      onHead: async (key) => {
        if (key.startsWith("reports/") && seam.reportHeadFailures > 0) {
          seam.reportHeadFailures -= 1;
          throw new Error("ACC_REPORT_HEAD_FAILED");
        }
        if (key.startsWith("reports/") && seam.reportPublishedHook) {
          const hook = seam.reportPublishedHook;
          seam.reportPublishedHook = null;
          await hook(key);
        }
        if (key.startsWith("verification/") && seam.packageVerifyHook) {
          const hook = seam.packageVerifyHook;
          seam.packageVerifyHook = null;
          await hook(key);
        }
      },
    }),
    isObjectLockEnabled: () => false,
    readObjectLockDefaults: () => ({}),
    normalizeContentType: actual.normalizeContentType,
    normalizeMetadata: actual.normalizeMetadata,
    normalizeTagging: actual.normalizeTagging,
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, unknown> }) => {
      storage.served.push("putObjectBuffer");
      if (!Buffer.isBuffer(p.body) || p.body.length <= 0) throw new Error("putObjectBuffer: body must be a non-empty Buffer");
      put(p.bucket, p.key, p.body, p.contentType, p.metadata);
      return { etag: `"${p.body.length}"` };
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

/**
 * The API's storage, for the recovery CLI's `status` (a HEAD of each stored
 * output). The same in-process store the worker double writes — never ambient
 * S3.
 */
vi.mock("../../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage.js")>();
  return {
    ...actual,
    headObject: async (p: { bucket: string; key: string }) => {
      const o = storage.objects.get(storage.at(p.bucket, p.key));
      if (!o) {
        const err = new Error(`NoSuchKey: ${p.key}`) as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      return { sizeBytes: o.body.length, contentType: o.contentType, metadata: o.metadata } as never;
    },
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
      where: { keyId_version_purpose: { keyId: FIXTURE_SIGNING_KEY_ID, version: 1, purpose: "EVIDENCE_SIGNATURE" } },
      create: {
        keyId: FIXTURE_SIGNING_KEY_ID,
        version: 1,
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture-local-only-not-a-real-key\n-----END PUBLIC KEY-----\n",
      },
      update: {},
    });
  }, 180_000);

  /** Every record this suite creates, so it leaves nothing for other suites' sweeps. */
  const createdEvidence: string[] = [];

  afterAll(async () => {
    // A failed case can leave a SIGNED record with no report, which the
    // global lifecycle-recovery sweep of a later suite would pick up.
    if (createdEvidence.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: createdEvidence } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  beforeEach(() => {
    seam.packageBuildFailures = 0;
    seam.packageBuildCalls = 0;
    seam.reportHeadFailures = 0;
    seam.evidenceReadFailures = 0;
    seam.evidenceReadGate = null;
    seam.packageVerifyHook = null;
    seam.reportPublishedHook = null;
    seam.beforeRenderSnapshot = null;
    seam.afterRenderSnapshot = null;
    seam.renderInputFailures = 0;
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
    createdEvidence.push(ev.id);
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
    // "The package" of a version is its PUBLISHED PRIMARY row (FULL_FORENSIC or
    // legacy). Since 2026-10-07 every profile is its own row and a row exists
    // (RESERVED / FAILED) from the moment its id is reserved, so the published
    // primary rows are what these cases mean by "a package"; `packageRows` is
    // every row, for the lifecycle assertions.
    const packageRows = await prisma.verificationPackage.findMany({
      where: { evidenceId },
      orderBy: [{ version: "asc" }, { disclosureProfile: "asc" }],
      select: {
        id: true, version: true, state: true, disclosureProfile: true, issuanceId: true,
        storageBucket: true, storageKey: true, reportVersion: true, reportSha256: true,
        failedAtUtc: true, terminalReason: true,
      } as never,
    }) as unknown as Array<{
      id: string; version: number; state: string; disclosureProfile: string | null; issuanceId: string | null;
      storageBucket: string; storageKey: string; reportVersion: number | null; reportSha256: string | null;
      failedAtUtc: Date | null; terminalReason: string | null;
    }>;
    const packages = packageRows.filter(
      (p) => p.state === "PUBLISHED" && (p.disclosureProfile === null || p.disclosureProfile === "FULL_FORENSIC"),
    );
    const req = requestId
      ? await prisma.reportGenerationRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { state: true, terminalReasonCode: true, reportVersion: true, stage: true } as never,
        }) as unknown as { state: string; terminalReasonCode: string | null; reportVersion: number | null; stage: string | null }
      : null;
    return { reports, packages, packageRows, req };
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
  it("ET-SM-02: an integrity rejection that lands while the PDF renders is never overwritten by REPORTED", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.reportPublishedHook = async () => {
      await prisma.evidence.update({ where: { id: evidenceId }, data: { status: "FAILED_HASH_MISMATCH" } as never });
    };
    expect(await run(id, 0), "the commit must refuse").toBeTruthy();
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } });
    expect(ev.status).toBe("FAILED_HASH_MISMATCH");
    const after = await state(evidenceId, id);
    expect(after.reports, "no report row commits").toEqual([]);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
    expect(after.req!.terminalReasonCode).toBe("REPORT_EVIDENCE_STATE_CHANGED");
  });

  it("ET-SM-02: a record trashed while the PDF renders gets no report", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.reportPublishedHook = async () => {
      await prisma.evidence.update({
        where: { id: evidenceId },
        data: { lifecycleState: "TRASHED", deletedAt: new Date() } as never,
      });
    };
    expect(await run(id, 0)).toBeTruthy();
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } });
    expect(ev.status).toBe("SIGNED");
    expect((await state(evidenceId, id)).reports).toEqual([]);
  });

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
    // One run builds the version's two disclosure profiles (FULL_FORENSIC and
    // its EXTERNAL_DISCLOSURE companion) through the one call site.
    expect(seam.packageBuildCalls - callsBefore, "the retry must actually build the package").toBe(2);
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
    // ET-RPT-07 — a pair already complete is recorded as exactly that, naming v1.
    const done = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id },
      select: { terminalReasonCode: true, resultReportId: true },
    });
    expect(done.terminalReasonCode).toBe("pair_complete");
    expect(done.resultReportId).toBe(
      (await prisma.report.findUniqueOrThrow({ where: { evidenceId_version: { evidenceId, version: 1 } }, select: { id: true } })).id,
    );
  });

  it("ET-REC-10: the LAST BullMQ attempt of a retryable failure opens no 'budget exhausted' incident while the durable budget remains", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    seam.reportHeadFailures = 1;
    // attemptsMade 4 of attempts 5: BullMQ's own last try.
    expect(await run(id, 4), "the report failure must surface").toBeTruthy();
    const after = await state(evidenceId, id);
    expect(after.req!.state, "the durable budget (12 claims) keeps the request alive").toBe("FAILED_RETRYABLE");
    const incidents = await prisma.operationalIncident.findMany({
      where: { teamId, fingerprint: { startsWith: `REPORT:${evidenceId}:` } },
      select: { fingerprint: true, title: true },
    });
    expect(incidents, "one budget: the exhausted incident belongs to FAILED_TERMINAL (D3 below)").toEqual([]);
  });

  it("a request that exhausts its retry budget is retired AND opens the deduplicated REPORT incident (D3)", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const id = await request({ evidenceId, teamId });
    await prisma.reportGenerationRequest.update({
      where: { id },
      data: { state: "FAILED_RETRYABLE", attemptCount: 12, terminalReasonCode: "VERIFICATION_PACKAGE_INCOMPLETE_STORE" },
    });
    for (let i = 0; i < 2; i += 1) {
      await authority.reconcileStrandedReportRequests({ enqueue: async () => ({ enqueued: true }), batchSize: 500 });
    }
    const after = await state(evidenceId, id);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
    expect(after.req!.terminalReasonCode).toBe("retry_budget_exhausted");
    const incidents = await prisma.operationalIncident.findMany({
      where: { teamId, fingerprint: `REPORT:${evidenceId}:RETRY_BUDGET_EXHAUSTED` },
      select: { status: true, category: true, relatedEvidenceId: true },
    });
    expect(incidents).toEqual([{ status: "OPEN", category: "REPORT", relatedEvidenceId: evidenceId }]);
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

    // One custody event per published artifact (2026-10-07): the full and the
    // external disclosure package, each naming its own package id.
    const custody = await prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "VERIFICATION_PACKAGE_GENERATED" },
      orderBy: { sequence: "asc" },
      select: { payload: true },
    });
    expect(custody).toHaveLength(2);
    const published = after.packageRows.filter((p) => p.state === "PUBLISHED");
    for (const event of custody) {
      const payload = event.payload as { packageId?: string; disclosureProfile?: string };
      expect(event.payload).toMatchObject({ version: 1, reportVersion: 1, reportSha256: sha256Hex(reportBytes), recovery: true });
      expect(published.find((p) => p.id === payload.packageId)?.disclosureProfile).toBe(payload.disclosureProfile);
    }
    expect(new Set(custody.map((e) => (e.payload as { disclosureProfile?: string }).disclosureProfile))).toEqual(
      new Set(["FULL_FORENSIC", "EXTERNAL_DISCLOSURE"]),
    );
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
    expect(s.reports, "no report row: the commit never ran").toEqual([]);
    // 2026-09-29: the version is RESERVED (committed) before any upload, and
    // rendering/publication run with no transaction open. So the failure
    // leaves the reservation — v1, stage REPORT_RESERVED — and the retry must
    // reuse it rather than mint v2.
    expect(s.req!.reportVersion).toBe(1);
    expect(s.req!.stage).toBe("REPORT_RESERVED");
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

  // -------------------------------------------------------------------------
  // publicAnchoringVerified — THE ONE OTS CLAIM, SIGNED (2026-09-29)
  //
  // The manifest used to sign `publicAnchoringVerified: true` whenever a
  // transaction id or an anchored-at time was on the record. It is now true
  // ONLY for an anchor verified against the Bitcoin chain
  // (ots_anchor_check = BITCOIN_VERIFIED), and the manifest, anchor.json and
  // opentimestamps.json state the same claim. The seal binds all of it.
  // -------------------------------------------------------------------------
  const MAGIC_PROOF = Buffer.concat([
    Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex"),
    Buffer.from("fixture-proof-body"),
  ]).toString("base64");
  const TXID = "e".repeat(64);
  const ANCHORED_AT = new Date("2026-09-20T10:00:00.000Z");

  async function packageEntriesFor(ots: Record<string, unknown>) {
    const { evidenceId, teamId } = await signedEvidence();
    await prisma.evidence.update({ where: { id: evidenceId }, data: ots as never });
    const id = await request({ evidenceId, teamId });
    expect(await run(id, 0)).toBeNull();
    const s = await state(evidenceId, id);
    expect(s.packages.map((p) => p.version)).toEqual([1]);
    const zip = stored(s.packages[0]!.storageBucket, s.packages[0]!.storageKey);
    return readZipEntries(zip!);
  }
  const json = (entries: Map<string, Buffer>, name: string) => {
    const key = [...entries.keys()].find((k) => k === name || k.endsWith(`/${name}`));
    return key ? (JSON.parse(entries.get(key)!.toString("utf8")) as Record<string, unknown>) : null;
  };

  const CASES: Array<{ name: string; ots: Record<string, unknown>; verified: boolean; claim: string }> = [
    {
      name: "pending proof",
      ots: { otsStatus: "PENDING", otsProofBase64: MAGIC_PROOF, otsHash: "7".repeat(64) },
      verified: false,
      claim: "pending",
    },
    {
      name: "failed proof",
      ots: { otsStatus: "FAILED", otsProofBase64: MAGIC_PROOF, otsFailureReason: "PROOF_HASH_MISMATCH" },
      verified: false,
      claim: "failed",
    },
    {
      name: "anchored and verified against the chain",
      ots: {
        otsStatus: "ANCHORED",
        otsProofBase64: MAGIC_PROOF,
        otsBitcoinTxid: TXID,
        otsAnchoredAtUtc: ANCHORED_AT,
        otsAnchorCheck: "BITCOIN_VERIFIED",
      },
      verified: true,
      claim: "verified",
    },
    {
      name: "anchored by proof structure only (chain not checked)",
      ots: {
        otsStatus: "ANCHORED",
        otsProofBase64: MAGIC_PROOF,
        otsBitcoinTxid: TXID,
        otsAnchoredAtUtc: ANCHORED_AT,
        otsAnchorCheck: "PROOF_STRUCTURE",
      },
      verified: false,
      claim: "anchored_not_checked",
    },
    {
      name: "anchored before the check was recorded (historical row, check NULL)",
      ots: { otsStatus: "ANCHORED", otsProofBase64: MAGIC_PROOF, otsBitcoinTxid: TXID, otsAnchoredAtUtc: ANCHORED_AT },
      verified: false,
      claim: "anchored_not_checked",
    },
    {
      name: "ANCHORED label with a txid but no anchor time (no valid proof of anchoring)",
      ots: { otsStatus: "ANCHORED", otsProofBase64: MAGIC_PROOF, otsBitcoinTxid: TXID },
      verified: false,
      claim: "pending",
    },
    // 2026-09-29 — D7: the manifest used to say "pending" here while
    // opentimestamps.json said anchored.
    {
      name: "anchor recorded by proof structure with no readable txid",
      ots: {
        otsStatus: "ANCHORED",
        otsProofBase64: MAGIC_PROOF,
        otsAnchoredAtUtc: ANCHORED_AT,
        otsAnchorCheck: "PROOF_STRUCTURE",
      },
      verified: false,
      claim: "anchored_not_checked",
    },
    // The txid precondition for a chain-checked claim is kept everywhere.
    {
      name: "chain check recorded but no txid (never verified without its txid)",
      ots: {
        otsStatus: "ANCHORED",
        otsProofBase64: MAGIC_PROOF,
        otsAnchoredAtUtc: ANCHORED_AT,
        otsAnchorCheck: "BITCOIN_VERIFIED",
      },
      verified: false,
      claim: "anchored_not_checked",
    },
  ];
  const MODE_FOR_CLAIM: Record<string, string> = {
    verified: "anchored",
    anchored_not_checked: "anchored",
    pending: "bitcoin_anchoring_pending",
    failed: "failed",
  };

  for (const c of CASES) {
    it(`the signed manifest claims publicAnchoringVerified=${c.verified} for a ${c.name}`, async () => {
      const entries = await packageEntriesFor(c.ots);
      const manifest = json(entries, "package-manifest.json");
      expect(manifest, "package-manifest.json").toBeTruthy();
      expect(manifest!.publicAnchoringVerified).toBe(c.verified);
      // The explicit claim is present whether or not anchor.json is included.
      if (manifest!.anchorIncluded) {
        expect(manifest!.anchoringClaim).toBe(c.claim);
        expect(json(entries, "anchor.json")).toMatchObject({ publicAnchoringVerified: c.verified, anchoringClaim: c.claim });
        // One claim, one mode: the manifest's anchorMode never contradicts it.
        expect(manifest!.anchorMode, "manifest anchorMode agrees with the claim").toBe(MODE_FOR_CLAIM[c.claim]);
      }
      const companion = json(entries, "opentimestamps.json");
      if (companion) {
        expect(companion.publicAnchoringVerified).toBe(c.verified);
        expect(companion.anchorClaim).toBe(c.claim.toUpperCase());
      }
      // No surface inside the package may call an unchecked anchor verified.
      if (!c.verified) {
        for (const [name, bytes] of entries) {
          if (/\.(json|txt|md)$/i.test(name)) {
            expect(bytes.toString("utf8"), name).not.toContain("OpenTimestamps Bitcoin anchoring verified");
          }
        }
      }
    });
  }

  it("the seal binds the manifest: flipping publicAnchoringVerified is detected", async () => {
    const { verifySealedPackageEntries } = await import("@proovra/shared");
    const { verify, createPublicKey } = await import("node:crypto");
    const entries = await packageEntriesFor(CASES[3]!.ots); // anchored, not checked → false
    const check = (m: Map<string, Buffer>) =>
      verifySealedPackageEntries({
        entries: m,
        sha256Hex: (b) => createHash("sha256").update(b).digest("hex"),
        verifyEd25519: (msg, sig, pem) => verify(null, msg, createPublicKey(pem), Buffer.from(sig, "base64")),
        decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
        hexToBytes: (hex) => Buffer.from(hex, "hex"),
      });
    const intact = check(entries);
    expect(intact.failures, JSON.stringify(intact.failures)).toEqual([]);
    expect(intact.ok).toBe(true);

    const key = [...entries.keys()].find((k) => k.endsWith("package-manifest.json"))!;
    const forged = JSON.parse(entries.get(key)!.toString("utf8")) as Record<string, unknown>;
    expect(forged.publicAnchoringVerified).toBe(false);
    forged.publicAnchoringVerified = true;
    const tampered = new Map(entries);
    tampered.set(key, Buffer.from(JSON.stringify(forged, null, 2)));
    const result = check(tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("ENTRIES_MATCH_INDEX");
  });

  // -------------------------------------------------------------------------
  // 2026-09-29 — EXACT TARGETING, BASELINES AND THE UNREADABLE ORIGINAL
  // -------------------------------------------------------------------------

  /** Report v1 with NO package, then a forced v2 WITH its package. */
  async function historicalGap() {
    const ev = await signedEvidence();
    const first = await request(ev);
    seam.packageBuildFailures = 1;
    await run(first, 0);
    await prisma.reportGenerationRequest.update({
      where: { id: first },
      data: { state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted", completedAtUtc: new Date() },
    });
    const second = await request({ ...ev, forceRegenerate: true });
    expect(await run(second, 0)).toBeNull();
    const s0 = await state(ev.evidenceId);
    expect(s0.reports.map((r) => r.version)).toEqual([1, 2]);
    expect(s0.packages.map((p) => p.version)).toEqual([2]);
    return ev;
  }

  const recovery = () => import("../../src/services/reports/output-recovery.service.js");
  const operatorRecover = async (evidenceId: string, over: Record<string, unknown> = {}) => {
    const { requestOutputRecovery } = await recovery();
    return requestOutputRecovery({
      evidenceId,
      actorUserId: harness.fixtures.teamA.ownerUserId,
      purpose: "operator_regenerate",
      regenerateReason: "integration",
      platformOperator: true,
      ...over,
    } as never);
  };
  const idOf = (r: unknown) => (r as { requestId: string }).requestId;

  it("EXACT VERSION: package v1 is recovered for report v1 while v2 is latest — own key, own version, no new report", async () => {
    const { evidenceId } = await historicalGap();
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    expect(r.kind).toBe("accepted");
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: idOf(r) },
      select: { idempotencyKey: true, reportVersion: true, artifactType: true, forceRegenerate: true },
    });
    expect(row).toMatchObject({ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, forceRegenerate: false });
    expect(row.idempotencyKey).toBe(`VERIFICATION_PACKAGE:${evidenceId}:v1`);
    const pointerBefore = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { verificationPackageVersion: true },
    });

    expect(await run(idOf(r), 0)).toBeNull();
    // ET-SEC-29 — recovering an OLDER package never moves the record's
    // "latest package" pointer backwards.
    expect(
      (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { verificationPackageVersion: true } }))
        .verificationPackageVersion,
    ).toBe(pointerBefore.verificationPackageVersion);
    expect(pointerBefore.verificationPackageVersion).toBe(2);
    const after = await state(evidenceId);
    expect(after.reports.map((x) => x.version), "no report is minted to repair a package").toEqual([1, 2]);
    expect(after.packages.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1], [2, 2]]);
    const v1 = after.reports.find((x) => x.version === 1)!;
    // ET-RPT-07 — the request records the report it TARGETED (v1), not the newest (v2).
    const done = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: idOf(r) },
      select: { state: true, terminalReasonCode: true, resultReportId: true },
    });
    const v1Row = await prisma.report.findUniqueOrThrow({
      where: { evidenceId_version: { evidenceId, version: 1 } },
      select: { id: true },
    });
    expect(done).toEqual({ state: "SUCCEEDED", terminalReasonCode: "package_built", resultReportId: v1Row.id });
    expect(sha256Hex(packageReportBytes(after.packages[0]!, 1))).toBe(v1.pdfSha256);

    // A package assembled after its report says so in words (2026-09-29).
    const entries = readZipEntries(stored(after.packages[0]!.storageBucket, after.packages[0]!.storageKey)!);
    const readmeKey = [...entries.keys()].find((k) => /README/i.test(k))!;
    const readme = entries.get(readmeKey)!.toString("utf8");
    expect(readme).toContain("CHRONOLOGY");
    expect(readme).toMatch(/after report version 1 was issued on/);
    expect(readme).toContain("may record facts that are later than the report");
  });

  it("CHRONOLOGY: a package issued WITH its report carries no after-issue section", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    expect(await run(await request({ evidenceId, teamId }), 0)).toBeNull();
    const s1 = await state(evidenceId);
    const entries = readZipEntries(stored(s1.packages[0]!.storageBucket, s1.packages[0]!.storageKey)!);
    const readmeKey = [...entries.keys()].find((k) => /README/i.test(k))!;
    expect(entries.get(readmeKey)!.toString("utf8")).not.toContain("CHRONOLOGY");
  });

  it("EXACT VERSION: a package for a report version that does not exist is refused, not queued", async () => {
    const { evidenceId } = await historicalGap();
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 9 });
    expect(r).toMatchObject({ kind: "declined", reason: "CONSISTENCY_REVIEW_REQUIRED" });
  });

  it.each([
    ["PENDING_DESTRUCTION", "PENDING_DESTRUCTION"],
    ["TRASHED", "EVIDENCE_TRASHED"],
    ["ARCHIVED", "EVIDENCE_ARCHIVED"],
  ] as const)("EXACT VERSION: an operator cannot build a package for a %s record", async (lifecycleState, reason) => {
    const { evidenceId } = await historicalGap();
    await prisma.evidence.update({ where: { id: evidenceId }, data: { lifecycleState } as never });
    const before = await prisma.reportGenerationRequest.count({ where: { evidenceId } });
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    expect(r).toMatchObject({ kind: "declined", reason });
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId } })).toBe(before);
    await prisma.evidence.update({ where: { id: evidenceId }, data: { lifecycleState: "ACTIVE" } as never });
  });

  it("EXACT VERSION: two concurrent recoveries of one version produce ONE request", async () => {
    const { evidenceId } = await historicalGap();
    const [a, b] = await Promise.all([
      operatorRecover(evidenceId, { packageForReportVersion: 1 }),
      operatorRecover(evidenceId, { packageForReportVersion: 1 }),
    ]);
    expect(a.kind).toBe("accepted");
    expect(b.kind).toBe("accepted");
    expect(idOf(a)).toBe(idOf(b));
    expect(
      await prisma.reportGenerationRequest.count({
        where: { evidenceId, artifactType: "VERIFICATION_PACKAGE", reportVersion: 1 },
      }),
    ).toBe(1);
  });

  it("OPERATOR SUPERSEDE never issues a new report version beside an issued one", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    expect(await run(await request({ evidenceId, teamId }), 0)).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    // An exhausted attempt to go BEYOND report v1 (a failed updated report).
    const failed = await request({ evidenceId, teamId, forceRegenerate: true });
    await prisma.reportGenerationRequest.update({
      where: { id: failed },
      data: { state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted", completedAtUtc: new Date() },
    });
    const before = await prisma.reportGenerationRequest.count({ where: { evidenceId } });
    const r = await operatorRecover(evidenceId, { operatorSupersede: true, regenerateReason: "operations_supersede" });
    expect(r).toMatchObject({ kind: "declined", requiresExplicitNewVersion: true });
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId } })).toBe(before);
    expect((await state(evidenceId)).reports.map((x) => x.version)).toEqual([1]);
  });

  it("RETRY of a missing package never resumes a pending NEW_VERSION request beside it", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const first = await request({ evidenceId, teamId });
    seam.packageBuildFailures = 1;
    await run(first, 0);
    await prisma.reportGenerationRequest.update({
      where: { id: first },
      data: { state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted", completedAtUtc: new Date() },
    });
    await new Promise((r) => setTimeout(r, 5));
    // The LATEST request of any type: a failed-retryable forced request.
    const forced = await request({ evidenceId, teamId, forceRegenerate: true });
    await prisma.reportGenerationRequest.update({
      where: { id: forced },
      data: { state: "FAILED_RETRYABLE", terminalReasonCode: "ACC", attemptCount: 1 },
    });
    // The package control's Retry — the report's failed updated-report request is beside it.
    const r = await operatorRecover(evidenceId, { intent: "RETRY", targetOutput: "verificationPackage" });
    expect(r.kind).toBe("accepted");
    expect(idOf(r)).not.toBe(forced);
    const made = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: idOf(r) },
      select: { artifactType: true, reportVersion: true, forceRegenerate: true },
    });
    expect(made).toEqual({ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, forceRegenerate: false });
    const forcedAfter = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: forced }, select: { state: true } });
    expect(forcedAfter.state, "the forced request was not touched").toBe("FAILED_RETRYABLE");
  });

  it("PUBLISH → CONCURRENT COMMIT: the run does not fail or attach a second package", async () => {
    const { evidenceId } = await historicalGap();
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    const id = idOf(r);
    const concurrentKey = `verification/${evidenceId}/v1/concurrent.zip`;
    // A concurrent issuance re-reserves THE SAME rows (same package ids) and
    // publishes them while this run is between publication and commit.
    seam.packageVerifyHook = async () => {
      const otherIssuance = randomUUID();
      await prisma.verificationPackage.updateMany({
        where: { evidenceId, version: 1 },
        data: {
          issuanceId: otherIssuance,
          state: "PUBLISHED",
          storageBucket: process.env.S3_BUCKET!,
          storageKey: concurrentKey,
          generatedAtUtc: new Date(),
          completedAtUtc: new Date(),
        } as never,
      });
    };
    const before = (await state(evidenceId, id)).packageRows.map((p) => p.id);
    expect(await run(id, 0)).toBeNull();
    const after = await state(evidenceId, id);
    // Nothing attached a second package: the same rows, the same ids, the
    // concurrent issuance's objects.
    expect(after.packageRows.filter((p) => p.version === 1)).toHaveLength(2);
    const v1Rows = after.packageRows.filter((p) => p.version === 1);
    expect(v1Rows.every((p) => p.state === "PUBLISHED" && p.storageKey === concurrentKey)).toBe(true);
    if (before.length) expect(after.packageRows.map((p) => p.id).sort()).toEqual([...new Set([...before, ...v1Rows.map((p) => p.id)])].sort());
    expect(after.req!.state).toBe("SUCCEEDED");
  });

  it("STALE BASELINE: a report digest that moved before commit is refused, never attached", async () => {
    const { evidenceId } = await historicalGap();
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    const id = idOf(r);
    seam.packageVerifyHook = async () => {
      await prisma.report.update({
        where: { evidenceId_version: { evidenceId, version: 1 } },
        data: { pdfSha256: "0".repeat(64) } as never,
      });
    };
    expect(await run(id, 0)).toBeTruthy();
    const after = await state(evidenceId, id);
    expect(after.packages.map((p) => p.version)).toEqual([2]);
    expect(after.req!.state).toBe("FAILED_TERMINAL");
  });

  it("UNREADABLE ORIGINAL: recovery stops on the first 404, names it, builds nothing, offers no Recover", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const first = await request({ evidenceId, teamId });
    seam.packageBuildFailures = 1;
    await run(first, 0);
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { storageBucket: true, storageKey: true },
    });
    storage.objects.delete(storage.at(ev.storageBucket!, ev.storageKey!));
    const err = await run(first, 1);
    expect((err as { code?: string }).code).toBe("EVIDENCE_ORIGINAL_NOT_FOUND");
    const after = await state(evidenceId, first);
    expect(after.req).toMatchObject({ state: "FAILED_TERMINAL", terminalReasonCode: "EVIDENCE_ORIGINAL_NOT_FOUND" });
    expect(after.reports.map((x) => x.version)).toEqual([1]);
    expect(after.packages).toEqual([]);
    const evAfter = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } });
    expect(evAfter.status, "a 404 is not an integrity failure").not.toBe("FAILED_HASH_MISMATCH");

    const { loadEvidenceOutputFacts } = await recovery();
    const loaded = (await loadEvidenceOutputFacts({ evidenceIds: [evidenceId], callerIsPlatformOperator: true })).get(evidenceId)!;
    expect(loaded.actions.verificationPackage.action).toBe("NONE");
    const { outputNoteCopy } = await import("@proovra/shared");
    const note = outputNoteCopy({
      actionUnavailableReason: loaded.actions.verificationPackage.reason,
      terminalReasonCode: loaded.packageRequest?.terminalReasonCode ?? null,
    });
    expect(note).toMatch(/cannot currently be read from storage/);
    expect(note).not.toMatch(/retries were exhausted/);
  });

  // -------------------------------------------------------------------------
  // EVIDENCE-OUTPUT INCIDENT (2026-10-05) — FREE skip → internal TEAM grant →
  // the recovery command → exactly one report + one package, replay-safe.
  // -------------------------------------------------------------------------
  it("a record finalized while FREE is recovered after an internal TEAM grant: one report, one package, no duplicate on replay", async () => {
    const { recoverEvidenceOutputs, evidenceOutputStatus } = await import("../../src/scripts/recover-evidence-outputs.js");
    const { applyInternalPlanGrant } = await import("../../src/services/billing/internal-plan-grant.service.js");

    // A Personal-workspace FREE account, as in the incident.
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { email: `free-${tag}@example.test`, provider: "EMAIL", providerUserId: `free-${tag}` } as never,
      select: { id: true },
    });
    const org = await prisma.organization.create({ data: { name: `Personal ${tag}` } as never, select: { id: true } });
    const team = await prisma.team.create({
      data: { name: `Personal ${tag}`, ownerUserId: user.id, organizationId: org.id, workspaceKind: "PERSONAL", isPersonal: true } as never,
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, role: "OWNER" } as never }).catch(() => undefined);
    await prisma.entitlement.create({ data: { userId: user.id, plan: "FREE", active: true } });

    // SIGNED with its original stored — what finalization left behind.
    const body = Buffer.from(`incident original ${tag}\n`);
    const ev = await prisma.evidence.create({
      data: { title: "Incident fixture", type: "PHOTO", status: "CREATED", teamId: team.id, organizationId: org.id, ownerUserId: user.id },
      select: { id: true },
    });
    createdEvidence.push(ev.id);
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
        fingerprintHash: "8".repeat(64),
        fingerprintCanonicalJson: JSON.stringify({ incident: ev.id }),
        storageBucket: process.env.S3_BUCKET!,
        storageKey,
        mimeType: "text/plain",
        sizeBytes: BigInt(body.length),
        fileSha256: sha256Hex(body),
      },
    });
    const requestsFor = () => prisma.reportGenerationRequest.findMany({ where: { evidenceId: ev.id }, select: { id: true, purpose: true } });

    // 1. FREE: recovery is refused as not entitled, and nothing is queued.
    const free = await recoverEvidenceOutputs({ evidenceId: ev.id, apply: true });
    expect(free.summary).toMatchObject({ notEntitled: 1, requested: 0 });
    expect(await requestsFor()).toEqual([]);

    // 2. The internal TEAM grant (the canonical service, never SQL).
    const grant = await applyInternalPlanGrant({
      userId: user.id,
      plan: "TEAM",
      reason: "Owner-authorized PROOVRA end-to-end product testing",
      idempotencyKey: `owner-test:free-${tag}@example.test:team:2026-10`,
      expiresAtUtc: new Date(Date.now() + 90 * 86_400_000),
      actorUserId: randomUUID(),
    });
    expect(grant.created).toBe(true);

    // 3. Dry-run decides without writing; apply writes exactly ONE request.
    expect((await recoverEvidenceOutputs({ evidenceId: ev.id })).summary).toMatchObject({ wouldRequest: 1, requested: 0 });
    expect(await requestsFor()).toEqual([]);
    const applied = await recoverEvidenceOutputs({ evidenceId: ev.id, apply: true });
    expect(applied.summary).toMatchObject({ requested: 1, refused: 0 });
    const [req] = await requestsFor();
    expect(req.purpose).toBe("first_issuance");
    // A second apply before the worker ran collapses onto the same request.
    const again = await recoverEvidenceOutputs({ evidenceId: ev.id, apply: true });
    expect(again.summary.requested).toBe(0);
    expect(await requestsFor()).toHaveLength(1);

    // 4. The real processor: report + REPORTED, then the package for THAT version.
    expect(await run(req.id)).toBeNull();
    const done = await state(ev.id, req.id);
    expect(done.req?.state).toBe("SUCCEEDED");
    expect(done.reports.map((r) => r.version)).toEqual([1]);
    expect(done.packages.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1]]);
    const evAfter = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true } });
    expect(evAfter.status).toBe("REPORTED");
    // Both objects are durable, and the package carries the exact stored report.
    const reportBytes = stored(done.reports[0].storageBucket, done.reports[0].storageKey);
    expect(reportBytes).toBeTruthy();
    expect(packageReportBytes(done.packages[0], 1).equals(reportBytes!)).toBe(true);
    expect(done.packages[0].reportSha256).toBe(sha256Hex(reportBytes!));

    // 5. Replay: nothing to recover, no new request, report or package.
    const replay = await recoverEvidenceOutputs({ evidenceId: ev.id, apply: true });
    expect(replay.summary).toMatchObject({ notApplicable: 1, requested: 0 });
    expect(await requestsFor()).toHaveLength(1);
    const after = await state(ev.id);
    expect(after.reports).toHaveLength(1);
    expect(after.packages).toHaveLength(1);

    // 6. The status command proves completeness (both objects exist).
    expect(await evidenceOutputStatus({ evidenceId: ev.id, expectComplete: true })).toBe(0);
  }, 180_000);

  // -------------------------------------------------------------------------
  // PACKAGE ID IDEMPOTENCY (2026-10-07)
  //
  // A package id is RESERVED (a row per profile, state RESERVED) before any
  // byte is built, in the claim-fenced transaction, and every retry, BullMQ
  // redelivery, duplicate delivery and recovery of the same (evidence,
  // version, profile) carries that same id until it is PUBLISHED. These cases
  // drive the real processor through each failure point and assert: the same
  // ids, one row per profile, no "successful" orphan (a published row always
  // names the object it verified; an unrecorded object is never a package),
  // the id sealed inside each ZIP, and no evidence credit moved.
  // -------------------------------------------------------------------------
  const rowsOf = async (evidenceId: string, version: number) =>
    (await state(evidenceId)).packageRows.filter((p) => p.version === version);
  const idsByProfile = (rows: Array<{ id: string; disclosureProfile: string | null }>) =>
    Object.fromEntries(rows.map((r) => [r.disclosureProfile ?? "LEGACY", r.id]));
  const creditEntries = (evidenceId: string) =>
    prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId } });
  const manifestPackageId = (pkg: { storageBucket: string; storageKey: string }) => {
    const entries = readZipEntries(stored(pkg.storageBucket, pkg.storageKey)!);
    const key = [...entries.keys()].find((k) => k === "package-manifest.json");
    return (JSON.parse(entries.get(key!)!.toString("utf8")) as { packageId?: string }).packageId;
  };
  async function expectPublishedPair(evidenceId: string, version: number, ids: Record<string, string>) {
    const rows = await rowsOf(evidenceId, version);
    expect(rows, "one row per profile").toHaveLength(2);
    expect(idsByProfile(rows), "the reserved ids, unchanged").toEqual(ids);
    for (const row of rows) {
      expect(row.state).toBe("PUBLISHED");
      expect(stored(row.storageBucket, row.storageKey), "a published row names a stored object").toBeTruthy();
      expect(manifestPackageId(row), "the id sealed inside the ZIP is the row id").toBe(row.id);
    }
    return rows;
  }

  it("IDEMPOTENCY: a crash BEFORE upload keeps the reserved ids; the retry publishes them", async () => {
    const ev = await signedEvidence();
    const credits = await creditEntries(ev.evidenceId);
    const id = await request(ev);
    seam.packageBuildFailures = 1;
    expect(await run(id, 0), "the build failure surfaces").toBeTruthy();
    const failed = await rowsOf(ev.evidenceId, 1);
    expect(failed).toHaveLength(2);
    for (const row of failed) {
      expect(row.state).toBe("FAILED");
      expect(row.issuanceId).toBe(id);
      expect(row.terminalReason).toBeTruthy();
      expect(row.storageKey, "nothing was stored").toBeNull();
    }
    const ids = idsByProfile(failed);
    expect(await run(id, 1)).toBeNull();
    await expectPublishedPair(ev.evidenceId, 1, ids);
    expect(await creditEntries(ev.evidenceId), "generation never consumes credit").toBe(credits);
  });

  it("IDEMPOTENCY: a crash AFTER upload, before the DB commit, leaves only an unreferenced object; the retry reuses the ids", async () => {
    const ev = await signedEvidence();
    const id = await request(ev);
    const before = new Set(storage.objects.keys());
    seam.packageVerifyHook = async () => {
      throw new Error("ACC_CRASH_AFTER_UPLOAD");
    };
    expect(await run(id, 0)).toBeTruthy();
    const orphans = [...storage.objects.keys()].filter((k) => !before.has(k) && k.includes("/verification/"));
    expect(orphans.length, "the upload happened").toBeGreaterThan(0);
    const reserved = await rowsOf(ev.evidenceId, 1);
    expect(reserved.every((r) => r.state !== "PUBLISHED"), "nothing claims the uploaded object").toBe(true);
    const ids = idsByProfile(reserved);
    expect(await run(id, 1)).toBeNull();
    const published = await expectPublishedPair(ev.evidenceId, 1, ids);
    for (const row of published) {
      expect(orphans, "a published row never names the crashed attempt's object").not.toContain(storage.at(row.storageBucket, row.storageKey));
    }
  });

  it("IDEMPOTENCY: a REDELIVERED job after success builds and publishes nothing", async () => {
    const ev = await signedEvidence();
    const id = await request(ev);
    expect(await run(id, 0)).toBeNull();
    const rows = await rowsOf(ev.evidenceId, 1);
    const ids = idsByProfile(rows);
    const calls = seam.packageBuildCalls;
    const objects = storage.objects.size;
    expect(await run(id, 1)).toBeNull();
    expect(await run(id, 2)).toBeNull();
    expect(seam.packageBuildCalls, "no rebuild").toBe(calls);
    expect(storage.objects.size, "no new object").toBe(objects);
    await expectPublishedPair(ev.evidenceId, 1, ids);
  });

  it("IDEMPOTENCY: a DUPLICATE delivery (two workers at once) publishes one pair", async () => {
    const ev = await signedEvidence();
    const id = await request(ev);
    const results = await Promise.all([run(id, 0), run(id, 0)]);
    // One delivery claims the request; the other is a no-op answer.
    expect(results.filter((r) => r === null).length).toBeGreaterThanOrEqual(1);
    if (results.some((r) => r !== null)) expect(await run(id, 1)).toBeNull();
    const rows = await rowsOf(ev.evidenceId, 1);
    expect(rows).toHaveLength(2);
    await expectPublishedPair(ev.evidenceId, 1, idsByProfile(rows));
    const reports = (await state(ev.evidenceId)).reports.map((r) => r.version);
    expect(reports, "one report version").toEqual([1]);
  });

  it("IDEMPOTENCY: a RECOVERY by a new request reuses the failed ids (and only re-issues them)", async () => {
    const { evidenceId } = await historicalGap();
    // historicalGap left report v1 whose package build failed: its rows are FAILED.
    const failed = await rowsOf(evidenceId, 1);
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.state === "FAILED")).toBe(true);
    const ids = idsByProfile(failed);
    const credits = await creditEntries(evidenceId);
    const r = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    expect(await run(idOf(r), 0)).toBeNull();
    const published = await expectPublishedPair(evidenceId, 1, ids);
    expect(published.every((row) => row.issuanceId === idOf(r)), "the recovering request issued them").toBe(true);
    // Version 2's packages are untouched by the v1 recovery.
    expect((await rowsOf(evidenceId, 2)).every((row) => row.state === "PUBLISHED")).toBe(true);
    expect(await creditEntries(evidenceId)).toBe(credits);
  });

  it("IDEMPOTENCY: two CONCURRENT recovery runs of one version publish one pair under one set of ids", async () => {
    const { evidenceId } = await historicalGap();
    const ids = idsByProfile(await rowsOf(evidenceId, 1));
    const a = await operatorRecover(evidenceId, { packageForReportVersion: 1 });
    // A second, independent request row for the same version (as a reconciler
    // or operator could create) racing the first.
    const second = await request({
      evidenceId,
      teamId: harness.fixtures.teamA.teamId,
      artifactType: "VERIFICATION_PACKAGE",
      reportVersion: 1,
    });
    const results = await Promise.all([run(idOf(a), 0), run(second, 0)]);
    for (const [i, res] of results.entries()) {
      if (res !== null) expect(await run(i === 0 ? idOf(a) : second, 1)).toBeNull();
    }
    await expectPublishedPair(evidenceId, 1, ids);
  });


  // -------------------------------------------------------------------------
  // OTS PENDING REPORT REGRESSION (production 2026-10-08, evidence
  // ce465a9e…): the payload was prepared while otsStatus was still null, OTS
  // initialization committed PENDING before the render gate re-read the
  // record, and the gate failed a valid report terminally ("record PENDING,
  // payload UNAVAILABLE") into the DLQ. One run now states ONE record snapshot.
  // -------------------------------------------------------------------------
  const anchoringOf = async (evidenceId: string, version: number) => {
    const { readStoredTrustDecision } = await import("@proovra/shared");
    const report = await prisma.report.findUniqueOrThrow({
      where: { evidenceId_version: { evidenceId, version } },
      select: { trustDecisionSnapshot: true },
    });
    return readStoredTrustDecision(report.trustDecisionSnapshot)!.signals.find((s) => s.key === "bitcoin_anchoring")!;
  };
  const otsPending = { otsStatus: "PENDING", otsHash: "7".repeat(64), otsCalendar: "https://calendar.example" } as const;

  it("OTS PENDING: report v1 and both package profiles publish; OTS is stated PENDING (NOT_CHECKED), never UNAVAILABLE", async () => {
    const ev = await signedEvidence();
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: otsPending as never });
    const credits = await creditEntries(ev.evidenceId);
    const id = await request(ev);
    expect(await run(id, 0)).toBeNull();
    const pair = await rowsOf(ev.evidenceId, 1);
    expect(pair.map((r) => r.state)).toEqual(["PUBLISHED", "PUBLISHED"]);
    const anchoring = await anchoringOf(ev.evidenceId, 1);
    expect(anchoring.state).toBe("PENDING");
    const { toVerificationStatus } = await import("@proovra/shared");
    expect(toVerificationStatus(anchoring.state)).toBe("NOT_CHECKED");
    // Both sealed packages state the same OTS row: pending, not chain-verified.
    for (const row of pair) {
      const m = JSON.parse(readZipEntries(stored(row.storageBucket, row.storageKey)!).get("trust-decision.json")!.toString("utf8")) as {
        rows: Array<{ key: string; status: string; statement: string }>;
      };
      const ots = m.rows.find((r) => r.key === "ots_anchoring")!;
      expect(ots.status, row.disclosureProfile ?? "").toBe("NOT_CHECKED");
      expect(ots.statement).toMatch(/pending/i);
      expect(ots.statement).toMatch(/not been independently chain-verified/);
    }
    const request_ = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { state: true } });
    expect(request_.state).not.toMatch(/FAILED|DLQ/);
    expect(await creditEntries(ev.evidenceId), "no credit moved").toBe(credits);
  });

  it("RACE: OTS initialization commits AFTER the payload was prepared, BEFORE rendering — the run succeeds and states PENDING", async () => {
    const ev = await signedEvidence(); // otsStatus null when the run prepares its payload
    seam.beforeRenderSnapshot = async () => {
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: otsPending as never });
    };
    const id = await request(ev);
    expect(await run(id, 0), "no REPORT_RENDER_INPUT_INCONSISTENT for a valid report").toBeNull();
    expect(seam.beforeRenderSnapshot, "the commit landed in the window").toBeNull();
    expect((await anchoringOf(ev.evidenceId, 1)).state, "the report states the record's PENDING, not UNAVAILABLE").toBe("PENDING");
    expect((await rowsOf(ev.evidenceId, 1)).map((r) => r.state)).toEqual(["PUBLISHED", "PUBLISHED"]);
  });

  it("RACE: OTS advances WHILE the report renders — the issuance keeps its snapshot; packages publish; no false inconsistency", async () => {
    const ev = await signedEvidence();
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: otsPending as never });
    seam.afterRenderSnapshot = async () => {
      await prisma.evidence.update({
        where: { id: ev.evidenceId },
        data: {
          otsStatus: "ANCHORED",
          otsProofBase64: Buffer.from("ots-proof").toString("base64"),
          otsBitcoinTxid: "c".repeat(64),
          otsAnchoredAtUtc: new Date(),
          otsUpgradedAtUtc: new Date(),
          otsAnchorCheck: "PROOF_STRUCTURE",
        } as never,
      });
    };
    const id = await request(ev);
    expect(await run(id, 0)).toBeNull();
    expect(seam.afterRenderSnapshot, "the upgrade landed after the snapshot, while rendering").toBeNull();
    expect((await anchoringOf(ev.evidenceId, 1)).state, "the issuance states its own snapshot").toBe("PENDING");
    expect((await rowsOf(ev.evidenceId, 1)).map((r) => r.state)).toEqual(["PUBLISHED", "PUBLISHED"]);
  });


  it("RECOVERY of the production DLQ shape: a v1 request failed non-retriably at the render gate is superseded ONCE by the operator path — one report, one pair, no credit, no duplicate on replay", async () => {
    const ev = await signedEvidence();
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: otsPending as never });
    const credits = await creditEntries(ev.evidenceId);
    // The completion path's own request (production: REPORT:<id>:v0).
    const { requestReportGeneration } = await import("../../src/services/reports/report-generation-authority.service.js");
    const completion = await requestReportGeneration({
      evidenceId: ev.evidenceId,
      purpose: "evidence_completed",
      requestedByMachineId: "api.evidence-complete",
    } as never);
    const failedId = (completion as { requestId: string }).requestId;
    expect(failedId).toBeTruthy();
    // The production failure, through the real processor: terminal, DLQ, no report.
    seam.renderInputFailures = 1;
    const err = await run(failedId, 0);
    expect(String((err as Error)?.message)).toMatch(/REPORT_RENDER_INPUT_INCONSISTENT/);
    const failedRow = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: failedId },
      select: { state: true, terminalReasonCode: true, idempotencyKey: true },
    });
    expect(failedRow.state).toBe("FAILED_TERMINAL");
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } })).toBe(0);

    // The canonical operator path (POST /v1/admin/incidents/:id/remediate
    // { supersede: true, reason } → requestOutputRecovery operatorSupersede).
    const recovered = await operatorRecover(ev.evidenceId, { operatorSupersede: true });
    expect(recovered.kind).toBe("accepted");
    const newId = idOf(recovered);
    expect(newId).not.toBe(failedId);
    const newRow = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: newId }, select: { idempotencyKey: true } });
    expect(failedRow.idempotencyKey).toBe(`REPORT:${ev.evidenceId}:v0`);
    expect(newRow.idempotencyKey).toBe(`${failedRow.idempotencyKey}:s1`);

    // Replays before the run collapse onto the live request — never a second one.
    const replay = await operatorRecover(ev.evidenceId, { operatorSupersede: true });
    expect(replay.kind === "accepted" ? idOf(replay) : newId).toBe(newId);

    expect(await run(newId, 0)).toBeNull();
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } }), "exactly one report").toBe(1);
    const pair = await rowsOf(ev.evidenceId, 1);
    expect(pair.map((r) => r.state)).toEqual(["PUBLISHED", "PUBLISHED"]);
    expect((await anchoringOf(ev.evidenceId, 1)).state).toBe("PENDING");

    // After success a further operator attempt finds nothing to recover.
    const after = await operatorRecover(ev.evidenceId, { operatorSupersede: true });
    expect(after.kind).toBe("declined");
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } })).toBe(1);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: ev.evidenceId } }), "one row per profile").toBe(2);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } }), "the dead row and ONE successor").toBe(2);
    // The failed row is kept, unchanged, as the record of the failure.
    expect(
      await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: failedId }, select: { state: true, terminalReasonCode: true, idempotencyKey: true } }),
    ).toEqual(failedRow);
    expect(await creditEntries(ev.evidenceId), "recovery consumes no credit").toBe(credits);
  });

  // -------------------------------------------------------------------------
  // EVIDENCE-DETAIL RECOVERY UX (2026-10-08). The record itself offers
  // "Retry report generation" for an exhausted TECHNICAL Report v1 failure to
  // a caller holding the EXISTING supersession right, and the click runs the
  // SAME supersession the Operations remediation runs — through the Evidence
  // route's own call into requestOutputRecovery, re-derived at click time.
  // -------------------------------------------------------------------------
  /** Exactly the Evidence route's call for a per-output Retry. */
  const recordRetry = async (
    evidenceId: string,
    actorUserId: string,
    over: Record<string, unknown> = {},
  ) => {
    const { requestOutputRecovery } = await recovery();
    return requestOutputRecovery({
      evidenceId,
      actorUserId,
      intent: "RETRY",
      targetOutput: "report",
      purpose: "operator_regenerate",
      regenerateReason: "recovery_requested",
      resolveSupersedeRight: true,
      ...over,
    } as never);
  };
  const recordActions = async (evidenceId: string, callerUserId: string, resolveSupersedeRight = true) => {
    const { loadEvidenceOutputFacts } = await recovery();
    return (await loadEvidenceOutputFacts({ evidenceIds: [evidenceId], callerUserId, resolveSupersedeRight })).get(evidenceId)!;
  };
  /** The production DLQ shape: Report v1 failed non-retriably, no report. */
  async function failedFirstIssuance() {
    const ev = await signedEvidence();
    const { requestReportGeneration } = await import("../../src/services/reports/report-generation-authority.service.js");
    const completion = await requestReportGeneration({
      evidenceId: ev.evidenceId,
      purpose: "evidence_completed",
      requestedByMachineId: "api.evidence-complete",
    } as never);
    const failedId = (completion as { requestId: string }).requestId;
    seam.renderInputFailures = 1;
    expect(String(((await run(failedId, 0)) as Error)?.message)).toMatch(/REPORT_RENDER_INPUT_INCONSISTENT/);
    const failedRow = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: failedId },
      select: { state: true, terminalReasonCode: true, idempotencyKey: true, attemptCount: true, completedAtUtc: true },
    });
    expect(failedRow.state).toBe("FAILED_TERMINAL");
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } })).toBe(0);
    return { ...ev, failedId, failedRow };
  }
  const requestCount = (evidenceId: string) => prisma.reportGenerationRequest.count({ where: { evidenceId } });

  it("RECORD RETRY: the right holder is offered 'Retry report generation'; a viewer, another tenant and the non-opted surfaces are not", async () => {
    const ev = await failedFirstIssuance();
    const { teamA, teamB } = harness.fixtures;

    const owner = await recordActions(ev.evidenceId, teamA.ownerUserId);
    expect(owner.facts.callerMaySupersede).toBe(true);
    expect(owner.actions.report).toEqual({
      action: "RETRY",
      reason: null,
      operation: "FULL_GENERATION",
      supersedesTechnicalTerminal: true,
    });
    expect(owner.actions.newVersion.action, "never a new version when v1 never existed").toBe("NONE");

    // A viewer holds neither right: the escalation stays, read-only.
    const viewer = await recordActions(ev.evidenceId, teamA.viewerUserId);
    expect(viewer.facts.callerMaySupersede).toBe(false);
    expect(viewer.actions.report.action).toBe("NONE");
    // Another workspace's owner: no record access, so nothing at all.
    const stranger = await recordActions(ev.evidenceId, teamB.ownerUserId);
    expect(stranger.facts.callerMayGenerate).toBe(false);
    expect(stranger.facts.callerMaySupersede).toBe(false);
    expect(stranger.actions.report.action).toBe("NONE");
    // Operations, backfill and list surfaces do not opt in: still escalated.
    const plain = await recordActions(ev.evidenceId, teamA.ownerUserId, false);
    expect(plain.actions.report).toMatchObject({ action: "NONE", reason: "ESCALATED_TO_OPERATOR" });

    // The server re-decides at click time: a viewer's (or another tenant's) click creates nothing.
    const before = await requestCount(ev.evidenceId);
    for (const actor of [teamA.viewerUserId, teamB.ownerUserId]) {
      const r = await recordRetry(ev.evidenceId, actor);
      expect(r.kind, actor).toBe("declined");
    }
    expect(await requestCount(ev.evidenceId)).toBe(before);
  });

  it("RECORD RETRY: double and concurrent clicks create ONE successor; v1 and both packages land; the failed request stays as history; no credit", async () => {
    const ev = await failedFirstIssuance();
    const owner = harness.fixtures.teamA.ownerUserId;
    const credits = await creditEntries(ev.evidenceId);

    // Three concurrent clicks, then a double-click replay before any worker runs.
    const clicks = await Promise.all([1, 2, 3].map(() => recordRetry(ev.evidenceId, owner)));
    for (const c of clicks) expect(c.kind).toBe("accepted");
    const ids = new Set(clicks.map(idOf));
    expect(ids.size, "concurrent clicks resolve to one request").toBe(1);
    const [successorId] = [...ids];
    expect(successorId).not.toBe(ev.failedId);
    const replay = await recordRetry(ev.evidenceId, owner);
    expect(replay.kind === "accepted" ? idOf(replay) : successorId, "a replay collapses onto it").toBe(successorId);
    expect(await requestCount(ev.evidenceId), "the dead row and ONE successor").toBe(2);
    const successor = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: successorId },
      select: { idempotencyKey: true, forceRegenerate: true, regenerateReason: true },
    });
    expect(successor.idempotencyKey).toBe(`${ev.failedRow.idempotencyKey}:s1`);
    expect(successor.forceRegenerate, "a first issuance, not a new version").toBe(false);
    expect(successor.regenerateReason).toBe("retry_after_exhausted_failure");

    // While it is live the record offers no second retry.
    expect((await recordActions(ev.evidenceId, owner)).actions.report).toMatchObject({ action: "NONE", reason: "IN_PROGRESS" });

    expect(await run(successorId, 0)).toBeNull();
    const s = await state(ev.evidenceId);
    expect(s.reports.map((r) => r.version), "exactly Report v1 — no v2").toEqual([1]);
    expect((await rowsOf(ev.evidenceId, 1)).map((r) => r.state), "both profiles published").toEqual(["PUBLISHED", "PUBLISHED"]);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: ev.evidenceId } }), "one row per profile").toBe(2);

    // Refresh / replay after success: nothing more is created.
    const stale = await recordRetry(ev.evidenceId, owner);
    expect(stale.kind).toBe("declined");
    expect(await requestCount(ev.evidenceId)).toBe(2);
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } })).toBe(1);
    const done = await recordActions(ev.evidenceId, owner);
    expect(done.actions.report.reason).toBe("NOT_REQUIRED");
    expect(done.actions.verificationPackage.reason).toBe("NOT_REQUIRED");

    // The failed request is history, unchanged.
    expect(
      await prisma.reportGenerationRequest.findUniqueOrThrow({
        where: { id: ev.failedId },
        select: { state: true, terminalReasonCode: true, idempotencyKey: true, attemptCount: true, completedAtUtc: true },
      }),
    ).toEqual(ev.failedRow);
    expect(await creditEntries(ev.evidenceId), "recovery consumes no credit").toBe(credits);
  });

  it("RECORD RETRY: an integrity or policy terminal is never superseded, whoever clicks", async () => {
    for (const code of ["EVIDENCE_INTEGRITY_FAILED", "WORKSPACE_MISMATCH"]) {
      const ev = await failedFirstIssuance();
      await prisma.reportGenerationRequest.update({ where: { id: ev.failedId }, data: { terminalReasonCode: code } });
      const owner = harness.fixtures.teamA.ownerUserId;
      const loaded = await recordActions(ev.evidenceId, owner);
      expect(loaded.actions.report.action, code).toBe("NONE");
      expect(loaded.actions.report.reason, code).not.toBe("ESCALATED_TO_OPERATOR");
      const before = await requestCount(ev.evidenceId);
      const r = await recordRetry(ev.evidenceId, owner);
      expect(r.kind, code).toBe("declined");
      // Even the explicit operator path refuses it.
      const op = await operatorRecover(ev.evidenceId, { operatorSupersede: true });
      expect(op.kind, code).toBe("declined");
      expect(await requestCount(ev.evidenceId), code).toBe(before);
      expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } }), code).toBe(0);
    }
  });

  it("RECORD RETRY of the PACKAGE: report v1 stands, its exhausted technical package failure is retried package-only", async () => {
    const { evidenceId, teamId } = await signedEvidence();
    const first = await request({ evidenceId, teamId });
    seam.packageBuildFailures = 1;
    await run(first, 0);
    await prisma.reportGenerationRequest.update({
      where: { id: first },
      data: { state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted", completedAtUtc: new Date() },
    });
    const owner = harness.fixtures.teamA.ownerUserId;
    const loaded = await recordActions(evidenceId, owner);
    expect(loaded.actions.report.reason).toBe("NOT_REQUIRED");
    expect(loaded.actions.verificationPackage).toEqual({
      action: "RETRY",
      reason: null,
      operation: "PACKAGE_RECOVERY",
      supersedesTechnicalTerminal: true,
    });
    const reportIdentity = (rs: Array<{ version: number; storageKey: string; pdfSha256: string | null }>) => rs.map((r) => [r.version, r.storageKey, r.pdfSha256]);
    const reportBefore = reportIdentity((await state(evidenceId)).reports);
    const clicks = await Promise.all([1, 2].map(() => recordRetry(evidenceId, owner, { targetOutput: "verificationPackage" })));
    for (const c of clicks) expect(c.kind).toBe("accepted");
    expect(new Set(clicks.map(idOf)).size).toBe(1);
    const made = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: idOf(clicks[0]) },
      select: { artifactType: true, reportVersion: true, forceRegenerate: true },
    });
    expect(made).toEqual({ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, forceRegenerate: false });
    expect(await run(idOf(clicks[0]), 0)).toBeNull();
    const after = await state(evidenceId);
    expect(reportIdentity(after.reports), "the stored report is untouched (same version, object and digest)").toEqual(reportBefore);
    expect((await rowsOf(evidenceId, 1)).filter((r) => r.state === "PUBLISHED").length).toBe(2);
  });

});
