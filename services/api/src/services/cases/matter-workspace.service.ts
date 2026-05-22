/**
 * Phase 32.8D — Matter Workspace service.
 *
 * Builds the 11-section Matter Workspace envelope for the case detail
 * page. Reuses every existing dashboard engine where possible — incidents
 * via OperationalIncident, workflows via OperationalWorkflow, causality
 * via OperationalCausalityChain, timeline via OperationalTimelineEvent,
 * integrity via EvidenceIntegritySnapshot, etc.
 *
 * Hard rules:
 *   - Reads ONLY. Page-load mutation surface is zero.
 *   - Each section is wrapped in try/catch so a single failure
 *     degrades the section, never the envelope.
 *   - Bounded queries (take caps) and bounded operator-safe strings.
 *   - Evidence reads UNION `Evidence.caseId` + `CaseEvidenceLink`
 *     per the Phase 32.8D backward-compatibility decision.
 *   - Risk engine writes an advisory CaseRiskSnapshot (best-effort).
 *   - NO signed URL generation, NO custody event emission, NO
 *     report/package generation, NO queue enqueues.
 */

import { prisma } from "../../db.js";
import {
  computeCaseRisk,
  listCaseEvidenceIds,
  recordCaseRiskSnapshot,
  type CaseRiskComputation,
  type RiskReasonCode,
} from "./case-risk-engine.service.js";
import {
  getCaseAssignmentRoles,
  resolveCaseViewerCapabilities,
  type CaseAccessRole,
} from "./case-permission.service.js";

export type SectionStatus =
  | "ok"
  | "degraded"
  | "unavailable"
  | "not_applicable";

export type CaseScope = "PERSONAL" | "TEAM";

const SECTION_EVIDENCE_LIMIT = 50;
const SECTION_TIMELINE_LIMIT = 100;
const SECTION_HISTORY_LIMIT = 50;

export type MatterWorkspaceEnvelope = {
  generatedAt: string;
  case: {
    id: string;
    name: string;
    referenceNumber: string | null;
    description: string | null;
    status: string;
    priority: string;
    scope: CaseScope;
    ownerUserId: string;
    teamId: string | null;
    closedAtUtc: string | null;
    closureReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  viewer: {
    userId: string;
    role: string;
    /**
     * Phase 32.8D-frontend-closure-2 — Per-case canonical capability
     * map. Computed by `resolveCaseViewerCapabilities` (the SAME
     * helper that backs the mutation route guards), so the
     * frontend's button-disabled hint and the backend's 403 cannot
     * drift.
     */
    canManage: boolean;
    canMutate: boolean;
    canAssign: boolean;
    canChangeStatus: boolean;
    canLinkEvidence: boolean;
    canUnlinkEvidence: boolean;
    canUnlinkLegacyEvidence: boolean;
    canComment: boolean;
    canResolveComment: boolean;
    /**
     * Bounded reason strings keyed by action name. Only populated
     * when the action is denied — the frontend uses this for the
     * tooltip on the disabled button.
     */
    disabledReasons: Partial<{
      assign: string;
      changeStatus: string;
      linkEvidence: string;
      unlinkEvidence: string;
      unlinkLegacyEvidence: string;
      comment: string;
      resolveComment: string;
    }>;
    /**
     * Bounded list of the viewer's ACTIVE CaseAssignment role names
     * for this case. Used by the matter-workspace UI for display
     * only — never as an authority source on its own.
     */
    activeAssignmentRoles: ReadonlyArray<string>;
  };
  /** Phase 32.8D — risk projection on the case detail page. */
  risk: {
    status: SectionStatus;
    data: CaseRiskComputation | null;
    sampledAtUtc: string;
  };
  sections: {
    commandSummary: {
      status: SectionStatus;
      data: {
        linkedEvidenceCount: number;
        recentlyLinkedCount: number;
        activeCaseHoldsCount: number;
        affectedEvidenceHoldsCount: number;
        pendingReviewCount: number;
        openEscalationsCount: number;
        activeAssignmentCount: number;
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
        lifecycleState: string | null;
        createdAt: string;
        reportReady: boolean;
        packageReady: boolean;
        /**
         * Phase 32.8D-frontend-closure — when present, the canonical
         * `CaseEvidenceLink.id` for this evidence's link to the case.
         * Null when the evidence is attached only via the legacy
         * `Evidence.caseId` column (no CaseEvidenceLink row). The
         * frontend renders a disabled Unlink button in that case.
         */
        linkId: string | null;
        linkRole: string | null;
        linkSource: string | null;
      }>;
    };
    relationships: {
      status: SectionStatus;
      links: Array<{
        id: string;
        evidenceId: string;
        role: string;
        source: string;
        linkedAtUtc: string;
        reason: string | null;
      }>;
      relationships: Array<{
        id: string;
        sourceEvidenceId: string;
        targetEvidenceId: string;
        relationshipType: string;
        createdAt: string;
        note: string | null;
      }>;
      counts: {
        primary: number;
        supporting: number;
        related: number;
        duplicate: number;
        derived: number;
        context: number;
      };
    };
    workflows: {
      status: SectionStatus;
      items: Array<{
        id: string;
        workflowType: string;
        status: string;
        severity: string;
        priority: string;
        title: string;
        safeSummary: string;
        assignedOwnerUserId: string | null;
        escalationLevel: number;
        retryCount: number;
        dueAtUtc: string | null;
        nextRetryAtUtc: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    };
    incidentsAndCausality: {
      status: SectionStatus;
      incidents: Array<{
        id: string;
        title: string;
        category: string;
        severity: string;
        status: string;
        occurrenceCount: number;
        lastSeenAtUtc: string;
        safeSummary: string;
        relatedEvidenceId: string | null;
      }>;
      chains: Array<{
        id: string;
        chainKey: string;
        title: string;
        summary: string;
        rootCauseType: string;
        severity: string;
        status: string;
        linkedIncidentCount: number;
        linkedWorkflowCount: number;
        startAtUtc: string;
        lastSeenAtUtc: string;
      }>;
    };
    reviewerCoordination: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        needsInfoCount: number;
        overdueCount: number;
        openEscalationsCount: number;
        unresolvedReviewerCommentsCount: number;
        unresolvedAnnotationsCount: number;
      } | null;
      escalations: Array<{
        id: string;
        evidenceId: string;
        severity: string;
        status: string;
        createdAt: string;
      }>;
      reviewerCapacity: Array<{
        reviewerUserId: string;
        saturationLevel: string;
        assignedCount: number;
        overdueCount: number;
        capacityScore: number;
        sampledAtUtc: string;
      }>;
    };
    governance: {
      status: SectionStatus;
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
      governanceWorkflows: Array<{
        id: string;
        workflowType: string;
        status: string;
        severity: string;
        title: string;
        safeSummary: string;
        dueAtUtc: string | null;
      }>;
      auditReadinessScore: number | null;
      blockerCount: number;
    };
    custodyAndIntegrity: {
      status: SectionStatus;
      lifecycleStateCounts: Array<{ lifecycleState: string; count: number }>;
      verificationStatusCounts: Array<{
        verificationStatus: string;
        count: number;
      }>;
      integritySnapshots: Array<{
        evidenceId: string;
        overallStatus: string;
        tsaStatus: string | null;
        otsStatus: string | null;
        reasonCodes: string[];
        computedAtUtc: string;
        tsaParseStatus: string | null;
      }>;
      custodyEventTotals: {
        eventsLast30d: number;
      };
    };
    timeline: {
      status: SectionStatus;
      items: Array<{
        id: string;
        family: string;
        eventType: string;
        severity: string;
        occurredAtUtc: string;
        summary: string;
        evidenceId: string | null;
        actorUserId: string | null;
        sourceTable: string;
        route: string | null;
      }>;
    };
    notes: {
      status: SectionStatus;
      caseComments: Array<{
        id: string;
        authorUserId: string;
        body: string;
        visibility: string;
        resolvedAtUtc: string | null;
        resolvedByUserId: string | null;
        createdAt: string;
      }>;
      unresolvedReviewerComments: Array<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
      unresolvedAnnotations: Array<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
    };
    deliverables: {
      status: SectionStatus;
      reports: Array<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      packages: Array<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      externalReviewLinks: Array<{
        id: string;
        evidenceId: string;
        viewerType: string;
        createdAt: string;
      }>;
      counts: {
        reportsReady: number;
        packagesReady: number;
        deliverablesPending: number;
      };
    };
  };
  assignments: Array<{
    id: string;
    assignedToUserId: string;
    assignedByUserId: string;
    role: string;
    status: string;
    assignedAtUtc: string;
    removedAtUtc: string | null;
    note: string | null;
  }>;
  statusHistory: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    changedByUserId: string;
    reason: string | null;
    changedAtUtc: string;
  }>;
};

function classifyCaseScope(teamId: string | null): CaseScope {
  return teamId ? "TEAM" : "PERSONAL";
}

export async function buildMatterWorkspace(input: {
  caseId: string;
  userId: string;
  role: string;
}): Promise<MatterWorkspaceEnvelope | { notFound: true }> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    select: {
      id: true,
      name: true,
      referenceNumber: true,
      description: true,
      status: true,
      priority: true,
      ownerUserId: true,
      teamId: true,
      closedAtUtc: true,
      closureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!caseRow) return { notFound: true };
  const scope = classifyCaseScope(caseRow.teamId);
  // Phase 32.8D-frontend-closure-2 — compute per-case capabilities
  // via the SAME canonical helper used by the mutation route guards
  // (`gateCaseMutation`). The frontend renders buttons disabled when
  // these are false, with the bounded reason in the tooltip — no
  // drift between display and enforcement.
  const accessRole = (input.role as CaseAccessRole) ?? "VIEWER";
  const activeAssignmentRoleNames = await getCaseAssignmentRoles(
    caseRow.id,
    input.userId,
  );
  const viewerCaps = resolveCaseViewerCapabilities({
    accessRole,
    assignmentRoles: activeAssignmentRoleNames,
  });

  const evidenceIds = await listCaseEvidenceIds({
    teamId: caseRow.teamId,
    caseId: caseRow.id,
  });

  // Risk projection (lazy write).
  const risk = await runRisk({
    teamId: caseRow.teamId,
    caseId: caseRow.id,
  });

  const [
    commandSummary,
    evidence,
    relationships,
    workflows,
    incidentsAndCausality,
    reviewerCoordination,
    governance,
    custodyAndIntegrity,
    timeline,
    notes,
    deliverables,
    assignments,
    statusHistory,
  ] = await Promise.all([
    runCommandSummary(caseRow.id, caseRow.teamId, evidenceIds),
    runEvidenceBoard(caseRow.id, evidenceIds),
    runRelationships(caseRow.id, evidenceIds),
    runWorkflows(caseRow.id),
    runIncidentsAndCausality(caseRow.id, evidenceIds),
    runReviewerCoordination(caseRow.id, caseRow.teamId, evidenceIds),
    runGovernance(caseRow.id, evidenceIds, risk.data?.auditReadinessScore ?? null),
    runCustodyAndIntegrity(evidenceIds),
    runTimeline(caseRow.id, evidenceIds),
    runNotes(caseRow.id, evidenceIds),
    runDeliverables(evidenceIds),
    runAssignments(caseRow.id),
    runStatusHistory(caseRow.id),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    case: {
      id: caseRow.id,
      name: caseRow.name,
      referenceNumber: caseRow.referenceNumber,
      description: caseRow.description,
      status: caseRow.status,
      priority: caseRow.priority,
      scope,
      ownerUserId: caseRow.ownerUserId,
      teamId: caseRow.teamId,
      closedAtUtc: caseRow.closedAtUtc?.toISOString() ?? null,
      closureReason: caseRow.closureReason,
      createdAt: caseRow.createdAt.toISOString(),
      updatedAt: caseRow.updatedAt.toISOString(),
    },
    viewer: {
      userId: input.userId,
      role: input.role,
      canManage: viewerCaps.canManage,
      canMutate: viewerCaps.canMutate,
      canAssign: viewerCaps.canAssign,
      canChangeStatus: viewerCaps.canChangeStatus,
      canLinkEvidence: viewerCaps.canLinkEvidence,
      canUnlinkEvidence: viewerCaps.canUnlinkEvidence,
      canUnlinkLegacyEvidence: viewerCaps.canUnlinkLegacyEvidence,
      canComment: viewerCaps.canComment,
      canResolveComment: viewerCaps.canResolveComment,
      disabledReasons: viewerCaps.disabledReasons,
      activeAssignmentRoles: activeAssignmentRoleNames,
    },
    risk,
    sections: {
      commandSummary,
      evidence,
      relationships,
      workflows,
      incidentsAndCausality,
      reviewerCoordination,
      governance,
      custodyAndIntegrity,
      timeline,
      notes,
      deliverables,
    },
    assignments,
    statusHistory,
  };
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

async function runRisk(input: {
  teamId: string | null;
  caseId: string;
}): Promise<MatterWorkspaceEnvelope["risk"]> {
  try {
    const data = await recordCaseRiskSnapshot(input);
    return {
      status: "ok",
      data,
      sampledAtUtc: new Date().toISOString(),
    };
  } catch {
    try {
      const data = await computeCaseRisk(input);
      return {
        status: "degraded",
        data,
        sampledAtUtc: new Date().toISOString(),
      };
    } catch {
      return {
        status: "unavailable",
        data: null,
        sampledAtUtc: new Date().toISOString(),
      };
    }
  }
}

async function runCommandSummary(
  caseId: string,
  teamId: string | null,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["commandSummary"]> {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      linkedEvidenceCount,
      recentlyLinkedCount,
      activeCaseHoldsCount,
      affectedEvidenceHoldsCount,
      pendingReviewCount,
      openEscalationsCount,
      activeAssignmentCount,
    ] = await Promise.all([
      // Linked evidence count = union size
      Promise.resolve(evidenceIds.length),
      // Recently linked: union of (Evidence.caseId where createdAt >= since7d) + CaseEvidenceLink.linkedAtUtc
      prisma.caseEvidenceLink.count({
        where: { caseId, linkedAtUtc: { gte: since7d } },
      }),
      prisma.caseLegalHold.count({
        where: { caseId, status: "ACTIVE" },
      }),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.evidenceLegalHold.count({
            where: {
              status: "ACTIVE",
              evidenceId: { in: evidenceIds },
            },
          }),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.evidenceReviewWorkflow.count({
            where: {
              evidenceId: { in: evidenceIds },
              status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            },
          }),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.reviewEscalation.count({
            where: {
              status: "OPEN",
              workflow: { evidenceId: { in: evidenceIds } },
            },
          }),
      prisma.caseAssignment.count({
        where: { caseId, status: "ACTIVE" },
      }),
    ]);
    void teamId; // reserved for future workspace-scoped checks
    return {
      status: "ok",
      data: {
        linkedEvidenceCount,
        recentlyLinkedCount,
        activeCaseHoldsCount,
        affectedEvidenceHoldsCount,
        pendingReviewCount,
        openEscalationsCount,
        activeAssignmentCount,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

async function runEvidenceBoard(
  caseId: string,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["evidence"]> {
  if (evidenceIds.length === 0) {
    return { status: "ok", items: [] };
  }
  try {
    const items = await prisma.evidence.findMany({
      where: { id: { in: evidenceIds } },
      orderBy: { createdAt: "desc" },
      take: SECTION_EVIDENCE_LIMIT,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        verificationStatus: true,
        lifecycleState: true,
        createdAt: true,
        latestReportVersion: true,
        verificationPackageVersion: true,
      },
    });
    // Look up linkId/linkRole/linkSource for the items present so the
    // Evidence Board can offer direct "Unlink" actions per row. When a
    // row's evidence is only attached via the legacy Evidence.caseId
    // column (no CaseEvidenceLink row), linkId is `null`, which the
    // frontend renders as a disabled Unlink button with an
    // explanation rather than calling the wrong DELETE endpoint.
    const links = await prisma.caseEvidenceLink.findMany({
      where: { caseId, evidenceId: { in: items.map((e) => e.id) } },
      select: { id: true, evidenceId: true, role: true, source: true },
    });
    const byEv = new Map(
      links.map((l) => [
        l.evidenceId,
        { linkId: l.id, role: l.role, source: l.source },
      ]),
    );
    return {
      status: "ok",
      items: items.map((e) => ({
        id: e.id,
        title: e.title ?? "Untitled evidence",
        type: String(e.type),
        status: String(e.status),
        verificationStatus: e.verificationStatus
          ? String(e.verificationStatus)
          : null,
        lifecycleState: e.lifecycleState ? String(e.lifecycleState) : null,
        createdAt: e.createdAt.toISOString(),
        reportReady: e.latestReportVersion !== null,
        packageReady: e.verificationPackageVersion !== null,
        linkId: byEv.get(e.id)?.linkId ?? null,
        linkRole: byEv.get(e.id)?.role ? String(byEv.get(e.id)!.role) : null,
        linkSource: byEv.get(e.id)?.source
          ? String(byEv.get(e.id)!.source)
          : null,
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runRelationships(
  caseId: string,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["relationships"]> {
  try {
    const links = await prisma.caseEvidenceLink.findMany({
      where: { caseId },
      orderBy: { linkedAtUtc: "desc" },
      take: SECTION_EVIDENCE_LIMIT,
    });
    const counts = {
      primary: 0,
      supporting: 0,
      related: 0,
      duplicate: 0,
      derived: 0,
      context: 0,
    };
    for (const l of links) {
      switch (l.role) {
        case "PRIMARY":
          counts.primary += 1;
          break;
        case "SUPPORTING":
          counts.supporting += 1;
          break;
        case "RELATED":
          counts.related += 1;
          break;
        case "DUPLICATE":
          counts.duplicate += 1;
          break;
        case "DERIVED":
          counts.derived += 1;
          break;
        case "CONTEXT":
          counts.context += 1;
          break;
      }
    }
    // Bounded relationship reads (depth=1) within case evidence scope.
    let relationships: Array<{
      id: string;
      sourceEvidenceId: string;
      targetEvidenceId: string;
      relationshipType: string;
      createdAt: string;
      note: string | null;
    }> = [];
    if (evidenceIds.length > 0) {
      const rels = await prisma.evidenceRelationship.findMany({
        where: {
          OR: [
            { sourceEvidenceId: { in: evidenceIds } },
            { targetEvidenceId: { in: evidenceIds } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      relationships = rels.map((r) => ({
        id: r.id,
        sourceEvidenceId: r.sourceEvidenceId,
        targetEvidenceId: r.targetEvidenceId,
        relationshipType: String(r.relationshipType),
        createdAt: r.createdAt.toISOString(),
        note: r.note,
      }));
    }
    return {
      status: "ok",
      links: links.map((l) => ({
        id: l.id,
        evidenceId: l.evidenceId,
        role: String(l.role),
        source: String(l.source),
        linkedAtUtc: l.linkedAtUtc.toISOString(),
        reason: l.reason,
      })),
      relationships,
      counts,
    };
  } catch {
    return {
      status: "unavailable",
      links: [],
      relationships: [],
      counts: {
        primary: 0,
        supporting: 0,
        related: 0,
        duplicate: 0,
        derived: 0,
        context: 0,
      },
    };
  }
}

async function runWorkflows(
  caseId: string,
): Promise<MatterWorkspaceEnvelope["sections"]["workflows"]> {
  try {
    const rows = await prisma.operationalWorkflow.findMany({
      where: {
        caseId,
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
      orderBy: [
        { severity: "desc" },
        { priority: "asc" },
        { updatedAt: "desc" },
      ],
      take: 50,
      select: {
        id: true,
        workflowType: true,
        status: true,
        severity: true,
        priority: true,
        title: true,
        safeSummary: true,
        assignedOwnerUserId: true,
        escalationLevel: true,
        retryCount: true,
        dueAtUtc: true,
        nextRetryAtUtc: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      status: "ok",
      items: rows.map((r) => ({
        id: r.id,
        workflowType: String(r.workflowType),
        status: String(r.status),
        severity: String(r.severity),
        priority: String(r.priority),
        title: r.title,
        safeSummary: r.safeSummary,
        assignedOwnerUserId: r.assignedOwnerUserId,
        escalationLevel: r.escalationLevel,
        retryCount: r.retryCount,
        dueAtUtc: r.dueAtUtc?.toISOString() ?? null,
        nextRetryAtUtc: r.nextRetryAtUtc?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runIncidentsAndCausality(
  caseId: string,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["incidentsAndCausality"]> {
  try {
    const [incidents, chains] = await Promise.all([
      evidenceIds.length === 0
        ? Promise.resolve([])
        : prisma.operationalIncident.findMany({
            where: {
              status: { in: ["OPEN", "ACKNOWLEDGED"] },
              relatedEvidenceId: { in: evidenceIds },
            },
            orderBy: [
              { severity: "desc" },
              { lastSeenAtUtc: "desc" },
            ],
            take: 50,
            select: {
              id: true,
              title: true,
              category: true,
              severity: true,
              status: true,
              occurrenceCount: true,
              lastSeenAtUtc: true,
              safeSummary: true,
              relatedEvidenceId: true,
            },
          }),
      prisma.operationalCausalityChain.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
        take: 50,
        select: {
          id: true,
          chainKey: true,
          title: true,
          summary: true,
          rootCauseType: true,
          severity: true,
          status: true,
          linkedIncidentIds: true,
          linkedWorkflowIds: true,
          linkedCaseIds: true,
          startAtUtc: true,
          lastSeenAtUtc: true,
        },
      }),
    ]);

    // Filter chains to those that include this caseId in linkedCaseIds.
    const relevantChains = chains.filter((c) => {
      const ids = Array.isArray(c.linkedCaseIds)
        ? (c.linkedCaseIds as string[])
        : [];
      return ids.includes(caseId);
    });

    return {
      status: "ok",
      incidents: incidents.map((i) => ({
        id: i.id,
        title: i.title,
        category: String(i.category),
        severity: String(i.severity),
        status: String(i.status),
        occurrenceCount: i.occurrenceCount,
        lastSeenAtUtc: i.lastSeenAtUtc.toISOString(),
        safeSummary: i.safeSummary,
        relatedEvidenceId: i.relatedEvidenceId,
      })),
      chains: relevantChains.map((c) => {
        const incIds = Array.isArray(c.linkedIncidentIds)
          ? (c.linkedIncidentIds as string[])
          : [];
        const wfIds = Array.isArray(c.linkedWorkflowIds)
          ? (c.linkedWorkflowIds as string[])
          : [];
        return {
          id: c.id,
          chainKey: c.chainKey,
          title: c.title,
          summary: c.summary,
          rootCauseType: String(c.rootCauseType),
          severity: String(c.severity),
          status: String(c.status),
          linkedIncidentCount: incIds.length,
          linkedWorkflowCount: wfIds.length,
          startAtUtc: c.startAtUtc.toISOString(),
          lastSeenAtUtc: c.lastSeenAtUtc.toISOString(),
        };
      }),
    };
  } catch {
    return { status: "unavailable", incidents: [], chains: [] };
  }
}

async function runReviewerCoordination(
  caseId: string,
  teamId: string | null,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["reviewerCoordination"]> {
  if (evidenceIds.length === 0 && !teamId) {
    return {
      status: "ok",
      data: {
        queuedCount: 0,
        assignedCount: 0,
        inReviewCount: 0,
        needsInfoCount: 0,
        overdueCount: 0,
        openEscalationsCount: 0,
        unresolvedReviewerCommentsCount: 0,
        unresolvedAnnotationsCount: 0,
      },
      escalations: [],
      reviewerCapacity: [],
    };
  }
  try {
    const [
      queuedCount,
      assignedCount,
      inReviewCount,
      needsInfoCount,
      overdueCount,
      openEscalationsCount,
      unresolvedReviewerCommentsCount,
      unresolvedAnnotationsCount,
      escalationsRaw,
    ] = await Promise.all([
      countReviews(evidenceIds, ["QUEUED"]),
      countReviews(evidenceIds, ["ASSIGNED"]),
      countReviews(evidenceIds, ["IN_REVIEW"]),
      countReviews(evidenceIds, ["NEEDS_INFO"]),
      overdueReviews(evidenceIds),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.reviewEscalation.count({
            where: {
              status: "OPEN",
              workflow: { evidenceId: { in: evidenceIds } },
            },
          }),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.evidenceReviewerComment.count({
            where: {
              evidenceId: { in: evidenceIds },
              resolvedAtUtc: null,
            },
          }),
      evidenceIds.length === 0
        ? Promise.resolve(0)
        : prisma.evidenceAnnotation.count({
            where: {
              evidenceId: { in: evidenceIds },
              resolvedAtUtc: null,
            },
          }),
      evidenceIds.length === 0
        ? Promise.resolve([])
        : prisma.reviewEscalation.findMany({
            where: {
              status: "OPEN",
              workflow: { evidenceId: { in: evidenceIds } },
            },
            orderBy: { createdAt: "desc" },
            take: 25,
            select: {
              id: true,
              severity: true,
              status: true,
              createdAt: true,
              workflow: { select: { evidenceId: true } },
            },
          }),
    ]);

    // Reviewer capacity: pull active workflow owners on this case + their
    // freshest snapshot per reviewer.
    let reviewerCapacity: MatterWorkspaceEnvelope["sections"]["reviewerCoordination"]["reviewerCapacity"] =
      [];
    if (teamId) {
      try {
        const owners = await prisma.operationalWorkflow.findMany({
          where: {
            caseId,
            assignedOwnerUserId: { not: null },
            status: {
              in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_ON_REVIEWER"],
            },
          },
          select: { assignedOwnerUserId: true },
          take: 50,
        });
        const ids = Array.from(
          new Set(
            owners
              .map((o) => o.assignedOwnerUserId)
              .filter((x): x is string => !!x),
          ),
        );
        if (ids.length > 0) {
          const snapshots = await prisma.reviewerCapacitySnapshot.findMany({
            where: { teamId, reviewerUserId: { in: ids } },
            orderBy: { sampledAtUtc: "desc" },
            take: ids.length * 4,
          });
          const seen = new Set<string>();
          for (const s of snapshots) {
            if (seen.has(s.reviewerUserId)) continue;
            seen.add(s.reviewerUserId);
            reviewerCapacity.push({
              reviewerUserId: s.reviewerUserId,
              saturationLevel: String(s.saturationLevel),
              assignedCount: s.assignedCount,
              overdueCount: s.overdueCount,
              capacityScore: s.capacityScore,
              sampledAtUtc: s.sampledAtUtc.toISOString(),
            });
          }
        }
      } catch {
        /* degrade */
      }
    }

    return {
      status: "ok",
      data: {
        queuedCount,
        assignedCount,
        inReviewCount,
        needsInfoCount,
        overdueCount,
        openEscalationsCount,
        unresolvedReviewerCommentsCount,
        unresolvedAnnotationsCount,
      },
      escalations: escalationsRaw.map((e) => ({
        id: e.id,
        evidenceId: e.workflow?.evidenceId ?? "",
        severity: String(e.severity),
        status: String(e.status),
        createdAt: e.createdAt.toISOString(),
      })),
      reviewerCapacity,
    };
  } catch {
    return {
      status: "unavailable",
      data: null,
      escalations: [],
      reviewerCapacity: [],
    };
  }
}

async function countReviews(
  evidenceIds: string[],
  statuses: string[],
): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  try {
    return await prisma.evidenceReviewWorkflow.count({
      where: {
        evidenceId: { in: evidenceIds },
        status: { in: statuses as never },
      },
    });
  } catch {
    return 0;
  }
}

async function overdueReviews(evidenceIds: string[]): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  try {
    return await prisma.evidenceReviewWorkflow.count({
      where: {
        evidenceId: { in: evidenceIds },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        dueAt: { lt: new Date(), not: null },
      },
    });
  } catch {
    return 0;
  }
}

async function runGovernance(
  caseId: string,
  evidenceIds: string[],
  auditReadinessScore: number | null,
): Promise<MatterWorkspaceEnvelope["sections"]["governance"]> {
  try {
    const [caseHolds, evidenceHolds, governanceWorkflows] = await Promise.all([
      prisma.caseLegalHold.findMany({
        where: { caseId },
        orderBy: { placedAtUtc: "desc" },
        take: 25,
      }),
      evidenceIds.length === 0
        ? Promise.resolve([])
        : prisma.evidenceLegalHold.findMany({
            where: {
              evidenceId: { in: evidenceIds },
              status: "ACTIVE",
            },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              evidenceId: true,
              status: true,
              createdAt: true,
            },
          }),
      prisma.operationalWorkflow.findMany({
        where: {
          caseId,
          workflowType: {
            in: [
              "GOVERNANCE_ESCALATION",
              "EXPORT_BLOCKER_RESOLUTION",
              "AUDIT_READINESS",
            ],
          },
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
        orderBy: { updatedAt: "desc" },
        take: 25,
        select: {
          id: true,
          workflowType: true,
          status: true,
          severity: true,
          title: true,
          safeSummary: true,
          dueAtUtc: true,
        },
      }),
    ]);

    return {
      status: "ok",
      caseHolds: caseHolds.map((h) => ({
        id: h.id,
        title: h.title,
        status: String(h.status),
        placedAtUtc: h.placedAtUtc.toISOString(),
        releasedAtUtc: h.releasedAtUtc?.toISOString() ?? null,
      })),
      evidenceHolds: evidenceHolds.map((h) => ({
        id: h.id,
        evidenceId: h.evidenceId,
        status: String(h.status),
        createdAt: h.createdAt.toISOString(),
      })),
      governanceWorkflows: governanceWorkflows.map((w) => ({
        id: w.id,
        workflowType: String(w.workflowType),
        status: String(w.status),
        severity: String(w.severity),
        title: w.title,
        safeSummary: w.safeSummary,
        dueAtUtc: w.dueAtUtc?.toISOString() ?? null,
      })),
      auditReadinessScore,
      blockerCount:
        caseHolds.filter((h) => h.status === "ACTIVE").length +
        governanceWorkflows.length,
    };
  } catch {
    return {
      status: "unavailable",
      caseHolds: [],
      evidenceHolds: [],
      governanceWorkflows: [],
      auditReadinessScore,
      blockerCount: 0,
    };
  }
}

async function runCustodyAndIntegrity(
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["custodyAndIntegrity"]> {
  if (evidenceIds.length === 0) {
    return {
      status: "ok",
      lifecycleStateCounts: [],
      verificationStatusCounts: [],
      integritySnapshots: [],
      custodyEventTotals: { eventsLast30d: 0 },
    };
  }
  try {
    const [lifecycle, verification, snapshots, custody30d] = await Promise.all([
      prisma.evidence.groupBy({
        by: ["lifecycleState"],
        where: { id: { in: evidenceIds } },
        _count: { _all: true },
        orderBy: { lifecycleState: "asc" },
      }),
      prisma.evidence.groupBy({
        by: ["verificationStatus"],
        where: { id: { in: evidenceIds } },
        _count: { _all: true },
        orderBy: { verificationStatus: "asc" },
      }),
      prisma.evidenceIntegritySnapshot.findMany({
        where: {
          evidenceId: { in: evidenceIds },
          overallStatus: { in: ["REVIEW_REQUIRED", "FAILED"] },
        },
        orderBy: { computedAtUtc: "desc" },
        take: 50,
      }),
      prisma.custodyEvent.count({
        where: {
          evidenceId: { in: evidenceIds },
          atUtc: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    return {
      status: "ok",
      lifecycleStateCounts: lifecycle.map((l) => ({
        lifecycleState: String(l.lifecycleState),
        count: l._count._all,
      })),
      verificationStatusCounts: verification.map((v) => ({
        verificationStatus: v.verificationStatus
          ? String(v.verificationStatus)
          : "UNKNOWN",
        count: v._count._all,
      })),
      integritySnapshots: snapshots.map((s) => ({
        evidenceId: s.evidenceId,
        overallStatus: s.overallStatus ?? "UNKNOWN",
        tsaStatus: s.tsaStatus,
        otsStatus: s.otsStatus,
        reasonCodes: Array.isArray(s.reasonCodes)
          ? (s.reasonCodes as string[])
          : [],
        computedAtUtc: s.computedAtUtc.toISOString(),
        tsaParseStatus: s.tsaParseStatus,
      })),
      custodyEventTotals: { eventsLast30d: custody30d },
    };
  } catch {
    return {
      status: "unavailable",
      lifecycleStateCounts: [],
      verificationStatusCounts: [],
      integritySnapshots: [],
      custodyEventTotals: { eventsLast30d: 0 },
    };
  }
}

async function runTimeline(
  caseId: string,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["timeline"]> {
  try {
    // 1. Direct projection reads (OperationalTimelineEvent has caseId).
    const projectionRows = await prisma.operationalTimelineEvent.findMany({
      where: {
        OR: [
          { caseId },
          ...(evidenceIds.length > 0
            ? [{ evidenceId: { in: evidenceIds } }]
            : []),
        ],
      },
      orderBy: { occurredAtUtc: "desc" },
      take: SECTION_TIMELINE_LIMIT,
      select: {
        id: true,
        eventFamily: true,
        eventType: true,
        severity: true,
        occurredAtUtc: true,
        summary: true,
        evidenceId: true,
        actorUserId: true,
        sourceTable: true,
        route: true,
        safeToDisplay: true,
      },
    });

    // 2. Case-table direct events (status history + assignments +
    // evidence links + case comments) merged into the timeline.
    const [statusEvents, assignEvents, linkEvents, commentEvents] =
      await Promise.all([
        prisma.caseStatusHistory.findMany({
          where: { caseId },
          orderBy: { changedAtUtc: "desc" },
          take: 25,
        }),
        prisma.caseAssignment.findMany({
          where: { caseId },
          orderBy: { assignedAtUtc: "desc" },
          take: 25,
        }),
        prisma.caseEvidenceLink.findMany({
          where: { caseId },
          orderBy: { linkedAtUtc: "desc" },
          take: 25,
        }),
        prisma.caseComment.findMany({
          where: { caseId },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            authorUserId: true,
            createdAt: true,
            resolvedAtUtc: true,
            visibility: true,
          },
        }),
      ]);

    const merged: MatterWorkspaceEnvelope["sections"]["timeline"]["items"] = [
      ...projectionRows
        .filter((p) => p.safeToDisplay)
        .map((p) => ({
          id: p.id,
          family: String(p.eventFamily),
          eventType: p.eventType,
          severity: p.severity,
          occurredAtUtc: p.occurredAtUtc.toISOString(),
          summary: p.summary,
          evidenceId: p.evidenceId,
          actorUserId: p.actorUserId,
          sourceTable: p.sourceTable,
          route: p.route,
        })),
      ...statusEvents.map((s) => ({
        id: `status:${s.id}`,
        family: "CASE",
        eventType: `case.status_changed.${s.toStatus}`,
        severity: "INFO",
        occurredAtUtc: s.changedAtUtc.toISOString(),
        summary: s.reason
          ? `Case status → ${s.toStatus}: ${s.reason}`
          : `Case status → ${s.toStatus}.`,
        evidenceId: null,
        actorUserId: s.changedByUserId,
        sourceTable: "case_status_history",
        route: null,
      })),
      ...assignEvents.map((a) => ({
        id: `assign:${a.id}`,
        family: "CASE",
        eventType:
          a.status === "ACTIVE" ? "case.assignment_added" : "case.assignment_removed",
        severity: "INFO",
        occurredAtUtc: (a.removedAtUtc ?? a.assignedAtUtc).toISOString(),
        summary: `${a.role} ${a.status === "ACTIVE" ? "assigned" : "removed"}: ${a.assignedToUserId.slice(0, 8)}`,
        evidenceId: null,
        actorUserId:
          a.status === "ACTIVE"
            ? a.assignedByUserId
            : a.removedByUserId ?? a.assignedByUserId,
        sourceTable: "case_assignments",
        route: null,
      })),
      ...linkEvents.map((l) => ({
        id: `link:${l.id}`,
        family: "CASE",
        eventType: "case.evidence_linked",
        severity: "INFO",
        occurredAtUtc: l.linkedAtUtc.toISOString(),
        summary: `Evidence linked as ${l.role}.`,
        evidenceId: l.evidenceId,
        actorUserId: l.linkedByUserId,
        sourceTable: "case_evidence_links",
        route: `/evidence/${l.evidenceId}`,
      })),
      ...commentEvents.map((c) => ({
        id: `comment:${c.id}`,
        family: "CASE",
        eventType: c.resolvedAtUtc
          ? "case.comment_resolved"
          : "case.comment_added",
        severity: "INFO",
        occurredAtUtc: (c.resolvedAtUtc ?? c.createdAt).toISOString(),
        summary: c.resolvedAtUtc
          ? "Case comment resolved."
          : `Case comment added (${c.visibility}).`,
        evidenceId: null,
        actorUserId: c.authorUserId,
        sourceTable: "case_comments",
        route: null,
      })),
    ];

    merged.sort(
      (a, b) =>
        new Date(b.occurredAtUtc).getTime() -
        new Date(a.occurredAtUtc).getTime(),
    );

    return {
      status: "ok",
      items: merged.slice(0, SECTION_TIMELINE_LIMIT),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runNotes(
  caseId: string,
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["notes"]> {
  try {
    const [caseComments, unresolvedReviewerComments, unresolvedAnnotations] =
      await Promise.all([
        prisma.caseComment.findMany({
          where: { caseId },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            authorUserId: true,
            body: true,
            visibility: true,
            resolvedAtUtc: true,
            resolvedByUserId: true,
            createdAt: true,
          },
        }),
        evidenceIds.length === 0
          ? Promise.resolve([])
          : prisma.evidenceReviewerComment.findMany({
              where: {
                evidenceId: { in: evidenceIds },
                resolvedAtUtc: null,
              },
              orderBy: { createdAt: "desc" },
              take: 25,
              select: { id: true, evidenceId: true, createdAt: true },
            }),
        evidenceIds.length === 0
          ? Promise.resolve([])
          : prisma.evidenceAnnotation.findMany({
              where: {
                evidenceId: { in: evidenceIds },
                resolvedAtUtc: null,
              },
              orderBy: { createdAt: "desc" },
              take: 25,
              select: { id: true, evidenceId: true, createdAt: true },
            }),
      ]);
    return {
      status: "ok",
      caseComments: caseComments.map((c) => ({
        id: c.id,
        authorUserId: c.authorUserId,
        body: c.body,
        visibility: String(c.visibility),
        resolvedAtUtc: c.resolvedAtUtc?.toISOString() ?? null,
        resolvedByUserId: c.resolvedByUserId,
        createdAt: c.createdAt.toISOString(),
      })),
      unresolvedReviewerComments: unresolvedReviewerComments.map((c) => ({
        id: c.id,
        evidenceId: c.evidenceId,
        createdAt: c.createdAt.toISOString(),
      })),
      unresolvedAnnotations: unresolvedAnnotations.map((a) => ({
        id: a.id,
        evidenceId: a.evidenceId,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  } catch {
    return {
      status: "unavailable",
      caseComments: [],
      unresolvedReviewerComments: [],
      unresolvedAnnotations: [],
    };
  }
}

async function runDeliverables(
  evidenceIds: string[],
): Promise<MatterWorkspaceEnvelope["sections"]["deliverables"]> {
  if (evidenceIds.length === 0) {
    return {
      status: "ok",
      reports: [],
      packages: [],
      externalReviewLinks: [],
      counts: {
        reportsReady: 0,
        packagesReady: 0,
        deliverablesPending: 0,
      },
    };
  }
  try {
    const [reports, packages, externalLinks, signedCount, reportedCount, packagedCount] =
      await Promise.all([
        prisma.report.findMany({
          where: { evidenceId: { in: evidenceIds } },
          orderBy: { generatedAtUtc: "desc" },
          take: 50,
          select: {
            id: true,
            evidenceId: true,
            version: true,
            generatedAtUtc: true,
          },
        }),
        prisma.verificationPackage.findMany({
          where: { evidenceId: { in: evidenceIds } },
          orderBy: { generatedAtUtc: "desc" },
          take: 50,
          select: {
            id: true,
            evidenceId: true,
            version: true,
            generatedAtUtc: true,
          },
        }),
        prisma.verificationView.findMany({
          where: { evidenceId: { in: evidenceIds } },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            evidenceId: true,
            viewerType: true,
            createdAt: true,
          },
        }),
        prisma.evidence.count({
          where: { id: { in: evidenceIds }, status: "SIGNED" },
        }),
        prisma.evidence.count({
          where: { id: { in: evidenceIds }, status: "REPORTED" },
        }),
        prisma.evidence.count({
          where: {
            id: { in: evidenceIds },
            verificationPackageVersion: { not: null },
          },
        }),
      ]);
    const reportsReady = reports.length;
    const packagesReady = packages.length;
    const deliverablesPending =
      Math.max(0, signedCount - reportsReady) +
      Math.max(0, reportedCount - packagedCount);

    return {
      status: "ok",
      reports: reports.map((r) => ({
        id: r.id,
        evidenceId: r.evidenceId,
        version: r.version,
        generatedAtUtc: r.generatedAtUtc?.toISOString() ?? null,
      })),
      packages: packages.map((p) => ({
        id: p.id,
        evidenceId: p.evidenceId,
        version: p.version,
        generatedAtUtc: p.generatedAtUtc?.toISOString() ?? null,
      })),
      externalReviewLinks: externalLinks.map((v) => ({
        id: v.id,
        evidenceId: v.evidenceId,
        viewerType: String(v.viewerType),
        createdAt: v.createdAt.toISOString(),
      })),
      counts: {
        reportsReady,
        packagesReady,
        deliverablesPending,
      },
    };
  } catch {
    return {
      status: "unavailable",
      reports: [],
      packages: [],
      externalReviewLinks: [],
      counts: {
        reportsReady: 0,
        packagesReady: 0,
        deliverablesPending: 0,
      },
    };
  }
}

async function runAssignments(
  caseId: string,
): Promise<MatterWorkspaceEnvelope["assignments"]> {
  try {
    const rows = await prisma.caseAssignment.findMany({
      where: { caseId },
      orderBy: { assignedAtUtc: "desc" },
      take: SECTION_HISTORY_LIMIT,
    });
    return rows.map((a) => ({
      id: a.id,
      assignedToUserId: a.assignedToUserId,
      assignedByUserId: a.assignedByUserId,
      role: String(a.role),
      status: String(a.status),
      assignedAtUtc: a.assignedAtUtc.toISOString(),
      removedAtUtc: a.removedAtUtc?.toISOString() ?? null,
      note: a.note,
    }));
  } catch {
    return [];
  }
}

async function runStatusHistory(
  caseId: string,
): Promise<MatterWorkspaceEnvelope["statusHistory"]> {
  try {
    const rows = await prisma.caseStatusHistory.findMany({
      where: { caseId },
      orderBy: { changedAtUtc: "desc" },
      take: SECTION_HISTORY_LIMIT,
    });
    return rows.map((s) => ({
      id: s.id,
      fromStatus: s.fromStatus ? String(s.fromStatus) : null,
      toStatus: String(s.toStatus),
      changedByUserId: s.changedByUserId,
      reason: s.reason,
      changedAtUtc: s.changedAtUtc.toISOString(),
    }));
  } catch {
    return [];
  }
}

export type { CaseRiskComputation, RiskReasonCode };
