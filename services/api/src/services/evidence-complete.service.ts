import { prisma } from "../db.js";
import { readMaxEvidenceSizeBytes } from "@proovra/shared";
import {
  compositeSha256,
  isEvidenceReservationExpiredTx,
  multipartManifestSha256,
  recordIntegrityCheckTx,
} from "@proovra/shared-runtime";
import { canonicalJson, sha256Hex } from "../crypto.js";
import {
  outputEarnedFactFromDecision,
  resolveEvidenceOutputEntitlements,
  type PlanType,
} from "@proovra/shared-billing";
import { getEvidenceSigner } from "../signing/signer.js";
import {
  assertWorkspaceAllowsStorageGrowth,
  lockEvidenceCapacitySubject,
  resolveEnforcementScopeForRequester,
  evidenceCreationScope,
  resolveFinalizationIssuance,
  settleEvidenceCompletionFunding,
} from "./billing-enforcement.service.js";
import { resolveEvidenceFunding } from "./billing/evidence-credits.service.js";
import {
  applyDefaultObjectRetention,
  getObjectStream,
  headObject,
} from "../storage.js";
import { sha256HexFromStream } from "../stream-hash.js";
import { createEvidenceTimestamp } from "./timestamp.service.js";
import * as prismaPkg from "@prisma/client";
import { requestReportGeneration } from "./reports/report-generation-authority.service.js";
import { requestEvidenceOtsAnchoring } from "./integrity/ots-anchoring-authority.service.js";
// Post-finalize side-effect orchestration lives in its own file.
import { runEvidenceFinalizationFanout } from "./evidence-finalization-fanout.service.js";
import { Readable } from "stream";
import {
  appendCustodyEvent,
  appendCustodyEventTx,
} from "./custody-events.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
import {
  enqueueScan,
  isMalwareScanningEnabled,
  runScan,
} from "./security/file-security-scan.service.js";
import { safeEmitSecurityEvent } from "./security/security-event.service.js";
import { safeTransitionUploadSession } from "./reliability/upload-session.service.js";
import { evaluateUploadSessionFinalizeGate } from "./uploads/upload-session.service.js";
import { enqueueGraphReconcileJob } from "../queue/graph-reconcile-queue.js";
import { warn as logWarn } from "../utils/logger.js";
import { AppError, ErrorCode } from "../errors.js";
import { effectiveChecklistPlan, validateRequiredChecklistMapping } from "./capture-checklist-gate.js";
import { getIntakeTemplate } from "./capture-intake-templates.js";

type HttpError = Error & { statusCode: number; code?: string };

/**
 * UC-0 — the digests a server-issued direct-capture session DECLARED for its
 * parts before the bytes were uploaded. Completion compares each against the
 * SERVER-computed SHA-256 of the stored object and refuses — before any
 * signature, timestamp or custody event — when one differs or is missing. The
 * declared value is a claim to check, never a substitute for the server hash.
 */
export type CaptureSessionCompletion = {
  sessionId: string;
  expectedSha256ByPartIndex: ReadonlyMap<number, string>;
};

function captureCompletionError(code: string, statusCode = 409): HttpError {
  return Object.assign(new Error(code), { statusCode, code });
}

// Adapter: bridge utils/logger.warn → FanoutLogger contract.
const completeFanoutLogger = {
  warn(obj: Record<string, unknown>, msg: string): void {
    logWarn(msg, obj);
  },
};

type ProcessedPart = {
  id: string;
  partIndex: number;
  sizeBytes: bigint;
  sha256: string;
  mimeType: string | null;
  bucket: string;
  key: string;
  /** (2026-09-29, D14) The exact version hashed and signed; null if unversioned. */
  versionId: string | null;
};

type RetentionTarget = {
  bucket: string;
  key: string;
  /** ET-SM-03 — the sealed version; retention and the lock snapshot address it. */
  versionId?: string | null;
  evidencePartId?: string;
};

type CompleteEvidenceTransactionResult = {
  result: CompleteEvidenceReturn;
  shouldEnqueueReport: boolean;
  retentionTargets: RetentionTarget[];
  /**
   * (2026-09-29, audit D11) The record was ALREADY finalized: this call is a
   * duplicate. The one-time fan-out (webhook, malware scan, post-finalize
   * hooks) does not run again, and retention is re-applied only when the
   * first finalize never recorded it.
   */
  alreadyFinalized?: boolean;
};

const { EvidenceStatus } = prismaPkg;

type CompleteEvidenceReturn = {
  id: string;
  status: prismaPkg.EvidenceStatus;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  /** (2026-09-29, D11) This call was a duplicate of an earlier finalize. */
  alreadyFinalized?: boolean;
};

function asIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
}

function normalizeObservedMimeType(
  value: string | null | undefined
): string | null {
  const raw = clean(value)?.toLowerCase() ?? null;
  if (!raw) return null;
  const normalized = raw.split(";")[0]?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > 128) return null;
  if (/[\r\n]/.test(normalized)) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)) return null;
  return normalized;
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString: () => string }).toString === "function"
  ) {
    const n = Number((value as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isNotFoundLike(e: unknown): boolean {
  const err = e as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
  };

  const name = String(err?.name ?? "").toLowerCase();
  const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
  const msg = String(err?.message ?? "").toLowerCase();

  return (
    name.includes("notfound") ||
    code.includes("notfound") ||
    code === "nosuchkey" ||
    msg.includes("notfound") ||
    msg.includes("no such key") ||
    msg.includes("not found")
  );
}

function isAlreadyObjectLockedLike(e: unknown): boolean {
  const err = e as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
  };

  const name = String(err?.name ?? "").toLowerCase();
  const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
  const msg = String(err?.message ?? "").toLowerCase();

  return (
    name.includes("accessdenied") ||
    code.includes("accessdenied") ||
    code === "accessdenied" ||
    msg.includes("access denied because object protected by object lock") ||
    msg.includes("object protected by object lock") ||
    msg.includes("object lock") ||
    msg.includes("retention") ||
    msg.includes("legal hold")
  );
}

async function safeHead(bucket: string, key: string) {
  try {
    return await headObject({ bucket, key });
  } catch (e) {
    const errObj = e as {
      name?: unknown;
      code?: unknown;
      Code?: unknown;
      message?: unknown;
    };

    const detail =
      errObj?.name ??
      errObj?.code ??
      errObj?.Code ??
      errObj?.message ??
      "unknown";

    const err: HttpError = Object.assign(
      new Error(
        `OBJECT_HEAD_FAILED: ${String(detail)} bucket=${bucket} key=${key}`
      ),
      { statusCode: isNotFoundLike(e) ? 404 : 502 }
    );

    throw err;
  }
}

async function safeGetStream(bucket: string, key: string, versionId?: string | null) {
  try {
    // (2026-09-29, D14) The version the HEAD described, so the bytes hashed are
    // exactly the version recorded — a PUT landing between the two calls can
    // not change them.
    return await getObjectStream({ bucket, key, versionId: versionId ?? null });
  } catch (e) {
    const errObj = e as {
      name?: unknown;
      code?: unknown;
      Code?: unknown;
      message?: unknown;
    };

    const detail =
      errObj?.name ??
      errObj?.code ??
      errObj?.Code ??
      errObj?.message ??
      "unknown";

    const err: HttpError = Object.assign(
      new Error(
        `OBJECT_GET_FAILED: ${String(detail)} bucket=${bucket} key=${key}`
      ),
      { statusCode: isNotFoundLike(e) ? 404 : 502 }
    );

    throw err;
  }
}

/**
 * Apply default object retention to each target. Returns whether ANY target had
 * retention actually applied (i.e. Object Lock enabled and retention written).
 *
 * The truthful return value is critical for the EVIDENCE_LOCKED custody event:
 * we must NOT append EVIDENCE_LOCKED unless retention actually applied. When
 * Object Lock is disabled in the environment, applyDefaultObjectRetention is a
 * no-op that returns { applied: false, reason: "object_lock_disabled" } — that
 * must propagate to the caller so the chain remains honest.
 */
async function applyRetentionOrThrow(
  targets: RetentionTarget[]
): Promise<{ anyApplied: boolean; reason: string | null }> {
  const deduped = Array.from(
    new Map(targets.map((item) => [`${item.bucket}:${item.key}:${item.versionId ?? ""}`, item])).values()
  );

  let anyApplied = false;
  let reason: string | null = null;

  for (const target of deduped) {
    try {
      const result = await applyDefaultObjectRetention({
        bucket: target.bucket,
        key: target.key,
        versionId: target.versionId ?? null,
      });
      if (result?.applied === true) {
        anyApplied = true;
      } else if (!reason && typeof result?.reason === "string") {
        reason = result.reason;
      }
    } catch (error) {
      if (isAlreadyObjectLockedLike(error)) {
        // Object already locked by an earlier write — that counts as applied.
        anyApplied = true;
        continue;
      }

      const errMsg =
        error instanceof Error ? error.message : "UNKNOWN_RETENTION_ERROR";

      throw new Error(
        `EVIDENCE_RETENTION_APPLY_FAILED: bucket=${target.bucket} key=${target.key} reason=${errMsg}`
      );
    }
  }

  return { anyApplied, reason };
}

function buildMultipartSummary(parts: ProcessedPart[], totalSizeBytes: number) {
  const imageCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("image/")
  ).length;

  const videoCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("video/")
  ).length;

  const audioCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("audio/")
  ).length;

  const documentCount = parts.filter((p) => {
    const mime = String(p.mimeType ?? "").toLowerCase();
    return (
      mime === "application/pdf" ||
      mime.startsWith("text/") ||
      mime.includes("document") ||
      mime.includes("msword") ||
      mime.includes("officedocument")
    );
  }).length;

  const mimeTypes = Array.from(
    new Set(
      parts
        .map((p) => clean(p.mimeType))
        .filter((v): v is string => Boolean(v))
    )
  );

  return {
    itemCount: parts.length,
    totalSizeBytes,
    mimeTypes,
    imageCount,
    videoCount,
    audioCount,
    documentCount,
  };
}

function classifyMimeToEvidenceType(
  mimeType: string | null | undefined
): prismaPkg.EvidenceType {
  const mime = String(mimeType ?? "").trim().toLowerCase();

  if (mime.startsWith("image/")) return prismaPkg.EvidenceType.PHOTO;
  if (mime.startsWith("video/")) return prismaPkg.EvidenceType.VIDEO;
  if (mime.startsWith("audio/")) return prismaPkg.EvidenceType.AUDIO;
  return prismaPkg.EvidenceType.DOCUMENT;
}

function deriveCanonicalEvidenceTypeFromParts(
  parts: ProcessedPart[],
  fallbackMimeType: string | null | undefined
): prismaPkg.EvidenceType {
  if (parts.length === 0) {
    return classifyMimeToEvidenceType(fallbackMimeType);
  }

  const kinds = new Set(
    parts.map((part) => classifyMimeToEvidenceType(part.mimeType ?? fallbackMimeType))
  );

  if (kinds.size === 1) {
    return Array.from(kinds)[0] ?? prismaPkg.EvidenceType.DOCUMENT;
  }

  return prismaPkg.EvidenceType.DOCUMENT;
}

function buildFingerprint(params: {
  evidence: {
    id: string;
    type: prismaPkg.EvidenceType;
    capturedAtUtc: Date | null;
    deviceTimeIso: string | null;
    lat: unknown;
    lng: unknown;
    accuracyMeters: unknown;
  };
  uploadedAtUtcIso: string;
  singleFile?: {
    bucket: string | null;
    key: string | null;
    sizeBytes: number;
    mimeType: string | null;
    sha256: string;
  };
  multipart?: {
    parts: ProcessedPart[];
    totalSizeBytes: number;
  };
}) {
  const gps = {
    lat: decimalToNumber(params.evidence.lat),
    lng: decimalToNumber(params.evidence.lng),
    accuracyMeters: decimalToNumber(params.evidence.accuracyMeters),
  };

  if (params.multipart) {
    const summary = buildMultipartSummary(
      params.multipart.parts,
      params.multipart.totalSizeBytes
    );

    return {
      v: 1,
      evidenceId: params.evidence.id,
      type: params.evidence.type,
      file: {
        multipart: true,
        summary,
        parts: params.multipart.parts.map((p) => ({
          partIndex: p.partIndex,
          storageBucket: p.bucket,
          storageKey: p.key,
          sizeBytes: Number(p.sizeBytes),
          mimeType: p.mimeType,
          sha256: p.sha256,
        })),
      },
      capturedAtUtc: asIso(params.evidence.capturedAtUtc),
      deviceTimeIso: params.evidence.deviceTimeIso ?? null,
      gps,
      uploadedAtUtc: params.uploadedAtUtcIso,
    };
  }

  return {
    v: 1,
    evidenceId: params.evidence.id,
    type: params.evidence.type,
    file: {
      multipart: false,
      bucket: params.singleFile?.bucket ?? null,
      key: params.singleFile?.key ?? null,
      sizeBytes: params.singleFile?.sizeBytes ?? 0,
      mimeType: params.singleFile?.mimeType ?? null,
      sha256: params.singleFile?.sha256 ?? "",
      etag: null,
    },
    capturedAtUtc: asIso(params.evidence.capturedAtUtc),
    deviceTimeIso: params.evidence.deviceTimeIso ?? null,
    gps,
    uploadedAtUtc: params.uploadedAtUtcIso,
  };
}

/**
 * ET-ACQ-04 — a pre-computed digest is bound to the exact object it was read
 * from: bucket, key, version, ETag and size. An object with neither a version
 * nor an ETag cannot be bound and is never pre-hashed.
 */
function prehashBinding(
  bucket: string,
  key: string,
  meta: { versionId?: string | null; etag?: string | null; sizeBytes?: number | null },
): string | null {
  if (!meta.versionId && !meta.etag) return null;
  return JSON.stringify([bucket, key, meta.versionId ?? null, meta.etag ?? null, meta.sizeBytes ?? null]);
}

/**
 * The digest of the object a HEAD inside the transaction just described:
 * the pre-computed one when it was read from exactly that object, otherwise
 * streamed and hashed here (a part replaced since the pre-hash, a store that
 * reports no version or ETag).
 */
async function digestOf(
  prehashed: ReadonlyMap<string, string>,
  bucket: string,
  key: string,
  meta: { versionId?: string | null; etag?: string | null; sizeBytes?: number | null },
): Promise<string> {
  const binding = prehashBinding(bucket, key, meta);
  const known = binding ? prehashed.get(binding) : undefined;
  if (known) return known;
  const body = await safeGetStream(bucket, key, meta.versionId ?? null);
  return sha256HexFromStream(body as unknown as Readable);
}

/**
 * ET-ACQ-04 — THE pre-transaction phase of completion. For a record that can
 * still be completed: HEAD every object, refuse an oversize total with 413
 * before any GET, then read and hash each object OUTSIDE the interactive
 * transaction (which ran hashing, signing and the TSA call inside a 120 s
 * window). Anything it cannot establish is left to the transaction, which
 * gives the canonical answer (a missing object, a finalized record, an
 * unauthorized caller): this phase only ever saves work or refuses oversize.
 */
async function prehashCompletionObjects(input: {
  evidenceId: string;
  ownerUserId: string;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const evidence = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, ownerUserId: input.ownerUserId, deletedAt: null },
    select: { status: true, storageBucket: true, storageKey: true },
  });
  if (!evidence) return out;
  if (
    evidence.status === EvidenceStatus.SIGNED ||
    evidence.status === EvidenceStatus.REPORTED ||
    evidence.status === EvidenceStatus.FAILED_HASH_MISMATCH
  ) {
    return out;
  }
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId: input.evidenceId },
    orderBy: { partIndex: "asc" },
    select: { storageBucket: true, storageKey: true },
  });
  const objects =
    parts.length > 0
      ? parts.map((p) => ({ bucket: clean(p.storageBucket), key: clean(p.storageKey) }))
      : [{ bucket: clean(evidence.storageBucket), key: clean(evidence.storageKey) }];
  const heads: Array<{ bucket: string; key: string; meta: Awaited<ReturnType<typeof safeHead>> }> = [];
  for (const o of objects) {
    if (!o.bucket || !o.key) return out;
    try {
      heads.push({ bucket: o.bucket, key: o.key, meta: await safeHead(o.bucket, o.key) });
    } catch {
      return out;
    }
  }
  if (heads.reduce((sum, h) => sum + (h.meta.sizeBytes ?? 0), 0) > readMaxEvidenceSizeBytes()) {
    const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), { statusCode: 413 });
    throw err;
  }
  for (const h of heads) {
    const binding = prehashBinding(h.bucket, h.key, h.meta);
    if (!binding || !h.meta.sizeBytes || h.meta.sizeBytes <= 0) continue;
    const body = await safeGetStream(h.bucket, h.key, h.meta.versionId ?? null);
    out.set(binding, await sha256HexFromStream(body as unknown as Readable));
  }
  return out;
}

export async function completeEvidence(params: {
  evidenceId: string;
  ownerUserId: string;
  /**
   * UC-0 — present ONLY when the direct-capture session adapter completes the
   * record it reserved. A record bound to an ACTIVE direct-capture session can
   * be completed through that session and nothing else.
   */
  captureSession?: CaptureSessionCompletion;
  /**
   * UC-ARCH-005 — present ONLY when the external-intake orchestration submits
   * the contributor's session. A SECURE_INTAKE_LINK record is completed through
   * its bound intake session and nothing else: its owner of record (the link
   * creator) cannot seal a contributor's in-flight submission through the
   * authenticated /v1/evidence/:id/complete door.
   */
  intakeSubmission?: { sessionId: string };
  /**
   * UC-ARCH-003 — who asked and from where, for the ONE completion custody
   * event and tenant audit this authority now writes for every channel.
   */
  requestContext?: { ip?: string | null; userAgent?: string | null; correlationId?: string | null };
}): Promise<CompleteEvidenceReturn> {
  const signer = getEvidenceSigner();

  // ET-ACQ-04 — size and digests are established BEFORE the interactive
  // transaction: an oversize upload is refused from its HEAD sizes before a
  // single byte is read, and the bytes are hashed outside the 120 s window
  // (bound to the exact object version, re-checked inside).
  const prehashed = await prehashCompletionObjects({
    evidenceId: params.evidenceId,
    ownerUserId: params.ownerUserId,
  });

  const final = await prisma.$transaction(
    async (tx): Promise<CompleteEvidenceTransactionResult> => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
      `;

      const evidence = await tx.evidence.findFirst({
        where: {
          id: params.evidenceId,
          ownerUserId: params.ownerUserId,
          deletedAt: null,
        },
      });

      if (!evidence) {
        const err: HttpError = Object.assign(new Error("NOT_FOUND"), {
          statusCode: 404,
        });
        throw err;
      }

      const scope = await resolveEnforcementScopeForRequester({
        ownerUserId: evidence.ownerUserId,
        teamId: evidence.teamId ?? null,
      });

      const evidenceBucket = clean(evidence.storageBucket);
      const evidenceKey = clean(evidence.storageKey);
      const evidenceMime = normalizeObservedMimeType(evidence.mimeType);

      if (evidence.status === EvidenceStatus.REPORTED) {
        // ET-SEC-11 — a REPORTED record is finalized too. Without
        // alreadyFinalized a repeat /complete re-ran the one-time fan-out:
        // a second EVIDENCE_COMPLETED custody event, the evidence.completed
        // webhook, the malware scan and post-finalize work.
        safeEmitSecurityEvent({
          teamId: evidence.teamId,
          eventType: "finalize_duplicate_detected",
          severity: "INFO",
          evidenceId: evidence.id,
          details: { reason: "already_reported" },
        });
        return {
          alreadyFinalized: true,
          result: {
            id: evidence.id,
            status: evidence.status,
            fileSha256: evidence.fileSha256,
            fingerprintHash: evidence.fingerprintHash,
            signatureBase64: evidence.signatureBase64,
            signingKeyId: evidence.signingKeyId,
            signingKeyVersion: evidence.signingKeyVersion,
            alreadyFinalized: true,
          },
          shouldEnqueueReport: false,
          retentionTargets: [],
        };
      }

      // Phase A0 — integrity hard-gate terminal short-circuit.
      // FAILED_HASH_MISMATCH is set by the worker (or any future
      // reconciler) when a server-recomputed SHA-256 disagreed with
      // the value persisted at completion. A retry POST to /complete
      // must NOT re-promote this row: completion is single-shot in
      // its current design (it OVERWRITES `fileSha256` from the
      // server-recomputed stream), and a successful retry here would
      // silently re-flip the row to SIGNED even though the worker had
      // recorded a real mismatch. Refuse with 409 and a bounded
      // operator-readable code; the route layer surfaces this to the
      // owner.
      if (evidence.status === EvidenceStatus.FAILED_HASH_MISMATCH) {
        const err: HttpError = Object.assign(
          new Error("EVIDENCE_INTEGRITY_FAILED"),
          { statusCode: 409 },
        );
        throw err;
      }

      if (evidence.status === EvidenceStatus.SIGNED) {
        // Phase 12 — duplicate finalize detected. Audit so operators
        // can spot retry storms; the response is still the canonical
        // existing result so callers see a stable success.
        safeEmitSecurityEvent({
          teamId: evidence.teamId,
          eventType: "finalize_duplicate_detected",
          severity: "INFO",
          evidenceId: evidence.id,
          details: { reason: "already_signed" },
        });
        /*
         * A DUPLICATE COMPLETE REPEATS NOTHING THAT ALREADY HAPPENED
         * (2026-09-29, audit D11). It used to hand the primary object back
         * for retention every time — re-applying PutObjectRetention (which
         * can extend retain-until) and appending another lock custody event
         * — and the fan-out below re-emitted the webhook and the scan.
         * Retention is now re-applied only when the first finalize never
         * recorded a lock (a post-commit failure this call can repair).
         */
        const retentionTargets: RetentionTarget[] = [];
        if (evidenceBucket && evidenceKey && !evidence.storageObjectLockMode) {
          retentionTargets.push({
            bucket: evidenceBucket,
            key: evidenceKey,
            versionId: evidence.storageVersionId ?? null,
          });
        }

        return {
          alreadyFinalized: true,
          result: {
            id: evidence.id,
            status: evidence.status,
            fileSha256: evidence.fileSha256,
            fingerprintHash: evidence.fingerprintHash,
            signatureBase64: evidence.signatureBase64,
            signingKeyId: evidence.signingKeyId,
            signingKeyVersion: evidence.signingKeyVersion,
            alreadyFinalized: true,
          },
          // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the already-signed
          // path re-reads how THIS record was funded instead of re-asking the
          // account's plan. A credit-funded record on a FREE account still
          // earns its report; asking `canPlanGenerateReports(FREE)` here
          // silently withheld the output the customer had paid for.
          shouldEnqueueReport: resolveEvidenceOutputEntitlements({
            plan: scope.plan,
            funding: await resolveEvidenceFunding(evidence.id),
          }).reportsIncluded,
          retentionTargets,
        };
      }

      // UC-COM-001 — an EXPIRED reservation (untouched for the whole window and
      // held by no live session) has stopped counting against the allowance, so
      // it may not be sealed: sealing it would fund a record the admission
      // population no longer contains. The capture must be admitted afresh.
      if (await isEvidenceReservationExpiredTx(tx, evidence.id, new Date())) {
        throw captureCompletionError("EVIDENCE_RESERVATION_EXPIRED");
      }

      // Phase 30.7 — custody-safe finalize gate.
      //
      // If a Phase 30 resumable upload session exists for this
      // evidence, refuse finalization unless that session is
      // COMPLETED with every part VERIFIED. Legacy single-shot
      // uploads (no session row) continue unchanged.
      //
      // The gate read runs on the transaction client so it shares
      // the advisory-lock snapshot with the SIGNED-status short-
      // circuit above. A concurrent session abort cannot race past
      // this check.
      //
      // Idempotency: this gate sits AFTER the SIGNED/REPORTED
      // short-circuits. A retry on already-finalized evidence
      // returns the existing chain WITHOUT re-evaluating the gate,
      // so a session that aborted post-finalization cannot retro-
      // actively turn a successful finalize into a denial.
      if (evidence.teamId) {
        const gate = await evaluateUploadSessionFinalizeGate(
          { teamId: evidence.teamId, evidenceId: evidence.id },
          tx as unknown as typeof prisma,
        );
        if (!gate.ok) {
          safeEmitSecurityEvent({
            teamId: evidence.teamId,
            eventType: "finalize_blocked_by_upload_session",
            severity: "WARNING",
            evidenceId: evidence.id,
            details: {
              reason: gate.reason,
              sessionId: gate.sessionId ?? null,
              sessionState: gate.sessionState ?? null,
            },
          });
          const statusCode =
            gate.reason === "gate_unavailable" ? 503 : 409;
          const err: HttpError = Object.assign(
            new Error(`UPLOAD_SESSION_GATE:${gate.reason}`),
            { statusCode },
          );
          throw err;
        }
      }

      // UC-0 — direct-capture session guard. A record reserved by a
      // server-issued capture session carries that session's declared digests
      // and trust chain; completing it through any other door (e.g.
      // POST /v1/evidence/:id/complete) would seal it without the digest
      // comparison and without binding the session. Refuse that, and refuse a
      // session completion that names a different session. Web capture DRAFT
      // sessions carry no acquisition mode and are unaffected.
      const boundCaptureSession = await tx.captureSession.findFirst({
        where: { finalizedEvidenceId: evidence.id, acquisitionMode: { not: null } },
        select: { id: true, status: true },
      });
      if (boundCaptureSession) {
        if (params.captureSession?.sessionId !== boundCaptureSession.id) {
          throw captureCompletionError("CAPTURE_SESSION_COMPLETION_REQUIRED");
        }
        if (boundCaptureSession.status !== prismaPkg.CaptureSessionStatus.ACTIVE) {
          throw captureCompletionError("CAPTURE_SESSION_NOT_ACTIVE");
        }
      } else if (params.captureSession) {
        throw captureCompletionError("CAPTURE_SESSION_NOT_BOUND_TO_EVIDENCE");
      }

      // UC-ARCH-005 — an intake record seals only through its bound intake
      // session (the contributor's submit). The link creator owns the record of
      // record but may not finalize a contributor's in-flight submission.
      if (evidence.acquisitionMode === "SECURE_INTAKE_LINK") {
        if (!params.intakeSubmission) {
          throw captureCompletionError("INTAKE_SUBMISSION_REQUIRED");
        }
        const boundIntake = await tx.workflowIntakeSession.findFirst({
          where: { id: params.intakeSubmission.sessionId, evidenceId: evidence.id },
          select: { id: true },
        });
        if (!boundIntake) throw captureCompletionError("INTAKE_SESSION_NOT_BOUND_TO_EVIDENCE");
      } else if (params.intakeSubmission) {
        throw captureCompletionError("INTAKE_SESSION_NOT_BOUND_TO_EVIDENCE");
      }

      // Phase 12 — move the operations-side session to VERIFYING. Best
      // effort; failure here MUST NOT break the forensic write path.
      safeTransitionUploadSession({
        evidenceId: evidence.id,
        to: "VERIFYING",
      }).catch(() => null);

      const parts = await tx.evidencePart.findMany({
        where: { evidenceId: evidence.id },
        orderBy: { partIndex: "asc" },
      });

      if (parts.length === 0 && (!evidenceBucket || !evidenceKey)) {
        const err: HttpError = Object.assign(
          new Error("Cannot complete evidence without an uploaded file"),
          { statusCode: 400 }
        );
        throw err;
      }

      // Phase CAPTURE-HARDENING — server-side required-checklist gate.
      // Runs BEFORE signature / TSA / Object Lock / report enqueue, so
      // a rejected finalize never produces a custody / signature /
      // package artifact. See validateRequiredChecklistMapping JSDoc.
      // ET-ACQ-05 — the plan comes from the server when it can: the capture
      // session the owner opened (its plan mode) and the template it named.
      const planSession = await tx.captureSession.findFirst({
        where: { finalizedEvidenceId: evidence.id, ownerUserId: evidence.ownerUserId },
        select: { planMode: true, templateId: true },
      });
      const planTemplate = planSession?.templateId ? getIntakeTemplate(planSession.templateId) : null;
      const checklistVerdict = validateRequiredChecklistMapping({
        intakePlanJson: effectiveChecklistPlan({
          clientPlan: evidence.intakePlanJson,
          serverSession: planSession,
          serverTemplate: planTemplate,
        }),
        parts: parts.map((p) => ({ checklistStepId: p.checklistStepId })),
      });
      if (checklistVerdict.enforced && checklistVerdict.missing.length > 0) {
        // Audit the rejection so operators can see when a client tried
        // to bypass the frontend gate. No Sentry capture — this is a
        // business validation result, not an unexpected error.
        safeEmitSecurityEvent({
          teamId: evidence.teamId,
          eventType: "finalize_blocked_by_checklist",
          severity: "WARNING",
          evidenceId: evidence.id,
          details: {
            missingRequiredSteps: checklistVerdict.missing,
          },
        });
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Required checklist steps are not satisfied.",
          {
            field: "intakePlanJson.requiredSteps",
            missingRequiredSteps: checklistVerdict.missing,
          },
        );
      }

      let sizeBytesNum = 0;
      let fileSha256 = "";
      let primaryBucket = evidenceBucket;
      let primaryKey = evidenceKey;
      let primaryVersionId: string | null = null;
      let primaryMimeType = evidenceMime;
      let multipartItemCount = 1;
      let multipart = false;
      let canonical = "";
      let fingerprintHash = "";
      let canonicalEvidenceType = evidence.type;
      // Phase C #4 — multipart hash semantics. These variables are populated
      // in either the multipart branch or the single-file branch and stored
      // alongside fileSha256 so consumers know which is which.
      let multipartManifestSha256Out: string | null = null;
      let hashSemanticsOut: "single_file" | "multipart_composite" =
        "single_file";
      const retentionTargets: RetentionTarget[] = [];

      const now = new Date();
      const uploadedAtUtcIso = now.toISOString();

      if (parts.length > 0) {
        const updatedParts: ProcessedPart[] = [];

        // ET-ACQ-04 — every part's HEAD first, and the total refused before
        // any part is read (it was compared only after every part had been
        // downloaded and hashed).
        const heads: Array<{
          part: (typeof parts)[number];
          bucket: string;
          key: string;
          meta: Awaited<ReturnType<typeof safeHead>>;
          size: number;
        }> = [];
        for (const part of parts) {
          const bucket = clean(part.storageBucket);
          const key = clean(part.storageKey);

          if (!bucket || !key) {
            const err: HttpError = Object.assign(
              new Error("PART_STORAGE_NOT_SET"),
              { statusCode: 400 }
            );
            throw err;
          }

          const meta = await safeHead(bucket, key);
          const size = meta.sizeBytes;

          if (!size || size <= 0) {
            const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
              statusCode: 404,
            });
            throw err;
          }
          heads.push({ part, bucket, key, meta, size });
        }
        if (heads.reduce((sum, h) => sum + h.size, 0) > readMaxEvidenceSizeBytes()) {
          const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
            statusCode: 413,
          });
          throw err;
        }

        for (const { part, bucket, key, meta, size } of heads) {
          const sha256 = await digestOf(prehashed, bucket, key, meta);

          sizeBytesNum += size;

          const mimeType =
            normalizeObservedMimeType(meta.contentType) ??
            normalizeObservedMimeType(part.mimeType) ??
            null;

          updatedParts.push({
            id: part.id,
            partIndex: part.partIndex,
            sizeBytes: BigInt(size),
            sha256,
            mimeType,
            bucket,
            key,
            versionId: meta.versionId ?? null,
          });

          retentionTargets.push({
            bucket,
            key,
            versionId: meta.versionId ?? null,
            evidencePartId: part.id,
          });
        }

        if (updatedParts.length === 0) {
          const err: HttpError = Object.assign(
            new Error("NO_VALID_PARTS_FOUND"),
            { statusCode: 400 }
          );
          throw err;
        }

        // UC-0 — server digest vs session-declared digest, per part, BEFORE
        // anything is signed. A part with no declaration is refused too: the
        // session adapter declares every part it uploads.
        if (params.captureSession) {
          const expected = params.captureSession.expectedSha256ByPartIndex;
          if (expected.size !== updatedParts.length) {
            throw captureCompletionError("CAPTURE_PART_DECLARATION_MISMATCH");
          }
          for (const p of updatedParts) {
            const declared = expected.get(p.partIndex);
            if (!declared) {
              throw captureCompletionError("CAPTURE_PART_UNDECLARED");
            }
            if (declared.toLowerCase() !== p.sha256.toLowerCase()) {
              throw captureCompletionError("CAPTURE_DIGEST_MISMATCH");
            }
          }
        }

        primaryBucket = updatedParts[0].bucket;
        primaryKey = updatedParts[0].key;
        primaryVersionId = updatedParts[0].versionId;
        primaryMimeType =
          updatedParts[0].mimeType ?? primaryMimeType ?? evidenceMime;
        canonicalEvidenceType = deriveCanonicalEvidenceTypeFromParts(
          updatedParts,
          primaryMimeType
        );

const isMultipartPackage = updatedParts.length > 1;

// Phase C #4 — multipart hash semantics.
//
// Single-file evidence: fileSha256 IS the SHA-256 of the original file.
// Multipart evidence: fileSha256 is a synthetic composite (per-part
// SHA-256s joined by "|" then hashed). To make multipart integrity
// independently reproducible by reviewers, we ALSO record an explicit
// multipartManifestSha256 computed deterministically from the per-part
// hashes in part-index order, joined by newlines. The package-checksums.json
// in the verification package is the same source of truth.
// UC-ARCH-006 — the shared digest rules (same module the worker re-derives with).
fileSha256 = isMultipartPackage
  ? compositeSha256([...updatedParts].sort((a, b) => a.partIndex - b.partIndex).map((p) => p.sha256))
  : updatedParts[0]!.sha256;

const sortedPartsForManifest = [...updatedParts].sort(
  (a, b) => a.partIndex - b.partIndex
);
multipartManifestSha256Out = isMultipartPackage
  ? multipartManifestSha256(sortedPartsForManifest.map((p) => p.sha256))
  : null;
hashSemanticsOut = isMultipartPackage
  ? "multipart_composite"
  : "single_file";

multipart = isMultipartPackage;
multipartItemCount = updatedParts.length;

        await Promise.all(
          updatedParts.map((p) =>
            tx.evidencePart.update({
              where: { id: p.id },
              data: {
                sizeBytes: p.sizeBytes,
                sha256: p.sha256,
                mimeType: p.mimeType,
                storageVersionId: p.versionId,
                uploadedByUserId: params.ownerUserId,
                uploadedAtUtc: now,
              },
            })
          )
        );

const fingerprint = buildFingerprint({
  evidence: {
    id: evidence.id,
    type: canonicalEvidenceType,
    capturedAtUtc: evidence.capturedAtUtc,
    deviceTimeIso: evidence.deviceTimeIso,
    lat: evidence.lat,
    lng: evidence.lng,
    accuracyMeters: evidence.accuracyMeters,
  },
  uploadedAtUtcIso,
  ...(isMultipartPackage
    ? {
        multipart: {
          parts: updatedParts,
          totalSizeBytes: sizeBytesNum,
        },
      }
    : {
        singleFile: {
          bucket: updatedParts[0]!.bucket,
          key: updatedParts[0]!.key,
          sizeBytes: Number(updatedParts[0]!.sizeBytes),
          mimeType: updatedParts[0]!.mimeType,
          sha256: updatedParts[0]!.sha256,
        },
      }),
});

        canonical = canonicalJson(fingerprint);
        fingerprintHash = sha256Hex(canonical);
      } else {
        // UC-0 — a session-bound record is always sealed from its declared
        // parts; the legacy single-object path has nothing to compare against.
        if (params.captureSession) {
          throw captureCompletionError("CAPTURE_PARTS_REQUIRED");
        }
        const bucket = evidenceBucket!;
        const key = evidenceKey!;

        const meta = await safeHead(bucket, key);
        const size = meta.sizeBytes;

        if (!size || size <= 0) {
          const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
            statusCode: 404,
          });
          throw err;
        }

        sizeBytesNum = size;

        const maxBytes = readMaxEvidenceSizeBytes();
        if (sizeBytesNum > maxBytes) {
          const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
            statusCode: 413,
          });
          throw err;
        }

        primaryMimeType =
          normalizeObservedMimeType(meta.contentType) ?? evidenceMime ?? null;
        primaryBucket = bucket;
        primaryKey = key;
        canonicalEvidenceType = classifyMimeToEvidenceType(primaryMimeType);

        retentionTargets.push({
          bucket,
          key,
          versionId: meta.versionId ?? null,
        });

        primaryVersionId = meta.versionId ?? null;
        fileSha256 = await digestOf(prehashed, bucket, key, meta);

        const fingerprint = buildFingerprint({
          evidence: {
            id: evidence.id,
            type: canonicalEvidenceType,
            capturedAtUtc: evidence.capturedAtUtc,
            deviceTimeIso: evidence.deviceTimeIso,
            lat: evidence.lat,
            lng: evidence.lng,
            accuracyMeters: evidence.accuracyMeters,
          },
          uploadedAtUtcIso,
          singleFile: {
            bucket: primaryBucket,
            key: primaryKey,
            sizeBytes: sizeBytesNum,
            mimeType: primaryMimeType,
            sha256: fileSha256,
          },
        });

        canonical = canonicalJson(fingerprint);
        fingerprintHash = sha256Hex(canonical);
      }

      const existingStoredBytes =
        typeof evidence.sizeBytes === "bigint" ? evidence.sizeBytes : 0n;
      const nextStoredBytes = BigInt(sizeBytesNum);
      const incomingGrowth =
        nextStoredBytes > existingStoredBytes
          ? nextStoredBytes - existingStoredBytes
          : 0n;

      // ET-SEC-28 — under the workspace capacity lock (see
      // lockEvidenceCapacitySubject): a concurrent finalize in this workspace
      // waits here until this one commits, then sees its bytes.
      await lockEvidenceCapacitySubject(scope, tx);
      await assertWorkspaceAllowsStorageGrowth({
        scope,
        incomingBytes: incomingGrowth,
      });

      const signResult = await signer.signFingerprintHex(fingerprintHash);

      const tsaResult = await createEvidenceTimestamp({
        digestHex: fileSha256,
      });
      const tsaInputKind =
        multipartItemCount > 1 ? "CANONICAL_PACKAGE_SHA256" : "FILE_SHA256";

// UC-0 — `captureMethod` is the legacy STRUCTURE/compat field (single file vs
// multipart). It is NOT acquisition: `acquisitionMode` is written once by
// createEvidence and is deliberately absent from `finalizeData` below, so
// completion can never change how a record says it entered PROOVRA.
const captureMethod =
  multipartItemCount > 1
    ? prismaPkg.CaptureMethod.MULTIPART_PACKAGE
    : prismaPkg.CaptureMethod.UPLOADED_FILE;
    
      // Phase 12 — atomic finalize guard. We already hold the
      // advisory lock and we already returned early if the row was
      // SIGNED, but this `updateMany` re-asserts the precondition at
      // the DB level so a refactor that accidentally removes either
      // guard above cannot silently create a duplicate finalize.
      const finalizeData = {
        status: EvidenceStatus.SIGNED,
        verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
        type: canonicalEvidenceType,
        captureMethod,
        uploadedByUserId: params.ownerUserId,
        uploadedAtUtc: now,
        signedAtUtc: now,
        sizeBytes: BigInt(sizeBytesNum),
        mimeType: primaryMimeType,
        fileSha256,
        // (2026-09-29, D14) The signed version of the primary original.
        storageVersionId: primaryVersionId,
        // Phase C #4: explicit multipart hash semantics, see schema
        // comments. fileSha256 alone is ambiguous for multipart records
        // because it's a synthetic composite of per-part hashes.
        multipartManifestSha256: multipartManifestSha256Out,
        hashSemantics: hashSemanticsOut,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: signResult.signatureBase64,
        signingKeyId: signResult.keyId,
        signingKeyVersion: signResult.keyVersion,
        storageBucket: primaryBucket,
        storageKey: primaryKey,
        tsaProvider: tsaResult?.provider ?? null,
        tsaUrl: tsaResult?.url ?? null,
        tsaSerialNumber: tsaResult?.serialNumber ?? null,
        tsaGenTimeUtc: tsaResult?.genTimeUtc ?? null,
        tsaTokenBase64: tsaResult?.tokenBase64 ?? null,
        tsaMessageImprint: tsaResult?.messageImprint ?? null,
        // Phase IA-digest-policy-hard-invariant — semantic refresh.
        //
        //   tsaInputDigestHex   = the digest we sent to `openssl ts -query`
        //                         (i.e. what the request asked the TSA to
        //                         certify). ALWAYS persisted when a TSA
        //                         request was made — STAMPED or FAILED.
        //   tsaMessageImprint   = the imprint READ FROM THE TOKEN (ET-TSA-03,
        //                         2026-09-29). It used to be the digest we
        //                         sent, so every read-side "imprint matches"
        //                         check compared a value with itself.
        //
        //   tsaInputKind        = the shape label for that request digest
        //                         (FILE_SHA256 or CANONICAL_PACKAGE_SHA256).
        //                         ALWAYS persisted alongside the digest so
        //                         the trust chain is self-describing
        //                         without a join.
        //
        // Issue #8 was about NOT falling back to a random column when the
        // TSA never ran — that intent is preserved: on rows with no
        // tsaResult (TSA disabled / not configured) both columns remain
        // null, because there was no request to record.
        tsaInputDigestHex: tsaResult ? tsaResult.requestDigestHex : null,
        tsaInputKind: tsaResult ? tsaInputKind : null,
        tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
        tsaStatus: tsaResult?.status ?? null,
        tsaFailureReason: tsaResult?.failureReason ?? null,
        // ET-TSA-01 / ET-TSA-06: validation facts and the bounded failure code.
        tsaFailureCode: tsaResult?.failureCode ?? null,
        tsaValidatedAtUtc: tsaResult?.validatedAtUtc ?? null,
        tsaSignerCertSha256: tsaResult?.signerCertSha256 ?? null,
        tsaPolicyOid: tsaResult?.policyOid ?? null,
      } satisfies prismaPkg.Prisma.EvidenceUpdateManyMutationInput;

      /*
       * EVERY RECORD FINALIZES UNPUBLISHED (ET-PKG-07, owner decision
       * 2026-09-30). Evidence is private by default: a record becomes publicly
       * verifiable only when its owner publishes it, and then only through a
       * share link.
       *
       * (2026-09-29, audit D3) finalized NOT_PUBLISHED only where the
       * workspace required publication approval, and PUBLISHED everywhere
       * else — by the column default. The default is no longer consulted and
       * no policy is read here: NOT_PUBLISHED is written on every path.
       * Publishing is an explicit action that needs the publish permission
       * (evidence.publish_verify) and its step-up, in every workspace.
       */
      const finalizeClaim = await tx.evidence.updateMany({
        where: {
          // ET-DC-01: a released (soft-deleted) reservation is never signed.
          deletedAt: null,
          id: evidence.id,
          status: {
            in: [EvidenceStatus.CREATED, EvidenceStatus.UPLOADING],
          },
        },
        data: { ...finalizeData, publicVerifyState: "NOT_PUBLISHED" },
      });
      if (finalizeClaim.count !== 1) {
        // Race lost — another finalize won between the early-return
        // check and this update. Audit + raise a stable error so the
        // outer handler can re-fetch and return the canonical result.
        safeEmitSecurityEvent({
          teamId: evidence.teamId,
          eventType: "finalize_duplicate_detected",
          severity: "WARNING",
          evidenceId: evidence.id,
          details: { reason: "lost_finalize_race" },
        });
        const err: HttpError = Object.assign(
          new Error("EVIDENCE_FINALIZE_RACE_DETECTED"),
          { statusCode: 409 },
        );
        throw err;
      }
      const ev = await tx.evidence.findUniqueOrThrow({
        where: { id: evidence.id },
        select: {
          id: true,
          status: true,
          fileSha256: true,
          fingerprintHash: true,
          signatureBase64: true,
          signingKeyId: true,
          signingKeyVersion: true,
          storageRegion: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
        },
      });

      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.UPLOAD_COMPLETED,
        atUtc: now,
        payload: {
          phase: "upload_completed",
          multipart,
          itemCount: multipartItemCount,
          sizeBytes: sizeBytesNum,
          mimeType: primaryMimeType,
          fileSha256,
          captureMethod,
          uploadedByUserId: params.ownerUserId,
        } as prismaPkg.Prisma.InputJsonValue,
      });

      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.SIGNATURE_APPLIED,
        atUtc: now,
        payload: {
          phase: "signature_applied",
          verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
          captureMethod,
          fingerprintHash,
          signingKeyId: signResult.keyId,
          signingKeyVersion: signResult.keyVersion,
          multipart,
          itemCount: multipartItemCount,
          tsaProvider: tsaResult?.provider ?? null,
          tsaUrl: tsaResult?.url ?? null,
          tsaSerialNumber: tsaResult?.serialNumber ?? null,
          tsaGenTimeUtc: tsaResult?.genTimeUtc?.toISOString() ?? null,
          tsaMessageImprint: tsaResult?.messageImprint ?? null,
          // Phase IA-digest-policy-hard-invariant — always record what we
          // sent + its label, regardless of STAMPED/FAILED outcome. The
          // chain stays self-describing for triage.
          tsaInputDigestHex: tsaResult ? tsaResult.requestDigestHex : null,
          tsaInputKind: tsaResult ? tsaInputKind : null,
          tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
          tsaStatus: tsaResult?.status ?? null,
          tsaFailureReason: tsaResult?.failureReason ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
      });

      if (tsaResult) {
        await appendCustodyEventTx(tx, {
          evidenceId: evidence.id,
          eventType:
            tsaResult.status === "STAMPED"
              ? prismaPkg.CustodyEventType.TIMESTAMP_APPLIED
              : prismaPkg.CustodyEventType.TIMESTAMP_FAILED,
          atUtc: now,
          payload: {
            tsaProvider: tsaResult.provider,
            tsaUrl: tsaResult.url,
            tsaSerialNumber: tsaResult.serialNumber,
            tsaGenTimeUtc: tsaResult.genTimeUtc?.toISOString() ?? null,
            tsaMessageImprint: tsaResult.messageImprint,
            tsaInputDigestHex: tsaResult.requestDigestHex,
            tsaInputKind,
            tsaHashAlgorithm: tsaResult.hashAlgorithm,
            tsaStatus: tsaResult.status,
            tsaFailureReason: tsaResult.failureReason,
            // ET-TSA-01/06: the validation fact and the bounded failure code.
            tsaFailureCode: tsaResult.failureCode,
            tsaValidatedAtUtc: tsaResult.validatedAtUtc?.toISOString() ?? null,
            // Phase IA-digest-policy-hard-invariant — surface soft
            // parser issues for STAMPED rows so operators can see "the
            // timestamp landed but our parser missed the serial" without
            // re-reading the token. Empty on fully-clean STAMPED + on
            // every FAILED row.
            tsaParseWarnings: tsaResult.warnings,
          } as prismaPkg.Prisma.InputJsonValue,
        });
      }

      // UC-ARCH-003 — THE completion custody event, for EVERY channel, inside
      // the transaction that won the finalize claim above: exactly once per
      // record (a duplicate complete returns before reaching here), and never
      // without the signature it announces. It used to be appended only by the
      // web /complete route, so direct-capture and intake records had none.
      const completedViaIntake = evidence.acquisitionMode === "SECURE_INTAKE_LINK";
      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_COMPLETED,
        atUtc: now,
        payload: {
          // An intake record is completed by the external contributor, who
          // has no user account; its owner of record did not complete it.
          completedByUserId: completedViaIntake ? null : params.ownerUserId,
          completedBy: completedViaIntake ? "EXTERNAL_CONTRIBUTOR" : "OWNER",
          completedAtUtc: now.toISOString(),
          acquisitionMode: evidence.acquisitionMode ?? null,
          captureSessionId: params.captureSession?.sessionId ?? null,
          intakeSessionId: params.intakeSubmission?.sessionId ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
        ip: params.requestContext?.ip ?? null,
        userAgent: params.requestContext?.userAgent ?? null,
      });

      // UC-WEB-001 — a web capture DRAFT bound to this record is FINALIZED
      // here, when the record is sealed — not when it was reserved. A draft
      // whose finalize failed mid-upload therefore stays resumable.
      const boundDrafts = await tx.captureSession.findMany({
        where: {
          finalizedEvidenceId: evidence.id,
          acquisitionMode: null,
          status: prismaPkg.CaptureSessionStatus.DRAFT,
        },
        select: { id: true },
      });
      for (const draft of boundDrafts) {
        await tx.captureSession.update({
          where: { id: draft.id },
          data: { status: prismaPkg.CaptureSessionStatus.FINALIZED, finalizedAtUtc: now },
        });
        await tx.captureSessionEvent.create({
          data: {
            sessionId: draft.id,
            actorUserId: params.ownerUserId,
            eventType: prismaPkg.CaptureSessionEventType.FINALIZED,
            payload: { evidenceId: evidence.id } as prismaPkg.Prisma.InputJsonValue,
          },
        });
      }

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — settle the commercial
      // cost of this completion INSIDE the completion transaction.
      //
      // `consumeWorkspaceCompletionCredits(scope)` used to be called here with
      // no transaction client, so it ran against the global prisma connection:
      // a completion that rolled back after this line still burned the
      // customer's credit. `tx` is now passed, so the spend and the completion
      // commit or roll back together, and the ledger's unique `evidence_id`
      // makes a retry for this same record a no-op rather than a second spend.
      // BILLING PRODUCTION CLOSURE (2026-08-27) — the record count is no longer
      // passed from here.
      //
      // The comment that stood in this place claimed the row "is already
      // written inside `tx`, so the canonical count does not yet include it".
      // That was false: this transaction CLAIMS a row `createEvidence`
      // inserted and committed earlier (see the `evidence.updateMany` claim
      // above), and `countPersonalEvidenceRecords` reads the global client. The
      // count therefore included the record being funded, and FREE's third
      // record — PRO's hundredth — asked for a paid credit it should never
      // have needed. `settleEvidenceCompletionFunding` now takes the count
      // itself, excluding this record by id.
      const settlement = await settleEvidenceCompletionFunding(
        { scope, evidenceId: ev.id },
        tx,
      );

      // ET-COM-04 — THE STORED FUNDING FACT. The issuance decision is taken
      // HERE, once, from the plan the record was settled on, how it was
      // funded, and the subscription lifecycle as it stands at finalization.
      // When that decision is ENTITLED on a plan basis it is written onto the
      // record in this same transaction, so a later billing lapse cannot
      // revoke an output the record has already earned. (A credit-funded
      // record's fact is its ledger row; a lapsed plan settles as FREE and
      // earns nothing plan-based.)
      const finalizationIssuance = resolveFinalizationIssuance(scope, settlement.funding);
      const earned = outputEarnedFactFromDecision({
        plan: evidenceCreationScope(scope).plan as PlanType,
        decision: finalizationIssuance,
      });
      if (earned) {
        await tx.evidence.updateMany({
          where: { id: ev.id, outputEarnedBasis: null },
          data: {
            outputEarnedPlan: earned.plan,
            outputEarnedBasis: earned.basis,
            outputEarnedAtUtc: now,
          },
        });
      }

      // ET-SM-07 — THE FIRST INTEGRITY CHECK. The digest just signed was
      // computed from the stored bytes at the versions recorded above, so
      // finalization IS a verified read of them. It is recorded through the
      // integrity-recheck authority: a new record is "verified, current" from
      // the moment it is signed, and the scheduled recheck takes it from here.
      const signedRow = await tx.evidence.findUniqueOrThrow({
        where: { id: ev.id },
        select: { teamId: true, fileSha256: true, storageVersionId: true },
      });
      const signedParts = await tx.evidencePart.findMany({
        where: { evidenceId: ev.id },
        orderBy: { partIndex: "asc" },
        select: { partIndex: true, storageVersionId: true, sha256: true },
      });
      await recordIntegrityCheckTx(tx, {
        evidenceId: ev.id,
        teamId: signedRow.teamId ?? null,
        outcome: "VERIFIED",
        failureCode: null,
        trigger: "FINALIZATION",
        storageVersionId: signedParts.length > 0 ? null : (signedRow.storageVersionId ?? null),
        checkedObjects:
          signedParts.length > 0
            ? signedParts.map((p) => ({
                partIndex: p.partIndex,
                versionId: p.storageVersionId ?? null,
                sha256: p.sha256 ?? null,
              }))
            : [
                {
                  partIndex: null,
                  versionId: signedRow.storageVersionId ?? null,
                  sha256: signedRow.fileSha256 ?? null,
                },
              ],
        expectedDigest: signedRow.fileSha256 ?? null,
        checkedDigest: signedRow.fileSha256 ?? null,
        correlationId: `finalize:${ev.id}`,
        checkedAtUtc: now,
      });

      return {
        result: {
          id: ev.id,
          status: ev.status,
          fileSha256: ev.fileSha256,
          fingerprintHash: ev.fingerprintHash,
          signatureBase64: ev.signatureBase64,
          signingKeyId: ev.signingKeyId,
          signingKeyVersion: ev.signingKeyVersion,
        },
        // The outputs belong to the RECORD and its funding, not to the
        // account's recurring plan. A credit-funded completion earns its
        // report even though the account is on FREE — and (ET-COM-04) a
        // lapsed plan earns none: the decision above read the lifecycle.
        shouldEnqueueReport: finalizationIssuance.reportsIncluded,
        retentionTargets,
      };
    },
    {
      maxWait: 10_000,
      timeout: 120_000,
    }
  );

  if (final.retentionTargets.length > 0) {
    const retentionResult = await applyRetentionOrThrow(final.retentionTargets);

    const primaryTarget = final.retentionTargets[0];

    if (primaryTarget) {
      try {
        const lockedMeta = await headObject({
          bucket: primaryTarget.bucket,
          key: primaryTarget.key,
          versionId: primaryTarget.versionId ?? null,
        });

        await prisma.evidence.update({
          where: { id: final.result.id },
          data: {
            storageRegion: process.env.S3_REGION?.trim() || null,
            storageObjectLockMode: lockedMeta.objectLockMode
              ? String(lockedMeta.objectLockMode)
              : null,
            storageObjectLockRetainUntilUtc:
              lockedMeta.objectLockRetainUntilDate ?? null,
            storageObjectLockLegalHoldStatus:
              lockedMeta.objectLockLegalHoldStatus
                ? String(lockedMeta.objectLockLegalHoldStatus)
                : null,
          },
        });

        for (const target of final.retentionTargets) {
          if (!target.evidencePartId) continue;

          try {
            const partMeta = await headObject({
              bucket: target.bucket,
              key: target.key,
              versionId: target.versionId ?? null,
            });

            await prisma.evidencePart.update({
              where: { id: target.evidencePartId },
              data: {
                storageRegion: process.env.S3_REGION?.trim() || null,
                storageObjectLockMode: partMeta.objectLockMode
                  ? String(partMeta.objectLockMode)
                  : null,
                storageObjectLockRetainUntilUtc:
                  partMeta.objectLockRetainUntilDate ?? null,
                storageObjectLockLegalHoldStatus:
                  partMeta.objectLockLegalHoldStatus
                    ? String(partMeta.objectLockLegalHoldStatus)
                    : null,
              },
            });
          } catch {
            // ignore per-part snapshot failures
          }
        }

        // A repeat complete that repaired retention appends nothing if the
        // record already carries its lock outcome (2026-09-29, audit D11).
        const recordedOutcome = async (
          type: prismaPkg.CustodyEventType,
        ): Promise<boolean> =>
          final.alreadyFinalized === true &&
          (await prisma.custodyEvent.count({
            where: { evidenceId: final.result.id, eventType: type },
          })) > 0;

        // Decide truthfully whether to append EVIDENCE_LOCKED.
        //
        // We require ALL of the following to be true:
        //   1. applyRetentionOrThrow reported at least one target had retention
        //      actually applied (i.e. Object Lock enabled in the environment
        //      AND a PutObjectRetention call succeeded).
        //   2. headObject() reports a non-null objectLockMode on the object.
        //   3. headObject() reports a future objectLockRetainUntilDate.
        //
        // If any of these fail, we append the truthful STORAGE_PROTECTION_UNAVAILABLE
        // event instead of the misleading EVIDENCE_LOCKED. The verify page
        // already correctly downgrades the badge in this case; the chain must
        // not contradict the badge.
        const lockMode = lockedMeta.objectLockMode
          ? String(lockedMeta.objectLockMode)
          : null;
        const retainUntil = lockedMeta.objectLockRetainUntilDate ?? null;
        const retentionInForce =
          retainUntil instanceof Date && retainUntil.getTime() > Date.now();

        const lockTrulyApplied =
          retentionResult.anyApplied === true &&
          (lockMode === "COMPLIANCE" || lockMode === "GOVERNANCE") &&
          retentionInForce;

        if (lockTrulyApplied && !(await recordedOutcome(prismaPkg.CustodyEventType.EVIDENCE_LOCKED))) {
          await appendCustodyEvent({
            evidenceId: final.result.id,
            eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED,
            atUtc: new Date(),
            payload: {
              storageRegion: process.env.S3_REGION?.trim() || null,
              storageObjectLockMode: lockMode,
              storageObjectLockRetainUntilUtc:
                retainUntil?.toISOString() ?? null,
              storageObjectLockLegalHoldStatus:
                lockedMeta.objectLockLegalHoldStatus
                  ? String(lockedMeta.objectLockLegalHoldStatus)
                  : null,
              itemCount: final.retentionTargets.length,
              retentionApplied: true,
            } as prismaPkg.Prisma.InputJsonValue,
          });
        } else if (
          !lockTrulyApplied &&
          !(await recordedOutcome(prismaPkg.CustodyEventType.STORAGE_PROTECTION_UNAVAILABLE)) &&
          !(await recordedOutcome(prismaPkg.CustodyEventType.EVIDENCE_LOCKED))
        ) {
          await appendCustodyEvent({
            evidenceId: final.result.id,
            eventType:
              prismaPkg.CustodyEventType.STORAGE_PROTECTION_UNAVAILABLE,
            atUtc: new Date(),
            payload: {
              phase: "storage_protection_unavailable",
              storageRegion: process.env.S3_REGION?.trim() || null,
              storageObjectLockMode: lockMode,
              storageObjectLockRetainUntilUtc:
                retainUntil?.toISOString() ?? null,
              storageObjectLockLegalHoldStatus:
                lockedMeta.objectLockLegalHoldStatus
                  ? String(lockedMeta.objectLockLegalHoldStatus)
                  : null,
              itemCount: final.retentionTargets.length,
              retentionApplied: false,
              reason:
                retentionResult.reason ??
                (retentionResult.anyApplied
                  ? "object_metadata_does_not_confirm_lock"
                  : "object_lock_disabled"),
            } as prismaPkg.Prisma.InputJsonValue,
          });
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "OBJECT_LOCK_SNAPSHOT_FAILED";

        throw new Error(
          `EVIDENCE_OBJECT_LOCK_SNAPSHOT_FAILED:${final.result.id}:${reason}`
        );
      }
    }
  }

  /*
   * ==========================================================================
   * OTS — THE INTEGRITY LIFECYCLE, ENTERED BY EVERY FINALIZED RECORD.
   * ==========================================================================
   * This is the trigger that did not exist. OpenTimestamps was stamped inside
   * the report job, so a record reached the calendar only if its plan included
   * reports — and Pricing lists OpenTimestamps under "Every plan includes",
   * beside hashing, RFC 3161 timestamps, signatures and custody. A Free record
   * was promised an anchor by a page and denied one by a pipeline it had no
   * business being routed through.
   *
   * NOTE WHAT THIS BLOCK DOES NOT CONSULT. Not the plan, not the entitlement,
   * not `final.shouldEnqueueReport` a few lines below, not the credit ledger,
   * not the record's funding. Integrity is not sold. The commercial question
   * is asked once, immediately after this, and it decides Report and
   * Verification Package — nothing else.
   *
   * IT RUNS AFTER THE COMMIT, like the report request beneath it and for the
   * same reason: the calendar is an external network call, and a signature
   * must never be rolled back because a timestamp server was briefly
   * unreachable. The request authority derives the job id from the evidence id
   * (`ots-upgrade-<id>`), so the id is itself the dedupe — a duplicate finalize
   * collapses onto the live job instead of stamping twice.
   *
   * IT GOES THROUGH THE AUTHORITY, not the queue. `requestEvidenceOtsAnchoring`
   * is the ONE API-side producer for this work name; enqueueing directly from
   * here made a second one, and the registry's central claim — one producer per
   * work name — is what stops two callers drifting apart on the semantics.
   *
   * A FAILURE HERE IS NOT A COMPLETION FAILURE. The authority never throws. The
   * record is finalized, signed and durable; it simply has no anchor yet, which
   * is the truth and is exactly the state the anchoring budget and the
   * reconciliation path are built to carry forward.
   */
  await requestEvidenceOtsAnchoring({
    evidenceId: final.result.id,
    trigger: "evidence.completed",
  });

  if (final.shouldEnqueueReport) {
    // PHASE 12 — POINT 5. The completion path persists a durable generation
    // request and enqueues its id. It runs OUTSIDE any transaction on purpose:
    // a rolled-back request must never be able to produce a runnable job.
    await requestReportGeneration({
      evidenceId: final.result.id,
      purpose: "evidence_completed",
      // The completion fan-out is machine-initiated: it runs after signing
      // succeeds, not on behalf of a specific actor's click. Recording that
      // honestly beats attributing the request to whoever happened to upload.
      requestedByMachineId: "api.evidence-complete",
    });
  }

  // Phase 12 — operations-side session reached its terminal good state.
  safeTransitionUploadSession({
    evidenceId: final.result.id,
    to: "COMPLETED",
  }).catch(() => null);

  // ET-ACQ-03 — the one-time completion fan-out runs EXACTLY ONCE per record,
  // on whichever finalize reaches it first. (2026-09-29, audit D11) stopped a
  // duplicate complete from repeating it by returning here on
  // alreadyFinalized — which also meant a first finalize that failed after
  // its commit (the retention / lock-snapshot step above, a crash) never got
  // its webhook, scan or fan-out: the retry took this early return. OTS and
  // the report request above are idempotent and double as recovery; the
  // fan-out is now claimed durably, so the retry runs it and a duplicate
  // does not.
  await runCompletionFanoutOnce({
    evidenceId: final.result.id,
    signingKeyVersion: final.result.signingKeyVersion ?? null,
    requestContext: params.requestContext ?? null,
  });

  return final.result;
}

/** A claim older than this is presumed crashed and may be re-driven. */
const COMPLETION_FANOUT_LEASE_MS = 10 * 60_000;

/**
 * ET-ACQ-03 — THE completion fan-out, once per record: the evidence.completed
 * webhook, the malware scan and the finalization fan-out.
 *
 * Claimed with one conditional write (not done, finalized, unclaimed or its
 * lease lapsed), so concurrent finalizes run it once and a crashed claim is
 * re-driven by the next finalize after the lease. Marked done when it has
 * run. Each step stays best-effort, as before: it never fails completion.
 * Records signed before the marker existed are backfilled done
 * (migration 20280812000001).
 */
export async function runCompletionFanoutOnce(input: {
  evidenceId: string;
  signingKeyVersion: number | null;
  requestContext?: { ip?: string | null; userAgent?: string | null; correlationId?: string | null } | null;
}): Promise<{ ran: boolean }> {
  const claimedAt = new Date();
  const claim = await prisma.evidence.updateMany({
    where: {
      id: input.evidenceId,
      completionFanoutDoneAtUtc: null,
      status: { in: [EvidenceStatus.SIGNED, EvidenceStatus.REPORTED] },
      OR: [
        { completionFanoutClaimedAtUtc: null },
        { completionFanoutClaimedAtUtc: { lt: new Date(claimedAt.getTime() - COMPLETION_FANOUT_LEASE_MS) } },
      ],
    },
    data: { completionFanoutClaimedAtUtc: claimedAt },
  });
  if (claim.count === 0) return { ran: false };
  const final = { result: { id: input.evidenceId, signingKeyVersion: input.signingKeyVersion } };

  // UC-ARCH-003 — the channel-independent completion effects that used to live
  // only in the web /complete route: the reviewer-queue workflow row and the
  // evidence.complete tenant audit. Here they run once per record for web,
  // direct capture (mobile / extension / screen) and intake alike.
  await initializeCompletionReviewAndAudit(input.evidenceId, input.requestContext ?? null);

  // Phase 10 — fire `evidence.completed` to any subscribed webhook
  // endpoints in this workspace. The dispatcher is feature-flag gated
  // and swallows its own errors so failures here never break the
  // completion path.
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: final.result.id },
      select: {
        id: true,
        teamId: true,
        type: true,
        status: true,
        verificationStatus: true,
        fileSha256: true,
        mimeType: true,
        sizeBytes: true,
        signedAtUtc: true,
        capturedAtUtc: true,
      },
    });
    if (ev && ev.teamId) {
      await emitWebhookEvent({
        teamId: ev.teamId,
        eventType: "evidence.completed",
        payload: {
          evidenceId: ev.id,
          type: ev.type,
          status: ev.status,
          verificationStatus: ev.verificationStatus,
          fileSha256: ev.fileSha256,
          mimeType: ev.mimeType,
          sizeBytes: ev.sizeBytes ? ev.sizeBytes.toString() : null,
          signedAtUtc: ev.signedAtUtc?.toISOString() ?? null,
          capturedAtUtc: ev.capturedAtUtc?.toISOString() ?? null,
        },
        attemptInline: true,
      });
    }
  } catch {
    // Webhook emission is best-effort; never fail completion on it.
  }

  // Phase 11 — enqueue a file security scan row for this evidence and
  // run the active scanner. NEVER blocks completion; scanner failures
  // are recorded as FAILED / SKIPPED rows, not exceptions. Feature flag
  // controls whether any row is written at all.
  if (isMalwareScanningEnabled()) {
    try {
      const ev = await prisma.evidence.findUnique({
        where: { id: final.result.id },
        select: { id: true, teamId: true },
      });
      if (ev) {
        await enqueueScan({ evidenceId: ev.id, teamId: ev.teamId! });
        // Fire-and-forget runScan; the scanner is responsible for its
        // own timeouts. Completion returns immediately either way.
        runScan({ evidenceId: ev.id, teamId: ev.teamId! }).catch(() => null);
      }
    } catch (err) {
      // Never fail completion on scan enqueue — scanner is best-effort.
      logWarn("evidence_complete.scan_enqueue_failed", {
        err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        evidenceId: final.result.id,
      });
    }
  }

  // Post-finalize fan-out: helper NEVER throws. The contract is
  // "never fail completion on post-finalize fan-out failure" — every
  // failure path is logged (bounded warn via utils/logger.warn).
  await runEvidenceCompletePostFinalize({
    evidenceId: final.result.id,
    signingKeyVersion: final.result.signingKeyVersion ?? null,
  });

  // Done — only for the claim this call holds (a lapsed claim re-driven by
  // another finalize owns the marker from then on).
  await prisma.evidence.updateMany({
    where: { id: input.evidenceId, completionFanoutClaimedAtUtc: claimedAt },
    data: { completionFanoutDoneAtUtc: new Date() },
  });
  return { ran: true };
}

/**
 * UC-ARCH-003 — the reviewer workflow (NOT_STARTED, so the record enters the
 * reviewer queue on completion) and the evidence.complete tenant audit.
 * Best-effort like every fan-out step: a failure is logged, never thrown.
 */
async function initializeCompletionReviewAndAudit(
  evidenceId: string,
  requestContext: { ip?: string | null; userAgent?: string | null; correlationId?: string | null } | null,
): Promise<void> {
  const ev = await prisma.evidence
    .findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        teamId: true,
        ownerUserId: true,
        status: true,
        verificationStatus: true,
        acquisitionMode: true,
        templateSlug: true,
        templateVersion: true,
        templateDbId: true,
      },
    })
    .catch(() => null);
  if (!ev) return;
  const viaIntake = ev.acquisitionMode === "SECURE_INTAKE_LINK";
  try {
    const { upsertEvidenceReviewerWorkflow } = await import(
      "./evidence-review/reviewer-workflow.service.js"
    );
    await upsertEvidenceReviewerWorkflow({
      evidenceId: ev.id,
      workspaceType: ev.teamId ? "TEAM" : "PERSONAL",
      teamId: ev.teamId,
      actorUserId: ev.ownerUserId,
      status: prismaPkg.EvidenceReviewWorkflowStatus.NOT_STARTED,
      priority: prismaPkg.EvidenceReviewWorkflowPriority.NORMAL,
      note: "Created automatically on Capture finalization.",
      templateIdentity: {
        templateSlug: ev.templateSlug ?? null,
        templateVersion: ev.templateVersion ?? null,
        templateDbId: ev.templateDbId ?? null,
      },
      templateIdentitySource: "capture",
    });
  } catch (err) {
    logWarn("evidence_complete.workflow_init_failed", {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      evidenceId,
    });
  }
  try {
    const { emitTenantAudit } = await import("./audit/tenant-audit.service.js");
    await emitTenantAudit({
      action: "evidence.complete",
      outcome: "success",
      sourceApp: "API",
      // The external contributor of an intake record has no user account.
      actorUserId: viaIntake ? null : ev.ownerUserId,
      workspaceId: ev.teamId ?? null,
      resourceType: "evidence",
      resourceId: ev.id,
      correlationId: requestContext?.correlationId ?? null,
      ipAddress: requestContext?.ip ?? null,
      userAgent: requestContext?.userAgent ?? null,
      metadata: {
        status: ev.status,
        verificationStatus: ev.verificationStatus,
        acquisitionMode: ev.acquisitionMode ?? null,
        result: "completed",
        severity: "info",
      },
    });
  } catch (err) {
    logWarn("evidence_complete.audit_failed", {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      evidenceId,
    });
  }
}

/**
 * Post-finalize fan-out. NEVER throws — every failure path emits a
 * bounded warn via utils/logger.warn. Exported for direct testing.
 * Codes: evidence_complete.fanout_failed,
 * evidence_complete.graph_reconcile_not_queued (queue's bounded shape),
 * evidence_complete.graph_reconcile_enqueue_failed (enqueue threw).
 */
export async function runEvidenceCompletePostFinalize(input: {
  evidenceId: string;
  signingKeyVersion: number | null;
}): Promise<void> {
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { id: true, teamId: true },
    });
    if (!ev || !ev.teamId) return;

    await runEvidenceFinalizationFanout(
      {
        teamId: ev.teamId,
        evidenceId: ev.id,
        reason: "evidence_completed",
        signatureVersion: input.signingKeyVersion,
      },
      completeFanoutLogger,
    );

    // Observe the bounded { queued:false } shape the fanout's logger
    // never fires on. Same jobId dedupes against the fanout enqueue.
    try {
      const enq = await enqueueGraphReconcileJob({
        teamId: ev.teamId,
        reason: "evidence_completed",
        evidenceId: ev.id,
      });
      if (!enq.queued) {
        logWarn("evidence_complete.graph_reconcile_not_queued", {
          evidenceId: ev.id,
          teamId: ev.teamId,
          reason: enq.reason ?? null,
          jobId: enq.jobId ?? null,
        });
      }
    } catch (enqErr) {
      logWarn("evidence_complete.graph_reconcile_enqueue_failed", {
        err: enqErr instanceof Error ? enqErr.message.slice(0, 200) : String(enqErr).slice(0, 200),
        evidenceId: ev.id,
        teamId: ev.teamId,
      });
    }
  } catch (err) {
    logWarn("evidence_complete.fanout_failed", {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      evidenceId: input.evidenceId,
    });
  }
}
