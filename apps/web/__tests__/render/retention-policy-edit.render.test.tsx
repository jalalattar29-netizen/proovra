/**
 * BATCH J — Governance retention: edit a policy.
 *
 *   PATCH /v1/governance/retention-policies/:id
 *     app/(app)/governance/retention/page.tsx +
 *     app/(app)/governance/retention/_EditRetentionPolicyDialog.tsx —
 *     Edit on ACTIVE/PAUSED rows only; prefilled form; only changed fields
 *     plus a required change note are sent; confirmation; step-up wrapped;
 *     success announced only after the list AND version history reread show
 *     the new version.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), stepUpCalls: 0 }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/navigation/OperationalBreadcrumb", () => ({ OperationalBreadcrumb: () => null }));
vi.mock("../../components/governance/RetentionInheritanceSummary", () => ({ RetentionInheritanceSummary: () => null }));
vi.mock("../../components/governance/RetentionConflictAlert", () => ({ RetentionConflictAlert: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../../lib/platform-context", () => {
  const guard = { stamp: () => 1, isStale: () => false };
  return { useTeamId: () => TEAM, useTenantGuard: () => guard };
});
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      mocks.stepUpCalls += 1;
      return fn({ "x-proovra-step-up-challenge-id": "challenge-1" });
    },
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});

import RetentionPoliciesPage from "../../app/(app)/governance/retention/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";
const DONE = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-01T10:00:00.000Z";

function policy(over: Record<string, unknown> = {}) {
  return {
    id: ID, teamId: TEAM, displayName: "Claims", description: "Claims evidence", status: "ACTIVE",
    scope: "WORKSPACE", scopeQualifier: null, caseId: null, retentionDays: 365, immutable: false,
    autoExtensionEnabled: false, autoExtensionDays: null, supersededByPolicyId: null, currentVersion: 2,
    createdByUserId: "u", createdAt: ISO, updatedAt: ISO, archivedAtUtc: null, ...over,
  };
}
function failure(statusCode: number, code?: string): Error {
  return Object.assign(new Error("request failed"), { statusCode, code });
}

let saved = false;
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "PATCH") {
    saved = true;
    return { policy: policy({ currentVersion: 3, retentionDays: 730 }) };
  }
  if (path.startsWith("/v1/governance/retention-policies?")) {
    return {
      policies: [
        saved ? policy({ currentVersion: 3, retentionDays: 730 }) : policy(),
        policy({ id: DONE, displayName: "Old", status: "SUPERSEDED" }),
      ],
    };
  }
  if (path.includes("/versions?")) {
    return { versions: (saved ? [3, 2, 1] : [2, 1]).map((version) => ({ version, retentionDays: 365, immutable: false, diffJson: {}, authoredByUserId: "u", changeNote: null, authoredAtUtc: ISO })) };
  }
  if (path.startsWith("/v1/governance/retention-policies/effective")) return { policy: null, reason: "no_policy", source: "none", conflicts: [] };
  if (path.startsWith("/v1/governance/retention-candidates")) return { candidates: [] };
  throw new Error("unexpected " + path);
}

beforeEach(() => {
  saved = false;
  mocks.stepUpCalls = 0;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const patches = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
async function openEditor() {
  const edit = await screen.findByRole("button", { name: "Edit retention policy Claims" });
  edit.focus();
  fireEvent.click(edit);
  return screen.findByRole("dialog", { name: "Edit retention policy" });
}
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Save new version" });
function reasonOf(button: HTMLElement): string | null | undefined {
  return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;
}

describe("governance retention policy edit", () => {
  it("offers Edit only on editable rows and opens a prefilled form with focus inside", async () => {
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    expect(screen.queryByRole("button", { name: "Edit retention policy Old" })).toBeNull();
    const name = within(dialog).getByLabelText("Display name") as HTMLInputElement;
    expect(name.value).toBe("Claims");
    expect(document.activeElement).toBe(name);
    expect((within(dialog).getByLabelText("Retention in days (empty means indefinite)") as HTMLInputElement).value).toBe("365");
  });

  it("saves only the changed fields through step-up and announces after the list and versions reread", async () => {
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("Retention in days (empty means indefinite)"), { target: { value: "730" } });
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "Two year hold" } });
    fireEvent.click(save(dialog));
    await screen.findByText(/"Claims" saved as version 3 and confirmed from the version history/);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save version 3 of "Claims"?' }));
    expect(mocks.stepUpCalls).toBe(1);
    const [path, init] = patches()[0];
    expect(path).toBe(`/v1/governance/retention-policies/${ID}`);
    expect(JSON.parse(init.body)).toEqual({ teamId: TEAM, retentionDays: 730, changeNote: "Two year hold" });
    expect(init.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    const calls = mocks.fetch.mock.calls.map(([p]) => p);
    const after = calls.slice(calls.indexOf(path) + 1);
    expect(after).toContain(`/v1/governance/retention-policies?teamId=${TEAM}&status=ALL`);
    expect(after).toContain(`/v1/governance/retention-policies/${ID}/versions?teamId=${TEAM}`);
    expect(screen.queryByRole("dialog", { name: "Edit retention policy" })).toBeNull();
  });

  it("cancel makes no write and returns focus to the Edit control", async () => {
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Edit retention policy" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit retention policy Claims" }));
    expect(patches()).toHaveLength(0);
  });

  it("declining the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByLabelText("Immutable — block destruction even after expiry"));
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "Lock" } });
    fireEvent.click(save(dialog));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(patches()).toHaveLength(0);
  });

  it("explains every disabled save", async () => {
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    expect(reasonOf(save(dialog))).toBe("Change at least one setting to save a new version.");
    fireEvent.change(within(dialog).getByLabelText("Description (operator-readable only)"), { target: { value: "New words" } });
    expect(reasonOf(save(dialog))).toMatch(/description change alone does not create a new version/);
    fireEvent.change(within(dialog).getByLabelText("Retention in days (empty means indefinite)"), { target: { value: "abc" } });
    expect(reasonOf(save(dialog))).toMatch(/whole number of days/);
    fireEvent.change(within(dialog).getByLabelText("Retention in days (empty means indefinite)"), { target: { value: "" } });
    expect(reasonOf(save(dialog))).toBe("Enter a change note for the audit trail.");
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "Indefinite" } });
    expect(save(dialog).hasAttribute("disabled")).toBe(false);
  });

  it.each([
    [failure(409, "RETENTION_POLICY_TERMINAL"), /superseded or archived/],
    [failure(403), /cannot change retention policies/],
    [Object.assign(new Error("cancel"), { code: "STEP_UP_CANCEL" }), /nothing was saved/],
  ])("a refused save is reported in the form without claiming success (%#)", async (err, message) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw err;
      return defaultReply(path, init);
    });
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("Retention in days (empty means indefinite)"), { target: { value: "730" } });
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "x" } });
    fireEvent.click(save(dialog));
    expect((await within(dialog).findByText(message)).getAttribute("role")).toBe("alert");
    expect(screen.queryByText(/saved as version/)).toBeNull();
  });

  it("does not claim success when the reread shows no new version", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { policy: policy() };
      return defaultReply(path, init);
    });
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Claims 2" } });
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "rename" } });
    fireEvent.click(save(dialog));
    await within(dialog).findByText(/does not show a new version/);
    expect(screen.queryByText(/saved as version/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (saved && path.includes("/versions?")) throw failure(503);
      return defaultReply(path, init);
    });
    render(<RetentionPoliciesPage />);
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("Retention in days (empty means indefinite)"), { target: { value: "730" } });
    fireEvent.change(within(dialog).getByLabelText("Change note (required)"), { target: { value: "x" } });
    fireEvent.click(save(dialog));
    await within(dialog).findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/saved as version/)).toBeNull();
  });

  it("a failed policy read is not rendered as an empty list", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/v1/governance/retention-policies?")) throw failure(500);
      return defaultReply(path, init);
    });
    render(<RetentionPoliciesPage />);
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.queryByText("No retention policy configured")).toBeNull();
  });
});
