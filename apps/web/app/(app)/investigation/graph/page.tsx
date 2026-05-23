"use client";

/**
 * Phase 31.18 — Graph Navigation Explorer (workspace-wide).
 *
 * The case-graph page (`/investigation/cases/[caseId]/graph`) is
 * scoped to one case. This page is the workspace-wide entry point —
 * lists recent seed nodes operators can open a graph view from.
 *
 * Consumes `/v1/graph/seeds` which returns up to 25 nodes per kind
 * across CASE, INCIDENT, REPORT, and EVIDENCE.
 *
 * Hard rules:
 *   * Tone is operational only. No forbidden vocabulary
 *     (tampered/forged/fake/authentic/admissible/proves/confirms/
 *     manipulated/doctored).
 *   * No storage internals, no signed URLs, no internal IDs leaking.
 *   * Bounded polling — 60s, paused when the tab is hidden.
 *   * Each seed pivots to the appropriate downstream surface (case
 *     graph for CASE, evidence detail for EVIDENCE, etc.).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
type GraphSeedKind = "CASE" | "INCIDENT" | "REPORT" | "EVIDENCE";

type GraphSeed = {
  id: string;
  nodeKind: GraphSeedKind;
  externalId: string;
  safeLabel: string | null;
  updatedAtUtc: string;
};

type SeedsResponse = {
  nodes: GraphSeed[];
};

const SEED_KIND_LABELS: Record<GraphSeedKind, string> = {
  CASE: "Cases",
  INCIDENT: "Incidents",
  REPORT: "Reports",
  EVIDENCE: "Recent evidence",
};

const FILTER_OPTIONS: Array<{ value: GraphSeedKind | "ALL"; label: string }> = [
  { value: "ALL", label: "All seeds" },
  { value: "CASE", label: "Cases only" },
  { value: "INCIDENT", label: "Incidents only" },
  { value: "REPORT", label: "Reports only" },
  { value: "EVIDENCE", label: "Evidence only" },
];

// Phase 38.13 — wrap in canonical PageRouteGate.
export default function GraphExplorerPage() {
  return (
    <PageRouteGate routeId="investigation.graph">
      <GraphExplorerPageInner />
    </PageRouteGate>
  );
}

function GraphExplorerPageInner() {
  const teamId = useTeamId();
  const [seeds, setSeeds] = useState<GraphSeed[] | null>(null);
  const [filter, setFilter] = useState<GraphSeedKind | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);

  
useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = (await apiFetch(
          `/v1/graph/seeds?teamId=${encodeURIComponent(teamId)}&perKindLimit=25`,
          { method: "GET" },
        )) as SeedsResponse;
        if (cancelled) return;
        setSeeds(res.nodes ?? []);
        setLastFetchAt(Date.now());
        setError(null);
      } catch {
        if (!cancelled) setError("graph_seeds_unavailable");
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
  }, [teamId]);

  const grouped = useMemo(() => {
    if (!seeds) return null;
    const buckets: Record<GraphSeedKind, GraphSeed[]> = {
      CASE: [],
      INCIDENT: [],
      REPORT: [],
      EVIDENCE: [],
    };
    for (const s of seeds) {
      if (filter !== "ALL" && s.nodeKind !== filter) continue;
      if (buckets[s.nodeKind]) {
        buckets[s.nodeKind].push(s);
      }
    }
    return buckets;
  }, [seeds, filter]);

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  const kindOrder: GraphSeedKind[] = ["CASE", "INCIDENT", "REPORT", "EVIDENCE"];

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Investigation graph explorer</h1>
          <p style={subtitleStyle}>
            Workspace-wide entry point for the investigation graph. Each row
            is a graph seed — open one to inspect its connected evidence,
            review tasks, escalations, exports, reports, and verification
            packages.
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
        <label style={controlsLabelStyle}>Seed kind</label>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as GraphSeedKind | "ALL")}
          style={selectStyle}
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Link
          href="/investigation/duplicates"
          style={pivotLinkSecondaryStyle}
        >
          → Duplicate review
        </Link>
        <Link href="/investigation/timeline" style={pivotLinkSecondaryStyle}>
          → Timeline
        </Link>
        <Link href="/investigation/reviewers" style={pivotLinkSecondaryStyle}>
          → Reviewers
        </Link>
      </section>

      {grouped == null ? (
        <p style={emptyStyle}>Loading…</p>
      ) : (
        <div style={sectionsStyle}>
          {kindOrder.map((kind) => {
            const bucket = grouped[kind];
            if (filter !== "ALL" && kind !== filter) return null;
            return (
              <SeedSection
                key={kind}
                kind={kind}
                title={SEED_KIND_LABELS[kind]}
                seeds={bucket}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SeedSection({
  kind,
  title,
  seeds,
}: {
  kind: GraphSeedKind;
  title: string;
  seeds: GraphSeed[];
}) {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
        <span style={sectionCountStyle}>
          {seeds.length} {seeds.length === 1 ? "seed" : "seeds"}
        </span>
      </div>
      {seeds.length === 0 ? (
        <p style={sectionEmptyStyle}>
          No {kind.toLowerCase()} seeds in this workspace yet.
        </p>
      ) : (
        <ul style={listStyle}>
          {seeds.map((s) => (
            <SeedRow key={s.id} seed={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SeedRow({ seed }: { seed: GraphSeed }) {
  const href = pivotHref(seed);
  return (
    <li style={rowStyle}>
      <div style={rowMainStyle}>
        <div style={kindBadgeStyle(seed.nodeKind)}>{seed.nodeKind.toLowerCase()}</div>
        <div style={rowBodyStyle}>
          <div style={labelStyle}>
            {seed.safeLabel ?? `${seed.nodeKind.toLowerCase()} ${seed.externalId.slice(0, 8)}…`}
          </div>
          <div style={mutedRowStyle}>
            updated {formatDateTime(seed.updatedAtUtc)} · id{" "}
            <span style={monoStyle}>{seed.externalId.slice(0, 12)}…</span>
          </div>
        </div>
      </div>
      <Link href={href} style={pivotLinkSmallStyle}>
        Open
      </Link>
    </li>
  );
}

function pivotHref(seed: GraphSeed): string {
  switch (seed.nodeKind) {
    case "CASE":
      return `/investigation/cases/${seed.externalId}/graph`;
    case "EVIDENCE":
      return `/evidence/${seed.externalId}`;
    case "INCIDENT":
      return `/investigation/relationships?nodeId=${encodeURIComponent(seed.id)}`;
    case "REPORT":
      return `/investigation/relationships?nodeId=${encodeURIComponent(seed.id)}`;
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
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

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
};

const pivotLinkSecondaryStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 999,
  padding: "3px 10px",
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
  whiteSpace: "nowrap",
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
  gap: 12,
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

const sectionsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const sectionStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  overflow: "hidden",
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: "#0f172a",
};

const sectionCountStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontWeight: 500,
};

const sectionEmptyStyle: React.CSSProperties = {
  margin: 0,
  padding: 14,
  fontSize: 12,
  color: "#64748b",
  fontStyle: "italic",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderBottom: "1px solid #f1f5f9",
};

const rowMainStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
  flex: 1,
};

const rowBodyStyle: React.CSSProperties = {
  minWidth: 0,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const mutedRowStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  marginTop: 2,
};

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function kindBadgeStyle(k: GraphSeedKind): React.CSSProperties {
  const palette: Record<GraphSeedKind, [string, string, string]> = {
    CASE: ["#eff6ff", "#bfdbfe", "#1e40af"],
    INCIDENT: ["#fef2f2", "#fca5a5", "#991b1b"],
    REPORT: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
    EVIDENCE: ["#ecfdf5", "#bbf7d0", "#166534"],
  };
  const [bg, border, color] = palette[k];
  return {
    padding: "3px 9px",
    fontSize: 10,
    fontWeight: 700,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  };
}
