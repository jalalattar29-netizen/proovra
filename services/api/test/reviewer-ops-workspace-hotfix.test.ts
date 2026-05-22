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
  const src = readSource(
    "../../../apps/web/lib/useActiveWorkspaceId.ts",
  );

  it("declares the canonical state union", () => {
    expect(src).toContain('status: "loading"');
    expect(src).toContain('status: "ready"');
    expect(src).toContain('status: "no-workspace"');
    expect(src).toContain('status: "error"');
  });

  it("classifies 401 as auth_required", () => {
    expect(src).toContain('"auth_required"');
    expect(src).toContain("statusCode === 401");
  });

  it("classifies 403 as permission_denied", () => {
    expect(src).toContain('"permission_denied"');
    expect(src).toContain("statusCode === 403");
  });

  it("classifies other failures as operational (with requestId)", () => {
    expect(src).toContain('"operational"');
    expect(src).toContain("requestId");
  });

  it("falls back to /v1/teams when currentWorkspaceId is null", () => {
    expect(src).toContain('"/v1/users/me"');
    expect(src).toContain('"/v1/teams"');
  });

  it("treats a /v1/teams fallback with zero items as no-workspace (not error)", () => {
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

  it("renders 403 (permission_denied) state with the canonical copy", () => {
    expect(src).toContain("permission_denied");
    expect(src).toContain(
      "You do not have permission to view Review Operations",
    );
  });

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

  it("uses the canonical useActiveWorkspaceId hook", () => {
    expect(src).toContain("useActiveWorkspaceId");
  });

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

  it("never short-circuits to a bare 'Switch to a workspace' string outside its bounded Shell", () => {
    const live = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const matches = live.match(/Switch to a workspace[^<]*</);
    if (matches) {
      throw new Error(
        "Main /reviewer-ops console has an inline 'Switch to a workspace' render outside the bounded Shell.",
      );
    }
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
  const pages = [
    {
      name: "SLA dashboard",
      rel: "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
      surface: '"SLA"',
    },
    {
      name: "escalations console",
      rel: "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
      surface: '"Escalations"',
    },
    {
      // Phase 32.8B — moved to /governance/policy; legacy path is a redirect.
      name: "policy admin",
      rel: "../../../apps/web/app/(app)/governance/policy/page.tsx",
      surface: '"Governance Policy"',
    },
    {
      name: "review workspace [reviewId]",
      rel: "../../../apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      surface: '"Reviewer Ops"',
    },
  ];

  for (const { name, rel, surface } of pages) {
    describe(name, () => {
      const src = readSource(rel);

      it("imports useActiveWorkspaceId from the canonical hook", () => {
        expect(src).toContain("useActiveWorkspaceId");
      });

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

  it("Command Center routes workspace resolution through the canonical hook (which carries the Phase 32.6.4 fallback)", () => {
    expect(cc).toMatch(/useActiveWorkspaceId\(/);
  });

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
