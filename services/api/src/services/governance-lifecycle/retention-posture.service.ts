/**
 * WHAT RETENTION IS IN FORCE — ONE STORE (GOV-005 / RETENTION-TWO-TABLES).
 *
 * Retention policies live in `evidence_retention_policies`, the store the record
 * binding reads (`packages/shared-runtime/src/evidence-retention/policy-binding.ts`).
 * Policies created from Evidence Lifecycle → Retention and the setup wizard are
 * written there too (lifecycle/retention-engine.service.ts), and the rows of the
 * retired `retention_policy_configs` table were copied there by migration
 * 20281119100100. A lifecycle-page policy is recognised by the template marker
 * in its description and still reported as LIFECYCLE_TEMPLATE, so the posture
 * numbers keep saying where each policy came from; they no longer add two
 * tables, because there is one.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

/** The description prefix a lifecycle-page policy carries. */
export const LIFECYCLE_TEMPLATE_MARKER = "lifecycle-template:";

export type RetentionPostureRow = {
  id: string;
  teamId: string;
  displayName: string;
  scope: string;
  /** Null: indefinite. */
  retentionDays: number | null;
  /** Set on a lifecycle-template policy, which is stated in years. */
  retentionYears: number | null;
  immutable: boolean;
  source: "GOVERNANCE_POLICY" | "LIFECYCLE_TEMPLATE";
};

export type RetentionPosture = {
  /** Policies in force. */
  activePolicyCount: number;
  governancePolicyCount: number;
  lifecycleTemplateCount: number;
  /** Workspaces with at least one policy in force. */
  coveredTeamIds: string[];
};

const isTemplate = (description: string | null) => Boolean(description?.startsWith(LIFECYCLE_TEMPLATE_MARKER));

export async function readRetentionPosture(
  teamIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPosture> {
  if (teamIds.length === 0) {
    return { activePolicyCount: 0, governancePolicyCount: 0, lifecycleTemplateCount: 0, coveredTeamIds: [] };
  }
  const rows = await client.evidenceRetentionPolicy.findMany({
    where: { teamId: { in: teamIds }, status: "ACTIVE" },
    select: { teamId: true, description: true },
  });
  const lifecycleTemplateCount = rows.filter((r) => isTemplate(r.description)).length;
  return {
    activePolicyCount: rows.length,
    governancePolicyCount: rows.length - lifecycleTemplateCount,
    lifecycleTemplateCount,
    coveredTeamIds: [...new Set(rows.map((r) => r.teamId))],
  };
}

/** The newest policies in force. */
export async function readRetentionPostureSample(
  teamIds: string[],
  limit: number,
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPostureRow[]> {
  if (teamIds.length === 0) return [];
  const rows = await client.evidenceRetentionPolicy.findMany({
    where: { teamId: { in: teamIds }, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, teamId: true, displayName: true, description: true, scope: true, retentionDays: true, immutable: true },
  });
  return rows.map((p) => {
    const template = isTemplate(p.description);
    return {
      id: p.id,
      teamId: p.teamId,
      displayName: p.displayName,
      scope: p.scope,
      retentionDays: p.retentionDays,
      retentionYears: template && p.retentionDays !== null ? Math.round((p.retentionDays / 365.25) * 100) / 100 : null,
      immutable: p.immutable,
      source: template ? ("LIFECYCLE_TEMPLATE" as const) : ("GOVERNANCE_POLICY" as const),
    };
  });
}
