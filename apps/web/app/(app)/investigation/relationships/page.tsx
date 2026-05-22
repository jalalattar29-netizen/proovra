"use client";

/**
 * Phase 32.16 — Relationship Inspector.
 *
 * Surface #2 of 11 in the investigation workstation list. Inspects
 * a single graph node or edge within the context of a case subgraph.
 *
 * URL params:
 *   - caseId (required): the case whose subgraph to load
 *   - nodeId (optional): the node to highlight
 *   - edgeId (optional): the edge to highlight
 *
 * Consumes the existing `/v1/graph/cases/:caseId?depth=2` API. The
 * bounded public projection (id / nodeKind / safeLabel /
 * visibilityScope on nodes, id / edgeType / sourceNodeId /
 * targetNodeId / sourceKind / confidence / safeSummary on edges)
 * is what we render — no internal IDs, no timestamps, no storage
 * internals.
 *
 * Hard rules:
 *   * No fake data. Empty selection → "Select a relationship or
 *     node to inspect" with next-action guidance.
 *   * No forbidden vocabulary.
 *   * No internal IDs surfaced (only safe labels + kinds).
 *   * Bounded polling — paused when tab hidden.
 *   * Safer canonical-custody language.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
// =============================================================================
// Types — mirror the public graph projection
// =============================================================================

type GraphNode = {
  id: string;
  nodeKind: string;
  safeLabel: string;
  visibilityScope: string;
};

type GraphEdge = {
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceKind: string;
  confidence: string;
  safeSummary: string | null;
};

type CaseSubgraphResponse = {
  caseId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
};

// =============================================================================
// Page
// =============================================================================

export default function RelationshipInspectorPage() {
  const teamId = useTeamId();
  const search = useSearchParams();
  const caseId = search?.get("caseId") ?? "";
  const focusedNodeId = search?.get("nodeId") ?? null;
  const focusedEdgeId = search?.get("edgeId") ?? null;
  const [data, setData] = useState<CaseSubgraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  
useEffect(() => {
    if (!teamId || !caseId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const res = (await apiFetch(
          `/v1/graph/cases/${encodeURIComponent(caseId)}?teamId=${encodeURIComponent(teamId)}&depth=2`,
        )) as CaseSubgraphResponse;
        if (cancelled) return;
        setData(res);
        setError(null);
      } catch {
        if (!cancelled) setError("graph_unavailable");
      }
    };
    void load();
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [teamId, caseId]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of data?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [data]);

  const edgeById = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    for (const e of data?.edges ?? []) m.set(e.id, e);
    return m;
  }, [data]);

  const focusedEdge = focusedEdgeId ? edgeById.get(focusedEdgeId) : null;
  const focusedNode = focusedNodeId ? nodeById.get(focusedNodeId) : null;

  // When inspecting a node, list its incident edges (in/out).
  const incidentEdges = useMemo(() => {
    if (!focusedNode || !data) return [];
    return data.edges.filter(
      (e) =>
        e.sourceNodeId === focusedNode.id ||
        e.targetNodeId === focusedNode.id,
    );
  }, [data, focusedNode]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={kickerStyle}>Investigation graph</div>
          <h1 style={titleStyle}>Relationship Inspector</h1>
          <p style={subtitleStyle}>
            Bounded view of a single relationship or node within the case
            subgraph. Relationships are advisory; the canonical custody
            record remains the authoritative integrity artifact for each
            evidence record.
          </p>
        </div>
        <div style={headerRightStyle}>
          {error ? (
            <span style={errorPillStyle}>graph unavailable</span>
          ) : null}
          {caseId ? (
            <Link
              href={`/investigation/cases/${encodeURIComponent(caseId)}/graph`}
              style={pivotLinkStyle}
            >
              ← Open case graph
            </Link>
          ) : null}
        </div>
      </header>

      {!caseId ? (
        <section style={sectionStyle}>
          <p style={emptyStyle}>
            Select a relationship or node to inspect by navigating from the
            Case Graph Explorer. The inspector requires a case id in the URL.
          </p>
        </section>
      ) : !data ? (
        <section style={sectionStyle}>
          <p style={emptyStyle}>Loading subgraph…</p>
        </section>
      ) : focusedEdge ? (
        <EdgeInspector
          edge={focusedEdge}
          source={nodeById.get(focusedEdge.sourceNodeId) ?? null}
          target={nodeById.get(focusedEdge.targetNodeId) ?? null}
          caseId={caseId}
        />
      ) : focusedNode ? (
        <NodeInspector
          node={focusedNode}
          incidentEdges={incidentEdges}
          nodeById={nodeById}
          caseId={caseId}
        />
      ) : (
        <section style={sectionStyle}>
          <p style={emptyStyle}>
            Select a relationship or node to inspect. From the Case Graph
            Explorer, append <code>?nodeId=…</code> or{" "}
            <code>?edgeId=…</code> to this page to view detail.
          </p>
        </section>
      )}
    </div>
  );
}

// =============================================================================
// Edge inspector
// =============================================================================

function EdgeInspector({
  edge,
  source,
  target,
  caseId,
}: {
  edge: GraphEdge;
  source: GraphNode | null;
  target: GraphNode | null;
  caseId: string;
}) {
  return (
    <section style={sectionStyle}>
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span style={edgeBadgeStyle}>{edge.edgeType}</span>
          <span style={confidenceBadgeStyle(edge.confidence)}>
            {confidenceLabel(edge.confidence)}
          </span>
          <span style={sourceBadgeStyle(edge.sourceKind)}>
            {edge.sourceKind === "SYSTEM"
              ? "System-detected"
              : "Manually recorded"}
          </span>
        </div>

        <div style={endpointRowStyle}>
          <EndpointCard
            label="Source"
            node={source}
            caseId={caseId}
          />
          <span style={arrowStyle}>→</span>
          <EndpointCard
            label="Target"
            node={target}
            caseId={caseId}
          />
        </div>

        {edge.safeSummary ? (
          <p style={summaryStyle}>
            <strong>Why this relationship exists.</strong>{" "}
            {edge.safeSummary}
          </p>
        ) : (
          <p style={summaryMutedStyle}>
            No additional safe summary recorded for this relationship.
          </p>
        )}

        <div style={metaRowStyle}>
          <span style={metaItemStyle}>Source kind: {edge.sourceKind}</span>
          <span style={metaItemStyle}>Edge type: {edge.edgeType}</span>
        </div>
      </div>

      <p style={disclaimerStyle}>
        Graph relationships are deterministic, advisory observations of
        links between records in this workspace. They do not establish
        factual links between people or events.
      </p>
    </section>
  );
}

// =============================================================================
// Node inspector
// =============================================================================

function NodeInspector({
  node,
  incidentEdges,
  nodeById,
  caseId,
}: {
  node: GraphNode;
  incidentEdges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  caseId: string;
}) {
  return (
    <section style={sectionStyle}>
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span style={nodeKindBadgeStyle(node.nodeKind)}>{node.nodeKind}</span>
          <span style={visibilityBadgeStyle}>{node.visibilityScope}</span>
        </div>
        <h2 style={nodeTitleStyle}>{node.safeLabel}</h2>
      </div>

      <div style={cardStyle}>
        <h3 style={subsectionTitleStyle}>Incident relationships</h3>
        {incidentEdges.length === 0 ? (
          <p style={emptyStyle}>
            No relationships incident to this node in the current case
            subgraph. Run the graph reconciler to populate domain
            relationships, or check the broader graph search.
          </p>
        ) : (
          <ul style={edgeListStyle}>
            {incidentEdges.map((e) => {
              const otherId =
                e.sourceNodeId === node.id ? e.targetNodeId : e.sourceNodeId;
              const other = nodeById.get(otherId);
              const direction =
                e.sourceNodeId === node.id ? "outgoing" : "incoming";
              return (
                <li key={e.id} style={edgeListRowStyle}>
                  <div style={edgeListBadgeRowStyle}>
                    <span style={edgeBadgeStyle}>{e.edgeType}</span>
                    <span style={confidenceBadgeStyle(e.confidence)}>
                      {confidenceLabel(e.confidence)}
                    </span>
                    <span style={directionBadgeStyle}>{direction}</span>
                  </div>
                  <div style={edgeListLabelStyle}>
                    {direction === "outgoing"
                      ? `→ ${other?.safeLabel ?? "—"}`
                      : `← ${other?.safeLabel ?? "—"}`}
                  </div>
                  {e.safeSummary ? (
                    <div style={edgeListSummaryStyle}>{e.safeSummary}</div>
                  ) : null}
                  <Link
                    href={`/investigation/relationships?caseId=${encodeURIComponent(caseId)}&edgeId=${encodeURIComponent(e.id)}`}
                    style={pivotLinkStyle}
                  >
                    Inspect this relationship →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p style={disclaimerStyle}>
        Node detail and relationships are advisory observations only. They
        do not classify the recorded material and they do not establish
        legal weight.
      </p>
    </section>
  );
}

// =============================================================================
// Endpoint card subcomponent
// =============================================================================

function EndpointCard({
  label,
  node,
  caseId,
}: {
  label: string;
  node: GraphNode | null;
  caseId: string;
}) {
  if (!node) {
    return (
      <div style={endpointCardStyle}>
        <div style={endpointLabelStyle}>{label}</div>
        <div style={endpointPlaceholderStyle}>Endpoint not in subgraph</div>
      </div>
    );
  }
  return (
    <div style={endpointCardStyle}>
      <div style={endpointLabelStyle}>{label}</div>
      <div style={endpointBadgeRowStyle}>
        <span style={nodeKindBadgeStyle(node.nodeKind)}>{node.nodeKind}</span>
      </div>
      <div style={endpointNameStyle}>{node.safeLabel}</div>
      <Link
        href={`/investigation/relationships?caseId=${encodeURIComponent(caseId)}&nodeId=${encodeURIComponent(node.id)}`}
        style={pivotLinkStyle}
      >
        Open node detail →
      </Link>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function confidenceLabel(c: string): string {
  switch (c) {
    case "LOW":
      return "Low confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "HIGH":
      return "High confidence";
    default:
      return c;
  }
}

// =============================================================================
// Styles
// =============================================================================

const pageStyle: React.CSSProperties = {
  padding: 24,
  maxWidth: 1100,
  margin: "0 auto",
  fontFamily:
    "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  color: "#0f172a",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 20,
};

const headerRightStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 6,
};

const kickerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginBottom: 2,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
};

const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 13,
  color: "#64748b",
  maxWidth: 720,
  lineHeight: 1.5,
};

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
};

const errorPillStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  fontWeight: 600,
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  color: "#991b1b",
  borderRadius: 999,
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
};

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 12,
};

const subsectionTitleStyle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: 13,
  fontWeight: 700,
  color: "#334155",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#64748b",
  lineHeight: 1.5,
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
};

const edgeBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e40af",
  borderRadius: 999,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "nowrap",
};

function confidenceBadgeStyle(c: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    LOW: ["#fffbeb", "#fcd34d", "#92400e"],
    MEDIUM: ["#eff6ff", "#bfdbfe", "#1e40af"],
    HIGH: ["#ecfdf5", "#bbf7d0", "#166534"],
  };
  const [bg, border, color] = palette[c] ?? ["#f1f5f9", "#cbd5e1", "#475569"];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

function sourceBadgeStyle(s: string): React.CSSProperties {
  const isManual = s === "MANUAL";
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    background: isManual ? "#fef3c7" : "#f1f5f9",
    border: `1px solid ${isManual ? "#fcd34d" : "#cbd5e1"}`,
    color: isManual ? "#92400e" : "#475569",
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const visibilityBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 500,
  background: "#f5f3ff",
  border: "1px solid #ddd6fe",
  color: "#5b21b6",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

function nodeKindBadgeStyle(kind: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    CASE: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
    EVIDENCE: ["#eff6ff", "#bfdbfe", "#1e40af"],
    REPORT: ["#ecfdf5", "#bbf7d0", "#166534"],
    VERIFICATION_PACKAGE: ["#ecfdf5", "#bbf7d0", "#166534"],
    EXPORT: ["#fef3c7", "#fcd34d", "#92400e"],
    MEDIA_SIGNAL: ["#fffbeb", "#fcd34d", "#92400e"],
    REVIEW_TASK: ["#f0f9ff", "#bae6fd", "#075985"],
    ESCALATION: ["#fef2f2", "#fca5a5", "#991b1b"],
    INCIDENT: ["#fef2f2", "#fca5a5", "#991b1b"],
    OCR: ["#f1f5f9", "#cbd5e1", "#334155"],
    TRANSCRIPT: ["#f1f5f9", "#cbd5e1", "#334155"],
  };
  const [bg, border, color] = palette[kind] ?? ["#f1f5f9", "#cbd5e1", "#475569"];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const directionBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 500,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  color: "#475569",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const endpointRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 14,
  flexWrap: "wrap",
};

const endpointCardStyle: React.CSSProperties = {
  flex: "1 1 240px",
  border: "1px solid #e5e7eb",
  background: "#f8fafc",
  borderRadius: 8,
  padding: 12,
  minWidth: 220,
};

const endpointLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const endpointBadgeRowStyle: React.CSSProperties = {
  marginTop: 4,
  display: "flex",
};

const endpointNameStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};

const endpointPlaceholderStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#94a3b8",
};

const arrowStyle: React.CSSProperties = {
  fontSize: 18,
  color: "#94a3b8",
};

const summaryStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 0",
  fontSize: 13,
  color: "#0f172a",
  lineHeight: 1.5,
  borderTop: "1px solid #f1f5f9",
};

const summaryMutedStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 0",
  fontSize: 12,
  color: "#94a3b8",
  fontStyle: "italic",
  borderTop: "1px solid #f1f5f9",
};

const metaRowStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
};

const metaItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const nodeTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: "#0f172a",
};

const edgeListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const edgeListRowStyle: React.CSSProperties = {
  padding: 10,
  border: "1px solid #f1f5f9",
  borderRadius: 6,
  background: "#fafbfc",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const edgeListBadgeRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};

const edgeListLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#0f172a",
  fontWeight: 500,
};

const edgeListSummaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.4,
};

const disclaimerStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 14px",
  fontSize: 11,
  color: "#475569",
  lineHeight: 1.5,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
