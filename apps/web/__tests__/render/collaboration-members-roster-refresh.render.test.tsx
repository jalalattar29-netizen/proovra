/**
 * PRO-K2-07 / PRO-K2-19 / PRO-K2-18 — the Collaboration Team Members tab.
 *
 * K2-07: after Remove / Suspend the roster PAGE is reloaded from the server, not
 * only the parent team detail (the page was keyed on team id + search text, so
 * the removed member stayed on screen with live action buttons).
 * K2-19: a suspended member is reachable (Suspended view) and can be reinstated.
 * K2-18: the at-capacity Upgrade link appears only when the server says
 * upgrading is the remedy.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/ui", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useToast: () => ({ addToast: mocks.toast }),
}));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpace: () => ({ plan: "PRO" }),
  usePlatformContext: () => ({ context: null }),
  // RG-14 (WS-ENT) — the tab also asks the plan whether team tasks are included.
  usePlanFeature: () => true,
}));

import { MembersTab } from "../../app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const LEAD = { id: "m-lead", userId: "u-lead", role: "LEAD", status: "ACTIVE", displayName: "Lead Person" };
const DANA = { id: "m-dana", userId: "u-dana", role: "MEMBER", status: "ACTIVE", displayName: "Dana" };
const SAM = { id: "m-sam", userId: "u-sam", role: "MEMBER", status: "SUSPENDED", displayName: "Sam" };

function row(m: typeof LEAD) {
  return { ...m, joinedAt: "2026-11-01T00:00:00Z", suspendedAt: null, removedAt: null, email: null, avatarUrl: null };
}

function team() {
  return {
    id: TEAM_ID,
    status: "ACTIVE",
    // PRO-K2-08 (WS-ENT) — each row control follows the viewer's own group role.
    viewerRole: "LEAD",
    activeMemberCount: 2,
    capacityMemberCount: 2,
    memberPreviewLimit: 25,
    members: [LEAD, DANA].map((m) => ({ ...row(m), user: { id: m.userId, email: null, displayName: m.displayName, firstName: null, lastName: null, avatarUrl: null } })),
  } as never;
}

let current: Array<typeof LEAD>;
let upgradeHref: string | null;
const rosterReads: string[] = [];

function serve() {
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/entitlement")) {
      return { collaborationTeamMembers: { limit: 5 }, upgradeHref };
    }
    if (path.includes(`/${TEAM_ID}/members`) && (!init || !init.method || init.method === "GET")) {
      rosterReads.push(path);
      const suspendedView = path.includes("status=SUSPENDED");
      const rows = current.filter((m) => (suspendedView ? m.status === "SUSPENDED" : m.status === "ACTIVE"));
      return { members: rows.map(row), nextCursor: null, totalActive: rows.length };
    }
    if (init?.method === "DELETE" && path.endsWith("/members/m-dana")) {
      current = current.filter((m) => m.id !== "m-dana");
      return { ok: true };
    }
    if (init?.method === "PATCH" && path.endsWith("/members/m-sam")) {
      current = current.map((m) => (m.id === "m-sam" ? { ...m, status: "ACTIVE" } : m));
      return { ok: true };
    }
    return {};
  });
}

describe("Collaboration Team Members tab", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.toast.mockReset();
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    current = [LEAD, DANA, SAM];
    upgradeHref = null;
    rosterReads.length = 0;
    serve();
  });
  afterEach(() => {
    cleanup();
  });

  it("PRO-K2-07 — Remove reloads the roster page, so the removed member leaves the screen", async () => {
    render(<MembersTab team={team()} onRefresh={async () => {}} canManage canInvite={false} />);
    await screen.findByTestId("member-remove-m-dana");
    const readsBefore = rosterReads.length;
    fireEvent.click(screen.getByTestId("member-remove-m-dana"));
    await waitFor(() => expect(screen.queryByTestId("member-row-m-dana")).toBeNull());
    expect(rosterReads.length).toBeGreaterThan(readsBefore);
  });

  it("PRO-K2-19 — a suspended member is listed in the Suspended view and can be reinstated", async () => {
    render(<MembersTab team={team()} onRefresh={async () => {}} canManage canInvite={false} />);
    await screen.findByTestId("member-row-m-dana");
    expect(screen.queryByTestId("member-row-m-sam")).toBeNull();
    // The status filter is the product listbox (no native select in the product).
    fireEvent.click(screen.getByRole("combobox", { name: "Show members" }));
    fireEvent.click(screen.getByRole("option", { name: "Suspended members" }));
    fireEvent.click(await screen.findByTestId("member-reinstate-m-sam"));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${TEAM_ID}/members/m-sam`),
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("member-row-m-sam")).toBeNull());
  });

  it("PRO-K2-18 — at capacity, Upgrade is offered only when the server names an upgrade path", async () => {
    current = [LEAD, DANA];
    const full = { ...(team() as object), capacityMemberCount: 5 } as never;
    render(<MembersTab team={full} onRefresh={async () => {}} canManage canInvite />);
    await screen.findByTestId("members-at-capacity-notice");
    expect(screen.queryByTestId("members-at-capacity-upgrade")).toBeNull();
    cleanup();
    upgradeHref = "/billing?upgrade=TEAM";
    render(<MembersTab team={full} onRefresh={async () => {}} canManage canInvite />);
    const link = await screen.findByTestId("members-at-capacity-upgrade");
    expect(link.getAttribute("href")).toBe("/billing?upgrade=TEAM");
  });
});
