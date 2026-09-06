/**
 * PHASE 7 §10 (2026-07-22) — RENDER-LEVEL behavioral tests.
 *
 * These exercise the SHARED context-safety primitives inside the REAL
 * PlatformContextProvider (no test-only provider), driving a real
 * workspace switch through the production `switchWorkspace` path (apiFetch
 * mocked to return the next tenant's envelope — no network). Each distinct
 * behavior family is proven once at the primitive level; the per-surface
 * consumer-contract matrix (context-safety.consumers test) proves the 15
 * surfaces compose these verified primitives.
 */

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// apiFetch is mocked so `switchWorkspace` resolves to the target tenant's
// envelope without any network. The mock is the ONLY seam; the provider
// runs its real state machine.
const apiState = vi.hoisted(() => ({
  nextEnvelope: null as unknown,
}));
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path.includes("switch-workspace") || path.includes("platform/context")) {
      return apiState.nextEnvelope;
    }
    return {};
  },
  readApiToken: () => null,
  // WORKSPACE AND COLLABORATION RECONCILIATION — the provider writes the
  // active-workspace request binding through this module the moment an
  // envelope is applied, so a double that omits it throws mid-ingest and
  // leaves the provider half-applied. A partial double of a module boundary
  // is an ambient dependency, not a smaller one.
  setActiveWorkspaceId: () => {},
}));

import {
  PlatformContextProvider,
  usePlatformContext,
  useWorkspaceContextSafety,
  useTenantDraft,
  tenantStorageKey,
  WorkspaceContextBanner,
  registerDirtyWork,
  getDirtyWorkLabels,
} from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

// Minimal-but-valid envelope for a workspace. Only the fields the tested
// primitives + provider read are populated; versions match the build so
// `versionsAreCompatible` passes on both the initial and switched envelope.
function makeEnvelope(
  workspaceId: string,
  opts: {
    kind?: "PERSONAL" | "OWNED" | "ORGANIZATION";
    orgName?: string | null;
    orgId?: string | null;
    capabilities?: Record<string, boolean>;
  } = {},
): unknown {
  const kind = opts.kind ?? "OWNED";
  const displayName =
    kind === "PERSONAL" ? "Personal Space" : `Workspace ${workspaceId}`;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: { id: workspaceId, name: displayName, status: "active", scope: kind },
    activeSpace: {
      type: kind === "PERSONAL" ? "PERSONAL" : "ORGANIZATION",
      id: workspaceId,
      displayName,
      roleLabel: "Owner",
    },
    capabilities: opts.capabilities ?? {},
    account: { accountPlan: "PRO", accountStatus: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: opts.orgId
        ? [
            {
              organizationId: opts.orgId,
              organizationName: opts.orgName ?? "Acme Corp",
              workspaces: [],
            },
          ]
        : [],
      activeContext: {
        workspaceId,
        kind,
        organizationId: opts.orgId ?? null,
        displayName,
      },
    },
    diagnostics: { requestId: "test" },
  };
}

function Providers({
  envelope,
  children,
}: {
  envelope: unknown;
  children: React.ReactNode;
}) {
  return (
    <PlatformContextProvider testEnvelope={envelope as never}>
      {children}
    </PlatformContextProvider>
  );
}

// A control that triggers the REAL switchWorkspace, plus a live readout of
// the active workspace + generation, so tests can await the switch.
function SwitchControls() {
  const { switchWorkspace, activeWorkspaceId, contextGeneration, state } =
    usePlatformContext();
  return (
    <div>
      <span data-testid="active-ws">{activeWorkspaceId}</span>
      <span data-testid="state">{state.name}</span>
      <span data-testid="gen">{contextGeneration}</span>
      <button
        data-testid="switch-b"
        onClick={() => {
          apiState.nextEnvelope = makeEnvelope("ws-B");
          void switchWorkspace("ws-B");
        }}
      >
        switch
      </button>
    </div>
  );
}

beforeEach(() => {
  apiState.nextEnvelope = null;
});

describe("Phase 7 §10.3 — stale async result cannot update the new workspace", () => {
  function StaleProbe() {
    const { runGuarded } = useWorkspaceContextSafety({
      isDirty: false,
      dirtyLabel: "x",
    });
    const [applied, setApplied] = useState<string>("none");
    let resolveOp: (v: string) => void = () => {};
    const start = () => {
      const p = new Promise<string>((r) => {
        resolveOp = r;
      });
      void runGuarded(
        () => p,
        (v) => setApplied(v),
      );
      // expose the resolver on window for the test to fire post-switch
      (window as unknown as { __resolveOp: typeof resolveOp }).__resolveOp =
        resolveOp;
    };
    return (
      <div>
        <span data-testid="applied">{applied}</span>
        <button data-testid="start" onClick={start}>
          start
        </button>
      </div>
    );
  }

  it("a request started in A, resolved after switching to B, does NOT apply", async () => {
    const user = userEvent.setup();
    render(
      <Providers envelope={makeEnvelope("ws-A")}>
        <SwitchControls />
        <StaleProbe />
      </Providers>,
    );
    expect(screen.getByTestId("active-ws").textContent).toBe("ws-A");

    await user.click(screen.getByTestId("start")); // request in flight (A)
    await user.click(screen.getByTestId("switch-b")); // switch to B
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("ws-B"),
    );

    // Now resolve the A-era request. runGuarded must DROP it (stale tenant).
    await act(async () => {
      (window as unknown as { __resolveOp: (v: string) => void }).__resolveOp(
        "A-result",
      );
    });
    expect(screen.getByTestId("applied").textContent).toBe("none");
  });
});

describe("Phase 7 §10.2 — workspace-keyed drafts cannot collide across workspaces", () => {
  it("the same resource key resolves to different storage per workspace", () => {
    expect(tenantStorageKey("ws-A", "case-draft")).not.toBe(
      tenantStorageKey("ws-B", "case-draft"),
    );
  });

  function DraftProbe() {
    const { value, setValue, activeWorkspaceId } = useTenantDraft<string>(
      "case-draft",
      "",
    );
    return (
      <div>
        <span data-testid="draft">{value}</span>
        <span data-testid="draft-ws">{activeWorkspaceId}</span>
        <button data-testid="write" onClick={() => setValue("A-secret")}>
          write
        </button>
      </div>
    );
  }

  it("a draft written under A is NOT visible under B (real render + switch)", async () => {
    const user = userEvent.setup();
    render(
      <Providers envelope={makeEnvelope("ws-A")}>
        <SwitchControls />
        <DraftProbe />
      </Providers>,
    );
    await user.click(screen.getByTestId("write"));
    expect(screen.getByTestId("draft").textContent).toBe("A-secret");
    // A's draft physically lives under A's tenant key.
    expect(
      window.localStorage.getItem(tenantStorageKey("ws-A", "case-draft")),
    ).toContain("A-secret");

    await user.click(screen.getByTestId("switch-b"));
    await waitFor(() =>
      expect(screen.getByTestId("draft-ws").textContent).toBe("ws-B"),
    );
    // Under B the draft is empty — A's value never leaks across the switch.
    expect(screen.getByTestId("draft").textContent).toBe("");
    expect(
      window.localStorage.getItem(tenantStorageKey("ws-B", "case-draft")),
    ).toBeNull();
  });
});

describe("Phase 7 §10.5 — context banner shows the authoritative workspace/org", () => {
  it("renders the active workspace + organization, and updates on switch", async () => {
    const user = userEvent.setup();
    render(
      <Providers
        envelope={makeEnvelope("ws-A", { orgId: "org-1", orgName: "Acme Corp" })}
      >
        <SwitchControls />
        <WorkspaceContextBanner action="Test action in" />
      </Providers>,
    );
    const banner = screen.getByText(/Test action in/i).closest("[data-workspace-context-banner]");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Workspace ws-A");
    expect(banner?.textContent).toContain("Acme Corp");

    await user.click(screen.getByTestId("switch-b"));
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("ws-B"),
    );
    expect(
      screen
        .getByText(/Test action in/i)
        .closest("[data-workspace-context-banner]")?.textContent,
    ).toContain("Workspace ws-B");
  });
});

describe("Phase 7 §10.1 — dirty work blocks a silent switch", () => {
  it("registered dirty work is visible to the switcher; cleanup clears it", () => {
    const before = getDirtyWorkLabels().length;
    const release = registerDirtyWork("Unsaved case");
    expect(getDirtyWorkLabels()).toContain("Unsaved case");
    // The switcher (AppAccountToolbar) reads getDirtyWorkLabels() before
    // calling switchWorkspace and refuses/ confirms when non-empty.
    release();
    expect(getDirtyWorkLabels().length).toBe(before);
  });
});
