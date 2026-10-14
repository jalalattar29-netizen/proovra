/**
 * RETENTION ARCHIVE RESTORE (owner decision 2026-10-14).
 *
 * A record in the Retention Archive comes back to ACTIVE only through this
 * durable workflow — never by a row flip. The request row
 * (`evidence_archive_restore_requests`) is the outbox: the API writes it once
 * (idempotent; one open request per record at the database), and this module
 * claims it under a lease, so a crash or restart resumes it and two workers
 * never run it twice.
 *
 * WHAT IS VERIFIED BEFORE THE RECORD MOVES, all at the exact recorded versions:
 *   1. the signed original — every part — read from storage and hashed against
 *      the digest the evidence signature covers (the integrity-recheck rule,
 *      `observeOriginalDigest`, recorded as a RECOVERY integrity check);
 *   2. every issued report and package object exists, and its bytes match the
 *      recorded pdfSha256 / packageSha256 where one was recorded;
 *   3. the signing references the record needs (signature, fingerprint, key id)
 *      are present and the custody chain verifies.
 * Any missing or inconsistent object FAILS CLOSED: the record stays archived,
 * nothing partial is activated, an ARCHIVE_RESTORE_FAILED custody event and an
 * actionable Operations condition are recorded. A transient storage failure is
 * retried on a later tick (bounded attempts) before it is declared failed.
 *
 * WHAT IS NEVER DONE: no artifact is regenerated (the same reports and
 * packages come back), no evidence slot is consumed, no identity changes — the
 * same Evidence ID and the same canonical verification reference.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  appendCustodyEventTx,
  evaluateCustodyChain,
} from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import {
  observeOriginalDigest,
  recordIntegrityObservation,
  type IntegrityObjectReader,
} from "../integrity-recheck.js";

/** How long one claimed attempt may run before another worker may resume it. */
export const ARCHIVE_RESTORE_LEASE_MS = 15 * 60 * 1000;
/** Transient storage failures retried this many times before FAILED. */
export const ARCHIVE_RESTORE_MAX_ATTEMPTS = 3;
const DEFAULT_BATCH = 10;

export type ArchiveRestoreFailureCode =
  | "OBJECT_VERSION_MISSING"
  | "DIGEST_MISMATCH"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "SIGNATURE_REFERENCE_MISSING"
  | "CUSTODY_CHAIN_INVALID"
  | "STORAGE_UNAVAILABLE"
  | "STATE_CHANGED";

type VerifiedObject = {
  kind: "ORIGINAL" | "REPORT" | "PACKAGE";
  ref: string;
  versionId: string | null;
  sha256: string | null;
  outcome: "VERIFIED" | "FAILED" | "UNAVAILABLE";
};

export type ArchiveRestoreOutcome =
  | { requestId: string; evidenceId: string; outcome: "COMPLETED" }
  | { requestId: string; evidenceId: string; outcome: "FAILED"; failureCode: ArchiveRestoreFailureCode }
  | { requestId: string; evidenceId: string; outcome: "RETRY"; failureCode: "STORAGE_UNAVAILABLE" };

async function defaultReader(): Promise<IntegrityObjectReader> {
  const { getObjectStream, headObject } = await import("../storage.js");
  return {
    head: (o) => headObject(o),
    stream: async (o) => (await getObjectStream(o)) as unknown as Readable,
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.$metadata?.httpStatusCode === 404 ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.name === "NoSuchVersion" ||
    e?.Code === "NoSuchKey"
  );
}

async function sha256OfStream(stream: Readable): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Verify one artifact object: present at its key, and its bytes match the recorded digest. */
async function verifyArtifact(
  reader: IntegrityObjectReader,
  kind: "REPORT" | "PACKAGE",
  ref: string,
  location: { bucket: string | null; key: string | null },
  recordedSha256: string | null,
): Promise<{ object: VerifiedObject; failure: ArchiveRestoreFailureCode | null }> {
  if (!location.bucket || !location.key) {
    return {
      object: { kind, ref, versionId: null, sha256: null, outcome: "FAILED" },
      failure: "ARTIFACT_MISSING",
    };
  }
  const o = { bucket: location.bucket, key: location.key, versionId: null };
  try {
    const head = await reader.head(o);
    if (!head.sizeBytes || head.sizeBytes <= 0) {
      return { object: { kind, ref, versionId: null, sha256: null, outcome: "FAILED" }, failure: "ARTIFACT_MISSING" };
    }
    if (!recordedSha256) {
      return { object: { kind, ref, versionId: null, sha256: null, outcome: "VERIFIED" }, failure: null };
    }
    const sha = await sha256OfStream(await reader.stream(o));
    return sha === recordedSha256
      ? { object: { kind, ref, versionId: null, sha256: sha, outcome: "VERIFIED" }, failure: null }
      : { object: { kind, ref, versionId: null, sha256: sha, outcome: "FAILED" }, failure: "ARTIFACT_DIGEST_MISMATCH" };
  } catch (err) {
    return isNotFound(err)
      ? { object: { kind, ref, versionId: null, sha256: null, outcome: "FAILED" }, failure: "ARTIFACT_MISSING" }
      : { object: { kind, ref, versionId: null, sha256: null, outcome: "UNAVAILABLE" }, failure: "STORAGE_UNAVAILABLE" };
  }
}

/**
 * Verify everything a safe restoration needs. Pure reads; the caller decides.
 */
export async function verifyArchivedRecordForRestore(
  evidenceId: string,
  reader: IntegrityObjectReader,
): Promise<{ failure: ArchiveRestoreFailureCode | null; objects: VerifiedObject[]; observation: Awaited<ReturnType<typeof observeOriginalDigest>> | null }> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      fileSha256: true,
      fingerprintCanonicalJson: true,
      fingerprintHash: true,
      signatureBase64: true,
      signingKeyId: true,
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
    },
  });
  if (!evidence) return { failure: "STATE_CHANGED", objects: [], observation: null };

  // 3 (checked first: no storage round-trips for a record that cannot be restored).
  if (!evidence.signatureBase64 || !evidence.fingerprintHash || !evidence.signingKeyId) {
    return { failure: "SIGNATURE_REFERENCE_MISSING", objects: [], observation: null };
  }
  const custody = await prisma.custodyEvent.findMany({
    where: { evidenceId },
    orderBy: { sequence: "asc" },
    select: { sequence: true, eventType: true, atUtc: true, payload: true, prevEventHash: true, eventHash: true },
  });
  const chain = evaluateCustodyChain({
    evidenceId,
    records: custody.map((r) => ({ ...r, eventType: String(r.eventType) })),
  });
  if (!chain.valid) return { failure: "CUSTODY_CHAIN_INVALID", objects: [], observation: null };

  // 1. The signed original, at its exact recorded versions.
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId },
    orderBy: { partIndex: "asc" },
    select: { partIndex: true, sha256: true, storageBucket: true, storageKey: true, storageVersionId: true },
  });
  const observation = await observeOriginalDigest(evidence, parts, reader);
  const objects: VerifiedObject[] = observation.checkedObjects.map((c) => ({
    kind: "ORIGINAL",
    ref: c.partIndex === null ? "original" : `part:${c.partIndex}`,
    versionId: c.versionId ?? null,
    sha256: c.sha256 ?? null,
    outcome: observation.outcome === "VERIFIED" ? "VERIFIED" : observation.outcome === "FAILED" ? "FAILED" : "UNAVAILABLE",
  }));
  if (observation.outcome !== "VERIFIED") {
    const failure: ArchiveRestoreFailureCode =
      observation.failureCode === "DIGEST_MISMATCH"
        ? "DIGEST_MISMATCH"
        : observation.failureCode === "OBJECT_VERSION_MISSING"
          ? "OBJECT_VERSION_MISSING"
          : "STORAGE_UNAVAILABLE";
    return { failure, objects, observation };
  }

  // 2. Every issued report and package.
  const [reports, packages] = await Promise.all([
    prisma.report.findMany({
      where: { evidenceId },
      orderBy: { version: "asc" },
      select: { version: true, storageBucket: true, storageKey: true, pdfSha256: true },
    }),
    prisma.verificationPackage.findMany({
      where: { evidenceId, state: "PUBLISHED" },
      orderBy: { version: "asc" },
      select: { version: true, storageBucket: true, storageKey: true, packageSha256: true },
    }),
  ]);
  for (const r of reports) {
    const res = await verifyArtifact(reader, "REPORT", `report:v${r.version}`, { bucket: r.storageBucket, key: r.storageKey }, r.pdfSha256 ?? null);
    objects.push(res.object);
    if (res.failure) return { failure: res.failure, objects, observation };
  }
  for (const p of packages) {
    const res = await verifyArtifact(reader, "PACKAGE", `package:v${p.version}`, { bucket: p.storageBucket, key: p.storageKey }, p.packageSha256 ?? null);
    objects.push(res.object);
    if (res.failure) return { failure: res.failure, objects, observation };
  }
  return { failure: null, objects, observation };
}

async function claimRequest(requestId: string, now: Date): Promise<{ firstAttempt: boolean } | null> {
  const prior = await prisma.evidenceArchiveRestoreRequest.findUnique({
    where: { id: requestId },
    select: { startedAtUtc: true },
  });
  const claimed = await prisma.evidenceArchiveRestoreRequest.updateMany({
    where: {
      id: requestId,
      OR: [
        { status: "REQUESTED" },
        { status: "RUNNING", leaseUntilUtc: { lt: now } },
        { status: "RUNNING", leaseUntilUtc: null },
      ],
    },
    data: {
      status: "RUNNING",
      startedAtUtc: prior?.startedAtUtc ?? now,
      leaseUntilUtc: new Date(now.getTime() + ARCHIVE_RESTORE_LEASE_MS),
      attemptCount: { increment: 1 },
    },
  });
  return claimed.count === 1 ? { firstAttempt: !prior?.startedAtUtc } : null;
}

async function failRequest(
  request: { id: string; evidenceId: string; teamId: string | null },
  failureCode: ArchiveRestoreFailureCode,
  objects: VerifiedObject[],
  now: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.evidenceArchiveRestoreRequest.updateMany({
      where: { id: request.id, status: "RUNNING" },
      data: {
        status: "FAILED",
        failureCode,
        failedAtUtc: now,
        leaseUntilUtc: null,
        verifiedObjects: objects as never,
      },
    });
    if (updated.count !== 1) return;
    await appendCustodyEventTx(tx, {
      evidenceId: request.evidenceId,
      eventType: "ARCHIVE_RESTORE_FAILED",
      atUtc: now,
      payload: { requestId: request.id, failureCode },
    });
  });
  if (failureCode === "STATE_CHANGED") return;
  const failure =
    failureCode === "OBJECT_VERSION_MISSING"
      ? "object_missing"
      : failureCode === "DIGEST_MISMATCH"
        ? "digest_mismatch"
        : failureCode === "STORAGE_UNAVAILABLE"
          ? "storage_unavailable"
          : "artifact_invalid";
  try {
    const { recordWorkerIncident } = await import("./incident-emitter.js");
    await recordWorkerIncident({
      sourceId: "governance.archive_restore_failed",
      teamId: request.teamId,
      category: "GOVERNANCE",
      severity: failure === "storage_unavailable" ? "WARNING" : "HIGH",
      fingerprint: `archive_restore_failed:${request.id}`,
      relatedEvidenceId: request.evidenceId,
      message: { code: "ops.governance.archive_restore_failed", params: { evidenceId: request.evidenceId, failure } },
      metadata: { requestId: request.id, failureCode },
    } as never);
  } catch (err) {
    logger.warn({ err, requestId: request.id }, "archive_restore.condition_failed");
  }
}

/**
 * Run ONE claimed request to its end (or to a retry). Exported for the sweep
 * and for tests; the sweep is the only production caller.
 */
export async function runArchiveRestoreRequest(
  requestId: string,
  options: { now?: Date; reader?: IntegrityObjectReader } = {},
): Promise<ArchiveRestoreOutcome | null> {
  const now = options.now ?? new Date();
  const claim = await claimRequest(requestId, now);
  if (!claim) return null;
  const request = await prisma.evidenceArchiveRestoreRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { id: true, evidenceId: true, teamId: true, attemptCount: true, requestedByUserId: true },
  });

  const evidence = await prisma.evidence.findUnique({
    where: { id: request.evidenceId },
    select: { lifecycleState: true, destructionClaimedAtUtc: true, teamId: true },
  });
  if (!evidence || evidence.lifecycleState !== "RETENTION_ARCHIVED" || evidence.destructionClaimedAtUtc) {
    await failRequest(request, "STATE_CHANGED", [], now);
    return { requestId, evidenceId: request.evidenceId, outcome: "FAILED", failureCode: "STATE_CHANGED" };
  }
  if (claim.firstAttempt) {
    await prisma.$transaction((tx) =>
      appendCustodyEventTx(tx, {
        evidenceId: request.evidenceId,
        eventType: "ARCHIVE_RESTORE_STARTED",
        atUtc: now,
        payload: { requestId },
      }),
    );
  }

  const reader = options.reader ?? (await defaultReader());
  const verification = await verifyArchivedRecordForRestore(request.evidenceId, reader);

  // The byte observation is recorded through the ONE integrity writer either
  // way, so the record's stored-bytes state reflects what the restore found
  // (a digest mismatch applies its own terminal rejection there).
  if (verification.observation && verification.observation.outcome !== "UNAVAILABLE") {
    await recordIntegrityObservation({
      evidenceId: request.evidenceId,
      teamId: evidence.teamId ?? null,
      expectedDigest: verification.observation.expectedDigest ?? null,
      observation: verification.observation,
      trigger: "RECOVERY",
      correlationId: `archive-restore:${requestId}`,
      now,
    });
  }

  if (verification.failure === "STORAGE_UNAVAILABLE" && request.attemptCount < ARCHIVE_RESTORE_MAX_ATTEMPTS) {
    // Transient: release for a later tick. The record has not moved.
    await prisma.evidenceArchiveRestoreRequest.updateMany({
      where: { id: requestId, status: "RUNNING" },
      data: { status: "REQUESTED", leaseUntilUtc: null, verifiedObjects: verification.objects as never },
    });
    return { requestId, evidenceId: request.evidenceId, outcome: "RETRY", failureCode: "STORAGE_UNAVAILABLE" };
  }
  if (verification.failure) {
    await failRequest(request, verification.failure, verification.objects, now);
    return { requestId, evidenceId: request.evidenceId, outcome: "FAILED", failureCode: verification.failure };
  }

  // VERIFIED -> ACTIVE, atomically, re-checking the state under the evidence lock.
  const completed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.evidenceId}))`;
    const moved = await tx.evidence.updateMany({
      where: { id: request.evidenceId, lifecycleState: "RETENTION_ARCHIVED", destructionClaimedAtUtc: null },
      data: {
        lifecycleState: "ACTIVE",
        deletedAt: null,
        deletedAtUtc: null,
        deletedByUserId: null,
        deleteScheduledForUtc: null,
        retentionArchivedAtUtc: null,
        purgeEligibleAtUtc: null,
        retentionBarrierState: null,
        retentionBarrierEvaluatedAtUtc: null,
      },
    });
    if (moved.count !== 1) return false;
    await tx.evidenceArchiveRestoreRequest.update({
      where: { id: requestId },
      data: {
        status: "COMPLETED",
        completedAtUtc: now,
        leaseUntilUtc: null,
        verifiedObjects: verification.objects as never,
      },
    });
    await appendCustodyEventTx(tx, {
      evidenceId: request.evidenceId,
      eventType: "ARCHIVE_RESTORE_VERIFIED",
      atUtc: now,
      payload: {
        requestId,
        verifiedObjectCount: verification.objects.length,
        originalDigest: verification.observation?.checkedDigest ?? null,
      },
    });
    await appendCustodyEventTx(tx, {
      evidenceId: request.evidenceId,
      eventType: "ARCHIVE_RESTORE_COMPLETED",
      atUtc: now,
      payload: { requestId, restoredByUserId: request.requestedByUserId },
    });
    return true;
  });
  if (!completed) {
    await failRequest(request, "STATE_CHANGED", verification.objects, now);
    return { requestId, evidenceId: request.evidenceId, outcome: "FAILED", failureCode: "STATE_CHANGED" };
  }

  // The record is back in the working set: its search projection is rebuilt
  // by the canonical indexing path (best-effort; the reconciler repairs a miss).
  try {
    const { enqueueSearchIndexingJob } = await import("../queue.js");
    await enqueueSearchIndexingJob({
      teamId: evidence.teamId ?? null,
      kind: "evidence",
      sourceId: request.evidenceId,
      reason: "lifecycle_changed",
    });
  } catch (err) {
    logger.warn({ err, evidenceId: request.evidenceId }, "archive_restore.search_reindex_enqueue_failed");
  }
  return { requestId, evidenceId: request.evidenceId, outcome: "COMPLETED" };
}

/**
 * The sweep: claim and run due requests (REQUESTED, or RUNNING with a lapsed
 * lease). Bounded per tick.
 */
export async function processArchiveRestoreRequests(
  options: { now?: Date; batchSize?: number; reader?: IntegrityObjectReader } = {},
): Promise<ArchiveRestoreOutcome[]> {
  const now = options.now ?? new Date();
  const due = await prisma.evidenceArchiveRestoreRequest.findMany({
    where: {
      OR: [
        { status: "REQUESTED" },
        { status: "RUNNING", leaseUntilUtc: { lt: now } },
        { status: "RUNNING", leaseUntilUtc: null },
      ],
    },
    orderBy: [{ requestedAtUtc: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 100)),
    select: { id: true },
  });
  const out: ArchiveRestoreOutcome[] = [];
  for (const r of due) {
    try {
      const res = await runArchiveRestoreRequest(r.id, { now, reader: options.reader });
      if (res) out.push(res);
    } catch (err) {
      // The lease lapses and a later tick resumes it; the record has not moved.
      logger.error({ err, requestId: r.id }, "archive_restore.request_failed_unexpectedly");
    }
  }
  if (out.length > 0) {
    logger.info(
      {
        processed: out.length,
        completed: out.filter((o) => o.outcome === "COMPLETED").length,
        failed: out.filter((o) => o.outcome === "FAILED").length,
      },
      "archive_restore.sweep.completed",
    );
  }
  return out;
}
