"use client";

/**
 * OPERATIONS — the workspace operational-condition workbench.
 *
 * ===========================================================================
 * WHAT THIS ROUTE IS
 * ===========================================================================
 * The shared surface where a workspace finds unresolved operational
 * conditions, decides which matter, gives them an owner, and closes them. It
 * is a WORKBENCH: the queue is the page, and everything above it exists to
 * filter the queue.
 *
 * ===========================================================================
 * WHAT WAS WRONG WITH THE PAGE THIS REPLACES
 * ===========================================================================
 * Production rendered TWO page shells stacked on top of each other, and two
 * thirds of the page were PLATFORM RUNTIME read from `/v1/ops/health` and
 * `/v1/ops/metrics` — properties of the API PROCESS that reset on deploy, are
 * identical for every tenant and actionable by none. They belong to
 * `/admin/platform/observability`. THIS ROUTE NO LONGER FETCHES EITHER
 * ENDPOINT — the only reads below are `/v1/ops/summary`, `/v1/ops/incidents`,
 * `/v1/ops/incident-groups`, `/v1/ops/incidents/:id`, the saved views and
 * `/v1/ops/assignable-operators`, all of which are workspace-scoped.
 *
 * ===========================================================================
 * WHY THERE IS NO PLAN BRANCH IN THIS FILE
 * ===========================================================================
 * Personal Pro, a shared Team, an Organization workspace and an Enterprise
 * customer all render THIS component. Two server-projected signals shape it:
 *
 *   capabilities.OPERATIONS_*   what this caller may DO
 *   workspace.operatorCount     whether OWNERSHIP is a real axis here
 *
 * ===========================================================================
 * HONESTY
 * ===========================================================================
 * Every read carries `complete` / `mayAssertAllClear`. "Workspace operations
 * are clear" renders only when the incident source said it reached the end of
 * the collection. A failed or truncated read produces a degraded banner and
 * never a reassuring empty state.
 *
 * ===========================================================================
 * THE 2026-10-12 CONTRACT (this revision)
 * ===========================================================================
 *   * EVERY KPI OPENS THE LIST WITH THE PREDICATE THAT COUNTED IT. Each card
 *     writes its whole predicate (the unresolved cards status UNRESOLVED,
 *     Resolved status RESOLVED) into the address.
 *   * (2026-10-14) `/operations` with no query opens the flat "All
 *     conditions" list with lifecycle ALL — history included, and said so.
 *     Presentation (`?view=grouped`) and lifecycle (`?status=`) are separate
 *     dimensions in the URL, so refresh and Back/Forward restore both.
 *   * (2026-10-14) EMPTINESS IS DECIDED FROM AUTHORITATIVE, UNFILTERED COUNTS:
 *     the summary's unresolved count plus its all-time resolved count. Only a
 *     retained total of zero may render the first-use panel; a workspace with
 *     only resolved history sees that history and at most one quiet line.
 *   * A SUMMARY THAT COULD NOT BE READ IS UNKNOWN. Its counts are null and the
 *     strip says "Unavailable"; a bounded scan says "at least N". Neither may
 *     produce a 0, an all-clear, or an automatic re-check.
 *   * EVERY RESPONSE IS BOUND TO THE WORKSPACE THAT ASKED. Switching workspace
 *     clears every per-workspace slice before the new name renders, and every
 *     read — summary, list, groups, resolved, detail, affected, saved views,
 *     operators, load-more, the re-check poll and a remediation — is checked
 *     against the active workspace and its own sequence when it lands.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { PageShell } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import {
  toSafeUserError,
  type SafeUserError,
} from "../../../lib/feedback/toSafeUserError";
import {
  useActiveWorkspaceId,
  useOwningContextLabel,
  usePlatformContext,
} from "../../../lib/platform-context";
import type { CapabilityKey } from "../../../lib/platform-context/types";
import { resolveRuntimeReadAccess } from "../../../lib/platform-context/runtimeReadAccess";

import "./operations.css";

import { BulkToolbar } from "./_components/BulkToolbar";
import { FilterToolbar } from "./_components/FilterToolbar";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../components/identity-security/StepUpModal";
import { IncidentInspector } from "./_components/IncidentInspector";
import { SavedViews } from "./_components/SavedViews";
import { IncidentSurface } from "./_components/IncidentSurface";
import { GroupSurface } from "./_components/GroupSurface";
import { GroupInspector } from "./_components/GroupInspector";
import { QueueSummary, summaryUnknown } from "./_components/QueueSummary";
import type { RestrictedReason } from "./_components/States";
import {
  ClearState,
  DegradedNotice,
  InlineMutationError,
  LoadingState,
  NoMatchState,
  PartialCoverageNotice,
  PreparingState,
  ReconcilingNotice,
  ReconciliationFailedNotice,
  ReconciliationStalledNotice,
  RefreshingNotice,
  RestrictedState,
  StaleStatusNotice,
  UnavailableState,
  UnconfirmedEmptyState,
} from "./_components/States";
import { IconOperations, IconRefresh } from "./_components/icons";
import {
  DEFAULT_FILTERS,
  DEFAULT_PRESENTATION,
  PAGE_SIZE,
  VIEW_PARAM,
  anyFilterActive,
  anyNarrowingFilter,
  filtersForMetric,
  filtersFromParams,
  groupsQuery,
  incidentsQuery,
  metricForFilters,
  operationsHref,
  presentationFromParams,
  type FilterState,
  type Presentation,
} from "./_lib/filters";
import { buildRowModel } from "./_lib/rowModel";
import {
  fillOperationsCopy,
  useOpsCopy,
  useOpsLocale,
  useOpsNumber,
  useOpsTime,
  type OperationsCopy,
} from "./_lib/copy";
import {
  classifyOpsError,
  classifyReconcileRefusal,
  opsErrorMessage,
  reconcileErrorMessage,
} from "./_lib/errors";
import {
  bulkActionItemSettled,
  bulkActionItemSucceeded,
  conditionSourceLabel,
  makeClientRequestKey,
} from "@proovra/shared";
import type {
  AssignableOperator,
  Incident,
  IncidentDetail,
  IncidentDetailResponse,
  BulkActionResponse,
  OperationsSavedView,
  SlaEnvelope,
  ProjectedRemediation,
  RemediationOutcome,
  IncidentListResponse,
  OperationsCapabilities,
  OperationsSummary,
  SourceState,
  IncidentGroup,
  IncidentGroupTotals,
  AffectedRecord,
} from "./_lib/types";
import type { QueueMetricKey } from "./_lib/vocabulary";

// ---------------------------------------------------------------------------

const LOADING = { kind: "loading" } as const;

/**
 * A failed read becomes an operator-facing sentence, never a provider string.
 */
function sourceErrorFor(
  surface: "summary" | "incidents" | "detail",
  err: unknown,
  copy: OperationsCopy,
): { message: string; requestId?: string } {
  const safe = toSafeUserError(err, {
    message:
      surface === "summary"
        ? copy.degradedSummary
        : surface === "incidents"
          ? copy.workspaceUnavailable
          : copy.drawer.historyLoadFailed,
  });
  return { message: safe.message, requestId: safe.supportReference };
}

/**
 * WHICH SECTION A GROUP WAS OPENED FROM.
 *
 * One source can hold an unresolved group in "Action required" AND a resolved
 * group in "Resolved in the last 7 days" under the same groupKey. Keying the
 * inspector on the groupKey alone opened whichever list `find` met first —
 * so pressing the resolved row could show the unresolved group and drill
 * into the wrong members. The section travels with the key.
 */
type GroupSection = "action" | "monitoring" | "resolved" | "filtered";
type OpenGroupRef = { section: GroupSection; groupKey: string };

export default function OperationsPage() {
  return (
    <PageRouteGate routeId="workspace.operations">
      <OperationsWorkbench />
    </PageRouteGate>
  );
}

function OperationsWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = useActiveWorkspaceId();
  const { envelope } = usePlatformContext();
  const { workspaceName } = useOwningContextLabel();
  // OPS-020 / D10 — the page in the reader's language (shared dictionary).
  const copy = useOpsCopy();
  const locale = useOpsLocale();
  const time = useOpsTime();
  const fmt = useOpsNumber();

  /**
   * THE WORKSPACE A RESPONSE MUST STILL BELONG TO.
   *
   * Read by every response handler. A response for a workspace the operator
   * has since left is discarded — whatever its own sequence says — because
   * the server answered both questions correctly and only the client can tell
   * that the question is no longer the one on screen.
   */
  const teamRef = React.useRef<string | null>(teamId);
  teamRef.current = teamId;

  /**
   * OPS-020 / D9 — ONE live region for the outcome of an action. The same
   * sentence twice in a row ("Condition acknowledged.") must be announced
   * twice, and a live region whose text does not change announces nothing —
   * so it is cleared first and the sentence set on the next task.
   */
  const [announcement, setAnnouncement] = React.useState("");
  const announceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = React.useCallback((text: string) => {
    setAnnouncement("");
    if (announceTimer.current) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      setAnnouncement(text);
    }, 30);
  }, []);
  React.useEffect(
    () => () => {
      if (announceTimer.current) clearTimeout(announceTimer.current);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // CAPABILITIES — resolved once, server-projected, never re-derived.
  // -------------------------------------------------------------------------
  const capabilityMap: Partial<Record<CapabilityKey, boolean>> =
    envelope?.capabilities ?? {};
  const capabilities: OperationsCapabilities = React.useMemo(() => {
    const canAcknowledge = capabilityMap.OPERATIONS_ACKNOWLEDGE === true;
    const canResolve = capabilityMap.OPERATIONS_RESOLVE === true;
    const canSuppress = capabilityMap.OPERATIONS_SUPPRESS === true;
    const canAssign = capabilityMap.OPERATIONS_ASSIGN === true;
    const canManageSharedViews =
      capabilityMap.OPERATIONS_SAVED_VIEWS_MANAGE === true;
    return {
      canAcknowledge,
      canResolve,
      canSuppress,
      canAssign,
      canManageSharedViews,
      // Deliberately NOT including `canManageSharedViews`: this decides
      // whether INCIDENT actions render.
      canActOnAnything:
        canAcknowledge || canResolve || canSuppress || canAssign,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    capabilityMap.OPERATIONS_ACKNOWLEDGE,
    capabilityMap.OPERATIONS_RESOLVE,
    capabilityMap.OPERATIONS_SUPPRESS,
    capabilityMap.OPERATIONS_ASSIGN,
    capabilityMap.OPERATIONS_SAVED_VIEWS_MANAGE,
  ]);
  const canView = capabilityMap.OPERATIONS_VIEW === true;
  /**
   * D15 — may this reader open an Evidence record from a group's drill-down?
   * The envelope's EVIDENCE_VIEW for this workspace: Operations access is not
   * evidence access, and a link the reader cannot follow is withheld.
   */
  const canOpenRecords = capabilityMap.EVIDENCE_VIEW === true;
  const viewerUserId = envelope?.account?.userId ?? null;

  // -------------------------------------------------------------------------
  // FILTERS — the URL is the state, so a filtered queue is a shareable link.
  // A deliberate change of filters, presentation or reset is a NEW history
  // entry (router.push), so Back and Forward step through exactly the views
  // the reader chose; opening or closing a drawer only rewrites the address.
  // -------------------------------------------------------------------------
  const searchKey = searchParams?.toString() ?? "";
  // The filters are the query WITHOUT `?incident=`: opening or closing a
  // condition's drawer changes the URL, and must not re-read the queue.
  const filterKey = React.useMemo(() => {
    const p = new URLSearchParams(searchKey);
    p.delete("incident");
    // The legacy alias is a drawer address too, never a filter.
    p.delete("incidentId");
    // The PRESENTATION is not a filter either: switching between the flat
    // list and the grouped view must not re-read the queue.
    p.delete(VIEW_PARAM);
    return p.toString();
  }, [searchKey]);
  const filters = React.useMemo(
    () => filtersFromParams(new URLSearchParams(filterKey)),
    [filterKey],
  );

  // -------------------------------------------------------------------------
  // PRESENTATION — flat "All conditions" (the default) or grouped, a separate
  // dimension from the lifecycle filter. The URL is its authority (refresh
  // keeps it, Back/Forward restores it); the local mirror is what a click
  // flips at once, re-synced whenever the address changes.
  // -------------------------------------------------------------------------
  const urlPresentation: Presentation = React.useMemo(
    () => presentationFromParams(new URLSearchParams(searchKey)),
    [searchKey],
  );
  const [grouped, setGrouped] = React.useState(urlPresentation === "grouped");
  React.useEffect(() => {
    setGrouped(urlPresentation === "grouped");
  }, [urlPresentation]);
  const presentation: Presentation = grouped ? "grouped" : "flat";
  /** The drawer address on screen, kept across a filter change. */
  const incidentParam = React.useMemo(
    () => new URLSearchParams(searchKey).get("incident"),
    [searchKey],
  );

  const applyFilters = React.useCallback(
    (next: FilterState) => {
      router.push(operationsHref(next, presentation, incidentParam), {
        scroll: false,
      });
    },
    [router, presentation, incidentParam],
  );
  const patchFilters = React.useCallback(
    (patch: Partial<FilterState>) => applyFilters({ ...filters, ...patch }),
    [applyFilters, filters],
  );
  const clearFilters = React.useCallback(
    () => applyFilters({ ...DEFAULT_FILTERS }),
    [applyFilters],
  );

  /**
   * APPLY A SAVED VIEW.
   *
   * Writes the URL like every other filter change. Every field the view did
   * not set falls back to the DEFAULT, so a named view means the same thing
   * whatever was on screen. D11 — the SLA posture is part of the view.
   */
  const applyView = React.useCallback(
    (view: OperationsSavedView) => {
      const f = view.filter;
      applyFilters({
        ...DEFAULT_FILTERS,
        sla: (f.sla ?? "") as FilterState["sla"],
        status: (f.status ?? DEFAULT_FILTERS.status) as FilterState["status"],
        severity: (f.severity ?? "") as FilterState["severity"],
        category: (f.category ?? "") as FilterState["category"],
        owner: (f.owner ?? "any") as FilterState["owner"],
        q: f.q ?? "",
        sort: (f.sort ?? DEFAULT_FILTERS.sort) as FilterState["sort"],
      });
    },
    [applyFilters],
  );

  // -------------------------------------------------------------------------
  // SOURCES
  // -------------------------------------------------------------------------
  const [summary, setSummary] =
    React.useState<SourceState<OperationsSummary>>(LOADING);
  const [operatorCount, setOperatorCount] = React.useState<number | null>(null);
  const [incidents, setIncidents] =
    React.useState<SourceState<Incident[]>>(LOADING);
  const [complete, setComplete] = React.useState(true);
  /** The workspace's own SLA commitment, sent with the list. */
  const [sla, setSla] = React.useState<SlaEnvelope | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  /** A FAILED NEXT PAGE, reported beside the pagination control. */
  const [loadMoreError, setLoadMoreError] =
    React.useState<SafeUserError | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastLoadedAtUtc, setLastLoadedAtUtc] = React.useState<string | null>(
    null,
  );
  const [reloadToken, setReloadToken] = React.useState(0);

  const [savedViews, setSavedViews] = React.useState<OperationsSavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = React.useState(false);

  const [operators, setOperators] = React.useState<AssignableOperator[]>([]);
  const [selfUserId, setSelfUserId] = React.useState<string | null>(null);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const openIdRef = React.useRef<string | null>(openId);
  openIdRef.current = openId;

  // THE GROUPED QUEUE — one presentation of the selected conditions (the
  // flat list is the default; `grouped` is declared with the URL above).
  const [groups, setGroups] = React.useState<IncidentGroup[]>([]);
  const [groupTotals, setGroupTotals] = React.useState<IncidentGroupTotals | null>(
    null,
  );
  const [groupsLoading, setGroupsLoading] = React.useState(false);
  /** OPS-036 — A FAILED GROUPED READ IS UNAVAILABLE, NOT EMPTY. */
  const [groupsError, setGroupsError] = React.useState<SafeUserError | null>(null);
  /**
   * The "Resolved" section's own read: EVERY resolved group under the default
   * lifecycle (ALL) — the same population the Resolved filter selects, so
   * grouping the All view never drops resolved history (2026-10-23).
   */
  const [resolvedGroups, setResolvedGroups] = React.useState<IncidentGroup[]>([]);
  const [resolvedTotals, setResolvedTotals] = React.useState<IncidentGroupTotals | null>(null);
  /** Loading is not empty: the section claims nothing until its read lands. */
  const [resolvedLoading, setResolvedLoading] = React.useState(false);
  /** A failed read of that section is unavailable, never "nothing resolved". */
  const [resolvedUnavailable, setResolvedUnavailable] = React.useState(false);
  const [openGroupRef, setOpenGroupRef] = React.useState<OpenGroupRef | null>(null);
  const openGroupRefRef = React.useRef<OpenGroupRef | null>(openGroupRef);
  openGroupRefRef.current = openGroupRef;

  /** The drill-down's accumulated pages for the OPEN group. */
  const [affected, setAffected] = React.useState<AffectedRecord[]>([]);
  const [affectedCursor, setAffectedCursor] = React.useState<string | null>(null);
  const [affectedHasMore, setAffectedHasMore] = React.useState(false);
  const [affectedLoading, setAffectedLoading] = React.useState(false);
  const [affectedError, setAffectedError] = React.useState<string | null>(null);

  const [detail, setDetail] =
    React.useState<SourceState<IncidentDetail>>(LOADING);
  /** What this operator may do about the open condition, server-projected. */
  const [remediation, setRemediation] =
    React.useState<ProjectedRemediation | null>(null);
  const [remediationBusy, setRemediationBusy] = React.useState<string | null>(
    null,
  );
  const [remediationOutcome, setRemediationOutcome] =
    React.useState<RemediationOutcome | null>(null);
  /** Set only when the last remediation answer was retryable (D6). */
  const [remediationRetry, setRemediationRetry] = React.useState<
    (() => void) | null
  >(null);

  const [markedIds, setMarkedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The PER-TARGET answer to the last sweep. */
  const [bulkOutcome, setBulkOutcome] = React.useState<string | null>(null);
  const [mutationError, setMutationError] =
    React.useState<SafeUserError | null>(null);
  /** The "Try again" for the current mutation error — only when retryable. */
  const [mutationRetry, setMutationRetry] = React.useState<(() => void) | null>(
    null,
  );
  const showMutationError = React.useCallback(
    (error: SafeUserError | null, retry?: (() => void) | null) => {
      setMutationError(error);
      setMutationRetry(() => (error && retry ? retry : null));
    },
    [],
  );

  // -------------------------------------------------------------------------
  // D1 — A WORKSPACE SWITCH CLEARS EVERY PER-WORKSPACE SLICE, IN THE SAME
  // RENDER THAT FIRST SEES THE NEW WORKSPACE.
  //
  // An effect would run AFTER that render had painted the new workspace's
  // name over the previous workspace's summary, groups, saved views and open
  // drawer. React's "adjust state while rendering" pattern resets them before
  // anything is committed, so the new name only ever appears beside a loading
  // state or the new workspace's own data.
  // -------------------------------------------------------------------------
  const [scopeTeamId, setScopeTeamId] = React.useState<string | null>(teamId);
  if (scopeTeamId !== teamId) {
    setScopeTeamId(teamId);
    setSummary(LOADING);
    setOperatorCount(null);
    setIncidents(LOADING);
    setComplete(true);
    setSla(null);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    setRefreshing(false);
    setLastLoadedAtUtc(null);
    setSavedViews([]);
    setSavedViewsLoading(false);
    setOperators([]);
    setSelfUserId(null);
    setOpenId(null);
    setGroups([]);
    setGroupTotals(null);
    setGroupsLoading(false);
    setGroupsError(null);
    setResolvedGroups([]);
    setResolvedTotals(null);
    setResolvedLoading(false);
    setResolvedUnavailable(false);
    setOpenGroupRef(null);
    setAffected([]);
    setAffectedCursor(null);
    setAffectedHasMore(false);
    setAffectedLoading(false);
    setAffectedError(null);
    setDetail(LOADING);
    setRemediation(null);
    setRemediationBusy(null);
    setRemediationOutcome(null);
    setRemediationRetry(null);
    setMarkedIds(new Set());
    setPendingId(null);
    setBusy(false);
    setBulkOutcome(null);
    setMutationError(null);
    setMutationRetry(null);
    setAnnouncement("");
  }

  /**
   * OPS-020 — A CONDITION IS URL-ADDRESSABLE. `?incident=<id>` opens its
   * drawer. The id is read by the drawer's own detail request, which the
   * server authorizes; an id from another workspace is simply not found.
   */
  React.useEffect(() => {
    const params = new URLSearchParams(searchKey);
    // `?incidentId=` is a LEGACY alias: the inbox and the Command Center
    // linked with it while this page read only `?incident=`, so those links
    // opened the queue and never the drawer. It is honoured, and the address
    // is normalised to the one canonical spelling.
    const legacy = params.get("incidentId");
    const id = params.get("incident") ?? legacy;
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setOpenId(id);
    if (legacy !== null) {
      params.delete("incidentId");
      if (id && /^[0-9a-f-]{36}$/i.test(id)) params.set("incident", id);
      const qs = params.toString();
      router.replace(qs ? `/operations?${qs}` : "/operations", { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);
  /**
   * A CONDITION ADDRESS BELONGS TO ITS WORKSPACE. Switching workspace already
   * closes the drawer (the render-time reset above); the address loses the
   * previous tenant's `?incident=` too, so a refresh or a shared link never
   * asks the new workspace for the old one's condition. Filters stay.
   */
  const incidentScopeRef = React.useRef<string | null>(teamId);
  React.useEffect(() => {
    const previous = incidentScopeRef.current;
    incidentScopeRef.current = teamId;
    if (!previous || !teamId || previous === teamId) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("incident") && !params.has("incidentId")) return;
    params.delete("incident");
    params.delete("incidentId");
    const qs = params.toString();
    router.replace(qs ? `/operations?${qs}` : "/operations", { scroll: false });
  }, [teamId, router]);
  const setIncidentInUrl = React.useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchKey);
      params.delete("incidentId");
      if (id) params.set("incident", id);
      else params.delete("incident");
      const qs = params.toString();
      router.replace(qs ? `/operations?${qs}` : "/operations", { scroll: false });
    },
    [router, searchKey],
  );
  const openIncident = React.useCallback(
    (id: string) => {
      setOpenGroupRef(null);
      setOpenId(id);
      setIncidentInUrl(id);
    },
    [setIncidentInUrl],
  );
  const closeIncident = React.useCallback(() => {
    setOpenId(null);
    setIncidentInUrl(null);
  }, [setIncidentInUrl]);

  /**
   * SWITCH PRESENTATION. The filters travel unchanged — presentation and
   * lifecycle are separate dimensions. Grouped closes a condition drawer (its
   * rows are groups); the flat list closes a group drawer and keeps an open
   * condition's address.
   */
  const switchPresentation = React.useCallback(
    (next: Presentation) => {
      setGrouped(next === "grouped");
      if (next === "grouped") setOpenId(null);
      else setOpenGroupRef(null);
      router.push(
        operationsHref(filters, next, next === "grouped" ? null : incidentParam),
        { scroll: false },
      );
    },
    [router, filters, incidentParam],
  );

  /**
   * "Reset filters" — back to the page DEFAULTS: every lifecycle state, the
   * flat "All conditions" list, no search, no severity, source or commitment.
   */
  const resetToDefaults = React.useCallback(() => {
    setGrouped(DEFAULT_PRESENTATION === "grouped");
    setOpenGroupRef(null);
    router.push(operationsHref({ ...DEFAULT_FILTERS }, DEFAULT_PRESENTATION, incidentParam), {
      scroll: false,
    });
  }, [router, incidentParam]);

  /**
   * EACH READ OWNS ITS SEQUENCE. Sharing one counter means the second read to
   * finish invalidates the first (OPS-007): a detail read discarded a list
   * response and Refresh stayed disabled for good. Every handler checks its
   * own sequence AND the workspace.
   */
  const requestSeq = React.useRef(0);
  const detailSeq = React.useRef(0);
  const groupsSeq = React.useRef(0);
  const resolvedSeq = React.useRef(0);
  const affectedSeq = React.useRef(0);
  const savedViewsSeq = React.useRef(0);
  /** D3 — the operator list's OWN sequence (it borrowed the list's). */
  const operatorsSeq = React.useRef(0);
  /** D8 — the remediation request's identity. */
  const remediationSeq = React.useRef(0);

  /** The CANONICAL step-up control, shared with every bulk fan-out. */
  const stepUp = useStepUpAction({ teamId });

  /**
   * MAY THIS CONTEXT READ OPERATIONAL DATA AT ALL? The SAME predicate the
   * application shell asks before its runtime poller fires.
   */
  const readAccess = resolveRuntimeReadAccess({ envelope, teamId });

  // ORDER MATTERS: the envelope knows the real reason a workspace did not
  // resolve, so it is asked before the symptom (`!teamId`) is.
  const gate: null | RestrictedReason = !envelope
    ? "no_envelope"
    : readAccess.refusedReason === "context_mismatch"
      ? "context_mismatch"
      : readAccess.refusedReason === "account_not_active"
        ? "account_not_active"
        : !teamId
          ? "no_workspace"
          : !canView || !readAccess.incidents
            ? "not_included"
            : null;

  // ==========================================================================
  // THE GROUPED READ
  // ==========================================================================
  React.useEffect(() => {
    // Read from PRIMITIVES — a refused context reads NOTHING.
    const refused =
      readAccess.refusedReason !== null || !canView || !readAccess.incidents;
    if (refused || !teamId || !grouped) return;
    const team = teamId;
    const seq = ++groupsSeq.current;
    const controller = new AbortController();
    setGroupsLoading(true);
    // A FILTERED grouped view sends the SAME predicate as the flat list
    // (status included), so both presentations select the same conditions.
    // The unfiltered grouped view is SECTIONS — "Action required" and
    // "Monitoring" partition the unresolved set — so that read asks for the
    // unresolved set, and resolved history has its own section and read.
    const sections = !anyNarrowingFilter(filters);
    void apiFetch(`/v1/ops/incident-groups?${groupsQuery({ teamId: team, filters, sections })}`, {
      method: "GET",
      signal: controller.signal,
    })
      .then((res) => {
        if (seq !== groupsSeq.current || team !== teamRef.current) return;
        const payload = res as {
          groups?: IncidentGroup[];
          totals?: IncidentGroupTotals;
          completeness?: { complete?: boolean };
        };
        const next = (payload.groups ?? []).slice();
        setGroupsError(null);
        setGroups(next);
        const readComplete = payload.completeness?.complete;
        setGroupTotals({
          ...(payload.totals ?? {
            groups: next.length,
            conditions: next.reduce((sum, g) => sum + g.conditionCount, 0),
          }),
          ...(typeof readComplete === "boolean" ? { complete: readComplete } : {}),
        });
      })
      .catch((err) => {
        if (seq !== groupsSeq.current || team !== teamRef.current) return;
        // OPS-036 — unavailable, never "0 groups".
        setGroups([]);
        setGroupTotals(null);
        setGroupsError(
          toSafeUserError(err, { message: copy.groupsUnavailableBody }),
        );
      })
      .finally(() => {
        if (seq === groupsSeq.current && team === teamRef.current) setGroupsLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    teamId,
    grouped,
    filters,
    reloadToken,
    canView,
    readAccess.refusedReason,
    readAccess.incidents,
  ]);

  /**
   * "Resolved" — its own read of RESOLVED groups, only on the default view (no
   * narrowing filter; the sort order does not narrow).
   *
   * POPULATION, NOT PRESENTATION (2026-10-23). The default lifecycle is ALL,
   * so the grouped sections must together hold every condition the flat All
   * list holds. This read used to carry `resolvedWithinDays=7`: grouping the
   * All view silently dropped every resolution older than a week, and only
   * switching the filter to Resolved brought them back. It now sends the SAME
   * predicate the Resolved filter does, so Action required + Monitoring (the
   * unresolved read) + Resolved (this read) = ALL.
   */
  React.useEffect(() => {
    const refused =
      readAccess.refusedReason !== null || !canView || !readAccess.incidents;
    if (refused || !teamId || !grouped || anyNarrowingFilter(filters)) {
      setResolvedGroups([]);
      setResolvedTotals(null);
      setResolvedLoading(false);
      setResolvedUnavailable(false);
      return;
    }
    const team = teamId;
    const seq = ++resolvedSeq.current;
    const controller = new AbortController();
    setResolvedLoading(true);
    void apiFetch(
      `/v1/ops/incident-groups?${groupsQuery({ teamId: team, filters: { ...filters, status: "RESOLVED" } })}`,
      { method: "GET", signal: controller.signal },
    )
      .then((res) => {
        if (seq !== resolvedSeq.current || team !== teamRef.current) return;
        const payload = res as {
          groups?: IncidentGroup[];
          totals?: IncidentGroupTotals;
          completeness?: { complete?: boolean };
        };
        const next = payload.groups ?? [];
        setResolvedGroups(next);
        const readComplete = payload.completeness?.complete;
        setResolvedTotals({
          ...(payload.totals ?? {
            groups: next.length,
            conditions: next.reduce((sum, g) => sum + g.conditionCount, 0),
          }),
          ...(typeof readComplete === "boolean" ? { complete: readComplete } : {}),
        });
        setResolvedUnavailable(false);
      })
      .catch(() => {
        if (seq !== resolvedSeq.current || team !== teamRef.current) return;
        setResolvedGroups([]);
        setResolvedTotals(null);
        setResolvedUnavailable(true);
      })
      .finally(() => {
        if (seq === resolvedSeq.current && team === teamRef.current) setResolvedLoading(false);
      });
    return () => controller.abort();
  }, [
    teamId,
    grouped,
    filters,
    reloadToken,
    canView,
    readAccess.refusedReason,
    readAccess.incidents,
  ]);

  /**
   * THE DRILL-DOWN'S STATUS CONTEXT: the read the clicked section came from.
   * A resolved section pages RESOLVED members; "Action required" and
   * "Monitoring" page UNRESOLVED members (the set their read counted); a
   * filtered grouped view pages the active status filter and severity — so
   * the members listed are always the ones the row counted.
   */
  const affectedContext = React.useCallback(
    (ref: OpenGroupRef): { status: string; severity: string } =>
      ref.section === "resolved"
        ? { status: "RESOLVED", severity: "" }
        : ref.section === "action" || ref.section === "monitoring"
          ? { status: "UNRESOLVED", severity: filters.severity }
          : { status: filters.status || DEFAULT_FILTERS.status, severity: filters.severity },
    [filters.status, filters.severity],
  );

  /** Load one page of the open group's members. */
  const loadAffected = React.useCallback(
    (ref: OpenGroupRef, cursor: string | null) => {
      if (!teamId) return;
      const team = teamId;
      const seq = ++affectedSeq.current;
      setAffectedLoading(true);
      setAffectedError(null);
      const ctx = affectedContext(ref);
      const params = new URLSearchParams({ teamId: team, status: ctx.status });
      if (ctx.severity) params.set("severity", ctx.severity);
      if (cursor) params.set("cursor", cursor);
      const stillCurrent = () => {
        const open = openGroupRefRef.current;
        return (
          seq === affectedSeq.current &&
          team === teamRef.current &&
          open !== null &&
          open.section === ref.section &&
          open.groupKey === ref.groupKey
        );
      };
      void apiFetch(
        `/v1/ops/incident-groups/${encodeURIComponent(ref.groupKey)}/affected?${params.toString()}`,
        { method: "GET" },
      )
        .then((res) => {
          if (!stillCurrent()) return;
          const v = res as {
            records?: AffectedRecord[];
            pagination?: { nextCursor: string | null };
          };
          // APPEND, never replace, while paging one group.
          setAffected((prev) =>
            cursor ? [...prev, ...(v.records ?? [])] : (v.records ?? []),
          );
          setAffectedCursor(v.pagination?.nextCursor ?? null);
          setAffectedHasMore((v.pagination?.nextCursor ?? null) !== null);
        })
        .catch((err) => {
          if (!stillCurrent()) return;
          setAffectedError(
            toSafeUserError(err, {
              message: copy.group.affectedFailed,
            }).message,
          );
        })
        .finally(() => {
          if (seq === affectedSeq.current) setAffectedLoading(false);
        });
    },
    [teamId, affectedContext, copy],
  );

  // Opening a group starts its drill-down from the first page, and closing one
  // clears it so the next group cannot inherit the previous one's records.
  const openGroupIdentity = openGroupRef
    ? `${openGroupRef.section}:${openGroupRef.groupKey}`
    : null;
  React.useEffect(() => {
    affectedSeq.current += 1;
    setAffected([]);
    setAffectedCursor(null);
    setAffectedHasMore(false);
    setAffectedError(null);
    setAffectedLoading(false);
    const ref = openGroupRefRef.current;
    if (ref) loadAffected(ref, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGroupIdentity, loadAffected]);

  const openGroup: IncidentGroup | null = openGroupRef
    ? ((openGroupRef.section === "resolved" ? resolvedGroups : groups).find(
        (g) => g.groupKey === openGroupRef.groupKey,
      ) ?? null)
    : null;

  /** The canonical accessible dialog, mounted once at the root layer. */
  const { confirm } = useConfirmAction();

  // -------------------------------------------------------------------------
  // THE READ — summary and list, independent (`allSettled`): a failed summary
  // must not blank the queue, and a failed queue must not hide the summary.
  // -------------------------------------------------------------------------
  React.useEffect(() => {
    if (gate || !teamId) return;
    const team = teamId;
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    const first = summary.kind === "loading" && incidents.kind === "loading";
    if (!first) setRefreshing(true);
    setLoadingMore(false);
    setLoadMoreError(null);

    void Promise.allSettled([
      apiFetch(`/v1/ops/summary?teamId=${encodeURIComponent(team)}`, {
        method: "GET",
        signal: controller.signal,
      }),
      apiFetch(`/v1/ops/incidents?${incidentsQuery({ teamId: team, filters })}`, {
        method: "GET",
        signal: controller.signal,
      }),
    ]).then(([summaryR, incidentsR]) => {
      if (seq !== requestSeq.current || team !== teamRef.current) return;

      if (summaryR.status === "fulfilled") {
        const v = summaryR.value as {
          summary: OperationsSummary;
          workspace?: { operatorCount: number };
        };
        setSummary({ kind: "ready", data: v.summary });
        setOperatorCount(v.workspace?.operatorCount ?? null);
      } else {
        setSummary({ kind: "error", ...sourceErrorFor("summary", summaryR.reason, copy) });
      }

      if (incidentsR.status === "fulfilled") {
        const v = incidentsR.value as IncidentListResponse;
        setIncidents({ kind: "ready", data: v.incidents ?? [] });
        setComplete(v.completeness?.complete ?? true);
        // The commitment travels WITH the rows it governs.
        setSla(v.sla ?? null);
        setNextCursor(v.pagination?.nextCursor ?? null);
      } else {
        setIncidents({
          kind: "error",
          ...sourceErrorFor("incidents", incidentsR.reason, copy),
        });
      }

      setRefreshing(false);
      // FRESHNESS IS A CLAIM ABOUT DATA THE PAGE HAS: stamped only when the
      // incident read succeeded.
      if (incidentsR.status === "fulfilled") {
        setLastLoadedAtUtc(new Date().toISOString());
      }
    });
    return () => controller.abort();
    // `summary.kind` / `incidents.kind` are read only to decide whether this is
    // the FIRST load; including them would re-fire the effect on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, gate, filters, reloadToken]);

  /**
   * The eligible-operator list, read ONCE per workspace — under its OWN
   * sequence (D3) and bound to the workspace that asked.
   */
  React.useEffect(() => {
    if (gate || !teamId || !capabilities.canAssign) {
      operatorsSeq.current += 1;
      setOperators([]);
      setSelfUserId(null);
      return;
    }
    const team = teamId;
    const seq = ++operatorsSeq.current;
    const controller = new AbortController();
    void apiFetch(
      `/v1/ops/assignable-operators?teamId=${encodeURIComponent(team)}`,
      { method: "GET", signal: controller.signal },
    )
      .then((res) => {
        if (seq !== operatorsSeq.current || team !== teamRef.current) return;
        const v = res as { operators: AssignableOperator[]; selfUserId: string };
        setOperators(v.operators ?? []);
        setSelfUserId(v.selfUserId ?? null);
      })
      .catch(() => {
        if (seq !== operatorsSeq.current || team !== teamRef.current) return;
        // A missing picker is not worth a banner: ownership still renders.
        setOperators([]);
      });
    return () => controller.abort();
  }, [teamId, gate, capabilities.canAssign]);

  // The inspector's history is its own read, so a failed history never blanks
  // the condition the operator opened.
  React.useEffect(() => {
    if (!openId || !teamId) return;
    const team = teamId;
    const id = openId;
    const seq = ++detailSeq.current;
    const controller = new AbortController();
    setDetail(LOADING);
    void apiFetch(
      `/v1/ops/incidents/${encodeURIComponent(id)}?teamId=${encodeURIComponent(team)}`,
      { method: "GET", signal: controller.signal },
    )
      .then((res) => {
        if (seq !== detailSeq.current || team !== teamRef.current || id !== openIdRef.current) return;
        const v = res as IncidentDetailResponse;
        setDetail({ kind: "ready", data: v.incident });
        setRemediation(v.remediation ?? null);
      })
      .catch((err) => {
        if (seq !== detailSeq.current || team !== teamRef.current || id !== openIdRef.current) return;
        setDetail({ kind: "error", ...sourceErrorFor("detail", err, copy) });
        setRemediation(null);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, teamId, reloadToken]);

  /**
   * D8 — opening a different condition (or leaving the workspace) clears the
   * previous one's remediation answer AND invalidates any request still in
   * flight for it, so "Accepted and queued" can never appear beside a record
   * it did not describe.
   */
  React.useEffect(() => {
    remediationSeq.current += 1;
    setRemediationOutcome(null);
    setRemediationRetry(null);
    setRemediationBusy(null);
  }, [openId, teamId]);

  /**
   * SAVED VIEWS — on the same gate as the queue, under their own sequence and
   * bound to the workspace (D2): a slow list for the previous workspace must
   * not land as this workspace's views.
   */
  const loadSavedViews = React.useCallback(() => {
    if (gate || !teamId) {
      savedViewsSeq.current += 1;
      setSavedViews([]);
      return;
    }
    const team = teamId;
    const seq = ++savedViewsSeq.current;
    setSavedViewsLoading(true);
    void apiFetch(
      `/v1/ops/saved-views?teamId=${encodeURIComponent(team)}`,
      { method: "GET" },
    )
      .then((res) => {
        if (seq !== savedViewsSeq.current || team !== teamRef.current) return;
        setSavedViews((res as { views: OperationsSavedView[] }).views ?? []);
      })
      .catch(() => {
        if (seq !== savedViewsSeq.current || team !== teamRef.current) return;
        setSavedViews([]);
      })
      .finally(() => {
        if (seq === savedViewsSeq.current) setSavedViewsLoading(false);
      });
  }, [teamId, gate]);

  React.useEffect(() => {
    loadSavedViews();
  }, [loadSavedViews]);

  const saveView = React.useCallback(
    async (input: { name: string; visibility: "PRIVATE" | "TEAM" }) => {
      if (!teamId || busy) return;
      const team = teamId;
      setBusy(true);
      showMutationError(null);
      try {
        await apiFetch("/v1/ops/saved-views", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId: team,
            name: input.name,
            visibility: input.visibility,
            // Only the filters that are actually SET. D11 — the SLA posture
            // is one of them; it was dropped on save, so "Overdue, unassigned"
            // replayed as "unassigned". The status is ALWAYS stored, the
            // default included: the saved-view schema accepts the queue's whole
            // filter vocabulary (one status, UNRESOLVED or ALL), so a view
            // replays as itself even if the default ever changes.
            filter: {
              teamId: team,
              ...(filters.sla ? { sla: filters.sla } : {}),
              status: filters.status || DEFAULT_FILTERS.status,
              ...(filters.severity ? { severity: filters.severity } : {}),
              ...(filters.category ? { category: filters.category } : {}),
              ...(filters.owner && filters.owner !== "any"
                ? { owner: filters.owner }
                : {}),
              ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
              ...(filters.sort ? { sort: filters.sort } : {}),
            },
          }),
        });
        if (team === teamRef.current) loadSavedViews();
      } catch (err) {
        if (team !== teamRef.current) return;
        showMutationError(
          toSafeUserError(err, { message: copy.errors.savedViewFailed }),
        );
      } finally {
        if (team === teamRef.current) setBusy(false);
      }
    },
    [teamId, busy, filters, loadSavedViews, showMutationError, copy],
  );

  /**
   * RENAME ONE VIEW, with the `updatedAt` last read: a view that changed since
   * is a 409 rather than a silent overwrite.
   */
  const renameView = React.useCallback(
    async (view: OperationsSavedView, name: string) => {
      if (!teamId || busy) return;
      const team = teamId;
      setBusy(true);
      showMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/saved-views/${encodeURIComponent(view.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              teamId: team,
              expectedUpdatedAt: view.updatedAt,
              name,
            }),
          },
        );
        if (team === teamRef.current) loadSavedViews();
      } catch (err) {
        if (team !== teamRef.current) return;
        showMutationError(
          toSafeUserError(err, {
            message: copy.views.renameFailed,
          }),
        );
        loadSavedViews();
      } finally {
        if (team === teamRef.current) setBusy(false);
      }
    },
    [teamId, busy, loadSavedViews, showMutationError, copy],
  );

  const deleteView = React.useCallback(
    async (view: OperationsSavedView) => {
      if (!teamId || busy) return;
      const team = teamId;
      setBusy(true);
      showMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/saved-views/${encodeURIComponent(view.id)}?teamId=${encodeURIComponent(team)}`,
          { method: "DELETE" },
        );
        if (team === teamRef.current) loadSavedViews();
      } catch (err) {
        if (team !== teamRef.current) return;
        showMutationError(
          toSafeUserError(err, {
            message: copy.views.deleteFailed,
          }),
        );
      } finally {
        if (team === teamRef.current) setBusy(false);
      }
    },
    [teamId, busy, loadSavedViews, showMutationError, copy],
  );

  const loadMore = React.useCallback(() => {
    if (!teamId || !nextCursor || loadingMore) return;
    const team = teamId;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void apiFetch(
      `/v1/ops/incidents?${incidentsQuery({ teamId: team, filters, cursor: nextCursor })}`,
      { method: "GET" },
    )
      .then((res) => {
        if (seq !== requestSeq.current || team !== teamRef.current) return;
        const v = res as IncidentListResponse;
        setIncidents((prev) =>
          prev.kind === "ready"
            ? { kind: "ready", data: [...prev.data, ...(v.incidents ?? [])] }
            : prev,
        );
        setComplete(v.completeness?.complete ?? true);
        setNextCursor(v.pagination?.nextCursor ?? null);
      })
      .catch((err) => {
        if (seq !== requestSeq.current || team !== teamRef.current) return;
        // Reported AT the pagination control; the cursor is kept so a retry
        // resumes from exactly where the read stopped.
        setLoadMoreError(
          toSafeUserError(err, { message: copy.errors.loadMoreFailed }),
        );
      })
      .finally(() => {
        if (seq === requestSeq.current && team === teamRef.current) setLoadingMore(false);
      });
  }, [teamId, nextCursor, loadingMore, filters, copy]);

  const refresh = React.useCallback(() => setReloadToken((n) => n + 1), []);

  // ---------------------------------------------------------------------
  // "CHECK AGAIN" — a request for a NEW CHECK, not a re-read of the old one.
  // The poll is BOUNDED and bound to the workspace that asked: switching
  // workspace mid-poll ends it, and nothing it learns is applied elsewhere.
  // ---------------------------------------------------------------------
  const RECONCILE_POLL_ATTEMPTS = 12;
  const RECONCILE_POLL_BASE_MS = 750;
  const RECONCILE_POLL_MAX_MS = 4000;

  const checkAgainRef = React.useRef<() => Promise<void>>(async () => {});
  const checkAgain = React.useCallback(async () => {
    if (!teamId || refreshing) return;
    const team = teamId;
    setRefreshing(true);
    showMutationError(null);
    try {
      const started = (await apiFetch(`/v1/ops/workspace-reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: team, explicit: true }),
      })) as {
        refusedReason?: string | null;
        retryable?: boolean;
        alreadyRunning?: boolean;
        readiness?: string;
      } | null;
      if (team !== teamRef.current) return;

      // D6 / OPS-11 — a refusal says WHICH refusal. Only schema_mismatch is a
      // deployment mismatch; permission_denied is a permission problem; every
      // other refusal is temporary and offers "Try again".
      if (started?.refusedReason) {
        const cls = classifyReconcileRefusal({
          refusedReason: started.refusedReason,
          retryable: started.retryable,
        });
        showMutationError(
          {
            title: "",
            message: reconcileErrorMessage(cls.kind, copy),
            severity: cls.kind === "temporary" ? "warning" : "error",
          },
          cls.retryable ? () => void checkAgainRef.current() : null,
        );
        return;
      }

      // The server runs the check inline; poll only a run still going.
      const stillRunning = started?.alreadyRunning === true || started?.readiness === "RUNNING";
      for (let attempt = 0; stillRunning && attempt < RECONCILE_POLL_ATTEMPTS; attempt += 1) {
        const wait = Math.min(
          RECONCILE_POLL_BASE_MS * 2 ** Math.floor(attempt / 3),
          RECONCILE_POLL_MAX_MS,
        );
        await new Promise((r) => setTimeout(r, wait));
        if (team !== teamRef.current) return;
        const polled = (await apiFetch(
          `/v1/ops/summary?teamId=${encodeURIComponent(team)}`,
          { method: "GET" },
        )) as { summary?: { readiness?: string } } | null;
        if (team !== teamRef.current) return;
        if (polled?.summary?.readiness !== "RUNNING") break;
      }
      if (team === teamRef.current) announce(copy.checkFinished);
    } catch (err) {
      if (team !== teamRef.current) return;
      const cls = classifyOpsError(err);
      const kind =
        cls.kind === "deployment" || cls.kind === "permission" ? cls.kind : "temporary";
      showMutationError(
        {
          title: "",
          message: reconcileErrorMessage(kind, copy),
          severity: kind === "temporary" ? "warning" : "error",
          supportReference: toSafeUserError(err, { message: "" }).supportReference,
        },
        kind === "temporary" ? () => void checkAgainRef.current() : null,
      );
    } finally {
      // Whatever happened, re-read once — for THIS workspace only.
      if (team === teamRef.current) {
        setRefreshing(false);
        refresh();
      }
    }
  }, [teamId, refreshing, refresh, showMutationError, copy, announce]);
  checkAgainRef.current = checkAgain;

  /**
   * A workspace nobody has ever scanned asks for its first check, ONCE.
   *
   * D4 — ONLY when the summary was actually READ and says NEVER_RUN. An
   * unreadable summary reports `readiness: NEVER_RUN` as its honest floor;
   * treating that as "never scanned" started a re-check every time the
   * summary store blinked.
   */
  const autoCheckedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!teamId) return;
    if (summary.kind !== "ready") return;
    if (summaryUnknown(summary.data)) return;
    if (summary.data.readiness !== "NEVER_RUN") return;
    if (autoCheckedRef.current === teamId) return;
    autoCheckedRef.current = teamId;
    void checkAgain();
  }, [teamId, summary, checkAgain]);

  // -------------------------------------------------------------------------
  // MUTATIONS — nothing is applied optimistically; each re-reads.
  // -------------------------------------------------------------------------
  type TransitionAction = "ack" | "resolve" | "suppress" | "unsuppress";
  const runTransitionRef = React.useRef<
    (id: string, action: TransitionAction, extra?: { resolutionNote?: string; reason?: string }) => Promise<boolean>
  >(async () => false);
  /**
   * ONE TRANSITION AT A TIME, decided synchronously. `busy` is React state,
   * so two presses inside one frame both read `busy === false`; this ref is
   * what makes a double-clicked Resolve one request.
   */
  const transitionInFlight = React.useRef(false);
  const runTransition = React.useCallback(
    async (
      incidentId: string,
      // Inline literal union (not the alias): the capability analyzer resolves
      // the POST path from it, one route per member.
      action: "ack" | "resolve" | "suppress" | "unsuppress",
      extra?: { resolutionNote?: string; reason?: string },
    ): Promise<boolean> => {
      if (!teamId || busy || transitionInFlight.current) return false;
      transitionInFlight.current = true;
      const team = teamId;
      // The control the operator actually pressed, captured BEFORE anything
      // disables it, so focus can be returned after a refusal dialog.
      const trigger =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      setBusy(true);
      setPendingId(incidentId);
      showMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/${action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              teamId: team,
              ...(extra?.resolutionNote ? { resolutionNote: extra.resolutionNote } : {}),
              ...(extra?.reason ? { reason: extra.reason } : {}),
            }),
          },
        );
        if (team !== teamRef.current) return false;
        announce(
          action === "ack"
            ? copy.announceAcknowledged
            : action === "resolve"
              ? copy.announceResolved
              : action === "unsuppress"
                ? copy.announceResumed
                : copy.announceSuppressed,
        );
        // The lists, the summary counts, the grouped sections and the open
        // drawer all re-read NOW — no page refresh is needed to see the
        // condition in its new state.
        refresh();
        return true;
      } catch (err) {
        if (team !== teamRef.current) return false;
        const cls = classifyOpsError(err);
        // ---------------------------------------------------------------
        // THE SOURCE-CONTRACT REFUSALS GET A DIALOG. They are answers to what
        // the operator just asked, about the row in front of them. Four
        // codes, four sentences — and CONDITION_STATE_CHANGED (the condition
        // changed between the check and the write) re-reads and says so.
        // ---------------------------------------------------------------
        const NOTICE: Partial<Record<typeof cls.kind, { title: string; description: string; testId: string }>> = {
          still_active: {
            title: copy.errors.stillActiveTitle,
            description: copy.errors.stillActiveBody,
            testId: "ops-condition-still-active",
          },
          activity_unknown: {
            title: copy.errors.activityUnknownTitle,
            description: copy.errors.activityUnknownBody,
            testId: "ops-condition-activity-unknown",
          },
          not_directly_resolvable: {
            title: copy.errors.notResolvableTitle,
            description: copy.errors.notResolvableBody,
            testId: "ops-condition-not-directly-resolvable",
          },
          state_changed: {
            title: copy.errors.stateChangedTitle,
            description: copy.errors.stateChangedBody,
            testId: "ops-condition-state-changed",
          },
        };
        const notice = NOTICE[cls.kind];
        if (notice) {
          // The server refused and wrote NOTHING. The re-read puts the row
          // (and the open drawer) back to the real state; the dialog explains.
          refresh();
          await confirm({
            title: notice.title,
            description: notice.description,
            confirmLabel: copy.close,
            tone: "warning",
            noticeOnly: true,
            testId: notice.testId,
          });
          setBusy(false);
          setPendingId(null);
          // AFTER the dialog has finished unmounting, put focus back where the
          // operator was.
          await new Promise<void>((done) => {
            setTimeout(() => {
              if (trigger && document.body.contains(trigger)) {
                try {
                  trigger.focus();
                } catch {
                  /* the control went with a re-render; nothing to restore */
                }
              }
              done();
            }, 0);
          });
          return false;
        }
        const fallback = toSafeUserError(err, { message: copy.errors.actionFailed });
        showMutationError(
          {
            ...fallback,
            message: opsErrorMessage(cls.kind, copy, fallback.message),
          },
          cls.retryable
            ? () => void runTransitionRef.current(incidentId, action, extra)
            : null,
        );
        // A REFUSED transition re-reads too: the row must show what the
        // server actually holds.
        refresh();
        return false;
      } finally {
        transitionInFlight.current = false;
        if (team === teamRef.current) {
          setBusy(false);
          setPendingId(null);
        }
      }
    },
    [teamId, busy, refresh, confirm, copy, announce, showMutationError],
  );
  runTransitionRef.current = runTransition;

  const assign = React.useCallback(
    async (incidentId: string, assigneeUserId: string | null) => {
      if (!teamId || busy) return;
      const team = teamId;
      setBusy(true);
      setPendingId(incidentId);
      showMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/assign`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId: team, assigneeUserId }),
          },
        );
        if (team === teamRef.current) refresh();
      } catch (err) {
        if (team !== teamRef.current) return;
        const cls = classifyOpsError(err);
        const fallback = toSafeUserError(err, { message: copy.errors.assignFailed });
        showMutationError(
          { ...fallback, message: opsErrorMessage(cls.kind, copy, fallback.message) },
          cls.retryable ? () => void assign(incidentId, assigneeUserId) : null,
        );
        if (cls.kind === "state_changed") refresh();
      } finally {
        if (team === teamRef.current) {
          setBusy(false);
          setPendingId(null);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamId, busy, refresh, copy, showMutationError],
  );

  /**
   * REQUEST ONE REGISTERED REMEDIATION.
   *
   * D8 — the answer is bound to {incidentId, workspaceId, requestId}. A
   * response that lands after the drawer moved to another condition, or the
   * operator moved to another workspace, is dropped: an "Accepted and queued"
   * beside a record it did not describe is a false statement about that
   * record.
   */
  const remediate = React.useCallback(
    async (actionId: string, reason?: string) => {
      if (!teamId || !openId || remediationBusy) return;
      const team = teamId;
      const incidentId = openId;
      const seq = ++remediationSeq.current;
      const stillCurrent = () =>
        seq === remediationSeq.current &&
        team === teamRef.current &&
        incidentId === openIdRef.current;
      setRemediationBusy(actionId);
      setRemediationOutcome(null);
      setRemediationRetry(null);
      showMutationError(null);
      try {
        const res = await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/remediate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              reason ? { teamId: team, actionId, reason } : { teamId: team, actionId },
            ),
          },
        );
        if (!stillCurrent()) return;
        const outcome = (res as { remediation?: RemediationOutcome }).remediation;
        setRemediationOutcome(
          outcome ?? { result: "QUEUED", message: copy.drawer.remediationQueued },
        );
        refresh();
      } catch (err) {
        if (!stillCurrent()) return;
        // ET-REC-05 — a refusal, a not-eligible answer or a queue outage is
        // still the server's ANSWER, with its own sentence. Only a retryable
        // one (FAILED 502 / QUEUE_UNAVAILABLE 503) offers "Try again".
        const answered = (err as { body?: { error?: { remediation?: RemediationOutcome } } })?.body
          ?.error?.remediation;
        const cls = classifyOpsError(err);
        if (answered && typeof answered.result === "string" && typeof answered.message === "string") {
          setRemediationOutcome(answered);
          setRemediationRetry(() =>
            cls.retryable ? () => void remediateRef.current(actionId, reason) : null,
          );
          refresh();
        } else {
          const fallback = toSafeUserError(err, { message: copy.errors.remediationFailed });
          showMutationError(
            { ...fallback, message: opsErrorMessage(cls.kind, copy, fallback.message) },
            cls.retryable ? () => void remediateRef.current(actionId, reason) : null,
          );
        }
      } finally {
        if (seq === remediationSeq.current) setRemediationBusy(null);
      }
    },
    [teamId, openId, remediationBusy, refresh, showMutationError, copy],
  );
  const remediateRef = React.useRef(remediate);
  remediateRef.current = remediate;

  // -------------------------------------------------------------------------
  // DERIVED
  // -------------------------------------------------------------------------
  /** ONE instant for the whole queue: the moment the list was read. */
  const now = React.useMemo(
    () => (lastLoadedAtUtc ? Date.parse(lastLoadedAtUtc) : Date.now()),
    [lastLoadedAtUtc],
  );

  const operatorLabels = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const o of operators) {
      m.set(o.userId, o.displayName?.trim() || o.email?.trim() || o.userId.slice(0, 8));
    }
    return m;
  }, [operators]);

  const rows = React.useMemo(
    () =>
      incidents.kind === "ready"
        ? incidents.data.map((i) =>
            buildRowModel(i, {
              capabilities,
              viewerUserId,
              operatorLabels,
              now,
              slaAttentionPostures: sla?.attentionPostures,
              copy,
              locale,
            }),
          )
        : [],
    [incidents, capabilities, viewerUserId, operatorLabels, now, sla, copy, locale],
  );

  /**
   * D14 — a selection is a set of rows ON SCREEN. Any change to what is on
   * screen (filters, search, view mode, workspace) clears it, and a sweep only
   * ever acts on marked rows that are still visible.
   */
  React.useEffect(() => {
    setMarkedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filterKey, grouped, teamId]);
  const visibleIds = React.useMemo(
    () => new Set(grouped ? [] : rows.map((r) => r.id)),
    [grouped, rows],
  );

  /**
   * RUN ONE BULK ACTION AND REPORT PER TARGET. The selection is cleared only
   * for targets that settled; the rest stay marked for a retry.
   */
  const runBulk = React.useCallback(
    async (
      actionType:
        | "BULK_ACKNOWLEDGE_INCIDENTS"
        | "BULK_SUPPRESS_INCIDENTS"
        | "BULK_ASSIGN_INCIDENTS",
      extra?: { assigneeUserId?: string; note?: string },
    ) => {
      // Never act on a row that is not on screen.
      const targetIds = Array.from(markedIds).filter((id) => visibleIds.has(id));
      if (!teamId || busy || targetIds.length === 0) return;
      const team = teamId;
      // OPS-011 — ONE key per sweep.
      const idempotencyKey = makeClientRequestKey();
      setBusy(true);
      showMutationError(null);
      setBulkOutcome(null);
      try {
        const res = await stepUp.runStepUpAction((headers) =>
          apiFetch(`/v1/ops/bulk-actions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ teamId: team, actionType, targetIds, idempotencyKey, ...extra }),
          }),
        );
        if (team !== teamRef.current) return;
        const run = res as BulkActionResponse;
        const items = run.items ?? [];
        const failedIds = new Set(
          items
            .filter((i) => !bulkActionItemSettled(i.status))
            .map((i) => i.targetId),
        );
        for (const id of targetIds) {
          if (!items.some((i) => i.targetId === id)) failedIds.add(id);
        }
        const succeeded = items.filter((i) => bulkActionItemSucceeded(i.status)).length;

        const outcomeText =
          failedIds.size === 0
            ? fillOperationsCopy(copy.bulkUpdated, { done: fmt(succeeded), total: fmt(targetIds.length) })
            : fillOperationsCopy(copy.bulkPartial, {
                done: fmt(succeeded),
                total: fmt(targetIds.length),
                failed: fmt(failedIds.size),
              });
        setBulkOutcome(outcomeText);
        announce(outcomeText);
        setMarkedIds(failedIds);
        refresh();
      } catch (err) {
        if (team !== teamRef.current) return;
        if ((err as { code?: string }).code === "STEP_UP_CANCEL") {
          setBulkOutcome(copy.bulkCancelled);
        } else {
          const cls = classifyOpsError(err);
          const fallback = toSafeUserError(err, { message: copy.errors.bulkFailed });
          showMutationError({
            ...fallback,
            message: opsErrorMessage(cls.kind, copy, fallback.message),
          });
        }
      } finally {
        if (team === teamRef.current) setBusy(false);
      }
    },
    [teamId, busy, markedIds, visibleIds, refresh, stepUp, copy, fmt, announce, showMutationError],
  );

  /** Ownership is a real axis only where more than one person can hold work. */
  const collaborative = (operatorCount ?? 0) > 1;

  // A condition opened from a group member or from `?incident=` may not be on
  // the loaded page of the flat list; its own detail read carries the same
  // projection, so the drawer is built from that.
  const openRow = openId
    ? (rows.find((r) => r.id === openId) ??
      (detail.kind === "ready" && detail.data.id === openId
        ? buildRowModel(detail.data as unknown as Incident, {
            capabilities,
            viewerUserId,
            operatorLabels,
            now,
            slaAttentionPostures: sla?.attentionPostures,
            copy,
            locale,
          })
        : null))
    : null;

  const selectedMetric = metricForFilters(filters);

  const selectMetric = React.useCallback(
    (key: QueueMetricKey) => {
      // Each card opens the list with EXACTLY the predicate that counted it.
      applyFilters(filtersForMetric(key));
      setMarkedIds(new Set());
    },
    [applyFilters],
  );

  const toggleMark = React.useCallback((id: string) => {
    setMarkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // HEADER
  // -------------------------------------------------------------------------
  const header = (
    <div className="app-page-header" data-testid="operations-header">
      <div className="app-page-header__lead">
        <span className="app-page-header__icon" aria-hidden="true">
          <IconOperations size={21} />
        </span>
        <div className="app-page-header__text">
          {/* THE ONLY <h1> ON THIS PAGE. */}
          <h1 className="app-page-header__title">{copy.pageTitle}</h1>
          <p className="app-page-header__subtitle">
            {capabilities.canActOnAnything ? copy.subtitleOperator : copy.subtitleViewer}
          </p>
          <p className="opsw-context" data-ops-context>
            {workspaceName ? (
              <>
                <span>{copy.conditionsIn}</span>{" "}
                <strong data-context-workspace>{workspaceName}</strong>
              </>
            ) : null}
            {lastLoadedAtUtc ? (
              <span className="opsw-context__stamp" data-ops-last-loaded>
                {copy.updated} {formatUserDateTime(lastLoadedAtUtc)}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {!gate ? (
        <div className="app-page-header__actions">
          {/* OPS-032 — REFRESH RE-EXAMINES THE SOURCES. */}
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => void checkAgain()}
            disabled={refreshing}
            aria-busy={refreshing}
            data-ops-refresh
          >
            <IconRefresh size={16} />
            <span>{refreshing ? copy.refreshing : copy.refresh}</span>
          </button>
        </div>
      ) : null}
    </div>
  );

  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------
  if (gate) {
    return (
      <PageShell className="opsw-page" header={header} data-testid="operations-page">
        <RestrictedState reason={gate} />
      </PageShell>
    );
  }

  const firstLoad = incidents.kind === "loading" && summary.kind === "loading";
  const queueFailed = incidents.kind === "error";
  const summaryFailed = summary.kind === "error";
  /**
   * D4 — a summary that was READ but could not be produced (every count null)
   * knows nothing about discovery either; its readiness is a floor, not a
   * fact, so no reconciliation banner and no "Preparing" are derived from it.
   */
  const summaryIsUnknown = summary.kind === "ready" && summaryUnknown(summary.data);
  const readiness =
    summary.kind === "ready" && !summaryIsUnknown ? summary.data.readiness : undefined;
  const reconciliation =
    summary.kind === "ready" && !summaryIsUnknown ? (summary.data.reconciliation ?? null) : null;
  const serverPermitsClear =
    summary.kind === "ready" ? summary.data.mayAssertAllClear === true : false;
  /**
   * THE ONE STATUS (2026-10-14) — the server's, read once and shared by the
   * flat and grouped presentations, so switching views can never turn a
   * confirmed workspace into an unconfirmed one. STALE is its own state now:
   * it used to fall through to the generic "unconfirmed" panel, which then
   * sat above the very resolved history it claimed was not there.
   */
  const opsStatus =
    summary.kind === "ready" && !summaryIsUnknown ? (summary.data.status ?? null) : null;
  const isStale = opsStatus ? opsStatus.state === "STALE" || opsStatus.freshness === "STALE" : readiness === "STALE";
  /** A state notice (failed, stalled, partial, stale) is above the queue and offers the re-check. */
  const stateNoticeShown =
    readiness === "FAILED" || readiness === "STALLED" || readiness === "PARTIAL" || isStale;
  const checkTimeLabel = (iso: string | null | undefined) =>
    iso ? `${formatUserDateTime(iso)} (${time.ago(iso)})` : null;
  /** User-facing names of the sources the last check could not see. */
  const unseenSourceNames = Array.from(
    new Set([
      ...(opsStatus?.failedSourceIds ?? reconciliation?.sources.failedSources ?? []),
      ...(opsStatus?.truncatedSourceIds ?? reconciliation?.sources.truncatedSources ?? []),
    ]),
  )
    .map((id) => conditionSourceLabel(locale, id))
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  /** Is a PARTIAL run worth re-running? Only if EVERY recorded failure is. */
  const partialIsRetryable =
    (reconciliation?.sources.sourceFailures ?? []).length === 0 ||
    (reconciliation?.sources.sourceFailures ?? []).every((f) => f.retryable);

  const narrowing = anyNarrowingFilter(filters);

  /**
   * THE AUTHORITATIVE RETAINED TOTAL (2026-10-14) — every condition this
   * workspace holds, in any lifecycle state: the summary's unresolved count
   * (OPEN + ACKNOWLEDGED + SUPPRESSED) plus its all-time RESOLVED count. Both
   * are the server's own counts against the canonical tenant predicate,
   * UNFILTERED — so global emptiness is never inferred from the page of rows
   * the current filters happened to return.
   *
   * Null when either count is unknown (an unreadable summary, a resolved count
   * that could not be read): unknown never becomes 0. A bounded scan makes
   * `open` a floor at its bound, so a floor total can never be 0 either.
   */
  const summaryRead =
    summary.kind === "ready" && !summaryIsUnknown ? summary.data : null;
  const retainedTotal =
    summaryRead &&
    typeof summaryRead.open === "number" &&
    typeof summaryRead.resolved === "number"
      ? summaryRead.open + summaryRead.resolved
      : null;
  /** Unresolved work, exactly zero — and the summary that says so was read. */
  const noActiveWork =
    summaryRead !== null &&
    summaryRead.open === 0 &&
    summaryRead.complete !== false;

  /**
   * STATE A — the ONLY state that may render the large first-use panel and its
   * navigation links: the read succeeded, reached the end and is empty,
   * nothing narrowed it, the SERVER licensed the word "clear" (a fresh,
   * complete discovery run; a readable summary) — and the authoritative
   * retained total is ZERO. A workspace with resolved history is not empty.
   */
  const mayAssertClear =
    incidents.kind === "ready" &&
    complete &&
    rows.length === 0 &&
    !narrowing &&
    !summaryIsUnknown &&
    serverPermitsClear &&
    retainedTotal === 0;

  /**
   * COUNTS SAY WHAT THEY COUNT. Each result line names its scope: "all
   * statuses" under the default lifecycle, "unresolved" for the grouped
   * sections (they partition the unresolved set), and "filtered" whenever a
   * filter narrowed the selection — so a filtered count, zero included, never
   * reads as the workspace total.
   */
  // The unfiltered grouped view is TWO reads (unresolved sections + Resolved)
  // that partition ALL, so its header counts both — the conditions it states
  // are the rows on screen, never only the unresolved part of them.
  const withResolved = grouped && !narrowing && !resolvedUnavailable && resolvedTotals !== null;
  const groupCount =
    (groupTotals?.groups ?? groups.length) + (withResolved ? resolvedTotals.groups : 0);
  const conditionCount =
    (groupTotals?.conditions ?? 0) + (withResolved ? resolvedTotals.conditions : 0);
  const groupsFloor =
    groupTotals?.complete === false || (withResolved && resolvedTotals.complete === false);
  const groupedSummary = [
    groupCount === 1 ? copy.resultSourceOne : fillOperationsCopy(copy.resultSources, { n: fmt(groupCount) }),
    groupsFloor
      ? fillOperationsCopy(copy.metricAtLeast, {
          n: fillOperationsCopy(copy.resultConditions, { n: fmt(conditionCount) }),
        })
      : conditionCount === 1
        ? copy.resultConditionOne
        : fillOperationsCopy(copy.resultConditions, { n: fmt(conditionCount) }),
    ...(!narrowing
      ? [withResolved ? copy.resultAllStatuses : copy.resultUnresolvedScope]
      : filters.status === "ALL"
        ? [copy.resultAllStatuses, copy.resultFiltered]
        : [copy.resultFiltered]),
  ].join(" · ");
  const flatSummary = [
    rows.length === 1 && !nextCursor
      ? copy.resultConditionOne
      : fillOperationsCopy(nextCursor ? copy.resultConditionsMore : copy.resultConditions, {
          n: fmt(rows.length),
        }),
    ...(filters.status === "ALL" ? [copy.resultAllStatuses] : []),
    ...(narrowing ? [copy.resultFiltered] : []),
  ].join(" · ");

  // THE GROUPED VIEW'S SECTIONS, partitioned from ONE read (the UNRESOLVED
  // groups): a group is in exactly one of them.
  const actionGroups = groups.filter((g) => g.statusPosture === "OPEN");
  const monitoringGroups = groups.filter(
    (g) => g.statusPosture === "ACKNOWLEDGED" || g.statusPosture === "SUPPRESSED",
  );
  const sectionKey = (section: GroupSection) =>
    openGroupRef && openGroupRef.section === section ? openGroupRef.groupKey : null;
  const openFrom = (section: GroupSection) => (groupKey: string) =>
    setOpenGroupRef({ section, groupKey });

  /**
   * WHAT AN EMPTY SURFACE SAYS — decided from authoritative facts, never from
   * the filtered page alone:
   *
   *   narrowed by a filter        → "No conditions match these filters." +
   *                                 Reset filters (state D). No onboarding.
   *   retained total 0, licensed  → the first-use panel (state A).
   *   summary unreadable          → unconfirmed, never clear.
   *   never scanned               → preparing.
   *   anything else               → not confirmed (a partial/stale check, a
   *                                 resolved count that could not be read).
   */
  const emptyState = narrowing ? (
    <NoMatchState onReset={resetToDefaults} />
  ) : mayAssertClear ? (
    <ClearState />
  ) : summaryIsUnknown ? (
    <UnconfirmedEmptyState onRetry={refresh} busy={refreshing} />
  ) : readiness === "NEVER_RUN" ? (
    // Nothing has scanned this workspace — and the summary SAID so.
    <PreparingState />
  ) : (
    // A CHECK that did not license "clear": one compact line whose button asks
    // for a NEW check (re-reading the same stale run changed nothing), never
    // the panel.
    <UnconfirmedEmptyState onRetry={() => void checkAgain()} busy={refreshing} reason="check" showAction={!stateNoticeShown} />
  );

  /**
   * STATE B — no unresolved work, but the workspace HAS history. One quiet
   * line, licensed exactly like the word "clear" is (a readable summary that
   * reached the end, and the server's permission), never a panel and never a
   * navigation card. The history itself is on screen below it.
   */
  const showQuietNoActive =
    !narrowing && noActiveWork && serverPermitsClear && (retainedTotal ?? 0) > 0;

  /** One section of the grouped view: full when populated, one line when empty. */
  const collapsedSection = (key: string, text: string) => (
    <div className="opsw-section-collapsed" data-ops-section={key} data-ops-section-collapsed="true">
      <p className="opsw-muted" data-ops-section-empty>
        {text}
      </p>
    </div>
  );

  return (
    <PageShell className="opsw-page" header={header} data-testid="operations-page">
      <p className="app-visually-hidden" role="status" aria-live="polite" data-ops-live>
        {announcement}
      </p>
      {mutationError ? (
        <InlineMutationError
          error={mutationError}
          onDismiss={() => showMutationError(null)}
          onRetry={mutationRetry ?? undefined}
        />
      ) : null}

      {summaryFailed ? (
        <DegradedNotice
          what={copy.degradedSummary}
          message={summary.message}
          requestId={summary.requestId}
          onRetry={refresh}
        />
      ) : null}

      {/*
        THE RECONCILIATION BANNER — one notice at most, chosen by the run's own
        state, and only from a summary that was actually read.
      */}
      {readiness === "FAILED" ? (
        <ReconciliationFailedNotice
          category={reconciliation?.safeFailureCategory ?? null}
          onRetry={() => void checkAgain()}
          busy={refreshing}
        />
      ) : readiness === "STALLED" ? (
        <ReconciliationStalledNotice onRetry={() => void checkAgain()} busy={refreshing} />
      ) : readiness === "PARTIAL" ? (
        <PartialCoverageNotice
          failedCount={reconciliation?.sources.failedSources.length ?? 0}
          truncatedCount={reconciliation?.sources.truncatedSources.length ?? 0}
          onRetry={() => void checkAgain()}
          retryable={partialIsRetryable}
          sourceNames={unseenSourceNames}
          busy={refreshing}
        />
      ) : isStale ? (
        <StaleStatusNotice
          lastCompleteCheckLabel={checkTimeLabel(opsStatus?.lastCompleteCheckAtUtc)}
          lastCheckLabel={checkTimeLabel(
            opsStatus ? opsStatus.lastCheckAtUtc : (reconciliation?.completedAtUtc ?? null),
          )}
          onCheck={() => void checkAgain()}
          busy={refreshing}
        />
      ) : null}

      {readiness === "RUNNING" ? <ReconcilingNotice /> : null}

      {firstLoad ? <LoadingState /> : null}

      {!firstLoad && queueFailed ? (
        <UnavailableState
          message={incidents.message}
          requestId={incidents.requestId}
          onRetry={refresh}
        />
      ) : null}

      {!firstLoad && !queueFailed ? (
        <>
          {refreshing ? <RefreshingNotice /> : null}

          {summary.kind === "ready" ? (
            <QueueSummary
              summary={summary.data}
              selected={selectedMetric}
              onSelect={selectMetric}
              showCollaborative={collaborative}
            />
          ) : null}

          <SavedViews
            views={savedViews}
            loading={savedViewsLoading}
            busy={busy}
            // Nothing to name until something is filtered.
            canSave={anyFilterActive(filters)}
            onApply={applyView}
            onSave={(input) => void saveView(input)}
            onRename={(view, name) => void renameView(view, name)}
            canManageShared={capabilities.canManageSharedViews}
            onDelete={(view) => void deleteView(view)}
          />

          <FilterToolbar
            filters={filters}
            onChange={patchFilters}
            onClear={clearFilters}
            showClear={anyFilterActive(filters)}
            showOwnerFilter={collaborative}
            operators={operators}
            busy={busy}
            // The grouped view is ordered by the server's grouping; a sort
            // control there would change nothing (or, as it once did, hide
            // the sections). It is offered where it applies: the flat list.
            showSort={!grouped}
            resultSummary={
              // OPS-036 — a failed grouped read has no count to state.
              grouped && groupsError ? "" : grouped ? groupedSummary : flatSummary
            }
          />

          {/* ALL CONDITIONS / GROUPED — the PRESENTATION, one control, not a
              plan fork and not a filter. The flat list is the default, so it
              comes first; the choice is in the URL (`?view=grouped`). */}
          <div
            className="opsw-view-toggle"
            role="group"
            aria-label={copy.viewToggleLabel}
            data-ops-view-toggle
            data-ops-presentation={presentation}
          >
            <button
              type="button"
              className={grouped ? "app-secondary-action" : "app-primary-action"}
              aria-pressed={!grouped}
              onClick={() => switchPresentation("flat")}
              data-ops-view="flat"
            >
              {copy.viewAll}
            </button>
            <button
              type="button"
              className={grouped ? "app-primary-action" : "app-secondary-action"}
              aria-pressed={grouped}
              onClick={() => switchPresentation("grouped")}
              data-ops-view="grouped"
            >
              {copy.viewGrouped}
            </button>
          </div>

          <BulkToolbar
            count={markedIds.size}
            capabilities={capabilities}
            busy={busy}
            onAcknowledge={() => void runBulk("BULK_ACKNOWLEDGE_INCIDENTS")}
            onSuppress={(reason) => void runBulk("BULK_SUPPRESS_INCIDENTS", { note: reason })}
            onClear={() => {
              setMarkedIds(new Set());
              setBulkOutcome(null);
            }}
            showOwnership={collaborative}
            operators={operators}
            selfUserId={selfUserId}
            onAssign={(assigneeUserId) =>
              void runBulk("BULK_ASSIGN_INCIDENTS", { assigneeUserId })
            }
            outcome={bulkOutcome}
          />

          {/* EMPTINESS IS DECIDED BY THE SURFACE BEING SHOWN — and by
              authoritative unfiltered counts, never by the filtered page. */}
          {grouped && groupsError ? (
            <div data-ops-groups-unavailable>
              <UnavailableState
                message={copy.groupsUnavailableBody}
                requestId={groupsError.supportReference}
                onRetry={refresh}
              />
            </div>
          ) : grouped && groupsLoading && groups.length === 0 ? (
            // LOADING IS NOT EMPTY — never a one-frame false all-clear.
            <PreparingState />
          ) : grouped && !narrowing ? (
            // THE GROUPED SECTIONS. "Action required" (posture OPEN) is the
            // primary content; "Monitoring" (acknowledged or silenced) is
            // secondary; "Resolved" (its own read) is quiet reference
            // below. All from the one UNRESOLVED read, so no group is in two
            // sections — and an EMPTY section is one compact line, never a
            // block, and never a global empty card.
            groups.length === 0 &&
            (mayAssertClear || summaryIsUnknown || readiness === "NEVER_RUN") &&
            resolvedGroups.length === 0 ? (
              emptyState
            ) : groups.length === 0 ? (
              // Nothing unresolved, but there is history (state B) or the
              // check did not license "nothing needs action".
              serverPermitsClear && !summaryIsUnknown && !groupsFloor ? (
                <div className="opsw-section-collapsed" data-ops-section="active" data-ops-section-collapsed="true">
                  <p className="opsw-muted" data-ops-section-empty data-ops-quiet-clear>
                    {copy.sectionEmptyActive}
                  </p>
                </div>
              ) : (
                summaryIsUnknown ? (
                  <UnconfirmedEmptyState onRetry={refresh} busy={refreshing} />
                ) : (
                  <UnconfirmedEmptyState onRetry={() => void checkAgain()} busy={refreshing} reason="check" showAction={!stateNoticeShown} />
                )
              )
            ) : (
              <>
                {actionGroups.length > 0 ? (
                  <section
                    className="opsw-section opsw-section--primary"
                    aria-labelledby="opsw-section-action"
                    data-ops-section="action-required"
                    data-ops-section-rank="primary"
                  >
                    <h2 className="opsw-section__title" id="opsw-section-action">
                      {copy.sectionActionRequired}
                    </h2>
                    <p className="opsw-muted opsw-section__hint">{copy.sectionActionRequiredHint}</p>
                    <GroupSurface groups={actionGroups} openGroupKey={sectionKey("action")} onOpen={openFrom("action")} />
                  </section>
                ) : (
                  collapsedSection("action-required", copy.sectionEmptyAction)
                )}
                {monitoringGroups.length > 0 ? (
                  <section
                    className="opsw-section opsw-section--secondary"
                    aria-labelledby="opsw-section-monitoring"
                    data-ops-section="monitoring"
                    data-ops-section-rank="secondary"
                  >
                    <h2 className="opsw-section__title" id="opsw-section-monitoring">
                      {copy.sectionMonitoring}
                    </h2>
                    <p className="opsw-muted opsw-section__hint">{copy.sectionMonitoringHint}</p>
                    <GroupSurface groups={monitoringGroups} openGroupKey={sectionKey("monitoring")} onOpen={openFrom("monitoring")} />
                  </section>
                ) : (
                  collapsedSection("monitoring", copy.sectionEmptyMonitoring)
                )}
              </>
            )
          ) : (grouped ? groups.length : rows.length) === 0 ? (
            emptyState
          ) : grouped ? (
            // A FILTERED grouped view: exactly what the filters asked for.
            <GroupSurface
              groups={groups}
              openGroupKey={sectionKey("filtered")}
              onOpen={openFrom("filtered")}
            />
          ) : (
            <>
              {showQuietNoActive ? (
                <p className="opsw-muted opsw-quiet-line" role="status" data-ops-quiet-clear>
                  {copy.quietNoActive}
                </p>
              ) : null}
              <IncidentSurface
                rows={rows}
                openId={openId}
                markedIds={markedIds}
                showOwnerColumn={collaborative}
                showSelection={
                  capabilities.canAcknowledge || capabilities.canSuppress
                }
                handlers={{
                  onOpen: openIncident,
                  onAcknowledge: (id) => void runTransition(id, "ack"),
                  // OPS-029 — a source that needs a written conclusion is
                  // resolved from its drawer, where the note is asked for.
                  onResolve: (id) =>
                    rows.find((r) => r.id === id)?.requiresResolutionNote
                      ? openIncident(id)
                      : void runTransition(id, "resolve"),
                  // OPS-030 — stopping notifications needs a reason.
                  onSuppress: openIncident,
                  onAssign: openIncident,
                  onToggleMark: toggleMark,
                  pendingId,
                }}
              />
            </>
          )}

          {/* RESOLVED — every resolved condition, quiet reference content under the
              grouped sections. Not rendered under the first-use panel (there
              is no history to show), and one line when it is empty. */}
          {grouped && !groupsError && !narrowing && !mayAssertClear ? (
            resolvedUnavailable ? (
              <div className="opsw-section-collapsed" data-ops-section="recently-resolved" data-ops-section-collapsed="true">
                <p className="opsw-muted" role="status" data-ops-section-unavailable>{copy.sectionResolvedUnavailable}</p>
              </div>
            ) : resolvedLoading && resolvedGroups.length === 0 ? null : resolvedGroups.length > 0 ? (
              <section
                className="opsw-section opsw-section--quiet"
                aria-labelledby="opsw-section-resolved"
                data-ops-section="recently-resolved"
                data-ops-section-rank="reference"
              >
                <h2 className="opsw-section__title" id="opsw-section-resolved">
                  {copy.sectionRecentlyResolved}
                </h2>
                <p className="opsw-muted opsw-section__hint">{copy.sectionRecentlyResolvedHint}</p>
                <GroupSurface
                  groups={resolvedGroups}
                  openGroupKey={sectionKey("resolved")}
                  onOpen={openFrom("resolved")}
                  timeline="resolution"
                />
              </section>
            ) : (
              collapsedSection("recently-resolved", copy.sectionEmptyResolved)
            )
          ) : null}

          {/* OPS-020 — the flat list's pager only. */}
          {!grouped && nextCursor ? (
            <div className="opsw-more">
              <button
                type="button"
                className="app-secondary-action"
                onClick={loadMore}
                disabled={loadingMore}
                aria-busy={loadingMore}
                data-ops-load-more
              >
                {loadingMore ? copy.loading : fillOperationsCopy(copy.loadMore, { n: fmt(PAGE_SIZE) })}
              </button>
              {loadMoreError ? (
                <span
                  className="opsw-more__error"
                  role="status"
                  data-ops-load-more-error
                >
                  {loadMoreError.message}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      <StepUpModal control={stepUp} />

      {openGroup && openGroupRef ? (
        <GroupInspector
          group={openGroup}
          records={affected}
          loading={affectedLoading}
          error={affectedError}
          hasMore={affectedHasMore}
          onLoadMore={() => loadAffected(openGroupRef, affectedCursor)}
          onClose={() => setOpenGroupRef(null)}
          // OPS-012 — every member opens its condition, where its action is.
          onOpenCondition={openIncident}
          canOpenRecords={canOpenRecords}
        />
      ) : null}

      {openRow ? (
        <IncidentInspector
          row={openRow}
          detail={detail}
          capabilities={capabilities}
          showOwnership={collaborative}
          operators={operators}
          selfUserId={selfUserId}
          pending={busy}
          onClose={closeIncident}
          onAcknowledge={() => void runTransition(openRow.id, "ack")}
          // Returns the outcome, so the drawer keeps a note the server
          // refused and clears one it accepted.
          onResolve={(resolutionNote) =>
            runTransition(openRow.id, "resolve", { resolutionNote })
          }
          onSuppress={(reason) => void runTransition(openRow.id, "suppress", { reason })}
          onUnsuppress={() => void runTransition(openRow.id, "unsuppress")}
          onAssign={(userId) => void assign(openRow.id, userId)}
          remediation={remediation}
          remediationBusy={remediationBusy}
          remediationOutcome={remediationOutcome}
          onRemediate={(actionId, reason) => void remediate(actionId, reason)}
          onRetryRemediation={remediationRetry}
        />
      ) : null}
    </PageShell>
  );
}
