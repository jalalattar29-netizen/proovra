"use client";

/**
 * The reviewer picker — one canonical dialog for "who should own this".
 *
 * Shared by the /review console (row "Assign") and /review/queues (row
 * "Assign" and bulk assign). Reads the bounded team-scoped projection
 * `GET /v1/reviewer-ops/assignable-reviewers` (gated on `review.assign`); a
 * 403 says so, any other failure offers Retry, and it NEVER falls back to a
 * free-text prompt (Phase RW3-2).
 *
 * TEAM-UI-SPEC §1 — canonical `Modal`; footer = Cancel (secondary); choosing a
 * reviewer is a row action (secondary). The forward step (the confirmation or
 * the assignment itself) belongs to the caller.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import {
  COLLABORATION_TEAMS_HREF,
  PLACEMENT_ACTION_LABEL,
  isPlacedReviewer,
  placementPrerequisiteSentence,
} from "../../lib/members/placement";
import { Modal } from "../cases-experience/matter-modals/Modal";
import { reviewerIdentityLabel } from "../../lib/reviewer-workspace/reviewer-identity";

const REVIEWER_ROLE_WORDS: Readonly<Record<string, string>> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

export type AssignableReviewer = {
  userId: string;
  displayName: string | null;
  /** T-086 (stage D) — projected by the API, already masked. */
  maskedEmail?: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  status: "ACTIVE";
  currentWorkloadCount?: number;
  /**
   * Team remediation T-097 — the placement prerequisite. `false`: this person
   * is not in a Collaboration Team, so the server would refuse the assignment
   * (422 REVIEW_ASSIGNEE_NOT_PLACED). Absent (older API): treated as placed.
   */
  placed?: boolean;
  notAssignableReason?: "REVIEW_ASSIGNEE_NOT_PLACED" | null;
};

export type PickerState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; reviewers: AssignableReviewer[] };

/**
 * Picker state + the guarded fetch. `open()` (re)loads; a response for a
 * workspace the reviewer has since left is discarded.
 */
export function useReviewerPicker(teamId: string | null) {
  const [state, setState] = useState<PickerState | null>(null);
  const activeTeamRef = useRef<string | null>(teamId);
  useEffect(() => {
    activeTeamRef.current = teamId;
  }, [teamId]);

  const open = useCallback(async () => {
    setState({ kind: "LOADING" });
    if (!teamId) {
      setState({ kind: "ERROR", message: "Select a workspace before loading reviewers." });
      return;
    }
    const requestTeamId = teamId;
    try {
      const res = await apiFetch(
        `/v1/reviewer-ops/assignable-reviewers?teamId=${encodeURIComponent(requestTeamId)}&limit=200`,
        { method: "GET" },
      );
      // Stale-context rejection — never offer another tenant's reviewers.
      if (requestTeamId !== activeTeamRef.current) {
        setState(null);
        return;
      }
      const reviewers = Array.isArray(res?.reviewers) ? (res.reviewers as AssignableReviewer[]) : [];
      setState({ kind: "READY", reviewers });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] assignable-reviewers fetch failed", {
        status: (err as { statusCode?: number })?.statusCode ?? 0,
        code: (err as { code?: string })?.code ?? "UNKNOWN",
      });
      const code = (err as { code?: string })?.code;
      const status = (err as { statusCode?: number })?.statusCode;
      if (
        status === 403 ||
        code === "REVIEW_PERMISSION_DENIED" ||
        code === "NOT_PERMITTED" ||
        code === "FORBIDDEN"
      ) {
        setState({
          kind: "FORBIDDEN",
          message: "You do not have permission to assign reviews in this workspace.",
        });
        return;
      }
      setState({
        kind: "ERROR",
        message: "Reviewer list could not be loaded. Try again or refresh the page.",
      });
    }
  }, [teamId]);

  const close = useCallback(() => setState(null), []);
  return useMemo(() => ({ state, open, close }), [state, open, close]);
}

export function ReviewerPickerModal({
  state,
  title = "Assign to reviewer",
  description,
  busy = false,
  onRetry,
  onCancel,
  onSelect,
}: {
  state: PickerState;
  title?: string;
  description?: string;
  /** True while the caller is applying the choice. */
  busy?: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onSelect: (userId: string) => void;
}) {
  const [query, setQuery] = useState<string>("");
  const visibleReviewers = useMemo(() => {
    if (state.kind !== "READY") return [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return state.reviewers;
    return state.reviewers.filter(
      (r) =>
        (r.displayName ? r.displayName.toLowerCase().includes(q) : false) ||
        (r.maskedEmail ? r.maskedEmail.toLowerCase().includes(q) : false) ||
        r.userId.toLowerCase().includes(q),
    );
  }, [state, query]);

  return (
    <Modal
      open
      title={title}
      description={description}
      onClose={onCancel}
      dismissDisabled={busy}
      testid="reviewer-picker-modal"
      footer={
        <button
          type="button"
          className="app-secondary-action"
          data-reviewer-picker-cancel
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      }
    >
      <div
        data-reviewer-picker-modal
        data-reviewer-picker-state={state.kind}
        className="review-panel-stack"
      >
        {state.kind === "LOADING" ? (
          <p data-reviewer-picker-loading className="app-field-help" aria-live="polite">
            Loading reviewer list…
          </p>
        ) : null}

        {state.kind === "FORBIDDEN" ? (
          <div data-reviewer-picker-denied className="app-alert app-alert--danger" role="alert">
            {state.message}
          </div>
        ) : null}

        {state.kind === "ERROR" ? (
          <div data-reviewer-picker-error className="app-alert app-alert--danger" role="alert">
            <span>{state.message}</span>{" "}
            <button
              type="button"
              className="app-secondary-action"
              data-reviewer-picker-retry
              onClick={onRetry}
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.kind === "READY" ? (
          <>
            <div>
              <label className="app-field-label" htmlFor="reviewer-picker-search">
                Search reviewers
              </label>
              <input
                id="reviewer-picker-search"
                type="search"
                className="app-input"
                data-reviewer-picker-search
                placeholder="Search by name or id…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div data-reviewer-picker-list className="app-inner-surface">
              {visibleReviewers.length === 0 ? (
                <p data-reviewer-picker-empty className="app-field-help review-picker__empty">
                  No reviewers match. Reviewers are workspace members with the assign capability.
                </p>
              ) : (
                <ul className="review-tools review-picker__list">
                  {visibleReviewers.map((r) => {
                    const placed = isPlacedReviewer(r);
                    const name = reviewerIdentityLabel(r);
                    return (
                    <li
                      key={r.userId}
                      data-reviewer-picker-row={r.userId}
                      data-reviewer-picker-placed={placed ? "true" : "false"}
                      className="review-tools__row review-picker__row"
                    >
                      <span className="app-table__identity">
                        <span className="app-table__primary">{name}</span>
                        <span className="app-table__muted">
                          {REVIEWER_ROLE_WORDS[r.role] ?? "Member"}
                          {typeof r.currentWorkloadCount === "number" ? (
                            <span data-reviewer-picker-workload={r.userId}>
                              {" "}
                              · {r.currentWorkloadCount} active
                            </span>
                          ) : null}
                        </span>
                        {placed ? null : (
                          <span
                            className="app-field-help"
                            id={`reviewer-picker-unplaced-${r.userId}`}
                            data-reviewer-picker-unplaced={r.userId}
                          >
                            {placementPrerequisiteSentence(name)}.{" "}
                            <a href={COLLABORATION_TEAMS_HREF} data-reviewer-picker-place-action={r.userId}>
                              {PLACEMENT_ACTION_LABEL}
                            </a>
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="app-secondary-action"
                        data-reviewer-picker-select={r.userId}
                        disabled={busy || !placed}
                        aria-describedby={placed ? undefined : `reviewer-picker-unplaced-${r.userId}`}
                        onClick={() => {
                          if (placed) onSelect(r.userId);
                        }}
                      >
                        Select
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export default ReviewerPickerModal;
