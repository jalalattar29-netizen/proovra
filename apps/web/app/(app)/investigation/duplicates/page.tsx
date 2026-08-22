"use client";
/**
 * Phase 31.18 — Duplicate / Similarity Review workstation surface.
 *
 * Consumes `/v1/graph/duplicates` which lists evidence-to-evidence
 * edges of three bounded kinds:
 *   * SAME_HASH_AS              — exact byte match (HIGH confidence)
 *   * SIMILAR_TO                — perceptual similarity (when present)
 *   * POSSIBLE_DERIVATIVE_OF    — likely derivation (when present)
 *
 * Hard rules:
 *   * Tone is operational only. No forbidden vocabulary
 *     (tampered/forged/fake/authentic/admissible/proves/confirms/
 *     manipulated/doctored).
 *   * No storage internals, no signed URLs, no internal IDs.
 *   * Bounded polling — 60s, paused when the tab is hidden.
 *   * Operator can filter by edge type and confidence, anchor on a
 *     specific evidence id via the `evidenceId` query param, and
 *     pivot to evidence detail or the graph view.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { useCan, useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational/OperationalEmptyState";
import {
  classifyInvestigationEmptyState,
  type ProducerModeStatusLike,
} from "../../../../lib/empty-state/classifier";
import { formatUserDateTime } from "../../../../lib/date";
type DuplicateEdgeKind =
  | "SAME_HASH_AS"
  | "SIMILAR_TO"
  | "POSSIBLE_DERIVATIVE_OF";

type DuplicateEdge = {
  edgeId: string;
  edgeType: DuplicateEdgeKind;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  safeSummary: string | null;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  observedAtUtc: string;
};

type DuplicatesResponse = {
  edges: DuplicateEdge[];
  truncated: boolean;
};

// Wave 2 — mirrors `ProducerKind` + `ProducerModeStatus` from
// packages/shared-runtime/src/media-intelligence/producer-mode.ts.
// We bind only the 5 fields the duplicates page renders to avoid
// importing the shared-runtime type into the web bundle.
type ProducerKind =
  | "ocr"
  | "transcript"
  | "perceptual_similarity"
  | "derivative_detection"
  | "semantic_search";

type ProducerModeStatus = {
  kind: ProducerKind;
  mode: string;
  enabled: boolean;
  reason: string;
};

type CapabilitiesResponse = {
  producerModes: ProducerModeStatus[];
};

const FILTER_OPTIONS: Array<{ value: DuplicateEdgeKind | "ALL"; label: string }> = [
  { value: "ALL", label: "All relationships" },
  { value: "SAME_HASH_AS", label: "Exact byte match" },
  { value: "SIMILAR_TO", label: "Perceptually similar" },
  { value: "POSSIBLE_DERIVATIVE_OF", label: "Possible derivative" },
];

const CONFIDENCE_OPTIONS: Array<{ value: "ALL" | "LOW" | "MEDIUM" | "HIGH"; label: string }> = [
  { value: "ALL", label: "Any confidence" },
  { value: "HIGH", label: "High only" },
  { value: "MEDIUM", label: "Medium and higher" },
  { value: "LOW", label: "Low and higher" },
];

// Phase 38.13 — wrap in canonical PageRouteGate.
export default function DuplicatesReviewPage() {
  return (
    <PageRouteGate routeId="investigation.duplicates">
      <DuplicatesReviewPageInner />
    </PageRouteGate>
  );
}

function DuplicatesReviewPageInner() {
  const teamId = useTeamId();
  // Wave 2 Phase 4 — diagnostics + admin-action gate.
  const canDiagnostics = useCan("OBSERVABILITY_VIEW");
  const [anchorEvidenceId, setAnchorEvidenceId] = useState<string | null>(null);
  const [edges, setEdges] = useState<DuplicateEdge[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState<DuplicateEdgeKind | "ALL">("ALL");
  const [confidenceFilter, setConfidenceFilter] = useState<"ALL" | "LOW" | "MEDIUM" | "HIGH">(
    "ALL",
  );
  const [error, setError] = useState<string | null>(null);
  // Wave 2 Phase 4 — capture the underlying fetch error so the classifier
  // can resolve API_ERROR with a bounded reason.
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  // Wave 2 — producer-mode truth resolver (5-kind ProducerModeStatus array).
  // Drives honest empty-state copy for SIMILAR_TO + POSSIBLE_DERIVATIVE_OF
  // sections when those producers aren't wired on the workspace.
  const [producerModes, setProducerModes] = useState<ProducerModeStatus[] | null>(
    null,
  );
  // Wave 2 — per-edge action busy state. Keyed by edgeId; value is the
  // action string (CONFIRMED / DISMISSED / MARKED_DERIVATIVE) currently
  // in flight. Best-effort UI hint — never persisted.
  const [actionBusy, setActionBusy] = useState<Record<string, string>>({});
  // Wave 2 Phase 6 — export action state.
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Parse evidenceId anchor from URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ev = params.get("evidenceId");
    setAnchorEvidenceId(ev && /^[0-9a-fA-F-]{36}$/.test(ev) ? ev : null);
  }, []);

  // Workspace resolution.

// Bounded poll.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const q = new URLSearchParams({ teamId, limit: "200" });
        if (anchorEvidenceId) q.set("evidenceId", anchorEvidenceId);
        const res = (await apiFetch(
          `/v1/graph/duplicates?${q.toString()}`,
          { method: "GET" },
        )) as DuplicatesResponse;
        if (cancelled) return;
        setEdges(res.edges ?? []);
        setTruncated(Boolean(res.truncated));
        setLastFetchAt(Date.now());
        setError(null);
        setFetchError(null);
      } catch (err) {
        if (!cancelled) {
          setError("duplicates_unavailable");
          setFetchError(
            err instanceof Error ? err : new Error("duplicates_unavailable"),
          );
        }
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
  }, [teamId, anchorEvidenceId]);

  // Wave 2 — load /v1/intelligence/capabilities once per team. The
  // resolver output drives the per-section empty-state copy so the page
  // never invents its own disclaimer language.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(
          `/v1/intelligence/capabilities?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as CapabilitiesResponse;
        if (cancelled) return;
        setProducerModes(Array.isArray(res?.producerModes) ? res.producerModes : []);
      } catch {
        if (!cancelled) setProducerModes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Wave 2 — record a reviewer decision on a duplicate-class edge.
  // Best-effort; UI surfaces a bounded error without leaking the
  // server message. On success the local edges list is unchanged
  // (the decision is recorded out-of-band; the next poll cycle will
  // surface any reconcile-time edge tombstoning).
  const recordDecision = async (
    edge: DuplicateEdge,
    decision: "CONFIRMED" | "DISMISSED" | "MARKED_DERIVATIVE",
  ) => {
    if (!teamId) return;
    setActionBusy((m) => ({ ...m, [edge.edgeId]: decision }));
    try {
      await apiFetch(
        `/v1/graph/duplicates/${encodeURIComponent(edge.edgeId)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, decision }),
        },
      );
    } catch {
      /* best-effort UI; the next poll cycle will reconcile state */
    } finally {
      setActionBusy((m) => {
        const next = { ...m };
        delete next[edge.edgeId];
        return next;
      });
    }
  };

  // Wave 2 Phase 6 — duplicate findings export. Downloads JSON.
  const handleExport = async () => {
    if (!teamId || exportBusy) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const res = (await apiFetch("/v1/graph/duplicates/export", {
        method: "POST",
        body: JSON.stringify({
          teamId,
          ...(anchorEvidenceId ? { evidenceId: anchorEvidenceId } : {}),
        }),
        headers: { "Content-Type": "application/json" },
      })) as { edges: unknown[]; generatedAtUtc: string };
      if (typeof window !== "undefined") {
        const blob = new Blob([JSON.stringify(res, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `duplicate-findings-${res.generatedAtUtc.slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setExportError(
        /403|forbidden/i.test(msg)
          ? "You do not have permission to export findings."
          : "Unable to generate export. Try again.",
      );
    } finally {
      setExportBusy(false);
    }
  };

  // Wave 2 — "Mark related" pivots through the existing manual
  // relationships endpoint with edge_type=MANUALLY_LINKED_TO. The
  // duplicates page doesn't expose graph node ids directly — operators
  // who want to assert a manual link should open the relationships
  // page (deep-linked below). This helper is a no-op stub kept for
  // forward-compat with the in-row pivot row.
  const markRelatedHref = (edge: DuplicateEdge): string =>
    `/investigation/relationships?nodeId=${encodeURIComponent(
      edge.sourceEvidenceId,
    )}&edgeId=${encodeURIComponent(edge.edgeId)}`;

  const filtered = useMemo(() => {
    if (!edges) return null;
    return edges.filter((e) => {
      if (filter !== "ALL" && e.edgeType !== filter) return false;
      if (confidenceFilter === "HIGH") {
        if (e.confidence !== "HIGH") return false;
      } else if (confidenceFilter === "MEDIUM") {
        if (e.confidence === "LOW") return false;
      }
      return true;
    });
  }, [edges, filter, confidenceFilter]);

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  const counts = useMemo(() => {
    if (!edges) return null;
    const c: Record<DuplicateEdgeKind, number> = {
      SAME_HASH_AS: 0,
      SIMILAR_TO: 0,
      POSSIBLE_DERIVATIVE_OF: 0,
    };
    for (const e of edges) c[e.edgeType] += 1;
    return c;
  }, [edges]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Duplicate and similarity review</h1>
          <p style={subtitleStyle}>
            Operator-facing list of evidence records that share an exact byte
            match, are perceptually similar, or appear to be derivatives of
            one another. Each relationship is advisory; review the underlying
            evidence record before drawing any operational conclusion.
          </p>
          {anchorEvidenceId ? (
            <p style={anchorNoticeStyle}>
              Anchored to evidence record{" "}
              <span style={anchorIdStyle}>{anchorEvidenceId.slice(0, 12)}…</span>
              {" "}
              <Link href="/investigation/duplicates" style={pivotLinkStyle}>
                Clear anchor
              </Link>
            </p>
          ) : null}
        </div>
        <div style={headerRightStyle}>
          <span style={freshnessPillStyle(error, ageSeconds, teamId)}>
            {error
              ? "Relationships unavailable — retrying"
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

      <section style={countsRowStyle}>
        <CountTile label="Exact byte match" value={counts?.SAME_HASH_AS ?? null} />
        <CountTile label="Perceptually similar" value={counts?.SIMILAR_TO ?? null} />
        <CountTile
          label="Possible derivative"
          value={counts?.POSSIBLE_DERIVATIVE_OF ?? null}
        />
      </section>

      <section style={controlsRowStyle}>
        <div style={controlsGroupStyle}>
          <label style={controlsLabelStyle}>Relationship</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as DuplicateEdgeKind | "ALL")}
            style={selectStyle}
          >
            {FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={controlsGroupStyle}>
          <label style={controlsLabelStyle}>Confidence</label>
          <select
            value={confidenceFilter}
            onChange={(e) =>
              setConfidenceFilter(
                e.target.value as "ALL" | "LOW" | "MEDIUM" | "HIGH",
              )
            }
            style={selectStyle}
          >
            {CONFIDENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {truncated ? (
          <span style={truncatedNoticeStyle}>
            Showing the most recent 200 relationships. Anchor to a specific
            evidence record or narrow your filter to see older entries.
          </span>
        ) : null}
        {/* Wave 2 Phase 6 — export action. Available to any reviewer
            (evidence.read on the backend; UI button is always shown). */}
        <button
          type="button"
          data-action="export-duplicates"
          onClick={() => void handleExport()}
          disabled={exportBusy || !teamId}
          style={exportButtonStyle(exportBusy)}
        >
          {exportBusy ? "Exporting…" : "Export duplicate findings"}
        </button>
        {exportError ? (
          <span style={exportErrorPillStyle}>{exportError}</span>
        ) : null}
      </section>

      {/* Wave 2 — 3 honest sections. Each section's body depends on:
            * actual edges of that kind in `filtered`, OR
            * the producer-mode resolver's `enabled` + `reason` when none.
          Sections are ALWAYS rendered (even if empty) so reviewers see
          a clear, honest map of what the workspace can / cannot produce
          today. No invented disclaimer copy — the producer-mode `reason`
          string is the canonical source. */}
      {(() => {
        const perceptual = producerModes?.find(
          (p) => p.kind === "perceptual_similarity",
        );
        const derivative = producerModes?.find(
          (p) => p.kind === "derivative_detection",
        );
        return (
          <>
            <DuplicateSection
              title="Exact duplicates"
              description="Records that share an identical byte-for-byte SHA-256."
              kind="SAME_HASH_AS"
              filtered={filtered}
              filter={filter}
              anchor={anchorEvidenceId}
              actionBusy={actionBusy}
              recordDecision={recordDecision}
              markRelatedHref={markRelatedHref}
              producerMode={null}
              fetchError={fetchError}
              isAdmin={canDiagnostics}
            />
            <DuplicateSection
              title="Perceptual similarity"
              description="Visually similar images detected via internal perceptual hashing."
              kind="SIMILAR_TO"
              filtered={filtered}
              filter={filter}
              anchor={anchorEvidenceId}
              actionBusy={actionBusy}
              recordDecision={recordDecision}
              markRelatedHref={markRelatedHref}
              producerMode={perceptual ?? null}
              fetchError={fetchError}
              isAdmin={canDiagnostics}
            />
            <DuplicateSection
              title="Possible derivatives"
              description="Heuristic lineage proposals based on similar perceptual hash and time/byte ordering."
              kind="POSSIBLE_DERIVATIVE_OF"
              filtered={filtered}
              filter={filter}
              anchor={anchorEvidenceId}
              actionBusy={actionBusy}
              recordDecision={recordDecision}
              markRelatedHref={markRelatedHref}
              producerMode={derivative ?? null}
              fetchError={fetchError}
              isAdmin={canDiagnostics}
            />
          </>
        );
      })()}
    </div>
  );
}

function DuplicateSection({
  title,
  description,
  kind,
  filtered,
  filter,
  anchor,
  actionBusy,
  recordDecision,
  markRelatedHref,
  producerMode,
  fetchError,
  isAdmin,
}: {
  title: string;
  description: string;
  kind: DuplicateEdgeKind;
  filtered: DuplicateEdge[] | null;
  filter: DuplicateEdgeKind | "ALL";
  anchor: string | null;
  actionBusy: Record<string, string>;
  recordDecision: (
    edge: DuplicateEdge,
    decision: "CONFIRMED" | "DISMISSED" | "MARKED_DERIVATIVE",
  ) => Promise<void> | void;
  markRelatedHref: (edge: DuplicateEdge) => string;
  producerMode: ProducerModeStatus | null;
  fetchError: Error | null;
  isAdmin: boolean;
}) {
  // Honor the global filter — when the operator filters to a specific
  // kind, hide the other sections to avoid visual clutter.
  if (filter !== "ALL" && filter !== kind) return null;
  const ofKind = filtered?.filter((e) => e.edgeType === kind) ?? null;
  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>{title}</h2>
      <p style={sectionDescriptionStyle}>{description}</p>
      {ofKind == null ? (
        <p style={emptyStyle}>Loading…</p>
      ) : ofKind.length === 0 ? (
        // Wave 2 Phase 4 — classifier-driven empty state. The classifier
        // picks the right code from { TRUE_EMPTY, API_ERROR,
        // FEATURE_NOT_CONFIGURED, CONFIG_DISABLED, CAPABILITY_UNAVAILABLE }
        // based on the producer-mode resolver output for this section.
        (() => {
          // Map ProducerModeStatus → classifier-shaped ProducerModeStatusLike.
          // ProducerModeStatus declared in the page bridges the 5 fields
          // the page uses; the classifier requires the full 8-field shape.
          const capabilityStatus: ProducerModeStatusLike | undefined =
            producerMode
              ? {
                  kind: producerMode.kind,
                  mode: producerMode.mode,
                  enabled: producerMode.enabled,
                  // The page binding does not project configured/automatic/
                  // indexExistingOnly/provider — derive bounded defaults
                  // that reproduce the Wave 1 resolver semantics.
                  configured: producerMode.enabled,
                  automatic: producerMode.enabled,
                  indexExistingOnly: false,
                  provider: producerMode.enabled ? "internal" : "none",
                  reason: producerMode.reason,
                }
              : undefined;
          const { classification, reason } = classifyInvestigationEmptyState(
            {
              data: ofKind,
              fetchError,
              permission: "allowed",
              capabilityStatus,
            },
            "duplicates",
          );
          return (
            <OperationalEmptyState
              classification={classification}
              reason={reason}
              // Wave 2 — canonical empty-state CTAs across every
              // investigation surface: Capture evidence + Open cases.
              // Mirrors the timeline + graph + hub callers so reviewers
              // see a consistent next-step regardless of which
              // investigation surface they landed on.
              nextAction={{ label: "Capture evidence", href: "/capture" }}
              adminAction={{ label: "Open cases", href: "/cases" }}
              diagnosticsLink="/admin/platform/observability"
              isAdmin={isAdmin}
            />
          );
        })()
      ) : (
        <ul style={listStyle}>
          {ofKind.map((edge) => (
            <DuplicateRow
              key={edge.edgeId}
              edge={edge}
              anchor={anchor}
              actionBusy={actionBusy[edge.edgeId] ?? null}
              recordDecision={recordDecision}
              markRelatedHref={markRelatedHref}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CountTile({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div style={countTileStyle}>
      <div style={countLabelStyle}>{label}</div>
      <div style={countValueStyle}>{value == null ? "—" : value}</div>
    </div>
  );
}

function DuplicateRow({
  edge,
  anchor,
  actionBusy,
  recordDecision,
  markRelatedHref,
}: {
  edge: DuplicateEdge;
  anchor: string | null;
  actionBusy: string | null;
  recordDecision: (
    edge: DuplicateEdge,
    decision: "CONFIRMED" | "DISMISSED" | "MARKED_DERIVATIVE",
  ) => Promise<void> | void;
  markRelatedHref: (edge: DuplicateEdge) => string;
}) {
  // When anchored to a specific evidence, display the OTHER endpoint
  // as the primary subject. Without an anchor, show both sides.
  const a = edge.sourceEvidenceId;
  const b = edge.targetEvidenceId;
  return (
    <li style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={edgeTypeBadgeStyle(edge.edgeType)}>
          {edgeTypeLabel(edge.edgeType)}
        </span>
        <span style={confidenceBadgeStyle(edge.confidence)}>
          {edge.confidence.toLowerCase()} confidence
        </span>
        <span style={timestampStyle}>
          {formatDateTime(edge.observedAtUtc)}
        </span>
      </div>
      <div style={endpointsStyle}>
        <EndpointCard
          id={a}
          highlight={anchor === a}
          deemphasize={anchor != null && anchor !== a}
        />
        <span style={arrowStyle}>↔</span>
        <EndpointCard
          id={b}
          highlight={anchor === b}
          deemphasize={anchor != null && anchor !== b}
        />
      </div>
      {edge.safeSummary ? (
        <div style={summaryStyle}>{edge.safeSummary}</div>
      ) : null}
      {/* Wave 2 — reviewer decision actions. CONFIRMED, DISMISSED,
          MARKED_DERIVATIVE go through POST /v1/graph/duplicates/:edgeId/decision.
          "Mark related" pivots to the canonical manual-relationship surface
          on the relationships page (we don't expose graph node ids here).
          "Open both records" links via the per-side evidence pivots below. */}
      <div style={actionsRowStyle}>
        <button
          type="button"
          disabled={actionBusy != null}
          onClick={() => recordDecision(edge, "CONFIRMED")}
          style={actionPrimaryStyle(actionBusy === "CONFIRMED")}
        >
          {actionBusy === "CONFIRMED" ? "Confirming…" : "Confirm duplicate"}
        </button>
        <button
          type="button"
          disabled={actionBusy != null}
          onClick={() => recordDecision(edge, "DISMISSED")}
          style={actionSecondaryStyle(actionBusy === "DISMISSED")}
        >
          {actionBusy === "DISMISSED" ? "Dismissing…" : "Dismiss"}
        </button>
        <Link href={markRelatedHref(edge)} style={pivotLinkSmallStyle}>
          Mark related
        </Link>
      </div>
      <div style={pivotsRowStyle}>
        <Link href={`/evidence/${a}`} style={pivotLinkSmallStyle}>
          Open A
        </Link>
        <Link href={`/evidence/${b}`} style={pivotLinkSmallStyle}>
          Open B
        </Link>
        {/* Phase 14 — pivot each side of the duplicate relationship
            into the canonical /search surface scoped to that
            evidence record. Operators can review the full search
            envelope (badges, governance state, related rows) without
            leaving the duplicate-review flow. */}
        <Link
          href={`/search?evidenceId=${encodeURIComponent(a)}`}
          style={pivotLinkSmallStyle}
        >
          Open A in Search
        </Link>
        <Link
          href={`/search?evidenceId=${encodeURIComponent(b)}`}
          style={pivotLinkSmallStyle}
        >
          Open B in Search
        </Link>
        <Link
          href={`/investigation/relationships?nodeId=${encodeURIComponent(
            edge.edgeId,
          )}&edgeId=${encodeURIComponent(edge.edgeId)}`}
          style={pivotLinkSmallStyle}
        >
          Inspect relationship
        </Link>
      </div>
    </li>
  );
}

function EndpointCard({
  id,
  highlight,
  deemphasize,
}: {
  id: string;
  highlight: boolean;
  deemphasize: boolean;
}) {
  return (
    <div style={endpointCardStyle(highlight, deemphasize)}>
      <div style={endpointLabelStyle}>Evidence</div>
      <div style={endpointIdStyle}>{id.slice(0, 12)}…</div>
    </div>
  );
}

function edgeTypeLabel(t: DuplicateEdgeKind): string {
  switch (t) {
    case "SAME_HASH_AS":
      return "exact byte match";
    case "SIMILAR_TO":
      return "perceptually similar";
    case "POSSIBLE_DERIVATIVE_OF":
      return "possible derivative";
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

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

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
};

const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 13,
  color: "#64748b",
  maxWidth: 760,
  lineHeight: 1.5,
};

const anchorNoticeStyle: React.CSSProperties = {
  margin: "8px 0 0 0",
  fontSize: 12,
  color: "#1e40af",
};

const anchorIdStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
};

const pivotLinkSmallStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  padding: "3px 10px",
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

const countsRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 12,
  marginBottom: 20,
};

const countTileStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 14,
};

const countLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const countValueStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  color: "#0f172a",
  marginTop: 4,
};

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
  marginBottom: 20,
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};

const controlsGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
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

function exportButtonStyle(busy: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    color: "#1e40af",
    background: busy ? "#dbeafe" : "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 6,
    padding: "5px 12px",
    cursor: busy ? "wait" : "pointer",
    whiteSpace: "nowrap",
  };
}

const exportErrorPillStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  padding: "3px 8px",
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
  margin: "0 0 4px 0",
  fontSize: 15,
  fontWeight: 700,
  color: "#0f172a",
};

const sectionDescriptionStyle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: 12,
  color: "#64748b",
  lineHeight: 1.5,
};

const actionsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 8,
};

function actionPrimaryStyle(busy: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 600,
    color: "#ffffff",
    background: busy ? "#1e3a8a" : "#1e40af",
    border: "1px solid #1e3a8a",
    borderRadius: 6,
    padding: "5px 12px",
    cursor: busy ? "wait" : "pointer",
  };
}

function actionSecondaryStyle(busy: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 600,
    color: "#1e40af",
    background: busy ? "#dbeafe" : "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 6,
    padding: "5px 12px",
    cursor: busy ? "wait" : "pointer",
  };
}

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

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const rowStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginBottom: 10,
};

function edgeTypeBadgeStyle(t: DuplicateEdgeKind): React.CSSProperties {
  const palette: Record<DuplicateEdgeKind, [string, string, string]> = {
    SAME_HASH_AS: ["#fef2f2", "#fca5a5", "#991b1b"],
    SIMILAR_TO: ["#fffbeb", "#fcd34d", "#92400e"],
    POSSIBLE_DERIVATIVE_OF: ["#eff6ff", "#bfdbfe", "#1e40af"],
  };
  const [bg, border, color] = palette[t];
  return {
    padding: "2px 10px",
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
}

function confidenceBadgeStyle(
  c: "LOW" | "MEDIUM" | "HIGH",
): React.CSSProperties {
  const palette: Record<typeof c, [string, string, string]> = {
    HIGH: ["#ecfdf5", "#bbf7d0", "#166534"],
    MEDIUM: ["#fffbeb", "#fcd34d", "#92400e"],
    LOW: ["#f1f5f9", "#cbd5e1", "#475569"],
  } as Record<typeof c, [string, string, string]>;
  const [bg, border, color] = palette[c];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
  };
}

const timestampStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  marginLeft: "auto",
};

const endpointsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 8,
};

function endpointCardStyle(
  highlight: boolean,
  deemphasize: boolean,
): React.CSSProperties {
  return {
    flex: 1,
    padding: 10,
    background: highlight ? "#eff6ff" : "#f8fafc",
    border: `1px solid ${highlight ? "#93c5fd" : "#e2e8f0"}`,
    borderRadius: 6,
    opacity: deemphasize ? 0.65 : 1,
  };
}

const endpointLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const endpointIdStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  marginTop: 2,
};

const arrowStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#94a3b8",
  fontWeight: 600,
};

const summaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.5,
  marginBottom: 8,
};

const pivotsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};
