/**
 * PROOVRA Phase 2B — Portal invitation service.
 *
 * Orchestrates:
 *
 *   * issueInvitation        — issue a grant + role assignment +
 *                              GRANT_ISSUED activity. Returns the
 *                              raw token ONCE.
 *   * resendInvitation       — rotate the raw token + emit
 *                              GRANT_RESENT.
 *   * revokeInvitation       — flip grant state to REVOKED + emit
 *                              GRANT_REVOKED.
 *   * acceptInvitation       — set grant ACTIVE on first arrival +
 *                              emit GRANT_ACCEPTED.
 *   * listInvitationsForTeam — workspace-anchored list with role +
 *                              activity counters.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Issue / resend return the raw token EXACTLY ONCE; subsequent
 *     reads only return its hash + state.
 *   * Role + watermark + MFA bound at issue time; sidecar role row
 *     mirrors them.
 *   * Bounded denial reasons.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXTERNAL_REVIEWER_ROLES,
  WATERMARK_POLICIES,
  type ExternalPortalDenialReason,
  type ExternalReviewerRole,
  type WatermarkPolicy,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  issueExternalReviewGrant,
  transitionExternalReviewGrant,
} from "./external-review-grant.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";

export type IssueInvitationInput = {
  prisma?: PrismaClient;
  teamId: string;
  invitedByUserId: string;
  reviewerEmail: string;
  reviewerDisplayName?: string;
  organization?: string;
  role: ExternalReviewerRole;
  watermarkPolicy?: WatermarkPolicy;
  mfaRequired?: boolean;
  scope: {
    kind: "EVIDENCE" | "CASE" | "PACKAGE";
    evidenceId?: string;
    caseId?: string;
    packageId?: string;
  };
  expiresAtUtc: string;
  allowOriginalDownload?: boolean;
  allowPackageDownload?: boolean;
  safeNote?: string;
};

export type IssueInvitationResult =
  | {
      ok: true;
      grantId: string;
      rawToken: string;
      role: ExternalReviewerRole;
    }
  | { ok: false; denial: ExternalPortalDenialReason };

export async function issueInvitation(
  input: IssueInvitationInput,
): Promise<IssueInvitationResult> {
  if (!(EXTERNAL_REVIEWER_ROLES as ReadonlyArray<string>).includes(input.role)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (
    input.watermarkPolicy &&
    !(WATERMARK_POLICIES as ReadonlyArray<string>).includes(input.watermarkPolicy)
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;

  const issued = await issueExternalReviewGrant(
    {
      teamId: input.teamId,
      invitedByUserId: input.invitedByUserId,
      scopeKind: input.scope.kind,
      evidenceId: input.scope.evidenceId ?? null,
      caseId: input.scope.caseId ?? null,
      packageId: input.scope.packageId ?? null,
      reviewerEmail: input.reviewerEmail,
      reviewerDisplayName: input.reviewerDisplayName ?? null,
      expiresAtUtc: input.expiresAtUtc,
      allowOriginalDownload: input.allowOriginalDownload ?? false,
      allowPackageDownload: input.allowPackageDownload ?? true,
      safeNote: input.safeNote ?? null,
    },
    prisma,
  );
  if (!issued.ok) {
    return { ok: false, denial: mapGrantDenial(issued.reason) };
  }

  // Create the sidecar role assignment row.
  await prisma.externalReviewerRoleAssignment.upsert({
    where: { id: issued.grant.id },
    create: {
      id: issued.grant.id,
      teamId: input.teamId,
      evidenceId: issued.grant.evidenceId ?? input.scope.evidenceId ?? "00000000-0000-0000-0000-000000000000",
      grantedByUserId: input.invitedByUserId,
      externalEmail: input.reviewerEmail,
      role: input.role,
      mfaRequired: input.mfaRequired === true,
      watermarkPolicy: input.watermarkPolicy ?? "ALWAYS",
      inviteEmail: input.reviewerEmail,
    },
    update: {
      role: input.role,
      mfaRequired: input.mfaRequired === true,
      watermarkPolicy: input.watermarkPolicy ?? "ALWAYS",
      inviteEmail: input.reviewerEmail,
    },
  });

  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: issued.grant.id,
    code: "GRANT_ISSUED",
    payload: {
      role: input.role,
      scope: input.scope.kind,
      expiresAtUtc: input.expiresAtUtc,
      mfaRequired: input.mfaRequired === true,
      watermarkPolicy: input.watermarkPolicy ?? "ALWAYS",
    },
  });

  return {
    ok: true,
    grantId: issued.grant.id,
    rawToken: issued.rawToken,
    role: input.role,
  };
}

/**
 * Revoke a grant. Bounded — the underlying grant service enforces the
 * state-machine. Emits GRANT_REVOKED activity.
 */
export async function revokeInvitation(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  revokedByUserId: string;
  reason?: string;
}): Promise<
  | { ok: true }
  | { ok: false; denial: ExternalPortalDenialReason }
> {
  const prisma = input.prisma ?? defaultPrisma;
  const res = await transitionExternalReviewGrant(
    {
      grantId: input.grantId,
      teamId: input.teamId,
      toState: "REVOKED",
      actorUserId: input.revokedByUserId,
    },
    prisma,
  );
  if (!res.ok) {
    return { ok: false, denial: mapGrantDenial(res.reason) };
  }
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "GRANT_REVOKED",
    payload: { reason: input.reason ?? null },
  });
  return { ok: true };
}

/**
 * Accept an invitation. The grant service flips INVITED → ACTIVE.
 * We emit GRANT_ACCEPTED and stamp the role-assignment row.
 */
export async function acceptInvitation(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  acceptedByUserId?: string;
}): Promise<
  | { ok: true }
  | { ok: false; denial: ExternalPortalDenialReason }
> {
  const prisma = input.prisma ?? defaultPrisma;
  const res = await transitionExternalReviewGrant(
    {
      grantId: input.grantId,
      teamId: input.teamId,
      toState: "ACTIVE",
      actorUserId:
        input.acceptedByUserId ?? "00000000-0000-0000-0000-000000000000",
    },
    prisma,
  );
  if (!res.ok) {
    return { ok: false, denial: mapGrantDenial(res.reason) };
  }
  await prisma.externalReviewerRoleAssignment.updateMany({
    where: { id: input.grantId, teamId: input.teamId },
    data: { inviteAcceptedAtUtc: new Date() },
  });
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "GRANT_ACCEPTED",
  });
  return { ok: true };
}

/**
 * Workspace-anchored list. Joins grant + role + activity counts so
 * the internal invite surface can render everything in one read.
 *
 * Phase 2B Closure extension — additionally returns the grant state,
 * expiry, and federation fields needed by the External Review
 * Management Console (tabs by lifecycle state, SSO badges, etc.).
 */
export async function listInvitationsForTeam(input: {
  prisma?: PrismaClient;
  teamId: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const assignments = await prisma.externalReviewerRoleAssignment.findMany({
    where: { teamId: input.teamId },
    orderBy: { inviteSentAtUtc: "desc" },
    take: Math.min(input.limit ?? 100, 500),
  });
  // Activity counts (open & total) via aggregate.
  const totals = await prisma.externalReviewActivity.groupBy({
    by: ["grantId"],
    where: { teamId: input.teamId },
    _count: true,
  });
  const totalMap = new Map<string, number>(
    totals.map((t: (typeof totals)[number]) => [t.grantId as string, (t._count as number) ?? 0]),
  );

  // Phase 2B Closure — bring in the grant state + expiry from the
  // primitive table (external_review_grants is owned by the Phase 27/28
  // grant service and accessed via $queryRaw).
  const grantIds = assignments.map((a) => a.id);
  let stateMap = new Map<string, { state: string; expiresAtUtc: Date }>();
  if (grantIds.length > 0) {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; state: string; expires_at_utc: Date }>
    >`
      SELECT "id", "state", "expires_at_utc"
        FROM "external_review_grants"
       WHERE "team_id" = ${input.teamId}::uuid
         AND "id" = ANY(${grantIds}::uuid[])
    `;
    stateMap = new Map(
      rows.map((r) => [
        r.id,
        { state: r.state, expiresAtUtc: r.expires_at_utc },
      ]),
    );
  }

  // Latest delivery row per grant — single read, in-memory pivot.
  const deliveries = grantIds.length
    ? await prisma.externalReviewInvitationDelivery.findMany({
        where: { teamId: input.teamId, grantId: { in: grantIds } },
        orderBy: { queuedAtUtc: "desc" },
        select: {
          grantId: true,
          status: true,
          sentAtUtc: true,
          failureReason: true,
          attempt: true,
          queuedAtUtc: true,
        },
      })
    : [];
  const latestDeliveryByGrant = new Map<
    string,
    {
      status: string;
      sentAtUtc: Date | null;
      failureReason: string | null;
      attempt: number;
      queuedAtUtc: Date;
    }
  >();
  for (const d of deliveries) {
    if (!latestDeliveryByGrant.has(d.grantId)) {
      latestDeliveryByGrant.set(d.grantId, {
        status: d.status,
        sentAtUtc: d.sentAtUtc,
        failureReason: d.failureReason,
        attempt: d.attempt,
        queuedAtUtc: d.queuedAtUtc,
      });
    }
  }

  const nowMs = Date.now();
  return assignments.map((a) => {
    const meta = stateMap.get(a.id);
    const expiresAtUtc = meta?.expiresAtUtc ?? null;
    const expired =
      expiresAtUtc !== null && expiresAtUtc.getTime() < nowMs;
    const grantState = meta?.state ?? null;
    const latestDelivery = latestDeliveryByGrant.get(a.id) ?? null;
    return {
      grantId: a.id,
      role: a.role,
      organization: a.organization,
      inviteEmail: a.inviteEmail,
      mfaRequired: a.mfaRequired,
      watermarkPolicy: a.watermarkPolicy,
      inviteSentAtUtc: a.inviteSentAtUtc?.toISOString() ?? null,
      inviteAcceptedAtUtc: a.inviteAcceptedAtUtc?.toISOString() ?? null,
      inviteResentAtUtc: a.inviteResentAtUtc?.toISOString() ?? null,
      activityCount: totalMap.get(a.id) ?? 0,
      // Phase 2B Closure additions.
      grantState,
      expiresAtUtc: expiresAtUtc?.toISOString() ?? null,
      expired,
      authMethod: a.authMethod,
      ssoConnectionId: a.ssoConnectionId,
      allowedDomains: a.allowedDomains ?? [],
      ssoSubjectHash: a.ssoSubjectHash,
      ssoNameId: a.ssoNameId,
      ssoBoundAtUtc: a.ssoBoundAtUtc?.toISOString() ?? null,
      mfaSatisfiedAtUtc: a.mfaSatisfiedAtUtc?.toISOString() ?? null,
      latestDelivery: latestDelivery
        ? {
            status: latestDelivery.status,
            sentAtUtc: latestDelivery.sentAtUtc?.toISOString() ?? null,
            queuedAtUtc: latestDelivery.queuedAtUtc.toISOString(),
            failureReason: latestDelivery.failureReason,
            attempt: latestDelivery.attempt,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapGrantDenial(reason: string): ExternalPortalDenialReason {
  switch (reason) {
    case "INVALID_TOKEN":
      return "TOKEN_INVALID";
    case "EXPIRED":
      return "TOKEN_EXPIRED";
    case "REVOKED":
      return "TOKEN_REVOKED";
    case "GRANT_NOT_FOUND":
    case "INVITE_NOT_FOUND":
      return "INVITE_NOT_FOUND";
    case "ALREADY_ACCEPTED":
      return "INVITE_ALREADY_ACCEPTED";
    case "ALREADY_REVOKED":
      return "INVITE_ALREADY_REVOKED";
    case "POLICY_VIOLATION":
    case "BLOCKED_BY_POLICY":
      return "POLICY_REJECTED";
    default:
      return "POLICY_REJECTED";
  }
}
