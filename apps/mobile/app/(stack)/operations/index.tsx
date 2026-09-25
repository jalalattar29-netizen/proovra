/**
 * OPERATIONS (T-11 / RC-12) — the native port of `apps/web/app/(app)/operations/page.tsx`.
 *
 * Every decision (gate, eligibility, filters, copy, bulk arithmetic) lives in
 * `src/product/ops-console.ts`; the row/notice primitives live in
 * `src/ui/ops-surfaces.tsx`; this file wires them to the API and draws them.
 * Touch adaptations, and only these: the web's listboxes are chip rows; the
 * side inspector is a bottom sheet; the row menu is an "Actions" button that
 * opens a sheet; the web's narrow-width CARD rendering of a row is the row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch, apiFetchText } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { describeDuration, describeRelativeTime } from "../../../src/lib/relative-time";
import { usePlatformContext } from "../../../src/product/platform-context";
import {
  AFFECTED_MORE_LABEL,
  CATEGORY_LABEL,
  DEFAULT_FILTERS,
  LOAD_MORE_LABEL,
  OPS_BULK_PATH,
  OPS_RECONCILE_PATH,
  OPS_SAVED_VIEWS_PATH,
  QUEUE_METRICS,
  QUEUE_OVERLAP_NOTE,
  RECONCILE_MAX_POLLS,
  REFUSAL_NOTICE,
  RESTRICTED_BODY,
  RESTRICTED_TITLE,
  SEVERITIES,
  SEVERITY_VOCABULARY,
  SLA_FILTER_OPTIONS,
  SORT_LABEL,
  SOURCE_FALLBACK,
  STATE_COPY,
  STATUSES,
  STATUS_VOCABULARY,
  affectedFor,
  anyFilterActive,
  bulkBody,
  canViewWorkspaceHealth,
  categoryLabel,
  filtersForMetric,
  buildOpsAssignPath,
  opsCapabilities,
  buildOpsGroupAffectedPath,
  buildOpsGroupsPath,
  buildOpsIncidentPath,
  buildOpsIncidentsPath,
  buildOpsLifecyclePath,
  buildOpsOperatorsPath,
  buildOpsRemediatePath,
  buildOpsSavedViewPath,
  buildOpsSavedViewsPath,
  buildOpsSummaryPath,
  ownerLabel,
  parseAffected,
  parseGroups,
  parseIncidentDetail,
  parseIncidentsPage,
  parseOperators,
  parseOpsSavedViews,
  parseSummary,
  reconcilePollDelay,
  reconciliationNotice,
  refusalCode,
  remediationMessage,
  resolutionNoteFor,
  resolveOperationsAccess,
  rowActions,
  rowEligibility,
  savedViewFilterBody,
  selectedMetric,
  slaBreachRecord,
  slaExplanation,
  slaLabel,
  subtitleFor,
  summarizeBulk,
  timelineEventLabel,
  viewerUserId,
  type AffectedRecord,
  type BulkActionType,
  type Incident,
  type IncidentDetail,
  type IncidentGroup,
  type LifecycleAction,
  type OpsFilters,
  type OpsSummary,
  type Operator,
  type RemediationAction,
  type RowActionKey,
  type SavedView,
  type SortKey,
} from "../../../src/product/ops-console";
import { theme } from "../../../src/theme/theme";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraConfirmSheet,
  ProovraDetailRows,
  ProovraEmpty,
  ProovraFilterChips,
  ProovraFilterSearch,
  ProovraInput,
  ProovraKpiGrid,
  ProovraListRow,
  ProovraLoadingState,
  ProovraPageHeader,
  ProovraScreen,
  ProovraSection,
  ProovraSheet,
  ProovraSupportReference,
  ProovraText,
} from "../../../src/ui";
import { ChallengeStepUpSheet, useChallengeStepUp } from "../../../src/ui/challenge-step-up";
import {
  OpsGroupCard,
  OpsIdentifier,
  OpsIncidentCard,
  OpsNotice,
  OpsSeverityCapsule,
} from "../../../src/ui/ops-surfaces";

type Phase = "loading" | "ready" | "failed";
/** A safe, operator-facing failure and the reference to quote for it. */
type Failure = { title?: string; message: string; reference?: string | null };

function failureOf(err: unknown, message: string): Failure {
  const safe = toSafeUserError(err, { message });
  return { message: safe.message || message, reference: safe.requestId ?? null };
}

export default function OperationsScreen() {
  const router = useRouter();
  const platform = usePlatformContext();
  const envelope = platform.envelope;
  const teamId = platform.context?.activeTeamId ?? null;
  const workspaceName = platform.context?.displayName ?? "this workspace";
  const restricted = platform.loading ? null : resolveOperationsAccess(envelope, teamId);
  const caps = useMemo(() => opsCapabilities(envelope), [envelope]);
  const viewer = viewerUserId(envelope);
  const healthVisible = canViewWorkspaceHealth(envelope);

  const [filters, setFilters] = useState<OpsFilters>(DEFAULT_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [reload, setReload] = useState(0);

  const [summary, setSummary] = useState<OpsSummary | null>(null);
  const [operatorCount, setOperatorCount] = useState(0);
  const [summaryError, setSummaryError] = useState<Failure | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [complete, setComplete] = useState(false);
  const [attention, setAttention] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<Failure | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const [groups, setGroups] = useState<IncidentGroup[]>([]);
  const [groupTotals, setGroupTotals] = useState<{ groups: number; conditions: number } | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const [operators, setOperators] = useState<Operator[]>([]);
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(false);

  const [marked, setMarked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Failure | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; body: string } | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<IncidentGroup | null>(null);

  const loadedOnce = useRef(false);
  const collaborative = operatorCount > 1;
  const stepUp = useChallengeStepUp(teamId);

  // Debounced search (the web's 250 ms).
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === searchText ? f : { ...f, q: searchText })), 250);
    return () => clearTimeout(t);
  }, [searchText]);

  /* ------------------------------------------------------------ reads */

  useEffect(() => {
    if (restricted || !teamId || platform.loading) return;
    let live = true;
    apiFetch(buildOpsSummaryPath(teamId))
      .then((d) => {
        if (!live) return;
        const parsed = parseSummary(d);
        setSummary(parsed.summary);
        setOperatorCount(parsed.operatorCount);
        setSummaryError(null);
      })
      .catch((err) => {
        if (!live) return;
        // P:639 — a failed summary hides the cards (P:1675) and says so above them.
        setSummary(null);
        setSummaryError(failureOf(err, SOURCE_FALLBACK.summary));
      });
    return () => {
      live = false;
    };
  }, [teamId, restricted, platform.loading, reload]);

  useEffect(() => {
    if (restricted || !teamId || platform.loading) return;
    let live = true;
    // P:618-619 — a re-read over content already on screen is "Refreshing…".
    if (loadedOnce.current) setRefreshing(true);
    setPhase((p) => (p === "ready" ? "ready" : "loading"));
    apiFetch(buildOpsIncidentsPath(teamId, filters))
      .then((d) => {
        if (!live) return;
        const page = parseIncidentsPage(d);
        setIncidents(page.incidents);
        setComplete(page.complete);
        setAttention(page.attentionPostures);
        setNextCursor(page.nextCursor);
        setMoreError(null);
        setLoadError(null);
        setLastLoadedAt(new Date().toISOString());
        loadedOnce.current = true;
        setPhase("ready");
      })
      .catch((err) => {
        if (!live) return;
        setLoadError(failureOf(err, SOURCE_FALLBACK.incidents));
        setPhase("failed");
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
    };
  }, [teamId, restricted, platform.loading, filters, reload]);

  useEffect(() => {
    if (restricted || !teamId || platform.loading || !grouped) return;
    let live = true;
    setGroupsLoading(true);
    apiFetch(buildOpsGroupsPath(teamId, filters))
      .then((d) => {
        if (!live) return;
        const g = parseGroups(d);
        setGroups(g.groups);
        setGroupTotals({ groups: g.totalGroups, conditions: g.totalConditions });
        setGroupsFailed(false);
      })
      .catch(() => {
        // Spec §8: the web swallows this and renders "no match" over real
        // conditions. Native says the grouped read failed.
        if (!live) return;
        setGroups([]);
        setGroupTotals(null);
        setGroupsFailed(true);
      })
      .finally(() => {
        if (live) setGroupsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [teamId, restricted, platform.loading, filters, grouped, reload]);

  useEffect(() => {
    if (restricted || !teamId || platform.loading || !caps.assign) return;
    apiFetch(buildOpsOperatorsPath(teamId))
      .then((d) => {
        const o = parseOperators(d);
        setOperators(o.operators);
        setSelfUserId(o.selfUserId);
      })
      .catch(() => setOperators([]));
  }, [teamId, restricted, platform.loading, caps.assign]);

  const loadViews = useCallback(() => {
    if (!teamId) return;
    setViewsLoading(true);
    apiFetch(buildOpsSavedViewsPath(teamId))
      .then((d) => setViews(parseOpsSavedViews(d, viewer)))
      .catch(() => setViews([]))
      .finally(() => setViewsLoading(false));
  }, [teamId, viewer]);
  useEffect(() => {
    if (!restricted && teamId && !platform.loading) loadViews();
  }, [restricted, teamId, platform.loading, loadViews]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    if (!teamId || !nextCursor || moreBusy) return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = parseIncidentsPage(await apiFetch(buildOpsIncidentsPath(teamId, filters, nextCursor)));
      setIncidents((prev) => [...prev, ...page.incidents]);
      setComplete(page.complete);
      setNextCursor(page.nextCursor);
    } catch (err) {
      // P:919 — reported beside the control; the cursor is kept so a retry resumes.
      setMoreError(failureOf(err, STATE_COPY.loadMoreFailed).message);
    } finally {
      setMoreBusy(false);
    }
  }, [teamId, filters, nextCursor, moreBusy]);

  /* ------------------------------------------------------------ reconcile */

  const reconcileStarted = useRef<string | null>(null);
  const checkingRef = useRef(false);
  const checkAgain = useCallback(async () => {
    if (!teamId || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setNotice(null);
    try {
      const res = (await apiFetch(OPS_RECONCILE_PATH, { method: "POST", body: JSON.stringify({ teamId }) })) as {
        refusedReason?: string | null;
        retryable?: boolean;
      };
      if (res?.refusedReason) {
        setNotice(
          res.retryable === false
            ? { title: STATE_COPY.checkRefusedTitle, message: STATE_COPY.checkRefusedBody }
            : { title: STATE_COPY.checkNotStartedTitle, message: STATE_COPY.checkNotStartedBody },
        );
      } else {
        for (let n = 0; n < RECONCILE_MAX_POLLS; n += 1) {
          await new Promise((r) => setTimeout(r, reconcilePollDelay(n)));
          const parsed = parseSummary(await apiFetch(buildOpsSummaryPath(teamId)));
          setSummary(parsed.summary);
          if (parsed.summary.readiness !== "RUNNING") break;
        }
      }
    } catch (err) {
      // The web shows generic copy for a 503 schema_mismatch; the body says
      // exactly why, so native reads it (spec §4).
      const body = (err as { body?: { refusedReason?: string } })?.body;
      setNotice(
        body?.refusedReason === "schema_mismatch"
          ? { title: STATE_COPY.checkRefusedTitle, message: STATE_COPY.checkRefusedBody }
          : failureOf(err, STATE_COPY.checkThrew),
      );
    } finally {
      checkingRef.current = false;
      setChecking(false);
      refresh();
    }
  }, [teamId, refresh]);

  // A workspace that has never been checked is checked once, automatically (P:1021-1029).
  useEffect(() => {
    if (summary?.readiness === "NEVER_RUN" && teamId && reconcileStarted.current !== teamId) {
      reconcileStarted.current = teamId;
      void checkAgain();
    }
  }, [summary?.readiness, teamId, checkAgain]);

  /* ------------------------------------------------------------ mutations */

  const lifecycle = useCallback(
    async (id: string, action: LifecycleAction) => {
      if (!teamId || busy) return;
      setBusy(true);
      setPendingId(id);
      setNotice(null);
      try {
        await apiFetch(buildOpsLifecyclePath(id, action), { method: "POST", body: JSON.stringify({ teamId }) });
      } catch (err) {
        const code = refusalCode(err);
        if (code) setRefusal(REFUSAL_NOTICE[code]!);
        else setNotice(failureOf(err, STATE_COPY.actionFailed));
      } finally {
        setBusy(false);
        setPendingId(null);
        refresh();
      }
    },
    [teamId, busy, refresh],
  );

  const assign = useCallback(
    async (id: string, assigneeUserId: string | null) => {
      if (!teamId || busy) return;
      setBusy(true);
      setPendingId(id);
      setNotice(null);
      try {
        await apiFetch(buildOpsAssignPath(id), { method: "POST", body: JSON.stringify({ teamId, assigneeUserId }) });
        refresh();
      } catch (err) {
        setNotice(failureOf(err, STATE_COPY.assignFailed));
      } finally {
        setBusy(false);
        setPendingId(null);
      }
    },
    [teamId, busy, refresh],
  );

  const runBulk = useCallback(
    async (actionType: BulkActionType, assigneeUserId?: string) => {
      if (!teamId || marked.length === 0 || busy) return;
      const targets = [...marked];
      setBusy(true);
      setNotice(null);
      setBulkOutcome(null);
      try {
        const res = await stepUp.run((headers) =>
          apiFetch(OPS_BULK_PATH, { method: "POST", headers, body: JSON.stringify(bulkBody(teamId, actionType, targets, assigneeUserId)) }),
        );
        const outcome = summarizeBulk(res, targets);
        setMarked(outcome.stillSelected);
        setBulkOutcome(outcome.message);
      } catch (err) {
        // P:1315-1322: a cancelled challenge is an outcome; anything else is a failure banner.
        if ((err as { code?: string })?.code === "STEP_UP_CANCEL") setBulkOutcome(STATE_COPY.bulkCancelled);
        else setNotice(failureOf(err, STATE_COPY.bulkFailed));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [teamId, marked, busy, stepUp, refresh],
  );

  const onRowAction = useCallback(
    (id: string, key: RowActionKey) => {
      // C/IncidentSurface.tsx: "Change owner" opens the inspector, where ownership lives.
      if (key === "open" || key === "assign") setOpenId(id);
      else if (key === "acknowledge") void lifecycle(id, "ack");
      else if (key === "resolve") void lifecycle(id, "resolve");
      else void lifecycle(id, "suppress");
    },
    [lifecycle],
  );

  /* ------------------------------------------------------------ render */

  const busyHeader = refreshing || checking;
  const header = (
    <ProovraPageHeader
      title="Operations"
      subtitle={subtitleFor(caps)}
      contextStrip={
        restricted ? undefined : (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Conditions in ${workspaceName}${lastLoadedAt ? ` · Updated ${formatUserDateTime(lastLoadedAt)}` : ""}`}
          </ProovraText>
        )
      }
      secondaryActions={
        !restricted && healthVisible ? (
          <ProovraButton label="Workspace health" variant="ghost" fullWidth={false} onPress={() => router.push("/operations/health")} />
        ) : undefined
      }
      primaryAction={
        restricted ? undefined : (
          <ProovraButton
            label={busyHeader ? "Refreshing…" : "Refresh"}
            variant="secondary"
            fullWidth={false}
            disabled={busyHeader}
            onPress={refresh}
            testID="ops-refresh"
          />
        )
      }
    />
  );

  if (restricted) {
    return (
      <ProovraScreen shell testID="operations">
        {header}
        <ProovraEmpty title={RESTRICTED_TITLE} purpose={RESTRICTED_BODY[restricted]} />
      </ProovraScreen>
    );
  }

  const reconciliation = reconciliationNotice(summary);
  const active = anyFilterActive(filters);
  const selected = selectedMetric(filters);
  const selectable = caps.acknowledge || caps.suppress;
  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setSearchText("");
  };
  // P:1546-1551 — the server's permission plus a complete, unfiltered, empty read.
  const mayAssertClear = phase === "ready" && complete && incidents.length === 0 && !active && summary?.mayAssertAllClear === true;
  // P:1808 — EMPTINESS IS DECIDED BY THE SURFACE BEING SHOWN.
  const surfaceEmpty = grouped ? groups.length === 0 : incidents.length === 0;
  const openRow = openId ? (incidents.find((x) => x.id === openId) ?? null) : null;

  const emptyState = mayAssertClear ? (
    <ProovraEmpty
      title={STATE_COPY.clearTitle}
      purpose={STATE_COPY.clearBody}
      action={
        <View style={{ gap: theme.space.s2 }}>
          <ProovraButton label="Evidence library" variant="secondary" onPress={() => router.push("/evidence")} />
          <ProovraButton label="Workspace overview" variant="ghost" onPress={() => router.push("/")} />
        </View>
      }
    />
  ) : summary?.readiness === "NEVER_RUN" && !active ? (
    <ProovraEmpty title={STATE_COPY.preparingTitle} purpose={STATE_COPY.preparingBody} />
  ) : (
    <ProovraEmpty
      title={STATE_COPY.noMatchTitle}
      purpose={STATE_COPY.noMatchBody}
      action={<ProovraButton label="Clear filters" onPress={clearFilters} />}
    />
  );

  let queue: React.ReactNode;
  if (grouped && groupsFailed) {
    queue = (
      <ProovraEmpty
        title={STATE_COPY.unavailableTitle}
        purpose={STATE_COPY.groupsFailed}
        action={<ProovraButton label="Try again" variant="secondary" onPress={refresh} />}
      />
    );
  } else if (grouped && groupsLoading && groups.length === 0) {
    // LOADING IS NOT EMPTY (P:1799-1807): never an all-clear for one frame.
    queue = <ProovraLoadingState label={STATE_COPY.loading} />;
  } else if (surfaceEmpty) {
    queue = phase === "ready" ? emptyState : null;
  } else if (grouped) {
    queue = (
      <View style={{ gap: theme.space.s2 }} testID="ops-groups">
        {groups.map((g) => (
          <OpsGroupCard key={g.groupKey} group={g} onOpen={() => setOpenGroup(g)} />
        ))}
      </View>
    );
  } else {
    queue = (
      <View style={{ gap: theme.space.s2 }} testID="ops-incidents">
        {incidents.map((i) => (
          <OpsIncidentCard
            key={i.id}
            incident={i}
            owner={collaborative ? ownerLabel(i, viewer, operators) : null}
            attention={i.sla !== null && attention.includes(i.sla.posture)}
            selectable={selectable}
            marked={marked.includes(i.id)}
            actions={rowActions(i, caps)}
            pending={pendingId === i.id}
            onToggle={() => setMarked((m) => (m.includes(i.id) ? m.filter((x) => x !== i.id) : [...m, i.id]))}
            onOpen={() => setOpenId(i.id)}
            onAction={(key) => onRowAction(i.id, key)}
          />
        ))}
      </View>
    );
  }

  return (
    <ProovraScreen shell testID="operations">
      {header}

      {notice ? (
        <OpsNotice
          tone="danger"
          title={notice.title}
          text={notice.message}
          reference={notice.reference}
          actions={[{ label: "Dismiss", variant: "ghost", onPress: () => setNotice(null) }]}
          testID="ops-mutation-error"
        />
      ) : null}
      {summaryError ? (
        <OpsNotice
          tone="warn"
          title="The queue summary could not be loaded."
          text={`${summaryError.message} ${STATE_COPY.degradedTail}`}
          reference={summaryError.reference}
          actions={[{ label: "Retry", onPress: refresh }]}
          testID="ops-degraded-summary"
        />
      ) : null}
      <ReconciliationBanner notice={reconciliation} onCheckAgain={() => void checkAgain()} />

      {phase === "loading" && incidents.length === 0 ? <ProovraLoadingState label={STATE_COPY.loading} /> : null}

      {phase === "failed" ? (
        <ProovraEmpty
          title={STATE_COPY.unavailableTitle}
          purpose={loadError?.message ?? STATE_COPY.unavailableFallback}
          action={
            <View style={{ gap: theme.space.s2 }}>
              <ProovraSupportReference reference={loadError?.reference} />
              <ProovraButton label="Try again" onPress={refresh} />
            </View>
          }
        />
      ) : null}

      {phase === "ready" ? (
        <>
          {refreshing ? (
            <ProovraText variant="label" color={theme.color.ink.muted} testID="ops-refreshing">
              Refreshing…
            </ProovraText>
          ) : null}

          {summary ? (
            <ProovraSection title="Queue summary">
              <ProovraKpiGrid
                items={QUEUE_METRICS.filter((m) => !m.collaborativeOnly || collaborative).map((m) => {
                  const v = summary.counts[m.key];
                  return {
                    key: m.key,
                    label: m.label,
                    value: typeof v === "number" ? String(v) : "—",
                    caption: m.note,
                    tone: m.tone,
                    selected: selected === m.key,
                    onPress: () => {
                      setFilters(selected === m.key ? DEFAULT_FILTERS : filtersForMetric(m.key));
                      setSearchText("");
                      setMarked([]);
                    },
                  };
                })}
              />
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {QUEUE_OVERLAP_NOTE}
              </ProovraText>
            </ProovraSection>
          ) : null}

          <SavedViewsStrip
            teamId={teamId}
            views={views}
            loading={viewsLoading}
            filters={filters}
            canManageShared={caps.manageSharedViews}
            pageBusy={busy}
            onApply={(v) => {
              setFilters(v.filter);
              setSearchText(v.filter.q);
            }}
            onChanged={loadViews}
          />

          <ProovraSection title="Filters">
            <ProovraFilterSearch value={searchText} onChange={setSearchText} placeholder="Search conditions" testID="ops-search" />
            <ProovraFilterChips
              label="Status"
              value={filters.status}
              disabled={busy}
              onChange={(status) => setFilters((f) => ({ ...f, status }))}
              options={[{ value: "", label: "Any status" }, ...STATUSES.map((s) => ({ value: s as string, label: STATUS_VOCABULARY[s].label }))]}
            />
            <ProovraFilterChips
              label="Severity"
              value={filters.severity}
              disabled={busy}
              onChange={(severity) => setFilters((f) => ({ ...f, severity }))}
              options={[{ value: "", label: "Any severity" }, ...SEVERITIES.map((s) => ({ value: s as string, label: SEVERITY_VOCABULARY[s].label }))]}
            />
            <ProovraFilterChips
              label="Source"
              value={filters.category}
              disabled={busy}
              onChange={(category) => setFilters((f) => ({ ...f, category }))}
              options={[{ value: "", label: "Any source" }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))]}
            />
            {collaborative ? (
              <ProovraFilterChips
                label="Owner"
                value={filters.owner}
                disabled={busy}
                onChange={(owner) => setFilters((f) => ({ ...f, owner }))}
                options={[
                  { value: "any", label: "Anyone" },
                  { value: "me", label: "Assigned to me" },
                  { value: "unassigned", label: "Unassigned" },
                  ...operators.map((o) => ({ value: o.userId, label: o.label })),
                ]}
              />
            ) : null}
            <ProovraFilterChips
              label="Sort"
              value={filters.sort}
              disabled={busy}
              onChange={(sort) => setFilters((f) => ({ ...f, sort: sort as SortKey }))}
              options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ value: k, label: SORT_LABEL[k] }))}
            />
            <ProovraFilterChips
              label="Time commitment"
              value={filters.sla}
              disabled={busy}
              onChange={(sla) => setFilters((f) => ({ ...f, sla }))}
              options={SLA_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="ops-result-summary">
                {grouped
                  ? `${(groupTotals?.groups ?? groups.length).toLocaleString("en-US")} ${(groupTotals?.groups ?? groups.length) === 1 ? "group" : "groups"} · ${(
                      groupTotals?.conditions ?? 0
                    ).toLocaleString("en-US")} ${(groupTotals?.conditions ?? 0) === 1 ? "condition" : "conditions"}`
                  : incidents.length === 1
                    ? "1 condition"
                    : `${incidents.length}${nextCursor ? "+" : ""} conditions`}
              </ProovraText>
              {active ? <ProovraButton label="Clear filters" variant="ghost" fullWidth={false} onPress={clearFilters} /> : null}
            </View>
            <ProovraFilterChips
              label="View"
              value={grouped ? "grouped" : "all"}
              onChange={(v) => {
                setGrouped(v === "grouped");
                setOpenGroup(null);
                setOpenId(null);
              }}
              options={[
                { value: "grouped", label: "Grouped" },
                { value: "all", label: "All conditions" },
              ]}
            />
          </ProovraSection>

          {marked.length > 0 ? (
            <BulkToolbar
              count={marked.length}
              caps={caps}
              collaborative={collaborative}
              operators={operators}
              selfUserId={selfUserId}
              busy={busy}
              outcome={bulkOutcome}
              onAcknowledge={() => void runBulk("BULK_ACKNOWLEDGE_INCIDENTS")}
              onSuppress={() => void runBulk("BULK_SUPPRESS_INCIDENTS")}
              onAssign={(userId) => void runBulk("BULK_ASSIGN_INCIDENTS", userId)}
              onClear={() => {
                setMarked([]);
                setBulkOutcome(null);
              }}
            />
          ) : bulkOutcome ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="ops-bulk-outcome">
              {bulkOutcome}
            </ProovraText>
          ) : null}

          {queue}

          {!grouped && nextCursor ? (
            <View style={{ gap: theme.space.s2, alignItems: "center" }}>
              <ProovraButton
                label={moreBusy ? "Loading…" : LOAD_MORE_LABEL}
                variant="secondary"
                fullWidth={false}
                disabled={moreBusy}
                onPress={() => void loadMore()}
                testID="ops-load-more"
              />
              {moreError ? (
                <ProovraText variant="label" color={theme.color.status.risk.fg}>
                  {moreError}
                </ProovraText>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}

      {openId && teamId ? (
        <IncidentInspector
          teamId={teamId}
          id={openId}
          row={openRow}
          caps={caps}
          collaborative={collaborative}
          viewer={viewer}
          operators={operators}
          selfUserId={selfUserId}
          busy={busy}
          reloadToken={reload}
          onClose={() => setOpenId(null)}
          onLifecycle={(action) => void lifecycle(openId, action)}
          onAssign={(userId) => void assign(openId, userId)}
          onChanged={refresh}
        />
      ) : null}
      {openGroup && teamId ? <GroupInspector teamId={teamId} group={openGroup} onClose={() => setOpenGroup(null)} /> : null}

      <ProovraConfirmSheet
        visible={refusal !== null}
        title={refusal?.title ?? ""}
        consequence={refusal?.body}
        confirmLabel="Close"
        tone="warning"
        onConfirm={() => setRefusal(null)}
        onCancel={() => setRefusal(null)}
      />
      <ChallengeStepUpSheet stepUp={stepUp} />
    </ProovraScreen>
  );
}

/* ================================================================ pieces */

function ReconciliationBanner({ notice, onCheckAgain }: { notice: ReturnType<typeof reconciliationNotice>; onCheckAgain: () => void }) {
  if (!notice) return null;
  if (notice.kind === "running") {
    return (
      <ProovraText variant="label" color={theme.color.ink.muted} testID="ops-reconciling">
        {STATE_COPY.reconciling}
      </ProovraText>
    );
  }
  if (notice.kind === "stalled") {
    return (
      <OpsNotice tone="warn" title={STATE_COPY.stalledTitle} text={STATE_COPY.stalledBody} actions={[{ label: "Check again", onPress: onCheckAgain }]} />
    );
  }
  if (notice.kind === "failed") {
    return (
      <OpsNotice tone="danger" text={notice.message} actions={notice.canRetry ? [{ label: "Try again", onPress: onCheckAgain }] : undefined} />
    );
  }
  return (
    <OpsNotice
      tone="warn"
      title={notice.heading}
      text={`${STATE_COPY.partialTail}${notice.retryable ? "" : ` ${STATE_COPY.partialNotRetryable}`}`}
      actions={notice.retryable ? [{ label: "Check again", onPress: onCheckAgain }] : undefined}
    />
  );
}

function BulkToolbar({
  count,
  caps,
  collaborative,
  operators,
  selfUserId,
  busy,
  outcome,
  onAcknowledge,
  onSuppress,
  onAssign,
  onClear,
}: {
  count: number;
  caps: ReturnType<typeof opsCapabilities>;
  collaborative: boolean;
  operators: Operator[];
  selfUserId: string | null;
  busy: boolean;
  outcome: string | null;
  onAcknowledge: () => void;
  onSuppress: () => void;
  onAssign: (userId: string) => void;
  onClear: () => void;
}) {
  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s2 }} testID="ops-bulk-toolbar">
        <ProovraText variant="bodySm" weight="semibold">
          {count === 1 ? "1 condition selected" : `${count} conditions selected`}
        </ProovraText>
        {caps.acknowledge ? <ProovraButton label="Acknowledge" variant="secondary" disabled={busy} onPress={onAcknowledge} /> : null}
        {caps.suppress ? <ProovraButton label="Stop notifying" variant="danger" disabled={busy} onPress={onSuppress} /> : null}
        {collaborative && caps.assign && operators.length > 0 ? (
          <ProovraFilterChips
            label="Assign to…"
            value=""
            disabled={busy}
            onChange={(v) => v && onAssign(v)}
            options={[
              ...(selfUserId ? [{ value: selfUserId, label: "Me" }] : []),
              ...operators.filter((o) => o.userId !== selfUserId).map((o) => ({ value: o.userId, label: o.label })),
            ]}
          />
        ) : null}
        <ProovraButton label="Clear selection" variant="ghost" onPress={onClear} />
        {outcome ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="ops-bulk-outcome">
            {outcome}
          </ProovraText>
        ) : null}
      </View>
    </ProovraCard>
  );
}

function SavedViewsStrip({
  teamId,
  views,
  loading,
  filters,
  canManageShared,
  pageBusy,
  onApply,
  onChanged,
}: {
  teamId: string | null;
  views: SavedView[];
  loading: boolean;
  filters: OpsFilters;
  canManageShared: boolean;
  pageBusy: boolean;
  onApply: (v: SavedView) => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<{ mode: "create" } | { mode: "rename"; view: SavedView } | null>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const [busy, setBusy] = useState(false);
  const canSave = anyFilterActive(filters);
  if (!loading && views.length === 0 && !canSave && !form) return null;

  const canManage = (v: SavedView) => (v.visibility === "TEAM" ? canManageShared : v.ownedByViewer);
  const locked = busy || pageBusy;

  const submit = async () => {
    if (!teamId || !form || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (form.mode === "create") {
        await apiFetch(OPS_SAVED_VIEWS_PATH, {
          method: "POST",
          body: JSON.stringify({ teamId, name: name.trim(), visibility: shared ? "TEAM" : "PRIVATE", filter: savedViewFilterBody(teamId, filters) }),
        });
      } else {
        await apiFetch(buildOpsSavedViewPath(form.view.id), {
          method: "PATCH",
          body: JSON.stringify({ teamId, expectedUpdatedAt: form.view.updatedAt, name: name.trim() }),
        });
      }
      setForm(null);
      setName("");
    } catch (err) {
      setError(toSafeUserError(err, { message: form.mode === "create" ? STATE_COPY.viewSaveFailed : STATE_COPY.viewRenameFailed }).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const remove = async (v: SavedView) => {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      // 204 No Content: read as text, not JSON.
      await apiFetchText(`${buildOpsSavedViewPath(v.id)}?teamId=${encodeURIComponent(teamId)}`, { method: "DELETE" });
    } catch (err) {
      setError(toSafeUserError(err, { message: STATE_COPY.viewDeleteFailed }).message);
    } finally {
      setBusy(false);
      setDeleting(null);
      onChanged();
    }
  };

  return (
    <ProovraSection title="Views">
      {loading ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Loading…
        </ProovraText>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        {views.map((v) => (
          <View key={v.id} style={{ flexDirection: "row", alignItems: "center" }}>
            <ProovraButton
              label={v.visibility === "TEAM" ? `${v.name} · Shared` : v.name}
              variant="secondary"
              fullWidth={false}
              disabled={locked}
              onPress={() => onApply(v)}
            />
            {canManage(v) ? (
              <ProovraButton
                label="Manage"
                accessibilityLabel={`Actions for the view ${v.name}`}
                variant="ghost"
                fullWidth={false}
                onPress={() => setManaging(v)}
              />
            ) : null}
          </View>
        ))}
      </View>
      {canSave && !form ? (
        <ProovraButton
          label="Save this view"
          variant="secondary"
          fullWidth={false}
          disabled={locked}
          onPress={() => {
            setForm({ mode: "create" });
            setName("");
            setShared(false);
          }}
        />
      ) : null}
      {form ? (
        <ProovraCard>
          <ProovraInput
            value={name}
            onChangeText={(t) => setName(t.slice(0, 120))}
            placeholder={form.mode === "create" ? "Name this view" : "Rename this view"}
            accessibilityLabel={form.mode === "create" ? "Name for the saved view" : "New name for the saved view"}
          />
          {form.mode === "create" && canManageShared ? (
            <ProovraFilterChips
              label="Share with this workspace"
              value={shared ? "yes" : "no"}
              onChange={(v) => setShared(v === "yes")}
              options={[
                { value: "no", label: "Only me" },
                { value: "yes", label: "Share with this workspace" },
              ]}
            />
          ) : null}
          <ProovraButton label={form.mode === "create" ? "Save" : "Rename"} disabled={locked || !name.trim()} onPress={() => void submit()} />
          <ProovraButton label="Cancel" variant="ghost" onPress={() => setForm(null)} />
        </ProovraCard>
      ) : null}
      {error ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>
          {error}
        </ProovraText>
      ) : null}
      <ProovraSheet visible={managing !== null} title={managing?.name ?? ""} onClose={() => setManaging(null)}>
        <ProovraButton
          label="Rename view"
          variant="secondary"
          onPress={() => {
            if (managing) {
              setForm({ mode: "rename", view: managing });
              setName(managing.name);
            }
            setManaging(null);
          }}
        />
        <ProovraButton
          label="Delete view"
          variant="danger"
          onPress={() => {
            setDeleting(managing);
            setManaging(null);
          }}
        />
      </ProovraSheet>
      <ProovraConfirmSheet
        visible={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : ""}
        consequence={
          deleting?.visibility === "TEAM"
            ? "This view is shared, so it will disappear for everyone in this workspace. The conditions themselves are not affected."
            : "The conditions themselves are not affected."
        }
        confirmLabel="Delete view"
        tone="danger"
        busy={busy}
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </ProovraSection>
  );
}

/** "<absolute> (<relative>)" — the inspector's instants (C/IncidentInspector.tsx When). */
function when(iso: string): string {
  return `${formatUserDateTime(iso)} (${describeRelativeTime(iso)})`;
}

function IncidentInspector({
  teamId,
  id,
  row,
  caps,
  collaborative,
  viewer,
  operators,
  selfUserId,
  busy,
  reloadToken,
  onClose,
  onLifecycle,
  onAssign,
  onChanged,
}: {
  teamId: string;
  id: string;
  /** The queue's own row — rendered at once, and kept when the history read fails. */
  row: Incident | null;
  caps: ReturnType<typeof opsCapabilities>;
  collaborative: boolean;
  viewer: string | null;
  operators: Operator[];
  selfUserId: string | null;
  busy: boolean;
  reloadToken: number;
  onClose: () => void;
  onLifecycle: (a: LifecycleAction) => void;
  onAssign: (userId: string | null) => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const routerPush = (href: string) => router.push(href as never);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [remBusy, setRemBusy] = useState<string | null>(null);
  const [remOutcome, setRemOutcome] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RemediationAction | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    apiFetch(buildOpsIncidentPath(teamId, id))
      .then((d) => {
        if (!live) return;
        setDetail(parseIncidentDetail(d));
      })
      .catch((err) => {
        if (!live) return;
        setDetail(null);
        setError(failureOf(err, SOURCE_FALLBACK.detail));
      });
    return () => {
      live = false;
    };
  }, [teamId, id, reloadToken]);

  const remediate = async (a: RemediationAction) => {
    setConfirming(null);
    setRemBusy(a.actionId);
    setRemOutcome(null);
    try {
      const res = await apiFetch(buildOpsRemediatePath(id), { method: "POST", body: JSON.stringify({ teamId, actionId: a.actionId }) });
      setRemOutcome(remediationMessage(res) ?? STATE_COPY.remediationQueued);
    } catch (err) {
      // Spec §9: a refused remediation carries the server's own explanation.
      setRemOutcome(remediationMessage(err) ?? toSafeUserError(err, { message: STATE_COPY.remediationFailed }).message);
    } finally {
      setRemBusy(null);
      onChanged();
    }
  };

  // THE ROW FIRST (P:1909-1927 renders the inspector from the row): a failed
  // history never blanks the condition the operator opened.
  const i = detail?.incident ?? row;
  const elig = i ? rowEligibility(i, caps) : null;
  const affected = i ? affectedFor(i) : null;
  const rem = detail?.remediation ?? null;

  return (
    <ProovraSheet visible title={i?.title ?? "Condition"} onClose={onClose}>
      <View style={{ gap: theme.space.s4 }} testID="ops-inspector">
        {!i && !error ? <ProovraLoadingState label="Loading history…" /> : null}
        {!i && error ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
            {`${error.message} The history could not be loaded, so what is shown here is not the full record.`}
          </ProovraText>
        ) : null}
        {i ? (
          <>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap", alignItems: "center" }}>
              <OpsSeverityCapsule label={SEVERITY_VOCABULARY[i.severity].label} tone={SEVERITY_VOCABULARY[i.severity].tone} />
              <ProovraBadge label={STATUS_VOCABULARY[i.status].label} tone={STATUS_VOCABULARY[i.status].tone} />
            </View>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {STATUS_VOCABULARY[i.status].explanation}
            </ProovraText>

            <ProovraSection title="What happened">
              {i.safeSummary ? <ProovraText variant="bodySm">{i.safeSummary}</ProovraText> : null}
              <ProovraDetailRows
                rows={[
                  { label: "Source", value: categoryLabel(i.category) },
                  { label: "Severity", value: `${SEVERITY_VOCABULARY[i.severity].label} — ${SEVERITY_VOCABULARY[i.severity].explanation}` },
                  ...(affected?.label ? [{ label: "Affected record", value: affected.label }] : []),
                ]}
              />
              {affected?.href ? (
                <ProovraButton
                  label="Open record"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => {
                    onClose();
                    routerPush(affected.href!);
                  }}
                />
              ) : null}
            </ProovraSection>

            {rem && (rem.actions.length > 0 || rem.deepLink || rem.guidance || rem.unsafeReason) ? (
              <ProovraSection title="What you can do">
                {rem.guidance ? <ProovraText variant="bodySm">{rem.guidance}</ProovraText> : null}
                {rem.unsafeReason ? (
                  <ProovraText variant="bodySm" color={theme.color.ink.muted}>
                    {rem.unsafeReason}
                  </ProovraText>
                ) : null}
                {rem.actions.map((a) => (
                  <View key={a.actionId} style={{ gap: 4 }}>
                    <ProovraButton
                      label={remBusy === a.actionId ? "Starting…" : a.label}
                      disabled={remBusy !== null || busy}
                      onPress={() => (a.confirm ? setConfirming(a) : void remediate(a))}
                    />
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {`${a.description}${a.async ? STATE_COPY.remediationAsyncHint : ""}`}
                    </ProovraText>
                  </View>
                ))}
                {remOutcome ? (
                  <ProovraText variant="bodySm" testID="ops-remediation-outcome">
                    {remOutcome}
                  </ProovraText>
                ) : null}
                {rem.deepLink ? (
                  <ProovraButton
                    label={rem.deepLink.label}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => {
                      onClose();
                      routerPush(rem.deepLink!.href);
                    }}
                  />
                ) : null}
              </ProovraSection>
            ) : null}

            {i.metric ? (
              <ProovraSection title="How much">
                <ProovraDetailRows
                  rows={[
                    { label: "Affected now", value: `${i.metric.currentValue.toLocaleString("en-US")} ${i.metric.unit}${i.metric.truncated ? " (at least — the read was bounded)" : ""}` },
                    {
                      label: "Threshold",
                      value: `${i.metric.thresholdValue.toLocaleString("en-US")}${i.metric.criticalThresholdValue != null ? ` (critical at ${i.metric.criticalThresholdValue.toLocaleString("en-US")})` : ""}`,
                    },
                    ...(i.metric.previousValue != null
                      ? [
                          {
                            label: "Previous observation",
                            value: `${i.metric.previousValue.toLocaleString("en-US")}${
                              i.metric.delta != null ? ` (${i.metric.delta >= 0 ? "+" : ""}${i.metric.delta.toLocaleString("en-US")})` : ""
                            }`,
                          },
                        ]
                      : []),
                    {
                      label: "Observed",
                      value: `${when(i.metric.observedAtUtc)}${
                        i.metric.stale ? " — the most recent check could not reach this source, so this is the last confirmed value." : ""
                      }`,
                    },
                  ]}
                />
              </ProovraSection>
            ) : null}

            <ProovraSection title="When">
              <ProovraDetailRows
                rows={[
                  { label: "First seen", value: when(i.firstSeenAtUtc) },
                  { label: "Latest occurrence", value: when(i.lastSeenAtUtc) },
                  { label: "Source observations", value: `Observed in ${i.occurrenceCount.toLocaleString("en-US")} checks` },
                  ...(i.sla
                    ? [
                        {
                          label: "Time commitment",
                          value: `${slaLabel(i.sla.posture)}${i.sla.dueAtUtc ? ` — ${i.sla.posture === "RESOLVED" ? "was due" : "due"} ${formatUserDateTime(i.sla.dueAtUtc)}` : ""}. ${slaExplanation(i.sla)}${
                            slaBreachRecord(i.sla) ? ` ${slaBreachRecord(i.sla)}` : ""
                          }`,
                        },
                      ]
                    : []),
                ]}
              />
            </ProovraSection>

            {collaborative ? (
              <ProovraSection title="Ownership">
                {!caps.assign ? (
                  <ProovraText variant="bodySm">{`Owner ${ownerLabel(i, viewer, operators)}`}</ProovraText>
                ) : (
                  <>
                    <ProovraFilterChips
                      label="Owner"
                      value={i.assignedOperatorUserId ?? ""}
                      disabled={busy || !elig?.canAssign}
                      onChange={(v) => onAssign(v || null)}
                      options={[{ value: "", label: "Unassigned" }, ...operators.map((o) => ({ value: o.userId, label: o.label }))]}
                    />
                    {selfUserId && selfUserId !== i.assignedOperatorUserId && elig?.canAssign ? (
                      <ProovraButton label="Take it" variant="secondary" fullWidth={false} disabled={busy} onPress={() => onAssign(selfUserId)} />
                    ) : null}
                    {operators.length === 0 ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {STATE_COPY.noOperators}
                      </ProovraText>
                    ) : null}
                  </>
                )}
              </ProovraSection>
            ) : null}

            <ProovraSection title="History">
              {!detail && !error ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Loading history…
                </ProovraText>
              ) : null}
              {error ? (
                <View style={{ gap: theme.space.s2 }} testID="ops-timeline-error">
                  <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
                    {`${error.message} The history could not be loaded, so what is shown here is not the full record.`}
                  </ProovraText>
                  <ProovraSupportReference reference={error.reference} />
                </View>
              ) : null}
              {detail && detail.timeline.length === 0 ? <ProovraText variant="bodySm">{STATE_COPY.historyEmpty}</ProovraText> : null}
              {detail?.timeline.map((t, n) => (
                <ProovraText key={`${t.event}-${n}`} variant="bodySm">
                  {`${timelineEventLabel(t.event)}${t.safeMessage ? ` — ${t.safeMessage}` : ""} · ${describeRelativeTime(t.atUtc)}`}
                </ProovraText>
              ))}
              {detail && !detail.timelineComplete ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {STATE_COPY.historyTruncated}
                </ProovraText>
              ) : null}
            </ProovraSection>

            {detail && (i.relatedProvider || i.relatedJobId || i.requestId || i.traceId) ? (
              <ProovraSection title="Technical references">
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {STATE_COPY.techRefsIntro}
                </ProovraText>
                {i.relatedProvider ? <OpsIdentifier label="Provider" value={i.relatedProvider} /> : null}
                {i.relatedJobId ? <OpsIdentifier label="Job" value={i.relatedJobId} /> : null}
                {i.requestId ? <OpsIdentifier label="Request" value={i.requestId} /> : null}
                {i.traceId ? <OpsIdentifier label="Trace" value={i.traceId} /> : null}
              </ProovraSection>
            ) : null}

            {resolutionNoteFor(i) ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {resolutionNoteFor(i)}
              </ProovraText>
            ) : null}

            <View style={{ gap: theme.space.s2 }}>
              {elig?.canAcknowledge ? <ProovraButton label="Acknowledge" variant="secondary" disabled={busy} onPress={() => onLifecycle("ack")} /> : null}
              {elig?.canResolve ? <ProovraButton label="Resolve" disabled={busy} onPress={() => onLifecycle("resolve")} /> : null}
              {elig?.canSuppress ? <ProovraButton label="Stop notifying" variant="danger" disabled={busy} onPress={() => onLifecycle("suppress")} /> : null}
            </View>
          </>
        ) : null}
      </View>
      <ProovraConfirmSheet
        visible={confirming !== null}
        title={confirming ? `${confirming.label}?` : ""}
        consequence={confirming?.description}
        confirmLabel={confirming?.label ?? "Confirm"}
        onConfirm={() => confirming && void remediate(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </ProovraSheet>
  );
}

function GroupInspector({ teamId, group: g, onClose }: { teamId: string; group: IncidentGroup; onClose: () => void }) {
  const router = useRouter();
  const [records, setRecords] = useState<AffectedRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = parseAffected(await apiFetch(buildOpsGroupAffectedPath(teamId, g.groupKey, next)));
        // APPEND, never replace: the rows already read must not vanish.
        setRecords((prev) => (next ? [...prev, ...page.records] : page.records));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(toSafeUserError(err, { message: STATE_COPY.groupFailed }).message);
      } finally {
        setLoading(false);
      }
    },
    [teamId, g.groupKey],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const sev = SEVERITY_VOCABULARY[g.severity];
  const st = STATUS_VOCABULARY[g.statusPosture as keyof typeof STATUS_VOCABULARY] ?? STATUS_VOCABULARY.OPEN;

  return (
    <ProovraSheet visible title={g.title} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="ops-group-inspector">
        <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap", alignItems: "center" }}>
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <ProovraBadge label={st.label} tone={st.tone} />
        </View>
        <ProovraSection title="What this is">
          <ProovraDetailRows
            rows={[
              { label: "Source", value: categoryLabel(g.category) },
              { label: "Conditions", value: g.conditionCount.toLocaleString("en-US") },
              ...(g.affectedRecordCount != null
                ? [{ label: `Affected ${g.affectedUnit ?? "records"}`, value: g.affectedRecordCount.toLocaleString("en-US") }]
                : []),
              ...(g.metric && g.metric.contract === "AGGREGATE_THRESHOLD"
                ? [
                    {
                      label: "Threshold",
                      value: `${g.metric.thresholdValue.toLocaleString("en-US")}${
                        g.metric.criticalThresholdValue != null ? ` (critical at ${g.metric.criticalThresholdValue.toLocaleString("en-US")})` : ""
                      }`,
                    },
                  ]
                : []),
              ...(g.durationSeconds != null ? [{ label: "Elapsed", value: describeDuration(g.durationSeconds) }] : []),
              { label: "Source observations", value: `Observed in ${g.observations.toLocaleString("en-US")} checks` },
              ...(g.metric?.stale
                ? [
                    {
                      label: "Metric freshness",
                      value: `Last confirmed ${formatUserDateTime(g.metric.observedAtUtc)}. The most recent attempt to read this source did not complete, so the values above are the last ones observed.`,
                    },
                  ]
                : []),
              ...(g.firstSeenAtUtc ? [{ label: "First seen", value: when(g.firstSeenAtUtc) }] : []),
              ...(g.lastSeenAtUtc ? [{ label: "Last seen", value: when(g.lastSeenAtUtc) }] : []),
            ]}
          />
        </ProovraSection>
        <ProovraSection title="Affected records">
          {error ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg} testID="ops-affected-error">
              {error}
            </ProovraText>
          ) : null}
          {!loading && !error && records.length === 0 ? <ProovraText variant="bodySm">{STATE_COPY.groupEmpty}</ProovraText> : null}
          {records.map((r) => (
            <ProovraListRow
              key={r.conditionId}
              title={r.title}
              subtitle={`${SEVERITY_VOCABULARY[r.severity].label} · ${describeRelativeTime(r.firstSeenAtUtc)}${r.assignedOperatorUserId ? " · owned" : ""}`}
              trailing={
                r.evidenceId ? (
                  <ProovraButton
                    label="Open record"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => {
                      onClose();
                      router.push(`/evidence/${encodeURIComponent(r.evidenceId!)}` as never);
                    }}
                  />
                ) : undefined
              }
            />
          ))}
          {loading ? <ProovraLoadingState label={STATE_COPY.groupLoading} /> : null}
          {cursor && !loading ? (
            <ProovraButton label={AFFECTED_MORE_LABEL} variant="secondary" fullWidth={false} onPress={() => void load(cursor)} />
          ) : null}
        </ProovraSection>
      </View>
    </ProovraSheet>
  );
}

