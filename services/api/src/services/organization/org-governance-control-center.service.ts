/**
 * Phase 5 (Enterprise Governance) — Organization Governance Control Center
 * aggregator service.
 *
 * Powers the single read-only org-admin console endpoint
 * `GET /v1/orgs/:id/governance/control-center`, which the
 * `organizations/[id]/admin/governance` tab renders as the canonical
 * evidence-Governance Control Center.
 *
 * WHY an aggregate (vs. client fan-out like the Phase-4 overview tab):
 *   The rich governance signals (legal holds, retention policies,
 *   destruction reviews, external-review grants, blocked-export
 *   metadata) live on WORKSPACE-scoped tables (`team_id`) and their
 *   REST reads are gated on WORKSPACE membership + workspace
 *   permissions. An org-admin does NOT necessarily hold membership in
 *   every workspace under the org, so the org console cannot fan out to
 *   the per-workspace endpoints. This aggregate resolves the org's
 *   workspaces (Team.organizationId) under a SINGLE org-level gate
 *   (ORG_AUDITOR+) and projects bounded, read-only posture counts +
 *   samples across them.
 *
 * Hard rules (mirrors governance-control-plane.service.ts):
 *   - READ ONLY. No Prisma writes. NEVER emits audit / security events.
 *   - Bounded queries (counts + small samples only).
 *   - Per-section try/catch. A failed section degrades to
 *     `status: "unavailable"` with null data — it NEVER crashes the
 *     whole envelope and NEVER fabricates a metric.
 *   - NEVER returns secrets, tokens, storage keys, signed URLs,
 *     evidence bytes, reviewer emails, or payment instruments.
 *   - NEVER weakens governance — projection only.
 */

import { prisma } from "../../db.js";

export type SectionStatus = "ok" | "degraded" | "unavailable";

export type OrgGovernanceControlCenterEnvelope = {
  organizationId: string;
  generatedAt: string;
  /** Non-personal workspaces bound to this org that the aggregate spans. */
  scope: {
    workspaceCount: number;
  };
  sections: {
    /** Active legal holds across the org's workspaces. */
    legalHolds: {
      status: SectionStatus;
      data: {
        activeCount: number;
        activeCaseHoldCount: number;
        /** Distinct evidence records currently under an active hold. */
        evidenceUnderHoldCount: number;
        sample: Array<{
          id: string;
          teamId: string;
          evidenceId: string;
          title: string;
          reason: string | null;
          placedAtUtc: string;
        }>;
      } | null;
    };
    /** Active workspace retention policies + org retention template. */
    retention: {
      status: SectionStatus;
      data: {
        activePolicyCount: number;
        /** Workspaces that have at least one ACTIVE retention policy. */
        workspacesWithPolicyCount: number;
        /** Org-level retention template published (Phase B0). */
        orgTemplatePublished: boolean;
        sample: Array<{
          id: string;
          teamId: string;
          displayName: string;
          scope: string;
          retentionDays: number | null;
          immutable: boolean;
        }>;
      } | null;
    };
    /** Destruction reviews pending an approval decision. */
    destruction: {
      status: SectionStatus;
      data: {
        pendingCount: number;
        sample: Array<{
          id: string;
          teamId: string;
          evidenceId: string;
          status: string;
          reason: string;
          createdAt: string;
        }>;
      } | null;
    };
    /** External-sharing under governance — active external-review grants. */
    externalSharing: {
      status: SectionStatus;
      data: {
        activeGrantCount: number;
      } | null;
    };
    /** Recent org governance audit events (org-scoped, forensic feed). */
    audit: {
      status: SectionStatus;
      data: {
        recentCount: number;
        events: Array<{
          id: string;
          eventType: string;
          targetType: string | null;
          createdAt: string;
        }>;
      } | null;
    };
    /**
     * Read-only chain-of-custody / coverage health indicators, derived
     * from the counts above. Honest — never a synthetic "healthy" badge.
     */
    coverage: {
      status: SectionStatus;
      data: {
        /** Workspaces spanned by the org governance boundary. */
        workspaceCount: number;
        /** Workspaces with an ACTIVE retention policy (retention coverage). */
        retentionCoveredWorkspaceCount: number;
        /** Whether an org retention template backs uncovered workspaces. */
        orgTemplatePublished: boolean;
        /** True while any active legal hold is preserving evidence. */
        legalHoldActive: boolean;
        /** Destruction reviews awaiting a two-person decision. */
        pendingDestructionCount: number;
      } | null;
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded limits — samples only; the UI renders counts + a short preview.
// ---------------------------------------------------------------------------

const HOLDS_SAMPLE_LIMIT = 20;
const RETENTION_SAMPLE_LIMIT = 20;
const DESTRUCTION_SAMPLE_LIMIT = 20;
const AUDIT_SAMPLE_LIMIT = 20;
const WORKSPACE_SPAN_LIMIT = 500;

const RETENTION_POLICY_KEY = "retention.default";

/** Destruction-review statuses that mean "awaiting a decision". */
const PENDING_DESTRUCTION_STATUSES = ["PENDING", "UNDER_REVIEW"] as const;

/** External-review grant states that count as "active governance sharing". */
const ACTIVE_GRANT_STATES = ["INVITED", "ACTIVE"] as const;

/**
 * Resolve the non-personal workspace ids bound to an organization. This
 * is the org → workspace fan-out set every section aggregates over.
 */
async function resolveOrgWorkspaceIds(orgId: string): Promise<string[]> {
  const rows = await prisma.team.findMany({
    where: { organizationId: orgId, isPersonal: false },
    select: { id: true },
    take: WORKSPACE_SPAN_LIMIT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

export async function buildOrgGovernanceControlCenter(input: {
  orgId: string;
}): Promise<OrgGovernanceControlCenterEnvelope> {
  const teamIds = await resolveOrgWorkspaceIds(input.orgId);
  const hasWorkspaces = teamIds.length > 0;

  // ----------- Legal holds -----------
  let legalHolds: OrgGovernanceControlCenterEnvelope["sections"]["legalHolds"] =
    { status: "unavailable", data: null };
  let activeLegalHoldCount = 0;
  let activeCaseHoldCount = 0;
  let evidenceUnderHoldCount = 0;
  try {
    if (!hasWorkspaces) {
      legalHolds = {
        status: "ok",
        data: {
          activeCount: 0,
          activeCaseHoldCount: 0,
          evidenceUnderHoldCount: 0,
          sample: [],
        },
      };
    } else {
      const [count, holds, distinctEvidence] = await Promise.all([
        prisma.evidenceLegalHold.count({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
        }),
        prisma.evidenceLegalHold.findMany({
          // PHASE 12B CLUSTER 8 — explicit EVIDENCE scope: this sample names
          // records, so a nullable-target CASE / WORKSPACE hold must not
          // appear in it. `activeCaseHoldCount` covers the case half.
          where: {
            teamId: { in: teamIds },
            status: "ACTIVE",
            scope: "EVIDENCE",
            evidenceId: { not: null },
          },
          orderBy: { placedAtUtc: "desc" },
          take: HOLDS_SAMPLE_LIMIT,
          select: {
            id: true,
            teamId: true,
            evidenceId: true,
            title: true,
            reason: true,
            placedAtUtc: true,
          },
        }),
        prisma.evidenceLegalHold.findMany({
          where: {
            teamId: { in: teamIds },
            status: "ACTIVE",
            scope: "EVIDENCE",
            evidenceId: { not: null },
          },
          select: { evidenceId: true },
          distinct: ["evidenceId"],
        }),
      ]);
      activeLegalHoldCount = count;
      evidenceUnderHoldCount = distinctEvidence.length;

      // Case-level holds are an OPTIONAL Phase 14 subsystem — count them
      // best-effort and never let a schema-drift error fail the section.
      try {
        activeCaseHoldCount = await prisma.evidenceLegalHold.count({
          // P12.3 canonical-only (scope='CASE').
          where: { scope: "CASE", teamId: { in: teamIds }, status: "ACTIVE" },
        });
      } catch {
        activeCaseHoldCount = 0;
      }

      legalHolds = {
        status: "ok",
        data: {
          activeCount: activeLegalHoldCount,
          activeCaseHoldCount,
          evidenceUnderHoldCount,
          sample: holds
            .filter((h): h is typeof h & { evidenceId: string } =>
              typeof h.evidenceId === "string",
            )
            .map((h) => ({
            id: h.id,
            teamId: h.teamId,
            evidenceId: h.evidenceId,
            title: h.title,
            reason: h.reason,
            placedAtUtc: h.placedAtUtc.toISOString(),
          })),
        },
      };
    }
  } catch {
    legalHolds = { status: "unavailable", data: null };
  }

  // ----------- Retention -----------
  let retention: OrgGovernanceControlCenterEnvelope["sections"]["retention"] = {
    status: "unavailable",
    data: null,
  };
  let retentionCoveredWorkspaceCount = 0;
  let orgTemplatePublished = false;
  try {
    // Org-level retention template (Phase B0 org policy KV row).
    try {
      const template = await prisma.organizationPolicy.findUnique({
        where: {
          organization_policies_org_key_uniq: {
            organizationId: input.orgId,
            key: RETENTION_POLICY_KEY,
          },
        },
        select: { id: true },
      });
      orgTemplatePublished = !!template;
    } catch {
      orgTemplatePublished = false;
    }

    if (!hasWorkspaces) {
      retention = {
        status: "ok",
        data: {
          activePolicyCount: 0,
          workspacesWithPolicyCount: 0,
          orgTemplatePublished,
          sample: [],
        },
      };
    } else {
      const [count, policies, coveredGroups] = await Promise.all([
        prisma.evidenceRetentionPolicy.count({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
        }),
        prisma.evidenceRetentionPolicy.findMany({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
          orderBy: { updatedAt: "desc" },
          take: RETENTION_SAMPLE_LIMIT,
          select: {
            id: true,
            teamId: true,
            displayName: true,
            scope: true,
            retentionDays: true,
            immutable: true,
          },
        }),
        prisma.evidenceRetentionPolicy.findMany({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
          select: { teamId: true },
          distinct: ["teamId"],
        }),
      ]);
      retentionCoveredWorkspaceCount = coveredGroups.length;
      retention = {
        status: "ok",
        data: {
          activePolicyCount: count,
          workspacesWithPolicyCount: retentionCoveredWorkspaceCount,
          orgTemplatePublished,
          sample: policies.map((p) => ({
            id: p.id,
            teamId: p.teamId,
            displayName: p.displayName,
            scope: p.scope,
            retentionDays: p.retentionDays,
            immutable: p.immutable,
          })),
        },
      };
    }
  } catch {
    retention = { status: "unavailable", data: null };
  }

  // ----------- Destruction reviews (pending decision) -----------
  let destruction: OrgGovernanceControlCenterEnvelope["sections"]["destruction"] =
    { status: "unavailable", data: null };
  let pendingDestructionCount = 0;
  try {
    if (!hasWorkspaces) {
      destruction = { status: "ok", data: { pendingCount: 0, sample: [] } };
    } else {
      const [count, rows] = await Promise.all([
        prisma.destructionReview.count({
          where: {
            teamId: { in: teamIds },
            status: { in: [...PENDING_DESTRUCTION_STATUSES] },
          },
        }),
        prisma.destructionReview.findMany({
          where: {
            teamId: { in: teamIds },
            status: { in: [...PENDING_DESTRUCTION_STATUSES] },
          },
          orderBy: { createdAt: "desc" },
          take: DESTRUCTION_SAMPLE_LIMIT,
          select: {
            id: true,
            teamId: true,
            evidenceId: true,
            status: true,
            reason: true,
            createdAt: true,
          },
        }),
      ]);
      pendingDestructionCount = count;
      destruction = {
        status: "ok",
        data: {
          pendingCount: count,
          sample: rows.map((r) => ({
            id: r.id,
            teamId: r.teamId,
            evidenceId: r.evidenceId,
            status: r.status,
            reason: r.reason,
            createdAt: r.createdAt.toISOString(),
          })),
        },
      };
    }
  } catch {
    destruction = { status: "unavailable", data: null };
  }

  // ----------- External-sharing under governance -----------
  //
  // `external_review_grants` is accessed via raw SQL elsewhere in the
  // codebase; count active grants across the org's workspaces with a
  // bounded parameterized query. Degrades to `unavailable` on any error
  // (e.g. table not deployed) rather than fabricating a count.
  let externalSharing: OrgGovernanceControlCenterEnvelope["sections"]["externalSharing"] =
    { status: "unavailable", data: null };
  try {
    if (!hasWorkspaces) {
      externalSharing = { status: "ok", data: { activeGrantCount: 0 } };
    } else {
      const rows = (await prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM "external_review_grants"
        WHERE "team_id" = ANY(${teamIds}::uuid[])
          AND "state" = ANY(${[...ACTIVE_GRANT_STATES]}::text[])
      `) as Array<{ count: number }>;
      const activeGrantCount = rows[0]?.count ?? 0;
      externalSharing = { status: "ok", data: { activeGrantCount } };
    }
  } catch {
    externalSharing = { status: "unavailable", data: null };
  }

  // ----------- Recent org governance audit -----------
  let audit: OrgGovernanceControlCenterEnvelope["sections"]["audit"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const rows = await prisma.organizationAuditEvent.findMany({
      where: { organizationId: input.orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_SAMPLE_LIMIT,
      select: {
        id: true,
        eventType: true,
        targetType: true,
        createdAt: true,
      },
    });
    audit = {
      status: "ok",
      data: {
        recentCount: rows.length,
        events: rows.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          targetType: e.targetType ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      },
    };
  } catch {
    audit = { status: "unavailable", data: null };
  }

  // ----------- Coverage / custody health (derived, honest) -----------
  const coverage: OrgGovernanceControlCenterEnvelope["sections"]["coverage"] = {
    status:
      retention.status === "unavailable" && legalHolds.status === "unavailable"
        ? "unavailable"
        : "ok",
    data:
      retention.status === "unavailable" && legalHolds.status === "unavailable"
        ? null
        : {
            workspaceCount: teamIds.length,
            retentionCoveredWorkspaceCount,
            orgTemplatePublished,
            legalHoldActive: activeLegalHoldCount > 0 || activeCaseHoldCount > 0,
            pendingDestructionCount,
          },
  };

  return {
    organizationId: input.orgId,
    generatedAt: new Date().toISOString(),
    scope: { workspaceCount: teamIds.length },
    sections: {
      legalHolds,
      retention,
      destruction,
      externalSharing,
      audit,
      coverage,
    },
  };
}
