/**
 * F-21 (Free-user audit) — the command palette does not offer
 * organization-only destinations outside an organization workspace, as the
 * sidebar already does not. On 2c84cad83 a personal Free account found them
 * as "Requires organization" rows whose action led to /workspaces, which
 * redirects a self-serve account to the Teams upsell (organization creation is
 * retired). The resolver's own CTAs no longer point at dead ends either.
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));

const WS = "11111111-1111-4111-8111-111111111111";
const CAPS = {
  DASHBOARD_VIEW: true,
  EVIDENCE_VIEW: true,
  EVIDENCE_CAPTURE: true,
  CASES_VIEW: true,
  REPORTS_VIEW: true,
  SEARCH_VIEW: true,
  SETTINGS_VIEW: true,
  ACCOUNT_SETTINGS_VIEW: true,
  ACCOUNT_BILLING_VIEW: true,
  TEAM_VIEW: true,
};
const ENVELOPE = {
  activeSpace: { type: "PERSONAL", id: WS },
  platform: { isPlatformAdmin: false },
  capabilities: CAPS,
  account: { accountPlan: "FREE" },
  flags: { isEnterpriseWorkspace: false },
  planFeatures: { intakeIncluded: false, reportsIncluded: true, professionalSurfacesIncluded: false },
};
const CONTEXT = { envelope: ENVELOPE };
const WORKSPACE = { id: WS, status: "active" };

vi.mock("../../lib/platform-context", async (original) => ({
  ...(await original<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => CONTEXT,
  useWorkspaceFragment: () => WORKSPACE,
  usePersonalSpaceFragment: () => WORKSPACE,
}));

import { CommandPalette } from "../../components/navigation/CommandPalette";
import { ROUTE_REGISTRY } from "../../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../../lib/navigation/routeAccessResolver";

afterEach(() => cleanup());

const access = (route: (typeof ROUTE_REGISTRY)[number]) =>
  resolveRouteAccess({
    route,
    activeSpaceType: "PERSONAL",
    isPlatformAdmin: false,
    capabilities: CAPS as never,
    accountPlan: "FREE",
    isEnterpriseWorkspace: false,
    planFeatures: ENVELOPE.planFeatures as never,
    workspace: WORKSPACE as never,
    personalSpace: WORKSPACE as never,
  });

const orgOnlyInPalette = ROUTE_REGISTRY.filter(
  (r) => r.commandPaletteVisible && access(r).canSeeNav && access(r).accessState === "NEEDS_ORGANIZATION",
);

async function search(container: HTMLElement, text: string) {
  const input = container.querySelector("[data-command-palette-input]") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
}

describe("command palette, personal Free workspace", () => {
  it("there are organization-only routes the resolver would show (the case is real)", () => {
    expect(orgOnlyInPalette.length).toBeGreaterThan(0);
  });

  it("offers none of them, while ordinary destinations still appear", async () => {
    const { container } = render(<CommandPalette />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    for (const route of orgOnlyInPalette) {
      await search(container, route.label);
      expect(
        container.querySelector(`[data-command-palette-result-id="${route.id}"]`),
        `${route.id} must not be offered outside an organization`,
      ).toBeNull();
      expect(container.querySelector('[data-command-palette-result-state="NEEDS_ORGANIZATION"]')).toBeNull();
    }
    await search(container, "Capture");
    expect(container.querySelector('[data-command-palette-result-id="workspace.capture"]')).not.toBeNull();
  });
});

describe("resolver CTAs lead somewhere reachable", () => {
  it("NEEDS_ORGANIZATION does not send a personal account to /workspaces", () => {
    const route = orgOnlyInPalette[0]!;
    const a = access(route);
    expect(a.primaryAction?.href).toBe("/home");
    expect(a.reason).not.toMatch(/Create/);
  });

  it("DENIED_NO_CAPABILITY does not offer the platform-admin /tools catalog", () => {
    const route = ROUTE_REGISTRY.find((r) => r.id === "workspace.cases")!;
    const a = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {} as never,
      accountPlan: "FREE",
      isEnterpriseWorkspace: false,
      planFeatures: ENVELOPE.planFeatures as never,
      workspace: WORKSPACE as never,
      personalSpace: WORKSPACE as never,
    });
    expect(a.accessState).toBe("DENIED_NO_CAPABILITY");
    expect([a.primaryAction?.href, a.secondaryAction?.href]).not.toContain("/tools");
  });
});
