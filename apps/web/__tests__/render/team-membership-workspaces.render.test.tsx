/**
 * TEAM-SPEC §3 "Team membership surfaces" — /workspaces lists every workspace
 * the server offers (Personal, Shared with you, Your workspaces,
 * Organizations), and every Open is SWITCH-THEN-NAVIGATE through the real
 * provider's switchWorkspace over the real apiFetch (stubbed transport).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushes: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => pushes.push(to), replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/workspaces",
  useParams: () => ({}),
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/contextual-help/ContextualHelp", () => ({ ContextualHelp: () => null }));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { WorkspaceAdministrationHome } from "../../components/workspace-admin/WorkspaceAdministrationHome";

const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const OWNED = "33333333-3333-4333-8333-333333333333";

function envelope(active: "personal" | "shared"): Record<string, unknown> {
  const activeId = active === "personal" ? PERSONAL : SHARED;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "test" },
    workspace: { id: activeId, name: "W", status: "active", scope: "PERSONAL" },
    account: { userId: ME, email: "me@example.test", displayName: "Me", accountPlan: "PRO", accountStatus: "active" },
    personalSpace: { status: "active", id: PERSONAL, label: "Personal Space", ownerUserId: ME, plan: null },
    organizations: [],
    activeSpace:
      active === "personal"
        ? { type: "PERSONAL", id: PERSONAL, displayName: "Personal Space", roleLabel: "Owner", plan: "PRO" }
        : { type: "PERSONAL", id: SHARED, displayName: "Dana's workspace", roleLabel: "MEMBER", shared: true, plan: "TEAM" },
    contextOptions: {
      personalSpace: { workspaceId: PERSONAL, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [{ workspaceId: OWNED, name: "Legacy Desk", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" }],
      sharedWorkspaces: [{ workspaceId: SHARED, name: "Dana's workspace", kind: "PERSONAL", role: "MEMBER", lifecycleStatus: "active" }],
      organizations: [],
      activeContext: { workspaceId: activeId, kind: "PERSONAL", organizationId: null, displayName: "W" },
    },
    duplicatePersonalCandidates: [],
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: {},
  };
}

const calls: Array<{ method: string; path: string; body: unknown }> = [];
const order: string[] = [];
let switchStatus = 200;

beforeEach(() => {
  calls.length = 0;
  order.length = 0;
  pushes.length = 0;
  switchStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      if (path === "/v1/platform/context/switch-workspace") {
        order.push(`switch:${(body as { workspaceId: string | null }).workspaceId}`);
        if (switchStatus !== 200) {
          return new Response(JSON.stringify({ error: { code: "WORKSPACE_ACCESS_DENIED" } }), {
            status: switchStatus,
            headers: { "content-type": "application/json" },
          });
        }
        const target = (body as { workspaceId: string | null }).workspaceId;
        return new Response(JSON.stringify(envelope(target === SHARED ? "shared" : "personal")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(active: "personal" | "shared") {
  return render(
    <PlatformContextProvider testEnvelope={envelope(active) as never}>
      <WorkspaceAdministrationHome />
    </PlatformContextProvider>,
  );
}

describe("/workspaces — every workspace the server offers, switch-then-open", () => {
  it("lists the shared and owned workspaces with an Open action each", () => {
    mount("personal");
    expect(screen.getByText("Dana's workspace")).toBeTruthy();
    expect(screen.getByText("Legacy Desk")).toBeTruthy();
    expect(document.querySelector(`[data-shared-workspace-open="${SHARED}"]`)).toBeTruthy();
    expect(document.querySelector(`[data-owned-workspace-open="${OWNED}"]`)).toBeTruthy();
    // Members & Access is linked; no fabricated FREE plan on a null plan.
    expect(document.querySelector('a[href="/people"]')).toBeTruthy();
    expect(document.querySelector("[data-personal-space-plan]")).toBeNull();
    expect(screen.queryByText(/Plan: Free/i)).toBeNull();
    // Copy states the Team model.
    expect(screen.getByText(/invited into the owner's Personal Workspace/)).toBeTruthy();
  });

  it("Open on a shared workspace switches FIRST, then navigates", async () => {
    mount("personal");
    fireEvent.click(document.querySelector(`[data-shared-workspace-open="${SHARED}"]`) as HTMLElement);
    await waitFor(() => expect(pushes).toEqual(["/home"]));
    expect(order).toEqual([`switch:${SHARED}`]);
  });

  it("Open Personal Space from a shared workspace switches to the personal space (null) before opening it", async () => {
    mount("shared");
    fireEvent.click(document.querySelector("[data-personal-space-open]") as HTMLElement);
    await waitFor(() => expect(pushes).toEqual(["/evidence"]));
    expect(order).toEqual(["switch:null"]);
  });

  it("Open Personal Space when it is already active navigates without a switch", async () => {
    mount("personal");
    await act(async () => {
      fireEvent.click(document.querySelector("[data-personal-space-open]") as HTMLElement);
    });
    expect(pushes).toEqual(["/evidence"]);
    expect(order).toEqual([]);
  });

  it("a refused switch does not navigate and says so", async () => {
    switchStatus = 403;
    mount("personal");
    fireEvent.click(document.querySelector(`[data-owned-workspace-open="${OWNED}"]`) as HTMLElement);
    await waitFor(() => expect(order).toEqual([`switch:${OWNED}`]));
    await waitFor(() => expect(document.querySelector("[data-workspace-open-error]")).toBeTruthy());
    expect(pushes).toEqual([]);
  });
});
