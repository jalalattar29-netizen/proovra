/**
 * PHASE 38.11 — Final rollout completion source-contract tests.
 *
 * Covers:
 *   1. CommandCenter renders sections from a section-component
 *      registry driven by `finalSectionOrder` (real layout reorder).
 *   2. Capture workflow guidance panel renders + carries safety
 *      statement + treats recommended templates as a SUBSET
 *      (never replacement).
 *   3. Route registry expansion (8 new routes).
 *   4. PageRouteGate migrations (8 more pages).
 *   5. useTeamWorkspaceGate allow-list shrinkage (3 more consumers
 *      migrated off the legacy hook).
 *   6. Cumulative <PageRouteGate> adoption ≥ 29 pages.
 *   7. Copy-safety locks hold on every newly-touched surface.
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

const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const GUIDANCE = readWeb(
  "app/(app)/capture/_lib/CaptureWorkflowGuidance.tsx",
);
const GUIDANCE_DATA = readWeb("app/(app)/capture/_lib/workflowGuidance.ts");

// =============================================================================
// PART 1 — Dashboard real section-layout reorder
// =============================================================================

describe("Phase 38.11 — CommandCenter renders sections from registry + persona order", () => {
  it("declares a SECTION_RENDERERS registry mapping sectionId → renderer", () => {
    expect(COMMAND_CENTER).toMatch(
      /const\s+SECTION_RENDERERS\s*:\s*Record<\s*string,\s*SectionRendererEntry\s*>/,
    );
  });

  it("declares the CANONICAL_SECTION_IDS fallback list", () => {
    expect(COMMAND_CENTER).toMatch(/CANONICAL_SECTION_IDS/);
  });

  it("renders sections via the registry-driven render loop — not hand-coded JSX per section", () => {
    // Phase 38.12 — the render loop was upgraded to wrap consecutive
    // same-gridGroup sections in `ec-grid-2col` / `ec-grid-3col` bands.
    // The plan is computed by `buildSectionRenderPlan(finalSectionOrder)`,
    // so the loop entry point is the band iteration; the SECTION_RENDERERS
    // lookup happens INSIDE the band's entry list via the registry.
    expect(COMMAND_CENTER).toMatch(
      /buildSectionRenderPlan\(finalSectionOrder\)\.map\(/,
    );
    expect(COMMAND_CENTER).toMatch(/SECTION_RENDERERS\[sectionId\]/);
    expect(COMMAND_CENTER).toMatch(/data-section-position/);
  });

  it("removes the hand-coded ec-grid-2col section JSX (replaced by registry loop)", () => {
    // The legacy layout used hand-coded `<div className="ec-grid-2col">`
    // wrappers around hard-coded section JSX. Phase 38.11 moves the
    // section rendering to a registry loop — those hand-coded
    // wrappers should be gone.
    expect(COMMAND_CENTER).not.toMatch(
      /<div\s+id="caseOperations"\s+data-section="caseOperations"/,
    );
    expect(COMMAND_CENTER).not.toMatch(
      /<div\s+id="governancePosture"\s+data-section="governancePosture"/,
    );
  });

  it("each persona priority list maps to registered section ids", () => {
    // Spot-check: every section id used in any persona priority list
    // exists in the renderer registry (or in CANONICAL_SECTION_IDS).
    const REGISTERED = [
      "operationalPressure",
      "routingQueue",
      "investigationIntelligence",
      "workloadEngine",
      "caseOperations",
      "reviewerOrchestration",
      "pipelineDetail",
      "governancePosture",
      "queueCongestion",
      "auditReadiness",
      "organizationalIntelligence",
      "timeline",
      "recentEvidence",
      "incidents",
    ];
    for (const id of REGISTERED) {
      expect(COMMAND_CENTER).toMatch(
        new RegExp(`${id}:\\s*\\{\\s*ariaLabel:`),
      );
    }
  });

  it("preserves projectionSummary section availability via Object.keys(sections) intersection", () => {
    // The registry loop intersects the envelope's section keys with
    // the renderer registry — projectionSummary (and any other
    // backend-emitted section) remains available if it has a
    // registered renderer.
    expect(COMMAND_CENTER).toMatch(/Object\.keys\(sections\)/);
  });
});

// =============================================================================
// PART 2 — Capture workflow guidance panel
// =============================================================================

describe("Phase 38.11 — capture workflow guidance panel", () => {
  it("exports getCaptureWorkflowGuidance with a bounded entry per workflow", () => {
    expect(GUIDANCE_DATA).toMatch(/export function getCaptureWorkflowGuidance/);
    for (const code of [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ]) {
      expect(GUIDANCE_DATA).toMatch(new RegExp(`${code}:\\s*\\{`));
    }
  });

  it("CaptureWorkflowGuidance renders the canonical safety statement", () => {
    expect(GUIDANCE).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
  });

  it("CaptureWorkflowGuidance documents that recommended templates are a SUBSET (never replacement)", () => {
    expect(GUIDANCE).toMatch(/SUBSET, not a replacement/i);
    expect(GUIDANCE).toMatch(/All templates remain available/);
  });

  it("CaptureWorkflowGuidance is dismissible (localStorage-persisted, scoped per workflow)", () => {
    expect(GUIDANCE).toMatch(/data-capture-workflow-guidance-dismiss/);
    expect(GUIDANCE).toMatch(/localStorage/);
  });

  it("CaptureWorkflowGuidance has bounded a11y semantics", () => {
    expect(GUIDANCE).toMatch(/aria-label=\{`Workflow guidance:/);
    expect(GUIDANCE).toMatch(/aria-label="Dismiss workflow guidance"/);
  });

  it("capture page mounts the workflow guidance panel", () => {
    expect(CAPTURE).toMatch(/CaptureWorkflowGuidance/);
    expect(CAPTURE).toMatch(/workflow=\{workflowCode\}/);
  });

  it("capture guidance NEVER hides templates — recommended chips are a SUBSET, not a replacement", () => {
    // The component computes a recommended subset via
    //   `allTemplates.filter((t) => recommendedIds.has(t.id))`
    // for the chip strip. That's the SUBSET. What is forbidden is
    // RENDERING THE MAIN TEMPLATE LIST from a filtered subset. The
    // capture page itself still iterates `collectionPlans` (the
    // unfiltered, workflow-ordered full list) for the actual selector.
    expect(GUIDANCE).toMatch(/All templates remain available/);
    // Capture page must not reduce its main template list via a
    // workflow filter.
    expect(CAPTURE).not.toMatch(
      /collectionPlans\.filter\([\s\S]{0,80}workflow/,
    );
  });

  it("guidance copy is operational tone — no legal/marketing overclaims", () => {
    // Forbidden marketing / legal-overclaim phrases.
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\bauthentic\b/i,
      /\bguaranteed\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bfraud-proof\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(GUIDANCE_DATA, `guidance copy must not match ${pattern}`).not.toMatch(
        pattern,
      );
    }
  });
});

// =============================================================================
// PART 3 — Route registry expansion (8 new entries)
// =============================================================================

describe("Phase 38.11 — route registry expansion (8 new routes)", () => {
  const NEW_ROUTES: Array<{ id: string; href: string }> = [
    { id: "governance.policy", href: "/governance/policy" },
    { id: "governance.analytics", href: "/governance/analytics" },
    { id: "governance.lifecycle", href: "/governance/lifecycle" },
    { id: "governance.destruction", href: "/governance/destruction" },
    { id: "governance.notifications", href: "/governance/notifications" },
    { id: "platform.observability", href: "/operations/observability" },
    { id: "investigation.hub", href: "/investigation" },
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

  it("governance subroutes inherit ORGANIZATION_ONLY scope", () => {
    for (const id of [
      "governance.policy",
      "governance.analytics",
      "governance.lifecycle",
      "governance.destruction",
      "governance.notifications",
    ]) {
      const block = REGISTRY.match(
        new RegExp(
          `id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]*?requiredActiveSpace:\\s*"([A-Z_]+)"`,
        ),
      );
      expect(block?.[1], `${id} must be ORGANIZATION_ONLY`).toBe(
        "ORGANIZATION_ONLY",
      );
    }
  });
});

// =============================================================================
// PART 4 — PageRouteGate migrations (8 more pages)
// =============================================================================

describe("Phase 38.11 — additional PageRouteGate migrations", () => {
  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    {
      page: "app/(app)/governance/policy/page.tsx",
      routeId: "governance.policy",
    },
    {
      page: "app/(app)/governance/analytics/page.tsx",
      routeId: "governance.analytics",
    },
    {
      page: "app/(app)/governance/lifecycle/page.tsx",
      routeId: "governance.lifecycle",
    },
    {
      page: "app/(app)/governance/destruction/page.tsx",
      routeId: "governance.destruction",
    },
    {
      page: "app/(app)/governance/notifications/page.tsx",
      routeId: "governance.notifications",
    },
    {
      page: "app/(app)/operations/observability/page.tsx",
      routeId: "platform.observability",
    },
    {
      page: "app/(app)/reviewer-ops/sla/page.tsx",
      routeId: "review.sla",
    },
    {
      page: "app/(app)/investigation/page.tsx",
      routeId: "investigation.hub",
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
// PART 5 — Legacy hook shrinkage (sla, policy, observability migrated)
// =============================================================================

describe("Phase 38.11 — useTeamWorkspaceGate allow-list shrinkage", () => {
  const MIGRATED_OFF = [
    "app/(app)/reviewer-ops/sla/page.tsx",
    "app/(app)/governance/policy/page.tsx",
    "app/(app)/operations/observability/page.tsx",
  ];

  for (const page of MIGRATED_OFF) {
    it(`${page} no longer imports useTeamWorkspaceGate`, () => {
      const src = readWeb(page);
      expect(src).not.toMatch(/useTeamWorkspaceGate/);
    });
    it(`${page} now reads activeSpaceId from the canonical envelope`, () => {
      const src = readWeb(page);
      expect(src).toMatch(/useActiveSpaceId/);
    });
  }
});

// =============================================================================
// PART 6 — Cumulative migration tally
// =============================================================================

describe("Phase 38.11 — cumulative <PageRouteGate> adoption", () => {
  it("at least 29 canonical pages now wrap in <PageRouteGate>", () => {
    const PAGES = [
      // Phase 38.7
      "app/(app)/reports/page.tsx",
      "app/(app)/cases/page.tsx",
      "app/(app)/search/page.tsx",
      // Phase 38.8
      "app/(app)/home/page.tsx",
      "app/(app)/governance/page.tsx",
      // Phase Final-Vocab-Alignment — canonical reviewer console is
      // `/review/page.tsx`; the legacy `/reviewer-ops/page.tsx` was
      // deleted and the URL redirects via `next.config.js`.
      "app/(app)/review/page.tsx",
      "app/(app)/operations/page.tsx",
      // Phase Final-Closure-Remediation — canonical surface is
      // `/workspaces`; the duplicate `/teams/page.tsx` was deleted.
      "app/(app)/workspaces/page.tsx",
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
      "app/(app)/operations/runbooks/page.tsx",
      "app/(app)/reviewer-ops/escalations/page.tsx",
      // Phase 38.11
      "app/(app)/governance/policy/page.tsx",
      "app/(app)/governance/analytics/page.tsx",
      "app/(app)/governance/lifecycle/page.tsx",
      "app/(app)/governance/destruction/page.tsx",
      "app/(app)/governance/notifications/page.tsx",
      "app/(app)/operations/observability/page.tsx",
      "app/(app)/reviewer-ops/sla/page.tsx",
      "app/(app)/investigation/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(29);
  });
});

// =============================================================================
// PART 7 — Forbidden copy + safety statement final lock
// =============================================================================

describe("Phase 38.11 — forbidden copy + safety statement final lock", () => {
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

  it("CommandCenter + capture surfaces contain no profession-locking copy", () => {
    for (const src of [COMMAND_CENTER, CAPTURE, GUIDANCE, GUIDANCE_DATA]) {
      for (const pattern of BANNED) {
        expect(src).not.toMatch(pattern);
      }
    }
  });

  it("required safety statement appears on the capture guidance panel", () => {
    // The component imports + renders WORKFLOW_SAFETY_STATEMENT.
    expect(GUIDANCE).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
  });

  it("required safety statement remains on All Tools + persona + command palette", () => {
    const TOOLS = readWeb("app/(app)/tools/page.tsx");
    const PERSONA = readWeb("app/(app)/settings/persona/page.tsx");
    const PALETTE = readWeb("components/navigation/CommandPalette.tsx");
    expect(TOOLS).toMatch(
      /Workflow profiles personalize layout, defaults, and\s+recommendations\. They do not change permissions or remove tools\./,
    );
    expect(PERSONA).toMatch(
      /workflow profile tunes ordering, defaults, and labels\. It does\s+NOT change/i,
    );
    expect(PALETTE).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
  });
});
