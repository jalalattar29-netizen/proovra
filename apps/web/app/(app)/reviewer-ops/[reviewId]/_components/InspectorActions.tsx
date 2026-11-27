"use client";

/**
 * TEAM-UI-SPEC §2 — the "Next step" panel of the review inspector.
 *
 * Replaces "What you can do now" and the eight-button action grid:
 *
 *   - ONE contextual primary: Start review · Record response · Assign an
 *     independent second reviewer (handoff, managers) · Go to adjudication ·
 *     Go to decision (an anchor that focuses the "Record decision" panel);
 *   - secondary actions only where the server allows them: Pause / Resume
 *     (one slot), Reassign, Escalate (envelope capability REVIEW_ESCALATE);
 *   - Archive inside a "More actions" overflow menu, as a danger item that
 *     opens a confirm (stage D, T-075: the decision is the primary, Pause and
 *     Reassign are secondary, Archive is never a peer button);
 *   - the main blocked reason as ONE muted line under the title.
 *
 * There is no Approve / Reject / Request information control here: a verdict
 * is entered only in the decision panel.
 *
 * TEAM-UI-SPEC (structure) — the panel is a FULL-WIDTH strip directly under
 * the page header, laid out like Evidence Detail's "What needs attention":
 * one row with the title (and the muted blocked reason) on the start side and
 * the primary + secondary actions inline after it, wrapping on narrow
 * screens. `data-reviewer-next-step-layout="strip"` pins the layout.
 */

import { MoreHorizontal } from "lucide-react";

import { AppRowMenu } from "../../../../../components/app-primitives/AppRowMenu";
import {
  ACTION_LABELS,
  mainBlockedReason,
  type ActionMap,
  type NextStepPrimary,
  type ViewerActionName,
} from "./inspector-model";

export type NextStepHandlers = {
  start: () => void;
  record_response: () => void;
  pause: () => void;
  resume: () => void;
  reassign: () => void;
  assign_second_reviewer: () => void;
  escalate: () => void;
  archive: () => void;
  /** T-009 — reopen a finished review (same transition as the Evidence page). */
  reopen?: () => void;
  /** 2026-11-27 — explicitly require an independent second decision. */
  request_independent_review?: () => void;
  /** Focus the decision panel (Go to decision / Go to adjudication). */
  go_to_decision: () => void;
};

const PRIMARY_LABEL: Record<Exclude<NextStepPrimary, null>, string> = {
  start: "Start review",
  record_response: "Record response",
  assign_second_reviewer: "Assign an independent second reviewer",
  adjudicate: "Go to adjudication",
  decide: "Go to decision",
};

export const DECISION_ANCHOR_ID = "review-decision";

export function InspectorActions({
  actions,
  primary,
  handlers,
  busy,
  paused,
  fromViewer,
  canEscalate,
  canArchive,
}: {
  actions: ActionMap;
  primary: NextStepPrimary;
  handlers: NextStepHandlers;
  /** The action in flight, if any. */
  busy: ViewerActionName | null;
  paused: boolean;
  /** Whether the map came from the server's `viewer` block. */
  fromViewer: boolean;
  /** The envelope grants REVIEW_ESCALATE. */
  canEscalate: boolean;
  /**
   * Archive closes through the review-ops bulk door, which requires bulk
   * authority (OWNER/ADMIN, the envelope's BULK_ACTIONS). Offered only then, so
   * a Member is never shown a control the server refuses.
   */
  canArchive: boolean;
}) {
  const blocked = mainBlockedReason(actions);
  // Pause and Resume are one slot: show the one that applies, only if allowed.
  const pauseSlot: "pause" | "resume" | null = actions.resume.allowed
    ? "resume"
    : actions.pause.allowed && !paused
      ? "pause"
      : null;
  const showReassign = actions.reassign.allowed && primary !== "assign_second_reviewer";
  const showArchive = actions.archive.allowed && canArchive;
  // T-019 — Escalate is offered where the SERVER says this viewer may raise
  // one (an older API without the action falls back to the envelope).
  const showEscalate = fromViewer ? actions.escalate.allowed : canEscalate;
  // T-009 — Reopen on the Review page.
  const showReopen = actions.reopen.allowed && !!handlers.reopen;
  // 2026-11-27 — only where the server allows it (viewer.actions).
  const showRequestIndependent =
    fromViewer && actions.request_independent_review.allowed && !!handlers.request_independent_review;
  const anything =
    primary !== null ||
    pauseSlot !== null ||
    showReassign ||
    showEscalate ||
    showArchive ||
    showReopen ||
    showRequestIndependent;
  const disabled = busy !== null;

  return (
    <section
      className="app-panel review-next-step"
      aria-labelledby="review-next-step-title"
      data-reviewer-actions
      data-reviewer-actions-source={fromViewer ? "viewer" : "lifecycle"}
      data-reviewer-next-step={primary ?? "none"}
      data-reviewer-next-step-layout="strip"
    >
      <div className="review-next-step__lead">
        <h2 id="review-next-step-title" className="app-panel__title review-next-step__title">
          Next step
        </h2>
        {primary === null && blocked ? (
          <p className="app-field-help review-next-step__note" data-reviewer-main-blocked-reason>
            {blocked}
          </p>
        ) : null}
        {!anything ? (
          <p data-reviewer-allowed-actions-empty className="app-field-help review-next-step__note">
            There is nothing for you to do on this review right now.
          </p>
        ) : null}
      </div>

      <div className="review-next-step__actions">
        {primary !== null ? (
          <div data-reviewer-next-step-primary className="review-next-step__group">
            {primary === "decide" || primary === "adjudicate" ? (
              <a
                href={`#${DECISION_ANCHOR_ID}`}
                className="app-primary-action"
                data-reviewer-action="go_to_decision"
                onClick={(e) => {
                  e.preventDefault();
                  handlers.go_to_decision();
                }}
                style={{ textDecoration: "none", maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 36 }}
              >
                {PRIMARY_LABEL[primary]}
              </a>
            ) : (
              <button
                type="button"
                className="app-primary-action"
                disabled={disabled}
                aria-busy={busy === primary || undefined}
                onClick={() => handlers[primary]()}
                data-reviewer-action={primary === "assign_second_reviewer" ? "reassign" : primary}
                data-reviewer-action-allowed="true"
                {...(primary === "assign_second_reviewer" ? { "data-reviewer-handoff-assign": "" } : {})}
                style={{ maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 36 }}
              >
                {busy === primary ? "Working…" : PRIMARY_LABEL[primary]}
              </button>
            )}
          </div>
        ) : null}

        {pauseSlot !== null || showReassign || showEscalate || showReopen || showRequestIndependent ? (
          <div data-reviewer-next-step-secondary className="review-next-step__group">
            {pauseSlot ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={disabled}
                aria-busy={busy === pauseSlot || undefined}
                onClick={() => handlers[pauseSlot]()}
                data-reviewer-action={pauseSlot}
                data-reviewer-action-allowed="true"
                {...(pauseSlot === "pause" ? { "data-reviewer-action-pause": "" } : { "data-reviewer-action-resume": "" })}
              >
                {busy === pauseSlot ? "Working…" : ACTION_LABELS[pauseSlot]}
              </button>
            ) : null}
            {showReassign ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={disabled}
                onClick={handlers.reassign}
                data-reviewer-action="reassign"
                data-reviewer-action-allowed="true"
              >
                Reassign
              </button>
            ) : null}
            {showReopen ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={disabled}
                aria-busy={busy === "reopen" || undefined}
                onClick={handlers.reopen}
                data-reviewer-action="reopen"
                data-reviewer-action-allowed="true"
              >
                {busy === "reopen" ? "Working…" : ACTION_LABELS.reopen}
              </button>
            ) : null}
            {showEscalate ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={disabled}
                onClick={handlers.escalate}
                data-reviewer-action="escalate"
                data-reviewer-action-allowed="true"
              >
                Escalate
              </button>
            ) : null}
            {showRequestIndependent ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={disabled}
                onClick={handlers.request_independent_review}
                data-reviewer-action="request_independent_review"
                data-reviewer-action-allowed="true"
              >
                {ACTION_LABELS.request_independent_review}
              </button>
            ) : null}

          </div>
        ) : null}

        {showArchive ? (
          <div data-reviewer-next-step-overflow className="review-next-step__group">
            <AppRowMenu
              label="More actions for this review"
              dataPrefix="reviewer-overflow"
              triggerLabel="More"
              icon={<MoreHorizontal size={16} aria-hidden="true" />}
              actions={[
                {
                  key: "archive",
                  label: "Archive review…",
                  danger: true,
                  disabled: disabled,
                  onSelect: handlers.archive,
                },
              ]}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
