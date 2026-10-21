/**
 * FORWARD EVIDENCE OUTPUT PIPELINE — characterization and closure suite
 * (2026-10-20, remediation of the Production-backed evidence-output audit).
 *
 * Every case here runs the REAL worker processor and the REAL request
 * authorities against live PostgreSQL 16 + Redis, with the same storage double
 * and render seams as point5/report-package-recovery (the harness is copied
 * from it verbatim, not re-invented). Each case names the audit finding it
 * pins; each was written to FAIL on origin/main 99c87eea1 before its fix.
 */
import { otsProofForDigest } from "../helpers/ots-proof-bytes.js";
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { tamperSealedEvidence } from "../helpers/sealed-identity-tamper.js";

/** Failure seams, all off by default. Test doubles, not production switches. */
const seam = vi.hoisted(() => ({
  /** Phase 7: the report input the processor handed the renderer, last run. */
  lastRenderInput: null as null | { verificationRef?: string | null; recordedLocationDisclosed?: boolean; evidence: { id: string } },
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
  /**
   * Fail the rendered-report gate this many times exactly as production did
   * (2026-10-09): the PDF could not be read back (PDF.js API/worker mismatch).
   */
  renderedReportUnreadable: 0,
  /** Every exception the WORKER reported to Sentry during a case. */
  sentryCaptures: [] as unknown[],
  /**
   * When set, the worker RUN (resolveEvidenceOutputIssuance) reads this
   * entitlement while the CLAIM (workerOutputEntitlement) still reads the real
   * one: the plan lapsing in the window between claim and prepare.
   */
  runIssuanceOverride: null as null | Record<string, unknown>,
  /** When set, the package allowance gate refuses with this code (once). */
  packageAllowanceRefusal: null as null | "STORAGE_LIMIT_REACHED" | "VERIFICATION_PACKAGE_NOT_INCLUDED",
}));

vi.mock("../../../worker/src/workspace-billing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...actual,
    assertWorkspaceAllowsVerificationPackageArtifact: async (...a: unknown[]) => {
      const code = seam.packageAllowanceRefusal;
      if (code) {
        seam.packageAllowanceRefusal = null;
        throw Object.assign(new Error(code), { code });
      }
      return actual.assertWorkspaceAllowsVerificationPackageArtifact(...a);
    },
  };
});

vi.mock("../../../worker/src/output-issuance.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...actual,
    resolveEvidenceOutputIssuance: async (...a: unknown[]) => seam.runIssuanceOverride ?? actual.resolveEvidenceOutputIssuance(...a),
  };
});

vi.mock("../../../worker/src/sentry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, captureException: (err: unknown) => void seam.sentryCaptures.push(err) };
});

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
    buildReportPdfV2: async (input: unknown) => {
      seam.lastRenderInput = input as typeof seam.lastRenderInput;
      return render();
    },
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
    assertRenderedReport: async () => {
      if (seam.renderedReportUnreadable > 0) {
        seam.renderedReportUnreadable -= 1;
        throw new actual.OutputVerificationError("REPORT_PDF_VERIFICATION_FAILED", [
          { check: "PDF_TEXT", detail: "the rendered PDF could not be read back (PDFJS_RUNTIME_MISMATCH)" },
        ]);
      }
    },
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
  const head = async (p: { bucket: string; key: string }) => {
    const o = storage.objects.get(storage.at(p.bucket, p.key));
    if (!o) {
      const err = new Error(`NoSuchKey: ${p.key}`) as Error & { name: string };
      err.name = "NoSuchKey";
      throw err;
    }
    return { sizeBytes: o.body.length, contentType: o.contentType, metadata: o.metadata } as never;
  };
  return {
    ...actual,
    headObject: head,
    // AUD-011 — the recorded-version HEAD and its probe read the same
    // in-process store (classified through the real classifier).
    headRecordedObject: async (p: { bucket: string; key: string }) => {
      try {
        return await head(p);
      } catch (err) {
        throw new actual.StorageReadError(actual.classifyStorageFailure(err), 404);
      }
    },
    probeStoredObject: async (p: { bucket: string; key: string }) => {
      try {
        const h = (await head(p)) as { sizeBytes: number };
        return { state: "PRESENT" as const, sizeBytes: h.sizeBytes };
      } catch (err) {
        return { state: actual.classifyStorageFailure(err) };
      }
    },
  };
});

const FIXTURE_SIGNING_KEY_ID = "recovery-fixture-key";
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("FORWARD OUTPUT PIPELINE (real processor, live PostgreSQL 16)", () => {
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
    seam.renderedReportUnreadable = 0;
    seam.sentryCaptures.length = 0;
    seam.runIssuanceOverride = null;
    seam.packageAllowanceRefusal = null;
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
        // The digest finalization writes: SHA-256 of the canonical fingerprint
        // (every OTS proof must commit to it, and the package checks that).
        fingerprintHash: createHash("sha256").update(JSON.stringify({ recovery: ev.id })).digest("hex"),
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


  /** The report PDF inside a package, and the package's own manifest claims. */

  // -------------------------------------------------------------------------
  /** A pending OTS proof over THIS record's fingerprint digest (its otsHash is that digest). */
  const otsPendingFor = async (evidenceId: string) => {
    const digest = (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { fingerprintHash: true } })).fingerprintHash!;
    return {
      otsStatus: "PENDING",
      otsHash: digest,
      otsProofBase64: otsProofForDigest(digest),
      otsCalendar: "https://calendar.example",
    };
  };

  const anchoredProofFor = async (evidenceId: string) =>
    otsProofForDigest(
      (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { fingerprintHash: true } })).fingerprintHash!,
      { bitcoinHeight: 860_000 },
    );
  const autoRequests = (evidenceId: string) =>
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId, purpose: "ots_upgrade_completed" },
      select: { id: true, state: true, forceRegenerate: true, clientRequestKey: true, requestedByMachineId: true },
    });
  /**
   * The independent Bitcoin main-chain check, as the worker's chain transition
   * persists it: VERIFIED, bound to THIS proof (verifier proof prefix) and to
   * the attested height.
   */
  const chainVerifiedColumnsFor = (proofBase64: string) => ({
    otsChainVerificationStatus: "VERIFIED",
    otsChainCheckedAtUtc: new Date("2026-10-15T08:00:00.000Z"),
    otsChainVerifiedAtUtc: new Date("2026-10-15T08:00:00.000Z"),
    otsChainBlockHeight: 860_000,
    otsChainBlockHash: "00000000000000000001" + "ab".repeat(22),
    otsChainBlockTimeUtc: new Date("2026-08-01T00:00:00.000Z"),
    otsChainConfirmations: 12,
    otsChainVerifier: `proovra-ots-chain/1;core=310100;min=6;proof=${createHash("sha256").update(Buffer.from(proofBase64, "base64")).digest("hex").slice(0, 16)}`,
    otsChainFailureCode: null,
  });

  // -------------------------------------------------------------------------
  // Shared helpers for the forward cases
  // -------------------------------------------------------------------------
  /** The record as the signing pipeline writes it: a fingerprint that signs the raw file digest. */
  async function signFingerprintRaw(ev: { evidenceId: string; originalSha: string }) {
    const json = JSON.stringify({ recovery: ev.evidenceId, file: { sha256: ev.originalSha } });
    // AUD-43 — the fixture re-seals outside the application path.
    await tamperSealedEvidence(prisma, ev.evidenceId, { fingerprintCanonicalJson: json, fingerprintHash: createHash("sha256").update(json).digest("hex") });
  }
  /** The legacy single-part column form: sha256 of the raw hex (what 21 Production records carry). */
  const legacyComposite = (raw: string) => createHash("sha256").update(raw.toLowerCase()).digest("hex");

  async function setLifecycle(evidenceId: string, lifecycleState: string) {
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { lifecycleState, ...(lifecycleState.includes("ARCHIVED") ? { archivedAt: new Date() } : {}) } as never,
    });
  }

  /** Run `fn` while the fixture workspace is on a plan that includes no reports. */
  async function withNotEntitledWorkspace<T>(fn: () => Promise<T>): Promise<T> {
    const { teamId } = harness.fixtures.teamA;
    const owner = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { ownerUserId: true } });
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "FREE" } });
    const ent = await prisma.entitlement.findFirst({ where: { userId: owner.ownerUserId }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "FREE" } });
    try {
      return await fn();
    } finally {
      await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
      if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "PRO" } });
    }
  }

  /** A signed record with an issued v1 whose proof is now independently verified on the Bitcoin chain. */
  async function chainVerifiedWithV1(opts: { digestForm?: "RAW" | "LEGACY_COMPOSITE" } = {}) {
    const ev = await signedEvidence();
    await signFingerprintRaw(ev);
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: (await otsPendingFor(ev.evidenceId)) as never });
    expect(await run(await request(ev), 0), "v1 must issue").toBeNull();
    if (opts.digestForm === "LEGACY_COMPOSITE") {
      await tamperSealedEvidence(prisma, ev.evidenceId, { fileSha256: legacyComposite(ev.originalSha) });
    }
    const proof = await anchoredProofFor(ev.evidenceId);
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { otsProofBase64: proof } as never });
    const reconcile = await import("../../../worker/src/scripts/reconcile-ots-state.js");
    await reconcile.main(["--apply", "--evidence-id", ev.evidenceId]);
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: chainVerifiedColumnsFor(proof) as never });
    return ev;
  }

  const requestsOf = (evidenceId: string) =>
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId },
      orderBy: { createdAtUtc: "asc" },
      select: { id: true, purpose: true, state: true, terminalReasonCode: true },
    });

  // -------------------------------------------------------------------------
  // PHASE 1 — ONE OUTPUT-PRODUCER GUARD (AUD-01, AUD-02, AUD-35)
  // -------------------------------------------------------------------------
  describe("PHASE 1 — one output-producer guard", () => {
    it.each(["ARCHIVED", "RETENTION_ARCHIVED", "TRASHED", "PENDING_DESTRUCTION"] as const)(
      "AUD-01: a %s record whose proof becomes CHAIN_VERIFIED gets no request, no job, no artifact",
      async (lifecycleState) => {
        const ev = await chainVerifiedWithV1();
        const before = await requestsOf(ev.evidenceId);
        await setLifecycle(ev.evidenceId, lifecycleState);
        const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
        const decision = await reconcileOtsAnchoredReportVersion(ev.evidenceId);
        expect(decision.outcome).not.toBe("requested");
        expect(await requestsOf(ev.evidenceId)).toEqual(before);
        expect((await state(ev.evidenceId)).reports.map((r) => r.version)).toEqual([1]);
      },
      300_000,
    );

    // Each layer of the guard on its own: higher-level producers refuse first,
    // so the request writer and the claim are exercised directly here.
    it("AUD-01: the request writer refuses a lifecycle-ineligible record BEFORE asking the host for entitlement, and writes no row", async () => {
      const ev = await signedEvidence();
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      const { createReportGenerationRequest } = await import("@proovra/shared-runtime/reports");
      let entitlementAsked = 0;
      const res = await createReportGenerationRequest(prisma as never, {
        evidenceId: ev.evidenceId,
        purpose: "lifecycle_recovery",
        artifactType: "REPORT",
        forceRegenerate: false,
        requestedByMachineId: "forward-test",
        entitlement: async () => {
          entitlementAsked += 1;
          return null;
        },
      } as never);
      expect(res).toMatchObject({ created: false, refusal: "NOT_APPLICABLE_ARCHIVED" });
      expect(entitlementAsked, "lifecycle first: no host input for a refused record").toBe(0);
      expect(await requestsOf(ev.evidenceId)).toEqual([]);
    }, 300_000);

    it("AUD-01: a request written while ACTIVE whose record is archived before the claim is settled AT CLAIM, never run", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      const resolution = await authority.resolveAndClaimReportRequest({ requestId: id, requestIdForLog: id });
      expect(resolution).toMatchObject({ outcome: "noop", reason: "NOT_APPLICABLE_ARCHIVED" });
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_ARCHIVED" });
    }, 300_000);

    it("AUD-02: a record whose plan includes no reports gets no chain-verified version request", async () => {
      const ev = await chainVerifiedWithV1();
      const before = await requestsOf(ev.evidenceId);
      await withNotEntitledWorkspace(async () => {
        const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
        const decision = await reconcileOtsAnchoredReportVersion(ev.evidenceId);
        expect(decision.outcome).not.toBe("requested");
      });
      expect(await requestsOf(ev.evidenceId)).toEqual(before);
    }, 300_000);

    it("AUD-02: the worker's own producer (first issuance / recovery) refuses an ARCHIVED or not-entitled record", async () => {
      const archived = await signedEvidence();
      await setLifecycle(archived.evidenceId, "ARCHIVED");
      const res = await authority.requestReportGenerationFromWorker({
        evidenceId: archived.evidenceId,
        purpose: "lifecycle_recovery",
        machineId: "forward-test",
        enqueue: async () => ({ enqueued: true }),
      });
      expect(res.enqueued).toBe(false);
      expect(await requestsOf(archived.evidenceId)).toEqual([]);

      const free = await signedEvidence();
      await withNotEntitledWorkspace(async () => {
        const r = await authority.requestReportGenerationFromWorker({
          evidenceId: free.evidenceId,
          purpose: "lifecycle_recovery",
          machineId: "forward-test",
          enqueue: async () => ({ enqueued: true }),
        });
        expect(r.enqueued).toBe(false);
      });
      expect(await requestsOf(free.evidenceId)).toEqual([]);
    }, 300_000);

    it("AUD-02: the legacy queue drain cannot mint a request for an ARCHIVED record", async () => {
      const ev = await signedEvidence();
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      const minted = await authority.mintRequestForLegacyJob({ evidenceId: ev.evidenceId, jobId: "legacy-1" });
      expect(minted.requestId).toBeNull();
      expect(await requestsOf(ev.evidenceId)).toEqual([]);
    }, 300_000);

    it("AUD-01: the API request authority refuses an ARCHIVED / RETENTION_ARCHIVED record before any row exists", async () => {
      const api = await import("../../src/services/reports/report-generation-authority.service.js");
      for (const lifecycleState of ["ARCHIVED", "RETENTION_ARCHIVED"]) {
        const ev = await signedEvidence();
        await setLifecycle(ev.evidenceId, lifecycleState);
        const out = await api.requestReportGeneration({
          evidenceId: ev.evidenceId,
          purpose: "evidence_completed",
          requestedByMachineId: "forward-test",
        } as never);
        expect(out.requested, lifecycleState).toBe(false);
        expect(await requestsOf(ev.evidenceId)).toEqual([]);
      }
    }, 300_000);

    // AUD-33 (2026-10-20) — mutant F: the API request authority's NOT_INCLUDED
    // answer was unpinned (removing the entitlement reading survived 210
    // tests). An ACTIVE, signed record on a plan that includes no reports is
    // refused as NOT_INCLUDED before any request row exists.
    it("AUD-33/F: the API request authority refuses an ACTIVE record its plan does not include, as NOT_INCLUDED, before any row exists", async () => {
      const api = await import("../../src/services/reports/report-generation-authority.service.js");
      const ev = await signedEvidence();
      const out = await withNotEntitledWorkspace(() =>
        api.requestReportGeneration({
          evidenceId: ev.evidenceId,
          purpose: "evidence_completed",
          requestedByMachineId: "forward-test",
        } as never),
      );
      expect(out.requested).toBe(false);
      expect(out.outcome).toBe("NOT_INCLUDED");
      expect(await requestsOf(ev.evidenceId)).toEqual([]);
      // The control: the same record on the entitled plan IS requested.
      const entitled = await api.requestReportGeneration({
        evidenceId: ev.evidenceId,
        purpose: "evidence_completed",
        requestedByMachineId: "forward-test",
      } as never);
      expect(entitled.requested).toBe(true);
    }, 300_000);


    it("AUD-01: a QUEUED request whose record was archived after enqueue is not run at claim", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      expect(await run(id, 0)).toBeNull();
      const after = await state(ev.evidenceId, id);
      expect(after.reports).toEqual([]);
      expect(after.req!.state).not.toBe("SUCCEEDED");
      expect(after.req!.state).not.toBe("FAILED_TERMINAL");
    }, 300_000);

    it("AUD-01/35: a record archived WHILE its report renders commits no report and no package", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.afterRenderSnapshot = async () => setLifecycle(ev.evidenceId, "ARCHIVED");
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.reports).toEqual([]);
      expect(after.packageRows.filter((p) => p.state === "PUBLISHED")).toEqual([]);
      expect(after.req!.state).not.toBe("FAILED_TERMINAL");
      // The refusal is the BUSINESS one the commit-time admission states, not a
      // technical "state changed" that only happens to publish nothing.
      expect(after.req).toMatchObject({ terminalReasonCode: "NOT_APPLICABLE_ARCHIVED" });
    }, 300_000);

    it("AUD-35: a record trashed WHILE its package builds gets no published package", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.packageVerifyHook = async () => {
        await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { lifecycleState: "TRASHED", deletedAt: new Date() } as never });
      };
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.packageRows.filter((p) => p.state === "PUBLISHED")).toEqual([]);
      // The business refusal of the commit-time admission, stated as such.
      expect(after.req).toMatchObject({ terminalReasonCode: "NOT_APPLICABLE_TRASHED" });
    }, 300_000);

    it("AUD-01: the stranded-request sweep settles an ARCHIVED record's waiting request instead of re-enqueueing it", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      const enqueued: string[] = [];
      await authority.reconcileStrandedReportRequests({
        enqueue: async (requestId: string) => {
          enqueued.push(requestId);
          return { enqueued: true };
        },
      });
      expect(enqueued).not.toContain(id);
      const after = await state(ev.evidenceId, id);
      expect(after.req).toMatchObject({ terminalReasonCode: "NOT_APPLICABLE_ARCHIVED" });
      expect(after.req!.state).not.toBe("FAILED_TERMINAL");
    }, 300_000);

    it("AUD-01: the API re-enqueue refuses an ARCHIVED record's waiting request", async () => {
      const api = await import("../../src/services/reports/report-generation-authority.service.js");
      const ev = await signedEvidence();
      const id = await request(ev);
      await setLifecycle(ev.evidenceId, "RETENTION_ARCHIVED");
      const out = await api.reenqueueReportGenerationRequest(id);
      expect(out).toEqual({ enqueued: false, outcome: "NOT_RECOVERABLE" });
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ terminalReasonCode: "NOT_APPLICABLE_RETENTION_ARCHIVED" });
    }, 300_000);

    it("ACTIVE + entitled: exactly one chain-verified request, and duplicate deliveries collapse onto it", async () => {
      const ev = await chainVerifiedWithV1();
      const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("requested");
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("already_requested");
      expect(await autoRequests(ev.evidenceId)).toHaveLength(1);
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // PHASE 2 — A BUSINESS REFUSAL IS NOT A FAILURE (AUD-03, AUD-04, AUD-12)
  // -------------------------------------------------------------------------
  describe("PHASE 2 — business refusal is not failure", () => {
    const incidentsFor = (evidenceId: string) =>
      prisma.operationalIncident.count({ where: { relatedEvidenceId: evidenceId } });

    it("AUD-03: a plan that lapsed after the request was written settles NOT_APPLICABLE — no throw, no Sentry, no incident", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      const result = await withNotEntitledWorkspace(() => run(id, 0));
      expect(result, "the job must not throw (BullMQ `failed` would fire)").toBeNull();
      const after = await state(ev.evidenceId, id);
      expect(after.req).toMatchObject({ state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_NOT_ENTITLED" });
      expect(after.reports).toEqual([]);
      expect(seam.sentryCaptures).toEqual([]);
      expect(await incidentsFor(ev.evidenceId)).toBe(0);
    }, 300_000);

    it("AUD-03: a plan that lapses between the claim and the run settles NOT_APPLICABLE at run time — no throw, no Sentry, no incident", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.runIssuanceOverride = {
        decision: "NOT_ENTITLED",
        basis: "PLAN",
        reportsIncluded: false,
        verificationPackageIncluded: false,
        mayIssueHistoricalFirstOutputs: false,
      };
      // The run-time gate raises THE refusal itself — never the legacy
      // REPORT_NOT_INCLUDED_IN_PLAN worker error that the plan-denial branch
      // has to translate.
      const { logger: workerLogger } = await import("../../../worker/src/logger.js");
      const warn = vi.spyOn(workerLogger, "warn");
      expect(await run(id, 0)).toBeNull();
      expect(warn.mock.calls.map((c) => c[1])).not.toContain("GenerateReportJob refused: this record's plan does not include the output");
      warn.mockRestore();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({
        state: "NOT_APPLICABLE",
        terminalReasonCode: "NOT_APPLICABLE_NOT_ENTITLED",
      });
      expect(seam.sentryCaptures).toEqual([]);
      expect(await incidentsFor(ev.evidenceId)).toBe(0);
    }, 300_000);

    it("AUD-03: a record archived while its report renders settles NOT_APPLICABLE — no Sentry, no incident", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.afterRenderSnapshot = async () => setLifecycle(ev.evidenceId, "ARCHIVED");
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({
        state: "NOT_APPLICABLE",
        terminalReasonCode: "NOT_APPLICABLE_ARCHIVED",
      });
      expect(seam.sentryCaptures).toEqual([]);
      expect(await incidentsFor(ev.evidenceId)).toBe(0);
    }, 300_000);

    it("AUD-12: a package refused by the storage allowance settles NOT_APPLICABLE_STORAGE_LIMIT — the report stays, no Sentry, no incident", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.packageAllowanceRefusal = "STORAGE_LIMIT_REACHED";
      expect(await run(id, 0)).toBeNull();
      const after = await state(ev.evidenceId, id);
      expect(after.req).toMatchObject({ state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_STORAGE_LIMIT" });
      expect(after.reports.map((r) => r.version), "the report already committed stays issued").toEqual([1]);
      expect(after.packageRows.filter((p) => p.state === "PUBLISHED")).toEqual([]);
      expect(seam.sentryCaptures).toEqual([]);
      expect(await incidentsFor(ev.evidenceId)).toBe(0);
    }, 300_000);

    it("a genuine technical failure still fails terminally, is captured and opens an incident", async () => {
      const ev = await signedEvidence();
      const id = await request(ev);
      seam.renderedReportUnreadable = 1;
      // The job as BullMQ hands it over; discard() marks it as BullMQ does.
      const job = {
        id: `report-${id}`,
        name: "GenerateReportJob",
        attemptsMade: 0,
        data: { commandId: id, traceId: "recovery", schemaVersion: 1 },
        opts: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
        queueName: "report",
        discarded: false,
        discard() {
          this.discarded = true;
        },
        updateProgress: async () => undefined,
        log: async () => undefined,
      };
      let err: unknown = null;
      try {
        await processor.processGenerateReport(job as never);
      } catch (e) {
        err = e;
      }
      expect(err).toBeTruthy();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({
        state: "FAILED_TERMINAL",
        terminalReasonCode: "REPORT_PDF_VERIFICATION_FAILED",
      });
      expect(await incidentsFor(ev.evidenceId)).toBeGreaterThan(0);
      // AUD-41 (2026-10-20) — the processor no longer captures per attempt; the
      // REAL failed binding captures a non-retryable (discarded) failure once.
      expect(job.discarded).toBe(true);
      expect(seam.sentryCaptures).toEqual([]);
      const { EventEmitter } = await import("node:events");
      const worker = Object.assign(new EventEmitter(), { name: "report" });
      const { bindWorkerEvents } = await import("../../../worker/src/worker-events.js");
      bindWorkerEvents(worker as never, "report");
      worker.emit("failed", job, err);
      expect(seam.sentryCaptures.length).toBe(1);
    }, 300_000);

    it("AUD-04: a refusal after a READY report leaves the record READY — never NEEDS_ATTENTION / REPORT_UPDATE_FAILED", async () => {
      const ev = await chainVerifiedWithV1();
      const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("requested");
      const [auto] = await autoRequests(ev.evidenceId);
      await withNotEntitledWorkspace(() => run(auto!.id, 0));
      const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
        where: { id: auto!.id },
        select: { state: true, terminalReasonCode: true, createdAtUtc: true },
      });
      expect(row).toMatchObject({ state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_NOT_ENTITLED" });
      const v1 = await prisma.report.findFirstOrThrow({ where: { evidenceId: ev.evidenceId }, orderBy: { version: "desc" }, select: { generatedAtUtc: true } });
      const shared = await import("@proovra/shared");
      const reportUpdateFailed = shared.isCurrentReportUpdateFailure({
        reportState: "READY",
        reportRequestState: row.state,
        reportRequestReasonCode: row.terminalReasonCode,
        requestCreatedAt: row.createdAtUtc,
        latestReportGeneratedAt: v1.generatedAtUtc,
      });
      expect(reportUpdateFailed).toBe(false);
      expect(shared.deliverableStatusFor({ report: "READY", verificationPackage: "READY", reportUpdateFailed })).toEqual({
        status: "READY",
        reason: "COMPLETE",
      });
      expect((await state(ev.evidenceId)).reports.map((r) => r.version), "v1 stays downloadable").toEqual([1]);
    }, 300_000);

    it("AUD-03: once the refusal's condition ends, the next request supersedes the NOT_APPLICABLE row", async () => {
      const ev = await signedEvidence();
      const api = await import("../../src/services/reports/report-generation-authority.service.js");
      // The first request through the SAME authority (and so the same
      // idempotency chain) the second one uses.
      const first = await api.requestReportGeneration({
        evidenceId: ev.evidenceId,
        purpose: "evidence_completed",
        requestedByMachineId: "forward-test",
      } as never);
      expect(first).toMatchObject({ requested: true });
      const id = (first as { requestId: string }).requestId;
      await setLifecycle(ev.evidenceId, "ARCHIVED");
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "NOT_APPLICABLE" });
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { lifecycleState: "ACTIVE", archivedAt: null } as never });
      const again = await api.requestReportGeneration({
        evidenceId: ev.evidenceId,
        purpose: "evidence_completed",
        requestedByMachineId: "forward-test",
      } as never);
      expect(again).toMatchObject({ requested: true });
      expect((again as { requestId?: string }).requestId).not.toBe(id);
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // PHASE 3 — OTS / BITCOIN FORWARD PATH (AUD-10, AUD-11, OTS parts of AUD-41/50)
  // -------------------------------------------------------------------------
  describe("PHASE 3 — OTS / Bitcoin forward path", () => {
    /** An anchored record carrying a recorded chain fact, without a report run. */
    async function anchoredWithChain(chain: {
      status: string;
      confirmations: number | null;
      checkedAtUtc: Date;
      verifiedAtUtc: Date | null;
      failureCode?: string | null;
      anchoredAtUtc?: Date;
    }) {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const proof = await anchoredProofFor(ev.evidenceId);
      const base = chainVerifiedColumnsFor(proof);
      await prisma.evidence.update({
        where: { id: ev.evidenceId },
        data: {
          otsStatus: "ANCHORED",
          otsHash: (await prisma.evidence.findUniqueOrThrow({ where: { id: ev.evidenceId }, select: { fingerprintHash: true } })).fingerprintHash,
          otsProofBase64: proof,
          otsAnchoredAtUtc: chain.anchoredAtUtc ?? new Date(),
          ...base,
          otsChainVerificationStatus: chain.status,
          otsChainConfirmations: chain.confirmations,
          otsChainCheckedAtUtc: chain.checkedAtUtc,
          otsChainVerifiedAtUtc: chain.verifiedAtUtc,
          otsChainFailureCode: chain.failureCode ?? null,
        } as never,
      });
      return ev;
    }

    async function withChainVerifierEnabled<T>(fn: () => Promise<T>): Promise<T> {
      const saved = { ...process.env };
      process.env.OTS_BITCOIN_VERIFY_ENABLED = "true";
      // Loopback, never contacted by the reconciler (it only enqueues).
      process.env.OTS_BITCOIN_RPC_URL = "http://127.0.0.1:18443";
      process.env.OTS_BITCOIN_RPC_USERNAME = "forward-test";
      process.env.OTS_BITCOIN_EXPECTED_CHAIN = "regtest";
      try {
        return await fn();
      } finally {
        for (const k of ["OTS_BITCOIN_VERIFY_ENABLED", "OTS_BITCOIN_RPC_URL", "OTS_BITCOIN_RPC_USERNAME", "OTS_BITCOIN_EXPECTED_CHAIN"]) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    }

    async function clearOtsJobs(ids: string[]) {
      const q = await import("../../../worker/src/queue.js");
      for (const id of ids) {
        const job = await q.otsUpgradeQueue.getJob(`ots-upgrade-${id}`);
        await job?.remove().catch(() => undefined);
      }
    }

    it("AUD-10: final (≥144 confirmations) VERIFIED records are never re-enqueued by the chain catch-up; a still-confirming one is", async () => {
      const hour = 60 * 60 * 1000;
      const finals = [] as string[];
      for (let i = 0; i < 3; i += 1) {
        const ev = await anchoredWithChain({
          status: "VERIFIED",
          confirmations: 200 + i,
          checkedAtUtc: new Date(Date.now() - 7 * hour),
          verifiedAtUtc: new Date(Date.now() - 24 * hour),
        });
        finals.push(ev.evidenceId);
      }
      const confirming = await anchoredWithChain({
        status: "VERIFIED",
        confirmations: 20,
        checkedAtUtc: new Date(Date.now() - 7 * hour),
        verifiedAtUtc: new Date(Date.now() - 24 * hour),
      });
      const q = await import("../../../worker/src/queue.js");
      await clearOtsJobs([...finals, confirming.evidenceId]);
      try {
        const reconciler = await import("../../../worker/src/ots-initialization-reconciler.js");
        await withChainVerifierEnabled(() => reconciler.runOtsInitializationReconciler({ trigger: "test" as never, batchSize: 1000 }));
        for (const id of finals) expect(await q.isOtsUpgradeScheduled(id), `final ${id}`).toBe(false);
        expect(await q.isOtsUpgradeScheduled(confirming.evidenceId)).toBe(true);
        // A second pass changes nothing for the final rows.
        await withChainVerifierEnabled(() => reconciler.runOtsInitializationReconciler({ trigger: "test" as never, batchSize: 1000 }));
        for (const id of finals) expect(await q.isOtsUpgradeScheduled(id)).toBe(false);
      } finally {
        await clearOtsJobs([...finals, confirming.evidenceId]);
      }
    }, 300_000);

    it("AUD-10: the chain sweep serves the longest-unchecked record first (no starvation behind old anchors)", async () => {
      const hour = 60 * 60 * 1000;
      // Anchored LAST, checked FIRST: an anchored-date order would serve it last.
      const starved = await anchoredWithChain({
        status: "UNAVAILABLE",
        confirmations: null,
        checkedAtUtc: new Date("2020-01-01T00:00:00Z"),
        verifiedAtUtc: null,
        failureCode: "BTC_RPC_UNAVAILABLE",
        anchoredAtUtc: new Date(),
      });
      // Anchored FIRST, checked recently: an anchored-date order serves it
      // before the starved record and a batch of one never reaches the latter.
      const competitor = await anchoredWithChain({
        status: "UNAVAILABLE",
        confirmations: null,
        checkedAtUtc: new Date(Date.now() - 7 * hour),
        verifiedAtUtc: null,
        failureCode: "BTC_RPC_UNAVAILABLE",
        anchoredAtUtc: new Date("2019-01-01T00:00:00Z"),
      });
      const q = await import("../../../worker/src/queue.js");
      await clearOtsJobs([starved.evidenceId, competitor.evidenceId]);
      try {
        const reconciler = await import("../../../worker/src/ots-initialization-reconciler.js");
        await withChainVerifierEnabled(() => reconciler.runOtsInitializationReconciler({ trigger: "test" as never, batchSize: 1 }));
        expect(await q.isOtsUpgradeScheduled(starved.evidenceId), "the longest-unchecked record is served first").toBe(true);
        expect(await q.isOtsUpgradeScheduled(competitor.evidenceId), "a batch of one serves one record").toBe(false);
      } finally {
        await clearOtsJobs([starved.evidenceId, competitor.evidenceId]);
      }
    }, 300_000);

    it("AUD-11: the proof is independently verified on the Bitcoin chain WHILE the report renders — the run commits and the package states the issuance snapshot", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const proof = await anchoredProofFor(ev.evidenceId);
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { otsProofBase64: proof } as never });
      const reconcile = await import("../../../worker/src/scripts/reconcile-ots-state.js");
      await reconcile.main(["--apply", "--evidence-id", ev.evidenceId]);
      const id = await request(ev);
      seam.afterRenderSnapshot = async () => {
        await prisma.evidence.update({ where: { id: ev.evidenceId }, data: chainVerifiedColumnsFor(proof) as never });
      };
      expect(await run(id, 0)).toBeNull();
      const after = await state(ev.evidenceId, id);
      expect(after.req).toMatchObject({ state: "SUCCEEDED" });
      expect(after.reports.map((r) => r.version)).toEqual([1]);
      expect(after.packages.map((p) => p.version)).toEqual([1]);
      const v1 = await prisma.report.findUniqueOrThrow({
        where: { evidenceId_version: { evidenceId: ev.evidenceId, version: 1 } },
        select: { anchorSnapshot: true },
      });
      expect((v1.anchorSnapshot as { otsVerification?: string }).otsVerification, "v1 states what it knew at issuance").toBe("ATTESTATION_RECORDED");
    }, 300_000);

    it("AUD-11: a chain verification that REGRESSES while the report renders is still refused", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const proof = await anchoredProofFor(ev.evidenceId);
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { otsProofBase64: proof } as never });
      const reconcile = await import("../../../worker/src/scripts/reconcile-ots-state.js");
      await reconcile.main(["--apply", "--evidence-id", ev.evidenceId]);
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: chainVerifiedColumnsFor(proof) as never });
      const id = await request(ev);
      seam.afterRenderSnapshot = async () => {
        await prisma.evidence.update({
          where: { id: ev.evidenceId },
          data: { otsChainVerificationStatus: null, otsChainVerifiedAtUtc: null, otsChainCheckedAtUtc: null, otsChainBlockHash: null, otsChainBlockHeight: null, otsChainConfirmations: null, otsChainVerifier: null } as never,
        });
      };
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.packages).toEqual([]);
      expect(after.req).toMatchObject({ state: "FAILED_TERMINAL", terminalReasonCode: "REPORT_RENDER_INPUT_INCONSISTENT" });
    }, 300_000);

    it("AUD-11: an anchored proof whose bytes change while the report renders is still refused", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const proof = await anchoredProofFor(ev.evidenceId);
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { otsProofBase64: proof } as never });
      const reconcile = await import("../../../worker/src/scripts/reconcile-ots-state.js");
      await reconcile.main(["--apply", "--evidence-id", ev.evidenceId]);
      const id = await request(ev);
      const digest = (await prisma.evidence.findUniqueOrThrow({ where: { id: ev.evidenceId }, select: { fingerprintHash: true } })).fingerprintHash!;
      const other = otsProofForDigest(digest, { bitcoinHeight: 860_123 });
      expect(other).not.toBe(proof);
      seam.afterRenderSnapshot = async () => {
        await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { otsProofBase64: other } as never });
      };
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.packages).toEqual([]);
      expect(after.req).toMatchObject({ state: "FAILED_TERMINAL", terminalReasonCode: "REPORT_RENDER_INPUT_INCONSISTENT" });
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // PHASE 4 — CANONICAL DIGEST FORM (AUD-53, AUD-54)
  // -------------------------------------------------------------------------
  describe("PHASE 4 — canonical digest form", () => {
    it("AUD-53: a single-part record carrying the legacy composite column issues its chain-verified v2", async () => {
      const ev = await chainVerifiedWithV1({ digestForm: "LEGACY_COMPOSITE" });
      const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("requested");
      const [auto] = await autoRequests(ev.evidenceId);
      expect(await run(auto!.id, 0)).toBeNull();
      const after = await state(ev.evidenceId, auto!.id);
      expect(after.req).toMatchObject({ state: "SUCCEEDED" });
      expect(after.reports.map((r) => r.version)).toEqual([1, 2]);
      expect(after.packages.map((p) => p.version)).toContain(2);
    }, 300_000);

    it("AUD-53: the first issuance of a legacy-composite single-part record succeeds", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      await tamperSealedEvidence(prisma, ev.evidenceId, { fileSha256: legacyComposite(ev.originalSha) });
      const id = await request(ev);
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "SUCCEEDED" });
    }, 300_000);

    it("AUD-53: a digest that is neither the signed raw form nor its legacy composite is still refused as an integrity failure", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      await tamperSealedEvidence(prisma, ev.evidenceId, { fileSha256: "ab".repeat(32) });
      const id = await request(ev);
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.reports).toEqual([]);
      expect(after.req!.state).toBe("FAILED_TERMINAL");
      expect(after.req!.terminalReasonCode).not.toBe("Error");
    }, 300_000);
  });

  describe("PHASE 7 — privacy of the issued report", () => {
    /*
     * The renderer is a fixture in this suite; what the processor hands it is
     * real. The rendering of that input — every page footer's pvr_, no UUID,
     * no coordinate while withheld — is proven on real Chromium PDFs in
     * services/worker/test/report-pdf-layout.test.ts (AUD-18 / AUD-19 blocks).
     */
    // Read through a function: the reset below would otherwise narrow it to null.
    const renderInput = () => seam.lastRenderInput;

    async function issueWithLocation(disclosure: { verificationDisclosureMode?: string; showRecordedLocation?: boolean }) {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      // The fixture's capture facts are written outside the application path
      // (F-01: they are set once with the fingerprint).
      await tamperSealedEvidence(prisma, ev.evidenceId, { lat: 52.521, lng: 13.405, accuracyMeters: 12 });
      if (Object.keys(disclosure).length > 0) {
        await prisma.evidence.update({ where: { id: ev.evidenceId }, data: disclosure as never });
      }
      seam.lastRenderInput = null;
      const id = await request(ev);
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "SUCCEEDED" });
      const ref = (await prisma.evidence.findUniqueOrThrow({ where: { id: ev.evidenceId }, select: { verificationRef: true } })).verificationRef;
      const input = renderInput();
      expect(input, "the processor rendered a report").toBeTruthy();
      expect(input!.evidence.id).toBe(ev.evidenceId);
      return { ...ev, input: input!, ref };
    }

    it("AUD-18 + AUD-19: a record whose owner did not disclose its location is rendered with its pvr_ and the location withheld", async () => {
      const r = await issueWithLocation({});
      expect(r.ref).toMatch(/^pvr_/);
      expect(r.input.verificationRef).toBe(r.ref);
      expect(r.input.recordedLocationDisclosed).toBe(false);
    }, 300_000);

    it("AUD-19: CONTENT_PREVIEW with the recorded location shown is rendered with the location disclosed", async () => {
      const r = await issueWithLocation({ verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: true });
      expect(r.input.recordedLocationDisclosed).toBe(true);
      expect(r.input.verificationRef).toBe(r.ref);
    }, 300_000);
  });

  // =========================================================================
  // INDEPENDENT FORWARD AUDIT CLOSURE (2026-10-21)
  // =========================================================================
  describe("AFC — independent forward audit closure", () => {
    it("F-25: a report run rewrites no acquisition fact (capture_method, submitter / creator / uploader)", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      // A secure-intake record: the contributor has no user row (submitter null);
      // its structure was sealed as a package.
      await tamperSealedEvidence(prisma, ev.evidenceId, { captureMethod: "MULTIPART_PACKAGE" });
      await prisma.evidence.update({
        where: { id: ev.evidenceId },
        data: { submittedByUserId: null, createdByUserId: null, uploadedByUserId: null } as never,
      });
      const id = await request(ev);
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "SUCCEEDED" });
      const row = await prisma.evidence.findUniqueOrThrow({
        where: { id: ev.evidenceId },
        select: { captureMethod: true, submittedByUserId: true, createdByUserId: true, uploadedByUserId: true, status: true },
      });
      expect(row).toEqual({ captureMethod: "MULTIPART_PACKAGE", submittedByUserId: null, createdByUserId: null, uploadedByUserId: null, status: "REPORTED" });
    }, 300_000);

    // ---- F-07: lifecycle / legal hold / entitlement / organization re-decided at commit
    async function issuedV1() {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const id = await request(ev);
      expect(await run(id, 0), "v1 must issue").toBeNull();
      return ev;
    }
    async function latestPointer(evidenceId: string) {
      return (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { latestReportVersion: true, verificationPackageVersion: true } }));
    }

    it("F-07: a legal hold placed while a regeneration renders refuses the commit; no v2, no pointer advance", async () => {
      const ev = await issuedV1();
      const before = await latestPointer(ev.evidenceId);
      const owner = await prisma.team.findUniqueOrThrow({ where: { id: ev.teamId }, select: { ownerUserId: true } });
      seam.afterRenderSnapshot = async () => {
        await prisma.evidenceLegalHold.create({
          data: { teamId: ev.teamId, evidenceId: ev.evidenceId, scope: "EVIDENCE", title: "f-07", placedByUserId: owner.ownerUserId } as never,
        });
      };
      const id = await request({ ...ev, forceRegenerate: true });
      const err = await run(id, 0);
      expect(err).toBeNull();
      const s = await state(ev.evidenceId, id);
      expect(s.reports.map((r) => r.version)).toEqual([1]);
      expect(s.req).toMatchObject({ state: "BLOCKED_POLICY", terminalReasonCode: "legal_hold_active" });
      expect(await latestPointer(ev.evidenceId)).toEqual(before);
      expect(seam.sentryCaptures).toEqual([]);
    }, 300_000);

    it("F-07: an organization suspended while the report renders refuses the commit", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const team = await prisma.team.findUniqueOrThrow({ where: { id: ev.teamId }, select: { organizationId: true } });
      seam.afterRenderSnapshot = async () => {
        await prisma.organization.update({ where: { id: team.organizationId }, data: { status: "SUSPENDED" } as never });
      };
      try {
        const id = await request(ev);
        expect(await run(id, 0)).toBeNull();
        const s = await state(ev.evidenceId, id);
        expect(s.reports).toEqual([]);
        expect(s.req).toMatchObject({ state: "BLOCKED_POLICY", terminalReasonCode: "organization_not_active" });
        expect((await latestPointer(ev.evidenceId)).latestReportVersion ?? null).toBeNull();
      } finally {
        await prisma.organization.update({ where: { id: team.organizationId }, data: { status: "ACTIVE" } as never });
      }
    }, 300_000);

    it("F-07: a plan that lapses (in the database) while the report renders settles NOT_APPLICABLE at commit", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      const owner = await prisma.team.findUniqueOrThrow({ where: { id: ev.teamId }, select: { ownerUserId: true } });
      const ent = await prisma.entitlement.findFirst({ where: { userId: owner.ownerUserId }, select: { id: true, plan: true } });
      seam.afterRenderSnapshot = async () => {
        await prisma.team.update({ where: { id: ev.teamId }, data: { billingPlan: "FREE" } });
        if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "FREE" } });
      };
      try {
        const id = await request(ev);
        expect(await run(id, 0)).toBeNull();
        const s = await state(ev.evidenceId, id);
        expect(s.reports).toEqual([]);
        expect(s.req?.state).toBe("NOT_APPLICABLE");
        expect(seam.sentryCaptures).toEqual([]);
      } finally {
        await prisma.team.update({ where: { id: ev.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
        if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: ent.plan } });
      }
    }, 300_000);

    // ---- F-06: a long run renews a fenced lease; the reconciler and the claim leave it alone
    it("F-06: a running report renews its claim's lease (fenced heartbeat)", async () => {
      const authority = await import("../../../worker/src/report-generation-authority.js");
      authority.setReportClaimHeartbeatIntervalForTests(200);
      try {
        const ev = await signedEvidence();
        await signFingerprintRaw(ev);
        const id = await request(ev);
        let seen: { claimedAtUtc: Date | null; leaseRenewedAtUtc: Date | null } | null = null;
        seam.afterRenderSnapshot = async () => {
          await new Promise((r) => setTimeout(r, 700));
          seen = (await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { claimedAtUtc: true, leaseRenewedAtUtc: true } as never })) as never;
        };
        expect(await run(id, 0)).toBeNull();
        expect(seen).not.toBeNull();
        expect(seen!.leaseRenewedAtUtc, "the run renewed its lease").toBeInstanceOf(Date);
        expect(seen!.leaseRenewedAtUtc!.getTime()).toBeGreaterThan(seen!.claimedAtUtc!.getTime());
      } finally {
        authority.setReportClaimHeartbeatIntervalForTests(null);
      }
    }, 300_000);

    it("F-06: the stranded-request reconciler and a competing claim never take a claim whose lease was renewed", async () => {
      const authority = await import("../../../worker/src/report-generation-authority.js");
      const ev = await signedEvidence();
      const id = await request(ev);
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      await prisma.reportGenerationRequest.update({
        where: { id },
        data: { state: "PROCESSING", claimedAtUtc: longAgo, leaseRenewedAtUtc: new Date() } as never,
      });
      await authority.reconcileStrandedReportRequests({ enqueue: async () => ({ enqueued: false }) });
      const after = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { state: true, claimedAtUtc: true } });
      expect(after).toEqual({ state: "PROCESSING", claimedAtUtc: longAgo });
      // A second worker's claim is refused while the lease is live.
      expect(await run(id, 0)).toBeNull();
      const again = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { state: true, claimedAtUtc: true } });
      expect(again).toEqual({ state: "PROCESSING", claimedAtUtc: longAgo });
      // An expired lease (no renewal within the lease) IS released.
      await prisma.reportGenerationRequest.update({ where: { id }, data: { leaseRenewedAtUtc: longAgo } as never });
      await authority.reconcileStrandedReportRequests({ enqueue: async () => ({ enqueued: false }) });
      expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe("FAILED_RETRYABLE");
    }, 300_000);

    // ---- F-24: the record's report pointer only advances
    it("F-24: a commit never moves latestReportVersion backwards", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      seam.reportPublishedHook = async () => {
        // A higher version committed first (simulated: the pointer moved past this run's version).
        await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { latestReportVersion: 7 } as never });
      };
      const id = await request(ev);
      await run(id, 0);
      expect((await latestPointer(ev.evidenceId)).latestReportVersion).toBe(7);
    }, 300_000);

    // ---- F-05 / F-11 / F-34: a package built later for an issued report
    /** v1 issued with its report only (the package refused by the storage allowance). */
    async function reportOnlyV1(extra: Record<string, unknown> = {}) {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      if (Object.keys(extra).length) await tamperSealedEvidence(prisma, ev.evidenceId, extra);
      seam.packageAllowanceRefusal = "STORAGE_LIMIT_REACHED";
      const id = await request(ev);
      expect(await run(id, 0)).toBeNull();
      seam.packageAllowanceRefusal = null;
      const s = await state(ev.evidenceId);
      expect(s.reports.map((r) => r.version)).toEqual([1]);
      expect(s.packages).toEqual([]);
      return ev;
    }
    const packageOnly = async (ev: { evidenceId: string; teamId: string }, version: number) => {
      const id = await request({ ...ev, artifactType: "VERIFICATION_PACKAGE", reportVersion: version, purpose: "package_recovery" });
      return { id, err: await run(id, 0) };
    };

    it("F-05: a package built later carries exactly the chain its report issued, cut by sequence (a later event dated before issuance is excluded)", async () => {
      const ev = await reportOnlyV1();
      const v1 = await prisma.report.findUniqueOrThrow({ where: { evidenceId_version: { evidenceId: ev.evidenceId, version: 1 } }, select: { generatedAtUtc: true } });
      const issuedThrough = (await prisma.custodyEvent.aggregate({ where: { evidenceId: ev.evidenceId }, _max: { sequence: true } }))._max.sequence!;
      // An event recorded AFTER issuance whose own time precedes it (a timestamp's genTime, a reconciled hold).
      const { appendCustodyEvent } = await import("../../src/services/custody-events.service.js");
      await appendCustodyEvent({ evidenceId: ev.evidenceId, eventType: "TECHNICAL_VERIFICATION_CHECKED" as never, atUtc: new Date(v1.generatedAtUtc.getTime() - 86_400_000), payload: { source: "f-05" } });
      const { id, err } = await packageOnly(ev, 1);
      expect(err).toBeNull();
      expect((await state(ev.evidenceId, id)).req?.state).toBe("SUCCEEDED");
      const pkg = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId: ev.evidenceId, version: 1, state: "PUBLISHED", disclosureProfile: "FULL_FORENSIC" }, select: { custodyThroughSequence: true } as never }) as unknown as { custodyThroughSequence: number | null };
      expect(pkg.custodyThroughSequence).toBe(issuedThrough);
    }, 300_000);

    it("F-11: a token validated after issuance does not make the version's package permanently unbuildable", async () => {
      const token = Buffer.from(`f-11-token-${randomUUID()}`).toString("base64");
      const ev = await reportOnlyV1({ tsaStatus: "STAMPED", tsaTokenBase64: token, tsaValidatedAtUtc: null });
      // The operator path that validates a retained token after issuance.
      await tamperSealedEvidence(prisma, ev.evidenceId, { tsaValidatedAtUtc: new Date() });
      const { id, err } = await packageOnly(ev, 1);
      expect(err).toBeNull();
      const s = await state(ev.evidenceId, id);
      expect(s.req).toMatchObject({ state: "SUCCEEDED" });
      expect(s.packages.map((p) => p.version)).toEqual([1]);
    }, 300_000);

    it("F-07: an organization suspended while a package builds refuses the package commit (BLOCKED_POLICY, no package)", async () => {
      const ev = await reportOnlyV1();
      const team = await prisma.team.findUniqueOrThrow({ where: { id: ev.teamId }, select: { organizationId: true } });
      seam.packageVerifyHook = async () => {
        await prisma.organization.update({ where: { id: team.organizationId }, data: { status: "SUSPENDED" } as never });
      };
      try {
        const { id, err } = await packageOnly(ev, 1);
        expect(err).toBeNull();
        const s1 = await state(ev.evidenceId, id);
        expect(s1.req).toMatchObject({ state: "BLOCKED_POLICY", terminalReasonCode: "organization_not_active" });
        expect(s1.packages).toEqual([]);
        expect((await latestPointer(ev.evidenceId)).verificationPackageVersion ?? null).toBeNull();
      } finally {
        await prisma.organization.update({ where: { id: team.organizationId }, data: { status: "ACTIVE" } as never });
      }
    }, 300_000);

    // ---- F-10: an owed chain-verified version whose request failed terminally is owed again
    it("F-10: a technically failed owed OTS version is re-requested once, idempotently; a business refusal is not", async () => {
      const ev = await chainVerifiedWithV1();
      const { reconcileOtsAnchoredReportVersion } = await import("../../../worker/src/ots-anchored-version.js");
      const first = await reconcileOtsAnchoredReportVersion(ev.evidenceId);
      expect(first.outcome).toBe("requested");
      // The owed request failed terminally (a technical failure, e.g. storage).
      await prisma.reportGenerationRequest.update({ where: { id: first.requestId! }, data: { state: "FAILED_TERMINAL", terminalReasonCode: "STORAGE_UNAVAILABLE", completedAtUtc: new Date() } as never });
      const retry = await reconcileOtsAnchoredReportVersion(ev.evidenceId);
      expect(retry.outcome).toBe("requested");
      expect(retry.requestId).not.toBe(first.requestId);
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("already_requested");
      expect(await autoRequests(ev.evidenceId)).toHaveLength(2);
      // A business refusal (NOT_APPLICABLE) is a stable outcome, never re-asked.
      await prisma.reportGenerationRequest.update({ where: { id: retry.requestId! }, data: { state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_NOT_ENTITLED", completedAtUtc: new Date() } as never });
      expect((await reconcileOtsAnchoredReportVersion(ev.evidenceId)).outcome).toBe("already_requested");
      expect(await autoRequests(ev.evidenceId)).toHaveLength(2);
    }, 300_000);

    // ---- F-38: stale or competing writers are fenced
    it("F-38: a stale run cannot fail the reservations a live claimant holds", async () => {
      const issuance = await import("../../../worker/src/package-issuance.js");
      const ev = await signedEvidence();
      const id = await request(ev);
      const live = new Date();
      await prisma.reportGenerationRequest.update({ where: { id }, data: { state: "PROCESSING", claimedAtUtc: live } as never });
      const row = await prisma.verificationPackage.create({
        data: { evidenceId: ev.evidenceId, version: 1, state: "RESERVED", disclosureProfile: "FULL_FORENSIC", issuanceId: id } as never,
        select: { id: true },
      }).catch(() => null);
      await issuance.failIssuance({ requestId: id, reason: "STALE", fence: { claimedAtUtc: new Date(live.getTime() - 60_000) } });
      if (row) {
        expect((await prisma.verificationPackage.findUniqueOrThrow({ where: { id: row.id }, select: { state: true } })).state).toBe("RESERVED");
      }
    }, 300_000);

    it("F-38: the reconciler does not adopt another request's report for an explicit NEW_VERSION request", async () => {
      const authority = await import("../../../worker/src/report-generation-authority.js");
      const ev = await issuedV1();
      const id = await request({ ...ev, forceRegenerate: true });
      await prisma.reportGenerationRequest.update({ where: { id }, data: { state: "FAILED_RETRYABLE", createdAtUtc: new Date(Date.now() - 3_600_000) } as never });
      await authority.reconcileStrandedReportRequests({ enqueue: async () => ({ enqueued: false }) });
      const after = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id }, select: { state: true } });
      expect(after.state).not.toBe("SUCCEEDED");
    }, 300_000);
  });
});
