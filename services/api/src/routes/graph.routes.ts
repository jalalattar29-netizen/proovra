/**
 * Phase 32 — Investigation graph REST routes.
 *
 * Three routes this session:
 *
 *   GET  /v1/graph/evidence/:evidenceId?teamId=&depth=
 *     → bounded-depth subgraph rooted at one evidence node.
 *       Visibility-aware (stale nodes/edges filtered out).
 *       Returns `truncated: true` when caps hit.
 *
 *   POST /v1/graph/relationships/manual
 *     → operator-created relationship between two graph nodes.
 *       Bounded edge type vocabulary (REFERENCES_SAME_INCIDENT |
 *       MANUALLY_LINKED_TO). Audited.
 *
 *   DELETE /v1/graph/relationships/manual/:manualRelationshipId
 *     → retract a previously-created manual relationship. Marks
 *       the audit row RETRACTED + stales the corresponding edge.
 *       Idempotent.
 *
 * Hard contracts:
 *   * Every route uses `authorizeOrFail` with anti-enumeration 404.
 *   * GET requires `evidence.read`; POST/DELETE require
 *     `evidence.update_metadata`.
 *   * Bounded `depth` parameter (0..MAX_GRAPH_TRAVERSAL_DEPTH).
 *   * Response NEVER projects storage_key / storage_bucket /
 *     multipartUploadId / signed URLs / raw GPS / private notes /
 *     legal notes — verified by source-contract test.
 *   * Bounded node/edge caps prevent unbounded payloads.
 *   * Manual edge types bounded to a closed set — operators can't
 *     forge SAME_HASH_AS or HAS_OCR edges from the API.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { enqueueGraphReconcileJob } from "../queue/graph-reconcile-queue.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  buildCaseSubgraph,
  buildEvidenceSubgraph,
  buildInvestigationTimeline,
  createManualRelationship,
  listDuplicateEdges,
  listGraphSeedNodes,
  retractManualRelationship,
  searchGraph,
  type DuplicateEdge,
  type GraphEdge,
  type GraphNode,
  type GraphSeedNode,
  type TimelineEvent,
} from "../services/graph/graph-builder.service.js";
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_KINDS,
  MAX_GRAPH_TRAVERSAL_DEPTH,
  MANUAL_EDGE_TYPES,
} from "../services/graph/graph-catalog.js";
import { bump } from "../services/ops/metrics.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
// Wave 3 Phase 7B — bounded custody emit for Investigation-mutation
// surfaces. Best-effort; never blocks the operator action. See
// services/investigation-custody.service.ts for the swallow contract.
import * as prismaPkg from "@prisma/client";
import { appendInvestigationCustody } from "../services/investigation-custody.service.js";

// =============================================================================
// Bounded validators
// =============================================================================

const SubgraphParams = z.object({
  evidenceId: z.string().uuid(),
});

const SubgraphQuery = z.object({
  teamId: z.string().uuid(),
  depth: z.coerce.number().int().min(0).max(MAX_GRAPH_TRAVERSAL_DEPTH).optional(),
});

const ManualRelationshipBody = z
  .object({
    teamId: z.string().uuid(),
    sourceNodeId: z.string().uuid(),
    targetNodeId: z.string().uuid(),
    edgeType: z.enum(MANUAL_EDGE_TYPES),
    safeNote: z.string().min(1).max(400).optional(),
  })
  .strict();

const RetractManualParams = z.object({
  manualRelationshipId: z.string().uuid(),
});

const RetractManualBody = z
  .object({
    teamId: z.string().uuid(),
    reason: z.string().min(1).max(240).optional(),
  })
  .strict();

// =============================================================================
// Public projections — narrow anti-leak shape
// =============================================================================

type PublicNode = {
  id: string;
  nodeKind: GraphNode["nodeKind"];
  safeLabel: string | null;
  visibilityScope: GraphNode["visibilityScope"];
};

function projectNodeForPublic(node: GraphNode): PublicNode {
  return {
    id: node.id,
    nodeKind: node.nodeKind,
    safeLabel: node.safeLabel,
    visibilityScope: node.visibilityScope,
  };
}

type PublicEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: GraphEdge["edgeType"];
  sourceKind: GraphEdge["sourceKind"];
  confidence: GraphEdge["confidence"];
  safeSummary: string | null;
};

function projectEdgeForPublic(edge: GraphEdge): PublicEdge {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    edgeType: edge.edgeType,
    sourceKind: edge.sourceKind,
    confidence: edge.confidence,
    safeSummary: edge.safeSummary,
  };
}

// =============================================================================
// Routes
// =============================================================================

export async function graphRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/graph/evidence/:evidenceId
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/evidence/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = SubgraphParams.parse(req.params);
      const q = SubgraphQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const subgraph = await buildEvidenceSubgraph({
        teamId: q.teamId,
        evidenceId,
        depth: q.depth,
      });
      return reply.code(200).send({
        evidenceId,
        nodes: subgraph.nodes.map(projectNodeForPublic),
        edges: subgraph.edges.map(projectEdgeForPublic),
        truncated: subgraph.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/graph/relationships/manual
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/relationships/manual",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = ManualRelationshipBody.parse(req.body ?? {});
      if (body.sourceNodeId === body.targetNodeId) {
        return reply.code(400).send({
          error: { code: "self_loop_not_allowed" },
        });
      }
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await createManualRelationship({
        teamId: body.teamId,
        actorUserId: actor.actorUserId,
        sourceNodeId: body.sourceNodeId,
        targetNodeId: body.targetNodeId,
        edgeType: body.edgeType,
        safeNote: body.safeNote ?? null,
      });
      if (!result.ok) {
        if (result.reason === "nodes_not_in_team") {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }
      // Wave 2 Phase 6 — bounded audit emit on successful create.
      // Never write AdminAuditLog directly per dedup register; always
      // go through appendPlatformAuditLog. Best-effort — never blocks
      // the operator action.
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "GRAPH_MANUAL_RELATIONSHIP_CREATED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "created",
          resourceType: "graph_edge",
          resourceId: result.edgeId,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            manualRelationshipId: result.manualRelationshipId,
            edgeId: result.edgeId,
            sourceNodeId: body.sourceNodeId,
            targetNodeId: body.targetNodeId,
            edgeType: body.edgeType,
          },
        });
      } catch {
        /* best-effort audit; never block the operator action */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the DB write
      // succeeds. Best-effort; failures are swallowed via the canonical
      // observability swallow. Payload ≤ 200 bytes serialized.
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.MANUAL_RELATIONSHIP_CREATED,
          edgeId: result.edgeId,
          payload: {
            mrId: result.manualRelationshipId,
            etype: body.edgeType,
          },
          surface: "graph.routes.ts:manualCreate",
        });
      } catch {
        /* best-effort custody; never block the operator action */
      }
      return reply.code(201).send({
        manualRelationshipId: result.manualRelationshipId,
        edgeId: result.edgeId,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/graph/relationships/manual/:manualRelationshipId
  // ---------------------------------------------------------------------------
  app.delete(
    "/v1/graph/relationships/manual/:manualRelationshipId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { manualRelationshipId } = RetractManualParams.parse(req.params);
      const body = RetractManualBody.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await retractManualRelationship({
        teamId: body.teamId,
        manualRelationshipId,
        actorUserId: actor.actorUserId,
        reason: body.reason ?? null,
      });
      if (!result.ok) {
        bump("graph_query_denied_total");
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }
      // Wave 2 Phase 6 — bounded audit emit on successful retract.
      // Best-effort — never blocks the operator action.
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "GRAPH_MANUAL_RELATIONSHIP_RETRACTED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "retracted",
          resourceType: "manual_relationship",
          resourceId: manualRelationshipId,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            manualRelationshipId,
            reason: body.reason ?? null,
          },
        });
      } catch {
        /* best-effort audit; never block the operator action */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the DB write
      // succeeds. The retract has no surviving edgeId (it's been
      // staled), so the helper falls back to the workspace anchor.
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.MANUAL_RELATIONSHIP_RETRACTED,
          payload: { mrId: manualRelationshipId },
          surface: "graph.routes.ts:manualRetract",
        });
      } catch {
        /* best-effort custody; never block the operator action */
      }
      return reply.code(200).send({ manualRelationshipId, retracted: true });
    },
  );

  // ===========================================================================
  // Phase 32.5 — Additional graph read endpoints
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /v1/graph/cases/:caseId?teamId=&depth=
  //
  // Bounded subgraph rooted at a CASE node. Returns empty subgraph
  // when no CASE node has been materialized yet (anti-enumeration:
  // same shape as "no graph yet for this case").
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/cases/:caseId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { caseId } = z.object({ caseId: z.string().uuid() }).parse(
        req.params,
      );
      const q = z
        .object({
          teamId: z.string().uuid(),
          depth: z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_GRAPH_TRAVERSAL_DEPTH)
            .optional(),
        })
        .parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const subgraph = await buildCaseSubgraph({
        teamId: q.teamId,
        caseId,
        depth: q.depth,
      });
      bump("graph_case_subgraph_loaded_total");
      return reply.code(200).send({
        caseId,
        nodes: subgraph.nodes.map(projectNodeForPublic),
        edges: subgraph.edges.map(projectEdgeForPublic),
        truncated: subgraph.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/graph/search?teamId=&kinds=…&edgeTypes=…&label=…&limit=
  //
  // Bounded filter-shaped graph node search. Each filter is bounded
  // + validated. Visibility-aware (stale nodes excluded).
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/search",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          // CSV of node kinds. Bounded enum validation inside the
          // handler so a malformed value returns an empty result
          // rather than 400 (anti-enumeration: don't reveal which
          // kinds exist).
          kinds: z.string().max(400).optional(),
          edgeTypes: z.string().max(400).optional(),
          label: z.string().min(1).max(80).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      // Parse kinds CSV against bounded catalog; silently drop
      // unknown tokens. The set of valid kinds is public so this
      // doesn't reveal anything.
      const kindSet = new Set<string>(GRAPH_NODE_KINDS);
      const parsedKinds = q.kinds
        ? q.kinds
            .split(",")
            .map((s) => s.trim())
            .filter((s) => kindSet.has(s))
        : [];
      const edgeSet = new Set<string>(GRAPH_EDGE_TYPES);
      const parsedEdges = q.edgeTypes
        ? q.edgeTypes
            .split(",")
            .map((s) => s.trim())
            .filter((s) => edgeSet.has(s))
        : [];
      const result = await searchGraph({
        teamId: q.teamId,
        nodeKinds:
          parsedKinds.length > 0
            ? (parsedKinds as never)
            : null,
        edgeTypes:
          parsedEdges.length > 0
            ? (parsedEdges as never)
            : null,
        labelContains: q.label ?? null,
        limit: q.limit,
      });
      bump("graph_search_executed_total");
      return reply.code(200).send({
        nodes: result.nodes.map(projectNodeForPublic),
        truncated: result.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/graph/timeline?teamId=&rootNodeId=&from=&to=&limit=
  //
  // Unified investigation timeline. Sources from graph node + edge
  // create/stale timestamps today; future phases union additional
  // event streams (custody / escalations / exports) into the same
  // projection.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          rootNodeId: z.string().uuid().optional(),
          // Phase 31.7 — when provided, the timeline unions the
          // evidence-keyed event streams (lifecycle, MI runs, MI
          // signals) for this evidence id in addition to the graph
          // events. Anti-enumeration: a non-team evidence id surfaces
          // no rows (each stream's WHERE binds team_id first).
          evidenceId: z.string().uuid().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await buildInvestigationTimeline({
        teamId: q.teamId,
        rootNodeId: q.rootNodeId ?? null,
        evidenceId: q.evidenceId ?? null,
        fromUtc: q.from ?? null,
        toUtc: q.to ?? null,
        limit: q.limit,
      });
      bump("graph_timeline_executed_total");
      // Phase Repair (Problem 13) — propagate the bounded QUERY_FAILED
      // shape to the client. We keep a 200 status so the existing
      // poll loop on the timeline page doesn't trip its error handler
      // (which would render the API_ERROR card instead of the more
      // accurate PIPELINE_FAILED card); the discriminator is the new
      // `status` field. The UI looks at this BEFORE the empty-state
      // classifier so the operator never sees TRUE_EMPTY on a real
      // SQL failure.
      if (!result.ok) {
        return reply.code(200).send({
          events: [],
          truncated: false,
          status: "failed",
          classification: result.classification,
          reason: result.reason,
        });
      }
      return reply.code(200).send({
        events: result.events.map(projectTimelineEvent),
        truncated: result.truncated,
        status: "ok",
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/graph/duplicates/:edgeId/decision
  //
  // Wave 2 — record a reviewer decision on a duplicate-class graph edge
  // (SAME_HASH_AS | SIMILAR_TO | POSSIBLE_DERIVATIVE_OF). The decision
  // is upserted into `duplicate_decisions` with one row per
  // (team, edge). Permission: evidence.update_metadata. Anti-enumeration
  // 404 when the edge doesn't belong to the caller's team OR isn't a
  // duplicate-class edge type.
  //
  // Bounded vocabulary:
  //   * decision ∈ { CONFIRMED, DISMISSED, MARKED_DERIVATIVE }
  //   * reasonNote bounded to 400 chars (matches the DB CHECK)
  //
  // No custody emit in Wave 2 — the existing CustodyEventType enum has
  // no value that covers "duplicate decision recorded" and adding new
  // enum values cross-cuts forensic-hash semantics. Wave 3 widens the
  // enum; until then this route emits the platform audit log only.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/duplicates/:edgeId/decision",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ edgeId: z.string().uuid() })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          decision: z.enum([
            "CONFIRMED",
            "DISMISSED",
            "MARKED_DERIVATIVE",
          ]),
          reasonNote: z.string().min(1).max(400).optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;

      // Anti-enumeration: confirm the edge belongs to this team AND is
      // a duplicate-class edge. We read the edge directly so the route
      // doesn't trust the client's claimed edgeType.
      let edgeRow:
        | {
            id: string;
            team_id: string;
            edge_type: string;
          }
        | null = null;
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT "id", "team_id", "edge_type"
             FROM "investigation_graph_edges"
             WHERE "id" = $1
               AND "team_id" = $2
               AND "edge_type" IN (
                 'SAME_HASH_AS', 'SIMILAR_TO', 'POSSIBLE_DERIVATIVE_OF'
               )
             LIMIT 1`,
          params.edgeId,
          body.teamId,
        )) as Array<{ id: string; team_id: string; edge_type: string }>;
        edgeRow = rows[0] ?? null;
      } catch {
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }
      if (!edgeRow) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // Upsert the decision row. Unique by (team_id, edge_id).
      let row: { id: string; created_at_utc: Date } | null = null;
      try {
        const inserted = (await prisma.$queryRawUnsafe(
          `INSERT INTO "duplicate_decisions"
             ("team_id", "edge_id", "edge_type", "decision",
              "decided_by_user_id", "reason_note")
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ("team_id", "edge_id")
           DO UPDATE SET
             "decision"           = EXCLUDED."decision",
             "decided_by_user_id" = EXCLUDED."decided_by_user_id",
             "reason_note"        = EXCLUDED."reason_note",
             "edge_type"          = EXCLUDED."edge_type",
             "created_at_utc"     = NOW()
           RETURNING "id", "created_at_utc"`,
          body.teamId,
          edgeRow.id,
          edgeRow.edge_type,
          body.decision,
          actor.actorUserId,
          body.reasonNote?.slice(0, 400) ?? null,
        )) as Array<{ id: string; created_at_utc: Date }>;
        row = inserted[0] ?? null;
      } catch {
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }
      if (!row) {
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }

      // Bounded audit emit. Never write AdminAuditLog directly per
      // dedup register; always go through appendPlatformAuditLog.
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "DUPLICATE_DECISION_RECORDED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "recorded",
          resourceType: "graph_edge",
          resourceId: edgeRow.id,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            edgeId: edgeRow.id,
            edgeType: edgeRow.edge_type,
            decision: body.decision,
          },
        });
      } catch {
        /* best-effort audit; never block the reviewer action */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the DB upsert
      // succeeds. The edge's endpoints map to evidence anchors so the
      // helper appends one entry per anchor (typically 2 evidence rows).
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.DUPLICATE_DECISION_RECORDED,
          edgeId: edgeRow.id,
          payload: {
            decision: body.decision,
            etype: edgeRow.edge_type,
          },
          surface: "graph.routes.ts:duplicateDecision",
        });
      } catch {
        /* best-effort custody; never block the reviewer action */
      }
      // Wave 2: the metrics counter for duplicate-decision writes will
      // land in the next metrics-catalog update wave. The bounded audit
      // emit above already gives ops a chain-of-custody record.
      return reply.code(200).send({
        id: row.id,
        decision: body.decision,
        decidedAt: row.created_at_utc.toISOString(),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/graph/duplicates?teamId=&evidenceId=&limit=
  //
  // Bounded list of evidence-to-evidence duplicate/similarity edges
  // for the Duplicate / Similarity Review workstation surface.
  // Phase 31.18.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/duplicates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await listDuplicateEdges({
        teamId: q.teamId,
        evidenceId: q.evidenceId ?? null,
        limit: q.limit,
      });
      bump("graph_duplicate_list_executed_total");
      return reply.code(200).send({
        edges: result.edges.map(projectDuplicateEdgeForPublic),
        truncated: result.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/graph/export
  //
  // Wave 2 Phase 6 — bounded JSON export of the workspace graph nodes +
  // edges. Bounded to 500 nodes + 500 edges per response (truncation
  // flag exposed) so even large workspaces never produce an unbounded
  // payload. Permission: evidence.read. Anti-enumeration via team scope.
  // Audited via appendPlatformAuditLog action INVESTIGATION_EXPORT_GENERATED.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ teamId: z.string().uuid() })
        .strict()
        .parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      // Bounded read — top 500 active nodes + 500 active edges, both
      // team-anchored at every read.
      type NodeRow = {
        id: string;
        node_kind: string;
        external_id: string;
        safe_label: string | null;
        visibility_scope: string;
        updated_at_utc: Date;
      };
      type EdgeRow = {
        id: string;
        source_node_id: string;
        target_node_id: string;
        edge_type: string;
        source_kind: string;
        confidence: string;
        safe_summary: string | null;
        updated_at_utc: Date;
      };
      const EXPORT_LIMIT = 500;
      let nodes: NodeRow[] = [];
      let edges: EdgeRow[] = [];
      try {
        nodes = (await prisma.$queryRawUnsafe(
          `SELECT "id", "node_kind"::text AS "node_kind", "external_id",
                  "safe_label", "visibility_scope"::text AS "visibility_scope",
                  "updated_at_utc"
             FROM "investigation_graph_nodes"
             WHERE "team_id" = $1 AND "stale_at_utc" IS NULL
             ORDER BY "updated_at_utc" DESC
             LIMIT $2`,
          body.teamId,
          EXPORT_LIMIT + 1,
        )) as NodeRow[];
        edges = (await prisma.$queryRawUnsafe(
          `SELECT "id", "source_node_id", "target_node_id",
                  "edge_type"::text AS "edge_type",
                  "source_kind"::text AS "source_kind",
                  "confidence"::text AS "confidence",
                  "safe_summary", "updated_at_utc"
             FROM "investigation_graph_edges"
             WHERE "team_id" = $1 AND "stale_at_utc" IS NULL
             ORDER BY "updated_at_utc" DESC
             LIMIT $2`,
          body.teamId,
          EXPORT_LIMIT + 1,
        )) as EdgeRow[];
      } catch {
        return reply.code(503).send({
          error: { code: "graph_unavailable" },
        });
      }
      const nodesTruncated = nodes.length > EXPORT_LIMIT;
      const edgesTruncated = edges.length > EXPORT_LIMIT;
      const trimmedNodes = nodesTruncated ? nodes.slice(0, EXPORT_LIMIT) : nodes;
      const trimmedEdges = edgesTruncated ? edges.slice(0, EXPORT_LIMIT) : edges;
      const generatedAt = new Date().toISOString();
      // Bounded audit emit on every export.
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "INVESTIGATION_EXPORT_GENERATED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "generated",
          resourceType: "team",
          resourceId: body.teamId,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            exportKind: "graph",
            nodeCount: trimmedNodes.length,
            edgeCount: trimmedEdges.length,
            truncated: nodesTruncated || edgesTruncated,
          },
        });
      } catch {
        /* best-effort audit; never block the export */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the export
      // succeeds. Workspace-scoped → helper resolves a workspace anchor.
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.INVESTIGATION_GRAPH_EXPORTED,
          payload: {
            nc: trimmedNodes.length,
            ec: trimmedEdges.length,
            tr: nodesTruncated || edgesTruncated,
          },
          surface: "graph.routes.ts:graphExport",
        });
      } catch {
        /* best-effort custody; never block the export */
      }
      bump("graph_export_generated_total");
      return reply.code(200).send({
        teamId: body.teamId,
        exportKind: "graph",
        generatedAtUtc: generatedAt,
        nodes: trimmedNodes.map((n) => ({
          id: n.id,
          nodeKind: n.node_kind,
          externalId: n.external_id,
          safeLabel: n.safe_label,
          visibilityScope: n.visibility_scope,
          updatedAtUtc: n.updated_at_utc.toISOString(),
        })),
        edges: trimmedEdges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source_node_id,
          targetNodeId: e.target_node_id,
          edgeType: e.edge_type,
          sourceKind: e.source_kind,
          confidence: e.confidence,
          safeSummary: e.safe_summary,
          updatedAtUtc: e.updated_at_utc.toISOString(),
        })),
        truncated: nodesTruncated || edgesTruncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/graph/timeline/export
  //
  // Wave 2 Phase 6 — bounded JSON export of the workspace investigation
  // timeline. Reuses the existing buildInvestigationTimeline aggregator
  // (capped at 200 events). Permission: evidence.read. Audited.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/timeline/export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
          fromUtc: z.string().datetime().optional(),
          toUtc: z.string().datetime().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await buildInvestigationTimeline({
        teamId: body.teamId,
        rootNodeId: null,
        evidenceId: body.evidenceId ?? null,
        fromUtc: body.fromUtc ?? null,
        toUtc: body.toUtc ?? null,
        limit: 200,
      });
      // Phase Repair (Problem 13) — refuse to produce a misleading
      // empty export when the projection failed. Returning a 503
      // signals the operator's client to retry rather than persisting
      // an artifact that claims "0 events" as authoritative.
      if (!result.ok) {
        return reply.code(503).send({
          status: "failed",
          classification: result.classification,
          reason: result.reason,
        });
      }
      const generatedAt = new Date().toISOString();
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "INVESTIGATION_EXPORT_GENERATED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "generated",
          resourceType: "team",
          resourceId: body.teamId,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            exportKind: "timeline",
            eventCount: result.events.length,
            truncated: result.truncated,
            evidenceScoped: body.evidenceId ? true : false,
          },
        });
      } catch {
        /* best-effort audit */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the export
      // succeeds. When evidenceId is supplied the helper anchors to it
      // directly; otherwise resolves a workspace anchor.
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.INVESTIGATION_TIMELINE_EXPORTED,
          anchorEvidenceIds: body.evidenceId ? [body.evidenceId] : undefined,
          payload: {
            ec: result.events.length,
            tr: result.truncated,
            es: body.evidenceId ? true : false,
          },
          surface: "graph.routes.ts:timelineExport",
        });
      } catch {
        /* best-effort custody */
      }
      bump("graph_timeline_export_generated_total");
      return reply.code(200).send({
        teamId: body.teamId,
        exportKind: "timeline",
        generatedAtUtc: generatedAt,
        events: result.events.map(projectTimelineEvent),
        truncated: result.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/graph/duplicates/export
  //
  // Wave 2 Phase 6 — bounded JSON export of duplicate / similarity
  // findings. Reuses the existing listDuplicateEdges aggregator
  // (capped at 200 edges). Permission: evidence.read. Audited.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/duplicates/export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const result = await listDuplicateEdges({
        teamId: body.teamId,
        evidenceId: body.evidenceId ?? null,
        limit: 200,
      });
      const generatedAt = new Date().toISOString();
      try {
        await appendPlatformAuditLog({
          userId: actor.actorUserId,
          action: "INVESTIGATION_EXPORT_GENERATED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: "generated",
          resourceType: "team",
          resourceId: body.teamId,
          requestId: req.id,
          metadata: {
            teamId: body.teamId,
            exportKind: "duplicates",
            edgeCount: result.edges.length,
            truncated: result.truncated,
            evidenceScoped: body.evidenceId ? true : false,
          },
        });
      } catch {
        /* best-effort audit */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the export
      // succeeds. When evidenceId is supplied the helper anchors to it
      // directly; otherwise resolves a workspace anchor.
      try {
        await appendInvestigationCustody({
          teamId: body.teamId,
          actorUserId: actor.actorUserId,
          eventType: prismaPkg.CustodyEventType.INVESTIGATION_DUPLICATES_EXPORTED,
          anchorEvidenceIds: body.evidenceId ? [body.evidenceId] : undefined,
          payload: {
            ec: result.edges.length,
            tr: result.truncated,
            es: body.evidenceId ? true : false,
          },
          surface: "graph.routes.ts:duplicatesExport",
        });
      } catch {
        /* best-effort custody */
      }
      bump("graph_duplicates_export_generated_total");
      return reply.code(200).send({
        teamId: body.teamId,
        exportKind: "duplicates",
        generatedAtUtc: generatedAt,
        edges: result.edges.map(projectDuplicateEdgeForPublic),
        truncated: result.truncated,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/graph/seeds?teamId=&kinds=…&perKindLimit=
  //
  // Bounded list of graph seed nodes for the Graph Navigation
  // Explorer. Phase 31.18.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/seeds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          kinds: z.string().max(400).optional(),
          perKindLimit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      const kindSet = new Set<string>(GRAPH_NODE_KINDS);
      const parsedKinds = q.kinds
        ? q.kinds
            .split(",")
            .map((s) => s.trim())
            .filter((s) => kindSet.has(s))
        : [];
      const result = await listGraphSeedNodes({
        teamId: q.teamId,
        kinds: parsedKinds.length > 0 ? (parsedKinds as never) : null,
        perKindLimit: q.perKindLimit,
      });
      bump("graph_seeds_executed_total");
      return reply.code(200).send({
        nodes: result.nodes.map(projectGraphSeedForPublic),
      });
    },
  );

  // ===========================================================================
  // Wave 1 — Manual graph reconcile + diagnostics
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // POST /v1/graph/reconcile
  //
  // Operator-triggered manual graph reconcile. Enqueues a worker job
  // (the worker is the source of truth for actually running
  // `reconcileTeamGraph`). Anti-enumeration: non-workspace members
  // get a 404, not a 403. Bounded auditing via appendPlatformAuditLog
  // with code `GRAPH_MANUAL_RECONCILE_REQUESTED`.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/graph/reconcile",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const body = z
        .object({ reason: z.string().min(1).max(240).optional() })
        .strict()
        .parse(req.body ?? {});
      const actor = await requireGraphAdminActor(req, reply, q.teamId);
      if (!actor) return;
      const enqueueResult = await enqueueGraphReconcileJob({
        teamId: q.teamId,
        reason: "manual_refresh",
        requestedByUserId: actor.userId,
      });
      const queuedAt = new Date().toISOString();
      // Bounded audit emit — never write AdminAuditLog directly per
      // dedup register; always go through appendPlatformAuditLog.
      try {
        await appendPlatformAuditLog({
          userId: actor.userId,
          action: "GRAPH_MANUAL_RECONCILE_REQUESTED",
          category: "investigation_graph",
          severity: "info",
          source: "investigation_graph_routes",
          outcome: enqueueResult.queued ? "queued" : "noop",
          resourceType: "team",
          resourceId: q.teamId,
          requestId: req.id,
          metadata: {
            teamId: q.teamId,
            jobId: enqueueResult.jobId,
            queueReason: enqueueResult.reason,
            requestedReason: body.reason ?? null,
          },
        });
      } catch {
        /* best-effort audit; never block the operator action */
      }
      // Wave 3 Phase 7B — bounded custody emit AFTER the reconcile
      // job has been enqueued. Workspace-scoped → helper resolves a
      // workspace anchor.
      try {
        await appendInvestigationCustody({
          teamId: q.teamId,
          actorUserId: actor.userId,
          eventType: prismaPkg.CustodyEventType.GRAPH_RECONCILE_REQUESTED,
          payload: { q: enqueueResult.queued, r: enqueueResult.reason },
          surface: "graph.routes.ts:reconcile",
        });
      } catch {
        /* best-effort custody; never block the operator action */
      }
      // Wave 1: counter for manual reconcile requests is reserved
      // for the next metrics-catalog update wave. The bounded audit
      // emit above already gives ops a full chain-of-custody record.
      return reply.code(202).send({
        jobId: enqueueResult.jobId,
        queuedAt,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/graph/diagnostics
  //
  // Aggregated counts + reconcile health for the workspace's
  // investigation graph. Bounded — every aggregator is a thin Prisma
  // count grouped by node_kind / edge_type. Queue depth comes from
  // the existing graph-reconcile queue helper.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/graph/diagnostics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const actor = await requireGraphAdminActor(req, reply, q.teamId);
      if (!actor) return;
      const diagnostics = await buildGraphDiagnostics(q.teamId);
      // Wave 1: counter for diagnostics reads is reserved for the
      // next metrics-catalog update wave.
      return reply.code(200).send(diagnostics);
    },
  );
}

// =============================================================================
// Wave 1 — workspace-admin / reviewer-admin actor gate.
//
// Mirrors `requireOpsActor` in ops.routes.ts / operations-queues.routes.ts.
// Anti-enumeration: non-members return 404 (not 403). Allows either
// `identity.member.read` (workspace admin) or `evidence.update_metadata`
// (reviewer admin) — either is sufficient for graph maintenance.
// =============================================================================

async function requireGraphAdminActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  // Either gate suffices.
  const [opsDecision, reviewerDecision] = await Promise.all([
    evaluateMemberAccess({
      teamId,
      userId,
      permission: "identity.member.read",
    }),
    evaluateMemberAccess({
      teamId,
      userId,
      permission: "evidence.update_metadata",
    }),
  ]);
  if (!opsDecision.allowed && !reviewerDecision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: opsDecision.reason ?? reviewerDecision.reason ?? "denied",
      },
    });
    return null;
  }
  return { userId };
}

// =============================================================================
// Wave 1 — graph diagnostics aggregator.
//
// Composes thin Prisma counts; never reads/projects evidence content,
// OCR text, transcript text, GPS, storage keys, reviewer-private
// fields. Team-anchored at every read. Best-effort — any sub-query
// failure surfaces as the corresponding field being null / 0; never
// throws to the caller.
// =============================================================================

type GraphDiagnostics = {
  nodeCount: number;
  edgeCount: number;
  staleNodeCount: number;
  staleEdgeCount: number;
  queueDepth: number | null;
  lastReconcileCompletedAt: string | null;
  lastReconcileStatus: string | null;
  nodeCountsByKind: Record<string, number>;
  edgeCountsByType: Record<string, number>;
};

async function buildGraphDiagnostics(
  teamId: string,
): Promise<GraphDiagnostics> {
  // Counts grouped by node_kind / edge_type. Team-anchored.
  const nodeCountsByKind: Record<string, number> = {};
  const edgeCountsByType: Record<string, number> = {};
  let nodeCount = 0;
  let edgeCount = 0;
  let staleNodeCount = 0;
  let staleEdgeCount = 0;
  try {
    const nodeRows = (await prisma.$queryRawUnsafe(
      `SELECT "node_kind"::text AS "node_kind",
              COUNT(*)::int AS "total",
              SUM(CASE WHEN "stale_at_utc" IS NULL THEN 0 ELSE 1 END)::int AS "stale"
         FROM "investigation_graph_nodes"
         WHERE "team_id" = $1
         GROUP BY "node_kind"`,
      teamId,
    )) as Array<{ node_kind: string; total: number; stale: number }>;
    for (const r of nodeRows) {
      const total = Number(r.total ?? 0);
      const stale = Number(r.stale ?? 0);
      nodeCountsByKind[r.node_kind] = total;
      nodeCount += total;
      staleNodeCount += stale;
    }
  } catch {
    /* best-effort */
  }
  try {
    const edgeRows = (await prisma.$queryRawUnsafe(
      `SELECT "edge_type"::text AS "edge_type",
              COUNT(*)::int AS "total",
              SUM(CASE WHEN "stale_at_utc" IS NULL THEN 0 ELSE 1 END)::int AS "stale"
         FROM "investigation_graph_edges"
         WHERE "team_id" = $1
         GROUP BY "edge_type"`,
      teamId,
    )) as Array<{ edge_type: string; total: number; stale: number }>;
    for (const r of edgeRows) {
      const total = Number(r.total ?? 0);
      const stale = Number(r.stale ?? 0);
      edgeCountsByType[r.edge_type] = total;
      edgeCount += total;
      staleEdgeCount += stale;
    }
  } catch {
    /* best-effort */
  }
  // Queue depth — dynamic import keeps the route module decoupled
  // from BullMQ at load time. The helper itself is best-effort and
  // returns null on Redis unavailability.
  let queueDepth: number | null = null;
  try {
    const { getQueueInventory } = await import(
      "../services/operations/queue-inventory.service.js"
    );
    const inv = await getQueueInventory();
    const row = inv.find((q) => q.queueName === "graph-reconcile");
    if (row) {
      queueDepth =
        (row.counts.waiting ?? 0) +
        (row.counts.active ?? 0) +
        (row.counts.delayed ?? 0);
    }
  } catch {
    /* best-effort */
  }
  // Last reconcile — not yet persisted as its own row. We surface
  // the most recent updated_at on a graph node as a proxy until a
  // dedicated reconcile-result table lands in a future wave.
  let lastReconcileCompletedAt: string | null = null;
  let lastReconcileStatus: string | null = null;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT MAX("updated_at_utc") AS "last_at"
         FROM "investigation_graph_nodes"
         WHERE "team_id" = $1`,
      teamId,
    )) as Array<{ last_at: Date | null }>;
    const lastAt = rows[0]?.last_at ?? null;
    if (lastAt) {
      lastReconcileCompletedAt = lastAt.toISOString();
      lastReconcileStatus = "unknown";
    }
  } catch {
    /* best-effort */
  }
  return {
    nodeCount,
    edgeCount,
    staleNodeCount,
    staleEdgeCount,
    queueDepth,
    lastReconcileCompletedAt,
    lastReconcileStatus,
    nodeCountsByKind,
    edgeCountsByType,
  };
}

// =============================================================================
// Phase 32.5 — Timeline event public projection (narrow + anti-leak)
// =============================================================================

type PublicTimelineEvent = {
  id: string;
  kind: TimelineEvent["kind"];
  atUtc: string;
  summary: string;
  nodeId: string;
  otherNodeId: string | null;
  edgeType: TimelineEvent["edgeType"];
};

function projectTimelineEvent(e: TimelineEvent): PublicTimelineEvent {
  return {
    id: e.id,
    kind: e.kind,
    atUtc: e.atUtc,
    summary: e.summary,
    nodeId: e.nodeId,
    otherNodeId: e.otherNodeId,
    edgeType: e.edgeType,
  };
}

// =============================================================================
// Phase 31.18 — duplicate / similarity edge + graph seed projections
// =============================================================================

type PublicDuplicateEdge = {
  edgeId: string;
  edgeType: DuplicateEdge["edgeType"];
  confidence: DuplicateEdge["confidence"];
  safeSummary: string | null;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  observedAtUtc: string;
};

function projectDuplicateEdgeForPublic(e: DuplicateEdge): PublicDuplicateEdge {
  return {
    edgeId: e.edgeId,
    edgeType: e.edgeType,
    confidence: e.confidence,
    safeSummary: e.safeSummary,
    sourceEvidenceId: e.sourceEvidenceId,
    targetEvidenceId: e.targetEvidenceId,
    observedAtUtc: e.observedAtUtc,
  };
}

type PublicGraphSeed = {
  id: string;
  nodeKind: GraphSeedNode["nodeKind"];
  externalId: string;
  safeLabel: string | null;
  updatedAtUtc: string;
};

function projectGraphSeedForPublic(n: GraphSeedNode): PublicGraphSeed {
  return {
    id: n.id,
    nodeKind: n.nodeKind,
    externalId: n.externalId,
    safeLabel: n.safeLabel,
    updatedAtUtc: n.updatedAtUtc,
  };
}
