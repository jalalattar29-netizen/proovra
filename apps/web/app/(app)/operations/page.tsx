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
import { QueueSummary } from "./_components/QueueSummary";
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
  ReconciliationStaleNotice,
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
    const canManageSharedViews =
      capabilityMap.OPERATIONS_SAVED_VIEWS_MANAGE === true;
    return {
      canAcknowledge,
      canResolve,
      canSuppress,
      canAssign,
      canManageSharedViews,
      // Deliberately NOT including `canManageSharedViews`: this decides
      // whether INCIDENT actions render, and managing a saved view acts on
      // configuration rather than on any condition in the queue.
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

  /**
   * APPLY A SAVED VIEW.
   *
   * It writes the URL, exactly as every other filter change does, so the URL
   * remains the ONE shareable description of what the queue is showing. A view
   * that set state directly would leave the address bar describing something
   * else, and a link copied from it would open a different queue.
   *
   * Every field the view did not set falls back to the DEFAULT rather than to
   * the filters currently on screen: a named view must mean the same thing
   * whatever the operator happened to be looking at when they clicked it.
   */
  const applyView = React.useCallback(
    (view: OperationsSavedView) => {
      const f = view.filter;
      applyFilters({
        ...DEFAULT_FILTERS,
        status: (f.status ?? "") as FilterState["status"],
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
  /**
   * The workspace's own SLA commitment, sent with the list.
   *
   * Null until a page arrives, and null forever for a workspace whose policy
   * could not be resolved — in which case no row makes a claim about
   * lateness rather than measuring against a default nobody agreed to.
   */
  const [sla, setSla] = React.useState<SlaEnvelope | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
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

  // ==========================================================================
  // THE GROUPED QUEUE
  // ==========================================================================
  //
  // The DEFAULT. A workspace with five thousand records whose timestamping
  // failed had five thousand top-level rows, all saying the same sentence, and
  // the one genuinely different condition sat at position 3,847. The server
  // has computed these groups for a release and nothing rendered them.
  //
  // Not an Enterprise mode: every workspace kind renders this, and a group of
  // one shows its own condition's title and reads exactly like the row it
  // replaces. "All conditions" is one toggle away and reaches the same rows.
  const [grouped, setGrouped] = React.useState(true);
  const [groups, setGroups] = React.useState<IncidentGroup[]>([]);
  /**
   * THE HEADLINE TOTALS, AS THE SERVER COMPUTED THEM.
   *
   * The header read `${rows.length} conditions` in every mode, so a grouped
   * queue showing five rows was captioned "38 conditions" and the two numbers
   * on one screen had no stated relationship. Both are true; they answer
   * different questions; the header now says which is which and takes both
   * from the response that produced the list it sits above.
   */
  const [groupTotals, setGroupTotals] = React.useState<IncidentGroupTotals | null>(
    null,
  );
  const [groupsLoading, setGroupsLoading] = React.useState(false);
  const [openGroupKey, setOpenGroupKey] = React.useState<string | null>(null);
  /**
   * THE GROUPED READ'S OWN SEQUENCE.
   *
   * Deliberately NOT the queue's. They are two independent reads that resolve
   * in whatever order the network gives them, and sharing one counter means
   * the second to finish invalidates the first — the grouped response would
   * arrive, be discarded because the flat list had since bumped the counter,
   * and the page would render an empty grouped queue over real conditions.
   */
  const groupsSeq = React.useRef(0);

  /** The drill-down's accumulated pages for the OPEN group. */
  const [affected, setAffected] = React.useState<AffectedRecord[]>([]);
  const [affectedCursor, setAffectedCursor] = React.useState<string | null>(null);
  const [affectedHasMore, setAffectedHasMore] = React.useState(false);
  const [affectedLoading, setAffectedLoading] = React.useState(false);
  const [affectedError, setAffectedError] = React.useState<string | null>(null);
  const affectedSeq = React.useRef(0);

  React.useEffect(() => {
    if (!teamId || !grouped) return;
    const seq = ++groupsSeq.current;
    setGroupsLoading(true);
    // The SAME filters the flat list sends. A grouped view that ignored the
    // operator's filters would be showing a different queue under the same
    // heading.
    const params = new URLSearchParams({ teamId });
    if (filters.status) params.set("status", filters.status);
    if (filters.severity) params.set("severity", filters.severity);
    if (filters.category) params.set("category", filters.category);
    if (filters.owner) params.set("owner", filters.owner);
    if (filters.sla) params.set("sla", filters.sla);
    if (filters.q) params.set("q", filters.q);
    void apiFetch(`/v1/ops/incident-groups?${params.toString()}`, {
      method: "GET",
    })
      .then((res) => {
        if (seq !== groupsSeq.current) return;
        const payload = res as {
          groups?: IncidentGroup[];
          totals?: IncidentGroupTotals;
        };
        const next = (payload.groups ?? []).slice();
        setGroups(next);
        // An older server sends no totals. Derived from the payload rather
        // than left null, because a header with a group count and no condition
        // count is worse than one computed from the same rows on screen.
        setGroupTotals(
          payload.totals ?? {
            groups: next.length,
            conditions: next.reduce((sum, g) => sum + g.conditionCount, 0),
          },
        );
      })
      .catch(() => {
        if (seq !== groupsSeq.current) return;
        // A failed grouped read leaves the groups EMPTY rather than stale.
        // The flat list is still there, and an empty grouped view with a
        // visible toggle is honest; a previous workspace's groups would not be.
        setGroups([]);
        setGroupTotals(null);
      })
      .finally(() => {
        if (seq === groupsSeq.current) setGroupsLoading(false);
      });
  }, [teamId, grouped, filters, reloadToken]);

  /** Load one page of the open group's members. */
  const loadAffected = React.useCallback(
    (groupKey: string, cursor: string | null) => {
      if (!teamId) return;
      const seq = ++affectedSeq.current;
      setAffectedLoading(true);
      setAffectedError(null);
      const params = new URLSearchParams({ teamId });
      if (cursor) params.set("cursor", cursor);
      void apiFetch(
        `/v1/ops/incident-groups/${encodeURIComponent(groupKey)}/affected?${params.toString()}`,
        { method: "GET" },
      )
        .then((res) => {
          if (seq !== affectedSeq.current) return;
          const v = res as {
            records?: AffectedRecord[];
            pagination?: { nextCursor: string | null };
          };
          // APPEND, never replace: the operator is paging through one group
          // and the rows they have already read must not vanish under them.
          setAffected((prev) =>
            cursor ? [...prev, ...(v.records ?? [])] : (v.records ?? []),
          );
          setAffectedCursor(v.pagination?.nextCursor ?? null);
          setAffectedHasMore((v.pagination?.nextCursor ?? null) !== null);
        })
        .catch((err) => {
          if (seq !== affectedSeq.current) return;
          // Bounded and already-safe. The raw transport error never reaches
          // the panel.
          setAffectedError(
            toSafeUserError(err, {
              message: "Those records could not be loaded.",
            }).message,
          );
        })
        .finally(() => {
          if (seq === affectedSeq.current) setAffectedLoading(false);
        });
    },
    [teamId],
  );

  // Opening a group starts its drill-down from the first page, and closing one
  // clears it so the next group cannot inherit the previous one's records.
  React.useEffect(() => {
    setAffected([]);
    setAffectedCursor(null);
    setAffectedHasMore(false);
    setAffectedError(null);
    if (openGroupKey) loadAffected(openGroupKey, null);
  }, [openGroupKey, loadAffected]);

  const openGroup = openGroupKey
    ? (groups.find((g) => g.groupKey === openGroupKey) ?? null)
    : null;

  const [detail, setDetail] =
    React.useState<SourceState<IncidentDetail>>(LOADING);

  /**
   * WHAT THIS OPERATOR MAY DO ABOUT THE OPEN CONDITION.
   *
   * Server-projected, and held separately from the detail so the browser has
   * no path that could reconstruct it: there is no plan name, no role string
   * and no severity here from which an action could be re-derived locally.
   * When the server sends nothing, nothing is offered.
   */
  const [remediation, setRemediation] =
    React.useState<ProjectedRemediation | null>(null);
  const [remediationBusy, setRemediationBusy] = React.useState<string | null>(
    null,
  );
  const [remediationOutcome, setRemediationOutcome] =
    React.useState<RemediationOutcome | null>(null);

  const [markedIds, setMarkedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The PER-TARGET answer to the last sweep. */
  const [bulkOutcome, setBulkOutcome] = React.useState<string | null>(null);
  const [mutationError, setMutationError] =
    React.useState<SafeUserError | null>(null);

  /**
   * The canonical accessible dialog, mounted once at the root layer. Used
   * here for exactly one refusal; every other failure keeps the banner.
   */
  const { confirm } = useConfirmAction();

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

  /**
   * The CANONICAL step-up control, shared with every other surface that runs
   * a bulk fan-out. It owns the challenge, the retry and the cancel signal;
   * this page only says which request needs it.
   */
  const stepUp = useStepUpAction({ teamId });

  /**
   * MAY THIS CONTEXT READ OPERATIONAL DATA AT ALL?
   *
   * The SAME predicate the application shell asks before its runtime poller
   * fires. Sharing it is the point: two gates over one boundary drift, and
   * these two already had — the route would read on an envelope that
   * disagreed with itself about which workspace was active, because
   * self-consistency was a question only the shell's resolver asked.
   *
   * It answers whether to ASK. What the answer MEANS still belongs to the
   * canonical incident projection, and the server remains authoritative.
   */
  const readAccess = resolveRuntimeReadAccess({ envelope, teamId });

  // ORDER MATTERS, and it is the reverse of the obvious one.
  //
  // `useActiveWorkspaceId` returns null for a workspace that has not resolved,
  // which includes a SUSPENDED or INACTIVE one — so checking `!teamId` first
  // told a suspended operator "No workspace is selected yet", which is both
  // wrong and unactionable. The envelope knows the real reason; it is asked
  // before the symptom is.
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
        // The commitment travels WITH the rows it governs, so a page that
        // failed to load cannot leave the previous workspace's promise on
        // screen beside a different workspace's conditions.
        setSla(v.sla ?? null);
        setNextCursor(v.pagination?.nextCursor ?? null);
      } else {
        setIncidents({
          kind: "error",
          ...sourceErrorFor("incidents", incidentsR.reason),
        });
      }

      setRefreshing(false);
      // FRESHNESS IS A CLAIM ABOUT DATA THE PAGE HAS.
      //
      // This stamped unconditionally, so a failed read still produced
      // "Updated 17:59" in the header — a statement about a queue that was not
      // fetched, sitting above a panel saying it could not be fetched. The
      // stamp now moves only when the INCIDENT read succeeded, because that is
      // the source the page is showing; when it fails, the previous successful
      // stamp stands and describes what is actually on screen.
      if (incidentsR.status === "fulfilled") {
        setLastLoadedAtUtc(new Date().toISOString());
      }
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
        const v = res as IncidentDetailResponse;
        setDetail({ kind: "ready", data: v.incident });
        setRemediation(v.remediation ?? null);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setDetail({ kind: "error", ...sourceErrorFor("detail", err) });
        setRemediation(null);
      });
  }, [openId, teamId, reloadToken]);

  // Opening a different condition clears the previous one's answer, so a
  // stale "Accepted and queued" can never appear beside a record it did not
  // describe.
  React.useEffect(() => {
    setRemediationOutcome(null);
  }, [openId]);

  /**
   * SAVED VIEWS.
   *
   * Loaded on the same gate as the queue itself: a context that may not read
   * operational data issues no request here either, so a refused workspace
   * makes zero `/v1/ops/*` calls of ANY kind. A failed load leaves the strip
   * empty rather than raising a banner — a missing bookmark list must not look
   * like a failure of the conditions themselves.
   */
  const loadSavedViews = React.useCallback(() => {
    // `gate` is a REFUSAL REASON, so truthy means refused. Same predicate,
    // same direction, as every other read on this page.
    if (gate || !teamId) {
      setSavedViews([]);
      return;
    }
    setSavedViewsLoading(true);
    void apiFetch(
      `/v1/ops/saved-views?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res) => {
        setSavedViews((res as { views: OperationsSavedView[] }).views ?? []);
      })
      .catch(() => setSavedViews([]))
      .finally(() => setSavedViewsLoading(false));
  }, [teamId, gate]);

  React.useEffect(() => {
    loadSavedViews();
  }, [loadSavedViews]);

  const saveView = React.useCallback(
    async (input: { name: string; visibility: "PRIVATE" | "TEAM" }) => {
      if (!teamId || busy) return;
      setBusy(true);
      setMutationError(null);
      try {
        await apiFetch("/v1/ops/saved-views", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            name: input.name,
            visibility: input.visibility,
            // Only the filters that are actually SET. Persisting the empty
            // defaults would make every saved view carry the whole filter
            // vocabulary, so a later change to a default would silently
            // rewrite what old views mean.
            filter: {
              teamId,
              ...(filters.status ? { status: filters.status } : {}),
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
        loadSavedViews();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: "That view could not be saved.",
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [teamId, busy, filters, loadSavedViews],
  );

  /**
   * RENAME ONE VIEW.
   *
   * Sends the `updatedAt` the browser last read. A view that changed since
   * then is a 409 rather than an overwrite: without that, two operators
   * renaming one shared view both succeed and the first person's change is
   * gone with no error anywhere.
   */
  const renameView = React.useCallback(
    async (view: OperationsSavedView, name: string) => {
      if (!teamId || busy) return;
      setBusy(true);
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/saved-views/${encodeURIComponent(view.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              teamId,
              expectedUpdatedAt: view.updatedAt,
              name,
            }),
          },
        );
        loadSavedViews();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message:
              "That view could not be renamed. It may have changed since you opened it.",
          }),
        );
        // Re-read either way, so the operator sees whatever is actually there
        // rather than the name they tried to set.
        loadSavedViews();
      } finally {
        setBusy(false);
      }
    },
    [teamId, busy, loadSavedViews],
  );

  const deleteView = React.useCallback(
    async (view: OperationsSavedView) => {
      if (!teamId || busy) return;
      setBusy(true);
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/ops/saved-views/${encodeURIComponent(view.id)}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" },
        );
        loadSavedViews();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: "That view could not be removed.",
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [teamId, busy, loadSavedViews],
  );

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

  // ---------------------------------------------------------------------
  // "CHECK AGAIN" — a request for a NEW CHECK, not a re-read of the old one.
  //
  // It used to be `refresh`, which bumped a token and re-fetched the same
  // summary. That is not what the button says. A workspace whose last run was
  // PARTIAL would re-read the same PARTIAL run and render the same warning,
  // and an operator pressing it repeatedly had no way to tell that nothing
  // was being re-examined.
  //
  // Now it asks the server explicitly, then polls the run's readiness until
  // it leaves RUNNING. The poll is BOUNDED — a fixed attempt budget with a
  // widening interval — because an unbounded poller on a run that never
  // finishes is a browser tab quietly hammering an API during an incident.
  // Exhausting the budget is not an error: the run may still be going, and
  // the surface says exactly that rather than inventing a failure.
  // ---------------------------------------------------------------------
  const RECONCILE_POLL_ATTEMPTS = 12;
  const RECONCILE_POLL_BASE_MS = 750;
  const RECONCILE_POLL_MAX_MS = 4000;

  const checkAgain = React.useCallback(async () => {
    if (!teamId || refreshing) return;
    setRefreshing(true);
    setMutationError(null);
    try {
      const started = (await apiFetch(`/v1/ops/workspace-reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      })) as { refusedReason?: string | null; retryable?: boolean } | null;

      // A refusal the server can name is shown as itself. It is bounded
      // server-side vocabulary, never a message from a driver.
      if (started?.refusedReason) {
        setMutationError(
          started.retryable === false
            ? {
                title: "This check can't run right now",
                message:
                  "The app and its data store don't currently match, so a new check would fail the same way. Contact whoever manages this deployment.",
                severity: "error",
              }
            : {
                title: "A new check couldn't be started",
                message: "Nothing has changed. Try again shortly.",
                severity: "warning",
              },
        );
        refresh();
        return;
      }

      for (let attempt = 0; attempt < RECONCILE_POLL_ATTEMPTS; attempt += 1) {
        const wait = Math.min(
          RECONCILE_POLL_BASE_MS * 2 ** Math.floor(attempt / 3),
          RECONCILE_POLL_MAX_MS,
        );
        await new Promise((r) => setTimeout(r, wait));
        const polled = (await apiFetch(
          `/v1/ops/summary?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as { summary?: { readiness?: string } } | null;
        if (polled?.summary?.readiness !== "RUNNING") break;
      }
    } catch (err) {
      setMutationError(
        toSafeUserError(err, {
          message: "A new check could not be started.",
        }),
      );
    } finally {
      // Whatever happened, re-read once so the surface renders the run that
      // now exists rather than the one it remembered.
      setRefreshing(false);
      refresh();
    }
  }, [teamId, refreshing, refresh]);

  /**
   * A workspace nobody has ever scanned asks for its first check, ONCE.
   *
   * The GET no longer starts a run — it is a read and behaves like one — so
   * something has to ask, or a workspace whose scheduler tick has not landed
   * yet would sit on `NEVER_RUN` while an operator watched an empty page that
   * says nothing has looked.
   *
   * Guarded by a ref rather than by the readiness value, deliberately. Keying
   * off readiness alone would re-fire every time a summary re-read returned
   * `NEVER_RUN`, which is exactly what happens while the first run is still
   * being claimed: start a run, re-read too early, start another. The ref
   * makes it once per workspace per mount, and the durable lock makes a
   * duplicate harmless even if that reasoning is wrong.
   */
  const autoCheckedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!teamId) return;
    if (summary.kind !== "ready") return;
    if (summary.data.readiness !== "NEVER_RUN") return;
    if (autoCheckedRef.current === teamId) return;
    autoCheckedRef.current = teamId;
    void checkAgain();
  }, [teamId, summary, checkAgain]);

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
      // The control the operator actually pressed, captured BEFORE anything
      // disables it. The transition sets `busy`, which disables the row and
      // inspector actions, and a disabled element loses focus to the document
      // body — so by the time a refusal comes back there is nothing for the
      // dialog to hand focus back to. Captured here, restored below.
      const trigger =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
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
        // ---------------------------------------------------------------
        // THE SOURCE-CONTRACT REFUSALS GET A DIALOG. NOTHING ELSE DOES.
        //
        // These are not transport problems or permission problems — they are
        // answers to what the operator just asked, and the previous
        // presentation put them in a banner at the top of the page, far from
        // the row they pressed. On a long queue that banner is off-screen
        // entirely, so the visible outcome of pressing Resolve was: nothing
        // happened. An operator reading that concludes the action worked.
        //
        // A modal is the correct weight precisely because it interrupts: the
        // refusal is about the row in front of them and it changes what they
        // should do next. Every OTHER failure keeps the existing safe banner —
        // this is a targeted correction, not a new error strategy.
        //
        // THREE CODES, THREE SENTENCES. They are three different facts:
        //
        //   STILL_ACTIVE       the source says the condition holds
        //   ACTIVITY_UNKNOWN   the source could not be read at all
        //   NOT_DIRECTLY_RESOLVABLE  nobody may close this one by hand
        //
        // Collapsing them into one message would tell an operator their
        // condition is still failing when the platform merely could not check,
        // which is inventing a fact to avoid an awkward sentence.
        // ---------------------------------------------------------------
        const code =
          err && typeof err === "object"
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        const REFUSAL_NOTICES: Record<
          string,
          { title: string; description: string; testId: string }
        > = {
          CONDITION_STILL_ACTIVE: {
            title: "Condition is still active",
            description:
              "This condition is still being reported by its source. Complete the required remediation, or suppress it with a recorded reason if notifications should stop.",
            testId: "ops-condition-still-active",
          },
          CONDITION_ACTIVITY_UNKNOWN: {
            title: "Condition status could not be verified",
            description:
              "PROOVRA could not confirm that the underlying condition has recovered. No status was changed. Check again after the source becomes available.",
            testId: "ops-condition-activity-unknown",
          },
          CONDITION_NOT_DIRECTLY_RESOLVABLE: {
            title: "This condition cannot be resolved here",
            description:
              "This condition is owned by the surface that reported it and closes when that surface recovers. You can still acknowledge it, assign it, or suppress it with a recorded reason.",
            testId: "ops-condition-not-directly-resolvable",
          },
        };
        const notice = REFUSAL_NOTICES[code];
        if (notice) {
          // The server refused and wrote NOTHING. The re-read below is what
          // puts the row back to its real status; the dialog only explains.
          refresh();
          await confirm({
            title: notice.title,
            description: notice.description,
            // "Close" and not "Dismiss": dismiss, suppress and resolve are
            // three different things an operator can do to a condition, and
            // two of them mutate it. A button that only shuts a dialog must
            // not borrow the name of one that changes the record.
            confirmLabel: "Close",
            tone: "warning",
            noticeOnly: true,
            testId: notice.testId,
          });
          // The pressed control is disabled while the transition is in
          // flight, and a disabled element cannot take focus. Released here,
          // before the restore below, so there is something to return to.
          // The `finally` clears them again; both are idempotent.
          setBusy(false);
          setPendingId(null);
          // AFTER the dialog has finished unmounting, not before.
          //
          // The dialog restores focus to whatever held it when it opened, and
          // by then the pressed control was disabled by `busy` — so its idea
          // of "previous" is the drawer or the body. Deferring by one task
          // lets that restore happen first and then puts focus where the
          // operator actually was.
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
          return;
        }
        setMutationError(
          toSafeUserError(err, { message: "That action could not be applied." }),
        );
        // A REFUSED transition re-reads too, and that is the point of doing it
        // here rather than only on success. The server can decline a resolve
        // whose condition is still active; the row must then show what the
        // server actually holds, not the state the operator asked for. Nothing
        // is applied optimistically, so this is a re-read and never a rollback
        // of a local guess.
        refresh();
      } finally {
        setBusy(false);
        setPendingId(null);
      }
    },
    [teamId, busy, refresh, confirm],
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

  /**
   * REQUEST ONE REGISTERED REMEDIATION.
   *
   * The answer this reports is the answer to the REQUEST, not to the work.
   * Both remediations are asynchronous, so the operator is told the request
   * was accepted and queued — never that the condition is fixed. The
   * condition closes when the source domain's own truth converges and the
   * resolver observes it, which is the only signal that is actually true.
   *
   * Nothing is applied optimistically and the incident is NOT locally marked
   * resolved: a queue accepting work is not evidence that the work succeeded,
   * and showing it as one is the false-clear this surface exists to prevent.
   */
  const remediate = React.useCallback(
    async (actionId: string) => {
      if (!teamId || !openId || remediationBusy) return;
      setRemediationBusy(actionId);
      setRemediationOutcome(null);
      setMutationError(null);
      try {
        const res = await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(openId)}/remediate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId, actionId }),
          },
        );
        const outcome = (res as { remediation?: RemediationOutcome })
          .remediation;
        setRemediationOutcome(
          outcome ?? { result: "QUEUED", message: "Accepted and queued." },
        );
        // Re-read rather than patch: the server owns the condition's state and
        // its timeline now has an entry the browser cannot author.
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: "That action could not be started.",
          }),
        );
      } finally {
        setRemediationBusy(null);
      }
    },
    [teamId, openId, remediationBusy, refresh],
  );

  /**
   * RUN ONE BULK ACTION AND REPORT PER TARGET.
   *
   * The runner answers for every target it touched, and this preserves that
   * distinction rather than collapsing it. A sweep where 12 of 15 conditions
   * moved is neither a success nor a failure, and reporting it as either is
   * actively harmful: "done" leaves three conditions unowned while the
   * operator believes otherwise, and "failed" sends them to redo twelve that
   * already landed.
   *
   * The selection is cleared only when EVERY target succeeded. Keeping the
   * failures marked leaves the operator holding exactly the set that still
   * needs attention, which is the set they would otherwise have to
   * reconstruct by hand.
   */
  const runBulk = React.useCallback(
    async (
      actionType:
        | "BULK_ACKNOWLEDGE_INCIDENTS"
        | "BULK_SUPPRESS_INCIDENTS"
        | "BULK_ASSIGN_INCIDENTS",
      extra?: { assigneeUserId?: string },
    ) => {
      if (!teamId || busy || markedIds.size === 0) return;
      const targetIds = Array.from(markedIds);
      setBusy(true);
      setMutationError(null);
      setBulkOutcome(null);
      try {
        // A sweep mutates many operator records at once, so the server
        // requires the actor to re-prove before the runner touches anything.
        // `runStepUpAction` re-issues the SAME request once the challenge is
        // satisfied; without it every bulk action returns 401 and the
        // operator sees a generic failure with no way to proceed.
        const res = await stepUp.runStepUpAction((headers) =>
          apiFetch(`/v1/ops/bulk-actions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ teamId, actionType, targetIds, ...extra }),
          }),
        );
        const run = res as BulkActionResponse;
        const items = run.items ?? [];
        const failedIds = new Set(
          items
            .filter((i) => i.status !== "SUCCEEDED")
            .map((i) => i.targetId),
        );
        const succeeded = targetIds.length - failedIds.size;

        setBulkOutcome(
          failedIds.size === 0
            ? `${succeeded} of ${targetIds.length} updated.`
            : `${succeeded} of ${targetIds.length} updated. ${failedIds.size} could not be changed and ${failedIds.size === 1 ? "remains" : "remain"} selected.`,
        );
        // Only the ones that did NOT move stay marked.
        setMarkedIds(failedIds);
        refresh();
      } catch (err) {
        if ((err as { code?: string }).code === "STEP_UP_CANCEL") {
          setBulkOutcome("Nothing was changed — verification was cancelled.");
        } else {
          setMutationError(
            toSafeUserError(err, {
              message: "That bulk action could not be applied.",
            }),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [teamId, busy, markedIds, refresh, stepUp],
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
              slaAttentionPostures: sla?.attentionPostures,
            }),
          )
        : [],
    [incidents, capabilities, viewerUserId, operatorLabels, now, sla],
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
    filters.sla === "BREACHED"
      ? "slaBreached"
      : filters.sla === "AT_RISK"
        ? "slaAtRisk"
        : filters.status === "RESOLVED"
          ? "resolved"
          : filters.severity === "CRITICAL" && filters.status === "OPEN"
      ? "critical"
      : filters.severity === "HIGH" && filters.status === "OPEN"
        ? "high"
        : filters.severity === "WARNING" && filters.status === "OPEN"
          ? "warning"
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
      if (key === "slaBreached") applyFilters({ ...base, sla: "BREACHED" });
      else if (key === "slaAtRisk") applyFilters({ ...base, sla: "AT_RISK" });
      else if (key === "critical") applyFilters({ ...base, severity: "CRITICAL" });
      else if (key === "high") applyFilters({ ...base, severity: "HIGH" });
      else if (key === "warning") applyFilters({ ...base, severity: "WARNING" });
      // RESOLVED is a STATUS, not an SLA posture — and the default view is
      // unresolved work, so the card has to move the status axis or it filters
      // to nothing. Same `applyFilters`, same URL, same reset semantics as
      // every other card.
      else if (key === "resolved") applyFilters({ ...base, status: "RESOLVED" });
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
   * WORKSPACE-SCOPE CONVERGENCE (§8/§16) — the reconciliation facts.
   *
   * Read from the summary rather than derived here. The server owns the
   * decision about whether this workspace may be described as clear; the page
   * renders that decision and does not re-compute it, because a second
   * predicate is a second answer.
   */
  const readiness = summary.kind === "ready" ? summary.data.readiness : undefined;
  const reconciliation =
    summary.kind === "ready" ? (summary.data.reconciliation ?? null) : null;
  const serverPermitsClear =
    summary.kind === "ready" ? summary.data.mayAssertAllClear : false;

  /**
   * Is a PARTIAL run worth re-running?
   *
   * Only if EVERY recorded failure is retryable. One source that failed on a
   * deployment/schema disagreement makes the whole run un-fixable by pressing
   * a button, and offering the button anyway teaches operators that the
   * button does nothing.
   *
   * The default when a run carries no recorded reasons — which is every run
   * written by an image older than this one — is `true`: an unknown cause is
   * not evidence that a retry is pointless, and withholding the control on a
   * guess is worse than offering one that may not help.
   */
  const partialIsRetryable =
    (reconciliation?.sources.sourceFailures ?? []).length === 0 ||
    (reconciliation?.sources.sourceFailures ?? []).every((f) => f.retryable);

  /**
   * The all-clear predicate, stated once.
   *
   * FIVE things must be true now. The first four are unchanged: the read
   * succeeded, it reached the end of the collection, the result is empty, and
   * nothing was filtering it.
   *
   * The fifth is the correction. Those four are all satisfied by a workspace
   * NOTHING HAS EVER SCANNED — an empty incident table read completely is
   * exactly what "never examined" looks like from here. The server's
   * `mayAssertAllClear` additionally requires a fresh READY discovery run with
   * every required source succeeded and nothing truncated, which is the only
   * evidence that "no conditions" means anything at all.
   */
  const mayAssertClear =
    incidents.kind === "ready" &&
    complete &&
    rows.length === 0 &&
    !anyFilterActive(filters) &&
    serverPermitsClear;

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

      {/*
        WORKSPACE-SCOPE CONVERGENCE (§16) — the reconciliation banner.

        One notice at most, chosen by the run's own state. Ordered by how
        badly the state undermines the numbers below it: a failed or stalled
        check makes them stale, a partial one makes them a floor, and a stale
        one makes them old but complete.
      */}
      {readiness === "FAILED" ? (
        <ReconciliationFailedNotice
          category={reconciliation?.safeFailureCategory ?? null}
          onRetry={checkAgain}
        />
      ) : readiness === "STALLED" ? (
        <ReconciliationStalledNotice onRetry={checkAgain} />
      ) : readiness === "PARTIAL" ? (
        <PartialCoverageNotice
          failedCount={reconciliation?.sources.failedSources.length ?? 0}
          truncatedCount={reconciliation?.sources.truncatedSources.length ?? 0}
          onRetry={checkAgain}
          retryable={partialIsRetryable}
        />
      ) : readiness === "STALE" ? (
        <ReconciliationStaleNotice
          completedAtUtc={reconciliation?.completedAtUtc ?? null}
          onRetry={checkAgain}
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
            // Nothing to name until something is filtered. "Save this view"
            // over the default queue would save the default queue.
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
            /*
              THE COUNT DESCRIBES THE SURFACE THAT IS ON SCREEN.

              It used to read `${rows.length} conditions` unconditionally —
              the FLAT list's length — so a grouped queue of five rows was
              captioned "38 conditions" and nothing said the two numbers were
              about different things. Grouped mode states both, in the order
              the eye needs them: how many rows are below, and how many
              conditions those rows account for.
            */
            resultSummary={
              grouped
                ? `${(groupTotals?.groups ?? groups.length).toLocaleString("en-US")} ${
                    (groupTotals?.groups ?? groups.length) === 1
                      ? "group"
                      : "groups"
                  } · ${(groupTotals?.conditions ?? 0).toLocaleString("en-US")} ${
                    (groupTotals?.conditions ?? 0) === 1
                      ? "condition"
                      : "conditions"
                  }`
                : rows.length === 1
                  ? "1 condition"
                  : `${rows.length}${nextCursor ? "+" : ""} conditions`
            }
          />

          {/*
            GROUPED / ALL CONDITIONS.

            One control, not a plan fork. Grouping is the default because a
            long queue of identical rows is unreadable; the flat list is
            still here because a grouped view that could not be left would
            have HIDDEN the individual conditions, which is the defect the
            per-record fingerprints exist to prevent.
          */}
          <div className="opsw-view-toggle" data-ops-view-toggle>
            <button
              type="button"
              className={grouped ? "app-primary-action" : "app-secondary-action"}
              aria-pressed={grouped}
              onClick={() => {
                setGrouped(true);
                setOpenId(null);
              }}
              data-ops-view="grouped"
            >
              Grouped
            </button>
            <button
              type="button"
              className={grouped ? "app-secondary-action" : "app-primary-action"}
              aria-pressed={!grouped}
              onClick={() => {
                setGrouped(false);
                setOpenGroupKey(null);
              }}
              data-ops-view="flat"
            >
              All conditions
            </button>
          </div>

          <BulkToolbar
            count={markedIds.size}
            capabilities={capabilities}
            busy={busy}
            onAcknowledge={() => void runBulk("BULK_ACKNOWLEDGE_INCIDENTS")}
            onSuppress={() => void runBulk("BULK_SUPPRESS_INCIDENTS")}
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

          {/*
            EMPTINESS IS DECIDED BY THE SURFACE BEING SHOWN.

            `rows` is the FLAT list. Reading it in grouped mode would let a
            grouped queue render an empty state over real groups whenever the
            two reads disagreed — a bounded flat page that returned nothing
            while the grouped read returned two sources would have shown
            "Workspace operations are clear" over five thousand conditions,
            which is the exact class of false all-clear this programme exists
            to remove.
          */}
          {grouped && groupsLoading && groups.length === 0 ? (
            // LOADING IS NOT EMPTY.
            //
            // Without this the first paint of a grouped queue renders the
            // empty branch — and when the workspace is otherwise clear, that
            // branch is "Workspace operations are clear". A false all-clear
            // that lasts one frame is still a false all-clear, and it is the
            // one this whole programme exists to remove.
            <PreparingState />
          ) : (grouped ? groups.length : rows.length) === 0 ? (
            mayAssertClear ? (
              <ClearState />
            ) : readiness === "NEVER_RUN" && !anyFilterActive(filters) ? (
              // Nothing has scanned this workspace. "No conditions" is not a
              // finding yet, and NoMatchState would be wrong too — there are
              // no filters to widen.
              <PreparingState />
            ) : (
              <NoMatchState onClear={clearFilters} />
            )
          ) : grouped ? (
            // THE DEFAULT. One row per source rather than one per record: a
            // workspace with five thousand failed timestamps had five thousand
            // identical rows and nowhere to look. Every workspace kind renders
            // this — a group of one shows its own condition's title and reads
            // exactly like the row it replaces.
            <GroupSurface
              groups={groups}
              openGroupKey={openGroupKey}
              onOpen={setOpenGroupKey}
            />
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

      <StepUpModal control={stepUp} />

      {openGroup ? (
        <GroupInspector
          group={openGroup}
          records={affected}
          loading={affectedLoading}
          error={affectedError}
          hasMore={affectedHasMore}
          onLoadMore={() =>
            openGroupKey ? loadAffected(openGroupKey, affectedCursor) : undefined
          }
          onClose={() => setOpenGroupKey(null)}
          // Server-projected capability: a link the reader cannot follow is
          // withheld rather than rendered and refused.
          // Reaching this page already required `operations.view`, which is
          // what the shell gates the incident read on. The link goes to the
          // Evidence detail page, which enforces its own read on arrival — so
          // this offers it to a reader who is already an authorized operator
          // of this workspace and lets the destination be the authority.
          canOpenRecords
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
          onClose={() => setOpenId(null)}
          onAcknowledge={() => void runTransition(openRow.id, "ack")}
          onResolve={() => void runTransition(openRow.id, "resolve")}
          onSuppress={() => void runTransition(openRow.id, "suppress")}
          onAssign={(userId) => void assign(openRow.id, userId)}
          remediation={remediation}
          remediationBusy={remediationBusy}
          remediationOutcome={remediationOutcome}
          onRemediate={(actionId) => void remediate(actionId)}
        />
      ) : null}
    </PageShell>
  );
}
