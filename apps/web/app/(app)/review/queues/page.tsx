"use client";

/**
 * PROOVRA Phase 3 — Reviewer queues + bulk operations.
 *
 * Workspace-anchored queue surface with multi-select + bulk actions
 * (assign, decide). Selection model:
 *   - shift-click → range select
 *   - cmd/ctrl-click → toggle
 *   - "Select all" header checkbox toggles every visible row
 *
 * Bulk confirmation modal shows the affected count + the action
 * before issuing the request. Server applies bounded batch limit
 * (≤ 100) and emits per-item outcomes.
 *
 * Phase 3 deltas (honest-to-API):
 *
 *   - The backend route GET /v1/reviewer-ops/queue expects the query
 *     parameter `queue=<REVIEWER_OPS_QUEUE_TYPES>` (UPPERCASE enum).
 *     The Phase 2A page sent `state=<lowercase>`, which Zod ignored
 *     and the route silently defaulted to UNASSIGNED. The filter is
 *     now sourced from the canonical REVIEWER_OPS_QUEUE_TYPES enum
 *     so each option targets a real backend branch.
 *
 *   - The backend Zod caps `limit` at 100 (not 200). The previous
 *     `limit=200` request would 400 (INVALID_QUERY) and the catch{}
 *     swallowed it into an empty table. We now request the maximum
 *     supported `limit=100`.
 *
 *   - QC filter: REVIEWER_OPS_QUEUE_TYPES does not include a "qc" or
 *     "qc_sampled" branch. The QC surface lives under /review/qc with
 *     its own samples endpoint. We do not add a fake QC option here.
 *
 *   - QC discovery card (Phase RW3-3): rather than mix QC rows into the
 *     workflow-centric queue (which would muddy bulk-assign + bulk-decide
 *     semantics), we render a TOP-OF-PAGE discovery card that surfaces
 *     "QC samples awaiting verdict: N" with a link to /review/qc. The
 *     count is sourced from GET /v1/reviewer-ops/qc/pending-count (team-
 *     scoped, gated on `evidence_request.review`). Failure → bounded
 *     ERROR; denial → FORBIDDEN copy; no fake zero.
 *
 *   - Member picker for bulk-assign: a team-scoped reviewer-picker
 *     endpoint now exists (`GET /v1/reviewer-ops/assignable-reviewers`,
 *     gated on `review.assign`). The previous `window.prompt`
 *     compromise is replaced with a searchable modal that fetches the
 *     bounded reviewer projection on open. On 403 the modal surfaces
 *     the denial message rather than falling back to the prompt.
 *
 * Phase RW3 delta (honest cursor pagination):
 *
 *   - The route now accepts a `cursor` query parameter and threads
 *     it into the service. The previous "Showing the first N" banner
 *     was a CANNOT_WIRE compromise because the route silently dropped
 *     the cursor; we now replace it with a real Load-more button.
 *     Subsequent pages send `&cursor=<lastRowId>` and APPEND rows to
 *     the existing list. Selection state survives across pages so
 *     bulk actions can target rows from multiple pages (still capped
 *     at the server-side 100-row bulk cap).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  REVIEWER_OPS_QUEUE_TYPES,
  REVIEWER_VERDICTS,
  type ReviewerOpsQueueType,
} from "@proovra/shared";

import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import {
  bulkAssign,
  bulkDecide,
  type BulkOutcome,
} from "../../../../lib/reviewer-workspace/reviewer-api";
// PHASE 12B (Evidence Operations) — the reviewer console is the canonical
// home for BOTH the server-side queue-intelligence projection and the
// evidence-request review queue. Both modules are segment-private.
import {
  QueueIntelligenceNotice,
  QueueSignalCell,
  useQueueIntelligence,
} from "./_queue-intelligence";
import { EvidenceRequestReviewQueue } from "./_evidence-request-queue";

type QueueRow = {
  id: string;
  evidenceId: string;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  dueAt: string | null;
  createdAt: string;
};

// -----------------------------------------------------------------------------
// Backend contract constants
// -----------------------------------------------------------------------------

// Backend Zod caps `limit` at 100 (services/api/src/routes/reviewer-ops.routes.ts).
// Requesting more 400s with INVALID_QUERY which the catch{} would swallow.
const QUEUE_PAGE_LIMIT = 100;

// Bulk action server cap (services/api/src/services/reviewer-ops bulk routes).
const BULK_ACTION_CAP = 100;

// Human-facing label for each REVIEWER_OPS_QUEUE_TYPES enum value. The
// label is bounded and never leaks raw enum to operators. The select's
// `value` attribute is the canonical UPPERCASE enum that the backend
// expects.
const QUEUE_LABELS: Record<ReviewerOpsQueueType, string> = {
  MY_REVIEWS: "Assigned to me",
  UNASSIGNED: "Unassigned",
  OVERDUE: "Overdue",
  DUE_SOON: "Due soon",
  ESCALATED: "Escalated",
  HIGH_PRIORITY: "High priority",
  LEGAL_HOLD: "Legal hold",
  WORKFLOW_BLOCKED: "Workflow blocked",
  INTEGRITY_RISK: "Integrity risk",
  EXTERNAL_INTAKE: "External intake",
  COMPLETED_RECENTLY: "Completed recently",
};

// Empty-state copy per queue. Each tab gets distinct, bounded copy so
// operators can tell "nothing here right now" from "wrong tab".
const EMPTY_STATE_COPY: Record<ReviewerOpsQueueType, string> = {
  MY_REVIEWS: "No reviews are currently assigned to you.",
  UNASSIGNED: "No unassigned items are waiting for triage.",
  OVERDUE: "No reviews are overdue.",
  DUE_SOON: "No reviews are due soon.",
  ESCALATED: "No reviews have an open escalation.",
  HIGH_PRIORITY: "No reviews are flagged high priority or urgent.",
  LEGAL_HOLD: "No reviews are under an active legal hold.",
  WORKFLOW_BLOCKED: "No reviews are paused or blocked.",
  INTEGRITY_RISK: "No reviews carry an integrity-risk escalation.",
  EXTERNAL_INTAKE: "No external-intake reviews are waiting.",
  COMPLETED_RECENTLY: "No reviews have completed in the last 7 days.",
};

export default function QueuesPage() {
  return (
    <PageRouteGate routeId="workspace.review_queues">
      <QueuesShell />
    </PageRouteGate>
  );
}

// Bounded projection returned by /v1/reviewer-ops/assignable-reviewers.
// Mirrors the AssignableReviewer service type. displayName is optional
// (null when not set); currentWorkloadCount is omitted when no
// ReviewerWorkloadSnapshot exists rather than projecting a fake zero.
type AssignableReviewer = {
  userId: string;
  displayName: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  status: "ACTIVE";
  currentWorkloadCount?: number;
};

// Tagged state for the reviewer picker fetch. LOADING during the open
// fetch; FORBIDDEN when the backend returns 403 (`REVIEW_PERMISSION_DENIED`
// or `NOT_PERMITTED`); ERROR for other failures; READY when the list
// is populated. The picker NEVER falls back to window.prompt — this
// is the hard rule that this phase enforces.
type PickerState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; reviewers: AssignableReviewer[] };

// Phase RW3-3 — QC discovery card state. We do NOT mix QC rows into the
// queue (REVIEWER_OPS_QUEUE_TYPES has no QC branch; QcSample is a
// sibling lifecycle). Instead we surface a bounded "pending samples"
// count card at the top of the page that links to /review/qc.
//
//   - LOADING: in-flight first fetch.
//   - FORBIDDEN: caller lacks the `evidence_request.review` capability.
//   - ERROR: bounded failure copy. We do NOT silently render zero.
//   - READY: card surfaces the real pendingCount (may be 0 — honest).
type QcDiscoveryState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; pendingCount: number };

function QueuesShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = useActiveSpaceId();
  // PHASE 12B — stale-context rejection. Every async read captures the
  // teamId it was issued for and compares it against this ref when it
  // resolves, so a response belonging to a previous workspace generation
  // is DISCARDED instead of rendered under the new tenant. The ref is
  // synced in the first effect below so it is already current before any
  // data effect fires.
  const activeTeamRef = useRef<string | null>(teamId);
  useEffect(() => {
    activeTeamRef.current = teamId;
  }, [teamId]);
  const initialQueue = searchParams.get("queue");
  const initialFilter = REVIEWER_OPS_QUEUE_TYPES.includes(
    initialQueue as ReviewerOpsQueueType,
  )
    ? (initialQueue as ReviewerOpsQueueType)
    : "MY_REVIEWS";
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewerOpsQueueType>(initialFilter);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  // Selection state survives across pages: a row id that was selected
  // on page 1 stays selected after Load-more appends page 2. The
  // server-side bulk cap (100) is still enforced at the slice
  // boundary inside runDecide / runAssign.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<
    | null
    | {
        kind: "DECIDE";
        verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";
      }
    | { kind: "ASSIGN"; assigneeUserId: string }
  >(null);
  // Reviewer picker state. Null when closed; otherwise carries a
  // tagged fetch state. Opens on "Bulk assign" click; closes on
  // cancel or successful selection (handed off to the confirm modal).
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  // Phase RW3-3 — QC discovery card state. Independent of the queue
  // fetch so a QC failure does not blank the queue table and vice versa.
  const [qcState, setQcState] = useState<QcDiscoveryState>({ kind: "LOADING" });

  // Workspace-anchored queue read. Two modes:
  //   - cursor === null → first page; replaces rows.
  //   - cursor !== null → next page; APPENDS rows.
  // Wrapped in try/catch with structured warn log on failure.
  const loadPage = useCallback(
    async (cursor: string | null) => {
      if (!teamId) {
        setRows([]);
        setNextCursor(null);
        setRefreshError("Select a workspace before loading review queues.");
        return;
      }

      // Captured for the stale-context comparison below. The URL keeps
      // using `teamId` directly so the tenant-scoping contract stays
      // literally visible in the request template.
      const requestTeamId = teamId;
      const url =
        cursor === null
          ? `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${encodeURIComponent(filter)}&limit=${QUEUE_PAGE_LIMIT}`
          : `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${encodeURIComponent(filter)}&limit=${QUEUE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
      try {
        const res = await apiFetch(url, { method: "GET" });
        // Stale-context rejection — the workspace changed mid-flight.
        if (requestTeamId !== activeTeamRef.current) return;
        const pageRows = (res?.rows ?? res?.workflows ?? []) as QueueRow[];
        const nextCursorValue =
          typeof res?.nextCursor === "string" && res.nextCursor.length > 0
            ? res.nextCursor
            : null;
        setRows((prev) => {
          if (cursor === null) return pageRows;
          // Append, but dedupe against any ids already in the prev
          // list — defends against rare overlap if the data shifted
          // between page reads. Stable order: previously-loaded rows
          // first, then new rows.
          const seen = new Set((prev ?? []).map((r) => r.id));
          const merged = [...(prev ?? [])];
          for (const r of pageRows) {
            if (!seen.has(r.id)) {
              merged.push(r);
              seen.add(r.id);
            }
          }
          return merged;
        });
        setNextCursor(nextCursorValue);
        setRefreshError(null);
        setLastRefreshedAt(new Date().toISOString());
      } catch (err) {
        if (requestTeamId !== activeTeamRef.current) return;
        // eslint-disable-next-line no-console
        console.warn("[reviewer-workspace] queue list refresh failed", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: (err as any)?.statusCode ?? 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code: (err as any)?.code ?? "UNKNOWN",
          queue: filter,
          cursorPresent: cursor !== null,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (err as any)?.code as string | undefined;
        if (cursor === null) {
          // First-page failure: drop rows to an empty list so the
          // UI does not silently show stale data.
          setRows([]);
          setNextCursor(null);
        } else {
          // Subsequent-page failure: preserve already-loaded rows,
          // clear the cursor so the user can retry by reloading.
          setNextCursor(null);
        }
        if (code === "INVALID_CURSOR") {
          setRefreshError(
            "Pagination cursor was rejected. Reload the queue to start over.",
          );
        } else if (code === "NOT_PERMITTED" || code === "FORBIDDEN") {
          setRefreshError(
            "You do not have permission to view this queue.",
          );
        } else {
          setRefreshError(
            "Queue list could not be loaded. Try again shortly.",
          );
        }
      }
    },
    [filter, teamId],
  );

  // First page on mount / filter change. Selection is cleared when
  // the filter changes because the rows no longer match the
  // operator's intent.
  const refresh = useCallback(async () => {
    await loadPage(null);
  }, [loadPage]);

  async function loadMore() {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      await loadPage(nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  // Phase RW3-3 — QC discovery card fetch. Independent of the queue
  // refresh: a QC failure must not blank the queue, and a queue failure
  // must not blank the QC card. Wrapped in try/catch with a structured
  // warn log. 403 → FORBIDDEN bounded copy; other failures → ERROR.
  // The READY state surfaces the real pendingCount (which may be 0 —
  // we render that as an honest "no pending QC samples", NOT as a fake
  // success banner).
  const refreshQc = useCallback(async () => {
    setQcState({ kind: "LOADING" });
    try {
      if (!teamId) {
        setQcState({ kind: "ERROR", message: "Select a workspace before loading QC counts." });
        return;
      }
      const requestTeamId = teamId;
      const res = await apiFetch(
        `/v1/reviewer-ops/qc/pending-count?teamId=${encodeURIComponent(requestTeamId)}`,
        {
          method: "GET",
        },
      );
      // Stale-context rejection — discard a previous workspace's count.
      if (requestTeamId !== activeTeamRef.current) return;
      const pendingCount =
        typeof res?.pendingCount === "number" && Number.isFinite(res.pendingCount)
          ? res.pendingCount
          : 0;
      setQcState({ kind: "READY", pendingCount });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] qc pending-count fetch failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.code as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.statusCode as number | undefined;
      if (
        status === 403 ||
        code === "REVIEW_PERMISSION_DENIED" ||
        code === "NOT_PERMITTED" ||
        code === "FORBIDDEN"
      ) {
        setQcState({
          kind: "FORBIDDEN",
          message:
            "QC samples are restricted in this workspace.",
        });
        return;
      }
      setQcState({
        kind: "ERROR",
        message:
          "QC pending count could not be loaded. Try again shortly.",
      });
    }
    // `teamId` MUST be a dependency: with `[]` the callback captured the
    // workspace id from first render and kept querying the previous
    // tenant after a workspace switch (defect fixed in Phase 12B).
  }, [teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const queue = searchParams.get("queue");
    if (
      queue &&
      REVIEWER_OPS_QUEUE_TYPES.includes(queue as ReviewerOpsQueueType) &&
      queue !== filter
    ) {
      setFilter(queue as ReviewerOpsQueueType);
      setSelected(new Set());
    }
  }, [filter, searchParams]);

  useEffect(() => {
    void refreshQc();
  }, [refreshQc]);

  const allVisibleIds = useMemo(
    () => (rows ?? []).map((r) => r.id),
    [rows],
  );
  // PHASE 12B — server-side queue intelligence for the loaded rows. The
  // projection is the ONLY source of priority band, stuck state, SLA,
  // escalation and governance-blocker signals; the client never scores.
  const { state: intelligenceState, refresh: refreshIntelligence } =
    useQueueIntelligence(teamId, allVisibleIds, activeTeamRef);
  const allSelected =
    allVisibleIds.length > 0 &&
    allVisibleIds.every((id) => selected.has(id));

  const toggleOne = useCallback(
    (idx: number, ev: React.MouseEvent) => {
      if (!rows) return;
      const id = rows[idx]!.id;
      setSelected((prev) => {
        const next = new Set(prev);
        if (ev.shiftKey && lastIndex !== null) {
          const lo = Math.min(idx, lastIndex);
          const hi = Math.max(idx, lastIndex);
          for (let i = lo; i <= hi; i += 1) next.add(rows[i]!.id);
        } else {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return next;
      });
      setLastIndex(idx);
    },
    [rows, lastIndex],
  );

  function toggleAll() {
    if (!rows) return;
    setSelected((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      for (const id of allVisibleIds) next.add(id);
      return next;
    });
  }

  async function runDecide(
    verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO",
  ) {
    // Server-side bulk cap is 100; slice the selection to stay inside.
    const ids = Array.from(selected).slice(0, BULK_ACTION_CAP);
    const res = await bulkDecide({
      verdict,
      workflowIds: ids,
      teamId,
    });
    setBanner(summariseOutcome(`Decide=${verdict}`, ids.length, res));
    setSelected(new Set());
    setPendingConfirmation(null);
    await refresh();
  }

  async function runAssign(assigneeUserId: string) {
    const ids = Array.from(selected).slice(0, BULK_ACTION_CAP);
    const res = await bulkAssign({
      assigneeUserId,
      workflowIds: ids,
      teamId,
    });
    setBanner(summariseOutcome(`Assign`, ids.length, res));
    setSelected(new Set());
    setPendingConfirmation(null);
    await refresh();
  }

  // Reviewer picker open + fetch. Wraps the fetch in try/catch with a
  // structured warn log; surfaces the bounded denial copy on 403; never
  // falls back to window.prompt. The picker stays open in ERROR state
  // and offers a retry rather than corrupting the bulk-assign flow.
  const openReviewerPicker = useCallback(async () => {
    setPickerState({ kind: "LOADING" });
    try {
      if (!teamId) {
        setPickerState({
          kind: "ERROR",
          message: "Select a workspace before loading reviewers.",
        });
        return;
      }
      const requestTeamId = teamId;
      const res = await apiFetch(
        `/v1/reviewer-ops/assignable-reviewers?teamId=${encodeURIComponent(requestTeamId)}&limit=200`,
        { method: "GET" },
      );
      // Stale-context rejection — never offer another tenant's reviewers.
      if (requestTeamId !== activeTeamRef.current) {
        setPickerState(null);
        return;
      }
      const reviewers =
        Array.isArray(res?.reviewers) ? (res.reviewers as AssignableReviewer[]) : [];
      setPickerState({ kind: "READY", reviewers });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] assignable-reviewers fetch failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.code as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.statusCode as number | undefined;
      if (
        status === 403 ||
        code === "REVIEW_PERMISSION_DENIED" ||
        code === "NOT_PERMITTED" ||
        code === "FORBIDDEN"
      ) {
        setPickerState({
          kind: "FORBIDDEN",
          message:
            "You do not have permission to assign reviews in this workspace.",
        });
        return;
      }
      setPickerState({
        kind: "ERROR",
        message:
          "Reviewer list could not be loaded. Try again or refresh the page.",
      });
    }
    // `teamId` MUST be a dependency — see the refreshQc note above.
  }, [teamId]);

  if (!teamId) {
    return (
      <PageShell
        data-reviewer-queues-page
        header={
          <PageHeader
            eyebrow="Review"
            title="Reviewer queues"
            subtitle="Triage, assignment, and bulk review actions across the current workspace."
          />
        }
      >
        <Card variant="empty" padding="none">
          <EmptyState
            title="Select a workspace"
            purpose="Choose an active workspace before loading review queues."
          />
        </Card>
      </PageShell>
    );
  }

  const visibleRowCount = rows?.length ?? 0;
  const hasMore = nextCursor !== null;

  return (
    <PageShell
      data-reviewer-queues-page
      header={
        <PageHeader
          eyebrow="Review"
          title="Reviewer queues"
          subtitle="Triage, assignment, and bulk review actions across the current workspace. Filters are URL-backed for direct links from Review Workspace and saved views."
          secondaryActions={
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                fontWeight: 600,
                color: "var(--ink-secondary, #475569)",
              }}
            >
              Queue
              <select
                data-reviewer-queue-filter
                value={filter}
                onChange={(e) => {
                  const next = e.target.value as ReviewerOpsQueueType;
                  setFilter(next);
                  setSelected(new Set());
                  router.replace(
                    `/review/queues?queue=${encodeURIComponent(next)}`,
                    { scroll: false },
                  );
                }}
                style={{
                  minHeight: 40,
                  fontSize: 13.5,
                  color: "var(--ink-primary, #0f172a)",
                  background: "var(--surface-card, #ffffff)",
                  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                  borderRadius: "var(--radius-md, 8px)",
                  padding: "0 12px",
                  cursor: "pointer",
                }}
              >
                {REVIEWER_OPS_QUEUE_TYPES.map((q) => (
                  <option key={q} value={q}>
                    {QUEUE_LABELS[q]}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      }
    >
      <Card variant="admin" padding="compact">
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-secondary, #475569)",
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Badge tone="info">{QUEUE_LABELS[filter]}</Badge>
          <span>Loaded rows: {visibleRowCount}</span>
          <span>
            Loaded pages:{" "}
            {Math.max(
              1,
              Math.ceil(Math.max(visibleRowCount, 1) / QUEUE_PAGE_LIMIT),
            )}
          </span>
          <span>More available: {hasMore ? "Yes" : "No"}</span>
          <span>
            Last refresh:{" "}
            {lastRefreshedAt
              ? formatUserDateTime(lastRefreshedAt)
              : "Not yet loaded"}
          </span>
        </div>
      </Card>

      <QcDiscoveryCard state={qcState} onRetry={() => void refreshQc()} />

      {/* PHASE 12B — evidence-request review queue (GET /v1/review/queue).
          A sibling domain to the workflow queue below, not a duplicate:
          see _evidence-request-queue.tsx for the parity analysis. */}
      <EvidenceRequestReviewQueue teamId={teamId} activeTeamRef={activeTeamRef} />

      <QueueIntelligenceNotice
        state={intelligenceState}
        onRetry={refreshIntelligence}
      />

      <BulkBar
        selectedCount={selected.size}
        onDecide={(verdict) =>
          setPendingConfirmation({ kind: "DECIDE", verdict })
        }
        onAssign={() => {
          void openReviewerPicker();
        }}
        onClear={() => setSelected(new Set())}
      />

      {banner ? (
        <div
          data-bulk-banner
          style={{
            padding: "10px 14px",
            background: "var(--surface-muted, #f1f4f9)",
            border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
            borderRadius: "var(--radius-md, 8px)",
            fontSize: 13,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {banner}
        </div>
      ) : null}

      {refreshError ? (
        <div
          data-reviewer-queue-error
          style={{
            padding: "10px 14px",
            background: "var(--status-risk-bg, #fef2f2)",
            border: "1px solid var(--status-risk-border, #fecaca)",
            color: "var(--status-risk-fg, #991b1b)",
            borderRadius: "var(--radius-md, 8px)",
            fontSize: 13,
          }}
        >
          {refreshError}
        </div>
      ) : null}

      {rows === null ? (
        <Card padding="comfortable">
          <div
            style={{
              color: "var(--ink-secondary, #475569)",
              fontSize: 13.5,
            }}
          >
            Loading…
          </div>
        </Card>
      ) : (
        <PageSection>
          <div
            data-ui-datatable-scroll
            style={{
              width: "100%",
              overflowX: "auto",
              border:
                "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-card, 14px)",
              background: "var(--surface-card, #ffffff)",
            }}
          >
          <table
            data-reviewer-queue-table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13.5,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            <thead>
              <tr>
                <th style={th}>
                  <input
                    type="checkbox"
                    data-reviewer-queue-select-all
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th style={th}>Workflow</th>
                <th style={th}>Evidence</th>
                <th style={th}>Status</th>
                <th style={th}>Priority</th>
                <th style={th}>Signals</th>
                <th style={th}>Assignee</th>
                <th style={th}>Due</th>
                <th style={th}>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr
                  key={r.id}
                  data-reviewer-queue-row={r.id}
                  data-reviewer-queue-selected={selected.has(r.id) ? "true" : "false"}
                  style={{
                    background: selected.has(r.id)
                      ? "var(--surface-muted, #f1f4f9)"
                      : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={(e) => toggleOne(idx, e)}
                >
                  <td style={td}>
                    <input
                      type="checkbox"
                      data-reviewer-queue-checkbox={r.id}
                      checked={selected.has(r.id)}
                      onChange={() => null}
                    />
                  </td>
                  <td style={td}>
                    <code>{r.id.slice(0, 8)}…</code>
                  </td>
                  <td style={td}>
                    <code>{r.evidenceId.slice(0, 8)}…</code>
                  </td>
                  <td style={td}>{r.status}</td>
                  <td style={td}>{r.priority}</td>
                  <td style={td}>
                    <QueueSignalCell
                      state={intelligenceState}
                      intelligence={
                        intelligenceState.kind === "READY"
                          ? intelligenceState.byWorkflowId.get(r.id)
                          : undefined
                      }
                    />
                  </td>
                  <td style={td}>
                    {r.assignedToUserId ? r.assignedToUserId.slice(0, 8) + "…" : "—"}
                  </td>
                  <td style={td}>
                    {r.dueAt ? formatUserDate(r.dueAt) : "—"}
                  </td>
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    {/* Canonical drill-down into the reviewer detail route. */}
                    <Link
                      href={`/reviewer-ops/${r.id}`}
                      data-reviewer-queue-open={r.id}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--ink-primary, #0f172a)",
                      }}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    data-reviewer-queue-empty={filter}
                    style={{ padding: 0, border: "none" }}
                  >
                    <EmptyState
                      title={EMPTY_STATE_COPY[filter]}
                      purpose={
                        filter === "MY_REVIEWS"
                          ? "Claim work from Unassigned or return to Reviewer Workspace once something is assigned."
                          : filter === "UNASSIGNED"
                            ? "Items appear here when real workflows are waiting for ownership."
                            : "Change the queue filter or refresh to confirm whether work has moved."
                      }
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>

          {hasMore ? (
            <div
              data-reviewer-queue-load-more-wrap
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 13,
                color: "var(--ink-secondary, #475569)",
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                data-reviewer-queue-load-more
                loading={loadingMore}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
              <span>
                Showing {visibleRowCount} item
                {visibleRowCount === 1 ? "" : "s"}. More rows match this
                filter.
              </span>
            </div>
          ) : null}
        </PageSection>
      )}

      {pickerState ? (
        <ReviewerPickerModal
          state={pickerState}
          onRetry={() => void openReviewerPicker()}
          onCancel={() => setPickerState(null)}
          onSelect={(userId) => {
            setPickerState(null);
            setPendingConfirmation({
              kind: "ASSIGN",
              assigneeUserId: userId,
            });
          }}
        />
      ) : null}

      {pendingConfirmation ? (
        <ConfirmModal
          confirmation={pendingConfirmation}
          count={selected.size}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={async () => {
            if (pendingConfirmation.kind === "DECIDE") {
              await runDecide(pendingConfirmation.verdict);
            } else {
              await runAssign(pendingConfirmation.assigneeUserId);
            }
          }}
        />
      ) : null}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Phase RW3-2 — Reviewer picker modal.
//
// Renders the tagged PickerState:
//   - LOADING:    busy state while the fetch is in flight.
//   - FORBIDDEN:  bounded denial copy; NO fallback to window.prompt.
//   - ERROR:      bounded error copy + retry button.
//   - READY:      searchable list (client-side filter on displayName +
//                 last 8 of userId), with a select button per row.
// ---------------------------------------------------------------------------
function ReviewerPickerModal({
  state,
  onRetry,
  onCancel,
  onSelect,
}: {
  state: PickerState;
  onRetry: () => void;
  onCancel: () => void;
  onSelect: (userId: string) => void;
}) {
  const [query, setQuery] = useState<string>("");
  const visibleReviewers = useMemo(() => {
    if (state.kind !== "READY") return [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return state.reviewers;
    return state.reviewers.filter((r) => {
      if (r.displayName && r.displayName.toLowerCase().includes(q)) return true;
      // Match on the short id form the operator sees in the table.
      if (r.userId.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [state, query]);

  return (
    <div
      data-reviewer-picker-modal
      data-reviewer-picker-state={state.kind}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 70,
      }}
    >
      <div
        style={{
          background: "var(--surface-card, #ffffff)",
          borderRadius: "var(--radius-card, 14px)",
          padding: 20,
          maxWidth: 520,
          width: "92vw",
          maxHeight: "78vh",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxShadow: "0 24px 48px rgba(15,23,42,0.25)",
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Assign to reviewer</h3>

        {state.kind === "LOADING" ? (
          <div data-reviewer-picker-loading style={{ color: "#475569", fontSize: 13 }}>
            Loading reviewer list…
          </div>
        ) : null}

        {state.kind === "FORBIDDEN" ? (
          <div
            data-reviewer-picker-denied
            style={{
              padding: "8px 12px",
              background: "rgba(220, 38, 38, 0.08)",
              color: "#7f1d1d",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {state.message}
          </div>
        ) : null}

        {state.kind === "ERROR" ? (
          <div
            data-reviewer-picker-error
            style={{
              padding: "8px 12px",
              background: "rgba(220, 38, 38, 0.08)",
              color: "#7f1d1d",
              borderRadius: 8,
              fontSize: 12,
              display: "flex",
              gap: 8,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>{state.message}</span>
            <button
              type="button"
              data-reviewer-picker-retry
              onClick={onRetry}
              style={pickerBtn}
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.kind === "READY" ? (
          <>
            <input
              type="search"
              data-reviewer-picker-search
              placeholder="Search by name or id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                padding: "8px 12px",
                fontSize: 13.5,
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 8px)",
                color: "var(--ink-primary, #0f172a)",
                background: "var(--surface-card, #ffffff)",
              }}
            />
            <div
              data-reviewer-picker-list
              style={{
                overflowY: "auto",
                maxHeight: "48vh",
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 8px)",
              }}
            >
              {visibleReviewers.length === 0 ? (
                <div
                  data-reviewer-picker-empty
                  style={{ padding: 12, fontSize: 12, color: "var(--ink-secondary, #475569)" }}
                >
                  No reviewers match. Reviewers are workspace members with
                  the assign capability.
                </div>
              ) : (
                visibleReviewers.map((r) => (
                  <div
                    key={r.userId}
                    data-reviewer-picker-row={r.userId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}>
                        {r.displayName ?? `Reviewer ${r.userId.slice(0, 8)}`}
                      </div>
                      <div style={{ color: "var(--ink-secondary, #475569)" }}>
                        <code>{r.userId.slice(0, 8)}…</code>
                        <span style={{ marginLeft: 6 }}>{r.role}</span>
                        {typeof r.currentWorkloadCount === "number" ? (
                          <span
                            data-reviewer-picker-workload={r.userId}
                            style={{ marginLeft: 6 }}
                          >
                            · {r.currentWorkloadCount} active
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      data-reviewer-picker-select={r.userId}
                      onClick={() => onSelect(r.userId)}
                      style={primaryBtn}
                    >
                      Select
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            data-reviewer-picker-cancel
            onClick={onCancel}
            style={ghostBtn}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const pickerBtn = {
  background: "var(--btn-primary-bg, #0f172a)",
  color: "var(--btn-primary-color, #fafafa)",
  border: "1px solid var(--btn-primary-border, #0f172a)",
  fontSize: 12,
  padding: "5px 11px",
  borderRadius: "var(--radius-md, 8px)",
  cursor: "pointer",
  fontWeight: 600,
} as const;

// ---------------------------------------------------------------------------
// Phase RW3-3 — QC discovery card.
//
// Renders the tagged QcDiscoveryState at the top of the queues page so
// operators can SEE pending QC work without leaving the queues surface.
// The card is a navigation hint — it links to /review/qc rather than
// mixing QC rows into the workflow-centric queue table.
//
//   - LOADING:    bounded loading line.
//   - FORBIDDEN:  bounded denial copy + link still rendered (the QC
//                 surface itself enforces the cap server-side; the
//                 card just doesn't show a count).
//   - ERROR:      bounded error copy + retry button. No fake zero.
//   - READY:      shows pendingCount (may be 0 — surfaced honestly as
//                 "No QC samples are awaiting verdict.") and a link
//                 to /review/qc.
// ---------------------------------------------------------------------------
function QcDiscoveryCard({
  state,
  onRetry,
}: {
  state: QcDiscoveryState;
  onRetry: () => void;
}) {
  return (
    <div
      data-reviewer-queue-qc-card
      data-reviewer-queue-qc-state={state.kind}
      style={{
        padding: "12px 16px",
        background: "var(--surface-card, #ffffff)",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
        borderRadius: "var(--radius-card, 14px)",
        fontSize: 13,
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ color: "var(--ink-primary, #0f172a)" }}>QC samples</strong>
        {state.kind === "LOADING" ? (
          <span data-reviewer-queue-qc-loading style={{ color: "var(--ink-secondary, #475569)" }}>
            Loading pending count…
          </span>
        ) : null}
        {state.kind === "READY" ? (
          state.pendingCount > 0 ? (
            <span
              data-reviewer-queue-qc-count={state.pendingCount}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--status-pending-fg, #EA580C)", fontWeight: 600 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--status-pending-solid, #f59e0b)",
                  flexShrink: 0,
                }}
              />
              {state.pendingCount} sample
              {state.pendingCount === 1 ? "" : "s"} awaiting verdict.
            </span>
          ) : (
            <span
              data-reviewer-queue-qc-empty
              style={{ color: "var(--ink-secondary, #475569)" }}
            >
              No QC samples are awaiting verdict.
            </span>
          )
        ) : null}
        {state.kind === "FORBIDDEN" ? (
          <span
            data-reviewer-queue-qc-denied
            style={{ color: "var(--status-risk-fg, #991b1b)" }}
          >
            {state.message}
          </span>
        ) : null}
        {state.kind === "ERROR" ? (
          <span
            data-reviewer-queue-qc-error
            style={{ color: "var(--status-risk-fg, #991b1b)" }}
          >
            {state.message}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {state.kind === "ERROR" ? (
          <button
            type="button"
            data-reviewer-queue-qc-retry
            onClick={onRetry}
            style={pickerBtn}
          >
            Retry
          </button>
        ) : null}
        <a
          data-reviewer-queue-qc-link
          href="/review/qc"
          style={{
            color: "var(--ink-primary, #0f172a)",
            textDecoration: "underline",
            fontWeight: 600,
          }}
        >
          Open QC samples
        </a>
      </div>
    </div>
  );
}

function BulkBar({
  selectedCount,
  onDecide,
  onAssign,
  onClear,
}: {
  selectedCount: number;
  onDecide: (
    verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO",
  ) => void;
  onAssign: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) {
    return (
      <div
        data-bulk-bar
        data-bulk-bar-state="empty"
        style={{
          padding: "10px 14px",
          background: "var(--surface-muted, #f1f4f9)",
          border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
          borderRadius: "var(--radius-md, 8px)",
          fontSize: 13,
          color: "var(--ink-secondary, #475569)",
        }}
      >
        Select rows with the checkboxes or shift-click. Bulk actions
        appear when at least one row is selected (≤ {BULK_ACTION_CAP} per call).
      </div>
    );
  }
  const cappedCount = Math.min(selectedCount, BULK_ACTION_CAP);
  const overCap = selectedCount > BULK_ACTION_CAP;
  return (
    <div
      data-bulk-bar
      data-bulk-bar-state="active"
      data-bulk-bar-selected={selectedCount}
      style={{
        padding: "10px 14px",
        background: "var(--ink-primary, #0f172a)",
        color: "#fafafa",
        borderRadius: "var(--radius-md, 8px)",
        fontSize: 13,
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <strong>{selectedCount} selected</strong>
      {overCap ? (
        <span data-bulk-bar-cap-note style={{ color: "#fbbf24" }}>
          (first {cappedCount} will be applied; server cap is {BULK_ACTION_CAP})
        </span>
      ) : null}
      <button
        type="button"
        data-bulk-action="ASSIGN"
        onClick={onAssign}
        style={bulkBtn}
      >
        Bulk assign
      </button>
      {REVIEWER_VERDICTS.filter((v) => v !== "PENDING").map((v) => (
        <button
          key={v}
          type="button"
          data-bulk-action={v}
          onClick={() =>
            onDecide(v as "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO")
          }
          style={bulkBtn}
        >
          Bulk {v.toLowerCase()}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        data-bulk-clear
        onClick={onClear}
        style={{ ...bulkBtn, background: "transparent" }}
      >
        Clear
      </button>
    </div>
  );
}

function ConfirmModal({
  confirmation,
  count,
  onConfirm,
  onCancel,
}: {
  confirmation:
    | { kind: "DECIDE"; verdict: string }
    | { kind: "ASSIGN"; assigneeUserId: string };
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-bulk-confirm
      data-bulk-confirm-kind={confirmation.kind}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: "var(--surface-card, #ffffff)",
          borderRadius: "var(--radius-card, 14px)",
          padding: 20,
          maxWidth: 440,
          width: "92vw",
          boxShadow: "0 24px 48px rgba(15,23,42,0.25)",
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        <h3 style={{ marginTop: 0, fontSize: 16, fontWeight: 700 }}>
          Confirm bulk{" "}
          {confirmation.kind === "DECIDE"
            ? confirmation.verdict.toLowerCase()
            : "assign"}
        </h3>
        <p style={{ color: "var(--ink-secondary, #475569)", fontSize: 13 }}>
          This will apply the action to{" "}
          <strong>{Math.min(count, BULK_ACTION_CAP)}</strong>{" "}
          workflows. The audit trail records each per-item outcome.
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 12,
          }}
        >
          <button
            type="button"
            data-bulk-confirm-cancel
            onClick={onCancel}
            style={ghostBtn}
          >
            Cancel
          </button>
          <button
            type="button"
            data-bulk-confirm-go
            onClick={onConfirm}
            style={primaryBtn}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function summariseOutcome(
  action: string,
  requested: number,
  res:
    | {
        total: number;
        succeeded: number;
        outcomes: BulkOutcome[];
      }
    | { denial: string }
    | unknown,
): string {
  if (res && typeof res === "object" && "denial" in (res as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return `${action} refused: ${(res as any).denial}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  return `${action}: ${r?.succeeded ?? 0} of ${r?.total ?? requested} succeeded.`;
}

const th = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-muted, #94a3b8)",
  background: "var(--surface-header, #f8fafc)",
  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  whiteSpace: "nowrap",
} as const;
const td = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  verticalAlign: "middle",
} as const;
const bulkBtn = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#fafafa",
  fontSize: 12,
  padding: "5px 11px",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
} as const;
const ghostBtn = {
  background: "transparent",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  color: "var(--ink-primary, #0f172a)",
  fontSize: 13,
  padding: "6px 14px",
  borderRadius: "var(--radius-md, 8px)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const primaryBtn = {
  background: "var(--btn-primary-bg, #0f172a)",
  color: "var(--btn-primary-color, #fafafa)",
  border: "1px solid var(--btn-primary-border, #0f172a)",
  fontSize: 13,
  padding: "6px 14px",
  borderRadius: "var(--radius-md, 8px)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
