/**
 * PHASE 7 §10.7/§10.8 (2026-07-22) — route healing + capability-aware
 * gating through the REAL PageRouteGate + resolveRouteAccess path.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../lib/api", () => ({
  apiFetch: async () => ({}),
  readApiToken: () => null,
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import { PageRouteGate } from "../../components/navigation/PageRouteGate";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

function makeEnvelope(capabilities: Record<string, boolean>): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: { id: "ws-A", name: "W", status: "active", scope: "OWNED" },
    activeSpace: {
      type: "ORGANIZATION",
      id: "ws-A",
      displayName: "W",
      roleLabel: "Owner",
    },
    capabilities,
    account: { accountPlan: "PRO", accountStatus: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: "ws-A",
        kind: "OWNED",
        organizationId: null,
        displayName: "W",
      },
    },
    diagnostics: { requestId: "t" },
  };
}

function renderGate(caps: Record<string, boolean>) {
  return render(
    <PlatformContextProvider testEnvelope={makeEnvelope(caps) as never}>
      <PageRouteGate routeId="account.settings">
        <div data-testid="protected">SETTINGS BODY</div>
      </PageRouteGate>
    </PlatformContextProvider>,
  );
}

describe("Phase 7 §10.8 — PageRouteGate renders per capability/context", () => {
  it("renders the protected body when the required capability is present", () => {
    renderGate({ ACCOUNT_SETTINGS_VIEW: true });
    expect(screen.getByTestId("protected")).not.toBeNull();
  });

  it("§10.7 — when the capability is absent (context removed/suspended), the body is NOT rendered; a bounded gate panel shows instead", () => {
    renderGate({ ACCOUNT_SETTINGS_VIEW: false });
    // The workspace-scoped body must not leak when access is not granted.
    expect(screen.queryByTestId("protected")).toBeNull();
    // A structured route-gate panel renders instead (never a blank page).
    expect(
      document.querySelector('[data-testid="route-gate-account.settings"]') ??
        document.querySelector("[data-page-route-gate]"),
    ).not.toBeNull();
  });
});
