/**
 * WHAT RETENTION IS IN FORCE, ACROSS BOTH POLICY TABLES.
 *
 * Two tables hold retention policies, and both bind a record:
 *   - `evidence_retention_policies`, written from Governance → Retention, stamps a
 *     version on a record and sets its date.
 *   - `retention_policy_configs`, written from Evidence Lifecycle → Retention and
 *     the setup wizard, stands between a record and its destruction
 *     (destruction-barriers.service.ts reads it through `resolveEffectiveRetention`).
 *
 * Every posture number used to count only the first table, so a company whose
 * policy came from the setup wizard read "0 policies, 0% of workspaces" while that
 * policy was in force. A posture answers what is in force, so it counts both. Which
 * table should be the single authority is an open founder decision
 * (docs/architecture/lifecycle-domain-responsibilities.md, section 8a); this module
 * does not decide it, merges nothing and writes nothing.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type RetentionPostureRow = {
  id: string;
  teamId: string;
  displayName: string;
  scope: string;
  /** Null: indefinite, or set in years on a template policy. */
  retentionDays: number | null;
  /** Set on a template policy, which is stated in years. */
  retentionYears: number | null;
  immutable: boolean;
  source: "GOVERNANCE_POLICY" | "LIFECYCLE_TEMPLATE";
};

export type RetentionPosture = {
  /** Policies in force, whichever table holds them. */
  activePolicyCount: number;
  governancePolicyCount: number;
  lifecycleTemplateCount: number;
  /** Workspaces with at least one policy in force, in either table. */
  coveredTeamIds: string[];
};

export async function readRetentionPosture(
  teamIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPosture> {
  if (teamIds.length === 0) {
    return { activePolicyCount: 0, governancePolicyCount: 0, lifecycleTemplateCount: 0, coveredTeamIds: [] };
  }
  const [named, templates] = await Promise.all([
    client.evidenceRetentionPolicy.groupBy({
      by: ["teamId"],
      where: { teamId: { in: teamIds }, status: "ACTIVE" },
      _count: { _all: true },
    }),
    client.retentionPolicyConfig.groupBy({
      by: ["teamId"],
      where: { teamId: { in: teamIds }, state: "ACTIVE" },
      _count: { _all: true },
    }),
  ]);
  const governancePolicyCount = named.reduce((n, r) => n + r._count._all, 0);
  const lifecycleTemplateCount = templates.reduce((n, r) => n + r._count._all, 0);
  return {
    activePolicyCount: governancePolicyCount + lifecycleTemplateCount,
    governancePolicyCount,
    lifecycleTemplateCount,
    coveredTeamIds: [...new Set([...named, ...templates].map((r) => r.teamId))],
  };
}

/** The newest policies in force, across both tables. */
export async function readRetentionPostureSample(
  teamIds: string[],
  limit: number,
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPostureRow[]> {
  if (teamIds.length === 0) return [];
  const [named, templates] = await Promise.all([
    client.evidenceRetentionPolicy.findMany({
      where: { teamId: { in: teamIds }, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { id: true, teamId: true, displayName: true, scope: true, retentionDays: true, immutable: true, updatedAt: true },
    }),
    client.retentionPolicyConfig.findMany({
      where: { teamId: { in: teamIds }, state: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { id: true, teamId: true, name: true, scopeKind: true, years: true, updatedAt: true },
    }),
  ]);
  return [
    ...named.map((p) => ({
      at: p.updatedAt.getTime(),
      row: {
        id: p.id,
        teamId: p.teamId,
        displayName: p.displayName,
        scope: p.scope,
        retentionDays: p.retentionDays,
        retentionYears: null,
        immutable: p.immutable,
        source: "GOVERNANCE_POLICY" as const,
      },
    })),
    ...templates.map((p) => ({
      at: p.updatedAt.getTime(),
      row: {
        id: p.id,
        teamId: p.teamId,
        displayName: p.name,
        scope: p.scopeKind,
        retentionDays: null,
        retentionYears: p.years,
        immutable: false,
        source: "LIFECYCLE_TEMPLATE" as const,
      },
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((x) => x.row);
}
