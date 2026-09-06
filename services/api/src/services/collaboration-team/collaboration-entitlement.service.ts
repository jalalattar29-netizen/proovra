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
 * TWO NUMBERS, DELIBERATELY SEPARATE
 * =============================================================================
 *   workspaceSeats  — how many PEOPLE may hold active access to this workspace.
 *                     The owner is one. This is the commercial boundary.
 *   collaborationTeams — how many GROUPS those people may be organised into.
 *
 * They are not multiplied together and never have been. A person in five groups
 * is one seat. Conflating them is what produced a "team member limit" that
 * refused a workspace with seats to spare.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { getPlanCapabilities } from "@proovra/shared-billing";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";
import { resolveWorkspaceSeatState } from "../billing/workspace-seats.service.js";

export type CollaborationEntitlementProjection = {
  workspaceId: string;
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
    used: number;
    remaining: number;
    overLimit: boolean;
  };
  invitations: {
    pending: number;
    maxPending: number;
    maxPer24h: number;
  };
  /** Each dimension currently over its ceiling, named separately. */
  exceededDimensions: Array<"WORKSPACE_SEATS" | "COLLABORATION_TEAMS" | "PENDING_INVITATIONS">;
  upgradeHref: string | null;
};

export async function resolveCollaborationEntitlement(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<CollaborationEntitlementProjection> {
  const workspace = await client.team.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { ownerUserId: true },
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
  const teamsLimit = caps.maxCollaborationTeamsPerWorkspace;

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
      : null;

  return {
    workspaceId,
    plan: ctx.plan,
    featureIncluded: teamsLimit > 0,
    mutationsAllowed: ctx.lifecycle.mutationsAllowed,
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
    },
    invitations: {
      pending: pendingInvites,
      maxPending: caps.maxPendingInvitesPerTeam,
      maxPer24h: caps.maxInvitesPer24h,
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
