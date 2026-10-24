/**
 * MEMBERS AUDIT LIFE-01/02/07 — Workspace lifecycle renders the SERVER's
 * policy, per kind, and offers no delete control for any kind.
 *
 * The audit observed a Personal Workspace showing both "Close this
 * workspace…" (always refused) and "Delete workspace" (which, with no evidence
 * yet, destroyed the workspace). These cases drive the real section against
 * the real response shape and assert what a person can actually press.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/(app)/teams/[id]/components/WorkspaceClosureCard", () => ({
  WorkspaceClosureCard: ({ teamId }: { teamId: string }) => (
    <div data-testid="closure-card">closure for {teamId}</div>
  ),
}));
vi.mock("../../app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard", () => ({
  WorkspaceOwnershipTransferCard: () => <div data-testid="transfer-card">transfer</div>,
}));

import { WorkspaceLifecycleSection } from "../../app/(app)/settings/_sections/WorkspaceLifecycleSection";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function policy(kind: "PERSONAL" | "ORGANIZATION" | "OWNED") {
  return {
    PERSONAL: { kind, endPath: "ACCOUNT_CLOSURE", deletable: false, closable: false, transferable: false, nextAction: "CLOSE_ACCOUNT" },
    ORGANIZATION: { kind, endPath: "ORGANIZATION_OFFBOARDING", deletable: false, closable: false, transferable: false, nextAction: "ORGANIZATION_OFFBOARDING" },
    OWNED: { kind, endPath: "WORKSPACE_CLOSURE", deletable: false, closable: true, transferable: true, nextAction: "REQUEST_WORKSPACE_CLOSURE" },
  }[kind];
}

function serve(kind: "PERSONAL" | "ORGANIZATION" | "OWNED", canManageWorkspace: boolean) {
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === `/v1/teams/${WS}`) {
      return { id: WS, name: "Casework", canManageWorkspace, lifecycle: policy(kind) };
    }
    throw new Error("unexpected request " + String(path));
  });
}

function noDestructiveControls() {
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  expect(screen.queryByText(/Close this workspace/i)).toBeNull();
  expect(screen.queryByTestId("closure-card")).toBeNull();
}

describe("WorkspaceLifecycleSection", () => {
  // Block bodies: a returned function from beforeEach is run as a cleanup hook.
  beforeEach(() => {
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("PERSONAL owner: explains account closure, offers Close account, and nothing that closes or deletes the workspace", async () => {
    serve("PERSONAL", true);
    const openPrivacy = vi.fn();
    render(<WorkspaceLifecycleSection workspaceId={WS} currentUserId="u1" onOpenPrivacy={openPrivacy} />);
    await screen.findByText("Your Personal Workspace");
    expect(screen.getByText(/closes only when you close your account/)).toBeTruthy();
    noDestructiveControls();
    expect(screen.queryByTestId("transfer-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to Close account" }));
    expect(openPrivacy).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls.every(([, init]) => !init || (init as RequestInit).method !== "DELETE")).toBe(true);
  });

  it("ORGANIZATION owner: explains organization offboarding; no workspace-level close, delete or transfer", async () => {
    serve("ORGANIZATION", true);
    render(<WorkspaceLifecycleSection workspaceId={WS} currentUserId="u1" onOpenPrivacy={() => {}} />);
    await screen.findByText("Organization Workspace");
    noDestructiveControls();
    expect(screen.queryByTestId("transfer-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to Close account" })).toBeNull();
  });

  it("OWNED owner: the canonical closure request and ownership transfer — still no delete", async () => {
    serve("OWNED", true);
    render(<WorkspaceLifecycleSection workspaceId={WS} currentUserId="u1" onOpenPrivacy={() => {}} />);
    await screen.findByTestId("closure-card");
    expect(screen.getByTestId("transfer-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("OWNED non-owner: the explanation only", async () => {
    serve("OWNED", false);
    render(<WorkspaceLifecycleSection workspaceId={WS} currentUserId="u2" onOpenPrivacy={() => {}} />);
    await screen.findByText("Workspace closure");
    expect(screen.queryByTestId("closure-card")).toBeNull();
    expect(screen.queryByTestId("transfer-card")).toBeNull();
  });

  it("a failed read is an error with its support reference and a retry — never an empty lifecycle", async () => {
    mocks.fetch.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 503, code: "SERVICE_UNAVAILABLE", requestId: "req-123" }),
    );
    render(<WorkspaceLifecycleSection workspaceId={WS} currentUserId="u1" onOpenPrivacy={() => {}} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/req-123/);
    serve("PERSONAL", true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Your Personal Workspace")).toBeTruthy());
  });
});
