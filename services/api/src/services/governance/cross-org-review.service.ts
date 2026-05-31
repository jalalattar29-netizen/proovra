/**
 * PROOVRA Phase 4A — Cross-org review grants.
 *
 * Org-A invites Org-B → controlled review. Integrates with the
 * existing External Reviewer Portal (Phase 2B) so the actual review
 * surface + watermarking + decision recording is reused — this
 * service governs the org-to-org binding layer.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  CROSS_ORG_REVIEW_STATES,
  type CrossOrgReviewGrantProjection,
  type CrossOrgReviewState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  issueInvitation,
  revokeInvitation,
} from "../external-review/portal-invitation.service.js";
import {
  emitCrossOrgEvent,
  emitTrustEvent,
} from "../trust/trust-and-governance-audit.service.js";

export type InviteCrossOrgReviewInput = {
  prisma?: PrismaClient;
  teamId: string;
  invitingOrganizationId: string;
  invitedOrgSlug: string;
  scope: string;
  expiresAtUtc?: Date | null;
  createdByUserId: string;
};

export type InviteCrossOrgReviewResult =
  | { ok: true; grantId: string }
  | { ok: false; denial: "POLICY_REJECTED" };

export async function inviteCrossOrgReview(
  input: InviteCrossOrgReviewInput,
): Promise<InviteCrossOrgReviewResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(input.invitedOrgSlug)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.crossOrgReviewGrant.create({
    data: {
      teamId: input.teamId,
      invitingOrganizationId: input.invitingOrganizationId,
      invitedOrgSlug: input.invitedOrgSlug,
      state: "INVITED",
      // R7-governance: scope is a Json column; service input is a bounded string description. Wrap as
      // { text: ... } so the audit/dashboard layer can read the structured form. Pre-Phase 4A scope
      // was inline text — preserved via .text for back-compat consumers.
      scope: { text: input.scope.slice(0, 600) } as Prisma.InputJsonValue,
      expiresAtUtc: input.expiresAtUtc ?? null,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_CREATED",
    actorUserId: input.createdByUserId,
  }).catch(() => {});
  return { ok: true, grantId: row.id };
}

export type AcceptCrossOrgReviewResult =
  | { ok: true }
  | {
      ok: false;
      denial?:
        | "EXTERNAL_GRANT_NOT_FOUND"
        | "EXTERNAL_GRANT_REVOKED"
        | "POLICY_REJECTED";
    };

export async function acceptCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  acceptingOrganizationId: string;
  externalReviewGrantId: string | null;
  actorUserId?: string | null;
}): Promise<AcceptCrossOrgReviewResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state !== "INVITED") return { ok: false };

  // Issue a portal invitation for the cross-org reviewer, OR — when the
  // caller supplied an externalReviewGrantId — validate that the grant
  // actually exists under THIS workspace and is not already REVOKED.
  // Without this check the caller could bind any UUID into the cross-org
  // grant, including one belonging to another tenant.
  let portalGrantId: string | null = input.externalReviewGrantId;
  if (portalGrantId) {
    type GrantProbe = { id: string; state: string };
    const probe = await prisma.$queryRawUnsafe<ReadonlyArray<GrantProbe>>(
      `SELECT "id", "state"
         FROM "external_review_grants"
        WHERE "id" = $1::uuid
          AND "team_id" = $2::uuid
        LIMIT 1`,
      portalGrantId,
      input.teamId,
    );
    const grant = probe[0] ?? null;
    if (!grant) {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_invalid_external_grant",
      }).catch(() => {});
      return { ok: false, denial: "EXTERNAL_GRANT_NOT_FOUND" };
    }
    if (grant.state === "REVOKED") {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_invalid_external_grant",
      }).catch(() => {});
      return { ok: false, denial: "EXTERNAL_GRANT_REVOKED" };
    }
  } else {
    const reviewerEmail = `cross-org-${row.invitedOrgSlug}@cross-org.invalid`;
    const expiresAtUtc = row.expiresAtUtc
      ? row.expiresAtUtc.toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const issued = await issueInvitation({
      prisma,
      teamId: input.teamId,
      invitedByUserId: input.actorUserId ?? input.acceptingOrganizationId,
      reviewerEmail,
      role: "EXTERNAL_REVIEWER",
      scope: { kind: "PACKAGE" },
      expiresAtUtc,
    }).catch(() => null);
    if (issued?.ok) {
      portalGrantId = issued.grantId;
    }
  }

  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: {
      state: "ACCEPTED",
      invitedOrganizationId: input.acceptingOrganizationId,
      externalReviewGrantId: portalGrantId,
    },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_ACCEPTED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export async function declineCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  actorUserId?: string | null;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state !== "INVITED") return { ok: false };
  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: { state: "DECLINED" },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_DECLINED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export type RevokeCrossOrgReviewResult =
  | { ok: true }
  | { ok: false; denial?: "ACTOR_REQUIRED" | "POLICY_REJECTED" };

export async function revokeCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  actorUserId?: string | null;
}): Promise<RevokeCrossOrgReviewResult> {
  const prisma = input.prisma ?? defaultPrisma;
  // An actor is REQUIRED for revoke — never silently substitute a
  // zero-UUID. The downstream portal-invitation revoke writes this id
  // into the audit trail as the "who", so a missing actor would corrupt
  // the chain of accountability.
  if (!input.actorUserId) {
    void emitTrustEvent({
      prisma,
      teamId: input.teamId,
      code: "POLICY_VIOLATION",
      actorUserId: null,
      targetType: "CROSS_ORG_REVIEW",
      targetId: input.grantId,
      reason: "cross_org_revoke_missing_actor",
    }).catch(() => {});
    return { ok: false, denial: "ACTOR_REQUIRED" };
  }
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state === "REVOKED") return { ok: true };

  // Revoke the underlying portal invitation if one was issued.
  if (row.externalReviewGrantId) {
    await revokeInvitation({
      prisma,
      teamId: input.teamId,
      grantId: row.externalReviewGrantId,
      revokedByUserId: input.actorUserId,
      reason: "cross_org_review_revoked",
    }).catch(() => {});
  }

  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: { state: "REVOKED" },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_REVOKED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export async function listCrossOrgGrants(input: {
  prisma?: PrismaClient;
  teamId: string;
  invitingOrganizationId?: string;
  state?: CrossOrgReviewState;
}): Promise<ReadonlyArray<CrossOrgReviewGrantProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.crossOrgReviewGrant.findMany({
    where: {
      teamId: input.teamId,
      ...(input.invitingOrganizationId
        ? { invitingOrganizationId: input.invitingOrganizationId }
        : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    // R7-governance: invitingOrganizationId is R7-additive nullable. Coalesce to "" so projection
    // contract stays string. Cross-org enforcement reads the column directly (not projection).
    invitingOrganizationId: r.invitingOrganizationId ?? "",
    invitedOrganizationId: r.invitedOrganizationId,
    // R7-governance: invitedOrgSlug is R7-additive nullable. Coalesce to "" for non-null projection.
    invitedOrgSlug: r.invitedOrgSlug ?? "",
    externalReviewGrantId: r.externalReviewGrantId,
    state: r.state as CrossOrgReviewState,
    // R7-governance: scope is a Json column; project it as a string by extracting `.text` (set by
    // inviteCrossOrgReview) with fallback to JSON.stringify for legacy untyped rows.
    scope: typeof (r.scope as { text?: string } | null)?.text === "string"
      ? (r.scope as { text: string }).text
      : JSON.stringify(r.scope ?? ""),
    expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
    createdByUserId: r.createdByUserId,
    createdAtUtc: r.createdAt.toISOString(),
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _s: CrossOrgReviewState = "INVITED";
  void _s;
  void CROSS_ORG_REVIEW_STATES;
}
void _assertEnumsIntact;
