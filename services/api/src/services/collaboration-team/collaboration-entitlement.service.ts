/**
 * THE commercial projection for the Collaboration Teams surface.
 *
 * =============================================================================
 * WHY A PROJECTION AND NOT A CALCULATION
 * =============================================================================
 * The console used to work its own capacity out of whatever the API happened to
 * return: `team?.maxMembersPerTeam ?? team?.includedSeats ?? 5`. `includedSeats`
 * is a raw column that is 0 on every workspace Enterprise provisioning did not
 * write, so a 1,005-member workspace on the TEAM plan rendered "the actual
 * member cap is 0 per team" and "Members: 1005 / 0 · 0 remaining". The browser
 * was a limit authority, and it was wrong.
 *
 * Everything the surface needs to render a capacity, a lock, an upgrade prompt
 * or a restriction notice is decided here, once, from the canonical authorities,
 * and sent as answers rather than as inputs.
 *
 * =============================================================================
 * WCR-06 (2026-09-07) — AND THE SURFACE NOW ACTUALLY READS IT
 * =============================================================================
 * The paragraph above was true of this file and false of the product. This
 * endpoint had ZERO consumers in `apps/web`: the page went on reading
 * `useWorkspaceLimits()`, which projects raw `PLAN_CAPABILITIES` integers with
 * no contract, no seat state, no lifecycle and no restriction reason. Two
 * commercial projections described one page and the weaker one won.
 *
 * An authority nobody calls is not an authority. The list page, the create
 * affordance, the capacity badge and the Members tab now all read this, and
 * `useWorkspaceLimits` is confined to nav gating where a plan-shaped boolean is
 * all that is needed.
 *
 * =============================================================================
 * TWO NUMBERS, DELIBERATELY SEPARATE
 * =============================================================================
 *   workspaceSeats  — how many PEOPLE may hold active access to this workspace.
 *                     The owner is one. This is the commercial boundary.
 *   collaborationTeams — how many GROUPS those people may be organised into.
 *
 * They are not multiplied together and never have been. A person in five groups
 * is one seat. Conflating them is what produced a "team member limit" that
 * refused a workspace with seats to spare.
 *
 * =============================================================================
 * WCR-05 — WORKSPACE-WIDE, NOT VIEWER-WIDE
 * =============================================================================
 * `collaborationTeams.used` counts every ACTIVE group in the WORKSPACE. The
 * list endpoint returns only the groups the viewer participates in, which is
 * the right rule for a participation view and the wrong number for a capacity
 * badge — a member of one of a workspace's two groups was shown "1 of 2", given
 * an enabled Create button, and met a 409. Capacity is a fact about the
 * workspace; membership is a fact about the viewer.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { getPlanCapabilities } from "@proovra/shared-billing";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";
import { resolveWorkspaceSeatState } from "../billing/workspace-seats.service.js";
import {
  resolveEffectiveCollaborationMemberLimit,
  resolveEffectiveCollaborationTeamLimit,
} from "../billing/enterprise-contract-limits.js";

export type CollaborationEntitlementProjection = {
  workspaceId: string;
  /** PERSONAL | OWNED | ORGANIZATION — the persisted discriminator, not a guess. */
  workspaceKind: string;
  /** Effective plan governing this WORKSPACE (never the viewer's own plan). */
  plan: string;
  /** Is the Collaboration Teams feature part of this workspace's plan at all? */
  featureIncluded: boolean;
  /** May the actor's workspace perform growth mutations right now? */
  mutationsAllowed: boolean;
  lifecycle: {
    state: string;
    /** Bounded reason for a restriction, or null when unrestricted. */
    reasonCode: string | null;
    graceEndsAtUtc: Date | null;
  };
  workspaceSeats: {
    limit: number;
    used: number;
    remaining: number;
    /** Usage above the ceiling — a downgrade, not an error. */
    overLimit: boolean;
    source: string;
  };
  collaborationTeams: {
    limit: number;
    /** ACTIVE groups in the WORKSPACE — not the viewer's page, not their memberships. */
    used: number;
    remaining: number;
    overLimit: boolean;
    /** PLAN_CATALOG or ENTERPRISE_CONTRACT — which authority set `limit`. */
    source: string;
  };
  /** Safety ceiling on ACTIVE members inside ONE group, contract-first. */
  collaborationTeamMembers: {
    limit: number;
    source: string;
  };
  invitations: {
    pending: number;
    maxPending: number;
    maxPer24h: number;
  };
  /**
   * Server-decided affordances. The browser renders these; it does not derive
   * them. Each is the same predicate its gate enforces, so an enabled control
   * and a 2xx cannot drift apart.
   */
  canCreateCollaborationTeam: boolean;
  canInviteWorkspaceMember: boolean;
  canAssignExistingMember: boolean;
  /**
   * WCR-6A — workspace-wide governance visibility.
   *
   * Enumerating every group in the workspace is an ADMINISTRATIVE act, distinct
   * from participating in one. `canViewAllTeams` is the server's answer to "may
   * this actor see the whole directory?", decided by the canonical workspace
   * permission and NOT by group membership — the alternative, quietly making
   * every OWNER a member of every group, would grant Discussion and Assignment
   * participation as a side effect of administration.
   */
  governance: {
    canViewAllTeams: boolean;
    /** Every ACTIVE group in the workspace, whoever is in them. */
    allTeamsCount: number;
  };
  /** Each dimension currently over its ceiling, named separately. */
  exceededDimensions: Array<"WORKSPACE_SEATS" | "COLLABORATION_TEAMS" | "PENDING_INVITATIONS">;
  upgradeHref: string | null;
};

export async function resolveCollaborationEntitlement(
  workspaceId: string,
  options: { canViewAllTeams?: boolean } = {},
  client: PrismaClient = defaultPrisma,
): Promise<CollaborationEntitlementProjection> {
  const workspace = await client.team.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { ownerUserId: true, workspaceKind: true },
  });

  const [ctx, seats, teamsUsed, pendingInvites] = await Promise.all([
    resolveCommercialContext({
      type: "WORKSPACE",
      teamId: workspaceId,
      requesterUserId: workspace.ownerUserId,
    }),
    resolveWorkspaceSeatState(workspaceId, client),
    client.collaborationTeam.count({
      where: { workspaceId, status: "ACTIVE", archivedAtUtc: null },
    }),
    client.teamInvite.count({
      where: {
        teamId: workspaceId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);

  const caps = getPlanCapabilities(ctx.plan);
  /**
   * WCR-07 — CONTRACT FIRST, on both collaboration dimensions.
   *
   * This read `caps.maxCollaborationTeamsPerWorkspace` directly, which is a
   * flat 1000 on the ENTERPRISE row — a placeholder standing in for "a lot",
   * not a term anybody signed. `seats.contractLimits` is the status-checked
   * projection the seat resolver already computed (it fails closed on DRAFT /
   * SUSPENDED / TERMINATED), so reading it here is one resolution rather than
   * a second one that could disagree.
   */
  const teamsLimit = resolveEffectiveCollaborationTeamLimit({
    plan: ctx.plan,
    contract: seats.contractLimits,
  });
  const teamsSource =
    seats.contractLimits.contractGovernsCapability &&
    seats.contractLimits.collaborationTeams !== null
      ? "ENTERPRISE_CONTRACT"
      : "PLAN_CATALOG";
  const memberLimit = resolveEffectiveCollaborationMemberLimit({
    plan: ctx.plan,
    contract: seats.contractLimits,
  });
  const memberSource =
    seats.contractLimits.contractGovernsCapability &&
    seats.contractLimits.collaborationTeamMembers !== null
      ? "ENTERPRISE_CONTRACT"
      : "PLAN_CATALOG";

  const exceeded: CollaborationEntitlementProjection["exceededDimensions"] = [];
  if (seats.overLimit) exceeded.push("WORKSPACE_SEATS");
  if (teamsUsed > teamsLimit) exceeded.push("COLLABORATION_TEAMS");
  if (pendingInvites > caps.maxPendingInvitesPerTeam) {
    exceeded.push("PENDING_INVITATIONS");
  }

  /**
   * A restriction has to name itself.
   *
   * "Something went wrong" and "your plan does not include this" and "payment
   * needs attention" are three different situations with three different next
   * actions, and the surface can only say the right one if the server tells it
   * which happened.
   */
  const reasonCode = !ctx.lifecycle.mutationsAllowed
    ? ctx.lifecycle.state
    : teamsLimit <= 0
      ? "PLAN_DOES_NOT_INCLUDE_TEAMS"
      : teamsUsed >= teamsLimit
        ? "COLLABORATION_TEAM_LIMIT_REACHED"
        : null;

  const mutationsAllowed = ctx.lifecycle.mutationsAllowed;

  return {
    workspaceId,
    workspaceKind: String(workspace.workspaceKind),
    plan: ctx.plan,
    featureIncluded: teamsLimit > 0,
    mutationsAllowed,
    lifecycle: {
      state: ctx.lifecycle.state,
      reasonCode,
      graceEndsAtUtc: ctx.lifecycle.graceEndsAtUtc,
    },
    workspaceSeats: {
      limit: seats.limit,
      used: seats.used,
      remaining: seats.remaining,
      overLimit: seats.overLimit,
      source: seats.source,
    },
    collaborationTeams: {
      limit: teamsLimit,
      used: teamsUsed,
      remaining: Math.max(0, teamsLimit - teamsUsed),
      overLimit: teamsUsed > teamsLimit,
      source: teamsSource,
    },
    collaborationTeamMembers: {
      // Reconciled to the workspace's real population for the same reason the
      // guard reconciles it: a group may hold everyone in the workspace and
      // cannot hold anyone else, so a ceiling above the seat count would be a
      // number no group could ever reach.
      limit: Math.max(0, Math.min(Math.max(seats.limit, seats.used), memberLimit)),
      source: memberSource,
    },
    invitations: {
      pending: pendingInvites,
      maxPending: caps.maxPendingInvitesPerTeam,
      maxPer24h: caps.maxInvitesPer24h,
    },
    /**
     * The three affordances the surface renders, decided here.
     *
     * `canCreateCollaborationTeam` mirrors `assertCanCreateCollaborationTeam`
     * exactly — feature included, lifecycle permits growth, and the WORKSPACE
     * is under its ceiling. The old page computed the last term from the
     * viewer's own group count and therefore enabled a button the server was
     * always going to refuse.
     */
    canCreateCollaborationTeam:
      teamsLimit > 0 && mutationsAllowed && teamsUsed < teamsLimit,
    canInviteWorkspaceMember:
      seats.featureIncluded && mutationsAllowed && seats.used < seats.limit,
    // Assigning an EXISTING workspace member to a group consumes no seat, so it
    // is bounded only by the group ceiling and the lifecycle — never by seats.
    canAssignExistingMember: teamsLimit > 0 && mutationsAllowed,
    governance: {
      canViewAllTeams: options.canViewAllTeams === true,
      allTeamsCount: teamsUsed,
    },
    exceededDimensions: exceeded,
    // Only offered when upgrading is actually the remedy. A workspace blocked
    // by a suspended organization contract is not fixed by a checkout page.
    upgradeHref:
      reasonCode === "PLAN_DOES_NOT_INCLUDE_TEAMS" || exceeded.length > 0
        ? "/billing"
        : null,
  };
}
