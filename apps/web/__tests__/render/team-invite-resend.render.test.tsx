import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  platform: { envelope: { user: { id: "me-user" } }, contextGeneration: 1 },
  canManage: true,
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => false }) }));
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
const INVITE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let resent = false;
const invite = (id: string, email: string) => ({
  id, email, role: "MEMBER", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", acceptedAt: null,
  lastResentAt: resent && id === INVITE ? "2026-01-15T00:00:00.000Z" : null, resendCount: resent && id === INVITE ? 1 : 0,
});
function reply(path: string, init?: RequestInit, emailSent = true): unknown {
  if (init?.method === "POST" && path.endsWith("/resend")) {
    resent = true;
    return { invite: invite(INVITE, "late@example.org"), emailSent };
  }
  if (path === `/v1/teams/${TEAM}`) return { id: TEAM, name: "Casework", ownerUserId: "owner", canManageMembers: mocks.canManage, stats: { memberCount: 1, pendingInviteCount: 2, caseCount: 0 }, members: [] };
  if (path === `/v1/teams/${TEAM}/invites`) {
    if (!mocks.canManage) throw { statusCode: 403 };
    return { invites: [invite(INVITE, "late@example.org"), invite(OTHER, "other@example.org")] };
  }
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return { members: [], nextCursor: null, total: 0 };
  if (path === `/v1/teams/${TEAM}/cases`) return { items: [] };
  if (path === `/v1/teams/${TEAM}/activity`) return { activities: [] };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  return {};
}
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
const resendButton = () => screen.findByRole("button", { name: "Resend invitation to late@example.org" });

beforeEach(() => {
  resent = false;
  mocks.canManage = true;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.toast.mockReset();
});
afterEach(cleanup);

describe("workspace invitation resend", () => {
  it("resends, rereads the invitation list, then reports the delivery", async () => {
    render(<TeamDetailPage />);
    fireEvent.click(await resendButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Invitation resent to late@example.org. The previous link no longer works.", "success"));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/teams/${TEAM}/invites/${INVITE}/resend`);
    expect(calls[write][1].body).toBeUndefined();
    expect(calls.slice(write + 1).some(([p]) => p === `/v1/teams/${TEAM}/invites`)).toBe(true);
    expect(await screen.findByText(/^Resent /)).toBeTruthy();
    // Revoke is still offered beside it.
    expect(screen.getByTestId(`invite-revoke-${INVITE}`)).toBeTruthy();
  });

  it("warns when the new link was issued but the email was not delivered", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init, false));
    render(<TeamDetailPage />);
    fireEvent.click(await resendButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/email could not be delivered/), "warning"));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (resent && path === `/v1/teams/${TEAM}/invites`) throw { statusCode: 503 };
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    fireEvent.click(await resendButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/could not be reloaded to confirm it/), "error"));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
    await screen.findByTestId("people-invites-error");
  });

  it("explains a no-longer-pending invitation and reloads the list", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw { statusCode: 409, code: "INVITE_NOT_PENDING", message: "raw server text" };
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    fireEvent.click(await resendButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/already accepted or revoked/), "error"));
    expect(mocks.toast).not.toHaveBeenCalledWith("raw server text", expect.anything());
    const lists = mocks.fetch.mock.calls.filter(([p]) => p === `/v1/teams/${TEAM}/invites`);
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it("disables the other resend controls with a reason while one is in flight", async () => {
    let release!: () => void;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { release = () => resolve({ emailSent: true }); });
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    fireEvent.click(await resendButton());
    const other = screen.getByRole("button", { name: "Resend invitation to other@example.org" });
    await waitFor(() => expect(other.hasAttribute("disabled")).toBe(true));
    expect(other.getAttribute("data-disabled-reason")).toBe("Another invitation is being resent. Wait for it to finish.");
    fireEvent.click(other);
    expect(posts()).toHaveLength(1);
    release();
  });

  it("never renders a failed invitation read as 'no invitations outstanding'", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === `/v1/teams/${TEAM}/invites`) throw { statusCode: 500 };
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    await screen.findByTestId("people-invites-error");
    expect(screen.queryByTestId("people-invites-empty")).toBeNull();
    expect(screen.queryByRole("button", { name: /Resend invitation/ })).toBeNull();
  });

  it("offers no resend to a caller who cannot manage members", async () => {
    mocks.canManage = false;
    render(<TeamDetailPage />);
    await screen.findByTestId("people-roster");
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([p]) => p === `/v1/teams/${TEAM}/invites`)).toBe(true));
    expect(screen.queryByRole("button", { name: /Resend invitation/ })).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});
