/**
 * PHASE 38.9 — Rollout completion source-contract tests.
 *
 * Covers:
 *   1. Sidebar canonicalization — AppSidebarV2 reads ONLY from the
 *      route registry + resolvers, with no envelope.navigation
 *      consumption.
 *   2. Additional PageRouteGate migrations (Evidence / Capture /
 *      Notifications / Integrations / Settings / Billing / Retention /
 *      Persona) — each wraps in <PageRouteGate routeId="…">.
 *   3. Route registry expansion — workspace.notifications and
 *      workspace.integrations exist as canonical entries.
 *   4. Command palette mounts the canonical workflow safety notice.
 *   5. Copy-safety lock expansion — forbidden strings stay absent,
 *      required safety statement appears on Tools / Persona / Command
 *      Palette.
 *   6. Cumulative PageRouteGate adoption ≥ 16 pages.
 *   7. Architectural locks: no new useTeamWorkspaceGate consumers,
 *      no workflow used for access control in the sidebar.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const PALETTE = readWeb("components/navigation/CommandPalette.tsx");
const SAFETY = readWeb("components/navigation/WorkflowSafetyNotice.tsx");

// =============================================================================
// PART 1 — Sidebar canonicalization
// =============================================================================

describe("Phase 38.9 — sidebar consumes only canonical registry + resolvers", () => {
  it("imports ROUTE_REGISTRY from the canonical registry", () => {
    expect(SIDEBAR).toMatch(
      /import\s*\{[\s\S]*ROUTE_REGISTRY[\s\S]*\}\s*from\s*["'][^"']*navigation\/routeRegistry["']/,
    );
  });

  it("imports resolveRouteAccess from the canonical resolver", () => {
    expect(SIDEBAR).toMatch(
      /import\s*\{[\s\S]*resolveRouteAccess[\s\S]*\}\s*from\s*["'][^"']*navigation\/routeAccessResolver["']/,
    );
  });

  it("imports resolveWorkflowExposure from the canonical exposure resolver", () => {
    expect(SIDEBAR).toMatch(
      /import\s*\{[\s\S]*resolveWorkflowExposure[\s\S]*\}\s*from\s*["'][^"']*navigation\/workflowExposureResolver["']/,
    );
  });

  it("does NOT consume envelope.navigation.groups for rendering", () => {
    // Strip comments first — the docstring intentionally references
    // the legacy projection by name to explain what was removed.
    const stripped = SIDEBAR.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/.*$/gm,
      "",
    );
    expect(stripped).not.toMatch(/envelope\??\.navigation\??\.groups/);
  });

  it("does NOT import splitByPersona / reorderByPersona (replaced by exposure resolver)", () => {
    expect(SIDEBAR).not.toMatch(/import\s*\{[\s\S]*splitByPersona/);
    expect(SIDEBAR).not.toMatch(/import\s*\{[\s\S]*reorderByPersona/);
  });

  it("never calls apiFetch", () => {
    expect(SIDEBAR).not.toMatch(/apiFetch\s*\(/);
  });

  it("does NOT derive role / platform-admin / capability locally — reads envelope only", () => {
    // The sidebar may *read* envelope.platform.isPlatformAdmin as a
    // pass-through value, but it must never *derive* role/admin from
    // string membership (e.g. role === "OWNER").
    expect(SIDEBAR).not.toMatch(/role\s*===\s*["']OWNER["']/);
    expect(SIDEBAR).not.toMatch(/role\s*===\s*["']ADMIN["']/);
    expect(SIDEBAR).not.toMatch(/role\s*===\s*["']MEMBER["']/);
  });

  it("workflow is used only for bucketing — never as a sidebar access gate", () => {
    // The exposure resolver buckets by workflow but does not re-decide
    // access. Sanity-check: no `if (workflow ...) return null` patterns
    // in the sidebar source.
    expect(SIDEBAR).not.toMatch(
      /if\s*\(\s*(primaryWorkflow|workflow)\s*[!=]==\s*["'][A-Z_]+["']\s*\)\s*\{?\s*return\s+null/m,
    );
  });

  it("renders an All Tools sidebar surface so the universal fallback is reachable", () => {
    expect(SIDEBAR).toMatch(/href="\/tools"/);
    expect(SIDEBAR).toMatch(/All Tools/);
  });

  it("emits structured data-sidebar-access-state attribute for denied-but-visible routes", () => {
    expect(SIDEBAR).toMatch(/data-sidebar-access-state/);
  });
});

// =============================================================================
// PART 2 — Route registry expansion
// =============================================================================

describe("Phase 38.9 — route registry expansion", () => {
  it("declares workspace.notifications as a canonical route", () => {
    expect(REGISTRY).toMatch(/id:\s*"workspace\.notifications"/);
    expect(REGISTRY).toMatch(/href:\s*"\/notifications"/);
  });

  it("declares workspace.integrations as a canonical route", () => {
    expect(REGISTRY).toMatch(/id:\s*"workspace\.integrations"/);
    expect(REGISTRY).toMatch(/href:\s*"\/integrations"/);
  });

  it("notifications & integrations are sidebar-eligible (so they appear in nav buckets)", () => {
    const notif = REGISTRY.match(
      /id:\s*"workspace\.notifications"[\s\S]*?sidebarEligible:\s*(true|false)/,
    );
    const integ = REGISTRY.match(
      /id:\s*"workspace\.integrations"[\s\S]*?sidebarEligible:\s*(true|false)/,
    );
    expect(notif?.[1]).toBe("true");
    expect(integ?.[1]).toBe("true");
  });
});

// =============================================================================
// PART 3 — Additional page migrations
// =============================================================================

describe("Phase 38.9 — additional PageRouteGate migrations", () => {
  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    { page: "app/(app)/evidence/page.tsx", routeId: "workspace.evidence" },
    { page: "app/(app)/capture/page.tsx", routeId: "workspace.capture" },
    {
      page: "app/(app)/notifications/page.tsx",
      routeId: "workspace.notifications",
    },
    {
      page: "app/(app)/integrations/page.tsx",
      routeId: "workspace.integrations",
    },
    { page: "app/(app)/settings/page.tsx", routeId: "account.settings" },
    { page: "app/(app)/billing/page.tsx", routeId: "account.billing" },
    {
      page: "app/(app)/governance/retention/page.tsx",
      routeId: "governance.retention",
    },
    {
      page: "app/(app)/settings/persona/page.tsx",
      routeId: "account.persona",
    },
  ];

  for (const entry of MIGRATIONS) {
    it(`${entry.page} wraps canonical content in <PageRouteGate routeId="${entry.routeId}">`, () => {
      const src = readWeb(entry.page);
      expect(src).toMatch(/PageRouteGate/);
      expect(src).toMatch(
        new RegExp(`routeId="${entry.routeId.replace(/\./g, "\\.")}"`),
      );
      expect(src).toMatch(/from\s+["'].*navigation\/PageRouteGate["']/);
    });
  }
});

// =============================================================================
// PART 4 — Cumulative migration tally (≥ 16 pages)
// =============================================================================

describe("Phase 38.9 — cumulative <PageRouteGate> adoption", () => {
  it("at least 16 canonical pages now wrap in <PageRouteGate>", () => {
    const PAGES = [
      // Phase 38.7
      "app/(app)/reports/page.tsx",
      "app/(app)/cases/page.tsx",
      "app/(app)/search/page.tsx",
      // Phase 38.8
      "app/(app)/home/page.tsx",
      "app/(app)/governance/page.tsx",
      "app/(app)/reviewer-ops/page.tsx",
      "app/(app)/ops/page.tsx",
      "app/(app)/teams/page.tsx",
      // Phase 38.9
      "app/(app)/evidence/page.tsx",
      "app/(app)/capture/page.tsx",
      "app/(app)/notifications/page.tsx",
      "app/(app)/integrations/page.tsx",
      "app/(app)/settings/page.tsx",
      "app/(app)/billing/page.tsx",
      "app/(app)/governance/retention/page.tsx",
      "app/(app)/settings/persona/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(16);
  });
});

// =============================================================================
// PART 5 — Workflow safety notice + canonical statement
// =============================================================================

describe("Phase 38.9 — canonical workflow safety statement", () => {
  it("WorkflowSafetyNotice exposes the exact bounded statement constant", () => {
    expect(SAFETY).toMatch(
      /WORKFLOW_SAFETY_STATEMENT\s*=\s*["']Workflow profiles personalize layout, defaults, and recommendations\. They do not change permissions or remove tools\.["']/,
    );
  });

  it("command palette mounts the safety statement so users always see it", () => {
    expect(PALETTE).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
    expect(PALETTE).toMatch(/data-command-palette-safety-notice/);
  });

  it("All Tools page still mentions the safety statement (Phase 38.7 lock holds)", () => {
    const src = readWeb("app/(app)/tools/page.tsx");
    expect(src).toMatch(
      /Workflow profiles personalize layout, defaults, and\s+recommendations\. They do not change permissions or remove tools\./,
    );
  });

  it("persona wizard footnote retains the canonical safety statement (Phase 38.7 lock holds)", () => {
    const src = readWeb("app/(app)/settings/persona/page.tsx");
    expect(src).toMatch(
      /workflow profile tunes ordering, defaults, and labels\. It does\s+NOT change/i,
    );
  });
});

// =============================================================================
// PART 6 — Forbidden user-facing copy stays absent (lock expansion)
// =============================================================================

describe("Phase 38.9 — forbidden profession-locking copy stays absent in user-facing files", () => {
  const FILES = [
    "components/app-shell-v2/AppSidebarV2.tsx",
    "components/navigation/CommandPalette.tsx",
    "components/navigation/PageRouteGate.tsx",
    "components/navigation/WorkflowSafetyNotice.tsx",
    "app/(app)/tools/page.tsx",
    "app/(app)/settings/persona/page.tsx",
  ];

  const BANNED = [
    /"lawyer mode"/i,
    /"journalist mode"/i,
    /"insurance mode"/i,
    /"investigator mode"/i,
    /"only for lawyers"/i,
    /"only for journalists"/i,
    /"only for insurance"/i,
    /"not available for your workflow"/i,
    /"hidden because of workflow"/i,
    /"profession-only"/i,
  ];

  for (const file of FILES) {
    it(`${file} contains no profession-locking copy`, () => {
      const src = readWeb(file);
      for (const pattern of BANNED) {
        expect(src, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});

// =============================================================================
// PART 7 — Sidebar still reads only canonical state (no new local authority)
// =============================================================================

describe("Phase 38.9 — sidebar does not reintroduce local authority", () => {
  it("does not import useTeamWorkspaceGate", () => {
    expect(SIDEBAR).not.toMatch(/useTeamWorkspaceGate/);
  });

  it("does not read persona.featurePriorityOverrides to remove items", () => {
    // featurePriorityOverrides is a UX-ordering hint and must never be
    // used to filter routes out of the sidebar.
    expect(SIDEBAR).not.toMatch(/featurePriorityOverrides/);
  });

  it("does not perform local capability re-derivation (uses resolveRouteAccess output)", () => {
    // The sidebar calls resolveRouteAccess once per route, then renders.
    // It must NOT perform additional capability checks like
    // `capabilities.X === true` outside of passing them to the resolver.
    expect(SIDEBAR).toMatch(/capabilities,\s*\n\s*accountPlan/);
  });
});
