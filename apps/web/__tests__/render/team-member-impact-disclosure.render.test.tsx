/**
 * Team remediation T-099 / T-101 — what a role change and a removal do to the
 * work a person holds is said BEFORE it happens, from the server's counts.
 *
 *   - T-099: changing a role reads `role-change-impact?role=<new>` and the
 *     confirmation states the counts ("N reviews will go back to the queue (M
 *     were in progress), K escalations will be unassigned, J case assignments
 *     will end"), or that nothing is released (reviewer → reviewer). The
 *     change is sent only after the confirmation.
 *   - T-101: the removal dialog lists held reviews (and how many were in
 *     progress), held escalations, case assignments and restricted-case
 *     grants, labelled as what they are.
 *
 * Real `apiFetch` over a stubbed `fetch`; the real ConfirmActionProvider.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { WorkspaceMembersPanel } from "../../app/(app)/teams/[id]/components/WorkspaceMembersPanel";
import { MemberRemovalDialog } from "../../app/(app)/teams/[id]/components/MemberRemovalDialog";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Seen = { url: string; method: string };
let seen: Seen[];
let routes: Array<[RegExp, string, () => { status: number; body: unknown }]>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  seen = [];
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      seen.push({ url, method });
      const hit = routes.find(([re, m]) => re.test(url) && m === method);
      const r = hit ? hit[2]() : { status: 404, body: { error: { code: "NOT_FOUND" } } };
      return json(r.status, r.body);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROSTER = [
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userId: "owner", role: "OWNER", status: "ACTIVE", user: { displayName: "Olive Owner" } },
  { id: MEMBER_ID, userId: "dana", role: "MEMBER", status: "ACTIVE", user: { displayName: "Dana Reviewer" } },
];

function mountRoster() {
  routes.push([/\/members\?/, "GET", () => ({ status: 200, body: { members: ROSTER, nextCursor: null, total: 2 } })]);
  render(
    <ConfirmActionProvider>
      <WorkspaceMembersPanel
        teamId={TEAM}
        currentUserId="owner"
        canManageTeam
        viewerRole="OWNER"
        onInvite={() => {}}
        onRemove={() => {}}
        notify={() => {}}
      />
    </ConfirmActionProvider>,
  );
}

async function chooseRole(label: string) {
  const trigger = await screen.findByRole("combobox", { name: "Workspace role for Dana Reviewer" }).catch(() =>
    screen.getByLabelText("Workspace role for Dana Reviewer"),
  );
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

describe("T-099 — the role change states what it releases before it is made", () => {
  it("a demotion below the reviewer floor states the counts, and nothing is sent until confirmed", async () => {
    routes.push([
      /role-change-impact\?role=VIEWER$/,
      "GET",
      () => ({
        status: 200,
        body: {
          member: { memberId: MEMBER_ID, userId: "dana", role: "MEMBER" },
          newRole: "VIEWER",
          impact: {
            releasesHeldWork: true,
            heldReviews: 3,
            heldReviewsInProgress: 1,
            heldEscalations: 2,
            heldWork: { reviewWorkflows: 3, reviewsInProgress: 1, escalations: 2, teamTasks: 0 },
            caseAssignmentsEnded: 4,
          },
        },
      }),
    ]);
    mountRoster();
    await screen.findByText("Dana Reviewer");
    await chooseRole("Viewer");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Change Dana Reviewer to Viewer\?/)).toBeTruthy();
    expect(dialog.textContent).toContain(
      "3 reviews will go back to the queue (1 was in progress), 2 escalations will be unassigned, 4 case assignments will end.",
    );
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
  });

  it("a reviewer-to-reviewer change says nothing is released", async () => {
    routes.push([
      /role-change-impact\?role=ADMIN$/,
      "GET",
      () => ({
        status: 200,
        body: {
          newRole: "ADMIN",
          impact: {
            releasesHeldWork: false,
            heldReviews: 3,
            heldReviewsInProgress: 1,
            heldEscalations: 0,
            heldWork: { reviewWorkflows: 3 },
            caseAssignmentsEnded: 0,
          },
        },
      }),
    ]);
    mountRoster();
    await screen.findByText("Dana Reviewer");
    await chooseRole("Admin");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Nothing they hold is released");
  });
});

describe("T-101 — the removal dialog lists everything the removal releases", () => {
  it("held reviews (with in progress), escalations, case assignments and restricted-case grants", async () => {
    routes.push([
      /removal-impact$/,
      "GET",
      () => ({
        status: 200,
        body: {
          member: { memberId: MEMBER_ID, userId: "dana", role: "MEMBER" },
          impact: {
            ownedEvidence: 0,
            ownedCases: 0,
            openAssignments: 4,
            caseAssignments: 4,
            heldReviews: 2,
            heldReviewsInProgress: 1,
            heldEscalations: 3,
            restrictedCaseGrants: 5,
            heldWork: { reviewWorkflows: 2, reviewsInProgress: 1, escalations: 3 },
            requiresTransfer: false,
          },
          eligibleTransferTargets: [],
        },
      }),
    ]);
    render(
      <MemberRemovalDialog
        open
        teamId={TEAM}
        member={{ memberId: MEMBER_ID, userId: "dana", label: "Dana Reviewer", role: "MEMBER" }}
        onCancel={() => {}}
        onRemoved={() => {}}
      />,
    );
    const reviews = await screen.findByTestId("member-removal-impact-reviews");
    expect(reviews.textContent).toContain("Reviews held");
    expect(reviews.textContent).toContain("2");
    expect(reviews.textContent).toContain("1 in progress");
    expect(screen.getByTestId("member-removal-impact-escalations").textContent).toContain("3");
    const assignments = screen.getByTestId("member-removal-impact-assignments");
    expect(assignments.textContent).toContain("Case assignments");
    expect(assignments.textContent).not.toContain("Open assignments");
    expect(screen.getByTestId("member-removal-impact-grants").textContent).toContain("5");
    expect(document.querySelector("[data-member-removal-release-summary]")?.textContent).toBe(
      "When they are removed, 2 reviews they hold will go back to the queue (1 was in progress), 3 escalations will be unassigned, 4 case assignments will end, their access to 5 restricted cases will end.",
    );
    // The ownership-transfer disclosure stays.
    expect(document.querySelector("[data-member-removal-no-transfer]")).not.toBeNull();
  });

  it("an older API without the new counts still shows case assignments", async () => {
    routes.push([
      /removal-impact$/,
      "GET",
      () => ({
        status: 200,
        body: {
          member: { memberId: MEMBER_ID, userId: "dana", role: "MEMBER" },
          impact: { ownedEvidence: 0, ownedCases: 0, openAssignments: 2, requiresTransfer: false },
          eligibleTransferTargets: [],
        },
      }),
    ]);
    render(
      <MemberRemovalDialog
        open
        teamId={TEAM}
        member={{ memberId: MEMBER_ID, userId: "dana", label: "Dana Reviewer", role: "MEMBER" }}
        onCancel={() => {}}
        onRemoved={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("member-removal-impact-assignments").textContent).toContain("2"));
    expect(screen.queryByTestId("member-removal-impact-reviews")).toBeNull();
  });
});
