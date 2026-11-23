/**
 * TEAM-SPEC §3 "Team membership surfaces":
 *   - a peer ADMIN's row offers no role or Remove control (the server refuses
 *     with `rank_insufficient`); the OWNER can manage an ADMIN;
 *   - `rank_insufficient` has its own customer copy (not "Failed to update role");
 *   - the account menu's Organizations link counts CUSTOMER organizations
 *     only, so an OWNED-only member is not sent to an empty list.
 * Driven with the real apiFetch over a stubbed transport.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn(),
  }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));

import {
  RANK_INSUFFICIENT_MESSAGE,
  WorkspaceMembersPanel,
} from "../../app/(app)/teams/[id]/components/WorkspaceMembersPanel";
import { resolveAccountMenu, type AccountMenuInput } from "../../lib/navigation/accountMenu";

const TEAM = "team-1";
const OWNER = { id: "m-owner", userId: "u-owner", role: "OWNER", status: "ACTIVE", user: { displayName: "Olive Owner" } };
const ADMIN_A = { id: "m-a", userId: "u-a", role: "ADMIN", status: "ACTIVE", user: { displayName: "Ada Admin" } };
const ADMIN_B = { id: "m-b", userId: "u-b", role: "ADMIN", status: "ACTIVE", user: { displayName: "Ben Admin" } };
const MEMBER = { id: "m-c", userId: "u-c", role: "MEMBER", status: "ACTIVE", user: { displayName: "Cy Member" } };

let patchReply: { status: number; body: unknown } = { status: 200, body: {} };
const patches: string[] = [];

beforeEach(() => {
  patches.length = 0;
  patchReply = { status: 200, body: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        patches.push(path);
        return new Response(JSON.stringify(patchReply.body), {
          status: patchReply.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.startsWith(`/v1/teams/${TEAM}/members`)) {
        return new Response(
          JSON.stringify({ members: [OWNER, ADMIN_A, ADMIN_B, MEMBER], nextCursor: null, total: 4 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(currentUserId: string, notify = vi.fn()) {
  render(
    <WorkspaceMembersPanel
      teamId={TEAM}
      currentUserId={currentUserId}
      canManageTeam
      onInvite={() => {}}
      onRemove={() => {}}
      notify={notify}
    />,
  );
  return notify;
}

describe("peer ADMIN rows are read-only; the OWNER manages admins", () => {
  it("an ADMIN sees no role or Remove control on another ADMIN, but can manage a MEMBER", async () => {
    mount(ADMIN_A.userId);
    await screen.findByText("Ben Admin");
    expect(screen.queryByRole("combobox", { name: "Workspace role for Ben Admin" })).toBeNull();
    expect(document.querySelector(`[data-testid="member-remove-${ADMIN_B.id}"]`)).toBeNull();
    expect(document.querySelector(`[data-testid="member-rank-locked-${ADMIN_B.id}"]`)).toBeTruthy();
    // The MEMBER row is still manageable by the ADMIN.
    expect(screen.getByRole("combobox", { name: "Workspace role for Cy Member" })).toBeTruthy();
    expect(document.querySelector(`[data-testid="member-remove-${MEMBER.id}"]`)).toBeTruthy();
  });

  it("the OWNER can change and remove an ADMIN", async () => {
    mount(OWNER.userId);
    await screen.findByText("Ben Admin");
    expect(screen.getByRole("combobox", { name: "Workspace role for Ben Admin" })).toBeTruthy();
    expect(document.querySelector(`[data-testid="member-remove-${ADMIN_B.id}"]`)).toBeTruthy();
  });

  it("a rank_insufficient refusal is explained, not reported as a generic failure", async () => {
    patchReply = { status: 403, body: { error: { code: "rank_insufficient", requestId: "r1" } } };
    const notify = mount(ADMIN_A.userId);
    await screen.findByText("Cy Member");
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace role for Cy Member" }));
    fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() => expect(patches).toEqual([`/v1/teams/${TEAM}/members/${MEMBER.id}`]));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(RANK_INSUFFICIENT_MESSAGE, "error"));
    expect(notify).not.toHaveBeenCalledWith("Failed to update role", "error");
  });
});

describe("account menu — Organizations counts CUSTOMER organizations only", () => {
  const base = (overrides: Partial<AccountMenuInput>): AccountMenuInput => ({
    capabilities: { ACCOUNT_SETTINGS_VIEW: true, ACCOUNT_BILLING_VIEW: true },
    isPlatformAdmin: false,
    activeSpace: { type: "PERSONAL", id: "personal-1" },
    personalSpace: { id: "personal-1", status: "active" },
    organizations: [],
    accountPlan: "TEAM",
    contextOptions: null,
    ...overrides,
  });
  const org = (id: string) => ({
    id,
    name: id,
    displayName: id,
    role: "MEMBER" as const,
    membershipStatus: "ACTIVE" as const,
  });

  it("a member of a legacy OWNED workspace only gets no Organizations link", () => {
    const m = resolveAccountMenu(
      base({
        organizations: [org("owned-1")],
        contextOptions: {
          personalSpace: { workspaceId: "personal-1", name: "Personal Space", role: "OWNER" },
          ownedWorkspaces: [{ workspaceId: "owned-1", name: "Legacy Desk", role: "MEMBER" }],
          organizations: [],
        },
      }),
    );
    expect(m.organization).toEqual([]);
  });

  it("a member of a CUSTOMER organization workspace gets the link", () => {
    const m = resolveAccountMenu(
      base({
        organizations: [org("org-ws-1")],
        contextOptions: {
          personalSpace: { workspaceId: "personal-1", name: "Personal Space", role: "OWNER" },
          ownedWorkspaces: [],
          organizations: [
            {
              organizationId: "org-1",
              organizationName: "Acme",
              workspaces: [{ workspaceId: "org-ws-1", workspaceName: "Acme Legal", workspaceRole: "MEMBER" }],
            },
          ],
        },
      }),
    );
    expect(m.organization.map((l) => l.href)).toEqual(["/organizations"]);
  });

  it("an explicit SYSTEM organizationKind never counts", () => {
    const m = resolveAccountMenu(
      base({ organizations: [{ ...org("x"), organizationKind: "SYSTEM" }] }),
    );
    expect(m.organization).toEqual([]);
  });
});
