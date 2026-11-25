"use client";

/**
 * THE REVIEW INBOX — `/review` (team remediation stage D).
 *
 * One Inbox with views replaces the "My reviews" console and the separate
 * Queues page (T-065). A view is a queue slice the reviewer-ops queue route
 * serves; the URL (`?view=`) and the highlighted view always agree because the
 * page READS the view from the URL and choosing a view WRITES the URL.
 * `/review/queues?queue=X` redirects to `/review?view=X`.
 *
 *   - Columns: Evidence · Status · Due · Assignee · Actions (the duplicate
 *     Workflow column is gone). Status is the lifecycle word plus ONE
 *     sentence "Needs attention because …" (T-069) in plain status text with
 *     severity tones (T-071); Normal priority says nothing (T-070).
 *   - Due is the governing deadline from the SLA rollup when the row was
 *     scored, else the workflow's due date (T-096).
 *   - Assignee is the server's identity (display name or masked e-mail), the
 *     same rendering as the picker and the lineage (T-086).
 *   - A failed load or a plan refusal shows the alert and Retry only — never
 *     the confirmed-empty copy (T-067).
 *   - The QC line appears only while samples are pending and only where the
 *     QC page opens (T-068). The evidence-request panel lives on Requests
 *     (T-066); Copilot output checks live in Monitoring → Quality (T-080).
 *   - Keyboard: the INBOX_KEYMAP, and the help lists exactly the registered
 *     keys (T-094). Opening a row carries the view, so Back on the Review page
 *     returns here and Next item moves within the view (T-074, T-077).
 *   - Bulk: one bar (the reviewer-ops bulk door, step-up honoured) with
 *     "Assign to…" and coded-value tags that are labelled as tags, never as
 *     decisions (T-082).
 *   - Initial load: the queue page, its signals, the saved views and the QC
 *     count — no console aggregator, no per-row suggestion ranking (T-095).
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { REVIEWER_VERDICTS, type ReviewerOpsQueueType } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDate } from "../../lib/date";
import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../lib/feedback/plan-refusal";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { mayDeleteReviewerSavedView } from "../../lib/evidence/saved-view-sharing";
import { useActiveSpaceId, useCan, usePlanFeatureGate } from "../../lib/platform-context";
import { useOptionalPlatformContext } from "../../lib/platform-context/PlatformContextProvider";
import { roleInWorkspace } from "../../lib/platform-context/actorRole";
import { recordReference } from "../../lib/short-id";
import { bulkAssign, bulkDecide, resolveSavedViewQueue, type BulkOutcome } from "../../lib/reviewer-workspace/reviewer-api";
import {
  INBOX_EMPTY_COPY,
  INBOX_TITLE,
  INBOX_VIEW_LABELS,
  MORE_INBOX_VIEWS,
  primaryInboxViewsFor,
  inboxHref,
  inboxViewFromParams,
  isInboxView,
  reviewHrefFromInbox,
  type InboxView,
} from "../../lib/reviewer-workspace/inbox-views";
import { INBOX_KEYMAP, useKeymap } from "../../lib/reviewer-workspace/review-keymap";
import {
  isNotablePriority,
  priorityLabel,
  priorityTone,
  reviewLifecycleLabel,
  reviewLifecycleTone,
} from "../../lib/reviewer-workspace/review-status";
import { assigneeLabel } from "../../lib/reviewer-workspace/reviewer-identity";
import { AppListbox } from "../app-primitives/AppListbox";
import { AppStatusText } from "../app-primitives/AppStatusText";
import { Modal } from "../cases-experience/matter-modals/Modal";
import { StepUpModal, isStepUpCancelled, stepUpCancelMessage, useStepUpAction } from "../identity-security/StepUpModal";
import { RuntimeStatusBanner } from "../operational";
import { PageShell } from "../ui";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { EmptyState } from "../ui/EmptyState";
import { ReviewerShortcutsHelp } from "../../app/(app)/reviewer-ops/components/ReviewerShortcutsHelp";
import { ReviewHubNav, ReviewToolsPanel } from "./ReviewHubNav";
import { ReviewPageHeader } from "./ReviewPageHeader";
import { ReviewerBulkOpsBar, type BulkResult } from "./ReviewerBulkOpsBar";
import { ReviewerPickerModal, useReviewerPicker } from "./ReviewerPickerModal";
import { QueueAttentionLine, QueueIntelligenceNotice, useQueueIntelligence } from "./queueIntelligence";
import { isQueueRowActionable, toQueueRows, type QueueRow } from "./queueRow";
import { useReviewDestination } from "./reviewDestination";
import "./review-surfaces.css";

/** First page and each "Load more" (the route caps `limit` at 100). */
const INBOX_PAGE_SIZE = 50;
/** Bulk server cap. */
const BULK_ACTION_CAP = 100;

export const INBOX_SUBTITLE = "Reviews in this workspace, one view at a time.";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: QueueRow[]; nextCursor: string | null };

type QcLine = { kind: "none" } | { kind: "pending"; count: number };

type SavedViewRow = {
  id?: string;
  name?: string | null;
  queueType?: string | null;
  createdByUserId?: string | null;
  visibility?: "PRIVATE" | "TEAM" | null;
  filter?: { queue?: ReviewerOpsQueueType; onlyMine?: boolean };
};

type BulkTag = "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";

/**
 * T-082 — a coded value is a TAG on the review, never a decision: the bulk
 * options read "Tag: proposed approve", never a bare decision verb.
 */
export const BULK_TAG_LABELS: Readonly<Record<BulkTag, string>> = {
  APPROVE: "Tag: proposed approve",
  REJECT: "Tag: proposed reject",
  ESCALATE: "Tag: proposed escalation",
  NEEDS_INFO: "Tag: needs information",
};
const BULK_TAGS = REVIEWER_VERDICTS.filter((v) => v !== "PENDING") as ReadonlyArray<BulkTag>;

/** A bulk refusal as a person reads it. */
function bulkReasonLabel(code: string | null | undefined): string {
  switch (code) {
    case "NOT_PERMITTED":
    case "FORBIDDEN":
      return "your role cannot do this";
    case "WORKSPACE_NOT_FOUND":
      return "not available in this workspace";
    case "NOT_FOUND":
    case "WORKFLOW_NOT_FOUND":
      return "review not found";
    case "ENTITLEMENT_REQUIRED":
    case "REVIEW_CAPABILITY_NOT_INCLUDED":
      return "not included in this workspace's plan";
    case "ASSIGNEE_NOT_ELIGIBLE":
      return "that reviewer cannot take this review";
    default:
      return "not applied";
  }
}

function evidenceRef(r: QueueRow): string {
  return r.evidenceId ? recordReference("Evidence", r.evidenceId) : recordReference("Review", r.id);
}

export function ReviewInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = useActiveSpaceId();
  const view: InboxView = inboxViewFromParams(searchParams);

  // Bulk eligibility (TEAM-SPEC R1): the plan's Team review tools + the role.
  const bulkPlanIncluded = usePlanFeatureGate("reviewQueuesIncluded");
  const canBulk = useCan("BULK_ACTIONS");
  const canAssign = useCan("REVIEW_ASSIGN");
  const canDecideRole = useCan("REVIEWER_OPS_ACT");
  const bulkEnabled = bulkPlanIncluded && canBulk;
  const bulkAssignAllowed = bulkEnabled && canAssign;
  const bulkTagAllowed = bulkEnabled && canDecideRole;

  const platform = useOptionalPlatformContext();
  const viewerUserId = platform?.envelope?.user?.id ?? platform?.envelope?.account?.userId ?? null;

  const activeTeamRef = useRef<string | null>(teamId);
  activeTeamRef.current = teamId;
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const picker = useReviewerPicker(teamId);
  const [pickerTarget, setPickerTarget] = useState<null | { kind: "BULK" } | { kind: "ROW"; workflowId: string }>(null);
  const [rowAssignBusy, setRowAssignBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    null | { kind: "TAG"; tag: BulkTag } | { kind: "ASSIGN"; assigneeUserId: string }
  >(null);
  const [tag, setTag] = useState<BulkTag | null>(null);
  const stepUp = useStepUpAction({ teamId });

  // ---- The view's rows ------------------------------------------------------
  const loadPage = useCallback(
    async (cursor: string | null) => {
      if (!teamId) return;
      const requestTeamId = teamId;
      const mine = cursor === null ? ++generationRef.current : generationRef.current;
      const stale = () => requestTeamId !== activeTeamRef.current || mine !== generationRef.current;
      const params = new URLSearchParams({ teamId, queue: view, limit: String(INBOX_PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      try {
        const res = (await apiFetch(`/v1/reviewer-ops/queue?${params.toString()}`, { method: "GET" })) as {
          rows?: ReadonlyArray<unknown>;
          nextCursor?: string | null;
        } | null;
        if (stale()) return;
        const pageRows = toQueueRows(res?.rows);
        const next = typeof res?.nextCursor === "string" && res.nextCursor.length > 0 ? res.nextCursor : null;
        if (cursor === null) {
          setLoad({ kind: "ready", rows: pageRows, nextCursor: next });
          setGeneration(mine);
          setSelectionIndex(0);
        } else {
          setLoad((prev) => {
            if (prev.kind !== "ready") return prev;
            const seen = new Set(prev.rows.map((r) => r.id));
            return { kind: "ready", rows: [...prev.rows, ...pageRows.filter((r) => !seen.has(r.id))], nextCursor: next };
          });
        }
      } catch (err) {
        if (stale()) return;
        const code = (err as { code?: string } | null)?.code;
        const message = isPlanRefusal(err)
          ? PLAN_REFUSAL_COPY
          : code === "NOT_PERMITTED" || code === "FORBIDDEN"
            ? "You do not have permission to view this Inbox view."
            : toSafeUserError(err, { message: "This view could not be loaded. Nothing is shown until it loads." }).message;
        if (cursor === null) {
          // T-067 — a failed first page is an error, never a confirmed-empty view.
          setLoad({ kind: "error", message });
        } else {
          setMoreError(toSafeUserError(err, { message: "More reviews could not be loaded." }).message);
          setLoad((prev) => (prev.kind === "ready" ? { ...prev, nextCursor: null } : prev));
        }
      }
    },
    [teamId, view],
  );

  const reload = useCallback(() => {
    setLoad({ kind: "loading" });
    setMoreError(null);
    void loadPage(null);
  }, [loadPage]);

  useEffect(() => {
    setSelection(new Set());
    setBulkResult(null);
    setFilterText("");
    reload();
  }, [reload]);

  const rows = load.kind === "ready" ? load.rows : [];
  const visibleRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [evidenceRef(r), reviewLifecycleLabel(r.status), r.assignee?.displayName ?? "", r.assignee?.maskedEmail ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [rows, filterText]);

  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const { state: intelligence, refresh: refreshIntelligence } = useQueueIntelligence(
    teamId,
    rowIds,
    activeTeamRef,
    `${view}|${generation}`,
  );

  // ---- QC line (T-068) -------------------------------------------------------
  const qcDestination = useReviewDestination("workspace.review_qc", { label: "Open QC samples" });
  const qcOpens = qcDestination?.kind === "link";
  const [qc, setQc] = useState<QcLine>({ kind: "none" });
  useEffect(() => {
    setQc({ kind: "none" });
    if (!teamId || !qcOpens) return;
    let cancelled = false;
    const requestTeamId = teamId;
    apiFetch(`/v1/reviewer-ops/qc/pending-count?teamId=${encodeURIComponent(teamId)}`, { method: "GET" })
      .then((res: { pendingCount?: unknown }) => {
        if (cancelled || requestTeamId !== activeTeamRef.current) return;
        const n = typeof res?.pendingCount === "number" && Number.isFinite(res.pendingCount) ? res.pendingCount : 0;
        setQc(n > 0 ? { kind: "pending", count: n } : { kind: "none" });
      })
      // A refusal or a failure is not a reason to show anything here: QC has
      // its own page and section. No link into a refusal (T-068).
      .catch(() => {
        if (!cancelled) setQc({ kind: "none" });
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, qcOpens]);

  // ---- Saved views -----------------------------------------------------------
  const [savedViews, setSavedViews] = useState<ReadonlyArray<SavedViewRow> | null>(null);
  const loadSavedViews = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = (await apiFetch(`/v1/reviewer-ops/saved-views?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      })) as { views?: ReadonlyArray<SavedViewRow> } | null;
      setSavedViews(Array.isArray(res?.views) ? res!.views! : []);
    } catch {
      setSavedViews(null);
    }
  }, [teamId]);
  useEffect(() => {
    void loadSavedViews();
  }, [loadSavedViews]);

  // ---- Navigation ------------------------------------------------------------
  const goToView = useCallback(
    (next: InboxView) => {
      router.push(inboxHref(next));
    },
    [router],
  );
  const openRow = useCallback(
    (row: QueueRow | undefined, focus = false) => {
      if (!row) return;
      router.push(reviewHrefFromInbox(row.id, view, { focus }));
    },
    [router, view],
  );

  // ---- Assign ------------------------------------------------------------------
  const openPicker = (target: { kind: "BULK" } | { kind: "ROW"; workflowId: string }) => {
    setPickerTarget(target);
    void picker.open();
  };
  const closePicker = () => {
    picker.close();
    setPickerTarget(null);
  };
  async function runRowAssign(workflowId: string, assigneeUserId: string) {
    if (!teamId) return;
    setRowAssignBusy(true);
    try {
      // T-036 (stage B) — assignment is not a step-up action.
      await apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, assignedToUserId: assigneeUserId, note: null }),
      });
      setBanner("Reviewer assigned.");
      closePicker();
      reload();
    } catch (err) {
      setBanner(toSafeUserError(err, { message: "Could not assign reviewer." }).message);
      closePicker();
    } finally {
      setRowAssignBusy(false);
    }
  }
  const rowAssignable = (r: QueueRow) => canAssign && !r.assignedToUserId && isQueueRowActionable(r);

  async function runBulkConfirmed(confirmation: NonNullable<typeof pendingConfirm>) {
    const ids = Array.from(selection).slice(0, BULK_ACTION_CAP);
    let res: unknown;
    try {
      if (confirmation.kind === "TAG") {
        res = await stepUp.runStepUpAction((headers) =>
          bulkDecide({ verdict: confirmation.tag, workflowIds: ids, teamId }, { headers, rethrowChallenges: true }),
        );
      } else {
        res = await bulkAssign({ assigneeUserId: confirmation.assigneeUserId, workflowIds: ids, teamId });
      }
    } catch (err) {
      setBanner(
        isStepUpCancelled(err)
          ? stepUpCancelMessage(err, "Nothing was changed: identity confirmation was cancelled.")
          : toSafeUserError(err, { message: "The bulk action could not be completed. Nothing was changed." }).message,
      );
      setPendingConfirm(null);
      return;
    }
    const action = confirmation.kind === "TAG" ? BULK_TAG_LABELS[confirmation.tag] : "Assign";
    const r = res as { denial?: string; succeeded?: number; total?: number; outcomes?: BulkOutcome[] } | null;
    if (r && typeof r === "object" && "denial" in r && r.denial) {
      setBanner(`${action} refused: ${bulkReasonLabel(r.denial)}.`);
    } else {
      const failed = (r?.outcomes ?? []).filter((o) => !o.ok);
      setBanner(
        `${action}: ${r?.succeeded ?? 0} of ${r?.total ?? ids.length} applied.` +
          (failed.length > 0
            ? ` Not applied: ${failed
                .map((o) => {
                  const row = rows.find((x) => x.id === o.workflowId);
                  return `${row ? evidenceRef(row) : "a review"} (${bulkReasonLabel(o.denial)})`;
                })
                .join(", ")}.`
            : ""),
      );
    }
    setSelection(new Set());
    setPendingConfirm(null);
    reload();
  }

  // ---- Keyboard (T-094) --------------------------------------------------------
  const keyHandlers = useMemo(
    () => ({
      next: () => setSelectionIndex((i) => Math.min(i + 1, Math.max(visibleRows.length - 1, 0))),
      previous: () => setSelectionIndex((i) => Math.max(i - 1, 0)),
      open: () => openRow(visibleRows[selectionIndex]),
      focus: () => openRow(visibleRows[selectionIndex], true),
      ...(canAssign
        ? {
            assign: () => {
              const row = visibleRows[selectionIndex];
              if (row && rowAssignable(row)) openPicker({ kind: "ROW", workflowId: row.id });
            },
          }
        : {}),
      filter: () => filterRef.current?.focus(),
      help: () => setHelpOpen((o) => !o),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleRows, selectionIndex, canAssign, openRow],
  );
  const dialogOpen = helpOpen || pickerTarget !== null || pendingConfirm !== null;
  const helpRows = useKeymap(INBOX_KEYMAP, keyHandlers, !dialogOpen || helpOpen);

  // ---- Render ------------------------------------------------------------------
  const header = <ReviewPageHeader title={INBOX_TITLE} subtitle={INBOX_SUBTITLE} />;

  if (!teamId) {
    return (
      <PageShell className="review-inbox" header={header}>
        <ReviewHubNav active="inbox" />
        <section className="app-panel">
          <EmptyState title="Select a workspace" purpose="Choose an active workspace to see its reviews." />
        </section>
      </PageShell>
    );
  }

  const selectable = bulkEnabled;
  const allIds = visibleRows.map((r) => r.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selection.has(id));

  return (
    <PageShell className="review-inbox review-launcher-clearance" data-review-inbox data-inbox-view={view} header={header}>
      <ReviewHubNav active="inbox" />
      <RuntimeStatusBanner requires={["reviewAutomation"]} />

      {/* T-065 — the views. The URL decides which one is highlighted. */}
      <div className="review-view-bar" data-inbox-views>
        <nav className="app-tabs review-view-tabs" aria-label="Inbox views" data-inbox-view-tabs>
          {primaryInboxViewsFor(canAssign).map((v) => {
            const active = v === view;
            return (
              <Link
                key={v}
                href={inboxHref(v)}
                className={active ? "app-tab is-active" : "app-tab"}
                aria-current={active ? "page" : undefined}
                data-inbox-view-tab={v}
              >
                {INBOX_VIEW_LABELS[v]}
              </Link>
            );
          })}
        </nav>
        <AppListbox<InboxView>
          value={MORE_INBOX_VIEWS.includes(view) ? view : null}
          ariaLabel="More views"
          placeholder="More views"
          options={MORE_INBOX_VIEWS.map((v) => ({ value: v, label: INBOX_VIEW_LABELS[v] }))}
          onChange={(v) => goToView(v)}
          triggerProps={{ "data-inbox-more-views": "" }}
        />
      </div>

      {qc.kind === "pending" && qcDestination?.kind === "link" ? (
        <p className="app-field-help review-inline-line" data-inbox-qc-line={qc.count}>
          {qc.count} quality-control sample{qc.count === 1 ? " is" : "s are"} waiting for a verdict ·{" "}
          <Link href={qcDestination.href} className="app-ghost-action" data-inbox-qc-link>
            Open quality control
          </Link>
        </p>
      ) : null}

      {view === "AWAITING_ADJUDICATION" ? (
        <ChallengedDecisionsHint />
      ) : null}

      {banner ? (
        <div className="app-alert" role="status" data-inbox-banner>
          {banner}
        </div>
      ) : null}

      {load.kind === "loading" ? (
        <p className="app-field-help" aria-live="polite" data-inbox-loading>
          Loading {INBOX_VIEW_LABELS[view].toLowerCase()}…
        </p>
      ) : null}

      {load.kind === "error" ? (
        <div className="app-alert app-alert--danger" role="alert" data-inbox-load-error>
          {load.message}{" "}
          <button type="button" className="app-secondary-action" data-inbox-retry onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}

      {load.kind === "ready" ? (
        <>
          <div className="review-toolbar review-inbox__filter">
            <input
              ref={filterRef}
              type="search"
              className="app-input"
              placeholder="Filter this view (press /)"
              aria-label="Filter this view"
              value={filterText}
              onChange={(e) => {
                setFilterText(e.target.value);
                setSelectionIndex(0);
              }}
              data-inbox-filter
            />
            <span className="app-field-help" data-inbox-count>
              {visibleRows.length} shown{load.nextCursor ? " · more available" : ""}
            </span>
          </div>

          <QueueIntelligenceNotice state={intelligence} onRetry={refreshIntelligence} />

          <ReviewerBulkOpsBar
            teamId={teamId}
            selection={selection}
            callerUserId={viewerUserId}
            enabled={bulkEnabled}
            onClearSelection={() => setSelection(new Set())}
            onMutated={reload}
            onResult={setBulkResult}
            runStepUpAction={stepUp.runStepUpAction}
            rowLabel={(id) => {
              const row = rows.find((r) => r.id === id);
              return row ? evidenceRef(row) : "A review";
            }}
            extraActions={
              <>
                {bulkAssignAllowed ? (
                  <button
                    type="button"
                    className="app-secondary-action"
                    data-inbox-bulk-assign
                    onClick={() => openPicker({ kind: "BULK" })}
                  >
                    Assign to…
                  </button>
                ) : null}
                {bulkTagAllowed ? (
                  <span className="review-bulk-code" data-inbox-bulk-tag-group>
                    <AppListbox<BulkTag>
                      value={tag}
                      ariaLabel="Tag"
                      placeholder="Tag"
                      options={BULK_TAGS.map((t) => ({ value: t, label: BULK_TAG_LABELS[t] }))}
                      onChange={(t) => setTag(t)}
                      triggerProps={{ "data-inbox-bulk-tag-select": "" }}
                    />
                    <button
                      type="button"
                      className="app-secondary-action"
                      data-inbox-bulk-tag-apply
                      disabled={tag === null}
                      title={tag === null ? "Choose a tag first." : "Sets the tag only; it does not decide the review."}
                      aria-describedby="inbox-bulk-tag-help"
                      onClick={() => {
                        if (tag) setPendingConfirm({ kind: "TAG", tag });
                      }}
                    >
                      Apply tag
                    </button>
                    <span id="inbox-bulk-tag-help" className="app-visually-hidden">
                      {tag === null
                        ? "Choose a tag first."
                        : "A tag records a coded value. It does not approve, reject or close any review."}
                    </span>
                  </span>
                ) : null}
              </>
            }
          />

          {visibleRows.length === 0 ? (
            <section className="app-panel" data-inbox-empty={view}>
              <EmptyState
                title={filterText.trim() ? "No reviews in this view match the filter." : INBOX_EMPTY_COPY[view]}
                purpose={
                  filterText.trim()
                    ? "Clear the filter to see every review in this view."
                    : "Choose another view above to see other reviews."
                }
              />
            </section>
          ) : (
            <div className="app-table-surface" data-ui-datatable-scroll>
              <table
                className="app-table review-rows review-cards-900"
                data-responsive
                data-inbox-table
                data-review-selectable={selectable ? "true" : "false"}
              >
                <thead>
                  <tr>
                    {selectable ? (
                      <th>
                        <input
                          type="checkbox"
                          className="app-checkbox"
                          aria-label="Select every review shown"
                          data-inbox-select-all
                          checked={allSelected}
                          onChange={() => setSelection(allSelected ? new Set() : new Set(allIds))}
                        />
                      </th>
                    ) : null}
                    <th>Evidence</th>
                    <th>Status</th>
                    <th>Due</th>
                    <th>Assignee</th>
                    <th>
                      <span className="app-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r, idx) => {
                    const scored = intelligence.kind === "READY" ? intelligence.byWorkflowId.get(r.id) : undefined;
                    const escalationShown = Boolean(scored?.escalationState?.activeEscalationId);
                    const showLifecycle = !(r.status.toUpperCase() === "ESCALATED" && escalationShown);
                    // T-096 — the governing deadline when the row was scored.
                    const due = scored?.slaState?.dueAtUtc ?? r.dueAt;
                    const outcome = bulkResult?.items.find((i) => i.workflowId === r.id) ?? null;
                    const href = reviewHrefFromInbox(r.id, view);
                    return (
                      <tr
                        key={r.id}
                        data-inbox-row={r.id}
                        data-selected={idx === selectionIndex ? "true" : "false"}
                        data-review-row-selected={selection.has(r.id) ? "true" : undefined}
                        data-inbox-row-outcome={outcome ? (outcome.ok ? "ok" : "failed") : undefined}
                      >
                        {selectable ? (
                          <td data-review-cell="check" data-label="">
                            <input
                              type="checkbox"
                              className="app-checkbox"
                              aria-label={`Select review of ${evidenceRef(r)}`}
                              data-inbox-row-checkbox={r.id}
                              checked={selection.has(r.id)}
                              onChange={() =>
                                setSelection((s) => {
                                  const next = new Set(s);
                                  if (next.has(r.id)) next.delete(r.id);
                                  else next.add(r.id);
                                  return next;
                                })
                              }
                            />
                          </td>
                        ) : null}
                        <td data-review-cell="ref" data-label="Evidence">
                          <Link href={href} className="review-rows__ref" data-inbox-row-ref={r.id}>
                            {evidenceRef(r)}
                          </Link>
                        </td>
                        <td data-review-cell="status" data-label="Status">
                          <span className="review-status-cell">
                            <span className="app-status-text-row">
                              {showLifecycle ? (
                                <AppStatusText tone={reviewLifecycleTone(r.status)} data-inbox-row-status={r.status}>
                                  {reviewLifecycleLabel(r.status)}
                                </AppStatusText>
                              ) : null}
                              {isNotablePriority(r.priority) ? (
                                <AppStatusText tone={priorityTone(r.priority)} data-inbox-row-priority={r.priority}>
                                  {priorityLabel(r.priority)}
                                </AppStatusText>
                              ) : null}
                            </span>
                            <QueueAttentionLine intelligence={scored} />
                          </span>
                        </td>
                        <td data-review-cell="due" data-label="Due">
                          <span className="app-table__muted" data-inbox-row-due>
                            {due ? formatUserDate(due) : "No deadline"}
                          </span>
                        </td>
                        <td data-review-cell="assignee" data-label="Assignee">
                          <span className="app-table__muted" data-inbox-row-assignee={r.id}>
                            {assigneeLabel(r.assignedToUserId, r.assignee, viewerUserId)}
                          </span>
                        </td>
                        <td data-review-cell="actions" data-label="">
                          <div className="app-table__actions">
                            <Link href={href} className="app-ghost-action" data-row-action="open" data-inbox-row-open={r.id}>
                              Open
                            </Link>
                            {rowAssignable(r) ? (
                              <button
                                type="button"
                                className="app-secondary-action"
                                data-row-action="assign"
                                data-inbox-row-assign={r.id}
                                disabled={rowAssignBusy}
                                onClick={() => openPicker({ kind: "ROW", workflowId: r.id })}
                              >
                                Assign
                              </button>
                            ) : null}
                            {outcome && !outcome.ok ? (
                              <AppStatusText tone="amber" data-inbox-row-not-applied>
                                Not applied{outcome.message ? `: ${outcome.message}` : ""}
                              </AppStatusText>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {load.nextCursor || moreError ? (
            <div className="review-toolbar" data-inbox-load-more-wrap>
              {load.nextCursor ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  data-inbox-load-more
                  disabled={loadingMore}
                  aria-busy={loadingMore || undefined}
                  onClick={() => {
                    if (!load.nextCursor) return;
                    setLoadingMore(true);
                    setMoreError(null);
                    void loadPage(load.nextCursor).finally(() => setLoadingMore(false));
                  }}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
              {moreError ? (
                <span role="alert" className="app-field-error" data-inbox-load-more-error>
                  {moreError}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {savedViews !== null ? (
        <SavedViewsPanel
          teamId={teamId}
          view={view}
          views={savedViews}
          onChanged={() => void loadSavedViews()}
          onApply={goToView}
        />
      ) : null}

      <ReviewToolsPanel />

      <ReviewerShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} rows={helpRows} variant="console" />

      {picker.state && pickerTarget ? (
        <ReviewerPickerModal
          state={picker.state}
          title={pickerTarget.kind === "ROW" ? "Assign reviewer" : "Assign the selected reviews to"}
          busy={rowAssignBusy}
          onRetry={() => void picker.open()}
          onCancel={closePicker}
          onSelect={(userId) => {
            if (pickerTarget.kind === "ROW") {
              void runRowAssign(pickerTarget.workflowId, userId);
              return;
            }
            closePicker();
            setPendingConfirm({ kind: "ASSIGN", assigneeUserId: userId });
          }}
        />
      ) : null}

      {pendingConfirm ? (
        <BulkConfirmModal
          confirmation={pendingConfirm}
          count={Math.min(selection.size, BULK_ACTION_CAP)}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => runBulkConfirmed(pendingConfirm)}
        />
      ) : null}

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

/** T-081 — the Conflicts view names its sibling: filed challenges. */
function ChallengedDecisionsHint() {
  const d = useReviewDestination("workspace.review_disagreements", { label: "Challenged decisions" });
  return (
    <p className="app-field-help review-inline-line" data-inbox-conflicts-hint>
      Conflicts are reviews whose first and second reviews reached different outcomes; they wait for adjudication.
      {d?.kind === "link" ? (
        <>
          {" "}
          Decisions a reviewer formally challenged are under{" "}
          <Link href={d.href} className="app-ghost-action" data-inbox-challenged-link>
            Challenged decisions
          </Link>
          .
        </>
      ) : null}
    </p>
  );
}

function BulkConfirmModal({
  confirmation,
  count,
  onConfirm,
  onCancel,
}: {
  confirmation: { kind: "TAG"; tag: BulkTag } | { kind: "ASSIGN"; assigneeUserId: string };
  count: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [applying, setApplying] = useState(false);
  return (
    <Modal
      open
      title={confirmation.kind === "TAG" ? `${BULK_TAG_LABELS[confirmation.tag]} on ${count} reviews?` : `Assign ${count} reviews?`}
      onClose={onCancel}
      dismissDisabled={applying}
      testid="inbox-bulk-confirm"
      footer={
        <>
          <button type="button" className="app-secondary-action" disabled={applying} onClick={onCancel} data-inbox-bulk-cancel>
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
            disabled={applying}
            aria-busy={applying || undefined}
            data-inbox-bulk-confirm
            onClick={() => {
              if (applying) return;
              setApplying(true);
              void onConfirm().finally(() => setApplying(false));
            }}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <p className="app-field-help" data-inbox-bulk-confirm-kind={confirmation.kind}>
        {confirmation.kind === "TAG"
          ? "A tag records a coded value on each review. No review is approved, rejected, escalated or closed."
          : "Each selected review is assigned to the reviewer you chose. The audit trail records every outcome."}
      </p>
    </Modal>
  );
}

/**
 * Saved views — Create (the current view) + Delete + Apply (opens the view in
 * the Inbox). Private or Workspace visibility, as before.
 */
export function SavedViewsPanel({
  teamId,
  view,
  views,
  onChanged,
  onApply,
}: {
  teamId: string;
  view: InboxView;
  views: ReadonlyArray<SavedViewRow>;
  onChanged: () => void;
  onApply: (view: InboxView) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "TEAM">("PRIVATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { confirm } = useConfirmAction();
  const platform = useOptionalPlatformContext();
  const viewerUserId = platform?.envelope?.user?.id ?? null;
  const viewerRole = roleInWorkspace(platform?.envelope ?? null, teamId);
  const savable = (INBOX_VIEW_LABELS as Record<string, string>)[view] !== undefined && !view.startsWith("AWAITING_");

  const apply = (v: SavedViewRow) => {
    const queue = resolveSavedViewQueue(v);
    if (queue && isInboxView(queue)) {
      onApply(queue);
      return;
    }
    setError("This saved view has no Inbox view to open.");
  };

  const create = async () => {
    if (!name.trim() || !savable) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/reviewer-ops/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, name: name.trim(), visibility, filter: { teamId, queue: view } }),
      });
      setName("");
      setCreating(false);
      onChanged();
    } catch (err) {
      setError(toSafeUserError(err, { message: "Could not save the view." }).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      await apiFetch(`/v1/reviewer-ops/saved-views/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`, {
        method: "DELETE",
      });
      onChanged();
    } catch (err) {
      setError(toSafeUserError(err, { message: "Could not delete the saved view." }).message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="app-panel" data-reviewer-saved-views-panel aria-labelledby="reviewer-saved-views-title">
      <div className="app-panel__head">
        <h2 className="app-panel__title" id="reviewer-saved-views-title">
          Saved views
        </h2>
        {!creating && savable ? (
          <button type="button" className="app-secondary-action" data-reviewer-saved-view-create onClick={() => setCreating(true)}>
            Save this view
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
                  { value: "TEAM", label: "Workspace — everyone in this workspace" },
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
                title={!name.trim() ? "Name the view first." : undefined}
              >
                {busy ? "Saving…" : "Save view"}
              </button>
            </div>
          </form>
        ) : null}
        {views.length === 0 ? (
          <p className="app-field-help" data-reviewer-saved-views-empty>
            No saved views yet. Save a view to return to it later.
          </p>
        ) : (
          <ul className="review-tools">
            {views.map((v, idx) => {
              const vid = v.id ?? "";
              const deleting = deletingId === vid;
              const queue = resolveSavedViewQueue(v);
              return (
                <li key={v.id ?? idx} className="review-tools__row review-picker__row" data-reviewer-saved-view-row={vid}>
                  <button type="button" className="app-ghost-action" data-reviewer-saved-view-apply={vid} onClick={() => apply(v)}>
                    {v.name ?? `View ${idx + 1}`}
                    {queue && isInboxView(queue) ? ` · ${INBOX_VIEW_LABELS[queue]}` : ""}
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
                            description: `Delete saved view "${v.name ?? "Untitled"}"?`,
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
