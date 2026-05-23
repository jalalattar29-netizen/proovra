/**
 * PHASE 38.14 — Product maturity source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. Capture readiness layer — pure computeCaptureReadiness +
 *      CaptureReadinessPanel; workflow-aware criteria; bounded
 *      vocabulary (draft/developing/ready); no legal/forensic
 *      overclaim.
 *   2. ReviewerCommandConsole migrated off useTeamWorkspaceGate.
 *   3. 4 dashboard subroutes wrapped in PageRouteGate +
 *      corresponding registry entries.
 *   4. Cumulative <PageRouteGate> adoption ≥ 44 pages.
 *   5. Copy safety locks (positive overclaim ban + workflow safety
 *      statement) hold on every newly-touched surface.
 *   6. Capture readiness panel is informational only — never blocks
 *      finalization.
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

const READINESS = readWeb("app/(app)/capture/_lib/captureReadiness.ts");
const READINESS_PANEL = readWeb(
  "app/(app)/capture/_lib/CaptureReadinessPanel.tsx",
);
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const REVIEWER_CONSOLE = readWeb(
  "components/reviewer-experience/ReviewerCommandConsole.tsx",
);
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");

// =============================================================================
// PART 1 — Capture readiness layer
// =============================================================================

describe("Phase 38.14 — capture readiness layer", () => {
  it("computeCaptureReadiness is exported", () => {
    expect(READINESS).toMatch(/export function computeCaptureReadiness/);
  });

  it("declares a bounded readiness level vocabulary (draft|developing|ready)", () => {
    expect(READINESS).toMatch(
      /ReadinessLevel\s*=\s*"draft"\s*\|\s*"developing"\s*\|\s*"ready"/,
    );
  });

  it("declares per-workflow criterion lists for all 7 workflow codes", () => {
    for (const code of [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ]) {
      expect(READINESS).toMatch(new RegExp(`${code}:\\s*\\[`));
    }
  });

  it("readiness signal is computed from real session state (not faked)", () => {
    // The criterion evaluators read fields from the session items —
    // role, privateNote, sourceLabel, clientSignals.locationIncluded,
    // clientSignals.duplicateStatus. No literal-number metrics.
    expect(READINESS).toMatch(/i\.role\s*===/);
    expect(READINESS).toMatch(/i\.privateNote/);
    expect(READINESS).toMatch(/clientSignals\?\.locationIncluded/);
    expect(READINESS).toMatch(/clientSignals\?\.duplicateStatus/);
  });

  it("operational-tone label set — no legal/forensic overclaim labels", () => {
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bauthenticity guaranteed\b/i,
      /\bproves the truth\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(READINESS, `readiness data must not match ${pattern}`).not.toMatch(
        pattern,
      );
      expect(
        READINESS_PANEL,
        `readiness panel must not match ${pattern}`,
      ).not.toMatch(pattern);
    }
  });
});

describe("Phase 38.14 — CaptureReadinessPanel contract", () => {
  it("renders a labelled region (a11y)", () => {
    expect(READINESS_PANEL).toMatch(/role="region"/);
    expect(READINESS_PANEL).toMatch(/aria-label=\{`Capture readiness:/);
  });

  it("emits structured data attributes for the readiness level + workflow + score", () => {
    expect(READINESS_PANEL).toMatch(/data-capture-readiness-level=/);
    expect(READINESS_PANEL).toMatch(/data-capture-readiness-workflow=/);
    expect(READINESS_PANEL).toMatch(/data-capture-readiness-score=/);
  });

  it("emits a per-criterion satisfied attribute", () => {
    expect(READINESS_PANEL).toMatch(/data-capture-readiness-criterion=/);
    expect(READINESS_PANEL).toMatch(
      /data-capture-readiness-criterion-satisfied=/,
    );
  });

  it("is dismissible (localStorage-persisted, scoped per workflow)", () => {
    expect(READINESS_PANEL).toMatch(/data-capture-readiness-dismiss/);
    expect(READINESS_PANEL).toMatch(/localStorage/);
  });

  it("explicitly documents itself as informational + non-blocking", () => {
    // The footnote copy is part of the operational contract — must
    // be present so operators understand the panel never blocks
    // finalization.
    expect(READINESS_PANEL).toMatch(
      /never blocks finalization|operational completeness only/i,
    );
  });

  it("capture page mounts the readiness panel after the guidance panel", () => {
    expect(CAPTURE).toMatch(/CaptureReadinessPanel/);
    expect(CAPTURE).toMatch(/items=\{sessionItems\}/);
    expect(CAPTURE).toMatch(/workflow=\{workflowCode\}/);
  });

  it("capture page does NOT use the readiness signal to block finalization", () => {
    // The readiness panel never short-circuits the capture flow. The
    // capture page must NOT contain a pattern like
    // `if (!readiness.ready) return null` or
    // `if (readiness.level !== "ready") disable finalize`.
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*!?readiness[\s\S]{0,80}return\s+null/,
    );
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*readiness\.level\s*!==\s*"ready"\s*\)\s*\{?\s*(disable|return null|throw)/,
    );
  });
});

// =============================================================================
// PART 2 — ReviewerCommandConsole migrated off useTeamWorkspaceGate
// =============================================================================

describe("Phase 38.14 — ReviewerCommandConsole migrated to useActiveSpaceId", () => {
  it("does not import useTeamWorkspaceGate anymore", () => {
    expect(REVIEWER_CONSOLE).not.toMatch(/useTeamWorkspaceGate/);
  });
  it("reads canonical activeSpaceId instead", () => {
    expect(REVIEWER_CONSOLE).toMatch(/useActiveSpaceId/);
  });
  it("removed the legacy workspaceState.status branching", () => {
    expect(REVIEWER_CONSOLE).not.toMatch(/workspace\.status\s*!==\s*"ready"/);
    expect(REVIEWER_CONSOLE).not.toMatch(/workspace\.status\s*===\s*"loading"/);
  });
});

// =============================================================================
// PART 3 — Dashboard subroute migrations + registry entries
// =============================================================================

describe("Phase 38.14 — dashboard subroute migrations", () => {
  const NEW_ROUTES: Array<{ id: string; href: string }> = [
    { id: "dashboard.api_keys", href: "/dashboard/api-keys" },
    { id: "dashboard.quotas", href: "/dashboard/quotas" },
    { id: "dashboard.insights", href: "/dashboard/insights" },
    {
      id: "dashboard.batch_analysis",
      href: "/dashboard/batch-analysis",
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

  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    {
      page: "app/(app)/dashboard/api-keys/page.tsx",
      routeId: "dashboard.api_keys",
    },
    {
      page: "app/(app)/dashboard/quotas/page.tsx",
      routeId: "dashboard.quotas",
    },
    {
      page: "app/(app)/dashboard/insights/page.tsx",
      routeId: "dashboard.insights",
    },
    {
      page: "app/(app)/dashboard/batch-analysis/page.tsx",
      routeId: "dashboard.batch_analysis",
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
// PART 4 — Cumulative migration tally (≥ 44)
// =============================================================================

describe("Phase 38.14 — cumulative <PageRouteGate> adoption", () => {
  it("at least 44 canonical pages now wrap in <PageRouteGate>", () => {
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
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(44);
  });
});

// =============================================================================
// PART 5 — Copy safety locks held on every newly-touched surface
// =============================================================================

describe("Phase 38.14 — copy safety locks (positive overclaim ban)", () => {
  const FILES = [
    "app/(app)/capture/_lib/captureReadiness.ts",
    "app/(app)/capture/_lib/CaptureReadinessPanel.tsx",
    "components/reviewer-experience/ReviewerCommandConsole.tsx",
    "app/(app)/dashboard/api-keys/page.tsx",
    "app/(app)/dashboard/quotas/page.tsx",
    "app/(app)/dashboard/insights/page.tsx",
    "app/(app)/dashboard/batch-analysis/page.tsx",
  ];

  // Positive-claim patterns (disclaimers excluded).
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
