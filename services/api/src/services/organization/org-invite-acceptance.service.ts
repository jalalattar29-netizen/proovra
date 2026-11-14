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
 * INVITATION BINDING (PROV-001, PROV-021) — the invitation names a mailbox, so
 *   it can be accepted only by an account that holds that address and has
 *   proven it. An account with no address no longer skips the comparison. An
 *   ORG_OWNER invitation also needs a password proven with the mailbox, and
 *   its acceptance ends the account's other sessions: a password a stranger
 *   set on this address must not become a way into a customer's organization.
 *
 * Everything else (expiry, revocation, workspace-assignment validation,
 * enterprise owner-accept completion) is unchanged behavior moved verbatim
 * from the route.
 */

import {
  BillingLimitError,
  assertSubscriptionActiveOrGraceAllowed,
} from "../collaboration-team/billing-guards.js";
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
import { revokeOtherSessionsForUserTx } from "../identity-security/session-revocation.service.js";
import {
  WorkspaceSeatContendedError,
  lockWorkspaceSeatsTx,
  withSeatClaimRetry,
} from "../billing/workspace-seats.service.js";

export type OrgInviteAcceptOutcome =
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "already_accepted" }
  | { kind: "expired" }
  | { kind: "email_mismatch" }
  /** The account holds the invited address but has not proven it. */
  | { kind: "email_unverified" }
  /** ORG_OWNER only: the password has never been proven with the mailbox. */
  | { kind: "credential_proof_required" }
  | { kind: "org_unavailable" }
  /**
   * The workspace-seat lock could not be taken within the bounded retry.
   *
   * Deliberately NOT a seat refusal: the workspace may have room, and the
   * invitation is untouched and still acceptable. Telling somebody they were
   * turned away for capacity when the truth is "too many people accepted at
   * once, try again" is the kind of wrong answer an operator acts on.
   */
  | { kind: "seat_contention" }
  | {
      kind: "ok";
      organizationId: string;
      role: string;
      assignedWorkspaceIds: string[];
      /** Workspaces the invitation named and could not grant, so the person can be told. */
      refusedWorkspaceCount: number;
      idempotentReplay: boolean;
      enterpriseWorkspaceId: string | null;
      setupRedirect: string | null;
    };

export async function acceptOrganizationInvite(input: {
  /** SHA-256 hex of the raw token (the route owns raw-token handling). */
  tokenHash: string;
  userId: string;
  /** The session accepting; every other session of an accepting owner ends. */
  sessionIdHash?: string | null;
}): Promise<OrgInviteAcceptOutcome> {
  const { tokenHash, userId, sessionIdHash = null } = input;

  /**
   * Bounded, jittered retry around the seat lock below. The jitter matters:
   * without it a burst of contenders re-collides on the same schedule and
   * simply re-forms the queue. Same shape, same numbers as the workspace
   * invitation path.
   */
  try {
    return await withSeatClaimRetry(() => runAcceptance(tokenHash, userId, sessionIdHash));
  } catch (err) {
    /**
     * Sustained contention on one workspace is not a race any more, and saying
     * so is more useful than a generic error. It is deliberately NOT a seat
     * refusal: the workspace may have room, and the invitation is untouched and
     * still acceptable, so the caller should retry rather than be told they were
     * turned away.
     */
    if (err instanceof WorkspaceSeatContendedError) {
      return { kind: "seat_contention" as const };
    }
    throw err;
  }
}

async function runAcceptance(
  tokenHash: string,
  userId: string,
  sessionIdHash: string | null,
): Promise<OrgInviteAcceptOutcome> {
  return prisma.$transaction(async (tx) => {
    const caller = await tx.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        passwordHash: true,
        credentialProvenAtUtc: true,
      },
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
        createdAt: true,
        workspaceAssignments: true,
      },
    });

    const recordRejection = async (
      reason:
        | "email_mismatch"
        | "email_unverified"
        | "credential_proof_required"
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
        refusedWorkspaceCount: 0,
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
    if (callerEmail !== inviteEmail) {
      await recordRejection("email_mismatch");
      return { kind: "email_mismatch" as const };
    }
    // Refused here rather than at sign-in: a directory-created account has a
    // session and an address it merely asserted, and the comparison above means
    // nothing against an address nobody proved.
    if (!caller?.emailVerifiedAt) {
      await recordRejection("email_unverified");
      return { kind: "email_unverified" as const };
    }
    if (invite.role === "ORG_OWNER" && caller.passwordHash && !caller.credentialProvenAtUtc) {
      await recordRejection("credential_proof_required");
      return { kind: "credential_proof_required" as const };
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

    /**
     * SERIALISE THE SEAT BOUNDARY — BEFORE ANYTHING IS WRITTEN.
     *
     * `grantWorkspaceMembership` reads the canonical seat state and then
     * writes. Between the read and the write another acceptance can do the
     * same, so eight people accepting into a workspace with two free seats
     * could all observe `used < limit` and all be seated. Enforcement that
     * holds under one caller and fails under eight is not enforcement.
     *
     * `acceptWorkspaceInvitation` already solved this for the OTHER acceptance
     * path, and this is the same mechanism rather than a second one:
     * `pg_try_advisory_xact_lock` on `workspace-seat:<id>` — the SAME key, so
     * the two acceptance paths serialise against EACH OTHER and not merely
     * against themselves.
     *
     * TRY, not wait. A blocking `pg_advisory_xact_lock` holds its pooled
     * connection for the whole wait, so contenders occupy connections doing
     * nothing and the pool empties — measured and documented on that path.
     *
     * SORTED, because an acceptance can carry several workspace assignments.
     * Two acceptances taking the same pair of locks in opposite orders is a
     * deadlock; one global order makes that impossible with no coordination.
     *
     * POSITION IS THE WHOLE POINT, and getting it wrong is what the
     * concurrency proof caught: returning a value from a Prisma `$transaction`
     * callback COMMITS — only throwing rolls back. With the lock taken after
     * the claim, a contender that lost the lock committed its claim and its
     * organization membership on the way out, and its retry then found its own
     * invitation already accepted and took the idempotent-replay path. Seven
     * of eight silently became replays and one seat was filled where two were
     * free: no over-allocation, but no correct allocation either.
     *
     * Taken HERE, before the claim and before every grant, a lost lock leaves
     * a transaction that has only READ. Committing that is a no-op, and the
     * retry re-runs the claim cleanly.
     */
    const parsedForLock = parseWorkspaceAssignments(invite.workspaceAssignments);
    if (!parsedForLock.ok) {
      // Malformed stored payload — fail closed BEFORE writing anything,
      // rather than after a claim that would have to be undone.
      throw new Error("invalid_workspace_assignments");
    }
    await lockWorkspaceSeatsTx(
      tx as never,
      parsedForLock.assignments.map((a) => a.teamId),
    );

    // §8 concurrency — guarded claim BEFORE any grant. The row lock
    // serializes concurrent transactions; exactly one observes count 1.
    //
    // F-08 follow-through (members audit F8) — the claim re-checks, AT CLAIM
    // TIME, everything the read above checked: not revoked, not expired, and
    // still the token that was presented (a delivery retry rotates the hash).
    // It guarded only `acceptedAt`, so a revoke (or expiry, or rotation) that
    // committed between the read and this write still granted membership and
    // seats on an invitation the administrator had been told was revoked. The
    // workspace-invitation claim already guards all four.
    const claimedAt = new Date();
    const claimed = await tx.organizationInvite.updateMany({
      where: {
        id: invite.id,
        tokenHash,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: claimedAt },
      },
      data: { acceptedAt: claimedAt, acceptedByUserId: userId },
    });
    if (claimed.count === 0) {
      const winner = await tx.organizationInvite.findUnique({
        where: { id: invite.id },
        select: { acceptedByUserId: true, acceptedAt: true, revokedAt: true, expiresAt: true, tokenHash: true },
      });
      if (winner?.acceptedByUserId === userId) {
        return replayProjection();
      }
      const unclaimed = !!winner && !winner.acceptedByUserId && !winner.acceptedAt;
      if (unclaimed && winner?.revokedAt) {
        await recordRejection("revoked");
        return { kind: "revoked" as const };
      }
      if (unclaimed && winner?.expiresAt instanceof Date && winner.expiresAt.getTime() <= claimedAt.getTime()) {
        await recordRejection("expired");
        return { kind: "expired" as const };
      }
      if (unclaimed && typeof winner?.tokenHash === "string" && winner.tokenHash !== tokenHash) {
        // Rotated by a delivery retry: the presented link is no longer the
        // invitation's credential. Same answer as an unknown token.
        return { kind: "not_found" as const };
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

    // Parsed once, above, so the seat locks could be taken before any write.
    // Re-parsing here would be a second reading of one stored payload.
    const parsedAssignments = parsedForLock;

    const assignedWorkspaceIds: string[] = [];
    /**
     * A REFUSED ASSIGNMENT IS A FACT SOMEBODY HAS TO BE ABLE TO SEE.
     *
     * Refusals were dropped on the floor: the loop kept only the successes,
     * and the audit event recorded a requested count and a granted list whose
     * difference an operator had to infer and could never explain. With seat
     * enforcement now on this path (`workspace_seat_limit_reached`, added to
     * `grantWorkspaceMembership` because this path consulted no commercial
     * authority at all) that difference stops being an edge case: a full
     * workspace is an ordinary, recoverable condition an admin has to be told
     * about, because the fix is theirs — free a seat, or raise the plan.
     *
     * The reason rides the EXISTING org audit event. No new audit authority,
     * no new table, no new notification.
     */
    const refusedAssignments: Array<{ teamId: string; reason: string }> = [];
    for (const assignment of parsedAssignments.assignments) {
      /*
       * GROWTH FOLLOWS THE SUBSCRIPTION LIFECYCLE (closure audit N-3, members
       * ledger M6). The workspace-invitation path refuses a restricted
       * workspace; this one seated people into it. Same canonical adapter;
       * the refusal is recorded like a full workspace, and the Organization
       * membership itself still commits.
       */
      try {
        await assertSubscriptionActiveOrGraceAllowed(
          { workspaceId: assignment.teamId },
          tx as unknown as Parameters<typeof assertSubscriptionActiveOrGraceAllowed>[1],
        );
      } catch (err) {
        if (err instanceof BillingLimitError) {
          refusedAssignments.push({ teamId: assignment.teamId, reason: err.code });
          continue;
        }
        throw err;
      }
      const granted = await grantWorkspaceMembership(tx, {
        organizationId: invite.organizationId,
        userId,
        assignment,
        accessReason: `Organization invite ${invite.id}`,
        invitationCreatedAt: invite.createdAt,
      });
      if (granted.ok) {
        assignedWorkspaceIds.push(assignment.teamId);
      } else {
        // Invalid assignments (team moved out of the org since invite
        // creation, a personal workspace, or a workspace with no free seat)
        // are skipped, not silently granted. The organization membership
        // itself still commits — a full workspace must not cost someone the
        // governance membership they were validly invited to.
        refusedAssignments.push({
          teamId: assignment.teamId,
          reason: granted.reason,
        });
      }
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
        // Bounded: ids + a closed reason vocabulary, no free text, no PII.
        refusedAssignments,
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

    // In this transaction: ownership must not commit while an older session of
    // the account can still use it.
    if (invite.role === "ORG_OWNER") {
      await revokeOtherSessionsForUserTx(tx as never, {
        userId,
        currentSessionIdHash: sessionIdHash,
        reason: "OWNERSHIP_ACCEPTED",
      });
    }

    return {
      kind: "ok" as const,
      organizationId: invite.organizationId,
      role: invite.role,
      assignedWorkspaceIds,
      refusedWorkspaceCount: refusedAssignments.length,
      idempotentReplay: false,
      enterpriseWorkspaceId: enterpriseCompletion?.enterpriseWorkspaceId ?? null,
      setupRedirect: enterpriseCompletion?.setupRedirect ?? null,
    };
  });
}
