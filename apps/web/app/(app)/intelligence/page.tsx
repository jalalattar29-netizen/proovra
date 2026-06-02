"use client";

/**
 * Phase 15 — Intelligence operations console.
 *
 * Reviewer-and-above visibility into:
 *   - keyword search across title / filename / OCR / transcript /
 *     extracted entity values (governance-scoped)
 *   - extraction job queue (OCR / transcript / entity / similarity)
 *   - active provider configuration
 *   - semantic search availability
 *
 * Wording: every result region is operational. We NEVER claim
 * "authentic", "verified", "fake", "manipulated", or legal status.
 * The mandatory advisory disclaimer is rendered alongside every
 * AI-touched section.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { statusBadgeStyle } from "../../../components/ui/StatusBadge";
// Phase 14 — SearchHit type removed; the inline keyword-search
// projection on this page has been retired in favor of a deep link
// into the canonical /search surface. Search-result rendering and
// governance gates are owned by /v1/search + apps/web/app/(app)/search.

type Job = {
  id: string;
  evidenceId: string;
  kind: string;
  status: string;
  provider: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
};

type Catalogs = {
  jobKinds: string[];
  jobStatuses: string[];
  disclaimer: string;
};

type Providers = {
  ocr: string;
  transcript: string;
  semanticEnabled: boolean;
};

// Phase 38.12 — wrap in canonical PageRouteGate.
export default function IntelligencePage() {
  return (
    <PageRouteGate routeId="workspace.intelligence">
      <IntelligencePageInner />
    </PageRouteGate>
  );
}

function IntelligencePageInner() {
  const teamId = useTeamId();
  // Phase 14 — Search functionality on this surface is consolidated
  // into the canonical /search page (Global Intelligence Search
  // Engine). The local /v1/intelligence/search affordance is replaced
  // with a deep link that pre-fills the operator query. The keyword
  // index, governance gates, saved views, and inspector all live on
  // the canonical surface.
  const [q, setQ] = useState("");

  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [catalogs, _setCatalogs] = useState<Catalogs | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("");


useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (jobStatusFilter) qs.set("status", jobStatusFilter);
    qs.set("limit", "100");
    apiFetch(`/v1/intelligence/jobs?${qs.toString()}`, { method: "GET" })
      .then(
        (res: { jobs: Job[]; providers: Providers }) => {
          if (cancelled) return;
          setJobs(res.jobs ?? []);
          setProviders(res.providers);
        },
      )
      .catch(() => setJobs([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, jobStatusFilter]);

  const trimmedQ = q.trim();
  const canSearch = trimmedQ.length >= 2;
  const searchHref = canSearch
    ? `/search?q=${encodeURIComponent(trimmedQ)}`
    : "/search";

  const jobsCounts = useMemo(() => {
    if (!jobs) return null;
    return jobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});
  }, [jobs]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Intelligence operations</h1>
        <p style={mutedStyle}>
          Operator workspace for OCR, transcript, entity, similarity,
          and search signals. Everything below is{" "}
          <strong>advisory only</strong> — these signals do not assert
          authenticity, manipulation, or legal admissibility.
        </p>
      </header>

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use intelligence.</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Providers</h2>
            {providers === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : (
              <div style={mutedStyle}>
                OCR: <strong>{providers.ocr}</strong> · Transcript:{" "}
                <strong>{providers.transcript}</strong> · Semantic search:{" "}
                <strong>
                  {providers.semanticEnabled ? "enabled" : "disabled"}
                </strong>
                . When a provider shows <code>noop</code>, no real engine
                is wired and extraction jobs will be recorded as SKIPPED
                with <code>no_provider_configured</code>.
              </div>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Search</h2>
            <p style={mutedStyle}>
              Workspace search is consolidated on the canonical Search
              surface. Enter a query and continue to /search — the
              global engine runs keyword matching across titles,
              filenames, OCR text, transcript text, and extracted
              entity values, with saved views, governance filters, and
              the relationship inspector.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                placeholder="Search this workspace…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <Link
                href={searchHref}
                style={{
                  ...primaryButtonStyle,
                  display: "inline-flex",
                  alignItems: "center",
                  textDecoration: "none",
                  pointerEvents: canSearch ? "auto" : "none",
                  opacity: canSearch ? 1 : 0.6,
                }}
                aria-disabled={!canSearch}
              >
                Open in Search
              </Link>
            </div>
            <p style={{ ...mutedStyle, marginTop: 12 }}>
              Semantic search is not enabled in this deployment.
            </p>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Extraction jobs</h2>
              <select
                value={jobStatusFilter}
                onChange={(e) => setJobStatusFilter(e.target.value)}
                style={selectStyle}
              >
                <option value="">All statuses</option>
                {catalogs?.jobStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                    {jobsCounts?.[s] !== undefined ? ` (${jobsCounts[s]})` : ""}
                  </option>
                ))}
              </select>
            </div>
            {jobs === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : jobs.length === 0 ? (
              <p style={mutedStyle}>No jobs yet.</p>
            ) : (
              <ul style={listStyle}>
                {jobs.map((j) => (
                  <li key={j.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link
                        href={`/evidence/${j.evidenceId}`}
                        style={{ fontWeight: 600, color: "#0f172a" }}
                      >
                        Evidence {j.evidenceId.slice(0, 8)}…
                      </Link>
                      <div style={mutedStyle}>
                        kind {j.kind} · attempts {j.attemptCount}
                        {j.provider ? ` · provider ${j.provider}` : ""}
                        {j.lastError ? ` · ${j.lastError}` : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(j.status)}>{j.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {catalogs ? (
            <p style={{ ...mutedStyle, marginTop: 16 }}>
              <em>{catalogs.disclaimer}</em>
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  marginTop: 12,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0",
};
const _badgeRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap",
};
const _errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
};
const selectStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};

const _hitBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
};

// Phase Final-Closure — local statusBadgeStyle removed; canonical
// version lives in components/ui/StatusBadge.tsx.
