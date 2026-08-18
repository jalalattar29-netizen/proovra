"use client";

/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * Graph curation, inside the existing investigation graph explorer.
 *
 * The explorer could already list seeds, reconcile, and export — but an
 * investigator had no way to SEARCH the graph, inspect the subgraph
 * around a piece of evidence, assert a relationship between two records,
 * retract one, or see whether the graph itself is healthy. This panel
 * closes those five gaps in one place, next to the seeds they act on.
 *
 * Wires:
 *   GET    /v1/graph/diagnostics                      — graph health
 *   GET    /v1/graph/search                           — bounded node search
 *   GET    /v1/graph/evidence/:evidenceId             — subgraph + provenance
 *   POST   /v1/graph/relationships/manual             — assert a link
 *   DELETE /v1/graph/relationships/manual/:id         — retract a link
 *
 * Two properties matter here and are enforced by the server:
 *
 *   DUPLICATE-EDGE IDEMPOTENCY — re-asserting a link that already exists
 *   (in either direction, since both manual edge types are symmetric)
 *   returns the EXISTING assertion instead of minting a second one. The
 *   UI reports that honestly rather than claiming a new link was made.
 *
 *   PROVENANCE — an operator-asserted edge carries who asserted it, when,
 *   and the note they left. A derived edge (same hash, OCR, …) carries
 *   none, and renders as "derived signal". Collapsing the two would let a
 *   human claim read as machine evidence.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";

// ---------------------------------------------------------------------------
// Server projection types
// ---------------------------------------------------------------------------

type GraphNode = {
  id: string;
  nodeKind: string;
  safeLabel: string | null;
  visibilityScope: string;
};

type RelationshipProvenance = {
  manualRelationshipId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
  createdByUserId: string;
  safeNote: string | null;
  status: string;
  createdAtUtc: string;
  reversed: boolean;
};

type GraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
  sourceKind: string;
  confidence: string;
  safeSummary: string | null;
  provenance: RelationshipProvenance | null;
};

type Diagnostics = {
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

const MANUAL_EDGE_TYPES = [
  "REFERENCES_SAME_INCIDENT",
  "MANUALLY_LINKED_TO",
] as const;

type Async<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

function denialOf(err: unknown): string | null {
  const e = err as {
    statusCode?: number;
    code?: string;
    body?: { error?: { code?: string } };
  };
  const code = e?.body?.error?.code ?? e?.code;
  if (code === "permission_denied" || e?.statusCode === 403) {
    return "Your role in this workspace cannot use this graph capability.";
  }
  if (e?.statusCode === 404 || code === "not_found") {
    return "This workspace has no graph data you can read.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function GraphCurationPanel({
  teamId,
  canCurate,
  canViewDiagnostics,
}: {
  teamId: string | null;
  /**
   * Rendering hint only. The server is the authority: every mutation
   * below is independently gated on `evidence.update_metadata`, and a
   * denial is surfaced as a denial, not as a silent no-op.
   */
  canCurate: boolean;
  canViewDiagnostics: boolean;
}) {
  const guard = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [diagnostics, setDiagnostics] = useState<Async<Diagnostics>>({
    kind: "idle",
  });
  const [search, setSearch] = useState<Async<GraphNode[]>>({ kind: "idle" });
  const [label, setLabel] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [subgraph, setSubgraph] = useState<
    Async<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>
  >({ kind: "idle" });

  const [sourceNodeId, setSourceNodeId] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [edgeType, setEdgeType] =
    useState<(typeof MANUAL_EDGE_TYPES)[number]>("MANUALLY_LINKED_TO");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [curationResult, setCurationResult] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------
  const loadDiagnostics = useCallback(async () => {
    if (!teamId || !canViewDiagnostics) return;
    setDiagnostics({ kind: "loading" });
    const stamp = guard.stamp();
    try {
      const res = (await apiFetch(
        `/v1/graph/diagnostics?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as Diagnostics;
      if (guard.isStale(stamp)) return;
      setDiagnostics({ kind: "ready", data: res });
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const denial = denialOf(err);
      if (denial) {
        setDiagnostics({ kind: "denied", reason: denial });
        return;
      }
      setDiagnostics({
        kind: "error",
        message: toSafeUserError(err, {
          message: "Unable to read graph diagnostics.",
        }).message,
      });
    }
  }, [canViewDiagnostics, guard, teamId]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  const runSearch = useCallback(async () => {
    if (!teamId) return;
    const trimmed = label.trim();
    if (trimmed.length < 1) {
      setSearch({ kind: "idle" });
      return;
    }
    setSearch({ kind: "loading" });
    const stamp = guard.stamp();
    try {
      const res = (await apiFetch(
        `/v1/graph/search?teamId=${encodeURIComponent(teamId)}&label=${encodeURIComponent(trimmed)}&limit=25`,
        { method: "GET" },
      )) as { nodes: GraphNode[] };
      if (guard.isStale(stamp)) return;
      setSearch({ kind: "ready", data: res.nodes ?? [] });
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const denial = denialOf(err);
      if (denial) {
        setSearch({ kind: "denied", reason: denial });
        return;
      }
      setSearch({
        kind: "error",
        message: toSafeUserError(err, {
          message: "Graph search is unavailable.",
        }).message,
      });
    }
  }, [guard, label, teamId]);

  // -------------------------------------------------------------------------
  // Evidence subgraph
  // -------------------------------------------------------------------------
  const loadSubgraph = useCallback(
    async (id: string) => {
      if (!teamId || !id.trim()) return;
      setSubgraph({ kind: "loading" });
      const stamp = guard.stamp();
      try {
        const res = (await apiFetch(
          `/v1/graph/evidence/${encodeURIComponent(id.trim())}?teamId=${encodeURIComponent(teamId)}&depth=2`,
          { method: "GET" },
        )) as { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };
        if (guard.isStale(stamp)) return;
        setSubgraph({ kind: "ready", data: res });
      } catch (err) {
        if (guard.isStale(stamp)) return;
        const denial = denialOf(err);
        if (denial) {
          setSubgraph({ kind: "denied", reason: denial });
          return;
        }
        setSubgraph({
          kind: "error",
          message: toSafeUserError(err, {
            message: "Unable to load the graph around that evidence record.",
          }).message,
        });
      }
    },
    [guard, teamId],
  );

  // -------------------------------------------------------------------------
  // Relationship create — duplicate-safe
  // -------------------------------------------------------------------------
  const createRelationship = useCallback(async () => {
    if (!teamId) return;
    const src = sourceNodeId.trim();
    const tgt = targetNodeId.trim();
    if (!src || !tgt) {
      setCurationResult({
        tone: "error",
        message: "Both graph node ids are required.",
      });
      return;
    }
    if (src === tgt) {
      setCurationResult({
        tone: "error",
        message: "A record cannot be linked to itself.",
      });
      return;
    }
    setBusy("create");
    setCurationResult(null);
    const stamp = guard.stamp();
    try {
      const res = (await apiFetch(`/v1/graph/relationships/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          sourceNodeId: src,
          targetNodeId: tgt,
          edgeType,
          ...(note.trim() ? { safeNote: note.trim() } : {}),
        }),
      })) as {
        manualRelationshipId: string;
        idempotent: boolean;
        provenance: RelationshipProvenance | null;
      };
      if (guard.isStale(stamp)) return;
      setCurationResult({
        tone: res.idempotent ? "info" : "success",
        message: res.idempotent
          ? `These records are already linked${res.provenance?.reversed ? " (asserted in the other direction)" : ""}. The existing relationship was kept — no duplicate was created.`
          : "Relationship recorded. It is attributed to you in the graph provenance.",
      });
      setNote("");
      if (evidenceId.trim()) await loadSubgraph(evidenceId);
      await loadDiagnostics();
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const denial = denialOf(err);
      setCurationResult({
        tone: "error",
        message:
          denial ??
          toSafeUserError(err, {
            message: "Unable to record that relationship.",
          }).message,
      });
    } finally {
      setBusy(null);
    }
  }, [
    edgeType,
    evidenceId,
    guard,
    loadDiagnostics,
    loadSubgraph,
    note,
    sourceNodeId,
    targetNodeId,
    teamId,
  ]);

  // -------------------------------------------------------------------------
  // Relationship retract
  // -------------------------------------------------------------------------
  const retractRelationship = useCallback(
    async (provenance: RelationshipProvenance) => {
      if (!teamId) return;
      const ok = await confirm({
        title: "Retract this relationship?",
        description:
          "The link is marked retracted and the corresponding graph edge is staled. The retraction is recorded — the original assertion is never erased.",
        confirmLabel: "Retract link",
        tone: "danger",
      });
      if (!ok) return;
      setBusy(`retract:${provenance.manualRelationshipId}`);
      setCurationResult(null);
      const stamp = guard.stamp();
      try {
        await apiFetch(
          `/v1/graph/relationships/manual/${encodeURIComponent(provenance.manualRelationshipId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, reason: "operator_retraction" }),
          },
        );
        if (guard.isStale(stamp)) return;
        setCurationResult({
          tone: "success",
          message: "Relationship retracted.",
        });
        if (evidenceId.trim()) await loadSubgraph(evidenceId);
        await loadDiagnostics();
      } catch (err) {
        if (guard.isStale(stamp)) return;
        const denial = denialOf(err);
        setCurationResult({
          tone: "error",
          message:
            denial ??
            toSafeUserError(err, {
              message: "Unable to retract that relationship.",
            }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [confirm, evidenceId, guard, loadDiagnostics, loadSubgraph, teamId],
  );

  if (!teamId) return null;

  return (
    <section style={panelStyle} data-testid="graph-curation-panel">
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Graph curation</h2>
        <p style={muted}>
          Search the graph, inspect what surrounds a record, and record or
          retract an operator-asserted relationship. Asserted links are always
          attributed; derived links are labelled as signals, never as
          conclusions.
        </p>
      </header>

      {/* Diagnostics */}
      {canViewDiagnostics ? (
        <div style={block} data-testid="graph-diagnostics">
          <h3 style={h3}>Graph health</h3>
          {diagnostics.kind === "loading" ? (
            <p style={muted}>Reading diagnostics…</p>
          ) : null}
          {diagnostics.kind === "denied" ? (
            <div style={denialBox}>{diagnostics.reason}</div>
          ) : null}
          {diagnostics.kind === "error" ? (
            <div style={errBox}>{diagnostics.message}</div>
          ) : null}
          {diagnostics.kind === "ready" ? (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Stat label="Nodes" value={diagnostics.data.nodeCount} />
              <Stat label="Edges" value={diagnostics.data.edgeCount} />
              <Stat label="Stale nodes" value={diagnostics.data.staleNodeCount} />
              <Stat label="Stale edges" value={diagnostics.data.staleEdgeCount} />
              <Stat
                label="Reconcile queue"
                value={
                  diagnostics.data.queueDepth === null
                    ? "unknown"
                    : diagnostics.data.queueDepth
                }
              />
              <Stat
                label="Last graph write"
                value={
                  diagnostics.data.lastReconcileCompletedAt
                    ? diagnostics.data.lastReconcileCompletedAt.slice(0, 19)
                    : "never"
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Search */}
      <div style={block} data-testid="graph-search">
        <h3 style={h3}>Find a node</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={input}
            placeholder="Label contains…"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
            aria-label="Graph node label search"
          />
          <button type="button" style={primaryBtn} onClick={() => void runSearch()}>
            Search
          </button>
        </div>
        {search.kind === "loading" ? <p style={muted}>Searching…</p> : null}
        {search.kind === "denied" ? (
          <div style={denialBox}>{search.reason}</div>
        ) : null}
        {search.kind === "error" ? <div style={errBox}>{search.message}</div> : null}
        {search.kind === "ready" && search.data.length === 0 ? (
          <p style={muted}>
            No graph node in this workspace matches that label. That is a real
            zero result, not a blocked read.
          </p>
        ) : null}
        {search.kind === "ready" && search.data.length > 0 ? (
          <ul style={listReset}>
            {search.data.map((n) => (
              <li key={n.id} style={row} data-node-id={n.id}>
                <span style={{ flex: 1 }}>
                  <strong>{n.safeLabel ?? "(no label)"}</strong>{" "}
                  <span style={chip}>{n.nodeKind}</span>
                </span>
                {canCurate ? (
                  <>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => setSourceNodeId(n.id)}
                    >
                      Use as source
                    </button>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => setTargetNodeId(n.id)}
                    >
                      Use as target
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Evidence subgraph */}
      <div style={block} data-testid="graph-evidence-subgraph">
        <h3 style={h3}>Evidence neighbourhood</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={input}
            placeholder="Evidence id"
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value)}
            aria-label="Evidence id"
          />
          <button
            type="button"
            style={primaryBtn}
            onClick={() => void loadSubgraph(evidenceId)}
          >
            Load neighbourhood
          </button>
        </div>
        {subgraph.kind === "loading" ? <p style={muted}>Loading…</p> : null}
        {subgraph.kind === "denied" ? (
          <div style={denialBox}>{subgraph.reason}</div>
        ) : null}
        {subgraph.kind === "error" ? (
          <div style={errBox}>{subgraph.message}</div>
        ) : null}
        {subgraph.kind === "ready" && subgraph.data.edges.length === 0 ? (
          <p style={muted}>
            Nothing is connected to that record yet.
          </p>
        ) : null}
        {subgraph.kind === "ready" && subgraph.data.edges.length > 0 ? (
          <ul style={listReset} data-testid="graph-edge-list">
            {subgraph.data.edges.map((e) => (
              <li
                key={e.id}
                style={row}
                data-edge-id={e.id}
                data-edge-source-kind={e.sourceKind}
                data-edge-has-provenance={e.provenance ? "true" : "false"}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{e.edgeType}</strong>{" "}
                  <span style={chip}>{e.confidence}</span>
                  <div style={muted}>
                    {e.provenance ? (
                      <>
                        Asserted by operator{" "}
                        {e.provenance.createdByUserId.slice(0, 8)}… on{" "}
                        {e.provenance.createdAtUtc.slice(0, 10)}
                        {e.provenance.safeNote
                          ? ` — “${e.provenance.safeNote}”`
                          : ""}
                      </>
                    ) : (
                      <>Derived signal — no operator assertion behind this link.</>
                    )}
                  </div>
                  {e.safeSummary ? <div style={muted}>{e.safeSummary}</div> : null}
                </span>
                {canCurate && e.provenance ? (
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={
                      busy === `retract:${e.provenance.manualRelationshipId}`
                    }
                    onClick={() => void retractRelationship(e.provenance!)}
                    data-action="retract-relationship"
                  >
                    {busy === `retract:${e.provenance.manualRelationshipId}`
                      ? "Retracting…"
                      : "Retract"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {subgraph.kind === "ready" && subgraph.data.truncated ? (
          <p style={muted}>
            The neighbourhood is larger than the display limit — narrow the
            depth or start from a more specific record.
          </p>
        ) : null}
      </div>

      {/* Relationship authoring */}
      <div style={block} data-testid="graph-relationship-create">
        <h3 style={h3}>Record a relationship</h3>
        {!canCurate ? (
          <div style={denialBox} data-testid="graph-curation-denied">
            You can read this graph but cannot assert or retract relationships.
            Recording an operator link needs evidence-management permission in
            this workspace.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                style={input}
                placeholder="Source node id"
                value={sourceNodeId}
                onChange={(e) => setSourceNodeId(e.target.value)}
                aria-label="Source node id"
              />
              <input
                style={input}
                placeholder="Target node id"
                value={targetNodeId}
                onChange={(e) => setTargetNodeId(e.target.value)}
                aria-label="Target node id"
              />
              <select
                style={input}
                value={edgeType}
                onChange={(e) =>
                  setEdgeType(
                    e.target.value as (typeof MANUAL_EDGE_TYPES)[number],
                  )
                }
                aria-label="Relationship type"
              >
                {MANUAL_EDGE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                style={{ ...input, flex: "1 1 220px" }}
                placeholder="Why are these related? (recorded with your name)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Relationship note"
              />
              <button
                type="button"
                style={primaryBtn}
                disabled={busy === "create"}
                onClick={() => void createRelationship()}
                data-action="create-relationship"
              >
                {busy === "create" ? "Recording…" : "Record link"}
              </button>
            </div>
            <p style={muted}>
              Re-recording a link that already exists keeps the original
              assertion — repeating this action never creates a duplicate.
            </p>
          </>
        )}
        {curationResult ? (
          <p
            style={
              curationResult.tone === "error"
                ? errBox
                : curationResult.tone === "info"
                  ? denialBox
                  : muted
            }
            data-testid="graph-curation-result"
            data-tone={curationResult.tone}
          >
            {curationResult.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
      <div style={muted}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#fff",
  marginTop: 20,
};
const block: React.CSSProperties = {
  borderTop: "1px solid #f1f5f9",
  paddingTop: 12,
  marginTop: 12,
};
const h3: React.CSSProperties = { fontSize: 14, margin: "0 0 8px" };
const muted: React.CSSProperties = { fontSize: 12, color: "#64748b", margin: "4px 0 0" };
const listReset: React.CSSProperties = {
  listStyle: "none",
  margin: "8px 0 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const row: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: 8,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const chip: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#f1f5f9",
  color: "#475569",
};
const input: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid #6D28D9",
  background: "#6D28D9",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 12,
  cursor: "pointer",
};
const errBox: React.CSSProperties = {
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#7f1d1d",
  borderRadius: 8,
  fontSize: 13,
  marginTop: 8,
};
const denialBox: React.CSSProperties = {
  padding: 10,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#78350f",
  borderRadius: 8,
  fontSize: 13,
  marginTop: 8,
};
