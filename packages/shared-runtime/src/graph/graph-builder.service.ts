/**
 * Phase 32 — Investigation graph builder + traversal.
 *
 * Read-side materialization of the investigation graph from
 * existing domain data. Builds nodes + edges idempotently into
 * `investigation_graph_nodes` and `investigation_graph_edges` so
 * the API + UI can traverse without doing per-request joins
 * across every domain table.
 *
 * Hard rules:
 *   * READ-ONLY against domain tables (Evidence, EvidencePart,
 *     EvidenceReviewWorkflow, evidence_legal_holds,
 *     media_intelligence_signals). Writes ONLY to graph tables +
 *     metric counters.
 *   * Team-anchored at every read. The graph schema enforces
 *     team_id on every node + edge.
 *   * Idempotent: re-runs upsert by (team_id, node_kind, external_id)
 *     for nodes and (team_id, source, target, edge_type) for edges.
 *   * stale_at_utc lets the reconciler mark edges inactive without
 *     destroying audit trail.
 *   * Fail-closed: every query is wrapped in try/catch; failures
 *     bump a metric + return without affecting domain flows.
 *   * Never throws — callers can invoke from reconcile cron
 *     without try/catch.
 *
 * What this builder DOES this session:
 *   * Materializes EVIDENCE nodes for every Evidence row in a team
 *   * Materializes MEDIA_SIGNAL / OCR / TRANSCRIPT nodes from
 *     media_intelligence_signals
 *   * Builds HAS_MEDIA_SIGNAL / HAS_OCR / HAS_TRANSCRIPT edges
 *   * Builds SAME_HASH_AS edges from EvidencePart SHA-256 matches
 *     within the team
 *
 * What this builder DOES NOT do (deferred):
 *   * CASE / INCIDENT / REVIEW_TASK / ESCALATION / EXPORT / REPORT /
 *     VERIFICATION_PACKAGE / EXTERNAL_REVIEW nodes — those need
 *     careful integration with their respective domain services
 *     and are best done in focused follow-up sessions.
 *   * Perceptual similarity (SIMILAR_TO, POSSIBLE_DERIVATIVE_OF) —
 *     requires perceptual hashing infrastructure.
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "../prisma-registry.js";
import { bump } from "../ops/metrics.service.js";
import type { GraphEdgeType, GraphNodeKind, GraphVisibilityScope } from "./graph-catalog.js";

// =============================================================================
// Public types
// =============================================================================

export type GraphNode = {
  id: string;
  teamId: string;
  nodeKind: GraphNodeKind;
  externalId: string;
  safeLabel: string | null;
  visibilityScope: GraphVisibilityScope;
  staleAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type GraphEdge = {
  id: string;
  teamId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: GraphEdgeType;
  sourceKind: "SYSTEM" | "MANUAL";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  safeSummary: string | null;
  createdByUserId: string | null;
  staleAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type ReconcileResult = {
  ok: boolean;
  nodesUpserted: number;
  edgesUpserted: number;
  edgesStaled: number;
};

// =============================================================================
// Phase 14 — Stage 2 trigger #4: optional post-reconcile fan-out.
//
// `reconcileTeamGraph` lives in shared-runtime, but the search-indexing
// queue helper (enqueueSearchIndexingJob) lives in
// `services/api/src/queue/search-queue.ts`. shared-runtime intentionally
// has no dependency on services/api — importing the queue helper inline
// here would invert the dependency direction and pull BullMQ + ioredis
// into every shared-runtime consumer (worker included). To keep the
// dependency direction clean we expose an optional `ReconcileHook`
// callback that API + worker call sites pass in when they want the
// search index refreshed after a successful reconcile.
//
// Contract: callbacks MUST never throw to the reconciler (the
// reconciler itself wraps each call in try/catch defensively). Each
// call site that wires a hook owns its own enqueue idempotency.
// =============================================================================

export type ReconcileTeamGraphHooks = {
  /**
   * Fires once after a successful reconcileTeamGraph pass. Callers
   * (e.g. evidence-complete fan-out, reconcile cron, /v1/graph/reconcile
   * route) pass `enqueueSearchIndexingJob` here so the team's search
   * documents get refreshed with the newly-materialised graph signal
   * counts + relationship edges. Best-effort.
   */
  onReconciled?: (input: {
    teamId: string;
    result: ReconcileResult;
  }) => void | Promise<void>;
};

// =============================================================================
// Reconciliation (idempotent rebuild for one team)
// =============================================================================

/**
 * Rebuild the graph for one team. Idempotent — re-running produces
 * the same node + edge set (with refreshed timestamps). Bounded:
 * caller is responsible for invoking per-team rather than globally
 * so the reconcile cron stays within a bounded execution time.
 *
 * Returns counts but never throws. Callers (the reconcile cron)
 * just log the result.
 *
 * Phase 14 — Stage 2 trigger #4: accepts an optional `hooks` argument
 * so call sites can ask for a post-reconcile search re-index without
 * shared-runtime taking on a hard dependency on the API's queue
 * helper. See the `ReconcileTeamGraphHooks` documentation above.
 */
export async function reconcileTeamGraph(
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
  hooks: ReconcileTeamGraphHooks = {},
): Promise<ReconcileResult> {
  bump("graph_reconcile_started_total");
  let nodesUpserted = 0;
  let edgesUpserted = 0;
  let edgesStaled = 0;
  try {
    // 1. Materialize EVIDENCE nodes for every Evidence row in this team.
    const evidence = await client.evidence.findMany({
      where: { teamId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        displayFileName: true,
        originalFileName: true,
      },
    });
    for (const ev of evidence) {
      const label = (
        ev.displayFileName ??
        ev.originalFileName ??
        ev.type ??
        "Evidence record"
      )
        .toString()
        .slice(0, 240);
      const visibility = evidenceVisibility(ev.status);
      const upserted = await upsertNode(
        client,
        teamId,
        "EVIDENCE",
        ev.id,
        label,
        visibility,
      );
      if (upserted) nodesUpserted += 1;
    }

    // 1b. Phase 31.15 — CASE domain reconciliation.
    //
    // Materializes a CASE node for every `cases` row in this team
    // and a BELONGS_TO_CASE edge from EVIDENCE → CASE for every
    // evidence with a non-null caseId. This is the reference
    // pattern for the remaining 10 graph domains (INCIDENT /
    // REVIEW_TASK / etc.): a domain-scoped node upsert + a domain-
    // scoped edge upsert + a stale-tombstone sweep for rows that
    // disappeared from the source-of-truth table.
    //
    // Hard rules carried by this step:
    //   * Bounded label — Case.name is VARCHAR(120) in the schema;
    //     we truncate to 240 chars (the graph node safe_label cap)
    //     defensively in case future schema widening lands first.
    //   * Visibility: WORKSPACE_INTERNAL. Cases are reviewer surface;
    //     external reviewers are isolated by graph traversal scope.
    //   * Stale sweep: CASE nodes whose external_id is NOT in the
    //     current team's cases table get marked stale. The edge-
    //     stale sweep at the bottom of this function then cascades
    //     to incident edges automatically.
    //   * Never throws. Best-effort step; failure here doesn't fail
    //     the broader reconcile.
    try {
      type CaseRow = { id: string; name: string };
      const cases = (await client.$queryRawUnsafe(
        `SELECT "id", "name"
           FROM "cases"
           WHERE "team_id" = $1
           ORDER BY "created_at" ASC`,
        teamId,
      )) as CaseRow[];
      const seenCaseIds = new Set<string>();
      for (const c of cases) {
        seenCaseIds.add(c.id);
        const label = (c.name ?? "Case").toString().slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "CASE",
          c.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
      }

      // Stale-sweep: mark CASE nodes whose external_id is gone from
      // the cases table for this team. Single UPDATE with a NOT
      // EXISTS clause; idempotent. Re-running on a clean state is
      // a no-op.
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'CASE'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "cases" c
                  WHERE c."id"::text = n."external_id"
                    AND c."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }

      // BELONGS_TO_CASE edges for every evidence with a case_id.
      // We re-select from the evidence table (instead of using the
      // earlier in-memory list) so we can include case_id in the
      // projection; case_id wasn't in the original SELECT.
      type EvidenceWithCase = { id: string; case_id: string };
      const evidenceWithCase = (await client.$queryRawUnsafe(
        `SELECT "id", "case_id"
           FROM "evidence"
           WHERE "team_id" = $1
             AND "case_id" IS NOT NULL
             AND "deleted_at" IS NULL`,
        teamId,
      )) as EvidenceWithCase[];
      for (const ev of evidenceWithCase) {
        // Only emit an edge if the CASE actually exists in the
        // current pass (so an orphaned case_id pointing to a
        // deleted case doesn't create a dangling edge).
        if (!seenCaseIds.has(ev.case_id)) continue;
        const evidenceNodeId = await findNodeId(client, teamId, "EVIDENCE", ev.id);
        const caseNodeId = await findNodeId(client, teamId, "CASE", ev.case_id);
        if (!evidenceNodeId || !caseNodeId) continue;
        const created = await upsertEdge(
          client,
          teamId,
          evidenceNodeId,
          caseNodeId,
          "BELONGS_TO_CASE",
          "SYSTEM",
          "HIGH",
          "Evidence record is assigned to this case in the workspace.",
        );
        if (created) edgesUpserted += 1;
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1c. Phase 31.16 — REPORT domain reconciliation.
    //
    // Materializes a REPORT node for every `reports` row whose
    // parent evidence is in this team, and a GENERATED_REPORT edge
    // from EVIDENCE → REPORT. Follows the CASE pattern exactly:
    // bounded label, idempotent upsert, stale-tombstone sweep,
    // best-effort try/catch isolation.
    //
    // The reports table has no direct team_id; we anchor on the
    // parent evidence row's team_id via JOIN.
    try {
      type ReportRow = {
        id: string;
        evidence_id: string;
        version: number;
        generated_at_utc: Date;
      };
      const reports = (await client.$queryRawUnsafe(
        `SELECT r."id", r."evidence_id", r."version", r."generated_at_utc"
           FROM "reports" r
           JOIN "evidence" e ON e."id" = r."evidence_id"
           WHERE e."team_id" = $1
             AND e."deleted_at" IS NULL
           ORDER BY r."generated_at_utc" ASC`,
        teamId,
      )) as ReportRow[];
      const seenReportExternalIds = new Set<string>();
      for (const r of reports) {
        // Stable external_id: evidence-scoped + version-pinned.
        // Re-runs upsert; new versions create new nodes.
        const externalId = `${r.evidence_id}:v${r.version}`;
        seenReportExternalIds.add(externalId);
        const label = `Report v${r.version}`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "REPORT",
          externalId,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        // GENERATED_REPORT edge: Evidence → Report.
        const evidenceNodeId = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          r.evidence_id,
        );
        const reportNodeId = await findNodeId(
          client,
          teamId,
          "REPORT",
          externalId,
        );
        if (evidenceNodeId && reportNodeId) {
          const created = await upsertEdge(
            client,
            teamId,
            evidenceNodeId,
            reportNodeId,
            "GENERATED_REPORT",
            "SYSTEM",
            "HIGH",
            `Evidence record generated this report (version ${r.version}).`,
          );
          if (created) edgesUpserted += 1;
        }
      }
      // Stale-sweep: REPORT nodes whose external_id is no longer
      // backed by a (reports, evidence) join in this team.
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'REPORT'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1
                   FROM "reports" r
                   JOIN "evidence" e ON e."id" = r."evidence_id"
                  WHERE n."external_id" = r."evidence_id"::text || ':v' || r."version"::text
                    AND e."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1d. Phase 31.16 — VERIFICATION_PACKAGE domain reconciliation.
    //
    // Same pattern as REPORT. The package node represents one
    // generated verification package; the GENERATED_PACKAGE edge
    // ties Evidence → VerificationPackage.
    try {
      type PackageRow = {
        id: string;
        evidence_id: string;
        version: number;
        generated_at_utc: Date;
      };
      const packages = (await client.$queryRawUnsafe(
        `SELECT vp."id", vp."evidence_id", vp."version", vp."generated_at_utc"
           FROM "verification_packages" vp
           JOIN "evidence" e ON e."id" = vp."evidence_id"
           WHERE e."team_id" = $1
             AND e."deleted_at" IS NULL
           ORDER BY vp."generated_at_utc" ASC`,
        teamId,
      )) as PackageRow[];
      for (const p of packages) {
        const externalId = `${p.evidence_id}:v${p.version}`;
        const label = `Verification package v${p.version}`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "VERIFICATION_PACKAGE",
          externalId,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        const evidenceNodeId = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          p.evidence_id,
        );
        const pkgNodeId = await findNodeId(
          client,
          teamId,
          "VERIFICATION_PACKAGE",
          externalId,
        );
        if (evidenceNodeId && pkgNodeId) {
          const created = await upsertEdge(
            client,
            teamId,
            evidenceNodeId,
            pkgNodeId,
            "GENERATED_PACKAGE",
            "SYSTEM",
            "HIGH",
            `Evidence record generated this verification package (version ${p.version}).`,
          );
          if (created) edgesUpserted += 1;
        }
      }
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'VERIFICATION_PACKAGE'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1
                   FROM "verification_packages" vp
                   JOIN "evidence" e ON e."id" = vp."evidence_id"
                  WHERE n."external_id" = vp."evidence_id"::text || ':v' || vp."version"::text
                    AND e."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1e. Phase 31.16 — EXPORT domain reconciliation.
    //
    // Source: `governance_export_snapshots`. Has a direct team_id
    // column so no JOIN to evidence is required (but we still
    // filter to evidence_id IS NOT NULL since we only emit edges
    // for evidence-scoped exports). The export snapshot id IS the
    // graph external_id (UUID, already team-scoped).
    try {
      type ExportRow = {
        id: string;
        evidence_id: string | null;
        snapshot_kind: string;
        created_at: Date;
        export_eligibility_outcome: string;
      };
      const exports = (await client.$queryRawUnsafe(
        `SELECT "id", "evidence_id", "snapshot_kind"::text AS "snapshot_kind",
                "created_at", "export_eligibility_outcome"
           FROM "governance_export_snapshots"
           WHERE "team_id" = $1
           ORDER BY "created_at" ASC`,
        teamId,
      )) as ExportRow[];
      for (const x of exports) {
        // Label includes the bounded snapshot_kind enum + outcome
        // tag. Never includes the snapshot payload (which can
        // contain operator-private fields).
        const label = `Export — ${x.snapshot_kind} (${x.export_eligibility_outcome})`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "EXPORT",
          x.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        // EXPORTED_AS edge: only when the export is scoped to an
        // evidence row (some exports are workspace-wide).
        if (x.evidence_id) {
          const evidenceNodeId = await findNodeId(
            client,
            teamId,
            "EVIDENCE",
            x.evidence_id,
          );
          const exportNodeId = await findNodeId(
            client,
            teamId,
            "EXPORT",
            x.id,
          );
          if (evidenceNodeId && exportNodeId) {
            const created = await upsertEdge(
              client,
              teamId,
              evidenceNodeId,
              exportNodeId,
              "EXPORTED_AS",
              "SYSTEM",
              "HIGH",
              `Evidence record was exported (${x.snapshot_kind}).`,
            );
            if (created) edgesUpserted += 1;
          }
        }
      }
      // Stale-sweep: EXPORT nodes whose external_id is no longer
      // in governance_export_snapshots for this team.
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'EXPORT'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "governance_export_snapshots" x
                  WHERE x."id"::text = n."external_id"
                    AND x."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1f. Phase 31.17 — REVIEW_TASK domain reconciliation.
    //
    // Materializes one REVIEW_TASK node per `evidence_review_workflows`
    // row in this team. Each workflow row is 1-to-1 with an
    // Evidence record (workflow.evidenceId is UNIQUE in the schema),
    // so REVIEWED_BY edges from EVIDENCE → REVIEW_TASK are clean.
    //
    // Privacy invariants:
    //   * The node label uses status + priority only — NEVER pulls
    //     escalation_reason / rejection_reason / paused_reason
    //     (any of which can carry reviewer-private text).
    //   * Visibility: WORKSPACE_INTERNAL. Reviewer assignment data
    //     is workspace-scoped; external reviewers see nothing.
    try {
      type WorkflowRow = {
        id: string;
        evidence_id: string;
        status: string;
        priority: string;
      };
      const workflows = (await client.$queryRawUnsafe(
        `SELECT w."id", w."evidence_id", w."status"::text AS "status",
                w."priority"::text AS "priority"
           FROM "evidence_review_workflows" w
           JOIN "evidence" e ON e."id" = w."evidence_id"
           WHERE w."team_id" = $1
             AND e."deleted_at" IS NULL`,
        teamId,
      )) as WorkflowRow[];
      for (const w of workflows) {
        const label = `Review task — ${w.status} (${w.priority})`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "REVIEW_TASK",
          w.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        const evidenceNodeId = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          w.evidence_id,
        );
        const taskNodeId = await findNodeId(
          client,
          teamId,
          "REVIEW_TASK",
          w.id,
        );
        if (evidenceNodeId && taskNodeId) {
          const created = await upsertEdge(
            client,
            teamId,
            evidenceNodeId,
            taskNodeId,
            "REVIEWED_BY",
            "SYSTEM",
            "HIGH",
            `Evidence record has a workspace review task (${w.status}).`,
          );
          if (created) edgesUpserted += 1;
        }
      }
      // Stale-sweep: REVIEW_TASK nodes whose external_id is no
      // longer in evidence_review_workflows for this team.
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'REVIEW_TASK'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "evidence_review_workflows" w
                  WHERE w."id"::text = n."external_id"
                    AND w."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1g. Phase 31.17 — ESCALATION domain reconciliation.
    //
    // One ESCALATION node per `review_escalations` row (team-scoped).
    // ESCALATED_FROM edges: REVIEW_TASK → ESCALATION when the
    // escalation's workflowId resolves to a REVIEW_TASK node.
    //
    // Privacy: the label uses bounded reason/severity catalog
    // tokens only. NEVER pulls resolutionNote / suppressionReason
    // — both can carry private operator text.
    try {
      type EscalationRow = {
        id: string;
        workflow_id: string;
        evidence_id: string | null;
        reason: string;
        severity: string;
        status: string;
      };
      const escalations = (await client.$queryRawUnsafe(
        `SELECT "id", "workflow_id", "evidence_id", "reason",
                "severity", "status"
           FROM "review_escalations"
           WHERE "team_id" = $1`,
        teamId,
      )) as EscalationRow[];
      for (const x of escalations) {
        const label = `Escalation — ${x.reason} (${x.severity}/${x.status})`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "ESCALATION",
          x.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        const reviewTaskNodeId = await findNodeId(
          client,
          teamId,
          "REVIEW_TASK",
          x.workflow_id,
        );
        const escalationNodeId = await findNodeId(
          client,
          teamId,
          "ESCALATION",
          x.id,
        );
        if (reviewTaskNodeId && escalationNodeId) {
          const created = await upsertEdge(
            client,
            teamId,
            reviewTaskNodeId,
            escalationNodeId,
            "ESCALATED_FROM",
            "SYSTEM",
            severityToConfidence(x.severity),
            `Review task escalated (${x.reason}).`,
          );
          if (created) edgesUpserted += 1;
        }
      }
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'ESCALATION'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "review_escalations" e
                  WHERE e."id"::text = n."external_id"
                    AND e."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1h. Phase 31.17 — INCIDENT domain reconciliation.
    //
    // One INCIDENT node per `operational_incidents` row in this
    // team (note: team_id is nullable on operational_incidents —
    // we only materialize team-scoped rows here).
    //
    // Edges: REFERENCES_SAME_INCIDENT from EVIDENCE → INCIDENT
    // when the incident carries a related_evidence_id pointer.
    //
    // Privacy: the label uses bounded category + severity + status
    // only. NEVER pulls title / safe_summary into the label since
    // the label is bounded to 240 chars and the OperationalIncident
    // table's `title` can already be operator-supplied. We use the
    // bounded enum tokens to stay safe by construction.
    try {
      type IncidentRow = {
        id: string;
        related_evidence_id: string | null;
        category: string;
        severity: string;
        status: string;
      };
      const incidents = (await client.$queryRawUnsafe(
        `SELECT "id", "related_evidence_id",
                "category"::text AS "category",
                "severity"::text AS "severity",
                "status"::text AS "status"
           FROM "operational_incidents"
           WHERE "team_id" = $1`,
        teamId,
      )) as IncidentRow[];
      for (const inc of incidents) {
        const label = `Incident — ${inc.category} (${inc.severity}/${inc.status})`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "INCIDENT",
          inc.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        if (inc.related_evidence_id) {
          const evidenceNodeId = await findNodeId(
            client,
            teamId,
            "EVIDENCE",
            inc.related_evidence_id,
          );
          const incidentNodeId = await findNodeId(
            client,
            teamId,
            "INCIDENT",
            inc.id,
          );
          if (evidenceNodeId && incidentNodeId) {
            const created = await upsertEdge(
              client,
              teamId,
              evidenceNodeId,
              incidentNodeId,
              "REFERENCES_SAME_INCIDENT",
              "SYSTEM",
              severityToConfidence(inc.severity),
              `Evidence record correlated with an operational incident (${inc.category}).`,
            );
            if (created) edgesUpserted += 1;
          }
        }
      }
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'INCIDENT'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "operational_incidents" inc
                  WHERE inc."id"::text = n."external_id"
                    AND inc."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1i. Phase 31.18 — EXTERNAL_REVIEW domain reconciliation.
    //
    // Source: `external_review_grants`. One EXTERNAL_REVIEW node per
    // grant row (team-scoped). REVIEWED_BY edges from
    //   EVIDENCE/CASE/VERIFICATION_PACKAGE → EXTERNAL_REVIEW
    // depending on the grant's scope_kind.
    //
    // Privacy invariants:
    //   * The label uses bounded scope_kind + state catalog tokens
    //     only. NEVER pulls reviewer_email / reviewer_display_name /
    //     safe_note / token_hash into the label or anywhere in the
    //     graph projection. Reviewer identity stays in the external-
    //     review service and the audit log.
    //   * Visibility: WORKSPACE_INTERNAL. External reviewers must
    //     never see the existence of OTHER external review grants.
    try {
      type GrantRow = {
        id: string;
        scope_kind: string;
        state: string;
        evidence_id: string | null;
        case_id: string | null;
        package_id: string | null;
      };
      const grants = (await client.$queryRawUnsafe(
        `SELECT "id", "scope_kind", "state",
                "evidence_id", "case_id", "package_id"
           FROM "external_review_grants"
           WHERE "team_id" = $1`,
        teamId,
      )) as GrantRow[];
      for (const g of grants) {
        const label = `External review — ${g.scope_kind} (${g.state})`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "EXTERNAL_REVIEW",
          g.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        // Edge endpoint depends on scope_kind. We only emit the edge
        // when the scope target node already exists in the graph
        // (which means it was materialized by a prior step). This
        // keeps the graph self-consistent across reconcile runs.
        const reviewNodeId = await findNodeId(
          client,
          teamId,
          "EXTERNAL_REVIEW",
          g.id,
        );
        if (reviewNodeId) {
          let scopeNodeId: string | null = null;
          if (g.scope_kind === "EVIDENCE" && g.evidence_id) {
            scopeNodeId = await findNodeId(
              client,
              teamId,
              "EVIDENCE",
              g.evidence_id,
            );
          } else if (g.scope_kind === "CASE" && g.case_id) {
            scopeNodeId = await findNodeId(
              client,
              teamId,
              "CASE",
              g.case_id,
            );
          } else if (g.scope_kind === "PACKAGE" && g.package_id) {
            scopeNodeId = await findNodeId(
              client,
              teamId,
              "VERIFICATION_PACKAGE",
              g.package_id,
            );
          }
          if (scopeNodeId) {
            const created = await upsertEdge(
              client,
              teamId,
              scopeNodeId,
              reviewNodeId,
              "REVIEWED_BY",
              "SYSTEM",
              "HIGH",
              `Scoped to an external reviewer grant (${g.scope_kind}/${g.state}).`,
            );
            if (created) edgesUpserted += 1;
          }
        }
      }
      // Stale-sweep: EXTERNAL_REVIEW nodes whose external_id is no
      // longer in external_review_grants for this team.
      try {
        await client.$executeRawUnsafe(
          `UPDATE "investigation_graph_nodes" n
             SET "stale_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE n."team_id" = $1
               AND n."node_kind" = 'EXTERNAL_REVIEW'
               AND n."stale_at_utc" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "external_review_grants" g
                  WHERE g."id"::text = n."external_id"
                    AND g."team_id" = $1
               )`,
          teamId,
        );
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 1j. Phase 13 — ENTITY domain reconciliation.
    //
    // Materializes one ENTITY node per `evidence_entities` row in
    // this team and one EXTRACTED_FROM edge from ENTITY → EVIDENCE.
    // Entities are the deterministic regex-driven extraction
    // results from Phase 15 (email / phone / URL / etc.); the
    // node + edge wiring lets graph + cross-evidence surfaces see
    // them without per-request joins back to the entities table.
    //
    // Privacy invariants:
    //   * Node label uses kind + normalizedValue only — both bounded
    //     fields, never raw OCR/transcript text and never private
    //     reviewer notes. Falls back to `kind` when normalizedValue
    //     is NULL so we never leak the raw matched text.
    //   * Visibility: WORKSPACE_INTERNAL. Entities are operator-
    //     facing analytical hints, not public-verify safe.
    //   * Bounded by team_id at every read.
    //
    // Idempotency:
    //   * External_id == evidence_entities.id (a UUID), so re-running
    //     upserts the same node+edge with the same label/summary
    //     (no churn on tombstoning).
    //   * No stale-sweep — entities are immutable rows; if the
    //     evidence is deleted the cascade-delete on evidence_entities
    //     and the per-evidence stale sweep on EVIDENCE nodes (which
    //     cascades to edges via the section 4 stale-edge sweep)
    //     handles cleanup.
    try {
      type EntityRow = {
        id: string;
        evidence_id: string;
        kind: string;
        normalized_value: string | null;
      };
      const entities = (await client.$queryRawUnsafe(
        `SELECT en."id", en."evidence_id", en."kind"::text AS "kind",
                en."normalized_value"
           FROM "evidence_entities" en
           JOIN "evidence" e ON e."id" = en."evidence_id"
           WHERE en."team_id" = $1
             AND e."deleted_at" IS NULL
           ORDER BY en."created_at" ASC
           LIMIT 5000`,
        teamId,
      )) as EntityRow[];
      for (const en of entities) {
        // Bounded label: "{KIND}: {normalizedValue}" or just
        // "{KIND}" when normalizedValue is NULL. Capped at 240
        // chars by upsertNode but we trim defensively here too.
        const labelTail = en.normalized_value
          ? `: ${en.normalized_value}`
          : "";
        const label = `${en.kind}${labelTail}`.slice(0, 240);
        const upserted = await upsertNode(
          client,
          teamId,
          "ENTITY",
          en.id,
          label,
          "WORKSPACE_INTERNAL",
        );
        if (upserted) nodesUpserted += 1;
        // EXTRACTED_FROM edge: ENTITY → EVIDENCE.
        const entityNodeId = await findNodeId(client, teamId, "ENTITY", en.id);
        const evidenceNodeId = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          en.evidence_id,
        );
        if (entityNodeId && evidenceNodeId) {
          const created = await upsertEdge(
            client,
            teamId,
            entityNodeId,
            evidenceNodeId,
            "EXTRACTED_FROM",
            "SYSTEM",
            "MEDIUM",
            `Candidate ${en.kind.toLowerCase()} extracted from this evidence record.`.slice(0, 240),
          );
          if (created) edgesUpserted += 1;
        }
      }
    } catch {
      /* best-effort; the rest of the reconcile continues */
    }

    // 2. Materialize MEDIA_SIGNAL nodes + HAS_MEDIA_SIGNAL edges,
    //    and the OCR/TRANSCRIPT node kind variants on the same
    //    table (discriminated by signal_type at the materializer).
    //
    // Phase 31.19 hardening:
    //   * DISMISSED signals are EXCLUDED from materialization. A
    //     reviewer-dismissed signal must not have an active graph
    //     node. (Previously dismissed-signal nodes survived until
    //     section-2b's stale sweep — which only fires when the
    //     row is fully deleted, not merely dismissed. The stricter
    //     filter here closes that gap.)
    //   * The status-aware sweep below tombstones any existing
    //     nodes whose underlying signal is now DISMISSED, even if
    //     the row still exists in the table.
    //   * Technical detail JSON is NEVER read into the graph —
    //     the safe_summary column is operator-safe by construction
    //     (the SafeWording library enforces a closed template set).
    type SignalRow = {
      id: string;
      evidence_id: string;
      signal_type: string;
      safe_summary: string;
      severity: string;
    };
    const signals = (await client.$queryRawUnsafe(
      `SELECT "id", "evidence_id", "signal_type", "safe_summary", "severity"
         FROM "media_intelligence_signals"
         WHERE "team_id" = $1
           AND "status" IN ('PENDING', 'ACKNOWLEDGED')
         ORDER BY "created_at_utc" ASC`,
      teamId,
    )) as SignalRow[];
    for (const sig of signals) {
      // The node label is the safe_summary truncated. The summary
      // is already wording-safe (signal-catalog enforced).
      const isOcr = sig.signal_type === "OCR_AVAILABLE";
      const isTranscript = sig.signal_type === "TRANSCRIPT_AVAILABLE";
      const nodeKind: GraphNodeKind = isOcr
        ? "OCR"
        : isTranscript
          ? "TRANSCRIPT"
          : "MEDIA_SIGNAL";
      const upserted = await upsertNode(
        client,
        teamId,
        nodeKind,
        sig.id,
        sig.safe_summary.slice(0, 240),
        "WORKSPACE_INTERNAL",
      );
      if (upserted) nodesUpserted += 1;
      // Edge from evidence → signal.
      const evidenceNodeId = await findNodeId(
        client,
        teamId,
        "EVIDENCE",
        sig.evidence_id,
      );
      if (evidenceNodeId) {
        const signalNodeId = await findNodeId(
          client,
          teamId,
          nodeKind,
          sig.id,
        );
        if (signalNodeId) {
          const edgeType: GraphEdgeType = isOcr
            ? "HAS_OCR"
            : isTranscript
              ? "HAS_TRANSCRIPT"
              : "HAS_MEDIA_SIGNAL";
          const created = await upsertEdge(
            client,
            teamId,
            evidenceNodeId,
            signalNodeId,
            edgeType,
            "SYSTEM",
            confidenceForSeverity(sig.severity),
            sig.safe_summary.slice(0, 240),
          );
          if (created) edgesUpserted += 1;
        }
      }
    }

    // 2b. Phase 31.18 — per-kind stale-tombstone sweep for the three
    // signal-derived node kinds (MEDIA_SIGNAL / OCR / TRANSCRIPT).
    //
    // Without this, nodes whose underlying media_intelligence_signals
    // row was deleted (or whose evidence was soft-deleted, breaking
    // the team-anchor join) stay live forever. Each kind gets its
    // own sweep so that the kind discriminator matches what the
    // section-2 loop materialized (OCR_AVAILABLE → OCR,
    // TRANSCRIPT_AVAILABLE → TRANSCRIPT, everything else →
    // MEDIA_SIGNAL).
    //
    // Tombstones do NOT delete nodes — the audit trail (created_at,
    // safe_label, visibility_scope at creation time) remains
    // queryable via stale_at_utc IS NOT NULL. The graph traversal
    // and Case Graph Explorer both filter on stale_at_utc IS NULL.
    //
    // Phase 31.19 hardening: each sweep now ALSO matches when the
    // underlying signal exists but has status = 'DISMISSED'. Adding
    // `AND s."status" IN ('PENDING','ACKNOWLEDGED')` to the inner
    // NOT EXISTS sub-select makes "dismissed in the table" trigger
    // tombstoning, matching the section-2 materializer's filter.
    try {
      await client.$executeRawUnsafe(
        `UPDATE "investigation_graph_nodes" n
           SET "stale_at_utc" = NOW(),
               "updated_at_utc" = NOW()
           WHERE n."team_id" = $1
             AND n."node_kind" = 'MEDIA_SIGNAL'
             AND n."stale_at_utc" IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM "media_intelligence_signals" s
                WHERE s."id"::text = n."external_id"
                  AND s."team_id" = $1
                  AND s."status" IN ('PENDING', 'ACKNOWLEDGED')
                  AND s."signal_type" NOT IN ('OCR_AVAILABLE', 'TRANSCRIPT_AVAILABLE')
             )`,
        teamId,
      );
    } catch {
      /* best-effort */
    }
    try {
      await client.$executeRawUnsafe(
        `UPDATE "investigation_graph_nodes" n
           SET "stale_at_utc" = NOW(),
               "updated_at_utc" = NOW()
           WHERE n."team_id" = $1
             AND n."node_kind" = 'OCR'
             AND n."stale_at_utc" IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM "media_intelligence_signals" s
                WHERE s."id"::text = n."external_id"
                  AND s."team_id" = $1
                  AND s."status" IN ('PENDING', 'ACKNOWLEDGED')
                  AND s."signal_type" = 'OCR_AVAILABLE'
             )`,
        teamId,
      );
    } catch {
      /* best-effort */
    }
    try {
      await client.$executeRawUnsafe(
        `UPDATE "investigation_graph_nodes" n
           SET "stale_at_utc" = NOW(),
               "updated_at_utc" = NOW()
           WHERE n."team_id" = $1
             AND n."node_kind" = 'TRANSCRIPT'
             AND n."stale_at_utc" IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM "media_intelligence_signals" s
                WHERE s."id"::text = n."external_id"
                  AND s."team_id" = $1
                  AND s."status" IN ('PENDING', 'ACKNOWLEDGED')
                  AND s."signal_type" = 'TRANSCRIPT_AVAILABLE'
             )`,
        teamId,
      );
    } catch {
      /* best-effort */
    }

    // 3. Build SAME_HASH_AS edges from EvidencePart SHA-256 matches.
    // We use a self-join on the parts table, bounded to non-null
    // SHA-256, within the team. Only the upper-triangle (id < id)
    // to avoid duplicate edges in both directions.
    type DupePair = {
      a_evidence_id: string;
      b_evidence_id: string;
    };
    const dupePairs = (await client.$queryRawUnsafe(
      `SELECT DISTINCT epa."evidence_id" AS "a_evidence_id",
              epb."evidence_id" AS "b_evidence_id"
         FROM "evidence_parts" epa
         JOIN "evidence" ea ON ea."id" = epa."evidence_id"
         JOIN "evidence_parts" epb ON epb."sha256" = epa."sha256"
         JOIN "evidence" eb ON eb."id" = epb."evidence_id"
         WHERE ea."team_id" = $1
           AND eb."team_id" = $1
           AND epa."sha256" IS NOT NULL
           AND epa."id" < epb."id"
           AND epa."evidence_id" <> epb."evidence_id"
         LIMIT 200`,
      teamId,
    )) as DupePair[];
    for (const pair of dupePairs) {
      const aNode = await findNodeId(client, teamId, "EVIDENCE", pair.a_evidence_id);
      const bNode = await findNodeId(client, teamId, "EVIDENCE", pair.b_evidence_id);
      if (aNode && bNode) {
        const created = await upsertEdge(
          client,
          teamId,
          aNode,
          bNode,
          "SAME_HASH_AS",
          "SYSTEM",
          "HIGH",
          "Exact byte-identical material observed in both records.",
        );
        if (created) edgesUpserted += 1;
      }
    }

    // 3b. Phase 12 — SIMILAR_TO edges from perceptual-hash matches.
    //
    // Self-join evidence_parts on bit-popcount of XOR'd pHash strings
    // ("Hamming distance" expressed as bit-count of differing bits in
    // the 64-bit fingerprint). Distance ≤ 4 → MEDIUM confidence;
    // distance 5..8 → LOW confidence. Distance ≥ 9 is dropped — the
    // probability of unrelated images sharing 56+ identical bits is
    // negligible-but-nonzero, and we'd rather be silent than noisy on
    // a surface that affects operator reviews.
    //
    // Wrapped in try/catch because the perceptual_phash column may
    // not yet exist on partial-state databases; the reconciler is
    // best-effort and must never fail the team-graph build.
    type SimilarPair = {
      a_evidence_id: string;
      b_evidence_id: string;
      hamming: number;
    };
    try {
      const similarPairs = (await client.$queryRawUnsafe(
        `SELECT DISTINCT
                epa."evidence_id" AS "a_evidence_id",
                epb."evidence_id" AS "b_evidence_id",
                LENGTH(REPLACE(
                  (LPAD(
                    (
                      (('x' || epa."perceptual_phash")::bit(64))::bigint
                      # (('x' || epb."perceptual_phash")::bit(64))::bigint
                    )::bit(64)::text,
                    64,
                    '0'
                  )),
                  '0',
                  ''
                ))::int AS "hamming"
           FROM "evidence_parts" epa
           JOIN "evidence" ea ON ea."id" = epa."evidence_id"
           JOIN "evidence_parts" epb ON epb."perceptual_phash" IS NOT NULL
           JOIN "evidence" eb ON eb."id" = epb."evidence_id"
          WHERE ea."team_id" = $1
            AND eb."team_id" = $1
            AND epa."perceptual_phash" IS NOT NULL
            AND epa."id" < epb."id"
            AND epa."evidence_id" <> epb."evidence_id"
            AND (epa."sha256" IS NULL
                 OR epb."sha256" IS NULL
                 OR epa."sha256" <> epb."sha256")
          LIMIT 500`,
        teamId,
      )) as SimilarPair[];
      const seenPair = new Set<string>();
      for (const pair of similarPairs) {
        const hamming = Number(pair.hamming ?? 0);
        if (!Number.isFinite(hamming) || hamming > 8) continue;
        const confidence: "MEDIUM" | "LOW" = hamming <= 4 ? "MEDIUM" : "LOW";
        // De-dupe at the (aEvidence, bEvidence) level — multiple parts
        // could match across the same two evidence records; we want
        // one SIMILAR_TO edge per evidence pair, not one per part.
        const key = `${pair.a_evidence_id}|${pair.b_evidence_id}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const aNode = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          pair.a_evidence_id,
        );
        const bNode = await findNodeId(
          client,
          teamId,
          "EVIDENCE",
          pair.b_evidence_id,
        );
        if (aNode && bNode) {
          const created = await upsertEdge(
            client,
            teamId,
            aNode,
            bNode,
            "SIMILAR_TO",
            "SYSTEM",
            confidence,
            "Visually similar material detected; operator review required.",
          );
          if (created) edgesUpserted += 1;
        }
      }
    } catch {
      // perceptual_phash column may not exist yet (Phase 12 migration
      // not applied) — best-effort, never fails reconcile.
    }

    // 4. Stale-edge sweep. Edges whose source or target node is
    // stale (or whose underlying domain row is gone) get marked
    // inactive. This is best-effort — a failure here doesn't
    // affect domain flow.
    try {
      const result = await client.$executeRawUnsafe(
        `UPDATE "investigation_graph_edges" e
           SET "stale_at_utc" = NOW(),
               "updated_at_utc" = NOW()
           WHERE e."team_id" = $1
             AND e."stale_at_utc" IS NULL
             AND (
               EXISTS (
                 SELECT 1 FROM "investigation_graph_nodes" n
                  WHERE n."id" = e."source_node_id"
                    AND n."stale_at_utc" IS NOT NULL
               )
               OR EXISTS (
                 SELECT 1 FROM "investigation_graph_nodes" n
                  WHERE n."id" = e."target_node_id"
                    AND n."stale_at_utc" IS NOT NULL
               )
             )`,
        teamId,
      );
      edgesStaled = typeof result === "number" ? result : 0;
      if (edgesStaled > 0) bump("graph_edge_removed_total", edgesStaled);
    } catch {
      /* best-effort */
    }

    bump("graph_reconcile_completed_total");
    const result: ReconcileResult = {
      ok: true,
      nodesUpserted,
      edgesUpserted,
      edgesStaled,
    };
    // Phase 14 — Stage 2 trigger #4: fire the optional post-reconcile
    // hook. The hook is best-effort; we swallow any error here so a
    // failed search-index enqueue can never poison the reconcile
    // return value. Callers can still observe failures via metrics
    // (search_indexing_enqueue_failed_total) and the SecurityEvent
    // stream surfaced by the queue helper itself.
    if (hooks.onReconciled) {
      try {
        await hooks.onReconciled({ teamId, result });
      } catch {
        /* Phase 14 — best-effort; never block reconcile completion. */
      }
    }
    return result;
  } catch {
    bump("graph_reconcile_failed_total");
    return {
      ok: false,
      nodesUpserted,
      edgesUpserted,
      edgesStaled,
    };
  }
}

// =============================================================================
// Visibility-aware traversal
// =============================================================================

export type EvidenceSubgraphInput = {
  teamId: string;
  evidenceId: string;
  /** Bounded 0..MAX_GRAPH_TRAVERSAL_DEPTH. */
  depth?: number;
};

export type EvidenceSubgraphResult = {
  ok: true;
  nodes: ReadonlyArray<GraphNode>;
  edges: ReadonlyArray<GraphEdge>;
  truncated: boolean;
};

/**
 * Build a subgraph rooted at one evidence node, traversing up to
 * `depth` hops. Visibility-aware: stale nodes/edges are filtered
 * out. Team-anchored. Bounded result size.
 *
 * Returns `truncated: true` when either the node or edge cap was
 * hit. Caller surfaces this to the UI so the operator can refine
 * the query.
 */
export async function buildEvidenceSubgraph(
  input: EvidenceSubgraphInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<EvidenceSubgraphResult> {
  const {
    MAX_GRAPH_TRAVERSAL_DEPTH,
    MAX_GRAPH_NODES_PER_RESPONSE,
    MAX_GRAPH_EDGES_PER_RESPONSE,
  } = await import("./graph-catalog.js");
  const depth = Math.max(
    0,
    Math.min(input.depth ?? 2, MAX_GRAPH_TRAVERSAL_DEPTH),
  );
  bump("graph_query_total");
  // Find the seed node for this evidence.
  const seedRows = (await client.$queryRawUnsafe(
    `SELECT "id", "team_id", "node_kind", "external_id", "safe_label",
            "visibility_scope", "stale_at_utc", "created_at_utc", "updated_at_utc"
       FROM "investigation_graph_nodes"
       WHERE "team_id" = $1 AND "node_kind" = 'EVIDENCE'
         AND "external_id" = $2 AND "stale_at_utc" IS NULL
       LIMIT 1`,
    input.teamId,
    input.evidenceId,
  )) as RawNodeRow[];
  if (seedRows.length === 0) {
    // No seed node → empty subgraph. Anti-enumeration: same shape
    // as "evidence exists but has no graph yet".
    return { ok: true, nodes: [], edges: [], truncated: false };
  }
  const seedNode = seedRows[0]!;
  const collectedNodes = new Map<string, RawNodeRow>();
  const collectedEdges = new Map<string, RawEdgeRow>();
  collectedNodes.set(seedNode.id, seedNode);
  let frontier = new Set<string>([seedNode.id]);
  let truncated = false;

  for (let hop = 0; hop < depth; hop++) {
    if (frontier.size === 0) break;
    if (collectedNodes.size >= MAX_GRAPH_NODES_PER_RESPONSE) {
      truncated = true;
      break;
    }
    // Pull all edges where source or target is in the current
    // frontier and which are not stale.
    const frontierIds = Array.from(frontier);
    const edges = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "source_node_id", "target_node_id",
              "edge_type", "source_kind", "confidence", "safe_summary",
              "created_by_user_id", "stale_at_utc",
              "created_at_utc", "updated_at_utc"
         FROM "investigation_graph_edges"
         WHERE "team_id" = $1
           AND "stale_at_utc" IS NULL
           AND ("source_node_id" = ANY($2::uuid[])
                OR "target_node_id" = ANY($2::uuid[]))
         LIMIT $3`,
      input.teamId,
      frontierIds,
      MAX_GRAPH_EDGES_PER_RESPONSE - collectedEdges.size,
    )) as RawEdgeRow[];
    const nextFrontier = new Set<string>();
    for (const e of edges) {
      if (collectedEdges.size >= MAX_GRAPH_EDGES_PER_RESPONSE) {
        truncated = true;
        break;
      }
      collectedEdges.set(e.id, e);
      const otherEnd = frontier.has(e.source_node_id)
        ? e.target_node_id
        : e.source_node_id;
      if (!collectedNodes.has(otherEnd)) {
        nextFrontier.add(otherEnd);
      }
    }
    // Hydrate the new nodes.
    if (nextFrontier.size > 0) {
      const newIds = Array.from(nextFrontier);
      const nodes = (await client.$queryRawUnsafe(
        `SELECT "id", "team_id", "node_kind", "external_id", "safe_label",
                "visibility_scope", "stale_at_utc",
                "created_at_utc", "updated_at_utc"
           FROM "investigation_graph_nodes"
           WHERE "team_id" = $1
             AND "id" = ANY($2::uuid[])
             AND "stale_at_utc" IS NULL`,
        input.teamId,
        newIds,
      )) as RawNodeRow[];
      for (const n of nodes) {
        collectedNodes.set(n.id, n);
      }
    }
    frontier = nextFrontier;
  }
  return {
    ok: true,
    nodes: Array.from(collectedNodes.values()).map(projectNode),
    edges: Array.from(collectedEdges.values()).map(projectEdge),
    truncated,
  };
}

// =============================================================================
// Manual relationship API (write side)
// =============================================================================

export type CreateManualRelationshipInput = {
  teamId: string;
  actorUserId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: "REFERENCES_SAME_INCIDENT" | "MANUALLY_LINKED_TO";
  safeNote?: string | null;
};

export type CreateManualRelationshipResult =
  | {
      ok: true;
      manualRelationshipId: string;
      edgeId: string;
    }
  | { ok: false; reason: "nodes_not_in_team" | "service_unavailable" };

export async function createManualRelationship(
  input: CreateManualRelationshipInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<CreateManualRelationshipResult> {
  try {
    // Both endpoints must belong to this team (anti-enumeration).
    const endpoints = (await client.$queryRawUnsafe(
      `SELECT "id"
         FROM "investigation_graph_nodes"
         WHERE "team_id" = $1
           AND "id" = ANY($2::uuid[])
           AND "stale_at_utc" IS NULL`,
      input.teamId,
      [input.sourceNodeId, input.targetNodeId],
    )) as Array<{ id: string }>;
    const ids = new Set(endpoints.map((r) => r.id));
    if (!ids.has(input.sourceNodeId) || !ids.has(input.targetNodeId)) {
      return { ok: false, reason: "nodes_not_in_team" };
    }
    // Insert audit row.
    const auditRows = (await client.$queryRawUnsafe(
      `INSERT INTO "manual_relationships"
         ("team_id", "source_node_id", "target_node_id",
          "edge_type", "created_by_user_id", "safe_note", "status")
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       RETURNING "id"`,
      input.teamId,
      input.sourceNodeId,
      input.targetNodeId,
      input.edgeType,
      input.actorUserId,
      input.safeNote?.slice(0, 400) ?? null,
    )) as Array<{ id: string }>;
    const manualRelationshipId = auditRows[0]!.id;
    // Upsert the corresponding graph edge.
    const edgeRows = (await client.$queryRawUnsafe(
      `INSERT INTO "investigation_graph_edges"
         ("team_id", "source_node_id", "target_node_id", "edge_type",
          "source_kind", "confidence", "safe_summary", "created_by_user_id")
       VALUES ($1, $2, $3, $4, 'MANUAL', 'MEDIUM', $5, $6)
       ON CONFLICT ("team_id", "source_node_id", "target_node_id", "edge_type")
       DO UPDATE SET
         "safe_summary" = EXCLUDED."safe_summary",
         "stale_at_utc" = NULL,
         "updated_at_utc" = NOW()
       RETURNING "id"`,
      input.teamId,
      input.sourceNodeId,
      input.targetNodeId,
      input.edgeType,
      input.safeNote?.slice(0, 240) ?? "Manually linked by operator.",
      input.actorUserId,
    )) as Array<{ id: string }>;
    bump("graph_edge_created_total");
    return {
      ok: true,
      manualRelationshipId,
      edgeId: edgeRows[0]!.id,
    };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

export type RetractManualRelationshipInput = {
  teamId: string;
  manualRelationshipId: string;
  actorUserId: string;
  reason?: string | null;
};

export async function retractManualRelationship(
  input: RetractManualRelationshipInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ ok: boolean }> {
  try {
    // Mark the manual relationship RETRACTED + stale the graph edge.
    const rels = (await client.$queryRawUnsafe(
      `UPDATE "manual_relationships"
         SET "status" = 'RETRACTED',
             "retracted_by_user_id" = $3,
             "retracted_at_utc" = NOW(),
             "retraction_reason" = $4
         WHERE "id" = $1 AND "team_id" = $2 AND "status" = 'ACTIVE'
         RETURNING "source_node_id", "target_node_id", "edge_type"`,
      input.manualRelationshipId,
      input.teamId,
      input.actorUserId,
      input.reason?.slice(0, 240) ?? null,
    )) as Array<{
      source_node_id: string;
      target_node_id: string;
      edge_type: string;
    }>;
    if (rels.length === 0) {
      // Already retracted / not found / wrong team — idempotent.
      return { ok: true };
    }
    const rel = rels[0]!;
    await client.$executeRawUnsafe(
      `UPDATE "investigation_graph_edges"
         SET "stale_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "team_id" = $1 AND "source_node_id" = $2
           AND "target_node_id" = $3 AND "edge_type" = $4
           AND "source_kind" = 'MANUAL'`,
      input.teamId,
      rel.source_node_id,
      rel.target_node_id,
      rel.edge_type,
    );
    bump("graph_edge_removed_total");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// =============================================================================
// Phase 31.18 — duplicate / similarity edges listing (workspace-wide)
//
// Returns evidence-to-evidence edges of three bounded edge types
// (SAME_HASH_AS, SIMILAR_TO, POSSIBLE_DERIVATIVE_OF) so the
// Duplicate / Similarity Review surface can list them without
// requesting a per-evidence subgraph.
//
// Hard rules:
//   * Team-anchored. Both endpoints' team_id must match.
//   * Stale edges excluded.
//   * Bounded `limit` (max 200).
//   * Read-only — never modifies graph state.
//   * Returns the EVIDENCE node external_ids (which are evidence
//     UUIDs) alongside the edge so the UI can pivot directly.
// =============================================================================

export type DuplicateEdge = {
  edgeId: string;
  edgeType: "SAME_HASH_AS" | "SIMILAR_TO" | "POSSIBLE_DERIVATIVE_OF";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  safeSummary: string | null;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  observedAtUtc: string;
};

export type ListDuplicateEdgesInput = {
  teamId: string;
  /** Optional anchor — when set, only edges touching this evidence
   *  id are returned. Pure filter, not a search. */
  evidenceId?: string | null;
  /** Bounded 1..200; default 100. */
  limit?: number;
};

const DUPLICATE_EDGE_TYPES = [
  "SAME_HASH_AS",
  "SIMILAR_TO",
  "POSSIBLE_DERIVATIVE_OF",
] as const;

export async function listDuplicateEdges(
  input: ListDuplicateEdgesInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ edges: ReadonlyArray<DuplicateEdge>; truncated: boolean }> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  bump("graph_duplicate_list_total");
  type Row = {
    edge_id: string;
    edge_type: string;
    confidence: string;
    safe_summary: string | null;
    source_external_id: string;
    target_external_id: string;
    updated_at_utc: Date;
  };
  let rows: Row[] = [];
  try {
    if (input.evidenceId) {
      rows = (await client.$queryRawUnsafe(
        `SELECT e."id" AS "edge_id",
                e."edge_type",
                e."confidence",
                e."safe_summary",
                ns."external_id" AS "source_external_id",
                nt."external_id" AS "target_external_id",
                e."updated_at_utc"
           FROM "investigation_graph_edges" e
           JOIN "investigation_graph_nodes" ns ON ns."id" = e."source_node_id"
           JOIN "investigation_graph_nodes" nt ON nt."id" = e."target_node_id"
          WHERE e."team_id" = $1
            AND e."stale_at_utc" IS NULL
            AND ns."team_id" = $1
            AND nt."team_id" = $1
            AND ns."node_kind" = 'EVIDENCE'
            AND nt."node_kind" = 'EVIDENCE'
            AND e."edge_type" IN ('SAME_HASH_AS','SIMILAR_TO','POSSIBLE_DERIVATIVE_OF')
            AND (ns."external_id" = $2 OR nt."external_id" = $2)
          ORDER BY e."updated_at_utc" DESC
          LIMIT $3`,
        input.teamId,
        input.evidenceId,
        limit + 1,
      )) as Row[];
    } else {
      rows = (await client.$queryRawUnsafe(
        `SELECT e."id" AS "edge_id",
                e."edge_type",
                e."confidence",
                e."safe_summary",
                ns."external_id" AS "source_external_id",
                nt."external_id" AS "target_external_id",
                e."updated_at_utc"
           FROM "investigation_graph_edges" e
           JOIN "investigation_graph_nodes" ns ON ns."id" = e."source_node_id"
           JOIN "investigation_graph_nodes" nt ON nt."id" = e."target_node_id"
          WHERE e."team_id" = $1
            AND e."stale_at_utc" IS NULL
            AND ns."team_id" = $1
            AND nt."team_id" = $1
            AND ns."node_kind" = 'EVIDENCE'
            AND nt."node_kind" = 'EVIDENCE'
            AND e."edge_type" IN ('SAME_HASH_AS','SIMILAR_TO','POSSIBLE_DERIVATIVE_OF')
          ORDER BY e."updated_at_utc" DESC
          LIMIT $2`,
        input.teamId,
        limit + 1,
      )) as Row[];
    }
  } catch {
    return { edges: [], truncated: false };
  }
  const truncated = rows.length > limit;
  const trimmed = truncated ? rows.slice(0, limit) : rows;
  const edges: DuplicateEdge[] = trimmed.map((r) => ({
    edgeId: r.edge_id,
    edgeType: r.edge_type as DuplicateEdge["edgeType"],
    confidence: r.confidence as DuplicateEdge["confidence"],
    safeSummary: r.safe_summary,
    sourceEvidenceId: r.source_external_id,
    targetEvidenceId: r.target_external_id,
    observedAtUtc: r.updated_at_utc.toISOString(),
  }));
  return { edges, truncated };
}

// =============================================================================
// Phase 31.18 — workspace graph seed listing
//
// Returns a bounded list of "seed" nodes operators may want to
// open in the Graph Navigation Explorer. We anchor on CASE,
// INCIDENT, REPORT, and EVIDENCE — these are the kinds where
// operators typically start a graph traversal.
//
// Hard rules:
//   * Team-anchored, stale excluded.
//   * Bounded per-kind cap (max 50 per kind).
//   * No safe_label leak — uses the WORKSPACE_INTERNAL projection
//     already enforced on the node row.
// =============================================================================

export type GraphSeedNode = {
  id: string;
  nodeKind: GraphNodeKind;
  externalId: string;
  safeLabel: string | null;
  updatedAtUtc: string;
};

export async function listGraphSeedNodes(
  input: {
    teamId: string;
    kinds?: ReadonlyArray<GraphNodeKind> | null;
    perKindLimit?: number;
  },
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ nodes: ReadonlyArray<GraphSeedNode> }> {
  const cap = Math.max(1, Math.min(input.perKindLimit ?? 25, 50));
  const requestedKinds =
    input.kinds && input.kinds.length > 0
      ? input.kinds
      : (["CASE", "INCIDENT", "REPORT", "EVIDENCE"] as const);
  const collected: GraphSeedNode[] = [];
  for (const kind of requestedKinds) {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT "id", "node_kind", "external_id", "safe_label", "updated_at_utc"
           FROM "investigation_graph_nodes"
           WHERE "team_id" = $1
             AND "node_kind" = $2
             AND "stale_at_utc" IS NULL
           ORDER BY "updated_at_utc" DESC
           LIMIT $3`,
        input.teamId,
        kind,
        cap,
      )) as Array<{
        id: string;
        node_kind: string;
        external_id: string;
        safe_label: string | null;
        updated_at_utc: Date;
      }>;
      for (const r of rows) {
        collected.push({
          id: r.id,
          nodeKind: r.node_kind as GraphNodeKind,
          externalId: r.external_id,
          safeLabel: r.safe_label,
          updatedAtUtc: r.updated_at_utc.toISOString(),
        });
      }
    } catch {
      /* best-effort per kind */
    }
  }
  return { nodes: collected };
}

// =============================================================================
// Internals
// =============================================================================

type RawNodeRow = {
  id: string;
  team_id: string;
  node_kind: string;
  external_id: string;
  safe_label: string | null;
  visibility_scope: string;
  stale_at_utc: Date | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

type RawEdgeRow = {
  id: string;
  team_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  source_kind: string;
  confidence: string;
  safe_summary: string | null;
  created_by_user_id: string | null;
  stale_at_utc: Date | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

function projectNode(raw: RawNodeRow): GraphNode {
  return {
    id: raw.id,
    teamId: raw.team_id,
    nodeKind: raw.node_kind as GraphNodeKind,
    externalId: raw.external_id,
    safeLabel: raw.safe_label,
    visibilityScope: raw.visibility_scope as GraphVisibilityScope,
    staleAtUtc: raw.stale_at_utc?.toISOString() ?? null,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}

function projectEdge(raw: RawEdgeRow): GraphEdge {
  return {
    id: raw.id,
    teamId: raw.team_id,
    sourceNodeId: raw.source_node_id,
    targetNodeId: raw.target_node_id,
    edgeType: raw.edge_type as GraphEdgeType,
    sourceKind: raw.source_kind as "SYSTEM" | "MANUAL",
    confidence: raw.confidence as "LOW" | "MEDIUM" | "HIGH",
    safeSummary: raw.safe_summary,
    createdByUserId: raw.created_by_user_id,
    staleAtUtc: raw.stale_at_utc?.toISOString() ?? null,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}

function evidenceVisibility(_status: string): GraphVisibilityScope {
  // Today we treat every evidence node as WORKSPACE_INTERNAL.
  // Future phases that need narrower visibility (e.g.
  // REVIEWER_RESTRICTED for sensitive content) wire that here.
  return "WORKSPACE_INTERNAL";
}

function confidenceForSeverity(
  severity: string,
): "LOW" | "MEDIUM" | "HIGH" {
  if (severity === "ATTENTION") return "HIGH";
  if (severity === "REVIEW_RECOMMENDED") return "MEDIUM";
  return "LOW";
}

/**
 * Phase 31.17 — incident/escalation severity → graph confidence.
 *
 * The reviewer-ops vocabulary (CRITICAL/HIGH/WARNING/INFO) is
 * different from the media-intelligence vocabulary; this helper
 * maps it onto the bounded LOW/MEDIUM/HIGH graph confidence enum.
 */
function severityToConfidence(
  severity: string,
): "LOW" | "MEDIUM" | "HIGH" {
  const s = severity?.toUpperCase?.() ?? "";
  if (s === "CRITICAL" || s === "HIGH") return "HIGH";
  if (s === "WARNING" || s === "MEDIUM") return "MEDIUM";
  return "LOW";
}

async function upsertNode(
  client: PrismaClient,
  teamId: string,
  nodeKind: GraphNodeKind,
  externalId: string,
  safeLabel: string,
  visibility: GraphVisibilityScope,
): Promise<boolean> {
  try {
    await client.$executeRawUnsafe(
      `INSERT INTO "investigation_graph_nodes"
         ("team_id", "node_kind", "external_id", "safe_label", "visibility_scope")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("team_id", "node_kind", "external_id")
       DO UPDATE SET
         "safe_label" = EXCLUDED."safe_label",
         "stale_at_utc" = NULL,
         "updated_at_utc" = NOW()`,
      teamId,
      nodeKind,
      externalId,
      safeLabel,
      visibility,
    );
    bump("graph_node_created_total");
    return true;
  } catch {
    return false;
  }
}

async function findNodeId(
  client: PrismaClient,
  teamId: string,
  nodeKind: GraphNodeKind,
  externalId: string,
): Promise<string | null> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id" FROM "investigation_graph_nodes"
         WHERE "team_id" = $1 AND "node_kind" = $2 AND "external_id" = $3
         LIMIT 1`,
      teamId,
      nodeKind,
      externalId,
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function upsertEdge(
  client: PrismaClient,
  teamId: string,
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: GraphEdgeType,
  sourceKind: "SYSTEM" | "MANUAL",
  confidence: "LOW" | "MEDIUM" | "HIGH",
  safeSummary: string,
): Promise<boolean> {
  try {
    await client.$executeRawUnsafe(
      `INSERT INTO "investigation_graph_edges"
         ("team_id", "source_node_id", "target_node_id", "edge_type",
          "source_kind", "confidence", "safe_summary")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("team_id", "source_node_id", "target_node_id", "edge_type")
       DO UPDATE SET
         "safe_summary" = EXCLUDED."safe_summary",
         "confidence" = EXCLUDED."confidence",
         "stale_at_utc" = NULL,
         "updated_at_utc" = NOW()`,
      teamId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      sourceKind,
      confidence,
      safeSummary,
    );
    bump("graph_edge_created_total");
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Phase 32.5 — Additional read APIs
// =============================================================================

export type SearchGraphInput = {
  teamId: string;
  nodeKinds?: ReadonlyArray<GraphNodeKind> | null;
  edgeTypes?: ReadonlyArray<GraphEdgeType> | null;
  /** Substring filter on safe_label. Bounded to 80 chars by the
   *  caller. Case-insensitive. */
  labelContains?: string | null;
  /** Bounded — caller clamps to [1, 200]. */
  limit?: number;
};

export type SearchGraphResult = {
  ok: true;
  nodes: ReadonlyArray<GraphNode>;
  truncated: boolean;
};

/**
 * Filter-shaped graph search. Returns nodes (not edges) matching
 * the bounded filter set. Team-anchored. Visibility-aware (stale
 * nodes excluded).
 */
export async function searchGraph(
  input: SearchGraphInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<SearchGraphResult> {
  const { MAX_GRAPH_NODES_PER_RESPONSE } = await import("./graph-catalog.js");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? 50, MAX_GRAPH_NODES_PER_RESPONSE),
  );
  bump("graph_query_total");
  try {
    const where: string[] = [`"team_id" = $1`, `"stale_at_utc" IS NULL`];
    const params: unknown[] = [input.teamId];
    const kindFilter =
      input.nodeKinds && input.nodeKinds.length > 0 ? input.nodeKinds : null;
    if (kindFilter) {
      params.push([...kindFilter]);
      where.push(`"node_kind" = ANY($${params.length}::text[])`);
    }
    const labelFilter = input.labelContains?.trim() ?? null;
    if (labelFilter) {
      params.push(`%${labelFilter}%`);
      where.push(`"safe_label" ILIKE $${params.length}`);
    }
    params.push(limit + 1);
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "node_kind", "external_id", "safe_label",
              "visibility_scope", "stale_at_utc", "created_at_utc", "updated_at_utc"
         FROM "investigation_graph_nodes"
         WHERE ${where.join(" AND ")}
         ORDER BY "updated_at_utc" DESC
         LIMIT $${params.length}`,
      ...params,
    )) as RawNodeRow[];
    const truncated = rows.length > limit;
    return {
      ok: true,
      nodes: rows.slice(0, limit).map(projectNode),
      truncated,
    };
  } catch {
    bump("graph_query_denied_total");
    return { ok: true, nodes: [], truncated: false };
  }
}

export type TimelineQueryInput = {
  teamId: string;
  rootNodeId?: string | null;
  /** Phase 31.7 — when provided, the timeline unions evidence-keyed
   *  event streams (lifecycle events, media intelligence runs +
   *  signals) for this evidence_id in addition to the graph events. */
  evidenceId?: string | null;
  fromUtc?: string | null;
  toUtc?: string | null;
  limit?: number;
};

export type TimelineEventKind =
  | "NODE_CREATED"
  | "EDGE_CREATED"
  | "EDGE_REMOVED"
  | "LIFECYCLE_EVENT"
  | "MEDIA_RUN_STARTED"
  | "MEDIA_RUN_COMPLETED"
  | "MEDIA_RUN_FAILED"
  | "MEDIA_SIGNAL_CREATED"
  | "MEDIA_SIGNAL_ACKNOWLEDGED"
  // Phase 13 — intelligence-chain events on the per-evidence
  // timeline. EXTRACTED_TEXT_COMPLETED fires when an OCR /
  // transcript extraction row reaches status COMPLETED;
  // ENTITY_EXTRACTED fires when an entity row is persisted. Both
  // events are gated on `evidenceId` (the timeline route only
  // unions them when an evidence_id was supplied) to avoid full
  // table scans on global queries.
  | "EXTRACTED_TEXT_COMPLETED"
  | "ENTITY_EXTRACTED";

export type TimelineEvent = {
  id: string;
  kind: TimelineEventKind;
  atUtc: string;
  summary: string;
  nodeId: string;
  otherNodeId: string | null;
  edgeType: GraphEdgeType | null;
};

export type TimelineQueryResult = {
  ok: true;
  events: ReadonlyArray<TimelineEvent>;
  truncated: boolean;
};

/**
 * Unified investigation timeline. Sources from graph node + edge
 * creation/staling timestamps. Future phases can union additional
 * event streams (custody events, escalations, exports) into this
 * projection. Bounded result + visibility-aware.
 */
export async function buildInvestigationTimeline(
  input: TimelineQueryInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<TimelineQueryResult> {
  const { MAX_GRAPH_NODES_PER_RESPONSE } = await import("./graph-catalog.js");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? 50, MAX_GRAPH_NODES_PER_RESPONSE),
  );
  bump("timeline_query_total");
  try {
    const params: unknown[] = [input.teamId];
    const nodeWhere: string[] = [
      `n."team_id" = $1`,
      `n."stale_at_utc" IS NULL`,
    ];
    const edgeWhere: string[] = [`e."team_id" = $1`];
    // Evidence-keyed event streams share the team-id binding and an
    // optional evidence-id binding; we collect their WHERE fragments
    // separately so we only union them when `evidenceId` is provided
    // (avoids scanning the full lifecycle table for global queries).
    const lifecycleWhere: string[] = [`le."team_id" = $1`];
    const runsWhere: string[] = [`r."team_id" = $1`];
    const signalsWhere: string[] = [`s."team_id" = $1`];
    // Phase 13 — extracted-text + entity event streams. Both are
    // evidence-keyed; team_id is enforced and an evidence_id pin
    // is added below when input.evidenceId is provided.
    const extractedWhere: string[] = [`et."team_id" = $1`];
    const entityWhere: string[] = [`ent."team_id" = $1`];

    if (input.rootNodeId) {
      params.push(input.rootNodeId);
      const p = params.length;
      nodeWhere.push(`n."id" = $${p}`);
      edgeWhere.push(
        `(e."source_node_id" = $${p} OR e."target_node_id" = $${p})`,
      );
    }
    let evidenceParamIndex: number | null = null;
    if (input.evidenceId) {
      params.push(input.evidenceId);
      evidenceParamIndex = params.length;
      lifecycleWhere.push(`le."evidence_id" = $${evidenceParamIndex}`);
      runsWhere.push(`r."evidence_id" = $${evidenceParamIndex}`);
      signalsWhere.push(`s."evidence_id" = $${evidenceParamIndex}`);
      extractedWhere.push(`et."evidence_id" = $${evidenceParamIndex}`);
      entityWhere.push(`ent."evidence_id" = $${evidenceParamIndex}`);
    }
    if (input.fromUtc) {
      params.push(new Date(input.fromUtc));
      const p = params.length;
      nodeWhere.push(`n."created_at_utc" >= $${p}`);
      edgeWhere.push(
        `(e."created_at_utc" >= $${p} OR (e."stale_at_utc" IS NOT NULL AND e."stale_at_utc" >= $${p}))`,
      );
      lifecycleWhere.push(`le."created_at" >= $${p}`);
      runsWhere.push(
        `(r."created_at_utc" >= $${p} OR r."started_at_utc" >= $${p} OR r."completed_at_utc" >= $${p})`,
      );
      signalsWhere.push(
        `(s."created_at_utc" >= $${p} OR s."acknowledged_at_utc" >= $${p})`,
      );
      extractedWhere.push(
        `(COALESCE(et."extracted_at_utc", et."updated_at") >= $${p})`,
      );
      entityWhere.push(`ent."created_at" >= $${p}`);
    }
    if (input.toUtc) {
      params.push(new Date(input.toUtc));
      const p = params.length;
      nodeWhere.push(`n."created_at_utc" < $${p}`);
      edgeWhere.push(
        `(e."created_at_utc" < $${p} OR (e."stale_at_utc" IS NOT NULL AND e."stale_at_utc" < $${p}))`,
      );
      lifecycleWhere.push(`le."created_at" < $${p}`);
      runsWhere.push(`r."created_at_utc" < $${p}`);
      signalsWhere.push(`s."created_at_utc" < $${p}`);
      extractedWhere.push(
        `(COALESCE(et."extracted_at_utc", et."updated_at") < $${p})`,
      );
      entityWhere.push(`ent."created_at" < $${p}`);
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    // The base UNION (graph nodes + edges) is always included. When
    // evidenceId is provided we extend it with three more streams:
    // lifecycle events, MI runs (started/completed/failed/dismissed),
    // and MI signals (created/acknowledged). Each stream emits the
    // same projection shape so the UNION's column types line up.
    const evidenceStreams = input.evidenceId
      ? `
       UNION ALL
       (
         SELECT 'LIFECYCLE_EVENT'::text AS "kind",
                le."created_at" AS "at_utc",
                COALESCE(le."summary", le."event_type") AS "summary",
                le."evidence_id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "evidence_lifecycle_events" le
           WHERE ${lifecycleWhere.join(" AND ")}
       )
       UNION ALL
       (
         SELECT CASE
                  WHEN r."status" = 'COMPLETED' THEN 'MEDIA_RUN_COMPLETED'
                  WHEN r."status" = 'FAILED' THEN 'MEDIA_RUN_FAILED'
                  ELSE 'MEDIA_RUN_STARTED'
                END AS "kind",
                COALESCE(r."completed_at_utc", r."started_at_utc", r."created_at_utc") AS "at_utc",
                ('Media intelligence run: ' || r."kind")::text AS "summary",
                r."evidence_id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "media_intelligence_runs" r
           WHERE ${runsWhere.join(" AND ")}
       )
       UNION ALL
       (
         SELECT CASE
                  WHEN s."status" = 'ACKNOWLEDGED' OR s."status" = 'DISMISSED'
                    THEN 'MEDIA_SIGNAL_ACKNOWLEDGED'
                  ELSE 'MEDIA_SIGNAL_CREATED'
                END AS "kind",
                COALESCE(s."acknowledged_at_utc", s."created_at_utc") AS "at_utc",
                s."safe_summary" AS "summary",
                s."evidence_id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "media_intelligence_signals" s
           WHERE ${signalsWhere.join(" AND ")}
       )
       UNION ALL
       (
         SELECT 'EXTRACTED_TEXT_COMPLETED'::text AS "kind",
                COALESCE(et."extracted_at_utc", et."updated_at") AS "at_utc",
                ('Text extracted (' || et."kind"::text || ')')::text AS "summary",
                et."evidence_id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "evidence_extracted_texts" et
           WHERE ${extractedWhere.join(" AND ")}
             AND et."status" = 'COMPLETED'
       )
       UNION ALL
       (
         SELECT 'ENTITY_EXTRACTED'::text AS "kind",
                ent."created_at" AS "at_utc",
                (
                  'Candidate ' || ent."kind"::text ||
                  COALESCE(' identified: ' || ent."normalized_value", ' identified')
                )::text AS "summary",
                ent."evidence_id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "evidence_entities" ent
           WHERE ${entityWhere.join(" AND ")}
       )`
      : "";

    const rows = (await client.$queryRawUnsafe(
      `(
         SELECT 'NODE_CREATED'::text AS "kind",
                n."created_at_utc" AS "at_utc",
                COALESCE(n."safe_label", n."node_kind") AS "summary",
                n."id" AS "node_id",
                NULL::uuid AS "other_node_id",
                NULL::text AS "edge_type"
           FROM "investigation_graph_nodes" n
           WHERE ${nodeWhere.join(" AND ")}
       )
       UNION ALL
       (
         SELECT CASE WHEN e."stale_at_utc" IS NULL THEN 'EDGE_CREATED' ELSE 'EDGE_REMOVED' END AS "kind",
                COALESCE(e."stale_at_utc", e."created_at_utc") AS "at_utc",
                COALESCE(e."safe_summary", e."edge_type") AS "summary",
                e."source_node_id" AS "node_id",
                e."target_node_id" AS "other_node_id",
                e."edge_type" AS "edge_type"
           FROM "investigation_graph_edges" e
           WHERE ${edgeWhere.join(" AND ")}
       )${evidenceStreams}
       ORDER BY "at_utc" DESC
       LIMIT ${limitParam}`,
      ...params,
    )) as Array<{
      kind: TimelineEventKind;
      at_utc: Date;
      summary: string;
      node_id: string;
      other_node_id: string | null;
      edge_type: string | null;
    }>;
    const truncated = rows.length > limit;
    return {
      ok: true,
      events: rows.slice(0, limit).map((r) => ({
        id: `${r.kind}:${r.node_id}:${r.other_node_id ?? ""}:${r.at_utc.toISOString()}`,
        kind: r.kind,
        atUtc: r.at_utc.toISOString(),
        summary: r.summary.slice(0, 240),
        nodeId: r.node_id,
        otherNodeId: r.other_node_id,
        edgeType: (r.edge_type as GraphEdgeType | null) ?? null,
      })),
      truncated,
    };
  } catch {
    return { ok: true, events: [], truncated: false };
  }
}

/**
 * Subgraph rooted at a CASE node. Today the CASE-node integration
 * itself is deferred (no CASE upserts in the reconciler yet) — so
 * this lookup returns an empty subgraph for case ids that haven't
 * been materialized. The route gives operators the forward-
 * compatible read shape today; the underlying CASE node builder
 * lands in a focused follow-up.
 */
export async function buildCaseSubgraph(
  input: { teamId: string; caseId: string; depth?: number },
  client: PrismaClient = getRegisteredPrisma(),
): Promise<EvidenceSubgraphResult> {
  bump("graph_query_total");
  const seedRows = (await client.$queryRawUnsafe(
    `SELECT "id" FROM "investigation_graph_nodes"
       WHERE "team_id" = $1 AND "node_kind" = 'CASE'
         AND "external_id" = $2 AND "stale_at_utc" IS NULL
       LIMIT 1`,
    input.teamId,
    input.caseId,
  )) as Array<{ id: string }>;
  if (seedRows.length === 0) {
    return { ok: true, nodes: [], edges: [], truncated: false };
  }
  return buildSubgraphFromNodeId(
    { teamId: input.teamId, seedNodeId: seedRows[0]!.id, depth: input.depth },
    client,
  );
}

/** Internal helper: traverse from any seed node id (not just
 *  evidence). Used by buildCaseSubgraph. */
async function buildSubgraphFromNodeId(
  input: { teamId: string; seedNodeId: string; depth?: number },
  client: PrismaClient,
): Promise<EvidenceSubgraphResult> {
  const {
    MAX_GRAPH_TRAVERSAL_DEPTH,
    MAX_GRAPH_NODES_PER_RESPONSE,
    MAX_GRAPH_EDGES_PER_RESPONSE,
  } = await import("./graph-catalog.js");
  const depth = Math.max(
    0,
    Math.min(input.depth ?? 2, MAX_GRAPH_TRAVERSAL_DEPTH),
  );
  const seedRows = (await client.$queryRawUnsafe(
    `SELECT "id", "team_id", "node_kind", "external_id", "safe_label",
            "visibility_scope", "stale_at_utc", "created_at_utc", "updated_at_utc"
       FROM "investigation_graph_nodes"
       WHERE "id" = $1 AND "team_id" = $2 AND "stale_at_utc" IS NULL
       LIMIT 1`,
    input.seedNodeId,
    input.teamId,
  )) as RawNodeRow[];
  if (seedRows.length === 0) {
    return { ok: true, nodes: [], edges: [], truncated: false };
  }
  const seedNode = seedRows[0]!;
  const collectedNodes = new Map<string, RawNodeRow>();
  const collectedEdges = new Map<string, RawEdgeRow>();
  collectedNodes.set(seedNode.id, seedNode);
  let frontier = new Set<string>([seedNode.id]);
  let truncated = false;
  for (let hop = 0; hop < depth; hop++) {
    if (frontier.size === 0) break;
    if (collectedNodes.size >= MAX_GRAPH_NODES_PER_RESPONSE) {
      truncated = true;
      break;
    }
    const frontierIds = Array.from(frontier);
    const edges = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "source_node_id", "target_node_id",
              "edge_type", "source_kind", "confidence", "safe_summary",
              "created_by_user_id", "stale_at_utc",
              "created_at_utc", "updated_at_utc"
         FROM "investigation_graph_edges"
         WHERE "team_id" = $1
           AND "stale_at_utc" IS NULL
           AND ("source_node_id" = ANY($2::uuid[])
                OR "target_node_id" = ANY($2::uuid[]))
         LIMIT $3`,
      input.teamId,
      frontierIds,
      MAX_GRAPH_EDGES_PER_RESPONSE - collectedEdges.size,
    )) as RawEdgeRow[];
    const nextFrontier = new Set<string>();
    for (const e of edges) {
      if (collectedEdges.size >= MAX_GRAPH_EDGES_PER_RESPONSE) {
        truncated = true;
        break;
      }
      collectedEdges.set(e.id, e);
      const otherEnd = frontier.has(e.source_node_id)
        ? e.target_node_id
        : e.source_node_id;
      if (!collectedNodes.has(otherEnd)) nextFrontier.add(otherEnd);
    }
    if (nextFrontier.size > 0) {
      const newIds = Array.from(nextFrontier);
      const nodes = (await client.$queryRawUnsafe(
        `SELECT "id", "team_id", "node_kind", "external_id", "safe_label",
                "visibility_scope", "stale_at_utc",
                "created_at_utc", "updated_at_utc"
           FROM "investigation_graph_nodes"
           WHERE "team_id" = $1
             AND "id" = ANY($2::uuid[])
             AND "stale_at_utc" IS NULL`,
        input.teamId,
        newIds,
      )) as RawNodeRow[];
      for (const n of nodes) collectedNodes.set(n.id, n);
    }
    frontier = nextFrontier;
  }
  return {
    ok: true,
    nodes: Array.from(collectedNodes.values()).map(projectNode),
    edges: Array.from(collectedEdges.values()).map(projectEdge),
    truncated,
  };
}
