/**
 * Phase IA-home-fork — the /home surface decision.
 *
 * The previous /home fork sent every non-self-serve case — including
 * the common `plan === null` (loading / no-entitlement) case — to the
 * enterprise CommandCenter. Self-serve users (and everyone during the
 * loading window) saw the wrong dashboard. This pins the corrected
 * contract at BOTH levels:
 *
 *   - the pure decision function `resolveHomeSurface` (unit), and
 *   - the page wiring in app/(app)/home/page.tsx (source contract).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveHomeSurface,
  type HomeSurfaceInput,
} from "../../../apps/web/components/home-experience/resolveHomeSurface";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

// PHASE 12B Track 1A — the decision input is SERVER-projected booleans only
// (isPlatformAdmin / isEnterpriseWorkspace [backend ENTERPRISE_PLAN_KEYS =
// {"ENTERPRISE"}] / planResolved). The old raw-plan table maps exactly onto
// these booleans; every original case is preserved below.
const SELF_SERVE: HomeSurfaceInput = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planResolved: true,
};

describe("Phase IA-home-fork — resolveHomeSurface (server-projected booleans)", () => {
  it("plan unresolved (envelope loading) → loading skeleton (NEVER CommandCenter)", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, planResolved: false })).toBe("loading");
  });

  it("every self-serve resolved context (old FREE/PAYG/PRO/TEAM) → self-serve Home V2", () => {
    // FREE/PAYG/PRO/TEAM all project isEnterpriseWorkspace=false — one case.
    expect(resolveHomeSurface(SELF_SERVE)).toBe("self-serve");
  });

  it("platform admin → command-center (even while the plan is unresolved)", () => {
    expect(
      resolveHomeSurface({ isPlatformAdmin: true, isEnterpriseWorkspace: false, planResolved: false }),
    ).toBe("command-center");
    expect(
      resolveHomeSurface({ isPlatformAdmin: true, isEnterpriseWorkspace: false, planResolved: true }),
    ).toBe("command-center");
  });

  it("enterprise workspace (backend flag from the ENTERPRISE plan) → command-center", () => {
    expect(
      resolveHomeSurface({ isPlatformAdmin: false, isEnterpriseWorkspace: true, planResolved: true }),
    ).toBe("command-center");
  });

  it("CommandCenter is reachable ONLY via an explicit enterprise signal (no fallback)", () => {
    expect(resolveHomeSurface(SELF_SERVE)).not.toBe("command-center");
    expect(resolveHomeSurface({ ...SELF_SERVE, planResolved: false })).not.toBe("command-center");
  });
});

// ============================================================================
// 2. The page wiring — uses the function + the three branches
// ============================================================================

describe("Phase IA-home-fork — home/page.tsx wiring", () => {
  const PAGE = readWeb("app/(app)/home/page.tsx");

  it("delegates the surface decision to resolveHomeSurface", () => {
    expect(PAGE).toMatch(/import \{ resolveHomeSurface \}/);
    expect(PAGE).toMatch(/const decision = resolveHomeSurface\(\{/);
  });

  it("renders CommandCenter ONLY in the command-center branch", () => {
    // CommandCenter appears exactly once, guarded by the decision.
    expect(PAGE).toMatch(/decision === "command-center" \?[\s\S]*?<CommandCenter \/>/);
    // And there is exactly one <CommandCenter /> usage.
    expect((PAGE.match(/<CommandCenter\s*\/>/g) ?? []).length).toBe(1);
  });

  it("renders a loading skeleton for the loading branch (not CommandCenter)", () => {
    expect(PAGE).toMatch(/decision === "loading" \?[\s\S]*?<HomeSkeleton \/>/);
    expect(PAGE).toMatch(/data-home-loading/);
  });

  it("renders SelfServeHomeDashboard as the default branch", () => {
    expect(PAGE).toMatch(/<SelfServeHomeDashboard \/>/);
    expect(PAGE).toMatch(/data-self-serve-home/);
  });

  it("the old fallback fork (showSelfServe / isSelfServePlan) is gone", () => {
    expect(PAGE).not.toMatch(/showSelfServe/);
    expect(PAGE).not.toMatch(/isSelfServePlan/);
  });

  it("still wraps in the canonical PageRouteGate (no regression)", () => {
    expect(PAGE).toMatch(/<PageRouteGate routeId="workspace\.home">/);
  });

  it("CommandCenter cannot be reached without the decision being command-center", () => {
    // There must be no <CommandCenter/> outside the command-center
    // ternary branch. Strip the command-center branch, then assert no
    // CommandCenter render remains.
    const withoutCcBranch = PAGE.replace(
      /decision === "command-center" \?[\s\S]*?\) :/,
      "REMOVED :",
    );
    expect(withoutCcBranch).not.toMatch(/<CommandCenter\s*\/>/);
  });
});

// ============================================================================
// 3. Self-serve users never see CommandCenter's nav grids
// ============================================================================

describe("Phase IA-home-fork — self-serve never sees CommandCenter nav grids", () => {
  it("CommandCenter's nav grids stay in CommandCenter, never in the self-serve dashboard", () => {
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");
    // The CommandCenter 'Operator actions' grid + its quick-action ids
    // must not appear anywhere in the self-serve Home tree.
    expect(DASH).not.toMatch(/Operator actions/);
    expect(DASH).not.toMatch(/data-cc-quick-action/);
    expect(SECTIONS).not.toMatch(/Operator actions/);
    expect(SECTIONS).not.toMatch(/data-cc-quick-action/);
    // And the self-serve dashboard does not import CommandCenter.
    expect(DASH).not.toMatch(/command-center/);
  });

  it("the self-serve dashboard header has no nav-duplicate button row", () => {
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    const header = DASH.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).not.toMatch(/<Link/);
    expect(header).not.toMatch(/<button/);
  });
});
