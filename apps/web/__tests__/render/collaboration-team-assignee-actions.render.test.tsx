/**
 * CT-07 — THE ASSIGNEE WORKS THEIR OWN TASK ON WEB, AS THE SERVER ALLOWS.
 *
 * The server (collaboration-team.service.ts `updateAssignment`) lets the
 * assignee of a task start it, put it back and complete it whatever their
 * group role, while moving SOMEBODY ELSE's task is a supervisory act
 * (`team.assignment.reassign`). The Work tab rendered Start and Complete only
 * when the viewer could CREATE tasks (LEAD/ADMIN), so a MEMBER — the normal
 * holder of a task — had no control for their own work.
 *
 * This mounts the REAL team detail page on its Work tab against server
 * responses and drives the controls a person sees.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const TEAM_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const VIEWER_ID = "c1000000-0000-4000-8000-0000000000a1";
const COLLEAGUE_ID = "c1000000-0000-4000-8000-0000000000b1";
const OWN_OPEN = "a0000000-0000-4000-8000-000000000001";
const OWN_IN_PROGRESS = "a0000000-0000-4000-8000-000000000002";
const COLLEAGUES = "a0000000-0000-4000-8000-000000000003";

const H = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  }
  return {
    FakeApiError,
    requestLog: [] as Array<{ path: string; method: string; body: unknown }>,
    viewerRole: "MEMBER" as "LEAD" | "MEMBER",
  };
});

const ISO = "2026-09-01T00:00:00.000Z";

function member(userId: string, role: string, name: string) {
  return {
    id: `m-${userId.slice(-2)}`,
    userId,
    role,
    status: "ACTIVE",
    joinedAt: ISO,
    suspendedAt: null,
    removedAt: null,
    user: { id: userId, email: `${name.toLowerCase()}@meridian.test`, displayName: name, firstName: null, lastName: null, avatarUrl: null },
  };
}

function teamDetail() {
  return {
    id: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    name: "Meridian Incident Response",
    description: null,
    teamType: "INVESTIGATION",
    status: "ACTIVE",
    createdAt: ISO,
    updatedAt: ISO,
    archivedAtUtc: null,
    viewerRole: H.viewerRole,
    activeMemberCount: 2,
    pendingInviteCount: 0,
    memberPreviewLimit: 25,
    members: [member(VIEWER_ID, H.viewerRole, "Talal"), member(COLLEAGUE_ID, "MEMBER", "Bilal")],
    invites: [],
    assignmentCount: 3,
  };
}

function task(id: string, assigneeUserId: string, status: "OPEN" | "IN_PROGRESS") {
  return {
    id,
    targetType: "CASE",
    targetId: `c0000000-0000-4000-8000-0000000000${id.slice(-2)}`,
    target: { resolved: true, label: `Case ${id.slice(-1)}`, sublabel: null, state: "OPEN", review: null },
    assigneeUserId,
    assignedByUserId: "u-lead",
    status,
    priority: "NORMAL",
    dueAtUtc: null,
    overdue: false,
    note: null,
    createdAt: ISO,
    updatedAt: ISO,
    completedAtUtc: null,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    H.requestLog.push({ path, method, body });
    if (path.includes("/assignments/") && method === "PATCH") return { ok: true };
    if (path.includes("/assignments")) {
      return {
        assignments: [
          task(OWN_OPEN, VIEWER_ID, "OPEN"),
          task(OWN_IN_PROGRESS, VIEWER_ID, "IN_PROGRESS"),
          task(COLLEAGUES, COLLEAGUE_ID, "OPEN"),
        ],
        nextCursor: null,
        total: 3,
      };
    }
    if (path.endsWith("/entitlement")) {
      return { plan: "TEAM", mutationsAllowed: true, collaborationTeams: { limit: 10, used: 1 }, collaborationTeamMembers: { limit: 10, used: 2 } };
    }
    if (path.includes("/disposability")) return { disposition: { disposable: false, blockers: ["ACTIVITY"] } };
    if (path.includes("/activity")) return { items: [], nextCursor: null };
    if (path.includes("/overview")) return { workload: [], health: [] };
    return { team: teamDetail(), viaWorkspaceGovernance: false };
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: H.FakeApiError,
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams("tab=work"),
  usePathname: () => `/collaboration-teams/${TEAM_ID}`,
  useParams: () => ({ teamId: TEAM_ID }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import TeamDetailPage from "../../app/(app)/collaboration-teams/[teamId]/page";

function envelope(): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "ct-07" },
    user: { id: VIEWER_ID, email: "talal@meridian.test", displayName: "Talal" },
    workspace: { id: WORKSPACE_ID, name: "Meridian Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: { type: "ORGANIZATION", id: WORKSPACE_ID, displayName: "Meridian Legal", roleLabel: "Member" },
    personalSpace: { id: "p-1", displayName: "Personal", available: true },
    plan: { tier: "TEAM", features: {} },
    // TEAM sells Team tasks; Create assignment is offered only where it is.
    planFeatures: { teamCollaborationIncluded: true, reviewQueuesIncluded: true, reviewerOperationsIncluded: true },
  };
}

async function mountWorkTab() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PlatformContextProvider testEnvelope={envelope() as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <TeamDetailPage />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
  });
  await waitFor(() => expect(view.queryByTestId(`assignment-edit-${OWN_OPEN}`) ?? view.queryByText("Case 1")).not.toBeNull());
  return view;
}

beforeEach(() => {
  H.requestLog.length = 0;
  H.viewerRole = "MEMBER";
});

afterEach(() => {
  cleanup();
});

describe("CT-07 — the assignee can Start and Complete their own task", () => {
  // MEMBER is the group role that holds work without supervising it (LEAD and
  // ADMIN also supervise; VIEWER cannot hold a task).
  for (const role of ["MEMBER"] as const) {
    it(`a ${role} sees Start and Complete on their own tasks only, and Complete sends the status`, async () => {
      H.viewerRole = role;
      const view = await mountWorkTab();
      expect(view.getByTestId(`assignment-start-${OWN_OPEN}`)).toBeTruthy();
      expect(view.getByTestId(`assignment-complete-${OWN_OPEN}`)).toBeTruthy();
      expect(view.getByTestId(`assignment-complete-${OWN_IN_PROGRESS}`)).toBeTruthy();
      // A colleague's task is not theirs to move, and nothing supervisory shows.
      expect(view.queryByTestId(`assignment-start-${COLLEAGUES}`)).toBeNull();
      expect(view.queryByTestId(`assignment-complete-${COLLEAGUES}`)).toBeNull();
      expect(view.queryByTestId(`assignment-edit-${OWN_OPEN}`)).toBeNull();
      expect(view.queryByTestId(`assignment-remove-${OWN_OPEN}`)).toBeNull();

      await act(async () => {
        fireEvent.click(view.getByTestId(`assignment-complete-${OWN_IN_PROGRESS}`));
      });
      await waitFor(() =>
        expect(
          H.requestLog.find((r) => r.method === "PATCH" && r.path.endsWith(`/assignments/${OWN_IN_PROGRESS}`)),
        ).toMatchObject({ body: { status: "COMPLETED" } }),
      );
    });
  }

  it("a LEAD (who may supervise) sees Start and Complete on everyone's tasks, with Edit", async () => {
    H.viewerRole = "LEAD";
    const view = await mountWorkTab();
    expect(view.getByTestId(`assignment-start-${COLLEAGUES}`)).toBeTruthy();
    expect(view.getByTestId(`assignment-complete-${COLLEAGUES}`)).toBeTruthy();
    expect(view.getByTestId(`assignment-edit-${COLLEAGUES}`)).toBeTruthy();
  });
});
