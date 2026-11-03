/**
 * CAP-10 follow-up — the ownership-transfer picker searches the paged member
 * API, so an organization of more than 200 members can hand ownership to a
 * member who is on no page the organization page read.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
  isApiResponseError: () => false,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...((await orig()) as object),
  usePlatformContext: () => ({ refresh: async () => {}, envelope: { user: { id: "user-1" } } }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  useSearchParams: () => new URLSearchParams(),
}));

import OrganizationPage from "../../app/(app)/organizations/[id]/page";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOTAL = 250;
function member(n: number) {
  return {
    membershipId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    userId: `user-${n}`,
    email: `m${n}@example.org`,
    displayName: `Member ${n}`,
    role: n === 1 ? "ORG_OWNER" : "ORG_MEMBER",
    memberSince: "2026-01-01T00:00:00.000Z",
  };
}
const everyone = Array.from({ length: TOTAL }, (_, i) => member(i + 1));
const summary = { totalMembers: TOTAL, byRole: { ORG_OWNER: 1, ORG_MEMBER: TOTAL - 1 }, byStatus: { ACTIVE: TOTAL } };

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://x");
    if (url.pathname === `/v1/orgs/${ORG}/members`) {
      const q = url.searchParams.get("q");
      if (q) {
        const hits = everyone.filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
        return { organizationId: ORG, summary: { ...summary, matchingMembers: hits.length }, members: hits, nextCursor: null };
      }
      // The organization page reads one page; member 250 is not on it.
      return { organizationId: ORG, summary, members: everyone.slice(0, 50), nextCursor: everyone[49].membershipId };
    }
    if (path === `/v1/orgs/${ORG}`) {
      return {
        id: ORG,
        name: "Acme Legal",
        status: "ACTIVE",
        callerRole: "ORG_OWNER",
        adminSurfaces: ["overview", "members"],
        organizationKind: "CUSTOMER",
        summary: { memberCount: TOTAL, workspaceCount: 1, pendingInviteCount: 0 },
      };
    }
    if (path === `/v1/orgs/${ORG}/transfer-ownership` && init?.method === "POST") return { ok: true };
    if (path === `/v1/orgs/${ORG}/workspaces`) return { organizationId: ORG, summary: { totalWorkspaces: 0 }, callerCanSeeBilling: true, workspaces: [] };
    if (path === `/v1/orgs/${ORG}/audit-events`) return { organizationId: ORG, summary: { totalEvents: 0 }, events: [] };
    if (path === `/v1/orgs/${ORG}/invites`) return { organizationId: ORG, summary: { totalPending: 0 }, invites: [] };
    if (path === `/v1/orgs/${ORG}/closure`) return { request: null, blockers: [], confirmationPhrase: "close this organization" };
    return {};
  });
});
afterEach(cleanup);

describe("ownership transfer in an organization of more than 200 members", () => {
  it("finds member 250 by search and transfers ownership to them", async () => {
    render(<OrganizationPage />);
    const search = await screen.findByLabelText("Search members for the new owner");
    fireEvent.change(search, { target: { value: "Member 250" } });
    await vi.waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([p]) => String(p).includes("q=Member%20250"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New owner" }));
    fireEvent.click(await screen.findByRole("option", { name: "Member 250" }));
    fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
    await vi.waitFor(() => {
      const post = mocks.fetch.mock.calls.find(
        ([p, init]) => p === `/v1/orgs/${ORG}/transfer-ownership` && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body)).targetUserId).toBe("user-250");
    });
  });
});
