import * as prismaPkg from "@prisma/client";
import { prisma } from "./db.js";
import {
  getPlanCapabilities,
  resolveWorkspaceEffectivePlan,
  type WorkspaceBillingStatus,
} from "@proovra/shared-billing";
// Domain classifier — single implementation in the general domain package.
import { normalizeWorkspaceKind } from "@proovra/shared";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat-occupancy authority,
// shared with the API so their arithmetic cannot diverge.
import { countActiveSeatOccupancy } from "@proovra/shared-runtime";

export type WorkerWorkspaceScope = {
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  ownerUserId: string;
  teamId: string | null;
  plan: prismaPkg.PlanType;
  credits: number;
  teamSeats: number;
  storageBytesOverride: bigint | null;
  activeStorageAddonBytes: bigint;
};

export type WorkerWorkspaceUsage = {
  storageBytesUsed: bigint;
  evidenceStorageBytes: bigint;
  reportStorageBytes: bigint;
  verificationPackageStorageBytes: bigint;
  evidenceCount: number;
  teamMemberCount: number;
  storageBytesLimit: bigint;
  storageBytesRemaining: bigint;
  storageUsageRatio: number;
};

function toBigIntOrZero(value: unknown): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.max(0, Math.trunc(value)));
  }

  return 0n;
}

async function getActiveStorageAddonBytes(params: {
  ownerUserId: string;
  teamId?: string | null;
}) {
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

  return toBigIntOrZero(aggregate._sum.extraStorageBytes);
}

export async function getPersonalWorkspaceScope(
  ownerUserId: string
): Promise<WorkerWorkspaceScope> {
  const entitlement = await prisma.entitlement.findFirst({
    where: {
      userId: ownerUserId,
      active: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      plan: true,
      credits: true,
      teamSeats: true,
    },
  });

  const activeStorageAddonBytes = await getActiveStorageAddonBytes({
    ownerUserId,
    teamId: null,
  });

  // PHASE 12 — POINT 7 (2026-08-05). This used to mirror the API's
  // PERSONAL-scope "PRO upgrade": a TEAM-plan owner's personal space resolved
  // at PRO in BOTH processes, kept in sync by a comment pointing at a line
  // number. Parity was the right instinct and the wrong mechanism — it was two
  // copies of a commercial decision, and the decision itself invented a plan
  // the account does not hold. The API no longer substitutes, so neither does
  // the worker: the owner's entitlement plan IS the personal scope's plan,
  // which keeps API and worker agreeing on `REPORT_NOT_INCLUDED_IN_PLAN`
  // because they now read the same fact rather than reproduce the same
  // workaround. (TEAM includes reports, so the mismatch this guarded against
  // cannot reappear.)
  const personalPlan = entitlement?.plan ?? prismaPkg.PlanType.FREE;

  return {
    billingShape: "SINGLE_OCCUPANT",
    ownerUserId,
    teamId: null,
    plan: personalPlan,
    credits: entitlement?.credits ?? 0,
    teamSeats: entitlement?.teamSeats ?? 0,
    storageBytesOverride: null,
    activeStorageAddonBytes,
  };
}

export async function getTeamWorkspaceScope(
  teamId: string
): Promise<WorkerWorkspaceScope> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      storageBytesOverride: true,
      // §9.4 corrected — subject-aware policy inputs.
      workspaceKind: true,
      isPersonal: true,
    },
  });

  if (!team) {
    throw new Error("TEAM_NOT_FOUND_FOR_EVIDENCE");
  }

  // PHASE 9 §9.4/§9.11 CORRECTED (2026-07-22) — the worker uses the SAME
  // subject-correct canonical pure policy as the API
  // (`resolveWorkspaceEffectivePlan` + `normalizeWorkspaceKind`,
  // shared-billing; one implementation each). OWNED workspaces resolve from
  // their OWN commercial state only; the owner's entitlement participates
  // ONLY for the PERSONAL workspace kind (the personal-space subject — this
  // is what keeps personal captures on auto-bootstrapped personal teams
  // resolving at the owner's real plan).
  const ownerEntitlement = await prisma.entitlement.findFirst({
    where: { userId: team.ownerUserId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  const ownerPlan = ownerEntitlement?.plan ?? prismaPkg.PlanType.FREE;
  const effectivePlan = resolveWorkspaceEffectivePlan({
    workspaceKind: normalizeWorkspaceKind({
      workspaceKind: (team as { workspaceKind?: string | null }).workspaceKind ?? null,
      isPersonal: (team as { isPersonal?: boolean | null }).isPersonal ?? null,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    }),
    billingPlan: team.billingPlan as prismaPkg.PlanType,
    billingStatus: team.billingStatus as WorkspaceBillingStatus,
    ownerPlan: ownerPlan as prismaPkg.PlanType,
  }).plan as prismaPkg.PlanType;

  const activeStorageAddonBytes = await getActiveStorageAddonBytes({
    ownerUserId: team.ownerUserId,
    teamId: team.id,
  });

  return {
    billingShape: "SHARED",
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    plan: effectivePlan,
    credits: 0,
    teamSeats: Math.max(0, team.includedSeats ?? 0),
    storageBytesOverride: team.storageBytesOverride ?? null,
    activeStorageAddonBytes,
  };
}

export async function resolveWorkspaceScopeForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkerWorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId);
  }

  return getPersonalWorkspaceScope(params.ownerUserId);
}

export async function resolveEffectivePlanForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<prismaPkg.PlanType> {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  return scope.plan;
}

export async function getWorkspaceUsage(
  scope: WorkerWorkspaceScope
): Promise<WorkerWorkspaceUsage> {
  const caps = getPlanCapabilities(scope.plan);

  const evidenceWhere = scope.teamId
    ? {
        teamId: scope.teamId,
        deletedAt: null,
      }
    : {
        ownerUserId: scope.ownerUserId,
        teamId: null,
        deletedAt: null,
      };

  const reportWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          deletedAt: null,
        },
      }
    : {
        evidence: {
          ownerUserId: scope.ownerUserId,
          teamId: null,
          deletedAt: null,
        },
      };

  const verificationPackageWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          deletedAt: null,
        },
      }
    : {
        evidence: {
          ownerUserId: scope.ownerUserId,
          teamId: null,
          deletedAt: null,
        },
      };

  const [
    evidenceAggregate,
    reportAggregate,
    verificationPackageAggregate,
    evidenceCount,
    teamMemberCount,
  ] = await Promise.all([
    prisma.evidence.aggregate({
      where: evidenceWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.report.aggregate({
      where: reportWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.verificationPackage.aggregate({
      where: verificationPackageWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.evidence.count({
      where: evidenceWhere,
    }),
    // PHASE 12 REMEDIATION — COMM-001 (2026-08-06). This counted EVERY
    // TeamMember row regardless of status, so worker-side seat
    // reconciliation overstated occupancy by every suspended and revoked
    // member. It now uses the ONE shared occupancy authority, identical to
    // the API's — the two can no longer report different numbers for the
    // same workspace.
    scope.teamId
      ? countActiveSeatOccupancy({ teamId: scope.teamId }, prisma)
      : Promise.resolve(0),
  ]);

  const evidenceStorageBytes = toBigIntOrZero(evidenceAggregate._sum.sizeBytes);
  const reportStorageBytes = toBigIntOrZero(reportAggregate._sum.sizeBytes);
  const verificationPackageStorageBytes = toBigIntOrZero(
    verificationPackageAggregate._sum.sizeBytes
  );

  const storageBytesUsed =
    evidenceStorageBytes + reportStorageBytes + verificationPackageStorageBytes;

const baseStorageBytesLimit = caps.includedStorageBytes;
const storageFromPlanAndAddons =
  baseStorageBytesLimit + scope.activeStorageAddonBytes;

const storageBytesLimit =
  scope.storageBytesOverride && scope.storageBytesOverride > 0n
    ? (scope.storageBytesOverride > storageFromPlanAndAddons
        ? scope.storageBytesOverride
        : storageFromPlanAndAddons)
    : storageFromPlanAndAddons;
    
  const storageBytesRemaining =
    storageBytesLimit > storageBytesUsed ? storageBytesLimit - storageBytesUsed : 0n;

  const ratio =
    storageBytesLimit > 0n
      ? Number(storageBytesUsed) / Number(storageBytesLimit)
      : 0;

  return {
    storageBytesUsed,
    evidenceStorageBytes,
    reportStorageBytes,
    verificationPackageStorageBytes,
    evidenceCount,
    teamMemberCount,
    storageBytesLimit,
    storageBytesRemaining,
    storageUsageRatio: Number.isFinite(ratio) ? ratio : 0,
  };
}

export async function assertWorkspaceStorageAvailable(params: {
  scope: WorkerWorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  const usage = await getWorkspaceUsage(params.scope);

  const incoming =
    typeof params.incomingBytes === "bigint"
      ? params.incomingBytes
      : typeof params.incomingBytes === "number" && Number.isFinite(params.incomingBytes)
        ? BigInt(Math.max(0, Math.trunc(params.incomingBytes)))
        : 0n;

  const nextValue = usage.storageBytesUsed + incoming;

  if (nextValue > usage.storageBytesLimit) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Storage limit reached");

    err.statusCode = 409;
    err.code = "STORAGE_LIMIT_REACHED";
    err.details = {
      billingShape: params.scope.billingShape,
      teamId: params.scope.teamId,
      ownerUserId: params.scope.ownerUserId,
      plan: params.scope.plan,
      storageBytesUsed: usage.storageBytesUsed.toString(),
      storageBytesLimit: usage.storageBytesLimit.toString(),
      incomingBytes: incoming.toString(),
      nextStorageBytes: nextValue.toString(),
      evidenceStorageBytes: usage.evidenceStorageBytes.toString(),
      reportStorageBytes: usage.reportStorageBytes.toString(),
      verificationPackageStorageBytes:
        usage.verificationPackageStorageBytes.toString(),
      activeStorageAddonBytes: params.scope.activeStorageAddonBytes.toString(),
    };

    throw err;
  }

  return usage;
}

export async function assertWorkspaceAllowsReportArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }

  const usage = await assertWorkspaceStorageAvailable({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });

  return {
    scope,
    usage,
  };
}

export async function assertWorkspaceAllowsVerificationPackageArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }

  const usage = await assertWorkspaceStorageAvailable({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });

  return {
    scope,
    usage,
  };
}