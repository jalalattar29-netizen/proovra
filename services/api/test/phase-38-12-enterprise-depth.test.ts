/**
 * PHASE 38.12 — Enterprise depth + consistency source-contract tests.
 *
 * Covers:
 *   1. CommandCenter section registry supports gridGroup metadata for
 *      multi-column operational density.
 *   2. buildSectionRenderPlan groups consecutive same-gridGroup
 *      sections into bands.
 *   3. Render loop emits ec-grid-2col / ec-grid-3col wrappers per band.
 *   4. Route registry expansion (5 new routes).
 *   5. Additional PageRouteGate migrations (5 more pages).
 *   6. Allow-list shrinkage: reviewer-ops/[reviewId] migrated.
 *   7. Cumulative <PageRouteGate> adoption ≥ 34 pages.
 *   8. Copy-safety locks hold.
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

const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const REVIEW_DETAIL = readWeb(
  "app/(app)/reviewer-ops/[reviewId]/page.tsx",
);

// =============================================================================
// PART 1 — Dashboard grid grouping
// =============================================================================

describe("Phase 38.12 — CommandCenter section registry supports grid grouping", () => {
  it("SectionRendererEntry type includes a gridGroup field", () => {
    expect(COMMAND_CENTER).toMatch(/gridGroup\?\s*:/);
  });

  it("declares the bounded gridGroup vocabulary in source", () => {
    const GROUPS = [
      "review-ops",
      "case-ops",
      "pipeline",
      "intel",
      "audit",
      "watch",
      "deep-intel",
      "deep-watch",
      "ops-runtime",
      "advisory",
    ];
    for (const g of GROUPS) {
      expect(COMMAND_CENTER, `gridGroup "${g}" missing`).toMatch(
        new RegExp(`"${g}"`),
      );
    }
  });

  it("annotates representative section pairs with the same gridGroup", () => {
    // caseOperations + reviewerOrchestration share "case-ops"
    expect(COMMAND_CENTER).toMatch(
      /caseOperations:\s*\{[\s\S]{0,300}gridGroup:\s*"case-ops"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /reviewerOrchestration:\s*\{[\s\S]{0,300}gridGroup:\s*"case-ops"/,
    );
    // pipelineDetail + governancePosture share "pipeline"
    expect(COMMAND_CENTER).toMatch(
      /pipelineDetail:\s*\{[\s\S]{0,300}gridGroup:\s*"pipeline"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /governancePosture:\s*\{[\s\S]{0,300}gridGroup:\s*"pipeline"/,
    );
    // auditReadiness + organizationalIntelligence share "audit"
    expect(COMMAND_CENTER).toMatch(
      /auditReadiness:\s*\{[\s\S]{0,300}gridGroup:\s*"audit"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /organizationalIntelligence:\s*\{[\s\S]{0,300}gridGroup:\s*"audit"/,
    );
  });

  it("declares buildSectionRenderPlan helper for band grouping", () => {
    expect(COMMAND_CENTER).toMatch(/function buildSectionRenderPlan/);
    expect(COMMAND_CENTER).toMatch(/SectionRenderBand/);
  });

  it("render loop consumes buildSectionRenderPlan + emits ec-grid wrappers", () => {
    expect(COMMAND_CENTER).toMatch(/buildSectionRenderPlan\(finalSectionOrder\)/);
    expect(COMMAND_CENTER).toMatch(/ec-grid-2col/);
    expect(COMMAND_CENTER).toMatch(/ec-grid-3col/);
    expect(COMMAND_CENTER).toMatch(/data-section-band/);
    expect(COMMAND_CENTER).toMatch(/data-section-grid-group/);
  });

  it("workflow profile still drives the section ORDER (priority strip + render unchanged)", () => {
    // The grid grouping is layered on TOP of finalSectionOrder — it
    // does not bypass `getPersonaSectionOrder`.
    expect(COMMAND_CENTER).toMatch(/getPersonaSectionOrder/);
    expect(COMMAND_CENTER).toMatch(/finalSectionOrder/);
  });

  it("band length is capped at 3 — keeps grids visually safe", () => {
    // Phase 38.12 used `last.entries.length < 3` (consecutive-walk
    // algorithm). Phase 38.13 switched to `band.entries.length < 3`
    // (partition+sort algorithm). Either is acceptable as long as the
    // cap is present.
    expect(COMMAND_CENTER).toMatch(
      /(last|band)\.entries\.length\s*<\s*3/,
    );
  });
});

// =============================================================================
// PART 2 — Route registry expansion (5 new routes)
// =============================================================================

describe("Phase 38.12 — route registry expansion (5 new routes)", () => {
  const NEW_ROUTES: Array<{ id: string; href: string }> = [
    { id: "review.queue_detail", href: "/reviewer-ops/queue" },
    { id: "workspace.communications", href: "/communications" },
    { id: "workspace.intelligence", href: "/intelligence" },
    { id: "investigation.timeline", href: "/investigation/timeline" },
    {
      id: "investigation.relationships",
      href: "/investigation/relationships",
    },
  ];

  for (const r of NEW_ROUTES) {
    it(`declares ${r.id} as a canonical route mapped to ${r.href}`, () => {
      expect(REGISTRY).toMatch(
        new RegExp(`id:\\s*"${r.id.replace(/\./g, "\\.")}"`),
      );
      expect(REGISTRY).toMatch(
        new RegExp(`href:\\s*"${r.href.replace(/\//g, "\\/")}"`),
      );
    });
  }

  it("review.queue_detail is org-only + reached from the queue (not a top-level discovery surface)", () => {
    expect(REGISTRY).toMatch(
      /id:\s*"review\.queue_detail"[\s\S]*?requiredActiveSpace:\s*"ORGANIZATION_ONLY"[\s\S]*?commandPaletteVisible:\s*false[\s\S]*?allToolsVisible:\s*false[\s\S]*?sidebarEligible:\s*false/,
    );
  });
});

// =============================================================================
// PART 3 — Additional PageRouteGate migrations
// =============================================================================

describe("Phase 38.12 — additional PageRouteGate migrations", () => {
  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    {
      page: "app/(app)/reviewer-ops/[reviewId]/page.tsx",
      routeId: "review.queue_detail",
    },
    {
      page: "app/(app)/communications/page.tsx",
      routeId: "workspace.communications",
    },
    {
      page: "app/(app)/intelligence/page.tsx",
      routeId: "workspace.intelligence",
    },
    {
      page: "app/(app)/investigation/timeline/page.tsx",
      routeId: "investigation.timeline",
    },
    {
      page: "app/(app)/investigation/relationships/page.tsx",
      routeId: "investigation.relationships",
    },
  ];

  for (const entry of MIGRATIONS) {
    it(`${entry.page} wraps in <PageRouteGate routeId="${entry.routeId}">`, () => {
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
// PART 4 — Legacy gate shrinkage (reviewer-ops/[reviewId] migrated)
// =============================================================================

describe("Phase 38.12 — useTeamWorkspaceGate shrinkage", () => {
  it("reviewer-ops/[reviewId] no longer imports useTeamWorkspaceGate", () => {
    expect(REVIEW_DETAIL).not.toMatch(/useTeamWorkspaceGate/);
  });
  it("reviewer-ops/[reviewId] now reads activeSpaceId from the canonical envelope", () => {
    expect(REVIEW_DETAIL).toMatch(/useActiveSpaceId/);
  });
});

// =============================================================================
// PART 5 — Cumulative migration tally (≥ 34)
// =============================================================================

describe("Phase 38.12 — cumulative <PageRouteGate> adoption", () => {
  it("at least 34 canonical pages now wrap in <PageRouteGate>", () => {
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
      // Phase 38.10
      "app/(app)/workflows/page.tsx",
      "app/(app)/intake-links/page.tsx",
      "app/(app)/security-center/page.tsx",
      "app/(app)/ops/runbooks/page.tsx",
      "app/(app)/reviewer-ops/escalations/page.tsx",
      // Phase 38.11
      "app/(app)/governance/policy/page.tsx",
      "app/(app)/governance/analytics/page.tsx",
      "app/(app)/governance/lifecycle/page.tsx",
      "app/(app)/governance/destruction/page.tsx",
      "app/(app)/governance/notifications/page.tsx",
      "app/(app)/ops/observability/page.tsx",
      "app/(app)/reviewer-ops/sla/page.tsx",
      "app/(app)/investigation/page.tsx",
      // Phase 38.12
      "app/(app)/reviewer-ops/[reviewId]/page.tsx",
      "app/(app)/communications/page.tsx",
      "app/(app)/intelligence/page.tsx",
      "app/(app)/investigation/timeline/page.tsx",
      "app/(app)/investigation/relationships/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(34);
  });
});

// =============================================================================
// PART 6 — Forbidden copy still absent on every newly-touched surface
// =============================================================================

describe("Phase 38.12 — forbidden copy stays absent", () => {
  const FILES = [
    "components/command-center/CommandCenter.tsx",
    "app/(app)/reviewer-ops/[reviewId]/page.tsx",
    "app/(app)/communications/page.tsx",
    "app/(app)/intelligence/page.tsx",
    "app/(app)/investigation/timeline/page.tsx",
    "app/(app)/investigation/relationships/page.tsx",
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
    /"mode-locked"/i,
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
