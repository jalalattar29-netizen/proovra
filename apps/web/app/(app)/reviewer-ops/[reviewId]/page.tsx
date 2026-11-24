"use client";
import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../lib/feedback/plan-refusal";
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

/**
 * Phase 25 — Review Workspace (single review).
 *
 * Full-page reviewer workspace surface. Loads `/workspace/:workflowId`,
 * shows lifecycle / SLA / escalation panels and the reviewer action surface.
 *
 * TEAM-UI-SPEC §2 (round 3) — ONE decision-entry flow. The "Record decision"
 * panel is the only place a verdict (FIRST, SECOND) or an adjudication is
 * entered; it posts `POST /v1/reviewer-ops/workspace/:id/decisions` through the
 * shared step-up flow. The standalone Approve / Reject / Request information
 * buttons and their dialogs are gone. The "Next step" panel offers one
 * contextual primary and only the secondary actions the server allows.
 *
 * Actions come from the server's `viewer.actions` (who may do what now, and
 * why not); the old lifecycle-only rule is a fallback for an API that does
 * not send them. Decision copy comes from the server's `outcome`, so a FIRST
 * decision under a second-review requirement never reads as an approval.
 * After any action the workspace AND the decision lineage / notes panels
 * reload, and a lineage decision reloads the workspace.
 *
 * Wording: operator-safe only. Approvals and rejections are INTERNAL review
 * decisions. Never composes legal / forensic overclaim phrases.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId, useOptionalPlatformContext } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
// Phase G3.2 — Presence + collision wiring for the reviewer
// inspector. Mirrors the evidence detail page's presence surfacing
// so reviewers see when a peer is acting on the same workflow + when
// the workflow has moved under them.
import { PresenceIndicator } from "../../../../components/presence/PresenceIndicator";
import { CollisionWarning } from "../../../../components/presence/CollisionWarning";
import {
  StepUpModal,
  isStepUpCancelled,
  stepUpCancelMessage,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { ReviewerCopilotPanel } from "../../../../components/ai-copilot/ReviewerCopilotPanel";
import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../components/ReviewerReasonModal";
// Batch J — POST /v1/reviewer/work/:workflowId/bind-schema (coding fields
// only appear once a review is bound to a published schema).
import { CodingSchemaBindingPanel } from "../components/CodingSchemaBindingPanel";
import {
  ReviewerShortcutsHelp,
  isShortcutTarget,
  useReviewerHelpHotkey,
} from "../components/ReviewerShortcutsHelp";
import {
  formatCellDateTime,
  formatRelativeDeadline,
} from "../../../../lib/date";
import { PageShell } from "../../../../components/ui/PageShell";
// TEAM-UI-SPEC (structure) — the one review page header, with the
// "← My reviews" back link above the title (Evidence Detail's breadcrumb slot).
import {
  ReviewPageHeader,
  type ReviewPageHeaderBack,
} from "../../../../components/reviewer-experience/ReviewPageHeader";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { severityTone, statusTone } from "../../../../components/ui/StatusBadge";
import { identifierLabel } from "@proovra/shared";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
import { describeArtifactDownloadFailure } from "../../../../lib/evidence/report-download-feedback";
import { ARTIFACT_WINDOW_BLOCKED_MESSAGE, openPendingArtifactWindow } from "../../../../lib/evidence/artifact-window";
import { recordReference } from "../../../../lib/short-id";
import { CopyIdButton } from "./_components/CopyIdButton";
import { DECISION_ANCHOR_ID, InspectorActions } from "./_components/InspectorActions";
import { type DecisionFocusRequest, type DecisionSubmitBody } from "./_components/DecisionPanel";
import {
  ReviewerDecisionLineagePanel,
  refusalMessage,
  type DecisionsSummary,
} from "./_components/DecisionLineagePanel";
import { ArchiveDialog, EscalateDialog, ReassignDialog, type EscalateInput } from "./_components/InspectorDialogs";
import { HandoffBanner, handoffAwaitsManager, type ReviewHandoff } from "./_components/HandoffBanner";
import {
  VERDICT_ACTION,
  VERDICT_CHOICES,
  deriveActions,
  describeOutcome,
  headerSlaLabel,
  lifecycleLabel,
  nextStepPrimary,
  slaDimensionLabel,
  slaStateLabel,
  type ActionMap,
  type DecisionOutcome,
  type LifecycleActionKind,
  type LifecycleState,
  type SlaState,
  type Viewer,
  type ViewerActionName,
} from "./_components/inspector-model";

type WorkspaceResponse = {
  projection: {
    workflowId: string;
    evidenceId: string;
    /** Optional readable evidence name, when the API projects one. */
    evidenceTitle?: string | null;
    lifecycleState: LifecycleState;
    assignedToUserId: string | null;
    /** Optional readable assignee name, when the API projects one. */
    assignedToDisplayName?: string | null;
    assignedAtUtc: string | null;
    priority: string;
    slaPausedAtUtc: string | null;
    pausedReason: string | null;
    slaRollupState: SlaState;
    slaDimensions: Array<{
      dimension: string;
      dueAtUtc: string | null;
      state: SlaState;
    }>;
  };
  openEscalation: null | {
    id: string;
    reason: string;
    severity: string;
    status: string;
    safeSummary: string;
    createdAt: string;
    assignedToUserId: string | null;
  };
  /** Kept by the API for compatibility; the page renders `viewer.actions`. */
  allowedLifecycleTransitions: LifecycleState[];
  /**
   * Who may do what now, computed by the server from lifecycle, role,
   * assignment, stage and independence. Optional: an older API omits it and
   * the page falls back to the lifecycle-only rule.
   */
  viewer?: Viewer | null;
  /**
   * TEAM-SPEC R3 — the second-review / adjudication handoff (who recorded the
   * first review, whether anyone eligible exists, staffing). Optional: an
   * older API omits it and no banner is shown.
   */
  handoff?: ReviewHandoff | null;
  /**
   * The opaque analysis revision for this review's evidence.
   *
   * Optional so an older API degrades to a panel that offers no selection
   * rather than one that selects records nobody can say are current.
   */
  analysisRevision?: string | null;
  // Phase B-2 — additive governance signals from the workspace
  // endpoint. Optional so older API versions degrade gracefully.
  governance?: {
    legalHold: {
      activeCount: number;
      mostRecent: null | {
        id: string;
        title: string;
        placedAtUtc: string;
      };
    };
    requiresRedaction: boolean;
    requiresRedactionFieldCount: number;
  };
};

/**
 * The reviewer-ops lifecycle actions this page can POST.
 *
 * A CLOSED set, matching the registered
 * `POST /v1/reviewer-ops/reviews/:workflowId/<action>` routes one-for-one. Typed
 * as a union rather than `string` so the call site resolves statically: the
 * route-consumer analyzer can then prove exactly which routes this page
 * consumes instead of reporting an unresolvable dynamic call.
 *
 * TEAM-UI-SPEC §2 — approve / reject / request-info are no longer posted from
 * here: every verdict goes through the decisions route.
 */
type ReviewerOpsAction = "start" | "pause" | "resume" | "response-received";

/** Stable (module-level) so the reassign dialog's load effect does not refire. */
function reassignRefusalMessage(err: unknown): string {
  return refusalMessage(err, "The review could not be reassigned. Nothing was changed.");
}

const STEP_UP_CANCELLED = "Identity confirmation was cancelled. Nothing was recorded.";

const ACTION_ROUTE: Record<"start" | "pause" | "resume" | "record_response", ReviewerOpsAction> = {
  start: "start",
  pause: "pause",
  resume: "resume",
  record_response: "response-received",
};

const TERMINAL_LIFECYCLE: LifecycleState[] = ["APPROVED", "REJECTED", "ARCHIVED"];

// Phase 38.12 — wrap in canonical PageRouteGate.
export default function ReviewWorkspacePage() {
  return (
    <PageRouteGate routeId="review.queue_detail">
      <ReviewWorkspacePageInner />
    </PageRouteGate>
  );
}

function deriveSignature(r: WorkspaceResponse | null): string | null {
  if (!r) return null;
  const p = r.projection;
  return [
    p.lifecycleState,
    p.assignedToUserId ?? "",
    p.slaRollupState,
    p.assignedAtUtc ?? "",
    r.openEscalation?.id ?? "",
    r.openEscalation?.status ?? "",
  ].join("|");
}

type InspectorDialog = "reassign" | "assign_second_reviewer" | "escalate" | "archive" | null;

function ReviewWorkspacePageInner() {
  const params = useParams<{ reviewId: string }>();
  const workflowId = params?.reviewId ?? "";
  // PageRouteGate guarantees an entitled active workspace here.
  const teamId = useActiveSpaceId();
  // The envelope's REVIEW_ESCALATE capability gates the Escalate entry point
  // (fail-closed without an envelope). The server still decides the POST.
  const platform = useOptionalPlatformContext();
  const envelopeMayEscalate = platform?.envelope?.capabilities?.REVIEW_ESCALATE === true;
  // Archive uses the bulk CLOSE door: OWNER/ADMIN bulk authority only.
  const envelopeMayArchive = platform?.envelope?.capabilities?.BULK_ACTIONS === true;
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed READ of the workspace, kept apart from an action refusal so a
  // reload after a refusal never wipes the refusal off the screen.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<ViewerActionName | null>(null);
  // Bumped after every action so the lineage and notes panels reread.
  const [panelsVersion, setPanelsVersion] = useState(0);
  const [decisions, setDecisions] = useState<DecisionsSummary | null>(null);
  // Phase G3.2 — collision detection. The reviewer workspace
  // projection doesn't surface `updatedAt` directly, so we derive a
  // stable signature from the fields that mutating actions move
  // (lifecycle, assignment, SLA, escalation). String equality on the
  // signature is the same check CollisionWarning performs against an
  // ISO timestamp — both modes are honest, neither claims false
  // precision.
  const [initialSignature, setInitialSignature] = useState<string | null>(null);
  // Phase 2.4 — structured reason dialog (Pause, Record response).
  const [reasonModal, setReasonModal] = useState<ReviewerReasonKind | null>(
    null,
  );
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<InspectorDialog>(null);
  // "Go to decision" and M ask the decision form for focus.
  const [focusRequest, setFocusRequest] = useState<DecisionFocusRequest | null>(null);
  const focusNonce = useRef(0);
  // Phase 2.5 — keyboard shortcuts + help overlay.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useReviewerHelpHotkey({
    open: shortcutsOpen,
    onOpen: () => setShortcutsOpen(true),
    onClose: () => setShortcutsOpen(false),
  });
  // A verdict, an escalation and an archive take the shared step-up challenge
  // when the workspace policy (or the adaptive gate) asks for one.
  const stepUp = useStepUpAction({ teamId });

  const load = useCallback(() => {
    if (!teamId || !workflowId) return;
    apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(
        workflowId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: WorkspaceResponse) => {
        setData(r);
        setLoadError(null);
        // Capture the first signature; subsequent reloads update
        // `data` (the current side) but never overwrite this snapshot.
        setInitialSignature((prev) => prev ?? deriveSignature(r));
      })
      .catch((err: { message?: string }) =>
        setLoadError(toSafeUserError(err, { message: "Could not load workspace." }).message),
      );
  }, [teamId, workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Reload the workspace AND the lineage / notes panels. */
  const reloadAll = useCallback(() => {
    load();
    setPanelsVersion((v) => v + 1);
  }, [load]);

  const post = useCallback(
    // `action` is the TRAILING SEGMENT of a reviewer-ops action route, and the
    // set is CLOSED — typed as the union rather than as `string`, so the
    // route-consumer analyzer can prove which routes the page consumes and a
    // typo is a compile error rather than a 404 discovered by a reviewer.
    //
    // PRO-R2-16 — resolves true only when the action succeeded, so a caller
    // holding typed input (the reason dialog) keeps it on a refusal. A refusal
    // from a dialog is shown inside that dialog.
    async (
      name: ViewerActionName & keyof typeof ACTION_ROUTE,
      body: Record<string, unknown>,
      opts: { kind?: LifecycleActionKind; inDialog?: boolean } = {},
    ): Promise<boolean> => {
      if (!teamId) return false;
      const action: ReviewerOpsAction = ACTION_ROUTE[name];
      setBusy(name);
      setNotice(null);
      if (opts.inDialog) setDialogError(null);
      else setError(null);
      try {
        const resp = (await apiFetch(
          `/v1/reviewer-ops/reviews/${encodeURIComponent(
            workflowId,
          )}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        )) as { outcome?: DecisionOutcome | null } | null;
        if (opts.kind) setNotice(describeOutcome(opts.kind, resp?.outcome ?? null));
        else if (name === "pause") setNotice("Review paused. The SLA clock is stopped.");
        else if (name === "resume") setNotice("Review resumed.");
        else if (name === "start") setNotice("Review started.");
        reloadAll();
        return true;
      } catch (err) {
        const message = refusalMessage(err, "The action could not be completed. Nothing was changed.");
        if (opts.inDialog) setDialogError(message);
        else setError(message);
        // A stale or out-of-stage refusal means the page is behind: reread.
        reloadAll();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [teamId, workflowId, reloadAll],
  );

  const actions: ActionMap | null = data
    ? deriveActions({
        viewer: data.viewer,
        lifecycleState: data.projection.lifecycleState,
        paused: Boolean(data.projection.slaPausedAtUtc),
        assigned: Boolean(data.projection.assignedToUserId),
      })
    : null;

  const nextAction = decisions?.nextAction ?? null;
  const inConflict =
    decisions?.state === "conflict_detected" || decisions?.state === "adjudication_required";
  // The decision form opens for FIRST / SECOND when the lineage asks this
  // viewer and at least one verdict kind is open in the action map.
  const mayDecide = Boolean(
    actions &&
      (nextAction === "submit_first" || nextAction === "submit_second") &&
      VERDICT_CHOICES.some((c) => actions[VERDICT_ACTION[c]].allowed),
  );
  const mayAdjudicate = Boolean(
    actions &&
      inConflict &&
      (nextAction === "submit_adjudication" || (data?.viewer ? actions.adjudicate.allowed : false)),
  );

  /** Move focus to the decision panel, optionally preselecting a choice. */
  const goToDecision = useCallback((choice: string | null) => {
    focusNonce.current += 1;
    setFocusRequest({ choice, nonce: focusNonce.current });
    if (typeof document !== "undefined") {
      document.getElementById(DECISION_ANCHOR_ID)?.scrollIntoView?.({ block: "start" });
    }
  }, []);

  // Phase 2.5 — action shortcuts. A starts the review; M moves focus to the
  // decision panel with Request information preselected (TEAM-UI-SPEC §2).
  // There is no approve key. They fire ONLY when no field is focused and only
  // when the action map allows the action, so a shortcut never bypasses what
  // the controls enforce. None of them navigates away from the review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (shortcutsOpen) return;
      if (reasonModal !== null || dialog !== null) return;
      if (!actions || busy !== null) return;
      const k = e.key.toLowerCase();
      if (k === "m") {
        if (!mayDecide || !actions.request_info.allowed) return;
        e.preventDefault();
        goToDecision("REQUEST_INFO");
      } else if (k === "a") {
        if (!actions.start.allowed) return;
        e.preventDefault();
        void post("start", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, busy, shortcutsOpen, reasonModal, dialog, post, mayDecide, goToDecision]);

  /**
   * THE verdict / adjudication POST (TEAM-UI-SPEC §2): the decisions route,
   * through the shared step-up flow — the route answers the same step-up
   * challenge as approve / reject. Resolves to an error message, or null.
   */
  const postDecision = useCallback(
    async (body: DecisionSubmitBody): Promise<string | null> => {
      if (!teamId) return "No active workspace.";
      setNotice(null);
      setError(null);
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
        setNotice(outcome || kind !== "decision" ? describeOutcome(kind, outcome) : "Decision recorded.");
        reloadAll();
        return null;
      } catch (err) {
        // T-027 (stage B) — closing the enrolment or re-sign-in state is not
        // "cancelling a confirmation"; the line says what is needed instead.
        if (isStepUpCancelled(err)) return stepUpCancelMessage(err, STEP_UP_CANCELLED);
        reloadAll();
        return refusalMessage(err, "The decision could not be recorded. Nothing was changed.");
      }
    },
    [teamId, workflowId, reloadAll, stepUp],
  );

  /** Reassign (or assign the independent second reviewer). */
  const postReassign = useCallback(
    async (newAssigneeUserId: string, handoff: boolean): Promise<string | null> => {
      if (!teamId) return "No active workspace.";
      try {
        await apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/reassign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId, newAssigneeUserId }),
        });
        setError(null);
        setNotice(handoff ? "Second reviewer assigned." : "Review reassigned.");
        setDialog(null);
        reloadAll();
        return null;
      } catch (err) {
        return reassignRefusalMessage(err);
      }
    },
    [teamId, workflowId, reloadAll],
  );

  /** Escalate — the same body the reviewer console raises. */
  const postEscalate = useCallback(
    async (input: EscalateInput): Promise<string | null> => {
      if (!teamId) return "No active workspace.";
      try {
        // T-037 (stage B) — raising an escalation is never step-up gated, so
        // it is not wrapped (the wrapper was a no-op that implied otherwise).
        await apiFetch("/v1/reviewer-ops/escalations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId,
            workflowId,
            reason: input.reason,
            severity: input.severity,
            safeSummary: input.safeSummary,
          }),
        });
        setError(null);
        setNotice("Escalation raised.");
        setDialog(null);
        reloadAll();
        return null;
      } catch (err) {
        return refusalMessage(err, "The escalation could not be raised. Nothing was changed.");
      }
    },
    [teamId, workflowId, reloadAll],
  );

  /**
   * Archive — the single-review archive route (T-161): CLOSE ends the workflow
   * and keeps whatever the round decided; it is never a verdict and never a
   * bulk triage. The Close guard refuses it while a second review or an
   * adjudication is pending.
   */
  const postArchive = useCallback(
    async (note: string): Promise<string | null> => {
      if (!teamId) return "No active workspace.";
      try {
        await stepUp.runStepUpAction((headers) =>
          apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/archive`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ teamId, ...(note ? { note } : {}) }),
          }),
        );
        setError(null);
        setNotice("Review archived.");
        setDialog(null);
        reloadAll();
        return null;
      } catch (err) {
        if (isStepUpCancelled(err)) {
          return stepUpCancelMessage(err, "Identity confirmation was cancelled. The review was not archived.");
        }
        reloadAll();
        return refusalMessage(err, "The review could not be archived. Nothing was changed.");
      }
    },
    [teamId, workflowId, reloadAll, stepUp],
  );

  /**
   * Reopen (T-009) — the same lifecycle transition the Evidence page uses
   * (a finished review moves to Reopened and the next decision opens a new
   * round), through the same door and its gate. Resolves true on success.
   */
  const postReopen = useCallback(
    async (note: string): Promise<boolean> => {
      if (!data) return false;
      setDialogError(null);
      setBusy("reopen");
      try {
        await stepUp.runStepUpAction((headers) =>
          apiFetch(`/v1/review-operations/evidence/${encodeURIComponent(data.projection.evidenceId)}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ decision: "REOPEN", note }),
          }),
        );
        setError(null);
        setNotice("Review reopened. The next decision starts a new round.");
        reloadAll();
        return true;
      } catch (err) {
        setDialogError(
          isStepUpCancelled(err)
            ? "Identity confirmation was cancelled. The review was not reopened."
            : refusalMessage(err, "The review could not be reopened. Nothing was changed."),
        );
        reloadAll();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [data, reloadAll, stepUp],
  );

  const openReason = useCallback((kind: ReviewerReasonKind) => {
    setDialogError(null);
    setReasonModal(kind);
  }, []);

  // PageRouteGate already guaranteed ALLOWED. If the envelope is
  // still hydrating, render the bounded loading shell.
  if (!teamId) {
    return (
      <PageShell
        width="full"
        data-review-workspace-loading
        header={
          <ReviewPageHeader back={INSPECTOR_BACK} title="Review" subtitle="Loading workspace…" />
        }
      />
    );
  }

  if (!data || !actions) {
    return (
      <PageShell
        width="full"
        header={
          <ReviewPageHeader back={INSPECTOR_BACK} title="Review" />
        }
      >
        {loadError ? (
          <p role="alert" className="app-alert app-alert--danger">
            {loadError}
          </p>
        ) : null}
        <EmptyState variant="inline" title="Loading workspace…" />
      </PageShell>
    );
  }

  const p = data.projection;
  const evidenceName = p.evidenceTitle?.trim() || recordReference("Evidence", p.evidenceId);
  const adjudicationBlockedReason =
    data.viewer && !actions.adjudicate.allowed
      ? actions.adjudicate.reason
      : decisions?.nextAction === "blocked_not_adjudicator"
        ? "Adjudication needs a workspace owner or admin who made neither decision."
        : null;
  const assignee = p.assignedToUserId
    ? data.viewer?.isAssignee
      ? "You"
      : p.assignedToDisplayName?.trim() || recordReference("Reviewer", p.assignedToUserId)
    : "Unassigned";
  const mayReassign = Boolean(data.viewer && actions.reassign.allowed);
  const handoffAssign = handoffAwaitsManager(data.handoff, mayReassign);
  const primary = nextStepPrimary({ actions, mayDecide, mayAdjudicate, handoffAssign });
  // T-019 — the server's viewer.actions.escalate decides when present; an
  // older API falls back to the envelope rule.
  const canEscalate =
    envelopeMayEscalate && !TERMINAL_LIFECYCLE.includes(p.lifecycleState) && !data.openEscalation;
  const escalationForcesIndependence = data.viewer?.escalationForcesIndependentReview ?? true;

  return (
    <PageShell
      width="full"
      header={
        /* TEAM-UI-SPEC (structure) — Evidence Detail's hero order: the
           "← My reviews" back link above the title (a real link, so
           middle-click keeps the queue open beside a review), the evidence
           display reference as the title, then ONE lifecycle badge, ONE SLA
           badge and the ghost Copy ID in the context strip. */
        <ReviewPageHeader
          back={INSPECTOR_BACK}
          title={<span data-reviewer-evidence-title>{evidenceName}</span>}
          contextStrip={
            <>
              {/* ONE lifecycle badge and ONE SLA badge, each with its word.
                  The header used to read "escalated • escalated". */}
              <Badge tone={statusTone(p.lifecycleState)} dot data-reviewer-lifecycle-badge>
                {lifecycleLabel(p.lifecycleState)}
              </Badge>
              <Badge tone={statusTone(p.slaRollupState)} dot data-reviewer-sla-badge>
                {headerSlaLabel(p.slaRollupState, p.lifecycleState)}
              </Badge>
              <CopyIdButton value={p.evidenceId} label="Evidence" />
            </>
          }
        />
      }
    >
      {notice ? (
        <p role="status" className="app-alert app-alert--ok" data-reviewer-action-notice style={{ marginTop: 0 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="app-alert app-alert--danger" data-reviewer-action-error style={{ marginTop: 0 }}>
          {error}
        </p>
      ) : null}

      {loadError ? (
        <p role="alert" className="app-alert app-alert--danger" data-reviewer-load-error style={{ marginTop: 0 }}>
          {loadError}
        </p>
      ) : null}
      {/* Phase G3.2 — Presence + collision wiring for the inspector. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 8,
          minWidth: 0,
        }}
      >
        <PresenceIndicator
          teamId={teamId}
          resourceKind="reviewer_workflow"
          resourceId={workflowId}
        />
      </div>
      <CollisionWarning
        entityLabel="Review workflow"
        initialUpdatedAtUtc={initialSignature}
        currentUpdatedAtUtc={deriveSignature(data)}
        onReload={() => reloadAll()}
      />

      {/* Phase B-2 — governance signals strip. Surfaces ACTIVE legal
          hold count + redaction-required visibility decisions for the
          underlying evidence. Read-only; the operator's path to act
          on these lives on /governance/* surfaces (Phase 9). Hidden
          when there is no signal — we never show an empty "no hold"
          state because the absence of a hold is the default. */}
      {data.governance &&
        (data.governance.legalHold.activeCount > 0 ||
          data.governance.requiresRedaction) && (
          <section
            data-section="reviewer-governance-signals"
            data-reviewer-legal-hold-active={
              data.governance.legalHold.activeCount > 0 ? "true" : "false"
            }
            data-reviewer-legal-hold-count={
              data.governance.legalHold.activeCount
            }
            data-reviewer-requires-redaction={
              data.governance.requiresRedaction ? "true" : "false"
            }
            data-reviewer-redaction-field-count={
              data.governance.requiresRedactionFieldCount
            }
            className="app-alert app-alert--warn"
            style={{ marginBottom: 12, display: "grid", gap: 6, minWidth: 0 }}
          >
            <h3 className="app-panel__title" style={{ margin: 0 }}>Governance signals</h3>
            <div className="app-chip-row" style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
              {data.governance.legalHold.activeCount > 0 && (
                <span
                  data-reviewer-governance-chip="legal-hold"
                  className="app-chip app-chip--warn"
                  style={{ overflowWrap: "anywhere", whiteSpace: "normal", height: "auto" }}
                >
                  Legal hold active ({data.governance.legalHold.activeCount})
                  {data.governance.legalHold.mostRecent
                    ? ` — “${data.governance.legalHold.mostRecent.title}”`
                    : ""}
                </span>
              )}
              {data.governance.requiresRedaction && (
                <span data-reviewer-governance-chip="requires-redaction" className="app-chip app-chip--warn">
                  Redaction required (
                  {data.governance.requiresRedactionFieldCount} field
                  {data.governance.requiresRedactionFieldCount === 1
                    ? ""
                    : "s"}
                  )
                </span>
              )}
            </div>
            <p className="app-field-help" style={{ margin: 0 }}>
              {data.governance.legalHold.activeCount > 0
                ? "Evidence under legal hold cannot be deleted or purged. Export gating applies; package downloads remain subject to workspace policy. See Governance → Lifecycle for the full hold history. "
                : ""}
              {data.governance.requiresRedaction
                ? "One or more visibility decisions for this evidence flag fields that need redaction before a report or package is exported. The export gate enforces this on the server."
                : ""}
            </p>
          </section>
        )}

      {/* TEAM-SPEC R3 — the second-review handoff: who recorded the first
          review, staffing, or "waiting". The assignment itself is the Next
          step panel's primary. */}
      <HandoffBanner handoff={data.handoff} mayReassign={mayReassign} />

      {/* TEAM-UI-SPEC (structure) — the "Next step" strip, FULL WIDTH under
          the header like Evidence Detail's "What needs attention". */}
      <InspectorActions
        actions={actions}
        primary={primary}
        fromViewer={Boolean(data.viewer)}
        busy={busy}
        paused={Boolean(p.slaPausedAtUtc)}
        canEscalate={canEscalate}
        canArchive={envelopeMayArchive}
        handlers={{
          start: () => void post("start", {}),
          record_response: () => openReason("RECORD_RESPONSE"),
          pause: () => openReason("PAUSE"),
          resume: () => void post("resume", {}),
          reassign: () => setDialog("reassign"),
          assign_second_reviewer: () => setDialog("assign_second_reviewer"),
          escalate: () => setDialog("escalate"),
          archive: () => setDialog("archive"),
          reopen: () => openReason("REOPEN"),
          go_to_decision: () => goToDecision(null),
        }}
      />

      {/* TEAM-UI-SPEC (structure) — two columns: the ONE decision-entry panel
          (wider) | Assignment & SLA + Linked evidence. One column below
          1100 px (review-surfaces.css). */}
      <div className="review-inspector-columns" data-reviewer-inspector-grid>
        <div className="review-inspector-columns__main">
          {/* TEAM-UI-SPEC §2 — the ONE decision-entry panel (Record decision /
              Adjudication) with the decision lineage. Server-enforced state
              machine: the caller's next allowed action comes from the API. */}
          <ReviewerDecisionLineagePanel
            workflowId={workflowId}
            teamId={teamId}
            refreshKey={panelsVersion}
            onLoaded={setDecisions}
            onSubmitDecision={postDecision}
            actions={actions}
            mayDecide={mayDecide}
            mayAdjudicate={mayAdjudicate}
            adjudicationBlockedReason={adjudicationBlockedReason}
            focusRequest={focusRequest}
          />
        </div>

        <div className="review-inspector-columns__side">
        <section className="app-panel" aria-labelledby="review-assignment-title" style={{ minWidth: 0 }}>
          <div className="app-panel__head">
            <h3 id="review-assignment-title" className="app-panel__title">Assignment &amp; SLA</h3>
          </div>
          <div className="app-panel__body" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <KV k="Assigned to" v={assignee} />
              <KV k="Assigned at" v={formatCellDateTime(p.assignedAtUtc)} />
              <KV k="Priority" v={identifierLabel(p.priority)} />
              {p.slaPausedAtUtc ? (
                <KV k="Paused" v={p.pausedReason?.trim() || "Paused"} />
              ) : null}
            </div>

            <ul data-reviewer-sla-clocks style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
              {p.slaDimensions.map((d) => (
                <li
                  key={d.dimension}
                  style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13, minWidth: 0 }}
                >
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{slaDimensionLabel(d.dimension)}</span>
                  <Badge tone={statusTone(d.state)} subtle>
                    {slaStateLabel(d.state)}
                  </Badge>
                  <span className="app-field-help" style={{ margin: 0 }}>
                    {formatRelativeDeadline(d.dueAtUtc)}
                  </span>
                </li>
              ))}
            </ul>

            {data.openEscalation ? (
              <div className="app-alert app-alert--danger" data-reviewer-open-escalation style={{ fontSize: 13, marginTop: 12, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: 6,
                  }}
                >
                  <strong>Open escalation</strong>
                  <Badge tone={severityTone(data.openEscalation.severity)} subtle>
                    {identifierLabel(data.openEscalation.severity)}
                  </Badge>
                  <span className="app-field-help" style={{ margin: 0 }}>
                    {escalationReasonLabel(data.openEscalation.reason)}
                  </span>
                  <span className="app-field-help" style={{ margin: 0 }}>
                    {formatCellDateTime(data.openEscalation.createdAt)}
                  </span>
                </div>
                <div style={{ overflowWrap: "anywhere" }}>{data.openEscalation.safeSummary}</div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Phase A.1D — review workflow continuity. Surface the related
            artifacts + cross-surface links the reviewer needs without
            leaving the review workspace. Every link routes to a real,
            registered surface; downloads use the same audited endpoints
            ReportsIndex uses. */}
        <section className="app-panel" data-section="reviewer-workflow-continuity" aria-labelledby="review-links-title" style={{ minWidth: 0 }}>
          <div className="app-panel__head">
            <h3 id="review-links-title" className="app-panel__title">Linked evidence</h3>
          </div>
          <div className="app-panel__body" style={{ minWidth: 0 }}>
            <ReviewerCrossSurfaceLinks evidenceId={p.evidenceId} />
          </div>
        </section>
        </div>
      </div>

      {/* Phase B.1-1 — structured reviewer notes. Wired to
          /v1/reviewer-ops/workspace/:workflowId/notes. Notes carry
          one of seven structured types and are audited via
          TeamActivity (REVIEWER_NOTE_CREATED). */}
      <ReviewerNotesPanel
        workflowId={workflowId}
        teamId={teamId}
        refreshKey={panelsVersion}
      />

      {/* Phase D3 — Reviewer Copilot (advisory only; final decision stays human). */}
      <div style={{ marginBottom: 12, minWidth: 0 }}>
        <ReviewerCopilotPanel
          reviewId={workflowId}
          evidence={[
            {
              id: p.evidenceId,
              title: evidenceName,
              // THE PROJECTED REVISION. This was a literal `0`, so the panel
              // asserted a version it had never been told and the route it
              // fed had no guard to check it against.
              analysisRevision: data.analysisRevision ?? undefined,
              status: p.lifecycleState,
            },
          ]}
        />
      </div>

      <CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />

      {/* Phase 2.5 — Keyboard shortcuts help (`?`, ignored while typing). */}
      <ReviewerShortcutsHelp
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        variant="inspector"
      />

      {/* Phase 2.4 — Structured reason dialog (Pause, Record response). A
          refusal stays inside the dialog with the typed reason kept. */}
      <ReviewerReasonModal
        kind={reasonModal}
        open={reasonModal !== null}
        error={dialogError}
        onCancel={() => {
          setReasonModal(null);
          setDialogError(null);
        }}
        onSubmit={async (reason) => {
          if (!reasonModal) return;
          let ok = false;
          if (reasonModal === "PAUSE") {
            ok = await post("pause", { pausedReason: reason }, { inDialog: true });
          } else if (reasonModal === "REOPEN") {
            ok = await postReopen(reason);
          } else if (reasonModal === "RECORD_RESPONSE") {
            ok = await post(
              "record_response",
              reason ? { note: reason } : {},
              { kind: "record_response", inDialog: true },
            );
          }
          // PRO-R2-16 — close only on success; a refusal keeps the dialog,
          // its message and the typed reason for the retry.
          if (ok) {
            setReasonModal(null);
            setDialogError(null);
          }
        }}
      />

      <ReassignDialog
        open={dialog === "reassign" || dialog === "assign_second_reviewer"}
        teamId={teamId}
        handoff={dialog === "assign_second_reviewer"}
        excludeUserId={dialog === "assign_second_reviewer" ? data.handoff?.firstReviewerUserId ?? null : null}
        currentAssigneeUserId={p.assignedToUserId}
        onCancel={() => setDialog(null)}
        onSubmit={(userId) => postReassign(userId, dialog === "assign_second_reviewer")}
        describeError={reassignRefusalMessage}
      />
      <EscalateDialog
        open={dialog === "escalate"}
        onCancel={() => setDialog(null)}
        onSubmit={postEscalate}
        forcesIndependentReview={escalationForcesIndependence}
      />
      <ArchiveDialog open={dialog === "archive"} onCancel={() => setDialog(null)} onSubmit={postArchive} />

      {/* Step-up — dormant until a verdict, escalation or archive meets the
          server's STEP_UP_REQUIRED gate; retries the request exactly once. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

/** TEAM-UI-SPEC (structure) — the inspector returns to the hub's My reviews. */
const INSPECTOR_BACK: ReviewPageHeaderBack = { href: "/review", label: "My reviews" };

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "2px 0",
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <span className="app-field-help" style={{ margin: 0 }}>{k}</span>
      <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{v}</span>
    </div>
  );
}



// ---------------------------------------------------------------------------
// Phase A.1D — Reviewer cross-surface continuity.
//
// Renders a compact strip of links + on-demand downloads inside the
// review workspace so a reviewer can open the evidence, fetch the
// latest report, fetch the verification package, and jump back to the
// reviewer queue without leaving the review.
//
// Every action routes to an EXISTING endpoint or registered route;
// nothing is invented. Downloads use the same gated path the
// evidence-detail page uses (signed URLs, gated on policy, audited
// server-side). Failure messaging is honest: 202 → "still generating",
// 403 → "permission required", etc.
// ---------------------------------------------------------------------------
function ReviewerCrossSurfaceLinks({ evidenceId }: { evidenceId: string }) {
  const [busy, setBusy] = useState<null | "report" | "package">(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (kind: "report" | "package") => {
    if (busy) return;
    // F-P1-04 — the tab opens IN the click, before the await (artifact-window.ts).
    const pending = openPendingArtifactWindow();
    setBusy(kind);
    setError(null);
    try {
      const path =
        kind === "report"
          ? `/v1/evidence/${evidenceId}/report/latest`
          : `/v1/evidence/${evidenceId}/verification-package`;
      const resp = (await apiFetch(path, { method: "GET" })) as {
        url?: string;
        code?: string;
        message?: string;
      };
      if (resp.url) {
        if (pending.assign(resp.url) === "blocked") setError(ARTIFACT_WINDOW_BLOCKED_MESSAGE);
      } else {
        pending.close();
        // RGA-04 — a 2xx with no URL carries a bounded code (e.g. pending).
        setError(
          describeArtifactDownloadFailure(
            kind === "report" ? "report" : "verificationPackage",
            { code: resp.code, statusCode: resp.code ? 202 : 503 },
          ).message,
        );
      }
    } catch (err) {
      pending.close();
      // RGA-04 — the ONE shared download-failure vocabulary.
      setError(
        describeArtifactDownloadFailure(kind === "report" ? "report" : "verificationPackage", err).message,
      );
    } finally {
      setBusy(null);
    }
  };

  const groupStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
    minWidth: 0,
  };
  const groupTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    margin: "0 0 6px",
    color: "var(--app-ink-label, var(--ink-secondary))",
  };

  return (
    <div
      data-reviewer-cross-surface-links
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        gap: 16,
        fontSize: 13,
        minWidth: 0,
      }}
    >
      {/* Evidence: the record under review and its outputs, all secondary
          (TEAM-UI-SPEC §2 — the decision panel holds the page's verdict
          primary). Downloads keep the existing gated endpoints. */}
      <div role="group" aria-labelledby="reviewer-links-evidence" data-reviewer-links-group="evidence" style={{ minWidth: 0 }}>
        <p id="reviewer-links-evidence" style={groupTitle}>Evidence</p>
        <div style={groupStyle}>
          <a
            href={`/evidence/${evidenceId}`}
            data-reviewer-link="open-evidence"
            className="app-secondary-action"
            style={{ textDecoration: "none" }}
          >
            Open evidence detail
          </a>
          <button
            type="button"
            onClick={() => void open("report")}
            disabled={busy !== null}
            aria-busy={busy === "report" || undefined}
            data-reviewer-link="download-report"
            className="app-secondary-action"
          >
            {busy === "report" ? "Opening…" : "Download latest report"}
          </button>
          <button
            type="button"
            onClick={() => void open("package")}
            disabled={busy !== null}
            aria-busy={busy === "package" || undefined}
            data-reviewer-link="download-package"
            className="app-secondary-action"
          >
            {busy === "package" ? "Opening…" : "Download verification package"}
          </button>
        </div>
        {error ? (
          <p
            role="alert"
            data-reviewer-cross-surface-error
            className="app-field-error"
            style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}
          >
            {error}
          </p>
        ) : null}
      </div>
      {/* Go to: other review surfaces. Navigation only, no primary. */}
      <nav aria-labelledby="reviewer-links-goto" data-reviewer-links-group="goto" style={{ minWidth: 0 }}>
        <p id="reviewer-links-goto" style={groupTitle}>Go to</p>
        <div style={groupStyle}>
          <a
            href="/reports"
            data-reviewer-link="open-reports"
            className="app-ghost-action"
            style={{ textDecoration: "none" }}
          >
            Reports queue
          </a>
          <a
            href="/reviewer-ops/escalations"
            data-reviewer-link="open-escalations"
            className="app-ghost-action"
            style={{ textDecoration: "none" }}
          >
            Escalations
          </a>
        </div>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase B.1-1 + B.1-2 — Structured Reviewer Notes panel + Timeline.
//
// Wired to:
//   GET  /v1/reviewer-ops/workspace/:workflowId/notes?teamId=<uuid>
//   POST /v1/reviewer-ops/workspace/:workflowId/notes  body: { teamId, type, body }
//
// Backend stores notes as a v1 JSON envelope inside
// EvidenceReviewerComment.body so we don't need a schema migration.
// Audit emission is workspace-scoped via TeamActivity. RBAC mirrors
// the rest of reviewer-ops (requireReviewerActor on the workflow's
// team).
//
// Note types (operator-readable categories the brief specified):
//   observation, concern, request_info, escalation_context,
//   decision_rationale, legal_hold_context, redaction_context.
//
// Legacy plain-text comments created BEFORE Phase B.1 surface with
// type "general" — the parser tolerates them so we don't blow up on
// pre-existing rows.
// ---------------------------------------------------------------------------

type ReviewerNoteType =
  | "observation"
  | "concern"
  | "request_info"
  | "escalation_context"
  | "decision_rationale"
  | "legal_hold_context"
  | "redaction_context";

const NOTE_TYPE_OPTIONS: ReadonlyArray<{ value: ReviewerNoteType; label: string }> = [
  { value: "observation", label: "Observation" },
  { value: "concern", label: "Concern" },
  { value: "request_info", label: "Request info" },
  { value: "escalation_context", label: "Escalation context" },
  { value: "decision_rationale", label: "Decision rationale" },
  { value: "legal_hold_context", label: "Legal hold context" },
  { value: "redaction_context", label: "Redaction context" },
];

const NOTE_TYPE_LABELS: Record<string, string> = {
  observation: "Observation",
  concern: "Concern",
  request_info: "Request info",
  escalation_context: "Escalation context",
  decision_rationale: "Decision rationale",
  legal_hold_context: "Legal hold context",
  redaction_context: "Redaction context",
  general: "Note",
};

type ReviewerNote = {
  id: string;
  type: string;
  body: string;
  isLegacyPlainText: boolean;
  visibility: string;
  author: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
};

type NotesEnvelope = {
  workflowId: string;
  evidenceId: string;
  summary: { total: number };
  items: ReviewerNote[];
};

function ReviewerNotesPanel({
  workflowId,
  teamId,
  refreshKey = 0,
}: {
  workflowId: string;
  teamId: string;
  /** Bumped by the page after any action, so the notes reread. */
  refreshKey?: number;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: NotesEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });
  const [filterType, setFilterType] = useState<"all" | ReviewerNoteType | "general">(
    "all",
  );
  const [composeType, setComposeType] = useState<ReviewerNoteType>("observation");
  const [composeBody, setComposeBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const formId = useId();

  const load = useCallback(async () => {
    // A refresh keeps the current list on screen instead of flashing to a
    // loading state.
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as NotesEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load notes." }).message;
      setState({ kind: "error", status, message });
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submitNote = useCallback(async () => {
    const trimmed = composeBody.trim();
    if (!trimmed) {
      setComposeError("Body is required.");
      return;
    }
    setSubmitting(true);
    setComposeError(null);
    try {
      await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, type: composeType, body: trimmed }),
        },
      );
      setComposeBody("");
      // Reload so the new note appears with its real audit-emitted state.
      await load();
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      if (isPlanRefusal(err)) {
        // PRO-R2-14 — the plan, not a membership problem.
        setComposeError(PLAN_REFUSAL_COPY);
      } else if (status === 403) {
        setComposeError(
          "Permission denied. Reviewer note creation requires workspace membership.",
        );
      } else if (status === 404) {
        setComposeError("Workflow not found in this workspace.");
      } else if (status === 400) {
        setComposeError(
          "Request rejected — note body must be 1–4000 characters.",
        );
      } else {
        const message =
          toSafeUserError(err, { message: "Could not create note." }).message;
        setComposeError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [composeBody, composeType, workflowId, teamId, load]);

  const visibleNotes =
    state.kind === "ready"
      ? filterType === "all"
        ? state.data.items
        : state.data.items.filter((n) => n.type === filterType)
      : [];

  return (
    <section
      className="app-panel"
      aria-labelledby={`${formId}-title`}
      style={{ marginBottom: 12, minWidth: 0 }}
      data-section="reviewer-notes"
      data-reviewer-notes-total={
        state.kind === "ready" ? state.data.summary.total : 0
      }
    >
      <div className="app-panel__head">
        <h3 id={`${formId}-title`} className="app-panel__title">
          Reviewer notes
          {state.kind === "ready" ? (
            <span className="app-field-help" style={{ margin: "0 0 0 6px", display: "inline" }}>
              · {state.data.summary.total} total
            </span>
          ) : null}
        </h3>
      </div>
      <div className="app-panel__body" style={{ minWidth: 0 }}>
      <p className="app-field-help" style={{ marginTop: 0, marginBottom: 8 }}>
        Structured notes attached to the evidence under this review.
        Every note is recorded in the workspace activity feed. Notes
        persist across reviewers and survive workflow transitions.
      </p>

      {/* ---- compose ---- */}
      <form
        data-reviewer-notes-form
        onSubmit={(e) => {
          e.preventDefault();
          void submitNote();
        }}
        style={{ display: "grid", gap: 6, marginBottom: 10, minWidth: 0 }}
      >
        <label className="app-field-label" htmlFor={`${formId}-type`}>
          Type
        </label>
        <AppListbox
          id={`${formId}-type`}
          value={composeType}
          options={[
            ...NOTE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          ]}
          onChange={(next) => setComposeType(next as ReviewerNoteType)}
          disabled={submitting}
          style={{ maxWidth: "100%" }}
          triggerProps={{ "data-reviewer-notes-compose-type": "" }}
        />
        <label className="app-field-label" htmlFor={`${formId}-body`}>
          Note
        </label>
        <textarea
          id={`${formId}-body`}
          className="app-input app-textarea"
          value={composeBody}
          onChange={(e) => setComposeBody(e.target.value)}
          disabled={submitting}
          maxLength={4000}
          rows={3}
          placeholder="Write a structured reviewer note (1–4000 chars). Every note is audited."
          data-reviewer-notes-compose-body
          style={{ boxSizing: "border-box" }}
        />
        {composeError ? (
          <p role="alert" className="app-field-error" data-reviewer-notes-compose-error style={{ margin: 0 }}>
            {composeError}
          </p>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="app-field-help" style={{ margin: 0 }}>
            {composeBody.length}/4000
          </span>
          {/* As Evidence notes: the filled secondary, never a page primary. */}
          <button
            type="submit"
            disabled={submitting || composeBody.trim().length === 0}
            aria-busy={submitting || undefined}
            data-reviewer-notes-compose-submit
            className="app-secondary-action app-secondary-action--filled"
          >
            {submitting ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>

      {/* ---- filter chips ---- */}
      {state.kind === "ready" && state.data.summary.total > 0 ? (
        <div
          role="group"
          aria-label="Filter notes by type"
          className="app-tabs"
          data-reviewer-notes-filter
          style={{ flexWrap: "wrap", height: "auto", marginBottom: 8, minWidth: 0 }}
        >
          <FilterChip
            label="All"
            active={filterType === "all"}
            onClick={() => setFilterType("all")}
            count={state.data.summary.total}
            dataValue="all"
          />
          {(["observation", "concern", "request_info", "escalation_context", "decision_rationale", "legal_hold_context", "redaction_context"] as ReviewerNoteType[]).map((t) => {
            const c = state.data.items.filter((n) => n.type === t).length;
            if (c === 0) return null;
            return (
              <FilterChip
                key={t}
                label={NOTE_TYPE_LABELS[t]}
                active={filterType === t}
                onClick={() => setFilterType(t)}
                count={c}
                dataValue={t}
              />
            );
          })}
          {state.data.items.some((n) => n.type === "general") ? (
            <FilterChip
              label="Legacy"
              active={filterType === "general"}
              onClick={() => setFilterType("general")}
              count={state.data.items.filter((n) => n.type === "general").length}
              dataValue="general"
            />
          ) : null}
        </div>
      ) : null}

      {/* ---- list ---- */}
      {state.kind === "loading" ? (
        <div data-reviewer-notes-state="loading" className="app-field-help">
          Loading notes…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          role="alert"
          data-reviewer-notes-state="error"
          style={{ fontSize: 13, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
        >
          {/* raw-identifier-ok: state.status here is the HTTP status number of a failed read */}
          {state.status === 403
            ? "You don't have permission to view notes for this workflow."
            : state.status === 404
              ? "Workflow not found in this workspace."
              : "Could not load notes."}
          <button
            type="button"
            onClick={() => void load()}
            data-reviewer-notes-retry
            className="app-secondary-action"
          >
            Retry
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.summary.total === 0 ? (
        <div data-reviewer-notes-state="empty" className="app-field-help" style={{ margin: 0 }}>
          No notes yet. Add the first structured note above to anchor
          this review's context for future reviewers.
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length === 0 && state.data.summary.total > 0 ? (
        <div data-reviewer-notes-state="filter-empty" style={{ fontSize: 13 }}>
          No notes of type{" "}
          <strong>{NOTE_TYPE_LABELS[filterType] ?? filterType}</strong>. {" "}
          <button
            type="button"
            onClick={() => setFilterType("all")}
            className="app-ghost-action"
          >
            Show all
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length > 0 ? (
        <ul
          data-reviewer-notes-items
          data-reviewer-notes-visible-count={visibleNotes.length}
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}
        >
          {visibleNotes.map((n) => {
            return (
              <li
                key={n.id}
                data-reviewer-note-id={n.id}
                data-reviewer-note-type={n.type}
                data-reviewer-note-legacy={n.isLegacyPlainText ? "true" : "false"}
                className="app-inner-surface"
                style={{ padding: "0.55rem 0.7rem", minWidth: 0 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span
                      data-reviewer-note-type-chip={n.type}
                      className={n.type === "concern" || n.type === "escalation_context" || n.type === "legal_hold_context" || n.type === "redaction_context" ? "app-chip app-chip--warn" : "app-chip"}
                    >
                      {NOTE_TYPE_LABELS[n.type] ?? identifierLabel(n.type)}
                    </span>
                    <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      {n.author.displayName || n.author.email || recordReference("Author", n.author.userId)}
                    </span>
                  </div>
                  <time dateTime={n.createdAt} className="app-field-help" style={{ margin: 0 }}>
                    {formatUserDateTime(n.createdAt)}
                  </time>
                </div>
                <div
                  data-reviewer-note-body
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {n.body}
                </div>
                {n.isLegacyPlainText ? (
                  <div data-reviewer-note-legacy-banner className="app-field-help" style={{ marginTop: 4 }}>
                    Legacy plain-text note (pre-Phase-B.1; no structured type).
                  </div>
                ) : null}
                {n.resolvedAt ? (
                  <div data-reviewer-note-resolved className="app-field-help" style={{ marginTop: 4 }}>
                    Resolved {formatUserDateTime(n.resolvedAt)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      </div>
    </section>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  count,
  dataValue,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number;
  dataValue: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-reviewer-notes-filter-chip={dataValue}
      data-reviewer-notes-filter-active={active ? "true" : "false"}
      aria-pressed={active}
      className={active ? "app-tab is-active" : "app-tab"}
    >
      {label} <span className="app-tab__count">{count}</span>
    </button>
  );
}
