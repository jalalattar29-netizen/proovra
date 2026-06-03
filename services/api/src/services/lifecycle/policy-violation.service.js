/**
 * PROOVRA Phase 4B Final Closure C7 — Policy Violation read service.
 *
 * Surfaces persisted POLICY_VIOLATION_* events from the bounded
 * intelligence_activity_events stream. Every code is a member of
 * INTELLIGENCE_LIFECYCLE_CODES so the emitter never silently drops them.
 *
 * Hard rules:
 *   * Workspace-anchored on teamId.
 *   * Bounded codes only — never persist or return raw user input.
 *   * Payload chips bounded to <200 chars via the emitter.
 *   * Cap at 200 rows per list call.
 */
import { prisma as defaultPrisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Bounded vocabulary of POLICY_VIOLATION_* codes
// ---------------------------------------------------------------------------
export const POLICY_VIOLATION_CODES = [
    "POLICY_VIOLATION_ENTITLEMENT",
    "POLICY_VIOLATION_LEGAL_HOLD",
    "POLICY_VIOLATION_RETENTION",
    "POLICY_VIOLATION_QUOTA",
];
// ---------------------------------------------------------------------------
// listPolicyViolations
// ---------------------------------------------------------------------------
export async function listPolicyViolations(input) {
    const db = input.prisma ?? defaultPrisma;
    const cap = Math.min(input.limit ?? 200, 200);
    const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const codes = input.kind
        ? [input.kind]
        : POLICY_VIOLATION_CODES;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await db.intelligenceActivityEvent.findMany({
        where: {
            teamId: input.teamId,
            code: { in: codes },
            occurredAtUtc: { gte: since },
        },
        orderBy: { occurredAtUtc: "desc" },
        take: cap,
        select: {
            id: true,
            teamId: true,
            code: true,
            reason: true,
            evidenceId: true,
            caseId: true,
            targetType: true,
            targetId: true,
            actorUserId: true,
            occurredAtUtc: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        code: r.code,
        reason: r.reason,
        evidenceId: r.evidenceId,
        caseId: r.caseId,
        targetType: r.targetType,
        targetId: r.targetId,
        actorUserId: r.actorUserId,
        occurredAtUtc: r.occurredAtUtc.toISOString(),
    }));
}
export async function countPolicyViolations(input) {
    const db = input.prisma ?? defaultPrisma;
    const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups = await db.intelligenceActivityEvent
        .groupBy({
        by: ["code"],
        where: {
            teamId: input.teamId,
            code: { in: POLICY_VIOLATION_CODES },
            occurredAtUtc: { gte: since },
        },
        _count: { _all: true },
    })
        .catch(() => []);
    const byKind = {};
    let total = 0;
    for (const g of groups) {
        const code = g.code;
        byKind[code] = g._count._all;
        total += g._count._all;
    }
    return { total, byKind };
}
