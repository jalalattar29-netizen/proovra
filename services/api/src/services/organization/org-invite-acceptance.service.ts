/**
 * PHASE 5 §8 (2026-07-22) — canonical organization-invite acceptance.
 *
 * ONE transaction body for POST /v1/org-invites/:token/accept (the route
 * stays a thin HTTP adapter). Two §8 guarantees live here:
 *
 * IDEMPOTENCY — the SAME user re-accepting an invite they already
 *   consumed gets a 200 replay (`idempotentReplay: true`) with the same
 *   organization/role/assignment projection, NOT a 410. Retries after a
 *   network failure, double-clicks, and back-button re-submits are safe.
 *   A DIFFERENT user hitting a consumed invite still gets
 *   `already_accepted` (410) with the rejection audited.
 *
 * CONCURRENCY — acceptance is claimed with a guarded
 *   `updateMany({ where: { id, acceptedAt: null } })` BEFORE any grant is
 *   written. Two concurrent accepts serialize on the row lock: the loser
 *   observes `count === 0`, re-reads, and lands on the replay path (same
 *   user) or `already_accepted` (different user). Grants are only ever
 *   written by the transaction that won the claim, so double-grant and
 *   split-brain acceptance are structurally impossible.
 *
 * Everything else (email match, expiry, revocation, workspace-assignment
 * validation, enterprise owner-accept completion) is unchanged behavior
 * moved verbatim from the route.
 */

import { prisma } from "../../db.js";
import {
  grantOrganizationMembership,
  grantWorkspaceMembership,
  parseWorkspaceAssignments,
} from "../identity/membership-provisioning.service.js";
import { setManagedIdentity } from "../identity/identity-mode.service.js";
import { resolveOrganizationPolicy } from "../identity/org-security-policy.service.js";
import { domainFromEmail } from "./organization-domain.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";
import { completeEnterpriseProvisioningOnOwnerAccept } from "../enterprise-provisioning.service.js";

export type OrgInviteAcceptOutcome =
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "already_accepted" }
  | { kind: "expired" }
  | { kind: "email_mismatch" }
  | { kind: "org_unavailable" }
  | {
      kind: "ok";
      organizationId: string;
      role: string;
      assignedWorkspaceIds: string[];
      idempotentReplay: boolean;
      enterpriseWorkspaceId: string | null;
      setupRedirect: string | null;
    };

export async function acceptOrganizationInvite(input: {
  /** SHA-256 hex of the raw token (the route owns raw-token handling). */
  tokenHash: string;
  userId: string;
}): Promise<OrgInviteAcceptOutcome> {
  const { tokenHash, userId } = input;

  return prisma.$transaction(async (tx) => {
    const caller = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const callerEmail = caller?.email?.trim().toLowerCase() ?? null;

    const invite = await tx.organizationInvite.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        organizationId: true,
        role: true,
        email: true,
        expiresAt: true,
        acceptedAt: true,
        acceptedByUserId: true,
        revokedAt: true,
        workspaceAssignments: true,
      },
    });

    const recordRejection = async (
      reason:
        | "email_mismatch"
        | "expired"
        | "revoked"
        | "already_accepted"
        | "not_found",
    ) => {
      if (!invite) return; // no org to scope the event to
      await emitOrgAuditEvent(tx, {
        organizationId: invite.organizationId,
        actorUserId: userId,
        eventType: "ORG_INVITE_ACCEPT_REJECTED",
        targetType: "organization_invite",
        targetId: invite.id,
        metadata: {
          reason,
          attemptedByUserId: userId,
          attemptedByEmail: callerEmail,
          inviteId: invite.id,
        },
      });
    };

    /**
     * Same projection the winning accept returns, recomputed READ-ONLY
     * for the idempotent replay: assignments whose team still belongs to
     * the invite's organization (mirrors grantWorkspaceMembership's
     * validation without writing anything).
     */
    const replayProjection = async (): Promise<OrgInviteAcceptOutcome> => {
      const parsed = parseWorkspaceAssignments(invite!.workspaceAssignments);
      const assignedWorkspaceIds: string[] = [];
      if (parsed.ok) {
        for (const assignment of parsed.assignments) {
          const team = await tx.team.findUnique({
            where: { id: assignment.teamId },
            select: { organizationId: true, isPersonal: true },
          });
          if (
            team &&
            team.organizationId === invite!.organizationId &&
            !team.isPersonal
          ) {
            assignedWorkspaceIds.push(assignment.teamId);
          }
        }
      }
      return {
        kind: "ok",
        organizationId: invite!.organizationId,
        role: invite!.role,
        assignedWorkspaceIds,
        idempotentReplay: true,
        enterpriseWorkspaceId: null,
        setupRedirect: null,
      };
    };

    if (!invite) {
      return { kind: "not_found" as const };
    }
    if (invite.revokedAt) {
      await recordRejection("revoked");
      return { kind: "revoked" as const };
    }
    if (invite.acceptedAt) {
      // §8 idempotency — the consumer's own retry replays; anyone else
      // is rejected (and audited: consumed-token reuse is a signal).
      if (invite.acceptedByUserId === userId) {
        return replayProjection();
      }
      await recordRejection("already_accepted");
      return { kind: "already_accepted" as const };
    }
    if (invite.expiresAt <= new Date()) {
      await recordRejection("expired");
      return { kind: "expired" as const };
    }

    const inviteEmail = invite.email.trim().toLowerCase();
    if (callerEmail && callerEmail !== inviteEmail) {
      await recordRejection("email_mismatch");
      return { kind: "email_mismatch" as const };
    }

    // §8.1 archived/closed target denial — an invite must never grant
    // access into a SUSPENDED or ARCHIVED organization. Checked at
    // acceptance time (the org's status may have changed since the
    // invite was issued; org suspension expires open invites, but this
    // guard also covers invites raced against the suspension commit).
    const targetOrg = await tx.organization.findUnique({
      where: { id: invite.organizationId },
      select: { status: true },
    });
    if (!targetOrg || targetOrg.status !== "ACTIVE") {
      return { kind: "org_unavailable" as const };
    }

    // §8 concurrency — guarded claim BEFORE any grant. The row lock
    // serializes concurrent transactions; exactly one observes count 1.
    const claimed = await tx.organizationInvite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date(), acceptedByUserId: userId },
    });
    if (claimed.count === 0) {
      const winner = await tx.organizationInvite.findUnique({
        where: { id: invite.id },
        select: { acceptedByUserId: true },
      });
      if (winner?.acceptedByUserId === userId) {
        return replayProjection();
      }
      await recordRejection("already_accepted");
      return { kind: "already_accepted" as const };
    }

    // Winner path — grants are written exactly once.
    await grantOrganizationMembership(tx, {
      organizationId: invite.organizationId,
      userId,
      role: invite.role,
    });

    const parsedAssignments = parseWorkspaceAssignments(
      invite.workspaceAssignments,
    );
    if (!parsedAssignments.ok) {
      // Malformed stored payload — fail closed rather than granting a
      // narrower/wider set than the inviter intended.
      throw new Error("invalid_workspace_assignments");
    }
    const assignedWorkspaceIds: string[] = [];
    for (const assignment of parsedAssignments.assignments) {
      const granted = await grantWorkspaceMembership(tx, {
        organizationId: invite.organizationId,
        userId,
        assignment,
        accessReason: `Organization invite ${invite.id}`,
      });
      if (granted.ok) assignedWorkspaceIds.push(assignment.teamId);
      // Invalid assignments (team moved out of the org since invite
      // creation) are skipped, not silently granted.
    }

    // PATH 9/9 — MANAGED INVITATION. When the Organization REQUIRES managed
    // identity, bind it atomically with the acceptance using DOMAIN evidence
    // (the caller's email domain, DB-verified against THIS org). Composes the
    // ONE identity authority — a cross-Organization conflict (the invitee is
    // already managed by another Org) THROWS and rolls the whole acceptance
    // back (fail closed; no membership, no grant, no session). When no verified
    // domain covers the email, membership is granted here and the managed
    // binding is established at first SSO login (paths 6/7) instead.
    const invitePolicy = await resolveOrganizationPolicy(invite.organizationId, tx as never);
    if (
      invitePolicy.applicability === "ORGANIZATION" &&
      invitePolicy.policy.managedIdentityRequired &&
      callerEmail
    ) {
      const emailDomain = domainFromEmail(callerEmail);
      if (emailDomain) {
        const verifiedDomain = await tx.organizationDomain.findFirst({
          where: {
            organizationId: invite.organizationId,
            domain: emailDomain,
            verifiedAt: { not: null },
          },
          select: { id: true },
        });
        if (verifiedDomain) {
          await setManagedIdentity(
            {
              userId,
              managingOrganizationId: invite.organizationId,
              evidence: {
                source: "DOMAIN",
                organizationDomainId: verifiedDomain.id,
                userEmail: callerEmail,
              },
            },
            tx as never,
          );
        }
      }
    }

    await emitOrgAuditEvent(tx, {
      organizationId: invite.organizationId,
      actorUserId: userId,
      eventType: "ORG_MEMBER_ACCEPTED",
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: {
        inviteId: invite.id,
        role: invite.role,
        acceptedByUserId: userId,
        assignedWorkspaceIds,
        requestedAssignments: parsedAssignments.assignments.length,
      },
    });

    // Brand-new-owner enterprise auto-completion (fully guarded inside
    // the helper; a no-op for every non-enterprise accept).
    const enterpriseCompletion =
      await completeEnterpriseProvisioningOnOwnerAccept(tx, {
        organizationId: invite.organizationId,
        userId,
        inviteRole: invite.role,
        actorUserId: userId,
      });

    return {
      kind: "ok" as const,
      organizationId: invite.organizationId,
      role: invite.role,
      assignedWorkspaceIds,
      idempotentReplay: false,
      enterpriseWorkspaceId: enterpriseCompletion?.enterpriseWorkspaceId ?? null,
      setupRedirect: enterpriseCompletion?.setupRedirect ?? null,
    };
  });
}
