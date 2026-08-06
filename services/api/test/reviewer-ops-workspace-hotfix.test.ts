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

import { existsSync, readFileSync } from "node:fs";
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

  it("pickMe projects the typed Prisma user row (not an untyped `any`)", () => {
    // The projection is what the operator consoles read; typing its input
    // against the real User row means a field that leaves the model breaks
    // here rather than silently projecting `undefined`.
    expect(src).toMatch(/function pickMe\(u: PrismaUser\)/);
    expect(src).not.toMatch(/function pickMe\(u: any\)/);
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

  it("reports no-workspace when canonical envelope reports no team", () => {
    expect(src).toMatch(/status:\s*"no-workspace"/);
  });
});

// -----------------------------------------------------------------------------
// Canonical gate renderer — PageRouteGate
// -----------------------------------------------------------------------------

describe("canonical reviewer-ops gate renderer", () => {
  // Phase 12 Point 4 Pass D — the local
  // `app/(app)/reviewer-ops/WorkspaceGateState.tsx` renderer was
  // deleted after every reviewer-ops / governance consumer migrated to
  // <PageRouteGate>. The hotfix invariants below (never collapse every
  // failure into "Switch to a workspace"; distinguish auth vs
  // permission vs operational; never render a blank page) are asserted
  // against the renderer that actually mounts.
  const src = readSource(
    "../../../apps/web/components/navigation/PageRouteGate.tsx",
  );

  it("the deleted local reviewer-ops gate renderer stays removed", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../../../apps/web/app/(app)/reviewer-ops/WorkspaceGateState.tsx",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("distinguishes denial reasons instead of collapsing them into one message", () => {
    // Each denied access state maps to canonical denial vocabulary
    // rather than a single hard-coded string.
    expect(src).toContain("accessStateToDenialReason");
    expect(src).toContain("denialReasonHeadline");
    expect(src).toContain("denialReasonGuidance");
    expect(src).toContain('data-page-route-gate-denial-reason');
  });

  it("never renders a blank page — every denied state carries recovery actions", () => {
    expect(src).toContain("ProovraDenialState");
    expect(src).toContain("access.primaryAction");
    expect(src).toContain("page-route-gate-primary-action");
    // The PLATFORM_ADMIN_ONLY branch used to `return null`; it must
    // keep rendering a structured panel with a way back.
    expect(src).toMatch(/PLATFORM_ADMIN_ONLY/);
    expect(src).toContain('label: "Back to home"');
  });

  it("resolves access from the canonical server projection, not a local fetch", () => {
    expect(src).toContain("usePlatformContext");
    expect(src).toContain("resolveRouteAccess");
    expect(src).not.toMatch(/apiFetch\(/);
  });
});

// -----------------------------------------------------------------------------
// Phase 32.8E — main /reviewer-ops console (own Shell states, canonical hook)
// -----------------------------------------------------------------------------

describe("Phase 32.8E — canonical /review console workspace wiring", () => {
  // Phase 12 Point 4 — the Phase-32.8E `ReviewerCommandConsole` lost its
  // mount when `/reviewer-ops` was redirected to `/review`, and was
  // deleted once its unique capabilities (bulk triage, multi-stage
  // summary, runtime banner, operator pivots) were folded into the
  // canonical console. These invariants now target that console.
  const src = readSource(
    "../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx",
  );
  const live = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("does NOT call /v1/users/me directly for workspace resolution", () => {
    expect(live).not.toMatch(/apiFetch\(\s*['"`]\/v1\/users\/me['"`]\s*,/);
  });

  it("takes the workspace subject from the canonical server projection", () => {
    // The page resolves the active space from the platform-context
    // envelope and passes it down; the console re-derives nothing.
    const page = readSource("../../../apps/web/app/(app)/review/page.tsx");
    expect(page).toMatch(/usePlatformContext/);
    expect(page).toMatch(/activeSpace\?\.type === "ORGANIZATION"/);
    expect(live).toMatch(/useActiveSpace\(\)/);
  });

  it("renders bounded loading / error / empty states rather than a bare wall", () => {
    expect(live).toMatch(/setLoading\(true\)/);
    expect(live).toMatch(/setError\(/);
    expect(live).toMatch(/<EmptyState/);
    expect(live).not.toMatch(/ShellNoWorkspace/);
  });

  it("never short-circuits to a bare 'Switch to a workspace' prompt", () => {
    // The canonical PageRouteGate owns the no-workspace path with a
    // structured recovery panel; the console must not grow a second one.
    expect(live).not.toContain('"Switch to a workspace"');
    expect(live).not.toMatch(
      /return\s*\(?\s*<[A-Za-z][^>]*>\s*Switch to a workspace/,
    );
  });
});

// -----------------------------------------------------------------------------
// Page wiring — every reviewer-ops sub-route mounts the canonical gate
// -----------------------------------------------------------------------------

describe("Reviewer Ops sub-routes mount the canonical PageRouteGate", () => {
  // Phase 32.8E — the main `/reviewer-ops` page was rebuilt as the
  // Review Orchestration & Escalation Command console; it ships its own
  // bounded Shell states and is covered above.
  //
  // Phase 38.10/38.11/38.12 migrated every remaining sub-route off the
  // local `WorkspaceGateState` renderer onto `<PageRouteGate>`, and
  // Phase 12 Point 4 Pass D deleted the renderer. The invariant that
  // matters — no reviewer-ops sub-route resolves the workspace itself
  // or short-circuits to a bare "Switch to a workspace" wall — is
  // asserted here against the pages as they ship today.
  const pages: Array<{ name: string; rel: string; routeId: string }> = [
    {
      name: "SLA dashboard",
      rel: "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
      routeId: "review.sla",
    },
    {
      name: "Escalations console",
      rel: "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
      routeId: "review.escalations",
    },
    {
      name: "Review workspace",
      rel: "../../../apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      routeId: "review.queue_detail",
    },
    {
      name: "Governance policy",
      rel: "../../../apps/web/app/(app)/governance/policy/page.tsx",
      routeId: "governance.policy",
    },
  ];

  for (const { name, rel, routeId } of pages) {
    describe(name, () => {
      const src = readSource(rel);
      const live = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

      it("wraps its body in <PageRouteGate> with its registered routeId", () => {
        expect(live).toContain("PageRouteGate");
        expect(live).toContain(`routeId="${routeId}"`);
      });

      it("does NOT resolve the workspace itself from /v1/users/me", () => {
        expect(live).not.toMatch(
          /setTeamId\s*\(\s*r\?\.user\?\.currentWorkspaceId/,
        );
        expect(live).not.toMatch(/apiFetch\(\s*['"`]\/v1\/users\/me['"`]/);
      });

      it("never short-circuits to a bare 'Switch to a workspace' wall", () => {
        // The canonical gate owns the no-workspace path with a
        // structured recovery panel. A page rendering the bare phrase
        // means it re-introduced its own gate.
        expect(live).not.toContain('"Switch to a workspace"');
        const inlineGate = live.match(/Switch to a workspace[^<]*</);
        if (inlineGate) {
          throw new Error(
            `Page ${name} has an inline 'Switch to a workspace' render. The canonical PageRouteGate must own this state.`,
          );
        }
      });

      it("does not import the deleted local gate renderer", () => {
        expect(live).not.toContain("WorkspaceGateState");
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
