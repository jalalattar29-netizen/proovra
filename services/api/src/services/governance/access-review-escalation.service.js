/**
 * PROOVRA Phase 4A Closure — Access review escalation service.
 *
 * Bounded surface for the ESCALATED decision verdict on access-review
 * items. Escalation is a tracking flag — NOT a separate workflow
 * engine. The service:
 *
 *   1. Marks the item's decision as `ESCALATED` (append-only).
 *   2. Emits the canonical `ACCESS_REVIEW_DECIDED` lifecycle event
 *      with bounded payload `{ decision: 'ESCALATED' }` so the audit
 *      federator surfaces the verdict in the standard
 *      access-review stream.
 *   3. Emits a parallel `POLICY_VIOLATION` lifecycle event with
 *      reason `access_review_escalation:<itemId>` so the Audit &
 *      Transparency Center treats the escalation as a governance
 *      signal that needs human re-routing.
 *
 * Hard rules:
 *   * Workspace-anchored — every read + write requires `teamId`.
 *   * Append-only — already-escalated items are a no-op success.
 *   * NEVER PII in bounded reasons — bounded id-prefix only.
 *   * Audit emission is tolerant of failure — the escalation flag is
 *     authoritative, the lifecycle event is a best-effort mirror.
 *   * The projection shape matches `listItems` in
 *     `access-review.service.ts` so the two read paths are
 *     interchangeable for UI consumers.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { emitTrustEvent } from "../trust/trust-and-governance-audit.service.js";
/**
 * Flag an access-review item as ESCALATED and emit the paired
 * lifecycle events. Returns `ok: true` and the primary escalation
 * event id on success; `ok: false` if the item is missing, belongs to
 * another tenant, or has already been decided with a non-PENDING
 * verdict other than ESCALATED.
 */
export async function escalateAccessReviewItem(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.accessReviewItem.findFirst({
        where: { id: input.itemId, teamId: input.teamId },
        select: { id: true, decision: true },
    });
    if (!row)
        return { ok: false };
    // Append-only: only PENDING items may be escalated. Already-ESCALATED
    // items are a no-op success (idempotent). APPROVED / REVOKED items
    // are terminal and cannot be escalated.
    if (row.decision !== "PENDING" && row.decision !== "ESCALATED") {
        return { ok: false };
    }
    if (row.decision === "PENDING") {
        await prisma.accessReviewItem.update({
            where: { id: row.id },
            data: {
                decision: "ESCALATED",
                reviewerUserId: input.escalatedByUserId,
                reviewedAtUtc: new Date(),
                notes: input.reason?.slice(0, 2000) ?? null,
            },
        });
    }
    // Primary lifecycle event — surfaces the verdict in the
    // ACCESS_REVIEW_DECIDED stream alongside APPROVED / REVOKED.
    const primary = await emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "ACCESS_REVIEW_DECIDED",
        actorUserId: input.escalatedByUserId,
        targetType: "ACCESS_REVIEW_ITEM",
        targetId: row.id,
        reason: input.reason?.slice(0, 200) ?? null,
        payload: { decision: "ESCALATED" },
    });
    // Parallel POLICY_VIOLATION emit — the Audit & Transparency Center
    // treats this as a governance signal so a human can re-route the
    // escalation. Bounded reason chip carries the item id prefix only.
    await emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.escalatedByUserId,
        targetType: "ACCESS_REVIEW_ITEM",
        targetId: row.id,
        reason: `access_review_escalation:${row.id}`,
    });
    return { ok: true, escalationEventId: primary.id };
}
/**
 * Workspace-scoped read of every access-review item currently flagged
 * ESCALATED. Same projection shape as `listItems` in
 * `access-review.service.ts` so UI consumers can render them in a
 * shared queue component. Ordered most-recent-decision first so
 * triage surfaces fresh escalations.
 */
export async function listEscalatedItems(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const limit = Math.min(input.limit ?? 200, 500);
    const rows = await prisma.accessReviewItem.findMany({
        where: { teamId: input.teamId, decision: "ESCALATED" },
        orderBy: [
            { reviewedAtUtc: "desc" },
            { createdAt: "desc" },
        ],
        take: limit,
    });
    return rows.map((r) => ({
        id: r.id,
        campaignId: r.campaignId,
        subjectUserId: r.subjectUserId,
        // R7-governance: grantRef is the bounded reference; coalesce to "" for non-null projection contract.
        grantRef: r.grantRef ?? "",
        decision: (r.decision ?? "PENDING"),
        reviewerUserId: r.reviewerUserId,
        reviewedAtUtc: r.reviewedAtUtc?.toISOString() ?? null,
        notes: r.notes,
    }));
}
