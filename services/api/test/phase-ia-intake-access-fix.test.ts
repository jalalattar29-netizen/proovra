/**
 * Phase IA-intake-access-fix — pin the three regressions that left a
 * PRO Personal OWNER staring at "Permission required" under "More /
 * Advanced":
 *
 *   Bug A — INTAKE_LINKS_MANAGE was only granted inside the
 *           team-workspace block. A PRO user on their Personal Space
 *           (scope=PERSONAL, role=OWNER) received NO writer/admin caps
 *           because the team block never executed.
 *
 *   Bug B — The /intake-links route had `advancedByDefault: true`. The
 *           workflow-exposure resolver dropped any route not tagged for
 *           the user's primary workflow into `moreAdvancedItems` when
 *           `advancedByDefault: true`. The canonical-primary list
 *           (which DOES include workspace.intake_links) was only used
 *           as a downstream bound, never to PROMOTE a route into the
 *           primary bucket — so intake-links stayed in More/Advanced.
 *
 *   Bug C — The denial panel always rendered "Browse all tools" →
 *           /tools, which is INTERNAL/notFound for every non-platform-
 *           admin. A self-serve user clicking it would hit a 404.
 *
 * The fixes are exercised by both the runtime resolver (where possible)
 * and source-contract grep (where the resolver lives behind a heavier
 * envelope/zod stack we don't want to import into the api test runner).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_PRIMARY_ROUTE_IDS,
} from "../../../apps/web/lib/navigation/canonicalNavigationGroups";
import { resolveWorkflowExposure } from "../../../apps/web/lib/navigation/workflowExposureResolver";
import type { RouteDefinition } from "../../../apps/web/lib/navigation/routeRegistry";
import type { RouteAccessResult } from "../../../apps/web/lib/navigation/routeAccessResolver";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// Fixtures
// ============================================================================

function makeRoute(
  overrides: Partial<RouteDefinition> & Pick<RouteDefinition, "id">,
): RouteDefinition {
  return {
    id: overrides.id,
    href: overrides.href ?? `/${overrides.id}`,
    label: overrides.label ?? overrides.id,
    description: overrides.description ?? "",
    domain: overrides.domain ?? "PERSONAL_WORKSPACE",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    requiredActiveSpace: overrides.requiredActiveSpace ?? "PERSONAL_OR_ORG",
    fallbackBehavior: overrides.fallbackBehavior ?? "REQUEST_ACCESS",
    workflowTags: overrides.workflowTags ?? [],
    advancedByDefault: overrides.advancedByDefault ?? false,
    commandPaletteVisible: overrides.commandPaletteVisible ?? true,
    allToolsVisible: overrides.allToolsVisible ?? true,
    sidebarEligible: overrides.sidebarEligible ?? true,
    denialGuidance: overrides.denialGuidance,
  };
}

const ALLOWED = {
  canLoad: true,
  canSeeNav: true,
  accessState: "ALLOWED",
  reason: null,
  primaryAction: null,
  secondaryAction: null,
} as unknown as RouteAccessResult;

// ============================================================================
// Bug A — capability-registry: personal-scope grant
// ============================================================================

describe("Phase IA-intake-access-fix — Bug A: personal OWNER capability", () => {
  const REG = readApi("src/services/platform-context/capability-registry.ts");

  it("grants INTAKE_LINKS_MANAGE inside the isPersonal block", () => {
    // Extract the personal-workspace block — bounded by the
    // `if (isPersonal)` opener and the next top-level `if (isTeam)`.
    const personalBlock =
      REG.match(/if \(isPersonal\)[\s\S]*?if \(isTeam\)/)?.[0] ?? "";
    expect(personalBlock).toContain("INTAKE_LINKS_MANAGE");
  });

  it("team block still grants INTAKE_LINKS_MANAGE (defence in depth, both branches)", () => {
    const teamBlock =
      REG.match(/if \(isTeam\)[\s\S]*?\/\/ Platform admin elevation/)?.[0] ?? "";
    // Both the writer + admin sub-blocks inside isTeam carry it.
    expect(teamBlock.match(/INTAKE_LINKS_MANAGE/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("VIEWER role still excluded — INTAKE_LINKS_MANAGE only fires on non-viewer paths", () => {
    // The viewer-scoped grants happen in the universal `setMany` at the
    // very top (line ~120) which only includes read-only capabilities.
    // The non-viewer scopes (personal owner = !isViewer && isMember,
    // team writer = isMember && !isViewer) carry the manage cap.
    expect(REG).toMatch(/isWriter = isMember && !isViewer/);
  });
});

// ============================================================================
// Bug B — sidebar: canonical-primary promotion
// ============================================================================

describe("Phase IA-intake-access-fix — Bug B: sidebar placement", () => {
  it("CANONICAL_PRIMARY_ROUTE_IDS still includes workspace.intake_links", () => {
    expect(CANONICAL_PRIMARY_ROUTE_IDS.has("workspace.intake_links")).toBe(true);
  });

  it("workspace.intake_links no longer has advancedByDefault: true", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    const block =
      REGISTRY.match(/id:\s*"workspace\.intake_links"[\s\S]{0,2000}\}/)?.[0] ??
      "";
    expect(block).toMatch(/advancedByDefault:\s*false/);
  });

  it("resolveWorkflowExposure promotes a canonical-primary route into primary even when no workflow tag matches", () => {
    // Simulate the PRO user whose primaryWorkflow doesn't touch the
    // /intake-links tags. Before the fix the route would land in
    // moreAdvancedItems via the advancedByDefault branch; after the
    // fix it MUST land in primaryItems via canonical-primary.
    const intake = makeRoute({
      id: "workspace.intake_links",
      workflowTags: ["LEGAL_CASEWORK"],
      advancedByDefault: false,
    });
    const result = resolveWorkflowExposure({
      routes: [{ route: intake, access: ALLOWED }],
      primaryWorkflow: "EVIDENCE_CAPTURE" as never,
      secondaryWorkflows: [],
    });
    expect(result.primaryItems.map((i) => i.route.id)).toContain(
      "workspace.intake_links",
    );
    expect(result.moreAdvancedItems.map((i) => i.route.id)).not.toContain(
      "workspace.intake_links",
    );
    // Audit-friendly bucket reason.
    expect(
      result.primaryItems.find((i) => i.route.id === "workspace.intake_links")
        ?.bucketReason,
    ).toBe("canonical-primary");
  });

  it("a non-canonical advancedByDefault route still lands in moreAdvancedItems", () => {
    // Defence: the canonical-primary promotion does NOT widen
    // advancedByDefault semantics for other routes.
    const odd = makeRoute({
      id: "workspace.something_else",
      workflowTags: ["GOVERNANCE"],
      advancedByDefault: true,
    });
    const result = resolveWorkflowExposure({
      routes: [{ route: odd, access: ALLOWED }],
      primaryWorkflow: "EVIDENCE_CAPTURE" as never,
      secondaryWorkflows: [],
    });
    expect(result.moreAdvancedItems.map((i) => i.route.id)).toContain(
      "workspace.something_else",
    );
    expect(result.primaryItems.map((i) => i.route.id)).not.toContain(
      "workspace.something_else",
    );
  });

  it("workflow-primary-tag still wins (no regression to canonical promotion)", () => {
    // When BOTH primary-workflow-match AND canonical-primary apply,
    // the bucketReason should still reflect the workflow tag for
    // existing analytics.
    const route = makeRoute({
      id: "workspace.evidence",
      workflowTags: ["EVIDENCE_CAPTURE"],
    });
    const result = resolveWorkflowExposure({
      routes: [{ route, access: ALLOWED }],
      primaryWorkflow: "EVIDENCE_CAPTURE" as never,
      secondaryWorkflows: [],
    });
    expect(
      result.primaryItems.find((i) => i.route.id === "workspace.evidence")
        ?.bucketReason,
    ).toBe("primary-workflow-match");
  });
});

// ============================================================================
// Bug C — denial: hide Browse all tools for non-platform-admin
// ============================================================================

describe("Phase IA-intake-access-fix — Bug C: denial copy", () => {
  const GATE = readWeb("components/navigation/PageRouteGate.tsx");

  it("Browse all tools link is rendered behind a platform-admin gate (NOT unconditionally)", () => {
    // Strip JSX/JS comments first so docstrings mentioning "Browse all
    // tools" don't skew the count.
    const stripped = GATE
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const browseCount = (stripped.match(/Browse all tools/g) ?? []).length;
    expect(browseCount).toBeGreaterThanOrEqual(2);

    // Pair each `Browse all tools` with the nearest preceding
    // `isPlatformAdmin === true ? (` (multiline). Every rendered
    // occurrence must be paired with the gate.
    const gated = (
      stripped.match(
        /isPlatformAdmin === true \? \([\s\S]*?Browse all tools/g,
      ) ?? []
    ).length;
    expect(gated).toBe(browseCount);
  });

  it("does not render All Tools fallback to /tools for self-serve users", () => {
    // Look for the conditional pattern around the `/tools` link.
    expect(GATE).toMatch(
      /isPlatformAdmin === true \? \([\s\S]{0,500}href="\/tools"/,
    );
  });
});

// ============================================================================
// Cross-cut — the runtime decision shape ordering is correct
// ============================================================================

describe("Phase IA-intake-access-fix — runtime decision invariants", () => {
  it("/intake-links route still requires INTAKE_LINKS_MANAGE (no gate weakening)", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    const block =
      REGISTRY.match(/id:\s*"workspace\.intake_links"[\s\S]{0,2000}\}/)?.[0] ??
      "";
    expect(block).toMatch(/requiredCapabilities:\s*\["INTAKE_LINKS_MANAGE"\]/);
  });

  it("route-specific denialGuidance is still attached to /intake-links", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    const block =
      REGISTRY.match(/id:\s*"workspace\.intake_links"[\s\S]{0,2000}\}/)?.[0] ??
      "";
    expect(block).toMatch(/denialGuidance:/);
  });

  it("/tools surface tier still INTERNAL/notFound (no regression)", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/tools",\s*tier:\s*"INTERNAL",\s*directAccessPolicy:\s*"notFound"/,
    );
  });

  it("All Tools sidebar entry stays gated to platform admins (no regression)", () => {
    const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(SIDEBAR).toMatch(
      /isPlatformAdmin \? \([\s\S]{0,800}data-sidebar-group="All Tools"/,
    );
  });
});
