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
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { buildCaseSubgraph, buildEvidenceSubgraph, buildInvestigationTimeline, createManualRelationship, listDuplicateEdges, listGraphSeedNodes, retractManualRelationship, searchGraph, } from "../services/graph/graph-builder.service.js";
import { GRAPH_EDGE_TYPES, GRAPH_NODE_KINDS, MAX_GRAPH_TRAVERSAL_DEPTH, MANUAL_EDGE_TYPES, } from "../services/graph/graph-catalog.js";
import { bump } from "../services/ops/metrics.service.js";
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
function projectNodeForPublic(node) {
    return {
        id: node.id,
        nodeKind: node.nodeKind,
        safeLabel: node.safeLabel,
        visibilityScope: node.visibilityScope,
    };
}
function projectEdgeForPublic(edge) {
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
export async function graphRoutes(app) {
    // ---------------------------------------------------------------------------
    // GET /v1/graph/evidence/:evidenceId
    // ---------------------------------------------------------------------------
    app.get("/v1/graph/evidence/:evidenceId", { preHandler: requireAuth }, async (req, reply) => {
        const { evidenceId } = SubgraphParams.parse(req.params);
        const q = SubgraphQuery.parse(req.query ?? {});
        const actor = await authorizeOrFail(req, reply, {
            teamId: q.teamId,
            permission: "evidence.read",
            antiEnumeration: true,
        });
        if (!actor)
            return;
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
    });
    // ---------------------------------------------------------------------------
    // POST /v1/graph/relationships/manual
    // ---------------------------------------------------------------------------
    app.post("/v1/graph/relationships/manual", { preHandler: requireAuth }, async (req, reply) => {
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
        if (!actor)
            return;
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
        return reply.code(201).send({
            manualRelationshipId: result.manualRelationshipId,
            edgeId: result.edgeId,
        });
    });
    // ---------------------------------------------------------------------------
    // DELETE /v1/graph/relationships/manual/:manualRelationshipId
    // ---------------------------------------------------------------------------
    app.delete("/v1/graph/relationships/manual/:manualRelationshipId", { preHandler: requireAuth }, async (req, reply) => {
        const { manualRelationshipId } = RetractManualParams.parse(req.params);
        const body = RetractManualBody.parse(req.body ?? {});
        const actor = await authorizeOrFail(req, reply, {
            teamId: body.teamId,
            permission: "evidence.update_metadata",
            antiEnumeration: true,
        });
        if (!actor)
            return;
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
        return reply.code(200).send({ manualRelationshipId, retracted: true });
    });
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
    app.get("/v1/graph/cases/:caseId", { preHandler: requireAuth }, async (req, reply) => {
        const { caseId } = z.object({ caseId: z.string().uuid() }).parse(req.params);
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
        if (!actor)
            return;
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
    });
    // ---------------------------------------------------------------------------
    // GET /v1/graph/search?teamId=&kinds=…&edgeTypes=…&label=…&limit=
    //
    // Bounded filter-shaped graph node search. Each filter is bounded
    // + validated. Visibility-aware (stale nodes excluded).
    // ---------------------------------------------------------------------------
    app.get("/v1/graph/search", { preHandler: requireAuth }, async (req, reply) => {
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
        if (!actor)
            return;
        // Parse kinds CSV against bounded catalog; silently drop
        // unknown tokens. The set of valid kinds is public so this
        // doesn't reveal anything.
        const kindSet = new Set(GRAPH_NODE_KINDS);
        const parsedKinds = q.kinds
            ? q.kinds
                .split(",")
                .map((s) => s.trim())
                .filter((s) => kindSet.has(s))
            : [];
        const edgeSet = new Set(GRAPH_EDGE_TYPES);
        const parsedEdges = q.edgeTypes
            ? q.edgeTypes
                .split(",")
                .map((s) => s.trim())
                .filter((s) => edgeSet.has(s))
            : [];
        const result = await searchGraph({
            teamId: q.teamId,
            nodeKinds: parsedKinds.length > 0
                ? parsedKinds
                : null,
            edgeTypes: parsedEdges.length > 0
                ? parsedEdges
                : null,
            labelContains: q.label ?? null,
            limit: q.limit,
        });
        bump("graph_search_executed_total");
        return reply.code(200).send({
            nodes: result.nodes.map(projectNodeForPublic),
            truncated: result.truncated,
        });
    });
    // ---------------------------------------------------------------------------
    // GET /v1/graph/timeline?teamId=&rootNodeId=&from=&to=&limit=
    //
    // Unified investigation timeline. Sources from graph node + edge
    // create/stale timestamps today; future phases union additional
    // event streams (custody / escalations / exports) into the same
    // projection.
    // ---------------------------------------------------------------------------
    app.get("/v1/graph/timeline", { preHandler: requireAuth }, async (req, reply) => {
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
        if (!actor)
            return;
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
        // shape to the client. Keep a 200 status; the discriminator is
        // the new `status` field. The UI checks `status === "failed"`
        // BEFORE the empty-state classifier so the operator never sees
        // TRUE_EMPTY on a real SQL failure.
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
    });
    // ---------------------------------------------------------------------------
    // GET /v1/graph/duplicates?teamId=&evidenceId=&limit=
    //
    // Bounded list of evidence-to-evidence duplicate/similarity edges
    // for the Duplicate / Similarity Review workstation surface.
    // Phase 31.18.
    // ---------------------------------------------------------------------------
    app.get("/v1/graph/duplicates", { preHandler: requireAuth }, async (req, reply) => {
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
        if (!actor)
            return;
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
    });
    // ---------------------------------------------------------------------------
    // GET /v1/graph/seeds?teamId=&kinds=…&perKindLimit=
    //
    // Bounded list of graph seed nodes for the Graph Navigation
    // Explorer. Phase 31.18.
    // ---------------------------------------------------------------------------
    app.get("/v1/graph/seeds", { preHandler: requireAuth }, async (req, reply) => {
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
        if (!actor)
            return;
        const kindSet = new Set(GRAPH_NODE_KINDS);
        const parsedKinds = q.kinds
            ? q.kinds
                .split(",")
                .map((s) => s.trim())
                .filter((s) => kindSet.has(s))
            : [];
        const result = await listGraphSeedNodes({
            teamId: q.teamId,
            kinds: parsedKinds.length > 0 ? parsedKinds : null,
            perKindLimit: q.perKindLimit,
        });
        bump("graph_seeds_executed_total");
        return reply.code(200).send({
            nodes: result.nodes.map(projectGraphSeedForPublic),
        });
    });
}
function projectTimelineEvent(e) {
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
function projectDuplicateEdgeForPublic(e) {
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
function projectGraphSeedForPublic(n) {
    return {
        id: n.id,
        nodeKind: n.nodeKind,
        externalId: n.externalId,
        safeLabel: n.safeLabel,
        updatedAtUtc: n.updatedAtUtc,
    };
}
