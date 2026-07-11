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

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import {
  useActiveSpace,
  usePersonaProfile,
  usePlatformContext,
  useTerminology,
  useWorkspaceId,
  workflowFromPersona,
} from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// Phase 7C — full shared design-system migration of the /search console.
// PageShell supplies the token-driven content plane; PageHeader renders
// the page heading/description/actions strip. The pinned
// `<h1 data-search-title>Search</h1>` element is passed as PageHeader's
// `title` so the contract semantics survive inside the shared header.
import { PageShell, PageHeader } from "../../../components/ui";
// Deep-import the NEW Phase-7 primitives (the barrel still serves the
// legacy Button/Card/Badge/EmptyState for older call sites; the search
// console upgrades to the richer variant/tone APIs).
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
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
  // Phase SEARCH-REMEDIATION — added so Personal / Small-Business
  // users can search cases, reports, packages, and notes from the
  // same search box.
  | "CASE"
  | "REPORT"
  | "PACKAGE"
  | "NOTE"
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

// Search-runtime-diagnostics — workspace-scoped envelope returned by
// GET /v1/search/diagnostics. Used to render explicit empty-state
// copy ("Search index preparing", "Workspace has no records yet")
// when the underlying cause is NOT "no matching rows" — preventing
// the runtime path from rendering a misleading "0 results."
// Older backends without the endpoint return 404; the page collapses
// to null and falls back to the legacy empty-state branches.
type SearchDiagnostics = {
  workspace: { id: string; name: string | null; isPersonal: boolean | null };
  evidence: { total: number };
  index: {
    total: number;
    byType: Record<string, number>;
    evidenceIndexed: number;
    // CHANGED — now mirrors `evidenceIndexable` (matches the
    // indexer's exclusions). Field name kept for back-compat with
    // older clients reading the response.
    evidenceTotal: number;
    coverage: number | null;
    // NEW — per-state breakdown of the source population. Used by
    // the admin-only chip to explain the delta between
    // `evidenceIndexed` and `evidenceTotal` when health !== healthy.
    // Older API builds omit this; consumers should treat it as
    // optional.
    breakdown?: {
      evidenceIndexable: number;
      activeIncluded: number;
      archivedIncluded: number;
      lockedIncluded: number;
      // Search-inclusion-audit (trash decision) — soft-deleted
      // records are INDEXED + searchable + tagged "in_trash".
      // This count is the trash bucket inside evidenceIndexable.
      trashedIncluded: number;
      destroyedExcluded: number;
      pendingDestructionExcluded: number;
      // Hard-deleted rows are physically absent from the source
      // table — the count is structurally unknowable. The API
      // returns `null` rather than a misleading zero.
      hardDeletedAbsent: number | null;
    };
  };
  health: "healthy" | "partial_index" | "empty_index" | "empty_workspace";
  queryProbe: {
    q: string;
    matchedTotal: number;
    matchedByType: Record<string, number>;
  } | null;
  runtime: {
    dbServerIp: string | null;
    dbServerPort: number | null;
    dbName: string | null;
    nodeEnv: string | null;
  };
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

// Phase SEARCH-REMEDIATION — Personal / Small-Business users see
// only the document types that are actually indexed and useful for
// their workflow. The enterprise types (workflow / workflow step /
// review event / audit event / communication / case timeline /
// incident) are filtered OUT for normal users — exposing them as
// chips with zero hits was a misleading "fake filter". The schema
// enum still includes them so enterprise callers can opt in by
// passing them in the query string directly.
const DOCUMENT_TYPES: DocumentType[] = [
  "EVIDENCE",
  "CASE",
  "REPORT",
  "PACKAGE",
  "NOTE",
];

const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  EVIDENCE: "Evidence",
  CASE: "Case",
  REPORT: "Report",
  PACKAGE: "Package",
  NOTE: "Note",
  // Enterprise types — kept for type safety, never shown as a chip
  // because they are not in the personal DOCUMENT_TYPES list above.
  WORKFLOW: "Workflow",
  WORKFLOW_STEP: "Workflow step",
  REVIEW_EVENT: "Review event",
  AUDIT_EVENT: "Audit event",
  COMMUNICATION: "Communication",
  CASE_TIMELINE: "Case timeline",
  INCIDENT: "Incident",
};

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
  // Phase SEARCH-REMEDIATION — terminology hook is no longer
  // consumed by the search heading (which is now plain "Search").
  // Kept as a `void` reference so removing the hook is a deliberate
  // future change rather than a lint-driven side effect.
  void useTerminology;
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
  // Phase SEARCH-REMEDIATION-3 — `isAdmin` is no longer consumed
  // by the search page because the truthful empty state replaced
  // the `NoResultsHelp` component (which used it to gate a
  // "Try semantic search" link). Kept as a `void` reference so
  // removing the activeSpace hook stays a deliberate change.
  const isAdmin =
    activeSpace?.type === "ORGANIZATION"
      ? activeSpace.roleLabel === "OWNER" || activeSpace.roleLabel === "ADMIN"
      : activeSpace?.type === "PERSONAL";
  void isAdmin;
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
  // Phase SEARCH-REMEDIATION-3 — `canSeeIntegrations` is no longer
  // consumed by the search page (NoResultsHelp was removed). Kept
  // as a `void` reference so removing the surface-context hook
  // stays an explicit, reviewed change.
  const canSeeIntegrations = canAccessSurface(
    surfaceUserCtx,
    "/integrations",
  );
  void canSeeIntegrations;
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
  // Search-page-final-cleanup (C) — date inputs go through a draft
  // buffer so a partially-typed value doesn't fire a search request
  // per keystroke. The Apply Filters button below the filter rail
  // pushes the draft into the live filter envelope (which is what
  // triggers the search). Chip / toggle / select filters still
  // auto-apply on change — only the two `datetime-local` inputs
  // batch.
  // Strings are kept in the input's native `datetime-local` format
  // (yyyy-MM-ddTHH:mm); converted to ISO on apply.
  const [dateSinceDraft, setDateSinceDraft] = useState<string>("");
  const [dateUntilDraft, setDateUntilDraft] = useState<string>("");
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
  // Search-page-final-cleanup (A) — the admin health chip is
  // DEFAULT-HIDDEN even for platform admins. Support only opts in
  // by appending `?_debug=search-health` to the URL. This means
  // the dev/admin who normally signs into a Personal workspace
  // sees the same clean chrome as a Personal/SMB user. The chip
  // returns only when (a) the user is platform-admin AND (b) the
  // opt-in flag is present in the URL. The empty-index user-safe
  // message (rendered for everyone when search is genuinely
  // blocking) is unaffected by the flag.
  const [searchHealthDebugOptIn, setSearchHealthDebugOptIn] =
    useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      setSearchHealthDebugOptIn(
        url.searchParams.get("_debug") === "search-health",
      );
    } catch {
      setSearchHealthDebugOptIn(false);
    }
  }, []);
  // Search-page-final-cleanup (C) — sync date drafts when the
  // live filter envelope changes from somewhere OTHER than the
  // local input (e.g. loading a saved view, deep link with
  // updatedSinceUtc, Clear filters). Converting ISO →
  // datetime-local format means slicing to "yyyy-MM-ddTHH:mm".
  useEffect(() => {
    if (!filter) return;
    setDateSinceDraft(filter.updatedSinceUtc?.slice(0, 16) ?? "");
    setDateUntilDraft(filter.updatedUntilUtc?.slice(0, 16) ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter?.updatedSinceUtc, filter?.updatedUntilUtc]);
  // Search-runtime-diagnostics — workspace-scoped health envelope used
  // to render explicit empty-state copy ("Search index preparing",
  // "Workspace has no records yet") instead of a misleading
  // "0 results" when the underlying cause is API down / empty index /
  // wrong workspace. One fetch per teamId. Missing endpoint (older
  // backend) collapses to null and the page falls back to the legacy
  // empty-state branches.
  const [searchHealth, setSearchHealth] = useState<SearchDiagnostics | null>(
    null,
  );
  const [searchHealthError, setSearchHealthError] = useState<boolean>(false);

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

  // Search-runtime-diagnostics — workspace-scoped health envelope.
  // Used to render explicit empty-state copy ("Search index
  // preparing", "Workspace has no records yet") when the cause of
  // an empty result is NOT "no matching rows". A 404 (older
  // backend) or any other failure collapses to null +
  // searchHealthError=true so the page degrades to the legacy
  // empty-state branches.
  //
  // Refetch trigger surface — runs on:
  //   1. teamId change (workspace switch),
  //   2. explicit reloadHealth() invocation from the search-result
  //      handler when reality (rows returned) contradicts the
  //      cached health (chip says "empty_index" but rows came
  //      back). Without that second trigger the chip stays stuck
  //      on "Search index preparing (0/N)" forever after a
  //      backfill — the bug that motivated this fix.
  // Search-runtime-diagnostics — passing `q` makes the backend run
  // the same OR-over-(title/subtitle/summary/searchableText)
  // probe-query the main `/v1/search` route would, returning the
  // per-type `matchedByType` envelope. The frontend uses that to
  // render truthful copy when a filter narrows results — e.g. when
  // the Evidence filter returns 0 but REPORT/PACKAGE rows DID
  // match the same query, the empty-state branch can say so
  // explicitly instead of generic "No matches".
  const reloadHealth = useCallback(
    (probeQuery?: string) => {
      if (!teamId) return;
      setSearchHealthError(false);
      const params = new URLSearchParams({ teamId });
      const trimmed = probeQuery?.trim() ?? "";
      if (trimmed.length > 0) params.set("q", trimmed.slice(0, 200));
      apiFetch(`/v1/search/diagnostics?${params.toString()}`, {
        method: "GET",
      })
        .then((r: SearchDiagnostics) => {
          setSearchHealth(r);
        })
        .catch(() => {
          setSearchHealth(null);
          setSearchHealthError(true);
        });
    },
    [teamId],
  );

  useEffect(() => {
    reloadHealth();
  }, [reloadHealth]);

  // Run query on filter change.
  useEffect(() => {
    if (!filter) return;
    let cancelled = false;
    setLoading(true);
    runSearch(filter)
      .then((r) => {
        if (cancelled) return;
        // Search-runtime-diagnostics — harden against malformed /
        // empty 200 responses. `apiFetch` returns `null` when the
        // server sends a non-JSON 200 (e.g. a reverse-proxy HTML
        // error page), and an old backend could in theory respond
        // with a JSON body missing `rows`. Both used to silently land
        // in the "0 results" empty-state branch. Treat both as
        // explicit transport errors so the user sees the
        // "Search is temporarily unavailable" copy instead.
        if (
          !r ||
          typeof r !== "object" ||
          !Array.isArray((r as SearchResponse).rows)
        ) {
          throw Object.assign(
            new Error("Malformed response from search API"),
            { code: "MALFORMED_RESPONSE" },
          );
        }
        setResults(r);
        setError(null);
        if (!r.rows.find((x) => x.documentId === selected?.documentId)) {
          setSelected(r.rows[0] ?? null);
        }
        // Search-runtime-diagnostics — reality wins over stale
        // chip + truthful per-type empty-state.
        //
        // Two reasons to refetch diagnostics here:
        //
        //   (a) Reality wins. If the search returned rows but the
        //       cached health envelope claims the index is empty /
        //       preparing, the diagnostics fetch ran before a
        //       backfill landed and is now stale — refresh so the
        //       chip recovers to "Ready" instead of "0/N preparing".
        //
        //   (b) queryProbe freshness. The empty-state branch
        //       wants the per-type match counts for the CURRENT
        //       query so it can say "No EVIDENCE matched — but
        //       REPORTs/PACKAGEs did" instead of generic copy. We
        //       refetch on every search with the current q so the
        //       envelope has matchedByType for the right query.
        const cachedProbeQ = searchHealth?.queryProbe?.q ?? null;
        const probeStale =
          (filter.q ?? "").trim().length > 0 && cachedProbeQ !== filter.q;
        const realityOverride =
          r.rows.length > 0 &&
          searchHealth &&
          (searchHealth.health === "empty_index" ||
            searchHealth.health === "empty_workspace");
        if (probeStale || realityOverride) {
          reloadHealth(filter.q);
        }
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Search failed." }).message);
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

  // Phase SEARCH-REMEDIATION-2 — recent searches in localStorage
  // (per-browser, per-workspace). Up to 10 entries, most-recent
  // first. Surfaced under the focused empty-query search box and
  // pushed on every successful submit. No backend round-trip; the
  // backend search audit log keeps the real history for ops.
  const recentKey = `proovra:search:recent:${teamId}`;
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(recentKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (
        Array.isArray(parsed) &&
        parsed.every((v): v is string => typeof v === "string")
      ) {
        setRecent(parsed.slice(0, 10));
      }
    } catch {
      /* localStorage may be disabled; fall back to no recents */
    }
  }, [recentKey]);
  const pushRecent = useCallback(
    (q: string) => {
      if (typeof window === "undefined") return;
      const trimmed = q.trim();
      if (trimmed.length === 0) return;
      const next = [trimmed, ...recent.filter((r) => r !== trimmed)].slice(0, 10);
      setRecent(next);
      try {
        window.localStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
    },
    [recent, recentKey],
  );
  const clearRecent = useCallback(() => {
    setRecent([]);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(recentKey);
    } catch {
      /* non-fatal */
    }
  }, [recentKey]);

  const submitQuery = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = qDraft.trim().slice(0, 200);
      updateFilter({ q: trimmed.length > 0 ? trimmed : undefined });
      pushRecent(trimmed);
    },
    [qDraft, updateFilter, pushRecent]
  );

  // Search-page-final-cleanup (C) — date drafts → live filter.
  // Apply pushes both date drafts (Since + Until) into the live
  // filter envelope, which triggers the search-result effect.
  // datetime-local string format ("yyyy-MM-ddTHH:mm") → ISO via
  // new Date(...).toISOString(). Empty draft → undefined (the
  // filter dimension is cleared on the wire).
  const applyDraftFilters = useCallback(() => {
    const sinceISO = dateSinceDraft
      ? new Date(dateSinceDraft).toISOString()
      : undefined;
    const untilISO = dateUntilDraft
      ? new Date(dateUntilDraft).toISOString()
      : undefined;
    updateFilter({
      updatedSinceUtc: sinceISO,
      updatedUntilUtc: untilISO,
    });
  }, [dateSinceDraft, dateUntilDraft, updateFilter]);

  // Search-page-final-cleanup (C) — Clear filters wipes every
  // narrowing dimension (document type, evidence kind, lifecycle
  // toggles, dates) AND the local date drafts. The free-text
  // query is preserved — the user just narrowed the wrong way,
  // they didn't necessarily change their mind about what they're
  // looking for. Cursor + sort + limit are also preserved.
  const clearNarrowingFilters = useCallback(() => {
    if (!filter) return;
    setDateSinceDraft("");
    setDateUntilDraft("");
    updateFilter({
      documentTypes: undefined,
      evidenceTypes: undefined,
      workflowStatuses: undefined,
      reviewStatuses: undefined,
      onLegalHold: undefined,
      exportRestricted: undefined,
      incidentLinked: undefined,
      workflowLinked: undefined,
      contributorScoped: undefined,
      updatedSinceUtc: undefined,
      updatedUntilUtc: undefined,
    });
  }, [filter, updateFilter]);

  // Search-page-final-cleanup (C) — dirty detector. The Apply
  // button only enables when a date draft differs from the live
  // filter (so the button is meaningful — clicking it when both
  // match is a no-op anyway). Date-only because chips already
  // auto-apply on change.
  const dateDraftDirty =
    (filter?.updatedSinceUtc?.slice(0, 16) ?? "") !== dateSinceDraft ||
    (filter?.updatedUntilUtc?.slice(0, 16) ?? "") !== dateUntilDraft;
  // Clear button visibility — anything narrowing is active or any
  // date draft is non-empty.
  const filtersNonEmpty =
    (filter ? hasNarrowingFilters(filter) : false) ||
    dateSinceDraft.length > 0 ||
    dateUntilDraft.length > 0;

  // Phase SEARCH-REMEDIATION-2 — type-ahead suggestions. Debounced
  // 250ms. Only fetched when the input has ≥2 chars. Results live
  // beside the search box; keyboard handlers cover ArrowUp/Down,
  // Enter (commits the highlighted suggestion's title as the
  // query), and Escape (closes the dropdown).
  type Suggestion = {
    id: string;
    documentType: DocumentType;
    sourceId: string;
    title: string;
    subtitle: string | null;
    evidenceId: string | null;
    caseId: string | null;
  };
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  useEffect(() => {
    if (!teamId) return;
    const trimmed = qDraft.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const res = (await apiFetch(
          `/v1/search/suggest?teamId=${encodeURIComponent(teamId)}&q=${encodeURIComponent(
            trimmed,
          )}`,
          { signal: ctrl.signal },
        )) as { suggestions: Suggestion[] };
        setSuggestions(res.suggestions ?? []);
        setHighlighted(-1);
      } catch {
        // Aborted or network — silently clear; the empty list
        // renders nothing and the user can still type.
        setSuggestions([]);
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [qDraft, teamId]);

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
        setError(toSafeUserError(err, { message: "Search failed." }).message)
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
        toSafeUserError(err, { message: "Could not save view." }).message
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
          toSafeUserError(err, { message: "Could not delete view." }).message
        );
      }
    },
    [teamId]
  );

  // Phase SEARCH-REMEDIATION-3 — rename a saved view via the new
  // PATCH endpoint. Uses a native prompt for the smallest viable
  // UI (the saved-view rail already shows the view inline; adding
  // a modal would be heavier than the operator needs). The backend
  // validates name length + creator identity.
  const renameSavedView = useCallback(
    async (id: string, currentName: string) => {
      if (!teamId) return;
      if (typeof window === "undefined") return;
      const next = window.prompt("Rename saved view", currentName);
      if (next == null) return;
      const trimmed = next.trim();
      if (trimmed.length === 0 || trimmed === currentName) return;
      try {
        const res = (await apiFetch(
          `/v1/search/saved-views/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ teamId, name: trimmed }),
          },
        )) as { view: SavedView };
        setSavedViews((prev) =>
          prev
            ? prev.map((v) => (v.id === id ? { ...v, name: res.view.name } : v))
            : prev,
        );
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not rename view." }).message,
        );
      }
    },
    [teamId],
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
        toSafeUserError(err, { message: "Could not run dry run. The semantic backfill endpoint may not be available on this deployment." }).message,
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
     <PageShell width="full" style={pageShellStyle}>
      <PageHeader
        title={
          // Phase 7C — the single semantic <h1> is now owned by the
          // shared PageHeader. The pinned `data-search-title` contract
          // hook rides on this inner <span> so the attribute stays in
          // the DOM for end-to-end probes without nesting a second
          // <h1>. `titleStyle` is applied here so the heading keeps its
          // exact typographic treatment inside PageHeader's h1.
          <span style={titleStyle} data-search-title>
            Search
          </span>
        }
        subtitle="Search evidence, cases, reports, notes and OCR text across this workspace. Results respect visibility and governance."
        primaryAction={
          <form
            onSubmit={submitQuery}
            style={searchFormStyle}
            data-search-form
          >
            <div className="cases-search-field" style={{ position: "relative", flex: 1 }}>
              {/* Canonical leading search icon (indigo-focus field). */}
              <span className="cases-search-icon" aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <input
                value={qDraft}
                onChange={(e) => setQDraft(e.target.value)}
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => {
                  // Delay close so a mousedown on a suggestion fires
                  // before the dropdown unmounts.
                  window.setTimeout(() => setSuggestOpen(false), 120);
                }}
                onKeyDown={(e) => {
                  if (!suggestOpen) return;
                  const items = qDraft.trim().length < 2 ? recent : suggestions;
                  if (items.length === 0) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlighted((h) => Math.min(items.length - 1, h + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlighted((h) => Math.max(0, h - 1));
                  } else if (e.key === "Enter" && highlighted >= 0) {
                    e.preventDefault();
                    const pick = items[highlighted];
                    const text =
                      typeof pick === "string" ? pick : pick.title;
                    setQDraft(text);
                    setSuggestOpen(false);
                    updateFilter({ q: text });
                    pushRecent(text);
                  } else if (e.key === "Escape") {
                    setSuggestOpen(false);
                  }
                }}
                placeholder="Search evidence, cases, reports, notes, OCR text…"
                className="cases-filter-search"
                style={searchInputStyle}
                maxLength={200}
                aria-label="Search query"
                aria-autocomplete="list"
                aria-expanded={suggestOpen}
                data-search-input
              />
              {suggestOpen ? (
                <SearchTypeahead
                  query={qDraft}
                  suggestions={suggestions}
                  recent={recent}
                  highlighted={highlighted}
                  onPick={(text) => {
                    setQDraft(text);
                    setSuggestOpen(false);
                    updateFilter({ q: text });
                    pushRecent(text);
                  }}
                  onClearRecent={clearRecent}
                />
              ) : null}
            </div>
            <Button type="submit" variant="primary">
              Search
            </Button>
          </form>
        }
        contextStrip={
          <>
          {/* Phase 15/16 — semantic-search status chip.
              Search-runtime-diagnostics: the chip exposes internal
              ranking-mode mechanics ("Hybrid semantic search active",
              "fell back to keyword", "semantic disabled"). That copy
              is developer / operator language and erodes trust for
              Personal/SMB users — it must NOT render outside the
              platform-admin surface. We gate on the canonical
              `isPlatformAdmin` envelope flag (the same flag the
              backfill panel already uses), so a non-admin user sees
              the clean chrome and only the workspace health chip
              from the diagnostics endpoint. */}
          {isPlatformAdmin ? (
            <SemanticStatusChip
              semanticEnabled={semanticEnabled}
              semanticAvailable={semanticAvailable}
              requestedMode={effectiveMode}
              modeUsed={modeUsed}
              fallbackReason={fallbackReason}
              statusEndpointAvailable={semanticStatus !== null}
            />
          ) : null}
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
          {/* Search-runtime-diagnostics — two distinct render paths:
              -- NORMAL USERS (Personal/SMB) --
                Render NOTHING in the healthy / partial_index /
                empty_workspace branches. The numeric "X records
                indexed" was an operator/debug counter and confused
                users into thinking their workspace was broken when
                the search was actually fine. Show a chip ONLY when
                indexing is genuinely blocking search — `empty_index`
                with NO results returned by the current query — and
                even then surface user-safe copy ("Search is being
                set up"), no numbers, no DB tooltip.
              -- ADMIN USERS --
                Render the full chip with the per-state breakdown
                (evidenceIndexable, archived/locked counts, plus the
                three excluded counts). This is the operator surface
                that explains the delta between indexedEvidence and
                evidenceIndexable. Gated on `isPlatformAdmin`.
              Reality-wins guard still applies: in either render
              path, if the current search returned rows, the cached
              empty-index or preparing copy is suppressed. */}
          {searchHealth ? (
            (() => {
              const realityOverrides =
                results &&
                results.rows.length > 0 &&
                (searchHealth.health === "empty_index" ||
                  searchHealth.health === "empty_workspace");
              const effectiveHealth = realityOverrides
                ? "healthy"
                : searchHealth.health;
              // Search-page-final-cleanup (A) — by default NO
              // user sees the numeric/diagnostic chip in normal
              // states. Two surfaces still render:
              //   (i)  empty_index AND no results visible — the
              //        chip is genuinely user-blocking; even
              //        non-admins should see the bounded
              //        "Search is being set up" message.
              //   (ii) platform-admin AND `?_debug=search-health`
              //        opted in via URL — the full diagnostic
              //        breakdown for support work.
              // Everything else collapses to `null`.
              const userBlocking = effectiveHealth === "empty_index";
              const supportOptIn =
                isPlatformAdmin && searchHealthDebugOptIn;
              if (!supportOptIn && !userBlocking) return null;
              if (!supportOptIn) {
                // User-facing blocking message — same copy + same
                // gating regardless of role. Numbers / DB tooltip
                // are deliberately omitted.
                return (
                  <Badge
                    tone="risk"
                    subtle
                    style={{ marginTop: 8 }}
                    data-search-health="empty_index"
                    data-search-health-audience="user"
                  >
                    Search is being set up. Try again in a moment.
                  </Badge>
                );
              }
              // Support/admin path — opt-in only. Full breakdown,
              // numbers included.
              const breakdown = searchHealth.index.breakdown;
              const adminToneMap: Record<string, BadgeTone> = {
                healthy: "verified",
                partial_index: "pending",
                empty_index: "risk",
                empty_workspace: "neutral",
              };
              const adminTone: BadgeTone =
                adminToneMap[effectiveHealth] ?? "neutral";
              return (
                <Badge
                  tone={adminTone}
                  subtle
                  style={{ marginTop: 8 }}
                  data-search-health={effectiveHealth}
                  data-search-health-audience="admin"
                  data-search-health-cached={searchHealth.health}
                  data-search-health-reality-overrides={
                    realityOverrides ? "true" : "false"
                  }
                  data-search-health-workspace-id={searchHealth.workspace.id}
                  data-search-health-workspace-name={
                    searchHealth.workspace.name ?? ""
                  }
                  data-search-health-evidence-indexable={
                    breakdown?.evidenceIndexable ??
                    searchHealth.index.evidenceTotal
                  }
                  data-search-health-evidence-indexed={
                    searchHealth.index.evidenceIndexed
                  }
                  data-search-health-active-included={
                    breakdown?.activeIncluded ?? 0
                  }
                  data-search-health-archived-included={
                    breakdown?.archivedIncluded ?? 0
                  }
                  data-search-health-locked-included={
                    breakdown?.lockedIncluded ?? 0
                  }
                  data-search-health-trashed-included={
                    breakdown?.trashedIncluded ?? 0
                  }
                  data-search-health-destroyed-excluded={
                    breakdown?.destroyedExcluded ?? 0
                  }
                  data-search-health-pending-destruction-excluded={
                    breakdown?.pendingDestructionExcluded ?? 0
                  }
                  title={renderAdminChipTooltip(searchHealth)}
                >
                  <strong>
                    {searchHealth.workspace.name ?? "Workspace"}
                  </strong>{" "}
                  ·{" "}
                  {effectiveHealth === "healthy"
                    ? realityOverrides
                      ? "Ready"
                      : `${searchHealth.index.evidenceIndexed} indexed`
                    : effectiveHealth === "partial_index"
                      ? `${searchHealth.index.evidenceIndexed}/${searchHealth.index.evidenceTotal} indexed (catching up)`
                      : effectiveHealth === "empty_index"
                        ? `Search index preparing (0/${searchHealth.index.evidenceTotal})`
                        : `Workspace has 0 indexable records`}
                </Badge>
              );
            })()
          ) : searchHealthError &&
            isPlatformAdmin &&
            searchHealthDebugOptIn ? (
            <Badge
              tone="neutral"
              subtle
              style={{ marginTop: 8 }}
              data-search-health="unknown"
              data-search-health-audience="admin"
            >
              Search index status unavailable
            </Badge>
          ) : null}
          </>
        }
      />

      {/* Phase 38.18 — workflow-aware contextual help, collapsed by
          default so the search results stay primary. */}
      <ContextualHelp
        workflow={searchWorkflowCode}
        surface="search"
        collapsedByDefault
      />

      {error ? (
        <Card variant="status" tone="risk" padding="compact" style={{ marginTop: 12 }}>
          <span style={{ fontSize: 13, color: "var(--status-risk-fg, #991b1b)" }}>
            {error}
          </span>
        </Card>
      ) : null}

      <div style={threeColStyle}>
        {/* ----------------------------- LEFT ----------------------------- */}
        <Card variant="summary" padding="compact" style={leftRailStyle}>
          <FilterSection label="Sort">
            <select
              value={filter.sort ?? "UPDATED_DESC"}
              onChange={(e) =>
                updateFilter({ sort: e.target.value as SortMode })
              }
              className="cases-form-input"
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
                    data-search-type-chip={t}
                  >
                    {DOCUMENT_TYPE_LABEL[t]}
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
            {/* Search-page-final-cleanup (C) — date inputs are
                draft-backed. Typing/clearing the picker writes
                only to the local draft string; the live filter
                envelope is unchanged until the user clicks Apply
                filters (sticky panel below). Datetime-local
                keystrokes used to fire a search per partial value
                — annoying + wasteful + sometimes invalid. */}
            <label style={fieldLabelStyle}>
              Since
              <input
                type="datetime-local"
                value={dateSinceDraft}
                onChange={(e) => setDateSinceDraft(e.target.value)}
                data-search-filter-date-since-input="true"
                className="cases-form-input"
                style={inputStyle}
              />
            </label>
            <label style={fieldLabelStyle}>
              Until
              <input
                type="datetime-local"
                value={dateUntilDraft}
                onChange={(e) => setDateUntilDraft(e.target.value)}
                data-search-filter-date-until-input="true"
                className="cases-form-input"
                style={inputStyle}
              />
            </label>
          </FilterSection>

          {/* Search-page-final-cleanup (C) — sticky Apply/Clear
              panel. Apply is the only way to push date drafts
              into the live filter envelope (chips auto-apply on
              their own). Clear wipes every narrowing dimension
              including dates. Free-text query is preserved by
              both. The panel only renders when something can be
              applied or cleared — keeps the rail uncluttered for
              the no-filter case. */}
          {(dateDraftDirty || filtersNonEmpty) ? (
            <div
              style={filterApplyPanelStyle}
              data-search-filter-apply-panel="true"
            >
              <Button
                variant="primary"
                size="sm"
                onClick={applyDraftFilters}
                disabled={!dateDraftDirty}
                data-search-filter-apply="true"
              >
                Apply filters
              </Button>
              {filtersNonEmpty ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={clearNarrowingFilters}
                  data-search-filter-clear="true"
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Saved views — operator surface only. The Personal/SMB
              search experience is intentionally one input box + the
              filter rail; persisted views add visual clutter and
              imply an enterprise workflow Personal users do not run.
              Gate on the same `isPlatformAdmin` flag the semantic
              chip + backfill panel already use, so the backend
              saved-search routes stay intact (and enterprise users
              keep their workflow). When the gate hides the section
              the GET /v1/search/saved-views fetch above continues to
              run silently so a future plan upgrade does not require
              a refresh to populate the list. */}
          {isPlatformAdmin ? (
            <FilterSection label="Saved views">
              <Button
                variant="secondary"
                size="sm"
                onClick={saveCurrentView}
                disabled={savingView}
                loading={savingView}
              >
                {savingView ? "Saving…" : "Save current view"}
              </Button>
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
                        onClick={() => renameSavedView(v.id, v.name)}
                        style={iconButtonStyle}
                        aria-label="Rename saved view"
                        data-search-saved-view-rename={v.id}
                        title="Rename"
                      >
                        ✎
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
          ) : null}
        </Card>

        {/* ----------------------------- CENTER ----------------------------- */}
        <Card variant="summary" padding="compact" style={centerColStyle}>
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
            <div
              className="cases-empty"
              style={emptyStateStyle}
              data-search-empty-state
              data-search-empty-state-filters-active={
                hasNarrowingFilters(filter) ? "true" : "false"
              }
            >
              {loading ? (
                <div data-search-empty-state-kind="loading">Searching…</div>
              ) : error ? (
                // Phase SEARCH-REMEDIATION-3 — distinct error state.
                // Never surface the raw `error` string (which may
                // carry a stack frame); always show the bounded copy.
                <div data-search-empty-state-kind="error">
                  <strong>Search is temporarily unavailable</strong>
                  <p style={{ marginTop: 6 }}>
                    Try again. If this continues, contact support.
                  </p>
                </div>
              ) : !filter?.q ? (
                // Phase SEARCH-REMEDIATION-3 — no query yet. Replaces
                // the legacy "0 results" placeholder for the
                // first-paint state where the user hasn't typed yet.
                <div data-search-empty-state-kind="idle">
                  <strong>Start searching</strong>
                  <p style={{ marginTop: 6 }}>
                    Search evidence, cases, reports, packages, notes,
                    OCR text and transcripts when available.
                  </p>
                </div>
              ) : hasNarrowingFilters(filter) ? (
                // Search-filter-audit — when a non-trivial filter is
                // active (document type, evidence kind, status,
                // dates, etc.) and the result set is empty, the cause
                // is "the filter narrowed everything away", NOT "the
                // workspace is empty" or "the index is preparing".
                //
                // Per-type truthful copy:
                //   When the user has selected one or more document
                //   types AND the diagnostics queryProbe reports
                //   that OTHER types DID match the same query,
                //   render an explicit "selected types had no
                //   matches — but other types did" message naming
                //   the matching types. Drives the user to clear
                //   the type filter instead of doubting search.
                //
                //   When queryProbe is unavailable (older backend,
                //   never fetched) or every type matched 0, fall
                //   back to the generic clear-filters hint.
                (() => {
                  const hint = describeFilterEmpty(filter, searchHealth);
                  return (
                    <div data-search-empty-state-kind="no-match-filtered">
                      <strong>
                        {hint.headline}
                        {searchHealth?.workspace?.name
                          ? ` in "${searchHealth.workspace.name}"`
                          : ""}
                      </strong>
                      <p style={{ marginTop: 6 }}>{hint.detail}</p>
                    </div>
                  );
                })()
              ) : searchHealth?.health === "empty_workspace" ? (
                // Search-runtime-diagnostics — the workspace itself
                // has no evidence yet. Searching anything will return
                // 0, but the cause is "no records exist in this
                // workspace", not "your query didn't match." Distinct
                // copy + a hint to switch workspaces if the user
                // expected records here.
                <div data-search-empty-state-kind="empty-workspace">
                  <strong>
                    Workspace
                    {searchHealth.workspace.name
                      ? ` "${searchHealth.workspace.name}"`
                      : ""}{" "}
                    has no records yet
                  </strong>
                  <p style={{ marginTop: 6 }}>
                    Add evidence, cases, reports, packages, or notes —
                    or switch to a workspace that has them. The
                    current workspace contains 0 records.
                  </p>
                </div>
              ) : searchHealth?.health === "empty_index" ? (
                // Search-runtime-diagnostics — workspace has records
                // but the search index is empty (lifecycle hook never
                // ran, or backfill not started). Distinct copy so the
                // user understands the records exist; they just
                // aren't searchable yet.
                <div data-search-empty-state-kind="empty-index">
                  <strong>Search index is preparing</strong>
                  <p style={{ marginTop: 6 }}>
                    This workspace has {searchHealth.index.evidenceTotal}{" "}
                    records, but none have been indexed yet. Indexing
                    runs automatically; reload in a moment. If this
                    persists, contact support.
                  </p>
                </div>
              ) : searchHealth?.health === "partial_index" ? (
                // Search-runtime-diagnostics — backfill in progress.
                // The user MAY get 0 results because their record
                // hasn't been indexed yet. Tell them so.
                <div data-search-empty-state-kind="partial-index">
                  <strong>No matching results yet</strong>
                  <p style={{ marginTop: 6 }}>
                    Search index is still catching up
                    ({searchHealth.index.evidenceIndexed} of{" "}
                    {searchHealth.index.evidenceTotal} records indexed).
                    Reload in a moment if you expected a recent
                    record.
                  </p>
                </div>
              ) : (
                // Search-runtime-diagnostics — fully indexed, query
                // truly has no hits in THIS workspace. Surface the
                // workspace name so a wrong-workspace mistake is
                // visible.
                <div data-search-empty-state-kind="no-match">
                  <strong>
                    No matches
                    {searchHealth?.workspace?.name
                      ? ` in "${searchHealth.workspace.name}"`
                      : ""}
                  </strong>
                  <p style={{ marginTop: 6 }}>
                    Try a different filename, case name, report title,
                    note, or record ID.
                  </p>
                  {searchHealth?.workspace?.name ? (
                    <p style={{ marginTop: 6 }}>
                      Or switch workspace if the record lives elsewhere.
                    </p>
                  ) : null}
                </div>
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
                  <div
                    style={resultRowHeaderStyle}
                    data-search-result-row={row.documentType}
                  >
                    <Badge
                      tone={docTypeTone(row.documentType)}
                      data-search-result-type={row.documentType}
                    >
                      {DOCUMENT_TYPE_LABEL[row.documentType] ?? row.documentType}
                    </Badge>
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
                          <Badge
                            key={b}
                            tone={badgeTone(b)}
                            subtle
                            data-search-result-badge={b}
                          >
                            {renderBadgeLabel(b)}
                          </Badge>
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
            <Button
              variant="secondary"
              onClick={loadMore}
              disabled={loading}
              loading={loading}
              fullWidth
              style={{ marginTop: 12 }}
            >
              {loading ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </Card>

        {/* ----------------------------- RIGHT ----------------------------- */}
        <Card variant="summary" padding="comfortable" style={rightRailStyle}>
          {!selected ? (
            // Phase SEARCH-REMEDIATION-3 — the empty preview no
            // longer wastes the right rail. Instead it shows the
            // user's recent searches, saved views, and tips. Clicks
            // re-run the query inline; the rail stays useful even
            // before a row is selected.
            <PreviewDefault
              recent={recent}
              savedViews={savedViews}
              onPickRecent={(q) => {
                setQDraft(q);
                updateFilter({ q });
              }}
              onPickSaved={(v) => applySavedView(v)}
              onClearRecent={clearRecent}
            />
          ) : (
            <Inspector
              row={selected}
              relationships={relationships}
              teamId={teamId}
              canSeeWorkflows={canSeeWorkflows}
              canSeeInvestigation={canSeeInvestigation}
            />
          )}
        </Card>
      </div>
     </PageShell>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Inspector
// -----------------------------------------------------------------------------

/**
 * Resolve the canonical destination URL + label for a search result
 * row's primary "Open …" action. The button mirrors the click target
 * that a user would expect for that document type — evidence detail
 * for evidence-anchored types (EVIDENCE / REPORT / PACKAGE), case
 * detail for case-anchored types (CASE / NOTE). Returns null when the
 * row carries neither an evidenceId nor a caseId (defensive — every
 * canonical projection writes one or the other, but the inspector
 * must not render a dead button if the API ever omits both).
 */
/**
 * Search-inclusion-audit — render a friendly user-facing label for
 * a backend badge code. Keeps the wire (lowercase, snake-case) in
 * sync with operator/admin tooling while the UI uses plain English.
 * For backend tokens not in the map, fall back to the raw token
 * (the rendered chip text is bounded by the allowed-badge catalog
 * anyway).
 */
// Phase 7C — map the search page's document-type + backend-badge
// vocabularies onto the shared Badge tone set. Presentation only; the
// wire tokens (data-search-result-type / data-search-result-badge)
// are preserved unchanged on every chip.
function docTypeTone(type: DocumentType): BadgeTone {
  switch (type) {
    case "EVIDENCE":
      return "info";
    case "CASE":
    case "CASE_TIMELINE":
      return "info";
    case "REPORT":
    case "REVIEW_EVENT":
      return "pending";
    case "PACKAGE":
    case "AUDIT_EVENT":
      return "governance";
    case "NOTE":
    case "COMMUNICATION":
      return "neutral";
    case "WORKFLOW":
      return "info";
    case "WORKFLOW_STEP":
      return "verified";
    case "INCIDENT":
      return "risk";
    default:
      return "neutral";
  }
}

function badgeTone(badge: string): BadgeTone {
  switch (badge) {
    case "legal-hold":
    case "governance-restricted":
    case "incident-linked":
      return "risk";
    case "export-restricted":
    case "review-linked":
      return "pending";
    case "visibility-restricted":
      return "governance";
    case "contributor-scoped":
      return "verified";
    case "workflow-linked":
    case "integrity record":
      return "info";
    case "communication-linked":
      return "pending";
    default:
      return "neutral";
  }
}

function renderBadgeLabel(badge: string): string {
  switch (badge) {
    case "in_trash":
      return "In trash";
    case "archived":
      return "Archived";
    case "locked":
      return "Locked";
    case "legal-hold":
      return "Legal hold";
    case "export-restricted":
      return "Export-restricted";
    case "workflow-linked":
      return "Workflow-linked";
    case "review-linked":
      return "Review-linked";
    case "contributor-scoped":
      return "Contributor-scoped";
    case "visibility-restricted":
      return "Visibility-restricted";
    case "governance-restricted":
      return "Governance-restricted";
    case "incident-linked":
      return "Incident-linked";
    case "communication-linked":
      return "Communication-linked";
    case "integrity record":
      return "Integrity record";
    case "matched metadata":
      return "Matched metadata";
    case "related evidence":
      return "Related evidence";
    default:
      return badge;
  }
}

function getOpenAction(
  row: ResultRow,
): { href: string; label: string } | null {
  // Search-inclusion-audit (trash decision): soft-deleted
  // (`in_trash`) result rows route to the SAME evidence detail
  // URL with `?context=trash` appended. The label changes to
  // "Open in trash" so the user knows the destination is a
  // read-only / restore-only surface and normal mutations are
  // gated. The detail page itself is responsible for honoring
  // the query param (separate ticket — that's where mutation
  // gating lives). The badge on the row already signals trash
  // state so the link decoration matches the row state.
  const isInTrash = row.badges.includes("in_trash");
  const trashSuffix = isInTrash ? "?context=trash" : "";
  switch (row.documentType) {
    case "EVIDENCE":
      return row.evidenceId
        ? {
            href: `/evidence/${row.evidenceId}${trashSuffix}`,
            label: isInTrash ? "Open in trash" : "Open evidence",
          }
        : null;
    case "CASE":
      return row.caseId
        ? {
            href: `/cases/${row.caseId}${trashSuffix}`,
            label: isInTrash ? "Open in trash" : "Open case",
          }
        : null;
    case "REPORT":
      return row.evidenceId
        ? {
            href: `/evidence/${row.evidenceId}${trashSuffix}`,
            label: isInTrash ? "Open in trash" : "Open report",
          }
        : null;
    case "PACKAGE":
      return row.evidenceId
        ? {
            href: `/evidence/${row.evidenceId}${trashSuffix}`,
            label: isInTrash ? "Open in trash" : "Open package",
          }
        : null;
    case "NOTE":
      return row.caseId
        ? {
            href: `/cases/${row.caseId}${trashSuffix}`,
            label: isInTrash ? "Open in trash" : "Open note",
          }
        : null;
    default:
      return null;
  }
}

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
  // Inspector primary action — every result type now exposes a
  // single "Open …" button right under the title. Previously the
  // only way to navigate to the underlying record was to click one
  // of the monospaced UUIDs under "Pointers", which read as
  // developer surface and confused Personal/SMB users. Pointers
  // remain as secondary technical metadata below.
  const openAction = getOpenAction(row);
  return (
    <div>
      <div style={inspectorHeaderStyle}>
        <Badge
          tone={docTypeTone(row.documentType)}
          data-search-inspector-type={row.documentType}
        >
          {DOCUMENT_TYPE_LABEL[row.documentType] ?? row.documentType}
        </Badge>
        <h2 style={inspectorTitleStyle}>{row.title}</h2>
        {row.subtitle ? (
          <p style={inspectorSubtitleStyle}>{row.subtitle}</p>
        ) : null}
        {openAction ? (
          <a
            href={openAction.href}
            style={inspectorPrimaryButtonStyle}
            data-search-open-action={row.documentType}
            data-search-open-href={openAction.href}
          >
            {openAction.label}
          </a>
        ) : null}
      </div>

      {row.badges.length > 0 ? (
        <Section label="Signals">
          <div style={badgeRowStyle}>
            {row.badges.map((b) => (
              <Badge
                key={b}
                tone={badgeTone(b)}
                subtle
                data-search-inspector-badge={b}
              >
                {renderBadgeLabel(b)}
              </Badge>
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

// Phase SEARCH-REMEDIATION — `SearchModeSelector` component
// removed. Users no longer pick a search algorithm; the backend
// chooses (and falls back gracefully when semantic is unavailable).
// The `modeUsed` field still ships in the response for admin
// diagnostics surfaces.

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
  const tone: BadgeTone =
    status === "active"
      ? "verified"
      : status === "fallback" || status === "unavailable"
        ? "pending"
        : status === "blocked"
          ? "risk"
          : "neutral";
  return (
    <Badge
      tone={tone}
      subtle
      data-semantic-search-status={status}
      style={{ marginTop: 8 }}
    >
      {label}
    </Badge>
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

// Phase SEARCH-REMEDIATION-3 — `NoResultsHelp` was deleted. The
// truthful empty-state branches in the center column now distinguish
// loading / error / idle / no-match without nagging the user about
// search-algorithm choices.

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
      <Button
        variant="secondary"
        size="sm"
        onClick={onRun}
        disabled={running}
        loading={running}
        style={{ alignSelf: "flex-start" }}
        data-action="semantic-backfill-dry-run"
      >
        {running ? "Running dry run…" : "Run backfill (dry run)"}
      </Button>
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

/**
 * Search-filter-audit — does the filter envelope carry any condition
 * BEYOND the workspace + free-text query? When this returns true the
 * empty-state surface MUST render the no-match-filtered branch
 * instead of the workspace-empty / index-empty branches; the cause
 * of a 0-row response in that case is filter narrowing, not an empty
 * index. We deliberately do NOT count `q` itself — typing a query is
 * the baseline operation, not "applying a filter".
 */
function hasNarrowingFilters(filter: FilterState | null): boolean {
  if (!filter) return false;
  if ((filter.documentTypes?.length ?? 0) > 0) return true;
  if ((filter.evidenceTypes?.length ?? 0) > 0) return true;
  if ((filter.workflowStatuses?.length ?? 0) > 0) return true;
  if ((filter.reviewStatuses?.length ?? 0) > 0) return true;
  if (filter.onLegalHold !== undefined) return true;
  if (filter.exportRestricted !== undefined) return true;
  if (filter.incidentLinked !== undefined) return true;
  if (filter.workflowLinked !== undefined) return true;
  if (filter.contributorScoped !== undefined) return true;
  if (filter.updatedSinceUtc) return true;
  if (filter.updatedUntilUtc) return true;
  return false;
}

/**
 * Search-filter-audit — render the truthful empty-state copy when a
 * filter narrowed results to zero. Inputs:
 *
 *   - `filter`: the live filter envelope. `documentTypes` is the
 *     only narrowing dimension we currently special-case for
 *     per-type copy (the user's biggest source of confusion).
 *   - `health`: the diagnostics envelope, including
 *     `queryProbe.matchedByType` for the LIVE query the user typed
 *     — populated by the search-result handler refetch above.
 *
 * Output:
 *
 *   - When the user selected one or more document types AND the
 *     queryProbe reports OTHER types matched but the SELECTED
 *     types didn't → "No <SELECTED> match. <OTHER> matched" copy
 *     so the user knows clearing the filter would surface results
 *     instead of doubting search.
 *
 *   - Otherwise → generic "No matches with the current filters,
 *     try clearing one." copy.
 *
 * Pure function — kept outside the React tree so the tests can
 * exercise the matrix without bringing up jsdom.
 */
function describeFilterEmpty(
  filter: FilterState | null,
  health: SearchDiagnostics | null,
): { headline: string; detail: string } {
  const generic = {
    headline: "No matches with the current filters",
    detail:
      "Try clearing one or more filters on the left, or broaden your query.",
  };
  if (!filter) return generic;
  const selectedTypes = filter.documentTypes ?? [];
  // Only specialise when documentTypes is the ONLY narrowing
  // filter — otherwise the per-type copy could be misleading (the
  // narrowing was a date / lifecycle flag, not the type itself).
  const onlyTypeNarrowing =
    selectedTypes.length > 0 &&
    (filter.evidenceTypes?.length ?? 0) === 0 &&
    (filter.workflowStatuses?.length ?? 0) === 0 &&
    (filter.reviewStatuses?.length ?? 0) === 0 &&
    filter.onLegalHold === undefined &&
    filter.exportRestricted === undefined &&
    filter.incidentLinked === undefined &&
    filter.workflowLinked === undefined &&
    filter.contributorScoped === undefined &&
    !filter.updatedSinceUtc &&
    !filter.updatedUntilUtc;
  const probe = health?.queryProbe;
  const queryProbeUsable =
    probe && filter.q && probe.q === filter.q ? probe : null;
  if (!onlyTypeNarrowing || !queryProbeUsable) return generic;
  // Find OTHER document types (not selected by the user) that DID
  // match the live query. If any, name them in the copy.
  const matchedOtherTypes: string[] = [];
  for (const [type, count] of Object.entries(queryProbeUsable.matchedByType)) {
    if (count > 0 && !selectedTypes.includes(type as DocumentType)) {
      matchedOtherTypes.push(type);
    }
  }
  if (matchedOtherTypes.length === 0) return generic;
  // Render the friendly labels for both sides of the contradiction.
  const selectedLabels = selectedTypes
    .map((t) => DOCUMENT_TYPE_LABEL[t] ?? t)
    .join(" / ");
  const otherLabels = matchedOtherTypes
    .map((t) => DOCUMENT_TYPE_LABEL[t as DocumentType] ?? t)
    .join(" / ");
  return {
    headline: `No ${selectedLabels} records match`,
    detail: `${otherLabels} records DID match your search — clear the type filter on the left to see them.`,
  };
}

/**
 * Admin-only chip tooltip — surfaces the full per-state breakdown
 * from the diagnostics envelope so an operator inspecting the chip
 * knows EXACTLY which evidence rows the indexer excluded and why.
 * Falls back to the runtime block (DB host + env) when the
 * breakdown is missing (older backend without the field).
 */
function renderAdminChipTooltip(health: SearchDiagnostics): string {
  const runtime = `API DB ${health.runtime.dbName ?? "(unknown)"} @ ${
    health.runtime.dbServerIp ?? "?"
  }:${health.runtime.dbServerPort ?? "?"} • ${
    health.runtime.nodeEnv ?? "?"
  }`;
  const b = health.index.breakdown;
  if (!b) return runtime;
  return [
    `Indexable evidence: ${b.evidenceIndexable}`,
    `  active:    ${b.activeIncluded}`,
    `  archived:  ${b.archivedIncluded}`,
    `  locked:    ${b.lockedIncluded}`,
    `  in trash:  ${b.trashedIncluded}`,
    `Excluded by indexer:`,
    `  destroyed:            ${b.destroyedExcluded}`,
    `  pending destruction:  ${b.pendingDestructionExcluded}`,
    `  hard-deleted:         (n/a — source row absent)`,
    ``,
    runtime,
  ].join("\n");
}

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
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

// -----------------------------------------------------------------------------
// Styles — restrained, dense, operational. No gradients.
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
  background: "#f8fafc",
  minHeight: "100vh",
};

// Phase 7B — the shared PageShell owns the content-plane padding /
// max-width / section rhythm now. The search console is a dense
// three-column operator surface, so we opt out of the max-width clamp
// (`width="full"` on the element) and keep the console's own compact
// top/side padding (20px/24px, matching the pre-migration spacing) plus
// a tighter section gap so the header + three-column grid stay close.
const pageShellStyle: React.CSSProperties = {
  paddingInline: 24,
  paddingBlock: "20px 40px",
  gap: 0,
};

const loadingScreenStyle: React.CSSProperties = {
  ...pageStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// Phase 7C — the page heading now renders inside the shared PageHeader.
// `titleStyle` is passed to the pinned `<h1 data-search-title>` so the
// contract-test element keeps its exact typographic treatment while the
// surrounding chrome (header layout, subtitle, actions row) is owned by
// PageHeader. The former bespoke `headerStyle` / `subtitleStyle` /
// `searchButtonStyle` / `errorBoxStyle` / the two chip-style helpers +
// the disabled `_semanticSearchChipStyle` baseline were removed once the
// header, buttons, error surface, and every status chip migrated to the
// shared PageHeader / Button / Card / Badge primitives.
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.2,
  letterSpacing: "-0.01em",
  color: "var(--ink-primary, #0f172a)",
};

// The search form keeps a bespoke input (pinned by the typeahead
// contract test to a `position:relative` wrapper + raw <input>) so the
// SearchTypeahead dropdown can anchor to it. The submit button migrated
// to the shared <Button variant="primary">.
const searchFormStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  minWidth: 320,
  flex: "1 1 360px",
};

// Layout only — border / radius / background / indigo focus ring come
// from the canonical `.cases-filter-search` class (with its leading
// search icon). Keeps the flex sizing the three-column header needs.
const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 240,
};

const threeColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr 360px",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

// Phase 7C — the three columns are now shared <Card> surfaces (token
// background / border / radius / padding). These style objects only
// carry the positional concerns Card doesn't own: sticky rails, scroll,
// and the center column's min-height.
const leftRailStyle: React.CSSProperties = {
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const centerColStyle: React.CSSProperties = {
  minHeight: 400,
};

const rightRailStyle: React.CSSProperties = {
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

// Compact filter-rail chip — canonical indigo active state
// (#F3F0FF / #D8CCFF / #4F46E5), the same tab language as Home / Cases.
// The compact metrics are kept (the rail is denser than the Cases
// segment strip) but the colours map onto the shared design system;
// active never reads as the old dark-slate pill.
function chipButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    background: active ? "#F3F0FF" : "rgba(255,255,255,0.85)",
    color: active ? "#4F46E5" : "#5F6878",
    borderColor: active ? "#D8CCFF" : "rgba(15,23,42,0.10)",
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

// Phase 7C — the Apply / Clear / Save-view / Load-more / Search buttons
// migrated to the shared <Button> primitive, so the bespoke
// primaryButtonStyle / secondaryButtonStyle / loadMoreButtonStyle /
// searchButtonStyle / semanticBackfillButtonStyle constants were
// removed.

// Sticky-ish container for the Apply/Clear button pair below
// the Updated date pickers. Visually framed so a user editing
// dates sees the resolution immediately under them and never
// has to scroll back to the top-right Search button.
const filterApplyPanelStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "10px 12px",
  marginTop: 12,
  borderTop: "1px solid #e2e8f0",
  background: "#f8fafc",
  borderRadius: 6,
  position: "sticky",
  bottom: 0,
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

// Phase 7C — the honest empty-state branches (loading / error / idle /
// no-match / no-match-filtered / empty-workspace / empty-index /
// partial-index) keep their pinned `data-search-empty-state-kind`
// markup; this container gives them the shared design system's centered,
// token-framed placeholder treatment (matching the Card `empty` variant
// language).
// Surface (background / border / radius) is owned by the canonical
// `.cases-empty` class applied at the call site; this object keeps the
// center-column spacing + typography the honest empty-state branches rely
// on. The former dashed-placeholder surface props were removed so the
// canonical translucent surface shows through.
const emptyStateStyle: React.CSSProperties = {
  justifyContent: "center",
  gap: 4,
  padding: "48px 24px",
  margin: "8px 0",
  fontSize: 13.5,
  lineHeight: 1.6,
};

const resultListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "8px 0 0",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

// Phase 7C — result rows read as premium interactive cards: token
// surface, rounded corners, a hairline separation via gap on the list,
// and a governance-accent left rail + tinted fill when selected.
function resultRowStyle(active: boolean): React.CSSProperties {
  return {
    padding: "12px 14px",
    borderRadius: "var(--radius-md, 12px)",
    cursor: "pointer",
    border: active
      ? "1px solid var(--status-info-border, #bfdbfe)"
      : "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
    background: active
      ? "var(--status-info-bg, #eff6ff)"
      : "var(--surface-card, #ffffff)",
    borderLeft: active
      ? "3px solid var(--status-info-solid, #2563eb)"
      : "3px solid transparent",
    boxShadow: active
      ? "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))"
      : "none",
    transition: "border-color 160ms ease, background-color 160ms ease",
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

// Phase 7C — document-type + backend-badge chips moved to the shared
// <Badge> primitive (tone mapped via docTypeTone / badgeTone). The
// bespoke docTypeChipStyle / badgeChipStyle palettes were removed, along
// with loadMoreButtonStyle (the Load-more control is now a <Button>).

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

// Inspector primary action button — single canonical CTA per result.
// Routes to the underlying record so users don't have to recognise
// the right monospaced UUID under "Pointers". Kept as a plain `<a>`
// (NOT the shared <Button>, which renders a real <button>) so the
// browser's native middle-click / cmd-click open-in-new-tab behaviour
// works without us reimplementing it — route behaviour is preserved.
// Phase 7C — restyled to the shared primary-CTA language (design-token
// gradient + premium radius/shadow) while keeping the same padding /
// weight the follow-up contract test pins.
const inspectorPrimaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 10,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  background: "var(--btn-primary-bg, #0f172a)",
  color: "var(--btn-primary-color, #ffffff)",
  border: "1px solid var(--btn-primary-border, #0f172a)",
  boxShadow: "var(--btn-primary-shadow, 0 12px 24px rgba(15,23,42,0.18))",
  borderRadius: "var(--radius-md, 12px)",
  textDecoration: "none",
  cursor: "pointer",
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

// Phase SEARCH-REMEDIATION — `searchModeSelectorStyle` +
// `searchModeButtonStyle` removed alongside the SearchModeSelector
// component above. Keep the section header so future style helpers
// have a home.

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

// Phase SEARCH-REMEDIATION-3 — `noResultsHelpStyle`,
// `noResultsLeadStyle`, `noResultsListStyle` removed alongside
// the `NoResultsHelp` component. The truthful empty state uses
// the page's existing `emptyStateStyle` token.

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


// Phase SEARCH-REMEDIATION-3 — `inlineLinkButtonStyle` removed
// alongside the `NoResultsHelp` "Try semantic search" link.

// ---------------------------------------------------------------------------
// Phase SEARCH-REMEDIATION-3 — PreviewDefault.
//
// Default state for the right rail when no result is selected.
// Shows three useful blocks: recent searches, saved searches, and
// a static "Search tips" block. Each block has a stable
// data-attribute so contract tests can pin the structure.
// ---------------------------------------------------------------------------

function PreviewDefault({
  recent,
  savedViews,
  onPickRecent,
  onPickSaved,
  onClearRecent,
}: {
  recent: string[];
  savedViews: SavedView[] | null;
  onPickRecent: (q: string) => void;
  onPickSaved: (view: SavedView) => void;
  onClearRecent: () => void;
}) {
  return (
    <div
      style={{ display: "grid", gap: 16, padding: 12 }}
      data-search-preview-default
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        Search workspace content
      </h3>

      <section data-search-preview-default-recent>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "#475569",
          }}
        >
          <span>Recent searches</span>
          {recent.length > 0 ? (
            <button
              type="button"
              onClick={onClearRecent}
              data-search-preview-default-clear-recent
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#1e40af",
                cursor: "pointer",
                font: "inherit",
                fontSize: 11,
                textDecoration: "underline",
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        {recent.length === 0 ? (
          <p
            className="cc-muted"
            style={{ marginTop: 6, fontSize: 12 }}
            data-search-preview-default-recent-empty
          >
            Your recent searches will appear here.
          </p>
        ) : (
          <ul
            style={{ marginTop: 6, padding: 0, listStyle: "none", display: "grid", gap: 4 }}
          >
            {recent.map((r, idx) => (
              <li key={`pd-recent-${idx}`}>
                <button
                  type="button"
                  onClick={() => onPickRecent(r)}
                  data-search-preview-default-recent-row={r}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "4px 0",
                    color: "#1e40af",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  {r}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-search-preview-default-saved>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "#475569",
          }}
        >
          Saved searches
        </div>
        {!savedViews || savedViews.length === 0 ? (
          <p
            className="cc-muted"
            style={{ marginTop: 6, fontSize: 12 }}
            data-search-preview-default-saved-empty
          >
            No saved searches yet.
          </p>
        ) : (
          <ul
            style={{ marginTop: 6, padding: 0, listStyle: "none", display: "grid", gap: 4 }}
          >
            {savedViews.slice(0, 8).map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => onPickSaved(v)}
                  data-search-preview-default-saved-row={v.id}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "4px 0",
                    color: "#1e40af",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  {v.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-search-preview-default-tips>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "#475569",
          }}
        >
          Search tips
        </div>
        <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12, color: "#475569" }}>
          <li>
            Search by filename, case name, report title, package, note,
            or record ID.
          </li>
          <li>
            OCR and transcript text appear in results when available.
          </li>
          <li>
            Use the filters on the left to narrow by type, status, case,
            or date.
          </li>
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase SEARCH-REMEDIATION-2 — SearchTypeahead.
//
// Renders a single dropdown anchored under the search input:
//   - When the query is empty: a list of recent searches with a
//     "Clear recent searches" link.
//   - When the query has ≥2 chars: live suggestions (top-N title
//     matches from `/v1/search/suggest`), each badged with their
//     document type.
//   - When neither has any rows: shows a single muted hint line.
//
// The component is purely presentational. Keyboard navigation
// (ArrowUp/Down/Enter/Escape) is owned by the input's `onKeyDown`
// in the parent; this component just renders the visible state.
// ---------------------------------------------------------------------------

function SearchTypeahead({
  query,
  suggestions,
  recent,
  highlighted,
  onPick,
  onClearRecent,
}: {
  query: string;
  suggestions: Array<{
    id: string;
    documentType: DocumentType;
    title: string;
    subtitle: string | null;
  }>;
  recent: string[];
  highlighted: number;
  onPick: (text: string) => void;
  onClearRecent: () => void;
}) {
  const trimmed = query.trim();
  const showRecent = trimmed.length < 2;
  const showSuggestions = !showRecent && suggestions.length > 0;
  const showEmpty = !showRecent && suggestions.length === 0 && trimmed.length >= 2;
  const showRecentEmpty = showRecent && recent.length === 0;

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.12)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
        zIndex: 30,
        maxHeight: 360,
        overflowY: "auto",
      }}
      role="listbox"
      data-search-typeahead
    >
      {showRecentEmpty ? (
        <p
          className="cc-muted"
          style={{ padding: "10px 12px", margin: 0, fontSize: 12 }}
          data-search-typeahead-recent-empty
        >
          Tip: try searching by filename, case name, or report title.
        </p>
      ) : null}
      {showRecent && recent.length > 0 ? (
        <div data-search-typeahead-recent>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 12px",
              fontSize: 11,
              color: "#475569",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            <span>Recent searches</span>
            <button
              type="button"
              onMouseDown={(e) => {
                // Prevent the input's blur from firing before this
                // click — otherwise the dropdown closes mid-click.
                e.preventDefault();
                onClearRecent();
              }}
              data-search-typeahead-clear-recent
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#1e40af",
                cursor: "pointer",
                font: "inherit",
                fontSize: 11,
                textDecoration: "underline",
              }}
            >
              Clear
            </button>
          </div>
          {recent.map((r, idx) => (
            <button
              type="button"
              key={`recent-${idx}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(r);
              }}
              data-search-typeahead-recent-row={r}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background:
                  highlighted === idx ? "rgba(30, 64, 175, 0.08)" : "#fff",
                border: "none",
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
              }}
            >
              {r}
            </button>
          ))}
        </div>
      ) : null}
      {showSuggestions ? (
        <div data-search-typeahead-suggestions>
          <div
            style={{
              padding: "6px 12px",
              fontSize: 11,
              color: "#475569",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            Suggestions
          </div>
          {suggestions.map((s, idx) => (
            <button
              type="button"
              key={s.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s.title);
              }}
              data-search-typeahead-suggestion={s.id}
              data-search-typeahead-suggestion-type={s.documentType}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background:
                  highlighted === idx ? "rgba(30, 64, 175, 0.08)" : "#fff",
                border: "none",
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {s.title}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#475569",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  flexShrink: 0,
                }}
              >
                {s.documentType}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {showEmpty ? (
        <p
          className="cc-muted"
          style={{ padding: "10px 12px", margin: 0, fontSize: 12 }}
          data-search-typeahead-empty
        >
          No matching titles. Press Enter to search anyway.
        </p>
      ) : null}
    </div>
  );
}
