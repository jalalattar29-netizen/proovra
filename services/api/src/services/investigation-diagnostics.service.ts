/**
 * Wave 1 Phase 5 — Investigation Diagnostics envelope aggregator.
 *
 * Single GET endpoint backing surface for the Investigation
 * Diagnostics drawer. Composes thin per-domain counters into a
 * bounded JSON envelope. The aggregator OWNS NO BUSINESS LOGIC:
 *
 *   * Counts come from Prisma `count()` calls grouped by workspace
 *     tenancy (`teamId`). No raw text fields read; no PII surfaced.
 *   * Queue depth + lastError sourced from the existing
 *     `getQueueInventory` helper (Phase P2.3). The BullMQ Queue
 *     handle is read-only via that helper — we never `Queue.add`.
 *   * Producer-mode statuses sourced from
 *     `resolveProducerModeStatuses` (Wave 1 Phase 3). The resolver
 *     never throws; collapses to NOT_CONFIGURED on any failure.
 *   * `lastErrors[]` reads the 5 most recent FAILED runs from
 *     `media_intelligence_runs` (bounded raw SQL — Prisma has no
 *     typed model for that table).
 *
 * Hard contracts:
 *   * NEVER throws to the caller. Every sub-aggregation is wrapped
 *     in a try/catch that collapses to 0 / [] / null.
 *   * NEVER projects evidence content, OCR text, transcript text,
 *     GPS, storage keys, reviewer-private fields, or audit
 *     metadata payloads. Counts only.
 *   * Bounded. Counts are sums; lastErrors[] is capped at 5.
 *   * NEVER reads `process.env` for producer-mode decisions.
 *     Always delegates to `resolveProducerModeStatuses`.
 *
 * Empty-state classifier (Wave 2 hook):
 *   * The shape includes `warnings[]` so the aggregator can emit
 *     plain-string operator notes for empty / not-wired domains.
 *     Wave 2 will replace string warnings with a typed classifier
 *     enum once the empty-state vocabulary is finalised.
 */

import type { PrismaClient } from "@prisma/client";

import {
  resolveProducerModeStatuses,
  type ProducerModeStatus,
} from "@proovra/shared-runtime/media-intelligence";

// ---------------------------------------------------------------------------
// Public envelope shape
// ---------------------------------------------------------------------------

export type InvestigationDiagnosticsWorkspace = {
  evidenceCount: number;
  finalizedEvidenceCount: number;
  evidencePartCount: number;
  caseCount: number;
  caseEvidenceLinkCount: number;
  custodyEventCount: number;
  auditEventCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  staleGraphNodeCount: number;
  staleGraphEdgeCount: number;
  timelineEventCount: number;
  duplicateExactCount: number;
  duplicateSimilarityCount: number;
  duplicateDerivativeCount: number;
  mediaSignalCount: number;
  mediaRecordCountsByKind: Record<string, number>;
  ocrRecordCount: number;
  transcriptRecordCount: number;
  extractedTextCount: number;
  perceptualHashCount: number;
  perceptualDhashCount: number;
  entityCount: number;
  reviewWorkflowCount: number;
  escalationCount: number;
  externalReviewerGrantCount: number;
  reportCount: number;
  verificationPackageCount: number;
};

export type InvestigationDiagnosticsQueueRow = {
  depth: number;
  lastError: string | null;
  lastRunAt: string | null;
};

export type InvestigationDiagnosticsQueues = {
  graphReconcile: InvestigationDiagnosticsQueueRow;
  graphDomainSync: InvestigationDiagnosticsQueueRow;
  graphTimelineSync: InvestigationDiagnosticsQueueRow;
  graphSearchProjection: InvestigationDiagnosticsQueueRow;
  mediaIntelligence: InvestigationDiagnosticsQueueRow;
  miOcr: InvestigationDiagnosticsQueueRow;
  miTranscript: InvestigationDiagnosticsQueueRow;
  miEmbed: InvestigationDiagnosticsQueueRow;
  miSearchIndex: InvestigationDiagnosticsQueueRow;
  searchIndexing: InvestigationDiagnosticsQueueRow;
  report: InvestigationDiagnosticsQueueRow;
};

export type InvestigationDiagnosticsLastError = {
  source: string;
  code: string;
  message: string;
  occurredAt: string;
};

export type InvestigationDiagnostics = {
  workspace: InvestigationDiagnosticsWorkspace;
  queues: InvestigationDiagnosticsQueues;
  producerModes: ProducerModeStatus[];
  lastErrors: InvestigationDiagnosticsLastError[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Allowlist of response keys — the route validates outgoing payloads
// against this set so we never leak PII / secrets / raw payloads.
// Each entry is the dotted path from the envelope root.
// ---------------------------------------------------------------------------

export const INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS = Object.freeze([
  // top-level
  "workspace",
  "queues",
  "producerModes",
  "lastErrors",
  "warnings",
  // workspace.*
  "workspace.evidenceCount",
  "workspace.finalizedEvidenceCount",
  "workspace.evidencePartCount",
  "workspace.caseCount",
  "workspace.caseEvidenceLinkCount",
  "workspace.custodyEventCount",
  "workspace.auditEventCount",
  "workspace.graphNodeCount",
  "workspace.graphEdgeCount",
  "workspace.staleGraphNodeCount",
  "workspace.staleGraphEdgeCount",
  "workspace.timelineEventCount",
  "workspace.duplicateExactCount",
  "workspace.duplicateSimilarityCount",
  "workspace.duplicateDerivativeCount",
  "workspace.mediaSignalCount",
  "workspace.mediaRecordCountsByKind",
  "workspace.ocrRecordCount",
  "workspace.transcriptRecordCount",
  "workspace.extractedTextCount",
  "workspace.perceptualHashCount",
  "workspace.perceptualDhashCount",
  "workspace.entityCount",
  "workspace.reviewWorkflowCount",
  "workspace.escalationCount",
  "workspace.externalReviewerGrantCount",
  "workspace.reportCount",
  "workspace.verificationPackageCount",
  // queues.*
  "queues.graphReconcile",
  "queues.graphDomainSync",
  "queues.graphTimelineSync",
  "queues.graphSearchProjection",
  "queues.mediaIntelligence",
  "queues.miOcr",
  "queues.miTranscript",
  "queues.miEmbed",
  "queues.miSearchIndex",
  "queues.searchIndexing",
  "queues.report",
  // queue row fields
  "depth",
  "lastError",
  "lastRunAt",
  // producerModes — bounded set from PRODUCER_KINDS catalog
  "kind",
  "mode",
  "enabled",
  "configured",
  "automatic",
  "indexExistingOnly",
  "provider",
  "reason",
  // lastErrors entry fields
  "source",
  "code",
  "message",
  "occurredAt",
] as const);

// ---------------------------------------------------------------------------
// Service input
// ---------------------------------------------------------------------------

export type BuildInvestigationDiagnosticsInput = {
  teamId: string;
  prisma: PrismaClient;
};

// ---------------------------------------------------------------------------
// Queue name → response key map
// ---------------------------------------------------------------------------

const QUEUE_NAME_TO_KEY = {
  "graph-reconcile": "graphReconcile",
  "graph-domain-sync": "graphDomainSync",
  "graph-timeline-sync": "graphTimelineSync",
  "graph-search-projection": "graphSearchProjection",
  "media-intelligence": "mediaIntelligence",
  "mi-ocr": "miOcr",
  "mi-transcript": "miTranscript",
  "mi-embed": "miEmbed",
  "mi-search-index": "miSearchIndex",
  "search-indexing": "searchIndexing",
  report: "report",
} as const;

const EMPTY_QUEUE_ROW: InvestigationDiagnosticsQueueRow = {
  depth: 0,
  lastError: null,
  lastRunAt: null,
};

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function buildInvestigationDiagnostics(
  opts: BuildInvestigationDiagnosticsInput,
): Promise<InvestigationDiagnostics> {
  const { teamId, prisma } = opts;
  const warnings: string[] = [];

  const workspace = await buildWorkspaceCounts(teamId, prisma, warnings);
  const queues = await buildQueueDiagnostics(warnings);
  const producerModes = await buildProducerModes(teamId, prisma, warnings);
  const lastErrors = await buildLastErrors(teamId, prisma, warnings);

  return {
    workspace,
    queues,
    producerModes,
    lastErrors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Workspace counts — bounded Prisma count() calls, team-anchored.
// ---------------------------------------------------------------------------

async function buildWorkspaceCounts(
  teamId: string,
  prisma: PrismaClient,
  warnings: string[],
): Promise<InvestigationDiagnosticsWorkspace> {
  const out: InvestigationDiagnosticsWorkspace = {
    evidenceCount: 0,
    finalizedEvidenceCount: 0,
    evidencePartCount: 0,
    caseCount: 0,
    caseEvidenceLinkCount: 0,
    custodyEventCount: 0,
    auditEventCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    staleGraphNodeCount: 0,
    staleGraphEdgeCount: 0,
    timelineEventCount: 0,
    duplicateExactCount: 0,
    duplicateSimilarityCount: 0,
    duplicateDerivativeCount: 0,
    mediaSignalCount: 0,
    mediaRecordCountsByKind: {},
    ocrRecordCount: 0,
    transcriptRecordCount: 0,
    extractedTextCount: 0,
    perceptualHashCount: 0,
    perceptualDhashCount: 0,
    entityCount: 0,
    reviewWorkflowCount: 0,
    escalationCount: 0,
    externalReviewerGrantCount: 0,
    reportCount: 0,
    verificationPackageCount: 0,
  };

  // Evidence + finalized (SIGNED|REPORTED) + parts.
  try {
    out.evidenceCount = await prisma.evidence.count({ where: { teamId } });
  } catch {
    warnings.push("evidence_count_unavailable");
  }
  try {
    out.finalizedEvidenceCount = await prisma.evidence.count({
      where: { teamId, status: { in: ["SIGNED", "REPORTED"] } },
    });
  } catch {
    warnings.push("finalized_evidence_count_unavailable");
  }
  try {
    // EvidencePart has no direct teamId — count via Evidence join.
    out.evidencePartCount = await prisma.evidencePart.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("evidence_part_count_unavailable");
  }

  // Cases + case→evidence links.
  try {
    out.caseCount = await prisma.case.count({ where: { teamId } });
  } catch {
    warnings.push("case_count_unavailable");
  }
  try {
    // CaseEvidenceLink carries a direct team_id column — anchor on it.
    out.caseEvidenceLinkCount = await prisma.caseEvidenceLink.count({
      where: { teamId },
    });
  } catch {
    warnings.push("case_evidence_link_count_unavailable");
  }

  // Custody journal — no direct team_id; route via evidence.team_id.
  try {
    out.custodyEventCount = await prisma.custodyEvent.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("custody_event_count_unavailable");
  }

  // Audit events — AdminAuditLog has no team_id column. We count only
  // entries whose resourceType=team and resourceId matches the team.
  // That's the same anchoring convention every Wave 1 audit emit uses.
  try {
    out.auditEventCount = await prisma.adminAuditLog.count({
      where: { resourceType: "team", resourceId: teamId },
    });
  } catch {
    warnings.push("audit_event_count_unavailable");
  }

  // Investigation graph nodes/edges — SQL-only tables.
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS "total",
         SUM(CASE WHEN "stale_at_utc" IS NULL THEN 0 ELSE 1 END)::int AS "stale"
       FROM "investigation_graph_nodes"
       WHERE "team_id" = $1`,
      teamId,
    )) as Array<{ total: number | null; stale: number | null }>;
    const row = rows[0];
    if (row) {
      out.graphNodeCount = Number(row.total ?? 0);
      out.staleGraphNodeCount = Number(row.stale ?? 0);
    }
  } catch {
    warnings.push("graph_node_count_unavailable");
  }
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS "total",
         SUM(CASE WHEN "stale_at_utc" IS NULL THEN 0 ELSE 1 END)::int AS "stale"
       FROM "investigation_graph_edges"
       WHERE "team_id" = $1`,
      teamId,
    )) as Array<{ total: number | null; stale: number | null }>;
    const row = rows[0];
    if (row) {
      out.graphEdgeCount = Number(row.total ?? 0);
      out.staleGraphEdgeCount = Number(row.stale ?? 0);
    }
  } catch {
    warnings.push("graph_edge_count_unavailable");
  }

  // Timeline events — currently sourced from graph node/edge create
  // events (no dedicated investigation_timeline_events table). We use
  // (active node count) + (active edge count) as a proxy. Surfacing a
  // warning so consumers know this is derived.
  out.timelineEventCount =
    Math.max(0, out.graphNodeCount - out.staleGraphNodeCount) +
    Math.max(0, out.graphEdgeCount - out.staleGraphEdgeCount);
  if (out.graphNodeCount === 0 && out.graphEdgeCount === 0) {
    warnings.push("timeline_derived_from_graph_no_dedicated_table");
  }
  // Phase Repair (Problem 13) — probe the actual timeline projection
  // so a SQL failure (e.g. schema drift, table missing) surfaces as
  // `timeline_query_failed` here instead of silently masquerading as
  // a TRUE_EMPTY workspace upstream. Bounded: limit=1 keeps the
  // projection cheap. The shared-runtime helper itself catches and
  // bumps `timeline_query_failed_total`; we only need to inspect the
  // discriminator.
  try {
    const { buildInvestigationTimeline } = await import(
      "@proovra/shared-runtime/graph"
    );
    const probe = await buildInvestigationTimeline(
      {
        teamId,
        rootNodeId: null,
        evidenceId: null,
        fromUtc: null,
        toUtc: null,
        limit: 1,
      },
      prisma,
    );
    if (!probe.ok) {
      warnings.push("timeline_query_failed");
    }
  } catch {
    // Defensive: even the import itself failing must not break the
    // diagnostics envelope. The bounded warning is the operator
    // signal; we still return the rest of the snapshot.
    warnings.push("timeline_query_failed");
  }

  // Duplicates / similarities / derivatives — by EvidenceSimilarity kind.
  try {
    out.duplicateExactCount = await prisma.evidenceSimilarity.count({
      where: { teamId, kind: "HASH_DUPLICATE" },
    });
  } catch {
    warnings.push("duplicate_exact_count_unavailable");
  }
  try {
    // Similarity = the catch-all bucket for OCR/transcript/embedding/metadata.
    out.duplicateSimilarityCount = await prisma.evidenceSimilarity.count({
      where: {
        teamId,
        kind: {
          in: [
            "OCR_SIMILAR",
            "TRANSCRIPT_SIMILAR",
            "METADATA_SIMILAR",
            "EMBEDDING_SIMILAR",
            "FILENAME_SIMILAR",
          ],
        },
      },
    });
  } catch {
    warnings.push("duplicate_similarity_count_unavailable");
  }
  // Derivative detection: the producer is live in graph reconcile
  // (reconcileTeamGraph upserts POSSIBLE_DERIVATIVE_OF edges from
  // perceptual_phash + upload-time + shared file traits). Count the
  // active (non-stale) candidate edges for this team.
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS "total"
         FROM "investigation_graph_edges"
        WHERE "team_id" = $1
          AND "edge_type" = 'POSSIBLE_DERIVATIVE_OF'
          AND "stale_at_utc" IS NULL`,
      teamId,
    )) as Array<{ total: number | null }>;
    out.duplicateDerivativeCount = Number(rows[0]?.total ?? 0);
  } catch {
    warnings.push("duplicate_derivative_count_unavailable");
  }

  // Media intelligence — signals + records-by-kind.
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS "total"
         FROM "media_intelligence_signals"
         WHERE "team_id" = $1`,
      teamId,
    )) as Array<{ total: number | null }>;
    out.mediaSignalCount = Number(rows[0]?.total ?? 0);
  } catch {
    warnings.push("media_signal_count_unavailable");
  }
  try {
    const rows = await prisma.mediaIntelligenceRecord.groupBy({
      by: ["kind"],
      where: { teamId },
      _count: { _all: true },
    });
    for (const row of rows) {
      out.mediaRecordCountsByKind[row.kind] = row._count._all;
    }
  } catch {
    warnings.push("media_record_counts_unavailable");
  }

  // OCR / transcript / extracted-text counts (SQL-only tables for
  // OCR + transcript foundations; ExtractedText is Prisma-modelled).
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT "evidence_id")::int AS "total"
         FROM "evidence_ocr_text" ot
         JOIN "evidence" e ON e."id" = ot."evidence_id"
         WHERE e."team_id" = $1`,
      teamId,
    )) as Array<{ total: number | null }>;
    out.ocrRecordCount = Number(rows[0]?.total ?? 0);
  } catch {
    warnings.push("ocr_record_count_unavailable");
  }
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT "evidence_id")::int AS "total"
         FROM "evidence_transcript_segments" ts
         JOIN "evidence" e ON e."id" = ts."evidence_id"
         WHERE e."team_id" = $1`,
      teamId,
    )) as Array<{ total: number | null }>;
    out.transcriptRecordCount = Number(rows[0]?.total ?? 0);
  } catch {
    warnings.push("transcript_record_count_unavailable");
  }
  try {
    out.extractedTextCount = await prisma.evidenceExtractedText.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("extracted_text_count_unavailable");
  }

  // Perceptual hashes — VARCHAR columns on evidence_parts.
  try {
    out.perceptualHashCount = await prisma.evidencePart.count({
      where: {
        evidence: { teamId },
        perceptualPhash: { not: null },
      },
    });
  } catch {
    warnings.push("perceptual_hash_count_unavailable");
  }
  try {
    out.perceptualDhashCount = await prisma.evidencePart.count({
      where: {
        evidence: { teamId },
        perceptualDhash: { not: null },
      },
    });
  } catch {
    warnings.push("perceptual_dhash_count_unavailable");
  }

  // Entities — extracted-entity surface (Phase 13).
  try {
    out.entityCount = await prisma.evidenceEntity.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("entity_count_unavailable");
  }

  // Review workflow + escalations + external reviewer grants.
  try {
    out.reviewWorkflowCount = await prisma.evidenceReviewWorkflow.count({
      where: { teamId },
    });
  } catch {
    warnings.push("review_workflow_count_unavailable");
  }
  try {
    out.escalationCount = await prisma.reviewEscalation.count({
      where: { teamId },
    });
  } catch {
    warnings.push("escalation_count_unavailable");
  }
  try {
    out.externalReviewerGrantCount =
      await prisma.externalReviewerRoleAssignment.count({
        where: { teamId },
      });
  } catch {
    warnings.push("external_reviewer_grant_count_unavailable");
  }

  // Reports + verification packages.
  try {
    out.reportCount = await prisma.report.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("report_count_unavailable");
  }
  try {
    out.verificationPackageCount = await prisma.verificationPackage.count({
      where: { evidence: { teamId } },
    });
  } catch {
    warnings.push("verification_package_count_unavailable");
  }

  return out;
}

// ---------------------------------------------------------------------------
// Queue diagnostics — delegates to queue-inventory.service.
// ---------------------------------------------------------------------------

async function buildQueueDiagnostics(
  warnings: string[],
): Promise<InvestigationDiagnosticsQueues> {
  const empty: InvestigationDiagnosticsQueues = {
    graphReconcile: { ...EMPTY_QUEUE_ROW },
    graphDomainSync: { ...EMPTY_QUEUE_ROW },
    graphTimelineSync: { ...EMPTY_QUEUE_ROW },
    graphSearchProjection: { ...EMPTY_QUEUE_ROW },
    mediaIntelligence: { ...EMPTY_QUEUE_ROW },
    miOcr: { ...EMPTY_QUEUE_ROW },
    miTranscript: { ...EMPTY_QUEUE_ROW },
    miEmbed: { ...EMPTY_QUEUE_ROW },
    miSearchIndex: { ...EMPTY_QUEUE_ROW },
    searchIndexing: { ...EMPTY_QUEUE_ROW },
    report: { ...EMPTY_QUEUE_ROW },
  };

  try {
    // Dynamic import keeps the diagnostics module decoupled from
    // BullMQ at load time. The helper itself is best-effort and
    // returns an outage row when Redis is unavailable.
    const { getQueueInventory, listFailedJobs } = await import(
      "./operations/queue-inventory.service.js"
    );
    const inventory = await getQueueInventory();

    for (const row of inventory) {
      const key = QUEUE_NAME_TO_KEY[
        row.queueName as keyof typeof QUEUE_NAME_TO_KEY
      ];
      if (!key) continue;

      const depth =
        (row.counts.waiting ?? 0) +
        (row.counts.active ?? 0) +
        (row.counts.delayed ?? 0);

      // Pull the most recent failure (if any) for lastError +
      // lastRunAt. listFailedJobs is bounded to 50 per call; we ask
      // for 1.
      let lastError: string | null = null;
      let lastRunAt: string | null = null;
      try {
        const failed = await listFailedJobs(row.queueName, 1);
        const top = failed[0];
        if (top) {
          lastError = top.failureReason;
          lastRunAt = top.failedAtUtc;
        }
      } catch {
        /* best-effort */
      }

      empty[key as keyof InvestigationDiagnosticsQueues] = {
        depth,
        lastError,
        lastRunAt,
      };
    }
  } catch {
    warnings.push("queue_inventory_unavailable");
  }

  return empty;
}

// ---------------------------------------------------------------------------
// Producer modes — delegates to resolveProducerModeStatuses.
// ---------------------------------------------------------------------------

async function buildProducerModes(
  teamId: string,
  prisma: PrismaClient,
  warnings: string[],
): Promise<ProducerModeStatus[]> {
  try {
    return await resolveProducerModeStatuses({ teamId, prisma });
  } catch {
    warnings.push("producer_modes_unavailable");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Last errors — 5 most recent FAILED media_intelligence_runs.
// ---------------------------------------------------------------------------

async function buildLastErrors(
  teamId: string,
  prisma: PrismaClient,
  warnings: string[],
): Promise<InvestigationDiagnosticsLastError[]> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "kind", "last_error", "updated_at_utc"
         FROM "media_intelligence_runs"
         WHERE "team_id" = $1
           AND "status" = 'FAILED'
           AND "last_error" IS NOT NULL
         ORDER BY "updated_at_utc" DESC
         LIMIT 5`,
      teamId,
    )) as Array<{
      kind: string;
      last_error: string | null;
      updated_at_utc: Date | string | null;
    }>;
    return rows.map((row) => {
      const occurred = row.updated_at_utc;
      let occurredAt = "";
      if (occurred instanceof Date) {
        occurredAt = occurred.toISOString();
      } else if (typeof occurred === "string") {
        occurredAt = occurred;
      }
      return {
        source: "media_intelligence_runs",
        code: row.kind ?? "unknown",
        message: (row.last_error ?? "").slice(0, 240),
        occurredAt,
      };
    });
  } catch {
    warnings.push("last_errors_unavailable");
    return [];
  }
}
