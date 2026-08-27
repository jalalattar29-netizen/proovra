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
 *   2. The Billing account selector — a managed identity has no PERSONAL
 *      billing account to select at all.
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
import { AccountSelector } from "../../app/(app)/billing/_sections/AccountSelector";
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

describe("PHASE 10 CLOSURE FIX 3 — the Billing account selector", () => {
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — this concern MOVED, and the
   * move made it stronger.
   *
   * It used to be tested against `CheckoutPanel`, which rendered a "Personal
   * workspace" target chip and hid it when `personalSpaceAllowed === false` —
   * client-side hiding over a server that also refused the checkout.
   *
   * There is no target picker any more. The page selects a BILLING ACCOUNT, and
   * a managed identity has no PERSONAL account in the server's list at all:
   * `listBillingAccountsForViewer` gates the personal entry on the canonical
   * `assertPersonalSpaceAllowed`. Absence at the source beats hiding at the
   * surface, because there is then nothing to reveal by any client route.
   */
  const account = (
    type: "PERSONAL" | "WORKSPACE",
    id: string,
    displayName: string,
  ) => ({
    type,
    id,
    displayName,
    capabilities: ["BILLING_ACCOUNT_VIEW" as const],
    billingOwnerMissing: false,
  });

  it("renders nothing when the viewer has only one billing account", () => {
    // A control that offers one choice is not a choice. It also implies other
    // bills the viewer cannot see.
    const { container } = render(
      <AccountSelector
        accounts={[account("WORKSPACE", "ws-1", "Acme")]}
        selected={account("WORKSPACE", "ws-1", "Acme")}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector("[data-billing-account-selector]")).toBeNull();
  });

  it("renders a real listbox once there are two accounts", () => {
    const accounts = [
      account("PERSONAL", "user-1", "Jamie"),
      account("WORKSPACE", "ws-1", "Acme"),
    ];
    render(
      <AccountSelector
        accounts={accounts}
        selected={accounts[0]!}
        onSelect={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Jamie/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("a managed identity with no personal account never sees one offered", () => {
    // The server omitted PERSONAL, so the selector cannot show it — there is no
    // client flag to get wrong.
    const accounts = [
      account("WORKSPACE", "ws-1", "Acme"),
      account("WORKSPACE", "ws-2", "Beta"),
    ];
    render(
      <AccountSelector
        accounts={accounts}
        selected={accounts[0]!}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText("Personal")).toBeNull();
  });
});
