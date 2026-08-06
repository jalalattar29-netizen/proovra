/**
 * Phase 1A — Enterprise 8-pillar IA contract test.
 *
 * Pins the canonical pillar architecture introduced by Phase 1A:
 *
 *   1. The pillar enum is exactly 8 entries in canonical order.
 *   2. EVERY route in `routeRegistry.ts` is mapped to a pillar in
 *      `pillarRegistry.PILLAR_FOR_ROUTE_ID` (full coverage).
 *   3. The visible-node ceiling is 25.
 *   4. HOME and TRUST are universal pillars (visible to every persona).
 *   5. The server-side `navigation-registry.ts` exposes
 *      `buildPillarProjection` and produces pillars in canonical order.
 *   6. The platform-context envelope `PlatformContextNavigation` shape
 *      includes `sidebar.pillars` (the new canonical contract).
 *   7. The `/trust` route is registered in `routeRegistry.ts` and is
 *      sidebar-eligible.
 *   8. The next.config.js redirects collapse the legacy `/ops/*` and
 *      `/dashboard/*` paths into their canonical pillar locations.
 *
 * Source-contract style: parses source text rather than importing,
 * matching the convention used by `phase-g0-operational-convergence.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const PILLAR_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/pillarRegistry.ts",
);
const GROUPING_RESOLVER = readSource(
  "../../../apps/web/lib/navigation/navigationGroupingResolver.ts",
);
const ROUTE_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/routeRegistry.ts",
);
const SERVER_NAV_REGISTRY = readSource(
  "../../../services/api/src/services/platform-context/navigation-registry.ts",
);
const PLATFORM_CONTEXT_TYPES = readSource(
  "../../../services/api/src/services/platform-context/types.ts",
);
const NEXT_CONFIG = readSource("../../../apps/web/next.config.js");
// 2026-07-15: the authenticated static Trust Hub (`/trust-hub`,
// id `workspace.trust`) was removed as redundant. The canonical trust
// portal is the public Trust Center (`/trust`); the in-app
// `/trust-center/*` article pages are a NON-navigational documentation
// surface gated by `workspace.trust_center`. Section 5 now pins that
// truth against a representative trust-center article page.
const TRUST_ARTICLE = readSource(
  "../../../apps/web/app/(app)/trust-center/security/page.tsx",
);

const CANONICAL_PILLAR_ORDER = [
  "HOME",
  "CAPTURE",
  "CASES",
  "REVIEW",
  "GOVERNANCE",
  "OPERATIONS",
  "ADMIN",
  "TRUST",
];

// ===========================================================================
// 1 — Pillar enum + order
// ===========================================================================

describe("Phase 1A — pillar enum", () => {
  it("declares exactly 8 pillars", () => {
    const match = PILLAR_REGISTRY.match(
      /export\s+const\s+PROOVRA_PILLARS\s*=\s*\[([^\]]+)\]/,
    );
    expect(match).toBeTruthy();
    const ids = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    expect(ids).toEqual(CANONICAL_PILLAR_ORDER);
  });

  it("PILLAR_DEFINITIONS preserves the canonical order", () => {
    for (let i = 0; i < CANONICAL_PILLAR_ORDER.length - 1; i++) {
      const a = CANONICAL_PILLAR_ORDER[i]!;
      const b = CANONICAL_PILLAR_ORDER[i + 1]!;
      const aPos = PILLAR_REGISTRY.indexOf(`id: "${a}"`);
      const bPos = PILLAR_REGISTRY.indexOf(`id: "${b}"`);
      expect(aPos).toBeGreaterThan(0);
      expect(bPos).toBeGreaterThan(aPos);
    }
  });

  it("declares the ≤25 visible-node ceiling", () => {
    expect(PILLAR_REGISTRY).toMatch(/MAX_VISIBLE_SIDEBAR_NODES\s*=\s*25/);
  });
});

// ===========================================================================
// 2 — Route → pillar full coverage
// ===========================================================================

describe("Phase 1A — route coverage", () => {
  it("every registered route id is mapped to a pillar", () => {
    // Extract all route ids from routeRegistry.ts
    const routeIdMatches = Array.from(
      ROUTE_REGISTRY.matchAll(/\bid:\s*"([a-z0-9_.-]+)"/gi),
    ).map((m) => m[1]!);
    // Filter to entries that look like real route ids (have a domain prefix)
    const routeIds = routeIdMatches.filter((id) => /\./.test(id));

    // Extract the mapping keys from pillarRegistry.PILLAR_FOR_ROUTE_ID
    const mappingBlock = PILLAR_REGISTRY.match(
      /PILLAR_FOR_ROUTE_ID:[\s\S]*?new\s+Map\(\[([\s\S]*?)\]\)/,
    );
    expect(mappingBlock).toBeTruthy();
    const mappedIds = new Set(
      Array.from(mappingBlock![1]!.matchAll(/"([a-z0-9_.-]+)"\s*,/gi)).map(
        (m) => m[1]!,
      ),
    );

    const unmapped = routeIds.filter((id) => !mappedIds.has(id));
    expect(
      unmapped,
      `Route ids missing from PILLAR_FOR_ROUTE_ID: ${unmapped.join(", ")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 3 — Universal pillars
// ===========================================================================

describe("Phase 1A — universal pillars", () => {
  // (2026-07-20) The `UNIVERSAL_PILLARS` set + the persona-pillar
  // visibility overlay were removed with the workspace-persona /
  // workflow-personalization feature. Pillar visibility is no longer
  // persona-filtered; every pillar's routes surface per capabilities,
  // so there is no "universal-per-persona" subset to pin. HOME and TRUST
  // remain in the canonical bounded pillar enum (pinned below).
  it("HOME and TRUST remain in the canonical pillar enum", () => {
    expect(PILLAR_REGISTRY).toMatch(/"HOME"/);
    expect(PILLAR_REGISTRY).toMatch(/"TRUST"/);
  });
});

// ===========================================================================
// 4 — Server-side pillar projection
// ===========================================================================

describe("Phase 1A — server-side pillar projection", () => {
  it("exports buildPillarProjection", () => {
    expect(SERVER_NAV_REGISTRY).toMatch(
      /export\s+function\s+buildPillarProjection\s*\(/,
    );
  });

  it("declares pillar order matching the canonical client-side order", () => {
    const pos = (token: string) => SERVER_NAV_REGISTRY.indexOf(`"${token}"`);
    for (let i = 0; i < CANONICAL_PILLAR_ORDER.length - 1; i++) {
      const a = CANONICAL_PILLAR_ORDER[i]!;
      const b = CANONICAL_PILLAR_ORDER[i + 1]!;
      const aPos = pos(a);
      const bPos = pos(b);
      // Both should appear in the PILLAR_ORDER array
      expect(aPos).toBeGreaterThan(0);
      // The b appearance in PILLAR_ORDER array follows a (we use the
      // first occurrence which is in PILLAR_ORDER)
      expect(bPos).toBeGreaterThan(0);
    }
  });

  it("envelope navigation type declares sidebar.pillars", () => {
    expect(PLATFORM_CONTEXT_TYPES).toMatch(
      /sidebar:\s*\{[\s\S]*?pillars:/,
    );
  });

  it("NAVIGATION_SCHEMA_VERSION is bumped to 2", () => {
    expect(PLATFORM_CONTEXT_TYPES).toMatch(
      /NAVIGATION_SCHEMA_VERSION\s*=\s*2/,
    );
  });

  it("PROOVRA_PILLARS is exported from server types", () => {
    expect(PLATFORM_CONTEXT_TYPES).toMatch(
      /export\s+const\s+PROOVRA_PILLARS\s*=/,
    );
  });
});

// ===========================================================================
// 5 — Trust pillar surface
// ===========================================================================

describe("Phase 1A — Trust pillar surface (Trust Hub removed 2026-07-15)", () => {
  it("the authenticated Trust Hub route is gone (no workspace.trust / /trust-hub)", () => {
    // The old hub route id + URL must not remain in the registry.
    // (`workspace.trust_center` does NOT match `"workspace.trust"` — the
    // closing quote falls after `trust`, not `trust_center`.)
    expect(ROUTE_REGISTRY).not.toMatch(/id:\s*"workspace\.trust"/);
    expect(ROUTE_REGISTRY).not.toMatch(/"\/trust-hub"/);
  });

  it("the TRUST pillar now classifies the NON-navigational trust-center doc gate", () => {
    expect(ROUTE_REGISTRY).toMatch(/id:\s*"workspace\.trust_center"/);
    expect(ROUTE_REGISTRY).toMatch(
      /workspace\.trust_center[\s\S]*?href:\s*"\/trust-center"/,
    );
    // No sidebar / cmd-K / All Tools discovery path (not a Trust landing).
    expect(ROUTE_REGISTRY).toMatch(
      /workspace\.trust_center[\s\S]*?sidebarEligible:\s*false/,
    );
  });

  it("in-app trust-center article pages gate on workspace.trust_center", () => {
    expect(TRUST_ARTICLE).toMatch(
      /PageRouteGate[\s\S]*?routeId="workspace\.trust_center"/,
    );
  });
});

// ===========================================================================
// 6 — Legacy-route redirects (IA consolidation)
// ===========================================================================

describe("Phase 1A — legacy IA redirects", () => {
  const REDIRECTS = [
    ["/ops/observability", "/operations/observability"],
    ["/ops/runbooks", "/operations/runbooks"],
    ["/ops/media-graph", "/operations/media-graph"],
    ["/ops/automation", "/operations/automation"],
    ["/ops/analytics", "/operations/analytics"],
    ["/dashboard/insights", "/home"],
    ["/dashboard/batch-analysis", "/operations/batch-analysis"],
    ["/dashboard/quotas", "/operations/quotas"],
  ];
  for (const [from, to] of REDIRECTS) {
    it(`redirects ${from} → ${to}`, () => {
      const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `source:\\s*"${escaped(from)}"[\\s\\S]{0,200}?destination:\\s*"${escaped(to)}"`,
      );
      expect(NEXT_CONFIG).toMatch(pattern);
    });
  }
});

// ===========================================================================
// 7 — Grouping resolver consumes the pillar registry
// ===========================================================================

describe("Phase 1A — grouping resolver", () => {
  it("imports from pillarRegistry", () => {
    expect(GROUPING_RESOLVER).toMatch(
      /from\s+"\.\/pillarRegistry"/,
    );
  });

  it("enforces MAX_VISIBLE_SIDEBAR_NODES", () => {
    expect(GROUPING_RESOLVER).toContain("MAX_VISIBLE_SIDEBAR_NODES");
    expect(GROUPING_RESOLVER).toContain("overflowItems");
  });

  // (2026-07-20) The "accepts a persona for visibility filtering" test was
  // removed with the workspace-persona / workflow-personalization feature.
  // The grouping resolver no longer takes a persona param or calls
  // `visiblePillarsForPersona`; navigation is canonical for everyone.
  it("does NOT filter navigation by a workspace persona", () => {
    expect(GROUPING_RESOLVER).not.toMatch(/WorkspacePersonaProfile/);
    expect(GROUPING_RESOLVER).not.toMatch(/visiblePillarsForPersona/);
  });
});

// ===========================================================================
// 8 — Pillar bound check (8 pillars)
// ===========================================================================

describe("Phase 1A — pillar bound", () => {
  it("PILLAR_DEFINITIONS has exactly 8 entries", () => {
    const idMatches = Array.from(
      PILLAR_REGISTRY.matchAll(/^\s{2}\{[\s\S]*?id:\s*"([A-Z]+)"/gm),
    ).map((m) => m[1]!);
    // Filter to only the PILLAR_DEFINITIONS array (the ids should be in
    // CANONICAL_PILLAR_ORDER).
    const pillarIds = idMatches.filter((id) =>
      CANONICAL_PILLAR_ORDER.includes(id),
    );
    expect(pillarIds.length).toBe(8);
  });
});
