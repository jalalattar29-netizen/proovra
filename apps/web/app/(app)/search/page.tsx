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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import {
  useActiveSpace,
  usePlatformContext,
  useTerminology,
  useWorkspaceId,
} from "../../../lib/platform-context";
// PHASE 12 REMEDIATION — WEB-002 (2026-08-06). The ONE tenant-storage
// namespace authority; see the recent-searches block below.
import { tenantStorageKey } from "../../../lib/platform-context/tenantStorage";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// REDESIGN/SEARCH — the console owns its presentation layer. `search.css`
// carries the route anatomy (header, form, filter rail, result list,
// inspector, guidance, states); everything it does not describe comes from
// the canonical `app-*` primitives. No second button, no second badge, no
// route-local palette.
import "./search.css";
// Canonical option control. The filter rail used a native <select>, which
// renders the OS popup, cannot be styled and cannot be keyboard-audited;
// AppListbox is the one accessible listbox for every internal surface.
import { AppListbox } from "../../../components/app-primitives/AppListbox";
// The one way a popup escapes its ancestors. See the note on
// `.search-typeahead` in search.css for what was trapping this menu.
import { AppAnchoredOverlay } from "../../../components/app-primitives/AppAnchoredOverlay";
import {
  AppStatusBadge,
  type AppTone,
} from "../../../components/app-primitives/AppStatusBadge";
// One authority for what a type, a badge and a lifecycle state look like —
// consumed by the result rows and by the Inspector, so the two can no longer
// disagree about the same record.
import {
  isLifecycleValue,
  searchBadgeTone,
  searchLifecycleLabel,
  searchLifecycleTone,
  searchTypeTone,
} from "./searchTones";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
// Phase IA-self-serve-simplification / Track 1A — gate the enterprise
// pivot links + admin-only deep links on the SERVER-projected
// enterprise-experience booleans (flags.isEnterpriseWorkspace /
// platform.isPlatformAdmin), never a client-derived plan/tier.
import { useEnterpriseSurfaceAccess } from "../../../lib/platform-context";
import { NlSearchBox } from "../../../components/ai-copilot/NlSearchBox";
// PHASE 12B (Evidence Operations) — the Discovery audit log
// (GET /v1/search/audit) is the sole public authority over the
// search-activity data domain. It is a DIFFERENT data domain from the
// unified GET /v1/search content projection (different gate:
// search-operator vs. search-actor), so it is surfaced as a scope tab
// on this console rather than folded into the content query.
import { SearchAuditLogPanel } from "../../../components/search/SearchAuditLogPanel";
import { Info, Inbox, Layers, Search as SearchGlyph } from "lucide-react";
// The console's distinct states. Each one is its own component with its own
// words, so "you have not searched yet", "your query matched nothing" and "the
// service did not answer" can never be rendered as one another. The outage
// wording lives in exactly one of them.
import {
  SearchDegradedNotice,
  SearchNoResultsState,
  SearchPristineState,
  SearchRestrictedState,
  SearchResultSkeletons,
  SearchState,
  SearchUnavailableAlert,
  SearchUnavailableState,
} from "./components/SearchStates";
// The guidance column stands in for the Inspector while nothing is selected,
// so the region is never an empty white gutter. Every list in it is real.
import {
  SearchGuidancePanel,
  type SavedSearchEntry,
} from "./components/SearchGuidance";
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
// `GET /v1/search/diagnostics` is registered on the canonical API
// (search.routes.ts). A failed request collapses to null and the page
// renders the generic empty-state branches — runtime-failure tolerance,
// not backend-version compatibility.
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

// The chips used to render the raw enum lower-cased ("photo"), which read as
// wire vocabulary next to the Title-Case document-type chips beside them.
const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  PHOTO: "Photo",
  VIDEO: "Video",
  AUDIO: "Audio",
  DOCUMENT: "Document",
};

const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "UPDATED_DESC", label: "Most recent first" },
  { value: "UPDATED_ASC", label: "Oldest first" },
  { value: "CREATED_DESC", label: "Newest by creation" },
  { value: "CREATED_ASC", label: "Earliest by creation" },
  { value: "RELEVANCE_DESC", label: "Relevance" },
];

const DEFAULT_LIMIT = 25;

// The one in-product support destination — the same route `(app)/error` and
// `(app)/not-found` send operators to. Passed to the state components so
// "Contact support" can never become a second, divergent link.
const SUPPORT_HREF = "/support";

/**
 * What a saved view's scope is CALLED.
 *
 * The wire says PRIVATE | TEAM. "Team" is not this product's word for a
 * workspace-scoped thing, and the console was previously rendering the enum
 * two different ways — `"Team"` in one list and `visibility.toLowerCase()` in
 * the other. One map, resolved once, in the words the rest of the product uses.
 */
const SAVED_VIEW_VISIBILITY_LABEL: Record<SavedViewVisibility, string> = {
  PRIVATE: "Private",
  TEAM: "Workspace",
};

/**
 * Why the search request produced no answer.
 *
 * The console used to keep a single `error` string that EVERY failure wrote
 * into — a failed saved-view rename included — and the empty-state branch
 * turned any non-null value into "Search is temporarily unavailable". So a
 * refused permission, a rename that hit a validation error, and an actual
 * network outage all claimed the search service was down.
 *
 *   restricted  — the workspace declined the request. The same request with
 *                 the same grant will be declined again, so this state offers
 *                 no retry and makes no claim about connectivity.
 *   unavailable — the service or the connection genuinely could not answer.
 *                 Only this kind may use connection-failure language.
 */
type SearchFailure = { kind: "restricted" | "unavailable" };

// Deliberately no `message` field. The classifier can only learn WHICH state
// is true; the words belong to the state components. A slot for server text
// here is how server text finds its way onto the screen later.

function classifySearchFailure(err: unknown): SearchFailure {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : null;
  const code = typeof e?.code === "string" ? e.code : null;
  // 403 is the search gate refusing the actor; 404 is the same refusal worded
  // so it cannot be used to enumerate workspaces. Neither is an outage.
  if (
    status === 403 ||
    status === 404 ||
    code === "permission_denied" ||
    code === "not_found"
  ) {
    return { kind: "restricted" };
  }
  return { kind: "unavailable" };
}

/**
 * The one lifecycle fact that leads a result row.
 *
 * A row can carry half a dozen badges at once. Rendering them as an
 * undifferentiated soup meant a legal hold — the most consequential thing this
 * product can say about a record — sat wherever the backend happened to put it
 * in the array. The first match below is promoted to the row's status slot, on
 * the same axis for every card; the rest render after the summary.
 */
const STATUS_BADGE_PRECEDENCE = [
  "legal-hold",
  "governance-restricted",
  "in_trash",
  "visibility-restricted",
  "export-restricted",
  "locked",
  "archived",
] as const;

function primaryStatusBadge(badges: ReadonlyArray<string>): string | null {
  for (const candidate of STATUS_BADGE_PRECEDENCE) {
    if (badges.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * The record's own lifecycle state, from the fields that carry it.
 *
 * ONE derivation, read by the result row and by the Inspector head, so the
 * list and the panel beside it cannot describe the same record differently.
 * Workflow state leads because it is the state an operator acts on; review
 * state answers for records that have no workflow.
 */
function rowLifecycleState(row: ResultRow): string | null {
  const value = row.workflowState ?? row.reviewState;
  return value && isLifecycleValue(value) ? value : null;
}

// -----------------------------------------------------------------------------
// Page component
// -----------------------------------------------------------------------------

// Phase 38.7 — canonical wrapper. The inner client component below
// retains all existing logic; the gate decides whether to render it.
export default function SearchPage() {
  return (
    <PageRouteGate routeId="workspace.search">
      {/* Phase F1 — deterministic natural-language Evidence-Operations search. */}
      <NlSearchBox />
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
  // Phase IA-self-serve-completion / Track 1A — gates for the inspector
  // pivot links. Workflow templates and investigation power tools belong
  // to the Enterprise workspace experience; clicking them as a
  // self-serve user previously hit a bounded 404. We hide the pivot
  // links and rename the section so self-serve users see a clean
  // "Related evidence" rail instead of an "Investigation pivots" rail
  // that promised features they could not reach. Server-projected
  // booleans only.
  const enterpriseSurfaces = useEnterpriseSurfaceAccess();
  const canSeeWorkflows = enterpriseSurfaces;
  const canSeeInvestigation = enterpriseSurfaces;
  // PHASE 12B — console scope. "records" is the unified content search
  // (GET /v1/search); "activity" is the workspace search-activity log
  // (GET /v1/search/audit). Two data domains, one console — never two
  // authorities over the same domain.
  const [scope, setScope] = useState<"records" | "activity">("records");
  // The operator-help bar is disclosure-only: it states what this console
  // really matches. Collapsed by default so results stay primary.
  const [helpOpen, setHelpOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Why the SEARCH failed, if it did. Never written by anything else.
  const [searchFailure, setSearchFailure] = useState<SearchFailure | null>(null);
  // Why an ACTION failed (save / rename / delete a view, load another page).
  // Rendered as a banner beside the results; it never becomes a search state.
  const [actionError, setActionError] = useState<string | null>(null);
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
  // Phase 16 — semantic status envelope. The chip + mode selector honor
  // this when present and degrade to the per-response
  // `results.semanticAvailable` when the request fails. One fetch per
  // teamId; no polling.
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
  // wrong workspace. One fetch per teamId. A failed request collapses to
  // null and the page renders the generic empty-state branches.
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
        setSearchFailure(null);
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
      .catch((err: unknown) => {
        if (cancelled) return;
        // The state components own the copy; all this decides is WHICH state
        // is true, from the transport's own answer.
        setSearchFailure(classifySearchFailure(err));
        // The selection belonged to the result set this failure just cleared.
        // Leaving it mounted put a record's Inspector beside "Search is
        // temporarily unavailable", which reads as though the results were
        // still there.
        setSelected(null);
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
  //
  // PHASE 12 REMEDIATION — WEB-002 (2026-08-06). The key used to be
  // `proovra:search:recent:${teamId}` — its OWN namespace. It was correctly
  // workspace-scoped, so there was never a cross-tenant leak, but it sat
  // outside the canonical `proovra:tenant:<workspaceId>:<key>` namespace.
  // That meant a tenant-scoped purge, which iterates the canonical
  // namespace, walked straight past it: switching or leaving a workspace
  // cleared every other tenant-scoped draft and left this workspace's search
  // history behind on the device.
  //
  // It now uses `tenantStorageKey`, the ONE storage-namespace authority, so
  // the value is purged by the same sweep as everything else. Prior-key
  // migration is handled in the load effect below: the legacy entry is read
  // once, rewritten under the canonical key, and removed — so an existing
  // user keeps their history AND the stray key stops surviving purges.
  const recentKey = tenantStorageKey(teamId ?? null, "search:recent");
  const legacyRecentKey = `proovra:search:recent:${teamId}`;
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      let raw = window.localStorage.getItem(recentKey);
      if (raw === null) {
        // One-time migration off the pre-canonical namespace.
        const legacy = window.localStorage.getItem(legacyRecentKey);
        if (legacy !== null) {
          window.localStorage.setItem(recentKey, legacy);
          window.localStorage.removeItem(legacyRecentKey);
          raw = legacy;
        }
      } else {
        // Canonical value already present — drop any stale legacy twin so it
        // cannot outlive a tenant purge.
        window.localStorage.removeItem(legacyRecentKey);
      }
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
  }, [recentKey, legacyRecentKey]);
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
  // The menu is portaled, so it is anchored to this element's measured rect
  // rather than laid out inside it.
  const searchFieldRef = useRef<HTMLDivElement | null>(null);
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
      .catch((err: unknown) =>
        setActionError(
          toSafeUserError(err, { message: "Could not load more results." })
            .message,
        ),
      )
      .finally(() => setLoading(false));
  }, [filter, results?.nextCursor]);

  /**
   * Re-run the current filter unchanged.
   *
   * A new envelope identity is what the search effect watches, so cloning the
   * live filter re-issues exactly the request that failed — no filter is
   * silently widened to manufacture a result.
   */
  const retrySearch = useCallback(() => {
    setSearchFailure(null);
    setFilter((prev) => (prev ? { ...prev } : prev));
  }, []);

  /**
   * The saved views, reduced to what the guidance column shows. `null` is
   * preserved as "not loaded / no authority" so the panel can say so rather
   * than rendering an empty list as if the operator had saved nothing.
   */
  const savedViewEntries = useMemo<readonly SavedSearchEntry[] | null>(
    () =>
      savedViews === null
        ? null
        : savedViews.map((v) => ({
            id: v.id,
            name: v.name,
            visibilityLabel: SAVED_VIEW_VISIBILITY_LABEL[v.visibility],
          })),
    [savedViews],
  );

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
      setActionError(
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
        setActionError(
          toSafeUserError(err, { message: "Could not delete view." }).message
        );
      }
    },
    // `confirm` is memoised once by ConfirmActionProvider — stable identity.
    [teamId, confirm]
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
        setActionError(
          toSafeUserError(err, { message: "Could not rename view." }).message,
        );
      }
    },
    [teamId],
  );

  /**
   * What is narrowing this result set — the filters only.
   *
   * The query itself is deliberately absent: this console's standing rule is
   * that a search string is never echoed back outside the input box, and this
   * summary was quoting it verbatim into the results header.
   */
  const filterSummary = useMemo(() => {
    if (!filter) return null;
    const parts: string[] = [];
    const types = filter.documentTypes?.length ?? 0;
    if (types > 0) parts.push(`${types} record type${types === 1 ? "" : "s"}`);
    const kinds = filter.evidenceTypes?.length ?? 0;
    if (kinds > 0) parts.push(`${kinds} evidence kind${kinds === 1 ? "" : "s"}`);
    if (filter.workflowLinked) parts.push("workflow-linked");
    if (filter.onLegalHold) parts.push("legal hold");
    if (filter.exportRestricted) parts.push("export-restricted");
    if (filter.incidentLinked) parts.push("incident-linked");
    if (filter.contributorScoped) parts.push("contributor-scoped");
    if (filter.updatedSinceUtc || filter.updatedUntilUtc)
      parts.push("an updated-date range");
    return parts.length > 0
      ? `narrowed by ${parts.join(", ")}`
      : "no filters applied";
  }, [filter]);

  /**
   * Records the workspace withheld. Counted, never listed — the count is the
   * honest statement that something exists that this actor may not see.
   */
  const withheldSummary = useMemo(() => {
    const parts: string[] = [];
    if (results?.filteredByVisibility)
      parts.push(`${results.filteredByVisibility} withheld by visibility`);
    if (results?.filteredByGovernance)
      parts.push(`${results.filteredByGovernance} withheld by governance`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [results?.filteredByVisibility, results?.filteredByGovernance]);

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
  // Did semantic similarity actually take part in ordering THIS result set?
  // The header label is derived from what ran, never from what was requested.
  const usedSemanticRanking = modeUsed === "hybrid" || modeUsed === "semantic";
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
    // Not an error and not an empty result: the workspace envelope has not
    // resolved yet, so there is nothing to search against.
    return (
      <main className="search-page" data-search-page="pending">
        <div className="app-panel search-state" data-search-state="workspace-pending">
          <p className="search-state__body">
            Workspace setup pending — refresh shortly.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="search-page" data-search-page>
      <header className="search-header">
        <div className="search-header__text">
          <h1 className="search-header__title" data-search-title>
            Search
          </h1>
          <p className="search-header__description">
            Search evidence, cases, reports, notes and OCR text across this
            workspace. Results respect visibility and governance.
          </p>
        </div>
        {/* What ordered this result set, stated plainly. Keyword matching is
            deterministic; semantic similarity only re-ranks rows the keyword
            pass already found, so it is labelled advisory rather than sold as
            a second kind of search. */}
        <p
          className="search-header__context"
          data-search-ranking={usedSemanticRanking ? "advisory" : "deterministic"}
        >
          {usedSemanticRanking
            ? "Deterministic match · advisory ranking"
            : "Deterministic match"}
        </p>
      </header>

      {/* Admin-only runtime strip: semantic status, backfill dry run, index
          health. Operator instrumentation, not product chrome — a non-admin
          renders nothing here at all. */}
      <div className="search-admin-strip" data-search-admin-strip>
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
                <AppStatusBadge
                  tone="amber"
                  dot
                  data-search-health="empty_index"
                  data-search-health-audience="user"
                >
                  Search is being set up. Try again in a moment.
                </AppStatusBadge>
              );
            }
            // Support/admin path — opt-in only. Full breakdown,
            // numbers included.
            const breakdown = searchHealth.index.breakdown;
            const adminToneMap: Record<string, AppTone> = {
              healthy: "green",
              partial_index: "amber",
              empty_index: "red",
              empty_workspace: "slate",
            };
            const adminTone: AppTone = adminToneMap[effectiveHealth] ?? "slate";
            return (
              <AppStatusBadge
                tone={adminTone}
                dot
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
              </AppStatusBadge>
            );
          })()
        ) : searchHealthError &&
          isPlatformAdmin &&
          searchHealthDebugOptIn ? (
          <AppStatusBadge
            tone="slate"
            dot
            data-search-health="unknown"
            data-search-health-audience="admin"
          >
            Search index status unavailable
          </AppStatusBadge>
        ) : null}
      </div>

      <div className="app-panel search-form-panel">
        <form onSubmit={submitQuery} className="search-form" data-search-form>
          {/* The field the typeahead is anchored to. */}
          <div className="search-form__field" ref={searchFieldRef}>
            <span className="search-form__icon" aria-hidden="true">
              <SearchGlyph size={17} strokeWidth={2} />
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
                className="search-form__input"
                maxLength={200}
                aria-label="Search query"
                aria-autocomplete="list"
                aria-expanded={suggestOpen}
                data-search-input
              />
            <AppAnchoredOverlay
              anchorRef={searchFieldRef}
              open={suggestOpen}
              onPointerDownOutside={() => setSuggestOpen(false)}
              data-search-typeahead-overlay
            >
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
            </AppAnchoredOverlay>
          </div>
          <button
            type="submit"
            className="app-primary-action search-form__submit"
            data-search-submit
          >
            Search
          </button>
        </form>
      </div>

      {/* Operator help. Every line below describes something this console
          actually does — the corpus it reads, the text it can match, and
          what it withholds. Collapsed by default so results stay primary. */}
      <div className="search-help" data-search-help>
        <span className="search-help__icon" aria-hidden="true">
          <Info size={16} strokeWidth={2} />
        </span>
        <span className="search-help__label">How search works</span>
        <button
          type="button"
          className="search-help__toggle"
          aria-expanded={helpOpen}
          aria-controls="search-help-body"
          onClick={() => setHelpOpen((prev) => !prev)}
          data-search-help-toggle
        >
          {helpOpen ? "Hide" : "Show"}
        </button>
        {helpOpen ? (
          <ul className="search-help__body" id="search-help-body">
            <li>
              Titles, filenames, case names, report titles, package labels and
              note text are matched directly.
            </li>
            <li>
              OCR and transcript text are matched where a record carries them.
            </li>
            <li>
              Records you cannot access are counted above the results, never
              listed.
            </li>
            <li>
              The filters narrow by record type, evidence kind, lifecycle state
              and when a record was last updated.
            </li>
          </ul>
        ) : null}
      </div>

      {/* Records = the unified content projection (GET /v1/search).
          Search activity = the workspace search-activity log
          (GET /v1/search/audit). Two data domains, one console; switching
          scope never changes the workspace. */}
      <div
        className="app-tabs"
        data-search-scope-tabs
        role="tablist"
        aria-label="Search console scope"
      >
        <button
          type="button"
          role="tab"
          className={`app-tab${scope === "records" ? " is-active" : ""}`}
          aria-selected={scope === "records"}
          data-search-scope-tab="records"
          data-search-scope-active={scope === "records" ? "true" : "false"}
          onClick={() => setScope("records")}
        >
          Records
        </button>
        <button
          type="button"
          role="tab"
          className={`app-tab${scope === "activity" ? " is-active" : ""}`}
          aria-selected={scope === "activity"}
          data-search-scope-tab="activity"
          data-search-scope-active={scope === "activity" ? "true" : "false"}
          onClick={() => setScope("activity")}
        >
          Search activity
        </button>
      </div>

      {scope === "activity" ? (
        <SearchAuditLogPanel teamId={teamId} />
      ) : (
      <>
      {/* An ACTION failed — saving a view, loading another page. It is
          reported where it happened and never becomes a search state. The
          message is already bounded by toSafeUserError. */}
      {actionError ? (
        <div className="app-alert app-alert--danger" role="alert" data-search-action-error>
          {actionError}
        </div>
      ) : null}

      {/* The outage banner accompanies the outage state and nothing else. */}
      {searchFailure?.kind === "unavailable" ? <SearchUnavailableAlert /> : null}

      {/* Filters | Results | Inspector. The three regions are sized from the
          console's own inline size, not the viewport: this surface sits beside
          the app sidebar and never had the width a viewport query described. */}
      <div className="search-workspace">
        <div className="search-workspace__grid">
        {/* ----------------------------- LEFT ----------------------------- */}
        <div className="search-col">
        <div className="app-panel search-filters" data-search-filters>
          <FilterSection label="Sort">
            <AppListbox
              value={filter.sort ?? "UPDATED_DESC"}
              options={SORT_MODES}
              onChange={(value) => updateFilter({ sort: value })}
              ariaLabel="Sort results"
            />
          </FilterSection>

          <FilterSection label="Document type">
            <div className="search-chip-row">
              {DOCUMENT_TYPES.map((t) => {
                const active = filter.documentTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    className="search-chip"
                    aria-pressed={active}
                    onClick={() =>
                      updateFilter({
                        documentTypes: toggleArray(filter.documentTypes, t),
                      })
                    }
                    data-search-type-chip={t}
                  >
                    {DOCUMENT_TYPE_LABEL[t]}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          <FilterSection label="Evidence kind">
            <div className="search-chip-row">
              {EVIDENCE_TYPES.map((t) => {
                const active = filter.evidenceTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    className="search-chip"
                    aria-pressed={active}
                    onClick={() =>
                      updateFilter({
                        evidenceTypes: toggleArray(filter.evidenceTypes, t),
                      })
                    }
                    data-search-evidence-chip={t}
                  >
                    {EVIDENCE_TYPE_LABEL[t]}
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
            {/* Draft-backed: typing in a picker writes only to the local draft
                string, and the live filter envelope is unchanged until Apply.
                Datetime-local keystrokes used to fire a search per partial
                value — wasteful, and sometimes an invalid instant. */}
            <div className="search-date-field">
              <label htmlFor="search-updated-since">Since</label>
              <input
                id="search-updated-since"
                type="datetime-local"
                value={dateSinceDraft}
                onChange={(e) => setDateSinceDraft(e.target.value)}
                data-search-filter-date-since-input="true"
                className="app-form-input"
              />
            </div>
            <div className="search-date-field">
              <label htmlFor="search-updated-until">Until</label>
              <input
                id="search-updated-until"
                type="datetime-local"
                value={dateUntilDraft}
                onChange={(e) => setDateUntilDraft(e.target.value)}
                data-search-filter-date-until-input="true"
                className="app-form-input"
              />
            </div>
          </FilterSection>

          {/* Apply is the only way to push the date drafts into the live filter
              (chips and toggles auto-apply on their own). Clear wipes every
              narrowing dimension including the dates; both preserve the query.
              The row only renders when there is something to apply or clear. */}
          {(dateDraftDirty || filtersNonEmpty) ? (
            <div
              className="search-filters__actions"
              data-search-filter-apply-panel="true"
            >
              <button
                type="button"
                className="app-primary-action"
                onClick={applyDraftFilters}
                disabled={!dateDraftDirty}
                data-search-filter-apply="true"
              >
                Apply filters
              </button>
              {filtersNonEmpty ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={clearNarrowingFilters}
                  data-search-filter-clear="true"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Saved views — operator surface only, gated on the same
              isPlatformAdmin envelope flag the runtime strip uses. The
              GET /v1/search/saved-views fetch keeps running when the gate
              hides the section, so a plan upgrade needs no refresh. */}
          {isPlatformAdmin ? (
            <FilterSection label="Saved views">
              <button
                type="button"
                className="app-secondary-action"
                onClick={saveCurrentView}
                disabled={savingView}
                aria-busy={savingView}
              >
                {savingView ? "Saving…" : "Save current view"}
              </button>
              {savedViews === null ? (
                <p className="app-hint">Loading…</p>
              ) : savedViews.length === 0 ? (
                <p className="app-hint">No saved views yet.</p>
              ) : (
                <ul className="search-saved-views">
                  {savedViews.map((v) => (
                    <li key={v.id} className="search-saved-view">
                      <button
                        type="button"
                        className="search-saved-view__apply"
                        onClick={() => applySavedView(v)}
                        title={v.description ?? ""}
                      >
                        <span>
                          {v.pinned ? "★ " : ""}
                          {v.name}
                        </span>
                        <span className="search-saved-view__visibility">
                          {SAVED_VIEW_VISIBILITY_LABEL[v.visibility]}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="search-saved-view__action"
                        onClick={() => renameSavedView(v.id, v.name)}
                        aria-label="Rename saved view"
                        data-search-saved-view-rename={v.id}
                        title="Rename"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="search-saved-view__action"
                        onClick={() => deleteSavedView(v.id)}
                        aria-label="Delete saved view"
                        title="Delete"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </FilterSection>
          ) : null}
        </div>
        </div>

        {/* ----------------------------- CENTER ----------------------------- */}
        <div className="search-col search-col--results">
          {/* Rows came back AND the index is still being built: the result set
              is real but incomplete. Reported beside the results, never
              promoted into a failure. */}
          {searchHealth?.health === "partial_index" &&
          results &&
          results.rows.length > 0 ? (
            <SearchDegradedNotice
              indexed={searchHealth.index.evidenceIndexed}
              total={searchHealth.index.evidenceTotal}
            />
          ) : null}

          {/* What the workspace returned. A FAILURE is not a count, so when
              the request did not answer this row states that instead of
              reporting "0 results" over the top of an outage. */}
          <div className="search-results__head" data-search-results-head>
            <span className="search-results__count" aria-live="polite">
              {loading
                ? "Searching…"
                : searchFailure
                  ? "No results to show"
                  : `${results?.totalReturned ?? 0} result${
                      (results?.totalReturned ?? 0) === 1 ? "" : "s"
                    }`}
            </span>
            {searchFailure ? null : <span>{filterSummary}</span>}
            {withheldSummary && !searchFailure ? (
              <span data-search-withheld>{withheldSummary}</span>
            ) : null}
          </div>

          {!results || results.rows.length === 0 ? (
            <div
              data-search-empty-state
              data-search-empty-state-filters-active={
                hasNarrowingFilters(filter) ? "true" : "false"
              }
            >
              {loading ? (
                // The result geometry, before the results — so nothing jumps
                // when the rows land.
                <div data-search-empty-state-kind="loading">
                  <SearchResultSkeletons />
                </div>
              ) : searchFailure?.kind === "restricted" ? (
                // The workspace declined the request. No retry: the same
                // request with the same grant is declined again, and the copy
                // never confirms whether anything exists behind the refusal.
                <div data-search-empty-state-kind="restricted">
                  <SearchRestrictedState />
                </div>
              ) : searchFailure ? (
                // ONLY a transport or service failure reaches this branch, so
                // this is the only place connection language may appear.
                <div data-search-empty-state-kind="error">
                  <SearchUnavailableState
                    onRetry={retrySearch}
                    retrying={loading}
                    supportHref={SUPPORT_HREF}
                  />
                </div>
              ) : !filter?.q ? (
                // Nothing has been asked yet. This is the resting state, not a
                // zero-result answer and not an error.
                <div data-search-empty-state-kind="idle">
                  <SearchPristineState />
                </div>
              ) : hasNarrowingFilters(filter) ? (
                // A filter narrowed everything away. This must stay AHEAD of
                // the workspace/index branches: with an EVIDENCE filter active,
                // "the index is empty" would be a false explanation.
                (() => {
                  const hint = describeFilterEmpty(filter, searchHealth);
                  return (
                    <div data-search-empty-state-kind="no-match-filtered">
                      <SearchNoResultsState
                        title={`${hint.headline}${
                          searchHealth?.workspace?.name
                            ? ` in "${searchHealth.workspace.name}"`
                            : ""
                        }`}
                        detail={hint.detail}
                        filtersActive
                        onClearFilters={clearNarrowingFilters}
                      />
                    </div>
                  );
                })()
              ) : searchHealth?.health === "empty_workspace" ? (
                // The workspace itself holds no records. Searching anything
                // returns nothing, but the cause is not the query.
                <div data-search-empty-state-kind="empty-workspace">
                  <SearchState
                    kind="empty-workspace"
                    icon={<Inbox size={34} strokeWidth={1.8} />}
                    title={`Workspace${
                      searchHealth.workspace.name
                        ? ` "${searchHealth.workspace.name}"`
                        : ""
                    } has no records yet`}
                  >
                    Add evidence, cases, reports, packages or notes — or switch
                    to a workspace that has them. This workspace contains 0
                    records.
                  </SearchState>
                </div>
              ) : searchHealth?.health === "empty_index" ? (
                // The records exist; they are not searchable yet.
                <div data-search-empty-state-kind="empty-index">
                  <SearchState
                    kind="empty-index"
                    icon={<Layers size={34} strokeWidth={1.8} />}
                    title="Search index is preparing"
                  >
                    This workspace has {searchHealth.index.evidenceTotal}{" "}
                    records, and none have been indexed yet. Indexing runs
                    automatically; reload in a moment. If this persists,
                    contact support.
                  </SearchState>
                </div>
              ) : searchHealth?.health === "partial_index" ? (
                // Backfill still running: a recent record may genuinely not be
                // searchable yet, so a zero result is not proof of absence.
                <div data-search-empty-state-kind="partial-index">
                  <SearchState
                    kind="partial-index"
                    icon={<Layers size={34} strokeWidth={1.8} />}
                    title="No matching results yet"
                  >
                    The search index is still catching up —{" "}
                    {searchHealth.index.evidenceIndexed} of{" "}
                    {searchHealth.index.evidenceTotal} records are searchable so
                    far. Reload in a moment if you expected a recent record.
                  </SearchState>
                </div>
              ) : (
                // Fully indexed, no filters, and the query genuinely has no
                // hits in THIS workspace — named, so a wrong-workspace mistake
                // is visible.
                <div data-search-empty-state-kind="no-match">
                  <SearchNoResultsState
                    title={`No matches${
                      searchHealth?.workspace?.name
                        ? ` in "${searchHealth.workspace.name}"`
                        : ""
                    }`}
                    detail="Try a different filename, case name, report title, note, or record ID."
                    filtersActive={false}
                  />
                </div>
              )}
            </div>
          ) : (
            <ul className="search-results__list" data-search-results>
              {results.rows.map((row) => {
                const isSelected = selected?.documentId === row.documentId;
                const status = primaryStatusBadge(row.badges);
                const otherBadges = row.badges.filter((x) => x !== status);
                const lifecycle = rowLifecycleState(row);
                // A CASE's subtitle IS its status label, so rendering both put
                // "Open" on the card twice. The supporting line is dropped when
                // it only repeats the badge beside it.
                const subtitle =
                  row.subtitle &&
                  lifecycle &&
                  searchLifecycleLabel(row.subtitle) ===
                    searchLifecycleLabel(lifecycle)
                    ? null
                    : row.subtitle;
                return (
                  <li key={row.documentId}>
                    {/* A real button: the row used to be an <li onClick>, which
                        no keyboard could reach at all. Selection changes colour
                        and border only — the geometry is identical in both
                        states, so nothing shifts when a row is chosen. */}
                    <button
                      type="button"
                      className="search-result"
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelected(row)}
                      data-search-result-row={row.documentType}
                    >
                      <span className="search-result__head">
                        {/* The type is a CLASSIFICATION, and it wears the one
                            tone this console gives that type — the same tone
                            the Inspector uses for the same record. */}
                        <AppStatusBadge
                          className="search-type-badge"
                          tone={searchTypeTone(row.documentType)}
                          data-search-result-type={row.documentType}
                        >
                          {DOCUMENT_TYPE_LABEL[row.documentType] ?? row.documentType}
                        </AppStatusBadge>
                        <span className="search-result__title">{row.title}</span>
                        {status ? (
                          <AppStatusBadge
                            className="search-result__status"
                            tone={searchBadgeTone(status)}
                            data-search-result-status={status}
                            data-search-result-badge={status}
                          >
                            {renderBadgeLabel(status)}
                          </AppStatusBadge>
                        ) : lifecycle ? (
                          <AppStatusBadge
                            className="search-result__status"
                            tone={searchLifecycleTone(lifecycle)}
                            data-search-result-status={lifecycle}
                            data-search-lifecycle={lifecycle}
                          >
                            {searchLifecycleLabel(lifecycle)}
                          </AppStatusBadge>
                        ) : null}
                      </span>

                      {/* Why the backend says this row matched. Pre-Phase-15
                          responses omit the field and the row is skipped. */}
                      {row.matchReasons && row.matchReasons.length > 0 ? (
                        <span className="search-result__reasons">
                          {row.matchReasons.map((reason) => (
                            <span
                              key={reason}
                              className="app-chip"
                              data-search-match-reason={reason}
                            >
                              {reason}
                            </span>
                          ))}
                        </span>
                      ) : null}

                      {subtitle ? (
                        <span className="search-result__meta">{subtitle}</span>
                      ) : null}
                      {row.summary ? (
                        <span className="search-result__meta">{row.summary}</span>
                      ) : null}

                      {otherBadges.length > 0 ? (
                        <span className="search-result__reasons">
                          {otherBadges.map((b) => (
                            <AppStatusBadge
                              key={b}
                              tone={searchBadgeTone(b)}
                              data-search-result-badge={b}
                            >
                              {renderBadgeLabel(b)}
                            </AppStatusBadge>
                          ))}
                        </span>
                      ) : null}

                      {/* A timestamp reads left-to-right inside an RTL card. */}
                      <span className="search-result__time">
                        updated {formatDateTime(row.updatedAtUtc)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {results?.nextCursor ? (
            <div className="search-results__more">
              <button
                type="button"
                className="app-secondary-action"
                onClick={loadMore}
                disabled={loading}
                aria-busy={loading}
                data-search-load-more
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>

        {/* ----------------------------- RIGHT ----------------------------- */}
        <div className="search-col">
          {!selected ? (
            <SearchGuidancePanel
              recent={recent}
              onApplyRecent={(q) => {
                setQDraft(q);
                updateFilter({ q });
              }}
              onClearRecent={clearRecent}
              saved={savedViewEntries}
              onApplySaved={(id) => {
                const view = savedViews?.find((v) => v.id === id);
                if (view) applySavedView(view);
              }}
              supportHref={SUPPORT_HREF}
            />
          ) : (
            <Inspector
              row={selected}
              relationships={relationships}
              canSeeWorkflows={canSeeWorkflows}
              canSeeInvestigation={canSeeInvestigation}
            />
          )}
        </div>
        </div>
      </div>
      </>
      )}
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
// `docTypeTone` and `badgeTone` used to live here. Both are now in
// `./searchTones`, which the result rows and the Inspector share — a mapping
// that exists twice is a mapping that will eventually disagree with itself.

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
  canSeeWorkflows,
  canSeeInvestigation,
}: {
  row: ResultRow;
  relationships: Relationship[] | null;
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
  const lifecycle = rowLifecycleState(row);
  // Same rule as the result row: the panel states a fact once.
  const subtitle =
    row.subtitle &&
    lifecycle &&
    searchLifecycleLabel(row.subtitle) === searchLifecycleLabel(lifecycle)
      ? null
      : row.subtitle;
  return (
    <div className="app-panel search-inspector" data-search-inspector>
      {/* Content-sized. This is a grid, and a grid item stretches to its
          column unless told otherwise — which is why this badge used to run
          the full width of the panel. `.search-type-badge` carries the
          `justify-self` that stops it. */}
      <AppStatusBadge
        className="search-type-badge"
        tone={searchTypeTone(row.documentType)}
        data-search-inspector-type={row.documentType}
      >
        {DOCUMENT_TYPE_LABEL[row.documentType] ?? row.documentType}
      </AppStatusBadge>
      {/* Bounded: a long record name wraps rather than widening the column. */}
      <h2 className="search-inspector__title">{row.title}</h2>
      {lifecycle ? (
        <AppStatusBadge
          className="search-type-badge"
          tone={searchLifecycleTone(lifecycle)}
          dot
          data-search-inspector-lifecycle={lifecycle}
        >
          {searchLifecycleLabel(lifecycle)}
        </AppStatusBadge>
      ) : null}
      {subtitle ? (
        <p className="search-inspector__status">{subtitle}</p>
      ) : null}
      {/* The single way out of this panel. An OUTLINED action, not a solid
          one: the panel already has a primary subject — the record — and a
          filled purple slab competed with it. It stays an <a> so the
          browser's own middle-click and cmd-click open-in-new-tab keep
          working, and it takes the tone of the record it opens, so an
          Evidence panel does not put a purple control on an orange record. */}
      {openAction ? (
        <a
          href={openAction.href}
          className={`app-secondary-action ${
            searchTypeTone(row.documentType) === "orange"
              ? "app-secondary-action--orange"
              : "app-secondary-action--accent"
          } search-inspector__action`}
          data-search-open-action={row.documentType}
          data-search-open-href={openAction.href}
        >
          {openAction.label}
        </a>
      ) : null}
      <hr className="search-inspector__divider" />

      {row.badges.length > 0 ? (
        <Section label="Signals">
          <div className="search-inspector__badges">
            {row.badges.map((b) => (
              <AppStatusBadge
                key={b}
                tone={searchBadgeTone(b)}
                data-search-inspector-badge={b}
              >
                {renderBadgeLabel(b)}
              </AppStatusBadge>
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
              <a className="search-pointer" href={`/evidence/${row.evidenceId}`}>
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
                  className="search-pointer"
                  href={`/workflows/${row.workflowInstanceId}`}
                >
                  {row.workflowInstanceId}
                </a>
              ) : (
                // Phase IA-self-serve-completion — show the ID but
                // not the link for self-serve users. /workflows is
                // ENTERPRISE_ONLY.
                <span className="search-pointer">{row.workflowInstanceId}</span>
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
              <a className="search-pointer" href={`/cases/${row.caseId}`}>
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
            <p className="app-hint">
              Semantically similar to: {row.title.slice(0, 80)}
              {row.title.length > 80 ? "…" : ""}
            </p>
          ) : null}
          {row.caseId ? (
            <KeyVal
              label="Case graph"
              value={
                <a
                  className="app-secondary-action"
                  href={`/investigation/cases/${row.caseId}/graph`}
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
                  className="app-secondary-action"
                  href={`/investigation/timeline?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
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
                  className="app-secondary-action"
                  href={`/investigation/duplicates?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
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
          <p className="app-hint">
            Semantically similar to: {row.title.slice(0, 80)}
            {row.title.length > 80 ? "…" : ""}
          </p>
        </Section>
      ) : null}

      <Section label="Lifecycle">
        {/* Each fact is coloured by the ONE lifecycle mapping, so WORKFLOW:
            Open here is the same green as Open on the row. An absent value is
            a neutral dash — never green, which would read as "fine", and
            never red, which would read as "wrong". */}
        <LifecycleFact label="Review" value={row.reviewState} />
        <LifecycleFact label="Workflow" value={row.workflowState} />
        <LifecycleFact label="Export" value={row.exportState} />
        <LifecycleFact label="Retention" value={row.retentionState} />
        <LifecycleFact label="Legal hold" value={row.legalHoldState} />
        <KeyVal label="Updated" value={formatDateTime(row.updatedAtUtc)} />
      </Section>

      {row.summary ? (
        <Section label="Summary">
          <p className="search-inspector__prose">{row.summary}</p>
        </Section>
      ) : null}

      {row.evidenceId ? (
        <Section label="Related evidence">
          {relationships === null ? (
            <p className="app-hint">Loading…</p>
          ) : relationships.length === 0 ? (
            <p className="app-hint">No related evidence.</p>
          ) : (
            <ul className="search-relationship-list">
              {relationships.map((r) => {
                const otherId =
                  r.sourceEvidenceId === row.evidenceId
                    ? r.targetEvidenceId
                    : r.sourceEvidenceId;
                return (
                  <li key={r.relationshipId} className="search-relationship">
                    <span className="app-chip">{r.relationshipType}</span>
                    {/* The full identifier, not a truncated one: it is the
                        thing the operator would copy, and it reads
                        left-to-right whatever the surrounding direction. */}
                    <a className="search-pointer" href={`/evidence/${otherId}`}>
                      {otherId}
                    </a>
                    {r.note ? (
                      <span className="search-relationship__note">{r.note}</span>
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

/**
 * One filter dimension. A fieldset/legend rather than two divs, so the group
 * label is the accessible name of the controls inside it — screen readers
 * announce "Document type, Evidence, not pressed" instead of a bare chip.
 */
function FilterSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="search-filters__group">
      <legend className="search-filters__legend">{label}</legend>
      {children}
    </fieldset>
  );
}

/**
 * One lifecycle fact. Informational — a state is something the console
 * REPORTS, so it is a badge and never a control.
 */
function LifecycleFact({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  const kind = searchLifecycleTone(value);
  return (
    <div className="search-fact">
      <span className="search-fact__label">{label}</span>
      {isLifecycleValue(value) ? (
        <AppStatusBadge
          className="search-fact__badge"
          tone={kind}
          data-search-lifecycle-fact={label}
        >
          {searchLifecycleLabel(value)}
        </AppStatusBadge>
      ) : (
        <span className="search-fact__value" data-search-lifecycle-fact={label}>
          {searchLifecycleLabel(value)}
        </span>
      )}
    </div>
  );
}

/** One labelled group of facts inside the Inspector. */
function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="search-inspector__section">
      <h3 className="search-inspector__section-label">{label}</h3>
      {children}
    </section>
  );
}

/** A lifecycle filter: a real checkbox, wearing the canonical control skin. */
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
    <label className="search-toggle-row">
      <input
        type="checkbox"
        className="app-checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * One fact. Label and value hold their own axes so every fact in the column
 * lines up.
 *
 * `mono` marks an IDENTIFIER rather than a value: a UUID is too wide to share
 * a baseline row with its label in a 320px rail, so it stacks underneath and
 * takes the pointer treatment — monospaced, bounded, and isolated to
 * left-to-right so it survives an RTL surface intact.
 */
function KeyVal({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  if (mono) {
    return (
      <div className="search-inspector__pointer">
        <span className="search-fact__label">{label}</span>
        {typeof value === "string" ? (
          <span className="search-pointer">{value}</span>
        ) : (
          value
        )}
      </div>
    );
  }
  return (
    <div className="search-fact">
      <span className="search-fact__label">{label}</span>
      <span className="search-fact__value">{value}</span>
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
  // Phase 16 — when the `GET /v1/search/semantic/status` request fails
  // we use the per-response signal instead and skip the "disabled vs
  // unavailable" split. The chip still renders the Phase 13 / Phase 15
  // wording in that case.
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
  const tone: AppTone =
    status === "active"
      ? "green"
      : status === "fallback" || status === "unavailable"
        ? "amber"
        : status === "blocked"
          ? "red"
          : "slate";
  return (
    <AppStatusBadge tone={tone} dot data-semantic-search-status={status}>
      {label}
    </AppStatusBadge>
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
      className="app-inner-surface search-admin-panel"
      data-semantic-backfill-panel
    >
      <span className="search-admin-panel__label">Semantic backfill</span>
      {dayLine ? <p className="app-hint">{dayLine}</p> : null}
      {budgetLine ? <p className="app-hint">{budgetLine}</p> : null}
      <button
        type="button"
        className="app-secondary-action"
        onClick={onRun}
        disabled={running}
        aria-busy={running}
        data-action="semantic-backfill-dry-run"
      >
        {running ? "Running dry run…" : "Run backfill (dry run)"}
      </button>
      {result ? (
        <p className="app-hint">
          Would embed {result.chunksToEmbed} chunk
          {result.chunksToEmbed === 1 ? "" : "s"} across {result.workspaceCount}{" "}
          workspace
          {result.workspaceCount === 1 ? "" : "s"}.
        </p>
      ) : null}
      {error ? (
        <div className="app-alert app-alert--danger" role="alert">
          {error}
        </div>
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
// Styles.
//
// REDESIGN/SEARCH — this console has no style objects left.
//
// Its presentation lives in `search.css`, `components/SearchStates.tsx`,
// `components/SearchGuidance.tsx` and the canonical `app-*` primitives. All
// sixty `React.CSSProperties` objects that used to sit here — page, header,
// form, workspace grid, filter rail, result list, states, inspector, guidance,
// typeahead and admin strip — are deleted, not hidden and not overridden.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Phase 15 — additive styles.
// -----------------------------------------------------------------------------

// Phase SEARCH-REMEDIATION — `searchModeSelectorStyle` +
// `searchModeButtonStyle` removed alongside the SearchModeSelector
// component above. Keep the section header so future style helpers
// have a home.

// Phase SEARCH-REMEDIATION-3 — `noResultsHelpStyle`,
// `noResultsLeadStyle`, `noResultsListStyle` removed alongside
// the `NoResultsHelp` component. The truthful empty state uses
// the page's existing `emptyStateStyle` token.

// Phase 16 — admin-only backfill panel + inline "Try semantic search"
// link button. Both surfaces share the page's design tokens; no new
// colours or spacing primitives.

// Phase SEARCH-REMEDIATION-3 — `inlineLinkButtonStyle` removed
// alongside the `NoResultsHelp` "Try semantic search" link.

// ---------------------------------------------------------------------------
// `PreviewDefault` was deleted here.
//
// It rendered the same three ideas the canonical `SearchGuidancePanel` does —
// recent searches, saved searches, tips — from ~150 lines of inline styles, in
// its own typography, with its own link colour. One guidance column now serves
// the region, and it also carries the support card the old preview never had.
// ---------------------------------------------------------------------------

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
    <div className="search-typeahead" role="listbox" data-search-typeahead>
      {showRecentEmpty ? (
        <p className="search-typeahead__empty" data-search-typeahead-recent-empty>
          Tip: try searching by filename, case name, or report title.
        </p>
      ) : null}

      {showRecent && recent.length > 0 ? (
        <div className="search-typeahead__group" data-search-typeahead-recent>
          <div className="search-typeahead__label">
            <span>Recent searches</span>
            <button
              type="button"
              className="search-typeahead__clear"
              onMouseDown={(e) => {
                // The input's blur closes this list. Preventing the default
                // here lets the click land before the list unmounts.
                e.preventDefault();
                onClearRecent();
              }}
              data-search-typeahead-clear-recent
            >
              Clear
            </button>
          </div>
          {recent.map((r, idx) => (
            <button
              type="button"
              key={`recent-${idx}`}
              className="search-typeahead__item"
              role="option"
              aria-selected={highlighted === idx}
              data-highlighted={highlighted === idx ? "true" : "false"}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(r);
              }}
              data-search-typeahead-recent-row={r}
            >
              <span className="search-typeahead__item-title">{r}</span>
            </button>
          ))}
        </div>
      ) : null}

      {showSuggestions ? (
        <div className="search-typeahead__group" data-search-typeahead-suggestions>
          <div className="search-typeahead__label">
            <span>Suggestions</span>
          </div>
          {suggestions.map((sug, idx) => (
            <button
              type="button"
              key={sug.id}
              className="search-typeahead__item"
              role="option"
              aria-selected={highlighted === idx}
              data-highlighted={highlighted === idx ? "true" : "false"}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(sug.title);
              }}
              data-search-typeahead-suggestion={sug.id}
              data-search-typeahead-suggestion-type={sug.documentType}
            >
              <span className="search-typeahead__item-title">{sug.title}</span>
              {/* The kind of record, in the same words the result rows use. */}
              <span className="app-chip">
                {DOCUMENT_TYPE_LABEL[sug.documentType] ?? sug.documentType}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {showEmpty ? (
        <p className="search-typeahead__empty" data-search-typeahead-empty>
          No matching titles. Press Enter to search anyway.
        </p>
      ) : null}
    </div>
  );
}
