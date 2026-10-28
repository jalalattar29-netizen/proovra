/**
 * MEMBERS LEDGER X4 — THE WORK TAB NAMES THE WHOLE GROUP, NOT ITS PREVIEW.
 *
 * The detail envelope carries a bounded member preview (the first 25). The
 * Work tab's assignee filter, each row's assignee and the reassign picker were
 * built from that preview, so in a group of 30 a task held by the 30th member
 * read as team-level work, and could neither be filtered for nor reassigned to
 * them. They now read the server's paged ACTIVE roster; the reassign picker
 * also leaves out VIEWERs, whom the server refuses as assignees.
 *
 * This mounts the REAL team detail page on its Work tab.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const TEAM_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const LEAD_ID = "c1000000-0000-4000-8000-000000000001";
const TASK_ID = "a0000000-0000-4000-8000-000000000030";
const ISO = "2026-09-01T00:00:00.000Z";

const uid = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const H = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  }
  return { FakeApiError, memberPages: [] as string[] };
});

function previewMember(userId: string, role: string, name: string) {
  return {
    id: `m-${userId.slice(-2)}`,
    userId,
    role,
    status: "ACTIVE",
    joinedAt: ISO,
    suspendedAt: null,
    removedAt: null,
    user: { id: userId, email: null, displayName: name, firstName: null, lastName: null, avatarUrl: null },
  };
}

/** 30 ACTIVE members, server-side: the LEAD, 28 MEMBERs, and one VIEWER. */
function rosterRow(n: number) {
  const role = n === 1 ? "LEAD" : n === 29 ? "VIEWER" : "MEMBER";
  return {
    id: `m-${n}`,
    userId: uid(n),
    role,
    status: "ACTIVE",
    joinedAt: ISO,
    suspendedAt: null,
    removedAt: null,
    displayName: n === 1 ? "Talal" : `Member ${n}`,
    email: null,
    avatarUrl: null,
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
    viewerRole: "LEAD",
    activeMemberCount: 30,
    pendingInviteCount: 0,
    memberPreviewLimit: 25,
    // The preview stops at 25; member 30 is not in it.
    members: Array.from({ length: 25 }, (_, i) =>
      previewMember(uid(i + 1), i === 0 ? "LEAD" : "MEMBER", i === 0 ? "Talal" : `Member ${i + 1}`),
    ),
    invites: [],
    assignmentCount: 1,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (path.includes("/members")) {
      H.memberPages.push(path);
      const all = Array.from({ length: 30 }, (_, i) => rosterRow(i + 1));
      // Two pages, the way the endpoint answers a group larger than a page.
      const second = path.includes("cursor=");
      return {
        members: second ? all.slice(20) : all.slice(0, 20),
        nextCursor: second ? null : "page-2",
        totalActive: 30,
      };
    }
    if (path.includes("/assignments") && method === "GET") {
      return {
        assignments: [
          {
            id: TASK_ID,
            targetType: "CASE",
            targetId: "c0000000-0000-4000-8000-000000000030",
            target: { resolved: true, label: "Case 30", sublabel: null, state: "OPEN", review: null },
            assigneeUserId: uid(30),
            assignedByUserId: LEAD_ID,
            status: "OPEN",
            priority: "NORMAL",
            dueAtUtc: null,
            overdue: false,
            note: null,
            createdAt: ISO,
            updatedAt: ISO,
            completedAtUtc: null,
          },
        ],
        nextCursor: null,
        total: 1,
      };
    }
    if (path.endsWith("/entitlement")) {
      return { plan: "TEAM", mutationsAllowed: true, collaborationTeams: { limit: 10, used: 1 }, collaborationTeamMembers: { limit: 50, used: 30 } };
    }
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
    diagnostics: { requestId: "x4" },
    user: { id: LEAD_ID, email: "talal@meridian.test", displayName: "Talal" },
    workspace: { id: WORKSPACE_ID, name: "Meridian Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: { type: "ORGANIZATION", id: WORKSPACE_ID, displayName: "Meridian Legal", roleLabel: "Lead" },
    personalSpace: { id: "p-1", displayName: "Personal", available: true },
    plan: { tier: "TEAM", features: {} },
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
  await waitFor(() => expect(view.getByTestId(`assignment-row-${TASK_ID}`)).toBeTruthy());
  return view;
}

function optionTexts(listbox: HTMLElement): string[] {
  return within(listbox).getAllByRole("option").map((o) => (o.textContent ?? "").trim());
}

afterEach(() => {
  cleanup();
  H.memberPages.length = 0;
});

describe("X4 — the Work tab reads the whole ACTIVE roster", () => {
  it("names member 30 on their task, in the assignee filter, and in the reassign picker (without the VIEWER)", async () => {
    const view = await mountWorkTab();

    // The row names the holder, not "team-level", once the roster is read.
    await waitFor(() =>
      expect(within(view.getByTestId(`assignment-row-${TASK_ID}`)).getByText("Member 30")).toBeTruthy(),
    );
    // Both pages were read.
    expect(H.memberPages.some((p) => p.includes("status=ACTIVE"))).toBe(true);
    expect(H.memberPages.some((p) => p.includes("cursor=page-2"))).toBe(true);

    // The filter offers every ACTIVE member, the 26th onward included.
    await act(async () => {
      fireEvent.click(view.getByRole("combobox", { name: "Filter by assignee" }));
    });
    // The menu is an anchored overlay, outside the page container.
    const filter = optionTexts(screen.getByRole("listbox", { name: "Filter by assignee" }));
    expect(filter).toContain("Member 26");
    expect(filter).toContain("Member 30");
    await act(async () => {
      fireEvent.click(view.getByRole("combobox", { name: "Filter by assignee" }));
    });

    // The reassign picker offers member 30 and leaves out the VIEWER.
    await act(async () => {
      fireEvent.click(view.getByTestId(`assignment-edit-${TASK_ID}`));
    });
    const picker = within(view.getByTestId("edit-assignment-assignee"));
    await act(async () => {
      fireEvent.click(picker.getByRole("combobox", { name: "Assignee" }));
    });
    const reassign = optionTexts(screen.getByRole("listbox", { name: "Assignee" }));
    expect(reassign).toContain("Member 30");
    expect(reassign).not.toContain("Member 29");
  });
});
