"use client";

/**
 * Phase 25 — Escalation Console, now Monitoring → Escalations (stage D,
 * T-078): rendered as a section of the one Monitoring page
 * (`/reviewer-ops/sla?section=escalations`); `/reviewer-ops/escalations`
 * redirects there and keeps `?escalationId=`.
 *
 * Operator surface for the escalation lifecycle:
 *   - Filter by status / severity
 *   - Acknowledge / reassign / resolve / suppress
 *   - Link back to the review
 *   - Optional link to the operational incident
 *
 * TEAM-SPEC §2 item 7 / §3 (2026-11-23):
 *   - The default filter is "Active" (`status=ACTIVE`: open, acknowledged and
 *     reassigned), the same definition the SLA dashboard, analytics and the
 *     inspector use for "open escalation". It used to be exactly OPEN, so an
 *     acknowledged escalation counted on the SLA page and was missing here.
 *   - The API returns `total` under the same filters; the page says
 *     "Showing N of total".
 *   - The empty state names the filter ("No active escalations").
 *   - `?escalationId=` (from notifications and Operations rows) is honoured:
 *     the list opens on All, and the row is highlighted and scrolled to.
 *   - Links go through `reviewDestination`; no worker jargon in the copy.
 *
 * TEAM-UI-SPEC §1/§4 (round 3): the list is an `.app-table` riding the shared
 * `[data-responsive]` card cutover (no horizontal scroll on a phone; compact
 * row = review ref + severity, status + created, then actions). Row actions
 * are secondary (Acknowledge, Reassign, Resolve) and Suppress is the
 * destructive entry point (`app-secondary-action--danger`) — its dialog owns
 * the confirm. No row carries a primary.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import {
  StepUpModal,
  isStepUpCancelled,
  stepUpCancelMessage,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import {
  NoEscalationsEmptyState,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../components/ReviewerReasonModal";
import { formatCellDateTime } from "../../../../lib/date";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import type { AppTone } from "../../../../components/app-primitives/AppStatusBadge";
import { escalationSeverityLabel, escalationSeverityTone } from "../../../../lib/reviewer-workspace/review-status";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { recordReference } from "../../../../lib/short-id";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { presentReviewEscalationSummary } from "@proovra/shared";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
import { useReviewDestinationResolver } from "../../../../components/reviewer-experience/reviewDestination";
import {
  ESCALATION_STATUS_FILTERS,
  type EscalationStatusFilter,
} from "../../../../components/reviewer-experience/monitoringDisplay";

type EscalationStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "REASSIGNED"
  | "RESOLVED"
  | "SUPPRESSED";


type EscalationProjection = {
  id: string;
  teamId: string;
  workflowId: string;
  evidenceId: string | null;
  reason: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: EscalationStatus;
  safeSummary: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  resolutionNote: string | null;
  suppressedAtUtc: string | null;
  suppressionReason: string | null;
  assignedToUserId: string | null;
  incidentId: string | null;
};


const SEVERITY_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All severities" },
  { value: "INFO", label: "Info" },
  { value: "WARNING", label: "Warning" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

const STATUS_LABEL: Record<EscalationStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  REASSIGNED: "Reassigned",
  RESOLVED: "Resolved",
  SUPPRESSED: "Suppressed",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Escalations section of Monitoring. The Monitoring page applies the
 * `review.sla` gate and shows this section only where `review.escalations`
 * resolves for the actor (PERSONAL_OR_ORG + reviewer operations, TEAM-SPEC R1).
 */
export function EscalationsSection() {
  // The ACTIVE workspace (personal or organization), from the canonical envelope.
  const teamId = useActiveSpaceId();
  const searchParams = useSearchParams();
  const rawEscalationId = searchParams?.get("escalationId") ?? null;
  const focusEscalationId =
    rawEscalationId && UUID_RE.test(rawEscalationId) ? rawEscalationId : null;
  const resolveDestination = useReviewDestinationResolver();
  const inspectorDestination = resolveDestination("review.queue_detail");
  const operationsDestination = resolveDestination("workspace.operations");
  const [rows, setRows] = useState<EscalationProjection[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // A deep link opens on All so the linked escalation is found whatever its state.
  const [status, setStatus] = useState<EscalationStatusFilter>(
    focusEscalationId ? "ALL" : "ACTIVE",
  );
  const [severity, setSeverity] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Phase 2.4 — structured reason modal replaces 3 window.prompt calls
  // (reassign / resolve / suppress). `reasonModal` holds the kind +
  // the escalation id the action targets.
  const [reasonModal, setReasonModal] = useState<{
    kind: ReviewerReasonKind;
    escalationId: string;
  } | null>(null);
  // Every read carries a generation; a slower response for an older filter is dropped.
  const loadGenerationRef = useRef(0);

  const load = useCallback(() => {
    if (!teamId) return;
    const generation = ++loadGenerationRef.current;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    qs.set("status", status);
    if (severity) qs.set("severity", severity);
    qs.set("limit", "100");
    apiFetch(`/v1/reviewer-ops/escalations?${qs.toString()}`, {
      method: "GET",
    })
      .then((r: { escalations?: EscalationProjection[]; total?: number }) => {
        if (generation !== loadGenerationRef.current) return;
        const list = r.escalations ?? [];
        setRows(list);
        setTotal(typeof r.total === "number" && Number.isFinite(r.total) ? r.total : list.length);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (generation !== loadGenerationRef.current) return;
        setError(toSafeUserError(err, { message: "Could not load escalations." }).message);
      });
  }, [teamId, status, severity]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  // Scroll the linked escalation into view once it is rendered.
  useEffect(() => {
    if (!focusEscalationId || !rows) return;
    const el = document.getElementById(`escalation-${focusEscalationId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
  }, [focusEscalationId, rows]);

  // T-032 (stage B) — resolve and suppress are step-up gated (escalation
  // checkbox, session risk) and age gated (re-sign-in). The shared dialog runs
  // here, in place: a challenge retries once without re-typing, and a refusal
  // keeps the reason modal and its text open.
  const stepUp = useStepUpAction({ teamId });
  const act = useCallback(
    async (
      label: string,
      id: string,
      path: string,
      body: Record<string, unknown>,
    ): Promise<boolean> => {
      // PRO-R2-16 — true only on success, so the reason modal keeps its text on a refusal.
      if (!teamId) return false;
      setBusy(`${id}:${label}`);
      try {
        await stepUp.runStepUpAction((headers) =>
          apiFetch(
            `/v1/reviewer-ops/escalations/${encodeURIComponent(id)}/${path}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId, ...body }),
            },
          ),
        );
        load();
        return true;
      } catch (err) {
        setError(
          isStepUpCancelled(err)
            ? stepUpCancelMessage(err, `The escalation was not ${label === "suppress" ? "suppressed" : label === "resolve" ? "resolved" : "changed"}: identity confirmation was cancelled.`)
            : toSafeUserError(err, { message: `Could not ${label} the escalation.` }).message,
        );
        return false;
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stepUp],
  );

  // While the envelope is still hydrating, render the bounded loading shell.
  if (!teamId) {
    return <p className="app-field-help" data-escalations-loading>Loading workspace…</p>;
  }

  const shown = rows?.length ?? 0;
  const linkedMissing =
    focusEscalationId !== null && rows !== null && !rows.some((r) => r.id === focusEscalationId);

  return (
    <div className="review-monitoring-section" data-monitoring-section-body="escalations">
      <div className="review-toolbar review-monitoring-section__head">
        <p className="app-field-help" style={{ margin: 0 }}>
          Reviews that passed their deadline or were raised by a person. Open, acknowledged and reassigned escalations count toward deadline pressure.
        </p>
        <span className="review-toolbar__spacer" />
        <button
          type="button"
          className="app-secondary-action"
          onClick={load}
          disabled={busy !== null}
          data-escalations-refresh
        >
          Refresh
        </button>
      </div>

      <FilterBar>
        <FilterBar.Select
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as EscalationStatusFilter)}
          options={ESCALATION_STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        />
        <FilterBar.Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={SEVERITY_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        />
      </FilterBar>

      {rows !== null && total !== null ? (
        <p className="app-field-help" data-escalations-count role="status">
          Showing {shown} of {total} escalation{total === 1 ? "" : "s"}.
          {status === "ACTIVE" ? " Active means open, acknowledged or reassigned." : ""}
        </p>
      ) : null}

      {linkedMissing ? (
        <div className="app-alert" role="status" data-escalation-link-missing>
          The linked escalation is not in this list. It may belong to another
          workspace or no longer be visible to you.
        </div>
      ) : null}

      {error ? (
        <div className="app-alert app-alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      {/* Review automation only: a stale review automation pass is said here,
          in one line. Global service status lives in the header indicator. */}
      <RuntimeStatusBanner requires={["reviewAutomation"]} />

      {rows === null ? (
        <p className="app-field-help" aria-live="polite" data-escalations-loading-rows>
          Loading escalations…
        </p>
      ) : rows.length === 0 ? (
        <section className="app-panel app-panel__body">
          <NoEscalationsEmptyState filter={status} severityFiltered={severity !== ""} />
        </section>
      ) : (
        <div className="app-table-surface app-table-surface--scroll">
          <table className="app-table review-cards-900" aria-label="Escalations" data-escalations-table>
            <thead>
              <tr>
                <th>Review</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Summary</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const highlighted = e.id === focusEscalationId;
                const live = !["RESOLVED", "SUPPRESSED"].includes(e.status);
                const ref = e.evidenceId
                  ? recordReference("Evidence", e.evidenceId)
                  : recordReference("Review", e.workflowId);
                const reviewHref = `/reviewer-ops/${encodeURIComponent(e.workflowId)}`;
                return (
                  <tr
                    key={e.id}
                    id={`escalation-${e.id}`}
                    data-escalation-row={e.id}
                    data-escalation-highlighted={highlighted ? "true" : undefined}
                    data-review-row-selected={highlighted ? "true" : undefined}
                  >
                    <td data-review-cell="ref" data-label="Review">
                      {inspectorDestination ? (
                        <Link href={reviewHref} className="review-rows__ref">
                          {ref}
                        </Link>
                      ) : (
                        <span className="review-rows__ref">{ref}</span>
                      )}
                    </td>
                    <td data-review-cell="priority" data-label="Severity">
                      <span className="app-status-text-row">
                        <AppStatusText tone={escalationSeverityTone(e.severity)}>{escalationSeverityLabel(e.severity)}</AppStatusText>
                        {highlighted ? <AppStatusText tone="blue">Linked</AppStatusText> : null}
                      </span>
                    </td>
                    <td data-review-cell="status" data-label="Status">
                      <AppStatusText tone={statusTone(e.status)}>
                        {STATUS_LABEL[e.status] ?? "Unknown status"}
                      </AppStatusText>
                    </td>
                    <td data-review-cell="extra" data-label="Reason">
                      <span className="app-table__muted">{escalationReasonLabel(e.reason)}</span>
                    </td>
                    <td data-review-cell="extra" data-label="Summary">
                      <span className="app-table__muted">{presentReviewEscalationSummary(e.safeSummary)}</span>
                      {e.incidentId && operationsDestination ? (
                        <>
                          {" "}
                          <Link href={operationsDestination.href}>View the related incident</Link>
                        </>
                      ) : null}
                    </td>
                    <td data-review-cell="due" data-label="Created">
                      <span className="app-table__muted">{formatCellDateTime(e.createdAt)}</span>
                    </td>
                    <td data-review-cell="actions" data-label="">
                      <div className="app-table__actions">
                        {inspectorDestination ? (
                          <Link href={reviewHref} className="app-ghost-action" data-escalation-action-open>
                            Open
                          </Link>
                        ) : null}
                        {e.status === "OPEN" ? (
                          <button
                            type="button"
                            className="app-secondary-action"
                            data-row-action
                            disabled={busy !== null}
                            onClick={() => act("acknowledge", e.id, "acknowledge", {})}
                            data-escalation-action-acknowledge
                          >
                            Acknowledge
                          </button>
                        ) : null}
                        {live ? (
                          <>
                            <button
                              type="button"
                              className="app-secondary-action"
                              data-row-action
                              disabled={busy !== null}
                              onClick={() => setReasonModal({ kind: "ESCALATION_REASSIGN", escalationId: e.id })}
                              data-escalation-action-reassign
                            >
                              Reassign
                            </button>
                            <button
                              type="button"
                              className="app-secondary-action"
                              data-row-action
                              disabled={busy !== null}
                              onClick={() => setReasonModal({ kind: "ESCALATION_RESOLVE", escalationId: e.id })}
                              data-escalation-action-resolve
                            >
                              Resolve
                            </button>
                            <button
                              type="button"
                              className="app-secondary-action app-secondary-action--danger"
                              data-row-action
                              disabled={busy !== null}
                              onClick={() => setReasonModal({ kind: "ESCALATION_SUPPRESS", escalationId: e.id })}
                              data-escalation-action-suppress
                            >
                              Suppress
                            </button>
                          </>
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

      {/* Phase 2.4 — structured reason modal for reassign / resolve /
          suppress. Replaces 3 window.prompt calls. */}
      <ReviewerReasonModal
        kind={reasonModal?.kind ?? null}
        open={reasonModal !== null}
        onCancel={() => setReasonModal(null)}
        onSubmit={async (reason) => {
          if (!reasonModal) return;
          const { kind, escalationId } = reasonModal;
          let ok = false;
          if (kind === "ESCALATION_REASSIGN") {
            ok = await act("reassign", escalationId, "reassign", {
              newAssigneeUserId: reason,
            });
          } else if (kind === "ESCALATION_RESOLVE") {
            ok = await act("resolve", escalationId, "resolve", {
              resolutionNote: reason,
            });
          } else if (kind === "ESCALATION_SUPPRESS") {
            ok = await act("suppress", escalationId, "suppress", {
              suppressionReason: reason,
            });
          }
          if (ok) setReasonModal(null);
        }}
      />
      <StepUpModal control={stepUp} />
    </div>
  );
}

function statusTone(status: EscalationStatus): AppTone {
  switch (status) {
    case "OPEN":
      return "red";
    case "ACKNOWLEDGED":
      return "amber";
    case "REASSIGNED":
      return "blue";
    case "RESOLVED":
      return "green";
    case "SUPPRESSED":
    default:
      return "slate";
  }
}
