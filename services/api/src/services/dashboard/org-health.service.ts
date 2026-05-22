/**
 * Phase 32.8C FINAL-3 — Organizational Health Snapshot writer + reader.
 *
 * Computes a bounded 0..100 health score per workspace from real
 * counters: open incidents, active workflows, resolved-in-7d, queue
 * snapshot freshness, audit-readiness counter, reviewer overload.
 *
 * Hard rules:
 *   - No fake scores. Every dimension is a deterministic count-based
 *     ratio with documented thresholds.
 *   - Writer failures NEVER block evidence/report/package/verify flows.
 *   - Bounded operator-safe metadata; no raw payloads.
 */

import { prisma } from "../../db.js";

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function recordOrgHealthSnapshotForWorkspace(input: {
  teamId: string;
}): Promise<{ persisted: boolean; failed: boolean }> {
  try {
    // Real counters
    const [
      openIncidents,
      criticalIncidents,
      activeWorkflows,
      resolvedWorkflows7d,
      failedWorkflows,
      queueSamples7d,
      reviewerCriticalCount,
      reviewerWorkloadCount,
      auditBlockerWorkflows,
      reportBacklog,
      packageBacklog,
    ] = await Promise.all([
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId: input.teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
      }),
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId: input.teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          severity: "CRITICAL",
        },
      }),
      prisma.operationalWorkflow
        .count({
          where: {
            teamId: input.teamId,
            status: {
              in: [
                "OPEN",
                "ASSIGNED",
                "IN_PROGRESS",
                "WAITING_ON_SYSTEM",
                "WAITING_ON_REVIEWER",
                "WAITING_ON_GOVERNANCE",
                "MITIGATING",
                "FAILED",
              ],
            },
          },
        })
        .catch(() => 0),
      prisma.operationalWorkflow
        .count({
          where: {
            teamId: input.teamId,
            status: "RESOLVED",
            updatedAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        })
        .catch(() => 0),
      prisma.operationalWorkflow
        .count({
          where: { teamId: input.teamId, status: "FAILED" },
        })
        .catch(() => 0),
      prisma.queueTelemetrySnapshot
        .count({
          where: {
            teamId: input.teamId,
            sampledAtUtc: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        })
        .catch(() => 0),
      prisma.reviewerCapacitySnapshot
        .count({
          where: { teamId: input.teamId, saturationLevel: "CRITICAL" },
        })
        .catch(() => 0),
      prisma.reviewerCapacitySnapshot
        .count({ where: { teamId: input.teamId } })
        .catch(() => 0),
      prisma.operationalWorkflow
        .count({
          where: {
            teamId: input.teamId,
            workflowType: { in: ["AUDIT_READINESS", "EXPORT_BLOCKER_RESOLUTION"] },
            status: {
              in: [
                "OPEN",
                "ASSIGNED",
                "IN_PROGRESS",
                "WAITING_ON_REVIEWER",
                "WAITING_ON_GOVERNANCE",
                "MITIGATING",
                "FAILED",
              ],
            },
          },
        })
        .catch(() => 0),
      prisma.evidence
        .count({
          where: {
            teamId: input.teamId,
            status: "SIGNED",
            latestReportVersion: null,
          },
        })
        .catch(() => 0),
      prisma.evidence
        .count({
          where: {
            teamId: input.teamId,
            status: "REPORTED",
            verificationPackageVersion: null,
          },
        })
        .catch(() => 0),
    ]);

    // Deterministic scoring (0..100). Penalties are bounded so a single
    // signal can't push a score arbitrarily negative.
    const healthScore = clamp100(
      100 -
        Math.min(50, openIncidents * 3) -
        Math.min(30, criticalIncidents * 10) -
        Math.min(20, failedWorkflows * 5),
    );
    const operationalMaturityScore = clamp100(
      100 -
        Math.min(40, activeWorkflows * 2) -
        Math.min(20, failedWorkflows * 5) +
        Math.min(20, Math.floor(resolvedWorkflows7d / 2)),
    );
    const governanceMaturityScore = clamp100(
      100 - Math.min(60, auditBlockerWorkflows * 8),
    );
    const auditReadinessScore = clamp100(
      100 -
        Math.min(50, auditBlockerWorkflows * 8) -
        Math.min(30, packageBacklog * 1),
    );
    const reviewerMaturityScore = clamp100(
      100 -
        Math.min(50, reviewerCriticalCount * 12) -
        Math.min(20, Math.max(0, reviewerWorkloadCount - 5)),
    );
    const queueReliabilityScore = clamp100(
      queueSamples7d > 0 ? 80 + Math.min(20, queueSamples7d) : 50,
    );
    const artifactReliabilityScore = clamp100(
      100 - Math.min(60, reportBacklog) - Math.min(40, packageBacklog),
    );

    await prisma.organizationalHealthSnapshot.create({
      data: {
        teamId: input.teamId,
        workspaceId: input.teamId,
        healthScore,
        operationalMaturityScore,
        governanceMaturityScore,
        auditReadinessScore,
        reviewerMaturityScore,
        incidentFrequency7d: openIncidents,
        workflowCompletion7d: resolvedWorkflows7d,
        queueReliabilityScore,
        artifactReliabilityScore,
        source: "DB_DERIVED",
      },
    });
    return { persisted: true, failed: false };
  } catch {
    return { persisted: false, failed: true };
  }
}

export async function getLatestOrgHealthSnapshot(input: {
  teamId: string;
}): Promise<{
  healthScore: number | null;
  operationalMaturityScore: number | null;
  governanceMaturityScore: number | null;
  auditReadinessScore: number | null;
  reviewerMaturityScore: number | null;
  incidentFrequency7d: number | null;
  workflowCompletion7d: number | null;
  queueReliabilityScore: number | null;
  artifactReliabilityScore: number | null;
  sampledAtUtc: string | null;
}> {
  try {
    const row = await prisma.organizationalHealthSnapshot.findFirst({
      where: { teamId: input.teamId },
      orderBy: { sampledAtUtc: "desc" },
      select: {
        healthScore: true,
        operationalMaturityScore: true,
        governanceMaturityScore: true,
        auditReadinessScore: true,
        reviewerMaturityScore: true,
        incidentFrequency7d: true,
        workflowCompletion7d: true,
        queueReliabilityScore: true,
        artifactReliabilityScore: true,
        sampledAtUtc: true,
      },
    });
    if (!row) {
      return {
        healthScore: null,
        operationalMaturityScore: null,
        governanceMaturityScore: null,
        auditReadinessScore: null,
        reviewerMaturityScore: null,
        incidentFrequency7d: null,
        workflowCompletion7d: null,
        queueReliabilityScore: null,
        artifactReliabilityScore: null,
        sampledAtUtc: null,
      };
    }
    return {
      ...row,
      sampledAtUtc: row.sampledAtUtc.toISOString(),
    };
  } catch {
    return {
      healthScore: null,
      operationalMaturityScore: null,
      governanceMaturityScore: null,
      auditReadinessScore: null,
      reviewerMaturityScore: null,
      incidentFrequency7d: null,
      workflowCompletion7d: null,
      queueReliabilityScore: null,
      artifactReliabilityScore: null,
      sampledAtUtc: null,
    };
  }
}
