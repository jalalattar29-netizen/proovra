/**
 * CT-13 — THE COLLABORATION TEAMS LIST IS FILTERED AND SORTED BY THE SERVER.
 *
 * The web list used to sort and type-filter the ONE page it held, presenting
 * it as the whole list. The server now applies status, type and sort across
 * pages (proven in members-reaudit-collaboration-teams.integration.test.ts),
 * and the page must send each control to it and render the rows exactly as
 * they arrive. This mounts the REAL list page against server responses whose
 * order is deliberately NOT what a local sort or filter would produce, so a
 * regression to client-side ordering or filtering changes what is on screen.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-09-01T00:00:00.000Z";

const H = vi.hoisted(() => ({
  /** Every list request's query, in order. */
  listQueries: [] as URLSearchParams[],
}));

function team(id: string, name: string, teamType: string) {
  return {
    id,
    name,
    description: null,
    teamType,
    status: "ACTIVE",
    createdAt: ISO,
    updatedAt: ISO,
    archivedAtUtc: null,
    memberCount: 2,
    pendingInviteCount: 0,
    openAssignmentCount: 0,
    overdueAssignmentCount: 0,
    highPriorityAssignmentCount: 0,
    lastActivityAt: ISO,
    viewerRole: "LEAD",
  };
}

const ZULU = team("t0000000-0000-4000-8000-000000000001", "Zulu Review", "REVIEW");
const ALPHA = team("t0000000-0000-4000-8000-000000000002", "Alpha Legal", "LEGAL");
const MIKE = team("t0000000-0000-4000-8000-000000000003", "Mike General", "GENERAL");
const BRAVO = team("t0000000-0000-4000-8000-000000000004", "Bravo Legal", "LEGAL");

/**
 * The server's answer. Its ORDER is the server's — never alphabetical here,
 * so a browser-side "Name (A–Z)" would visibly reorder it — and for a type
 * filter it includes a row of another type, which a browser-side filter would
 * drop. The page must show exactly this.
 */
function serverPage(q: URLSearchParams) {
  const page2 = q.get("cursor") === "page-2";
  if (q.get("type") === "LEGAL") {
    return page2 ? { teams: [ALPHA], nextCursor: null } : { teams: [BRAVO, MIKE], nextCursor: "page-2" };
  }
  if (q.get("sort") === "NAME_ASC") return { teams: [ZULU, ALPHA], nextCursor: null };
  return { teams: [ALPHA, ZULU], nextCursor: null };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    const url = new URL(`https://x.test${path}`);
    if (url.pathname.endsWith("/entitlement")) {
      return {
        workspaceId: WORKSPACE_ID,
        workspaceKind: "ORGANIZATION",
        plan: "TEAM",
        featureIncluded: true,
        mutationsAllowed: true,
        lifecycle: { state: "ACTIVE", reasonCode: null, graceEndsAtUtc: null },
        workspaceSeats: { limit: 10, used: 2, remaining: 8, overLimit: false, source: "plan" },
        collaborationTeams: { limit: 10, used: 4, remaining: 6, overLimit: false, source: "plan" },
        collaborationTeamMembers: { limit: 10, used: 2, remaining: 8, overLimit: false, source: "plan" },
        invitations: { pending: 0, maxPending: 10, maxPer24h: 10 },
        canCreateCollaborationTeam: true,
        canInviteWorkspaceMember: true,
        canAssignExistingMember: true,
        governance: { canViewAllTeams: false, allTeamsCount: 4 },
        exceededDimensions: [],
        upgradeHref: null,
      };
    }
    if (url.pathname === "/v1/collaboration-teams") {
      H.listQueries.push(url.searchParams);
      return {
        ...serverPage(url.searchParams),
        totalActive: 4,
        workspaceTotalActive: 4,
        scope: "PARTICIPATING",
        canGovernWorkspace: false,
        rollup: null,
      };
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/collaboration-teams",
  useParams: () => ({}),
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import TeamsOverviewPage from "../../app/(app)/collaboration-teams/page";

function envelope(): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "ct-13" },
    user: { id: "u-1", email: "lead@meridian.test", displayName: "Lead" },
    workspace: { id: WORKSPACE_ID, name: "Meridian Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: { type: "ORGANIZATION", id: WORKSPACE_ID, displayName: "Meridian Legal", roleLabel: "Owner", plan: "TEAM" },
    personalSpace: { id: "p-1", displayName: "Personal", available: true },
    plan: { tier: "TEAM", features: {} },
  };
}

async function mountList() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PlatformContextProvider testEnvelope={envelope() as never}>
        <ToastProvider>
          <TeamsOverviewPage />
        </ToastProvider>
      </PlatformContextProvider>,
    );
  });
  await waitFor(() => expect(view.queryByTestId(`team-card-${ALPHA.id}`)).not.toBeNull());
  return view;
}

/** The team names in the table, top to bottom. */
function rowOrder(view: ReturnType<typeof render>): string[] {
  return Array.from(view.getByTestId("teams-list").querySelectorAll("tbody tr")).map(
    (tr) => tr.getAttribute("data-testid")!.replace("team-card-", ""),
  );
}

async function choose(view: ReturnType<typeof render>, control: string, option: string) {
  await act(async () => {
    fireEvent.click(view.getByRole("combobox", { name: control }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("option", { name: option }));
  });
}

beforeEach(() => {
  H.listQueries.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("CT-13 — the Teams list sends its sort and type filter to the server and shows rows as received", () => {
  it("choosing Name (A–Z) asks the server for NAME_ASC and keeps the server's order", async () => {
    const view = await mountList();
    expect(H.listQueries[0]!.get("sort")).toBe("ACTIVITY_DESC");
    expect(rowOrder(view)).toEqual([ALPHA.id, ZULU.id]);

    await choose(view, "Sort teams", "Name (A–Z)");
    await waitFor(() => expect(H.listQueries.at(-1)!.get("sort")).toBe("NAME_ASC"));
    // The server answered Zulu before Alpha; a browser-side sort would flip it.
    await waitFor(() => expect(rowOrder(view)).toEqual([ZULU.id, ALPHA.id]));
  });

  it("choosing a type asks the server for it, renders its rows unfiltered, and Load more appends the next server page", async () => {
    const view = await mountList();
    await choose(view, "Filter by team type", "Legal");
    await waitFor(() => expect(H.listQueries.at(-1)!.get("type")).toBe("LEGAL"));
    // The server's rows, in its order — including the one a local type filter would drop.
    await waitFor(() => expect(rowOrder(view)).toEqual([BRAVO.id, MIKE.id]));

    await act(async () => {
      fireEvent.click(view.getByTestId("teams-load-more"));
    });
    await waitFor(() => expect(rowOrder(view)).toEqual([BRAVO.id, MIKE.id, ALPHA.id]));
    const more = H.listQueries.at(-1)!;
    expect(more.get("cursor")).toBe("page-2");
    expect(more.get("type")).toBe("LEGAL");
  });
});
