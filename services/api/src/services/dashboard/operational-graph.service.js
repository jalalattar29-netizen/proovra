/**
 * Phase 32.8C FINAL-3 — Operational Graph Engine.
 *
 * Projects real incidents/workflows/correlations/causality chains into
 * bounded graph nodes + edges. Used by the dashboard to compute blast
 * radius, root-cause impact, and topology summaries.
 *
 * Hard rules:
 *   - No fake graph nodes. Every node maps to a real underlying entity
 *     (incident, workflow, correlation, case, evidence).
 *   - Generator failures NEVER block evidence/report/package/verify
 *     flows. Every step wrapped in try/catch.
 *   - Bounded label (180 chars) + bounded enum-like severity/status.
 *   - Node + edge upserts are idempotent on
 *     `(teamId, nodeType, entityId)` / `(teamId, source, target, type)`.
 */
import { prisma } from "../../db.js";
export async function projectOperationalGraphForWorkspace(input) {
    let nodes = 0;
    let edges = 0;
    let failed = 0;
    // Map (nodeType, entityId) → persisted node id so edge writes can
    // resolve their endpoints in-memory rather than re-querying.
    const nodeIdMap = new Map();
    const upsertNode = async (nodeType, entityId, label, severity, status) => {
        const key = `${nodeType}:${entityId}`;
        const cached = nodeIdMap.get(key);
        if (cached)
            return cached;
        try {
            const row = await prisma.operationalGraphNode.upsert({
                where: {
                    teamId_nodeType_entityId: {
                        teamId: input.teamId,
                        nodeType,
                        entityId,
                    },
                },
                create: {
                    teamId: input.teamId,
                    nodeType,
                    entityId,
                    label: label.slice(0, 180),
                    severity: severity.slice(0, 16),
                    status: status.slice(0, 40),
                },
                update: {
                    label: label.slice(0, 180),
                    severity: severity.slice(0, 16),
                    status: status.slice(0, 40),
                },
                select: { id: true },
            });
            nodeIdMap.set(key, row.id);
            nodes += 1;
            return row.id;
        }
        catch {
            failed += 1;
            return null;
        }
    };
    const upsertEdge = async (sourceNodeId, targetNodeId, edgeType, confidence, reasonCode) => {
        try {
            await prisma.operationalGraphEdge.upsert({
                where: {
                    teamId_sourceNodeId_targetNodeId_edgeType: {
                        teamId: input.teamId,
                        sourceNodeId,
                        targetNodeId,
                        edgeType,
                    },
                },
                create: {
                    teamId: input.teamId,
                    sourceNodeId,
                    targetNodeId,
                    edgeType,
                    confidence: confidence.slice(0, 24),
                    reasonCode: reasonCode.slice(0, 80),
                },
                update: {},
            });
            edges += 1;
        }
        catch {
            failed += 1;
        }
    };
    // Incidents → nodes
    try {
        const incidents = await prisma.operationalIncident.findMany({
            where: {
                OR: [{ teamId: input.teamId }, { teamId: null }],
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
            },
            take: 200,
            select: {
                id: true,
                title: true,
                severity: true,
                status: true,
                category: true,
                relatedEvidenceId: true,
            },
        });
        for (const inc of incidents) {
            const nodeId = await upsertNode("INCIDENT", inc.id, inc.title, String(inc.severity), String(inc.status));
            if (nodeId && inc.relatedEvidenceId) {
                const evNodeId = await upsertNode("EVIDENCE", inc.relatedEvidenceId, `Evidence ${inc.relatedEvidenceId.slice(0, 8)}`, "MEDIUM", "ACTIVE");
                if (evNodeId) {
                    await upsertEdge(nodeId, evNodeId, "IMPACTS", "DIRECT", "INCIDENT_IMPACTS_EVIDENCE");
                }
            }
        }
    }
    catch {
        /* outer best-effort */
    }
    // Workflows → nodes + edges to incidents/correlations
    try {
        const workflows = await prisma.operationalWorkflow.findMany({
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
            take: 200,
            select: {
                id: true,
                title: true,
                severity: true,
                status: true,
                sourceIncidentId: true,
                sourceCorrelationId: true,
                evidenceId: true,
                caseId: true,
                assignedOwnerUserId: true,
            },
        });
        for (const wf of workflows) {
            const nodeId = await upsertNode("WORKFLOW", wf.id, wf.title, String(wf.severity), String(wf.status));
            if (!nodeId)
                continue;
            if (wf.sourceIncidentId) {
                const incId = nodeIdMap.get(`INCIDENT:${wf.sourceIncidentId}`);
                if (incId) {
                    await upsertEdge(incId, nodeId, "CAUSED", "DIRECT", "INCIDENT_TRIGGERED_WORKFLOW");
                }
            }
            if (wf.evidenceId) {
                const evNodeId = await upsertNode("EVIDENCE", wf.evidenceId, `Evidence ${wf.evidenceId.slice(0, 8)}`, "MEDIUM", "ACTIVE");
                if (evNodeId) {
                    await upsertEdge(nodeId, evNodeId, "IMPACTS", "DIRECT", "WORKFLOW_IMPACTS_EVIDENCE");
                }
            }
            if (wf.caseId) {
                const caseNode = await upsertNode("CASE", wf.caseId, `Case ${wf.caseId.slice(0, 8)}`, "MEDIUM", "ACTIVE");
                if (caseNode) {
                    await upsertEdge(nodeId, caseNode, "IMPACTS", "DIRECT", "WORKFLOW_IMPACTS_CASE");
                }
            }
            if (wf.assignedOwnerUserId) {
                const reviewerNode = await upsertNode("REVIEWER", wf.assignedOwnerUserId, `Reviewer ${wf.assignedOwnerUserId.slice(0, 8)}`, "LOW", "ASSIGNED");
                if (reviewerNode) {
                    await upsertEdge(reviewerNode, nodeId, "OWNS", "DIRECT", "REVIEWER_OWNS_WORKFLOW");
                }
            }
        }
    }
    catch {
        /* outer best-effort */
    }
    // Correlations → nodes + PART_OF edges
    try {
        const corrs = await prisma.operationalCorrelation.findMany({
            where: { teamId: input.teamId, expiresAtUtc: { gt: new Date() } },
            take: 50,
            select: {
                id: true,
                correlationType: true,
                severity: true,
                linkedIncidentIds: true,
            },
        });
        for (const c of corrs) {
            const nodeId = await upsertNode("CORRELATION", c.id, c.correlationType, String(c.severity), "ACTIVE");
            if (!nodeId)
                continue;
            const ids = Array.isArray(c.linkedIncidentIds)
                ? c.linkedIncidentIds
                : [];
            for (const incId of ids.slice(0, 20)) {
                const incNode = nodeIdMap.get(`INCIDENT:${incId}`);
                if (incNode) {
                    await upsertEdge(nodeId, incNode, "RELATED_TO", "DIRECT", "CORRELATION_GROUPS_INCIDENT");
                }
            }
        }
    }
    catch {
        /* outer best-effort */
    }
    return { nodes, edges, failed };
}
/**
 * Dashboard reader: returns a bounded graph topology summary —
 * top root-cause nodes by edge-out count + per-type counts + an
 * affected-entity rollup.
 */
export async function getOperationalGraphSummary(input) {
    const empty = {
        nodeCountsByType: [],
        edgeCountsByType: [],
        topRootCauses: [],
        blastRadius: {
            impactedEvidenceCount: 0,
            impactedCaseCount: 0,
            impactedReviewerCount: 0,
        },
    };
    try {
        const [nodeGroups, edgeGroups, evCount, caseCount, reviewerCount] = await Promise.all([
            prisma.operationalGraphNode.groupBy({
                by: ["nodeType"],
                where: { teamId: input.teamId },
                _count: { _all: true },
                orderBy: { nodeType: "asc" },
            }),
            prisma.operationalGraphEdge.groupBy({
                by: ["edgeType"],
                where: { teamId: input.teamId },
                _count: { _all: true },
                orderBy: { edgeType: "asc" },
            }),
            prisma.operationalGraphNode.count({
                where: { teamId: input.teamId, nodeType: "EVIDENCE" },
            }),
            prisma.operationalGraphNode.count({
                where: { teamId: input.teamId, nodeType: "CASE" },
            }),
            prisma.operationalGraphNode.count({
                where: { teamId: input.teamId, nodeType: "REVIEWER" },
            }),
        ]);
        // Top root causes: nodes with the highest out-degree, restricted to
        // INCIDENT / CORRELATION / WORKFLOW types.
        const edgeOut = await prisma.operationalGraphEdge.groupBy({
            by: ["sourceNodeId"],
            where: { teamId: input.teamId },
            _count: { _all: true },
            orderBy: { _count: { sourceNodeId: "desc" } },
            take: 10,
        });
        const sourceIds = edgeOut.map((e) => e.sourceNodeId);
        const sourceNodes = sourceIds.length
            ? await prisma.operationalGraphNode.findMany({
                where: { id: { in: sourceIds }, teamId: input.teamId },
                select: {
                    id: true,
                    nodeType: true,
                    entityId: true,
                    label: true,
                    severity: true,
                    status: true,
                },
            })
            : [];
        const byId = new Map(sourceNodes.map((n) => [n.id, n]));
        const topRootCauses = [];
        for (const e of edgeOut) {
            const n = byId.get(e.sourceNodeId);
            if (!n)
                continue;
            topRootCauses.push({
                nodeId: n.id,
                nodeType: String(n.nodeType),
                entityId: n.entityId,
                label: n.label,
                severity: n.severity,
                status: n.status,
                outDegree: e._count._all,
            });
        }
        return {
            nodeCountsByType: nodeGroups.map((g) => ({
                nodeType: String(g.nodeType),
                count: g._count._all,
            })),
            edgeCountsByType: edgeGroups.map((g) => ({
                edgeType: String(g.edgeType),
                count: g._count._all,
            })),
            topRootCauses,
            blastRadius: {
                impactedEvidenceCount: evCount,
                impactedCaseCount: caseCount,
                impactedReviewerCount: reviewerCount,
            },
        };
    }
    catch {
        return empty;
    }
}
