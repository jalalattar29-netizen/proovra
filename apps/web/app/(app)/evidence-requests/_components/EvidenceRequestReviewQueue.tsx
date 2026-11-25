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

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_STATUSES,
  type EvidenceRequestPriority,
  type EvidenceRequestStatus, identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDate } from "../../../../lib/date";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import { priorityTone } from "../../../../lib/reviewer-workspace/review-status";
import { EmptyState } from "../../../../components/ui/EmptyState";

/** Server cap for GET /v1/review/queue (`limit` max 200). */
const REVIEW_QUEUE_LIMIT = 100;

/**
 * T-133 (audit REV-06/REV-24/REV-28) — the list is titled "awaiting review",
 * so it opens on the statuses that ARE awaiting a reviewer, asked of the
 * server as one set (`statuses=`). "Any status" stays one choice away.
 */
const AWAITING_REVIEW = "AWAITING_REVIEW";
const AWAITING_REVIEW_STATUSES: ReadonlyArray<EvidenceRequestStatus> = [
  "RESPONSE_RECEIVED",
  "UNDER_REVIEW",
  "PARTIALLY_FULFILLED",
];
const ANY_STATUS = "";

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
  /** T-133 — projected by the API (a display name, never an address). */
  assignedReviewerDisplayName?: string | null;
  createdAt: string;
};

type PanelState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; items: ReadonlyArray<ReviewQueueItem>; loadedAt: string };

export function EvidenceRequestReviewQueue({
  teamId,
  activeTeamRef,
}: {
  teamId: string | null;
  activeTeamRef: { readonly current: string | null };
}) {
  const [state, setState] = useState<PanelState>({ kind: "LOADING" });
  const [status, setStatus] = useState<EvidenceRequestStatus | typeof AWAITING_REVIEW | typeof ANY_STATUS>(AWAITING_REVIEW);
  // T-133 — only the newest request may write the panel (a slow answer for an
  // older filter never overwrites a newer one).
  const generation = useRef(0);
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
    const mine = (generation.current += 1);
    const stale = () => mine !== generation.current || requestTeamId !== activeTeamRef.current;
    setState({ kind: "LOADING" });
    const params = new URLSearchParams({
      teamId: requestTeamId,
      limit: String(REVIEW_QUEUE_LIMIT),
    });
    if (status === AWAITING_REVIEW) params.set("statuses", AWAITING_REVIEW_STATUSES.join(","));
    else if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (unassignedOnly) params.set("unassigned", "true");
    try {
      const res = (await apiFetch(`/v1/review/queue?${params.toString()}`, {
        method: "GET",
      })) as { items?: ReadonlyArray<ReviewQueueItem> } | null;
      // Stale-context and stale-filter rejection.
      if (stale()) return;
      setState({
        kind: "READY",
        items: Array.isArray(res?.items) ? res.items : [],
        loadedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (stale()) return;
      const httpStatus = (err as { statusCode?: number } | null)?.statusCode;
      const code = (err as { code?: string } | null)?.code;
      if (httpStatus === 403) {
        setState({
          kind: "FORBIDDEN",
          message:
            "Evidence requests are restricted for your role in this workspace.",
        });
        return;
      }
      // T-133 — a 404 is "not available here", not a role restriction.
      if (httpStatus === 404) {
        setState({
          kind: "FORBIDDEN",
          message: "Evidence requests are not available in this workspace.",
        });
        return;
      }
      // T-133 — only FEATURE_DISABLED means the module is off; any other 503
      // is an outage the reader can retry.
      if (httpStatus === 503 && code === "FEATURE_DISABLED") {
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

  const filtersNarrowed = status !== AWAITING_REVIEW || priority !== "" || unassignedOnly;

  // TEAM-UI-SPEC §1 / §4 (round 3) — an app-panel; filters are canonical
  // fields in one row; the table rides the shared `[data-responsive]` card
  // cutover (no horizontal scroll on a phone); Retry is secondary and the row
  // link is the ghost "Review".
  return (
    <section
      className="app-panel"
      id="evidence-request-queue"
      data-evidence-request-queue
      data-evidence-request-queue-state={state.kind}
      aria-labelledby="evidence-request-queue-title"
    >
      <div className="app-panel__head">
        <div>
          <h2 className="app-panel__title" id="evidence-request-queue-title">
            Evidence requests awaiting review
          </h2>
          <p className="app-field-help">
            Requests sent to contributors, projected by the server for this
            workspace. Workflow reviews are the table below.
          </p>
        </div>
      </div>
      <div className="app-panel__body review-panel-stack">
        <div className="review-toolbar review-toolbar--flush">
          <span className="review-toolbar__label">Status</span>
          <AppListbox
            value={status}
            ariaLabel="Status"
            options={[
              { value: AWAITING_REVIEW, label: "Awaiting review" },
              { value: ANY_STATUS, label: "Any status" },
              ...EVIDENCE_REQUEST_STATUSES.map((s) => ({ value: s, label: identifierLabel(s) })),
            ]}
            onChange={(next) => setStatus(next as EvidenceRequestStatus | typeof AWAITING_REVIEW | typeof ANY_STATUS)}
            triggerProps={{ "data-evidence-request-queue-status": "" }}
          />
          <span className="review-toolbar__label">Priority</span>
          <AppListbox
            value={priority}
            ariaLabel="Priority"
            options={[
              { value: "", label: "Any" },
              ...EVIDENCE_REQUEST_PRIORITIES.map((p) => ({ value: p, label: identifierLabel(p) })),
            ]}
            onChange={(next) => setPriority(next as EvidenceRequestPriority | "")}
            triggerProps={{ "data-evidence-request-queue-priority": "" }}
          />
          <label className="review-check-row">
            <input
              type="checkbox"
              className="app-checkbox"
              data-evidence-request-queue-unassigned
              checked={unassignedOnly}
              onChange={(e) => setUnassignedOnly(e.target.checked)}
            />
            Unassigned only
          </label>
        </div>

        {state.kind === "LOADING" ? (
          <p className="app-field-help" data-evidence-request-queue-loading>
            Loading evidence requests…
          </p>
        ) : null}

        {state.kind === "FORBIDDEN" || state.kind === "ERROR" ? (
          <div
            role="status"
            className={state.kind === "FORBIDDEN" ? "app-alert app-alert--warn" : "app-alert app-alert--danger"}
            data-permission-denied={state.kind === "FORBIDDEN" ? "FORBIDDEN" : undefined}
            data-evidence-request-queue-message={state.kind}
          >
            {state.message}
            {state.kind === "ERROR" ? (
              <>
                {" "}
                <button
                  type="button"
                  className="app-secondary-action"
                  data-evidence-request-queue-retry
                  onClick={() => void load()}
                >
                  Retry
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {state.kind === "READY" && state.items.length === 0 ? (
          // T-133 — "nothing awaits review" and "your filter matched nothing"
          // are different facts.
          filtersNarrowed ? (
            <div data-evidence-request-queue-empty="filtered">
              <EmptyState
                title="No evidence requests match these filters"
                purpose="Change or clear the filters to see other requests."
              />
            </div>
          ) : (
            <div data-evidence-request-queue-empty="none">
              <EmptyState
                title="No evidence requests are awaiting review"
                purpose="Requests appear here once a contributor responds and a reviewer is needed."
              />
            </div>
          )
        ) : null}

        {state.kind === "READY" && state.items.length > 0 ? (
          <div>
            <div className="app-table-surface app-table-surface--scroll" data-ui-datatable-scroll>
              <table className="app-table" data-responsive data-evidence-request-queue-table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Assignee</th>
                    <th>Due</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => (
                    <tr key={item.id} data-evidence-request-queue-row={item.id}>
                      <td data-label="Request">
                        <span className="app-table__primary">{item.title}</span>
                      </td>
                      <td data-label="Type">
                        <span className="app-table__muted">{identifierLabel(item.requestType)}</span>
                      </td>
                      <td data-label="Status">
                        <AppStatusText tone="slate">{identifierLabel(item.status)}</AppStatusText>
                      </td>
                      <td data-label="Priority">
                        <AppStatusText tone={priorityTone(item.priority)}>{identifierLabel(item.priority)}</AppStatusText>
                      </td>
                      <td data-label="Assignee">
                        <span className="app-table__muted">
                          {item.assignedReviewerUserId
                            ? (item.assignedReviewerDisplayName ?? "Workspace member")
                            : "Unassigned"}
                        </span>
                      </td>
                      <td data-label="Due">
                        <span className="app-table__muted">
                          {item.dueAtUtc ? formatUserDate(item.dueAtUtc) : "—"}
                        </span>
                      </td>
                      <td data-label="">
                        <Link
                          href={`/evidence-requests/${item.id}`}
                          className="app-ghost-action"
                          data-evidence-request-queue-open={item.id}
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="app-field-help">
              {state.items.length} request{state.items.length === 1 ? "" : "s"} ·
              server-projected · loaded {formatUserDate(state.loadedAt)}
              {state.items.length >= REVIEW_QUEUE_LIMIT
                ? ` · showing the first ${REVIEW_QUEUE_LIMIT}; narrow the filters to see the rest`
                : ""}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
