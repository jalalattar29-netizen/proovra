import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { ensureEntitlement } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  type BillingWorkspaceScope,
  type WorkspaceScopeType,
  getEffectiveSeatLimit,
  assertWorkspacePlanCompatible,
} from "@proovra/shared-billing";

export type WorkspaceScope = {
  workspaceType: WorkspaceScopeType;
  ownerUserId: string;
  teamId: string | null;
  plan: prismaPkg.PlanType;
  credits: number;
  teamSeats: number;
  storageBytesOverride: bigint | null;
  activeStorageAddonBytes: bigint;
};

function toBillingWorkspaceScope(scope: WorkspaceScope): BillingWorkspaceScope {
  return {
    workspaceType: scope.workspaceType,
    ownerUserId: scope.ownerUserId,
    teamId: scope.teamId,
    plan: scope.plan,
    credits: scope.credits,
    teamSeats: scope.teamSeats,
  };
}

async function getActiveWorkspaceStorageAddonBytes(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<bigint> {
  const aggregate = await prisma.workspaceStorageAddon.aggregate({
    where: {
      ownerUserId: params.ownerUserId,
      teamId: params.teamId ?? null,
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
    _sum: {
      extraStorageBytes: true,
    },
  });

  return aggregate._sum.extraStorageBytes ?? 0n;
}

export async function getPersonalWorkspaceScope(
  userId: string
): Promise<WorkspaceScope> {
  const [entitlement, activeStorageAddonBytes] = await Promise.all([
    ensureEntitlement(userId),
    getActiveWorkspaceStorageAddonBytes({
      ownerUserId: userId,
      teamId: null,
    }),
  ]);

  const scope: WorkspaceScope = {
    workspaceType: "PERSONAL",
    ownerUserId: userId,
    teamId: null,
    plan: entitlement.plan,
    credits: entitlement.credits ?? 0,
    teamSeats: 0,
    storageBytesOverride: null,
    activeStorageAddonBytes,
  };

  assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
  return scope;
}

export async function getTeamWorkspaceScope(
  teamId: string
): Promise<WorkspaceScope> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      storageBytesOverride: true,
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  /**
   * Team workspace billing rules:
   *
   * - ACTIVE / PAST_DUE TEAM => effective TEAM
   * - Anything else => effective FREE
   *
   * This keeps the team workspace readable and manageable inside billing/settings
   * without pretending it has active TEAM entitlements.
   */
  const effectivePlan =
    team.billingStatus === prismaPkg.TeamBillingStatus.ACTIVE ||
    team.billingStatus === prismaPkg.TeamBillingStatus.PAST_DUE
      ? team.billingPlan
      : prismaPkg.PlanType.FREE;

  const activeStorageAddonBytes = await getActiveWorkspaceStorageAddonBytes({
    ownerUserId: team.ownerUserId,
    teamId: team.id,
  });

  const scope: WorkspaceScope = {
    workspaceType: "TEAM",
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    plan: effectivePlan,
    credits: 0,
    teamSeats: Math.max(0, team.includedSeats ?? 0),
    storageBytesOverride: team.storageBytesOverride ?? null,
    activeStorageAddonBytes,
  };

  assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
  return scope;
}

export async function resolveEvidenceWorkspaceScope(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId);
  }
  return getPersonalWorkspaceScope(params.ownerUserId);
}

export async function resolveWorkspaceScopeForUser(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  return resolveEvidenceWorkspaceScope(params);
}

export function getWorkspaceCapabilities(scope: WorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);
  const baseIncludedStorageBytes = caps.includedStorageBytes;
  const storageFromPlanAndAddons =
    baseIncludedStorageBytes + scope.activeStorageAddonBytes;

  const effectiveStorageBytesLimit =
    scope.storageBytesOverride &&
    scope.storageBytesOverride > storageFromPlanAndAddons
      ? scope.storageBytesOverride
      : storageFromPlanAndAddons;

  return {
    ...caps,
    workspaceType: scope.workspaceType,
    effectiveSeatLimit: getEffectiveSeatLimit(toBillingWorkspaceScope(scope)),
    baseIncludedStorageBytes,
    activeStorageAddonBytes: scope.activeStorageAddonBytes,
    storageBytesOverride: scope.storageBytesOverride,
    effectiveStorageBytesLimit,
  };
}