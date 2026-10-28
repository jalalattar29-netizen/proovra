/**
 * MEMBERS EXPERIENCE D — `/teams/:id/lifecycle`, by Workspace kind and viewer.
 *
 * For a Personal Workspace this page held one sentence and a button to
 * Settings → Privacy → Close account: a page that existed only to forward to
 * another button. Old links and bookmarks still reach it, so it now:
 *
 *   PERSONAL, owner       replaces itself with the account-closure surface
 *   PERSONAL, collaborator stays, says whose account it ends with, and offers
 *                          NO account closure (it was offering their own)
 *   ORGANIZATION          stays distinct — offboarding, never account closure
 *   OWNED, owner          stays — it holds the real closure controls
 *   unreadable            stays on the error; nothing redirects on no answer
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const H = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  router: null as unknown as Record<string, unknown>,
  read: null as null | Record<string, unknown> | Error,
}));
H.router = { replace: H.replace, push: H.push, back: () => {}, prefetch: () => {} };

vi.mock("../../lib/api", () => ({
  apiFetch: async () => {
    if (H.read instanceof Error) throw Object.assign(H.read, { statusCode: 404 });
    return H.read;
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: WS }),
  useRouter: () => H.router,
  usePathname: () => `/teams/${WS}/lifecycle`,
  useSearchParams: () => new URLSearchParams(),
}));

import WorkspaceLifecyclePage from "../../app/(app)/teams/[id]/lifecycle/page";

const POLICY = {
  PERSONAL: { kind: "PERSONAL", endPath: "ACCOUNT_CLOSURE", deletable: false, closable: false, transferable: false, nextAction: "CLOSE_ACCOUNT" },
  ORGANIZATION: { kind: "ORGANIZATION", endPath: "ORGANIZATION_OFFBOARDING", deletable: false, closable: false, transferable: false, nextAction: "ORGANIZATION_OFFBOARDING" },
  OWNED: { kind: "OWNED", endPath: "WORKSPACE_CLOSURE", deletable: false, closable: true, transferable: true, nextAction: "REQUEST_WORKSPACE_CLOSURE" },
} as const;

beforeEach(() => {
  H.replace.mockReset();
  H.push.mockReset();
});
afterEach(cleanup);

describe("the lifecycle URL, by kind and viewer", () => {
  it("Personal Workspace owner: replaced by the canonical account-closure surface", async () => {
    H.read = { id: WS, name: "Mine", canManageWorkspace: true, lifecycle: POLICY.PERSONAL };
    render(<WorkspaceLifecyclePage />);
    await waitFor(() => expect(H.replace).toHaveBeenCalledWith("/settings#privacy"));
    expect(H.push).not.toHaveBeenCalled();
    // The forwarding panel is never painted.
    expect(screen.queryByText("Go to Close account")).toBeNull();
  });

  it("Personal Workspace collaborator: no redirect, no account closure, told whose account it ends with", async () => {
    H.read = { id: WS, name: "Theirs", canManageWorkspace: false, lifecycle: POLICY.PERSONAL };
    render(<WorkspaceLifecyclePage />);
    await screen.findByText(/belongs to its owner.s account/);
    expect(H.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Go to Close account")).toBeNull();
    expect(screen.queryByText(/Your Personal Workspace/)).toBeNull();
  });

  it("Organization Workspace: stays distinct — offboarding, never account closure", async () => {
    H.read = { id: WS, name: "Org", canManageWorkspace: true, lifecycle: POLICY.ORGANIZATION };
    render(<WorkspaceLifecyclePage />);
    await screen.findByText("Organization Workspace");
    expect(screen.getByText(/organization's offboarding/)).toBeTruthy();
    expect(H.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Go to Close account")).toBeNull();
  });

  it("owned Workspace owner: stays, with its real controls", async () => {
    H.read = { id: WS, name: "Owned", canManageWorkspace: true, lifecycle: POLICY.OWNED };
    render(<WorkspaceLifecyclePage />);
    await screen.findByText("Workspace closure");
    expect(H.replace).not.toHaveBeenCalled();
  });

  it("an unreadable Workspace never redirects — no answer is not a Personal Workspace", async () => {
    H.read = new Error("not found");
    render(<WorkspaceLifecyclePage />);
    await waitFor(() => expect(document.querySelector("[data-workspace-lifecycle-error]")).not.toBeNull());
    expect(H.replace).not.toHaveBeenCalled();
  });
});
