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
} from "../../../apps/web/lib/surface/resolveHomeSurface";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const SELF_SERVE: Omit<HomeSurfaceInput, "plan"> = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

// ============================================================================
// 1. The decision function — every required case
// ============================================================================

describe("Phase IA-home-fork — resolveHomeSurface", () => {
  it("plan null → loading skeleton (NEVER CommandCenter)", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: null })).toBe("loading");
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: undefined })).toBe("loading");
  });

  it("PRO → self-serve Home V2", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: "PRO" })).toBe("self-serve");
  });

  it("TEAM → self-serve Home V2", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: "TEAM" })).toBe("self-serve");
  });

  it("FREE → self-serve Home V2", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: "FREE" })).toBe("self-serve");
  });

  it("PAYG → self-serve Home V2", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: "PAYG" })).toBe("self-serve");
  });

  it("platform admin → command-center", () => {
    expect(
      resolveHomeSurface({ plan: null, isPlatformAdmin: true, isEnterpriseWorkspace: false }),
    ).toBe("command-center");
    // Even with a self-serve plan, a platform admin still gets CC.
    expect(
      resolveHomeSurface({ plan: "PRO", isPlatformAdmin: true, isEnterpriseWorkspace: false }),
    ).toBe("command-center");
  });

  it("enterprise workspace → command-center", () => {
    expect(
      resolveHomeSurface({ plan: "PRO", isPlatformAdmin: false, isEnterpriseWorkspace: true }),
    ).toBe("command-center");
  });

  it("ENTERPRISE plan → command-center", () => {
    expect(resolveHomeSurface({ ...SELF_SERVE, plan: "ENTERPRISE" })).toBe(
      "command-center",
    );
  });

  it("a self-serve user NEVER resolves to command-center for any self-serve plan", () => {
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM"]) {
      expect(resolveHomeSurface({ ...SELF_SERVE, plan })).not.toBe("command-center");
    }
  });

  it("CommandCenter is reachable ONLY via an explicit enterprise signal", () => {
    // No enterprise signal of any kind ⇒ never command-center, whatever
    // the plan string (incl. unknown future plans).
    for (const plan of [null, undefined, "FREE", "PAYG", "PRO", "TEAM", "SOMETHING_NEW"]) {
      const d = resolveHomeSurface({ ...SELF_SERVE, plan });
      expect(d).not.toBe("command-center");
    }
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
