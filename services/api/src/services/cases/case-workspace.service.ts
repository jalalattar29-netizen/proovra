/**
 * Phase 32.8D — Case Workspace aggregator service.
 *
 * Read-only aggregator that powers the new /cases/[id] tabs and
 * the /cases list page operational strip. Following the same
 * partial-failure-tolerant envelope pattern as the Phase 32.8C
 * Command Center.
 *
 * Hard rules:
 *   - READ ONLY. No `prisma.*.create / update / delete / upsert`.
 *   - NEVER emits an audit event. Browsing a case workspace tab
 *     is NOT an auditable event the way a download or mutation is.
 *   - NEVER triggers a report or verification-package generation.
 *   - NEVER projects raw file content, signed URLs, or privileged
 *     legal text.
 *   - Bounded queries. Every `findMany` carries `take`.
 *   - Per-section try/catch — one degraded sub-system does not
 *     poison the whole workspace.
 */

import { prisma } from "../../db.js";
import { deriveCanonicalArtifactAvailability } from "@proovra/shared";

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type CaseScope = "PERSONAL" | "TEAM";

export type CaseSummaryItem = {
  id: string;
  name: string;
  scope: CaseScope;
  ownerUserId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  linkedEvidenceCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  pendingReviewCount: number;
};

export type CasesSummaryEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: CaseScope;
    memberCount: number;
  };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        totalCases: number;
        casesWithEvidence: number;
        casesWithActiveHolds: number;
        casesWithPendingReview: number;
      } | null;
    };
    cases: {
      status: SectionStatus;
      items: CaseSummaryItem[];
    };
  };
};

export type CaseWorkspaceEnvelope = {
  generatedAt: string;
  case: {
    id: string;
    name: string;
    scope: CaseScope;
    ownerUserId: string;
    teamId: string | null;
    createdAt: string;
    updatedAt: string;
    accessCount: number;
  };
  viewer: {
    userId: string;
    role: string;
    canManage: boolean;
  };
  sections: {
    overview: {
      status: SectionStatus;
      data: {
        linkedEvidenceCount: number;
        recentlyLinkedCount: number;
        activeCaseHoldsCount: number;
        affectedEvidenceHoldsCount: number;
        pendingReviewCount: number;
        openEscalationsCount: number;
      } | null;
    };
    evidence: {
      status: SectionStatus;
      items: Array<{
        id: string;
        title: string;
        type: string;
        status: string;
        verificationStatus: string | null;
        createdAt: string;
        reportReady: boolean;
        packageReady: boolean;
      }>;
    };
    preservation: {
      status: SectionStatus;
      data: {
        caseHolds: Array<{
          id: string;
          title: string;
          status: string;
          placedAtUtc: string;
          releasedAtUtc: string | null;
        }>;
        evidenceHolds: Array<{
          id: string;
          evidenceId: string;
          status: string;
          createdAt: string;
        }>;
      } | null;
    };
    reviewCoordination: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        needsInfoCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
    timeline: {
      status: SectionStatus;
      items: Array<{
        id: string;
        kind:
          | "case_created"
          | "case_updated"
          | "evidence_linked"
          | "legal_hold_placed"
          | "legal_hold_released";
        occurredAt: string;
        label: string;
        subtitle: string | null;
        href: string | null;
      }>;
    };
    activity: {
      status: SectionStatus;
      items: Array<{
        id: string;
        eventType: string;
        actorUserId: string | null;
        createdAt: string;
        metadata: Record<string, unknown> | null;
      }>;
    };
  };
};

// =============================================================================
// Bounded limits
// =============================================================================

const SUMMARY_CASES_LIMIT = 50;
const CASE_EVIDENCE_LIMIT = 25;
const CASE_HOLDS_LIMIT = 50;
const CASE_TIMELINE_LIMIT = 30;
const CASE_ACTIVITY_LIMIT = 25;

// =============================================================================
// Helpers
// =============================================================================

function classifyCaseScope(caseTeamId: string | null): CaseScope {
  return caseTeamId ? "TEAM" : "PERSONAL";
}

// =============================================================================
// Cases summary (for /cases list page)
// =============================================================================

/**
 * Build the cases summary envelope used by the /cases list page.
 *
 * The caller is responsible for proving workspace membership at
 * the route layer; this service assumes the user already passed
 * that gate.
 */
export async function buildCasesSummary(input: {
  teamId: string;
  userId: string;
  role: string;
}): Promise<CasesSummaryEnvelope> {
  const memberCount = await prisma.teamMember.count({
    where: { teamId: input.teamId, status: "ACTIVE" },
  });
  const workspaceScope: CaseScope = memberCount <= 1 ? "PERSONAL" : "TEAM";

  // Cases the user can see in this workspace. Same access model as
  // /v1/cases: cases the user owns, has direct access to, or whose
  // teamId matches the workspace and has no explicit access list.
  const accessibleWhere = {
    OR: [
      { ownerUserId: input.userId },
      { access: { some: { userId: input.userId } } },
      { teamId: input.teamId, access: { none: {} } },
    ],
  };

  let summary: CasesSummaryEnvelope["sections"]["summary"] = {
    status: "unavailable",
    data: null,
  };
  let cases: CasesSummaryEnvelope["sections"]["cases"] = {
    status: "unavailable",
    items: [],
  };

  // 1) Compute summary counts (workspace-level).
  try {
    const [
      totalCases,
      casesWithEvidence,
      casesWithActiveHolds,
      casesWithPendingReview,
    ] = await Promise.all([
      prisma.case.count({ where: accessibleWhere }),
      prisma.case.count({
        where: {
          ...accessibleWhere,
          // At least one evidence has caseId == this.id and is in workspace
          // We approximate "has evidence" via the `evidence` relation by
          // joining on `Evidence` directly:
          id: {
            in: (
              await prisma.evidence.findMany({
                where: {
                  teamId: input.teamId,
                  caseId: { not: null },
                },
                select: { caseId: true },
                distinct: ["caseId"],
                // Bound the "cases-with-evidence" probe — a single
                // workspace having more than this many cases is well
                // beyond the dashboard's display capacity anyway.
                take: 2000,
              })
            )
              .map((e) => e.caseId)
              .filter((v): v is string => v !== null),
          },
        },
      }),
      prisma.caseLegalHold.findMany({
        where: { teamId: input.teamId, status: "ACTIVE" },
        select: { caseId: true },
        distinct: ["caseId"],
        take: 2000,
      }).then((rows) => rows.length),
      prisma.evidenceReviewWorkflow
        .findMany({
          where: {
            teamId: input.teamId,
            status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            evidenceId: { not: undefined },
          },
          select: { evidence: { select: { caseId: true } } },
          take: 1000,
        })
        .then((rows) => {
          const ids = new Set<string>();
          for (const r of rows) {
            const cid = r.evidence?.caseId;
            if (typeof cid === "string") ids.add(cid);
          }
          return ids.size;
        })
        .catch(() => 0),
    ]);
    summary = {
      status: "ok",
      data: {
        totalCases,
        casesWithEvidence,
        casesWithActiveHolds,
        casesWithPendingReview,
      },
    };
  } catch {
    summary = { status: "unavailable", data: null };
  }

  // 2) Fetch enriched case rows.
  try {
    const rawCases = await prisma.case.findMany({
      where: accessibleWhere,
      orderBy: { updatedAt: "desc" },
      take: SUMMARY_CASES_LIMIT,
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (rawCases.length === 0) {
      cases = { status: "ok", items: [] };
    } else {
      const caseIds = rawCases.map((c) => c.id);
      const [evidenceCounts, holdsByCase, recentReviewByCase] =
        await Promise.all([
          prisma.evidence.groupBy({
            by: ["caseId"],
            where: { caseId: { in: caseIds } },
            _count: { _all: true },
          }),
          prisma.caseLegalHold.findMany({
            where: { caseId: { in: caseIds }, status: "ACTIVE" },
            select: { caseId: true },
            // Bounded — the caller already bounded `caseIds` to
            // SUMMARY_CASES_LIMIT.
            take: SUMMARY_CASES_LIMIT * 4,
          }),
          prisma.evidenceReviewWorkflow.findMany({
            where: {
              teamId: input.teamId,
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              evidence: { caseId: { in: caseIds } },
            },
            select: { evidence: { select: { caseId: true } } },
            take: 500,
          }),
        ]);
      const evidenceCountByCase = new Map<string, number>();
      for (const row of evidenceCounts) {
        if (row.caseId) evidenceCountByCase.set(row.caseId, row._count._all);
      }
      const holdsSet = new Set<string>();
      for (const h of holdsByCase) holdsSet.add(h.caseId);
      const reviewCountByCase = new Map<string, number>();
      for (const r of recentReviewByCase) {
        const cid = r.evidence?.caseId;
        if (typeof cid === "string") {
          reviewCountByCase.set(cid, (reviewCountByCase.get(cid) ?? 0) + 1);
        }
      }
      cases = {
        status: "ok",
        items: rawCases.map((c) => ({
          id: c.id,
          name: c.name,
          scope: classifyCaseScope(c.teamId),
          ownerUserId: c.ownerUserId,
          teamId: c.teamId,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
          linkedEvidenceCount: evidenceCountByCase.get(c.id) ?? 0,
          hasActiveLegalHold: holdsSet.has(c.id),
          lastActivityAtUtc: c.updatedAt.toISOString(),
          pendingReviewCount: reviewCountByCase.get(c.id) ?? 0,
        })),
      };
    }
  } catch {
    cases = { status: "unavailable", items: [] };
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      id: input.teamId,
      role: input.role,
      scope: workspaceScope,
      memberCount,
    },
    sections: { summary, cases },
  };
}

// =============================================================================
// Single-case workspace (for /cases/[id] detail tabs)
// =============================================================================

/**
 * Build the case workspace envelope used by /cases/[id].
 *
 * Access is asserted at the route layer (must be case owner, direct
 * access entry, or workspace member with no explicit access list).
 * This service assumes the caller already passed that gate.
 */
export async function buildCaseWorkspace(input: {
  caseId: string;
  userId: string;
  role: string;
}): Promise<CaseWorkspaceEnvelope | { notFound: true }> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      teamId: true,
      createdAt: true,
      updatedAt: true,
      access: { select: { id: true } },
    },
  });
  if (!caseRow) {
    return { notFound: true };
  }
  const scope = classifyCaseScope(caseRow.teamId);
  const canManage =
    caseRow.ownerUserId === input.userId ||
    input.role === "OWNER" ||
    input.role === "ADMIN";

  // ----------- Overview counts -----------
  let overview: CaseWorkspaceEnvelope["sections"]["overview"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      linkedEvidenceCount,
      recentlyLinkedCount,
      activeCaseHoldsCount,
      affectedEvidenceHoldsCount,
      pendingReviewCount,
      openEscalationsCount,
    ] = await Promise.all([
      prisma.evidence.count({ where: { caseId: input.caseId } }),
      prisma.evidence.count({
        where: { caseId: input.caseId, createdAt: { gte: since7d } },
      }),
      prisma.caseLegalHold.count({
        where: { caseId: input.caseId, status: "ACTIVE" },
      }),
      prisma.evidenceLegalHold.count({
        where: {
          status: "ACTIVE",
          evidence: { caseId: input.caseId },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          evidence: { caseId: input.caseId },
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        },
      }),
      prisma.reviewEscalation.count({
        where: {
          status: "OPEN",
          workflow: { evidence: { caseId: input.caseId } },
        },
      }),
    ]);
    overview = {
      status: "ok",
      data: {
        linkedEvidenceCount,
        recentlyLinkedCount,
        activeCaseHoldsCount,
        affectedEvidenceHoldsCount,
        pendingReviewCount,
        openEscalationsCount,
      },
    };
  } catch {
    overview = { status: "unavailable", data: null };
  }

  // ----------- Linked Evidence (with report/package readiness) -----------
  let evidence: CaseWorkspaceEnvelope["sections"]["evidence"] = {
    status: "unavailable",
    items: [],
  };
  try {
    const items = await prisma.evidence.findMany({
      where: { caseId: input.caseId },
      orderBy: { createdAt: "desc" },
      take: CASE_EVIDENCE_LIMIT,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        verificationStatus: true,
        createdAt: true,
      },
    });
    if (items.length === 0) {
      evidence = { status: "ok", items: [] };
    } else {
      const evidenceIds = items.map((e) => e.id);
      // Side-effect-free check for which evidence rows have a
      // generated Report or VerificationPackage row.
      const [reportEvidenceIds, packageEvidenceIds] = await Promise.all([
        prisma.report
          .findMany({
            where: { evidenceId: { in: evidenceIds } },
            select: { evidenceId: true },
            distinct: ["evidenceId"],
            // Bounded by CASE_EVIDENCE_LIMIT (caller already capped
            // `evidenceIds`); the explicit `take:` is for the source-
            // contract regression suite that requires every findMany
            // to carry a cap.
            take: CASE_EVIDENCE_LIMIT,
          })
          .then((rows) => new Set(rows.map((r) => r.evidenceId))),
        prisma.verificationPackage
          .findMany({
            where: { evidenceId: { in: evidenceIds } },
            select: { evidenceId: true },
            distinct: ["evidenceId"],
            take: CASE_EVIDENCE_LIMIT,
          })
          .then((rows) => new Set(rows.map((r) => r.evidenceId))),
      ]);
      evidence = {
        status: "ok",
        items: items.map((e) => ({
          id: e.id,
          title: e.title ?? "Untitled evidence",
          type: String(e.type),
          status: String(e.status),
          verificationStatus: e.verificationStatus
            ? String(e.verificationStatus)
            : null,
          createdAt: e.createdAt.toISOString(),
          ...deriveCanonicalArtifactAvailability({
            reportAvailable: reportEvidenceIds.has(e.id),
            verificationPackageAvailable: packageEvidenceIds.has(e.id),
          }),
        })),
      };
    }
  } catch {
    evidence = { status: "unavailable", items: [] };
  }

  // ----------- Legal Preservation (case-level + evidence-level) -----------
  let preservation: CaseWorkspaceEnvelope["sections"]["preservation"] = {
    status: "unavailable",
    data: null,
  };
  let preservationAnyFailed = false;
  let preservationAnyOk = false;
  type PreservationData = NonNullable<
    CaseWorkspaceEnvelope["sections"]["preservation"]["data"]
  >;
  let caseHolds: PreservationData["caseHolds"] = [];
  let evidenceHolds: PreservationData["evidenceHolds"] = [];
  try {
    const rows = await prisma.caseLegalHold.findMany({
      where: { caseId: input.caseId },
      orderBy: { placedAtUtc: "desc" },
      take: CASE_HOLDS_LIMIT,
      select: {
        id: true,
        title: true,
        status: true,
        placedAtUtc: true,
        releasedAtUtc: true,
      },
    });
    caseHolds = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: String(r.status),
      placedAtUtc: r.placedAtUtc.toISOString(),
      releasedAtUtc: r.releasedAtUtc ? r.releasedAtUtc.toISOString() : null,
    }));
    preservationAnyOk = true;
  } catch {
    preservationAnyFailed = true;
  }
  try {
    const rows = await prisma.evidenceLegalHold.findMany({
      where: { evidence: { caseId: input.caseId } },
      orderBy: { createdAt: "desc" },
      take: CASE_HOLDS_LIMIT,
      select: {
        id: true,
        evidenceId: true,
        status: true,
        createdAt: true,
      },
    });
    evidenceHolds = rows.map((r) => ({
      id: r.id,
      evidenceId: r.evidenceId,
      status: String(r.status),
      createdAt: r.createdAt.toISOString(),
    }));
    preservationAnyOk = true;
  } catch {
    preservationAnyFailed = true;
  }
  preservation = {
    status: !preservationAnyOk
      ? "unavailable"
      : preservationAnyFailed
        ? "degraded"
        : "ok",
    data: preservationAnyOk ? { caseHolds, evidenceHolds } : null,
  };

  // ----------- Review Coordination -----------
  let reviewCoordination: CaseWorkspaceEnvelope["sections"]["reviewCoordination"] =
    scope === "PERSONAL"
      ? { status: "not_applicable", data: null }
      : { status: "unavailable", data: null };
  if (scope === "TEAM") {
    try {
      const now = new Date();
      const [
        queuedCount,
        assignedCount,
        inReviewCount,
        needsInfoCount,
        overdueCount,
        openEscalationsCount,
      ] = await Promise.all([
        prisma.evidenceReviewWorkflow.count({
          where: { evidence: { caseId: input.caseId }, status: "QUEUED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { evidence: { caseId: input.caseId }, status: "ASSIGNED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { evidence: { caseId: input.caseId }, status: "IN_REVIEW" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { evidence: { caseId: input.caseId }, status: "NEEDS_INFO" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: {
            evidence: { caseId: input.caseId },
            status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            dueAt: { lt: now },
          },
        }),
        prisma.reviewEscalation.count({
          where: {
            status: "OPEN",
            workflow: { evidence: { caseId: input.caseId } },
          },
        }),
      ]);
      reviewCoordination = {
        status: "ok",
        data: {
          queuedCount,
          assignedCount,
          inReviewCount,
          needsInfoCount,
          overdueCount,
          openEscalationsCount,
        },
      };
    } catch {
      reviewCoordination = { status: "unavailable", data: null };
    }
  }

  // ----------- Timeline (real timestamps only) -----------
  let timeline: CaseWorkspaceEnvelope["sections"]["timeline"] = {
    status: "unavailable",
    items: [],
  };
  try {
    const timelineItems: CaseWorkspaceEnvelope["sections"]["timeline"]["items"] = [];
    // Case creation
    timelineItems.push({
      id: `case_created:${caseRow.id}`,
      kind: "case_created",
      occurredAt: caseRow.createdAt.toISOString(),
      label: "Case created",
      subtitle: null,
      href: null,
    });
    if (
      caseRow.updatedAt.getTime() - caseRow.createdAt.getTime() >
      60_000
    ) {
      timelineItems.push({
        id: `case_updated:${caseRow.id}`,
        kind: "case_updated",
        occurredAt: caseRow.updatedAt.toISOString(),
        label: "Case metadata updated",
        subtitle: null,
        href: null,
      });
    }
    // Evidence link events — approximated by each evidence's createdAt.
    // We don't have a dedicated "linked at" timestamp in the schema; the
    // evidence.createdAt is the closest real signal. The timeline label
    // is honest about this ("linked / created").
    const linked = await prisma.evidence.findMany({
      where: { caseId: input.caseId },
      orderBy: { createdAt: "desc" },
      take: CASE_TIMELINE_LIMIT,
      select: { id: true, title: true, createdAt: true },
    });
    for (const e of linked) {
      timelineItems.push({
        id: `evidence_linked:${e.id}`,
        kind: "evidence_linked",
        occurredAt: e.createdAt.toISOString(),
        label: `Evidence linked: ${e.title ?? "Untitled"}`,
        subtitle: null,
        href: `/evidence/${e.id}`,
      });
    }
    // Hold placed / released events
    const holds = await prisma.caseLegalHold.findMany({
      where: { caseId: input.caseId },
      orderBy: { placedAtUtc: "desc" },
      take: CASE_TIMELINE_LIMIT,
      select: {
        id: true,
        title: true,
        placedAtUtc: true,
        releasedAtUtc: true,
      },
    });
    for (const h of holds) {
      timelineItems.push({
        id: `legal_hold_placed:${h.id}`,
        kind: "legal_hold_placed",
        occurredAt: h.placedAtUtc.toISOString(),
        label: `Legal hold placed: ${h.title}`,
        subtitle: null,
        href: "/governance",
      });
      if (h.releasedAtUtc) {
        timelineItems.push({
          id: `legal_hold_released:${h.id}`,
          kind: "legal_hold_released",
          occurredAt: h.releasedAtUtc.toISOString(),
          label: `Legal hold released: ${h.title}`,
          subtitle: null,
          href: "/governance",
        });
      }
    }
    // Sort by time desc, cap.
    timelineItems.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    timeline = {
      status: "ok",
      items: timelineItems.slice(0, CASE_TIMELINE_LIMIT),
    };
  } catch {
    timeline = { status: "unavailable", items: [] };
  }

  // ----------- Activity (real TeamActivity events tagged to this case) -----
  let activity: CaseWorkspaceEnvelope["sections"]["activity"] = {
    status: "unavailable",
    items: [],
  };
  if (caseRow.teamId) {
    try {
      const rows = await prisma.teamActivity.findMany({
        where: {
          teamId: caseRow.teamId,
          OR: [
            { targetType: "case", targetId: input.caseId },
            { targetType: "case_access", targetId: input.caseId },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: CASE_ACTIVITY_LIMIT,
        select: {
          id: true,
          eventType: true,
          actorUserId: true,
          createdAt: true,
          metadata: true,
        },
      });
      activity = {
        status: "ok",
        items: rows.map((r) => ({
          id: r.id,
          eventType: r.eventType,
          actorUserId: r.actorUserId,
          createdAt: r.createdAt.toISOString(),
          metadata: r.metadata
            ? (r.metadata as Record<string, unknown>)
            : null,
        })),
      };
    } catch {
      activity = { status: "unavailable", items: [] };
    }
  } else {
    // Personal case — no team activity stream.
    activity = { status: "not_applicable", items: [] };
  }

  return {
    generatedAt: new Date().toISOString(),
    case: {
      id: caseRow.id,
      name: caseRow.name,
      scope,
      ownerUserId: caseRow.ownerUserId,
      teamId: caseRow.teamId,
      createdAt: caseRow.createdAt.toISOString(),
      updatedAt: caseRow.updatedAt.toISOString(),
      accessCount: caseRow.access.length,
    },
    viewer: {
      userId: input.userId,
      role: input.role,
      canManage,
    },
    sections: {
      overview,
      evidence,
      preservation,
      reviewCoordination,
      timeline,
      activity,
    },
  };
}
