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
 * TEAM-SPEC (2026-11-23):
 *
 *   - Bulk eligibility (R1): the bar and the row checkboxes are offered only
 *     where the API serves the action — the active workspace's plan includes
 *     the Team review tools (`reviewQueuesIncluded`) AND the role holds the
 *     bulk capability plus the action's own: REVIEW_ASSIGN for assign
 *     (`review.bulk` + `review.assign`), REVIEWER_OPS_ACT for coded
 *     verdicts (`review.bulk` + `review.decide`). The workspace KIND is
 *     not asked; the API accepts an entitled Personal Workspace.
 *   - Per-item results: a bulk call reports each item; failures are listed
 *     with a human reason and marked on their rows.
 *   - Filter race: every first-page read carries a generation number; a
 *     response for an older filter (or workspace) is discarded.
 *   - The QC samples row is rendered through `reviewDestination` — only
 *     when /review/qc opens for this actor (or a workspace switch would open
 *     it), never as a dead link.
 *   - Picker and confirmation use the canonical `Modal` (portal, focus trap,
 *     focus restore).
 *
 * TEAM-UI-SPEC round 3 (§1 canonical controls, §4 tables & mobile rows):
 *
 *   - The Queue AppListbox sits in the one toolbar row with the load status.
 *   - Rows are an `.app-table` riding the shared `[data-responsive]` card
 *     cutover (no horizontal scroll on a phone; compact row = evidence ref +
 *     priority, status + due, actions). Row actions: "Open" (ghost link) and
 *     at most ONE secondary — "Assign" on an unassigned row when the viewer
 *     holds REVIEW_ASSIGN (single assign through the shared reviewer picker
 *     and the audited `/reviews/:id/assign` endpoint, step-up honoured).
 *   - The bulk bar keeps bulk assign + coded verdicts, all secondary; the
 *     confirmation (canonical Modal) owns the one primary.
 *   - The selected row uses Evidence Library's selected-row style.
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

import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../lib/feedback/plan-refusal";
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  REVIEWER_OPS_QUEUE_TYPES,
  REVIEWER_VERDICTS,
  identifierLabel,
  type ReviewerOpsQueueType,
} from "@proovra/shared";

import {
  PageShell,
  PageSection,
} from "../../../../components/ui";
// TEAM-UI-SPEC (structure) — the one review page header (icon title row, no eyebrow).
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId, useCan, usePlanFeatureGate } from "../../../../lib/platform-context";
import { useOptionalPlatformContext } from "../../../../lib/platform-context/PlatformContextProvider";
import { recordReference } from "../../../../lib/short-id";
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
import {
  isQueueRowActionable,
  toQueueRows,
  type QueueRow,
} from "../../../../components/reviewer-experience/queueRow";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { ReviewDestinationLink } from "../../../../components/reviewer-experience/ReviewDestinationLink";
import {
  useReviewDestination,
  type ReviewDestination,
} from "../../../../components/reviewer-experience/reviewDestination";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import {
  ReviewerPickerModal,
  useReviewerPicker,
} from "../../../../components/reviewer-experience/ReviewerPickerModal";
import {
  StepUpModal,
  isStepUpCancelled,
  stepUpCancelMessage,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import "../../../../components/reviewer-experience/review-surfaces.css";


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
/**
 * TEAM-SPEC R3 (2026-11-23) — the queue options: the shared catalog plus the
 * handoff slices the reviewer-ops queue route derives from the current
 * decision round (queue=AWAITING_SECOND_REVIEW | AWAITING_ADJUDICATION).
 */
const HANDOFF_QUEUE_OPTIONS = ["AWAITING_SECOND_REVIEW", "AWAITING_ADJUDICATION"] as const;
type QueueOption = ReviewerOpsQueueType | (typeof HANDOFF_QUEUE_OPTIONS)[number];
const QUEUE_OPTIONS: readonly QueueOption[] = [...REVIEWER_OPS_QUEUE_TYPES, ...HANDOFF_QUEUE_OPTIONS];
function isQueueOption(value: string | null): value is QueueOption {
  return value !== null && (QUEUE_OPTIONS as readonly string[]).includes(value);
}

const QUEUE_LABELS: Record<QueueOption, string> = {
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
  AWAITING_SECOND_REVIEW: "Awaiting second reviewer",
  AWAITING_ADJUDICATION: "Awaiting adjudication",
};

// Empty-state copy per queue. Each tab gets distinct, bounded copy so
// operators can tell "nothing here right now" from "wrong tab".
const EMPTY_STATE_COPY: Record<QueueOption, string> = {
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
  AWAITING_SECOND_REVIEW: "No reviews are waiting for an independent second reviewer.",
  AWAITING_ADJUDICATION: "No reviewer disagreements are waiting for adjudication.",
};

/** TEAM-UI-SPEC (structure) — a short, plain subtitle. */
const REVIEW_QUEUES_SUBTITLE =
  "Triage, assign and bulk-act on reviews in this workspace.";

export default function QueuesPage() {
  return (
    <PageRouteGate routeId="workspace.review_queues">
      <QueuesShell />
    </PageRouteGate>
  );
}

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

/** A bulk denial / per-item refusal, as a person reads it. */
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
      return code ? identifierLabel(code).toLowerCase() : "not applied";
  }
}

function QueuesShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = useActiveSpaceId();
  // TEAM-SPEC R1 — bulk is offered on the effective plan + role capability.
  const bulkPlanIncluded = usePlanFeatureGate("reviewQueuesIncluded");
  const canBulk = useCan("BULK_ACTIONS");
  const canAssignRole = useCan("REVIEW_ASSIGN");
  const canDecideRole = useCan("REVIEWER_OPS_ACT");
  const bulkAssignAllowed = bulkPlanIncluded && canBulk && canAssignRole;
  const bulkCodeAllowed = bulkPlanIncluded && canBulk && canDecideRole;
  const bulkAllowed = bulkAssignAllowed || bulkCodeAllowed;
  // The QC row renders only where /review/qc opens (or a switch would open it).
  const qcDestination = useReviewDestination("workspace.review_qc", { label: "Open QC samples" });
  // Filter-race guard: bumped by every FIRST-page read; a response carrying an
  // older generation belongs to a filter or workspace the reviewer has left.
  const queueGenerationRef = useRef(0);
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
  const initialFilter: QueueOption = isQueueOption(initialQueue) ? initialQueue : "MY_REVIEWS";
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueOption>(initialFilter);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  // Selection state survives across pages: a row id that was selected
  // on page 1 stays selected after Load-more appends page 2. The
  // server-side bulk cap (100) is still enforced at the slice
  // boundary inside runDecide / runAssign.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // Per-item outcome of the most recent bulk call, keyed by workflow id.
  const [bulkOutcomes, setBulkOutcomes] = useState<ReadonlyMap<string, BulkOutcome> | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<
    | null
    | {
        kind: "DECIDE";
        verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";
      }
    | { kind: "ASSIGN"; assigneeUserId: string }
  >(null);
  // Reviewer picker (shared, canonical Modal). `pickerTarget` says what the
  // choice is for: the bulk selection (handed to the confirm modal) or one
  // row (assigned directly through the audited single-assign endpoint).
  const picker = useReviewerPicker(teamId);
  // TEAM-UI-SPEC (queues round) — the assignee reads "You", a display name
  // or "Unassigned", never a raw id. Names come from the reviewer list the
  // picker already loads (kept after it closes); otherwise the same human
  // "Reviewer ref …" the inspector falls back to.
  const platform = useOptionalPlatformContext();
  const viewerUserId =
    platform?.envelope?.user?.id ?? platform?.envelope?.account?.userId ?? null;
  const [reviewerNames, setReviewerNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (picker.state?.kind !== "READY") return;
    const next = new Map<string, string>();
    for (const r of picker.state.reviewers) {
      const name = r.displayName?.trim();
      if (name) next.set(r.userId, name);
    }
    setReviewerNames(next);
  }, [picker.state]);
  const assigneeLabel = (userId: string | null): string =>
    !userId
      ? "Unassigned"
      : userId === viewerUserId
        ? "You"
        : reviewerNames.get(userId) ?? recordReference("Reviewer", userId);
  const [pickerTarget, setPickerTarget] = useState<
    null | { kind: "BULK" } | { kind: "ROW"; workflowId: string }
  >(null);
  const [rowAssignBusy, setRowAssignBusy] = useState(false);
  const stepUp = useStepUpAction({ teamId });
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
      const generation =
        cursor === null ? ++queueGenerationRef.current : queueGenerationRef.current;
      const isStale = () =>
        requestTeamId !== activeTeamRef.current ||
        generation !== queueGenerationRef.current;
      const url =
        cursor === null
          ? `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${encodeURIComponent(filter)}&limit=${QUEUE_PAGE_LIMIT}`
          : `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${encodeURIComponent(filter)}&limit=${QUEUE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
      try {
        const res = await apiFetch(url, { method: "GET" });
        // Stale rejection — the workspace or the filter changed mid-flight.
        if (isStale()) return;
        const pageRows = toQueueRows(res?.rows as ReadonlyArray<unknown> | undefined);
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
        if (isStale()) return;
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
        if (isPlanRefusal(err)) {
          // PRO-R2-14 — the plan, not an outage.
          setRefreshError(PLAN_REFUSAL_COPY);
        } else if (code === "INVALID_CURSOR") {
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
  // A new filter shows "Loading…" until ITS rows arrive, never the previous
  // filter's rows under the new label.
  useEffect(() => {
    setRows(null);
    setNextCursor(null);
    setBulkOutcomes(null);
  }, [filter, teamId]);

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
  const qcOpens = qcDestination?.kind === "link";
  const refreshQc = useCallback(async () => {
    // Only ask for the count where the QC page opens for this actor.
    if (!qcOpens) return;
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
  }, [teamId, qcOpens]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const queue = searchParams.get("queue");
    if (isQueueOption(queue) && queue !== filter) {
      setFilter(queue);
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
    // T-167 (stage B) — the bulk door is step-up gated (bulk checkbox,
    // session risk) and age gated; the shared dialog satisfies it in place.
    let res: Awaited<ReturnType<typeof bulkDecide>>;
    try {
      res = await stepUp.runStepUpAction((headers) =>
        bulkDecide({ verdict, workflowIds: ids, teamId }, { headers, rethrowChallenges: true }),
      );
    } catch (err) {
      setBanner(
        isStepUpCancelled(err)
          ? stepUpCancelMessage(err, "Nothing was changed: identity confirmation was cancelled.")
          : toSafeUserError(err, { message: "The bulk action could not be completed. Nothing was changed." }).message,
      );
      setPendingConfirmation(null);
      return;
    }
    // PRO-R2-02 — this writes a coded verdict VALUE, not a review decision.
    setBanner(summariseOutcome(`Coded verdict "${identifierLabel(verdict)}"`, ids.length, res));
    setBulkOutcomes(outcomeMap(res));
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
    setBulkOutcomes(outcomeMap(res));
    setSelected(new Set());
    setPendingConfirmation(null);
    await refresh();
  }

  const openReviewerPicker = (target: { kind: "BULK" } | { kind: "ROW"; workflowId: string }) => {
    setPickerTarget(target);
    void picker.open();
  };
  const closePicker = () => {
    picker.close();
    setPickerTarget(null);
  };

  // One row, one reviewer: the audited single-assign endpoint (the same one
  // the console and the inspector use). T-036 (stage B) — assignment is not a
  // step-up action, so there is no step-up wrapper here.
  async function runRowAssign(workflowId: string, assigneeUserId: string) {
    if (!teamId) return;
    setRowAssignBusy(true);
    try {
      await apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, assignedToUserId: assigneeUserId, note: null }),
      });
      setBanner("Reviewer assigned.");
      closePicker();
      await refresh();
    } catch (err) {
      setBanner(toSafeUserError(err, { message: "Could not assign reviewer." }).message);
      closePicker();
    } finally {
      setRowAssignBusy(false);
    }
  }

  if (!teamId) {
    return (
      <PageShell
        data-reviewer-queues-page
        header={
          <ReviewPageHeader title="Review queues" subtitle={REVIEW_QUEUES_SUBTITLE} />
        }
      >
        <section className="app-panel">
          <EmptyState
            title="Select a workspace"
            purpose="Choose an active workspace before loading review queues."
          />
        </section>
      </PageShell>
    );
  }

  const visibleRowCount = rows?.length ?? 0;
  const hasMore = nextCursor !== null;

  return (
    <PageShell
      data-reviewer-queues-page
      header={
        <ReviewPageHeader title="Review queues" subtitle={REVIEW_QUEUES_SUBTITLE} />
      }
    >
      <ReviewHubNav active="queues" />
      {/* TEAM-UI-SPEC §3 — the Queue AppListbox and the load status in ONE row. */}
      <div className="app-inner-surface review-toolbar" data-reviewer-queue-toolbar>
        <span className="review-toolbar__label">Queue</span>
        <AppListbox
          value={filter}
          ariaLabel="Queue"
          options={[
            ...REVIEWER_OPS_QUEUE_TYPES.map((q) => ({ value: q, label: QUEUE_LABELS[q] })),
            ...HANDOFF_QUEUE_OPTIONS.map((q) => ({ value: q, label: QUEUE_LABELS[q] })),
          ]}
          onChange={(selected) => {
            const next = selected as QueueOption;
            setFilter(next);
            setSelected(new Set());
            router.replace(`/review/queues?queue=${encodeURIComponent(next)}`, { scroll: false });
          }}
          triggerProps={{ "data-reviewer-queue-filter": "" }}
        />
        <span className="review-toolbar__spacer" />
        <span className="app-field-help" data-reviewer-queue-load-status>
          {visibleRowCount} loaded · {hasMore ? "more available" : "all loaded"} · last refresh{" "}
          {lastRefreshedAt ? formatUserDateTime(lastRefreshedAt) : "not yet"}
        </span>
      </div>

      {qcDestination ? (
        <QcDiscoveryCard
          state={qcState}
          destination={qcDestination}
          onRetry={() => void refreshQc()}
        />
      ) : null}

      {/* PHASE 12B — evidence-request review queue (GET /v1/review/queue).
          A sibling domain to the workflow queue below, not a duplicate:
          see _evidence-request-queue.tsx for the parity analysis. */}
      <EvidenceRequestReviewQueue teamId={teamId} activeTeamRef={activeTeamRef} />

      <QueueIntelligenceNotice
        state={intelligenceState}
        onRetry={refreshIntelligence}
      />

      {bulkAllowed ? (
        <BulkBar
          selectedCount={selected.size}
          canAssign={bulkAssignAllowed}
          canCode={bulkCodeAllowed}
          onDecide={(verdict) =>
            setPendingConfirmation({ kind: "DECIDE", verdict })
          }
          onAssign={() => openReviewerPicker({ kind: "BULK" })}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {banner ? (
        <div className="app-alert" role="status" data-bulk-banner>
          {banner}
          {bulkOutcomes && [...bulkOutcomes.values()].some((o) => !o.ok) ? (
            <ul data-bulk-failures>
              {[...bulkOutcomes.values()]
                .filter((o) => !o.ok)
                .map((o) => {
                  const row = rows?.find((r) => r.id === o.workflowId);
                  return (
                    <li key={o.workflowId} data-bulk-failure={o.workflowId}>
                      {row ? queueEvidenceRef(row) : recordReference("Review", o.workflowId)}
                      : {bulkReasonLabel(o.denial)}
                    </li>
                  );
                })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {refreshError ? (
        <div className="app-alert app-alert--danger" role="alert" data-reviewer-queue-error>
          {refreshError}
        </div>
      ) : null}

      {rows === null ? (
        <p className="app-field-help" aria-live="polite" data-reviewer-queue-loading>
          Loading…
        </p>
      ) : (
        <PageSection>
          <div className="app-table-surface app-table-surface--scroll" data-ui-datatable-scroll>
            <table
              className="app-table review-rows"
              data-responsive
              data-review-selectable={bulkAllowed ? "true" : "false"}
              data-reviewer-queue-table
            >
              <thead>
                <tr>
                  {bulkAllowed ? (
                    <th>
                      <input
                        type="checkbox"
                        className="app-checkbox"
                        aria-label="Select all visible reviews"
                        data-reviewer-queue-select-all
                        checked={allSelected}
                        onChange={toggleAll}
                      />
                    </th>
                  ) : null}
                  <th>Evidence</th>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Signals</th>
                  <th>Assignee</th>
                  <th>Due</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const isSelected = selected.has(r.id);
                  const offerAssign =
                    canAssignRole && !r.assignedToUserId && isQueueRowActionable(r);
                  return (
                    <tr
                      key={r.id}
                      data-reviewer-queue-row={r.id}
                      data-reviewer-queue-selected={isSelected ? "true" : "false"}
                      data-review-row-selected={isSelected ? "true" : undefined}
                      data-reviewer-queue-bulk-outcome={
                        bulkOutcomes?.get(r.id) ? (bulkOutcomes.get(r.id)!.ok ? "ok" : "failed") : undefined
                      }
                      onClick={bulkAllowed ? (e) => toggleOne(idx, e) : undefined}
                    >
                      {bulkAllowed ? (
                        <td data-review-cell="check" data-label="">
                          <input
                            type="checkbox"
                            className="app-checkbox"
                            aria-label={`Select review of ${queueEvidenceRef(r)}`}
                            data-reviewer-queue-checkbox={r.id}
                            checked={isSelected}
                            onChange={() => null}
                          />
                        </td>
                      ) : null}
                      <td data-review-cell="ref" data-label="Evidence" onClick={(e) => e.stopPropagation()}>
                        {/* TEAM-UI-SPEC (queues round) — the console's human
                            evidence reference, never a raw truncated id. */}
                        <Link href={`/reviewer-ops/${r.id}`} className="review-rows__ref" data-reviewer-queue-ref={r.id}>
                          {queueEvidenceRef(r)}
                        </Link>
                      </td>
                      <td data-review-cell="extra" data-label="Workflow">
                        <span className="app-table__muted">{recordReference("Review", r.id)}</span>
                      </td>
                      <td data-review-cell="status" data-label="Status">
                        {r.status ? (
                          <Badge tone="info" subtle>
                            {identifierLabel(r.status)}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-review-cell="priority" data-label="Priority">
                        {r.priority ? (
                          <Badge tone={queuePriorityTone(r.priority)} subtle>
                            {identifierLabel(r.priority)}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        data-review-cell="signals"
                        data-label="Signals"
                        data-review-signals-scored={
                          intelligenceState.kind === "READY" && intelligenceState.byWorkflowId.has(r.id)
                            ? "true"
                            : "false"
                        }
                      >
                        <QueueSignalCell
                          state={intelligenceState}
                          intelligence={
                            intelligenceState.kind === "READY"
                              ? intelligenceState.byWorkflowId.get(r.id)
                              : undefined
                          }
                        />
                      </td>
                      <td data-review-cell="assignee" data-label="Assignee">
                        <span className="app-table__muted" data-reviewer-queue-assignee={r.id}>
                          {assigneeLabel(r.assignedToUserId)}
                        </span>
                      </td>
                      <td data-review-cell="due" data-label="Due">
                        <span className="app-table__muted">{r.dueAt ? formatUserDate(r.dueAt) : "—"}</span>
                      </td>
                      <td data-review-cell="actions" data-label="" onClick={(e) => e.stopPropagation()}>
                        <div className="app-table__actions">
                          {/* Canonical drill-down into the reviewer detail route. */}
                          <Link
                            href={`/reviewer-ops/${r.id}`}
                            className="app-ghost-action"
                            data-reviewer-queue-open={r.id}
                          >
                            Open
                          </Link>
                          {offerAssign ? (
                            <button
                              type="button"
                              className="app-secondary-action"
                              data-reviewer-queue-assign={r.id}
                              disabled={rowAssignBusy}
                              onClick={() => openReviewerPicker({ kind: "ROW", workflowId: r.id })}
                            >
                              Assign
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={bulkAllowed ? 9 : 8} data-review-cell="full" data-label="" data-reviewer-queue-empty={filter}>
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
            <div className="review-toolbar" data-reviewer-queue-load-more-wrap>
              <button
                type="button"
                className="app-secondary-action"
                data-reviewer-queue-load-more
                disabled={loadingMore}
                aria-busy={loadingMore || undefined}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
              <span className="app-field-help">
                Showing {visibleRowCount} item
                {visibleRowCount === 1 ? "" : "s"}. More rows match this
                filter.
              </span>
            </div>
          ) : null}
        </PageSection>
      )}

      {picker.state && pickerTarget ? (
        <ReviewerPickerModal
          state={picker.state}
          title={pickerTarget.kind === "ROW" ? "Assign reviewer" : "Assign to reviewer"}
          busy={rowAssignBusy}
          onRetry={() => void picker.open()}
          onCancel={closePicker}
          onSelect={(userId) => {
            if (pickerTarget.kind === "ROW") {
              void runRowAssign(pickerTarget.workflowId, userId);
              return;
            }
            closePicker();
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
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

/** Priority as a semantic Badge tone (never a raw enum on its own). */
/** The console's human evidence reference ("Evidence ref XXXXXX"). */
function queueEvidenceRef(r: QueueRow): string {
  return r.evidenceId ? recordReference("Evidence", r.evidenceId) : recordReference("Review", r.id);
}

function queuePriorityTone(priority: string): "risk" | "pending" | "info" | "neutral" {
  switch (priority.toUpperCase()) {
    case "CRITICAL":
    case "URGENT":
    case "HIGH":
      return "risk";
    case "MEDIUM":
    case "NORMAL":
      return "pending";
    case "LOW":
      return "info";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Phase RW3-3 — QC discovery card.
//
// Renders the tagged QcDiscoveryState at the top of the queues page so
// operators can SEE pending QC work without leaving the queues surface.
// The card is a navigation hint — it links to /review/qc rather than
// mixing QC rows into the workflow-centric queue table.
//
//   - LOADING:    bounded loading line.
//   - FORBIDDEN:  bounded denial copy + link still rendered.
//   - ERROR:      bounded error copy + retry button. No fake zero.
//   - READY:      shows pendingCount (may be 0 — surfaced honestly as
//                 "No QC samples are awaiting verdict.") and a link
//                 to /review/qc.
//
// TEAM-UI-SPEC §1 — an app-panel row; Retry secondary, the link ghost.
// ---------------------------------------------------------------------------
function QcDiscoveryCard({
  state,
  destination,
  onRetry,
}: {
  state: QcDiscoveryState;
  destination: NonNullable<ReviewDestination>;
  onRetry: () => void;
}) {
  // A switch destination: the count belongs to another workspace, so the card
  // says only where QC lives and offers the switch (never upgrade copy).
  if (destination.kind === "switch") {
    return (
      <div
        className="app-panel review-toolbar"
        data-reviewer-queue-qc-card
        data-reviewer-queue-qc-state="SWITCH"
      >
        <strong className="review-toolbar__label">QC samples</strong>
        <ReviewDestinationLink destination={destination} testId="reviewer-queue-qc-switch" />
      </div>
    );
  }
  return (
    <div
      className="app-panel review-toolbar"
      data-reviewer-queue-qc-card
      data-reviewer-queue-qc-state={state.kind}
    >
      <strong className="review-toolbar__label">QC samples</strong>
      {state.kind === "LOADING" ? (
        <span className="app-field-help" data-reviewer-queue-qc-loading>
          Loading pending count…
        </span>
      ) : null}
      {state.kind === "READY" ? (
        state.pendingCount > 0 ? (
          <span className="app-chip app-chip--warn" data-reviewer-queue-qc-count={state.pendingCount}>
            {state.pendingCount} sample
            {state.pendingCount === 1 ? "" : "s"} awaiting verdict.
          </span>
        ) : (
          <span className="app-field-help" data-reviewer-queue-qc-empty>
            No QC samples are awaiting verdict.
          </span>
        )
      ) : null}
      {state.kind === "FORBIDDEN" ? (
        <span className="app-field-error" data-reviewer-queue-qc-denied>
          {state.message}
        </span>
      ) : null}
      {state.kind === "ERROR" ? (
        <span className="app-field-error" data-reviewer-queue-qc-error>
          {state.message}
        </span>
      ) : null}
      <span className="review-toolbar__spacer" />
      {state.kind === "ERROR" ? (
        <button
          type="button"
          className="app-secondary-action"
          data-reviewer-queue-qc-retry
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
      <ReviewDestinationLink
        destination={destination}
        testId="reviewer-queue-qc-link"
        className="app-ghost-action"
      >
        <span data-reviewer-queue-qc-link>Open QC samples</span>
      </ReviewDestinationLink>
    </div>
  );
}

function BulkBar({
  selectedCount,
  canAssign,
  canCode,
  onDecide,
  onAssign,
  onClear,
}: {
  selectedCount: number;
  /** review.bulk + review.assign (REVIEW_ASSIGN). */
  canAssign: boolean;
  /** review.bulk + review.decide (REVIEWER_OPS_ACT). */
  canCode: boolean;
  onDecide: (
    verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO",
  ) => void;
  onAssign: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) {
    return (
      <p className="app-field-help" data-bulk-bar data-bulk-bar-state="empty">
        Select rows with the checkboxes or shift-click. Bulk actions
        appear when at least one row is selected (≤ {BULK_ACTION_CAP} per call).
      </p>
    );
  }
  return (
    <ActiveBulkBar
      selectedCount={selectedCount}
      canAssign={canAssign}
      canCode={canCode}
      onDecide={onDecide}
      onAssign={onAssign}
      onClear={onClear}
    />
  );
}

type BulkVerdict = "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";

/** The coded-verdict vocabulary the bulk bar offers (PENDING is not a code). */
const BULK_CODE_VERDICTS = REVIEWER_VERDICTS.filter((v) => v !== "PENDING") as ReadonlyArray<BulkVerdict>;

function ActiveBulkBar({
  selectedCount,
  canAssign,
  canCode,
  onDecide,
  onAssign,
  onClear,
}: {
  selectedCount: number;
  canAssign: boolean;
  canCode: boolean;
  onDecide: (verdict: BulkVerdict) => void;
  onAssign: () => void;
  onClear: () => void;
}) {
  // TEAM-UI-SPEC (queues round) — ONE "Code verdict" AppListbox + ONE Apply
  // replace the four "Code verdict: …" buttons that stacked on a phone. Apply
  // opens the same canonical confirm Modal with the chosen verdict.
  const [verdict, setVerdict] = useState<BulkVerdict | null>(null);
  const cappedCount = Math.min(selectedCount, BULK_ACTION_CAP);
  const overCap = selectedCount > BULK_ACTION_CAP;
  // TEAM-UI-SPEC §4 — every bulk control is secondary; the confirmation
  // dialog carries the one primary.
  return (
    <div
      className="app-inner-surface review-toolbar"
      data-bulk-bar
      data-bulk-bar-state="active"
      data-bulk-bar-selected={selectedCount}
    >
      <strong className="review-toolbar__label">{selectedCount} selected</strong>
      {overCap ? (
        <span className="app-chip app-chip--warn" data-bulk-bar-cap-note>
          First {cappedCount} will be applied; server cap is {BULK_ACTION_CAP}
        </span>
      ) : null}
      {canAssign ? (
        <button
          type="button"
          className="app-secondary-action"
          data-bulk-action="ASSIGN"
          onClick={onAssign}
        >
          Bulk assign
        </button>
      ) : null}
      {canCode ? (
        <span className="review-bulk-code" data-bulk-code-verdict-group>
          {/* PRO-R2-02 — named for what it does: a coded value, not a decision. */}
          <AppListbox<BulkVerdict>
            value={verdict}
            ariaLabel="Code verdict"
            placeholder="Code verdict"
            options={BULK_CODE_VERDICTS.map((v) => ({ value: v, label: identifierLabel(v) }))}
            onChange={(v) => setVerdict(v)}
            renderValue={(o) => (o ? `Code verdict: ${o.label}` : "Code verdict")}
            triggerProps={{ "data-bulk-code-verdict-select": "" }}
          />
          <button
            type="button"
            className="app-secondary-action"
            data-bulk-action="CODE_VERDICT"
            data-bulk-code-verdict={verdict ?? ""}
            disabled={verdict === null}
            data-disabled-reason={verdict === null ? "Choose a code verdict first." : undefined}
            onClick={() => {
              if (verdict) onDecide(verdict);
            }}
            title="Sets the coded verdict field only; it does not approve, reject or close the review."
          >
            Apply
          </button>
        </span>
      ) : null}
      <span className="review-toolbar__spacer" />
      <button
        type="button"
        className="app-ghost-action"
        data-bulk-clear
        onClick={onClear}
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
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  // PRO-R2-11 — one submission per confirmation: Apply is busy-guarded.
  const [applying, setApplying] = useState(false);
  return (
    <Modal
      open
      title={
        confirmation.kind === "DECIDE"
          ? `Set the coded verdict "${identifierLabel(confirmation.verdict)}"`
          : "Confirm bulk assign"
      }
      onClose={onCancel}
      dismissDisabled={applying}
      testid="bulk-confirm"
      footer={
        <>
          <button
            type="button"
            className="app-secondary-action"
            data-bulk-confirm-cancel
            disabled={applying}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
            data-bulk-confirm-go
            disabled={applying}
            aria-busy={applying || undefined}
            onClick={() => {
              if (applying) return;
              setApplying(true);
              void Promise.resolve(onConfirm()).finally(() => setApplying(false));
            }}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <div data-bulk-confirm data-bulk-confirm-kind={confirmation.kind}>
        <p className="app-field-help">
          This will apply the action to{" "}
          <strong>{Math.min(count, BULK_ACTION_CAP)}</strong>{" "}
          workflows. The audit trail records each per-item outcome.
          {confirmation.kind === "DECIDE"
            ? " It records a coded verdict value only: no review is approved, rejected, escalated or closed."
            : null}
        </p>
      </div>
    </Modal>
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
    return `${action} refused: ${bulkReasonLabel((res as any).denial)}.`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  return `${action}: ${r?.succeeded ?? 0} of ${r?.total ?? requested} applied.`;
}

/** Per-item outcomes of a bulk response, keyed by workflow id (null on a whole-call refusal). */
function outcomeMap(res: unknown): ReadonlyMap<string, BulkOutcome> | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outcomes = (res as any)?.outcomes;
  if (!Array.isArray(outcomes)) return null;
  const m = new Map<string, BulkOutcome>();
  for (const o of outcomes as BulkOutcome[]) {
    if (o && typeof o.workflowId === "string") m.set(o.workflowId, o);
  }
  return m;
}

