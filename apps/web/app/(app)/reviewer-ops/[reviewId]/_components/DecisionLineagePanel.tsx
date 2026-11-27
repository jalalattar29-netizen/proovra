"use client";

/**
 * THE decision panel of a review: "Record decision" (FIRST / SECOND) and, in
 * conflict, "Adjudication" — the same panel and the same form (`DecisionForm`),
 * plus the decision history. Shared by the Review page and its focus mode
 * (`/review/workspace`, Team remediation T-001), so both record every verdict
 * through the one canonical door with the same requirement, refusal and
 * outcome copy.
 *
 * Wired to:
 *   GET  /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=<uuid>
 *   POST /v1/reviewer-ops/workspace/:workflowId/decisions (by the host)
 *
 * Team remediation (2026-11-24):
 *   - T-015 — before submission: whether a second review is required, why, and
 *     whether anyone eligible can give it. Review remediation 2026-11-27
 *     (F-01/F-05/F-06): said ONCE, with who requested it and when; a FIRST
 *     decision is never blocked for lack of a second reviewer — afterwards the
 *     panel reads "First review recorded — waiting for an independent reviewer".
 *   - T-022 — the governing requirement of the RECORDED decisions.
 *   - T-023 — every round of the history, each with how it was settled.
 *   - T-024 — External Review verdicts, read-only and advisory.
 *   - T-018 — after an unresolved adjudication, the next step is named.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  REVIEW_DECISION_LABELS,
  REVIEW_REFUSAL_MESSAGES,
  describeGoverningRequirement,
  describeSecondReviewRequirement,
  identifierLabel,
  maskEmail,
  notRecordedMessage,
  secondReviewCauseLabel,
} from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { reviewerIdentityLabel } from "../../../../../lib/reviewer-workspace/reviewer-identity";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import type { AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import { formatUserDate, formatUserDateTime } from "../../../../../lib/date";
import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../../lib/feedback/plan-refusal";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  DecisionForm,
  type CodedAssessment,
  type DecisionFocusRequest,
  type DecisionSubmitBody,
  type DecisionSubmitFailure,
  type DecisionSubmitResult,
} from "./DecisionPanel";
import { DECISION_ANCHOR_ID } from "./InspectorActions";
import {
  DECISION_KIND_LABELS,
  REASON_CODE_LABELS,
  STAGE_LABELS,
  describeRefusal,
  teamRoleLabel,
  type ActionMap,
  type Refusal,
} from "./inspector-model";

export type DecisionKind =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_INFO"
  | "UPHOLD_FIRST"
  | "UPHOLD_SECOND"
  | "NEEDS_MORE_INFO"
  | "UNRESOLVED";

export type ReviewState =
  | "first_required"
  | "second_required"
  | "conflict_detected"
  | "adjudication_required"
  | "resolved";

export type NextAction =
  | "submit_first"
  | "submit_second"
  | "submit_adjudication"
  | "blocked_same_reviewer"
  | "blocked_not_adjudicator"
  // F-08 — an owner/admin who decided one of the two reviews.
  | "blocked_adjudicator_not_independent"
  | "no_action_resolved";

export type DecisionRow = {
  id: string;
  stage: "FIRST" | "SECOND" | "ADJUDICATION";
  round?: number;
  decision: DecisionKind;
  reasonCode: string | null;
  rationale: string;
  decidedAt: string;
  reviewer: { userId: string; email: string | null; displayName: string | null };
};

/** F-06 — the escalation that requires independence: who asked, when, why. */
export type SecondReviewEscalation = {
  reason: string;
  severity: string;
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  requestedAtUtc?: string | null;
  note?: string | null;
};

export type SecondReviewBlock = {
  required: boolean;
  cause: string | null;
  escalation: SecondReviewEscalation | null;
  eligibleReviewerCount: number | null;
  staffing: "ok" | "no_eligible_second_reviewer" | null;
};

export type GoverningBlock = {
  reviewers: number;
  secondReviewRequired: boolean;
  cause: string | null;
};

export type DecisionRound = {
  round: number;
  current: boolean;
  settledBy: "request_info" | "unresolved_adjudication" | "adjudication" | "decision" | null;
  governing: GoverningBlock;
  decisions: DecisionRow[];
};

export type ExternalFeedback = {
  id: string;
  verdict: string;
  rationale: string | null;
  reviewer: { email: string; displayName: string | null };
  submittedAt: string;
  advisory: true;
};

/**
 * Review remediation (F-04) — a request for information is a workflow action,
 * not a decision: the history lists it apart from the decision rounds.
 */
export type InformationRequestRow = {
  id: string;
  requestedInRound: number | null;
  requestedBy: { userId: string; displayName: string | null } | null;
  requestedFrom: { userId: string; displayName: string | null } | { role: string };
  reason: string | null;
  requestedAtUtc: string;
  supersededDecisionId: string | null;
};

export type DecisionsEnvelope = {
  workflowId: string;
  evidenceId: string;
  state: ReviewState;
  round?: number;
  continuedFrom?: "request_info" | "unresolved_adjudication" | null;
  secondReviewRequirement: { required: boolean; reason: string | null };
  /** T-015 — optional: an older API omits it. */
  secondReview?: SecondReviewBlock;
  governing?: GoverningBlock | null;
  callerContext: {
    userId: string;
    teamRole: string | null;
    isAdjudicator: boolean;
    callerIsFirstReviewer: boolean;
    nextAction: NextAction;
  };
  decisions: DecisionRow[];
  rounds?: DecisionRound[];
  externalFeedback?: ExternalFeedback[];
  /** Review remediation (F-04) — optional: an older API omits it. */
  informationRequests?: InformationRequestRow[];
};

/** What the decision panel last read, lifted for the host page. */
export type DecisionsSummary = {
  state: ReviewState;
  secondRequired: boolean;
  nextAction: NextAction;
  teamRole: string | null;
  decisions: DecisionRow[];
  secondReview?: SecondReviewBlock | null;
};

/**
 * Read a refusal from a thrown apiFetch error.
 *
 * ApiError carries the nested envelope (`err.body?.error?.code`,
 * `details.reason`); a lost answer is a plain Error with code NETWORK_ERROR.
 */
export function readRefusal(err: unknown): Refusal {
  const e = (err ?? {}) as {
    statusCode?: number;
    code?: string;
    details?: { reason?: unknown } | null;
    flatReason?: string;
    body?: { error?: { code?: string; reason?: string; details?: { reason?: unknown } | null } };
  };
  const code = e.body?.error?.code ?? e.code ?? null;
  const rawReason =
    e.details?.reason ?? e.body?.error?.details?.reason ?? e.body?.error?.reason ?? e.flatReason ?? null;
  return {
    status: typeof e.statusCode === "number" ? e.statusCode : 0,
    code: typeof code === "string" ? code : null,
    reason: typeof rawReason === "string" ? rawReason : null,
  };
}

/** One refusal sentence (shared catalog), with the plan and safe-error fallbacks. */
export function refusalMessage(err: unknown, fallback: string): string {
  if (isPlanRefusal(err)) return PLAN_REFUSAL_COPY;
  const refusal = readRefusal(err);
  const mapped = describeRefusal(refusal, "");
  return mapped || toSafeUserError(err, { message: fallback }).message;
}

/**
 * F-21 — a refused decision as the form shows it: "Not recorded: <reason>",
 * plus, for `coding_incomplete`, the labels of the required fields still
 * empty (the server sends them beside the code, or under `details`).
 */
export function decisionRefusal(err: unknown, fallback: string): DecisionSubmitFailure {
  const message = notRecordedMessage(refusalMessage(err, fallback));
  const e = (err ?? {}) as {
    details?: { missingLabels?: unknown } | null;
    body?: { error?: { missingLabels?: unknown; details?: { missingLabels?: unknown } | null } };
  };
  const raw = e.details?.missingLabels ?? e.body?.error?.missingLabels ?? e.body?.error?.details?.missingLabels;
  const missingLabels = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return missingLabels.length > 0 ? { message, missingLabels } : { message };
}

/**
 * T-086 (stage D) — a reviewer in the lineage is named the way the Inbox and
 * the picker name them: the display name, else the e-mail MASKED, never an id
 * reference.
 */
export function reviewerName(r: { userId: string; email: string | null; displayName: string | null }): string {
  return reviewerIdentityLabel({ userId: r.userId, displayName: r.displayName, maskedEmail: maskEmail(r.email) });
}

const STATE_LABELS: Record<ReviewState, string> = {
  first_required: "First review required",
  second_required: "Second review required",
  conflict_detected: "The reviews disagree — adjudication needed",
  adjudication_required: "Adjudication needed",
  resolved: "Review resolved",
};

/** The state's tone — plain status text (stage D, T-071), never a capsule. */
const STATE_TONE: Record<ReviewState, AppTone> = {
  first_required: "slate",
  second_required: "amber",
  conflict_detected: "amber",
  adjudication_required: "amber",
  resolved: "green",
};

const ROUND_SETTLED_LABELS: Record<string, string> = {
  request_info: "settled by a request for information",
  unresolved_adjudication: "adjudication left unresolved",
  adjudication: "settled by adjudication",
  decision: "decided",
};

const EXTERNAL_VERDICT_LABELS: Record<string, string> = {
  APPROVE: "Recommends approval",
  REJECT: "Recommends rejection",
  REQUEST_INFO: "Asks for more information",
  NEEDS_MORE_INFO: "Asks for more information",
};

/**
 * F-29 — the round's outcome in the decision vocabulary Evidence Detail uses
 * ("Approved" / "Not accepted"), from the resolved round's decisions. An
 * adjudication that upheld one review carries that review's verdict. null
 * when the round did not end in an approval or rejection.
 */
export function resolvedDecisionLabel(decisions: ReadonlyArray<DecisionRow>): string | null {
  const verdictOf = (d: DecisionRow | undefined): string | null => {
    if (!d) return null;
    if (d.decision === "APPROVE") return REVIEW_DECISION_LABELS.APPROVED;
    if (d.decision === "REJECT") return REVIEW_DECISION_LABELS.NOT_ACCEPTED;
    return null;
  };
  const last = decisions[decisions.length - 1];
  if (!last) return null;
  if (last.decision === "UPHOLD_FIRST") return verdictOf(decisions.find((d) => d.stage === "FIRST"));
  if (last.decision === "UPHOLD_SECOND") return verdictOf(decisions.find((d) => d.stage === "SECOND"));
  return verdictOf(last);
}

function decisionTone(kind: string): AppTone {
  if (kind === "APPROVE" || kind === "UPHOLD_FIRST" || kind === "UPHOLD_SECOND") return "green";
  if (kind === "REJECT") return "red";
  return "slate";
}

function DecisionRowItem({ d, index }: { d: DecisionRow; index: number }) {
  return (
    <li
      data-decision-row
      data-decision-stage={d.stage}
      data-decision-kind={d.decision}
      data-decision-reason-code={d.reasonCode ?? ""}
      data-decision-reviewer-id={d.reviewer.userId}
      className="app-inner-surface"
      style={{ padding: "0.5rem 0.7rem", minWidth: 0 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <AppStatusText tone="slate" data-decision-stage-chip={d.stage}>
            #{index + 1} · {STAGE_LABELS[d.stage] ?? "Review"}
          </AppStatusText>
          <AppStatusText tone={decisionTone(d.decision)} data-decision-kind-chip={d.decision}>
            {DECISION_KIND_LABELS[d.decision] ?? "Decision"}
          </AppStatusText>
          {d.reasonCode ? (
            <AppStatusText tone="slate" data-decision-reason-chip={d.reasonCode}>
              {REASON_CODE_LABELS[d.reasonCode] ?? "Other reason"}
            </AppStatusText>
          ) : null}
          <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{reviewerName(d.reviewer)}</span>
        </div>
        <time dateTime={d.decidedAt} className="app-field-help" style={{ margin: 0 }}>
          {formatUserDateTime(d.decidedAt)}
        </time>
      </div>
      <div data-decision-rationale style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {d.rationale}
      </div>
    </li>
  );
}

export function ReviewerDecisionLineagePanel({
  workflowId,
  teamId,
  refreshKey = 0,
  onLoaded,
  onSubmitDecision,
  actions,
  mayDecide,
  mayAdjudicate,
  adjudicationBlockedReason,
  focusRequest,
  handoffShown = false,
  onAssignSecondReviewer,
  staffingLink = null,
  assessment = null,
}: {
  workflowId: string;
  teamId: string;
  /** Bumped by the host after any action, so the lineage rereads. */
  refreshKey?: number;
  /** Lifts what was read, for the host's Next step and adjudication. */
  onLoaded?: (summary: DecisionsSummary | null) => void;
  /**
   * The host's decisions POST (step-up, refusal mapping, reload). Resolves to
   * an error message, or null.
   */
  onSubmitDecision: (body: DecisionSubmitBody) => Promise<DecisionSubmitResult>;
  /** The server's action map: which verdict kinds are open now. */
  actions: ActionMap;
  /** The lineage asks this viewer for a FIRST / SECOND decision and one kind is open. */
  mayDecide: boolean;
  /** In conflict, and this viewer is an independent owner or admin. */
  mayAdjudicate: boolean;
  adjudicationBlockedReason: string | null;
  focusRequest: DecisionFocusRequest | null;
  /**
   * The page's hand-off banner already names the pending second review (who
   * recorded the first, the assignment); the panel then states only the cause.
   */
  handoffShown?: boolean;
  /** Opens the second-reviewer assignment (offered only when the server allows reassign). */
  onAssignSecondReviewer?: (() => void) | null;
  /** The host's Members & access link (only where that page opens for the viewer). */
  staffingLink?: ReactNode;
  /** F-18 — the coded assessment the chosen verdict is compared with. */
  assessment?: CodedAssessment | null;
}) {
  // F-21 — a refused draft kept even when the refreshed state no longer shows
  // the form (decided in another tab): the text is never lost.
  const [kept, setKept] = useState<{ body: DecisionSubmitBody; failure: DecisionSubmitFailure } | null>(null);
  const submitDecision = useCallback(
    async (body: DecisionSubmitBody): Promise<DecisionSubmitResult> => {
      const result = await onSubmitDecision(body);
      if (result) setKept({ body, failure: typeof result === "string" ? { message: result } : result });
      else setKept(null);
      return result;
    },
    [onSubmitDecision],
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: DecisionsEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });

  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  const load = useCallback(async () => {
    // A refresh keeps the current lineage on screen instead of flashing to a
    // loading state.
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as DecisionsEnvelope;
      setState({ kind: "ready", data });
      onLoadedRef.current?.({
        state: data.state,
        secondRequired: Boolean(data.secondReviewRequirement?.required),
        nextAction: data.callerContext.nextAction,
        teamRole: data.callerContext.teamRole,
        decisions: data.decisions,
        secondReview: data.secondReview ?? null,
      });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 0;
      const message = toSafeUserError(err, { message: "Could not load decisions." }).message;
      setState({ kind: "error", status, message });
      onLoadedRef.current?.(null);
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const shell = (title: string, body: ReactNode, attrs: Record<string, string>) => (
    <section
      id={DECISION_ANCHOR_ID}
      className="app-panel"
      aria-labelledby="review-decision-title"
      tabIndex={-1}
      style={{ minWidth: 0 }}
      data-section="reviewer-decision-lineage"
      data-decision-panel
      {...attrs}
    >
      <div className="app-panel__head">
        <h2 id="review-decision-title" className="app-panel__title">
          {title}
        </h2>
      </div>
      <div className="app-panel__body" style={{ minWidth: 0 }}>
        {body}
      </div>
    </section>
  );

  if (state.kind === "loading") {
    return shell(
      "Record decision",
      <p className="app-field-help" style={{ margin: 0 }}>Loading review state…</p>,
      { "data-decision-state": "loading" },
    );
  }

  if (state.kind === "error") {
    return shell(
      "Record decision",
      <p role="alert" className="app-field-error" style={{ margin: 0 }}>
        {/* raw-identifier-ok: state.status here is the HTTP status number of a failed read */}
        {state.status === 404
          ? "Workflow not found in this workspace."
          : state.status === 403
            ? "You don't have permission to view review decisions."
            : "Could not load decisions."}
      </p>,
      { "data-decision-state": "error" },
    );
  }

  const data = state.data;
  const nextAction = data.callerContext.nextAction;
  const conflict = data.state === "conflict_detected" || data.state === "adjudication_required";
  const formStage: "FIRST" | "SECOND" = nextAction === "submit_second" ? "SECOND" : "FIRST";
  const second: SecondReviewBlock = data.secondReview ?? {
    required: Boolean(data.secondReviewRequirement.required),
    cause: data.secondReviewRequirement.reason,
    escalation: null,
    eligibleReviewerCount: null,
    staffing: null,
  };
  // F-01 / F-05 / F-06 — the requirement is stated ONCE, with its cause, who
  // requested it and when, and reviewer availability. A missing second
  // reviewer never blocks recording the FIRST decision: the sentence says what
  // happens instead, and the server records the decision as pending.
  const escalationWho = second.escalation
    ? {
        reason: second.escalation.reason,
        severity: second.escalation.severity,
        requestedByName: second.escalation.requestedByName ?? null,
        requestedAtLabel: second.escalation.requestedAtUtc ? formatUserDate(second.escalation.requestedAtUtc) : null,
      }
    : null;
  // After the FIRST of two decisions, a viewer who is not giving the second
  // one reads that it is pending (F-05), never "this is the second decision".
  const pendingIndependent =
    !conflict && data.state === "second_required" && second.required && nextAction !== "submit_second";
  const requirementSentence =
    conflict || pendingIndependent
      ? null
      : describeSecondReviewRequirement({
          required: second.required,
          cause: second.cause,
          escalation: escalationWho,
          eligibleReviewerCount: data.state === "second_required" ? null : second.eligibleReviewerCount,
          state: data.state,
        });
  const causeClause = secondReviewCauseLabel(second.cause);
  const pendingCause = causeClause
    ? `A second review is required because ${causeClause}${
        escalationWho?.requestedByName
          ? ` (${escalationWho.requestedByName}${escalationWho.requestedAtLabel ? `, ${escalationWho.requestedAtLabel}` : ""})`
          : ""
      }.`
    : "A second review is required.";
  const nobodyEligible = second.eligibleReviewerCount === 0 || second.staffing === "no_eligible_second_reviewer";
  // T-022 — what governed the recorded decisions, never today's rule.
  const governingSentence =
    data.state === "resolved" && data.governing ? describeGoverningRequirement(data.governing) : null;
  const finalDecision = data.state === "resolved" ? resolvedDecisionLabel(data.decisions) : null;
  const showDecisionForm = !conflict && mayDecide;
  const showAdjudicationForm = conflict && mayAdjudicate;
  const firstRecorded = data.decisions.some((d) => d.stage === "FIRST");
  // The one reason the verdict is closed, when the lineage asks for one.
  const verdictClosedReason =
    (nextAction === "submit_first" || nextAction === "submit_second") && !mayDecide
      ? actions.approve.reason ?? actions.reject.reason ?? actions.request_info.reason ?? null
      : null;
  const rounds: DecisionRound[] =
    data.rounds && data.rounds.length > 0
      ? data.rounds
      : data.decisions.length > 0
        ? [
            {
              round: data.round ?? 0,
              current: true,
              settledBy: null,
              governing: data.governing ?? { reviewers: data.decisions.length, secondReviewRequired: second.required, cause: second.cause },
              decisions: data.decisions,
            },
          ]
        : [];
  const totalDecisions = rounds.reduce((n, r) => n + r.decisions.length, 0);
  const external = data.externalFeedback ?? [];
  const infoRequests = data.informationRequests ?? [];

  return (
    <section
      id={DECISION_ANCHOR_ID}
      className="app-panel"
      aria-labelledby="review-decision-title"
      tabIndex={-1}
      style={{ minWidth: 0 }}
      data-section="reviewer-decision-lineage"
      data-decision-panel
      data-decision-state={data.state}
      data-decision-next-action={nextAction}
      data-decision-requires-second={second.required ? "true" : "false"}
      data-decision-caller-is-first-reviewer={data.callerContext.callerIsFirstReviewer ? "true" : "false"}
      data-decision-is-adjudicator={data.callerContext.isAdjudicator ? "true" : "false"}
      {...(conflict ? { "data-decision-panel-mode": "adjudication" } : { "data-decision-panel-mode": "decision" })}
    >
      <div className="app-panel__head" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <h2 id="review-decision-title" className="app-panel__title" style={{ margin: 0 }}>
          {conflict ? "Adjudication" : "Record decision"}
        </h2>
        <AppStatusText tone={STATE_TONE[data.state] ?? "slate"} data-decision-state-chip={data.state}>
          {STATE_LABELS[data.state] ?? "Review in progress"}
        </AppStatusText>
      </div>
      <div className="app-panel__body" style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {data.continuedFrom === "unresolved_adjudication" && data.state === "first_required" ? (
          <p className="app-field-help" data-decision-new-round="unresolved_adjudication" style={{ margin: 0 }}>
            The adjudication was left unresolved, so a new review round has started: the assigned reviewer records
            the first decision, then a different reviewer confirms it.
          </p>
        ) : null}
        {conflict ? (
          <p className="app-field-help" data-section="reviewer-adjudication" style={{ margin: 0 }}>
            The first and second reviews disagree. An owner or admin who made neither decision settles it here;
            an approval or rejection cannot settle a disagreement.
          </p>
        ) : governingSentence || finalDecision ? (
          <>
            {finalDecision ? (
              <p className="app-field-help" data-decision-outcome style={{ margin: 0, fontWeight: 600 }}>
                Decision: {finalDecision}
              </p>
            ) : null}
            {governingSentence ? (
              <p className="app-field-help" data-decision-governing style={{ margin: 0 }}>
                {governingSentence}
              </p>
            ) : null}
          </>
        ) : pendingIndependent ? (
          <div
            className="app-field-help"
            data-decision-pending-independent
            data-decision-second-review-reason={second.cause ?? undefined}
            data-decision-second-review-staffing={second.staffing ?? undefined}
            style={{ margin: 0, display: "grid", gap: 6, minWidth: 0, overflowWrap: "anywhere" }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>First review recorded — waiting for an independent reviewer</p>
            <p style={{ margin: 0 }} data-decision-pending-cause>
              {pendingCause}
              {!handoffShown && nobodyEligible
                ? " Nobody else is eligible yet — invite a member with review permission, then assign the second review."
                : ""}
            </p>
            {!handoffShown ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {onAssignSecondReviewer && actions.reassign.allowed && !nobodyEligible ? (
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={onAssignSecondReviewer}
                    data-decision-pending-assign
                  >
                    Assign second reviewer
                  </button>
                ) : null}
                {nobodyEligible ? staffingLink : null}
              </div>
            ) : null}
          </div>
        ) : requirementSentence ? (
          <p
            className="app-field-help"
            data-decision-requirement
            data-decision-second-review-reason={second.cause ?? undefined}
            data-decision-second-review-staffing={second.staffing ?? undefined}
            style={{ margin: 0, overflowWrap: "anywhere" }}
          >
            {requirementSentence}
          </p>
        ) : (
          <p className="app-field-help" style={{ margin: 0 }}>
            One review decides this review (no policy requires a second review).
          </p>
        )}

        {showDecisionForm ? (
          <DecisionForm
            mode="decision"
            stage={formStage}
            actions={actions}
            reviewState={data.state}
            secondRequired={second.required}
            onSubmit={submitDecision}
            focusRequest={focusRequest}
            firstRecorded={firstRecorded}
            assessment={assessment}
          />
        ) : showAdjudicationForm ? (
          <DecisionForm
            mode="adjudication"
            stage="SECOND"
            actions={actions}
            reviewState={data.state}
            secondRequired
            onSubmit={submitDecision}
            focusRequest={focusRequest}
          />
        ) : (
          <>
            <p
              className="app-field-help"
              data-decision-blocked-banner={nextAction}
              {...(conflict ? { "data-adjudication-blocked": "" } : {})}
              style={{ margin: 0, overflowWrap: "anywhere" }}
            >
              {conflict
                ? adjudicationBlockedReason ??
                  (nextAction === "blocked_adjudicator_not_independent"
                    ? REVIEW_REFUSAL_MESSAGES.adjudicator_not_independent
                    : `Only a workspace owner or admin who made neither decision can adjudicate (your role: ${teamRoleLabel(
                        data.callerContext.teamRole,
                      )}).`)
                : nextAction === "blocked_same_reviewer"
                  ? "A different reviewer must decide. You made the first decision, so the second review needs another reviewer."
                  : nextAction === "no_action_resolved"
                    ? "Review resolved. No further decisions are accepted for this round."
                    : verdictClosedReason ?? "No decision is open to you on this review right now."}
            </p>
            {/* F-21 — the refused text survives a refresh that closed the form. */}
            {kept ? (
              <div role="alert" data-decision-kept-draft style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <p className="app-field-error" data-decision-form-error style={{ margin: 0, overflowWrap: "anywhere" }}>
                  {kept.failure.message}
                </p>
                <label className="app-field-label" htmlFor="review-decision-kept-text">
                  Your text (not recorded)
                </label>
                <textarea
                  id="review-decision-kept-text"
                  className="app-input app-textarea"
                  readOnly
                  rows={3}
                  value={kept.body.rationale}
                  data-decision-kept-rationale
                  style={{ boxSizing: "border-box" }}
                />
              </div>
            ) : null}
          </>
        )}

        {/* ---- decision history: every round (T-023) ---- */}
        {totalDecisions > 0 ? (
          <div style={{ minWidth: 0, display: "grid", gap: 10 }} data-decision-history data-decision-round-count={rounds.length}>
            <p className="app-field-label" style={{ margin: 0 }}>
              Decision lineage ({totalDecisions})
            </p>
            {rounds.map((round) => (
              <div key={round.round} data-decision-round={round.round} data-decision-round-settled={round.settledBy ?? "open"} style={{ display: "grid", gap: 6 }}>
                {rounds.length > 1 ? (
                  <p className="app-field-help" style={{ margin: 0, fontWeight: 600 }}>
                    Round {round.round + 1}
                    {round.settledBy ? ` — ${ROUND_SETTLED_LABELS[round.settledBy] ?? "settled"}` : round.current ? " — current" : ""}
                  </p>
                ) : null}
                <ol
                  {...(round.current ? { "data-decision-lineage": "" } : {})}
                  data-decision-lineage-count={round.decisions.length}
                  {...(round.current && conflict ? { "data-adjudication-contested": "" } : {})}
                  style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}
                >
                  {round.decisions.map((d, idx) => (
                    <DecisionRowItem key={d.id} d={d} index={idx} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        ) : (
          <p data-decision-lineage-empty className="app-field-help" style={{ margin: 0 }}>
            No decisions recorded yet for this workflow.
          </p>
        )}

        {/* ---- Information requests: workflow actions, not decisions (F-04) ---- */}
        {infoRequests.length > 0 ? (
          <div data-decision-information-requests style={{ minWidth: 0, display: "grid", gap: 6 }}>
            <p className="app-field-label" style={{ margin: 0 }}>
              Information requested ({infoRequests.length})
            </p>
            <p className="app-field-help" style={{ margin: 0 }}>
              A request for information pauses the review; it is not a decision.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {infoRequests.map((r) => {
                const by = r.requestedBy?.displayName?.trim() || "A reviewer";
                const from =
                  "userId" in r.requestedFrom
                    ? r.requestedFrom.displayName?.trim() || "a workspace member"
                    : "the evidence owner";
                return (
                  <li
                    key={r.id}
                    data-information-request-row
                    data-information-request-superseded={r.supersededDecisionId ? "true" : "false"}
                    className="app-inner-surface"
                    style={{ padding: "0.5rem 0.7rem", minWidth: 0 }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                      <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                        {by} asked {from}
                      </span>
                      <time dateTime={r.requestedAtUtc} className="app-field-help" style={{ margin: 0 }}>
                        {formatUserDateTime(r.requestedAtUtc)}
                      </time>
                    </div>
                    {r.reason ? (
                      <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.reason}</div>
                    ) : null}
                    {r.supersededDecisionId ? (
                      <p className="app-field-help" style={{ margin: "4px 0 0" }}>
                        The first decision recorded before this request was set aside; the review continues in a new round.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* ---- External Review feedback: advisory only (T-024) ---- */}
        {external.length > 0 ? (
          <div data-decision-external-feedback style={{ minWidth: 0, display: "grid", gap: 6 }}>
            <p className="app-field-label" style={{ margin: 0 }}>
              External feedback ({external.length})
            </p>
            <p className="app-field-help" style={{ margin: 0 }}>
              Advisory only — external reviewers do not decide this review.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {external.map((x) => (
                <li key={x.id} data-external-feedback-row data-external-verdict={x.verdict} className="app-inner-surface" style={{ padding: "0.5rem 0.7rem", minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                    <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      {(EXTERNAL_VERDICT_LABELS[x.verdict] ?? identifierLabel(x.verdict))} · {reviewerIdentityLabel({ displayName: x.reviewer.displayName, maskedEmail: maskEmail(x.reviewer.email ?? null) })}
                    </span>
                    <time dateTime={x.submittedAt} className="app-field-help" style={{ margin: 0 }}>
                      {formatUserDateTime(x.submittedAt)}
                    </time>
                  </div>
                  {x.rationale ? (
                    <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.rationale}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
