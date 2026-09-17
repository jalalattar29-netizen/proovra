import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  platform: { envelope: { user: { id: "me-user" } }, contextGeneration: 1 },
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
function person(n: number, extra: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, userId: `user-${n}`, role: "MEMBER", status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", label: `Person ${n}`, user: { id: `user-${n}`, displayName: `Person ${n}`, email: `p${n}@example.org` }, ...extra };
}
const firstPage = Array.from({ length: 50 }, (_, i) => person(i + 1));
const secondPage = [person(51)];
let roles: Record<string, string> = {};

function team() {
  // The detail payload embeds only the first 50 — the bug this surface fixes.
  return { id: TEAM, name: "Casework", ownerUserId: "owner-user", canManageMembers: true, canManageWorkspace: false, stats: { memberCount: 51, pendingInviteCount: 0, caseCount: 0 }, members: firstPage };
}
function membersReply(path: string) {
  const url = new URL(path, "http://x");
  const q = url.searchParams.get("q");
  const status = url.searchParams.get("status");
  if (q) {
    const hits = [...firstPage, ...secondPage].filter((m) => m.user.displayName.toLowerCase().includes(q.toLowerCase()));
    return { members: hits, nextCursor: null, total: hits.length };
  }
  if (status === "SUSPENDED") return { members: [person(52, { status: "SUSPENDED", user: { id: "user-52", displayName: "Paused Person", email: null } })], nextCursor: null, total: 1 };
  const apply = (rows: ReturnType<typeof person>[]) => rows.map((m) => ({ ...m, role: roles[m.id] ?? m.role }));
  if (url.searchParams.get("cursor")) return { members: apply(secondPage), nextCursor: null, total: 51 };
  const limit = Number(url.searchParams.get("limit"));
  if (limit > 50) return { members: apply([...firstPage, ...secondPage]), nextCursor: null, total: 51 };
  return { members: apply(firstPage), nextCursor: firstPage[49].id, total: 51 };
}
function reply(path: string, init?: RequestInit): unknown {
  if (init?.method === "PATCH") {
    const id = path.split("/").pop()!;
    const role = JSON.parse(String(init.body)).role;
    roles[id] = role;
    return { member: { id, role } };
  }
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return membersReply(path);
  if (path === `/v1/teams/${TEAM}`) return team();
  if (path === `/v1/teams/${TEAM}/invites`) return { invites: [] };
  if (path === `/v1/teams/${TEAM}/cases`) return { items: [] };
  if (path === `/v1/teams/${TEAM}/activity`) return { activities: [] };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  return {};
}
const memberReads = () => mocks.fetch.mock.calls.filter(([p]) => String(p).startsWith(`/v1/teams/${TEAM}/members?`)).map(([p]) => new URL(String(p), "http://x").searchParams);
async function roster() {
  render(<TeamDetailPage />);
  await screen.findByText("Showing 50 of 51 people");
  return screen.getByTestId("people-roster");
}

beforeEach(() => {
  roles = {};
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.toast.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("workspace people — server-paged roster", () => {
  it("reads the paged members route and reaches the 51st member with Load more", async () => {
    const panel = await roster();
    expect(memberReads()[0].get("limit")).toBe("50");
    expect(memberReads()[0].has("cursor")).toBe(false);
    expect(within(panel).queryByText("Person 51")).toBeNull();
    fireEvent.click(within(panel).getByTestId("people-load-more"));
    await within(panel).findByText("Person 51");
    expect(memberReads().at(-1)!.get("cursor")).toBe(firstPage[49].id);
    expect(within(panel).getByText("Showing 51 of 51 people")).toBeTruthy();
    expect(within(panel).queryByTestId("people-load-more")).toBeNull();
  });

  it("searches on the server and finds a member the detail payload never carried", async () => {
    const panel = await roster();
    fireEvent.change(within(panel).getByLabelText("Search members"), { target: { value: "Person 51" } });
    await within(panel).findByText("Showing 1 of 1 matching person");
    expect(within(panel).getByText("Person 51")).toBeTruthy();
    const last = memberReads().at(-1)!;
    expect(last.get("q")).toBe("Person 51");
    expect(last.has("cursor")).toBe(false);
  });

  it("filters by status on the server and resets the cursor", async () => {
    const panel = await roster();
    fireEvent.click(within(panel).getByTestId("people-load-more"));
    await within(panel).findByText("Person 51");
    fireEvent.click(within(panel).getByRole("combobox", { name: /Filter members by status/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Suspended" }));
    await within(panel).findByText("Paused Person");
    const last = memberReads().at(-1)!;
    expect(last.get("status")).toBe("SUSPENDED");
    expect(last.has("cursor")).toBe(false);
    expect(within(panel).getAllByText("Suspended").length).toBeGreaterThan(0);
  });

  it("never renders a failed roster read as empty", async () => {
    let fail = true;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).startsWith(`/v1/teams/${TEAM}/members?`) && fail) throw { statusCode: 500 };
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    const error = await screen.findByTestId("people-error");
    expect(screen.queryByTestId("people-empty")).toBeNull();
    fail = false;
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    await screen.findByText("Showing 50 of 51 people");
  });

  it("reports a refused roster read as refused, not empty", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).startsWith(`/v1/teams/${TEAM}/members?`)) throw { statusCode: 403 };
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    await screen.findByText(/no longer have access to this workspace's members/);
    expect(screen.queryByTestId("people-empty")).toBeNull();
  });

  it("changes a role and announces it only after rereading the loaded rows", async () => {
    const panel = await roster();
    fireEvent.click(within(panel).getByTestId("people-load-more"));
    await within(panel).findByText("Person 51");
    fireEvent.click(within(panel).getByRole("combobox", { name: /Workspace role for Person 51/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Person 51 is now Viewer", "success"));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "PATCH");
    expect(calls[write][0]).toBe(`/v1/teams/${TEAM}/members/${secondPage[0].id}`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ role: "VIEWER" });
    const reread = calls.slice(write + 1).find(([p]) => String(p).startsWith(`/v1/teams/${TEAM}/members?`));
    expect(new URL(String(reread![0]), "http://x").searchParams.get("limit")).toBe("51");
    // The 51st member is still on screen after the reread.
    expect(within(panel).getByText("Person 51")).toBeTruthy();
  });

  it("does not announce a role change the reread contradicts", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { member: {} };
      return reply(path, init);
    });
    const panel = await roster();
    fireEvent.click(within(panel).getByRole("combobox", { name: /Workspace role for Person 1$/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/reloaded list shows a different role/), "error"));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/is now Admin/), "success");
  });

  it("ignores a stale page after the search changes", async () => {
    let releaseOld!: (v: unknown) => void;
    let first = true;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).startsWith(`/v1/teams/${TEAM}/members?`) && first) {
        first = false;
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      return reply(path, init);
    });
    render(<TeamDetailPage />);
    const search = await screen.findByLabelText("Search members");
    fireEvent.change(search, { target: { value: "Person 51" } });
    await screen.findByText("Showing 1 of 1 matching person");
    await act(async () => { releaseOld(membersReply(`/v1/teams/${TEAM}/members?limit=50`)); });
    expect(screen.getByText("Showing 1 of 1 matching person")).toBeTruthy();
    expect(screen.queryByText("Person 2")).toBeNull();
  });
});
