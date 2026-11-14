/**
 * F-21 (Free-user audit) — Home's reads: what it asks for and what it says
 * when a read fails. Drives the real `useHomeData` through the real `apiFetch`
 * over a stubbed fetch.
 *
 * On 2c84cad83 Home issued ten GETs on every load and on every refocus after
 * 2 s, including the intake-link list and its delivery messages for a plan
 * without intake (the /intake-links route those cards link to is gated on the
 * same `intakeIncluded` flag), and every failure resolved to null: a network
 * outage rendered as an empty workspace and `status: "error"` was never set.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const WS = "11111111-1111-4111-8111-111111111111";
let intakeIncluded = false;

// One stable context value per plan shape, as the provider memoizes it (a new
// object per render would re-create Home's reload on every render).
const contexts = new Map<boolean, unknown>();
function contextFor(intake: boolean): unknown {
  if (!contexts.has(intake)) {
    contexts.set(intake, {
      envelope: {
        activeSpace: { type: "PERSONAL", id: WS, shared: false, displayName: "Personal" },
        personalSpace: { plan: "FREE" },
        account: { accountPlan: "FREE" },
        organizations: [],
        planFeatures: { intakeIncluded: intake, reportsIncluded: true, teamCollaborationIncluded: false },
      },
    });
  }
  return contexts.get(intake);
}
const ACTIVE_SPACE = { type: "PERSONAL", id: WS, displayName: "Personal" };

vi.mock("../../lib/platform-context/PlatformContextProvider", async (original) => ({
  ...(await original<typeof import("../../lib/platform-context/PlatformContextProvider")>()),
  usePlatformContext: () => contextFor(intakeIncluded),
}));

vi.mock("../../lib/platform-context", async (original) => ({
  ...(await original<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => WS,
  useActiveSpace: () => ACTIVE_SPACE,
  useOrganizations: () => EMPTY_ORGS,
}));
const EMPTY_ORGS: never[] = [];

import {
  HOME_FOCUS_REFRESH_MIN_INTERVAL_MS,
  HOME_PARTIAL_LOAD_MESSAGE,
  useHomeData,
} from "../../components/home-experience/useHomeData";

type Reply = (url: string) => Promise<Response>;
function stubFetch(reply: Reply): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      return reply(url);
    }),
  );
  return urls;
}
const ok = async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  intakeIncluded = false;
});

describe("useHomeData", () => {
  it("a plan without intake does not read the intake list or its delivery messages", async () => {
    const urls = stubFetch(ok);
    const { result } = renderHook(() => useHomeData());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(urls.some((u) => u.includes("/v1/evidence?limit=100"))).toBe(true));
    expect(urls.some((u) => u.includes("/v1/workflow/intake-links"))).toBe(false);
    expect(urls.some((u) => u.includes("/v1/communications/messages"))).toBe(false);
    // The slices the plan does include are still read.
    expect(urls.some((u) => u.includes("/v1/dashboard/command-center"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/ops/summary"))).toBe(true);
  });

  it("a plan with intake reads both (control)", async () => {
    intakeIncluded = true;
    const urls = stubFetch(ok);
    const { result } = renderHook(() => useHomeData());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => {
      expect(urls.some((u) => u.includes("/v1/workflow/intake-links"))).toBe(true);
      expect(urls.some((u) => u.includes("/v1/communications/messages"))).toBe(true);
    });
  });

  it("no response at all ends in the retryable error state, and a retry that succeeds clears it", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { result } = renderHook(() => useHomeData());
    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status !== "error") throw new Error("unreachable");
    expect(result.current.message).toBe(HOME_PARTIAL_LOAD_MESSAGE);
    // The data that is available stays on screen with the error.
    expect(result.current.viewModel).not.toBeNull();

    stubFetch(ok);
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("a 5xx on one slice is an error; a 403 refusal on another is an honest absence, not an error", async () => {
    stubFetch(async (url) =>
      url.includes("/v1/ops/summary")
        ? new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })
        : ok(),
    );
    const first = renderHook(() => useHomeData());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    // Give every slice time to settle; the state must stay "ready".
    await new Promise((r) => setTimeout(r, 50));
    expect(first.result.current.status).toBe("ready");
    first.unmount();

    stubFetch(async (url) =>
      url.includes("/v1/dashboard/trust-summary")
        ? new Response(JSON.stringify({ message: "unavailable" }), { status: 503 })
        : ok(),
    );
    const second = renderHook(() => useHomeData());
    await waitFor(() => expect(second.result.current.status).toBe("error"));
  });

  it("refocus does not re-run every read inside the throttle window", async () => {
    expect(HOME_FOCUS_REFRESH_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    const urls = stubFetch(ok);
    const { result } = renderHook(() => useHomeData());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(urls.some((u) => u.includes("/v1/evidence?limit=100"))).toBe(true));
    const before = urls.length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(urls.length).toBe(before);
  });
});
