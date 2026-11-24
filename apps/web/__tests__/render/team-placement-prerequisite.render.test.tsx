/**
 * Team remediation T-097 / T-098 — the placement prerequisite is VISIBLE.
 *
 *   - the reviewer picker lists a member with `placed: false` as unavailable,
 *     with "Add <name> to a review team first" and the action into the
 *     Collaboration-Team add-member flow; a reviewer without the field (older
 *     API) stays selectable;
 *   - the inspector's Reassign dialog lists the unplaced person disabled, with
 *     the same sentence and the action;
 *   - a claim refused with 422 for placement — the canonical
 *     REVIEW_ASSIGNEE_NOT_PLACED (reason assignee_not_placed) or the legacy
 *     lowercase `assignee_not_placed` — reads "Place them in a team first"
 *     with the action, through the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectReviewWorkflowActions } from "@proovra/shared";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ReviewerPickerModal, type AssignableReviewer } from "../../components/reviewer-experience/ReviewerPickerModal";
import { ReassignDialog } from "../../app/(app)/reviewer-ops/[reviewId]/_components/InspectorDialogs";
import { EvidenceReviewActionsPanel } from "../../app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const PLACED = "11111111-1111-4111-8111-111111111111";
const UNPLACED = "22222222-2222-4222-8222-222222222222";
const LEGACY = "33333333-3333-4333-8333-333333333333";

const REVIEWERS: AssignableReviewer[] = [
  { userId: PLACED, displayName: "Ada Placed", role: "MEMBER", status: "ACTIVE", placed: true, notAssignableReason: null },
  {
    userId: UNPLACED,
    displayName: "Bea Newcomer",
    role: "MEMBER",
    status: "ACTIVE",
    placed: false,
    notAssignableReason: "REVIEW_ASSIGNEE_NOT_PLACED",
  },
  // An API older than the field: read as placed.
  { userId: LEGACY, displayName: "Cy Legacy", role: "ADMIN", status: "ACTIVE" },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("T-097 — the reviewer picker shows the placement prerequisite", () => {
  it("lists an unplaced member disabled, with the sentence and the add-to-team action", () => {
    const onSelect = vi.fn();
    render(
      <ReviewerPickerModal
        state={{ kind: "READY", reviewers: REVIEWERS }}
        onRetry={() => {}}
        onCancel={() => {}}
        onSelect={onSelect}
      />,
    );
    const unplacedSelect = document.querySelector<HTMLButtonElement>(`[data-reviewer-picker-select="${UNPLACED}"]`)!;
    expect(unplacedSelect.disabled).toBe(true);
    fireEvent.click(unplacedSelect);
    expect(onSelect).not.toHaveBeenCalled();

    const row = document.querySelector(`[data-reviewer-picker-row="${UNPLACED}"]`)!;
    expect(row.textContent).toContain("Add Bea Newcomer to a review team first");
    const action = row.querySelector<HTMLAnchorElement>(`[data-reviewer-picker-place-action="${UNPLACED}"]`);
    expect(action?.getAttribute("href")).toBe("/collaboration-teams");

    // Placed and legacy (no field) reviewers stay selectable and say nothing.
    for (const id of [PLACED, LEGACY]) {
      const btn = document.querySelector<HTMLButtonElement>(`[data-reviewer-picker-select="${id}"]`)!;
      expect(btn.disabled).toBe(false);
      expect(document.querySelector(`[data-reviewer-picker-unplaced="${id}"]`)).toBeNull();
    }
    fireEvent.click(document.querySelector(`[data-reviewer-picker-select="${LEGACY}"]`)!);
    expect(onSelect).toHaveBeenCalledWith(LEGACY);
  });
});

describe("T-097 — the inspector Reassign dialog shows the prerequisite", () => {
  it("offers the unplaced person disabled with the sentence, and the add-to-team action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { reviewers: REVIEWERS })),
    );
    render(
      <ReassignDialog
        open
        teamId="team-1"
        handoff={false}
        excludeUserId={null}
        currentAssigneeUserId={null}
        onCancel={() => {}}
        onSubmit={async () => null}
        describeError={() => "failed"}
      />,
    );
    const note = await screen.findByText(/cannot be given work/);
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/collaboration-teams");
    fireEvent.click(document.querySelector("[data-reviewer-reassign-picker]")!);
    const option = await screen.findByRole("option", { name: /Bea Newcomer/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("Add Bea Newcomer to a review team first");
    const placed = screen.getByRole("option", { name: /Ada Placed/ });
    expect(placed.getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("T-098 — a claim refused for placement says so, with the action", () => {
  const ME = "44444444-4444-4444-8444-444444444444";
  function mountPanel() {
    render(
      <ConfirmActionProvider>
        <EvidenceReviewActionsPanel
          evidenceId="ev-1"
          teamId="team-1"
          currentStatus="NOT_STARTED"
          assignedTo={null}
          viewerUserId={ME}
          availableActions={projectReviewWorkflowActions({
            dbStatus: "NOT_STARTED",
            assignedToUserId: null,
            viewerUserId: ME,
            viewerMayReview: true,
            hasWorkspace: true,
            decision: { state: "first_required", firstReviewerUserId: null, resolvedByRequestInfo: false },
          })}
        />
      </ConfirmActionProvider>,
    );
  }

  it.each([
    ["the legacy lowercase code", { error: { code: "assignee_not_placed", message: "Not placed" } }],
    [
      "the canonical code",
      { error: { code: "REVIEW_ASSIGNEE_NOT_PLACED", details: { reason: "assignee_not_placed" } } },
    ],
  ])("%s", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/claim") ? json(422, body) : json(200, {}),
      ),
    );
    mountPanel();
    fireEvent.click(document.querySelector('[data-evidence-review-action="CLAIM"]')!);
    await waitFor(() =>
      expect(document.querySelector('[data-evidence-review-outcome="error"]')).not.toBeNull(),
    );
    const outcome = document.querySelector('[data-evidence-review-outcome="error"]')!;
    expect(outcome.textContent).toContain("Place them in a team first");
    expect(outcome.textContent).toContain("Collaboration Team");
    expect(outcome.querySelector("a")?.getAttribute("href")).toBe("/collaboration-teams");
    expect(outcome.textContent).not.toContain("Please review your input");
  });
});
