"use client";

/**
 * Phase 32.15 — Case Graph Explorer.
 *
 * Surface #1 of 11 in the investigation workstation list. Renders
 * the subgraph rooted at one CASE node — Evidence linked to the
 * case + Reports / Verification Packages / Media Signals attached
 * to that evidence. Consumes the existing `/v1/graph/cases/:caseId`
 * API (Phase 32.5) which traverses the graph with bounded depth.
 *
 * Hard rules:
 *   * Real data only — no mock graph, no decorative-only graph.
 *   * No fake counters. Empty case → "no relationships yet" state
 *     with a next-action prompt.
 *   * Filter by relationship type (edge type catalog).
 *   * Filter by node kind.
 *   * No storage internals, no signed URLs, no private notes leak
 *     in any displayed field (the API projection already strips
 *     these; this UI never reconstitutes them).
 *   * Bounded polling — 60 s, paused when tab hidden.
 *   * Tone is operational only. No forbidden vocabulary.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../../../lib/api";
import { useTeamId } from "../../../../../../lib/platform-context";
// =============================================================================
// Types — mirror the /v1/graph/cases/:caseId projection
// =============================================================================

// Matches the public projection in services/api/src/routes/graph.routes.ts
// (projectNodeForPublic / projectEdgeForPublic). Timestamps and internal
// external IDs are deliberately NOT exposed at the public route.
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

const ALL_NODE_KINDS = [
  "ALL",
  "EVIDENCE",
  "CASE",
  "REPORT",
  "VERIFICATION_PACKAGE",
  "EXPORT",
  "MEDIA_SIGNAL",
  "OCR",
  "TRANSCRIPT",
  "INCIDENT",
  "REVIEW_TASK",
  "ESCALATION",
] as const;

type NodeKindFilter = (typeof ALL_NODE_KINDS)[number];

const ALL_EDGE_TYPES = [
  "ALL",
  "BELONGS_TO_CASE",
  "GENERATED_REPORT",
  "GENERATED_PACKAGE",
  "EXPORTED_AS",
  "HAS_MEDIA_SIGNAL",
  "HAS_OCR",
  "HAS_TRANSCRIPT",
  "SAME_HASH_AS",
  "SIMILAR_TO",
  "MANUALLY_LINKED_TO",
  "REFERENCES_SAME_INCIDENT",
] as const;

type EdgeTypeFilter = (typeof ALL_EDGE_TYPES)[number];

// =============================================================================
// Page
// =============================================================================

export default function CaseGraphExplorerPage() {
  const teamId = useTeamId();
  const params = useParams<{ caseId: string }>();
  const caseId = typeof params?.caseId === "string" ? params.caseId : "";
  const [data, setData] = useState<CaseSubgraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [nodeKindFilter, setNodeKindFilter] = useState<NodeKindFilter>("ALL");
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<EdgeTypeFilter>("ALL");

  // Resolve workspace.
  
// Bounded poll.
  useEffect(() => {
    if (!teamId || !caseId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = (await apiFetch(
          `/v1/graph/cases/${encodeURIComponent(caseId)}?teamId=${encodeURIComponent(teamId)}&depth=2`,
          { method: "GET" },
        )) as CaseSubgraphResponse;
        if (cancelled) return;
        setData(res);
        setLastFetchAt(Date.now());
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

  const filteredEdges = useMemo(() => {
    if (!data) return [];
    return data.edges.filter((e) => {
      if (edgeTypeFilter !== "ALL" && e.edgeType !== edgeTypeFilter)
        return false;
      if (nodeKindFilter !== "ALL") {
        const src = nodeById.get(e.sourceNodeId);
        const tgt = nodeById.get(e.targetNodeId);
        if (
          (!src || src.nodeKind !== nodeKindFilter) &&
          (!tgt || tgt.nodeKind !== nodeKindFilter)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [data, edgeTypeFilter, nodeKindFilter, nodeById]);

  const filteredNodesByKind = useMemo(() => {
    if (!data) return new Map<string, GraphNode[]>();
    const byKind = new Map<string, GraphNode[]>();
    for (const n of data.nodes) {
      if (nodeKindFilter !== "ALL" && n.nodeKind !== nodeKindFilter) continue;
      const bucket = byKind.get(n.nodeKind);
      if (bucket) bucket.push(n);
      else byKind.set(n.nodeKind, [n]);
    }
    return byKind;
  }, [data, nodeKindFilter]);

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={kickerStyle}>Case</div>
          <h1 style={titleStyle}>Case Graph Explorer</h1>
          <p style={subtitleStyle}>
            Connected evidence, reports, verification packages, exports, and
            media observations for this case. Relationships are advisory;
            the canonical custody record remains the authoritative
            integrity artifact for each evidence record.
          </p>
        </div>
        <div style={headerRightStyle}>
          <span style={freshnessPillStyle(error, ageSeconds, teamId)}>
            {error
              ? "data unavailable"
              : !teamId
                ? "loading workspace…"
                : ageSeconds == null
                  ? "loading…"
                  : `updated ${ageSeconds}s ago`}
          </span>
          <Link href="/investigation" style={pivotLinkStyle}>
            ← Investigation overview
          </Link>
        </div>
      </header>

      <section style={controlsRowStyle}>
        <label style={controlsLabelStyle}>Node kind</label>
        <select
          value={nodeKindFilter}
          onChange={(e) => setNodeKindFilter(e.target.value as NodeKindFilter)}
          style={selectStyle}
        >
          {ALL_NODE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "ALL" ? "All node kinds" : k}
            </option>
          ))}
        </select>
        <label style={controlsLabelStyle}>Edge type</label>
        <select
          value={edgeTypeFilter}
          onChange={(e) => setEdgeTypeFilter(e.target.value as EdgeTypeFilter)}
          style={selectStyle}
        >
          {ALL_EDGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "ALL" ? "All relationships" : t}
            </option>
          ))}
        </select>
        {data?.truncated ? (
          <span style={truncatedNoticeStyle}>
            Showing a bounded subgraph. Narrow your filters to see deeper
            relationships.
          </span>
        ) : null}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Nodes</h2>
        {data == null ? (
          <p style={emptyStyle}>Loading…</p>
        ) : filteredNodesByKind.size === 0 ? (
          <p style={emptyStyle}>
            No nodes recorded for this case under the current filter. Run
            the graph reconciler from operations to populate the workspace
            graph, or check that the case has at least one evidence record
            assigned.
          </p>
        ) : (
          <ul style={nodeListStyle}>
            {Array.from(filteredNodesByKind.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([kind, nodes]) => (
                <li key={kind} style={nodeGroupStyle}>
                  <div style={nodeGroupHeaderStyle}>
                    <span style={nodeKindBadgeStyle(kind)}>{kind}</span>
                    <span style={nodeGroupCountStyle}>
                      {nodes.length}{" "}
                      {nodes.length === 1 ? "node" : "nodes"}
                    </span>
                  </div>
                  <ul style={nodeItemsStyle}>
                    {nodes.map((n) => (
                      <li key={n.id} style={nodeItemStyle}>
                        <div style={nodeLabelStyle}>{n.safeLabel}</div>
                        <div style={nodeMetaRowStyle}>
                          <span style={nodeMetaItemStyle}>
                            {n.visibilityScope}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Relationships</h2>
        {data == null ? (
          <p style={emptyStyle}>Loading…</p>
        ) : filteredEdges.length === 0 ? (
          <p style={emptyStyle}>
            No relationships recorded under the current filter. Once
            evidence is assigned to this case, reports are generated, or
            packages are produced, the graph reconciler materializes the
            corresponding edges automatically.
          </p>
        ) : (
          <ul style={edgeListStyle}>
            {filteredEdges.map((e) => {
              const src = nodeById.get(e.sourceNodeId);
              const tgt = nodeById.get(e.targetNodeId);
              return (
                <li key={e.id} style={edgeRowStyle}>
                  <div style={edgeKindStyle}>
                    <span style={edgeTypeBadgeStyle(e.edgeType)}>
                      {e.edgeType}
                    </span>
                    <span style={edgeConfidenceStyle(e.confidence)}>
                      {confidenceLabel(e.confidence)}
                    </span>
                  </div>
                  <div style={edgeArrowRowStyle}>
                    <span style={edgeEndpointStyle}>
                      {src?.safeLabel ?? "—"}
                    </span>
                    <span style={edgeArrowStyle}>→</span>
                    <span style={edgeEndpointStyle}>
                      {tgt?.safeLabel ?? "—"}
                    </span>
                  </div>
                  {e.safeSummary ? (
                    <div style={edgeSummaryStyle}>{e.safeSummary}</div>
                  ) : null}
                  <div style={edgeMetaRowStyle}>
                    <span style={edgeMetaItemStyle}>{e.sourceKind}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
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
  maxWidth: 1280,
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

function freshnessPillStyle(
  err: string | null,
  ageSeconds: number | null,
  teamId: string | null,
): React.CSSProperties {
  let bg = "#eff6ff";
  let border = "#bfdbfe";
  let color = "#1e40af";
  if (err) {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  } else if (!teamId || ageSeconds == null) {
    bg = "#f1f5f9";
    border = "#cbd5e1";
    color = "#334155";
  } else if (ageSeconds > 180) {
    bg = "#fffbeb";
    border = "#fcd34d";
    color = "#92400e";
  }
  return {
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginBottom: 20,
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};

const controlsLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#475569",
};

const selectStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 12,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#ffffff",
  color: "#0f172a",
};

const truncatedNoticeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#92400e",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 999,
  padding: "3px 10px",
  marginLeft: "auto",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 24,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: 14,
  fontWeight: 700,
  color: "#334155",
  textTransform: "uppercase",
  letterSpacing: 0.6,
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

const nodeListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 12,
};

const nodeGroupStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: "#ffffff",
  overflow: "hidden",
};

const nodeGroupHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 12px",
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
};

const nodeGroupCountStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontWeight: 500,
};

const nodeItemsStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const nodeItemStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #f1f5f9",
};

const nodeLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  lineHeight: 1.3,
};

const nodeMetaRowStyle: React.CSSProperties = {
  marginTop: 4,
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const nodeMetaItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function nodeKindBadgeStyle(kind: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    CASE: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
    EVIDENCE: ["#eff6ff", "#bfdbfe", "#1e40af"],
    REPORT: ["#ecfdf5", "#bbf7d0", "#166534"],
    VERIFICATION_PACKAGE: ["#ecfdf5", "#bbf7d0", "#166534"],
    EXPORT: ["#fef3c7", "#fcd34d", "#92400e"],
    MEDIA_SIGNAL: ["#fffbeb", "#fcd34d", "#92400e"],
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

const edgeListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const edgeRowStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
  background: "#ffffff",
};

const edgeKindStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginBottom: 6,
};

function edgeTypeBadgeStyle(_t: string): React.CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1e40af",
    borderRadius: 999,
    whiteSpace: "nowrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
}

function edgeConfidenceStyle(c: string): React.CSSProperties {
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

const edgeArrowRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginBottom: 6,
};

const edgeEndpointStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#0f172a",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 360,
};

const edgeArrowStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#94a3b8",
};

const edgeSummaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.5,
};

const edgeMetaRowStyle: React.CSSProperties = {
  marginTop: 6,
  display: "flex",
  gap: 8,
};

const edgeMetaItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
