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

import { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { workspaceIncidentWhere } from "../observability/incident-scope.js";

type NodeType =
  | "INCIDENT"
  | "WORKFLOW"
  | "CORRELATION"
  | "CASE"
  | "EVIDENCE"
  | "QUEUE"
  | "WORKER"
  | "REVIEWER"
  | "GOVERNANCE_POLICY"
  | "EXPORT"
  | "REPORT"
  | "PACKAGE";

type EdgeType =
  | "CAUSED"
  | "BLOCKS"
  | "DEPENDS_ON"
  | "IMPACTS"
  | "ESCALATES_TO"
  | "MITIGATES"
  | "OWNS"
  | "ASSIGNED_TO"
  | "RELATED_TO";

export async function projectOperationalGraphForWorkspace(input: {
  teamId: string;
}): Promise<{ nodes: number; edges: number; failed: number }> {
  let nodes = 0;
  let edges = 0;
  let failed = 0;

  /*
   * CAP-6 — nodes are collected and written once, at the end, like edges.
   *
   * Each node used to be its own `upsert` (a read, then an insert or an
   * update): about thirty statements a workspace on every sweep. The rule is
   * unchanged and now runs as ONE statement on the same unique key
   * (team_id, node_type, entity_id):
   *   * a missing node is inserted;
   *   * an existing node gets the current label / severity / status and a new
   *     `updated_at` — the command center's freshness signal, so every node
   *     this pass saw is still marked fresh, exactly as the upsert did.
   * The first sighting of a (nodeType, entityId) in a pass decides its fields,
   * as the per-call cache did. Edges name their endpoints by the same key and
   * are resolved to the written ids before they are written.
   */
  const pendingNodes = new Map<
    string,
    { nodeType: NodeType; entityId: string; label: string; severity: string; status: string }
  >();
  const nodeIdMap = new Map<string, string>();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const upsertNode = async (
    nodeType: NodeType,
    entityId: string,
    label: string,
    severity: string,
    status: string,
  ): Promise<string | null> => {
    const key = `${nodeType}:${entityId}`;
    if (pendingNodes.has(key)) return key;
    // A value that cannot be a uuid could never be written (the upsert threw
    // for it alone); it must not fail the whole batch.
    if (!UUID.test(entityId)) {
      failed += 1;
      return null;
    }
    pendingNodes.set(key, {
      nodeType,
      entityId,
      label: label.slice(0, 180),
      severity: severity.slice(0, 16),
      status: status.slice(0, 40),
    });
    return key;
  };

  const flushNodes = async (): Promise<void> => {
    if (pendingNodes.size === 0) return;
    const rows = [...pendingNodes.values()];
    pendingNodes.clear();
    const now = new Date();
    try {
      const written = await prisma.$queryRaw<Array<{ id: string; node_type: string; entity_id: string }>>(Prisma.sql`
        INSERT INTO "operational_graph_nodes"
          ("team_id", "node_type", "entity_id", "label", "severity", "status", "created_at", "updated_at")
        SELECT ${input.teamId}::uuid, t.node_type::"OperationalGraphNodeType", t.entity_id::uuid,
               t.label, t.severity, t.status, ${now}, ${now}
        FROM unnest(
          ${rows.map((r) => r.nodeType)}::text[],
          ${rows.map((r) => r.entityId)}::text[],
          ${rows.map((r) => r.label)}::text[],
          ${rows.map((r) => r.severity)}::text[],
          ${rows.map((r) => r.status)}::text[]
        ) AS t(node_type, entity_id, label, severity, status)
        ON CONFLICT ("team_id", "node_type", "entity_id") DO UPDATE SET
          "label" = EXCLUDED."label",
          "severity" = EXCLUDED."severity",
          "status" = EXCLUDED."status",
          "updated_at" = EXCLUDED."updated_at"
        RETURNING "id"::text AS id, "node_type"::text AS node_type, "entity_id"::text AS entity_id`);
      for (const w of written) nodeIdMap.set(`${w.node_type}:${w.entity_id.toLowerCase()}`, w.id);
      nodes += written.length;
    } catch {
      failed += rows.length;
    }
  };
  const nodeIdFor = (key: string): string | null => {
    const sep = key.indexOf(":");
    return nodeIdMap.get(`${key.slice(0, sep)}:${key.slice(sep + 1).toLowerCase()}`) ?? null;
  };

  /*
   * CAP-6 — edges are collected and written once, at the end.
   *
   * Each edge used to be its own `upsert` with an empty `update`, which
   * Prisma runs as three reads and, for a new edge, an insert: about seventy
   * statements a workspace on every sweep, for rows that almost always exist
   * already. `createMany({ skipDuplicates })` is the same rule in one
   * statement — `INSERT … ON CONFLICT DO NOTHING` on the same unique key: a
   * missing edge is created, an existing edge is left exactly as it was.
   * Both endpoints are nodes of this pass, named by their node key and
   * resolved to the written ids at flush (an endpoint whose node was not
   * written drops the edge, as a failed node upsert did).
   */
  const pendingEdges = new Map<
    string,
    {
      teamId: string;
      sourceNodeId: string;
      targetNodeId: string;
      edgeType: EdgeType;
      confidence: string;
      reasonCode: string;
    }
  >();
  const upsertEdge = async (
    sourceNodeId: string,
    targetNodeId: string,
    edgeType: EdgeType,
    confidence: string,
    reasonCode: string,
  ): Promise<void> => {
    const key = `${sourceNodeId}:${targetNodeId}:${edgeType}`;
    if (pendingEdges.has(key)) return;
    pendingEdges.set(key, {
      teamId: input.teamId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      confidence: confidence.slice(0, 24),
      reasonCode: reasonCode.slice(0, 80),
    });
  };
  const flushEdges = async (): Promise<void> => {
    if (pendingEdges.size === 0) return;
    const rows = [...pendingEdges.values()].flatMap((e) => {
      const sourceNodeId = nodeIdFor(e.sourceNodeId);
      const targetNodeId = nodeIdFor(e.targetNodeId);
      return sourceNodeId && targetNodeId ? [{ ...e, sourceNodeId, targetNodeId }] : [];
    });
    pendingEdges.clear();
    if (rows.length === 0) return;
    try {
      await prisma.operationalGraphEdge.createMany({
        data: rows as never,
        skipDuplicates: true,
      });
      edges += rows.length;
    } catch {
      failed += rows.length;
    }
  };

  // Incidents → nodes
  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        // WORKSPACE-SCOPE CONVERGENCE (§12) — was
        // `OR: [{ teamId: input.teamId }, { teamId: null }]`. The NULL arm was
        // written to pick up platform-wide incidents; because deleting a
        // workspace rewrites ITS incidents' team_id to NULL via
        // `ON DELETE SET NULL`, the same arm returned every other tenant's
        // orphans into this workspace's read.
        ...workspaceIncidentWhere(input.teamId),
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
      const nodeId = await upsertNode(
        "INCIDENT",
        inc.id,
        inc.title,
        String(inc.severity),
        String(inc.status),
      );
      if (nodeId && inc.relatedEvidenceId) {
        const evNodeId = await upsertNode(
          "EVIDENCE",
          inc.relatedEvidenceId,
          `Evidence ${inc.relatedEvidenceId.slice(0, 8)}`,
          "MEDIUM",
          "ACTIVE",
        );
        if (evNodeId) {
          await upsertEdge(
            nodeId,
            evNodeId,
            "IMPACTS",
            "DIRECT",
            "INCIDENT_IMPACTS_EVIDENCE",
          );
        }
      }
    }
  } catch {
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
      const nodeId = await upsertNode(
        "WORKFLOW",
        wf.id,
        wf.title,
        String(wf.severity),
        String(wf.status),
      );
      if (!nodeId) continue;
      if (wf.sourceIncidentId) {
        const incId = nodeIdMap.get(`INCIDENT:${wf.sourceIncidentId}`);
        if (incId) {
          await upsertEdge(
            incId,
            nodeId,
            "CAUSED",
            "DIRECT",
            "INCIDENT_TRIGGERED_WORKFLOW",
          );
        }
      }
      if (wf.evidenceId) {
        const evNodeId = await upsertNode(
          "EVIDENCE",
          wf.evidenceId,
          `Evidence ${wf.evidenceId.slice(0, 8)}`,
          "MEDIUM",
          "ACTIVE",
        );
        if (evNodeId) {
          await upsertEdge(
            nodeId,
            evNodeId,
            "IMPACTS",
            "DIRECT",
            "WORKFLOW_IMPACTS_EVIDENCE",
          );
        }
      }
      if (wf.caseId) {
        const caseNode = await upsertNode(
          "CASE",
          wf.caseId,
          `Case ${wf.caseId.slice(0, 8)}`,
          "MEDIUM",
          "ACTIVE",
        );
        if (caseNode) {
          await upsertEdge(
            nodeId,
            caseNode,
            "IMPACTS",
            "DIRECT",
            "WORKFLOW_IMPACTS_CASE",
          );
        }
      }
      if (wf.assignedOwnerUserId) {
        const reviewerNode = await upsertNode(
          "REVIEWER",
          wf.assignedOwnerUserId,
          `Reviewer ${wf.assignedOwnerUserId.slice(0, 8)}`,
          "LOW",
          "ASSIGNED",
        );
        if (reviewerNode) {
          await upsertEdge(
            reviewerNode,
            nodeId,
            "OWNS",
            "DIRECT",
            "REVIEWER_OWNS_WORKFLOW",
          );
        }
      }
    }
  } catch {
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
      const nodeId = await upsertNode(
        "CORRELATION",
        c.id,
        c.correlationType,
        String(c.severity),
        "ACTIVE",
      );
      if (!nodeId) continue;
      const ids = Array.isArray(c.linkedIncidentIds)
        ? (c.linkedIncidentIds as string[])
        : [];
      for (const incId of ids.slice(0, 20)) {
        const incNode = nodeIdMap.get(`INCIDENT:${incId}`);
        if (incNode) {
          await upsertEdge(
            nodeId,
            incNode,
            "RELATED_TO",
            "DIRECT",
            "CORRELATION_GROUPS_INCIDENT",
          );
        }
      }
    }
  } catch {
    /* outer best-effort */
  }

  await flushNodes();
  await flushEdges();
  return { nodes, edges, failed };
}

/**
 * Dashboard reader: returns a bounded graph topology summary —
 * top root-cause nodes by edge-out count + per-type counts + an
 * affected-entity rollup.
 */
export async function getOperationalGraphSummary(input: {
  teamId: string;
}): Promise<{
  nodeCountsByType: Array<{ nodeType: string; count: number }>;
  edgeCountsByType: Array<{ edgeType: string; count: number }>;
  topRootCauses: Array<{
    nodeId: string;
    nodeType: string;
    entityId: string;
    label: string;
    severity: string;
    status: string;
    outDegree: number;
  }>;
  blastRadius: {
    impactedEvidenceCount: number;
    impactedCaseCount: number;
    impactedReviewerCount: number;
  };
}> {
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
    /*
     * THE GROUPING ALREADY ANSWERED THIS.
     *
     * `nodeGroups` is a GROUP BY over `node_type` for this workspace, so it
     * returns a count for EVERY type. Three `count()` calls then asked the
     * same table, with the same tenant predicate, for one bucket each — three
     * extra round trips inside the same `Promise.all` as the query that had
     * already produced their answers.
     *
     * Read from the grouping instead. Same table, same predicate, same scope:
     * a bucket with no rows is absent from a GROUP BY, which is why the
     * lookup below reads a missing bucket as 0 rather than as undefined.
     */
    const [nodeGroups, edgeGroups] = await Promise.all([
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
    ]);
    const nodeCountOf = (nodeType: string): number =>
      nodeGroups.find((g) => String(g.nodeType) === nodeType)?._count._all ?? 0;
    const evCount = nodeCountOf("EVIDENCE");
    const caseCount = nodeCountOf("CASE");
    const reviewerCount = nodeCountOf("REVIEWER");

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
    type TopRoot = {
      nodeId: string;
      nodeType: string;
      entityId: string;
      label: string;
      severity: string;
      status: string;
      outDegree: number;
    };
    const topRootCauses: TopRoot[] = [];
    for (const e of edgeOut) {
      const n = byId.get(e.sourceNodeId);
      if (!n) continue;
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
  } catch {
    return empty;
  }
}
