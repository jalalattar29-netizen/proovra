/**
 * TEAM-SPEC R3 (2026-11-23) — the second-review handoff on the web.
 *
 *   - inspector banner variants from the workspace `handoff` block: assignment
 *     manager (reassign here, first reviewer never offered), no eligible
 *     reviewer (cannot be waived; Members & access link only where it opens),
 *     everyone else ("waiting");
 *   - the product-facing "Reviewer collaboration scope" roadmap panel is gone;
 *   - /review/queues offers "Awaiting second reviewer" / "Awaiting adjudication".
 *
 * Real `apiFetch` over a stubbed network.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { chooseListbox, listboxLabels, listboxValues } from "./_listbox";

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";
const FIRST = "f1111111-1111-4111-8111-111111111111";
const OTHER = "a2222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  peopleDestination: null as null | { kind: "link"; routeId: string; href: string; label: string },
  replace: vi.fn(),
}));

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => "44444444-4444-4444-8444-444444444444",
  useTeamId: () => "44444444-4444-4444-8444-444444444444",
  useCan: () => true,
  useActiveSpace: () => ({ type: "PERSONAL", roleLabel: "OWNER" }),
  usePlanFeatureGate: () => true,
  usePlatformContext: () => ({ envelope: null, switchWorkspace: async () => true }),
  useWorkspaceFragment: () => null,
  usePersonalSpaceFragment: () => null,
}));
vi.mock("../../components/reviewer-experience/reviewDestination", () => ({
  useReviewDestination: (routeId: string) => (routeId === "workspace.people" ? mocks.peopleDestination : null),
  useReviewDestinationResolver: () => () => null,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/presence/CollisionWarning", () => ({ CollisionWarning: () => null }));
vi.mock("../../components/ai-copilot/ReviewerCopilotPanel", () => ({ ReviewerCopilotPanel: () => null }));
vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({ CodingSchemaBindingPanel: () => null }));
vi.mock("../../app/(app)/review/queues/_evidence-request-queue", () => ({ EvidenceRequestReviewQueue: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: mocks.replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/22222222-2222-4222-8222-222222222222",
  useParams: () => ({ reviewId: "22222222-2222-4222-8222-222222222222" }),
}));

import ReviewWorkspacePage from "../../app/(app)/reviewer-ops/[reviewId]/page";
import QueuesPage from "../../app/(app)/review/queues/page";
import { HANDOFF_COPY } from "../../app/(app)/reviewer-ops/[reviewId]/_components/HandoffBanner";

const ALL = ["start", "pause", "resume", "request_info", "record_response", "approve", "reject", "reassign", "adjudicate", "archive"];

function viewer(allowed: string[], isAssignee = false) {
  return {
    userId: "u-1",
    isAssignee,
    actions: ALL.map((a) => (allowed.includes(a) ? { action: a, allowed: true } : { action: a, allowed: false, reason: "not_assignee" })),
  };
}

type Handoff = Record<string, unknown>;
const secondReviewHandoff = (over: Handoff = {}): Handoff => ({
  requirement: "second_review",
  firstReviewerUserId: FIRST,
  firstReviewerDisplayName: "Dana First",
  secondReviewerUserId: null,
  awaitingAssignment: true,
  eligibleReviewerCount: 2,
  staffing: "ok",
  ...over,
});

let workspace: Record<string, unknown>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function workspaceBody(handoff: Handoff | undefined, v: unknown) {
  return {
    projection: {
      workflowId,
      evidenceId,
      lifecycleState: "IN_REVIEW",
      assignedToUserId: FIRST,
      assignedAtUtc: "2026-11-20T10:00:00.000Z",
      priority: "NORMAL",
      slaPausedAtUtc: null,
      pausedReason: null,
      slaRollupState: "HEALTHY",
      slaDimensions: [],
    },
    openEscalation: null,
    allowedLifecycleTransitions: [],
    viewer: v,
    ...(handoff ? { handoff } : {}),
  };
}

const wsPath = `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`;
const reassignPath = `/v1/reviewer-ops/reviews/${workflowId}/reassign`;

beforeEach(() => {
  workspace = workspaceBody(secondReviewHandoff(), viewer(["reassign"]));
  mocks.peopleDestination = null;
  mocks.replace.mockReset();
  calls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && path === wsPath) return json(200, workspace);
    if (method === "GET" && path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return json(200, {
        reviewers: [
          { userId: FIRST, displayName: "Dana First", role: "MEMBER", status: "ACTIVE" },
          { userId: OTHER, displayName: "Sam Second", role: "MEMBER", status: "ACTIVE" },
        ],
      });
    }
    if (method === "GET" && path.includes("/decisions?")) {
      return json(200, {
        workflowId,
        evidenceId,
        state: "second_required",
        secondReviewRequirement: { required: true, reason: "legal_hold_active" },
        callerContext: { userId: "u-1", teamRole: "OWNER", isAdjudicator: true, callerIsFirstReviewer: false, nextAction: "blocked_second_needs_reassignment" },
        decisions: [],
      });
    }
    if (method === "GET" && path.includes("/notes?")) return json(200, { workflowId, evidenceId, summary: { total: 0 }, items: [] });
    if (method === "GET" && path.startsWith("/v1/reviewer-ops/queue-intelligence")) return json(200, { projections: [], degradations: [] });
    if (method === "GET" && path.startsWith("/v1/reviewer-ops/queue")) return json(200, { rows: [], nextCursor: null });
    if (method === "GET" && path.includes("qc/pending-count")) return json(200, { pendingCount: 0 });
    if (method === "POST" && path === reassignPath) return json(200, { projection: {} });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderInspector() {
  render(<ReviewWorkspacePage />);
  await screen.findByRole("heading", { name: "What you can do now" });
}
const banner = () => document.querySelector("[data-review-handoff]");

describe("inspector handoff banner", () => {
  it("an assignment manager is told who recorded the first review and reassigns here — never to the first reviewer", async () => {
    await renderInspector();
    await waitFor(() => expect(banner()?.getAttribute("data-review-handoff")).toBe("manager"));
    expect(banner()?.textContent).toContain(HANDOFF_COPY.managerLead("Dana First"));
    expect(HANDOFF_COPY.managerLead("Dana First")).toBe(
      "First review recorded by Dana First. Assign an independent second reviewer.",
    );
    const picker = await waitFor(() => {
      const el = document.querySelector("[data-review-handoff-picker]");
      if (!el) throw new Error("picker not ready");
      return el;
    });
    expect(listboxValues(picker)).toEqual(["", OTHER]);
    expect(listboxLabels(picker)).not.toContain("Dana First");
    chooseListbox(picker, OTHER);
    fireEvent.click(document.querySelector("[data-review-handoff-reassign]") as HTMLButtonElement);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === reassignPath)).toBe(true));
    expect(calls.find((c) => c.path === reassignPath)?.body).toEqual({ teamId, newAssigneeUserId: OTHER });
    await screen.findByText("Second reviewer assigned.");
  });

  it("with no eligible reviewer the requirement is stated as unwaivable, with Members & access where it opens", async () => {
    workspace = workspaceBody(secondReviewHandoff({ staffing: "no_eligible_reviewer", eligibleReviewerCount: 0 }), viewer(["reassign"]));
    mocks.peopleDestination = { kind: "link", routeId: "workspace.people", href: "/people", label: "Open Members & access" };
    await renderInspector();
    await waitFor(() => expect(banner()?.getAttribute("data-review-handoff")).toBe("no_eligible_reviewer"));
    expect(banner()?.textContent).toContain(
      "A second, independent reviewer is required. Invite a member with review permission to this workspace (Members & access) — the requirement can't be waived.",
    );
    const link = document.querySelector('[data-testid="review-handoff-people-link"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/people");
    expect(document.querySelector("[data-review-handoff-picker]")).toBeNull();
  });

  it("no Members & access link where that page would not open", async () => {
    workspace = workspaceBody(secondReviewHandoff({ staffing: "no_eligible_reviewer", eligibleReviewerCount: 0 }), viewer(["reassign"]));
    await renderInspector();
    await waitFor(() => expect(banner()?.getAttribute("data-review-handoff")).toBe("no_eligible_reviewer"));
    expect(document.querySelector('[data-testid="review-handoff-people-link"]')).toBeNull();
  });

  it("anyone who cannot reassign reads that the review is waiting", async () => {
    workspace = workspaceBody(secondReviewHandoff(), viewer([], true));
    await renderInspector();
    await waitFor(() => expect(banner()?.getAttribute("data-review-handoff")).toBe("waiting"));
    expect(banner()?.textContent).toBe("Waiting for an independent second reviewer.");
    expect(calls.some((c) => c.path.startsWith("/v1/reviewer-ops/assignable-reviewers"))).toBe(false);
  });

  it("no banner once the second reviewer holds the review, or when nothing is required", async () => {
    workspace = workspaceBody(secondReviewHandoff({ awaitingAssignment: false }), viewer(["reassign"]));
    await renderInspector();
    expect(banner()).toBeNull();
    cleanup();
    workspace = workspaceBody({ requirement: null, firstReviewerUserId: null, awaitingAssignment: false, eligibleReviewerCount: 0, staffing: "ok" }, viewer(["reassign"]));
    await renderInspector();
    expect(banner()).toBeNull();
  });

  it("the roadmap panel (Reviewer collaboration scope / DEFERRED) is gone", async () => {
    await renderInspector();
    expect(screen.queryByText("Reviewer collaboration scope")).toBeNull();
    expect(document.querySelector('[data-section="reviewer-deferred-features"]')).toBeNull();
    expect(document.querySelector("[data-reviewer-deferred-block]")).toBeNull();
  });
});

describe("/review/queues handoff queue options", () => {
  it("offers Awaiting second reviewer and Awaiting adjudication and loads the slice", async () => {
    render(<QueuesPage />);
    const trigger = await waitFor(() => {
      const el = document.querySelector("[data-reviewer-queue-filter]");
      if (!el) throw new Error("filter not ready");
      return el;
    });
    const values = listboxValues(trigger);
    expect(values).toContain("AWAITING_SECOND_REVIEW");
    expect(values).toContain("AWAITING_ADJUDICATION");
    const labels = listboxLabels(trigger);
    expect(labels).toContain("Awaiting second reviewer");
    expect(labels).toContain("Awaiting adjudication");
    chooseListbox(trigger, "AWAITING_SECOND_REVIEW");
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes("/v1/reviewer-ops/queue?") && c.path.includes("queue=AWAITING_SECOND_REVIEW"))).toBe(true),
    );
    expect(mocks.replace).toHaveBeenCalledWith("/review/queues?queue=AWAITING_SECOND_REVIEW", { scroll: false });
    await screen.findByText("No reviews are waiting for an independent second reviewer.");
  });
});
