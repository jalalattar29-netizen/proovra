/**
 * PHASE 38.15 — Operational depth source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. Capture suggestions layer — pure computeCaptureSuggestions +
 *      CaptureSuggestionsPanel; derived from readiness gaps;
 *      bounded vocabulary; informational + non-blocking.
 *   2. GovernanceControlPlane migrated off useTeamWorkspaceGate.
 *   3. 3 long-tail operator routes wrapped in PageRouteGate +
 *      corresponding registry entries.
 *   4. Cumulative <PageRouteGate> adoption ≥ 47 pages.
 *   5. Copy-safety locks (positive overclaim ban) hold on every
 *      newly-touched surface.
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

const SUGGESTIONS = readWeb("app/(app)/capture/_lib/captureSuggestions.ts");
const SUGGESTIONS_PANEL = readWeb(
  "app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx",
);
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const GOVERNANCE_CONSOLE = readWeb(
  "components/governance-experience/GovernanceControlPlane.tsx",
);
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");

// =============================================================================
// PART 1 — Capture suggestions layer
// =============================================================================

describe("Phase 38.15 — capture suggestions layer", () => {
  it("computeCaptureSuggestions is exported", () => {
    expect(SUGGESTIONS).toMatch(/export function computeCaptureSuggestions/);
  });

  it("each suggestion is keyed on a readiness criterion id", () => {
    // The suggestions catalog covers every criterion id that the
    // readiness layer can emit. Sanity-check: every criterion id
    // declared in captureReadiness.ts has a SUGGESTIONS_BY_CRITERION
    // entry here.
    for (const criterionId of [
      "has_primary",
      "has_supporting",
      "has_context_note",
      "has_location",
      "has_source_label",
      "no_duplicate_warnings",
      "at_least_three_items",
    ]) {
      expect(SUGGESTIONS).toMatch(
        new RegExp(`${criterionId}:\\s*\\{[\\s\\S]{0,60}id:\\s*"${criterionId}"`),
      );
    }
  });

  it("suggestions catalog is bounded — tone limited to info|warning", () => {
    expect(SUGGESTIONS).toMatch(
      /tone:\s*"info"\s*\|\s*"warning"/,
    );
  });

  it("suggestions are derived from UNSATISFIED criteria only", () => {
    expect(SUGGESTIONS).toMatch(/if\s*\(criterion\.satisfied\)\s*continue/);
  });

  it("output capped to maxSuggestions (default 4)", () => {
    expect(SUGGESTIONS).toMatch(/input\.maxSuggestions\s*\?\?\s*4/);
    expect(SUGGESTIONS).toMatch(/out\.length\s*>=\s*max/);
  });

  it("operational-tone catalog — no legal/forensic overclaim labels", () => {
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bauthenticity guaranteed\b/i,
      /\bproves the truth\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(SUGGESTIONS, `suggestions data must not match ${pattern}`).not.toMatch(
        pattern,
      );
      expect(
        SUGGESTIONS_PANEL,
        `suggestions panel must not match ${pattern}`,
      ).not.toMatch(pattern);
    }
  });
});

describe("Phase 38.15 — CaptureSuggestionsPanel contract", () => {
  it("renders a labelled region (a11y)", () => {
    expect(SUGGESTIONS_PANEL).toMatch(/role="region"/);
    expect(SUGGESTIONS_PANEL).toMatch(/aria-label="Capture suggestions"/);
  });

  it("each suggestion action button is labelled with the suggestion title", () => {
    expect(SUGGESTIONS_PANEL).toMatch(
      /aria-label=\{`\$\{s\.action\.label\}\s*—\s*\$\{s\.title\}`\}/,
    );
  });

  it("emits structured data attributes for the workflow + counts + per-item id/tone", () => {
    expect(SUGGESTIONS_PANEL).toMatch(/data-capture-suggestions-workflow=/);
    expect(SUGGESTIONS_PANEL).toMatch(/data-capture-suggestions-count=/);
    expect(SUGGESTIONS_PANEL).toMatch(/data-capture-suggestion-id=/);
    expect(SUGGESTIONS_PANEL).toMatch(/data-capture-suggestion-tone=/);
  });

  it("is dismissible (localStorage-persisted, scoped per workflow)", () => {
    expect(SUGGESTIONS_PANEL).toMatch(/data-capture-suggestions-dismiss/);
    expect(SUGGESTIONS_PANEL).toMatch(/localStorage/);
  });

  it("explicitly documents itself as informational + non-blocking", () => {
    expect(SUGGESTIONS_PANEL).toMatch(
      /Suggestions are informational|never block finalization|never blocks finalization/i,
    );
  });

  it("hides when there are zero suggestions", () => {
    expect(SUGGESTIONS_PANEL).toMatch(
      /if\s*\(suggestions\.length\s*===\s*0\)\s*return\s+null/,
    );
  });

  it("capture page mounts the suggestions panel + derives readiness inline", () => {
    expect(CAPTURE).toMatch(/CaptureSuggestionsPanel/);
    expect(CAPTURE).toMatch(/readiness=\{computeCaptureReadiness/);
  });

  it("capture page does NOT use the suggestions signal to block finalization", () => {
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*suggestions[\s\S]{0,80}return\s+null/,
    );
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*suggestions\.length\s*>\s*0\s*\)\s*\{?\s*(disable|return null|throw)/,
    );
  });
});

// =============================================================================
// PART 2 — GovernanceControlPlane migrated
// =============================================================================

describe("Phase 38.15 — GovernanceControlPlane migrated to useActiveSpaceId", () => {
  it("does not import useTeamWorkspaceGate anymore", () => {
    expect(GOVERNANCE_CONSOLE).not.toMatch(/useTeamWorkspaceGate/);
  });
  it("reads canonical activeSpaceId instead", () => {
    expect(GOVERNANCE_CONSOLE).toMatch(/useActiveSpaceId/);
  });
  it("removed the legacy workspaceState.status branching", () => {
    expect(GOVERNANCE_CONSOLE).not.toMatch(/workspace\.status\s*!==\s*"ready"/);
    expect(GOVERNANCE_CONSOLE).not.toMatch(/workspace\.status\s*===\s*"loading"/);
  });
});

// =============================================================================
// PART 3 — Long-tail operator-route migrations + registry entries
// =============================================================================

describe("Phase 38.15 — long-tail operator-route migrations", () => {
  const NEW_ROUTES: Array<{ id: string; href: string }> = [
    { id: "platform.reliability", href: "/operations/reliability" },
    { id: "platform.media_graph", href: "/ops/media-graph" },
    { id: "workspace.collaboration", href: "/collaboration" },
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

  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    {
      page: "app/(app)/operations/reliability/page.tsx",
      routeId: "platform.reliability",
    },
    {
      page: "app/(app)/ops/media-graph/page.tsx",
      routeId: "platform.media_graph",
    },
    {
      page: "app/(app)/collaboration/page.tsx",
      routeId: "workspace.collaboration",
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
// PART 4 — Cumulative migration tally (≥ 47)
// =============================================================================

describe("Phase 38.15 — cumulative <PageRouteGate> adoption", () => {
  it("at least 47 canonical pages now wrap in <PageRouteGate>", () => {
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
      // Phase 38.13
      "app/(app)/evidence/[id]/page.tsx",
      "app/(app)/cases/[id]/page.tsx",
      "app/(app)/workflows/[id]/page.tsx",
      "app/(app)/investigation/graph/page.tsx",
      "app/(app)/investigation/duplicates/page.tsx",
      "app/(app)/investigation/reviewers/page.tsx",
      // Phase 38.14
      "app/(app)/dashboard/api-keys/page.tsx",
      "app/(app)/dashboard/quotas/page.tsx",
      "app/(app)/dashboard/insights/page.tsx",
      "app/(app)/dashboard/batch-analysis/page.tsx",
      // Phase 38.15
      "app/(app)/operations/reliability/page.tsx",
      "app/(app)/ops/media-graph/page.tsx",
      "app/(app)/collaboration/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(47);
  });
});

// =============================================================================
// PART 5 — Copy safety locks held on every newly-touched surface
// =============================================================================

describe("Phase 38.15 — copy safety locks", () => {
  const FILES = [
    "app/(app)/capture/_lib/captureSuggestions.ts",
    "app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx",
    "components/governance-experience/GovernanceControlPlane.tsx",
    "app/(app)/operations/reliability/page.tsx",
    "app/(app)/ops/media-graph/page.tsx",
    "app/(app)/collaboration/page.tsx",
  ];

  const BANNED = [
    /\b(is|are|will be|guaranteed)\s+legally admissible\b/i,
    /\bauthenticity\s+(is\s+)?guaranteed\b/i,
    /\b(is|are)\s+tamper-proof\b/i,
    /\b(is|are)\s+court-ready\b/i,
    /\b(it\s+)?proves the truth\b/i,
    /"tamper-proof evidence"/i,
    /"court-ready evidence"/i,
    /"court-ready package"/i,
    /"lawyer mode"/i,
    /"journalist mode"/i,
    /"insurance mode"/i,
    /"hidden because of workflow"/i,
    /"mode-locked"/i,
  ];

  for (const file of FILES) {
    it(`${file} contains no positive overclaim copy`, () => {
      const src = readWeb(file);
      for (const pattern of BANNED) {
        expect(src, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
