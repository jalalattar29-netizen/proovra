/**
 * MEMBERS EXPERIENCE B / C / D — Members & Access, driven for real.
 *
 *   B  The four figures are useful and truthful: Active members, Pending
 *      invitations, Collaboration Teams against the gate's limit, Open cases.
 *      "No limit / Seats available" is gone; an unknown figure is "—", never
 *      0; FREE and PAYG are told Teams are not included and are offered no
 *      invitation the server would refuse; a contract seat count still warns
 *      when full, a plan ceiling of 0 does not.
 *   C  Search and status share one toolbar row.
 *   D  The lifecycle card goes straight to where the lifecycle is controlled:
 *      account closure for a Personal Workspace, the lifecycle page for an
 *      owned one, nothing for an Organization Workspace.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  // Stable, as the provider's is: the page's loader is keyed on it.
  toast: () => {},
  // ONE router object, as Next provides: a fresh object per render is not what
  // the app runs against, and `next/link` effects keyed on it re-run forever.
  router: { push: () => {}, replace: () => {}, prefetch: () => {} },
  searchParams: new URLSearchParams(),
  platform: { envelope: { user: { id: "user-1" } }, contextGeneration: 1 },
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui", async (orig) => ({ ...((await orig()) as object), useToast: () => ({ addToast: mocks.toast }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../lib/platform-context", async (orig) => ({ ...((await orig()) as object), usePlatformContext: () => mocks.platform }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  useRouter: () => mocks.router,
  usePathname: () => "/people",
  useSearchParams: () => mocks.searchParams,
}));

import TeamDetailPage from "../../app/(app)/teams/[id]/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type LifecycleKind = "PERSONAL" | "OWNED" | "ORGANIZATION";
const POLICY: Record<LifecycleKind, Record<string, unknown>> = {
  PERSONAL: { kind: "PERSONAL", endPath: "ACCOUNT_CLOSURE", deletable: false, closable: false, transferable: false, nextAction: "CLOSE_ACCOUNT" },
  OWNED: { kind: "OWNED", endPath: "WORKSPACE_CLOSURE", deletable: false, closable: true, transferable: true, nextAction: "REQUEST_WORKSPACE_CLOSURE" },
  ORGANIZATION: { kind: "ORGANIZATION", endPath: "ORGANIZATION_OFFBOARDING", deletable: false, closable: false, transferable: false, nextAction: "ORGANIZATION_OFFBOARDING" },
};

const collab = {
  PRO: { featureIncluded: true, active: 1, limit: 2, limitSource: "PLAN_CATALOG", membersPerTeam: 5 },
  TEAM: { featureIncluded: true, active: 1, limit: 5, limitSource: "PLAN_CATALOG", membersPerTeam: 10 },
  ENTERPRISE: { featureIncluded: true, active: 3, limit: 12, limitSource: "ENTERPRISE_CONTRACT", membersPerTeam: 40 },
  FREE: { featureIncluded: false, active: 0, limit: 0, limitSource: "PLAN_CATALOG", membersPerTeam: 0 },
};

let fx: { stats: Record<string, unknown> | undefined; lifecycle: LifecycleKind };

function person(n: number, role: string) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, userId: `user-${n}`, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: `user-${n}`, displayName: `Person ${n}`, email: `p${n}@example.org` } };
}
const ROSTER = [person(1, "OWNER"), person(2, "MEMBER")];

function reply(path: string): unknown {
  if (path === `/v1/teams/${TEAM}`) {
    return {
      id: TEAM,
      name: "Casework",
      ownerUserId: "user-1",
      currentUserRole: "OWNER",
      canManageMembers: true,
      canManageWorkspace: true,
      lifecycle: POLICY[fx.lifecycle],
      ...(fx.stats ? { stats: fx.stats } : {}),
      members: ROSTER,
    };
  }
  if (path === `/v1/teams/${TEAM}/invites`) return { invites: [] };
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return { members: ROSTER, nextCursor: null, total: ROSTER.length };
  if (path === `/v1/teams/${TEAM}/activity`) return { activities: [] };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  return {};
}

const stats = (overrides: Record<string, unknown> = {}) => ({
  memberCount: 2,
  memberCounts: { active: 2, suspended: 0, removed: 0, unassigned: 0 },
  pendingInviteCount: 1,
  caseCount: 9,
  openCaseCount: 4,
  seatLimit: null,
  seatUsed: 1,
  seatAvailable: null,
  collaborationTeams: collab.TEAM,
  ...overrides,
});

beforeEach(() => {
  fx = { stats: stats(), lifecycle: "PERSONAL" };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => reply(path));
});
afterEach(cleanup);

async function mount() {
  render(<TeamDetailPage />);
  await screen.findByTestId("people-kpis");
  await screen.findByTestId("people-roster");
  // The page re-reads after its first paint (roster page, invitations); wait
  // for the settled figures rather than the first frame.
  await screen.findByTestId("people-toolbar");
}
const kpis = () => screen.getByTestId("people-kpis");
const teamsCard = () => screen.getByTestId("people-collaboration-teams-kpi");

describe("B — the KPI cards", () => {
  it("never shows 'No limit' or 'Seats available'", async () => {
    await mount();
    expect(within(kpis()).queryByText("No limit")).toBeNull();
    expect(within(kpis()).queryByText("Seats available")).toBeNull();
    expect(within(kpis()).queryByText(/Capacity is set per Collaboration Team/)).toBeNull();
  });

  it("TEAM: active Collaboration Teams against 5, per-Team size stated with the owner excluded", async () => {
    await mount();
    expect(within(teamsCard()).getByText("1 of 5")).toBeTruthy();
    expect(within(teamsCard()).getByText(/up to 10 members per Team, owner not counted/)).toBeTruthy();
  });

  it("PRO: against 2", async () => {
    fx.stats = stats({ collaborationTeams: collab.PRO });
    await mount();
    expect(within(teamsCard()).getByText("1 of 2")).toBeTruthy();
    expect(within(teamsCard()).getByText(/up to 5 members per Team/)).toBeTruthy();
  });

  it("Enterprise: the contract's limit, said to be the contract's — no seat availability claim", async () => {
    fx.stats = stats({ collaborationTeams: collab.ENTERPRISE });
    await mount();
    expect(within(teamsCard()).getByText("3 of 12")).toBeTruthy();
    expect(within(teamsCard()).getByText(/set by your contract/)).toBeTruthy();
  });

  it("FREE: 'Not included', and no invitation is offered", async () => {
    fx.stats = stats({ collaborationTeams: collab.FREE, seatLimit: 0, seatAvailable: 0 });
    await mount();
    expect(within(teamsCard()).getByText("Not included")).toBeTruthy();
    expect(screen.queryByTestId("people-invite-open")).toBeNull();
    expect(screen.queryByTestId("people-rail-invite")).toBeNull();
    // A plan ceiling of 0 is not "every seat is in use".
    expect(screen.queryByTestId("people-seats-full")).toBeNull();
  });

  it("an Enterprise contract with every seat taken still says so", async () => {
    fx.stats = stats({ collaborationTeams: collab.ENTERPRISE, seatLimit: 20, seatUsed: 20, seatAvailable: 0 });
    await mount();
    expect(screen.getByTestId("people-seats-full")).toBeTruthy();
  });

  it("unknown figures are '—', never 0", async () => {
    fx.stats = stats({ collaborationTeams: null, openCaseCount: undefined });
    await mount();
    expect(within(teamsCard()).getByText("—")).toBeTruthy();
    const open = screen.getByTestId("people-open-cases-kpi");
    expect(within(open).getByText("—")).toBeTruthy();
    expect(within(open).queryByText("0")).toBeNull();
  });

  it("'Open cases' is the server's open, visible count — not every Case row", async () => {
    await mount();
    const open = screen.getByTestId("people-open-cases-kpi");
    expect(within(open).getByText("4")).toBeTruthy();
    expect(within(open).getByText("Open cases")).toBeTruthy();
    expect(within(open).queryByText("9")).toBeNull();
  });
});

describe("C — one members toolbar row", () => {
  it("search and the status selector are siblings in the same toolbar row", async () => {
    await mount();
    const row = screen.getByTestId("people-toolbar").querySelector(".app-list-toolbar__row") as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByTestId("people-search")).toBeTruthy();
    expect(within(row).getByTestId("people-status-control")).toBeTruthy();
    expect(screen.getByLabelText("Filter members by status")).toBeTruthy();
  });
});

describe("D — the lifecycle card goes straight to the real control", () => {
  it("Personal Workspace: Close account, at the canonical account-closure surface", async () => {
    await mount();
    const link = await screen.findByTestId("people-lifecycle-link");
    expect(link.getAttribute("href")).toBe("/settings#privacy");
    expect(link.textContent).toBe("Close account");
    expect(screen.queryByText("Open workspace lifecycle")).toBeNull();
  });

  it("owned Workspace: the lifecycle page, which holds closure and transfer", async () => {
    fx.lifecycle = "OWNED";
    await mount();
    const link = await screen.findByTestId("people-lifecycle-link");
    expect(link.getAttribute("href")).toBe(`/teams/${TEAM}/lifecycle`);
  });

  it("Organization Workspace: explained, never routed into anyone's account closure", async () => {
    fx.lifecycle = "ORGANIZATION";
    await mount();
    await screen.findByTestId("people-lifecycle-pointer");
    expect(screen.queryByTestId("people-lifecycle-link")).toBeNull();
    expect(screen.queryByText("Close account")).toBeNull();
  });
});
