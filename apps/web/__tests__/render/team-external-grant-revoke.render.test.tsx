import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/people", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

import { TeamAccessReviewCard } from "../../app/(app)/teams/[id]/components/TeamAccessReviewCard";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT_A = "11111111-1111-4111-8111-111111111111";
const GRANT_B = "22222222-2222-4222-8222-222222222222";
let grants = [
  { grantId: GRANT_A, caseId: "c-a", caseName: "Warehouse fire", grantedAt: "2026-01-01T00:00:00.000Z" },
  { grantId: GRANT_B, caseId: "c-b", caseName: "Harbour audit", grantedAt: "2026-02-01T00:00:00.000Z" },
];
function review() {
  return {
    teamId: TEAM,
    summary: { internalMembers: 1, pendingInvites: 0, externalCollaborators: grants.length ? 1 : 0 },
    members: [],
    pendingInvites: [],
    externalCollaborators: grants.length
      ? [{ kind: "EXTERNAL", userId: "ext-user", email: "counsel@example.org", displayName: "Dana Counsel", firstGrantedAt: "2026-01-01T00:00:00.000Z", grants }]
      : [],
  };
}
function reply(path: string, init?: RequestInit): unknown {
  if (init?.method === "DELETE") {
    const id = path.split("/").pop();
    grants = grants.filter((g) => g.grantId !== id);
    return { ok: true, grantId: id };
  }
  if (path === `/v1/teams/${TEAM}/access-review`) return review();
  return {};
}
const deletes = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
async function expand() {
  render(<TeamAccessReviewCard teamId={TEAM} />);
  const toggle = await screen.findByRole("button", { name: "Show cases for Dana Counsel" });
  fireEvent.click(toggle);
  return toggle;
}
const revokeA = () => screen.getByRole("button", { name: "Revoke Dana Counsel's access to Warehouse fire" });

beforeEach(() => {
  grants = [
    { grantId: GRANT_A, caseId: "c-a", caseName: "Warehouse fire", grantedAt: "2026-01-01T00:00:00.000Z" },
    { grantId: GRANT_B, caseId: "c-b", caseName: "Harbour audit", grantedAt: "2026-02-01T00:00:00.000Z" },
  ];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("workspace external-grant revoke", () => {
  it("expands a collaborator to their cases", async () => {
    const toggle = await expand();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "Cases Dana Counsel can access" });
    expect(within(list).getByText("Warehouse fire")).toBeTruthy();
    expect(within(list).getByText("Harbour audit")).toBeTruthy();
    expect(screen.queryByText(/open the relevant case to change them/)).toBeNull();
  });

  it("revokes after a confirmation naming person and case, and announces only after the reread", async () => {
    await expand();
    fireEvent.click(revokeA());
    await screen.findByText("Dana Counsel no longer has access to Warehouse fire.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove Dana Counsel's access to Warehouse fire?", tone: "danger" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "DELETE");
    expect(calls[write][0]).toBe(`/v1/teams/${TEAM}/external-grants/${GRANT_A}`);
    expect(calls.slice(write + 1).some(([path]) => path === `/v1/teams/${TEAM}/access-review`)).toBe(true);
    expect(screen.queryByText("Warehouse fire")).toBeNull();
    expect(screen.getByText("Harbour audit")).toBeTruthy();
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    await expand();
    fireEvent.click(revokeA());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(deletes()).toHaveLength(0);
    expect(revokeA().hasAttribute("disabled")).toBe(false);
  });

  it("does not claim success when the reread still lists the grant", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => (init?.method === "DELETE" ? { ok: true } : reply(path, init)));
    await expand();
    fireEvent.click(revokeA());
    await screen.findByText(/still lists this grant/);
    expect(screen.queryByText(/no longer has access/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    let deleted = false;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return { ok: true }; }
      if (deleted) throw { statusCode: 503 };
      return reply(path, init);
    });
    await expand();
    fireEvent.click(revokeA());
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/no longer has access/)).toBeNull();
  });

  it("explains a grant the workspace cannot remove and rereads", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw { statusCode: 404, code: "GRANT_NOT_FOUND" };
      return reply(path, init);
    });
    await expand();
    const before = mocks.fetch.mock.calls.length;
    fireEvent.click(revokeA());
    await screen.findByText(/the case owner must remove it from the case/);
    expect(mocks.fetch.mock.calls.slice(before).some(([p, init]) => p === `/v1/teams/${TEAM}/access-review` && !init)).toBe(true);
  });

  it("points an internal member to Members", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw { statusCode: 422, code: "INTERNAL_MEMBER" };
      return reply(path, init);
    });
    await expand();
    fireEvent.click(revokeA());
    await screen.findByText(/managed from Members, not here/);
  });

  it("shows the access gate on a refused revoke", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw { statusCode: 403 };
      return reply(path, init);
    });
    await expand();
    fireEvent.click(revokeA());
    await waitFor(() => expect(document.querySelector("[data-team-access-review-forbidden]")).not.toBeNull());
  });

  it("disables the other revoke controls with a reason while one is in flight", async () => {
    let release!: () => void;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Promise((resolve) => { release = () => resolve({ ok: true }); });
      return reply(path, init);
    });
    await expand();
    fireEvent.click(revokeA());
    const other = screen.getByRole("button", { name: "Revoke Dana Counsel's access to Harbour audit" });
    await waitFor(() => expect(other.hasAttribute("disabled")).toBe(true));
    expect(other.getAttribute("data-disabled-reason")).toBe("Another access removal is in progress. Wait for it to finish.");
    release();
  });

  it("never renders a refused read as empty", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 403 });
    render(<TeamAccessReviewCard teamId={TEAM} />);
    await waitFor(() => expect(document.querySelector("[data-team-access-review-forbidden]")).not.toBeNull());
    expect(document.querySelector("[data-team-access-review-empty]")).toBeNull();
  });

  it("never renders a failed read as empty and offers a retry", async () => {
    mocks.fetch.mockRejectedValueOnce({ statusCode: 500 });
    render(<TeamAccessReviewCard teamId={TEAM} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(document.querySelector("[data-team-access-review-empty]")).toBeNull();
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Show cases for Dana Counsel" });
  });
});
