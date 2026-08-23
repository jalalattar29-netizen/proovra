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
 * Production rendered TWO page shells stacked on top of each other. The
 * `HubQuickActionsBar` emitted `<h1>Operations Center</h1>` plus three quick
 * actions, and `OpsPageInner` then rendered a canonical `PageHeader` with the
 * same title again. Two headers, two titles, one page.
 *
 * All three of the bar's quick actions pointed at surfaces the tenant reading
 * them cannot open — `/admin/platform/observability`, `/admin/platform/
 * runbooks` and an integrations console most operators are not admins of. The
 * hub definition that produced them has been deleted, and `operations` removed
 * from `HUB_IDS`, so mounting that bar on this route no longer typechecks.
 *
 * Below that, two thirds of the page were PLATFORM RUNTIME, read from
 * `/v1/ops/health` and `/v1/ops/metrics`:
 *
 *   Database up · Sentry · webhook alerts · communications ready ·
 *   identity-security ready · jobs failed · invalid webhook signatures ·
 *   step-up denied · 5xx · alerts sent · "Process uptime: 38 min · 522
 *   counters · 80 gauges"
 *
 * Those are properties of the API PROCESS, not of the workspace. They reset on
 * deploy, they are identical for every tenant on the instance, and no tenant
 * can act on any of them. They belong to `/admin/platform/observability`,
 * where they still live. THIS ROUTE NO LONGER FETCHES EITHER ENDPOINT — the
 * only reads below are `/v1/ops/summary`, `/v1/ops/incidents`,
 * `/v1/ops/incidents/:id` and `/v1/ops/assignable-operators`, all of which are
 * workspace-scoped.
 *
 * The six-button "Operations Intelligence" panel is gone too. Every button ran
 * the same deterministic snapshot through a language model and got back a
 * paraphrase of counts already on the screen, spending an AI operation each
 * time to state a number the summary strip states for free.
 *
 * ===========================================================================
 * WHY THERE IS NO PLAN BRANCH IN THIS FILE
 * ===========================================================================
 * Personal Pro, a shared Team, an Organization workspace and an Enterprise
 * customer all render THIS component. Nothing here reads a plan name, an
 * entitlement, a workspace kind or a member count. Two server-projected
 * signals shape the surface:
 *
 *   capabilities.OPERATIONS_*   what this caller may DO
 *   workspace.operatorCount     whether OWNERSHIP is a real axis here
 *
 * A sole operator gets four summary cards, no owner column and no owner
 * filter, because the server grants no `OPERATIONS_ASSIGN` where there is
 * nobody to assign to. A read-only viewer in a shared workspace gets the owner
 * column and filter and no mutations. An Enterprise admin gets the same table
 * with a bulk toolbar after selection. One design, three densities, zero
 * forks.
 *
 * ===========================================================================
 * HONESTY
 * ===========================================================================
 * Every read carries `complete` / `mayAssertAllClear`. "Workspace operations
 * are clear" renders only when the incident source said it reached the end of
 * the collection. A failed or truncated read produces a degraded banner and
 * never a reassuring empty state.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
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

import "./operations.css";

import { BulkToolbar } from "./_components/BulkToolbar";
import { FilterToolbar } from "./_components/FilterToolbar";
import { IncidentInspector } from "./_components/IncidentInspector";
import { IncidentSurface } from "./_components/IncidentSurface";
import { QueueSummary } from "./_components/QueueSummary";
import {
  ClearState,
  DegradedNotice,
  InlineMutationError,
  LoadingState,
  NoMatchState,
  RefreshingNotice,
  RestrictedState,
  UnavailableState,
} from "./_components/States";
import { IconOperations, IconRefresh } from "./_components/icons";
import {
  DEFAULT_FILTERS,
  PAGE_SIZE,
  anyFilterActive,
  filtersFromParams,
  filtersToParams,
  incidentsQuery,
  type FilterState,
} from "./_lib/filters";
import { buildRowModel } from "./_lib/rowModel";
import type {
  AssignableOperator,
  Incident,
  IncidentDetail,
  IncidentListResponse,
  OperationsCapabilities,
  OperationsSummary,
  SourceState,
} from "./_lib/types";
import type { QueueMetricKey } from "./_lib/vocabulary";

// ---------------------------------------------------------------------------

const LOADING = { kind: "loading" } as const;

/**
 * A failed read becomes an operator-facing sentence, never a provider string.
 *
 * `toSafeUserError` is the sanctioned projection everywhere else in the app;
 * these three surface names only decide WHICH sentence, so a 503 on the
 * summary does not tell the operator their incidents are unavailable.
 */
function sourceErrorFor(
  surface: "summary" | "incidents" | "detail",
  err: unknown,
): { message: string; requestId?: string } {
  const safe = toSafeUserError(err, {
    message:
      surface === "summary"
        ? "The queue summary could not be loaded."
        : surface === "incidents"
          ? "Operational conditions could not be loaded."
          : "This condition's history could not be loaded.",
  });
  return { message: safe.message, requestId: safe.supportReference };
}

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
    return {
      canAcknowledge,
      canResolve,
      canSuppress,
      canAssign,
      canActOnAnything:
        canAcknowledge || canResolve || canSuppress || canAssign,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    capabilityMap.OPERATIONS_ACKNOWLEDGE,
    capabilityMap.OPERATIONS_RESOLVE,
    capabilityMap.OPERATIONS_SUPPRESS,
    capabilityMap.OPERATIONS_ASSIGN,
  ]);
  const canView = capabilityMap.OPERATIONS_VIEW === true;
  const viewerUserId = envelope?.account?.userId ?? null;

  // -------------------------------------------------------------------------
  // FILTERS — the URL is the state, so a filtered queue is a shareable link.
  // -------------------------------------------------------------------------
  /**
   * The filters, keyed on the query STRING rather than on the params object.
   *
   * `useSearchParams()` is not stable by identity, and this memo feeds the
   * read effect below. Depending on the object therefore re-derives the
   * filters every render, refires the read, sets state, and renders again —
   * a loop rather than a wasted allocation. Keying on the serialised value
   * makes the dependency say what it actually is: the filters change when
   * the QUERY changes.
   */
  const searchKey = searchParams?.toString() ?? "";
  const filters = React.useMemo(
    () => filtersFromParams(new URLSearchParams(searchKey)),
    [searchKey],
  );

  const applyFilters = React.useCallback(
    (next: FilterState) => {
      const qs = filtersToParams(next).toString();
      router.replace(qs ? `/operations?${qs}` : "/operations", {
        scroll: false,
      });
    },
    [router],
  );
  const patchFilters = React.useCallback(
    (patch: Partial<FilterState>) => applyFilters({ ...filters, ...patch }),
    [applyFilters, filters],
  );
  const clearFilters = React.useCallback(
    () => applyFilters({ ...DEFAULT_FILTERS }),
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
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastLoadedAtUtc, setLastLoadedAtUtc] = React.useState<string | null>(
    null,
  );
  const [reloadToken, setReloadToken] = React.useState(0);

  const [operators, setOperators] = React.useState<AssignableOperator[]>([]);
  const [selfUserId, setSelfUserId] = React.useState<string | null>(null);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] =
    React.useState<SourceState<IncidentDetail>>(LOADING);

  const [markedIds, setMarkedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [mutationError, setMutationError] =
    React.useState<SafeUserError | null>(null);

  /**
   * Every in-flight read carries the token it was started under.
   *
   * A response that arrives after the workspace changed, or after the filters
   * changed, is DISCARDED rather than rendered. Without this, switching
   * workspaces while a slow read is outstanding paints the previous
   * workspace's conditions into the new workspace's queue — a tenant-boundary
   * defect that no server-side check can catch, because the server answered
   * both questions correctly.
   */
  const requestSeq = React.useRef(0);

  const gate: null | "no_envelope" | "not_included" | "no_workspace" = !envelope
    ? "no_envelope"
    : !canView
      ? "not_included"
      : !teamId
        ? "no_workspace"
        : null;

  // -------------------------------------------------------------------------
  // THE READ
  //
  // Summary and incidents are independent: a failed summary must not blank the
  // queue, and a failed queue must not hide the summary. `Promise.allSettled`
  // rather than `Promise.all` for exactly that reason.
  // -------------------------------------------------------------------------
  React.useEffect(() => {
    if (gate || !teamId) return;
    const seq = ++requestSeq.current;
    const first = summary.kind === "loading" && incidents.kind === "loading";
    if (!first) setRefreshing(true);

    void Promise.allSettled([
      apiFetch(`/v1/ops/summary?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(`/v1/ops/incidents?${incidentsQuery({ teamId, filters })}`, {
        method: "GET",
      }),
    ]).then(([summaryR, incidentsR]) => {
      if (seq !== requestSeq.current) return;

      if (summaryR.status === "fulfilled") {
        const v = summaryR.value as {
          summary: OperationsSummary;
          workspace?: { operatorCount: number };
        };
        setSummary({ kind: "ready", data: v.summary });
        setOperatorCount(v.workspace?.operatorCount ?? null);
      } else {
        setSummary({ kind: "error", ...sourceErrorFor("summary", summaryR.reason) });
      }

      if (incidentsR.status === "fulfilled") {
        const v = incidentsR.value as IncidentListResponse;
        setIncidents({ kind: "ready", data: v.incidents ?? [] });
        setComplete(v.completeness?.complete ?? true);
        setNextCursor(v.pagination?.nextCursor ?? null);
      } else {
        setIncidents({
          kind: "error",
          ...sourceErrorFor("incidents", incidentsR.reason),
        });
      }

      setRefreshing(false);
      setLastLoadedAtUtc(new Date().toISOString());
    });
    // `summary.kind` / `incidents.kind` are read only to decide whether this is
    // the FIRST load; including them would re-fire the effect on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, gate, filters, reloadToken]);

  /**
   * The eligible-operator list is read ONCE per workspace, not per row.
   *
   * Gated on `operations.assign` server-side, so a viewer simply gets no list
   * and the owner FILTER still offers Anyone / Me / Unassigned — the part that
   * does not require knowing who anybody is.
   */
  React.useEffect(() => {
    if (gate || !teamId || !capabilities.canAssign) {
      setOperators([]);
      setSelfUserId(null);
      return;
    }
    const seq = requestSeq.current;
    void apiFetch(
      `/v1/ops/assignable-operators?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res) => {
        if (seq !== requestSeq.current) return;
        const v = res as { operators: AssignableOperator[]; selfUserId: string };
        setOperators(v.operators ?? []);
        setSelfUserId(v.selfUserId ?? null);
      })
      .catch(() => {
        // A missing picker is not worth a banner: ownership still renders, the
        // filter still works, and the operator can retry by reopening.
        setOperators([]);
      });
  }, [teamId, gate, capabilities.canAssign]);

  // The inspector's history is its own read, so a failed history never blanks
  // the condition the operator opened.
  React.useEffect(() => {
    if (!openId || !teamId) return;
    const seq = ++requestSeq.current;
    setDetail(LOADING);
    void apiFetch(
      `/v1/ops/incidents/${encodeURIComponent(openId)}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res) => {
        if (seq !== requestSeq.current) return;
        setDetail({
          kind: "ready",
          data: (res as { incident: IncidentDetail }).incident,
        });
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setDetail({ kind: "error", ...sourceErrorFor("detail", err) });
      });
  }, [openId, teamId, reloadToken]);

  const loadMore = React.useCallback(() => {
    if (!teamId || !nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    void apiFetch(
      `/v1/ops/incidents?${incidentsQuery({ teamId, filters, cursor: nextCursor })}`,
      { method: "GET" },
    )
      .then((res) => {
        if (seq !== requestSeq.current) return;
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
        setMutationError(
          toSafeUserError(err, { message: "Could not load more conditions." }),
        );
      })
      .finally(() => setLoadingMore(false));
  }, [teamId, nextCursor, loadingMore, filters]);

  const refresh = React.useCallback(() => setReloadToken((n) => n + 1), []);

  // -------------------------------------------------------------------------
  // MUTATIONS
  //
  // Nothing is applied optimistically. Each transition re-reads from the
  // server, because the server owns the state machine and can refuse: a row
  // that shows Resolved over a rejected write is the failure this surface
  // exists to prevent.
  // -------------------------------------------------------------------------
  const runTransition = React.useCallback(
    async (incidentId: string, action: "ack" | "resolve" | "suppress") => {
      if (!teamId || busy) return;
      setBusy(true);
      setPendingId(incidentId);
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/${action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        );
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, { message: "That action could not be applied." }),
        );
      } finally {
        setBusy(false);
        setPendingId(null);
      }
    },
    [teamId, busy, refresh],
  );

  const assign = React.useCallback(
    async (incidentId: string, assigneeUserId: string | null) => {
      if (!teamId || busy) return;
      setBusy(true);
      setPendingId(incidentId);
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/assign`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId, assigneeUserId }),
          },
        );
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, { message: "Could not change who owns this." }),
        );
      } finally {
        setBusy(false);
        setPendingId(null);
      }
    },
    [teamId, busy, refresh],
  );

  const runBulk = React.useCallback(
    async (actionType: "BULK_ACKNOWLEDGE_INCIDENTS" | "BULK_SUPPRESS_INCIDENTS") => {
      if (!teamId || busy || markedIds.size === 0) return;
      setBusy(true);
      setMutationError(null);
      try {
        await apiFetch(`/v1/ops/bulk-actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            actionType,
            targetIds: Array.from(markedIds),
          }),
        });
        setMarkedIds(new Set());
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: "That bulk action could not be applied.",
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [teamId, busy, markedIds, refresh],
  );

  // -------------------------------------------------------------------------
  // DERIVED
  // -------------------------------------------------------------------------
  /**
   * ONE instant for the whole queue: the moment the list was read.
   *
   * Not `Date.now()` per row — the first and last rows of a long queue would
   * then be aged against different presents — and not a fresh `Date.now()` per
   * render either, which would make every unrelated re-render silently re-age
   * the table. Measuring against the READ is also the honest choice: these
   * ages describe the data that was fetched, not the moment React re-ran.
   */
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
            }),
          )
        : [],
    [incidents, capabilities, viewerUserId, operatorLabels, now],
  );

  /**
   * Ownership is a real axis only where more than one person can hold work.
   *
   * Server-projected, from the same resolver that decides who may be assigned.
   * NOT the caller's own assign capability — a viewer in a shared workspace
   * holds none and must still be able to ask who is on something.
   */
  const collaborative = (operatorCount ?? 0) > 1;

  const openRow = openId ? (rows.find((r) => r.id === openId) ?? null) : null;

  // The selected summary card, derived from the filters rather than stored
  // separately — otherwise a browser Back that changes the URL leaves the
  // highlighted card disagreeing with the queue underneath it.
  const selectedMetric: QueueMetricKey | null =
    filters.severity === "CRITICAL" && filters.status === "OPEN"
      ? "critical"
      : filters.severity === "HIGH" && filters.status === "OPEN"
        ? "high"
        : filters.owner === "me"
          ? "assignedToMe"
          : filters.owner === "unassigned"
            ? "unassigned"
            : null;

  const selectMetric = React.useCallback(
    (key: QueueMetricKey) => {
      // Each card is ONE coherent view, so it sets every axis it implies and
      // clears the ones it does not. Layering a card on top of leftover
      // filters is how an operator presses "Critical" and sees nothing.
      const base: FilterState = { ...DEFAULT_FILTERS };
      if (key === "critical") applyFilters({ ...base, severity: "CRITICAL" });
      else if (key === "high") applyFilters({ ...base, severity: "HIGH" });
      else if (key === "assignedToMe") applyFilters({ ...base, owner: "me" });
      else if (key === "unassigned") applyFilters({ ...base, owner: "unassigned" });
      else applyFilters(base);
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
          <h1 className="app-page-header__title">Operations</h1>
          <p className="app-page-header__subtitle">
            {capabilities.canActOnAnything
              ? "Monitor, assign and resolve operational conditions in this workspace."
              : "Monitor operational conditions in this workspace. Acting on one needs an operator role."}
          </p>
          <p className="opsw-context" data-ops-context>
            {workspaceName ? (
              <>
                <span>Conditions in</span>{" "}
                <strong data-context-workspace>{workspaceName}</strong>
              </>
            ) : null}
            {lastLoadedAtUtc ? (
              <span className="opsw-context__stamp" data-ops-last-loaded>
                Updated {formatUserDateTime(lastLoadedAtUtc)}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {!gate ? (
        <div className="app-page-header__actions">
          <button
            type="button"
            className="app-secondary-action"
            onClick={refresh}
            disabled={refreshing}
            data-ops-refresh
          >
            <IconRefresh size={16} />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
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
   * The all-clear predicate, stated once.
   *
   * FOUR things must be true: the read succeeded, it reached the end of the
   * collection, the result is empty, and nothing was filtering it. Drop any
   * one and this sentence becomes a lie an operator will act on.
   */
  const mayAssertClear =
    incidents.kind === "ready" &&
    complete &&
    rows.length === 0 &&
    !anyFilterActive(filters);

  return (
    <PageShell className="opsw-page" header={header} data-testid="operations-page">
      {mutationError ? (
        <InlineMutationError
          error={mutationError}
          onDismiss={() => setMutationError(null)}
        />
      ) : null}

      {summaryFailed ? (
        <DegradedNotice
          what="The queue summary"
          message={summary.message}
          requestId={summary.requestId}
          onRetry={refresh}
        />
      ) : null}

      {incidents.kind === "ready" && !complete ? (
        <DegradedNotice
          what="Part of the condition list"
          message="More conditions exist than were returned."
        />
      ) : null}

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

          <FilterToolbar
            filters={filters}
            onChange={patchFilters}
            onClear={clearFilters}
            showClear={anyFilterActive(filters)}
            showOwnerFilter={collaborative}
            operators={operators}
            busy={busy}
            resultSummary={
              rows.length === 1
                ? "1 condition"
                : `${rows.length}${nextCursor ? "+" : ""} conditions`
            }
          />

          <BulkToolbar
            count={markedIds.size}
            capabilities={capabilities}
            busy={busy}
            onAcknowledge={() => void runBulk("BULK_ACKNOWLEDGE_INCIDENTS")}
            onSuppress={() => void runBulk("BULK_SUPPRESS_INCIDENTS")}
            onClear={() => setMarkedIds(new Set())}
          />

          {rows.length === 0 ? (
            mayAssertClear ? (
              <ClearState />
            ) : (
              <NoMatchState onClear={clearFilters} />
            )
          ) : (
            <IncidentSurface
              rows={rows}
              openId={openId}
              markedIds={markedIds}
              showOwnerColumn={collaborative}
              showSelection={
                capabilities.canAcknowledge || capabilities.canSuppress
              }
              handlers={{
                onOpen: setOpenId,
                onAcknowledge: (id) => void runTransition(id, "ack"),
                onResolve: (id) => void runTransition(id, "resolve"),
                onSuppress: (id) => void runTransition(id, "suppress"),
                onAssign: setOpenId,
                onToggleMark: toggleMark,
                pendingId,
              }}
            />
          )}

          {nextCursor ? (
            <div className="opsw-more">
              <button
                type="button"
                className="app-secondary-action"
                onClick={loadMore}
                disabled={loadingMore}
                data-ops-load-more
              >
                {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more`}
              </button>
            </div>
          ) : null}
        </>
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
          onClose={() => setOpenId(null)}
          onAcknowledge={() => void runTransition(openRow.id, "ack")}
          onResolve={() => void runTransition(openRow.id, "resolve")}
          onSuppress={() => void runTransition(openRow.id, "suppress")}
          onAssign={(userId) => void assign(openRow.id, userId)}
        />
      ) : null}
    </PageShell>
  );
}
