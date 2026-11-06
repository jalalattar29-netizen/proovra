/**
 * PRO-075 (UI-04) — a signed-out visitor on an app route is offered sign-in.
 *
 * The audit's anonymous walk got "Workspace setup required" on /home, /cases
 * and /capture, "Permission required" on /billing, /settings and /teams/<id>,
 * and "Platform administrator only" on /admin/users, with every data call
 * 401 and no sign-in offer. Mounted with the REAL PlatformContextProvider and
 * apiFetch over a stubbed fetch, so the 401 is classified the way production
 * classifies it.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { PlatformContextProvider } from "../../lib/platform-context";
import { PageRouteGate } from "../../components/navigation/PageRouteGate";
import { SignedOutAppGate } from "../../components/navigation/SignedOutAppState";

function stubFetch(answer: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
}

const unauthorized = async () =>
  new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("PRO-075: signed out means sign in", () => {
  it.each(["/home", "/billing", "/admin/users"])("the app layout gate on %s offers sign-in back to the page", async (path) => {
    window.history.replaceState(null, "", `${path}?tab=x`);
    stubFetch(unauthorized);
    render(
      <PlatformContextProvider>
        <SignedOutAppGate active pathname={path}>
          <div data-testid="app-shell">SHELL</div>
        </SignedOutAppGate>
      </PlatformContextProvider>,
    );
    await settle();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(`${path}?tab=x`)}`);
    // Nothing about workspaces, plans or permissions.
    expect(document.body.textContent).not.toMatch(/Workspace setup required|Permission required|Platform administrator/);
  });

  it("PageRouteGate: a 401 context is a sign-in state, not a workspace or permission state", async () => {
    window.history.replaceState(null, "", "/billing");
    stubFetch(unauthorized);
    render(
      <PlatformContextProvider>
        <PageRouteGate routeId="account.settings">
          <div data-testid="protected">BODY</div>
        </PageRouteGate>
      </PlatformContextProvider>,
    );
    await settle();
    expect(screen.queryByTestId("protected")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(document.querySelector("[data-page-route-gate]")).toBeNull();
  });

  it("control: a route that loads with no context (an invitation page) still renders on a 401", async () => {
    stubFetch(unauthorized);
    render(
      <PlatformContextProvider>
        <PageRouteGate routeId="account.org-invite-accept">
          <div data-testid="invite-page">INVITE</div>
        </PageRouteGate>
      </PlatformContextProvider>,
    );
    await settle();
    expect(screen.getByTestId("invite-page")).toBeTruthy();
  });

  it("control: a network failure for a signed-in person keeps the app, not a sign-in prompt", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(
      <PlatformContextProvider>
        <SignedOutAppGate active pathname="/home">
          <div data-testid="app-shell">SHELL</div>
        </SignedOutAppGate>
      </PlatformContextProvider>,
    );
    await settle();
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.queryByText("Sign in to continue")).toBeNull();
  });

  it("control: with a session the gate is transparent", async () => {
    stubFetch(unauthorized);
    render(
      <PlatformContextProvider>
        <SignedOutAppGate active={false} pathname="/home">
          <div data-testid="app-shell">SHELL</div>
        </SignedOutAppGate>
      </PlatformContextProvider>,
    );
    await settle();
    expect(screen.getByTestId("app-shell")).toBeTruthy();
  });
});
