/**
 * TEAM-SPEC §3 "Team membership surfaces" — SurfaceGate offers "Switch to
 * your Personal Space" (never upgrade / ask-the-owner copy) when a plan-based
 * refusal comes from the ACTIVE shared workspace while the actor's own plan
 * carries the entitlement. Which plans pass is unchanged.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review/workspace",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { PlatformContextProvider } from "../../lib/platform-context";
import { SurfaceGate } from "../../components/surface/SurfaceGate";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";

function envelope(opts: { accountPlan: string; active: "shared" | "personal" }): unknown {
  const activeId = opts.active === "shared" ? SHARED : PERSONAL;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "test" },
    workspace: { id: activeId, name: "W", status: "active", scope: "PERSONAL" },
    account: { userId: ME, email: null, displayName: "Me", accountPlan: opts.accountPlan, accountStatus: "active" },
    personalSpace: { status: "active", id: PERSONAL, label: "Personal Space", ownerUserId: ME, plan: opts.accountPlan },
    organizations: [],
    activeSpace:
      opts.active === "shared"
        ? { type: "PERSONAL", id: SHARED, displayName: "Dana's workspace", roleLabel: "MEMBER", shared: true, plan: "PRO" }
        : { type: "PERSONAL", id: PERSONAL, displayName: "Personal Space", roleLabel: "Owner", plan: opts.accountPlan },
    contextOptions: {
      personalSpace: { workspaceId: PERSONAL, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      sharedWorkspaces: [{ workspaceId: SHARED, name: "Dana's workspace", kind: "PERSONAL", role: "MEMBER", lifecycleStatus: "active" }],
      organizations: [],
      activeContext: { workspaceId: activeId, kind: "PERSONAL", organizationId: null, displayName: "W" },
    },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      reviewQueuesIncluded: false,
      reviewerOperationsIncluded: false,
      externalReviewIncluded: true,
      professionalSurfacesIncluded: true,
    },
  };
}

const switches: unknown[] = [];
beforeEach(() => {
  switches.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/platform/context/switch-workspace") {
        switches.push(init?.body ? JSON.parse(String(init.body)) : null);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(env: unknown) {
  return render(
    <PlatformContextProvider testEnvelope={env as never}>
      <SurfaceGate>
        <p>gated content</p>
      </SurfaceGate>
    </PlatformContextProvider>,
  );
}

describe("SurfaceGate — switch, don't upgrade", () => {
  it("a TEAM account in a PRO shared workspace is offered the switch, with no plan or upgrade copy", async () => {
    mount(envelope({ accountPlan: "TEAM", active: "shared" }));
    expect(screen.queryByText("gated content")).toBeNull();
    const state = screen.getByTestId("surface-gate-switch-personal");
    expect(state.textContent).toMatch(/Switch to your Personal Space/);
    expect(state.textContent).not.toMatch(/upgrade|View plans|change the plan|Team plan and above/i);
    fireEvent.click(screen.getByTestId("surface-gate-switch-personal-action"));
    await waitFor(() => expect(switches).toEqual([{ workspaceId: null }]));
  });

  it("a PRO account (own plan lacks the entitlement) gets the ordinary refusal, not a switch", () => {
    mount(envelope({ accountPlan: "PRO", active: "shared" }));
    expect(screen.queryByTestId("surface-gate-switch-personal")).toBeNull();
    expect(screen.getByTestId("surface-gate-forbidden")).toBeTruthy();
  });

  it("in the actor's own Personal Space there is nothing to switch to", () => {
    mount(envelope({ accountPlan: "TEAM", active: "personal" }));
    expect(screen.queryByTestId("surface-gate-switch-personal")).toBeNull();
  });
});
