/**
 * PHASE 4 §7.4/§7.5 (2026-07-22) — owned/organization workspace lifecycle.
 *
 * ONE canonical surface for the workspace lifecycle transitions that were
 * missing from the platform:
 *
 *   §7.4 transferWorkspaceOwnership — OWNED workspaces only. Swaps
 *        Team.ownerUserId + Team.billingOwnerUserId and moves the OWNER
 *        membership role through the membership orchestrator (rbac
 *        deliberately refuses OWNER transitions). Billing follows the
 *        owner: the canonical scope adapter resolves the effective plan from
 *        the (new) owner's Entitlement whenever team billing is not
 *        ACTIVE, so the swap IS the billing-responsibility transfer.
 *
 *   §7.4 reopenClosedWorkspace — safe-by-default reopen after a COMPLETED
 *        closure: ONLY the owner's membership is reactivated. Other
 *        members stay REVOKED (re-invite), API credentials stay REVOKED
 *        (re-issue), webhooks stay DISABLED (re-enable explicitly).
 *
 *   §7.5 suspendOrganizationWorkspace / resumeOrganizationWorkspace —
 *        ORGANIZATION workspaces. Suspension flips every ACTIVE
 *        membership to SUSPENDED with a canonical marker reason (held
 *        roles preserved), clears switcher pointers (currentWorkspaceId)
 *        so sessions fall back to the personal workspace on next
 *        platform-context load, and pauses webhook delivery (DISABLED).
 *        Resume reactivates ONLY the memberships carrying the marker —
 *        rows revoked or suspended for other reasons stay dark. API
 *        credentials keep their status: the ApiCredentialStatus enum is
 *        ACTIVE|REVOKED (revocation is irreversible), so suspension does
 *        not burn them — workspace access checks on ACTIVE TeamMember
 *        rows remain the enforcement boundary for machine calls that
 *        resolve through membership.
 *
 * Evidence, custody, anchors, and audit history are NEVER touched by any
 * transition here — retention/legal governance owns evidence destruction.
 */

import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { resolveWorkspaceKind } from "../identity/workspace-kind.js";
// PHASE 3 orchestrator — the only sanctioned membership mutation surface.
import {
  massReactivateSuspendedWorkspaceMemberships,
  massSuspendWorkspaceMemberships,
  reopenWorkspaceOwnerMembership,
  transferWorkspaceOwnerRoles,
  type TxClient,
} from "../identity/membership-provisioning.service.js";
import { ACTIVE_WORKSPACE_CLOSURE_STATUSES } from "./workspace-closure.service.js";

export type WorkspaceLifecycleError = Error & {
  statusCode: number;
  code: string;
};

function lifecycleError(
  statusCode: number,
  code: string,
  message: string,
): WorkspaceLifecycleError {
  const err = new Error(message) as WorkspaceLifecycleError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const TEAM_LIFECYCLE_SELECT = {
  id: true,
  name: true,
  ownerUserId: true,
  billingOwnerUserId: true,
  isPersonal: true,
  workspaceKind: true,
  billingPlan: true,
  organizationId: true,
} as const;

/** §7.5 suspension marker — resume only reverts rows this action wrote. */
export const ORG_WORKSPACE_SUSPENSION_REASON = "organization workspace suspended";

/**
 * §7.4 — transfer ownership of an OWNED workspace. Fail-closed matrix:
 *   PERSONAL      → never transferable (the personal space IS the user);
 *   ORGANIZATION  → org-governed, not owner-transferable;
 *   UNKNOWN kind  → refused (classifier fail-closed contract);
 *   non-owner actor / inactive target → refused.
 */
export async function transferWorkspaceOwnership(input: {
  teamId: string;
  actorUserId: string;
  newOwnerUserId: string;
}): Promise<{ teamId: string; fromUserId: string; toUserId: string }> {
  const { teamId, actorUserId, newOwnerUserId } = input;

  const result = await prisma.$transaction(async (tx) => {
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: TEAM_LIFECYCLE_SELECT,
    });
    if (!team) {
      throw lifecycleError(404, "TEAM_NOT_FOUND", "Workspace not found");
    }
    const kind = resolveWorkspaceKind({
      teamLoaded: true,
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
    });
    if (kind === "PERSONAL") {
      throw lifecycleError(
        409,
        "PERSONAL_WORKSPACE_NOT_TRANSFERABLE",
        "A personal workspace cannot change owners",
      );
    }
    if (kind === "ORGANIZATION") {
      throw lifecycleError(
        409,
        "ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED",
        "Organization workspace ownership is governed at the organization level",
      );
    }
    if (kind !== "OWNED") {
      throw lifecycleError(
        409,
        "WORKSPACE_KIND_UNKNOWN",
        "Workspace kind could not be classified; transfer refused",
      );
    }
    if (team.ownerUserId !== actorUserId) {
      throw lifecycleError(
        403,
        "NOT_WORKSPACE_OWNER",
        "Only the workspace owner can transfer ownership",
      );
    }
    if (newOwnerUserId === actorUserId) {
      throw lifecycleError(
        409,
        "TRANSFER_TARGET_IS_OWNER",
        "The target user already owns this workspace",
      );
    }

    const roles = await transferWorkspaceOwnerRoles(tx, {
      teamId,
      fromUserId: actorUserId,
      toUserId: newOwnerUserId,
      actorUserId,
    });
    if (!roles.ok) {
      throw lifecycleError(
        409,
        "TRANSFER_TARGET_NOT_ACTIVE_MEMBER",
        "Ownership can only be transferred to an active workspace member",
      );
    }

    // Team-row swap: owner AND billing owner move together. Entitlement
    // rows stay attached to their users — the scope resolver reads the
    // team's (new) ownerUserId, which IS the billing transfer.
    await tx.team.update({
      where: { id: teamId },
      data: {
        ownerUserId: newOwnerUserId,
        billingOwnerUserId: newOwnerUserId,
      },
    });

    await tx.teamActivity.create({
      data: {
        teamId,
        actorUserId,
        eventType: "workspace_ownership_transferred",
        targetType: "team",
        targetId: teamId,
        metadata: { fromUserId: actorUserId, toUserId: newOwnerUserId },
      },
    });

    return { teamId, fromUserId: actorUserId, toUserId: newOwnerUserId };
  });

  await emitTenantAudit({
    action: "identity.workspace_ownership_transferred",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    workspaceId: teamId,
    resourceType: "team",
    resourceId: teamId,
    metadata: { fromUserId: actorUserId, toUserId: newOwnerUserId },
  }).catch(() => null);

  return result;
}

/**
 * §7.4 — reopen a workspace whose closure COMPLETED. Owner-only.
 * Restores ONLY the owner's membership; everything else stays dark.
 */
export async function reopenClosedWorkspace(input: {
  teamId: string;
  actorUserId: string;
}): Promise<{ teamId: string }> {
  const { teamId, actorUserId } = input;

  await prisma.$transaction(async (tx) => {
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: TEAM_LIFECYCLE_SELECT,
    });
    if (!team) {
      throw lifecycleError(404, "TEAM_NOT_FOUND", "Workspace not found");
    }
    if (team.ownerUserId !== actorUserId) {
      throw lifecycleError(
        403,
        "NOT_WORKSPACE_OWNER",
        "Only the workspace owner can reopen a closed workspace",
      );
    }
    const open = await tx.workspaceClosureRequest.findFirst({
      where: {
        teamId,
        status: { in: [...ACTIVE_WORKSPACE_CLOSURE_STATUSES] },
      },
      select: { id: true },
    });
    if (open) {
      throw lifecycleError(
        409,
        "CLOSURE_IN_PROGRESS",
        "A closure request is still open; cancel it instead of reopening",
      );
    }
    const completed = await tx.workspaceClosureRequest.findFirst({
      where: { teamId, status: "COMPLETED" },
      orderBy: { completedAtUtc: "desc" },
      select: { id: true },
    });
    if (!completed) {
      throw lifecycleError(
        409,
        "WORKSPACE_NOT_CLOSED",
        "This workspace has no completed closure to reopen from",
      );
    }

    await reopenWorkspaceOwnerMembership(tx, {
      teamId,
      ownerUserId: actorUserId,
      actorUserId,
    });

    // DELIBERATELY NOT RESTORED (safe-by-default reopen policy):
    //   * other members — REVOKED; the owner re-invites;
    //   * API credentials — REVOKED; secrets must be re-issued;
    //   * webhook endpoints — DISABLED; re-enabled explicitly.

    await tx.teamActivity.create({
      data: {
        teamId,
        actorUserId,
        eventType: "workspace_reopened",
        targetType: "team",
        targetId: teamId,
        metadata: { closureRequestId: completed.id },
      },
    });
  });

  await emitTenantAudit({
    action: "identity.workspace_reopened",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    workspaceId: teamId,
    resourceType: "team",
    resourceId: teamId,
    metadata: {},
  }).catch(() => null);

  return { teamId };
}

/**
 * §7.5 — suspend an ORGANIZATION workspace (reversible, org-admin action).
 * Every ACTIVE membership → SUSPENDED with the canonical marker reason;
 * switcher pointers into the workspace are cleared; webhook delivery is
 * paused (ACTIVE → DISABLED). Evidence/audit untouched; API credentials
 * keep their status (the enum is ACTIVE|REVOKED — revocation is
 * irreversible, so suspension does not burn them; workspace access checks
 * on ACTIVE TeamMember rows are the enforcement boundary).
 */
export async function suspendOrganizationWorkspace(input: {
  teamId: string;
  actorUserId: string;
  /** When set, the team MUST belong to this organization (fail-closed). */
  organizationId?: string;
}): Promise<{ teamId: string; membersSuspended: number }> {
  const { teamId, actorUserId } = input;

  const result = await prisma.$transaction(async (tx) => {
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: TEAM_LIFECYCLE_SELECT,
    });
    if (!team) {
      throw lifecycleError(404, "TEAM_NOT_FOUND", "Workspace not found");
    }
    if (
      input.organizationId !== undefined &&
      team.organizationId !== input.organizationId
    ) {
      throw lifecycleError(
        404,
        "TEAM_NOT_IN_ORGANIZATION",
        "Workspace does not belong to this organization",
      );
    }
    const kind = resolveWorkspaceKind({
      teamLoaded: true,
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
    });
    if (kind !== "ORGANIZATION") {
      throw lifecycleError(
        409,
        "NOT_ORGANIZATION_WORKSPACE",
        "Workspace-level suspension applies only to organization workspaces",
      );
    }

    const suspended = await massSuspendActiveMembers(tx, {
      teamId,
      actorUserId,
    });

    // Switcher/session effect: anyone parked on this workspace falls
    // back to their personal workspace on next platform-context load.
    await tx.user.updateMany({
      where: { currentWorkspaceId: teamId },
      data: { currentWorkspaceId: null },
    });

    // Pause webhook delivery while suspended.
    await tx.webhookEndpoint.updateMany({
      where: { teamId, status: "ACTIVE" },
      data: { status: "DISABLED" },
    });

    await tx.teamActivity.create({
      data: {
        teamId,
        actorUserId,
        eventType: "workspace_suspended",
        targetType: "team",
        targetId: teamId,
        metadata: { membersSuspended: suspended.count },
      },
    });

    return { teamId, membersSuspended: suspended.count };
  });

  await emitTenantAudit({
    action: "identity.workspace_suspended",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    organizationId: input.organizationId ?? null,
    workspaceId: teamId,
    resourceType: "team",
    resourceId: teamId,
    metadata: { membersSuspended: result.membersSuspended },
  }).catch(() => null);

  return result;
}

/**
 * §7.5 — resume a suspended ORGANIZATION workspace. Reactivates ONLY the
 * memberships THIS lifecycle action suspended (matched by the canonical
 * marker reason) — individually-suspended or revoked members are never
 * silently restored. Webhooks stay DISABLED (explicit re-enable), the
 * switcher repopulates naturally from ACTIVE memberships.
 */
export async function resumeOrganizationWorkspace(input: {
  teamId: string;
  actorUserId: string;
  /** When set, the team MUST belong to this organization (fail-closed). */
  organizationId?: string;
}): Promise<{ teamId: string; membersReactivated: number }> {
  const { teamId, actorUserId } = input;

  const result = await prisma.$transaction(async (tx) => {
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: TEAM_LIFECYCLE_SELECT,
    });
    if (!team) {
      throw lifecycleError(404, "TEAM_NOT_FOUND", "Workspace not found");
    }
    if (
      input.organizationId !== undefined &&
      team.organizationId !== input.organizationId
    ) {
      throw lifecycleError(
        404,
        "TEAM_NOT_IN_ORGANIZATION",
        "Workspace does not belong to this organization",
      );
    }

    const reactivated = await massReactivateSuspendedMembers(tx, {
      teamId,
      actorUserId,
    });

    await tx.teamActivity.create({
      data: {
        teamId,
        actorUserId,
        eventType: "workspace_resumed",
        targetType: "team",
        targetId: teamId,
        metadata: { membersReactivated: reactivated.count },
      },
    });

    return { teamId, membersReactivated: reactivated.count };
  });

  await emitTenantAudit({
    action: "identity.workspace_resumed",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    organizationId: input.organizationId ?? null,
    workspaceId: teamId,
    resourceType: "team",
    resourceId: teamId,
    metadata: { membersReactivated: result.membersReactivated },
  }).catch(() => null);

  return result;
}

async function massSuspendActiveMembers(
  tx: TxClient,
  input: { teamId: string; actorUserId: string },
): Promise<{ count: number }> {
  return massSuspendWorkspaceMemberships(tx, {
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    reason: ORG_WORKSPACE_SUSPENSION_REASON,
  });
}

async function massReactivateSuspendedMembers(
  tx: TxClient,
  input: { teamId: string; actorUserId: string },
): Promise<{ count: number }> {
  return massReactivateSuspendedWorkspaceMemberships(tx, {
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    matchReason: ORG_WORKSPACE_SUSPENSION_REASON,
  });
}
