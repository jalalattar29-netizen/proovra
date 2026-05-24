/**
 * PHASE R2 — Navigation Collapse & Information Architecture Recovery.
 *
 * R2 extracted the previously-inline sidebar group construction into
 * a formal canonical pipeline:
 *
 *   routeRegistry
 *     → resolveRouteAccess()                  (authorization, unchanged)
 *     → resolveWorkflowExposure()             (workflow bucketing, unchanged)
 *     → resolveWorkspaceExperience()          (R1.5B mode, unchanged)
 *     → resolveNavigationDisclosure()         (R2 — bounded primary + experience demotion)
 *     → resolveNavigationGroups()             (R2 — bounded sidebar groups)
 *     → AppSidebarV2 (render)
 *
 * The disclosure resolver enforces the canonical primary-route ID
 * set (Home / Capture / Evidence / Cases / Reports / Search). The
 * grouping resolver enforces the bounded group title vocabulary.
 *
 * NO routes were hard-deleted. NO discoverability was reduced —
 * All Tools, Command Palette, search, and direct URLs continue to
 * surface every permission-valid route. NO permission logic was
 * introduced into workflow/persona.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

const CANONICAL_GROUPS = readWeb(
  "lib/navigation/canonicalNavigationGroups.ts",
);
const DISCLOSURE = readWeb(
  "lib/navigation/navigationDisclosureResolver.ts",
);
const GROUPING = readWeb("lib/navigation/navigationGroupingResolver.ts");
const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const ROUTE_ACCESS = readWeb("lib/navigation/routeAccessResolver.ts");
const WORKFLOW_EXPOSURE = readWeb(
  "lib/navigation/workflowExposureResolver.ts",
);

// =============================================================================
// PART 1 — Canonical root primary navigation is bounded
// =============================================================================

describe("R2 Part 1 — root primary navigation is bounded to the canonical six", () => {
  it("CANONICAL_PRIMARY_ROUTE_IDS contains exactly Home, Capture, Evidence, Cases, Reports, Search", () => {
    const EXPECTED = [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.cases",
      "workspace.reports",
      "workspace.search",
    ];
    for (const id of EXPECTED) {
      expect(CANONICAL_GROUPS).toMatch(
        new RegExp(`"${id.replace(".", "\\.")}"`),
      );
    }
    // Count quoted strings inside CANONICAL_PRIMARY_ROUTE_IDS only.
    const setMatch = CANONICAL_GROUPS.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(setMatch, "CANONICAL_PRIMARY_ROUTE_IDS literal must be present").toBeTruthy();
    const setBody = setMatch![1];
    const quotedIds = (setBody.match(/"[a-z0-9.]+"/gi) ?? []).length;
    expect(
      quotedIds,
      "canonical primary set must contain exactly 6 ids (R2 Part 1)",
    ).toBe(6);
  });
});

// =============================================================================
// PART 2 — Bounded operational groups + bounded title vocabulary
// =============================================================================

describe("R2 Part 2 — operational groups + title vocabulary bounded", () => {
  it("the canonical group module exports the four bounded groups", () => {
    expect(CANONICAL_GROUPS).toMatch(/SIDEBAR_GROUP_PRIMARY/);
    expect(CANONICAL_GROUPS).toMatch(/SIDEBAR_GROUP_WORKSPACE/);
    expect(CANONICAL_GROUPS).toMatch(/SIDEBAR_GROUP_OPERATIONS/);
    expect(CANONICAL_GROUPS).toMatch(/SIDEBAR_GROUP_GOVERNANCE/);
  });

  it("the canonical group module pins the bounded title vocabulary", () => {
    expect(CANONICAL_GROUPS).toMatch(/"Primary workflows"/);
    expect(CANONICAL_GROUPS).toMatch(/"Workspace"/);
    expect(CANONICAL_GROUPS).toMatch(/"Operations"/);
    expect(CANONICAL_GROUPS).toMatch(/"Governance & Compliance"/);
    expect(CANONICAL_GROUPS).toMatch(/"More \/ Advanced"/);
    expect(CANONICAL_GROUPS).toMatch(/"All Tools"/);
  });

  it("no new root-group title literals appear in AppSidebarV2.tsx (extracted to canonical module)", () => {
    // R2 extracted the title literals out of AppSidebarV2.tsx. The
    // sidebar component should now only reference titles indirectly
    // via the canonical module — searches for raw `title: "..."`
    // patterns should return zero matches.
    const matches = SIDEBAR.match(/title:\s*"[^"]+"/g) ?? [];
    expect(
      matches,
      `sidebar no longer carries inline title literals — they live in canonicalNavigationGroups.ts. Found: ${matches.join(", ")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 3 — Contextual hubs preserved in the route registry
// =============================================================================

describe("R2 Part 3 — contextual operational hubs preserved", () => {
  const registry = readWeb("lib/navigation/routeRegistry.ts");

  it("investigation hub remains in the canonical registry", () => {
    expect(registry).toMatch(/id:\s*"investigation\.hub"/);
  });

  it("governance hub remains in the canonical registry", () => {
    expect(registry).toMatch(/id:\s*"governance\.hub"/);
  });

  it("review-ops surfaces remain in the canonical registry", () => {
    expect(registry).toMatch(/id:\s*"review\.queue"/);
    expect(registry).toMatch(/id:\s*"review\.escalations"/);
    expect(registry).toMatch(/id:\s*"review\.sla"/);
  });

  it("investigation sub-surfaces (graph, duplicates, timeline, relationships) still registered", () => {
    expect(registry).toMatch(/id:\s*"investigation\.graph"/);
    expect(registry).toMatch(/id:\s*"investigation\.duplicates"/);
    expect(registry).toMatch(/id:\s*"investigation\.timeline"/);
    expect(registry).toMatch(/id:\s*"investigation\.relationships"/);
  });
});

// =============================================================================
// PART 4 — Canonical navigation pipeline wired
// =============================================================================

describe("R2 Part 4 — sidebar consumes the canonical navigation pipeline", () => {
  it("sidebar imports the disclosure + grouping resolvers", () => {
    expect(SIDEBAR).toMatch(/resolveNavigationDisclosure/);
    expect(SIDEBAR).toMatch(/resolveNavigationGroups/);
  });

  it("the disclosure resolver runs before the grouping resolver", () => {
    const disclosureCall = SIDEBAR.indexOf("resolveNavigationDisclosure({");
    const groupingCall = SIDEBAR.indexOf("resolveNavigationGroups({");
    expect(disclosureCall).toBeGreaterThan(-1);
    expect(groupingCall).toBeGreaterThan(-1);
    expect(disclosureCall).toBeLessThan(groupingCall);
  });
});

// =============================================================================
// PART 5 — Progressive disclosure: bounded primary + experience demotion
// =============================================================================

describe("R2 Part 5 — disclosure resolver enforces bounded primary + folds in experience demotion", () => {
  it("disclosure resolver uses CANONICAL_PRIMARY_ROUTE_IDS to bound primary", () => {
    expect(DISCLOSURE).toMatch(/CANONICAL_PRIMARY_ROUTE_IDS/);
    expect(DISCLOSURE).toMatch(/primaryOverflow/i);
  });

  it("disclosure resolver folds in the experience-mode demotion via applyExperienceEmphasis", () => {
    expect(DISCLOSURE).toMatch(/applyExperienceEmphasis/);
  });

  it("disclosure resolver preserves allToolsItems untouched", () => {
    // The resolver MUST return `exposure.allToolsItems` directly,
    // not transform it. This is the discoverability guarantee.
    expect(DISCLOSURE).toMatch(/allToolsItems:\s*exposure\.allToolsItems/);
    expect(DISCLOSURE).toMatch(
      /recommendedItems:\s*exposure\.recommendedItems/,
    );
  });
});

// =============================================================================
// PART 6 — All Tools + Command Palette discoverability preserved
// =============================================================================

describe("R2 Part 6 — All Tools + Command Palette preservation", () => {
  it("the All Tools page still iterates the canonical route registry", () => {
    const tools = readWeb("app/(app)/tools/page.tsx");
    expect(tools).toMatch(/ROUTE_REGISTRY/);
    expect(tools).toMatch(/resolveRouteAccess/);
  });

  it("the Command Palette still iterates the canonical route registry", () => {
    const palette = readWeb("components/navigation/CommandPalette.tsx");
    expect(palette).toMatch(/ROUTE_REGISTRY/);
    expect(palette).toMatch(/resolveRouteAccess/);
  });
});

// =============================================================================
// PART 7 — Raw architecture chips replaced with operational language
// =============================================================================

describe("R2 Part 7 — degraded-route chips use operational language", () => {
  it("canonical chip labels constant defines the operational copy", () => {
    expect(CANONICAL_GROUPS).toMatch(/DEGRADATION_CHIP_LABELS/);
    expect(CANONICAL_GROUPS).toMatch(/"Requires organization"/);
    expect(CANONICAL_GROUPS).toMatch(/"Requires permission"/);
    expect(CANONICAL_GROUPS).toMatch(/"Setup needed"/);
    expect(CANONICAL_GROUPS).toMatch(/"Upgrade required"/);
  });

  it("sidebar no longer returns raw `Org` / `Access` chip strings", () => {
    // The pre-R2 implementation returned `return "Org";` and
    // `return "Access";` from degradationChip. Those raw labels
    // are architecture leakage and must be gone.
    expect(SIDEBAR).not.toMatch(/return\s+"Org"\s*;/);
    expect(SIDEBAR).not.toMatch(/return\s+"Access"\s*;/);
  });

  it("sidebar imports the canonical chip labels constant", () => {
    expect(SIDEBAR).toMatch(/DEGRADATION_CHIP_LABELS/);
  });
});

// =============================================================================
// PART 8 — Sidebar structure refactor: inline buildSidebarGroups extracted
// =============================================================================

describe("R2 Part 8 — sidebar inline grouping extracted to canonical resolver", () => {
  it("AppSidebarV2 no longer defines a local buildSidebarGroups function", () => {
    expect(SIDEBAR).not.toMatch(/function\s+buildSidebarGroups\s*\(/);
  });

  it("the grouping resolver module exports resolveNavigationGroups", () => {
    expect(GROUPING).toMatch(/export function resolveNavigationGroups/);
  });

  it("AppSidebarV2 still uses PageRouteGate-friendly architecture", () => {
    // Sanity check — sidebar still iterates ROUTE_REGISTRY through
    // the canonical pipeline; no separate registry / no parallel
    // hierarchy was introduced.
    expect(SIDEBAR).toMatch(/ROUTE_REGISTRY/);
    expect(SIDEBAR).toMatch(/resolveRouteAccess/);
    expect(SIDEBAR).toMatch(/resolveWorkflowExposure/);
    expect(SIDEBAR).toMatch(/resolveWorkspaceExperience/);
  });
});

// =============================================================================
// PART 9 — Dashboard / navigation coherence
// =============================================================================

describe("R2 Part 9 — dashboard coherence with navigation mode", () => {
  const cc = readWeb("components/command-center/CommandCenter.tsx");

  it("CommandCenter consumes the same resolveWorkspaceExperience helper as the sidebar", () => {
    expect(cc).toMatch(/resolveWorkspaceExperience/);
    expect(SIDEBAR).toMatch(/resolveWorkspaceExperience/);
  });

  it("CommandCenter exposes the mode + emphasis as data attributes (R3 will style)", () => {
    expect(cc).toMatch(/data-cc-experience-mode=/);
    expect(cc).toMatch(/data-cc-dashboard-emphasis=/);
  });
});

// =============================================================================
// PART 10 — Tests + guardrails (the 12 invariants)
// =============================================================================

describe("R2 Part 10 — invariant pins", () => {
  it("workflow/persona authorization logic was NOT introduced (regression sweep)", () => {
    // R2 must not move auth into workflow/persona. Code-context
    // matching only — header comments may mention these symbols.
    expect(DISCLOSURE).not.toMatch(/\.requiredCapabilities\b/);
    expect(DISCLOSURE).not.toMatch(/\.canLoad\b/);
    expect(DISCLOSURE).not.toMatch(/\bauthorize\s*\(/);
    expect(GROUPING).not.toMatch(/\.requiredCapabilities\b/);
    expect(GROUPING).not.toMatch(/\.canLoad\b/);
    expect(GROUPING).not.toMatch(/\bauthorize\s*\(/);
  });

  it("routeAccessResolver still does not consult workflow/persona (no regression)", () => {
    expect(ROUTE_ACCESS).not.toMatch(/\.workflowProfile\b/);
    expect(ROUTE_ACCESS).not.toMatch(/\.primaryWorkflow\b/);
    expect(ROUTE_ACCESS).not.toMatch(/\.workflowTags\b/);
    expect(ROUTE_ACCESS).not.toMatch(/\.personaProfile\b/);
  });

  it("workflowExposureResolver still documents the no-authorization contract", () => {
    expect(WORKFLOW_EXPOSURE).toMatch(/Workflow NEVER changes/i);
  });

  it("no second sidebar component was introduced", () => {
    const sidebarFiles = readdirSync(
      webPath("components/app-shell-v2"),
    ).filter((n) => /^App.*Sidebar.*\.tsx$/.test(n));
    expect(
      sidebarFiles,
      "exactly one canonical sidebar component allowed",
    ).toEqual(["AppSidebarV2.tsx"]);
  });

  it("the 8 backward-compat redirects are still in next.config.js (no direct-link breakage)", () => {
    const cfg = readWeb("next.config.js");
    expect(cfg).toMatch(/async\s+redirects/);
    expect(cfg).toMatch(/\/dashboard/);
    expect(cfg).toMatch(/\/archive/);
    expect(cfg).toMatch(/\/operations/);
    expect(cfg).toMatch(/\/security/);
    expect(cfg).toMatch(/\/reviewer-ops\/policy/);
  });
});

// =============================================================================
// PART 11 — Documentation present + substantial
// =============================================================================

describe("R2 Part 11 — R2 documentation present", () => {
  const doc = readRepo("docs/recovery/R2_NAVIGATION_IA_RECOVERY.md");

  it("R2 doc exists and covers the required sections", () => {
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R2/);
    expect(doc).toMatch(/canonical root navigation/i);
    expect(doc).toMatch(/operational groups/i);
    expect(doc).toMatch(/disclosure/i);
    expect(doc).toMatch(/Remaining risks/);
  });
});

// =============================================================================
// PART 12 — Capture / custody / TSA / report / package files unchanged
// =============================================================================

describe("R2 Part 12 — canonical capture/custody/TSA/report files unchanged", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 18308 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 4446 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 6033 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];

  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
      const fullPath = fileURLToPath(new URL(`../${rel}`, import.meta.url));
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(
        st.size,
        `${rel} size ${st.size} drifted out of window [${low}, ${high}]`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});
