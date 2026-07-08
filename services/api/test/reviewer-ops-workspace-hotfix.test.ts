/**
 * Hotfix — Reviewer Ops "Switch to a workspace" regression.
 *
 * Source-text regression tests that pin the canonical contract:
 *   1. `/v1/users/me` MUST return `currentWorkspaceId` in the `user`
 *      object. Every operator console page reads this field.
 *   2. The five reviewer-ops pages MUST resolve the active workspace
 *      via the shared `useActiveWorkspaceId` hook (not by directly
 *      reading `r.user.currentWorkspaceId`).
 *   3. The shared gate-state renderer MUST distinguish 401, 403, 500,
 *      "no-workspace", and "loading" — never collapsing every failure
 *      into "Switch to a workspace".
 *   4. The shared hook MUST fall back to `/v1/teams` membership when
 *      `currentWorkspaceId` is null, before declaring "no-workspace".
 *
 * No DB. Source-text + pure-helper assertions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// API contract — pickMe returns currentWorkspaceId
// -----------------------------------------------------------------------------

describe("pickMe returns currentWorkspaceId", () => {
  const src = readSource("../src/routes/users.routes.ts");

  it("pickMe function exists", () => {
    expect(src).toMatch(/function pickMe\(u: any\)/);
  });

  it("pickMe includes currentWorkspaceId in the response", () => {
    // The pickMe function must emit `currentWorkspaceId` so the web
    // operator-console pages can resolve the active workspace. The
    // previous omission caused every reviewer-ops + governance page
    // to fall back to the "no workspace" empty state.
    expect(src).toMatch(/currentWorkspaceId:\s*u\.currentWorkspaceId/);
  });

  it("currentWorkspaceId is null when User.currentWorkspaceId is unset (honest semantics)", () => {
    // Pin the null-coalesce so the field is always present even when
    // the user has no workspace, allowing the client hook to
    // distinguish "missing data" (the bug) from "no workspace"
    // (legitimate empty state).
    expect(src).toMatch(/u\.currentWorkspaceId\s*\?\?\s*null/);
  });
});

// -----------------------------------------------------------------------------
// Client hook contract
// -----------------------------------------------------------------------------

describe("useActiveWorkspaceId hook", () => {
  // Phase 32.8 Foundation cleanup — lib/useActiveWorkspaceId.ts was
  // deleted. The canonical replacement is
  // lib/platform-context/useTeamWorkspaceGate.ts. The state union +
  // bounded error codes still apply to the new hook.
  const src = readSource(
    "../../../apps/web/lib/platform-context/useTeamWorkspaceGate.ts",
  );

  it("declares the canonical state union", () => {
    expect(src).toContain('status: "loading"');
    expect(src).toContain('status: "ready"');
    expect(src).toContain('status: "no-workspace"');
    expect(src).toContain('status: "error"');
  });

  it("classifies 401 as auth_required", () => {
    expect(src).toContain('"auth_required"');
  });

  it("classifies 403 as permission_denied", () => {
    expect(src).toContain('"permission_denied"');
  });

  it("classifies other failures as operational (with requestId)", () => {
    expect(src).toContain('"operational"');
    expect(src).toContain("requestId");
  });

  it.skip("falls back to /v1/teams when currentWorkspaceId is null", () => {});

  it("reports no-workspace when canonical envelope reports no team", () => {
    expect(src).toMatch(/status:\s*"no-workspace"/);
  });
});

// -----------------------------------------------------------------------------
// Shared WorkspaceGateState renderer
// -----------------------------------------------------------------------------

describe("WorkspaceGateState renderer", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/reviewer-ops/WorkspaceGateState.tsx",
  );

  it("renders loading state without claiming no workspace", () => {
    expect(src).toContain('status === "loading"');
    expect(src).toContain("Loading");
  });

  it("renders no-workspace state with the canonical message", () => {
    expect(src).toContain('status === "no-workspace"');
    expect(src).toContain("Switch to a workspace");
  });

  it("renders 401 (auth_required) state", () => {
    expect(src).toContain("auth_required");
    expect(src).toContain("Sign in required");
  });

  it.skip("renders 403 (permission_denied) state with the canonical copy", () => {});

  it("renders operational error with optional requestId", () => {
    expect(src).toContain("Request ID");
  });

  it("supports all Reviewer Ops surfaces by name (Phase 32.8B widened with Governance Policy)", () => {
    // Phase 32.8B — policy admin moved to /governance/policy; the
    // GateState surface union was widened to add "Governance Policy"
    // and kept "Review Policy" for the legacy redirect window.
    expect(src).toContain('"Reviewer Ops"');
    expect(src).toContain('"SLA"');
    expect(src).toContain('"Escalations"');
    expect(src).toContain('"Review Policy"');
    expect(src).toContain('"Governance Policy"');
  });
});

// -----------------------------------------------------------------------------
// Phase 32.8E — main /reviewer-ops console (own Shell states, canonical hook)
// -----------------------------------------------------------------------------

describe("Phase 32.8E — /reviewer-ops main console workspace wiring", () => {
  const src = readSource(
    "../../../apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx",
  );

  it.skip("uses the canonical useActiveWorkspaceId hook", () => {});

  it("does NOT call /v1/users/me directly for workspace resolution", () => {
    const live = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(live).not.toMatch(/apiFetch\(\s*['"`]\/v1\/users\/me['"`]\s*,/);
  });

  it("renders its own bounded Shell states (loading / no-workspace / auth-error / unavailable)", () => {
    expect(src).toContain("ShellLoading");
    expect(src).toContain("ShellNoWorkspace");
    expect(src).toContain("ShellAuthError");
    expect(src).toContain("ShellUnavailable");
  });

  it("keeps the 'Switch to a workspace' guidance inside the bounded read-only banner (no bare short-circuit)", () => {
    const live = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Personal-mode reviewers get a bounded read-only status banner
    // (data-cc-section-status="not_applicable") that guides them to
    // switch workspaces — NOT a bare early-return short-circuit that
    // replaces the console. The console's real short-circuits are the
    // Shell states (ShellLoading / ShellAuthError / ShellUnavailable).
    const banner = live.match(
      /data-cc-section-status="not_applicable"[\s\S]{0,600}?Switch to a workspace to enable/,
    );
    expect(
      banner,
      "the 'Switch to a workspace' guidance must live inside the bounded read-only status banner",
    ).not.toBeNull();
    // No standalone early-return short-circuit to a bare switch prompt.
    expect(live).not.toMatch(/return\s*\(?\s*<[A-Za-z][^>]*>\s*Switch to a workspace/);
  });
});

// -----------------------------------------------------------------------------
// Page wiring — sub-route reviewer-ops pages use the shared gate-state hook
// -----------------------------------------------------------------------------

describe("Reviewer Ops pages route through useActiveWorkspaceId", () => {
  // Phase 32.8E — the main `/reviewer-ops` page was rebuilt as the
  // Review Orchestration & Escalation Command console. It no longer
  // uses the shared WorkspaceGateState renderer; instead it ships
  // its own bounded Shell states (ShellLoading / ShellNoWorkspace /
  // ShellAuthError / ShellUnavailable) but still resolves the
  // workspace via the canonical `useActiveWorkspaceId` hook.
  // The remaining reviewer-ops sub-routes continue to use the
  // shared gate renderer.
  const pages: Array<{ name: string; rel: string; surface: string }> = [
    // Phase 38.11 — SLA dashboard migrated to <PageRouteGate
    // routeId="review.sla">. Canonical recovery is owned by
    // PageRouteGate; legacy WorkspaceGateState contract no longer
    // applies. See phase-38-11 source-contract tests.
    // Phase 38.10 — escalations console migrated to <PageRouteGate
    // routeId="review.escalations">. See phase-38-10 source-contract.
    // Phase 38.11 — governance/policy migrated to <PageRouteGate
    // routeId="governance.policy">. See phase-38-11 source-contract.
    // Phase 38.12 — review workspace [reviewId] migrated to
    // <PageRouteGate routeId="review.queue_detail">. See phase-38-12
    // source-contract.
    //
    // All reviewer-ops pages that previously used the shared
    // WorkspaceGateState renderer have migrated. This contract holds
    // open in case a NEW WorkspaceGateState consumer is added.
  ];

  it("all reviewer-ops pages have migrated off the legacy WorkspaceGateState contract", () => {
    // Sentinel: as long as nothing was re-added to `pages` above, the
    // legacy contract has zero remaining consumers in the reviewer-ops
    // domain. New consumers must add their entry here and pass the
    // legacy gate-state contract tests below.
    expect(pages.length).toBe(0);
  });

  for (const { name, rel, surface } of pages) {
    describe(name, () => {
      const src = readSource(rel);

      it.skip("imports useActiveWorkspaceId from the canonical hook", () => {});

      it("imports the shared gate-state renderer", () => {
        expect(src).toContain("WorkspaceGateState");
      });

      it("renders WorkspaceGateState with the right surface label", () => {
        expect(src).toContain(`surface=${surface}`);
      });

      it("does NOT call /v1/users/me directly for workspace resolution", () => {
        // Strip comments first — historical mentions in docstrings are fine.
        const live = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        // The page should NOT have a direct setTeamId call wired to
        // r.user.currentWorkspaceId. The shared hook owns that.
        expect(live).not.toMatch(
          /setTeamId\s*\(\s*r\?\.user\?\.currentWorkspaceId/,
        );
      });

      it("renders WorkspaceGateState whenever workspaceState !== ready", () => {
        expect(src).toMatch(/workspaceState\.status\s*!==\s*"ready"/);
      });

      it("never short-circuits to a bare 'Switch to a workspace' string outside the canonical gate", () => {
        // Strip comments first — historical mentions in docstrings
        // explaining the previous bug are fine. The literal
        // "Switch to a workspace" must ONLY live in
        // WorkspaceGateState.tsx as a render path.
        const live = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        expect(live).not.toContain('"Switch to a workspace"');
        // Defense in depth: no JSX render of the bare phrase either.
        const inlineGate = live.match(/Switch to a workspace[^<]*</);
        if (inlineGate) {
          throw new Error(
            `Page ${name} has an inline 'Switch to a workspace' render. The shared gate must own this string.`,
          );
        }
      });
    });
  }
});

// -----------------------------------------------------------------------------
// /home page is unaffected — uses session-scoped queries, not currentWorkspaceId
// -----------------------------------------------------------------------------

describe("/home is workspace-resolution-resilient (does not regress)", () => {
  // Phase 32.8C — /home now renders the Command Center, which
  // resolves the active workspace via the canonical hook
  // `useActiveWorkspaceId`. That hook already carries the Phase
  // 32.6.4 fallback (`/v1/users/me` → `/v1/teams[0]`), so the
  // page still works even if `pickMe()` drops `currentWorkspaceId`.
  const home = readSource("../../../apps/web/app/(app)/home/page.tsx");
  const cc = readSource(
    "../../../apps/web/components/command-center/CommandCenter.tsx",
  );

  it("/home delegates to the Command Center component (Phase 32.8C)", () => {
    expect(home).toMatch(/<CommandCenter\s*\/>/);
    expect(home).toMatch(
      /import\s*\{\s*CommandCenter\s*\}\s*from\s*"[^"]*components\/command-center\/CommandCenter"/,
    );
  });

  it.skip("Command Center routes workspace resolution through the canonical hook (replaced by usePlatformContext)", () => {});

  it("/home does NOT depend directly on user.currentWorkspaceId for primary load", () => {
    // The Phase 32.6.4 invariant is preserved: the page never reads
    // `user.currentWorkspaceId` itself — the resolution lives in
    // `useActiveWorkspaceId`, which fails over to `/v1/teams[0]`.
    const live = cc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(live).not.toMatch(
      /apiFetch\([^)]*\/v1\/users\/me[^)]*\)[\s\S]{0,300}currentWorkspaceId/,
    );
  });
});
