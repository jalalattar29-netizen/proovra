"use client";

/**
 * Reviewer queue intelligence hydration (PHASE 12B), the Inbox's signals.
 *
 * Consumes POST /v1/reviewer-ops/queue-intelligence (the single server-side
 * projection over the priority engine, the stuck detector, reviewer workload
 * pressure and the governance blockers) for the rows the Inbox shows.
 *
 * Hard rules honoured here:
 *   - ZERO client ranking or scoring. Every SLA signal, escalation, blocker
 *     and stall below is read verbatim from the server projection.
 *   - Bounded request: the route caps `workflowIds` at 100 per call.
 *   - T-095 (stage D) — only NEW rows are scored: "Load more" asks for the
 *     appended ids, never re-scores the rows already projected. A changed view
 *     or workspace (`resetKey`) starts over.
 *   - Workspace isolation + stale-context rejection: a response from a
 *     previous workspace generation is DISCARDED, never merged.
 *   - Denial and failure are explicit states; the Inbox keeps rendering
 *     without intelligence rather than blanking.
 *   - No raw error text: failures go through toSafeUserError.
 *
 * Presentation (T-069 / T-071): the row's signals are ONE plain sentence,
 * "Needs attention because …", in the canonical plain status text with the
 * severity tone of each reason (`lib/reviewer-workspace/review-status.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EscalationSeverity,
  PriorityScoreResult,
  StuckClassification,
  WorkflowSlaStatus,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { attentionReasons, attentionSentence } from "../../lib/reviewer-workspace/review-status";
import { AppStatusText } from "../app-primitives/AppStatusText";

// ---------------------------------------------------------------------------
// Server projection shape (mirrors QueueIntelligenceResult on the API side)
// ---------------------------------------------------------------------------

export type QueueGovernanceBlockers = {
  legalHold: boolean;
  immutableDrift: boolean;
  packageBlocked: boolean;
  exportBlocked: boolean;
  retentionExpired: boolean;
};

/**
 * T-061 (stage C) — the SLA signal: Overdue, Due soon or Paused, from the same
 * rollup the Review page header uses. Falls back to the stored status (OVERDUE
 * read as a breach) for an older API.
 */
export function slaSignalLabel(sla: { status?: string | null; signal?: string | null } | null | undefined): string | null {
  if (!sla) return null;
  const signal = sla.signal !== undefined ? sla.signal : sla.status === "BREACHED" || sla.status === "OVERDUE" ? "OVERDUE" : sla.status === "DUE_SOON" ? "DUE_SOON" : sla.status === "PAUSED" ? "PAUSED" : null;
  switch (signal) {
    case "OVERDUE":
      return "Overdue";
    case "DUE_SOON":
      return "Due soon";
    case "PAUSED":
      return "Paused";
    default:
      return null;
  }
}

export type QueueWorkflowIntelligence = {
  workflowId: string;
  evidenceId: string | null;
  status: string;
  priority: PriorityScoreResult;
  stuckState: StuckClassification;
  reviewerPressure: "available" | "balanced" | "overloaded" | null;
  governanceBlockers: QueueGovernanceBlockers;
  slaState: {
    status: WorkflowSlaStatus;
    /** T-061 (stage C) — the Review page's presented rollup; older APIs omit it. */
    signal?: "OVERDUE" | "DUE_SOON" | "PAUSED" | null;
    dueAtUtc: string | null;
    breachedAtUtc: string | null;
  };
  escalationState: {
    activeEscalationId: string | null;
    severity: EscalationSeverity;
    /** unit: escalations (T-049). */
    activeCount?: number;
  };
  queueAging: {
    createdAtUtc: string;
    /** T-063 (stage C) — null on a finished review (no age). */
    daysOpen: number | null;
    agedFrom?: "assigned" | "created" | null;
    lastReviewerTouchAtUtc: string | null;
  };
};

export type QueueIntelligenceState =
  | { kind: "IDLE" }
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | {
      kind: "READY";
      byWorkflowId: ReadonlyMap<string, QueueWorkflowIntelligence>;
      /** Rows the server could not project (bounded reason codes). */
      degradedCount: number;
      /** Rows above the server's 100-per-call cap that were not requested. */
      notRequestedCount: number;
    };

/** Server-enforced bound (services/api/src/routes/reviewer-ops.routes.ts). */
export const QUEUE_INTELLIGENCE_MAX_IDS = 100;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hydrates the supplied workflow ids with the server projection.
 *
 * `activeTeamRef` must hold the CURRENT active workspace id. It is read after
 * every await so a response that belongs to a previous workspace generation
 * is dropped instead of rendered under the new tenant. `resetKey` names the
 * row set (the view): when it changes, every row is scored afresh; otherwise
 * only ids not projected yet are requested (T-095).
 */
export function useQueueIntelligence(
  teamId: string | null,
  workflowIds: ReadonlyArray<string>,
  activeTeamRef: { readonly current: string | null },
  resetKey: string = "",
): { state: QueueIntelligenceState; refresh: () => void } {
  const [state, setState] = useState<QueueIntelligenceState>({ kind: "IDLE" });
  const idsKey = workflowIds.join(",");
  const idsRef = useRef<ReadonlyArray<string>>(workflowIds);
  idsRef.current = workflowIds;
  // The projections already held for this row set, and the degraded count.
  const heldRef = useRef<{ key: string; map: Map<string, QueueWorkflowIntelligence>; asked: Set<string>; degraded: number }>({
    key: "",
    map: new Map(),
    asked: new Set(),
    degraded: 0,
  });

  const load = useCallback(
    async (opts: { full?: boolean } = {}) => {
      const ids = idsRef.current;
      if (!teamId) {
        setState({ kind: "IDLE" });
        return;
      }
      const setKey = `${teamId}|${resetKey}`;
      if (heldRef.current.key !== setKey || opts.full) {
        heldRef.current = { key: setKey, map: new Map(), asked: new Set(), degraded: 0 };
      }
      const held = heldRef.current;
      // An id already asked for (projected or reported as not projectable) is
      // never asked again for this row set.
      const missing = ids.filter((id) => !held.asked.has(id));
      if (missing.length === 0) {
        setState({ kind: "READY", byWorkflowId: new Map(held.map), degradedCount: held.degraded, notRequestedCount: 0 });
        return;
      }
      const requested = missing.slice(0, QUEUE_INTELLIGENCE_MAX_IDS);
      const notRequestedCount = missing.length - requested.length;
      const requestTeamId = teamId;
      for (const id of requested) held.asked.add(id);
      if (held.map.size === 0) setState({ kind: "LOADING" });
      try {
        const res = (await apiFetch("/v1/reviewer-ops/queue-intelligence", {
          method: "POST",
          body: JSON.stringify({ teamId: requestTeamId, workflowIds: requested }),
        })) as {
          projections?: ReadonlyArray<QueueWorkflowIntelligence>;
          degradations?: ReadonlyArray<{ workflowId: string; reason: string }>;
        } | null;
        // Stale-context rejection: another workspace or another view.
        if (requestTeamId !== activeTeamRef.current || heldRef.current !== held) return;
        for (const p of res?.projections ?? []) {
          if (p && typeof p.workflowId === "string") held.map.set(p.workflowId, p);
        }
        held.degraded += (res?.degradations ?? []).length;
        setState({
          kind: "READY",
          byWorkflowId: new Map(held.map),
          degradedCount: held.degraded,
          notRequestedCount,
        });
      } catch (err) {
        if (requestTeamId !== activeTeamRef.current || heldRef.current !== held) return;
        // A failed read may be retried: these ids were not projected.
        for (const id of requested) held.asked.delete(id);
        const status = (err as { statusCode?: number } | null)?.statusCode;
        if (status === 403 || status === 404) {
          setState({
            kind: "FORBIDDEN",
            message: "Queue signals are restricted for your role in this workspace.",
          });
          return;
        }
        setState({
          kind: "ERROR",
          message: toSafeUserError(err, {
            message: "Queue signals could not be loaded. The list itself is unaffected.",
          }).message,
        });
      }
      // `idsKey` is the intentional dependency — `workflowIds` is a new array
      // identity on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [teamId, idsKey, activeTeamRef, resetKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { state, refresh: () => void load({ full: true }) };
}

// ---------------------------------------------------------------------------
// Presentation — every value below is server-provided
// ---------------------------------------------------------------------------

/**
 * T-069 — the row's ONE sentence: "Needs attention because overdue 13 d ·
 * Escalation: High (2 active)". Each reason is plain status text in its
 * severity tone. Nothing when nothing needs attention, or when the row was
 * not scored (the notice above the list says why).
 */
export function QueueAttentionLine({ intelligence }: { intelligence: QueueWorkflowIntelligence | undefined }) {
  const reasons = attentionReasons(intelligence ?? null);
  if (reasons.length === 0) return null;
  return (
    <span className="review-attention" data-inbox-attention={intelligence?.workflowId} title={attentionSentence(reasons) ?? undefined}>
      <span className="review-attention__lead">Needs attention because </span>
      {reasons.map((r, i) => (
        <span key={r.key}>
          {i > 0 ? <span aria-hidden="true"> · </span> : null}
          <AppStatusText tone={r.tone} data-inbox-attention-reason={r.key}>
            {i === 0 ? r.text.charAt(0).toLowerCase() + r.text.slice(1) : r.text}
          </AppStatusText>
        </span>
      ))}
    </span>
  );
}

/** Header strip that reports the intelligence fetch outcome honestly. */
export function QueueIntelligenceNotice({
  state,
  onRetry,
}: {
  state: QueueIntelligenceState;
  onRetry: () => void;
}) {
  if (state.kind === "IDLE" || state.kind === "LOADING") return null;
  if (state.kind === "READY") {
    if (state.degradedCount === 0 && state.notRequestedCount === 0) return null;
    return (
      <div data-queue-intelligence-notice="PARTIAL" className="app-alert">
        {state.degradedCount > 0
          ? `${state.degradedCount} row${state.degradedCount === 1 ? "" : "s"} could not be checked for deadlines and escalations. `
          : ""}
        {state.notRequestedCount > 0
          ? `Signals cover the first ${QUEUE_INTELLIGENCE_MAX_IDS} loaded rows; ${state.notRequestedCount} newer row${state.notRequestedCount === 1 ? "" : "s"} are not checked.`
          : ""}
      </div>
    );
  }
  return (
    <div role="status" data-queue-intelligence-notice={state.kind} className="app-alert">
      {state.message}
      {state.kind === "ERROR" ? (
        <>
          {" "}
          <button type="button" className="app-secondary-action" data-queue-intelligence-retry onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}
