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
import { readZipEntries } from "../point5/_zip-entries.js";

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
  /**
   * Fail the rendered-report gate this many times exactly as production did
   * (2026-10-09): the PDF could not be read back (PDF.js API/worker mismatch).
   */
  renderedReportUnreadable: 0,
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
  const anchorSnapshotOf = async (evidenceId: string, version: number) =>
    ((await prisma.report.findUniqueOrThrow({ where: { evidenceId_version: { evidenceId, version } }, select: { anchorSnapshot: true } }))
      .anchorSnapshot ?? {}) as { otsState?: string; otsProofSha256?: string };

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
    await prisma.evidence.update({
      where: { id: ev.evidenceId },
      data: { fingerprintCanonicalJson: json, fingerprintHash: createHash("sha256").update(json).digest("hex") } as never,
    });
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
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { fileSha256: legacyComposite(ev.originalSha) } as never });
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
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { fileSha256: legacyComposite(ev.originalSha) } as never });
      const id = await request(ev);
      expect(await run(id, 0)).toBeNull();
      expect((await state(ev.evidenceId, id)).req).toMatchObject({ state: "SUCCEEDED" });
    }, 300_000);

    it("AUD-53: a digest that is neither the signed raw form nor its legacy composite is still refused as an integrity failure", async () => {
      const ev = await signedEvidence();
      await signFingerprintRaw(ev);
      await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { fileSha256: "ab".repeat(32) } as never });
      const id = await request(ev);
      await run(id, 0);
      const after = await state(ev.evidenceId, id);
      expect(after.reports).toEqual([]);
      expect(after.req!.state).toBe("FAILED_TERMINAL");
      expect(after.req!.terminalReasonCode).not.toBe("Error");
    }, 300_000);
  });
});
