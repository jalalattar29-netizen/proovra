/**
 * ARCHIVE COLLABORATION TEAM (2026-10-28) — the real Settings tab.
 *
 * A Collaboration Team is never deleted. The destructive action says
 * "Archive Collaboration Team"; before the step-up it shows the server's impact
 * preview and requires the team's exact name; the step-up is the ONE dialog
 * (no error toast, nothing reported archived until the server accepts); and an
 * archived team offers Restore to whoever may archive, even though its edit
 * controls are gone.
 *
 * (The file keeps its name from the step-up delete it used to cover; that
 * delete was retired with the hard-delete route.)
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), push: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: () => {}, refresh: () => {} }) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/ui", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useToast: () => ({ addToast: mocks.toast }),
}));

import { SettingsTab } from "../../app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function makeTeam(status: "ACTIVE" | "ARCHIVED") {
  return {
    id: TEAM_ID,
    workspaceId: WS,
    name: "Intake Desk",
    description: null,
    teamType: "GENERAL",
    status,
    members: [],
  } as never;
}

const IMPACT = {
  teamId: TEAM_ID,
  teamName: "Intake Desk",
  status: "ACTIVE",
  acceptedMembers: 4,
  caseGrants: 2,
  openAssignments: 3,
  pendingInvites: 1,
  unavailable: ["case_access_through_team", "new_tasks"],
  preserved: ["team_record", "membership_history", "audit_history"],
  restore: { requestable: true, rechecks: ["plan_entitlement"] },
};

function stepUpRequired() {
  const err = new Error("Step-up required") as Error & Record<string, unknown>;
  err.code = "STEP_UP_REQUIRED";
  err.statusCode = 401;
  err.details = { purpose: "COLLABORATION_TEAM_ARCHIVE", resourceKind: "collaboration_team", resourceId: TEAM_ID };
  return err;
}

const archiveCalls: Array<{ body: unknown; headers: unknown }> = [];

function serve(opts: { onArchive: () => unknown; impactFails?: boolean }) {
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/archive-impact")) {
      if (opts.impactFails) throw new Error("boom");
      return { impact: IMPACT };
    }
    if (path.endsWith("/archive") && init?.method === "POST") {
      archiveCalls.push({ body: JSON.parse(String(init.body)), headers: init.headers });
      return opts.onArchive();
    }
    if (path.includes("/step-up/start")) {
      return { challenge: { id: "33333333-3333-4333-8333-333333333333" }, method: "TOTP", availableMethods: ["TOTP"] };
    }
    return {};
  });
}

function renderTab(status: "ACTIVE" | "ARCHIVED", caps: { canManage: boolean; canArchive: boolean }) {
  return render(
    <SettingsTab
      team={makeTeam(status)}
      onChange={async () => {}}
      canManage={caps.canManage}
      canArchive={caps.canArchive}
      canTransferLead={false}
      onError={() => {}}
    />,
  );
}

async function openArchiveDialog() {
  fireEvent.click(await screen.findByTestId("settings-archive"));
  return screen.findByTestId("archive-team-dialog");
}

describe("Archive Collaboration Team — Settings tab", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.toast.mockReset();
    mocks.push.mockReset();
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    archiveCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it("names the action Archive Collaboration Team and offers no delete", async () => {
    serve({ onArchive: () => ({ ok: true }) });
    renderTab("ACTIVE", { canManage: true, canArchive: true });
    const button = await screen.findByTestId("settings-archive");
    expect(button.textContent).toBe("Archive Collaboration Team");
    expect(screen.queryByTestId("settings-delete")).toBeNull();
    expect(screen.queryByText(/delete team/i)).toBeNull();
  });

  it("shows the server's impact preview and requires the exact team name before submitting", async () => {
    serve({ onArchive: () => ({ ok: true }) });
    renderTab("ACTIVE", { canManage: true, canArchive: true });
    await openArchiveDialog();
    expect((await screen.findByTestId("archive-impact-members")).textContent).toContain("4 members");
    expect(screen.getByTestId("archive-impact-cases").textContent).toContain("2 Case grants");
    expect(screen.getByTestId("archive-impact-tasks").textContent).toContain("3 open tasks");
    expect(screen.getByTestId("archive-impact-invites").textContent).toContain("1 pending invitation");
    expect(screen.getByTestId("archive-impact-restore").textContent).toMatch(/can restore/i);
    const submit = screen.getByTestId("archive-team-submit") as HTMLButtonElement;
    expect(submit.textContent).toBe("Archive Collaboration Team");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("archive-confirm-name"), { target: { value: "intake desk" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("archive-confirm-name"), { target: { value: "Intake Desk" } });
    expect(submit.disabled).toBe(false);
  });

  it("STEP_UP_REQUIRED opens the one step-up dialog; nothing is reported archived", async () => {
    serve({
      onArchive: () => {
        throw stepUpRequired();
      },
    });
    renderTab("ACTIVE", { canManage: true, canArchive: true });
    await openArchiveDialog();
    fireEvent.change(await screen.findByTestId("archive-confirm-name"), { target: { value: "Intake Desk" } });
    fireEvent.click(screen.getByTestId("archive-team-submit"));
    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success" || kind === "error")).toBe(false);
    expect(archiveCalls[0]?.body).toEqual({ confirmName: "Intake Desk" });
  });

  it("when the server accepts, the team is archived and the person returns to the list", async () => {
    serve({ onArchive: () => ({ ok: true, alreadyArchived: false }) });
    renderTab("ACTIVE", { canManage: true, canArchive: true });
    await openArchiveDialog();
    fireEvent.change(await screen.findByTestId("archive-confirm-name"), { target: { value: "Intake Desk" } });
    fireEvent.change(screen.getByTestId("archive-reason"), { target: { value: "Project closed" } });
    fireEvent.click(screen.getByTestId("archive-team-submit"));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/collaboration-teams"));
    expect(archiveCalls[0]?.body).toEqual({ confirmName: "Intake Desk", reason: "Project closed" });
  });

  it("a failed impact read offers no destructive control", async () => {
    serve({ onArchive: () => ({ ok: true }), impactFails: true });
    renderTab("ACTIVE", { canManage: true, canArchive: true });
    await openArchiveDialog();
    await screen.findByTestId("archive-impact-failed");
    expect(screen.queryByTestId("archive-team-submit")).toBeNull();
    expect(archiveCalls).toHaveLength(0);
  });

  it("an archived team offers Restore Collaboration Team to a Lead, without edit controls", async () => {
    serve({ onArchive: () => ({ ok: true }) });
    renderTab("ARCHIVED", { canManage: false, canArchive: true });
    const restore = await screen.findByTestId("settings-unarchive");
    expect(restore.textContent).toBe("Restore Collaboration Team");
    expect(screen.queryByTestId("settings-name")).toBeNull();
    expect(screen.queryByTestId("settings-permission-denied")).toBeNull();
    fireEvent.click(restore);
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${TEAM_ID}/unarchive`),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("someone who can neither edit nor archive is refused the tab", async () => {
    serve({ onArchive: () => ({ ok: true }) });
    renderTab("ARCHIVED", { canManage: false, canArchive: false });
    await screen.findByTestId("settings-permission-denied");
    expect(screen.queryByTestId("settings-unarchive")).toBeNull();
  });
});
