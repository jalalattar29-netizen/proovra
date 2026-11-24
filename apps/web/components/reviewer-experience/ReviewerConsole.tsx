"use client";

/**
 * Phase C0 — Reviewer Console.
 *
 * The "My reviews" tab of the Review hub (`/review`). Wraps the
 * existing reviewer-ops surface with:
 *
 *   * one aggregator request (`/v1/reviewer-ops/console`) that
 *     returns the queue slices + saved views in one envelope,
 *   * two slices: Unassigned (`queue`) and Assigned to me (`mine`).
 *     TEAM-SPEC §3 removed the console's Escalations, SLA and Workload
 *     tabs — they duplicated the Monitoring pages
 *     (`/reviewer-ops/sla`, `/reviewer-ops/escalations`), which the
 *     hub tabs now lead to,
 *   * keyboard-first navigation: `j` / `k` to move selection,
 *     `Enter` to open the focused row, `a` to assign (unassigned rows,
 *     when the viewer may assign), `/` to focus the in-tab filter input. Ctrl/Cmd+K belongs to the app-wide "Jump to a
 *     page" palette alone; the console binds no handler for it,
 *   * rows mapped once through the shared `toQueueRow` — the same
 *     mapping `/review/queues` uses — because the API sends
 *     `workflowId` / `lifecycleState` / `legacy.stage` /
 *     `legacy.dueAt`, not `id` / `stage` / `status` / `dueAtUtc`,
 *   * inline degraded-section badges per the server's
 *     `diagnostics.sectionStatus` so a single failed sub-query
 *     never breaks the rest of the console.
 *
 * TEAM-UI-SPEC §4 (round 3) — row actions are "Open" (ghost link to the
 * inspector) plus at most ONE secondary: "Assign" on an unassigned row when
 * the viewer holds REVIEW_ASSIGN. Escalate and Request information left the
 * rows (Escalate is an inspector secondary action; requesting information is
 * part of the inspector's decision flow), and so did their dialogs and the
 * `e` / `m` shortcuts. Assign uses the shared reviewer picker
 * (`ReviewerPickerModal`) — never a free-text user id.
 *
 *   * Mutations go through the existing audited reviewer-ops endpoint
 *     (`/v1/reviewer-ops/reviews/:workflowId/assign`).
 *   * Sensitive mutations route through `useStepUpAction` so the
 *     backend's `enforceStepUpIfFlagged` gate is honoured. No
 *     frontend-only authorization — every action is gated by
 *     `requireReviewerActor` + the workspace step-up flag.
 *   * Approve / Reject remain OFF the inline surface. They live in
 *     the inspector where the full risk + adaptive gate context
 *     renders.
 *   * Rows whose lifecycle is terminal (APPROVED / REJECTED / ARCHIVED)
 *     have actions disabled — the inspector remains reachable.
 *
 * Saved-view CRUD (also G3.2) — the saved views sidebar now
 * supports Create from current filters + Delete. Rename is not
 * supported (the backend has no PATCH endpoint).
 *
 * Hard rules:
 *   * The console composes existing reviewer-ops endpoints; it does
 *     not invent capability checks client-side.
 *   * Every mutation surfaces a visible loading / error / rollback
 *     state — no silent failures.
 *   * No analytics emission beyond the existing
 *     `REVIEW_SESSION_STARTED` event the legacy reviewer hub fires.
 *   * Vocabulary discipline: every label is operational. The
 *     console never makes claims about factual truth, authorship,
 *     or legal status of the underlying evidence — those words
 *     are explicitly absent.
 */

import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../lib/feedback/plan-refusal";
import { recordReference } from "../../lib/short-id";
import { AppListbox } from "../app-primitives/AppListbox";
import { identifierLabel } from "@proovra/shared";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReviewerOpsQueueType } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
// TEAM-SPEC R1 — bulk eligibility is the active workspace's effective plan
// plus the role capability, never the workspace KIND.
import { useCan, usePlanFeatureGate } from "../../lib/platform-context";
import { useOptionalPlatformContext } from "../../lib/platform-context/PlatformContextProvider";
import { roleInWorkspace } from "../../lib/platform-context/actorRole";
import { mayDeleteReviewerSavedView } from "../../lib/evidence/saved-view-sharing";
import { ReviewerPickerModal, useReviewerPicker } from "./ReviewerPickerModal";
import "./review-surfaces.css";
import { toQueueRows, isQueueRowActionable, type QueueRow } from "./queueRow";
import { resolveSavedViewQueue } from "../../lib/reviewer-workspace/reviewer-api";
import {
  ReviewerBulkOpsBar,
  type BulkResult,
} from "./ReviewerBulkOpsBar";
import { MultiStageReviewSummaryCard } from "./MultiStageReviewSummaryCard";
import {
  StepUpModal,
  useStepUpAction,
} from "../identity-security/StepUpModal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { RuntimeStatusBanner } from "../operational";
import { ReviewerRoutingRecommendationsPane } from "../hidden-feature-panels/HiddenFeaturePanels";
// TEAM-UI-SPEC §1 — layout from PageShell, cards are app-panel, controls
// the canonical app-* action classes, status the semantic <Badge>.
import Link from "next/link";
import { PageShell } from "../ui";
import { ReviewPageHeader } from "./ReviewPageHeader";
import { Badge, type BadgeTone } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";

const DEFAULT_TEAM_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

type ConsoleSectionStatus = "ok" | "degraded";

/**
 * The aggregator envelope as the console reads it. The escalations / SLA /
 * workload sections are still sent by the server and are deliberately not
 * read here (their pages are the Monitoring tab).
 */
type ConsoleEnvelope = {
  generatedAt: string;
  teamId: string;
  reviewer: { userId: string; isReviewerCapable: boolean };
  /**
   * T-055 (stage C) — `count` is the slice's total (not its first page), or
   * null when it is unknown (a degraded section): then no number is shown.
   */
  queue: { rows: ReadonlyArray<unknown>; status: ConsoleSectionStatus; count: number | null };
  mine: { rows: ReadonlyArray<unknown>; status: ConsoleSectionStatus; count: number | null };
  savedViews: {
    rows: ReadonlyArray<SavedViewRow>;
    status: ConsoleSectionStatus;
    count: number;
  };
  diagnostics: {
    sectionStatus: Partial<Record<string, ConsoleSectionStatus>>;
    sectionLimit: number;
  };
};

type SavedViewRow = {
  id?: string;
  name?: string | null;
  queueType?: string | null;
  /** Server-projected (ReviewerOpsSavedViewProjection). */
  createdByUserId?: string | null;
  visibility?: "PRIVATE" | "TEAM" | null;
  filter?: {
    queue?: ReviewerOpsQueueType;
    onlyMine?: boolean;
  };
};

type TabId = "queue" | "mine";
const TABS: ReadonlyArray<{ id: TabId; label: string; description: string }> = [
  { id: "queue", label: "Unassigned", description: "Reviews waiting for an owner" },
  { id: "mine", label: "Assigned to me", description: "Reviews you own" },
];

// ---------------------------------------------------------------------------
// Phase 7D — presentational tone mapping for the shared <Badge>. These map
// the OPERATIONAL status / priority / severity vocabulary onto the design
// system's semantic tones. They never change WHICH value renders — a null
// value still renders the honest "—" placeholder, never a fabricated chip.
// ---------------------------------------------------------------------------

function priorityTone(priority: string | null | undefined): BadgeTone {
  switch ((priority ?? "").toUpperCase()) {
    case "CRITICAL":
    case "URGENT":
    case "HIGH":
      return "risk";
    case "MEDIUM":
      return "pending";
    case "LOW":
      return "info";
    default:
      return "neutral";
  }
}

function statusTone(status: string | null | undefined): BadgeTone {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "verified";
  if (s === "REJECTED" || s === "ARCHIVED") return "risk";
  if (s === "ESCALATED" || s === "NEEDS_INFORMATION") return "pending";
  if (s === "ASSIGNED" || s === "IN_REVIEW" || s === "QUEUED" || s === "SUBMITTED") {
    return "info";
  }
  return "neutral";
}

/** A due date as a person reads it; "—" when there is none. */
function formatDue(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export type ReviewerConsoleProps = {
  /**
   * The active reviewer workspace (Team) id resolved from
   * `ctx.activeSpace` upstream. When null, the component renders
   * the operator-safe "no workspace" panel rather than firing
   * a request with a placeholder.
   */
  teamId: string | null;
  /** Open the per-workflow inspector for a row. */
  onOpenRow?: (row: QueueRow) => void;
  /**
   * TEAM-UI-SPEC (structure) — the hub's local tabs, rendered directly UNDER
   * the page header (header → hub nav → content), the order every hub page
   * uses.
   */
  hubNav?: ReactNode;
};

/** TEAM-UI-SPEC (structure) — the hub page's title and plain subtitle. */
export const MY_REVIEWS_TITLE = "My reviews";
export const MY_REVIEWS_SUBTITLE =
  "Reviews waiting for an owner and reviews assigned to you.";

export function ReviewerConsole({
  teamId,
  onOpenRow,
  hubNav,
}: ReviewerConsoleProps) {
  // TEAM-SPEC R1 — the bulk bar is offered where the API serves bulk review:
  // the active workspace's plan includes the Team review tools AND the role
  // holds the bulk capability (OWNER / ADMIN). The workspace kind is not asked:
  // POST /v1/reviewer-ops/reviews/bulk has no kind refusal.
  const bulkPlanIncluded = usePlanFeatureGate("reviewQueuesIncluded");
  const bulkRoleAllowed = useCan("BULK_ACTIONS");
  const bulkEnabled = bulkPlanIncluded && bulkRoleAllowed;
  // TEAM-UI-SPEC §4 — the one row secondary ("Assign") is offered only where
  // the API would accept it: an unassigned, non-terminal row and a viewer
  // holding REVIEW_ASSIGN (`review.assign`). "View workspace health" moved to
  // the Monitoring (SLA) page (TEAM-UI-SPEC §3).
  const canAssign = useCan("REVIEW_ASSIGN");
  const picker = useReviewerPicker(teamId);
  const hasRoutingRecommendations = useHasRoutingRecommendations(teamId);
  const [envelope, setEnvelope] = useState<ConsoleEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("queue");
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  // Phase 12 Point 4 — bulk triage selection. The selection is scoped
  // to the rows currently rendered on the Queue / Mine tabs; switching
  // tab or reloading the envelope clears it so a stale id set can never
  // be submitted against a queue the operator is no longer looking at.
  const [bulkSelection, setBulkSelection] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  // G3.2 — per-tab pagination. The aggregator caps every section at
  // SECTION_LIMIT=25; once the operator clicks "Load more" or "View
  // all" we fall through to the per-tab endpoint with a higher
  // bounded limit. The aggregator stays unchanged so the initial
  // render remains fast.
  const [pagination, setPagination] = useState<
    Record<PaginatedTab, TabPagination>
  >(() => buildInitialPagination());
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // PRO-R2Z-04 — the advertised "/" filter narrows the visible rows (any row
  // whose id or text contains what was typed).
  const [filterText, setFilterText] = useState("");
  const applyRowFilter = useCallback(
    <T,>(rows: ReadonlyArray<T>): ReadonlyArray<T> => {
      const q = filterText.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    },
    [filterText],
  );

  // G3.2 — step-up control wired into the inline-action flow. The
  // workspace flag drives when the backend returns 401
  // STEP_UP_REQUIRED; the hook surfaces the modal + retries once.
  const stepUp = useStepUpAction({ teamId });

  // Reload the envelope on tab open / workspace switch. The
  // server already bounds every section; we never paginate the
  // envelope itself.
  const reload = useCallback(async () => {
    if (!teamId) {
      setEnvelope(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const json = (await apiFetch(
        `/v1/reviewer-ops/console?teamId=${encodeURIComponent(teamId)}`,
      )) as ConsoleEnvelope;
      setEnvelope(json);
      // Pagination is reset on reload — extended rows would be
      // stale after a mutation. The operator can click Load more
      // again to re-page; the action that triggered the reload
      // wanted fresh data.
      setPagination(buildInitialPagination());
      setSelectionIndex(0);
      // Drop any bulk selection — the row set just changed underneath
      // it, and a stale workflow id must never be re-submitted.
      setBulkSelection(new Set<string>());
    } catch (err) {
      // PRO-R2-14 — the plan refusal in words; otherwise the safe mapped
      // message, never the raw client error string.
      setError(
        isPlanRefusal(err)
          ? PLAN_REFUSAL_COPY
          : toSafeUserError(err, { message: "Reviewer console failed to load." }).message,
      );
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const unfilteredActiveRows = useMemo<ReadonlyArray<QueueRow>>(() => {
    if (!envelope) return [];
    // Phase G3.2 — once the operator paginates, the per-tab extended
    // row set replaces the aggregator's bounded slice for that tab.
    const extended = pagination[activeTab].extendedRows;
    if (extended) return extended;
    return toQueueRows(activeTab === "queue" ? envelope.queue.rows : envelope.mine.rows);
  }, [envelope, activeTab, pagination]);
  const activeRows = useMemo(
    () => applyRowFilter(unfilteredActiveRows),
    [applyRowFilter, unfilteredActiveRows],
  );

  // ---------------------------------------------------------------------------
  // Mutating action runners — every path goes through `useStepUpAction`'s
  // `runStepUpAction` wrapper so a 401 STEP_UP_REQUIRED is intercepted by
  // the modal and the original call is retried with the challenge header.
  // ---------------------------------------------------------------------------

  const flash = useCallback((msg: string) => {
    setActionFlash(msg);
    setTimeout(() => setActionFlash(null), 4000);
  }, []);

  const runAssign = useCallback(
    async (workflowId: string, assignedToUserId: string, note: string | null) => {
      if (!teamId) return;
      const key = `assign:${workflowId}`;
      setActionBusyKey(key);
      setActionError(null);
      try {
        // T-036 (stage B) — assignment is not a step-up action: no wrapper.
        // Authorization, the eligible-reviewer check and the audit row are
        // the server's.
        await apiFetch(
          `/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/assign`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              assignedToUserId,
              note: note && note.length > 0 ? note : null,
            }),
          },
        );
        setActionState({ kind: "idle" });
        picker.close();
        flash("Reviewer assigned.");
        await reload();
      } catch (err) {
        setActionError(
          toSafeUserError(err, { message: "Could not assign reviewer." }).message,
        );
      } finally {
        setActionBusyKey(null);
      }
    },
    [flash, picker, reload, teamId],
  );

  /** Opens the reviewer picker for one row — only where Assign is offered. */
  const openAssign = useCallback(
    (row: QueueRow) => {
      if (!canAssign || !isRowAssignable(row)) return;
      setActionState({ kind: "assign", workflowId: row.id });
      void picker.open();
    },
    [canAssign, picker],
  );

  // ---------------------------------------------------------------------------
  // Pagination runners — fetch the per-tab endpoint with a bounded
  // higher limit. The aggregator stays unchanged so the initial paint
  // remains fast; this only fires when the operator clicks Load more
  // or View all.
  // ---------------------------------------------------------------------------

  const fetchExtendedRows = useCallback(
    async (tab: PaginatedTab, nextLimit: number) => {
      if (!teamId) return;
      const capped = Math.min(nextLimit, TAB_LIMIT_CAPS[tab]);
      setPagination((p) => ({
        ...p,
        [tab]: { ...p[tab], loading: true, error: null, limit: capped },
      }));
      try {
        const queueType = tab === "queue" ? "UNASSIGNED" : "MY_REVIEWS";
        const json = (await apiFetch(
          `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${queueType}&limit=${capped}`,
        )) as { rows: ReadonlyArray<unknown>; nextCursor: string | null };
        const extendedRows = toQueueRows(json.rows);
        const hasMore =
          json.nextCursor !== null && capped < TAB_LIMIT_CAPS[tab];
        setPagination((p) => ({
          ...p,
          [tab]: {
            extendedRows,
            limit: capped,
            hasMore,
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        setPagination((p) => ({
          ...p,
          [tab]: {
            ...p[tab],
            loading: false,
            error:
              toSafeUserError(err, { message: "Could not load more rows." }).message,
          },
        }));
      }
    },
    [teamId],
  );

  const loadMore = useCallback(
    (tab: PaginatedTab) => {
      const next = pagination[tab].limit + PAGE_STEP;
      void fetchExtendedRows(tab, next);
    },
    [fetchExtendedRows, pagination],
  );

  const viewAll = useCallback(
    (tab: PaginatedTab) => {
      void fetchExtendedRows(tab, TAB_LIMIT_CAPS[tab]);
    },
    [fetchExtendedRows],
  );

  const resetPagination = useCallback((tab: PaginatedTab) => {
    setPagination((p) => ({ ...p, [tab]: emptyPagination() }));
  }, []);

  /**
   * Keyboard navigation. Bounded action list:
   *   * j / k         — move selection within the active tab
   *   * Enter         — open the focused row (delegates to
   *                     `onOpenRow`)
   *   * a             — assign the focused row (unassigned rows,
   *                     when the viewer may assign)
   *   * /             — focus the in-tab filter input
   *
   * Ctrl/Cmd+K is NOT handled here (TEAM-SPEC §3): it opens the app-wide
   * "Jump to a page" palette only. The console's own command palette bound
   * the same chord on window and both opened at once.
   *
   * Approve / Reject are intentionally NOT inline-keyboard-bound —
   * those flows live in the inspector where the full risk + adaptive
   * gate context renders.
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Avoid swallowing keys that the user is typing into a real
      // input — the filter / action modals / future inline edits.
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable);
      // While an action dialog is open the canonical Modal owns the keyboard
      // (Escape, focus trap); the console's shortcuts stay quiet.
      if (actionState.kind !== "idle") return;
      // Chords belong to the app (Ctrl/Cmd+K is the global page palette).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField) return;
      if (e.key === "j") {
        setSelectionIndex((i) => Math.min(i + 1, activeRows.length - 1));
        e.preventDefault();
        return;
      }
      if (e.key === "k") {
        setSelectionIndex((i) => Math.max(i - 1, 0));
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        const row = activeRows[selectionIndex];
        if (row && onOpenRow) {
          onOpenRow(row);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "/") {
        filterInputRef.current?.focus();
        e.preventDefault();
        return;
      }
      // `a` mirrors the row's Assign: only where that button is offered.
      if (e.key.toLowerCase() === "a") {
        const row = activeRows[selectionIndex];
        if (!row || !canAssign || !isRowAssignable(row)) return;
        e.preventDefault();
        openAssign(row);
      }
    },
    [activeRows, actionState.kind, canAssign, onOpenRow, openAssign, selectionIndex],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!teamId) {
    return (
      <PageShell
        className="reviewer-console reviewer-console--no-workspace"
        header={<ReviewPageHeader title={MY_REVIEWS_TITLE} />}
      >
        {hubNav}
        <section className="app-panel">
          <EmptyState
            title="Reviewer Console is workspace-scoped"
            purpose="Switch into a team workspace from the top-bar workspace switcher to open the queue."
          />
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="reviewer-console"
      data-active-tab={activeTab}
      header={
        /* TEAM-UI-SPEC (structure) — the canonical review header: icon title
           row, plain subtitle, no eyebrow. The keyboard shortcuts stay in the
           "?" shortcuts help, not in the subtitle. */
        <ReviewPageHeader title={MY_REVIEWS_TITLE} subtitle={MY_REVIEWS_SUBTITLE} />
      }
    >
      {hubNav}

      {/* TEAM-UI-SPEC (structure) — the full-width "HELP · REVIEWER
          OPERATIONS" ContextualHelp bar is removed exactly as Evidence
          Library removed its HELP bar: not part of the approved composition.
          The reviewer-ops help topic stays registered in the help centre. */}

      {/* Review automation only: this page's SLA and escalation figures are
          produced by the reviewer reconcile sweep, so a stale sweep is said
          here, in one line. Unrelated platform checks are not. Global service
          status lives in the header indicator. */}
      <RuntimeStatusBanner requires={["reviewAutomation"]} />

      {/* Routing recommendations — TEAM-UI-SPEC §3: shown only when there
          are any (no empty "No active routing recommendations" panel). */}
      {hasRoutingRecommendations ? (
        <ReviewerRoutingRecommendationsPane teamId={teamId} />
      ) : null}

      <nav
        className="reviewer-console__tabs app-tabs"
        role="tablist"
        aria-label="Review slice"
      >
        {TABS.map((t) => {
          const status =
            envelope?.diagnostics.sectionStatus[t.id] ?? "ok";
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(t.id);
                setSelectionIndex(0);
                // A bulk selection belongs to the rows it was made on.
                setBulkSelection(new Set<string>());
                setBulkResult(null);
              }}
              data-section-status={status}
              data-tab-id={t.id}
              className={active ? "app-tab is-active" : "app-tab"}
              title={t.description}
            >
              {t.label}
              {envelope && status !== "degraded" && typeof envelope[t.id].count === "number" ? (
                <span className="app-tab__count" data-tab-count>
                  {envelope[t.id].count}
                </span>
              ) : envelope ? (
                <span className="app-tab__count" data-tab-count-unknown aria-label="count not available">
                  —
                </span>
              ) : null}
              {status === "degraded" ? (
                <Badge
                  tone="pending"
                  title="This section failed to load; the other slice is unaffected."
                >
                  Not loaded
                </Badge>
              ) : null}
            </button>
          );
        })}
      </nav>

      {loading ? (
        <p className="app-field-help" data-reviewer-console-status aria-live="polite">
          Loading reviewer console…
        </p>
      ) : null}
      {error ? (
        <div className="app-alert app-alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      {actionError ? (
        <div className="app-alert app-alert--danger" role="alert" data-reviewer-action-error>
          {actionError}
        </div>
      ) : null}
      {actionFlash ? (
        <div className="app-alert app-alert--ok" role="status" data-reviewer-action-flash>
          {actionFlash}
        </div>
      ) : null}

      {envelope ? (
        <>
          {/* In-tab filter — `/` focuses this input. Bounded to the rows
              already loaded; Queues has every server-side filter. */}
          <div className="reviewer-console__filter">
            <input
              ref={filterInputRef}
              type="text"
              className="app-input"
              placeholder="Filter visible rows (press /)…"
              aria-label="Filter visible rows"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          {/* Phase 12 Point 4 — bulk triage over the visible queue rows.
              Server-side authority is unchanged: the backend enforces the
              plan, `review.bulk`, adaptive runtime and step-up on every
              submitted workflow. TEAM-SPEC R1 — the bar is offered on the
              plan feature plus the role capability, never on workspace kind. */}
          <ReviewerBulkOpsBar
            teamId={teamId}
            selection={bulkSelection}
            callerUserId={envelope.reviewer.userId ?? null}
            enabled={bulkEnabled}
            onClearSelection={() => setBulkSelection(new Set<string>())}
            onMutated={() => void reload()}
            onResult={setBulkResult}
            runStepUpAction={stepUp.runStepUpAction}
          />
          <QueueTable
            rows={activeRows}
            selectionIndex={selectionIndex}
            busyKey={actionBusyKey}
            canAssign={canAssign}
            selectable={bulkEnabled}
            bulkSelection={bulkSelection}
            bulkResult={bulkResult}
            onToggleRow={(wid) =>
              setBulkSelection((s) => {
                const next = new Set(s);
                if (next.has(wid)) next.delete(wid);
                else next.add(wid);
                return next;
              })
            }
            onToggleAll={(ids, allSelected) =>
              setBulkSelection(allSelected ? new Set<string>() : new Set(ids))
            }
            onAssign={openAssign}
          />
          <PaginationFooter
            tab={activeTab}
            state={pagination[activeTab]}
            cap={TAB_LIMIT_CAPS[activeTab]}
            onLoadMore={() => loadMore(activeTab)}
            onViewAll={() => viewAll(activeTab)}
            onReset={() => resetPagination(activeTab)}
          />

          {/* Phase B.3 — multi-stage review summary. Workspace-scoped
              counts of workflows by derived review state (first /
              second review required, conflict pending adjudication,
              resolved). Read-only; the adjudication actions live on
              the per-workflow inspector. */}
          {teamId ? <MultiStageReviewSummaryCard teamId={teamId} /> : null}

          {/* G3.2 — Saved views sidebar with Create + Delete + Apply.
              Rename is not supported (no backend PATCH endpoint). */}
          <SavedViewsPanel
            teamId={teamId}
            activeTab={activeTab}
            views={envelope.savedViews.rows}
            onChanged={() => void reload()}
          />
        </>
      ) : null}

      {actionState.kind === "assign" && picker.state ? (
        <ReviewerPickerModal
          state={picker.state}
          title="Assign reviewer"
          description={`Review ${shortId(actionState.workflowId)}`}
          busy={actionBusyKey === `assign:${actionState.workflowId}`}
          onRetry={() => void picker.open()}
          onCancel={() => {
            picker.close();
            setActionState({ kind: "idle" });
          }}
          onSelect={(assigneeUserId) =>
            void runAssign(actionState.workflowId, assigneeUserId, null)
          }
        />
      ) : null}

      {/* Step-up modal — surfaces only when a mutation hits the
          backend's STEP_UP_REQUIRED gate. Otherwise it stays
          dormant. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

/**
 * TEAM-UI-SPEC §3 — routing recommendations show only when there are any.
 * A bounded probe of the same endpoint the pane reads; any failure (or a
 * refusal) reads as "none", so the console never shows an empty or error
 * panel for an advisory feature.
 */
function useHasRoutingRecommendations(teamId: string | null): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    setHas(false);
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/reviewer/routing-recommendations?teamId=${encodeURIComponent(teamId)}`)
      .then((res: { recommendations?: ReadonlyArray<unknown> }) => {
        if (!cancelled) setHas(Array.isArray(res?.recommendations) && res.recommendations.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHas(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);
  return has;
}

/** Assign is offered on a non-terminal row that has no owner yet. */
function isRowAssignable(row: QueueRow): boolean {
  return isQueueRowActionable(row) && !row.assignedToUserId && row.id.length > 0;
}

// ---------------------------------------------------------------------------
// Action state machine — drives which (if any) inline-action modal renders.
// ---------------------------------------------------------------------------

type ActionState =
  | { kind: "idle" }
  | { kind: "assign"; workflowId: string };

// ---------------------------------------------------------------------------
// G3.2 — Pagination. Each tab tracks its own bounded "extended" view
// once the operator chooses to look past the aggregator's 25-row cap.
// ---------------------------------------------------------------------------

type PaginatedTab = TabId;

type TabPagination = {
  /**
   * Rows currently displayed in place of the aggregator's slice. Null
   * means the operator has not paginated — the aggregator's bounded
   * 25-row sample is in effect.
   */
  extendedRows: ReadonlyArray<QueueRow> | null;
  limit: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

const PAGE_STEP = 25;
const TAB_LIMIT_CAPS: Record<PaginatedTab, number> = {
  queue: 100,
  mine: 100,
};

function buildInitialPagination(): Record<PaginatedTab, TabPagination> {
  return {
    queue: emptyPagination(),
    mine: emptyPagination(),
  };
}

function emptyPagination(): TabPagination {
  return {
    extendedRows: null,
    limit: PAGE_STEP,
    hasMore: true,
    loading: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Queue table — rows are `QueueRow` (shared `toQueueRow` mapping).
//
// TEAM-UI-SPEC §4: `.app-table` in an `.app-table-surface`, riding the shared
// `[data-responsive]` card cutover below 720 px, arranged by
// review-surfaces.css into the compact two-line row (ref + priority; status +
// due; Open + the one secondary). The keyboard-selected row uses Evidence
// Library's selected-row style (`data-selected`).
// ---------------------------------------------------------------------------

function QueueTable({
  rows,
  selectionIndex,
  onAssign,
  busyKey,
  canAssign,
  selectable,
  bulkSelection,
  bulkResult,
  onToggleRow,
  onToggleAll,
}: {
  rows: ReadonlyArray<QueueRow>;
  selectionIndex: number;
  onAssign: (row: QueueRow) => void;
  busyKey: string | null;
  /** The viewer holds REVIEW_ASSIGN. */
  canAssign: boolean;
  /** Bulk checkboxes render only where bulk is offered (TEAM-SPEC R1). */
  selectable: boolean;
  bulkSelection: ReadonlySet<string>;
  bulkResult: BulkResult | null;
  onToggleRow: (workflowId: string) => void;
  onToggleAll: (workflowIds: ReadonlyArray<string>, allSelected: boolean) => void;
}) {
  if (rows.length === 0) {
    return (
      <section className="app-panel reviewer-console__empty">
        <EmptyState
          title="No reviews in this slice"
          purpose="No reviews match this slice right now. Switch slice above, or open Queues for every filter."
        />
      </section>
    );
  }
  // Bulk selection operates on the workflow ids actually rendered.
  const selectableIds = rows.map((r) => r.id).filter((id) => id.length > 0);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => bulkSelection.has(id));
  const someSelected = selectableIds.some((id) => bulkSelection.has(id));
  return (
    <div className="app-table-surface app-table-surface--scroll">
      <table
        role="grid"
        className="app-table review-rows"
        data-responsive
        data-review-selectable={selectable ? "true" : "false"}
        data-reviewer-console-table
      >
        <thead>
          <tr>
            {selectable ? (
              <th>
                <input
                  type="checkbox"
                  className="app-checkbox"
                  aria-label="Select all queue rows"
                  data-reviewer-bulk-select-all
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={() => onToggleAll(selectableIds, allSelected)}
                  disabled={selectableIds.length === 0}
                />
              </th>
            ) : null}
            <th>Evidence</th>
            <th>Stage</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Due</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const selected = idx === selectionIndex;
            const actionable = isQueueRowActionable(row);
            const wid = row.id;
            const assignBusy = busyKey === `assign:${wid}`;
            const offerAssign = canAssign && isRowAssignable(row);
            const bulkSelected = wid.length > 0 && bulkSelection.has(wid);
            const ref = row.evidenceId
              ? recordReference("Evidence", row.evidenceId)
              : recordReference("Review", wid);
            const inspectorHref = `/reviewer-ops/${encodeURIComponent(wid)}`;
            // Per-row outcome marker from the most recent bulk submit,
            // so the reviewer can see which rows just succeeded vs
            // failed without re-fetching.
            const outcome = bulkResult
              ? (bulkResult.items.find((i) => i.workflowId === wid) ?? null)
              : null;
            return (
              <tr
                key={row.id || `row-${idx}`}
                data-selected={selected}
                data-reviewer-row-actionable={actionable ? "true" : "false"}
                data-reviewer-workflow-id={wid}
                data-reviewer-bulk-selected={bulkSelected ? "true" : "false"}
                data-reviewer-bulk-last-outcome={
                  outcome ? (outcome.ok ? "ok" : "failed") : ""
                }
              >
                {selectable ? (
                  <td data-review-cell="check" data-label="">
                    <input
                      type="checkbox"
                      className="app-checkbox"
                      aria-label={`Select review of ${ref}`}
                      data-reviewer-bulk-row-checkbox={wid}
                      checked={bulkSelected}
                      onChange={() => onToggleRow(wid)}
                      disabled={wid.length === 0}
                    />
                  </td>
                ) : null}
                <td data-review-cell="ref" data-label="Evidence">
                  {wid ? (
                    <Link href={inspectorHref} className="review-rows__ref" data-reviewer-row-ref>
                      {ref}
                    </Link>
                  ) : (
                    <span className="review-rows__ref">{ref}</span>
                  )}
                </td>
                <td data-review-cell="extra" data-label="Stage" data-reviewer-row-stage>
                  {row.stage ? identifierLabel(row.stage) : "—"}
                </td>
                <td data-review-cell="status" data-label="Status">
                  {row.status ? (
                    <Badge tone={statusTone(row.status)} subtle>
                      {identifierLabel(row.status)}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-review-cell="priority" data-label="Priority">
                  {row.priority ? (
                    <Badge tone={priorityTone(row.priority)} subtle>
                      {identifierLabel(row.priority)}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-review-cell="due" data-label="Due" data-reviewer-row-due>
                  <span className="app-table__muted">{formatDue(row.dueAt)}</span>
                </td>
                <td data-review-cell="actions" data-label="">
                  <div className="app-table__actions" data-reviewer-row-actions={wid}>
                    {wid ? (
                      <Link
                        href={inspectorHref}
                        className="app-ghost-action"
                        data-reviewer-action="open-inspector"
                        data-reviewer-workflow-id={wid}
                        title="Open the review (Enter)"
                      >
                        Open
                      </Link>
                    ) : null}
                    {offerAssign ? (
                      <button
                        type="button"
                        className="app-secondary-action"
                        data-reviewer-action="assign"
                        data-reviewer-workflow-id={wid}
                        disabled={assignBusy}
                        aria-busy={assignBusy || undefined}
                        onClick={() => onAssign(row)}
                        title="Assign reviewer (a)"
                      >
                        {assignBusy ? "Assigning…" : "Assign"}
                      </button>
                    ) : null}
                    {outcome ? (
                      <span
                        className={
                          outcome.ok
                            ? "app-chip app-chip--ok review-rows__outcome"
                            : "app-chip app-chip--warn review-rows__outcome"
                        }
                        data-reviewer-bulk-row-outcome={outcome.ok ? "ok" : "failed"}
                      >
                        {outcome.ok
                          ? "Applied"
                          : `Not applied: ${outcome.message ?? identifierLabel(outcome.errorCode ?? "error")}`}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// G3.2 — Pagination footer. Renders Load more / View all once the
// operator has data, plus a clear "showing N rows" status. The
// console aggregator still caps the initial paint at 25 rows; this
// footer is the bounded escape hatch.
// ---------------------------------------------------------------------------

function PaginationFooter({
  tab,
  state,
  cap,
  onLoadMore,
  onViewAll,
  onReset,
}: {
  tab: PaginatedTab;
  state: TabPagination;
  cap: number;
  onLoadMore: () => void;
  onViewAll: () => void;
  onReset: () => void;
}) {
  const extended = state.extendedRows !== null;
  const shownCount = extended ? state.extendedRows!.length : null;
  const atCap = state.limit >= cap;
  return (
    <div
      className="app-inner-surface review-toolbar reviewer-console__pagination"
      data-reviewer-pagination-tab={tab}
      data-reviewer-pagination-limit={state.limit}
      data-reviewer-pagination-has-more={state.hasMore ? "true" : "false"}
    >
      <span className="app-field-help" data-reviewer-pagination-status>
        {extended
          ? `Showing ${shownCount} row${shownCount === 1 ? "" : "s"} (limit ${state.limit}${atCap ? " — workspace max" : ""}).`
          : "Showing first 25 rows from the console aggregator."}
        {state.loading ? " Loading more…" : null}
      </span>
      <span className="review-toolbar__spacer" />
      {state.error ? (
        <span role="alert" className="app-field-error" data-reviewer-pagination-error>
          {state.error}
        </span>
      ) : null}
      {extended ? (
        <button
          type="button"
          className="app-ghost-action"
          data-reviewer-pagination-reset
          onClick={onReset}
          disabled={state.loading}
          title="Return to the bounded 25-row aggregator slice"
        >
          Reset
        </button>
      ) : null}
      {!extended || (state.hasMore && !atCap) ? (
        <button
          type="button"
          className="app-secondary-action"
          data-reviewer-pagination-load-more
          onClick={onLoadMore}
          disabled={atCap || state.loading}
          aria-busy={state.loading || undefined}
        >
          {state.loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
      {!atCap ? (
        <button
          type="button"
          className="app-secondary-action"
          data-reviewer-pagination-view-all
          onClick={onViewAll}
          disabled={state.loading}
          title={`Load up to the workspace cap of ${cap} rows`}
        >
          View all (≤{cap})
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved views — Create + Delete + Apply.
// ---------------------------------------------------------------------------

/**
 * PRO-R2Z-05 — the queue slice a console tab stands for, saved with the view
 * so applying it opens that slice. A tab with no queue slice saves nothing.
 */
const TAB_SAVED_VIEW_QUEUE: Readonly<Record<TabId, "UNASSIGNED" | "MY_REVIEWS">> = {
  queue: "UNASSIGNED",
  mine: "MY_REVIEWS",
};

export function SavedViewsPanel({
  teamId,
  activeTab,
  views,
  onChanged,
}: {
  teamId: string;
  activeTab: TabId;
  views: ReadonlyArray<SavedViewRow>;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "TEAM">("PRIVATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { confirm } = useConfirmAction();
  // Closure 2 ("sem" item 4) — Delete is offered on the server's rule only.
  const platform = useOptionalPlatformContext();
  const viewerUserId = platform?.envelope?.user?.id ?? null;
  const viewerRole = roleInWorkspace(platform?.envelope ?? null, teamId);
  const applySavedView = useCallback((view: SavedViewRow) => {
    const queue = resolveSavedViewQueue(view);
    if (queue) {
      window.location.href = `/review/queues?queue=${encodeURIComponent(queue)}`;
      return;
    }
    if (view.filter?.onlyMine) {
      window.location.href = "/review/queues?queue=MY_REVIEWS";
      return;
    }
    setError(
      "This saved view does not expose a queue filter the console can apply directly yet.",
    );
  }, []);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    const queue = TAB_SAVED_VIEW_QUEUE[activeTab];
    if (!queue) {
      setError("This slice cannot be saved. Switch to Unassigned or Assigned to me first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/reviewer-ops/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim(),
          visibility,
          filter: { teamId, queue },
        }),
      });
      setName("");
      setCreating(false);
      onChanged();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Could not create saved view." }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [activeTab, name, onChanged, teamId, visibility]);

  const remove = useCallback(
    async (id: string) => {
      setDeletingId(id);
      setError(null);
      try {
        await apiFetch(
          `/v1/reviewer-ops/saved-views/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" },
        );
        onChanged();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not delete saved view." }).message,
        );
      } finally {
        setDeletingId(null);
      }
    },
    [onChanged, teamId],
  );

  return (
    <section
      className="app-panel reviewer-console__saved-views"
      data-reviewer-saved-views-panel
      aria-labelledby="reviewer-saved-views-title"
    >
      <div className="app-panel__head">
        <h2 className="app-panel__title" id="reviewer-saved-views-title">
          Saved queue views
        </h2>
        {!creating ? (
          <button
            type="button"
            className="app-secondary-action"
            data-reviewer-saved-view-create
            onClick={() => setCreating(true)}
          >
            Save current view
          </button>
        ) : null}
      </div>
      <div className="app-panel__body review-panel-stack">
        {error ? (
          <p role="alert" className="app-field-error" data-reviewer-saved-view-error>
            {error}
          </p>
        ) : null}

        {creating ? (
          <form
            className="app-inner-surface app-panel__body review-panel-stack"
            data-reviewer-saved-view-form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div>
              <label className="app-field-label" htmlFor="reviewer-saved-view-name">
                View name
              </label>
              <input
                id="reviewer-saved-view-name"
                autoFocus
                type="text"
                className="app-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                data-reviewer-saved-view-name
                required
              />
            </div>
            <div>
              <span className="app-field-label">Visibility</span>
              <AppListbox
                value={visibility}
                ariaLabel="Visibility"
                options={[
                  { value: "PRIVATE", label: "Private — only you" },
                  { value: "TEAM", label: "Workspace — everyone in this team" },
                ]}
                onChange={(next) => setVisibility(next as "PRIVATE" | "TEAM")}
                triggerProps={{ "data-reviewer-saved-view-visibility": "" }}
              />
            </div>
            <div className="review-panel__actions">
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => {
                  setCreating(false);
                  setName("");
                  setError(null);
                }}
                data-reviewer-saved-view-cancel
              >
                Cancel
              </button>
              <button
                type="submit"
                className="app-primary-action"
                data-reviewer-saved-view-submit
                disabled={!name.trim() || busy}
                aria-busy={busy || undefined}
              >
                {busy ? "Saving…" : "Save view"}
              </button>
            </div>
          </form>
        ) : null}

        {views.length === 0 ? (
          <p className="app-field-help" data-reviewer-saved-views-empty>
            No saved views yet. Save the current queue slice to return to it
            later.
          </p>
        ) : (
          <ul className="review-tools">
            {views.map((v, idx) => {
              const vid = v.id ?? "";
              const deleting = deletingId === vid;
              return (
                <li
                  key={v.id ?? idx}
                  className="review-tools__row review-picker__row"
                  data-reviewer-saved-view-row={vid}
                >
                  <button
                    type="button"
                    className="app-ghost-action"
                    data-reviewer-saved-view-apply={vid}
                    onClick={() => applySavedView(v)}
                  >
                    {v.name ?? `View ${idx + 1}`}
                    {v.queueType ? ` · ${identifierLabel(v.queueType)}` : ""}
                  </button>
                  {mayDeleteReviewerSavedView(v, viewerUserId, viewerRole) ? (
                    <button
                      type="button"
                      className="app-secondary-action app-secondary-action--danger"
                      data-reviewer-saved-view-delete={vid}
                      disabled={!vid || deleting}
                      aria-busy={deleting || undefined}
                      onClick={() => {
                        if (!vid) return;
                        void (async () => {
                          const ok = await confirm({
                            title: "Delete saved view?",
                            description: `Delete saved view "${v.name ?? vid}"?`,
                            confirmLabel: "Delete view",
                            tone: "warning",
                            testId: "reviewer-saved-view-delete",
                          });
                          if (ok) void remove(vid);
                        })();
                      }}
                      title="Delete saved view"
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// `DEFAULT_TEAM_PLACEHOLDER` is exported as a sentinel for tests that
// need to verify the no-workspace branch renders the operator-safe
// panel rather than firing a request.
export { DEFAULT_TEAM_PLACEHOLDER };
