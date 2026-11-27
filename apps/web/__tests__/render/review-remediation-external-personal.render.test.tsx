/**
 * Review remediation 2026-11-27 — F-33 (BEHAVIOUR-SPEC §8).
 *
 * External Review uses the CANONICAL active workspace id. On a Team-entitled
 * Personal workspace `useTeamId()` answers null (team-only legacy hook), which
 * left the scope picker "still loading" (no evidence or matters could be
 * chosen, so no invitation could be issued) and made Renew bail out. The page
 * now reads `useActiveWorkspaceId()`; the server still decides every action
 * (the step-up runner is unchanged), and switching workspace resets the page.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVIDENCE = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), workspace: { id: "" as string | null } }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  // A Team-entitled PERSONAL workspace: the legacy team-only hook is null.
  const space = { type: "PERSONAL", roleLabel: "Owner", shared: false };
  return {
    useCan: () => true,
    useActiveSpace: () => space,
    useTeamId: () => null,
    useActiveWorkspaceId: () => mocks.workspace.id,
    usePlatformContext: () => ({ envelope: null }),
    useWorkspaceFragment: () => null,
    usePersonalSpaceFragment: () => null,
  };
});
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn({}),
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});
vi.mock("../../components/ui", async (orig) => ({
  ...((await orig()) as object),
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true, askReason: async () => null }),
}));

import ExternalInvitationsPage from "../../app/(app)/review/external/page";

let invitations: unknown[] = [];

beforeEach(() => {
  mocks.workspace.id = PERSONAL;
  invitations = [];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === "/v1/external-review/invitations") return { invitations, viewerCanIssue: true };
    if (path.startsWith("/v1/evidence?")) {
      return { items: [{ id: EVIDENCE, title: "Dock camera footage", createdAt: "2026-01-01T00:00:00.000Z" }] };
    }
    if (path.startsWith("/v1/cases/matter-queue?")) return { items: [], total: 0 };
    return {};
  });
});
afterEach(cleanup);

describe("F-33 — External Review on a Team-entitled Personal workspace", () => {
  it("the scope picker loads this workspace's evidence and lets an invitation be scoped", async () => {
    render(<ExternalInvitationsPage />);
    fireEvent.click(await waitFor(() => document.querySelector("[data-invite-reviewer-action]") as HTMLElement));
    fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, {
      target: { value: "sue@acme.com,Sue Q.,Acme" },
    });
    // Never the null-workspace "still loading" state.
    expect(document.body.textContent).not.toContain("Your workspace is still loading.");
    fireEvent.click(screen.getByRole("radio", { name: /^Evidence record/ }));
    await screen.findByRole("radio", { name: /Dock camera footage/ });
    const evidenceRead = mocks.fetch.mock.calls.map(([p]) => String(p)).find((p) => p.startsWith("/v1/evidence?"))!;
    expect(new URLSearchParams(evidenceRead.split("?")[1]).get("teamId")).toBe(PERSONAL);
    fireEvent.click(screen.getByRole("radio", { name: /Dock camera footage/ }));
    await waitFor(() =>
      expect((document.querySelector("[data-bulk-issue-submit]") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("a workspace switch resets the page and rereads the list", async () => {
    const view = render(<ExternalInvitationsPage />);
    await waitFor(() => expect(mocks.fetch.mock.calls.filter(([p]) => p === "/v1/external-review/invitations")).toHaveLength(1));
    fireEvent.click(await waitFor(() => document.querySelector("[data-invite-reviewer-action]") as HTMLElement));
    expect(document.querySelector("[data-bulk-paste]")).not.toBeNull();

    mocks.workspace.id = OTHER;
    invitations = [];
    await act(async () => {
      view.rerender(<ExternalInvitationsPage />);
    });
    await waitFor(() => expect(mocks.fetch.mock.calls.filter(([p]) => p === "/v1/external-review/invitations")).toHaveLength(2));
    // The invite form of the old workspace is closed.
    expect(document.querySelector("[data-bulk-paste]")).toBeNull();
  });
});
