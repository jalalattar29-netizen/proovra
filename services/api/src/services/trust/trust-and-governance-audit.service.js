/**
 * PROOVRA Phase 4A Closure — Trust & Governance lifecycle audit emitter.
 *
 * Thin wrapper around `intelligence-activity.service.ts` that writes
 * the new Phase 4A Closure `TRUST_LIFECYCLE` / `GOVERNANCE_LIFECYCLE`
 * codes into the SAME `intelligence_activity_events` table the Phase
 * 3B emitter targets. The base emitter validates against
 * `INTELLIGENCE_LIFECYCLE_CODES` — this parallel emitter validates
 * against `TRUST_LIFECYCLE_CODES` (a disjoint enum) so the audit
 * federator can answer "did this trust/governance transition happen?"
 * from one table.
 *
 * Hard rules:
 *   * Workspace-anchored — every emit requires `teamId`.
 *   * Bounded code vocabulary from `TRUST_LIFECYCLE_CODES`.
 *   * NEVER raw payloads — bounded reason (<=200 chars) + ids only.
 *   * Append-only — no update / delete path.
 *   * Silently swallows persistence failures — lifecycle audit must
 *     never break the calling operational write path.
 */
import { ACCESS_REVIEW_ITEM_DECISIONS, TRUST_LIFECYCLE_CODES, classifyTrustLifecycleCategory, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Bounded target-type vocabulary for the Phase 4A audit stream. These
// strings populate the `target_type` column on `intelligence_activity_events`
// so the federator can group events by the bounded subject kind.
// ---------------------------------------------------------------------------
export const TRUST_AUDIT_TARGET_TYPES = [
    "TRUST_ARTICLE",
    "SUBPROCESSOR",
    "STATUS_INCIDENT",
    "ACCESS_REVIEW_ITEM",
    "CROSS_ORG_REVIEW",
    "DELEGATED_ADMIN_GRANT",
    "DEPARTMENT",
];
/**
 * Emit a single trust / governance lifecycle event. Silently swallows
 * persistence failures so the calling operational write is never
 * blocked by the audit log itself.
 */
export async function emitTrustEvent(input) {
    if (!TRUST_LIFECYCLE_CODES.includes(input.code)) {
        return { ok: false };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const category = classifyTrustLifecycleCategory(input.code);
    try {
        const row = await prisma.intelligenceActivityEvent.create({
            data: {
                teamId: input.teamId,
                category,
                code: input.code,
                actorUserId: input.actorUserId ?? null,
                targetType: input.targetType ?? null,
                targetId: input.targetId ?? null,
                recordId: input.recordId ?? null,
                reason: input.reason?.slice(0, 200) ?? null,
                payload: (input.payload ?? null),
            },
            select: { id: true },
        });
        return { ok: true, id: row.id };
    }
    catch {
        return { ok: false };
    }
}
// ---------------------------------------------------------------------------
// Bounded per-subject helpers. Each is a thin wrapper that pins the
// `targetType` + `targetId` for the caller so routes don't have to
// remember the bounded vocabulary.
// ---------------------------------------------------------------------------
export async function emitTrustArticleEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        targetType: "TRUST_ARTICLE",
        targetId: input.articleId,
        reason: input.reason ?? null,
        payload: input.payload ?? null,
    });
}
export async function emitSubprocessorEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        targetType: "SUBPROCESSOR",
        targetId: input.subprocessorId,
        reason: input.reason ?? null,
    });
}
export async function emitStatusIncidentEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        targetType: "STATUS_INCIDENT",
        targetId: input.incidentId,
        reason: input.reason ?? null,
    });
}
/**
 * Access review decisions write `ACCESS_REVIEW_DECIDED` for every
 * verdict and additionally `ACCESS_REVIEW_GRANT_REVOKED` when the
 * decision is `REVOKED` — the propagation engine listens for the
 * second code to actually revoke the underlying grant.
 */
export async function emitAccessReviewDecisionEvent(input) {
    if (!ACCESS_REVIEW_ITEM_DECISIONS.includes(input.decision)) {
        return { ok: false };
    }
    const primary = await emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: "ACCESS_REVIEW_DECIDED",
        actorUserId: input.actorUserId,
        targetType: "ACCESS_REVIEW_ITEM",
        targetId: input.itemId,
        reason: input.reason ?? null,
        payload: { decision: input.decision },
    });
    if (input.decision === "REVOKED") {
        await emitTrustEvent({
            prisma: input.prisma,
            teamId: input.teamId,
            code: "ACCESS_REVIEW_GRANT_REVOKED",
            actorUserId: input.actorUserId,
            targetType: "ACCESS_REVIEW_ITEM",
            targetId: input.itemId,
            reason: input.reason ?? null,
        });
    }
    return primary;
}
export async function emitCrossOrgEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: input.grantId,
        reason: input.reason ?? null,
    });
}
export async function emitDelegatedAdminEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId,
        targetType: "DELEGATED_ADMIN_GRANT",
        targetId: input.grantId,
        reason: input.reason ?? null,
    });
}
export async function emitDepartmentEvent(input) {
    return emitTrustEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: input.code,
        actorUserId: input.actorUserId,
        targetType: "DEPARTMENT",
        targetId: input.departmentId,
        reason: input.reason ?? null,
    });
}
