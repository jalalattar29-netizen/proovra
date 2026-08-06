"use client";

/**
 * PHASE 12B (Evidence Operations) — reviewer queue intelligence hydration.
 *
 * Consumes POST /v1/reviewer-ops/queue-intelligence (the single
 * server-side projection that wraps the priority engine, the stuck
 * detector, the assignment ranker, reviewer workload pressure and the
 * governance blockers). The canonical home for this projection is the
 * reviewer console, so it hydrates the rows already rendered by
 * /review/queues rather than living on a parallel surface.
 *
 * Hard rules honoured here:
 *   - ZERO client ranking or scoring. Every band, severity, blocker and
 *     SLA value below is read verbatim from the server projection. The
 *     module does not sort, threshold or recompute anything.
 *   - Bounded request: the route caps `workflowIds` at 100 per call, so
 *     the hook slices the visible rows to that cap and reports the
 *     remainder honestly instead of silently truncating.
 *   - Workspace isolation + stale-context rejection: the teamId used for
 *     the request is compared against the live active-workspace ref when
 *     the response resolves. A response from a previous workspace
 *     generation is DISCARDED, never merged.
 *   - Denial and failure are explicit states; the queue table keeps
 *     rendering without intelligence rather than blanking.
 *   - No raw error text: failures go through toSafeUserError.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EscalationSeverity,
  PriorityScoreResult,
  StuckClassification,
  WorkflowSlaStatus,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { Badge } from "../../../../components/ui/Badge";

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
    dueAtUtc: string | null;
    breachedAtUtc: string | null;
  };
  escalationState: {
    activeEscalationId: string | null;
    severity: EscalationSeverity;
  };
  queueAging: {
    createdAtUtc: string;
    daysOpen: number;
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
 * `activeTeamRef` must hold the CURRENT active workspace id. It is read
 * after every await so a response that belongs to a previous workspace
 * generation is dropped instead of rendered under the new tenant.
 */
export function useQueueIntelligence(
  teamId: string | null,
  workflowIds: ReadonlyArray<string>,
  activeTeamRef: { readonly current: string | null },
): { state: QueueIntelligenceState; refresh: () => void } {
  const [state, setState] = useState<QueueIntelligenceState>({ kind: "IDLE" });
  // Stable identity for the id list so the effect does not re-fire on
  // every render when the underlying rows are unchanged.
  const idsKey = workflowIds.join(",");
  const idsRef = useRef<ReadonlyArray<string>>(workflowIds);
  idsRef.current = workflowIds;

  const load = useCallback(async () => {
    const ids = idsRef.current;
    if (!teamId) {
      setState({ kind: "IDLE" });
      return;
    }
    if (ids.length === 0) {
      setState({
        kind: "READY",
        byWorkflowId: new Map(),
        degradedCount: 0,
        notRequestedCount: 0,
      });
      return;
    }
    const requested = ids.slice(0, QUEUE_INTELLIGENCE_MAX_IDS);
    const notRequestedCount = ids.length - requested.length;
    const requestTeamId = teamId;
    setState({ kind: "LOADING" });
    try {
      const res = (await apiFetch("/v1/reviewer-ops/queue-intelligence", {
        method: "POST",
        body: JSON.stringify({ teamId: requestTeamId, workflowIds: requested }),
      })) as {
        projections?: ReadonlyArray<QueueWorkflowIntelligence>;
        degradations?: ReadonlyArray<{ workflowId: string; reason: string }>;
      } | null;
      // Stale-context rejection: the workspace changed while the
      // projection was in flight, so this payload describes another
      // tenant's queue. Drop it.
      if (requestTeamId !== activeTeamRef.current) return;
      const byWorkflowId = new Map<string, QueueWorkflowIntelligence>();
      for (const p of res?.projections ?? []) {
        if (p && typeof p.workflowId === "string") {
          byWorkflowId.set(p.workflowId, p);
        }
      }
      setState({
        kind: "READY",
        byWorkflowId,
        degradedCount: (res?.degradations ?? []).length,
        notRequestedCount,
      });
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 403 || status === 404) {
        setState({
          kind: "FORBIDDEN",
          message:
            "Queue signals are restricted for your role in this workspace.",
        });
        return;
      }
      setState({
        kind: "ERROR",
        message: toSafeUserError(err, {
          message:
            "Queue signals could not be loaded. The queue itself is unaffected.",
        }).message,
      });
    }
    // `idsKey` is the intentional dependency — `workflowIds` is a new
    // array identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, idsKey, activeTeamRef]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, refresh: () => void load() };
}

// ---------------------------------------------------------------------------
// Presentation — every value below is server-provided
// ---------------------------------------------------------------------------

const BAND_TONE: Record<PriorityScoreResult["band"], "risk" | "pending" | "neutral"> = {
  URGENT: "risk",
  ATTENTION: "pending",
  STANDARD: "neutral",
};

const STUCK_TONE: Record<
  StuckClassification["topSeverity"],
  "risk" | "pending" | "neutral"
> = {
  CRITICAL: "risk",
  HIGH: "risk",
  WARNING: "pending",
  INFO: "neutral",
};

const BLOCKER_LABEL: Record<keyof QueueGovernanceBlockers, string> = {
  legalHold: "Legal hold",
  immutableDrift: "Storage drift",
  packageBlocked: "Packaging blocked",
  exportBlocked: "Export blocked",
  retentionExpired: "Retention expired",
};

const PRESSURE_LABEL: Record<"available" | "balanced" | "overloaded", string> = {
  available: "Reviewer available",
  balanced: "Reviewer balanced",
  overloaded: "Reviewer overloaded",
};

/** Row-level signal cell. Renders nothing but server-projected values. */
export function QueueSignalCell({
  intelligence,
  state,
}: {
  intelligence: QueueWorkflowIntelligence | undefined;
  state: QueueIntelligenceState;
}) {
  if (state.kind === "LOADING") {
    return (
      <span style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
        Loading…
      </span>
    );
  }
  // PHASE 12 — VERTICAL B. Three genuinely different outcomes that were
  // previously collapsed into one word:
  //
  //   RESTRICTED — the server declined to project for this actor. It is
  //                NOT "no signals" and it is NOT a failure.
  //   UNAVAILABLE — the projection call failed. The queue is fine; the
  //                signals are not.
  //   NOT SCORED  — the projection succeeded but did not cover this row
  //                (degraded or above the per-call cap).
  //
  // Collapsing any of these into a zero or a dash would let an operator
  // read "no risk" off a row the platform never actually evaluated.
  if (state.kind === "FORBIDDEN") {
    return (
      <span
        data-queue-signal-state="RESTRICTED"
        title="Queue signals are restricted for your role in this workspace. This row was not evaluated."
        style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
      >
        Restricted
      </span>
    );
  }
  if (state.kind === "ERROR") {
    return (
      <span
        data-queue-signal-state="UNAVAILABLE"
        title="Queue signals could not be loaded. This row was not evaluated."
        style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
      >
        Unavailable
      </span>
    );
  }
  if (!intelligence) {
    return (
      <span
        data-queue-signal-state="NOT_SCORED"
        title="This row was not covered by the queue-signal projection."
        style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
      >
        Not scored
      </span>
    );
  }
  const blockers = (
    Object.keys(BLOCKER_LABEL) as Array<keyof QueueGovernanceBlockers>
  ).filter((k) => intelligence.governanceBlockers?.[k] === true);
  return (
    <div
      data-queue-signal={intelligence.workflowId}
      data-queue-signal-band={intelligence.priority?.band ?? "UNKNOWN"}
      data-queue-signal-stuck={
        intelligence.stuckState?.isStuck ? "true" : "false"
      }
      data-queue-signal-blockers={blockers.length}
      style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
    >
      {intelligence.priority?.band ? (
        <Badge tone={BAND_TONE[intelligence.priority.band] ?? "neutral"}>
          {intelligence.priority.band}
        </Badge>
      ) : null}
      {intelligence.stuckState?.isStuck ? (
        <Badge tone={STUCK_TONE[intelligence.stuckState.topSeverity] ?? "pending"}>
          Stuck
        </Badge>
      ) : null}
      {intelligence.slaState?.status &&
      intelligence.slaState.status !== "ON_TRACK" ? (
        <Badge tone="pending">SLA {intelligence.slaState.status}</Badge>
      ) : null}
      {intelligence.escalationState?.activeEscalationId ? (
        <Badge tone="risk">
          Escalated {intelligence.escalationState.severity}
        </Badge>
      ) : null}
      {blockers.map((k) => (
        <Badge key={k} tone="risk">
          {BLOCKER_LABEL[k]}
        </Badge>
      ))}
      {intelligence.reviewerPressure ? (
        <span style={{ fontSize: 11, color: "var(--ink-secondary, #475569)" }}>
          {PRESSURE_LABEL[intelligence.reviewerPressure]}
        </span>
      ) : null}
      <span style={{ fontSize: 11, color: "var(--ink-secondary, #475569)" }}>
        {/* An absent aging figure is unknown, not zero days open. */}
        {typeof intelligence.queueAging?.daysOpen === "number"
          ? `Open ${intelligence.queueAging.daysOpen}d`
          : "Age not recorded"}
      </span>
    </div>
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
      <div
        data-queue-intelligence-notice="PARTIAL"
        style={noticeStyle}
      >
        {state.degradedCount > 0
          ? `${state.degradedCount} row${state.degradedCount === 1 ? "" : "s"} could not be scored and show no signals. `
          : ""}
        {state.notRequestedCount > 0
          ? `Signals cover the first ${QUEUE_INTELLIGENCE_MAX_IDS} loaded rows; ${state.notRequestedCount} newer row${state.notRequestedCount === 1 ? "" : "s"} are not scored.`
          : ""}
      </div>
    );
  }
  return (
    <div
      role="status"
      data-queue-intelligence-notice={state.kind}
      style={noticeStyle}
    >
      {state.message}
      {state.kind === "ERROR" ? (
        <button
          type="button"
          data-queue-intelligence-retry
          onClick={onRetry}
          style={{
            marginLeft: 8,
            background: "transparent",
            border: "none",
            padding: 0,
            color: "var(--ink-primary, #0f172a)",
            textDecoration: "underline",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

const noticeStyle = {
  padding: "8px 12px",
  background: "var(--surface-muted, #f1f4f9)",
  border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  borderRadius: "var(--radius-md, 8px)",
  fontSize: 12,
  color: "var(--ink-secondary, #475569)",
} as const;
