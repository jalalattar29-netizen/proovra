/**
 * PHASE 13 — SurfaceGate against the REAL platform-context state machine.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `SurfaceGate`'s denial is `notFound()`, and Next.js has no path back from a
 * thrown not-found: the boundary renders `(app)/not-found.tsx` and a later
 * envelope never gets to change the answer. So the ONE property that matters
 * about this gate is WHEN it is allowed to decide, and that is a property of
 * the provider's state machine rather than of any single render.
 *
 * The machine has five states and the gate may only decide in one of them:
 *
 *   IDLE            the state the provider is CONSTRUCTED in — the first paint
 *                   of every page. Deciding here 404'd every Enterprise page.
 *   LOADING_CONTEXT the fetch is in flight; still no envelope.
 *   SWITCHING       `envelope` is deliberately the PREVIOUS workspace's, so
 *                   deciding here authorizes the NEXT workspace against the
 *                   PREVIOUS one's entitlements.
 *   FAILED          `envelope` is ALSO the retained previous one, so deciding
 *                   from it keeps an Enterprise page open on a stale answer.
 *   READY           the only envelope that may decide.
 *
 * The provider here is the real one and the envelope arrives through a real
 * (mocked-transport) fetch, because `testEnvelope` short-circuits straight to
 * READY and is therefore unable to express any of the four states above.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Transport + navigation seams
// ---------------------------------------------------------------------------

/** Resolved by each test to drive the state machine deliberately. */
let contextFetch: () => Promise<unknown>;

vi.mock("../../lib/api", () => ({
  apiFetch: async () => contextFetch(),
  readApiToken: () => null,
  ApiError: class ApiError extends Error {},
  // WORKSPACE AND COLLABORATION RECONCILIATION — the provider writes the
  // active-workspace request binding through this module the moment an
  // envelope is applied, so a double that omits it throws mid-ingest and
  // leaves the provider half-applied. A partial double of a module boundary
  // is an ambient dependency, not a smaller one.
  setActiveWorkspaceId: () => {},
}));

const notFoundCalls = { count: 0 };
const replaceCalls: string[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/governance-platform/policies",
  useRouter: () => ({
    replace: (to: string) => {
      replaceCalls.push(to);
    },
    push: () => {},
  }),
  notFound: () => {
    notFoundCalls.count += 1;
    // Next's own `notFound()` throws so rendering stops. Reproduced, because a
    // gate that called it and then went on rendering children would pass a
    // spy-only assertion while still leaking the page.
    const err = new Error("NEXT_NOT_FOUND");
    (err as { digest?: string }).digest = "NEXT_NOT_FOUND";
    throw err;
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import { usePlatformContext } from "../../lib/platform-context/PlatformContextProvider";
import { SurfaceGate } from "../../components/surface/SurfaceGate";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

/**
 * `/governance-platform` is `{ tier: "ENTERPRISE", directAccessPolicy:
 * "notFound" }` in `lib/surface/tiers.ts` — the exact shape whose denial is
 * irreversible, and the family the browser layer failed on.
 */
function envelope(input: {
  workspaceId: string;
  isEnterpriseWorkspace: boolean;
  isPlatformAdmin?: boolean;
}): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: {
      id: input.workspaceId,
      name: "W",
      status: "active",
      scope: "ORGANIZATION",
    },
    activeSpace: {
      type: "ORGANIZATION",
      id: input.workspaceId,
      displayName: "W",
      roleLabel: "Owner",
    },
    capabilities: {},
    account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
    platform: { isPlatformAdmin: input.isPlatformAdmin === true },
    flags: { isEnterpriseWorkspace: input.isEnterpriseWorkspace },
    planFeatures: {},
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: input.workspaceId,
        kind: "ORGANIZATION",
        organizationId: "org-1",
        displayName: "W",
      },
    },
    diagnostics: { requestId: "t" },
  };
}

/**
 * The not-found BOUNDARY, which is the half of `notFound()` that makes it
 * irreversible.
 *
 * In the app, Next catches the thrown `NEXT_NOT_FOUND` and swaps the subtree
 * for `(app)/not-found.tsx` — permanently. Without a boundary here the throw
 * escapes as an unhandled render error, so the test would be asserting on a
 * crash rather than on the product's 404. Reproducing the boundary keeps the
 * assertion about the gate.
 */
class NotFoundBoundary extends React.Component<
  { children: React.ReactNode },
  { notFound: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { notFound: false };
  }
  static getDerivedStateFromError(error: unknown) {
    if ((error as { digest?: string } | null)?.digest === "NEXT_NOT_FOUND") {
      return { notFound: true };
    }
    throw error;
  }
  render() {
    if (this.state.notFound) {
      return <div data-testid="not-found-boundary">404</div>;
    }
    return <>{this.props.children}</>;
  }
}

/** Exposes `switchWorkspace` so a test can drive the SWITCHING transition. */
let switcher: ((id: string | null) => Promise<void>) | null = null;
/** `refresh()` enters SWITCHING too, but targeting the CURRENT workspace (NEW-070). */
let refresher: (() => Promise<void>) | null = null;
function Switcher() {
  const { switchWorkspace, refresh, state } = usePlatformContext();
  switcher = switchWorkspace;
  refresher = refresh;
  return <div data-testid="machine-state">{state.name}</div>;
}

function mount() {
  return render(
    <PlatformContextProvider>
      <Switcher />
      <NotFoundBoundary>
        <SurfaceGate>
          <div data-testid="enterprise-body">GOVERNANCE PLATFORM BODY</div>
        </SurfaceGate>
      </NotFoundBoundary>
    </PlatformContextProvider>,
  );
}

const body = () => screen.queryByTestId("enterprise-body");
const holding = () =>
  document.querySelector('[data-surface-gate-state="resolving"]');

beforeEach(() => {
  notFoundCalls.count = 0;
  replaceCalls.length = 0;
  switcher = null;
  refresher = null;
  contextFetch = () => new Promise(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SurfaceGate — only a READY envelope may decide", () => {
  it("IDLE/LOADING_CONTEXT: holds instead of calling notFound(), and does not render privileged content", async () => {
    // A fetch that never settles keeps the machine in LOADING_CONTEXT, which is
    // reached from IDLE — the state the provider is constructed in and the one
    // the first paint of every page is in.
    contextFetch = () => new Promise(() => {});
    mount();

    expect(
      notFoundCalls.count,
      "an unresolved context must NOT produce an irreversible 404",
    ).toBe(0);
    expect(
      body(),
      "privileged page content must not render before the envelope exists",
    ).toBeNull();
    expect(
      holding(),
      "the gate must render its bounded loading state while resolving",
    ).not.toBeNull();
  });

  it("the loading state is announced rather than silent", () => {
    mount();
    const region = holding()!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-busy")).toBe("true");
  });

  it("READY + authorized Enterprise context: the page renders", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true });
    mount();

    await screen.findByTestId("enterprise-body");
    expect(notFoundCalls.count).toBe(0);
    expect(holding(), "the gate must stop holding once READY").toBeNull();
  });

  it("READY + unauthorized (non-enterprise) context: denied AFTER resolution, page stays unavailable", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: false });
    mount();

    // The denial is asynchronous now — it may only happen once READY.
    await vi.waitFor(() => {
      expect(notFoundCalls.count).toBeGreaterThan(0);
    });
    expect(
      body(),
      "an unauthorized workspace must never see the Enterprise body",
    ).toBeNull();
  });

  it("context fetch failure fails CLOSED — the Enterprise page is not exposed", async () => {
    contextFetch = async () => {
      throw new Error("context unavailable");
    };
    mount();

    await vi.waitFor(() => {
      expect(screen.getByTestId("machine-state").textContent).toBe("FAILED");
    });
    expect(
      body(),
      "a FAILED context must not expose the Enterprise page",
    ).toBeNull();
    expect(
      notFoundCalls.count,
      "a FAILED context must reach a bounded denial, not hold forever",
    ).toBeGreaterThan(0);
  });

  it("FAILED after a READY Enterprise envelope still fails closed — the retained previous envelope must not authorize", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true });
    mount();
    await screen.findByTestId("enterprise-body");

    // The provider retains the previous envelope through FAILED on purpose, so
    // this is the case where reading `envelope` instead of gating on `name`
    // keeps a privileged page open on a stale answer.
    contextFetch = async () => {
      throw new Error("context unavailable");
    };
    await act(async () => {
      await switcher!("ws-B");
    });

    expect(screen.getByTestId("machine-state").textContent).toBe("FAILED");
    expect(
      body(),
      "a stale previous envelope must not keep the Enterprise page open after a context failure",
    ).toBeNull();
  });

  it("context switch: stale Enterprise authorization does not carry into the next workspace", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true });
    mount();
    await screen.findByTestId("enterprise-body");

    // Hold the switch in flight so SWITCHING is observable. `envelope` returns
    // the PREVIOUS (authorized) envelope in this state.
    let release: (v: unknown) => void = () => {};
    contextFetch = () =>
      new Promise((res) => {
        release = res;
      });
    const pending = act(async () => {
      void switcher!("ws-B");
      await Promise.resolve();
    });
    await pending;

    expect(screen.getByTestId("machine-state").textContent).toBe("SWITCHING");
    expect(
      body(),
      "the previous workspace's authorization must not render for the next workspace",
    ).toBeNull();
    expect(
      holding(),
      "the gate must return to its loading state until the new context resolves",
    ).not.toBeNull();

    // And the answer for the NEW workspace is the new workspace's.
    await act(async () => {
      release(envelope({ workspaceId: "ws-B", isEnterpriseWorkspace: false }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(notFoundCalls.count).toBeGreaterThan(0);
    });
    expect(body()).toBeNull();
  });

  it("NEW-070: a SAME-workspace refresh keeps the page mounted — it is not a switch", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true });
    mount();
    const bodyEl = await screen.findByTestId("enterprise-body");

    // `refresh()` also enters SWITCHING, but with `targetWorkspaceId` equal to
    // the workspace already rendered. Holding there would unmount the subtree on
    // every post-mutation revalidation and destroy any live region inside it.
    let release: (v: unknown) => void = () => {};
    contextFetch = () =>
      new Promise((res) => {
        release = res;
      });
    await act(async () => {
      void refresher!();
      await Promise.resolve();
    });

    expect(screen.getByTestId("machine-state").textContent).toBe("SWITCHING");
    expect(
      holding(),
      "a same-workspace refresh must NOT put the gate back into its loading state",
    ).toBeNull();
    expect(
      screen.queryByTestId("enterprise-body"),
      "the page must stay rendered across a same-workspace refresh",
    ).not.toBeNull();
    // The SAME element instance — not a remount, which is what would reset the
    // state a mutation had just written.
    expect(screen.getByTestId("enterprise-body")).toBe(bodyEl);

    await act(async () => {
      release(envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true }));
      await Promise.resolve();
    });
    expect(notFoundCalls.count).toBe(0);
  });

  it("StrictMode double-render produces no hook-order error, no premature 404 and no privileged flash", async () => {
    contextFetch = async () =>
      envelope({ workspaceId: "ws-A", isEnterpriseWorkspace: true });
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });

    render(
      <React.StrictMode>
        <PlatformContextProvider>
          <Switcher />
          <NotFoundBoundary>
            <SurfaceGate>
              <div data-testid="enterprise-body">GOVERNANCE PLATFORM BODY</div>
            </SurfaceGate>
          </NotFoundBoundary>
        </PlatformContextProvider>
      </React.StrictMode>,
    );

    expect(
      notFoundCalls.count,
      "the first (pre-envelope) render pair must not 404",
    ).toBe(0);
    await screen.findByTestId("enterprise-body");
    const hookOrder = errors
      .map((e) => JSON.stringify(e))
      .filter((s) => /Rendered (more|fewer) hooks|order of Hooks/i.test(s));
    expect(hookOrder, "hook order must be stable across renders").toEqual([]);
    spy.mockRestore();
  });
});
