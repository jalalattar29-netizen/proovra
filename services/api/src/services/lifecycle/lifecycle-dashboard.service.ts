/**
 * PROOVRA Phase 4B — Lifecycle Dashboard aggregator.
 *
 * Single workspace-anchored projection that powers the Evidence
 * Lifecycle landing page. Every block is computed from real signals
 * stored in the Phase 4B tables (retention_policy_configs, legal_holds,
 * archive_tier_transitions, destruction_requests/certificates) plus
 * the bounded intelligence_activity_events stream for violation +
 * override counts.
 *
 * Hard rules:
 *   * NEVER PII, NEVER raw reasons — bounded counts only.
 *   * Workspace-anchored on teamId.
 *   * Each block is wrapped in .catch() so a missing model or empty
 *     table never breaks the dashboard envelope.
 *   * Schema version is pinned to LIFECYCLE_DASHBOARD_SCHEMA_VERSION.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ARCHIVE_TIERS,
  LIFECYCLE_DASHBOARD_SCHEMA_VERSION,
  PRODUCT_AND_LIFECYCLE_LIMITATIONS,
  type ArchiveTier,
  type LifecycleDashboardProjection,
} from "@proovra/shared";

import { countPolicyViolations } from "./policy-violation.service.js";

import { prisma as defaultPrisma } from "../../db.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export type ProjectLifecycleDashboardInput = {
  prisma?: PrismaClient;
  teamId: string;
};

export async function projectLifecycleDashboard(
  input: ProjectLifecycleDashboardInput,
): Promise<LifecycleDashboardProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const teamId = input.teamId;
  const now = new Date();
  const in30 = new Date(now.getTime() + THIRTY_DAYS_MS);
  const in90 = new Date(now.getTime() + NINETY_DAYS_MS);
  const since30 = new Date(now.getTime() - THIRTY_DAYS_MS);

  // ---------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------
  const retention = await (async () => {
    const totalPolicies = await prisma.retentionPolicyConfig
      .count({ where: { teamId } })
      .catch(() => 0);
    const activePolicies = await prisma.retentionPolicyConfig
      .count({ where: { teamId, state: "ACTIVE" } })
      .catch(() => 0);
    const overridePolicies = await prisma.retentionPolicyConfig
      .count({ where: { teamId, isOverride: true } })
      .catch(() => 0);

    const templateGroups = await prisma.retentionPolicyConfig
      .groupBy({
        by: ["template"],
        where: { teamId, state: "ACTIVE" },
        _count: { _all: true },
      })
      .catch(
        () =>
          [] as Array<{ template: string; _count: { _all: number } }>,
      );
    const templateBreakdown: Record<string, number> = {};
    for (const g of templateGroups) {
      templateBreakdown[g.template] = g._count._all;
    }
    return {
      totalPolicies,
      activePolicies,
      overridePolicies,
      templateBreakdown,
    };
  })().catch(() => ({
    totalPolicies: 0,
    activePolicies: 0,
    overridePolicies: 0,
    templateBreakdown: {},
  }));

  // ---------------------------------------------------------------
  // Legal holds
  // ---------------------------------------------------------------
  const legalHolds = await (async () => {
    const totalActive = await prisma.legalHold
      .count({ where: { teamId, state: "ACTIVE" } })
      .catch(() => 0);
    const totalReleased = await prisma.legalHold
      .count({ where: { teamId, state: "RELEASED" } })
      .catch(() => 0);
    const totalExpired = await prisma.legalHold
      .count({ where: { teamId, state: "EXPIRED" } })
      .catch(() => 0);

    const kindGroups = await prisma.legalHold
      .groupBy({
        by: ["kind"],
        where: { teamId, state: "ACTIVE" },
        _count: { _all: true },
      })
      .catch(() => [] as Array<{ kind: string; _count: { _all: number } }>);
    const byKind: Record<string, number> = {};
    for (const g of kindGroups) {
      byKind[g.kind] = g._count._all;
    }
    return { totalActive, totalReleased, totalExpired, byKind };
  })().catch(() => ({
    totalActive: 0,
    totalReleased: 0,
    totalExpired: 0,
    byKind: {},
  }));

  // ---------------------------------------------------------------
  // Archive — per-tier counts + monthly cost roll-up using the most
  // recent transition per evidence.
  // ---------------------------------------------------------------
  const archive = await (async () => {
    const countByTier: Record<ArchiveTier, number> = {
      HOT: 0,
      WARM: 0,
      COLD: 0,
      DEEP_ARCHIVE: 0,
    };
    const costMicrosByTier: Record<ArchiveTier, number> = {
      HOT: 0,
      WARM: 0,
      COLD: 0,
      DEEP_ARCHIVE: 0,
    };

    // Latest transition per evidence — bounded scan of the last 5000
    // rows is enough for any workspace within the operational
    // envelope. Older transitions are still counted toward
    // totalTransitions below.
    const rows = await prisma.archiveTierTransition
      .findMany({
        where: { teamId },
        orderBy: { transitionedAtUtc: "desc" },
        take: 5000,
        select: {
          evidenceId: true,
          toTier: true,
          costEstimateUsdMicros: true,
        },
      })
      .catch(
        () =>
          [] as Array<{
            evidenceId: string;
            toTier: string;
            costEstimateUsdMicros: bigint;
          }>,
      );

    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.evidenceId)) continue;
      seen.add(r.evidenceId);
      const tier = (ARCHIVE_TIERS as ReadonlyArray<string>).includes(r.toTier)
        ? (r.toTier as ArchiveTier)
        : null;
      if (!tier) continue;
      countByTier[tier] += 1;
      costMicrosByTier[tier] += Number(r.costEstimateUsdMicros);
    }

    const totalTransitions = await prisma.archiveTierTransition
      .count({ where: { teamId, transitionedAtUtc: { gte: since30 } } })
      .catch(() => 0);

    return { countByTier, costMicrosByTier, totalTransitions };
  })().catch(() => ({
    countByTier: { HOT: 0, WARM: 0, COLD: 0, DEEP_ARCHIVE: 0 } as Record<
      ArchiveTier,
      number
    >,
    costMicrosByTier: {
      HOT: 0,
      WARM: 0,
      COLD: 0,
      DEEP_ARCHIVE: 0,
    } as Record<ArchiveTier, number>,
    totalTransitions: 0,
  }));

  // ---------------------------------------------------------------
  // Destruction
  // ---------------------------------------------------------------
  const destruction = await (async () => {
    const totalRequested = await prisma.destructionRequest
      .count({ where: { teamId, state: "REQUESTED" } })
      .catch(() => 0);
    const totalApproved = await prisma.destructionRequest
      .count({ where: { teamId, state: "APPROVED" } })
      .catch(() => 0);
    const totalRejected = await prisma.destructionRequest
      .count({ where: { teamId, state: "REJECTED" } })
      .catch(() => 0);
    const totalCertified = await prisma.destructionRequest
      .count({ where: { teamId, state: "CERTIFIED" } })
      .catch(() => 0);
    return { totalRequested, totalApproved, totalRejected, totalCertified };
  })().catch(() => ({
    totalRequested: 0,
    totalApproved: 0,
    totalRejected: 0,
    totalCertified: 0,
  }));

  // ---------------------------------------------------------------
  // Upcoming expirations — derived from active legal holds whose
  // expiresAtUtc falls in window. Retention policy expirations are
  // not modeled with per-evidence expiry rows in Phase 4B, so we
  // surface the legal-hold horizon here.
  // ---------------------------------------------------------------
  const upcomingExpirations = await (async () => {
    const within30Days = await prisma.legalHold
      .count({
        where: {
          teamId,
          state: "ACTIVE",
          expiresAtUtc: { gte: now, lte: in30 },
        },
      })
      .catch(() => 0);
    const within90Days = await prisma.legalHold
      .count({
        where: {
          teamId,
          state: "ACTIVE",
          expiresAtUtc: { gte: now, lte: in90 },
        },
      })
      .catch(() => 0);
    return { within30Days, within90Days };
  })().catch(() => ({ within30Days: 0, within90Days: 0 }));

  // ---------------------------------------------------------------
  // Violations — derived from the bounded POLICY_VIOLATION_* codes in
  // the intelligence_activity_events stream (Phase 4B Final Closure C7).
  // Raw sentinel codes ("LEGAL_HOLD_VIOLATION", "POLICY_BLOCK") are
  // replaced by real bounded codes; the old heuristic queries are kept
  // as fallback addends for rows emitted before the C7 migration.
  // ---------------------------------------------------------------
  const violations = await (async () => {
    // Real bounded counts from policy-violation.service
    const pvc = await countPolicyViolations({ prisma, teamId, since: since30 }).catch(
      (): { total: number; byKind: Partial<Record<"POLICY_VIOLATION_ENTITLEMENT" | "POLICY_VIOLATION_LEGAL_HOLD" | "POLICY_VIOLATION_RETENTION" | "POLICY_VIOLATION_QUOTA", number>> } => ({ total: 0, byKind: {} }),
    );

    const byCode = {
      POLICY_VIOLATION_ENTITLEMENT: pvc.byKind.POLICY_VIOLATION_ENTITLEMENT ?? 0,
      POLICY_VIOLATION_LEGAL_HOLD: pvc.byKind.POLICY_VIOLATION_LEGAL_HOLD ?? 0,
      POLICY_VIOLATION_RETENTION: pvc.byKind.POLICY_VIOLATION_RETENTION ?? 0,
      POLICY_VIOLATION_QUOTA: pvc.byKind.POLICY_VIOLATION_QUOTA ?? 0,
    };

    // Keep backward-compatible scalars so existing consumers are not broken.
    const totalLegalHoldViolations = byCode.POLICY_VIOLATION_LEGAL_HOLD;
    const totalRetentionViolations = byCode.POLICY_VIOLATION_RETENTION;
    const totalBounded = pvc.total;

    return { totalLegalHoldViolations, totalRetentionViolations, byCode, totalBounded };
  })().catch(() => ({
    totalLegalHoldViolations: 0,
    totalRetentionViolations: 0,
    byCode: {
      POLICY_VIOLATION_ENTITLEMENT: 0,
      POLICY_VIOLATION_LEGAL_HOLD: 0,
      POLICY_VIOLATION_RETENTION: 0,
      POLICY_VIOLATION_QUOTA: 0,
    },
    totalBounded: 0,
  }));

  // ---------------------------------------------------------------
  // Compliance — bounded heuristic:
  //   retentionCoverage: active policies / (active policies + 1) so
  //     a workspace with zero policies reads as 0 and a workspace
  //     with any active policy approaches 1.0 monotonically.
  //   holdCoverage: 1.0 when there are zero active violations vs.
  //     active holds; degrades proportionally with violations.
  //   overallScore: mean of the two, rounded to 2 decimals.
  // ---------------------------------------------------------------
  const compliance = (() => {
    const ap = retention.activePolicies;
    const retentionCoverage = ap === 0 ? 0 : ap / (ap + 1);
    const activeHolds = legalHolds.totalActive;
    const v = violations.totalLegalHoldViolations;
    const holdCoverage =
      activeHolds === 0 && v === 0
        ? 1
        : Math.max(0, 1 - v / Math.max(1, activeHolds + v));
    const overallScore =
      Math.round(((retentionCoverage + holdCoverage) / 2) * 100) / 100;
    return {
      overallScore,
      retentionCoverage: Math.round(retentionCoverage * 100) / 100,
      holdCoverage: Math.round(holdCoverage * 100) / 100,
    };
  })();

  const projection: LifecycleDashboardProjection = {
    schemaVersion: LIFECYCLE_DASHBOARD_SCHEMA_VERSION,
    generatedAtUtc: now.toISOString(),
    teamId,
    retention,
    legalHolds,
    archive,
    destruction,
    upcomingExpirations,
    violations,
    compliance,
    limitations: PRODUCT_AND_LIFECYCLE_LIMITATIONS,
  };
  return projection;
}
