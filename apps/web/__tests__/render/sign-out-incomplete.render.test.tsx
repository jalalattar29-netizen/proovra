/**
 * B8-F-001 — Sign-out reports success only when the server ended the session.
 *
 * The real (app) layout and the REAL apiFetch run; only `fetch` is mocked, so
 * the overload gate's nested 503 SERVER_BUSY, the handler's 503
 * `logout_incomplete` and a network failure reach the layout exactly as they
 * would in production.
 */
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  push: vi.fn(),
  setToken: vi.fn(),
  updateUser: vi.fn(),
  clearCaches: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({ push: spies.push, replace: vi.fn() }),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ authReady: true, hasSession: true, setToken: spies.setToken, updateUser: spies.updateUser }),
}));
vi.mock("../../components/app-shell-v2/AppShellV2", () => ({
  AppShellV2: ({ children, onLogout }: { children: React.ReactNode; onLogout: () => void }) => (
    <div data-testid="shell">
      <button type="button" onClick={() => void onLogout()}>
        Sign out
      </button>
      {children}
    </div>
  ),
}));
vi.mock("../../components/ai/ProovraChatWidget", () => ({ ProovraChatWidget: () => null }));
vi.mock("../../components/legal/LegalAcceptanceStep", () => ({ LegalAcceptanceStep: () => null }));
vi.mock("../../lib/platform-context", () => ({
  PlatformContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlatformContext: () => ({ state: { name: "READY" } }),
}));
vi.mock("../../lib/pwa/serviceWorkerClient", () => ({ clearServiceWorkerCaches: spies.clearCaches }));

import AppLayout from "../../app/(app)/layout";

type Reply = { status: number; body: unknown } | "network";
let replies: Reply[] = [];
let logoutCalls = 0;

beforeEach(() => {
  replies = [];
  logoutCalls = 0;
  spies.push.mockClear();
  spies.setToken.mockClear();
  spies.updateUser.mockClear();
  spies.clearCaches.mockClear();
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/v1/auth/logout")) {
      logoutCalls += 1;
      const next = replies.shift() ?? { status: 200, body: { ok: true } };
      if (next === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => cleanup());

async function signOut() {
  render(
    <AppLayout>
      <p>home</p>
    </AppLayout>,
  );
  await act(async () => {
    screen.getByRole("button", { name: "Sign out" }).click();
  });
}

describe("B8-F-001 — a sign-out the server did not complete is not reported as done", () => {
  it("overload 503 SERVER_BUSY: stays signed in, says so, and retries to completion", async () => {
    replies = [{ status: 503, body: { error: { code: "SERVER_BUSY", message: "busy" } } }];
    await signOut();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(screen.getByText("Sign-out did not complete")).toBeTruthy();
    expect(spies.setToken).not.toHaveBeenCalled();
    expect(spies.updateUser).not.toHaveBeenCalled();
    expect(spies.push).not.toHaveBeenCalled();
    // Local state that is safe to clear still is.
    expect(spies.clearCaches).toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button", { name: "Retry sign-out" }).click();
    });
    await waitFor(() => expect(spies.push).toHaveBeenCalledWith("/login"));
    expect(spies.setToken).toHaveBeenCalledWith(null);
    expect(logoutCalls).toBe(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("handler 503 logout_incomplete is said, not swallowed", async () => {
    replies = [{ status: 503, body: { ok: false, error: { code: "logout_incomplete" } } }];
    await signOut();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(screen.getByText(/could not confirm that this session was ended/)).toBeTruthy();
    expect(spies.push).not.toHaveBeenCalled();
  });

  it("a network failure keeps the person signed in with a retry", async () => {
    replies = ["network"];
    await signOut();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(spies.setToken).not.toHaveBeenCalled();
    expect(spies.push).not.toHaveBeenCalled();
  });

  it("a completed sign-out routes to /login as before", async () => {
    await signOut();
    await waitFor(() => expect(spies.push).toHaveBeenCalledWith("/login"));
    expect(spies.setToken).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a 401 (no live session left) completes the sign-out", async () => {
    replies = [{ status: 401, body: { error: { code: "UNAUTHORIZED", message: "no" } } }];
    await signOut();
    await waitFor(() => expect(spies.push).toHaveBeenCalledWith("/login"));
  });
});
