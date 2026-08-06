"use client";

/**
 * PHASE 12B (Evidence Operations) — evidence-request review queue panel.
 *
 * Consumes GET /v1/review/queue (registered in
 * services/api/src/routes/evidence-requests.routes.ts).
 *
 * WHY THIS IS NOT A DUPLICATE OF THE WORKFLOW QUEUE
 * -------------------------------------------------
 * The reviewer console already renders GET /v1/reviewer-ops/queue. That
 * route projects `ReviewWorkflow` rows (workflow id, verdicts, bulk
 * assign/decide semantics, cursor pagination, REVIEWER_OPS_QUEUE_TYPES
 * branches) and is gated by `requireReviewerActor` / `review.assign`.
 *
 * GET /v1/review/queue projects a DIFFERENT domain entity —
 * `EvidenceRequest` rows (request lifecycle statuses, request priority,
 * assigned reviewer, deliverables) — gated by `requireMember(...,
 * "evidence.read")`. The two cannot be merged without destroying one of
 * the two vocabularies.
 *
 * It also is not a full-parity duplicate of GET /v1/evidence-requests:
 *   - /v1/review/queue owns the `priority` filter
 *     (EVIDENCE_REQUEST_PRIORITIES) that /v1/evidence-requests does NOT
 *     expose, and returns an `items` envelope;
 *   - /v1/evidence-requests owns the `evidenceId` + `caseId` scoping used
 *     by the evidence-detail request panel, and returns `requests`.
 * Neither is a superset, so both are preserved and the unique `priority`
 * filter is made load-bearing here as a real operator control.
 *
 * Hard rules honoured:
 *   - Server-projected queue. No client ranking, scoring or re-ordering.
 *   - Workspace isolation: `teamId` comes from the active workspace and
 *     is required by the route; responses whose workspace generation
 *     changed mid-flight are discarded.
 *   - Reviewer/member authorization is the SERVER's decision; a denial is
 *     rendered as a denial, never as an empty queue.
 *   - No PII: recipient email/phone in the projection are NOT rendered.
 *   - Drill-down goes to the canonical request detail route
 *     /evidence-requests/[id].
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_STATUSES,
  type EvidenceRequestPriority,
  type EvidenceRequestStatus,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDate } from "../../../../lib/date";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";

/** Server cap for GET /v1/review/queue (`limit` max 200). */
const REVIEW_QUEUE_LIMIT = 100;

type ReviewQueueItem = {
  id: string;
  evidenceId: string | null;
  caseId: string | null;
  requestType: string;
  status: string;
  priority: string;
  title: string;
  dueAtUtc: string | null;
  assignedReviewerUserId: string | null;
  createdAt: string;
};

type PanelState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; items: ReadonlyArray<ReviewQueueItem>; loadedAt: string };

const PRIORITY_TONE: Record<EvidenceRequestPriority, "risk" | "pending" | "neutral"> = {
  URGENT: "risk",
  HIGH: "risk",
  NORMAL: "neutral",
  LOW: "neutral",
};

export function EvidenceRequestReviewQueue({
  teamId,
  activeTeamRef,
}: {
  teamId: string | null;
  activeTeamRef: { readonly current: string | null };
}) {
  const [state, setState] = useState<PanelState>({ kind: "LOADING" });
  const [status, setStatus] = useState<EvidenceRequestStatus | "">("");
  const [priority, setPriority] = useState<EvidenceRequestPriority | "">("");
  const [unassignedOnly, setUnassignedOnly] = useState<boolean>(false);

  const load = useCallback(async () => {
    if (!teamId) {
      setState({
        kind: "ERROR",
        message: "Select a workspace before loading the evidence-request queue.",
      });
      return;
    }
    const requestTeamId = teamId;
    setState({ kind: "LOADING" });
    const params = new URLSearchParams({
      teamId: requestTeamId,
      limit: String(REVIEW_QUEUE_LIMIT),
    });
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (unassignedOnly) params.set("unassigned", "true");
    try {
      const res = (await apiFetch(`/v1/review/queue?${params.toString()}`, {
        method: "GET",
      })) as { items?: ReadonlyArray<ReviewQueueItem> } | null;
      // Stale-context rejection.
      if (requestTeamId !== activeTeamRef.current) return;
      setState({
        kind: "READY",
        items: Array.isArray(res?.items) ? res.items : [],
        loadedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      const httpStatus = (err as { statusCode?: number } | null)?.statusCode;
      if (httpStatus === 403 || httpStatus === 404) {
        setState({
          kind: "FORBIDDEN",
          message:
            "Evidence requests are restricted for your role in this workspace.",
        });
        return;
      }
      if (httpStatus === 503) {
        setState({
          kind: "FORBIDDEN",
          message:
            "The evidence-request module is not enabled for this environment.",
        });
        return;
      }
      setState({
        kind: "ERROR",
        message: toSafeUserError(err, {
          message: "The evidence-request queue could not be loaded.",
        }).message,
      });
    }
  }, [teamId, status, priority, unassignedOnly, activeTeamRef]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      variant="admin"
      padding="compact"
      data-evidence-request-queue
      data-evidence-request-queue-state={state.kind}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: 10,
        }}
      >
        <div>
          <strong style={{ fontSize: 14, display: "block" }}>
            Evidence requests awaiting review
          </strong>
          <small style={{ fontSize: 11.5, color: "var(--ink-secondary, #475569)" }}>
            Requests sent to contributors, projected by the server for this
            workspace. Workflow reviews are the table below.
          </small>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label style={filterLabel}>
            Status
            <select
              data-evidence-request-queue-status
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as EvidenceRequestStatus | "")
              }
              style={selectStyle}
            >
              <option value="">Any</option>
              {EVIDENCE_REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label style={filterLabel}>
            Priority
            <select
              data-evidence-request-queue-priority
              value={priority}
              onChange={(e) =>
                setPriority(e.target.value as EvidenceRequestPriority | "")
              }
              style={selectStyle}
            >
              <option value="">Any</option>
              {EVIDENCE_REQUEST_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              ...filterLabel,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <input
              type="checkbox"
              data-evidence-request-queue-unassigned
              checked={unassignedOnly}
              onChange={(e) => setUnassignedOnly(e.target.checked)}
            />
            Unassigned only
          </label>
        </div>
      </div>

      {state.kind === "LOADING" ? (
        <div
          data-evidence-request-queue-loading
          style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}
        >
          Loading evidence requests…
        </div>
      ) : null}

      {state.kind === "FORBIDDEN" || state.kind === "ERROR" ? (
        <div
          role="status"
          data-permission-denied={state.kind === "FORBIDDEN" ? "FORBIDDEN" : undefined}
          data-evidence-request-queue-message={state.kind}
          style={{
            padding: "10px 12px",
            background:
              state.kind === "FORBIDDEN"
                ? "var(--status-pending-bg, #fef3c7)"
                : "var(--status-risk-bg, #fef2f2)",
            border: `1px solid ${
              state.kind === "FORBIDDEN"
                ? "var(--status-pending-border, #fcd34d)"
                : "var(--status-risk-border, #fecaca)"
            }`,
            color:
              state.kind === "FORBIDDEN"
                ? "var(--status-pending-fg, #78350f)"
                : "var(--status-risk-fg, #991b1b)",
            borderRadius: "var(--radius-md, 8px)",
            fontSize: 13,
          }}
        >
          {state.message}
          {state.kind === "ERROR" ? (
            <button
              type="button"
              data-evidence-request-queue-retry
              onClick={() => void load()}
              style={{
                marginLeft: 8,
                background: "transparent",
                border: "none",
                padding: 0,
                color: "inherit",
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
      ) : null}

      {state.kind === "READY" && state.items.length === 0 ? (
        <div data-evidence-request-queue-empty>
          <EmptyState
            title="No evidence requests match this filter"
            purpose="Requests appear here once they are sent to a contributor and are waiting on a reviewer."
          />
        </div>
      ) : null}

      {state.kind === "READY" && state.items.length > 0 ? (
        <div data-ui-datatable-scroll style={{ width: "100%", overflowX: "auto" }}>
          <table
            data-evidence-request-queue-table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            <thead>
              <tr>
                <th style={th}>Request</th>
                <th style={th}>Type</th>
                <th style={th}>Status</th>
                <th style={th}>Priority</th>
                <th style={th}>Assignee</th>
                <th style={th}>Due</th>
                <th style={th}>Open</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item) => (
                <tr key={item.id} data-evidence-request-queue-row={item.id}>
                  <td style={td}>{item.title}</td>
                  <td style={td}>{item.requestType}</td>
                  <td style={td}>{item.status}</td>
                  <td style={td}>
                    <Badge
                      tone={
                        PRIORITY_TONE[item.priority as EvidenceRequestPriority] ??
                        "neutral"
                      }
                    >
                      {item.priority}
                    </Badge>
                  </td>
                  <td style={td}>
                    {item.assignedReviewerUserId
                      ? `${item.assignedReviewerUserId.slice(0, 8)}…`
                      : "Unassigned"}
                  </td>
                  <td style={td}>
                    {item.dueAtUtc ? formatUserDate(item.dueAtUtc) : "—"}
                  </td>
                  <td style={td}>
                    <Link
                      href={`/evidence-requests/${item.id}`}
                      data-evidence-request-queue-open={item.id}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--ink-primary, #0f172a)",
                      }}
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div
            style={{
              marginTop: 8,
              fontSize: 11.5,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            {state.items.length} request{state.items.length === 1 ? "" : "s"} ·
            server-projected · loaded {formatUserDate(state.loadedAt)}
            {state.items.length >= REVIEW_QUEUE_LIMIT
              ? ` · showing the first ${REVIEW_QUEUE_LIMIT}; narrow the filters to see the rest`
              : ""}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const th = {
  textAlign: "left" as const,
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  fontSize: 11.5,
  fontWeight: 700,
  color: "var(--ink-secondary, #475569)",
  whiteSpace: "nowrap" as const,
};
const td = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  verticalAlign: "top" as const,
};
const filterLabel = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-secondary, #475569)",
};
const selectStyle = {
  minHeight: 32,
  fontSize: 12.5,
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  padding: "0 8px",
  cursor: "pointer",
} as const;
