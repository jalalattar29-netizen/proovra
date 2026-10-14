/**
 * Phase 12 — Upload reconciliation.
 *
 * Sweepers for the operations layer:
 *   1. `markStalledUploads`   — non-terminal sessions whose
 *      `lastActivityAtUtc` is older than the stalled threshold.
 *   2. `markAbandonedUploads` — STALLED / UPLOADING / PARTIAL / PRESIGNED
 *      sessions older than the abandoned threshold.
 *   3. `flagDbCompleteObjectMissing` — Evidence rows in SIGNED whose
 *      storage object is missing (defensive; rare).
 *
 * WHICH SESSIONS QUALIFY (2026-10-14). An upload session is the operations-side
 * shadow of a record's upload, and a shadow can outlive its upload: the record
 * finalizes (or is deleted) while the session's own best-effort transitions are
 * still in flight or were refused. The stalled sweep used to read the session
 * table alone, so the first time it ran in production it reported every such
 * shadow behind a long-SIGNED record as a stalled upload. A session now
 * qualifies only while its RECORD is still in its upload phase (CREATED /
 * UPLOADING / UPLOADED) and not deleted; a shadow whose record already settled
 * is closed to match it (`settleSupersededSessions`) and reported nowhere.
 *
 * A genuine stall is one Operations condition PER UPLOAD
 * (`capture.upload_stalled`, fingerprint `upload_stalled:<evidenceId>`),
 * written once at the transition, and closed by its probe when the upload
 * completes, is resumed or is abandoned, or the record is finalized or deleted.
 *
 * Recovery semantics:
 *   - We NEVER delete an evidence row, mutate fileSha256 / fingerprint,
 *     or fabricate completion metadata.
 *   - We NEVER auto-mark COMPLETED. The forensic chain owns that
 *     transition: a session behind a FINALIZED record is closed only by
 *     `settleCompletedUploadSession`, which re-proves the finalization
 *     (record, workspace, digest, parts, stored bytes) and refuses otherwise.
 *   - When an evidence row is in an unambiguous bad shape (e.g. DB
 *     SIGNED but object missing) we move the UploadSession to
 *     REVIEW_REQUIRED and emit a HIGH-severity security/reliability
 *     event so a human can decide.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { UploadSessionStatus } from "@proovra/shared";

import { recordIncident } from "../observability/incident.service.js";

import { prisma as defaultPrisma } from "../../db.js";
import { headObject } from "../../storage.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { getStaleThresholds } from "./upload-limits.service.js";
import {
  safeTransitionUploadSession,
  settleCompletedUploadSession,
} from "./upload-session.service.js";

const NON_TERMINAL_NON_STALLED: ReadonlyArray<UploadSessionStatus> = [
  "CREATED",
  "PRESIGNED",
  "UPLOADING",
  "PARTIAL",
  "VERIFYING",
];

const STALLED_OR_INACTIVE: ReadonlyArray<UploadSessionStatus> = [
  "STALLED",
  "PRESIGNED",
  "UPLOADING",
  "PARTIAL",
  "REVIEW_REQUIRED",
];

/**
 * The record states in which an upload can still be in progress. A record that
 * is SIGNED / REPORTED (finalized) or FAILED_HASH_MISMATCH (terminal) has no
 * upload left to stall, whatever its session row says.
 */
const UPLOAD_PHASE_EVIDENCE = ["CREATED", "UPLOADING", "UPLOADED"] as const;

/** The qualifying record: present, not deleted, still uploading. */
const LIVE_UPLOAD_RECORD: Prisma.EvidenceWhereInput = {
  deletedAt: null,
  status: { in: [...UPLOAD_PHASE_EVIDENCE] },
};

/**
 * Session states that may sit behind a record which has already settled.
 * REVIEW_REQUIRED is excluded on purpose: it is a deliberate human hold (the
 * object-missing check sets it on SIGNED records), never a shadow to tidy.
 */
const SETTLEABLE: ReadonlyArray<UploadSessionStatus> = [
  "CREATED",
  "PRESIGNED",
  "UPLOADING",
  "PARTIAL",
  "VERIFYING",
  "STALLED",
];

export type ReconcileStalledSummary = {
  stalledThresholdMinutes: number;
  abandonedThresholdHours: number;
  scanned: number;
  markedStalled: number;
  markedAbandoned: number;
  flaggedReviewRequired: number;
  /** Sessions closed to match a record that had already finalized or been deleted. */
  settledSuperseded: number;
};

/**
 * Single entry point — used by the cron route. Calls the three
 * reconciliation phases in order. Bounded by `batchSize` per phase so
 * a single run cannot consume the whole worker thread.
 */
export async function reconcileUploads(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ReconcileStalledSummary> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
  const { stalledMinutes, abandonedHours } = getStaleThresholds();
  const stalledCutoff = new Date(Date.now() - stalledMinutes * 60 * 1000);
  const abandonedCutoff = new Date(
    Date.now() - abandonedHours * 3600 * 1000,
  );

  // Shadows first: a session behind a settled record is closed to match it, so
  // neither pass below can report it.
  const settledSuperseded = await settleSupersededSessions({ batchSize }, client);

  const stalledRows = await client.uploadSession.findMany({
    where: {
      status: { in: NON_TERMINAL_NON_STALLED as never },
      lastActivityAtUtc: { lt: stalledCutoff },
      evidence: LIVE_UPLOAD_RECORD,
    },
    select: {
      evidenceId: true,
      teamId: true,
      status: true,
      evidence: { select: { title: true } },
    },
    take: batchSize,
  });

  let markedStalled = 0;
  for (const row of stalledRows) {
    const out = await safeTransitionUploadSession(
      {
        evidenceId: row.evidenceId,
        to: "STALLED",
        reason: `stalled_for_${stalledMinutes}m`,
      },
      client,
    );
    if (out && out.status === "STALLED") {
      markedStalled += 1;
      await recordUploadStalledCondition(
        {
          teamId: row.teamId,
          evidenceId: row.evidenceId,
          recordTitle: row.evidence?.title ?? null,
          minutes: stalledMinutes,
          previousStatus: row.status,
          stalledAtUtc: out.stalledAtUtc ?? new Date(),
        },
        client,
      );
      // The security log keeps its audit entry; the bridge does not turn it
      // into a condition (the event type is owned by the dedicated writer).
      safeEmitSecurityEvent(
        {
          teamId: row.teamId,
          eventType: "upload_stalled",
          severity: "WARNING",
          evidenceId: row.evidenceId,
          details: {
            stalledThresholdMinutes: stalledMinutes,
            previousStatus: row.status,
          },
        },
        client,
      );
    }
  }

  // Second pass — abandoned. Rows already terminal (COMPLETED / FAILED /
  // ABANDONED) are excluded by the WHERE.
  const abandonedRows = await client.uploadSession.findMany({
    where: {
      status: { in: STALLED_OR_INACTIVE as never },
      lastActivityAtUtc: { lt: abandonedCutoff },
      evidence: LIVE_UPLOAD_RECORD,
    },
    select: { evidenceId: true, teamId: true, status: true },
    take: batchSize,
  });

  let markedAbandoned = 0;
  for (const row of abandonedRows) {
    const out = await safeTransitionUploadSession(
      {
        evidenceId: row.evidenceId,
        to: "ABANDONED",
        reason: `abandoned_after_${abandonedHours}h`,
      },
      client,
    );
    if (out && out.status === "ABANDONED") {
      markedAbandoned += 1;
      safeEmitSecurityEvent(
        {
          teamId: row.teamId,
          eventType: "upload_abandoned",
          severity: "INFO",
          evidenceId: row.evidenceId,
          details: {
            abandonedThresholdHours: abandonedHours,
            previousStatus: row.status,
          },
        },
        client,
      );
    }
  }

  // Third pass — DB says SIGNED, object missing. Defensive against
  // orphaned storage / partial deletes. Reads only; for any unambiguous
  // mismatch we move the session to REVIEW_REQUIRED and emit HIGH.
  const flaggedReviewRequired = await flagDbCompleteObjectMissing(
    { batchSize },
    client,
  );

  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "reconciliation_triggered",
      severity: "INFO",
      details: {
        stalledThresholdMinutes: stalledMinutes,
        abandonedThresholdHours: abandonedHours,
        batchSize,
        markedStalled,
        markedAbandoned,
        flaggedReviewRequired,
        settledSuperseded,
      },
    },
    client,
  );

  return {
    stalledThresholdMinutes: stalledMinutes,
    abandonedThresholdHours: abandonedHours,
    scanned: stalledRows.length + abandonedRows.length,
    markedStalled,
    markedAbandoned,
    flaggedReviewRequired,
    settledSuperseded,
  };
}

/**
 * Close the session shadow of a record that has already SETTLED.
 *
 * A finalized record (SIGNED / REPORTED) completed its upload: its session is
 * COMPLETED. A deleted record, or one that failed its integrity check, has no
 * upload left: its session is ABANDONED. Neither is an event — the record's own
 * history already says what happened — so nothing is emitted and no condition
 * is written. Bounded per call; the next sweep continues.
 */
export async function settleSupersededSessions(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
  const rows = await client.uploadSession.findMany({
    where: {
      status: { in: SETTLEABLE as never },
      OR: [
        { evidence: { status: { in: ["SIGNED", "REPORTED"] } } },
        { evidence: { status: "FAILED_HASH_MISMATCH" } },
        { evidence: { deletedAt: { not: null } } },
      ],
    },
    select: { evidenceId: true, evidence: { select: { status: true, deletedAt: true } } },
    orderBy: { evidenceId: "asc" },
    take: batchSize,
  });
  let settled = 0;
  for (const row of rows) {
    const finalized =
      row.evidence.deletedAt == null &&
      (row.evidence.status === "SIGNED" || row.evidence.status === "REPORTED");
    if (finalized) {
      // The ONE guarded completion: it proves the upload completed from the
      // record itself (and refuses, writing nothing, when it cannot).
      const out = await settleCompletedUploadSession(row.evidenceId, client);
      if (out.outcome === "COMPLETED") settled += 1;
      continue;
    }
    const out = await safeTransitionUploadSession(
      {
        evidenceId: row.evidenceId,
        to: "ABANDONED",
        reason: row.evidence.deletedAt != null ? "record_deleted" : "record_integrity_failed",
      },
      client,
    );
    if (out && out.status === "ABANDONED") settled += 1;
  }
  return settled;
}

/**
 * The ONE stalled-upload condition, per upload, through the canonical writer.
 *
 * Written at the STALLED transition only — a repeated sweep never selects the
 * session again (STALLED is excluded from the qualifying set), so the same
 * occurrence is never counted twice. If the upload resumes and stalls again,
 * that later stall is a new occurrence of the same subject: a resolved row
 * reopens once. The probe (`upload.session_stalled`) closes it when the upload
 * completes, is resumed or abandoned, or the record is finalized or deleted.
 */
export async function recordUploadStalledCondition(
  input: {
    teamId: string;
    evidenceId: string;
    recordTitle: string | null;
    minutes: number;
    previousStatus: string;
    stalledAtUtc: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    const title = input.recordTitle?.trim();
    await recordIncident(
      {
        sourceId: "capture.upload_stalled",
        teamId: input.teamId,
        category: "UPLOAD",
        severity: "WARNING",
        fingerprint: `upload_stalled:${input.evidenceId}`,
        message: {
          code: "ops.capture.upload_stalled",
          params: {
            recordTitle: title ? title.slice(0, 80) : null,
            recordRef: input.evidenceId.slice(0, 8),
            minutes: input.minutes,
          },
        },
        relatedEvidenceId: input.evidenceId,
        runbookSlug: "stuck-upload",
        metadata: {
          signalCode: "upload_stalled",
          previousStatus: input.previousStatus,
          stalledAtUtc: input.stalledAtUtc.toISOString(),
          stalledThresholdMinutes: input.minutes,
        },
      },
      client,
    );
  } catch {
    // Best-effort: the session transition and the security log are the truth;
    // a failed condition write is retried by nothing and reported by the
    // writer's own counters.
  }
}

/**
 * Look for sessions whose evidence row reports SIGNED but the storage
 * head request fails. Conservative: only checks rows that still have a
 * UploadSession in COMPLETED state (so we don't flag in-flight
 * uploads) AND were completed in the last 30 days (so we don't re-scan
 * historical evidence repeatedly).
 *
 * Findings move the UploadSession to REVIEW_REQUIRED. Evidence row is
 * NOT mutated.
 */
export async function flagDbCompleteObjectMissing(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 200);
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const candidates = await client.uploadSession.findMany({
    where: {
      status: "COMPLETED",
      completedAtUtc: { gte: since },
    },
    select: {
      evidenceId: true,
      teamId: true,
      evidence: {
        select: { id: true, storageBucket: true, storageKey: true },
      },
    },
    orderBy: { completedAtUtc: "asc" },
    take: batchSize,
  });

  let flagged = 0;
  for (const row of candidates) {
    const bucket = row.evidence?.storageBucket;
    const key = row.evidence?.storageKey;
    if (!bucket || !key) continue;
    let exists = false;
    try {
      await headObject({ bucket, key });
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      const out = await safeTransitionUploadSession(
        {
          evidenceId: row.evidenceId,
          to: "REVIEW_REQUIRED",
          reason: "completed_object_missing",
        },
        client,
      );
      if (out && out.status === "REVIEW_REQUIRED") {
        flagged += 1;
        safeEmitSecurityEvent(
          {
            teamId: row.teamId,
            eventType: "recovery_review_required",
            severity: "HIGH",
            evidenceId: row.evidenceId,
            details: {
              reason: "completed_object_missing",
            },
          },
          client,
        );
      }
    }
  }
  return flagged;
}

// -----------------------------------------------------------------------------
// Operator-driven actions — invoked from the reliability UI.
// -----------------------------------------------------------------------------

export type OperatorActionInput = {
  evidenceId: string;
  actorUserId: string;
};

export async function operatorMarkAbandoned(
  input: OperatorActionInput,
  client: PrismaClient = defaultPrisma,
) {
  // `exclusive`: an operator's repeated click, or a colleague's simultaneous
  // one, must be refused rather than re-stamping the row and emitting the
  // event twice. See TransitionInput.exclusive.
  const row = await safeTransitionUploadSession(
    {
      evidenceId: input.evidenceId,
      to: "ABANDONED",
      reason: `marked_abandoned_by_user:${input.actorUserId}`,
      exclusive: true,
    },
    client,
  );
  if (row && row.status === "ABANDONED") {
    safeEmitSecurityEvent(
      {
        teamId: row.teamId,
        eventType: "upload_abandoned",
        severity: "INFO",
        evidenceId: input.evidenceId,
        details: { actorUserId: input.actorUserId, manual: true },
      },
      client,
    );
  }
  return row;
}

export async function operatorRequestReview(
  input: OperatorActionInput,
  client: PrismaClient = defaultPrisma,
) {
  const row = await safeTransitionUploadSession(
    {
      evidenceId: input.evidenceId,
      to: "REVIEW_REQUIRED",
      reason: `manual_review_request:${input.actorUserId}`,
      exclusive: true,
    },
    client,
  );
  if (row && row.status === "REVIEW_REQUIRED") {
    safeEmitSecurityEvent(
      {
        teamId: row.teamId,
        eventType: "recovery_review_required",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: { actorUserId: input.actorUserId, manual: true },
      },
      client,
    );
  }
  return row;
}
