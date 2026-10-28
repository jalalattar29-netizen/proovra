/**
 * MEMBERS EXPERIENCE E — the Collaboration Teams list toolbar and its URL.
 *
 *   - search, status, type and sort are ONE toolbar row (search first);
 *   - the filters arrive from the URL — a reload, a shared link or Back from a
 *     Team restores them — and every change is written back to it;
 *   - "Clear filters" appears only when something differs from the defaults,
 *     and returns every control (and the request) to them;
 *   - archived Teams are asked for only when the status filter includes them;
 *   - a "Load more" page fetched under the PREVIOUS filters is dropped.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-09-01T00:00:00.000Z";

const H = vi.hoisted(() => ({
  listQueries: [] as URLSearchParams[],
  url: "",
  replaced: [] as string[],
  router: null as unknown as { push: () => void; replace: (to: string) => void; back: () => void },
  /** Resolves a held "load more" request when set. */
  hold: null as null | ((v: unknown) => void),
}));
H.router = { push: () => {}, replace: (to: string) => H.replaced.push(to), back: () => {} };

function team(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    teamType: "LEGAL",
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
const ALPHA = team("t0000000-0000-4000-8000-000000000002", "Alpha Legal");
const BRAVO = team("t0000000-0000-4000-8000-000000000004", "Bravo Legal");
const STALE = team("t0000000-0000-4000-8000-000000000009", "Stale Page Row");

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    const url = new URL(`https://x.test${path}`);
    if (url.pathname.endsWith("/entitlement")) {
      return {
        workspaceId: WORKSPACE_ID,
        workspaceKind: "PERSONAL",
        plan: "TEAM",
        featureIncluded: true,
        mutationsAllowed: true,
        lifecycle: { state: "ACTIVE", reasonCode: null, graceEndsAtUtc: null },
        workspaceSeats: { limit: null, used: 2, remaining: null, overLimit: false, source: "plan" },
        collaborationTeams: { limit: 5, used: 2, remaining: 3, overLimit: false, source: "PLAN_CATALOG" },
        collaborationTeamMembers: { limit: 10, source: "PLAN_CATALOG" },
        invitations: { pending: 0, maxPending: 10, maxPer24h: 10 },
        canCreateCollaborationTeam: true,
        canInviteWorkspaceMember: true,
        canAssignExistingMember: true,
        governance: { canViewAllTeams: false, allTeamsCount: 2 },
        exceededDimensions: [],
        upgradeHref: null,
      };
    }
    if (url.pathname === "/v1/collaboration-teams") {
      H.listQueries.push(url.searchParams);
      const base = { totalActive: 2, workspaceTotalActive: 2, scope: "PARTICIPATING", canGovernWorkspace: false, rollup: null };
      if (url.searchParams.get("cursor") === "page-2") {
        await new Promise((resolve) => {
          H.hold = resolve;
        });
        return { ...base, teams: [STALE], nextCursor: null };
      }
      return { ...base, teams: [ALPHA, BRAVO], nextCursor: "page-2" };
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
  useRouter: () => H.router,
  useSearchParams: () => new URLSearchParams(H.url),
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
    diagnostics: { requestId: "teams-toolbar" },
    user: { id: "u-1", email: "lead@meridian.test", displayName: "Lead" },
    workspace: { id: WORKSPACE_ID, name: "Meridian", status: "active", scope: "PERSONAL" },
    activeSpace: { type: "PERSONAL", id: WORKSPACE_ID, displayName: "Meridian", roleLabel: "Owner", plan: "TEAM" },
    personalSpace: { id: WORKSPACE_ID, displayName: "Personal", available: true },
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
  H.replaced.length = 0;
  H.url = "";
  H.hold = null;
});
afterEach(cleanup);

describe("one coherent toolbar", () => {
  it("search, status, type and sort are siblings in ONE toolbar row, search first", async () => {
    const view = await mountList();
    const row = view.getByTestId("teams-toolbar").querySelector(".app-list-toolbar__row") as HTMLElement;
    const children = Array.from(row.children);
    expect(children[0]!.querySelector('[data-testid="teams-search-input"]')).not.toBeNull();
    for (const id of ["teams-status-filter", "teams-type-filter", "teams-sort-filter"]) {
      expect(within(row).getByTestId(id).parentElement).toBe(row);
    }
    // Selected values are whole words, never truncated by the control.
    expect(within(row).getByText("Last activity (newest)")).toBeTruthy();
  });

  it("Clear filters appears only when a filter differs from the default, and resets the request", async () => {
    const view = await mountList();
    expect(view.queryByTestId("teams-clear-filters")).toBeNull();
    await choose(view, "Sort teams", "Name (A–Z)");
    await waitFor(() => expect(H.listQueries.at(-1)!.get("sort")).toBe("NAME_ASC"));
    await act(async () => {
      fireEvent.click(view.getByTestId("teams-clear-filters"));
    });
    await waitFor(() => expect(H.listQueries.at(-1)!.get("sort")).toBe("ACTIVITY_DESC"));
    expect(view.queryByTestId("teams-clear-filters")).toBeNull();
  });
});

describe("the URL carries the filters", () => {
  it("arriving with filters in the URL sends them to the server and shows them selected", async () => {
    H.url = "q=alpha&status=active&type=legal&sort=name_asc";
    const view = await mountList();
    const first = H.listQueries[0]!;
    expect(first.get("q")).toBe("alpha");
    expect(first.get("status")).toBe("ACTIVE");
    expect(first.get("type")).toBe("LEGAL");
    expect(first.get("sort")).toBe("NAME_ASC");
    // ACTIVE excludes archived Teams from the request itself.
    expect(first.get("includeArchived")).toBeNull();
    expect((view.getByTestId("teams-search-input") as HTMLInputElement).value).toBe("alpha");
    expect(view.getByTestId("teams-clear-filters")).toBeTruthy();
  });

  it("a stale or unknown value falls back to the default rather than reaching the server", async () => {
    H.url = "status=deleted&sort=random";
    await mountList();
    expect(H.listQueries[0]!.get("status")).toBeNull();
    expect(H.listQueries[0]!.get("sort")).toBe("ACTIVITY_DESC");
  });

  it("choosing a filter writes it to the URL (replace, no history entry per click)", async () => {
    const view = await mountList();
    await choose(view, "Filter by status", "Archived");
    await waitFor(() => expect(H.replaced.at(-1)).toBe("/collaboration-teams?status=archived"));
    // Archived Teams are requested only because the filter now includes them.
    await waitFor(() => expect(H.listQueries.at(-1)!.get("includeArchived")).toBe("true"));
  });
});

describe("load more", () => {
  it("a page fetched under the previous filters is not appended to the new list", async () => {
    const view = await mountList();
    await act(async () => {
      fireEvent.click(view.getByTestId("teams-load-more"));
    });
    await waitFor(() => expect(H.hold).not.toBeNull());
    await choose(view, "Sort teams", "Name (A–Z)");
    await waitFor(() => expect(H.listQueries.at(-1)!.get("sort")).toBe("NAME_ASC"));
    await act(async () => {
      H.hold!(undefined);
    });
    await waitFor(() => expect(view.queryByTestId(`team-card-${ALPHA.id}`)).not.toBeNull());
    expect(view.queryByTestId(`team-card-${STALE.id}`)).toBeNull();
  });
});
