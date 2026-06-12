"use client";

/**
 * Phase 24 — Enterprise Evidence Discovery console.
 *
 * Three-column operator surface:
 *   left   — filter rail (document types, evidence types, workflow / review
 *            states, lifecycle flags, date range, sort) + saved views.
 *   center — dense result list with cursor pagination; selecting a row
 *            opens the inspector.
 *   right  — inspector panel for the selected row (pointers, badges,
 *            related evidence, save-as-view affordance).
 *
 * Wording invariant: operator-safe phrases only. The badge labels are
 * sourced from the shared catalog; we never compose freeform legal /
 * forensic claims in the UI. Search query strings are never echoed back
 * verbatim outside the input box.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import {
  useActiveSpace,
  usePersonaProfile,
  usePlatformContext,
  useTerminology,
  useWorkspaceId,
  workflowFromPersona,
} from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ContextualHelp } from "../../../components/contextual-help/ContextualHelp";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
// Phase IA-self-serve-simplification — gate the admin-only "Enable
// semantic search" deep link on /integrations eligibility. Self-serve
// admins still have isAdmin=true, but /integrations is ENTERPRISE_ONLY
// for their tier — they must not see the link.
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
// -----------------------------------------------------------------------------
// Wire-level types — kept loose so we don't drag the API SDK in here.
// -----------------------------------------------------------------------------

type DocumentType =
  | "EVIDENCE"
  | "WORKFLOW"
  | "WORKFLOW_STEP"
  | "REVIEW_EVENT"
  | "AUDIT_EVENT"
  | "COMMUNICATION"
  | "CASE_TIMELINE"
  | "INCIDENT";

type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type SortMode =
  | "UPDATED_DESC"
  | "UPDATED_ASC"
  | "CREATED_DESC"
  | "CREATED_ASC"
  | "RELEVANCE_DESC";

type SavedViewVisibility = "PRIVATE" | "TEAM";

// Phase 15 — additive search modes. Default behaviour remains keyword.
// "hybrid" blends keyword + semantic ranking; "semantic" is pure embedding.
type SearchMode = "keyword" | "hybrid" | "semantic";

type ResultRow = {
  documentId: string;
  documentType: DocumentType;
  title: string;
  subtitle: string | null;
  summary: string | null;
  evidenceId: string | null;
  workflowInstanceId: string | null;
  workflowStepInstanceId: string | null;
  caseId: string | null;
  reviewState: string | null;
  workflowState: string | null;
  exportState: string | null;
  retentionState: string | null;
  legalHoldState: string | null;
  contributorScoped: boolean;
  reviewerRestricted: boolean;
  badges: ReadonlyArray<string>;
  updatedAtUtc: string;
  // Phase 15 — optional ranking signals. Backend may omit on legacy
  // responses; UI degrades gracefully when absent.
  score?: number | null;
  semanticScore?: number | null;
  matchReasons?: ReadonlyArray<string>;
};

type SearchResponse = {
  rows: ResultRow[];
  nextCursor: string | null;
  totalReturned: number;
  filteredByGovernance: number;
  filteredByVisibility: number;
  // Phase 15 — optional semantic-runtime envelope. Older API builds
  // omit these and the page treats semantic as unavailable.
  modeUsed?: SearchMode;
  semanticAvailable?: boolean;
  fallbackReason?: string | null;
};

// Phase 16 — semantic status envelope returned by
// GET /v1/search/semantic/status. The endpoint is a thin projection
// over the workspace-scoped embedding provider gate + the most recent
// fallback reason recorded by the search service. Pre-Phase-16
// deployments do not expose this endpoint; the page treats a missing
// envelope as "semantic disabled" and never throws.
type SemanticStatusResponse = {
  enabled: boolean;
  semanticAvailable: boolean;
  fallbackReason: string | null;
};

// Phase 16 — admin backfill dry-run envelope returned by
// POST /v1/search/semantic/backfill { dryRun: true }. The shape is
// intentionally narrow: a count of chunks that would be embedded and
// the workspace span. We never echo raw chunk text in the result.
type SemanticBackfillResponse = {
  dryRun: boolean;
  chunksToEmbed: number;
  workspaceCount: number;
  // Optional usage telemetry the backend may attach so admins can see
  // how close they are to the per-day cap / monthly budget without
  // running a separate query. All numbers are bounded primitives.
  perDayChunksUsed?: number | null;
  perDayChunksCap?: number | null;
  monthToDateEur?: number | null;
  monthlyBudgetEur?: number | null;
};

type SavedView = {
  id: string;
  name: string;
  description: string | null;
  visibility: SavedViewVisibility;
  pinned: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  query: FilterState;
};

type Relationship = {
  relationshipId: string;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  relationshipType: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

// -----------------------------------------------------------------------------
// Filter state — mirrors the SearchFilterSchema on the wire.
// -----------------------------------------------------------------------------

type FilterState = {
  teamId: string;
  q?: string;
  documentTypes?: DocumentType[];
  evidenceTypes?: EvidenceType[];
  workflowStatuses?: string[];
  reviewStatuses?: string[];
  onLegalHold?: boolean;
  exportRestricted?: boolean;
  incidentLinked?: boolean;
  workflowLinked?: boolean;
  contributorScoped?: boolean;
  updatedSinceUtc?: string;
  updatedUntilUtc?: string;
  sort?: SortMode;
  cursor?: string;
  limit?: number;
  // Phase 15 — optional search mode. Saved views written before Phase 15
  // omit this field; the page derives a default at runtime so pre-Phase-15
  // saved views still apply cleanly with keyword behaviour intact.
  mode?: SearchMode;
};

const DOCUMENT_TYPES: DocumentType[] = [
  "EVIDENCE",
  "WORKFLOW",
  "WORKFLOW_STEP",
  "REVIEW_EVENT",
  "AUDIT_EVENT",
  "COMMUNICATION",
  "CASE_TIMELINE",
  "INCIDENT",
];

const EVIDENCE_TYPES: EvidenceType[] = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];

const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "UPDATED_DESC", label: "Most recent first" },
  { value: "UPDATED_ASC", label: "Oldest first" },
  { value: "CREATED_DESC", label: "Newest by creation" },
  { value: "CREATED_ASC", label: "Earliest by creation" },
  { value: "RELEVANCE_DESC", label: "Relevance" },
];

const DEFAULT_LIMIT = 25;

// -----------------------------------------------------------------------------
// Page component
// -----------------------------------------------------------------------------

// Phase 38.7 — canonical wrapper. The inner client component below
// retains all existing logic; the gate decides whether to render it.
export default function SearchPage() {
  return (
    <PageRouteGate routeId="workspace.search">
      <SearchInner />
    </PageRouteGate>
  );
}

function SearchInner() {
  // Phase EMERGENCY-RECOVERY — search works for personal workspaces too;
  // both personal and team modes have a real Team UUID after the
  // workspace-bootstrap fix, so we consume the canonical workspace id.
  const teamId = useWorkspaceId();
  // Phase 38.2 — consume persona terminology in the search header.
  const terms = useTerminology();
  // Phase 38.18 — workflow-aware contextual help.
  const searchPersona = usePersonaProfile();
  const searchWorkflowCode = workflowFromPersona(
    searchPersona.primaryProfile,
  ).code;
  // Phase 15 — read active space to gate the admin-only "Enable semantic
  // search" no-result suggestion. We never expose raw env-var names in
  // the UI; the suggestion link points at the in-product integrations
  // surface, not to environment variables.
  const activeSpace = useActiveSpace();
  const isAdmin =
    activeSpace?.type === "ORGANIZATION"
      ? activeSpace.roleLabel === "OWNER" || activeSpace.roleLabel === "ADMIN"
      : activeSpace?.type === "PERSONAL";
  // Phase 16 — platform-admin gate for the backfill panel. The flag is
  // derived from the canonical platform envelope (single source of
  // truth) — never from local role heuristics. Non-admins never see
  // the panel and the dry-run endpoint stays unreached from the UI.
  const { envelope } = usePlatformContext();
  const isPlatformAdmin = envelope?.platform?.isPlatformAdmin === true;
  // Phase IA-self-serve-simplification — surface-tier check for the
  // "Enable semantic search" deep link. /integrations is ENTERPRISE
  // (with a bounded redirect for non-eligible users), so we hide the
  // link from sidebar/topbar/All Tools AND from this no-results CTA.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeIntegrations = canAccessSurface(
    surfaceUserCtx,
    "/integrations",
  );
  // Phase IA-self-serve-completion — gates for the inspector pivot
  // links. /workflows and /investigation are both ENTERPRISE_ONLY
  // surfaces; clicking them as a self-serve user previously hit a
  // bounded 404. We now hide the pivot links and rename the section
  // so self-serve users see a clean "Related evidence" rail instead
  // of an "Investigation pivots" rail that promised features they
  // could not reach.
  const canSeeWorkflows = canAccessSurface(surfaceUserCtx, "/workflows");
  const canSeeInvestigation = canAccessSurface(
    surfaceUserCtx,
    "/investigation",
  );
  const [filter, setFilter] = useState<FilterState | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResultRow | null>(null);
  const [relationships, setRelationships] = useState<Relationship[] | null>(
    null
  );
  const [savedViews, setSavedViews] = useState<SavedView[] | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [qDraft, setQDraft] = useState("");
  const { confirm } = useConfirmAction();
  // Phase 16 — semantic status envelope. The chip + mode selector
  // honor this when present and silently degrade to the per-response
  // `results.semanticAvailable` when the endpoint is missing (older
  // backends). One fetch per teamId; no polling.
  const [semanticStatus, setSemanticStatus] =
    useState<SemanticStatusResponse | null>(null);
  const [backfillResult, setBackfillResult] =
    useState<SemanticBackfillResponse | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Phase 32.8 Foundation cleanup — initialize filter when teamId
  // resolves from the canonical platform context.
  //
  // Phase HOME-INTELLIGENCE — honor `/search?q=…` deep links: the Home
  // header search routes here with a query, but this page previously
  // ignored the URL and waited for manual input. Read `q` once at
  // init (window is client-only-safe inside useEffect; avoids the
  // useSearchParams Suspense requirement) and seed BOTH the draft box
  // and the live filter so results load immediately.
  useEffect(() => {
    if (!teamId) return;
    let initialQ = "";
    try {
      initialQ =
        new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    } catch {
      // Non-browser environment — fall through to an empty query.
    }
    if (initialQ) setQDraft(initialQ);
    setFilter({
      teamId,
      sort: "UPDATED_DESC",
      limit: DEFAULT_LIMIT,
      ...(initialQ ? { q: initialQ } : {}),
    });
  }, [teamId]);

  // Saved views.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/search/saved-views?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((r: { views: SavedView[] }) => {
        if (cancelled) return;
        setSavedViews(r.views ?? []);
      })
      .catch(() => {
        if (!cancelled) setSavedViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Phase 16 — semantic status. One fetch per teamId, on mount only.
  // The endpoint is the canonical workspace-scoped projection of the
  // embedding provider gate + most recent fallback reason. Missing
  // endpoint (older backend) collapses to `null` so the page degrades
  // to the per-response semantic availability signal instead.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(
      `/v1/search/semantic/status?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: SemanticStatusResponse) => {
        if (cancelled) return;
        setSemanticStatus({
          enabled: r?.enabled === true,
          semanticAvailable: r?.semanticAvailable === true,
          fallbackReason: r?.fallbackReason ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setSemanticStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Run query on filter change.
  useEffect(() => {
    if (!filter) return;
    let cancelled = false;
    setLoading(true);
    runSearch(filter)
      .then((r) => {
        if (cancelled) return;
        setResults(r);
        setError(null);
        if (!r.rows.find((x) => x.documentId === selected?.documentId)) {
          setSelected(r.rows[0] ?? null);
        }
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Search failed.");
        setResults({
          rows: [],
          nextCursor: null,
          totalReturned: 0,
          filteredByGovernance: 0,
          filteredByVisibility: 0,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Relationships for the selected evidence row.
  useEffect(() => {
    if (!teamId || !selected?.evidenceId) {
      setRelationships(null);
      return;
    }
    let cancelled = false;
    apiFetch(
      `/v1/search/relationships/${encodeURIComponent(
        selected.evidenceId
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" }
    )
      .then((r: { relationships: Relationship[] }) => {
        if (cancelled) return;
        setRelationships(r.relationships ?? []);
      })
      .catch(() => {
        if (!cancelled) setRelationships([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, selected?.evidenceId]);

  const updateFilter = useCallback(
    (patch: Partial<FilterState>) => {
      setFilter((prev) =>
        prev ? { ...prev, ...patch, cursor: undefined } : prev
      );
    },
    []
  );

  const toggleArray = useCallback(
    <T,>(arr: T[] | undefined, value: T): T[] | undefined => {
      const set = new Set(arr ?? []);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      const next = Array.from(set);
      return next.length === 0 ? undefined : next;
    },
    []
  );

  const submitQuery = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = qDraft.trim().slice(0, 200);
      updateFilter({ q: trimmed.length > 0 ? trimmed : undefined });
    },
    [qDraft, updateFilter]
  );

  const loadMore = useCallback(() => {
    if (!filter || !results?.nextCursor) return;
    setLoading(true);
    runSearch({ ...filter, cursor: results.nextCursor })
      .then((r) => {
        setResults((prev) =>
          prev
            ? {
                rows: [...prev.rows, ...r.rows],
                nextCursor: r.nextCursor,
                totalReturned: prev.totalReturned + r.totalReturned,
                filteredByGovernance:
                  prev.filteredByGovernance + r.filteredByGovernance,
                filteredByVisibility:
                  prev.filteredByVisibility + r.filteredByVisibility,
              }
            : r
        );
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Search failed.")
      )
      .finally(() => setLoading(false));
  }, [filter, results?.nextCursor]);

  const applySavedView = useCallback((view: SavedView) => {
    setFilter({ ...view.query, cursor: undefined });
    setQDraft(view.query.q ?? "");
  }, []);

  const saveCurrentView = useCallback(async () => {
    if (!teamId || !filter) return;
    const name = window.prompt("Name this view (operator label)");
    if (!name || name.trim().length === 0) return;
    setSavingView(true);
    try {
      const res = await apiFetch("/v1/search/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim().slice(0, 120),
          visibility: "PRIVATE",
          query: filter,
        }),
      });
      if (res?.view) {
        setSavedViews((prev) => (prev ? [res.view, ...prev] : [res.view]));
      }
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not save view."
      );
    } finally {
      setSavingView(false);
    }
  }, [teamId, filter]);

  const deleteSavedView = useCallback(
    async (id: string) => {
      if (!teamId) return;
      const ok = await confirm({
        title: "Delete this saved view?",
        description: "The view will be removed from your search rail. Existing results are not affected.",
        confirmLabel: "Delete view",
        tone: "warning",
        testId: "search-saved-view-delete",
      });
      if (!ok) return;
      try {
        await apiFetch(
          `/v1/search/saved-views/${encodeURIComponent(
            id
          )}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" }
        );
        setSavedViews((prev) =>
          prev ? prev.filter((v) => v.id !== id) : prev
        );
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Could not delete view."
        );
      }
    },
    [teamId]
  );

  const filterSummary = useMemo(() => {
    if (!filter) return null;
    const parts: string[] = [];
    if (filter.q) parts.push(`"${filter.q}"`);
    if (filter.documentTypes?.length)
      parts.push(`${filter.documentTypes.length} types`);
    if (filter.workflowLinked) parts.push("workflow-linked");
    if (filter.onLegalHold) parts.push("legal-hold");
    if (filter.exportRestricted) parts.push("export-restricted");
    return parts.length > 0 ? parts.join(" · ") : "all rows";
  }, [filter]);

  // Phase 16 — semantic availability prefers the dedicated status
  // endpoint when present (workspace-scoped, capability-aware). When
  // the endpoint is missing (older backend), we fall back to the
  // per-response signal from /v1/search. Either way the page never
  // falsely promises a capability that isn't online.
  const semanticEnabled = semanticStatus?.enabled === true;
  const semanticAvailable = semanticStatus
    ? semanticStatus.semanticAvailable === true
    : results?.semanticAvailable === true;
  // Phase 15 — effective mode: prefer the user's explicit choice, but
  // default to "hybrid" when semantic is available and "keyword" when
  // it is not. Pre-Phase-15 saved views (no mode field) consequently
  // pick up hybrid silently on semantic-enabled deployments without
  // operator action; the saved view itself is not mutated.
  const effectiveMode: SearchMode =
    filter?.mode ?? (semanticAvailable ? "hybrid" : "keyword");
  const modeUsed: SearchMode = results?.modeUsed ?? effectiveMode;
  // Phase 16 — prefer the per-response fallback reason (it reflects
  // THIS query) and fall back to the global status fallback reason
  // when the search hasn't returned a row-set yet (initial paint).
  const fallbackReason =
    results?.fallbackReason ?? semanticStatus?.fallbackReason ?? null;

  // Phase 16 — admin-only backfill dry-run. Only renders for platform
  // admins (the panel is hidden entirely otherwise). The call is
  // workspace-scoped and idempotent — a dry run never writes embeddings.
  const runBackfillDryRun = useCallback(async () => {
    if (!teamId || !isPlatformAdmin) return;
    setBackfillRunning(true);
    setBackfillError(null);
    try {
      const r = (await apiFetch("/v1/search/semantic/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, dryRun: true }),
      })) as SemanticBackfillResponse;
      setBackfillResult({
        dryRun: r?.dryRun === true,
        chunksToEmbed:
          typeof r?.chunksToEmbed === "number" ? r.chunksToEmbed : 0,
        workspaceCount:
          typeof r?.workspaceCount === "number" ? r.workspaceCount : 0,
        perDayChunksUsed:
          typeof r?.perDayChunksUsed === "number" ? r.perDayChunksUsed : null,
        perDayChunksCap:
          typeof r?.perDayChunksCap === "number" ? r.perDayChunksCap : null,
        monthToDateEur:
          typeof r?.monthToDateEur === "number" ? r.monthToDateEur : null,
        monthlyBudgetEur:
          typeof r?.monthlyBudgetEur === "number" ? r.monthlyBudgetEur : null,
      });
    } catch (err) {
      setBackfillError(
        (err as { message?: string })?.message ??
          "Could not run dry run. The semantic backfill endpoint may not be available on this deployment.",
      );
    } finally {
      setBackfillRunning(false);
    }
  }, [teamId, isPlatformAdmin]);

  if (!teamId || !filter) {
    return (
      <main style={loadingScreenStyle}>
        <p style={mutedStyle}>Workspace setup pending — refresh shortly.</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle} data-search-title>
            {terms.evidence} Discovery
          </h1>
          <p style={subtitleStyle}>
            Operator search across {terms.evidenceLower}, workflows, audit events, and
            communications. Results respect visibility and governance rules.
          </p>
          {/* Phase 15/16 — semantic-search status chip. The chip text
              and colour reflect whichever mode the backend actually
              ran (`modeUsed`), the workspace-scoped capability
              (`semanticEnabled` + `semanticAvailable` from the Phase
              16 status endpoint), and the per-query fallback reason
              when the backend downgraded. Phase 13 wording is
              preserved for the disabled baseline. No raw env-var
              names appear in any chip variant. */}
          <SemanticStatusChip
            semanticEnabled={semanticEnabled}
            semanticAvailable={semanticAvailable}
            requestedMode={effectiveMode}
            modeUsed={modeUsed}
            fallbackReason={fallbackReason}
            statusEndpointAvailable={semanticStatus !== null}
          />
          {/* Phase 16 — admin-only backfill panel. Hidden entirely for
              non-admins; the dry-run endpoint stays unreached from the
              UI. Renders directly under the chip to keep the operator
              context tight. */}
          {isPlatformAdmin ? (
            <SemanticBackfillPanel
              running={backfillRunning}
              error={backfillError}
              result={backfillResult}
              onRun={runBackfillDryRun}
            />
          ) : null}
        </div>
        <form onSubmit={submitQuery} style={searchFormStyle}>
          <input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search titles, subtitles, OCR text…"
            style={searchInputStyle}
            maxLength={200}
            aria-label="Search query"
          />
          {/* Phase 15/16 — search mode selector. Sits next to the
              search input so operators can switch ranking strategy
              without losing their query. When semantic is unavailable
              the Hybrid + Semantic options are rendered disabled with
              a tooltip that humanises the workspace-scoped fallback
              reason from the Phase 16 status endpoint. Clicking has
              no effect; the mode never changes. */}
          <SearchModeSelector
            value={effectiveMode}
            semanticAvailable={semanticAvailable}
            disabledReason={
              semanticAvailable
                ? null
                : humaniseFallbackReason(fallbackReason)
            }
            onChange={(next) => updateFilter({ mode: next })}
          />
          <button type="submit" style={searchButtonStyle}>
            Search
          </button>
        </form>
      </header>

      {/* Phase 38.18 — workflow-aware contextual help, collapsed by
          default so the search results stay primary. */}
      <ContextualHelp
        workflow={searchWorkflowCode}
        surface="search"
        collapsedByDefault
      />

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <div style={threeColStyle}>
        {/* ----------------------------- LEFT ----------------------------- */}
        <aside style={leftRailStyle}>
          <FilterSection label="Sort">
            <select
              value={filter.sort ?? "UPDATED_DESC"}
              onChange={(e) =>
                updateFilter({ sort: e.target.value as SortMode })
              }
              style={selectStyle}
            >
              {SORT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </FilterSection>

          <FilterSection label="Document type">
            <div style={chipGroupStyle}>
              {DOCUMENT_TYPES.map((t) => {
                const active = filter.documentTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      updateFilter({
                        documentTypes: toggleArray(filter.documentTypes, t),
                      })
                    }
                    style={chipButtonStyle(active)}
                  >
                    {t.toLowerCase().replace("_", " ")}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          <FilterSection label="Evidence kind">
            <div style={chipGroupStyle}>
              {EVIDENCE_TYPES.map((t) => {
                const active = filter.evidenceTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      updateFilter({
                        evidenceTypes: toggleArray(filter.evidenceTypes, t),
                      })
                    }
                    style={chipButtonStyle(active)}
                  >
                    {t.toLowerCase()}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          <FilterSection label="Lifecycle">
            <Toggle
              label="Workflow-linked only"
              value={filter.workflowLinked ?? false}
              onChange={(v) =>
                updateFilter({ workflowLinked: v ? true : undefined })
              }
            />
            <Toggle
              label="On legal hold"
              value={filter.onLegalHold ?? false}
              onChange={(v) =>
                updateFilter({ onLegalHold: v ? true : undefined })
              }
            />
            <Toggle
              label="Export-restricted"
              value={filter.exportRestricted ?? false}
              onChange={(v) =>
                updateFilter({ exportRestricted: v ? true : undefined })
              }
            />
            <Toggle
              label="Incident-linked"
              value={filter.incidentLinked ?? false}
              onChange={(v) =>
                updateFilter({ incidentLinked: v ? true : undefined })
              }
            />
            <Toggle
              label="Contributor-scoped"
              value={filter.contributorScoped ?? false}
              onChange={(v) =>
                updateFilter({ contributorScoped: v ? true : undefined })
              }
            />
          </FilterSection>

          <FilterSection label="Updated">
            <label style={fieldLabelStyle}>
              Since
              <input
                type="datetime-local"
                value={filter.updatedSinceUtc?.slice(0, 16) ?? ""}
                onChange={(e) =>
                  updateFilter({
                    updatedSinceUtc: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                style={inputStyle}
              />
            </label>
            <label style={fieldLabelStyle}>
              Until
              <input
                type="datetime-local"
                value={filter.updatedUntilUtc?.slice(0, 16) ?? ""}
                onChange={(e) =>
                  updateFilter({
                    updatedUntilUtc: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                style={inputStyle}
              />
            </label>
          </FilterSection>

          <FilterSection label="Saved views">
            <button
              type="button"
              onClick={saveCurrentView}
              disabled={savingView}
              style={primaryButtonStyle}
            >
              {savingView ? "Saving…" : "Save current view"}
            </button>
            {savedViews === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : savedViews.length === 0 ? (
              <p style={mutedStyle}>No saved views yet.</p>
            ) : (
              <ul style={savedViewListStyle}>
                {savedViews.map((v) => (
                  <li key={v.id} style={savedViewRowStyle}>
                    <button
                      type="button"
                      onClick={() => applySavedView(v)}
                      style={savedViewApplyStyle}
                      title={v.description ?? ""}
                    >
                      {v.pinned ? "★ " : ""}
                      {v.name}
                      <span style={savedViewVisibilityStyle}>
                        {v.visibility.toLowerCase()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedView(v.id)}
                      style={iconButtonStyle}
                      aria-label="Delete saved view"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </FilterSection>
        </aside>

        {/* ----------------------------- CENTER ----------------------------- */}
        <section style={centerColStyle}>
          <div style={resultsHeaderStyle}>
            <div style={mutedStyle}>
              {loading
                ? "Searching…"
                : `${results?.totalReturned ?? 0} result${
                    (results?.totalReturned ?? 0) === 1 ? "" : "s"
                  } · ${filterSummary}`}
            </div>
            <div style={mutedStyle}>
              {results?.filteredByVisibility
                ? `${results.filteredByVisibility} visibility-restricted`
                : null}
              {results?.filteredByGovernance
                ? ` · ${results.filteredByGovernance} governance-restricted`
                : null}
            </div>
          </div>
          {!results || results.rows.length === 0 ? (
            <div style={emptyStateStyle}>
              {loading ? (
                "Searching…"
              ) : (
                // Phase 15/16 — additive no-result suggestions. The
                // primary line preserves the legacy operator copy; the
                // suggestions list nudges the operator toward broader
                // queries, filter removal, and (for admins on
                // semantic-disabled deployments) the in-product
                // integrations surface where semantic search can be
                // enabled. Phase 16 adds a "Try semantic search" link
                // when the operator searched keyword-only and semantic
                // is available, and a single bounded line when
                // semantic was attempted (no nag). No env vars
                // anywhere.
                <NoResultsHelp
                  isAdmin={isAdmin}
                  canSeeIntegrations={canSeeIntegrations}
                  semanticAvailable={semanticAvailable}
                  mode={effectiveMode}
                  modeUsed={modeUsed}
                  onSwitchToHybrid={() => updateFilter({ mode: "hybrid" })}
                />
              )}
            </div>
          ) : (
            <ul style={resultListStyle}>
              {results.rows.map((row) => (
                <li
                  key={row.documentId}
                  style={resultRowStyle(selected?.documentId === row.documentId)}
                  onClick={() => setSelected(row)}
                >
                  <div style={resultRowHeaderStyle}>
                    <span style={docTypeChipStyle(row.documentType)}>
                      {row.documentType.toLowerCase().replace("_", " ")}
                    </span>
                    <span style={resultTitleStyle}>{row.title}</span>
                  </div>
                  {/* Phase 15 — match-reason badges. Backend annotates
                      each row with the signals that contributed to the
                      match (e.g. "Matched OCR text", "Semantically
                      similar"). Pre-Phase-15 responses omit the field
                      and the badge row is skipped. */}
                  {row.matchReasons && row.matchReasons.length > 0 ? (
                    <div style={matchReasonRowStyle}>
                      {row.matchReasons.map((reason) => (
                        <span key={reason} style={matchReasonBadgeStyle}>
                          {reason}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {row.subtitle ? (
                    <div style={resultSubtitleStyle}>{row.subtitle}</div>
                  ) : null}
                  {row.summary ? (
                    <div style={resultSummaryStyle}>{row.summary}</div>
                  ) : null}
                  <div style={resultMetaStyle}>
                    {row.badges.length > 0 ? (
                      <div style={badgeRowStyle}>
                        {row.badges.map((b) => (
                          <span key={b} style={badgeChipStyle(b)}>
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <span style={mutedStyle}>
                      updated {formatDateTime(row.updatedAtUtc)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {results?.nextCursor ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              style={loadMoreButtonStyle}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </section>

        {/* ----------------------------- RIGHT ----------------------------- */}
        <aside style={rightRailStyle}>
          {!selected ? (
            <div style={emptyStateStyle}>
              Select a result to inspect pointers and related evidence.
            </div>
          ) : (
            <Inspector
              row={selected}
              relationships={relationships}
              teamId={teamId}
              canSeeWorkflows={canSeeWorkflows}
              canSeeInvestigation={canSeeInvestigation}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Inspector
// -----------------------------------------------------------------------------

function Inspector({
  row,
  relationships,
  teamId,
  canSeeWorkflows,
  canSeeInvestigation,
}: {
  row: ResultRow;
  relationships: Relationship[] | null;
  teamId: string;
  // Phase IA-self-serve-completion — surface-tier gates for the
  // pointer + pivot links. Self-serve users see the IDs but not the
  // links, and the "Investigation pivots" section is renamed and
  // hidden when neither investigation nor workflow links can render.
  canSeeWorkflows: boolean;
  canSeeInvestigation: boolean;
}) {
  return (
    <div>
      <div style={inspectorHeaderStyle}>
        <div style={docTypeChipStyle(row.documentType)}>
          {row.documentType.toLowerCase().replace("_", " ")}
        </div>
        <h2 style={inspectorTitleStyle}>{row.title}</h2>
        {row.subtitle ? (
          <p style={inspectorSubtitleStyle}>{row.subtitle}</p>
        ) : null}
      </div>

      {row.badges.length > 0 ? (
        <Section label="Signals">
          <div style={badgeRowStyle}>
            {row.badges.map((b) => (
              <span key={b} style={badgeChipStyle(b)}>
                {b}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <Section label="Pointers">
        <KeyVal label="Document" value={row.documentId} mono />
        {row.evidenceId ? (
          <KeyVal
            label="Evidence"
            value={
              <a
                href={`/evidence/${row.evidenceId}`}
                style={pointerLinkStyle}
              >
                {row.evidenceId}
              </a>
            }
            mono
          />
        ) : null}
        {row.workflowInstanceId ? (
          <KeyVal
            label="Workflow"
            value={
              canSeeWorkflows ? (
                <a
                  href={`/workflows/${row.workflowInstanceId}`}
                  style={pointerLinkStyle}
                >
                  {row.workflowInstanceId}
                </a>
              ) : (
                // Phase IA-self-serve-completion — show the ID but
                // not the link for self-serve users. /workflows is
                // ENTERPRISE_ONLY.
                <span>{row.workflowInstanceId}</span>
              )
            }
            mono
          />
        ) : null}
        {row.workflowStepInstanceId ? (
          <KeyVal
            label="Workflow step"
            value={row.workflowStepInstanceId}
            mono
          />
        ) : null}
        {row.caseId ? (
          <KeyVal
            label="Case"
            value={
              <a href={`/cases/${row.caseId}`} style={pointerLinkStyle}>
                {row.caseId}
              </a>
            }
            mono
          />
        ) : null}
      </Section>

      {/* Phase IA-self-serve-completion — for self-serve users
          (canSeeInvestigation === false) the "Investigation pivots"
          section is renamed "Related evidence" and the three
          /investigation/* links are dropped. The semantic-score
          caption still renders so users understand why a row was
          surfaced even without the investigation tools. The section
          only renders for self-serve when there is a semantic-score
          caption to show; otherwise the entire block is dropped to
          avoid an empty section header. */}
      {canSeeInvestigation && (row.evidenceId || row.caseId) ? (
        <Section label="Investigation pivots">
          {/* Phase 15 — when the selected row carries a semantic score,
              caption the pivots so the operator knows the chain that
              produced this hit. The truncated title is enough context;
              we never echo the original query verbatim here either. */}
          {typeof row.semanticScore === "number" && row.semanticScore > 0 ? (
            <p style={semanticPivotCaptionStyle}>
              Semantically similar to: {row.title.slice(0, 80)}
              {row.title.length > 80 ? "…" : ""}
            </p>
          ) : null}
          {row.caseId ? (
            <KeyVal
              label="Case graph"
              value={
                <a
                  href={`/investigation/cases/${row.caseId}/graph`}
                  style={pointerLinkStyle}
                >
                  Open case graph
                </a>
              }
            />
          ) : null}
          {row.evidenceId ? (
            <KeyVal
              label="Timeline"
              value={
                <a
                  href={`/investigation/timeline?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
                  style={pointerLinkStyle}
                >
                  Open timeline view
                </a>
              }
            />
          ) : null}
          {row.evidenceId ? (
            <KeyVal
              label="Duplicates"
              value={
                <a
                  href={`/investigation/duplicates?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
                  style={pointerLinkStyle}
                >
                  Review duplicates and similars
                </a>
              }
            />
          ) : null}
        </Section>
      ) : null}
      {!canSeeInvestigation &&
      typeof row.semanticScore === "number" &&
      row.semanticScore > 0 ? (
        // Self-serve rail — keep the semantic-score caption only.
        <Section label="Related evidence">
          <p style={semanticPivotCaptionStyle}>
            Semantically similar to: {row.title.slice(0, 80)}
            {row.title.length > 80 ? "…" : ""}
          </p>
        </Section>
      ) : null}

      <Section label="Lifecycle">
        <KeyVal label="Review" value={row.reviewState ?? "—"} />
        <KeyVal label="Workflow" value={row.workflowState ?? "—"} />
        <KeyVal label="Export" value={row.exportState ?? "—"} />
        <KeyVal label="Retention" value={row.retentionState ?? "—"} />
        <KeyVal label="Legal hold" value={row.legalHoldState ?? "—"} />
        <KeyVal label="Updated" value={formatDateTime(row.updatedAtUtc)} />
      </Section>

      {row.summary ? (
        <Section label="Summary">
          <p style={summaryProseStyle}>{row.summary}</p>
        </Section>
      ) : null}

      {row.evidenceId ? (
        <Section label="Related evidence">
          {relationships === null ? (
            <p style={mutedStyle}>Loading…</p>
          ) : relationships.length === 0 ? (
            <p style={mutedStyle}>No related evidence.</p>
          ) : (
            <ul style={relationshipListStyle}>
              {relationships.map((r) => {
                const otherId =
                  r.sourceEvidenceId === row.evidenceId
                    ? r.targetEvidenceId
                    : r.sourceEvidenceId;
                return (
                  <li key={r.relationshipId} style={relationshipRowStyle}>
                    <span style={relTypeChipStyle}>{r.relationshipType}</span>
                    <a
                      href={`/evidence/${otherId}?teamId=${encodeURIComponent(
                        teamId
                      )}`}
                      style={pointerLinkStyle}
                    >
                      {otherId.slice(0, 12)}…
                    </a>
                    {r.note ? (
                      <span style={mutedStyle} title={r.note}>
                        {r.note.slice(0, 60)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small components
// -----------------------------------------------------------------------------

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={filterSectionStyle}>
      <div style={filterLabelStyle}>{label}</div>
      <div style={filterBodyStyle}>{children}</div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={toggleRowStyle}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function KeyVal({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={keyValRowStyle}>
      <span style={keyValLabelStyle}>{label}</span>
      <span style={mono ? keyValMonoStyle : keyValValueStyle}>{value}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Phase 15 — additive UI helpers (mode selector + status chip + no-result
// help). Kept colocated so the search page remains the single canonical
// surface for global intelligence search. None of these read or write any
// new envelope fields beyond what the search API already returns, and
// none expose raw env-var names in their copy.
// -----------------------------------------------------------------------------

function SearchModeSelector({
  value,
  semanticAvailable,
  disabledReason,
  onChange,
}: {
  value: SearchMode;
  semanticAvailable: boolean;
  // Phase 16 — humanised reason for the disabled tooltip. Sourced from
  // the workspace-scoped status endpoint or the per-query fallback
  // reason. `null` means the generic "not enabled" copy is used.
  disabledReason: string | null;
  onChange: (next: SearchMode) => void;
}) {
  // Options always present; "semantic" and "hybrid" become inert when
  // the backend is not advertising semantic capability. We never throw
  // an error or warn the operator — the chip styling + tooltip carry
  // the message.
  const disabledTitle = semanticAvailable
    ? undefined
    : disabledReason
      ? `Semantic search unavailable: ${disabledReason}`
      : "Semantic search is not enabled on this deployment";
  const options: ReadonlyArray<{
    value: SearchMode;
    label: string;
    disabled: boolean;
    title?: string;
  }> = [
    { value: "keyword", label: "Keyword", disabled: false },
    {
      value: "hybrid",
      label: "Hybrid",
      disabled: !semanticAvailable,
      title: disabledTitle,
    },
    {
      value: "semantic",
      label: "Semantic",
      disabled: !semanticAvailable,
      title: disabledTitle,
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Search mode"
      data-search-mode-selector
      style={searchModeSelectorStyle}
    >
      {options.map((opt) => {
        const active = value === opt.value && !opt.disabled;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={opt.disabled}
            disabled={opt.disabled}
            data-search-mode={opt.value}
            title={opt.title}
            onClick={() => {
              if (opt.disabled) return;
              if (value === opt.value) return;
              onChange(opt.value);
            }}
            style={searchModeButtonStyle(active, opt.disabled)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SemanticStatusChip({
  semanticEnabled,
  semanticAvailable,
  requestedMode,
  modeUsed,
  fallbackReason,
  statusEndpointAvailable,
}: {
  // Phase 16 — workspace-scoped "enabled" flag from the dedicated
  // status endpoint. Distinct from `semanticAvailable` because a
  // workspace can have the feature enabled at the deployment level
  // but still see the provider report "unavailable" today (daily cap
  // reached, provider offline, outbound disabled).
  semanticEnabled: boolean;
  semanticAvailable: boolean;
  requestedMode: SearchMode;
  modeUsed: SearchMode;
  fallbackReason: string | null;
  // Phase 16 — when the status endpoint isn't present (older
  // backend), we fall back to the legacy per-response signal and
  // skip the "disabled vs unavailable" split. The chip still renders
  // the Phase 13 / Phase 15 wording in that case.
  statusEndpointAvailable: boolean;
}) {
  // Variant resolution — keeps the chip honest about what actually
  // ran. Order matters: a fallback flag wins over a "happy path"
  // banner so operators see the real state. The data attribute
  // vocabulary (`disabled` / `active` / `fallback` / `blocked`) is
  // preserved from Phase 13 — Phase 16 adds `unavailable` for the
  // new "enabled but offline" case.
  const usedSemantic = modeUsed === "hybrid" || modeUsed === "semantic";
  const humanReason = humaniseFallbackReason(fallbackReason);
  let label: string;
  let status: "disabled" | "active" | "fallback" | "blocked" | "unavailable";
  if (statusEndpointAvailable && !semanticEnabled) {
    // Phase 16 — feature disabled at the workspace level. Single
    // bounded line; no env-var names anywhere.
    label = "Semantic search disabled — keyword mode active";
    status = "disabled";
  } else if (statusEndpointAvailable && semanticEnabled && !semanticAvailable) {
    // Phase 16 — feature enabled but the provider reported
    // unavailable for this workspace. Surface the humanised reason
    // when the backend gave us one.
    label = humanReason
      ? `Semantic search unavailable: ${humanReason}`
      : "Semantic search unavailable";
    status = "unavailable";
  } else if (statusEndpointAvailable && semanticEnabled && semanticAvailable) {
    // Phase 16 — workspace-scoped happy path. If a per-query fallback
    // happened anyway, show the fallback chip so the operator
    // doesn't think the rerank ran.
    if (
      (requestedMode === "hybrid" || requestedMode === "semantic") &&
      !usedSemantic
    ) {
      label = humanReason
        ? `Hybrid semantic search fell back to keyword — ${humanReason}`
        : "Hybrid semantic search fell back to keyword for this query";
      status = "fallback";
    } else {
      label = "Hybrid semantic search active";
      status = "active";
    }
  } else if (!semanticAvailable) {
    // Legacy path (no status endpoint). Preserve Phase 13 wording.
    if (requestedMode === "semantic" || requestedMode === "hybrid") {
      label = "Semantic search disabled — keyword search active";
      status = "blocked";
    } else {
      label = "Semantic search not available — keyword search active";
      status = "disabled";
    }
  } else if (
    (requestedMode === "hybrid" || requestedMode === "semantic") &&
    !usedSemantic
  ) {
    label = humanReason
      ? `Hybrid semantic search fell back to keyword — ${humanReason}`
      : "Hybrid semantic search fell back to keyword for this query";
    status = "fallback";
  } else if (usedSemantic) {
    label = "Hybrid semantic search active";
    status = "active";
  } else {
    label = "Keyword mode";
    status = "disabled";
  }
  return (
    <span
      data-semantic-search-status={status}
      style={semanticStatusChipStyle(status)}
    >
      {label}
    </span>
  );
}

// Phase 16 — bounded translation of the wire-level fallback codes
// into operator-safe copy. Unknown codes pass through lower-cased so
// future codes still render readably without a UI deploy.
function humaniseFallbackReason(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "PROVIDER_UNAVAILABLE":
      return "provider offline";
    case "DAILY_CAP":
      return "daily cap reached";
    case "MONTHLY_BUDGET":
      return "monthly budget reached";
    case "OUTBOUND_NOT_ALLOWED":
      return "outbound disabled";
    case "SEMANTIC_FEATURE_DISABLED":
      return "feature not enabled";
    case "QUERY_TOO_SHORT":
      return "query too short";
    case "NO_SEMANTIC_RESULTS":
      return "no semantic matches";
    default:
      return code.toLowerCase().replace(/_/g, " ");
  }
}

function NoResultsHelp({
  isAdmin,
  canSeeIntegrations,
  semanticAvailable,
  mode,
  modeUsed,
  onSwitchToHybrid,
}: {
  isAdmin: boolean;
  // Phase IA-self-serve-simplification — surface-tier gate for the
  // "Enable semantic search" deep link. Self-serve admins still have
  // isAdmin=true but cannot access /integrations.
  canSeeIntegrations: boolean;
  semanticAvailable: boolean;
  // Phase 16 — the operator's requested mode + the mode the backend
  // actually ran. When the operator searched keyword-only with
  // semantic available, we offer the "Try semantic search" link
  // (one click, flips to hybrid). When semantic was attempted (the
  // backend ran hybrid/semantic), we show a single bounded line and
  // do not nag.
  mode: SearchMode;
  modeUsed: SearchMode;
  onSwitchToHybrid: () => void;
}) {
  const semanticAttempted = modeUsed === "hybrid" || modeUsed === "semantic";
  if (semanticAttempted) {
    // Phase 16 — terminal state: both ranking strategies came up
    // empty. Bounded operator-safe copy, no nag.
    return (
      <div style={noResultsHelpStyle}>
        <p style={noResultsLeadStyle}>
          No matches found across keyword OR semantic search.
        </p>
      </div>
    );
  }
  // Suggestions are intentionally short and operator-safe. The
  // "Enable semantic search" link only renders for admins on
  // semantic-disabled deployments; non-admins are never nagged about
  // capabilities they cannot change. The link target is the in-product
  // integrations surface — no env-var names anywhere.
  return (
    <div style={noResultsHelpStyle}>
      <p style={noResultsLeadStyle}>
        No results yet. A few things you can try:
      </p>
      <ul style={noResultsListStyle}>
        <li>Try broader terms</li>
        <li>Remove filters</li>
        {/* Phase 16 — when the operator searched keyword and the
            workspace has semantic available, surface a single-click
            "Try semantic search" affordance. Flips mode to hybrid;
            no other state changes. */}
        {mode === "keyword" && semanticAvailable ? (
          <li>
            <button
              type="button"
              onClick={onSwitchToHybrid}
              style={inlineLinkButtonStyle}
              data-action="try-semantic-search"
            >
              Try semantic search
            </button>
          </li>
        ) : null}
        {isAdmin && canSeeIntegrations && !semanticAvailable ? (
          <li>
            <Link href="/integrations" style={pointerLinkStyle}>
              Enable semantic search
            </Link>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// Phase 16 — admin-only semantic backfill panel. Bounded to a single
// "Run backfill (dry run)" button and a single-line result. The
// panel is rendered ONLY when `isPlatformAdmin === true` (the caller
// guards), so this component never has to do its own role check.
function SemanticBackfillPanel({
  running,
  error,
  result,
  onRun,
}: {
  running: boolean;
  error: string | null;
  result: SemanticBackfillResponse | null;
  onRun: () => void;
}) {
  const dayLine =
    result && result.perDayChunksCap !== null && result.perDayChunksCap !== undefined
      ? `Per-day chunks: ${result.perDayChunksUsed ?? 0} / ${result.perDayChunksCap}`
      : null;
  const budgetLine =
    result &&
    result.monthlyBudgetEur !== null &&
    result.monthlyBudgetEur !== undefined
      ? `Month-to-date: EUR ${(result.monthToDateEur ?? 0).toFixed(2)} / ${result.monthlyBudgetEur.toFixed(2)}`
      : null;
  return (
    <div
      style={semanticBackfillPanelStyle}
      data-semantic-backfill-panel
    >
      <div style={semanticBackfillPanelLabelStyle}>Semantic backfill</div>
      {dayLine ? <div style={semanticBackfillPanelLineStyle}>{dayLine}</div> : null}
      {budgetLine ? (
        <div style={semanticBackfillPanelLineStyle}>{budgetLine}</div>
      ) : null}
      <button
        type="button"
        onClick={onRun}
        disabled={running}
        style={semanticBackfillButtonStyle(running)}
        data-action="semantic-backfill-dry-run"
      >
        {running ? "Running dry run…" : "Run backfill (dry run)"}
      </button>
      {result ? (
        <div style={semanticBackfillPanelResultStyle}>
          Would embed {result.chunksToEmbed} chunk
          {result.chunksToEmbed === 1 ? "" : "s"} across {result.workspaceCount}{" "}
          workspace
          {result.workspaceCount === 1 ? "" : "s"}.
        </div>
      ) : null}
      {error ? (
        <div style={semanticBackfillPanelErrorStyle}>{error}</div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function runSearch(filter: FilterState): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set("teamId", filter.teamId);
  if (filter.q) qs.set("q", filter.q);
  if (filter.documentTypes?.length)
    qs.set("documentTypes", filter.documentTypes.join(","));
  if (filter.evidenceTypes?.length)
    qs.set("evidenceTypes", filter.evidenceTypes.join(","));
  if (filter.workflowStatuses?.length)
    qs.set("workflowStatuses", filter.workflowStatuses.join(","));
  if (filter.reviewStatuses?.length)
    qs.set("reviewStatuses", filter.reviewStatuses.join(","));
  if (filter.onLegalHold !== undefined)
    qs.set("onLegalHold", String(filter.onLegalHold));
  if (filter.exportRestricted !== undefined)
    qs.set("exportRestricted", String(filter.exportRestricted));
  if (filter.incidentLinked !== undefined)
    qs.set("incidentLinked", String(filter.incidentLinked));
  if (filter.workflowLinked !== undefined)
    qs.set("workflowLinked", String(filter.workflowLinked));
  if (filter.contributorScoped !== undefined)
    qs.set("contributorScoped", String(filter.contributorScoped));
  if (filter.updatedSinceUtc) qs.set("updatedSinceUtc", filter.updatedSinceUtc);
  if (filter.updatedUntilUtc) qs.set("updatedUntilUtc", filter.updatedUntilUtc);
  if (filter.sort) qs.set("sort", filter.sort);
  if (filter.cursor) qs.set("cursor", filter.cursor);
  if (filter.limit) qs.set("limit", String(filter.limit));
  // Phase 15 — pass the search mode through to /v1/search. The backend
  // ignores unknown modes and falls back to keyword. We never send the
  // mode unless it differs from the default keyword mode, so legacy
  // backends that have not yet learned the parameter keep working.
  if (filter.mode && filter.mode !== "keyword") qs.set("mode", filter.mode);
  const r = await apiFetch(`/v1/search?${qs.toString()}`, { method: "GET" });
  return r as SearchResponse;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// -----------------------------------------------------------------------------
// Styles — restrained, dense, operational. No gradients.
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  padding: "20px 24px 40px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
  background: "#f8fafc",
  minHeight: "100vh",
};

const loadingScreenStyle: React.CSSProperties = {
  ...pageStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 24,
  paddingBottom: 16,
  borderBottom: "1px solid #e2e8f0",
  flexWrap: "wrap",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  letterSpacing: -0.2,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
  margin: "4px 0 0",
  maxWidth: 640,
};

// Phase 13 — disabled-state pill for the semantic-search indicator.
// Bounded operator-safe language only; no internal config names.
// Phase 15 — retained as the disabled baseline; new state-aware
// variants below (semanticStatusChipStyle) build from the same tokens.
const _semanticSearchChipStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 8,
  padding: "2px 10px",
  fontSize: 11,
  fontWeight: 500,
  background: "#f1f5f9",
  color: "#475569",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
};

// Phase 15 — palette-aware status chip. Uses the same colour family as
// the existing badge palette on this page so we do not introduce a new
// design system.
function semanticStatusChipStyle(
  status: "disabled" | "active" | "fallback" | "blocked" | "unavailable",
): React.CSSProperties {
  const palette: Record<
    "disabled" | "active" | "fallback" | "blocked" | "unavailable",
    { bg: string; fg: string; border: string }
  > = {
    disabled: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
    active: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    fallback: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    blocked: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    // Phase 16 — "enabled but offline" carries a warning palette so
    // operators distinguish it from "disabled" (no feature) and
    // "blocked" (operator picked an unavailable mode).
    unavailable: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  };
  const p = palette[status];
  return {
    display: "inline-block",
    marginTop: 8,
    padding: "2px 10px",
    fontSize: 11,
    fontWeight: 500,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    borderRadius: 999,
  };
}

const searchFormStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  minWidth: 320,
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
  minWidth: 240,
};

const searchButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  background: "#1e293b",
  color: "#fff",
  border: "1px solid #1e293b",
  borderRadius: 6,
  cursor: "pointer",
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 13,
};

const threeColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr 360px",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

const leftRailStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const centerColStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12,
  minHeight: 400,
};

const rightRailStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 16,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const filterSectionStyle: React.CSSProperties = {
  borderBottom: "1px solid #f1f5f9",
  padding: "10px 4px 12px",
};
const filterLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#475569",
  letterSpacing: 0.5,
  marginBottom: 8,
};
const filterBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const chipGroupStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

function chipButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 999,
    border: "1px solid",
    background: active ? "#1e293b" : "#fff",
    color: active ? "#fff" : "#334155",
    borderColor: active ? "#1e293b" : "#cbd5e1",
    cursor: "pointer",
  };
}

const selectStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  background: "#fff",
  color: "#0f172a",
};

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "#334155",
  cursor: "pointer",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontSize: 11,
  color: "#475569",
  gap: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  background: "#fff",
  color: "#0f172a",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid #1e293b",
  background: "#1e293b",
  color: "#fff",
  borderRadius: 6,
  cursor: "pointer",
};

const savedViewListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const savedViewRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};
const savedViewApplyStyle: React.CSSProperties = {
  flex: 1,
  textAlign: "left",
  padding: "5px 8px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f8fafc",
  fontSize: 12,
  color: "#0f172a",
  cursor: "pointer",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 6,
};
const savedViewVisibilityStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#64748b",
  textTransform: "uppercase",
};
const iconButtonStyle: React.CSSProperties = {
  padding: "2px 8px",
  border: "1px solid #e2e8f0",
  background: "#fff",
  color: "#64748b",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const resultsHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 4px 10px",
  borderBottom: "1px solid #f1f5f9",
  flexWrap: "wrap",
  gap: 8,
};

const emptyStateStyle: React.CSSProperties = {
  padding: 40,
  textAlign: "center",
  color: "#94a3b8",
  fontSize: 13,
};

const resultListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

function resultRowStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    cursor: "pointer",
    background: active ? "#f1f5f9" : "transparent",
    borderLeft: active ? "3px solid #1e293b" : "3px solid transparent",
  };
}
const resultRowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};
const resultTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};
const resultSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  marginTop: 2,
};
const resultSummaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  marginTop: 4,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const resultMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: 6,
  flexWrap: "wrap",
  gap: 6,
};
const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

function docTypeChipStyle(type: DocumentType): React.CSSProperties {
  const palette: Record<DocumentType, { bg: string; fg: string; border: string }> = {
    EVIDENCE: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    WORKFLOW: { bg: "#ecfeff", fg: "#155e75", border: "#a5f3fc" },
    WORKFLOW_STEP: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    REVIEW_EVENT: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    AUDIT_EVENT: { bg: "#f5f3ff", fg: "#5b21b6", border: "#ddd6fe" },
    COMMUNICATION: { bg: "#fff7ed", fg: "#9a3412", border: "#fed7aa" },
    CASE_TIMELINE: { bg: "#f0f9ff", fg: "#0c4a6e", border: "#bae6fd" },
    INCIDENT: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  };
  const p = palette[type];
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    display: "inline-block",
    whiteSpace: "nowrap",
  };
}

function badgeChipStyle(badge: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    "legal-hold": { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    "export-restricted": { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    "visibility-restricted": {
      bg: "#f5f3ff",
      fg: "#5b21b6",
      border: "#ddd6fe",
    },
    "contributor-scoped": { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    "workflow-linked": { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    "review-linked": { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    "governance-restricted": {
      bg: "#fef2f2",
      fg: "#991b1b",
      border: "#fecaca",
    },
    "incident-linked": { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    "communication-linked": { bg: "#fff7ed", fg: "#9a3412", border: "#fed7aa" },
    "integrity record": { bg: "#f0f9ff", fg: "#0c4a6e", border: "#bae6fd" },
    "matched metadata": { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
    "related evidence": { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
  };
  const p = map[badge] ?? {
    bg: "#f1f5f9",
    fg: "#334155",
    border: "#e2e8f0",
  };
  return {
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 500,
    borderRadius: 999,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    whiteSpace: "nowrap",
  };
}

const loadMoreButtonStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "8px 16px",
  width: "100%",
  fontSize: 13,
  fontWeight: 500,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#334155",
  borderRadius: 6,
  cursor: "pointer",
};

const inspectorHeaderStyle: React.CSSProperties = {
  paddingBottom: 12,
  borderBottom: "1px solid #f1f5f9",
  marginBottom: 8,
};
const inspectorTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: "6px 0 0",
  color: "#0f172a",
  wordBreak: "break-word",
};
const inspectorSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  margin: "4px 0 0",
};

const sectionStyle: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: "1px solid #f8fafc",
};
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#475569",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const keyValRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
  padding: "2px 0",
  fontSize: 12,
};
const keyValLabelStyle: React.CSSProperties = {
  color: "#64748b",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  whiteSpace: "nowrap",
};
const keyValValueStyle: React.CSSProperties = {
  color: "#0f172a",
  textAlign: "right",
  fontSize: 12,
  wordBreak: "break-word",
};
const keyValMonoStyle: React.CSSProperties = {
  ...keyValValueStyle,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 11,
};

const pointerLinkStyle: React.CSSProperties = {
  color: "#1e40af",
  textDecoration: "none",
};

const summaryProseStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "#334155",
  margin: 0,
  whiteSpace: "pre-wrap",
};

const relationshipListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const relationshipRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 0",
  fontSize: 12,
  borderBottom: "1px solid #f8fafc",
};
const relTypeChipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 4,
  background: "#f1f5f9",
  color: "#334155",
  border: "1px solid #e2e8f0",
  whiteSpace: "nowrap",
};

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
};

// -----------------------------------------------------------------------------
// Phase 15 — additive styles.
// -----------------------------------------------------------------------------

const searchModeSelectorStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: 0,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  overflow: "hidden",
  background: "#fff",
};

function searchModeButtonStyle(
  active: boolean,
  disabled: boolean,
): React.CSSProperties {
  return {
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    border: "none",
    background: active ? "#1e293b" : "#fff",
    color: disabled ? "#94a3b8" : active ? "#fff" : "#334155",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.7 : 1,
    borderRight: "1px solid #e2e8f0",
  };
}

const matchReasonRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 4,
};

const matchReasonBadgeStyle: React.CSSProperties = {
  padding: "1px 6px",
  fontSize: 10,
  fontWeight: 500,
  borderRadius: 4,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #bfdbfe",
  whiteSpace: "nowrap",
};

const noResultsHelpStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
};

const noResultsLeadStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#475569",
};

const noResultsListStyle: React.CSSProperties = {
  listStyle: "disc",
  margin: 0,
  padding: 0,
  paddingInlineStart: 20,
  fontSize: 12,
  color: "#475569",
  textAlign: "left",
  display: "inline-block",
};

const semanticPivotCaptionStyle: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 11,
  color: "#475569",
  fontStyle: "italic",
};

// Phase 16 — admin-only backfill panel + inline "Try semantic search"
// link button. Both surfaces share the page's design tokens; no new
// colours or spacing primitives.

const semanticBackfillPanelStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 12px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxWidth: 360,
};

const semanticBackfillPanelLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#475569",
  letterSpacing: 0.5,
};

const semanticBackfillPanelLineStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#475569",
};

const semanticBackfillPanelResultStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#0f172a",
};

const semanticBackfillPanelErrorStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#991b1b",
};

function semanticBackfillButtonStyle(running: boolean): React.CSSProperties {
  return {
    alignSelf: "flex-start",
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #1e293b",
    background: running ? "#cbd5e1" : "#1e293b",
    color: running ? "#475569" : "#fff",
    borderRadius: 6,
    cursor: running ? "not-allowed" : "pointer",
  };
}

const inlineLinkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  color: "#1e40af",
  textDecoration: "underline",
  cursor: "pointer",
  font: "inherit",
};
