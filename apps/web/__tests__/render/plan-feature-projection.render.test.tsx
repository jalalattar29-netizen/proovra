/**
 * PHASE 12 POINT 4 PASS C0 — a plan-gated affordance renders the SERVER's
 * projection (render-level).
 *
 * WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — RENAMED and
 * RETARGETED, because its subject was retired and its PROPERTY was not.
 *
 * It used to drive `teamCollaborationIncluded`. That flag projected eligibility for an
 * operation which granted nothing — "guest invitation" wrote a row and
 * stopped — so the operation, the flag and the client that read it are all
 * gone. What must not go is the rule the file exists for: the browser renders
 * the server's projection and never decides eligibility itself.
 *
 * It now drives `teamCollaborationIncluded`, which gates a real surface
 * (Collaboration Teams), is projected from the same catalog by the same
 * resolver, and has the same shape — false on FREE, true on the paid tiers.
 *
 * What is under proof — the REAL `usePlanFeature` hook inside the REAL
 * PlatformContextProvider, driven through a REAL workspace switch:
 *
 *   * an ENTERPRISE workspace GETS the affordance (a client-side
 *     `plan === "PRO" || plan === "TEAM"` rule of the kind this replaced
 *     wrongly locked Enterprise out);
 *   * FREE — a known `false` — is locked;
 *   * an ABSENT/unknown projection fails CLOSED rather than optimistically
 *     showing an affordance the server would deny;
 *   * switching workspace DISCARDS the previous workspace's projection, so an
 *     entitled workspace's affordance cannot survive into an unentitled one.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// apiFetch is the ONLY seam: `switchWorkspace` resolves to the target
// tenant's envelope with no network. The provider runs its real state machine.
const apiState = vi.hoisted(() => ({ nextEnvelope: null as unknown }));
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
  usePlatformContext,
} from "../../lib/platform-context";
import { usePlanFeature } from "../../lib/platform-context/useServerProjectionGates";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

/**
 * Minimal-but-valid envelope. `planFeatures` is passed through verbatim so a
 * test can model "the server said true", "the server said false", and "the
 * key is not there at all" (older backend / degraded projection).
 */
function makeEnvelope(
  workspaceId: string,
  opts: {
    kind?: "PERSONAL" | "OWNED" | "ORGANIZATION";
    accountPlan?: string;
    planFeatures?: Record<string, unknown> | null;
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
    capabilities: {},
    account: { accountPlan: opts.accountPlan ?? "FREE", accountStatus: "active" },
    ...(opts.planFeatures === null ? {} : { planFeatures: opts.planFeatures }),
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId,
        kind,
        organizationId: null,
        displayName,
      },
    },
    diagnostics: { requestId: "test" },
  };
}

/**
 * The guest affordance, expressed exactly as the collaboration surface
 * expresses it: read the server projection, and treat anything that is not a
 * known `true` as locked.
 */
function GuestAffordance() {
  const teamCollaborationIncluded = usePlanFeature("teamCollaborationIncluded");
  const allowed = teamCollaborationIncluded === true;
  return (
    <div data-testid="guests" data-guests-allowed={String(allowed)}>
      <button data-testid="invite-guest" disabled={!allowed}>
        Invite guest
      </button>
      {!allowed ? <span data-testid="guests-locked">Not included</span> : null}
    </div>
  );
}

/** Drives the REAL switchWorkspace into a workspace with no guest coverage. */
function SwitchControls() {
  const { switchWorkspace, activeWorkspaceId } = usePlatformContext();
  return (
    <div>
      <span data-testid="active-ws">{activeWorkspaceId}</span>
      <button
        data-testid="switch-free"
        onClick={() => {
          apiState.nextEnvelope = makeEnvelope("ws-free", {
            accountPlan: "FREE",
            planFeatures: { teamCollaborationIncluded: false },
          });
          void switchWorkspace("ws-free");
        }}
      >
        switch
      </button>
    </div>
  );
}

function renderWith(envelope: unknown) {
  return render(
    <PlatformContextProvider testEnvelope={envelope as never}>
      <SwitchControls />
      <GuestAffordance />
    </PlatformContextProvider>,
  );
}

const inviteButton = () =>
  screen.getByTestId("invite-guest") as HTMLButtonElement;

beforeEach(() => {
  apiState.nextEnvelope = null;
});

describe("Phase 12 Point 4 — the guest affordance renders the server projection", () => {
  it("an ENTERPRISE workspace GETS the affordance", () => {
    renderWith(
      makeEnvelope("ws-ent", {
        kind: "ORGANIZATION",
        accountPlan: "ENTERPRISE",
        planFeatures: { teamCollaborationIncluded: true },
      }),
    );
    expect(screen.getByTestId("guests").getAttribute("data-guests-allowed")).toBe(
      "true",
    );
    expect(inviteButton().disabled).toBe(false);
    expect(screen.queryByTestId("guests-locked")).toBeNull();
  });

  it("FREE is locked", () => {
    renderWith(
      makeEnvelope("ws-free", {
        accountPlan: "FREE",
        planFeatures: { teamCollaborationIncluded: false },
      }),
    );
    expect(screen.getByTestId("guests").getAttribute("data-guests-allowed")).toBe(
      "false",
    );
    expect(inviteButton().disabled).toBe(true);
  });

  it("an ABSENT projection fails CLOSED — no optimistic affordance", () => {
    // Older backend / degraded projection: the key simply is not there.
    renderWith(makeEnvelope("ws-unknown", { accountPlan: "ENTERPRISE", planFeatures: null }));
    expect(screen.getByTestId("guests").getAttribute("data-guests-allowed")).toBe(
      "false",
    );
    expect(inviteButton().disabled).toBe(true);
  });

  it("a workspace switch DISCARDS the entitled workspace's projection", async () => {
    const user = userEvent.setup();
    renderWith(
      makeEnvelope("ws-ent", {
        kind: "ORGANIZATION",
        accountPlan: "ENTERPRISE",
        planFeatures: { teamCollaborationIncluded: true },
      }),
    );
    expect(inviteButton().disabled).toBe(false);

    await user.click(screen.getByTestId("switch-free"));
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("ws-free"),
    );

    // The entitlement belonged to the PREVIOUS workspace. It must not survive.
    expect(screen.getByTestId("guests").getAttribute("data-guests-allowed")).toBe(
      "false",
    );
    expect(inviteButton().disabled).toBe(true);
  });
});
