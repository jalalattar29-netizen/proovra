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
 * Recovery semantics:
 *   - We NEVER delete an evidence row, mutate fileSha256 / fingerprint,
 *     or fabricate completion metadata.
 *   - We NEVER auto-mark COMPLETED. The forensic chain owns that
 *     transition.
 *   - When an evidence row is in an unambiguous bad shape (e.g. DB
 *     SIGNED but object missing) we move the UploadSession to
 *     REVIEW_REQUIRED and emit a HIGH-severity security/reliability
 *     event so a human can decide.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { headObject } from "../../storage.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { getStaleThresholds } from "./upload-limits.service.js";
import { safeTransitionUploadSession, } from "./upload-session.service.js";
const NON_TERMINAL_NON_STALLED = [
    "CREATED",
    "PRESIGNED",
    "UPLOADING",
    "PARTIAL",
    "VERIFYING",
];
const STALLED_OR_INACTIVE = [
    "STALLED",
    "PRESIGNED",
    "UPLOADING",
    "PARTIAL",
    "REVIEW_REQUIRED",
];
/**
 * Single entry point — used by the cron route. Calls the three
 * reconciliation phases in order. Bounded by `batchSize` per phase so
 * a single run cannot consume the whole worker thread.
 */
export async function reconcileUploads(input = {}, client = defaultPrisma) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
    const { stalledMinutes, abandonedHours } = getStaleThresholds();
    const stalledCutoff = new Date(Date.now() - stalledMinutes * 60 * 1000);
    const abandonedCutoff = new Date(Date.now() - abandonedHours * 3600 * 1000);
    const stalledRows = await client.uploadSession.findMany({
        where: {
            status: { in: NON_TERMINAL_NON_STALLED },
            lastActivityAtUtc: { lt: stalledCutoff },
        },
        select: { evidenceId: true, teamId: true, status: true },
        take: batchSize,
    });
    let markedStalled = 0;
    for (const row of stalledRows) {
        const out = await safeTransitionUploadSession({
            evidenceId: row.evidenceId,
            to: "STALLED",
            reason: `stalled_for_${stalledMinutes}m`,
        }, client);
        if (out && out.status === "STALLED") {
            markedStalled += 1;
            safeEmitSecurityEvent({
                teamId: row.teamId,
                eventType: "upload_stalled",
                severity: "WARNING",
                evidenceId: row.evidenceId,
                details: {
                    stalledThresholdMinutes: stalledMinutes,
                    previousStatus: row.status,
                },
            }, client);
        }
    }
    // Second pass — abandoned. Rows already terminal (COMPLETED / FAILED /
    // ABANDONED) are excluded by the WHERE.
    const abandonedRows = await client.uploadSession.findMany({
        where: {
            status: { in: STALLED_OR_INACTIVE },
            lastActivityAtUtc: { lt: abandonedCutoff },
        },
        select: { evidenceId: true, teamId: true, status: true },
        take: batchSize,
    });
    let markedAbandoned = 0;
    for (const row of abandonedRows) {
        const out = await safeTransitionUploadSession({
            evidenceId: row.evidenceId,
            to: "ABANDONED",
            reason: `abandoned_after_${abandonedHours}h`,
        }, client);
        if (out && out.status === "ABANDONED") {
            markedAbandoned += 1;
            safeEmitSecurityEvent({
                teamId: row.teamId,
                eventType: "upload_abandoned",
                severity: "INFO",
                evidenceId: row.evidenceId,
                details: {
                    abandonedThresholdHours: abandonedHours,
                    previousStatus: row.status,
                },
            }, client);
        }
    }
    // Third pass — DB says SIGNED, object missing. Defensive against
    // orphaned storage / partial deletes. Reads only; for any unambiguous
    // mismatch we move the session to REVIEW_REQUIRED and emit HIGH.
    const flaggedReviewRequired = await flagDbCompleteObjectMissing({ batchSize }, client);
    safeEmitSecurityEvent({
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
        },
    }, client);
    return {
        stalledThresholdMinutes: stalledMinutes,
        abandonedThresholdHours: abandonedHours,
        scanned: stalledRows.length + abandonedRows.length,
        markedStalled,
        markedAbandoned,
        flaggedReviewRequired,
    };
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
export async function flagDbCompleteObjectMissing(input = {}, client = defaultPrisma) {
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
        if (!bucket || !key)
            continue;
        let exists = false;
        try {
            await headObject({ bucket, key });
            exists = true;
        }
        catch {
            exists = false;
        }
        if (!exists) {
            const out = await safeTransitionUploadSession({
                evidenceId: row.evidenceId,
                to: "REVIEW_REQUIRED",
                reason: "completed_object_missing",
            }, client);
            if (out && out.status === "REVIEW_REQUIRED") {
                flagged += 1;
                safeEmitSecurityEvent({
                    teamId: row.teamId,
                    eventType: "recovery_review_required",
                    severity: "HIGH",
                    evidenceId: row.evidenceId,
                    details: {
                        reason: "completed_object_missing",
                    },
                }, client);
            }
        }
    }
    return flagged;
}
export async function operatorMarkAbandoned(input, client = defaultPrisma) {
    const row = await safeTransitionUploadSession({
        evidenceId: input.evidenceId,
        to: "ABANDONED",
        reason: `marked_abandoned_by_user:${input.actorUserId}`,
    }, client);
    if (row && row.status === "ABANDONED") {
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "upload_abandoned",
            severity: "INFO",
            evidenceId: input.evidenceId,
            details: { actorUserId: input.actorUserId, manual: true },
        }, client);
    }
    return row;
}
export async function operatorRequestReview(input, client = defaultPrisma) {
    const row = await safeTransitionUploadSession({
        evidenceId: input.evidenceId,
        to: "REVIEW_REQUIRED",
        reason: `manual_review_request:${input.actorUserId}`,
    }, client);
    if (row && row.status === "REVIEW_REQUIRED") {
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "recovery_review_required",
            severity: "WARNING",
            evidenceId: input.evidenceId,
            details: { actorUserId: input.actorUserId, manual: true },
        }, client);
    }
    return row;
}
