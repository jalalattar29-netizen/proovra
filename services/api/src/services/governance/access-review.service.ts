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
 *   * (GOV-014) An item names a real member and a real grant of this workspace,
 *     checked at creation. A decision needs an OPEN campaign and a reviewer who
 *     is not the subject. REVOKED is recorded only once the grant is revoked: a
 *     failed revoke leaves the item PENDING and says why. The decision and its
 *     audit commit together.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  ACCESS_REVIEW_CAMPAIGN_STATES,
  ACCESS_REVIEW_ITEM_DECISIONS,
  type AccessReviewCampaignKind,
  type AccessReviewCampaignProjection,
  type AccessReviewCampaignState,
  type AccessReviewItemDecision,
  type AccessReviewItemProjection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { revokeDelegatedAdminScope } from "../identity/membership-provisioning.service.js";
import { revokeDepartmentMembership } from "./department-membership.service.js";
import { escalateAccessReviewItem } from "./access-review-escalation.service.js";
import { revokeInvitation } from "../external-review/portal-invitation.service.js";
import { emitAccessReviewDecisionEvent } from "../trust/trust-and-governance-audit.service.js";

export type CreateCampaignInput = {
  prisma?: PrismaClient;
  teamId: string;
  kind: AccessReviewCampaignKind;
  name: string;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
  scheduledStartUtc: Date;
  scheduledEndUtc: Date;
  createdByUserId: string;
  /** Bounded list of grants to be reviewed. */
  items: ReadonlyArray<{ subjectUserId: string; grantRef: string }>;
};

export type CreateCampaignResult =
  | { ok: true; campaignId: string; itemCount: number }
  | { ok: false; denial: "POLICY_REJECTED" | "SUBJECT_NOT_A_MEMBER" | "GRANT_NOT_RECOGNISED" };

/** The grants an access review can actually revoke. */
const REVOCABLE_GRANT_KINDS = [
  "delegated_admin",
  "delegated_scope",
  "external_review",
  "department_membership",
] as const;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseGrantRef(ref: string | null): { kind: string; id: string } | null {
  const [kind, id, ...rest] = String(ref ?? "").split(":");
  if (!kind || !id || rest.length > 0) return null;
  if (!(REVOCABLE_GRANT_KINDS as readonly string[]).includes(kind) || !UUID_SHAPE.test(id)) return null;
  return { kind, id };
}

/** A grant reference must resolve to a live grant of this workspace and subject. */
async function grantExists(
  prisma: PrismaClient,
  teamId: string,
  subjectUserId: string,
  grant: { kind: string; id: string },
): Promise<boolean> {
  if (grant.kind === "department_membership") {
    const row = await prisma.departmentMembership.findFirst({
      where: { id: grant.id, teamId, state: "ACTIVE", userId: subjectUserId },
      select: { id: true },
    });
    return row !== null;
  }
  if (grant.kind === "external_review") {
    const row = await prisma.externalReviewGrant.findFirst({
      where: { id: grant.id, teamId },
      select: { id: true },
    });
    return row !== null;
  }
  const row = await prisma.memberDelegatedAdminScope.findFirst({
    where: { id: grant.id, teamId, revokedAtUtc: null, teamMember: { userId: subjectUserId } },
    select: { id: true },
  });
  return row !== null;
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  if (!(ACCESS_REVIEW_CAMPAIGN_KINDS as ReadonlyArray<string>).includes(input.kind)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.scheduledEndUtc.getTime() <= input.scheduledStartUtc.getTime()) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  for (const item of input.items) {
    // A fact about the campaign's data, not a gate on the caller.
    const members = await prisma.teamMember.count({
      where: { teamId: input.teamId, userId: item.subjectUserId },
    });
    if (members === 0) return { ok: false, denial: "SUBJECT_NOT_A_MEMBER" };
    const grant = parseGrantRef(item.grantRef);
    if (!grant || !(await grantExists(prisma, input.teamId, item.subjectUserId, grant))) {
      return { ok: false, denial: "GRANT_NOT_RECOGNISED" };
    }
  }
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

export async function openCampaign(input: {
  prisma?: PrismaClient;
  teamId: string;
  campaignId: string;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.accessReviewCampaign.findFirst({
    where: { id: input.campaignId, teamId: input.teamId },
  });
  if (!row || row.state !== "DRAFT") return { ok: false };
  await prisma.accessReviewCampaign.update({
    where: { id: row.id },
    data: { state: "OPEN" },
  });
  return { ok: true };
}

export async function closeCampaign(input: {
  prisma?: PrismaClient;
  teamId: string;
  campaignId: string;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.accessReviewCampaign.findFirst({
    where: { id: input.campaignId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state !== "OPEN") return { ok: false };
  await prisma.accessReviewCampaign.update({
    where: { id: row.id },
    data: { state: "CLOSED" },
  });
  return { ok: true };
}

export type RecordItemDecisionInput = {
  prisma?: PrismaClient;
  teamId: string;
  itemId: string;
  decision: AccessReviewItemDecision;
  reviewerUserId: string;
  notes?: string | null;
};

export type RecordItemDecisionResult =
  | { ok: true }
  | {
      ok: false;
      denial?:
        | "CAMPAIGN_NOT_OPEN"
        | "SELF_REVIEW_REFUSED"
        | "GRANT_NOT_REVOCABLE"
        | "GRANT_REVOKE_FAILED"
        | "ALREADY_DECIDED";
    };

/**
 * Carry out a REVOKED decision. Answers whether the grant is gone, so the decision
 * can never report a revocation that did not happen. Already revoked counts: the
 * state the reviewer asked for holds, and a retried decision must not fail on it.
 */
async function revokeGrant(
  prisma: PrismaClient,
  input: { teamId: string; reviewerUserId: string; grant: { kind: string; id: string } },
): Promise<boolean> {
  const { kind, id } = input.grant;
  try {
    if (kind === "delegated_admin" || kind === "delegated_scope") {
      // Members audit DOM-09 — the one delegated-admin authority.
      await revokeDelegatedAdminScope(
        {
          teamId: input.teamId,
          scopeId: id,
          actorUserId: input.reviewerUserId,
          reason: "access_review_revoked",
        },
        prisma,
      );
      return true;
    }
    if (kind === "external_review") {
      const res = await revokeInvitation({
        prisma,
        teamId: input.teamId,
        grantId: id,
        revokedByUserId: input.reviewerUserId,
        reason: "access_review_revoked",
      });
      return res.ok;
    }
    const res = await revokeDepartmentMembership({
      prisma,
      teamId: input.teamId,
      membershipId: id,
      actorUserId: input.reviewerUserId,
    });
    return res.ok || (res as { denial?: string }).denial === "ALREADY_REVOKED";
  } catch (err) {
    if ((err as { code?: string }).code === "delegated_scope_not_found") {
      const gone = await prisma.memberDelegatedAdminScope.findFirst({
        where: { id, teamId: input.teamId, revokedAtUtc: { not: null } },
        select: { id: true },
      });
      return gone !== null;
    }
    return false;
  }
}

export async function recordItemDecision(
  input: RecordItemDecisionInput,
): Promise<RecordItemDecisionResult> {
  if (!(ACCESS_REVIEW_ITEM_DECISIONS as ReadonlyArray<string>).includes(input.decision)) {
    return { ok: false };
  }
  if (input.decision === "PENDING") return { ok: false };
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.accessReviewItem.findFirst({
    where: { id: input.itemId, teamId: input.teamId },
    select: {
      id: true,
      decision: true,
      grantRef: true,
      subjectUserId: true,
      campaign: { select: { state: true } },
    },
  });
  if (!row) return { ok: false };
  if (row.campaign?.state !== "OPEN") return { ok: false, denial: "CAMPAIGN_NOT_OPEN" };
  if (row.subjectUserId === input.reviewerUserId) return { ok: false, denial: "SELF_REVIEW_REFUSED" };
  if (row.decision !== "PENDING") return { ok: false, denial: "ALREADY_DECIDED" };

  // REVOKED acts first: if the grant cannot be revoked the item stays PENDING and
  // the reviewer is told, rather than a certification saying access was removed.
  // A crash after this leaves a PENDING item whose retry finds the grant gone.
  if (input.decision === "REVOKED") {
    const grant = parseGrantRef(row.grantRef);
    if (!grant) return { ok: false, denial: "GRANT_NOT_REVOCABLE" };
    const revoked = await revokeGrant(prisma, {
      teamId: input.teamId,
      reviewerUserId: input.reviewerUserId,
      grant,
    });
    if (!revoked) return { ok: false, denial: "GRANT_REVOKE_FAILED" };
  }

  // Compare-and-set, with its audit in one transaction.
  const recorded = await prisma.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    const claim = await tx.accessReviewItem.updateMany({
      where: { id: row.id, decision: "PENDING" },
      data: {
        decision: input.decision,
        reviewerUserId: input.reviewerUserId,
        reviewedAtUtc: new Date(),
        notes: input.notes?.slice(0, 2000) ?? null,
      },
    });
    if (claim.count !== 1) return false;
    await emitAccessReviewDecisionEvent({
      prisma: tx,
      teamId: input.teamId,
      itemId: row.id,
      decision: input.decision,
      actorUserId: input.reviewerUserId,
      reason: input.notes ?? null,
    });
    return true;
  });
  if (!recorded) return { ok: false, denial: "ALREADY_DECIDED" };

  // Side-effects: ESCALATED dispatches the escalation service.
  if (input.decision === "ESCALATED") {
    await escalateAccessReviewItem({
      prisma,
      teamId: input.teamId,
      itemId: row.id,
      escalatedByUserId: input.reviewerUserId,
      reason: input.notes ?? null,
    }).catch(() => {});
  }

  return { ok: true };
}

export async function listCampaigns(input: {
  prisma?: PrismaClient;
  teamId: string;
  state?: AccessReviewCampaignState;
}): Promise<ReadonlyArray<AccessReviewCampaignProjection>> {
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
    const counts = c.items.reduce(
      (acc: { pending: number; approved: number; revoked: number; escalated: number }, it: (typeof c.items)[number]) => {
        if (it.decision === "PENDING") acc.pending += 1;
        else if (it.decision === "APPROVED") acc.approved += 1;
        else if (it.decision === "REVOKED") acc.revoked += 1;
        else if (it.decision === "ESCALATED") acc.escalated += 1;
        return acc;
      },
      { pending: 0, approved: 0, revoked: 0, escalated: 0 },
    );
    return {
      id: c.id,
      kind: c.kind as AccessReviewCampaignKind,
      // R7-governance: coalesce R7-additive `name` → legacy `title` → "" so projection contract stays non-null.
      name: c.name ?? c.title ?? "",
      state: c.state as AccessReviewCampaignState,
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

export async function listItems(input: {
  prisma?: PrismaClient;
  teamId: string;
  campaignId: string;
}): Promise<ReadonlyArray<AccessReviewItemProjection>> {
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
    decision: (r.decision ?? "PENDING") as AccessReviewItemDecision,
    reviewerUserId: r.reviewerUserId,
    reviewedAtUtc: r.reviewedAtUtc?.toISOString() ?? null,
    notes: r.notes,
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _s: AccessReviewCampaignState = "OPEN";
  void _s;
  void ACCESS_REVIEW_CAMPAIGN_STATES;
}
void _assertEnumsIntact;
