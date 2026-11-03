/**
 * CAP-10 — the organization member roster reads one page and reaches the rest
 * with Load more. The API used to return every member at once.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
  isApiResponseError: () => false,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => false }) }));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...((await orig()) as object),
  usePlatformContext: () => ({ refresh: async () => {}, envelope: { user: { id: "me-user" } } }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/admin/members",
  useSearchParams: () => new URLSearchParams(),
}));

import OrgAdminMembersPage from "../../app/(app)/organizations/[id]/admin/members/page";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function member(n: number) {
  return {
    membershipId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    userId: `user-${n}`,
    email: `m${n}@example.org`,
    displayName: `Member ${n}`,
    role: n === 1 ? "ORG_OWNER" : "ORG_MEMBER",
    memberSince: "2026-01-01T00:00:00.000Z",
    status: "ACTIVE",
    statusChangedAtUtc: null,
    suspendedAtUtc: null,
    suspensionReason: null,
    revokedAtUtc: null,
    revocationReason: null,
  };
}
const first = Array.from({ length: 50 }, (_, i) => member(i + 1));
const second = [member(51)];
const summary = { totalMembers: 51, byRole: { ORG_OWNER: 1, ORG_MEMBER: 50 }, byStatus: { ACTIVE: 51 } };
const memberReads = () => mocks.fetch.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith(`/v1/orgs/${ORG}/members`));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === `/v1/orgs/${ORG}/members`) return { organizationId: ORG, summary, members: first, nextCursor: first[49].membershipId };
    if (path.startsWith(`/v1/orgs/${ORG}/members?cursor=`)) return { organizationId: ORG, summary, members: second, nextCursor: null };
    if (path === `/v1/orgs/${ORG}`) return { id: ORG, name: "Acme Legal", callerRole: "ORG_OWNER", adminSurfaces: ["members"], organizationKind: "CUSTOMER", summary: { memberCount: 51, workspaceCount: 1, pendingInviteCount: 0 } };
    if (path === `/v1/orgs/${ORG}/invites`) return { summary: { totalPending: 0 }, invites: [] };
    if (path === `/v1/orgs/${ORG}/workspaces`) return { workspaces: [] };
    return {};
  });
});
afterEach(cleanup);

describe("CAP-10 — paged organization roster", () => {
  it("shows the first page, then the 51st member after Load more", async () => {
    render(<OrgAdminMembersPage />);
    const list = await screen.findByTestId("members-list");
    await within(list).findByText("Showing 50 of 51 members");
    expect(within(list).queryByText("Member 51")).toBeNull();
    fireEvent.click(within(list).getByTestId("org-members-load-more"));
    await within(list).findByText("Member 51");
    expect(memberReads().at(-1)).toBe(`/v1/orgs/${ORG}/members?cursor=${encodeURIComponent(first[49].membershipId)}`);
    expect(within(list).queryByTestId("org-members-load-more")).toBeNull();
    expect(within(list).getByText("Member 1")).toBeTruthy();
  });
});
