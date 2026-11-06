/**
 * A person opening an invitation with no session sees the invitation, not the app.
 * The real (app) layout renders; the shell is a marker so its absence is the assertion.
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/org-invites/abc/accept" }));
const auth = vi.hoisted(() => ({ hasSession: false }));
const ctx = vi.hoisted(() => ({
  state: { name: "FAILED", errorCode: "AUTH_REQUIRED", message: "", requestId: null, previous: null } as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ authReady: true, hasSession: auth.hasSession, setToken: vi.fn(), updateUser: vi.fn() }),
}));
vi.mock("../../components/app-shell-v2/AppShellV2", () => ({
  AppShellV2: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock("../../components/ai/ProovraChatWidget", () => ({ ProovraChatWidget: () => null }));
vi.mock("../../lib/platform-context", () => ({
  PlatformContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlatformContext: () => ({ state: ctx.state }),
}));

import AppLayout from "../../app/(app)/layout";
import { isInvitationAcceptPath } from "../../lib/navigation/invitation-path";

afterEach(() => {
  cleanup();
  nav.pathname = "/org-invites/abc/accept";
  auth.hasSession = false;
  ctx.state = { name: "FAILED", errorCode: "AUTH_REQUIRED", message: "", requestId: null, previous: null };
});

describe("the signed-out invitation page", () => {
  it("shows the invitation without the app shell", () => {
    render(<AppLayout><p>invitation</p></AppLayout>);
    expect(screen.getByText("invitation")).toBeTruthy();
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("keeps the shell for a signed-in person", () => {
    auth.hasSession = true;
    render(<AppLayout><p>invitation</p></AppLayout>);
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  // PRO-075 (2026-11-06), an intentional contract change. This pinned that a
  // signed-out visitor on any other app route got the shell, which is the
  // defect: the shell then showed workspace and permission states to someone
  // with no session, and no way to sign in. Signed out (the context answers
  // 401) they now get a sign-in state; the invitation doors above are
  // unchanged.
  it("offers sign-in, not the shell, on every other signed-out app route", () => {
    nav.pathname = "/home";
    render(<AppLayout><p>home</p></AppLayout>);
    expect(screen.queryByTestId("shell")).toBeNull();
    expect(screen.queryByText("home")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
  });

  it("keeps the shell when the context failed for another reason (a network error is not a sign-out)", () => {
    nav.pathname = "/home";
    ctx.state = { name: "FAILED", errorCode: "NETWORK_ERROR", message: "", requestId: null, previous: null };
    render(<AppLayout><p>home</p></AppLayout>);
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  it("covers both invitation doors and no neighbour", () => {
    expect(isInvitationAcceptPath("/collaboration-teams/invites/t/accept")).toBe(true);
    expect(isInvitationAcceptPath("/org-invites/t/accept/")).toBe(true);
    expect(isInvitationAcceptPath("/org-invites/t")).toBe(false);
    expect(isInvitationAcceptPath(null)).toBe(false);
  });
});
