/**
 * Team remediation — what Members & Access, the plan drawer and the case
 * restriction confirm SAY (no behaviour change):
 *
 *   T-097b  the workspace invite dialog states the placement prerequisite and
 *           offers "Add to a review team now" into the Collaboration-Team
 *           add-member flow (not on Enterprise, where the contract decides);
 *   T-105   three disclosures of TODAY's behaviour — members keep access,
 *           including write, after the plan is lowered or cancelled; no
 *           workspace-wide member ceiling; owners and admins cannot see a
 *           restricted case without a grant — on Members & Access help, in the
 *           downgrade / cancel drawer, and in the restriction confirm;
 *   T-117   a workspace name that shows an e-mail address prompts its manager
 *           to rename it (PATCH /v1/teams/:id already accepts a name).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async (_opts: unknown) => true),
  platform: { envelope: { user: { id: "me-user" } }, contextGeneration: 1 },
  team: {} as Record<string, unknown>,
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui", async (orig) => ({ ...((await orig()) as object), useToast: () => ({ addToast: mocks.toast }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../lib/platform-context", async (orig) => ({ ...((await orig()) as object), usePlatformContext: () => mocks.platform }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/people",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/(app)/evidence/[id]/components/WorkspaceMemberSelect", () => ({
  WorkspaceMemberSelect: ({ onChange }: { onChange: (m: { userId: string; label: string; role: string }) => void }) => (
    <button type="button" data-test-pick onClick={() => onChange({ userId: "user-pat", label: "Pat", role: "MEMBER" })}>
      pick Pat
    </button>
  ),
}));

import TeamDetailPage from "../../app/(app)/teams/[id]/page";
import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import { MatterAccessTab } from "../../components/cases-experience/MatterAccessTab";
import type { BillingAccountProjection, PlanOffer } from "../../lib/api/billing-accounts";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE = "c2000000-0000-4000-8000-000000000002";

function person(n: number, role: string) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, userId: `user-${n}`, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: `user-${n}`, displayName: `Person ${n}`, email: `p${n}@example.org` } };
}
const ROSTER = [person(1, "OWNER"), person(2, "MEMBER")];

function reply(path: string, init?: RequestInit): unknown {
  if (path === `/v1/teams/${TEAM}`) {
    return {
      id: TEAM,
      name: "Casework",
      ownerUserId: "user-1",
      currentUserRole: "OWNER",
      canManageMembers: true,
      canManageWorkspace: true,
      effectivePlan: "TEAM",
      stats: { memberCount: 2, memberCounts: { active: 2, suspended: 0, removed: 0 }, pendingInviteCount: 0, caseCount: 0 },
      members: ROSTER,
      ...mocks.team,
    };
  }
  if (path === `/v1/teams/${TEAM}/invites`) return { invites: [] };
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return { members: ROSTER, nextCursor: null, total: ROSTER.length };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  if (path === `/v1/cases/${CASE}`) return { case: { id: CASE, ownerUserId: "user-owner", access: [], teamAccess: [], restricted: false, restrictedAtUtc: null } };
  if (path === `/v1/cases/${CASE}/team-members`) return { items: [] };
  if (path === `/v1/cases/${CASE}/team-access/candidates`) return { items: [] };
  if (path === `/v1/cases/${CASE}/access` && init?.method === "POST") return { access: { id: "g1" } };
  return {};
}

beforeEach(() => {
  mocks.team = {};
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockClear();
});
afterEach(cleanup);

async function mountPage() {
  render(<TeamDetailPage />);
  await screen.findByTestId("people-roster");
}

describe("T-097 — the invite dialog states the placement prerequisite", () => {
  it("says a new member must join a Collaboration Team before work, and offers to add them", async () => {
    await mountPage();
    fireEvent.click(await screen.findByTestId("people-rail-invite-open"));
    const modal = (await screen.findByTestId("people-invite-form")).closest("[data-matter-modal]") as HTMLElement;
    const note = within(modal).getByTestId("people-invite-placement");
    expect(note.textContent).toMatch(/must be added to a Collaboration Team/);
    expect(note.textContent).toMatch(/assigned reviews or claim work/);
    const action = within(note).getByRole("link", { name: "Add to a review team now" });
    expect(action.getAttribute("href")).toBe("/collaboration-teams");
  });

  it("is not claimed on Enterprise, where the contract decides", async () => {
    mocks.team = { effectivePlan: "ENTERPRISE" };
    await mountPage();
    fireEvent.click(await screen.findByTestId("people-rail-invite-open"));
    const modal = (await screen.findByTestId("people-invite-form")).closest("[data-matter-modal]") as HTMLElement;
    expect(within(modal).queryByTestId("people-invite-placement")).toBeNull();
  });
});

describe("T-105 — Members & Access help discloses today's behaviour", () => {
  it("member access after a downgrade, no workspace ceiling, restricted cases and the owner", async () => {
    await mountPage();
    const help = await screen.findByTestId("people-access-disclosures");
    expect(help.textContent).toMatch(/keep their access, including adding and changing records, if the owner's plan is lowered or cancelled/);
    expect(help.textContent).toMatch(/no limit on the total number of members/);
    expect(help.textContent).toMatch(/including the workspace owner and admins/);
  });
});

describe("T-117 — a workspace name that shows an e-mail address", () => {
  it("prompts the manager to rename it, and the prompt opens the rename field", async () => {
    mocks.team = { name: "jamie@example.org's personal workspace" };
    await mountPage();
    const prompt = await screen.findByTestId("workspace-name-shows-email");
    fireEvent.click(within(prompt).getByRole("button", { name: "Rename workspace" }));
    expect(await screen.findByTestId("workspace-name-input")).toBeTruthy();
  });

  it("an ordinary name prompts nothing", async () => {
    await mountPage();
    await screen.findByTestId("people-workspace-overview");
    expect(screen.queryByTestId("workspace-name-shows-email")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const MOVE_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "USD",
  summary: "Pro",
  action: "DOWNGRADE",
  effect: "AT_PERIOD_END",
  actionLabel: "Move to Pro",
  effectSummary: "Lower limits than you have now. Nothing you have recorded is deleted.",
};

function teamProjection(): BillingAccountProjection {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_MANAGE", "BILLING_CANCEL"],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "TEAM",
      accessKind: "SUBSCRIPTION",
      displayName: "Team",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      currency: "USD",
      priceCents: 7900,
      currentPeriodEndUtc: "2031-03-14T09:30:00.000Z",
      cancelAtPeriodEnd: false,
      cancellationKeepsPaidPeriod: true,
      billingOwnerMissing: false,
      paymentProviderLabel: "Card",
    },
    planOffers: [MOVE_PRO],
    storageAddons: { offers: [], active: [] },
    actions: {
      canStartCheckout: false,
      planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      canRequestCancellation: true,
      contactAccountManager: false,
      manageLabel: null,
    },
  } as unknown as BillingAccountProjection;
}

describe("T-105 — the downgrade / cancel drawer mentions member access", () => {
  it("before a lowering and before cancelling", () => {
    render(
      <ManagePlanDrawer
        open
        projection={teamProjection()}
        onClose={() => {}}
        onChangePlan={() => {}}
        onCancel={() => {}}
        changeBusyPlan={null}
        cancelBusy={false}
      />,
    );
    const move = document.querySelector('[data-billing-manage-move="PRO"]')!;
    expect(move.textContent).toMatch(/keep their access, including adding and changing records, after your plan is lowered or cancelled/);
    const cancelNote = document.querySelector('[data-billing-manage-member-access-note="FREE"]');
    expect(cancelNote?.textContent).toMatch(/keep their access/);
    const button = document.querySelector("[data-billing-manage-cancel]")!;
    expect(cancelNote!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("T-105 — the restriction confirm says the owner cannot see it either", () => {
  it("'Restrict this case to named people?' names the owner and admins", async () => {
    const { container } = render(
      <MatterAccessTab caseId={CASE} teamId={TEAM} caseOwnerUserId="user-owner" viewer={{ userId: "user-owner", canManageAccess: true }} />,
    );
    await screen.findByText("Open to the whole workspace");
    fireEvent.click(screen.getByText("pick Pat"));
    fireEvent.click(container.querySelector("[data-matter-access-grant]") as HTMLElement);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const opts = mocks.confirm.mock.calls[0][0] as { title: string; description: string };
    expect(opts.title).toBe("Restrict this case to named people?");
    expect(opts.description).toMatch(/including the workspace owner and admins/);
  });
});
