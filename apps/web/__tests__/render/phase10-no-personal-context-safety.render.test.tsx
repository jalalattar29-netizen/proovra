/**
 * PHASE 10 CLOSURE FIX 3 (2026-07-23) — RENDER-LEVEL behavioral tests proving
 * the automatic no-Personal client heal (usePersonalSpaceGate) is INTEGRATED
 * with the existing Phase-7 context-safety primitives, not a parallel
 * mechanism.
 *
 * The gap this closes: a STANDARD→MANAGED/no-Personal policy flip during an
 * ACTIVE capture/upload/dirty form could fire an automatic `switchWorkspace`
 * that bypassed the Phase-7 dirty-work protection the MANUAL switcher already
 * honors. Every case below drives the REAL PlatformContextProvider (apiFetch
 * mocked as the only seam) and composes the SAME canonical primitives:
 *   - dirtyWorkRegistry.ts  (useDirtyWork / useDirtyWorkLabels)
 *   - tenantStorage.ts      (useTenantDraft / useWorkspaceContextSafety / tenantStorageKey)
 *   - MultipartUploader     (construction-bound workspace, immutable)
 *
 * The realistic timeline is reproduced: a surface is mounted and DIRTY while
 * Personal is allowed, THEN the policy flips to disallowed (via a real
 * `refresh()` returning the managed envelope). This is the exact sequence
 * where a naive auto-heal would silently switch.
 *
 * Locked behaviors covered: A (clean heal), B (dirty blocks + explicit
 * release), C (upload not rebound + stale finalize dropped), D (polling
 * disposed), plus draft-keying, no cross-organization redirect, and no
 * historical-evidence mutation.
 */

import React, { useEffect, useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// apiFetch is the ONLY seam. Path-aware: a `platform/context` refresh returns
// the (possibly disallowed) envelope for a POLICY FLIP; a `switch-workspace`
// POST returns the healed workspace's envelope. Every call is recorded so
// tests can assert the heal never touches evidence endpoints.
const apiState = vi.hoisted(() => ({
  refreshEnvelope: null as unknown,
  switchEnvelope: null as unknown,
  calls: [] as string[],
}));
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { body?: string }) => {
    apiState.calls.push(path);
    if (init?.body) apiState.calls.push(`BODY:${init.body}`);
    if (path.includes("switch-workspace")) return apiState.switchEnvelope;
    if (path.includes("platform/context")) return apiState.refreshEnvelope;
    return {};
  },
  readApiToken: () => null,
}));

import {
  PlatformContextProvider,
  usePlatformContext,
  usePersonalSpaceGate,
  PersonalSpaceUnavailablePanel,
  useDirtyWork,
  useTenantDraft,
  useWorkspaceContextSafety,
  tenantStorageKey,
} from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { MultipartUploader } from "../../lib/uploads/multipart-uploader";

// ---------------------------------------------------------------------------
// Envelope builder.
// ---------------------------------------------------------------------------

function makeEnvelope(opts: {
  workspaceId: string;
  activeSpaceType: "PERSONAL" | "ORGANIZATION";
  personalSpaceAllowed?: boolean;
  ownedWorkspaceId?: string | null;
  orgWorkspace?: { orgId: string; workspaceId: string } | null;
}): unknown {
  const {
    workspaceId,
    activeSpaceType,
    personalSpaceAllowed,
    ownedWorkspaceId = null,
    orgWorkspace = null,
  } = opts;
  const displayName =
    activeSpaceType === "PERSONAL" ? "Personal Space" : `Workspace ${workspaceId}`;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: {
      id: workspaceId,
      name: displayName,
      status: "active",
      scope: activeSpaceType === "PERSONAL" ? "PERSONAL" : "TEAM",
    },
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
        ? [
            {
              workspaceId: ownedWorkspaceId,
              name: "My Workspace",
              kind: "OWNED",
              role: "OWNER",
              lifecycleStatus: "active",
            },
          ]
        : [],
      organizations: orgWorkspace
        ? [
            {
              organizationId: orgWorkspace.orgId,
              organizationName: "Acme",
              workspaces: [
                {
                  workspaceId: orgWorkspace.workspaceId,
                  workspaceName: "Acme WS",
                  kind: "ORGANIZATION",
                  workspaceRole: "MEMBER",
                  lifecycleStatus: "active",
                },
              ],
            },
          ]
        : [],
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

const allowedPersonal = () =>
  makeEnvelope({
    workspaceId: "personal-1",
    activeSpaceType: "PERSONAL",
    personalSpaceAllowed: true,
    ownedWorkspaceId: "owned-1",
  });

const disallowedPersonal = (ownedWorkspaceId: string | null = "owned-1", orgWorkspace = null) =>
  makeEnvelope({
    workspaceId: "personal-1",
    activeSpaceType: "PERSONAL",
    personalSpaceAllowed: false,
    ownedWorkspaceId,
    orgWorkspace,
  });

const healedWorkspace = (workspaceId: string) =>
  makeEnvelope({
    workspaceId,
    activeSpaceType: "ORGANIZATION",
    personalSpaceAllowed: false,
  });

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

// The exact composition AppShellV2 uses. `children` (a descendant surface,
// e.g. the Capture page) is UNMOUNTED when the gate blocks — exactly the
// event that empties the dirty registry and would silently release a naive
// heal. The latch must survive it.
function GateHost({ children }: { children: React.ReactNode }) {
  const gate = usePersonalSpaceGate();
  const { activeWorkspaceId } = usePlatformContext();
  return (
    <div>
      <span data-testid="active-ws">{activeWorkspaceId}</span>
      {gate === "blocked" ? <PersonalSpaceUnavailablePanel /> : children}
    </div>
  );
}

// Descendant surface holding unsaved workspace-scoped work while `dirty`.
function DirtySurface({ dirty, label }: { dirty: boolean; label: string }) {
  useDirtyWork(dirty, label);
  return <div data-testid="dirty-surface">{label}</div>;
}

// A real policy-flip control: `refresh()` re-fetches the envelope, which now
// reports the managed (disallowed) policy — the STANDARD→MANAGED transition.
function FlipControl() {
  const { refresh } = usePlatformContext();
  return (
    <button data-testid="flip" onClick={() => void refresh()}>
      flip
    </button>
  );
}

// A count of switch-workspace POSTs whose body targets a given workspace —
// the heal fires exactly this. The policy-flip refresh uses a DIFFERENT path
// (platform/context), so it never counts here.
function healSwitchCount(targetWorkspaceId: string): number {
  return apiState.calls.filter(
    (c) => c.startsWith("BODY:") && c.includes(`"workspaceId":"${targetWorkspaceId}"`),
  ).length;
}

beforeEach(() => {
  apiState.refreshEnvelope = null;
  apiState.switchEnvelope = null;
  apiState.calls = [];
});

// ---------------------------------------------------------------------------
// Behavior B — dirty form/draft BLOCKS the automatic heal (survives unmount).
// ---------------------------------------------------------------------------

describe("PHASE 10 FIX 3 — dirty-work guard blocks the automatic no-Personal heal (behavior B)", () => {
  it("2. a policy flip during dirty Capture is WITHHELD — panel shown, NO heal switch, even after the capture surface unmounts", async () => {
    apiState.refreshEnvelope = disallowedPersonal("owned-1");
    apiState.switchEnvelope = healedWorkspace("owned-1");
    const user = userEvent.setup();

    render(
      <Providers envelope={allowedPersonal()}>
        <FlipControl />
        <GateHost>
          {/* dirty descendant — unmounts when the gate blocks */}
          <DirtySurface dirty label="Staged evidence in Capture" />
          <div data-testid="capture-content">CAPTURE UI</div>
        </GateHost>
      </Providers>,
    );

    // Allowed → capture visible, dirty registered.
    expect(screen.getByTestId("capture-content")).not.toBeNull();

    // Policy flips to disallowed.
    await user.click(screen.getByTestId("flip"));
    await waitFor(() =>
      expect(screen.getByTestId("personal-space-unavailable")).not.toBeNull(),
    );

    // Give any deferred heal a chance to (wrongly) fire.
    await act(async () => {
      await Promise.resolve();
    });

    // Withheld: capture gone (unmounted), panel shown, still Personal, and
    // the heal switch to owned-1 NEVER fired.
    expect(screen.queryByTestId("capture-content")).toBeNull();
    expect(screen.getByTestId("active-ws").textContent).toBe("personal-1");
    expect(healSwitchCount("owned-1")).toBe(0);
    // The panel names the withheld work and offers the explicit release.
    expect(screen.getByTestId("personal-space-discard-continue")).not.toBeNull();
    expect(
      screen.getByText("Staged evidence in Capture"),
    ).not.toBeNull();
  });

  it("3. a policy flip during a dirty settings/form is equally withheld", async () => {
    apiState.refreshEnvelope = disallowedPersonal("owned-1");
    apiState.switchEnvelope = healedWorkspace("owned-1");
    const user = userEvent.setup();

    render(
      <Providers envelope={allowedPersonal()}>
        <FlipControl />
        <GateHost>
          <DirtySurface dirty label="Unsaved changes in Settings" />
          <div data-testid="settings-content">SETTINGS UI</div>
        </GateHost>
      </Providers>,
    );

    await user.click(screen.getByTestId("flip"));
    await waitFor(() =>
      expect(screen.getByTestId("personal-space-unavailable")).not.toBeNull(),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("active-ws").textContent).toBe("personal-1");
    expect(healSwitchCount("owned-1")).toBe(0);
  });

  it("8. the explicit 'Discard unsaved work and continue' action releases the latch and THEN the clean heal proceeds", async () => {
    apiState.refreshEnvelope = disallowedPersonal("owned-1");
    apiState.switchEnvelope = healedWorkspace("owned-1");
    const user = userEvent.setup();

    render(
      <Providers envelope={allowedPersonal()}>
        <FlipControl />
        <GateHost>
          <DirtySurface dirty label="Staged evidence in Capture" />
          <div data-testid="capture-content">CAPTURE UI</div>
        </GateHost>
      </Providers>,
    );

    await user.click(screen.getByTestId("flip"));
    await waitFor(() =>
      expect(screen.getByTestId("personal-space-discard-continue")).not.toBeNull(),
    );
    expect(healSwitchCount("owned-1")).toBe(0);

    // Explicit resolution → latch releases → heal proceeds.
    await user.click(screen.getByTestId("personal-space-discard-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("owned-1"),
    );
    expect(healSwitchCount("owned-1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior A / no cross-org redirect / no evidence mutation (clean heal).
// ---------------------------------------------------------------------------

describe("PHASE 10 FIX 3 — a clean heal targets only a server-listed workspace (behaviors A, no-redirect, no-mutation)", () => {
  it("1. a clean disallowed Personal context heals into the owned workspace and renders content", async () => {
    apiState.switchEnvelope = healedWorkspace("owned-1");
    render(
      <Providers envelope={disallowedPersonal("owned-1")}>
        <GateHost>
          <div data-testid="content">CONTENT</div>
        </GateHost>
      </Providers>,
    );
    // Blocked while healing, never Personal content.
    expect(screen.queryByTestId("content")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("owned-1"),
    );
    expect(screen.getByTestId("content")).not.toBeNull();
  });

  it("11. an Org member's disallowed Personal heals ONLY into the server-listed workspace — never a fabricated other organization", async () => {
    apiState.switchEnvelope = healedWorkspace("org-a-ws");
    render(
      <Providers
        envelope={disallowedPersonal(null, {
          orgId: "org-a",
          workspaceId: "org-a-ws",
        } as never)}
      >
        <GateHost>
          <div data-testid="content">CONTENT</div>
        </GateHost>
      </Providers>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("org-a-ws"),
    );
    expect(healSwitchCount("org-a-ws")).toBe(1);
    expect(apiState.calls.some((c) => c.includes("org-b"))).toBe(false);
  });

  it("12. the heal touches ONLY the switch-workspace endpoint — no evidence transfer/mutation (historical Personal evidence untouched)", async () => {
    apiState.switchEnvelope = healedWorkspace("owned-1");
    render(
      <Providers envelope={disallowedPersonal("owned-1")}>
        <GateHost>
          <div data-testid="content">CONTENT</div>
        </GateHost>
      </Providers>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("owned-1"),
    );
    const nonBody = apiState.calls.filter((c) => !c.startsWith("BODY:"));
    expect(nonBody.every((c) => c.includes("switch-workspace"))).toBe(true);
    expect(apiState.calls.some((c) => /evidence|transfer|parts|complete/.test(c))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Behavior C — active upload not rebound + stale finalize dropped.
// ---------------------------------------------------------------------------

describe("PHASE 10 FIX 3 — active upload is not rebound and a stale finalize cannot commit (behavior C)", () => {
  it("4. an in-flight upload keeps its construction-bound workspace across a heal — never rebound", async () => {
    apiState.calls = [];
    const file = new File([new Uint8Array(16)], "e.bin", {
      type: "application/octet-stream",
    });
    const uploader = new MultipartUploader({
      sessionId: "sess-1",
      teamId: "personal-1", // the ORIGINAL authoritative workspace
      file,
      isOnline: () => true,
    });
    await uploader.start().catch(() => undefined);
    const bodies = apiState.calls.filter((c) => c.startsWith("BODY:"));
    const withTeam = bodies.filter((b) => b.includes("teamId"));
    expect(withTeam.length).toBeGreaterThan(0);
    // Every request carries the ORIGINAL workspace — no setter, nothing reads
    // an "active workspace", so a heal cannot redirect this uploader.
    expect(withTeam.every((b) => b.includes('"teamId":"personal-1"'))).toBe(true);
    expect(bodies.some((b) => b.includes("owned-1"))).toBe(false);
  });

  it("5. a finalize captured before the heal's context-generation change is DROPPED after the heal", async () => {
    apiState.refreshEnvelope = disallowedPersonal("owned-1");
    apiState.switchEnvelope = healedWorkspace("owned-1");
    const user = userEvent.setup();

    function FinalizeProbe() {
      const { runGuarded } = useWorkspaceContextSafety({
        isDirty: false,
        dirtyLabel: "x",
      });
      const [committed, setCommitted] = useState("no");
      const start = () => {
        const p = new Promise<string>((resolve) => {
          (window as unknown as { __resolveFinalize: (v: string) => void }).__resolveFinalize =
            resolve;
        });
        void runGuarded(
          () => p,
          () => setCommitted("yes"),
        );
      };
      return (
        <div>
          <span data-testid="committed">{committed}</span>
          <button data-testid="start-finalize" onClick={start}>
            start
          </button>
        </div>
      );
    }

    // Mount ALLOWED so no heal fires yet; capture the finalize at generation 0.
    render(
      <Providers envelope={allowedPersonal()}>
        <FlipControl />
        <GateHost>
          <FinalizeProbe />
        </GateHost>
      </Providers>,
    );
    await user.click(screen.getByTestId("start-finalize")); // finalize in flight (gen 0)

    // Flip to disallowed → clean heal → switch to owned-1 → generation bumps.
    await user.click(screen.getByTestId("flip"));
    await waitFor(() =>
      expect(screen.getByTestId("active-ws").textContent).toBe("owned-1"),
    );

    // Resolve the pre-heal finalize now — the stale-tenant guard drops it.
    await act(async () => {
      (
        window as unknown as { __resolveFinalize: (v: string) => void }
      ).__resolveFinalize("finalized");
    });
    expect(screen.getByTestId("committed").textContent).toBe("no");
  });
});

// ---------------------------------------------------------------------------
// Behavior D — polling disposed by context generation across the heal.
// ---------------------------------------------------------------------------

describe("PHASE 10 FIX 3 — background polling is disposed across the heal (behavior D)", () => {
  it("6. a workspace-keyed poller is disposed when the heal switches context — no post-heal ticks for the old workspace", async () => {
    vi.useFakeTimers();
    const ticks: string[] = [];
    apiState.switchEnvelope = healedWorkspace("owned-1");

    // The SAME `}, [workspaceId]` + clearInterval shape used across
    // evidence/governance/integrations pollers.
    function TenantPoller() {
      const { activeWorkspaceId } = usePlatformContext();
      useEffect(() => {
        const captured = activeWorkspaceId;
        const handle = setInterval(() => ticks.push(captured ?? "none"), 10);
        return () => clearInterval(handle);
      }, [activeWorkspaceId]);
      return null;
    }

    render(
      <Providers envelope={disallowedPersonal("owned-1")}>
        <GateHost>
          <TenantPoller />
        </GateHost>
      </Providers>,
    );

    // Let the auto-heal resolve (flush the mocked async switch + timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    const personalTicksBefore = ticks.filter((t) => t === "personal-1").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const personalTicksAfter = ticks.filter((t) => t === "personal-1").length;
    // No NEW personal-1 ticks after the heal disposed the old interval.
    expect(personalTicksAfter).toBe(personalTicksBefore);
    // The current poller ticks under the healed workspace only.
    expect(ticks.some((t) => t === "owned-1")).toBe(true);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Draft keying — the preserved draft stays under the ORIGINAL Personal key.
// ---------------------------------------------------------------------------

describe("PHASE 10 FIX 3 — a preserved draft stays keyed to the original Personal context (behavior B storage)", () => {
  it("7. while withheld, a workspace-keyed draft written in the Personal context stays under the Personal workspace key (no switch, no leak)", async () => {
    apiState.refreshEnvelope = disallowedPersonal("owned-1");
    apiState.switchEnvelope = healedWorkspace("owned-1");
    const user = userEvent.setup();

    function DraftSurface() {
      const { value, setValue } = useTenantDraft<string>("capture-draft", "");
      useDirtyWork(value.length > 0, "Staged evidence in Capture");
      return (
        <button data-testid="stage" onClick={() => setValue("personal-secret")}>
          {value || "empty"}
        </button>
      );
    }

    render(
      <Providers envelope={allowedPersonal()}>
        <FlipControl />
        <GateHost>
          <DraftSurface />
        </GateHost>
      </Providers>,
    );

    // Stage a draft in the Personal context (registers dirty).
    await user.click(screen.getByTestId("stage"));
    // Flip policy → withheld (dirty) → blocked, no switch.
    await user.click(screen.getByTestId("flip"));
    await waitFor(() =>
      expect(screen.getByTestId("personal-space-unavailable")).not.toBeNull(),
    );

    // Still Personal (no switch) and the draft physically lives under the
    // ORIGINAL Personal workspace's tenant key — never a healed workspace's.
    expect(screen.getByTestId("active-ws").textContent).toBe("personal-1");
    expect(healSwitchCount("owned-1")).toBe(0);
    expect(
      window.localStorage.getItem(tenantStorageKey("personal-1", "capture-draft")),
    ).toContain("personal-secret");
    expect(
      window.localStorage.getItem(tenantStorageKey("owned-1", "capture-draft")),
    ).toBeNull();
  });
});
