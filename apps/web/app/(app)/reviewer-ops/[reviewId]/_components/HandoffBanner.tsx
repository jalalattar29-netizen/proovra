"use client";

/**
 * TEAM-SPEC R3 (2026-11-23) — the second-review handoff banner.
 *
 * Driven by the workspace projection's `handoff` block. After a FIRST decision
 * under a second-review requirement the review waits for an assignment
 * manager to reassign it to a different eligible reviewer:
 *
 *   - an assignment manager (the server offers them `reassign`) is told who
 *     recorded the first review; the assignment itself is the "Next step"
 *     panel's ONE primary ("Assign an independent second reviewer"), whose
 *     dialog never offers the first reviewer (TEAM-UI-SPEC §2 — no second
 *     inline picker competing with it);
 *   - with nobody eligible (`staffing: "no_eligible_reviewer"`) the banner
 *     says a second, independent reviewer is required and cannot be waived,
 *     and links to Members & access when that page opens for the viewer;
 *   - everyone else reads that the review is waiting for an independent
 *     second reviewer.
 *
 * The server still decides every reassignment (independence, eligibility).
 */

import { reviewerIdentityLabel, UNNAMED_REVIEWER } from "../../../../../lib/reviewer-workspace/reviewer-identity";
import { ReviewDestinationLink } from "../../../../../components/reviewer-experience/ReviewDestinationLink";
import { useReviewDestination } from "../../../../../components/reviewer-experience/reviewDestination";

export type ReviewHandoff = {
  requirement: "second_review" | "adjudication" | null;
  firstReviewerUserId: string | null;
  firstReviewerDisplayName?: string | null;
  /** T-086 / E2E-08 — masked e-mail ("j***@example.com"), from the API. */
  firstReviewerMaskedEmail?: string | null;
  secondReviewerUserId?: string | null;
  awaitingAssignment: boolean;
  eligibleReviewerCount: number;
  staffing: "ok" | "no_eligible_reviewer" | "no_eligible_adjudicator";
};

export const HANDOFF_COPY = {
  managerLead: (name: string) => `First review recorded by ${name}. Assign an independent second reviewer.`,
  noEligibleReviewer:
    "A second, independent reviewer is required. Invite a member with review permission to this workspace (Members & access) — the requirement can't be waived.",
  waiting: "Waiting for an independent second reviewer.",
} as const;

/** The Members & access link, only where that page opens for the viewer. */
export function MembersAccessLink({ testId = "review-handoff-people-link" }: { testId?: string } = {}) {
  const destination = useReviewDestination("workspace.people", { label: "Open Members & access" });
  if (!destination) return null;
  return <ReviewDestinationLink destination={destination} testId={testId} className="app-ghost-action" />;
}

/** True when the banner's manager variant applies (the Next step primary assigns). */
export function handoffAwaitsManager(handoff: ReviewHandoff | null | undefined, mayReassign: boolean): boolean {
  return Boolean(
    handoff &&
      handoff.requirement === "second_review" &&
      handoff.awaitingAssignment &&
      handoff.staffing !== "no_eligible_reviewer" &&
      mayReassign,
  );
}

export function HandoffBanner({
  handoff,
  mayReassign,
}: {
  handoff: ReviewHandoff | null | undefined;
  /** The server offers this viewer the `reassign` action. */
  mayReassign: boolean;
}) {
  if (!handoff || handoff.requirement !== "second_review" || !handoff.awaitingAssignment) return null;
  // T-086 / E2E-08 — the one way Review names a person (display name, else the
  // masked e-mail); never an id reference such as "Reviewer ref 2C82A9".
  const named = handoff.firstReviewerUserId
    ? reviewerIdentityLabel({
        displayName: handoff.firstReviewerDisplayName ?? null,
        maskedEmail: handoff.firstReviewerMaskedEmail ?? null,
      })
    : UNNAMED_REVIEWER;
  const firstName = named === UNNAMED_REVIEWER ? "another reviewer" : named;
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
        <p style={{ margin: 0, overflowWrap: "anywhere" }} data-review-handoff-message>
          {HANDOFF_COPY.managerLead(firstName)}
        </p>
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
