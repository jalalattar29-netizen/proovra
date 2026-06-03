/**
 * Phase 12 — UploadSession service.
 *
 * Wraps the operations-facing lifecycle of an evidence upload. The
 * existing EvidenceStatus enum remains authoritative for forensic /
 * chain decisions; this service maintains an additive row that
 * surfaces multipart bookkeeping + recovery state (STALLED /
 * ABANDONED / REVIEW_REQUIRED) without mutating any evidence column.
 *
 * Every state-changing call:
 *   - validates the transition against the canonical matrix
 *   - bumps `lastActivityAtUtc`
 *   - is best-effort (failures NEVER bubble up to the caller — the
 *     forensic evidence path stays intact even if the session row is
 *     unreachable for a moment)
 */
import { isAllowedUploadSessionTransition, isTerminalUploadSessionStatus, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export class UploadSessionTransitionError extends Error {
    from;
    to;
    constructor(from, to) {
        super(`invalid_transition:${from}->${to}`);
        this.from = from;
        this.to = to;
        this.name = "UploadSessionTransitionError";
    }
}
/**
 * Idempotently create the session row for an evidence record. Safe to
 * call repeatedly — returns the existing row if one is already present.
 * Failure is swallowed and `null` is returned so the upload path is
 * never blocked on the operations-mirror table.
 */
export async function ensureUploadSession(input, client = defaultPrisma) {
    try {
        const existing = await client.uploadSession.findUnique({
            where: { evidenceId: input.evidenceId },
        });
        if (existing)
            return existing;
        return await client.uploadSession.create({
            data: {
                evidenceId: input.evidenceId,
                teamId: input.teamId,
                isMultipart: input.isMultipart ?? false,
                expectedPartCount: input.expectedPartCount ?? null,
                status: "CREATED",
            },
        });
    }
    catch {
        return null;
    }
}
export async function getUploadSessionByEvidence(evidenceId, client = defaultPrisma) {
    try {
        return await client.uploadSession.findUnique({
            where: { evidenceId },
        });
    }
    catch {
        return null;
    }
}
/**
 * Atomic, transition-validated update. Uses `updateMany` with a
 * status-WHERE guard so two concurrent transitions cannot both win.
 *
 * Returns the post-transition row on success, or `null` if the row
 * is missing / the transition is rejected. With `strict: true`, an
 * invalid transition raises `UploadSessionTransitionError`.
 */
export async function transitionUploadSession(input, client = defaultPrisma) {
    let current;
    try {
        current = await client.uploadSession.findUnique({
            where: { evidenceId: input.evidenceId },
        });
    }
    catch {
        return null;
    }
    if (!current)
        return null;
    const from = current.status;
    const to = input.to;
    if (!isAllowedUploadSessionTransition(from, to)) {
        if (input.strict)
            throw new UploadSessionTransitionError(from, to);
        return null;
    }
    const now = new Date();
    const data = {
        status: to,
        lastActivityAtUtc: now,
    };
    if (input.reason !== undefined) {
        data.failureReason = input.reason?.slice(0, 400) ?? null;
    }
    if (typeof input.completedPartCount === "number") {
        data.completedPartCount = Math.max(0, input.completedPartCount);
    }
    if (input.bumpRetry)
        data.retryCount = { increment: 1 };
    if (to === "STALLED")
        data.stalledAtUtc = now;
    if (to === "ABANDONED")
        data.abandonedAtUtc = now;
    if (to === "COMPLETED")
        data.completedAtUtc = now;
    try {
        const claim = await client.uploadSession.updateMany({
            where: { evidenceId: input.evidenceId, status: from },
            data,
        });
        if (claim.count !== 1) {
            // Lost the race — return whatever the canonical state is now.
            return await client.uploadSession.findUnique({
                where: { evidenceId: input.evidenceId },
            });
        }
        return await client.uploadSession.findUnique({
            where: { evidenceId: input.evidenceId },
        });
    }
    catch {
        return null;
    }
}
/** Convenience wrapper — non-strict, swallows errors. */
export async function safeTransitionUploadSession(input, client = defaultPrisma) {
    return transitionUploadSession({ ...input, strict: false }, client).catch(() => null);
}
/**
 * Heartbeat — bump `lastActivityAtUtc` without changing the state.
 * Useful when the client uploads a part: we want to keep the stalled
 * sweeper from picking the row up. Self-noop transition.
 */
export async function recordUploadActivity(evidenceId, client = defaultPrisma) {
    try {
        await client.uploadSession.updateMany({
            where: { evidenceId },
            data: { lastActivityAtUtc: new Date() },
        });
    }
    catch {
        /* never fail upload on heartbeat */
    }
}
// -----------------------------------------------------------------------------
// Read helpers — used by the /operations/reliability UI.
// -----------------------------------------------------------------------------
export async function listUploadSessions(input, client = defaultPrisma) {
    return client.uploadSession.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status
                ? { status: input.status }
                : {}),
        },
        orderBy: { lastActivityAtUtc: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function countUploadSessionsByTeam(input, client = defaultPrisma) {
    const rows = await client.uploadSession.groupBy({
        by: ["status"],
        where: { teamId: input.teamId },
        _count: { _all: true },
    });
    const out = {
        CREATED: 0,
        PRESIGNED: 0,
        UPLOADING: 0,
        PARTIAL: 0,
        VERIFYING: 0,
        COMPLETED: 0,
        FAILED: 0,
        STALLED: 0,
        ABANDONED: 0,
        REVIEW_REQUIRED: 0,
    };
    for (const r of rows) {
        out[r.status] = r._count._all;
    }
    return out;
}
export function projectUploadSession(row) {
    return {
        id: row.id,
        evidenceId: row.evidenceId,
        teamId: row.teamId,
        status: row.status,
        isMultipart: row.isMultipart,
        expectedPartCount: row.expectedPartCount,
        completedPartCount: row.completedPartCount,
        retryCount: row.retryCount,
        failureReason: row.failureReason,
        lastActivityAtUtc: row.lastActivityAtUtc.toISOString(),
        stalledAtUtc: row.stalledAtUtc?.toISOString() ?? null,
        abandonedAtUtc: row.abandonedAtUtc?.toISOString() ?? null,
        completedAtUtc: row.completedAtUtc?.toISOString() ?? null,
        isTerminal: isTerminalUploadSessionStatus(row.status),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // Deliberately NOT projected: multipartUploadId (reserved; null in
        // current deployments).
    };
}
