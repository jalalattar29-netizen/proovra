/**
 * Phase A0 — Integrity hard-gate rejection helper.
 *
 * Single responsibility: when the worker recomputes the SHA-256 of an
 * evidence object and finds it disagrees with the value persisted at
 * completion (`Evidence.fileSha256`), call this helper BEFORE throwing
 * `EVIDENCE_FILE_SHA256_MISMATCH`. It performs the four mandatory
 * side-effects in one atomic transaction so a partial failure cannot
 * leave the record half-quarantined:
 *
 *   1. Set `Evidence.status = FAILED_HASH_MISMATCH` (terminal). The
 *      `updateMany` is gated on a precondition (status IN
 *      (SIGNED, REPORTED)) so a concurrent benign transition (e.g.
 *      destruction orchestrator) cannot silently win and re-promote
 *      the row. If the precondition does not match, the helper
 *      surfaces `precondition_lost` and the caller still re-throws —
 *      no downstream effect is started.
 *   2. Set `Evidence.verificationStatus = FAILED`.
 *   3. Append a hash-linked `CustodyEvent` of type
 *      `INTEGRITY_REJECTED_HASH_MISMATCH` with a bounded payload
 *      that carries the expected + computed digests plus the source
 *      label so reviewers can correlate to the worker job. The
 *      custody chain links this rejection to the prior event the
 *      same way every other event does — no chain break.
 *   4. Insert a `SecurityEvent` of type `evidence_integrity_rejected`
 *      (severity HIGH). Truncated hash previews only (first/last 8
 *      hex chars); the full digests live on the custody payload +
 *      structured log so SIEM exporters do not duplicate them.
 *
 * The helper writes ONE structured log line `evidence.integrity.rejected`
 * with bounded fields the operator can grep, and one metric bump
 * `evidence_integrity_rejections_total` tagged with the source.
 *
 * Wording: this module never claims tampering, fakery, authorship, or
 * legal status. It records that a server-recomputed digest disagrees
 * with the digest recorded at completion. Vocabulary discipline is
 * enforced — the rejection reason set is bounded.
 */

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { appendCustodyEventTx } from "./custody-events.js";
import * as prismaPkg from "@prisma/client";

async function bumpIntegrityRejection(): Promise<void> {
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    // Literal string preserves the bounded `CounterName` union.
    mod.bump("evidence_integrity_rejections_total");
  } catch {
    // metrics are best-effort; never block the caller.
  }
}

const HEX_PREVIEW_LEN = 8;

function hexPreview(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "(none)";
  const hex = value.toLowerCase();
  if (hex.length <= HEX_PREVIEW_LEN * 2) return hex;
  return `${hex.slice(0, HEX_PREVIEW_LEN)}…${hex.slice(-HEX_PREVIEW_LEN)}`;
}

export type IntegrityRejectionSource =
  | "worker.report.single_file"
  | "worker.report.multipart"
  | "worker.reconciler"
  | "api.completion";

export type IntegrityRejectionResult = {
  applied: boolean;
  reason:
    | "rejected"
    | "already_rejected"
    | "evidence_not_found"
    | "precondition_lost";
  evidenceId: string;
};

/**
 * Apply the integrity rejection. Idempotent: if the row is already
 * `FAILED_HASH_MISMATCH`, this returns `already_rejected` without
 * writing a duplicate custody/security event. Callers should still
 * re-throw their original mismatch error so BullMQ moves the job to
 * the DLQ.
 */
export async function rejectEvidenceIntegrity(params: {
  evidenceId: string;
  expectedSha256: string | null;
  computedSha256: string;
  source: IntegrityRejectionSource;
  jobId?: string | number | null;
  attempt?: number | null;
}): Promise<IntegrityRejectionResult> {
  const detectedAtUtc = new Date();

  // First read outside the transaction — fast path for the idempotent
  // already-rejected case so we do not open a transaction just to
  // discover the row is already terminal.
  const existing = await prisma.evidence.findFirst({
    where: { id: params.evidenceId, deletedAt: null },
    select: { id: true, status: true, teamId: true, fileSha256: true },
  });

  if (!existing) {
    logger.warn(
      {
        evidenceId: params.evidenceId,
        source: params.source,
        expectedShaPreview: hexPreview(params.expectedSha256),
        computedShaPreview: hexPreview(params.computedSha256),
      },
      "evidence.integrity.rejection_skipped_not_found",
    );
    return {
      applied: false,
      reason: "evidence_not_found",
      evidenceId: params.evidenceId,
    };
  }

  if (existing.status === prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH) {
    logger.info(
      {
        evidenceId: params.evidenceId,
        source: params.source,
        expectedShaPreview: hexPreview(params.expectedSha256),
        computedShaPreview: hexPreview(params.computedSha256),
      },
      "evidence.integrity.rejection_idempotent",
    );
    return {
      applied: false,
      reason: "already_rejected",
      evidenceId: params.evidenceId,
    };
  }

  // Atomic write path. The advisory xact lock + appendCustodyEventTx +
  // status update all live in one transaction so:
  //   - the custody event and the status flip cannot diverge;
  //   - a concurrent benign mutation (e.g. retention update) cannot
  //     race past us;
  //   - if any step throws, the row stays in its prior state and the
  //     caller still throws EVIDENCE_FILE_SHA256_MISMATCH so the job
  //     goes to the DLQ for operator intervention.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
    `;

    const claim = await tx.evidence.updateMany({
      where: {
        id: params.evidenceId,
        deletedAt: null,
        status: {
          in: [
            prismaPkg.EvidenceStatus.SIGNED,
            prismaPkg.EvidenceStatus.REPORTED,
          ],
        },
      },
      data: {
        status: prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH,
        verificationStatus: prismaPkg.VerificationStatus.FAILED,
      },
    });

    if (claim.count !== 1) {
      return { transitioned: false as const };
    }

    await appendCustodyEventTx(tx, {
      evidenceId: params.evidenceId,
      eventType: prismaPkg.CustodyEventType.INTEGRITY_REJECTED_HASH_MISMATCH,
      atUtc: detectedAtUtc,
      payload: {
        expectedSha256: params.expectedSha256 ?? null,
        computedSha256: params.computedSha256,
        source: params.source,
        detectedAtUtc: detectedAtUtc.toISOString(),
      },
    });

    // SecurityEvent insert is best-effort by contract (never blocks
    // the rejection write), but it lives in the same transaction so
    // operators see them appear together. A failure here will roll
    // back the status flip and the caller will still throw — the row
    // will simply be retried on the next worker pass, where this
    // helper is idempotent.
    // SecurityEvent does NOT carry a structural evidenceId column;
    // we record it inside `details` so operators can correlate by
    // grepping the metadata. The custody event (above) is the
    // structural per-evidence record.
    await tx.securityEvent.create({
      data: {
        teamId: existing.teamId ?? null,
        eventType: "evidence_integrity_rejected",
        severity: "HIGH",
        details: {
          evidenceId: params.evidenceId,
          source: params.source,
          expectedShaPreview: hexPreview(params.expectedSha256),
          computedShaPreview: hexPreview(params.computedSha256),
          jobId: params.jobId ?? null,
          attempt: params.attempt ?? null,
          detectedAtUtc: detectedAtUtc.toISOString(),
        },
      },
    });

    return { transitioned: true as const };
  });

  if (!outcome.transitioned) {
    logger.warn(
      {
        evidenceId: params.evidenceId,
        source: params.source,
        expectedShaPreview: hexPreview(params.expectedSha256),
        computedShaPreview: hexPreview(params.computedSha256),
      },
      "evidence.integrity.rejection_precondition_lost",
    );
    return {
      applied: false,
      reason: "precondition_lost",
      evidenceId: params.evidenceId,
    };
  }

  await bumpIntegrityRejection();

  logger.error(
    {
      evidenceId: params.evidenceId,
      source: params.source,
      teamId: existing.teamId ?? null,
      expectedShaPreview: hexPreview(params.expectedSha256),
      computedShaPreview: hexPreview(params.computedSha256),
      jobId: params.jobId ?? null,
      attempt: params.attempt ?? null,
      detectedAtUtc: detectedAtUtc.toISOString(),
    },
    "evidence.integrity.rejected",
  );

  return {
    applied: true,
    reason: "rejected",
    evidenceId: params.evidenceId,
  };
}
