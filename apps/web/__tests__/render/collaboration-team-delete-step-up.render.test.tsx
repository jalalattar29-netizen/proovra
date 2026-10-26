/**
 * MEMBERS AUDIT SEC-03 — deleting a Collaboration Team is irreversible, and
 * the API now requires a fresh factor bound to the group. The real Settings tab
 * must answer STEP_UP_REQUIRED with the ONE step-up dialog (not an error
 * toast), must not report a deletion that did not happen, and must still
 * delete when the server accepts.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: () => {}, refresh: () => {} }) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));
vi.mock("../../components/ui", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useToast: () => ({ addToast: mocks.toast }),
}));

import { SettingsTab } from "../../app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

const team = {
  id: TEAM_ID,
  workspaceId: WS,
  name: "Intake",
  description: null,
  teamType: "GENERAL",
  status: "ACTIVE",
  members: [],
} as never;

function stepUpRequired() {
  const err = new Error("Step-up required") as Error & Record<string, unknown>;
  err.code = "STEP_UP_REQUIRED";
  err.statusCode = 401;
  err.details = { purpose: "SESSION_SANITY_CHECK", resourceKind: "collaboration_team", resourceId: TEAM_ID };
  return err;
}

function serve(onDelete: () => unknown) {
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/disposability")) return { disposition: { disposable: true, blockers: [] } };
    if (init?.method === "DELETE") return onDelete();
    return {};
  });
}

function renderTab() {
  return render(
    <SettingsTab
      team={team}
      onChange={async () => {}}
      canManage
      canArchive
      canDelete
      canTransferLead={false}
      onError={() => {}}
    />,
  );
}

async function pressDelete() {
  const button = await screen.findByTestId("settings-delete");
  fireEvent.click(button);
}

describe("Collaboration Team delete — SEC-03 step-up", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.toast.mockReset();
    mocks.push.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("STEP_UP_REQUIRED opens the step-up dialog; nothing is reported deleted and no error toast is shown", async () => {
    serve(() => {
      throw stepUpRequired();
    });
    renderTab();
    await pressDelete();
    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success" || kind === "error")).toBe(false);
  });

  it("when the server accepts, the group is deleted and the person is taken back to the list", async () => {
    serve(() => undefined);
    renderTab();
    await pressDelete();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/collaboration-teams"));
    expect(screen.queryByRole("dialog", { name: "Step-up confirmation" })).toBeNull();
  });
});
