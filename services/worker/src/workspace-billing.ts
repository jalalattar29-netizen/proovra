import * as prismaPkg from "@prisma/client";
import { prisma } from "./db.js";
import { getPlanCapabilities } from "@proovra/shared-billing";

export type WorkerWorkspaceScope = {
  workspaceType: "PERSONAL" | "TEAM";
  ownerUserId: string;
  teamId: string | null;
  plan: prismaPkg.PlanType;
  credits: number;
  teamSeats: number;
  storageBytesOverride: bigint | null;
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

  return {
    workspaceType: "PERSONAL",
    ownerUserId,
    teamId: null,
    plan: entitlement?.plan ?? prismaPkg.PlanType.FREE,
    credits: entitlement?.credits ?? 0,
    teamSeats: entitlement?.teamSeats ?? 0,
    storageBytesOverride: null,
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
    },
  });

  if (!team) {
    throw new Error("TEAM_NOT_FOUND_FOR_EVIDENCE");
  }

  const effectivePlan =
    team.billingStatus === prismaPkg.TeamBillingStatus.ACTIVE ||
    team.billingStatus === prismaPkg.TeamBillingStatus.PAST_DUE
      ? team.billingPlan
      : prismaPkg.PlanType.FREE;

  return {
    workspaceType: "TEAM",
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    plan: effectivePlan,
    credits: 0,
    teamSeats: Math.max(0, team.includedSeats ?? 0),
    storageBytesOverride: team.storageBytesOverride ?? null,
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
    scope.teamId
      ? prisma.teamMember.count({
          where: { teamId: scope.teamId },
        })
      : Promise.resolve(0),
  ]);

  const evidenceStorageBytes = toBigIntOrZero(evidenceAggregate._sum.sizeBytes);
  const reportStorageBytes = toBigIntOrZero(reportAggregate._sum.sizeBytes);
  const verificationPackageStorageBytes = toBigIntOrZero(
    verificationPackageAggregate._sum.sizeBytes
  );

  const storageBytesUsed =
    evidenceStorageBytes + reportStorageBytes + verificationPackageStorageBytes;

  const storageBytesLimit =
    scope.storageBytesOverride && scope.storageBytesOverride > 0n
      ? scope.storageBytesOverride
      : caps.includedStorageBytes;

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
      workspaceType: params.scope.workspaceType,
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