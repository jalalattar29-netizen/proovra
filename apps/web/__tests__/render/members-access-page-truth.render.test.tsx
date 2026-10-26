/**
 * Members & Access page — the re-audit's unproven web claims, driven for real.
 *
 *   MEM-03  the "Pending invitations" KPI reads the SERVER's count: a Member or
 *           Viewer (who is never sent the invitation list) and an administrator
 *           whose list read failed see `stats.pendingInviteCount`, not 0; with
 *           no count at all the card says it is unavailable.
 *   MEM-04  role labels are words, never enums; the invite dialog is a real
 *           <form> (submitting it sends the invitation); a blank rename is
 *           refused with a reason; the external collaborators card is for
 *           administrators only.
 *   INV-02  invitation and role refusals read in their REGISTERED copy
 *           (USER_FACING_ERRORS — asserted against the one source, not a copy).
 *   INV-06  a seat-full workspace says so with the corrected sentence and
 *           Invite stays enabled: the server decides.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { USER_FACING_ERRORS } from "@proovra/shared/user-facing-errors";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  platform: { envelope: { user: { id: "me-user" } }, contextGeneration: 1 },
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
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

import TeamDetailPage from "../../app/(app)/teams/[id]/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Fixture = {
  canManage: boolean;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  stats: Record<string, unknown> | undefined;
  invitesFail: boolean;
  invites: Array<Record<string, unknown>>;
  inviteRefusal: { statusCode: number; code: string } | null;
  roleRefusal: { statusCode: number; code: string } | null;
};
let fx: Fixture;

function person(n: number, role: string) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, userId: `user-${n}`, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: `user-${n}`, displayName: `Person ${n}`, email: `p${n}@example.org` } };
}
const ROSTER = [person(1, "OWNER"), person(2, "ADMIN"), person(3, "MEMBER"), person(4, "VIEWER")];

function reply(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? "GET";
  if (method === "POST" && path === `/v1/teams/${TEAM}/invites`) {
    if (fx.inviteRefusal) throw { ...fx.inviteRefusal, message: "raw server text" };
    return { invite: { id: "new-invite", email: "new@example.org", role: "MEMBER", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", acceptedAt: null }, emailSent: true };
  }
  if (method === "PATCH" && path.startsWith(`/v1/teams/${TEAM}/members/`)) {
    if (fx.roleRefusal) throw { ...fx.roleRefusal, message: "raw server text" };
    return {};
  }
  if (path === `/v1/teams/${TEAM}`) {
    return {
      id: TEAM,
      name: "Casework",
      ownerUserId: "user-1",
      currentUserRole: fx.role,
      canManageMembers: fx.canManage,
      canManageWorkspace: fx.role === "OWNER",
      ...(fx.stats ? { stats: fx.stats } : {}),
      members: ROSTER,
    };
  }
  if (path === `/v1/teams/${TEAM}/invites`) {
    if (fx.invitesFail) throw { statusCode: 500 };
    return { invites: fx.invites };
  }
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return { members: ROSTER, nextCursor: null, total: ROSTER.length };
  if (path === `/v1/teams/${TEAM}/cases`) return { items: [] };
  if (path === `/v1/teams/${TEAM}/activity`) return { activities: [] };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  if (path === "/v1/platform/rbac/matrix") return { roles: [], categories: [] };
  return {};
}

const baseStats = { memberCount: 4, memberCounts: { active: 4, suspended: 0, removed: 0 }, pendingInviteCount: 3, caseCount: 0, seatLimit: 10, seatUsed: 4, seatAvailable: 6 };
const openInvite = (id: string, email: string) => ({ id, email, role: "MEMBER", status: "PENDING", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", acceptedAt: null });

beforeEach(() => {
  fx = { canManage: true, role: "ADMIN", stats: { ...baseStats }, invitesFail: false, invites: [], inviteRefusal: null, roleRefusal: null };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.toast.mockReset();
});
afterEach(cleanup);

async function mount() {
  render(<TeamDetailPage />);
  await screen.findByTestId("people-kpis");
  await screen.findByTestId("people-roster");
}
const pendingFigure = () => screen.getByTestId("people-pending-invite-count");
const pendingCard = () => pendingFigure().closest(".app-metric-card") as HTMLElement;

// ---------------------------------------------------------------------------

describe("MEM-03 — the Pending invitations figure is the server's", () => {
  it("a Member, who is never sent the list, sees the server's count — not 0", async () => {
    fx = { ...fx, canManage: false, role: "MEMBER" };
    await mount();
    await waitFor(() => expect(pendingFigure().textContent).toBe("3"));
    expect(mocks.fetch.mock.calls.some(([p]) => p === `/v1/teams/${TEAM}/invites`)).toBe(false);
  });

  it("a Viewer sees the server's count too", async () => {
    fx = { ...fx, canManage: false, role: "VIEWER", stats: { ...baseStats, pendingInviteCount: 5 } };
    await mount();
    await waitFor(() => expect(pendingFigure().textContent).toBe("5"));
  });

  it("an administrator whose list read FAILED sees the server's count, not 0", async () => {
    fx = { ...fx, invitesFail: true };
    await mount();
    await screen.findByTestId("people-invites-error");
    expect(pendingFigure().textContent).toBe("3");
  });

  it("with no count anywhere the card says so — it never reads 0", async () => {
    fx = { ...fx, canManage: false, role: "MEMBER", stats: undefined };
    await mount();
    await waitFor(() => expect(pendingFigure().textContent).toBe("—"));
    expect(within(pendingCard()).getByText("Count unavailable right now")).toBeTruthy();
  });

  it("an administrator whose list read succeeded sees that list's open invitations", async () => {
    fx = { ...fx, stats: { ...baseStats, pendingInviteCount: 2 }, invites: [openInvite("i1", "a@example.org"), openInvite("i2", "b@example.org")] };
    await mount();
    await screen.findByText("a@example.org");
    expect(pendingFigure().textContent).toBe("2");
    expect(within(pendingCard()).getByText("Sent, not yet accepted")).toBeTruthy();
  });
});

describe("MEM-04 — labels, the invite form, blank rename, admin-only external card", () => {
  it("role labels are words — no raw OWNER / ADMIN / MEMBER / VIEWER anywhere on the page", async () => {
    fx = { ...fx, canManage: false, role: "ADMIN" };
    await mount();
    const roster = screen.getByTestId("people-roster");
    for (const label of ["Owner", "Admin", "Member", "Viewer"]) {
      expect(within(roster).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(document.body.textContent).toMatch(/Your role: Admin/);
    expect(document.body.textContent).not.toMatch(/\b(OWNER|ADMIN|MEMBER|VIEWER)\b/);
  });

  it("the invite dialog is a real <form>: submitting it (Enter) sends the invitation", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("people-invite-open"));
    const form = await screen.findByTestId("people-invite-form");
    expect(form.tagName).toBe("FORM");
    fireEvent.change(screen.getByTestId("people-invite-email"), { target: { value: "new@example.org" } });
    fireEvent.submit(form);
    await waitFor(() => {
      const post = mocks.fetch.mock.calls.find(([p, init]) => p === `/v1/teams/${TEAM}/invites` && init?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1].body))).toEqual({ email: "new@example.org", role: "MEMBER" });
    });
  });

  it("a blank rename is refused with a reason, and nothing is sent", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("workspace-rename-toggle"));
    const input = await screen.findByTestId("workspace-name-input");
    fireEvent.change(input, { target: { value: "   " } });
    const save = screen.getByTestId("workspace-name-save");
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("workspace-name-required").textContent).toBe("Enter a name for the workspace.");
    expect(input.getAttribute("aria-describedby")).toBe("workspace-name-required");
    fireEvent.click(save);
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("the external collaborators card is shown to administrators", async () => {
    await mount();
    expect(await screen.findByRole("heading", { name: "External collaborators" })).toBeTruthy();
  });

  it("…and not to a Member, who does not even request it", async () => {
    fx = { ...fx, canManage: false, role: "MEMBER" };
    await mount();
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([p]) => p === `/v1/teams/${TEAM}/activity`)).toBe(true));
    expect(screen.queryByRole("heading", { name: "External collaborators" })).toBeNull();
    expect(mocks.fetch.mock.calls.some(([p]) => p === `/v1/teams/${TEAM}/access-review`)).toBe(false);
  });
});

describe("INV-02 — refusals read in their registered copy", () => {
  async function inviteRefusedWith(code: string, statusCode: number) {
    fx = { ...fx, inviteRefusal: { statusCode, code } };
    await mount();
    fireEvent.click(screen.getByTestId("people-invite-open"));
    fireEvent.change(await screen.findByTestId("people-invite-email"), { target: { value: "new@example.org" } });
    fireEvent.click(screen.getByTestId("people-invite-submit"));
  }

  for (const [code, status] of [
    ["WORKSPACE_INVITES_NOT_INCLUDED", 402],
    ["WORKSPACE_INVITE_LIMIT_REACHED", 409],
    ["INVITE_ALREADY_PENDING", 409],
    ["ALREADY_WORKSPACE_MEMBER", 409],
  ] as const) {
    it(`${code} on Send invitation`, async () => {
      await inviteRefusedWith(code, status);
      const copy = USER_FACING_ERRORS[code];
      expect(copy, `${code} must have registered copy`).toBeTruthy();
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(copy.message, "error"));
      expect(mocks.toast).not.toHaveBeenCalledWith("raw server text", expect.anything());
    });
  }

  it("rank_insufficient (the engine's lower-case code) on a role change", async () => {
    fx = { ...fx, roleRefusal: { statusCode: 403, code: "rank_insufficient" } };
    await mount();
    const roster = screen.getByTestId("people-roster");
    // Choose a different role for Person 3 (a Member) through the real listbox.
    const trigger = within(roster).getByRole("combobox", { name: /Workspace role for Person 3/ });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(USER_FACING_ERRORS.RANK_INSUFFICIENT.message, "error"),
    );
    expect(mocks.toast).not.toHaveBeenCalledWith("raw server text", expect.anything());
  });
});

describe("INV-06 — a seat-full workspace", () => {
  it("states the corrected sentence and keeps Invite enabled: the server decides", async () => {
    fx = { ...fx, stats: { ...baseStats, seatLimit: 4, seatUsed: 4, seatAvailable: 0 } };
    await mount();
    const banner = await screen.findByTestId("people-seats-full");
    expect(banner.textContent).toMatch(/Every seat is in use\./);
    expect(banner.textContent).toMatch(
      /You can still send invitations, but an invited person can join only once a seat frees up or the contract adds seats\./,
    );
    const open = screen.getByTestId("people-invite-open");
    expect(open.hasAttribute("disabled")).toBe(false);
    fireEvent.click(open);
    fireEvent.change(await screen.findByTestId("people-invite-email"), { target: { value: "new@example.org" } });
    expect(screen.getByTestId("people-invite-submit").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("people-invite-submit"));
    await waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([p, init]) => p === `/v1/teams/${TEAM}/invites` && init?.method === "POST")).toBe(true),
    );
  });
});
