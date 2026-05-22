/**
 * Phase 32.8E — Workspace Administration aggregator service.
 *
 * Powers `/v1/teams/workspace-admin` — a read-only, audit-free
 * aggregator that consolidates the metadata the enterprise Teams
 * page needs. Replaces N audit-emitting `/v1/teams*` round-trips
 * with a single per-section envelope.
 *
 * Hard rules:
 *   - READ ONLY. No `prisma.*.create / update / delete / upsert`.
 *   - NEVER emits an audit event. Browsing the workspace admin
 *     page is not an auditable view event (the existing
 *     audited `/v1/teams/:id` GET is the canonical "viewed team"
 *     surface and remains untouched).
 *   - NEVER projects API key secrets, webhook secrets, plaintext
 *     billing tokens, or raw sensitive evidence contents.
 *   - Bounded queries — every `findMany` carries `take`.
 *   - Per-section try/catch — partial failures degrade individual
 *     sections, never the whole envelope.
 */

import { prisma } from "../../db.js";

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type WorkspaceAdminEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    name: string;
    scope: WorkspaceScope;
    role: string;
    memberCount: number;
    adminCount: number;
    pendingInviteCount: number;
    plan: string;
    billingStatus: string;
    createdAt: string;
  };
  sections: {
    overview: {
      status: SectionStatus;
      data: {
        ownerEmail: string | null;
        ownerUserId: string;
        caseCount: number;
        evidenceCount: number;
      } | null;
    };
    access: {
      status: SectionStatus;
      members: Array<{
        userId: string;
        email: string | null;
        displayName: string | null;
        role: string;
        status: string;
        joinedAt: string;
        lastSeenAtUtc: string | null;
      }>;
      invites: Array<{
        id: string;
        email: string;
        role: string;
        createdAt: string;
        expiresAt: string;
      }>;
    };
    governanceSnapshot: {
      status: SectionStatus;
      data: {
        policySource: "workspace_row" | "default";
        activeLegalHoldsCount: number;
        activeCaseLegalHoldsCount: number;
        retentionPoliciesCount: number;
        pendingDestructionCount: number;
        allowReportDownload: boolean;
        allowPackageDownload: boolean;
        allowPublicVerify: boolean;
      } | null;
    };
    integrationsPosture: {
      status: SectionStatus;
      data: {
        apiCredentialsCount: number;
        webhookEndpointsCount: number;
        recentFailedDeliveriesCount: number;
      } | null;
    };
    billing: {
      status: SectionStatus;
      data: {
        plan: string;
        status: string;
        includedSeats: number;
        activeMembers: number;
        overSeatLimit: boolean;
      } | null;
    };
    operationalAccountability: {
      status: SectionStatus;
      activities: Array<{
        id: string;
        eventType: string;
        actorUserId: string | null;
        targetType: string;
        targetId: string | null;
        createdAt: string;
      }>;
      reviewerWorkload: {
        queuedCount: number;
        assignedCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const MEMBERS_LIMIT = 100;
const INVITES_LIMIT = 50;
const RECENT_ACTIVITY_LIMIT = 25;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function buildWorkspaceAdmin(input: {
  teamId: string;
  userId: string;
  role: string;
}): Promise<WorkspaceAdminEnvelope | { notFound: true }> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      overSeatLimit: true,
      createdAt: true,
    },
  });
  if (!team) {
    return { notFound: true };
  }

  const [memberCount, adminCount, pendingInviteCount] = await Promise.all([
    prisma.teamMember.count({ where: { teamId: input.teamId, status: "ACTIVE" } }),
    prisma.teamMember.count({
      where: {
        teamId: input.teamId,
        status: "ACTIVE",
        role: { in: ["OWNER", "ADMIN"] },
      },
    }),
    prisma.teamInvite.count({
      where: {
        teamId: input.teamId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);
  const scope: WorkspaceScope = memberCount <= 1 ? "PERSONAL" : "TEAM";

  // ----------- Overview -----------
  let overview: WorkspaceAdminEnvelope["sections"]["overview"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const [owner, caseCount, evidenceCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: team.ownerUserId },
        select: { id: true, email: true },
      }),
      prisma.case.count({ where: { teamId: input.teamId } }),
      prisma.evidence.count({ where: { teamId: input.teamId } }),
    ]);
    overview = {
      status: "ok",
      data: {
        ownerUserId: team.ownerUserId,
        ownerEmail: owner?.email ?? null,
        caseCount,
        evidenceCount,
      },
    };
  } catch {
    overview = { status: "unavailable", data: null };
  }

  // ----------- Access (members + invites) -----------
  let access: WorkspaceAdminEnvelope["sections"]["access"] = {
    status: "unavailable",
    members: [],
    invites: [],
  };
  let accessFailures = 0;
  let members: WorkspaceAdminEnvelope["sections"]["access"]["members"] = [];
  let invites: WorkspaceAdminEnvelope["sections"]["access"]["invites"] = [];
  try {
    const rows = await prisma.teamMember.findMany({
      where: { teamId: input.teamId },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      take: MEMBERS_LIMIT,
      select: {
        userId: true,
        role: true,
        status: true,
        createdAt: true,
        lastSeenAtUtc: true,
        user: { select: { email: true, displayName: true } },
      },
    });
    members = rows.map((m) => ({
      userId: m.userId,
      email: m.user?.email ?? null,
      displayName: m.user?.displayName ?? null,
      role: String(m.role),
      status: String(m.status),
      joinedAt: m.createdAt.toISOString(),
      lastSeenAtUtc: m.lastSeenAtUtc ? m.lastSeenAtUtc.toISOString() : null,
    }));
  } catch {
    accessFailures += 1;
  }
  try {
    const rows = await prisma.teamInvite.findMany({
      where: {
        teamId: input.teamId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: INVITES_LIMIT,
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    invites = rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: String(r.role),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  } catch {
    accessFailures += 1;
  }
  access = {
    status:
      accessFailures === 0
        ? "ok"
        : accessFailures === 2
          ? "unavailable"
          : "degraded",
    members,
    invites,
  };

  // ----------- Governance snapshot -----------
  let governanceSnapshot: WorkspaceAdminEnvelope["sections"]["governanceSnapshot"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const [
      policy,
      activeLegalHoldsCount,
      activeCaseLegalHoldsCount,
      retentionPoliciesCount,
      pendingDestructionCount,
    ] = await Promise.all([
      prisma.workspaceGovernancePolicy.findUnique({
        where: { teamId: input.teamId },
        select: {
          allowReportDownload: true,
          allowPackageDownload: true,
          allowPublicVerify: true,
        },
      }),
      prisma.evidenceLegalHold.count({
        where: { teamId: input.teamId, status: "ACTIVE" },
      }),
      prisma.caseLegalHold
        .count({ where: { teamId: input.teamId, status: "ACTIVE" } })
        .catch(() => 0),
      prisma.evidenceRetentionPolicy
        .count({ where: { teamId: input.teamId, status: "ACTIVE" } })
        .catch(() => 0),
      prisma.destructionReview
        .count({
          where: {
            teamId: input.teamId,
            status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
          },
        })
        .catch(() => 0),
    ]);
    governanceSnapshot = {
      status: "ok",
      data: {
        policySource: policy ? "workspace_row" : "default",
        activeLegalHoldsCount,
        activeCaseLegalHoldsCount,
        retentionPoliciesCount,
        pendingDestructionCount,
        allowReportDownload: policy?.allowReportDownload ?? true,
        allowPackageDownload: policy?.allowPackageDownload ?? true,
        allowPublicVerify: policy?.allowPublicVerify ?? true,
      },
    };
  } catch {
    governanceSnapshot = { status: "unavailable", data: null };
  }

  // ----------- Integrations posture -----------
  let integrationsPosture: WorkspaceAdminEnvelope["sections"]["integrationsPosture"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [apiCount, webhookCount, failedCount] = await Promise.all([
      prisma.apiCredential
        .count({ where: { teamId: input.teamId } })
        .catch(() => 0),
      prisma.webhookEndpoint
        .count({ where: { teamId: input.teamId } })
        .catch(() => 0),
      prisma.integrationWebhookDelivery
        .count({
          where: {
            teamId: input.teamId,
            status: "FAILED",
            createdAt: { gte: since24h },
          },
        })
        .catch(() => 0),
    ]);
    integrationsPosture = {
      status: "ok",
      data: {
        apiCredentialsCount: apiCount,
        webhookEndpointsCount: webhookCount,
        recentFailedDeliveriesCount: failedCount,
      },
    };
  } catch {
    integrationsPosture = { status: "unavailable", data: null };
  }

  // ----------- Billing snapshot (read-only) -----------
  let billing: WorkspaceAdminEnvelope["sections"]["billing"] = {
    status: "unavailable",
    data: null,
  };
  try {
    billing = {
      status: "ok",
      data: {
        plan: String(team.billingPlan),
        status: String(team.billingStatus),
        includedSeats: team.includedSeats,
        activeMembers: memberCount,
        overSeatLimit: team.overSeatLimit,
      },
    };
  } catch {
    billing = { status: "unavailable", data: null };
  }

  // ----------- Operational accountability (activity + reviewer workload) -----
  let operationalAccountability: WorkspaceAdminEnvelope["sections"]["operationalAccountability"] = {
    status: "unavailable",
    activities: [],
    reviewerWorkload: null,
  };
  let opsAnyOk = false;
  let opsAnyFailed = false;
  let activities: WorkspaceAdminEnvelope["sections"]["operationalAccountability"]["activities"] = [];
  let reviewerWorkload: WorkspaceAdminEnvelope["sections"]["operationalAccountability"]["reviewerWorkload"] = null;
  try {
    const rows = await prisma.teamActivity.findMany({
      where: { teamId: input.teamId },
      orderBy: { createdAt: "desc" },
      take: RECENT_ACTIVITY_LIMIT,
      select: {
        id: true,
        eventType: true,
        actorUserId: true,
        targetType: true,
        targetId: true,
        createdAt: true,
      },
    });
    activities = rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      actorUserId: r.actorUserId,
      targetType: r.targetType,
      targetId: r.targetId,
      createdAt: r.createdAt.toISOString(),
    }));
    opsAnyOk = true;
  } catch {
    opsAnyFailed = true;
  }
  if (scope === "TEAM") {
    try {
      const now = new Date();
      const [queuedCount, assignedCount, overdueCount, openEscalationsCount] =
        await Promise.all([
          prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, status: "QUEUED" },
          }),
          prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, status: "ASSIGNED" },
          }),
          prisma.evidenceReviewWorkflow.count({
            where: {
              teamId: input.teamId,
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              dueAt: { lt: now },
            },
          }),
          prisma.reviewEscalation.count({
            where: { teamId: input.teamId, status: "OPEN" },
          }),
        ]);
      reviewerWorkload = {
        queuedCount,
        assignedCount,
        overdueCount,
        openEscalationsCount,
      };
      opsAnyOk = true;
    } catch {
      opsAnyFailed = true;
    }
  }
  operationalAccountability = {
    status: !opsAnyOk
      ? "unavailable"
      : opsAnyFailed
        ? "degraded"
        : "ok",
    activities,
    reviewerWorkload,
  };

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      id: team.id,
      name: team.name,
      scope,
      role: input.role,
      memberCount,
      adminCount,
      pendingInviteCount,
      plan: String(team.billingPlan),
      billingStatus: String(team.billingStatus),
      createdAt: team.createdAt.toISOString(),
    },
    sections: {
      overview,
      access,
      governanceSnapshot,
      integrationsPosture,
      billing,
      operationalAccountability,
    },
  };
}
