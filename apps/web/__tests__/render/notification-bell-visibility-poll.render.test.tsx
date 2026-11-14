/**
 * F-21 (Free-user audit) — the bell's 120 s summary poll pauses while the tab
 * is hidden and catches up when it comes back. On 2c84cad83 a hidden tab kept
 * requesting `/v1/me/inbox/summary` every 120 s for as long as it stayed open.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const calls: string[] = [];
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    if (path.startsWith("/v1/me/inbox/summary")) {
      return { unreadCount: 0, countIsExact: true, generatedAtUtc: new Date().toISOString() };
    }
    return { items: [] };
  },
  ApiError: class ApiError extends Error {},
}));

const CONTEXT = { contextGeneration: 0, activeWorkspaceId: "ws-1", state: { name: "READY" } };
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => CONTEXT,
}));

vi.mock("../../lib/navigation/useDeepLinkNavigation", () => ({
  useDeepLinkNavigation: () => ({ open: async () => ({ status: "navigated" as const }) }),
}));

import { NotificationBell } from "../../components/app-shell-v2/NotificationBell";

let visibility: DocumentVisibilityState = "visible";
const summaryCalls = () => calls.filter((p) => p.startsWith("/v1/me/inbox/summary")).length;

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  calls.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NotificationBell summary poll", () => {
  it("polls every 120 s while visible, asks nothing while hidden, and refreshes once on return", async () => {
    render(<NotificationBell />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summaryCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(summaryCalls()).toBe(2);

    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000 * 5);
    });
    expect(summaryCalls()).toBe(2);

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summaryCalls()).toBe(3);
  });

  it("a quick hide/show inside one interval does not add a request", async () => {
    render(<NotificationBell />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summaryCalls()).toBe(1);
    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(10_000);
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summaryCalls()).toBe(1);
  });
});
