"use client";

/**
 * TEAM-SPEC R3 (2026-11-23) — the second-review handoff banner.
 *
 * Driven by the workspace projection's `handoff` block. After a FIRST decision
 * under a second-review requirement the review waits for an assignment
 * manager to reassign it to a different eligible reviewer:
 *
 *   - an assignment manager (the server offers them `reassign`) is told who
 *     recorded the first review and given the reassignment here — the picker
 *     never offers the first reviewer;
 *   - with nobody eligible (`staffing: "no_eligible_reviewer"`) the banner
 *     says a second, independent reviewer is required and cannot be waived,
 *     and links to Members & access when that page opens for the viewer;
 *   - everyone else reads that the review is waiting for an independent
 *     second reviewer.
 *
 * The server still decides every reassignment (independence, eligibility).
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { recordReference } from "../../../../../lib/short-id";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { ReviewDestinationLink } from "../../../../../components/reviewer-experience/ReviewDestinationLink";
import { useReviewDestination } from "../../../../../components/reviewer-experience/reviewDestination";

export type ReviewHandoff = {
  requirement: "second_review" | "adjudication" | null;
  firstReviewerUserId: string | null;
  firstReviewerDisplayName?: string | null;
  secondReviewerUserId?: string | null;
  awaitingAssignment: boolean;
  eligibleReviewerCount: number;
  staffing: "ok" | "no_eligible_reviewer" | "no_eligible_adjudicator";
};

type AssignableReviewer = { userId: string; displayName: string | null };

export const HANDOFF_COPY = {
  managerLead: (name: string) => `First review recorded by ${name}. Assign an independent second reviewer.`,
  noEligibleReviewer:
    "A second, independent reviewer is required. Invite a member with review permission to this workspace (Members & access) — the requirement can't be waived.",
  waiting: "Waiting for an independent second reviewer.",
} as const;

/** The Members & access link, only where that page opens for the viewer. */
function MembersAccessLink() {
  const destination = useReviewDestination("workspace.people", { label: "Open Members & access" });
  if (!destination) return null;
  return <ReviewDestinationLink destination={destination} testId="review-handoff-people-link" />;
}

function SecondReviewerPicker({
  teamId,
  workflowId,
  firstReviewerUserId,
  onReassigned,
  describeError,
}: {
  teamId: string;
  workflowId: string;
  firstReviewerUserId: string | null;
  onReassigned: (message: string) => void;
  describeError: (err: unknown) => string;
}) {
  const [reviewers, setReviewers] = useState<AssignableReviewer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch(`/v1/reviewer-ops/assignable-reviewers?teamId=${encodeURIComponent(teamId)}&limit=200`, { method: "GET" })
      .then((r: { reviewers?: AssignableReviewer[] }) => {
        if (!live) return;
        // The first reviewer can never take the second review.
        setReviewers((r?.reviewers ?? []).filter((x) => x.userId !== firstReviewerUserId));
      })
      .catch((err: unknown) => {
        if (live) setLoadError(describeError(err));
      });
    return () => {
      live = false;
    };
  }, [teamId, firstReviewerUserId, describeError]);

  const submit = useCallback(async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, newAssigneeUserId: choice }),
      });
      onReassigned("Second reviewer assigned.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [choice, teamId, workflowId, onReassigned, describeError]);

  if (loadError) {
    return (
      <p role="alert" className="app-field-help" data-review-handoff-picker-error style={{ margin: 0 }}>
        {loadError}
      </p>
    );
  }
  if (!reviewers) {
    return (
      <p className="app-field-help" style={{ margin: 0 }}>
        Loading reviewers…
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 }}>
      <AppListbox
        value={choice}
        ariaLabel="Second reviewer"
        options={[
          { value: "", label: "Choose a second reviewer…" },
          ...reviewers.map((r) => ({ value: r.userId, label: r.displayName?.trim() || recordReference("Reviewer", r.userId) })),
        ]}
        onChange={(next) => setChoice(next)}
        disabled={busy}
        triggerProps={{ "data-review-handoff-picker": "" }}
      />
      <button
        type="button"
        className="app-primary-action"
        disabled={!choice || busy}
        aria-busy={busy || undefined}
        onClick={() => void submit()}
        data-review-handoff-reassign
      >
        {busy ? "Working…" : "Reassign"}
      </button>
      {error ? (
        <p role="alert" className="app-field-help" data-review-handoff-reassign-error style={{ margin: 0, flexBasis: "100%" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function HandoffBanner({
  handoff,
  mayReassign,
  teamId,
  workflowId,
  onReassigned,
  describeError,
}: {
  handoff: ReviewHandoff | null | undefined;
  /** The server offers this viewer the `reassign` action. */
  mayReassign: boolean;
  teamId: string;
  workflowId: string;
  onReassigned: (message: string) => void;
  describeError: (err: unknown) => string;
}) {
  if (!handoff || handoff.requirement !== "second_review" || !handoff.awaitingAssignment) return null;
  const firstName =
    handoff.firstReviewerDisplayName?.trim() ||
    (handoff.firstReviewerUserId ? recordReference("Reviewer", handoff.firstReviewerUserId) : "another reviewer");
  const noEligible = handoff.staffing === "no_eligible_reviewer";
  const variant = noEligible ? "no_eligible_reviewer" : mayReassign ? "manager" : "waiting";
  return (
    <section
      role="status"
      className={noEligible ? "app-alert app-alert--warn" : "app-alert app-alert--info"}
      data-review-handoff={variant}
      style={{ marginBottom: 12, display: "grid", gap: 8, minWidth: 0 }}
    >
      {variant === "manager" ? (
        <>
          <p style={{ margin: 0, overflowWrap: "anywhere" }} data-review-handoff-message>
            {HANDOFF_COPY.managerLead(firstName)}
          </p>
          <SecondReviewerPicker
            teamId={teamId}
            workflowId={workflowId}
            firstReviewerUserId={handoff.firstReviewerUserId}
            onReassigned={onReassigned}
            describeError={describeError}
          />
        </>
      ) : variant === "no_eligible_reviewer" ? (
        <>
          <p style={{ margin: 0, overflowWrap: "anywhere" }} data-review-handoff-message>
            {HANDOFF_COPY.noEligibleReviewer}
          </p>
          {mayReassign ? <MembersAccessLink /> : null}
        </>
      ) : (
        <p style={{ margin: 0 }} data-review-handoff-message>
          {HANDOFF_COPY.waiting}
        </p>
      )}
    </section>
  );
}
