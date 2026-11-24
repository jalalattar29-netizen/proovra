"use client";

/**
 * Team remediation T-001…T-006 (2026-11-24) — focus mode records decisions
 * through THE Review page's decision component and canonical door.
 *
 * The Reviewer Workspace used to decide through the legacy approve / reject /
 * request-info routes with its own buttons (enabled on `review.decide` alone),
 * dropped the typed reason before the server answered, reported every result
 * as "Workflow reject recorded." in a ribbon far from the controls, never
 * offered Start, and escalated with a hard-coded WORKFLOW_STALLED / WARNING.
 *
 * This column mounts, for the active review:
 *   - the shared decision panel (`ReviewerDecisionLineagePanel` +
 *     `DecisionForm`), fed by `GET /v1/reviewer-ops/workspace/:id`
 *     (`viewer.actions`, the handoff) and posting to
 *     `POST /v1/reviewer-ops/workspace/:id/decisions` through the shared
 *     step-up flow — the form keeps its text and shows a refusal inline;
 *   - Start review when the server offers it (an assigned review that has not
 *     started); until then the verdicts are closed with the server's reason;
 *   - Escalate through the shared Escalate dialog (reason, severity, and
 *     whether it forces an independent second review);
 *   - the shared outcome copy (`describeOutcome`) next to the decision.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { CanonicalActionButton } from "../../../../../components/external-review/CanonicalActionButton";
import { StepUpModal, isStepUpCancelled, useStepUpAction } from "../../../../../components/identity-security/StepUpModal";
import { type DecisionFocusRequest, type DecisionSubmitBody } from "../../../reviewer-ops/[reviewId]/_components/DecisionPanel";
import {
  ReviewerDecisionLineagePanel,
  refusalMessage,
  type DecisionsSummary,
} from "../../../reviewer-ops/[reviewId]/_components/DecisionLineagePanel";
import { EscalateDialog, type EscalateInput } from "../../../reviewer-ops/[reviewId]/_components/InspectorDialogs";
import {
  VERDICT_ACTION,
  VERDICT_CHOICES,
  deriveActions,
  describeOutcome,
  type DecisionOutcome,
  type LifecycleActionKind,
  type LifecycleState,
  type Viewer,
} from "../../../reviewer-ops/[reviewId]/_components/inspector-model";

type FocusWorkspace = {
  projection: { workflowId: string; evidenceId: string; lifecycleState: LifecycleState; assignedToUserId: string | null; slaPausedAtUtc: string | null };
  viewer?: Viewer | null;
};

/** A hotkey asking the column to act (a/r/i focus the form with that choice; e opens Escalate). */
export type FocusHotkeyRequest = { kind: "APPROVE" | "REJECT" | "REQUEST_INFO" | "ESCALATE"; nonce: number };

export function FocusDecisionColumn({
  teamId,
  workflowId,
  hotkeyRequest,
  onNotice,
  onDecided,
  onMutated,
}: {
  teamId: string;
  workflowId: string;
  hotkeyRequest: FocusHotkeyRequest | null;
  /** The one result line, shown by the host next to the decision column. */
  onNotice: (text: string | null) => void;
  /**
   * A decision was recorded (never called for a replay). `moved` is true when
   * it moved the review out of this reviewer's hands (it finished, it now waits
   * for an independent reviewer or for information): the host advances.
   */
  onDecided: (body: DecisionSubmitBody, outcome: DecisionOutcome | null, moved: boolean) => void;
  /** Any mutation (start, escalate, decision): the host refetches its summary. */
  onMutated: () => void;
}) {
  const [data, setData] = useState<FocusWorkspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [decisions, setDecisions] = useState<DecisionsSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<DecisionFocusRequest | null>(null);
  const stepUp = useStepUpAction({ teamId });

  const load = useCallback(async () => {
    try {
      const r = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as FocusWorkspace;
      setData(r);
      setLoadError(null);
    } catch (err) {
      setLoadError(refusalMessage(err, "Could not load this review."));
    }
  }, [teamId, workflowId]);

  useEffect(() => {
    setData(null);
    setDecisions(null);
    setActionError(null);
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
    setVersion((v) => v + 1);
    onMutated();
  }, [load, onMutated]);

  const actions = data
    ? deriveActions({
        viewer: data.viewer,
        lifecycleState: data.projection.lifecycleState,
        paused: Boolean(data.projection.slaPausedAtUtc),
        assigned: Boolean(data.projection.assignedToUserId),
      })
    : null;
  const nextAction = decisions?.nextAction ?? null;
  const inConflict = decisions?.state === "conflict_detected" || decisions?.state === "adjudication_required";
  const mayDecide = Boolean(
    actions &&
      (nextAction === "submit_first" || nextAction === "submit_second") &&
      VERDICT_CHOICES.some((c) => actions[VERDICT_ACTION[c]].allowed),
  );
  const mayAdjudicate = Boolean(actions && inConflict && actions.adjudicate.allowed);

  // Hotkeys drive the SAME controls: a verdict key focuses the shared form
  // with that choice (never records anything by itself); e opens Escalate.
  const handledHotkey = useRef(0);
  useEffect(() => {
    if (!hotkeyRequest || hotkeyRequest.nonce === handledHotkey.current || !actions) return;
    handledHotkey.current = hotkeyRequest.nonce;
    if (hotkeyRequest.kind === "ESCALATE") {
      if (actions.escalate.allowed) setEscalateOpen(true);
      return;
    }
    setFocusRequest({ choice: hotkeyRequest.kind, nonce: hotkeyRequest.nonce });
  }, [hotkeyRequest, actions]);

  const start = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      onNotice("Review started.");
      reload();
    } catch (err) {
      setActionError(refusalMessage(err, "The review could not be started. Nothing was changed."));
      reload();
    } finally {
      setBusy(false);
    }
  }, [teamId, workflowId, onNotice, reload]);

  const postDecision = useCallback(
    async (body: DecisionSubmitBody): Promise<string | null> => {
      onNotice(null);
      try {
        const resp = (await stepUp.runStepUpAction((headers) =>
          apiFetch(`/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ teamId, ...body }),
          }),
        )) as { outcome?: DecisionOutcome | null } | null;
        const outcome = resp?.outcome ?? null;
        const kind: LifecycleActionKind =
          body.decision === "APPROVE"
            ? "approve"
            : body.decision === "REJECT"
              ? "reject"
              : body.decision === "REQUEST_INFO"
                ? "request_info"
                : "decision";
        onNotice(describeOutcome(kind, outcome));
        reload();
        if (!outcome || !outcome.idempotent) {
          onDecided(body, outcome, Boolean(outcome && (outcome.statusChanged || outcome.nextRequirement !== null)));
        }
        return null;
      } catch (err) {
        if (isStepUpCancelled(err)) return "Identity confirmation was cancelled. Nothing was recorded.";
        reload();
        return refusalMessage(err, "The decision could not be recorded. Nothing was changed.");
      }
    },
    [teamId, workflowId, stepUp, onNotice, reload, onDecided],
  );

  const postEscalate = useCallback(
    async (input: EscalateInput): Promise<string | null> => {
      try {
        await apiFetch("/v1/reviewer-ops/escalations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId, workflowId, reason: input.reason, severity: input.severity, safeSummary: input.safeSummary }),
        });
        setEscalateOpen(false);
        onNotice("Escalation raised.");
        reload();
        return null;
      } catch (err) {
        return refusalMessage(err, "The escalation could not be raised. Nothing was changed.");
      }
    },
    [teamId, workflowId, onNotice, reload],
  );

  if (loadError && !data) {
    return (
      <p role="alert" className="app-field-error" data-focus-decision-load-error style={{ margin: 0 }}>
        {loadError}
      </p>
    );
  }
  if (!data || !actions) {
    return (
      <p className="app-field-help" data-focus-decision-loading style={{ margin: 0 }}>
        Loading review state…
      </p>
    );
  }

  return (
    <div data-focus-decision-column style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {actions.start.allowed || actions.escalate.allowed ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-focus-decision-actions>
          {actions.start.allowed ? (
            <CanonicalActionButton
              variant="primary"
              disabled={busy}
              onClick={() => void start()}
              data-focus-action="start"
            >
              {busy ? "Starting…" : "Start review"}
            </CanonicalActionButton>
          ) : null}
          {actions.escalate.allowed ? (
            <CanonicalActionButton
              variant="secondary"
              disabled={busy}
              onClick={() => setEscalateOpen(true)}
              data-focus-action="escalate"
            >
              Escalate
            </CanonicalActionButton>
          ) : null}
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="app-field-error" data-focus-action-error style={{ margin: 0, overflowWrap: "anywhere" }}>
          {actionError}
        </p>
      ) : null}
      <ReviewerDecisionLineagePanel
        workflowId={workflowId}
        teamId={teamId}
        refreshKey={version}
        onLoaded={setDecisions}
        onSubmitDecision={postDecision}
        actions={actions}
        mayDecide={mayDecide}
        mayAdjudicate={mayAdjudicate}
        adjudicationBlockedReason={data.viewer && !actions.adjudicate.allowed ? actions.adjudicate.reason : null}
        focusRequest={focusRequest}
      />
      <EscalateDialog
        open={escalateOpen}
        onCancel={() => setEscalateOpen(false)}
        onSubmit={postEscalate}
        forcesIndependentReview={data.viewer?.escalationForcesIndependentReview ?? true}
      />
      <StepUpModal control={stepUp} />
    </div>
  );
}
