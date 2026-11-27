"use client";

/**
 * PROOVRA Phase 2A — Disagreements surface.
 *
 * Workspace-anchored list of open disagreements with state-machine
 * transition controls. Senior reviewers + supervisors adjudicate;
 * the challenger may withdraw their own filing.
 *
 * PHASE 2 — Operator-selectable resolution verdict picker.
 *
 *   Previously every RESOLVED_* transition was forced through the
 *   first non-PENDING enum value ("APPROVE") regardless of operator
 *   intent. The canonical /v1/reviewer/disagreements/:id/transition
 *   route + service accept BOTH a bounded `verdict` enum and an
 *   optional `rationale` (max 600; truncated server side). Service
 *   code path:
 *   services/api/src/services/reviewer-workspace/reviewer-disagreement.service.ts
 *   -> transitionDisagreement.
 *
 *   Resolution rules (enforced by the service):
 *     - For any RESOLVED_* target the service records the verdict on
 *       the supervisor (or second-reviewer, when not yet UNDER
 *       supervisor review) columns and stores the rationale truncated
 *       to 600 chars.
 *     - Verdict must be a REVIEWER_VERDICTS enum value. We filter
 *       PENDING from the picker — recording a resolution as PENDING is
 *       semantically meaningless for an end-state transition.
 *
 *   Phase RW3 keeps the lifecycle on the canonical declared
 *   ReviewerDisagreement fields: secondReviewerUserId /
 *   supervisorUserId track stage owners, and final adjudication is
 *   persisted through resolution + resolvedAtUtc + resolvedByUserId.
 *   This page still keeps the table focused on progression controls +
 *   challenger context instead of rendering every lifecycle detail
 *   inline.
 *
 * Review remediation 2026-11-27 (F-11 / F-22):
 *   - a resolution always collects the required verdict and rationale, and
 *     says what an OVERTURNED / PARTIAL resolution does before it is recorded;
 *   - the server's `superseded` answer is said in plain words afterwards
 *     (reopened for a new round / round restarted / already superseded);
 *   - the challenger is never offered second review, supervisor review or a
 *     resolution (independence); when a move is refused for independence or
 *     role the page names who can resolve and the staffing path. The server
 *     still decides every move.
 */

import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../lib/feedback/plan-refusal";
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { PageShell } from "../../../../components/ui/PageShell";
// TEAM-UI-SPEC (structure) — the one review page header: icon title row, the
// tool name, a "← Review" back link above it, no eyebrow.
import {
  ReviewPageHeader,
  REVIEW_HUB_BACK,
} from "../../../../components/reviewer-experience/ReviewPageHeader";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";
import { reviewerDenialMessage } from "@proovra/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DISAGREEMENT_STATES,
  REVIEWER_VERDICTS,
  type DisagreementState,
  type ReviewerVerdict } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId, useOptionalPlatformContext } from "../../../../lib/platform-context";
import { transitionDisagreement, type DisagreementSuperseded } from "../../../../lib/reviewer-workspace/reviewer-api";
import { reviewerIdentityLabel } from "../../../../lib/reviewer-workspace/reviewer-identity";
import { recordReference } from "../../../../lib/short-id";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";

/**
 * Row shape intentionally keeps the list compact. The backend tracks
 * the full lifecycle, but this table only needs the progression fields
 * and challenger context.
 */
type DisagreementRow = {
  id: string;
  workflowId: string;
  state: DisagreementState;
  challengerUserId: string | null;
  challengerRationale: string | null;
  secondReviewerUserId: string | null;
  supervisorUserId: string | null;
  originalDecisionId: string | null;
  filedAtUtc: string;
  resolvedAtUtc: string | null;
  resolution?: ReviewerVerdict | null;
  resolvedByUserId?: string | null;
  /** §4 — the server's independence answer for the reader (older API: absent). */
  viewerIndependent?: boolean;
  viewerNotIndependentReason?: "filed_challenge" | "made_challenged_decision" | null;
  /** T-085 / T-086 — names the API may project beside the ids. */
  people?: Record<string, { displayName?: string | null; maskedEmail?: string | null }> | null;
};

/** T-086 — a person on a challenge, named the one way (never an id fragment). */
function personLabel(row: DisagreementRow, userId: string): string {
  const p = row.people?.[userId] ?? null;
  return reviewerIdentityLabel({ userId, displayName: p?.displayName ?? null, maskedEmail: p?.maskedEmail ?? null });
}

/** Verdicts the picker actually offers — PENDING filtered out as
 *  semantically meaningless on a RESOLVED_* end-state transition. */
const RESOLUTION_VERDICTS = REVIEWER_VERDICTS.filter(
  (v): v is Exclude<ReviewerVerdict, "PENDING"> => v !== "PENDING",
);

const VERDICT_LABELS: Record<ReviewerVerdict, string> = {
  PENDING: "Pending",
  APPROVE: "Approve",
  REJECT: "Reject",
  ESCALATE: "Escalate",
  NEEDS_INFO: "Needs info",
};

const STATE_LABELS: Record<DisagreementState, string> = {
  FILED: "Filed",
  UNDER_SECOND_REVIEW: "Under second review",
  UNDER_SUPERVISOR_REVIEW: "Under supervisor review",
  RESOLVED_UPHELD: "Resolved (upheld)",
  RESOLVED_OVERTURNED: "Resolved (overturned)",
  RESOLVED_PARTIAL: "Resolved (partial)",
  WITHDRAWN: "Withdrawn",
};

/** F-11 — what the server did to the challenged outcome, in plain words. */
function supersededMessage(to: DisagreementState, superseded: DisagreementSuperseded): string {
  const verb = to === "RESOLVED_PARTIAL" ? "partially overturned" : "overturned";
  if (superseded === "reopen") {
    return `The challenged outcome was ${verb}: the review was reopened for a new round. The earlier decisions and the challenge stay on the record.`;
  }
  if (superseded === "advance_round") {
    return `The challenged outcome was ${verb}: the review's round restarted, so the decision is taken again. The earlier decisions stay on the record.`;
  }
  if (superseded === "already_superseded") {
    return "The challenge is resolved. The challenged decision was already superseded by a later round, so nothing else changed.";
  }
  if (to === "RESOLVED_UPHELD") return "The challenge is resolved: the challenged outcome stands.";
  return `Moved to ${STATE_LABELS[to] ?? "the next stage"}.`;
}

/** F-22 — who can resolve a challenge, and what to do when nobody can. */
const RESOLVER_INDEPENDENCE_COPY =
  "Only a workspace owner or admin who neither filed this challenge nor made the challenged decision can review or resolve it. If nobody in this workspace qualifies, invite one from Members & access.";

/** Finding B — an overturn whose superseding failed is not half-recorded. */
const SUPERSEDE_FAILED_COPY =
  "the challenged outcome could not be superseded, so the challenge was not resolved and the review is unchanged. Your rationale is kept; try again.";

const RATIONALE_MAX = 600;
const CHALLENGER_RATIONALE_PREVIEW_MAX = 300;

export default function DisagreementsPage() {
  return (
    <PageRouteGate routeId="workspace.review_disagreements">
      <DisagreementsShell />
    </PageRouteGate>
  );
}

function DisagreementsShell() {
  const teamId = useActiveSpaceId();
  const [rows, setRows] = useState<DisagreementRow[] | null>(null);
  const [banner, setBanner] = useState<{ text: string; staffing?: boolean } | null>(null);
  // PRO-R2-15 — a failed read is an error with Retry, never "no disagreements".
  const [loadFailure, setLoadFailure] = useState<"denied" | "plan" | "failed" | null>(null);
  /**
   * Which (disagreementId, target state) currently has the resolution
   * picker open. Null when no picker is open. Only one picker can be
   * open at a time so the operator cannot accidentally submit against
   * the wrong row.
   */
  const [pickerArmed, setPickerArmed] = useState<
    | { disagreementId: string; to: DisagreementState }
    | null
  >(null);
  /** In-flight guard so the operator cannot double-fire a transition. */
  const [busyDisagreementId, setBusyDisagreementId] = useState<string | null>(
    null,
  );

  // `isStale` lets the effect discard a response that arrived after the
  // workspace changed (or the page unmounted) — the previous workspace's rows
  // must never paint under the newly selected one.
  const refresh = useCallback(async (isStale?: () => boolean) => {
    if (!teamId) {
      setRows([]);
      return;
    }
    try {
      const res = await apiFetch(
        `/v1/reviewer/disagreements?teamId=${encodeURIComponent(teamId)}&limit=100`,
        {
          method: "GET",
        },
      );
      if (isStale?.()) return;
      setRows((res?.disagreements ?? []) as DisagreementRow[]);
      setLoadFailure(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] disagreements list refresh failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
      });
      if (isStale?.()) return;
      setRows(null);
      const status = (err as { statusCode?: number } | null)?.statusCode;
      setLoadFailure(isPlanRefusal(err) ? "plan" : status === 401 || status === 403 ? "denied" : "failed");
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const counts = useMemo(() => {
    const source = rows ?? [];
    return {
      filed: source.filter((row) => row.state === "FILED").length,
      secondReview: source.filter((row) => row.state === "UNDER_SECOND_REVIEW")
        .length,
      supervisor: source.filter((row) => row.state === "UNDER_SUPERVISOR_REVIEW")
        .length,
      resolved: source.filter((row) => row.state.startsWith("RESOLVED_")).length,
      withdrawn: source.filter((row) => row.state === "WITHDRAWN").length,
    };
  }, [rows]);

  const onTransition = useCallback(
    async (
      id: string,
      to: DisagreementState,
      verdict?: ReviewerVerdict,
      rationale?: string,
    ) => {
      if (busyDisagreementId || !teamId) return;
      setBusyDisagreementId(id);
      try {
        const res = await transitionDisagreement({
          disagreementId: id,
          to,
          verdict,
          rationale,
          teamId,
        });
        if (res.ok) {
          setBanner({ text: supersededMessage(to, res.superseded) });
          setPickerArmed(null);
          await refresh();
        } else if (res.denial === "DISAGREEMENT_RESOLVER_NOT_INDEPENDENT" || res.denial === "NOT_PERMITTED") {
          // F-22 — why not, who can, and the staffing path. The picker and its
          // text stay open for whoever may retry.
          setBanner({ text: `Not recorded: ${reviewerDenialMessage(res.denial)} ${RESOLVER_INDEPENDENCE_COPY}`, staffing: true });
        } else if (res.denial === "DISAGREEMENT_SUPERSEDE_FAILED") {
          // Finding B — the review could not be reopened / restarted, so the
          // server recorded nothing (the challenge keeps its state). The
          // picker and its rationale stay open for a retry.
          setBanner({ text: `Not recorded: ${SUPERSEDE_FAILED_COPY}` });
        } else {
          setBanner({ text: `Not recorded: ${reviewerDenialMessage(res.denial)}` });
        }
      } finally {
        setBusyDisagreementId(null);
      }
    },
    [refresh, busyDisagreementId, teamId],
  );

  if (!teamId) {
    return (
      <PageShell data-disagreements-page>
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading challenged decisions."
        />
      </PageShell>
    );
  }

  return (
    // TEAM-UI-SPEC §1/§5 — the canonical page header (PageShell + PageHeader).
    <PageShell
      data-disagreements-page
      header={
        <ReviewPageHeader
          back={REVIEW_HUB_BACK}
          title="Challenged decisions"
          subtitle="Decisions a reviewer formally challenged. A challenge moves through second review and supervisor adjudication. Reviews whose first and second reviews differ are a different thing: they wait in the Inbox under Conflicts."
        />
      }
    >
      <div
        data-disagreement-lifecycle
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(130px, 100%), 1fr))",
          gap: 10,
        }}
      >
        <LifecycleTile label="Filed" value={counts.filed} />
        <LifecycleTile label="Second review" value={counts.secondReview} />
        <LifecycleTile label="Supervisor review" value={counts.supervisor} />
        <LifecycleTile label="Resolved" value={counts.resolved} />
        <LifecycleTile label="Withdrawn" value={counts.withdrawn} />
      </div>
      {banner ? (
        <div data-disagreement-banner role="status" className="app-panel">
          <div className="app-panel__body">
            {banner.text}
            {banner.staffing ? (
              <>
                {" "}
                <a href="/people" data-disagreement-staffing-link>
                  Open Members & access
                </a>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {loadFailure ? (
        <div role="alert" data-disagreements-failure={loadFailure} className="app-panel">
          <div className="app-panel__body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <p className="app-field-error" style={{ margin: 0, flex: "1 1 220px", minWidth: 0 }}>
            {loadFailure === "plan"
              ? PLAN_REFUSAL_COPY
              : loadFailure === "denied"
                ? "You do not have access to this workspace's challenged decisions."
                : "Challenged decisions could not be loaded. This is not the same as having none."}
          </p>
          {loadFailure === "failed" ? (
            <CanonicalActionButton variant="secondary" onClick={() => void refresh()}>
              Retry
            </CanonicalActionButton>
          ) : null}
          </div>
        </div>
      ) : rows === null ? (
        <p role="status" className="app-field-help">Loading…</p>
      ) : rows.length === 0 ? (
        <OperationalEmptyState
          kicker="Disagreement lifecycle"
          title="No decision has been challenged in this workspace."
          reason="A challenge appears here when a reviewer formally challenges a recorded decision from the review page. It moves into second review, then supervisor adjudication, before it is resolved or withdrawn."
          actions={[
            { label: "Open reviewer queues", href: "/review/queues?queue=MY_REVIEWS" },
            { label: "Open escalation operations", href: "/reviewer-ops/escalations" },
          ]}
          emptyStateCode="review_disagreements_empty"
        />
      ) : (
        <DisagreementsTable
          rows={rows}
          onTransition={onTransition}
          pickerArmed={pickerArmed}
          onArmPicker={setPickerArmed}
          busyDisagreementId={busyDisagreementId}
        />
      )}
    </PageShell>
  );
}

function DisagreementsTable({
  rows,
  onTransition,
  pickerArmed,
  onArmPicker,
  busyDisagreementId,
}: {
  rows: DisagreementRow[];
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
  pickerArmed: { disagreementId: string; to: DisagreementState } | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  busyDisagreementId: string | null;
}) {
  return (
    // TEAM-UI-SPEC §4 — eight columns: the shared responsive cutover
    // (`.app-table[data-responsive]`) collapses each row to a labelled card at
    // ≤ 720 px so nothing clips at 320/390 px.
    <div className="app-table-surface app-table-surface--scroll">
    <table data-disagreements-table className="app-table" data-responsive="">
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Review</th>
          <th scope="col">Owner</th>
          <th scope="col">Challenger</th>
          <th scope="col">Age</th>
          <th scope="col">Resolution</th>
          <th scope="col">Challenger rationale</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isBusy = busyDisagreementId === r.id;
          const isPickerOpen = pickerArmed?.disagreementId === r.id;
          return (
            <DisagreementRowGroup
              key={r.id}
              row={r}
              isBusy={isBusy}
              isPickerOpen={isPickerOpen}
              pickerTo={pickerArmed?.to ?? null}
              onArmPicker={onArmPicker}
              onTransition={onTransition}
            />
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function DisagreementRowGroup({
  row,
  isBusy,
  isPickerOpen,
  pickerTo,
  onArmPicker,
  onTransition,
}: {
  row: DisagreementRow;
  isBusy: boolean;
  isPickerOpen: boolean;
  pickerTo: DisagreementState | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
}) {
  return (
    <>
      <tr data-disagreement-row={row.id}>
        <td data-label="State">
          <AppStatusText tone="slate">{STATE_LABELS[row.state] ?? "Unknown state"}</AppStatusText>
        </td>
        <td data-label="Review">
          <a href={`/reviewer-ops/${encodeURIComponent(row.workflowId)}`} className="review-rows__ref">
            {recordReference("Review", row.workflowId)}
          </a>
        </td>
        <td data-label="Owner">
          <OwnerCell row={row} />
        </td>
        <td data-label="Challenger">
          {row.challengerUserId ? (
            <span>{personLabel(row, row.challengerUserId)}</span>
          ) : (
            <span className="app-table__muted">not recorded</span>
          )}
        </td>
        <td data-label="Age">
          {formatAge(row.filedAtUtc, row.resolvedAtUtc)}
        </td>
        <td data-label="Resolution">
          <ResolutionCell row={row} />
        </td>
        <td data-label="Challenger rationale">
          <ChallengerRationalePreview value={row.challengerRationale} />
        </td>
        <td data-label="">
          <TransitionButtons
            row={row}
            isBusy={isBusy}
            isPickerOpen={isPickerOpen}
            pickerTo={pickerTo}
            onArmPicker={onArmPicker}
            onTransition={onTransition}
          />
        </td>
      </tr>
      {isPickerOpen && pickerTo && pickerTo.startsWith("RESOLVED_") ? (
        <tr data-disagreement-resolve-picker-row={row.id}>
          <td colSpan={8} data-label="" style={{ padding: 0 }}>
            <ResolveVerdictPicker
              disagreementId={row.id}
              to={pickerTo}
              busy={isBusy}
              onCancel={() => onArmPicker(null)}
              onSubmit={(verdict, rationale) =>
                void onTransition(row.id, pickerTo, verdict, rationale)
              }
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TransitionButtons({
  row,
  isBusy,
  isPickerOpen,
  pickerTo,
  onArmPicker,
  onTransition,
}: {
  row: DisagreementRow;
  isBusy: boolean;
  isPickerOpen: boolean;
  pickerTo: DisagreementState | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
}) {
  // PRO-R2Z-08 — Withdraw is the challenger's own act (the API keeps it to
  // them); it is offered to nobody else.
  const viewerUserId = useOptionalPlatformContext()?.envelope?.user?.id ?? null;
  const targets = useMemo(
    () =>
      DISAGREEMENT_STATES.filter(
        (to) =>
          isPlausibleTransition(row.state, to) &&
          (to === "WITHDRAWN"
            ? viewerUserId !== null && row.challengerUserId === viewerUserId
            : // F-22 — independence, as the server decides it (viewerIndependent);
              // an older API without it falls back to the challenger check.
              row.viewerIndependent ?? !(viewerUserId !== null && row.challengerUserId === viewerUserId)),
      ),
    [row.state, row.challengerUserId, row.viewerIndependent, viewerUserId],
  );
  const isChallenger = viewerUserId !== null && row.challengerUserId === viewerUserId;
  const notIndependent = row.viewerIndependent === false || isChallenger;
  const open = !row.state.startsWith("RESOLVED_") && row.state !== "WITHDRAWN";
  return (
    <div className="app-table__actions" style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
      {targets.map((to) => {
        const isResolveTarget = to.startsWith("RESOLVED_");
        const thisPickerOpen = isPickerOpen && pickerTo === to;
        // Disable other buttons in the row while the picker is open
        // for one of them — keeps the UI clear about which transition
        // is being recorded.
        const disabledByOpenPicker = isPickerOpen && !thisPickerOpen;
        const disabled = isBusy || disabledByOpenPicker;
        return (
          // TEAM-UI-SPEC §1/§4 — row actions are secondary; the armed
          // transition (its resolution panel is open) is the filled toggle.
          <CanonicalActionButton
            key={to}
            variant={thisPickerOpen ? "filled" : "secondary"}
            aria-pressed={isResolveTarget ? thisPickerOpen : undefined}
            data-disagreement-transition-btn={to}
            disabled={disabled}
            disabledReason={
              disabledByOpenPicker ? "Finish or cancel the open resolution first." : null
            }
            onClick={() => {
              if (isResolveTarget) {
                // Arm the picker — operator must choose a verdict.
                onArmPicker(
                  thisPickerOpen
                    ? null
                    : { disagreementId: row.id, to },
                );
                return;
              }
              void onTransition(row.id, to);
            }}
          >
            {STATE_LABELS[to] ?? to}
          </CanonicalActionButton>
        );
      })}
      {notIndependent && open ? (
        <span className="app-field-help" data-disagreement-not-independent style={{ margin: 0 }}>
          {row.viewerNotIndependentReason === "made_challenged_decision"
            ? "You made the challenged decision, so another owner or admin reviews and resolves it."
            : "You filed this challenge, so another owner or admin reviews and resolves it."}
        </span>
      ) : targets.length === 0 ? (
        <span className="app-table__muted">
          No further transitions.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Resolution verdict picker — surfaces every operator-selectable
 * REVIEWER_VERDICTS value (PENDING filtered as meaningless on an
 * end-state transition) plus a bounded rationale textarea. The
 * canonical backend stores the verdict on the supervisor (or
 * second-reviewer, when not yet under supervisor review) columns and
 * persists rationale truncated to 600 chars.
 */
function ResolveVerdictPicker({
  disagreementId,
  to,
  busy,
  onSubmit,
  onCancel,
}: {
  disagreementId: string;
  to: DisagreementState;
  busy: boolean;
  onSubmit: (verdict: ReviewerVerdict, rationale: string) => void;
  onCancel: () => void;
}) {
  const [verdict, setVerdict] = useState<ReviewerVerdict | "">("");
  const [rationale, setRationale] = useState("");

  const trimmed = rationale.trim();
  const canSubmit =
    !busy &&
    verdict.length > 0 &&
    (REVIEWER_VERDICTS as ReadonlyArray<string>).includes(verdict) &&
    trimmed.length > 0 &&
    trimmed.length <= RATIONALE_MAX;

  return (
    <div
      data-disagreement-resolve-picker={disagreementId}
      role="group"
      aria-label="Resolve disagreement"
      style={{
        padding: 12,
        width: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="app-panel__title">
        Resolve disagreement → {STATE_LABELS[to] ?? to}. Choose a
        verdict and explain.
      </div>
      <p className="app-field-help" data-disagreement-resolve-effect style={{ margin: 0 }}>
        {to === "RESOLVED_UPHELD"
          ? "Upholding keeps the challenged outcome as it is."
          : "Overturning supersedes the challenged outcome: a finished review is reopened for a new round, an open one restarts its round. The earlier decisions and this challenge stay on the record."}
      </p>
      <label
        className="app-field-label"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <span>Verdict</span>
        <AppListbox
          value={verdict}
          options={[
            { value: "", label: "Choose a verdict…" },
            ...RESOLUTION_VERDICTS.map((v) => ({ value: v, label: VERDICT_LABELS[v] ?? v })),
          ]}
          onChange={(next) => setVerdict(next as ReviewerVerdict | "")}
          disabled={busy}
          triggerProps={{ "data-disagreement-resolve-verdict-select": "" }}
        />
      </label>
      <label
        className="app-field-label"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <span>
          Rationale ({trimmed.length}/{RATIONALE_MAX})
        </span>
        <textarea
          data-disagreement-resolve-rationale
          value={rationale}
          maxLength={RATIONALE_MAX}
          onChange={(e) => setRationale(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="Why is this disagreement being resolved this way?"
          className="app-input"
          style={{ resize: "vertical" }}
        />
      </label>
      {/* TEAM-UI-SPEC §1 — Cancel secondary + the one primary submit. */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <CanonicalActionButton
          variant="secondary"
          data-disagreement-resolve-cancel
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </CanonicalActionButton>
        <CanonicalActionButton
          variant="primary"
          data-disagreement-resolve-submit
          disabled={!canSubmit}
          disabledReason={
            busy
              ? null
              : verdict.length === 0
                ? "Choose a verdict."
                : trimmed.length === 0
                  ? "Explain the resolution."
                  : null
          }
          aria-busy={busy || undefined}
          onClick={() => onSubmit(verdict as ReviewerVerdict, trimmed)}
        >
          {busy ? "Submitting…" : "Record resolution"}
        </CanonicalActionButton>
      </div>
    </div>
  );
}

/**
 * Render the challenger rationale truncated to 300 chars. The full
 * value lives on the row; we never write it back, never include it in
 * audit metadata downstream, and never embed it raw in banner copy.
 */
function ChallengerRationalePreview({ value }: { value: string | null }) {
  if (!value || value.trim().length === 0) {
    return <span className="app-table__muted">—</span>;
  }
  const trimmed = value.trim();
  const truncated =
    trimmed.length > CHALLENGER_RATIONALE_PREVIEW_MAX
      ? `${trimmed.slice(0, CHALLENGER_RATIONALE_PREVIEW_MAX)}…`
      : trimmed;
  return (
    <span
      data-disagreement-challenger-rationale
      className="app-table__muted"
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        minWidth: 0,
      }}
    >
      {truncated}
    </span>
  );
}

function LifecycleTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="app-panel" data-disagreement-lifecycle-tile={label}>
      <div className="app-panel__body">
        <div className="app-field-help" style={{ margin: 0 }}>{label}</div>
        <div className="app-table__primary" style={{ fontSize: 18 }}>{value}</div>
      </div>
    </div>
  );
}

function OwnerCell({ row }: { row: DisagreementRow }) {
  const owner =
    row.state === "UNDER_SECOND_REVIEW"
      ? row.secondReviewerUserId
      : row.state === "UNDER_SUPERVISOR_REVIEW"
        ? row.supervisorUserId
        : row.state.startsWith("RESOLVED_")
          ? row.resolvedByUserId ?? row.supervisorUserId ?? row.secondReviewerUserId
          : null;
  if (!owner) {
    return <span className="app-table__muted">awaiting assignment</span>;
  }
  return <span>{personLabel(row, owner)}</span>;
}

function ResolutionCell({ row }: { row: DisagreementRow }) {
  if (!row.state.startsWith("RESOLVED_")) {
    return (
      <span className="app-table__muted">
        Filed {formatUserDateTime(row.filedAtUtc)}
      </span>
    );
  }
  return (
    <div className="app-table__identity">
      <span className="app-table__primary">
        {row.resolution ? VERDICT_LABELS[row.resolution] : "Resolved"}
      </span>
      <span className="app-table__muted">
        {row.resolvedAtUtc
          ? formatUserDateTime(row.resolvedAtUtc)
          : "Resolution time not recorded"}
      </span>
    </div>
  );
}

function formatAge(filedAtUtc: string, resolvedAtUtc: string | null): string {
  const end = resolvedAtUtc ? Date.parse(resolvedAtUtc) : Date.now();
  const deltaMs = Math.max(0, end - Date.parse(filedAtUtc));
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function isPlausibleTransition(
  from: DisagreementState,
  to: DisagreementState,
): boolean {
  if (from === to) return false;
  if (
    from === "FILED" &&
    (to === "UNDER_SECOND_REVIEW" || to === "WITHDRAWN")
  ) {
    return true;
  }
  if (
    from === "UNDER_SECOND_REVIEW" &&
    (to === "UNDER_SUPERVISOR_REVIEW" ||
      to === "RESOLVED_UPHELD" ||
      to === "RESOLVED_OVERTURNED" ||
      to === "RESOLVED_PARTIAL" ||
      to === "WITHDRAWN")
  ) {
    return true;
  }
  if (
    from === "UNDER_SUPERVISOR_REVIEW" &&
    (to === "RESOLVED_UPHELD" ||
      to === "RESOLVED_OVERTURNED" ||
      to === "RESOLVED_PARTIAL")
  ) {
    return true;
  }
  return false;
}


