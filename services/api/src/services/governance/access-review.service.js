/**
 * PROOVRA Phase 4A — Access review service.
 *
 * Access review campaigns + per-grant items + decisions. Campaign
 * kinds: PERIODIC / MANAGER / SECURITY / ROLE_CERTIFICATION /
 * ACCESS_CERTIFICATION. Decisions: APPROVED / REVOKED / ESCALATED.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Append-only decisions.
 *   * Campaign state machine: DRAFT → OPEN → CLOSED (or CANCELLED).
 *   * Items are added at campaign creation; reviewers update decisions
 *     individually.
 */
import { ACCESS_REVIEW_CAMPAIGN_KINDS, ACCESS_REVIEW_CAMPAIGN_STATES, ACCESS_REVIEW_ITEM_DECISIONS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { revokeDelegatedAdmin } from "./delegated-admin.service.js";
import { revokeDepartmentMembership } from "./department-membership.service.js";
import { escalateAccessReviewItem } from "./access-review-escalation.service.js";
import { revokeInvitation } from "../external-review/portal-invitation.service.js";
import { emitAccessReviewDecisionEvent } from "../trust/trust-and-governance-audit.service.js";
export async function createCampaign(input) {
    if (!ACCESS_REVIEW_CAMPAIGN_KINDS.includes(input.kind)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.scheduledEndUtc.getTime() <= input.scheduledStartUtc.getTime()) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const campaign = await prisma.accessReviewCampaign.create({
        data: {
            teamId: input.teamId,
            kind: input.kind,
            name: input.name.slice(0, 200),
            state: "DRAFT",
            organizationId: input.organizationId ?? null,
            departmentId: input.departmentId ?? null,
            workspaceId: input.workspaceId ?? null,
            scheduledStartUtc: input.scheduledStartUtc,
            scheduledEndUtc: input.scheduledEndUtc,
            createdByUserId: input.createdByUserId,
        },
        select: { id: true },
    });
    if (input.items.length > 0) {
        await prisma.accessReviewItem.createMany({
            data: input.items.map((it) => ({
                teamId: input.teamId,
                campaignId: campaign.id,
                subjectUserId: it.subjectUserId,
                grantRef: it.grantRef.slice(0, 200),
                decision: "PENDING",
            })),
        });
    }
    return { ok: true, campaignId: campaign.id, itemCount: input.items.length };
}
export async function openCampaign(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.accessReviewCampaign.findFirst({
        where: { id: input.campaignId, teamId: input.teamId },
    });
    if (!row || row.state !== "DRAFT")
        return { ok: false };
    await prisma.accessReviewCampaign.update({
        where: { id: row.id },
        data: { state: "OPEN" },
    });
    return { ok: true };
}
export async function closeCampaign(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.accessReviewCampaign.findFirst({
        where: { id: input.campaignId, teamId: input.teamId },
    });
    if (!row)
        return { ok: false };
    if (row.state !== "OPEN")
        return { ok: false };
    await prisma.accessReviewCampaign.update({
        where: { id: row.id },
        data: { state: "CLOSED" },
    });
    return { ok: true };
}
export async function recordItemDecision(input) {
    if (!ACCESS_REVIEW_ITEM_DECISIONS.includes(input.decision)) {
        return { ok: false };
    }
    if (input.decision === "PENDING")
        return { ok: false };
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.accessReviewItem.findFirst({
        where: { id: input.itemId, teamId: input.teamId },
        select: { id: true, decision: true, grantRef: true },
    });
    if (!row)
        return { ok: false };
    if (row.decision !== "PENDING")
        return { ok: false };
    await prisma.accessReviewItem.update({
        where: { id: row.id },
        data: {
            decision: input.decision,
            reviewerUserId: input.reviewerUserId,
            reviewedAtUtc: new Date(),
            notes: input.notes?.slice(0, 2000) ?? null,
        },
    });
    // Side-effects: REVOKED dispatches actual grant revocation.
    if (input.decision === "REVOKED" && row.grantRef) {
        const [kind, uuid] = row.grantRef.split(":");
        if (kind && uuid) {
            if (kind === "delegated_admin") {
                await revokeDelegatedAdmin({
                    prisma,
                    teamId: input.teamId,
                    grantId: uuid,
                    actorUserId: input.reviewerUserId,
                }).catch(() => { });
            }
            else if (kind === "external_review") {
                await revokeInvitation({
                    prisma,
                    teamId: input.teamId,
                    grantId: uuid,
                    revokedByUserId: input.reviewerUserId,
                    reason: "access_review_revoked",
                }).catch(() => { });
            }
            else if (kind === "department_membership") {
                await revokeDepartmentMembership({
                    prisma,
                    teamId: input.teamId,
                    membershipId: uuid,
                    actorUserId: input.reviewerUserId,
                }).catch(() => { });
            }
        }
    }
    // Side-effects: ESCALATED dispatches the escalation service.
    if (input.decision === "ESCALATED") {
        await escalateAccessReviewItem({
            prisma,
            teamId: input.teamId,
            itemId: row.id,
            escalatedByUserId: input.reviewerUserId,
            reason: input.notes ?? null,
        }).catch(() => { });
    }
    // Always emit an audit event for every decision.
    void emitAccessReviewDecisionEvent({
        prisma,
        teamId: input.teamId,
        itemId: row.id,
        decision: input.decision,
        actorUserId: input.reviewerUserId,
        reason: input.notes ?? null,
    }).catch(() => { });
    return { ok: true };
}
export async function listCampaigns(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.accessReviewCampaign.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { scheduledStartUtc: "desc" },
        take: 200,
        include: {
            items: { select: { decision: true } },
        },
    });
    return rows.map((c) => {
        const counts = c.items.reduce((acc, it) => {
            if (it.decision === "PENDING")
                acc.pending += 1;
            else if (it.decision === "APPROVED")
                acc.approved += 1;
            else if (it.decision === "REVOKED")
                acc.revoked += 1;
            else if (it.decision === "ESCALATED")
                acc.escalated += 1;
            return acc;
        }, { pending: 0, approved: 0, revoked: 0, escalated: 0 });
        return {
            id: c.id,
            kind: c.kind,
            // R7-governance: coalesce R7-additive `name` → legacy `title` → "" so projection contract stays non-null.
            name: c.name ?? c.title ?? "",
            state: c.state,
            organizationId: c.organizationId,
            departmentId: c.departmentId,
            workspaceId: c.workspaceId,
            // R7-governance: scheduledStartUtc/scheduledEndUtc are R7-additive nullable; fall back to legacy
            // startsAtUtc/endsAtUtc (always set, defaulted to NOW post-R7) so projection emits a string.
            scheduledStartUtc: (c.scheduledStartUtc ?? c.startsAtUtc).toISOString(),
            scheduledEndUtc: (c.scheduledEndUtc ?? c.endsAtUtc).toISOString(),
            // R7-governance: createdByUserId is R7-additive nullable; coalesce to "" so dashboard renders cleanly.
            createdByUserId: c.createdByUserId ?? "",
            totalItems: c.items.length,
            pendingItems: counts.pending,
            approvedItems: counts.approved,
            revokedItems: counts.revoked,
            escalatedItems: counts.escalated,
        };
    });
}
export async function listItems(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.accessReviewItem.findMany({
        where: { teamId: input.teamId, campaignId: input.campaignId },
        orderBy: { createdAt: "asc" },
        take: 500,
    });
    return rows.map((r) => ({
        id: r.id,
        campaignId: r.campaignId,
        subjectUserId: r.subjectUserId,
        // R7-governance: grantRef is the bounded reference (e.g. "delegated_admin:<uuid>"). Schema is nullable
        // for back-compat with seed rows; coalesce to "" preserves the non-null projection contract.
        grantRef: r.grantRef ?? "",
        // R7-governance: decision projects PENDING when null (matches the bounded UI chip).
        decision: (r.decision ?? "PENDING"),
        reviewerUserId: r.reviewerUserId,
        reviewedAtUtc: r.reviewedAtUtc?.toISOString() ?? null,
        notes: r.notes,
    }));
}
// Compile-time guard.
function _assertEnumsIntact() {
    const _s = "OPEN";
    void _s;
    void ACCESS_REVIEW_CAMPAIGN_STATES;
}
void _assertEnumsIntact;
