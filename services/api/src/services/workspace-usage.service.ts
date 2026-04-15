import { prisma } from "../db.js";
import type { WorkspaceScope } from "./workspace-billing.service.js";
import {
  formatBytesHuman,
  getPlanCapabilities,
} from "./plan-catalog.service.js";

function toBigIntOrZero(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.max(0, Math.trunc(value)));
  }
  return 0n;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function ratioToPercent(value: number): number {
  return Number((clampRatio(value) * 100).toFixed(1));
}

export type WorkspaceUsage = {
  storageBytesUsed: bigint;
  evidenceStorageBytes: bigint;
  reportStorageBytes: bigint;
  verificationPackageStorageBytes: bigint;
  evidenceCount: number;
  teamMemberCount: number;
  storageBytesLimit: bigint;
  storageBytesRemaining: bigint;
  storageUsageRatio: number;
  storageUsagePercent: number;
  isNearStorageLimit: boolean;
  isStorageLimitReached: boolean;
  storageLabel: string;
  storageLimitLabel: string;
  storageRemainingLabel: string;
  seatLimit: number;
  seatRemaining: number;
  seatUsageRatio: number;
  seatUsagePercent: number;
  isNearSeatLimit: boolean;
  isSeatLimitReached: boolean;
};

export async function getWorkspaceUsage(
  scope: WorkspaceScope
): Promise<WorkspaceUsage> {
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

  const rawStorageRatio =
    storageBytesLimit > 0n
      ? Number(storageBytesUsed) / Number(storageBytesLimit)
      : 0;

  const storageUsageRatio = clampRatio(rawStorageRatio);
  const storageUsagePercent = ratioToPercent(rawStorageRatio);
  const isStorageLimitReached = storageBytesLimit > 0n && storageBytesUsed >= storageBytesLimit;
  const isNearStorageLimit = !isStorageLimitReached && storageUsageRatio >= 0.8;

  const seatLimit = scope.teamId
    ? Math.max(caps.includedSeats, scope.teamSeats || 0)
    : 0;

  const seatRemaining =
    seatLimit > teamMemberCount ? seatLimit - teamMemberCount : 0;

  const rawSeatRatio =
    seatLimit > 0 ? teamMemberCount / seatLimit : 0;

  const seatUsageRatio = clampRatio(rawSeatRatio);
  const seatUsagePercent = ratioToPercent(rawSeatRatio);
  const isSeatLimitReached = seatLimit > 0 && teamMemberCount >= seatLimit;
  const isNearSeatLimit = seatLimit > 0 && !isSeatLimitReached && seatUsageRatio >= 0.8;

  return {
    storageBytesUsed,
    evidenceStorageBytes,
    reportStorageBytes,
    verificationPackageStorageBytes,
    evidenceCount,
    teamMemberCount,
    storageBytesLimit,
    storageBytesRemaining,
    storageUsageRatio,
    storageUsagePercent,
    isNearStorageLimit,
    isStorageLimitReached,
    storageLabel: formatBytesHuman(storageBytesUsed),
    storageLimitLabel: formatBytesHuman(storageBytesLimit),
    storageRemainingLabel: formatBytesHuman(storageBytesRemaining),
    seatLimit,
    seatRemaining,
    seatUsageRatio,
    seatUsagePercent,
    isNearSeatLimit,
    isSeatLimitReached,
  };
}

export async function assertWorkspaceStorageAvailable(params: {
  scope: WorkspaceScope;
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
  const nextRatio =
    usage.storageBytesLimit > 0n
      ? Number(nextValue) / Number(usage.storageBytesLimit)
      : 0;

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
      plan: params.scope.plan,
      storageBytesUsed: usage.storageBytesUsed.toString(),
      storageBytesLimit: usage.storageBytesLimit.toString(),
      incomingBytes: incoming.toString(),
      storageLabel: usage.storageLabel,
      storageLimitLabel: usage.storageLimitLabel,
      storageUsagePercent: usage.storageUsagePercent,
      nextStorageUsagePercent: ratioToPercent(nextRatio),
    };
    throw err;
  }

  return usage;
}

export async function assertTeamSeatAvailable(scope: WorkspaceScope) {
  if (!scope.teamId) return;

  const usage = await getWorkspaceUsage(scope);
  const caps = getPlanCapabilities(scope.plan);
  const seatLimit = Math.max(caps.includedSeats, scope.teamSeats || 0);

  if (seatLimit <= 0) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Team plan required");
    err.statusCode = 409;
    err.code = "TEAM_PLAN_REQUIRED";
    err.details = {
      plan: scope.plan,
      workspaceType: scope.workspaceType,
      teamId: scope.teamId,
    };
    throw err;
  }

  if (usage.teamMemberCount >= seatLimit) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Team seat limit reached");
    err.statusCode = 409;
    err.code = "TEAM_SEAT_LIMIT_REACHED";
    err.details = {
      plan: scope.plan,
      teamId: scope.teamId,
      teamMemberCount: usage.teamMemberCount,
      seatLimit,
      seatUsagePercent: usage.seatUsagePercent,
    };
    throw err;
  }

  return {
    seatLimit,
    teamMemberCount: usage.teamMemberCount,
    seatRemaining: usage.seatRemaining,
    seatUsageRatio: usage.seatUsageRatio,
    seatUsagePercent: usage.seatUsagePercent,
    isNearSeatLimit: usage.isNearSeatLimit,
  };
}