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
import { AppState, Linking, View } from "react-native";
import { fillOperationsCopy, makeClientRequestKey, operationsCopyFor } from "@proovra/shared";
import { useOptionalLocale } from "../../../src/locale-context";
import { useRouter } from "expo-router";

import { apiFetch, apiFetchText } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { usePlatformContext } from "../../../src/product/platform-context";
import { webOrigin } from "../../../src/product/intake-create";
import {
  fillOpsCopy,
  formatOpsCount,
  formatOpsDateTime,
  opsDuration,
  opsNativeCopyFor,
  opsRelativeTime,
  type OpsNativeCopy,
} from "../../../src/product/ops-copy";
import {
  DEFAULT_STATUS_FILTER,
  OPS_PAGE_LIMIT,
  OPS_SEARCH_MAX,
  REFUSAL_COPY_KEYS,
  STATUS_FILTERS,
  queueRequestKey,
  reconcileRefusalKind,
  remediationDestination,
  remediationOutcome,
  savedViewCanStore,
  shouldAutoReconcile,
  summaryCountDisplay,
  summaryIsFloor,
  type RemediationOutcome,
  CATEGORY_LABEL,
  DEFAULT_FILTERS,
  LOAD_MORE_LABEL,
  OPS_BULK_PATH,
  OPS_RECONCILE_PATH,
  OPS_SAVED_VIEWS_PATH,
  QUEUE_METRICS,
  RECONCILE_MAX_POLLS,
  REFUSAL_NOTICE,
  SEVERITIES,
  SEVERITY_VOCABULARY,
  SLA_FILTER_OPTIONS,
  SORT_LABEL,
  STATUS_VOCABULARY,
  affectedFor,
  anyFilterActive,
  bulkBody,
  canActOnAnything,
  canViewWorkspaceHealth,
  categoryLabel,
  conditionSummary,
  conditionTitle,
  filtersForMetric,
  buildOpsAssignPath,
  opsCapabilities,
  buildOpsGroupAffectedPath,
  buildOpsGroupsPath,
  buildOpsIncidentPath,
  buildOpsIncidentsPath,
  buildOpsLifecyclePath,
  lifecycleBody,
  buildOpsOperatorsPath,
  buildOpsRemediatePath,
  buildRemediateBody,
  REMEDIATION_REASON_MAX,
  remediationReasonReady,
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
  resolutionNoteFor,
  resolveOperationsAccess,
  rowActions,
  rowEligibility,
  savedViewFilterBody,
  selectedMetric,
  slaBreachRecord,
  slaExplanation,
  slaLabel,
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
  useOpsRowDirection,
} from "../../../src/ui/ops-surfaces";

type Phase = "loading" | "ready" | "failed";
/** A safe, operator-facing failure and the reference to quote for it. */
type Failure = { title?: string; message: string; reference?: string | null };

function failureOf(err: unknown, message: string): Failure {
  const safe = toSafeUserError(err, { message });
  return { message: safe.message || message, reference: safe.requestId ?? null };
}

/** A lifecycle/assign refusal in the active language (the three new codes are translated natively). */
function refusalNotice(code: string, nc: OpsNativeCopy): { title: string; body: string } {
  const keys = REFUSAL_COPY_KEYS[code];
  const words = nc as unknown as Record<string, string>;
  if (keys) return { title: words[keys[0]]!, body: words[keys[1]]! };
  return REFUSAL_NOTICE[code]!;
}

/** Status filter chip labels: the two set filters are native copy, the four statuses the vocabulary. */
function statusFilterLabel(v: string, nc: OpsNativeCopy): string {
  if (v === "UNRESOLVED") return nc.statusUnresolved;
  if (v === "ALL") return nc.statusAll;
  return (nc.status as Record<string, { label: string }>)[v]?.label ?? v;
}

/**
 * OPS-035 — ONE WORKSPACE, ONE SCREEN STATE.
 *
 * Filters, the selection, an open condition or group sheet and every read
 * belonged to whichever workspace was active when they were set, and none of
 * them was reset when the active workspace changed — so a switch could leave
 * the previous workspace's selection armed for a bulk action, or its sheet
 * open. Keying the screen on the active workspace remounts it: everything
 * starts from the new workspace's own state.
 */
export default function OperationsScreen() {
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;
  // Back in the foreground, the active workspace is asked again: it may have
  // been switched on another surface while this screen was away. A changed
  // workspace remounts the screen below through its key.
  const refreshRef = useRef(platform.refresh);
  refreshRef.current = platform.refresh;
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (last !== "active" && next === "active") refreshRef.current();
      last = next;
    });
    return () => sub.remove();
  }, []);
  return <OperationsWorkspaceScreen key={teamId ?? "no-workspace"} />;
}

function OperationsWorkspaceScreen() {
  const router = useRouter();
  const platform = usePlatformContext();
  // OPS-035 — the shared Operations dictionary (en / de / ar), as on web.
  const locale = useOptionalLocale();
  const copy = operationsCopyFor(locale);
  const nc = opsNativeCopyFor(locale);
  const fmt = (n: number) => formatOpsCount(n, locale);
  const rowDir = useOpsRowDirection();
  const envelope = platform.envelope;
  const teamId = platform.context?.activeTeamId ?? null;
  const workspaceName = platform.context?.displayName ?? nc.thisWorkspace;
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
  /** The group opened, with the queue predicate it was counted under (D6). */
  const [openGroup, setOpenGroup] = useState<{ group: IncidentGroup; status: string; severity: string | null } | null>(null);

  const loadedOnce = useRef(false);
  const collaborative = operatorCount > 1;
  const stepUp = useChallengeStepUp(teamId);

  // D2 — THE IDENTITY OF THE QUEUE ON SCREEN. Every read of the list carries
  // the workspace + filters it was asked under and a sequence number; a page
  // that answers after either moved is discarded, never appended.
  const queueKey = queueRequestKey(teamId, filters);
  const queueKeyRef = useRef(queueKey);
  queueKeyRef.current = queueKey;
  const queueSeq = useRef(0);
  const moreBusyRef = useRef(false);

  // D15 — in-flight guards that hold across a double tap. State updates are
  // asynchronous, so a second tap in the same frame still read the old `busy`.
  const mutationRef = useRef(false);
  const bulkIntentRef = useRef<{ signature: string; key: string } | null>(null);

  // D13 — a selection belongs to the queue it was made in: any change of
  // filters, search or workspace clears it.
  useEffect(() => {
    setMarked([]);
  }, [queueKey]);

  // OPS-035 — RETURNING TO THE FOREGROUND RE-READS. A queue left open in the
  // background is shown as it was when the app was put away; the first frame
  // after coming back asks again rather than presenting a stale picture.
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (last !== "active" && next === "active") setReload((n) => n + 1);
      last = next;
    });
    return () => sub.remove();
  }, []);

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
        setOperatorCount(parsed.operatorCount);
        if (parsed.summary.unreadable) {
          // D8 — every count is unknown: no cards (never a row of zeros) and
          // no automatic check started from a read that failed.
          setSummary(null);
          setSummaryError({ title: nc.summaryUnreadableTitle, message: nc.summaryUnreadableBody });
        } else {
          setSummary(parsed.summary);
          setSummaryError(null);
        }
      })
      .catch((err) => {
        if (!live) return;
        // P:639 — a failed summary hides the cards (P:1675) and says so above them.
        setSummary(null);
        setSummaryError(failureOf(err, nc.stateSummaryFailedTitle));
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
    const seq = (queueSeq.current += 1);
    setMoreError(null);
    apiFetch(buildOpsIncidentsPath(teamId, filters))
      .then((d) => {
        if (!live || seq !== queueSeq.current) return;
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
        if (!live || seq !== queueSeq.current) return;
        setLoadError(failureOf(err, nc.stateUnavailableFallback));
        setNextCursor(null);
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
        // The web swallows this and renders "no match" over real
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
    if (!teamId || !nextCursor || moreBusyRef.current) return;
    const key = queueKeyRef.current;
    const seq = queueSeq.current;
    const stale = () => queueKeyRef.current !== key || queueSeq.current !== seq;
    moreBusyRef.current = true;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = parseIncidentsPage(await apiFetch(buildOpsIncidentsPath(teamId, filters, nextCursor)));
      // D2 — a page of the PREVIOUS queue (filters changed, or the list was
      // re-read meanwhile) is dropped: appending it would mix two predicates.
      if (stale()) return;
      setIncidents((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...page.incidents.filter((x) => !seen.has(x.id))];
      });
      setComplete(page.complete);
      setNextCursor(page.nextCursor);
    } catch (err) {
      // P:919 — reported beside the control; the cursor is kept so a retry resumes.
      if (!stale()) setMoreError(failureOf(err, nc.stateLoadMoreFailed).message);
    } finally {
      moreBusyRef.current = false;
      setMoreBusy(false);
    }
  }, [teamId, filters, nextCursor]);

  /* ------------------------------------------------------------ reconcile */

  /** D9 — a refused check in words: only schema_mismatch is a deployment mismatch. */
  function reconcileNotice(refusedReason: string, retryable: boolean | null): Failure {
    switch (reconcileRefusalKind(refusedReason, retryable)) {
      case "mismatch":
        return { title: nc.checkMismatchTitle, message: nc.checkMismatchBody };
      case "permission":
        return { title: nc.checkPermissionTitle, message: nc.checkPermissionBody };
      case "other":
        return { title: nc.checkNotStartedTitle, message: nc.checkRefusedOtherBody };
      default:
        return { title: nc.checkNotStartedTitle, message: nc.checkNotStartedBody };
    }
  }

  const reconcileStarted = useRef<string | null>(null);
  const checkingRef = useRef(false);
  const checkAgain = useCallback(async () => {
    if (!teamId || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setNotice(null);
    try {
      // `explicit` (OPS-032): a person asked, so the sources are examined
      // even inside the freshness window.
      const res = (await apiFetch(OPS_RECONCILE_PATH, { method: "POST", body: JSON.stringify({ teamId, explicit: true }) })) as {
        refusedReason?: string | null;
        retryable?: boolean;
        alreadyRunning?: boolean;
        readiness?: string;
      };
      if (res?.refusedReason) {
        setNotice(reconcileNotice(res.refusedReason, res.retryable ?? null));
      } else {
        // The check runs inline: poll only a run the server says is still going.
        const stillRunning = res?.alreadyRunning === true || res?.readiness === "RUNNING";
        for (let n = 0; stillRunning && n < RECONCILE_MAX_POLLS; n += 1) {
          await new Promise((r) => setTimeout(r, reconcilePollDelay(n)));
          const parsed = parseSummary(await apiFetch(buildOpsSummaryPath(teamId)));
          if (parsed.summary.unreadable) break;
          setSummary(parsed.summary);
          if (parsed.summary.readiness !== "RUNNING") break;
        }
      }
    } catch (err) {
      // The web shows generic copy for a 503 schema_mismatch; the body says
      // exactly why, so native reads it.
      const e = err as { code?: string; body?: { refusedReason?: string; retryable?: boolean; error?: { code?: string; retryable?: boolean } } };
      const reason = e?.body?.refusedReason ?? (e?.code === "schema_mismatch" || e?.code === "permission_denied" ? e.code : null);
      setNotice(
        reason ? reconcileNotice(reason, e?.body?.retryable ?? e?.body?.error?.retryable ?? null) : failureOf(err, nc.stateCheckThrew),
      );
    } finally {
      checkingRef.current = false;
      setChecking(false);
      refresh();
    }
  }, [teamId, refresh]);

  // A workspace that has never been checked is checked once, automatically
  // (P:1021-1029) — from a summary that was READ. An unreadable summary says
  // NEVER_RUN as its floor; a failed read is not a reason to start work (D8).
  useEffect(() => {
    if (shouldAutoReconcile(summary) && teamId && reconcileStarted.current !== teamId) {
      reconcileStarted.current = teamId;
      void checkAgain();
    }
  }, [summary, teamId, checkAgain]);

  /* ------------------------------------------------------------ mutations */

  const lifecycle = useCallback(
    async (id: string, action: LifecycleAction, extra?: { resolutionNote?: string; reason?: string }) => {
      if (!teamId || mutationRef.current) return;
      mutationRef.current = true;
      setBusy(true);
      setPendingId(id);
      setNotice(null);
      try {
        // OPS-029 / OPS-030 — the note a Resolve needs and the reason a
        // suppression needs travel with the request.
        await apiFetch(buildOpsLifecyclePath(id, action), { method: "POST", body: JSON.stringify(lifecycleBody(teamId, extra)) });
      } catch (err) {
        const code = refusalCode(err);
        if (code) setRefusal(refusalNotice(code, nc));
        else setNotice(failureOf(err, nc.stateActionFailed));
      } finally {
        mutationRef.current = false;
        setBusy(false);
        setPendingId(null);
        refresh();
      }
    },
    [teamId, refresh, nc],
  );

  const assign = useCallback(
    async (id: string, assigneeUserId: string | null) => {
      if (!teamId || mutationRef.current) return;
      mutationRef.current = true;
      setBusy(true);
      setPendingId(id);
      setNotice(null);
      try {
        await apiFetch(buildOpsAssignPath(id), { method: "POST", body: JSON.stringify({ teamId, assigneeUserId }) });
        refresh();
      } catch (err) {
        // 400 invalid_assignee / 409 CONDITION_STATE_CHANGED are refusals with their own words.
        const code = refusalCode(err);
        if (code) {
          setRefusal(refusalNotice(code, nc));
          refresh();
        } else setNotice(failureOf(err, nc.stateAssignFailed));
      } finally {
        mutationRef.current = false;
        setBusy(false);
        setPendingId(null);
      }
    },
    [teamId, refresh, nc],
  );

  const runBulk = useCallback(
    async (actionType: BulkActionType, assigneeUserId?: string, note?: string) => {
      if (!teamId || marked.length === 0 || mutationRef.current) return;
      const targets = [...marked];
      // D15 — ONE KEY PER USER INTENT. A retry of the same sweep (same action,
      // same targets, same assignee and reason) after a failure re-sends the
      // SAME key, so the server reads back the first run instead of starting a
      // second; a different intent gets a fresh key.
      const signature = JSON.stringify([actionType, [...targets].sort(), assigneeUserId ?? null, note ?? null]);
      if (bulkIntentRef.current?.signature !== signature) {
        bulkIntentRef.current = { signature, key: makeClientRequestKey() };
      }
      const idempotencyKey = bulkIntentRef.current.key;
      mutationRef.current = true;
      setBusy(true);
      setNotice(null);
      setBulkOutcome(null);
      try {
        const res = await stepUp.run((headers) =>
          apiFetch(OPS_BULK_PATH, { method: "POST", headers, body: JSON.stringify(bulkBody(teamId, actionType, targets, assigneeUserId, { note, idempotencyKey })) }),
        );
        const outcome = summarizeBulk(res, targets, nc);
        // The sweep settled: the next one is a new intent.
        bulkIntentRef.current = null;
        setMarked(outcome.stillSelected);
        setBulkOutcome(outcome.message);
      } catch (err) {
        // P:1315-1322: a cancelled challenge is an outcome; anything else is a failure banner.
        if ((err as { code?: string })?.code === "STEP_UP_CANCEL") setBulkOutcome(nc.stateBulkCancelled);
        else setNotice(failureOf(err, nc.stateBulkFailed));
      } finally {
        mutationRef.current = false;
        setBusy(false);
        refresh();
      }
    },
    [teamId, marked, stepUp, refresh],
  );

  const onRowAction = useCallback(
    (id: string, key: RowActionKey) => {
      // C/IncidentSurface.tsx: "Change owner" opens the inspector, where ownership lives.
      if (key === "open" || key === "assign") setOpenId(id);
      else if (key === "acknowledge") void lifecycle(id, "ack");
      // D19 — "Resume notifications" (POST …/unsuppress) needs no reason.
      else if (key === "unsuppress") void lifecycle(id, "unsuppress");
      // OPS-029 — a source that needs a written conclusion is resolved from
      // its sheet, where the note is asked for.
      else if (key === "resolve") {
        if (incidents.find((i) => i.id === id)?.requiresResolutionNote) setOpenId(id);
        else void lifecycle(id, "resolve");
      }
      // OPS-030 — stopping notifications needs a reason; the sheet asks.
      else setOpenId(id);
    },
    [lifecycle, incidents],
  );

  /* ------------------------------------------------------------ render */

  const busyHeader = refreshing || checking;
  const header = (
    <ProovraPageHeader
      title={copy.pageTitle}
      subtitle={canActOnAnything(caps) ? copy.subtitleOperator : copy.subtitleViewer}
      contextStrip={
        restricted ? undefined : (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`${fillOpsCopy(nc.contextStrip, { name: workspaceName })}${lastLoadedAt ? ` · ${fillOpsCopy(nc.contextUpdated, { at: formatOpsDateTime(lastLoadedAt, locale) })}` : ""}`}
          </ProovraText>
        )
      }
      secondaryActions={
        !restricted && healthVisible ? (
          <ProovraButton label={nc.workspaceHealthLink} variant="ghost" fullWidth={false} onPress={() => router.push("/operations/health")} />
        ) : undefined
      }
      primaryAction={
        restricted ? undefined : (
          <ProovraButton
            label={busyHeader ? copy.refreshing : copy.refresh}
            variant="secondary"
            fullWidth={false}
            disabled={busyHeader}
            onPress={() => void checkAgain()}
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
        <ProovraEmpty title={nc.restrictedTitle} purpose={nc.restricted[restricted]} />
      </ProovraScreen>
    );
  }

  const reconciliation = reconciliationNotice(summary, nc);
  const active = anyFilterActive(filters);
  const selected = selectedMetric(filters);
  const selectable = caps.acknowledge || caps.suppress;
  // D2 — while a further page is loading, the filters are held still: a page
  // of one queue must not land in another.
  const filtersLocked = busy || moreBusy;
  const ownerWords = { assigned: nc.ownerAssigned, unassigned: nc.ownerUnassigned, you: nc.ownerYou };
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
      title={nc.stateClearTitle}
      purpose={nc.stateClearBody}
      action={
        <View style={{ gap: theme.space.s2 }}>
          <ProovraButton label={nc.evidenceLibrary} variant="secondary" onPress={() => router.push("/evidence")} />
          <ProovraButton label={nc.workspaceOverview} variant="ghost" onPress={() => router.push("/")} />
        </View>
      }
    />
  ) : summary?.readiness === "NEVER_RUN" && !active ? (
    <ProovraEmpty title={nc.statePreparingTitle} purpose={nc.statePreparingBody} />
  ) : (
    <ProovraEmpty
      title={nc.stateNoMatchTitle}
      purpose={nc.stateNoMatchBody}
      action={<ProovraButton label={nc.clearFilters} onPress={clearFilters} />}
    />
  );

  let queue: React.ReactNode;
  if (grouped && groupsFailed) {
    queue = (
      <ProovraEmpty
        title={nc.stateUnavailableTitle}
        purpose={nc.stateGroupsFailed}
        action={<ProovraButton label={nc.tryAgain} variant="secondary" onPress={refresh} />}
      />
    );
  } else if (grouped && groupsLoading && groups.length === 0) {
    // LOADING IS NOT EMPTY (P:1799-1807): never an all-clear for one frame.
    queue = <ProovraLoadingState label={nc.stateLoading} />;
  } else if (surfaceEmpty) {
    queue = phase === "ready" ? emptyState : null;
  } else if (grouped) {
    queue = (
      <View style={{ gap: theme.space.s2 }} testID="ops-groups">
        {groups.map((g) => (
          <OpsGroupCard
            key={g.groupKey}
            group={g}
            onOpen={() => setOpenGroup({ group: g, status: filters.status || DEFAULT_STATUS_FILTER, severity: filters.severity || null })}
          />
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
            owner={collaborative ? ownerLabel(i, viewer, operators, ownerWords) : null}
            selectLabel={fillOpsCopy(nc.selectFor, { title: conditionTitle(i, nc) })}
            attention={i.sla !== null && attention.includes(i.sla.posture)}
            selectable={selectable}
            marked={marked.includes(i.id)}
            actions={rowActions(i, caps, { collaborative }, nc)}
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
          actions={[{ label: nc.dismiss, variant: "ghost", onPress: () => setNotice(null) }]}
          testID="ops-mutation-error"
        />
      ) : null}
      {summaryError ? (
        <OpsNotice
          tone="warn"
          title={summaryError.title ?? nc.stateSummaryFailedTitle}
          text={summaryError.title ? summaryError.message : `${summaryError.message} ${nc.stateDegradedTail}`}
          reference={summaryError.reference}
          actions={[{ label: nc.retry, onPress: refresh }]}
          testID="ops-degraded-summary"
        />
      ) : null}
      <ReconciliationBanner notice={reconciliation} onCheckAgain={() => void checkAgain()} />

      {phase === "loading" && incidents.length === 0 ? <ProovraLoadingState label={nc.stateLoading} /> : null}

      {/*
        D14 — a failed queue read replaces the QUEUE, never the filters and
        search above it: the person who typed a query that failed must be able
        to change it.
      */}
      {phase === "ready" || phase === "failed" ? (
        <>
          {refreshing ? (
            <ProovraText variant="label" color={theme.color.ink.muted} testID="ops-refreshing">
              {nc.refreshingInline}
            </ProovraText>
          ) : null}

          {summary ? (
            <ProovraSection title={nc.sectionSummary} heading>
              <ProovraKpiGrid
                items={QUEUE_METRICS.filter((m) => !m.collaborativeOnly || collaborative).map((m) => {
                  return {
                    key: m.key,
                    label: nc.metric[m.key].label,
                    // D8 — null is "—", a bounded scan is "N+" (at least N), never 0.
                    value: summaryCountDisplay(summary, m.key, fmt),
                    caption: nc.metric[m.key].note,
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
              {summaryIsFloor(summary) ? (
                <ProovraText variant="label" color={theme.color.ink.secondary} testID="ops-summary-floor">
                  {nc.summaryFloorNote}
                </ProovraText>
              ) : null}
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {nc.overlapNote}
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

          <ProovraSection title={nc.sectionFilters} heading>
            <ProovraFilterSearch
              value={searchText}
              onChange={(t) => setSearchText(t.slice(0, OPS_SEARCH_MAX))}
              placeholder={nc.searchPlaceholder}
              clearLabel={nc.clearSearch}
              clearA11y={nc.clearSearch}
              testID="ops-search"
            />
            <ProovraFilterChips
              label={nc.statusLabel}
              value={filters.status}
              disabled={filtersLocked}
              onChange={(status) => setFilters((f) => ({ ...f, status }))}
              options={STATUS_FILTERS.map((s) => ({ value: s as string, label: statusFilterLabel(s, nc) }))}
            />
            <ProovraFilterChips
              label={nc.filterSeverity}
              value={filters.severity}
              disabled={filtersLocked}
              onChange={(severity) => setFilters((f) => ({ ...f, severity }))}
              options={[{ value: "", label: nc.filterSeverityAny }, ...SEVERITIES.map((s) => ({ value: s as string, label: nc.severity[s].label }))]}
            />
            <ProovraFilterChips
              label={nc.filterSource}
              value={filters.category}
              disabled={filtersLocked}
              onChange={(category) => setFilters((f) => ({ ...f, category }))}
              options={[{ value: "", label: nc.filterSourceAny }, ...Object.keys(CATEGORY_LABEL).map((value) => ({ value, label: categoryLabel(value, nc) }))]}
            />
            {collaborative ? (
              <ProovraFilterChips
                label={nc.filterOwner}
                value={filters.owner}
                disabled={filtersLocked}
                onChange={(owner) => setFilters((f) => ({ ...f, owner }))}
                options={[
                  { value: "any", label: nc.filterOwnerAny },
                  { value: "me", label: nc.filterOwnerMe },
                  { value: "unassigned", label: nc.filterOwnerNone },
                  ...operators.map((o) => ({ value: o.userId, label: o.label })),
                ]}
              />
            ) : null}
            <ProovraFilterChips
              label={nc.filterSort}
              value={filters.sort}
              disabled={filtersLocked}
              onChange={(sort) => setFilters((f) => ({ ...f, sort: sort as SortKey }))}
              options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ value: k, label: nc.sort[k] }))}
            />
            <ProovraFilterChips
              label={nc.filterSla}
              value={filters.sla}
              disabled={filtersLocked}
              onChange={(sla) => setFilters((f) => ({ ...f, sla }))}
              options={SLA_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.value ? slaLabel(o.value, nc) : nc.slaAny }))}
            />
            <View style={{ flexDirection: rowDir, alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="ops-result-summary">
                {phase === "failed"
                  ? ""
                  : grouped
                    ? `${(groupTotals?.groups ?? groups.length) === 1 ? nc.resultSourceOne : fillOpsCopy(nc.resultSources, { n: fmt(groupTotals?.groups ?? groups.length) })} · ${
                        (groupTotals?.conditions ?? 0) === 1 ? nc.resultConditionOne : fillOpsCopy(nc.resultConditions, { n: fmt(groupTotals?.conditions ?? 0) })
                      }${filters.status === "ALL" ? ` · ${nc.resultAllStatuses}` : ""}`
                    : incidents.length === 1 && !nextCursor
                      ? nc.resultConditionOne
                      : fillOpsCopy(nc.resultConditions, { n: `${fmt(incidents.length)}${nextCursor ? "+" : ""}` })}
              </ProovraText>
              {active ? <ProovraButton label={nc.clearFilters} variant="ghost" fullWidth={false} onPress={clearFilters} /> : null}
            </View>
            <ProovraFilterChips
              label={nc.filterView}
              value={grouped ? "grouped" : "all"}
              onChange={(v) => {
                setGrouped(v === "grouped");
                setOpenGroup(null);
                setOpenId(null);
              }}
              options={[
                { value: "grouped", label: copy.viewGrouped },
                { value: "all", label: copy.viewAll },
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
              onSuppress={(reason) => void runBulk("BULK_SUPPRESS_INCIDENTS", undefined, reason)}
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

          {phase === "failed" ? (
            <ProovraEmpty
              title={nc.stateUnavailableTitle}
              purpose={loadError?.message ?? nc.stateUnavailableFallback}
              action={
                <View style={{ gap: theme.space.s2 }}>
                  <ProovraSupportReference reference={loadError?.reference} />
                  <ProovraButton label={copy.retry} onPress={refresh} />
                </View>
              }
            />
          ) : (
            queue
          )}

          {phase === "ready" && !grouped && nextCursor ? (
            <View style={{ gap: theme.space.s2, alignItems: "center" }}>
              <ProovraButton
                label={moreBusy ? copy.loading : fillOperationsCopy(copy.loadMore, { n: OPS_PAGE_LIMIT }) || LOAD_MORE_LABEL}
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
          // One sheet per condition: switching conditions never carries one
          // condition's remediation outcome or typed reason onto another.
          key={openId}
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
          onLifecycle={(action, extra) => void lifecycle(openId, action, extra)}
          onAssign={(userId) => void assign(openId, userId)}
          onChanged={refresh}
        />
      ) : null}
      {openGroup && teamId ? (
        <GroupInspector
          key={openGroup.group.groupKey}
          teamId={teamId}
          group={openGroup.group}
          status={openGroup.status}
          severity={openGroup.severity}
          onClose={() => setOpenGroup(null)}
        />
      ) : null}

      <ProovraConfirmSheet
        cancelLabel={nc.cancel}
        visible={refusal !== null}
        title={refusal?.title ?? ""}
        consequence={refusal?.body}
        confirmLabel={nc.close}
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
  const nc = opsNativeCopyFor(useOptionalLocale());
  if (!notice) return null;
  if (notice.kind === "running") {
    return (
      <ProovraText variant="label" color={theme.color.ink.muted} testID="ops-reconciling">
        {nc.stateReconciling}
      </ProovraText>
    );
  }
  if (notice.kind === "stalled") {
    return (
      <OpsNotice tone="warn" title={nc.stateStalledTitle} text={nc.stateStalledBody} actions={[{ label: nc.checkAgain, onPress: onCheckAgain }]} />
    );
  }
  if (notice.kind === "failed") {
    return (
      <OpsNotice tone="danger" text={notice.message} actions={notice.canRetry ? [{ label: nc.tryAgain, onPress: onCheckAgain }] : undefined} />
    );
  }
  return (
    <OpsNotice
      tone="warn"
      title={notice.heading}
      text={`${nc.statePartialTail}${notice.retryable ? "" : ` ${nc.statePartialNotRetryable}`}`}
      actions={notice.retryable ? [{ label: nc.checkAgain, onPress: onCheckAgain }] : undefined}
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
  /** OPS-030 — a bulk "Stop notifying" carries the operator's reason. */
  onSuppress: (reason: string) => void;
  onAssign: (userId: string) => void;
  onClear: () => void;
}) {
  const locale = useOptionalLocale();
  const copy = operationsCopyFor(locale);
  const nc = opsNativeCopyFor(locale);
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [suppressReason, setSuppressReason] = useState("");
  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s2 }} testID="ops-bulk-toolbar">
        <ProovraText variant="bodySm" weight="semibold">
          {count === 1 ? nc.bulkSelectedOne : fillOpsCopy(nc.bulkSelectedMany, { n: formatOpsCount(count, locale) })}
        </ProovraText>
        {caps.acknowledge ? <ProovraButton label={copy.acknowledge} variant="secondary" disabled={busy} onPress={onAcknowledge} /> : null}
        {caps.suppress ? (
          <ProovraButton
            label={copy.stopNotifying}
            variant="danger"
            disabled={busy}
            onPress={() => setSuppressOpen((v) => !v)}
            testID="ops-bulk-suppress"
          />
        ) : null}
        {caps.suppress && suppressOpen ? (
          <View style={{ gap: 4 }} testID="ops-bulk-suppress-reason">
            <ProovraInput
              value={suppressReason}
              onChangeText={(t) => setSuppressReason(t.slice(0, 400))}
              placeholder={copy.bulkSuppressReasonLabel}
              accessibilityLabel={copy.bulkSuppressReasonLabel}
              autoCapitalize="sentences"
              multiline
            />
            <ProovraButton
              label={copy.stopNotifying}
              variant="danger"
              disabled={busy || suppressReason.trim().length < 3}
              onPress={() => onSuppress(suppressReason.trim())}
              testID="ops-bulk-suppress-confirm"
            />
          </View>
        ) : null}
        {collaborative && caps.assign && operators.length > 0 ? (
          <ProovraFilterChips
            label={nc.bulkAssignTo}
            value=""
            disabled={busy}
            onChange={(v) => v && onAssign(v)}
            options={[
              ...(selfUserId ? [{ value: selfUserId, label: nc.bulkMe }] : []),
              ...operators.filter((o) => o.userId !== selfUserId).map((o) => ({ value: o.userId, label: o.label })),
            ]}
          />
        ) : null}
        <ProovraButton label={nc.bulkClear} variant="ghost" onPress={onClear} />
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
  const nc = opsNativeCopyFor(useOptionalLocale());
  const viewsTitle = nc.sectionViews;
  const [form, setForm] = useState<{ mode: "create" } | { mode: "rename"; view: SavedView } | null>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const [busy, setBusy] = useState(false);
  // A view the saved-view schema cannot replay exactly (status ALL) is not offered.
  const canSave = anyFilterActive(filters) && savedViewCanStore(filters);
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
      setError(toSafeUserError(err, { message: form.mode === "create" ? nc.viewSaveFailed : nc.viewRenameFailed }).message);
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
      setError(toSafeUserError(err, { message: nc.viewDeleteFailed }).message);
    } finally {
      setBusy(false);
      setDeleting(null);
      onChanged();
    }
  };

  return (
    <ProovraSection title={viewsTitle} heading>
      {loading ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {nc.viewsLoading}
        </ProovraText>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        {views.map((v) => (
          <View key={v.id} style={{ flexDirection: "row", alignItems: "center" }}>
            <ProovraButton
              label={v.visibility === "TEAM" ? fillOpsCopy(nc.viewShared, { name: v.name }) : v.name}
              variant="secondary"
              fullWidth={false}
              disabled={locked}
              onPress={() => onApply(v)}
            />
            {canManage(v) ? (
              <ProovraButton
                label={nc.viewManage}
                accessibilityLabel={fillOpsCopy(nc.viewActionsFor, { name: v.name })}
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
          label={nc.viewSave}
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
            placeholder={form.mode === "create" ? nc.viewNamePlaceholder : nc.viewRenamePlaceholder}
            accessibilityLabel={form.mode === "create" ? nc.viewNameA11y : nc.viewRenameA11y}
          />
          {form.mode === "create" && canManageShared ? (
            <ProovraFilterChips
              label={nc.viewShareLabel}
              value={shared ? "yes" : "no"}
              onChange={(v) => setShared(v === "yes")}
              options={[
                { value: "no", label: nc.viewOnlyMe },
                { value: "yes", label: nc.viewShareLabel },
              ]}
            />
          ) : null}
          <ProovraButton label={form.mode === "create" ? nc.viewSaveButton : nc.viewRenameButton} disabled={locked || !name.trim()} onPress={() => void submit()} />
          <ProovraButton label={nc.cancel} variant="ghost" onPress={() => setForm(null)} />
        </ProovraCard>
      ) : null}
      {error ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>
          {error}
        </ProovraText>
      ) : null}
      <ProovraSheet closeLabel={nc.close} visible={managing !== null} title={managing?.name ?? ""} onClose={() => setManaging(null)}>
        <ProovraButton
          label={nc.viewRenameAction}
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
          label={nc.viewDeleteAction}
          variant="danger"
          onPress={() => {
            setDeleting(managing);
            setManaging(null);
          }}
        />
      </ProovraSheet>
      <ProovraConfirmSheet
        cancelLabel={nc.cancel}
        visible={deleting !== null}
        title={deleting ? fillOpsCopy(nc.viewDeleteTitle, { name: deleting.name }) : ""}
        consequence={
          deleting?.visibility === "TEAM"
            ? nc.viewDeleteShared
            : nc.viewDeletePrivate
        }
        confirmLabel={nc.viewDeleteAction}
        tone="danger"
        busy={busy}
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </ProovraSection>
  );
}

/** "<absolute> (<relative>)" — the inspector's instants (C/IncidentInspector.tsx When). */
function when(iso: string, nc: OpsNativeCopy, locale: string): string {
  return `${formatOpsDateTime(iso, locale)} (${opsRelativeTime(iso, nc, locale)})`;
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
  /** OPS-029 / OPS-030 — carries the note or the reason when one is needed. */
  onLifecycle: (a: LifecycleAction, extra?: { resolutionNote?: string; reason?: string }) => void;
  onAssign: (userId: string | null) => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const locale = useOptionalLocale();
  const copy = operationsCopyFor(locale);
  const nc = opsNativeCopyFor(locale);
  const rowDir = useOpsRowDirection();
  const fmt = (n: number) => formatOpsCount(n, locale);
  // "Copy request" in English (the web's wording); the label as written elsewhere.
  const copyLabel = (label: string) => fillOpsCopy(nc.copyRef, { label: locale === "en" ? label.toLowerCase() : label });
  const [resolutionNote, setResolutionNote] = useState("");
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [suppressReason, setSuppressReason] = useState("");
  const [confirmSuppress, setConfirmSuppress] = useState(false);
  const routerPush = (href: string) => router.push(href as never);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [remBusy, setRemBusy] = useState<string | null>(null);
  const [remOutcome, setRemOutcome] = useState<RemediationOutcome | null>(null);
  // D15 / D19 — one remediation in flight, and its outcome belongs to the
  // condition it was requested for.
  const remInFlight = useRef(false);
  const currentId = useRef(id);
  currentId.current = id;
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
        setError(failureOf(err, nc.stateHistoryFailedTail));
      });
    return () => {
      live = false;
    };
  }, [teamId, id, reloadToken]);

  // ET-REC-04 — the reason an action that requires one carries (as on web).
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const remediate = async (a: RemediationAction) => {
    setConfirming(null);
    if (!remediationReasonReady(a, reasonFor === a.actionId ? reasonText : "")) {
      // Ask for the reason first; nothing is sent without it.
      setReasonFor(a.actionId);
      return;
    }
    if (remInFlight.current) return;
    remInFlight.current = true;
    const forId = id;
    const settle = (o: RemediationOutcome) => {
      // The sheet may now show another condition: an outcome is only ever
      // shown beside the condition it was requested for.
      if (currentId.current === forId) setRemOutcome(o);
    };
    setRemBusy(a.actionId);
    setRemOutcome(null);
    try {
      const res = await apiFetch(buildOpsRemediatePath(forId), {
        method: "POST",
        body: buildRemediateBody({ teamId, actionId: a.actionId, reason: a.requiresReason ? reasonText : null }),
      });
      if (currentId.current === forId) {
        setReasonFor(null);
        setReasonText("");
      }
      settle(remediationOutcome(res, false, nc.stateRemediationQueued));
    } catch (err) {
      // A refused or failed remediation carries the server's own explanation;
      // FAILED (502) and QUEUE_UNAVAILABLE (503) say whether trying again helps.
      settle(remediationOutcome(err, true, toSafeUserError(err, { message: nc.stateRemediationFailed }).message));
    } finally {
      remInFlight.current = false;
      setRemBusy(null);
      onChanged();
    }
  };
  const deepLink = detail?.remediation?.deepLink ? remediationDestination(detail.remediation.deepLink.href, webOrigin()) : null;

  // THE ROW FIRST (P:1909-1927 renders the inspector from the row): a failed
  // history never blanks the condition the operator opened.
  const i = detail?.incident ?? row;
  const elig = i ? rowEligibility(i, caps, { collaborative }) : null;
  const affected = i ? affectedFor(i, nc) : null;
  const rem = detail?.remediation ?? null;

  return (
    <ProovraSheet closeLabel={nc.close} visible title={i ? conditionTitle(i, nc) : nc.conditionFallbackTitle} onClose={onClose}>
      <View style={{ gap: theme.space.s4 }} testID="ops-inspector">
        {!i && !error ? <ProovraLoadingState label={nc.stateHistoryLoading} /> : null}
        {!i && error ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
            {`${error.message} ${nc.stateHistoryFailedTail}`}
          </ProovraText>
        ) : null}
        {i ? (
          <>
            <View style={{ flexDirection: rowDir, gap: theme.space.s2, flexWrap: "wrap", alignItems: "center" }}>
              <OpsSeverityCapsule label={nc.severity[i.severity].label} tone={SEVERITY_VOCABULARY[i.severity].tone} a11y={fillOpsCopy(nc.a11ySeverity, { label: nc.severity[i.severity].label })} />
              <ProovraBadge label={nc.status[i.status].label} tone={STATUS_VOCABULARY[i.status].tone} />
            </View>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {nc.status[i.status].explanation}
            </ProovraText>

            <ProovraSection title={copy.whatHappened} heading>
              {i.safeSummary ? <ProovraText variant="bodySm">{conditionSummary(i, nc)}</ProovraText> : null}
              <ProovraDetailRows
                rows={[
                  { label: nc.factSource, value: categoryLabel(i.category, nc) },
                  { label: nc.factSeverity, value: `${nc.severity[i.severity].label} — ${nc.severity[i.severity].explanation}` },
                  ...(affected?.label ? [{ label: nc.factAffectedRecord, value: affected.label }] : []),
                ]}
              />
              {affected?.href ? (
                <ProovraButton
                  label={nc.openRecord}
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
              <ProovraSection title={copy.whatYouCanDo} heading>
                {rem.guidance ? <ProovraText variant="bodySm">{rem.guidance}</ProovraText> : null}
                {rem.unsafeReason ? (
                  <ProovraText variant="bodySm" color={theme.color.ink.muted}>
                    {rem.unsafeReason}
                  </ProovraText>
                ) : null}
                {rem.actions.map((a) => (
                  <View key={a.actionId} style={{ gap: 4 }}>
                    <ProovraButton
                      label={remBusy === a.actionId ? nc.starting : a.label}
                      disabled={remBusy !== null || busy}
                      onPress={() => (a.confirm ? setConfirming(a) : void remediate(a))}
                    />
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {`${a.description}${a.async ? ` ${nc.stateRemediationAsyncHint}` : ""}`}
                    </ProovraText>
                    {a.requiresReason && reasonFor === a.actionId ? (
                      <View style={{ gap: 4 }} testID="ops-remediation-reason">
                        <ProovraInput
                          value={reasonText}
                          onChangeText={(t) => setReasonText(t.slice(0, REMEDIATION_REASON_MAX))}
                          placeholder={nc.reasonPlaceholder}
                          accessibilityLabel={fillOpsCopy(nc.reasonFor, { label: a.label })}
                          autoCapitalize="sentences"
                          multiline
                        />
                        <ProovraButton
                          label={fillOpsCopy(nc.submitAction, { label: a.label })}
                          disabled={remBusy !== null || busy || !remediationReasonReady(a, reasonText)}
                          onPress={() => (a.confirm ? setConfirming(a) : void remediate(a))}
                        />
                      </View>
                    ) : null}
                  </View>
                ))}
                {remOutcome ? (
                  <OpsNotice
                    tone={remOutcome.tone === "failure" ? "danger" : "success"}
                    title={remOutcome.tone === "failure" ? nc.remediationFailedTitle : nc.remediationQueuedTitle}
                    text={
                      remOutcome.tone === "failure"
                        ? `${remOutcome.message} ${remOutcome.retryable ? nc.remediationRetryHint : nc.remediationNoRetryHint}`
                        : remOutcome.message
                    }
                    testID="ops-remediation-outcome"
                  />
                ) : null}
                {rem.deepLink && deepLink?.native ? (
                  <ProovraButton
                    label={rem.deepLink.label}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => {
                      onClose();
                      routerPush(deepLink.native!);
                    }}
                    testID="ops-remediation-link"
                  />
                ) : null}
                {rem.deepLink && deepLink && !deepLink.native ? (
                  // D3 — no native screen for this step: say so, and offer the
                  // web app when its origin is known. Never a dead route.
                  <View style={{ gap: 4 }} testID="ops-remediation-web-only">
                    <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                      {`${rem.deepLink.label}. ${nc.webOnlyBody}${deepLink.webUrl ? "" : ` ${fillOpsCopy(nc.webOnlyPath, { path: deepLink.webPath })}`}`}
                    </ProovraText>
                    {deepLink.webUrl ? (
                      <ProovraButton
                        label={nc.openOnWeb}
                        accessibilityLabel={`${nc.openOnWeb}: ${rem.deepLink.label}`}
                        variant="secondary"
                        fullWidth={false}
                        onPress={() => void Linking.openURL(deepLink.webUrl!)}
                      />
                    ) : null}
                  </View>
                ) : null}
              </ProovraSection>
            ) : null}

            {i.metric ? (
              <ProovraSection title={copy.howMuch} heading>
                <ProovraDetailRows
                  rows={[
                    { label: nc.factAffectedNow, value: `${fmt(i.metric.currentValue)} ${i.metric.unit}${i.metric.truncated ? ` ${nc.factAtLeast}` : ""}` },
                    {
                      label: nc.factThreshold,
                      value: `${fmt(i.metric.thresholdValue)}${i.metric.criticalThresholdValue != null ? ` ${fillOpsCopy(nc.factCriticalAt, { n: fmt(i.metric.criticalThresholdValue) })}` : ""}`,
                    },
                    ...(i.metric.previousValue != null
                      ? [
                          {
                            label: nc.factPrevious,
                            value: `${fmt(i.metric.previousValue)}${
                              i.metric.delta != null ? ` (${i.metric.delta >= 0 ? "+" : ""}${fmt(i.metric.delta)})` : ""
                            }`,
                          },
                        ]
                      : []),
                    {
                      label: nc.factObserved,
                      value: `${when(i.metric.observedAtUtc, nc, locale)}${
                        i.metric.stale ? ` — ${nc.factStaleTail}` : ""
                      }`,
                    },
                  ]}
                />
              </ProovraSection>
            ) : null}

            <ProovraSection title={copy.when} heading>
              <ProovraDetailRows
                rows={[
                  { label: nc.factFirstSeen, value: when(i.firstSeenAtUtc, nc, locale) },
                  { label: nc.factLatestOccurrence, value: when(i.lastSeenAtUtc, nc, locale) },
                  { label: nc.factObservations, value: fillOpsCopy(nc.observedChecks, { n: fmt(i.occurrenceCount) }) },
                  ...(i.sla
                    ? [
                        {
                          label: nc.factTimeCommitment,
                          value: `${slaLabel(i.sla.posture, nc)}${i.sla.dueAtUtc ? ` — ${fillOpsCopy(i.sla.posture === "RESOLVED" ? nc.slaWasDue : nc.slaDue, { at: formatOpsDateTime(i.sla.dueAtUtc, locale) })}` : ""}. ${slaExplanation(i.sla, nc)}${
                            slaBreachRecord(i.sla, nc) ? ` ${slaBreachRecord(i.sla, nc)}` : ""
                          }`,
                        },
                      ]
                    : []),
                ]}
              />
            </ProovraSection>

            {collaborative ? (
              <ProovraSection title={copy.ownership} heading>
                {!caps.assign ? (
                  <ProovraText variant="bodySm">{fillOpsCopy(nc.ownerLine, { owner: ownerLabel(i, viewer, operators, { assigned: nc.ownerAssigned, unassigned: nc.ownerUnassigned, you: nc.ownerYou }) })}</ProovraText>
                ) : (
                  <>
                    <ProovraFilterChips
                      label={nc.factOwner}
                      value={i.assignedOperatorUserId ?? ""}
                      disabled={busy || !elig?.canAssign}
                      onChange={(v) => onAssign(v || null)}
                      options={[{ value: "", label: nc.ownerUnassigned }, ...operators.map((o) => ({ value: o.userId, label: o.label }))]}
                    />
                    {selfUserId && selfUserId !== i.assignedOperatorUserId && elig?.canAssign ? (
                      <ProovraButton label={nc.takeIt} variant="secondary" fullWidth={false} disabled={busy} onPress={() => onAssign(selfUserId)} />
                    ) : null}
                    {operators.length === 0 ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {nc.stateNoOperators}
                      </ProovraText>
                    ) : null}
                  </>
                )}
              </ProovraSection>
            ) : null}

            <ProovraSection title={copy.history} heading>
              {!detail && !error ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {nc.stateHistoryLoading}
                </ProovraText>
              ) : null}
              {error ? (
                <View style={{ gap: theme.space.s2 }} testID="ops-timeline-error">
                  <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
                    {`${error.message} ${nc.stateHistoryFailedTail}`}
                  </ProovraText>
                  <ProovraSupportReference reference={error.reference} />
                </View>
              ) : null}
              {detail && detail.timeline.length === 0 ? <ProovraText variant="bodySm">{nc.stateHistoryEmpty}</ProovraText> : null}
              {detail?.timeline.map((t, n) => (
                <ProovraText key={`${t.event}-${n}`} variant="bodySm">
                  {`${timelineEventLabel(t.event, nc)}${t.safeMessage ? ` — ${t.safeMessage}` : ""} · ${opsRelativeTime(t.atUtc, nc, locale)}`}
                </ProovraText>
              ))}
              {detail && !detail.timelineComplete ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {nc.stateHistoryTruncated}
                </ProovraText>
              ) : null}
            </ProovraSection>

            {detail && (i.relatedProvider || i.relatedJobId || i.requestId || i.traceId) ? (
              <ProovraSection title={copy.technicalReferences} heading>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {nc.stateTechRefsIntro}
                </ProovraText>
                {i.relatedProvider ? <OpsIdentifier label={nc.refProvider} value={i.relatedProvider} copyLabel={copyLabel(nc.refProvider)} /> : null}
                {i.relatedJobId ? <OpsIdentifier label={nc.refJob} value={i.relatedJobId} copyLabel={copyLabel(nc.refJob)} /> : null}
                {i.requestId ? <OpsIdentifier label={nc.refRequest} value={i.requestId} copyLabel={copyLabel(nc.refRequest)} /> : null}
                {i.traceId ? <OpsIdentifier label={nc.refTrace} value={i.traceId} copyLabel={copyLabel(nc.refTrace)} /> : null}
              </ProovraSection>
            ) : null}

            {resolutionNoteFor(i, nc) ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {resolutionNoteFor(i, nc)}
              </ProovraText>
            ) : null}

            {elig?.canResolve && i.requiresResolutionNote ? (
              // OPS-029 — the note is asked for before Resolve is offered.
              <View style={{ gap: 4 }} testID="ops-resolution-note">
                <ProovraInput
                  value={resolutionNote}
                  onChangeText={(t) => setResolutionNote(t.slice(0, 400))}
                  placeholder={copy.resolutionNoteLabel}
                  accessibilityLabel={copy.resolutionNoteLabel}
                  autoCapitalize="sentences"
                  multiline
                />
              </View>
            ) : null}
            {elig?.canSuppress && suppressOpen ? (
              // OPS-030 — why notifications should stop, recorded in history.
              <View style={{ gap: 4 }} testID="ops-suppress-reason">
                <ProovraInput
                  value={suppressReason}
                  onChangeText={(t) => setSuppressReason(t.slice(0, 400))}
                  placeholder={copy.suppressReasonLabel}
                  accessibilityLabel={copy.suppressReasonLabel}
                  autoCapitalize="sentences"
                  multiline
                />
              </View>
            ) : null}
            <View style={{ gap: theme.space.s2 }}>
              {elig?.canAcknowledge ? <ProovraButton label={copy.acknowledge} variant="secondary" disabled={busy} onPress={() => onLifecycle("ack")} /> : null}
              {elig?.canResolve ? (
                <ProovraButton
                  label={copy.resolve}
                  disabled={busy || (i.requiresResolutionNote && resolutionNote.trim().length === 0)}
                  onPress={() =>
                    onLifecycle("resolve", i.requiresResolutionNote ? { resolutionNote: resolutionNote.trim() } : undefined)
                  }
                  testID="ops-resolve"
                />
              ) : null}
              {elig?.canSuppress ? (
                <ProovraButton
                  label={copy.stopNotifying}
                  variant="danger"
                  disabled={busy || (suppressOpen && suppressReason.trim().length < 3)}
                  onPress={() => (suppressOpen ? setConfirmSuppress(true) : setSuppressOpen(true))}
                  testID="ops-suppress"
                />
              ) : null}
              {elig?.canUnsuppress ? (
                // D19 / OPS-030 — a silenced condition can be un-silenced by
                // whoever may silence it (POST …/unsuppress, OPERATIONS_SUPPRESS).
                <ProovraButton
                  label={copy.resumeNotifications}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => onLifecycle("unsuppress")}
                  testID="ops-unsuppress"
                />
              ) : null}
            </View>
          </>
        ) : null}
      </View>
      <ProovraConfirmSheet
        cancelLabel={nc.cancel}
        visible={confirmSuppress}
        title={copy.suppressConfirmTitle}
        consequence={copy.suppressConfirmBody}
        confirmLabel={copy.stopNotifying}
        onConfirm={() => {
          setConfirmSuppress(false);
          onLifecycle("suppress", { reason: suppressReason.trim() });
        }}
        onCancel={() => setConfirmSuppress(false)}
      />
      <ProovraConfirmSheet
        cancelLabel={nc.cancel}
        visible={confirming !== null}
        title={confirming ? fillOpsCopy(nc.confirmAction, { label: confirming.label }) : ""}
        consequence={confirming?.description}
        confirmLabel={confirming?.label ?? nc.confirm}
        onConfirm={() => confirming && void remediate(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </ProovraSheet>
  );
}

function GroupInspector({
  teamId,
  group: g,
  status,
  severity,
  onClose,
}: {
  teamId: string;
  group: IncidentGroup;
  /** D6 — the queue predicate the group was counted under. */
  status: string;
  severity: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const locale = useOptionalLocale();
  const nc = opsNativeCopyFor(locale);
  const fmt = (n: number) => formatOpsCount(n, locale);
  const [records, setRecords] = useState<AffectedRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(
    async (next?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = parseAffected(await apiFetch(buildOpsGroupAffectedPath(teamId, g.groupKey, next, { status, severity })));
        if (!live.current) return;
        // APPEND, never replace: the rows already read must not vanish.
        setRecords((prev) => (next ? [...prev, ...page.records] : page.records));
        setCursor(page.nextCursor);
      } catch (err) {
        if (live.current) setError(toSafeUserError(err, { message: nc.stateGroupFailed }).message);
      } finally {
        if (live.current) setLoading(false);
      }
    },
    [teamId, g.groupKey, status, severity],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const recordStatus = (s: string) => (nc.status as Record<string, { label: string }>)[s] ?? null;

  const sev = { label: nc.severity[g.severity].label, tone: SEVERITY_VOCABULARY[g.severity].tone };
  const stKey = (g.statusPosture in STATUS_VOCABULARY ? g.statusPosture : "OPEN") as keyof typeof STATUS_VOCABULARY;
  const st = { label: nc.status[stKey].label, tone: STATUS_VOCABULARY[stKey].tone };

  return (
    <ProovraSheet closeLabel={nc.close} visible title={conditionTitle(g, nc)} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="ops-group-inspector">
        <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap", alignItems: "center" }}>
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <ProovraBadge label={st.label} tone={st.tone} />
        </View>
        <ProovraSection title={nc.groupWhatThisIs} heading>
          <ProovraDetailRows
            rows={[
              { label: nc.factSource, value: categoryLabel(g.category, nc) },
              { label: nc.groupConditions, value: fmt(g.conditionCount) },
              ...(g.affectedRecordCount != null
                ? [{ label: fillOpsCopy(nc.groupAffectedUnit, { unit: g.affectedUnit ?? "records" }), value: fmt(g.affectedRecordCount) }]
                : []),
              ...(g.metric && g.metric.contract === "AGGREGATE_THRESHOLD"
                ? [
                    {
                      label: nc.factThreshold,
                      value: `${fmt(g.metric.thresholdValue)}${
                        g.metric.criticalThresholdValue != null ? ` ${fillOpsCopy(nc.factCriticalAt, { n: fmt(g.metric.criticalThresholdValue) })}` : ""
                      }`,
                    },
                  ]
                : []),
              ...(g.durationSeconds != null ? [{ label: nc.groupElapsed, value: opsDuration(g.durationSeconds, nc) }] : []),
              { label: nc.factObservations, value: fillOpsCopy(nc.observedChecks, { n: fmt(g.observations) }) },
              ...(g.metric?.stale
                ? [
                    {
                      label: nc.groupFreshness,
                      value: fillOpsCopy(nc.groupFreshnessBody, { at: formatOpsDateTime(g.metric.observedAtUtc, locale) }),
                    },
                  ]
                : []),
              ...(g.firstSeenAtUtc ? [{ label: nc.factFirstSeen, value: when(g.firstSeenAtUtc, nc, locale) }] : []),
              ...(g.lastSeenAtUtc ? [{ label: nc.groupLastSeenLabel, value: when(g.lastSeenAtUtc, nc, locale) }] : []),
            ]}
          />
        </ProovraSection>
        <ProovraSection title={nc.groupAffectedSection} heading>
          <ProovraText variant="label" color={theme.color.ink.secondary} testID="ops-affected-scope">
            {fillOpsCopy(nc.affectedFilteredBy, { status: statusFilterLabel(status, nc).toLowerCase() })}
          </ProovraText>
          {error ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg} testID="ops-affected-error">
              {error}
            </ProovraText>
          ) : null}
          {!loading && !error && records.length === 0 ? <ProovraText variant="bodySm">{nc.stateGroupEmpty}</ProovraText> : null}
          {records.map((r) => (
            <ProovraListRow
              key={r.conditionId}
              title={conditionTitle(r, nc)}
              subtitle={[
                nc.severity[r.severity].label,
                // D6 — each record states its own status, in words.
                recordStatus(r.status)?.label ?? (r.status || null),
                opsRelativeTime(r.firstSeenAtUtc, nc, locale),
                r.assignedOperatorUserId ? nc.recordOwned : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              trailing={
                r.evidenceId ? (
                  <ProovraButton
                    label={nc.openRecord}
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
          {loading ? <ProovraLoadingState label={nc.stateGroupLoading} /> : null}
          {cursor && !loading ? (
            <ProovraButton label={nc.groupMore} variant="secondary" fullWidth={false} onPress={() => void load(cursor)} />
          ) : null}
        </ProovraSection>
      </View>
    </ProovraSheet>
  );
}

