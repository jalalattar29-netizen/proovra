import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import type { WorkspaceScope } from "./workspace-billing.service.js";
import {
  resolveEffectiveBaseStorageBytes,
  resolveEffectiveContractSeats,
} from "./billing/enterprise-contract-limits.js";
import {
  formatBytesHuman,
  getPlanCapabilities,
} from "./plan-catalog.service.js";

const GB = 1024n * 1024n * 1024n;

type StorageAddonOffer = {
  key: prismaPkg.StorageAddonKey;
  label: string;
  storageBytes: bigint;
  priceCents: number;
  currency: string;
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
};

const STORAGE_ADDON_OFFERS: readonly StorageAddonOffer[] = [
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_10_GB,
    label: "+10 GB",
    storageBytes: 10n * GB,
    priceCents: 299,
    currency: "EUR",
    billingShape: "SINGLE_OCCUPANT",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_50_GB,
    label: "+50 GB",
    storageBytes: 50n * GB,
    priceCents: 799,
    currency: "EUR",
    billingShape: "SINGLE_OCCUPANT",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_200_GB,
    label: "+200 GB",
    storageBytes: 200n * GB,
    priceCents: 1999,
    currency: "EUR",
    billingShape: "SINGLE_OCCUPANT",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_100_GB,
    label: "+100 GB",
    storageBytes: 100n * GB,
    priceCents: 999,
    currency: "EUR",
    billingShape: "SHARED",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_500_GB,
    label: "+500 GB",
    storageBytes: 500n * GB,
    priceCents: 3499,
    currency: "EUR",
    billingShape: "SHARED",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_1_TB,
    label: "+1 TB",
    storageBytes: 1024n * GB,
    priceCents: 5999,
    currency: "EUR",
    billingShape: "SHARED",
  },
] as const;

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

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — offers follow the TIER.
 *
 * This selected the SHARED catalog whenever the workspace was shared, which
 * meant the TEAM storage offers were reachable only from a separate workspace.
 * A customer on TEAM — a tier of their own Personal Workspace — was shown the
 * PRO catalog, or nothing at all.
 *
 * The offer catalog is a property of what the customer BOUGHT, so it is keyed
 * on the plan. The `billingShape` on each offer row stays as the catalog's own
 * grouping label; it is no longer read as a statement about the workspace.
 */
/**
 * Which storage add-ons a PLAN may buy.
 *
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — EXPORTED, because the
 * Billing projection was answering the same question a second time and
 * getting a different answer.
 *
 * It keyed its own list on the billing SHAPE, and a personal workspace is
 * SINGLE_OCCUPANT whatever tier it is on — so a TEAM customer was offered the
 * PRO catalogue (+10/+50/+200 GB) instead of theirs (+100/+500 GB/+1 TB).
 * Shape was the right key while TEAM meant a shared workspace; it stopped
 * being right the moment TEAM became a tier of the personal one.
 */
export function storageAddonOffersForPlan(plan: prismaPkg.PlanType) {
  switch (plan) {
    case prismaPkg.PlanType.TEAM:
      // The TEAM catalog: +100 GB, +500 GB, +1 TB. On the Personal subject.
      return STORAGE_ADDON_OFFERS.filter(
        (offer) => offer.billingShape === "SHARED",
      );

    case prismaPkg.PlanType.PRO:
      // The PRO catalog: +10 GB, +50 GB, +200 GB.
      return STORAGE_ADDON_OFFERS.filter(
        (offer) => offer.billingShape === "SINGLE_OCCUPANT",
      );

    case prismaPkg.PlanType.PAYG:
      // The grandfathered credit-overlay row keeps the two offers it has
      // always had. It buys no NEW recurring storage — the Billing surface
      // explains that recurring add-ons need PRO or TEAM.
      return STORAGE_ADDON_OFFERS.filter(
        (offer) =>
          offer.key === prismaPkg.StorageAddonKey.PERSONAL_10_GB ||
          offer.key === prismaPkg.StorageAddonKey.PERSONAL_50_GB,
      );

    // FREE buys no recurring storage, and ENTERPRISE is contract-managed:
    // an Organization's capacity comes from its contract, never a
    // self-service catalogue.
    default:
      return [];
  }
}

function getAvailableStorageAddonOffers(scope: WorkspaceScope) {
  return storageAddonOffersForPlan(scope.plan);
}

function getSuggestedUpgradePlan(
  scope: WorkspaceScope
): prismaPkg.PlanType | null {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — ENTERPRISE is the only
  // plan with no self-service next step. It used to be "any shared workspace",
  // which silenced the upgrade path for TEAM.
  if (scope.plan === prismaPkg.PlanType.ENTERPRISE) {
    return null;
  }

  if (
    scope.plan === prismaPkg.PlanType.FREE ||
    scope.plan === prismaPkg.PlanType.PAYG
  ) {
    return prismaPkg.PlanType.PRO;
  }

  if (scope.plan === prismaPkg.PlanType.PRO) {
    return prismaPkg.PlanType.TEAM;
  }

  return null;
}

/**
 * The seat ceiling for a workspace.
 *
 * WORKSPACE AND COLLABORATION RECONCILIATION — this reads `maxWorkspaceSeats`
 * from the catalog directly rather than `scope.teamSeats`.
 *
 * `scope.teamSeats` is written by `getEffectiveSeatLimit`, which returns 0 for
 * any non-SHARED billing shape. That was the right instinct under the old model
 * — a Personal Space with one occupant has no seats to sell — and it is wrong
 * under the approved one, where PRO seats five people and TEAM ten in exactly
 * that workspace. Worse, this function then took a `max()` over the catalog and
 * discarded the 0 anyway, so the projection and the gate disagreed about the
 * same workspace in the same request.
 *
 * There is now ONE rule and `resolveWorkspaceSeatState` states it. This helper
 * remains only because `getWorkspaceUsage` composes a synchronous scope object;
 * it reads the SAME catalog field and applies the SAME contract override, so it
 * cannot answer differently.
 */
function getTeamMemberLimit(scope: WorkspaceScope): number {
  if (!scope.teamId) {
    return 0;
  }

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a contracted seat count is
  // the ceiling, not one input to a `max()`. Maxing a contract against a
  // catalog placeholder would have silently granted seats nobody bought.
  return resolveEffectiveContractSeats({
    plan: scope.plan,
    contract: scope.contractLimits,
    // The catalog seat entitlement for the workspace's own plan. NOT
    // `scope.teamSeats`, which the shape-based projection may have zeroed.
    persistedSeats: getPlanCapabilities(scope.plan).maxWorkspaceSeats,
  });
}

export type WorkspaceUsage = {
  storageBytesUsed: bigint;
  evidenceStorageBytes: bigint;
  reportStorageBytes: bigint;
  verificationPackageStorageBytes: bigint;
  evidenceCount: number;
  teamMemberCount: number;

  baseStorageBytesLimit: bigint;
  extraStorageAddonBytes: bigint;
  storageBytesOverride: bigint | null;
  storageBytesLimit: bigint;
  storageBytesRemaining: bigint;

  storageUsageRatio: number;
  storageUsagePercent: number;
  isNearStorageLimit: boolean;
  isStorageLimitReached: boolean;

  storageLabel: string;
  storageLimitLabel: string;
  storageRemainingLabel: string;
  baseStorageLimitLabel: string;
  extraStorageAddonLabel: string;

  seatLimit: number;
  seatRemaining: number;
  seatUsageRatio: number;
  seatUsagePercent: number;
  isNearSeatLimit: boolean;
  isSeatLimitReached: boolean;

  suggestedUpgradePlan: prismaPkg.PlanType | null;
  availableStorageAddons: Array<{
    key: prismaPkg.StorageAddonKey;
    label: string;
    storageBytes: string;
    storageLabel: string;
    priceCents: number;
    currency: string;
  }>;
};

export async function getWorkspaceUsage(
  scope: WorkspaceScope
): Promise<WorkspaceUsage> {
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the plan-capabilities local
  // was removed. The one value this function still took from it — the base
  // storage limit — is now resolved contract-first by
  // `resolveEffectiveBaseStorageBytes`, and keeping the local would have left a
  // second, catalog-only candidate answer sitting beside it.

  // Phase HOME-DATA-OWNERSHIP — personal usage covers BOTH legacy rows
  // (team_id NULL) and rows stamped with the owner's personal Team id
  // (new captures + backfilled rows). Without the OR, every backfilled
  // byte would silently vanish from personal storage accounting.
  // (Evidence has no `team` relation field, so the personal team id is
  // resolved first.)
  // STORAGE ACCOUNTING — EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24).
  //
  // These filters excluded `deletedAt != null`, so a record stopped counting
  // toward the workspace's storage the moment a user moved it to trash. Nothing
  // had left the bucket: trash is recoverable and the objects sit there for the
  // full 90-day grace window and then for however long retention, Object Lock
  // or a legal hold keeps them — which can be years. A workspace could
  // therefore trash its way under quota while its actual stored bytes never
  // moved, and the invoice, the quota gate and the bucket all disagreed.
  //
  // The line is now DESTROYED, which is the only state in which the bytes are
  // provably gone: the canonical executor writes it after verifying the objects
  // no longer exist. ACTIVE, ARCHIVED and TRASHED all consume storage, because
  // they all are storage.
  const personalTeamForUsage = scope.teamId
    ? null
    : await prisma.team.findFirst({
        where: { ownerUserId: scope.ownerUserId, isPersonal: true },
        select: { id: true },
      });
  const personalEvidenceWhere = {
    ownerUserId: scope.ownerUserId,
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — see STORAGE ACCOUNTING
    // below. Only a DESTROYED tombstone stops consuming storage.
    lifecycleState: { not: "DESTROYED" as const },
    OR: [
      { teamId: null },
      ...(personalTeamForUsage ? [{ teamId: personalTeamForUsage.id }] : []),
    ],
  };

  const evidenceWhere = scope.teamId
    ? {
        teamId: scope.teamId,
        lifecycleState: { not: "DESTROYED" as const },
      }
    : personalEvidenceWhere;

  const reportWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          lifecycleState: { not: "DESTROYED" as const },
        },
      }
    : {
        evidence: personalEvidenceWhere,
      };

  const verificationPackageWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          lifecycleState: { not: "DESTROYED" as const },
        },
      }
    : {
        evidence: personalEvidenceWhere,
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
          // P5 domain remediation (2026-07-21) — a seat is an ACTIVE
          // member. Suspended/revoked members no longer consume license
          // seats (matches the stated business rule: "we limit actual
          // members", and a suspended member is denied all access).
          where: { teamId: scope.teamId, status: "ACTIVE" },
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

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a contracted storage figure
  // is the base capacity. It was previously ignored: every Enterprise
  // workspace was enforced at the flat 500 GB catalog placeholder no matter
  // what its contract said.
  const baseStorageBytesLimit = resolveEffectiveBaseStorageBytes({
    plan: scope.plan,
    contract: scope.contractLimits,
  });
  const extraStorageAddonBytes = scope.activeStorageAddonBytes ?? 0n;
  const storageBytesOverride = scope.storageBytesOverride ?? null;

  const storageFromPlanAndAddons =
    baseStorageBytesLimit + extraStorageAddonBytes;

  const storageBytesLimit =
    storageBytesOverride && storageBytesOverride > 0n
      ? maxBigInt(storageBytesOverride, storageFromPlanAndAddons)
      : storageFromPlanAndAddons;

  const storageBytesRemaining =
    storageBytesLimit > storageBytesUsed
      ? storageBytesLimit - storageBytesUsed
      : 0n;

  const rawStorageRatio =
    storageBytesLimit > 0n
      ? Number(storageBytesUsed) / Number(storageBytesLimit)
      : 0;

  const storageUsageRatio = clampRatio(rawStorageRatio);
  const storageUsagePercent = ratioToPercent(rawStorageRatio);
  const isStorageLimitReached =
    storageBytesLimit > 0n && storageBytesUsed >= storageBytesLimit;
  const isNearStorageLimit = !isStorageLimitReached && storageUsageRatio >= 0.8;

  /**
   * Important business rule:
   * We limit actual members in a team, not invitations.
   * The effective member limit comes from plan capabilities, not invite count.
   */
  const seatLimit = getTeamMemberLimit(scope);

  const seatRemaining =
    seatLimit > teamMemberCount ? seatLimit - teamMemberCount : 0;

  const rawSeatRatio = seatLimit > 0 ? teamMemberCount / seatLimit : 0;

  const seatUsageRatio = clampRatio(rawSeatRatio);
  const seatUsagePercent = ratioToPercent(rawSeatRatio);
  const isSeatLimitReached = seatLimit > 0 && teamMemberCount >= seatLimit;
  const isNearSeatLimit =
    seatLimit > 0 && !isSeatLimitReached && seatUsageRatio >= 0.8;

  const availableStorageAddons = getAvailableStorageAddonOffers(scope).map(
    (offer) => ({
      key: offer.key,
      label: offer.label,
      storageBytes: offer.storageBytes.toString(),
      storageLabel: formatBytesHuman(offer.storageBytes),
      priceCents: offer.priceCents,
      currency: offer.currency,
    })
  );

  return {
    storageBytesUsed,
    evidenceStorageBytes,
    reportStorageBytes,
    verificationPackageStorageBytes,
    evidenceCount,
    teamMemberCount,

    baseStorageBytesLimit,
    extraStorageAddonBytes,
    storageBytesOverride,
    storageBytesLimit,
    storageBytesRemaining,

    storageUsageRatio,
    storageUsagePercent,
    isNearStorageLimit,
    isStorageLimitReached,

    storageLabel: formatBytesHuman(storageBytesUsed),
    storageLimitLabel: formatBytesHuman(storageBytesLimit),
    storageRemainingLabel: formatBytesHuman(storageBytesRemaining),
    baseStorageLimitLabel: formatBytesHuman(baseStorageBytesLimit),
    extraStorageAddonLabel: formatBytesHuman(extraStorageAddonBytes),

    seatLimit,
    seatRemaining,
    seatUsageRatio,
    seatUsagePercent,
    isNearSeatLimit,
    isSeatLimitReached,

    suggestedUpgradePlan: getSuggestedUpgradePlan(scope),
    availableStorageAddons,
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
      billingShape: params.scope.billingShape,
      teamId: params.scope.teamId,
      plan: params.scope.plan,
      storageBytesUsed: usage.storageBytesUsed.toString(),
      storageBytesLimit: usage.storageBytesLimit.toString(),
      baseStorageBytesLimit: usage.baseStorageBytesLimit.toString(),
      extraStorageAddonBytes: usage.extraStorageAddonBytes.toString(),
      storageBytesOverride: usage.storageBytesOverride?.toString() ?? null,
      incomingBytes: incoming.toString(),
      storageLabel: usage.storageLabel,
      storageLimitLabel: usage.storageLimitLabel,
      storageUsagePercent: usage.storageUsagePercent,
      nextStorageUsagePercent: ratioToPercent(nextRatio),
      suggestedUpgradePlan: usage.suggestedUpgradePlan,
      availableStorageAddons: usage.availableStorageAddons,
      actions: {
        canAddStorage: usage.availableStorageAddons.length > 0,
        canUpgradePlan: usage.suggestedUpgradePlan !== null,
        canReviewArchivedEvidence: true,
      },
    };
    throw err;
  }

  return usage;
}

export async function assertTeamSeatAvailable(scope: WorkspaceScope) {
  if (!scope.teamId) return;

  const usage = await getWorkspaceUsage(scope);
  const seatLimit = getTeamMemberLimit(scope);

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
      billingShape: scope.billingShape,
      teamId: scope.teamId,
    };
    throw err;
  }

  if (usage.teamMemberCount >= seatLimit) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Team member limit reached");
    err.statusCode = 409;
    err.code = "TEAM_SEAT_LIMIT_REACHED";
    err.details = {
      plan: scope.plan,
      teamId: scope.teamId,
      teamMemberCount: usage.teamMemberCount,
      seatLimit,
      seatUsagePercent: usage.seatUsagePercent,
      maxMembersPerTeam: seatLimit,
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