/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23) — RENDER-LEVEL behavioral tests for
 * the client No-Personal UX gate.
 *
 * Every case is driven by a mocked `personalSpaceAllowed` value on the
 * platform-context envelope (never a hardcoded identityMode/ssoRequired
 * inference) — the same pattern as __tests__/render/context-safety.render
 * .test.tsx (real PlatformContextProvider via `testEnvelope`, apiFetch
 * mocked as the only seam).
 *
 * Coverage:
 *   1. `usePersonalSpaceGate` + `PersonalSpaceUnavailablePanel` — the exact
 *      composition AppShellV2 uses to protect EVERY (app) route (capture,
 *      evidence, billing, settings, deep links). Proven via a `GateHost`
 *      stand-in identical in shape to AppShellV2's gating block.
 *   2. `CheckoutPanel` — the Personal checkout target/button.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
}));

import {
  PlatformContextProvider,
  usePersonalSpaceGate,
  PersonalSpaceUnavailablePanel,
  PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
} from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { CheckoutPanel } from "../../components/billing/CheckoutPanel";
import { ToastProvider } from "../../components/ui";

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

function makeEnvelope(opts: {
  workspaceId: string;
  activeSpaceType: "PERSONAL" | "ORGANIZATION";
  personalSpaceAllowed?: boolean;
  ownedWorkspaceId?: string | null;
}): unknown {
  const { workspaceId, activeSpaceType, personalSpaceAllowed, ownedWorkspaceId = null } = opts;
  const displayName = activeSpaceType === "PERSONAL" ? "Personal Space" : `Workspace ${workspaceId}`;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: { id: workspaceId, name: displayName, status: "active", scope: activeSpaceType === "PERSONAL" ? "PERSONAL" : "TEAM" },
    activeSpace: {
      type: activeSpaceType,
      id: workspaceId,
      displayName,
      roleLabel: "Owner",
    },
    capabilities: {},
    account: { accountPlan: "PRO", accountStatus: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: ownedWorkspaceId
        ? [{ workspaceId: ownedWorkspaceId, name: "My Workspace", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" }]
        : [],
      organizations: [],
      activeContext: {
        workspaceId,
        kind: activeSpaceType === "PERSONAL" ? "PERSONAL" : "OWNED",
        organizationId: null,
        displayName,
      },
    },
    diagnostics: { requestId: "test" },
    ...(personalSpaceAllowed === undefined ? {} : { personalSpaceAllowed }),
  };
}

function Providers({ envelope, children }: { envelope: unknown; children: React.ReactNode }) {
  return <PlatformContextProvider testEnvelope={envelope as never}>{children}</PlatformContextProvider>;
}

// A stand-in for AppShellV2's own gating block — the exact composition
// (usePersonalSpaceGate + PersonalSpaceUnavailablePanel) that every (app)
// route (capture included) is wrapped by.
function GateHost({ children }: { children: React.ReactNode }) {
  const gate = usePersonalSpaceGate();
  return gate === "blocked" ? <PersonalSpaceUnavailablePanel /> : <>{children}</>;
}

beforeEach(() => {
  apiState.nextEnvelope = null;
});

describe("PHASE 10 CLOSURE FIX 3 — usePersonalSpaceGate + PersonalSpaceUnavailablePanel", () => {
  it("blocks Capture/deep-link content and shows the canonical unavailable banner when disallowed with no alternative workspace", () => {
    render(
      <Providers
        envelope={makeEnvelope({
          workspaceId: "personal-1",
          activeSpaceType: "PERSONAL",
          personalSpaceAllowed: false,
        })}
      >
        <GateHost>
          <div data-testid="capture-content">CAPTURE UI</div>
        </GateHost>
      </Providers>,
    );

    expect(screen.queryByTestId("capture-content")).toBeNull();
    expect(screen.getByTestId("personal-space-unavailable")).not.toBeNull();
    expect(screen.getByText(PERSONAL_SPACE_UNAVAILABLE_MESSAGE)).not.toBeNull();
    // Bounded copy — never exposes identityMode/ssoRequired/org internals.
    const panelText = screen.getByTestId("personal-space-unavailable").textContent ?? "";
    expect(panelText).not.toMatch(/identityMode|ssoRequired|MANAGED_ENTERPRISE|SCIM/i);
  });

  it("heals an active disallowed Personal context into an owned workspace (never a fabricated destination) and then renders content", async () => {
    apiState.nextEnvelope = makeEnvelope({
      workspaceId: "owned-1",
      activeSpaceType: "ORGANIZATION",
      personalSpaceAllowed: false,
    });

    render(
      <Providers
        envelope={makeEnvelope({
          workspaceId: "personal-1",
          activeSpaceType: "PERSONAL",
          personalSpaceAllowed: false,
          ownedWorkspaceId: "owned-1",
        })}
      >
        <GateHost>
          <div data-testid="capture-content">CAPTURE UI</div>
        </GateHost>
      </Providers>,
    );

    // Blocked while the heal is in flight — never renders Personal content.
    expect(screen.queryByTestId("capture-content")).toBeNull();

    await waitFor(() => expect(screen.getByTestId("capture-content")).not.toBeNull());
    expect(screen.queryByTestId("personal-space-unavailable")).toBeNull();
  });

  it("renders content normally when the active context is already non-Personal", () => {
    render(
      <Providers
        envelope={makeEnvelope({
          workspaceId: "org-1",
          activeSpaceType: "ORGANIZATION",
          personalSpaceAllowed: false,
        })}
      >
        <GateHost>
          <div data-testid="capture-content">CAPTURE UI</div>
        </GateHost>
      </Providers>,
    );

    expect(screen.getByTestId("capture-content")).not.toBeNull();
    expect(screen.queryByTestId("personal-space-unavailable")).toBeNull();
  });

  it("mirror case: personalSpaceAllowed=true (and absent) never blocks a Personal active context", () => {
    for (const personalSpaceAllowed of [true, undefined]) {
      const { unmount } = render(
        <Providers
          envelope={makeEnvelope({
            workspaceId: "personal-1",
            activeSpaceType: "PERSONAL",
            personalSpaceAllowed,
          })}
        >
          <GateHost>
            <div data-testid="capture-content">CAPTURE UI</div>
          </GateHost>
        </Providers>,
      );
      expect(screen.getByTestId("capture-content")).not.toBeNull();
      expect(screen.queryByTestId("personal-space-unavailable")).toBeNull();
      unmount();
    }
  });
});

describe("PHASE 10 CLOSURE FIX 3 — CheckoutPanel Personal checkout target", () => {
  function renderCheckout(props: Partial<React.ComponentProps<typeof CheckoutPanel>>) {
    return render(
      <ToastProvider>
        <CheckoutPanel personal={null} teams={[]} {...props} />
      </ToastProvider>,
    );
  }

  it("hides the Personal workspace checkout target when personalSpaceAllowed=false", () => {
    renderCheckout({ personalSpaceAllowed: false });
    expect(screen.queryByText("Personal workspace")).toBeNull();
    expect(screen.getByText("Workspace")).not.toBeNull();
  });

  it("mirror case: shows the Personal workspace checkout target when personalSpaceAllowed=true (default)", () => {
    renderCheckout({});
    expect(screen.getByText("Personal workspace")).not.toBeNull();
  });

  it("a stale ?workspace=personal deep link cannot select the disallowed Personal target", () => {
    renderCheckout({
      personalSpaceAllowed: false,
      initialTargetType: "PERSONAL",
      teams: [
        {
          id: "team-1",
          name: "Acme",
          plan: "TEAM",
          effectivePlan: "TEAM",
          billingStatus: "ACTIVE",
        } as never,
      ],
    });
    expect(screen.queryByText("Personal workspace")).toBeNull();
    // Auto-corrected to the Workspace target.
    expect(screen.getByText(/Target: Workspace/)).not.toBeNull();
  });

  it("with no owned workspace and Personal disallowed, checkout has no valid target", () => {
    renderCheckout({ personalSpaceAllowed: false, teams: [] });
    expect(screen.getByText(/No workspace is available for checkout/)).not.toBeNull();
    const continueButton = screen.getByText(/Continue to checkout/).closest("button");
    expect(continueButton).not.toBeNull();
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
  });
});
