/**
 * MEMBERS RE-AUDIT, SECOND ROUND — DEFECT 2: a case restricted only by its
 * flag is never shown as open.
 *
 * After a departure empties a restricted case's list, the case stays
 * restricted (`restricted_at_utc`): only its owner can open it. The Matter
 * Access tab used to decide "restricted" from the two lists alone, so it told
 * the owner the case was "Open to the whole workspace" and asked them to
 * confirm restricting a case that already was. The server now projects
 * `restricted`; the tab renders it.
 *
 * The real MatterAccessTab is mounted; only the API client, the confirm
 * dialog and the member picker (a search control with its own fetches) are
 * replaced.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  confirm: vi.fn(async (_opts: unknown) => true),
  detail: { restricted: false as boolean, restrictedAtUtc: null as string | null },
}));

vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/(app)/evidence/[id]/components/WorkspaceMemberSelect", () => ({
  WorkspaceMemberSelect: ({ onChange }: { onChange: (m: { userId: string; label: string; role: string }) => void }) => (
    <button type="button" data-test-pick onClick={() => onChange({ userId: "user-pat", label: "Pat", role: "MEMBER" })}>
      pick Pat
    </button>
  ),
}));

import { MatterAccessTab } from "../../components/cases-experience/MatterAccessTab";

const CASE = "c2000000-0000-4000-8000-000000000002";
const TEAM = "t2000000-0000-4000-8000-000000000002";
const OWNER = "user-owner";

function reply(path: string, init?: RequestInit): unknown {
  if (path === `/v1/cases/${CASE}`) {
    return {
      case: { id: CASE, ownerUserId: OWNER, access: [], teamAccess: [], ...mocks.detail },
    };
  }
  if (path === `/v1/cases/${CASE}/team-members`) return { items: [] };
  if (path === `/v1/cases/${CASE}/team-access/candidates`) return { items: [] };
  if (path === `/v1/cases/${CASE}/access` && init?.method === "POST") return { access: { id: "g1" } };
  return {};
}

function mount() {
  return render(
    <MatterAccessTab caseId={CASE} teamId={TEAM} caseOwnerUserId={OWNER} viewer={{ userId: OWNER, canManageAccess: true }} />,
  );
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockClear();
});
afterEach(cleanup);

describe("Matter Access — a flag-only restriction (defect 2)", () => {
  it("a case the server reports restricted, with an empty list, is NOT shown as open to the whole workspace", async () => {
    mocks.detail = { restricted: true, restrictedAtUtc: "2026-10-20T10:00:00.000Z" };
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("[data-matter-access-owner-only]")).not.toBeNull());
    expect(screen.getByText(/only the case owner can\s+open it/i)).toBeTruthy();
    expect(screen.queryByText("Open to the whole workspace")).toBeNull();
    expect(container.querySelector('[data-matter-access-mode="workspace"]')).toBeNull();
  });

  it("the raw flag alone (older server without `restricted`) is enough", async () => {
    mocks.detail = { restricted: undefined as never, restrictedAtUtc: "2026-10-20T10:00:00.000Z" };
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-matter-access-mode="restricted"]')).not.toBeNull());
    expect(screen.queryByText("Open to the whole workspace")).toBeNull();
  });

  it("control: an unrestricted case IS shown as open to the whole workspace", async () => {
    mocks.detail = { restricted: false, restrictedAtUtc: null };
    const { container } = mount();
    await screen.findByText("Open to the whole workspace");
    expect(container.querySelector('[data-matter-access-mode="restricted"]')).toBeNull();
  });

  it("granting on a flag-only case does not ask to 'restrict' it again; on an open case it does", async () => {
    mocks.detail = { restricted: true, restrictedAtUtc: "2026-10-20T10:00:00.000Z" };
    const first = mount();
    await waitFor(() => expect(first.container.querySelector("[data-matter-access-owner-only]")).not.toBeNull());
    fireEvent.click(screen.getByText("pick Pat"));
    fireEvent.click(first.container.querySelector("[data-matter-access-grant]") as HTMLElement);
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(`/v1/cases/${CASE}/access`, expect.objectContaining({ method: "POST" })),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    cleanup();

    mocks.fetch.mockClear();
    mocks.detail = { restricted: false, restrictedAtUtc: null };
    const second = mount();
    await screen.findByText("Open to the whole workspace");
    fireEvent.click(screen.getByText("pick Pat"));
    fireEvent.click(second.container.querySelector("[data-matter-access-grant]") as HTMLElement);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0][0]).toMatchObject({ title: "Restrict this case to named people?" });
  });
});
