/**
 * Phase G1 — Governance & Lifecycle Completion (source-contract suite).
 *
 * Closes the deferred items from Phase B0 / F:
 *
 *   B0.4 — Retention engine consumes resolveTeamRetentionPolicy().
 *   F.1  — LifecycleStateBadge component (reusable).
 *   F.2  — GovernanceSummary component.
 *   F.3  — ExportEligibilityPreflight component.
 *   F.4  — RetentionConflictAlert + retention engine conflict surface.
 *   Tenancy observability — bounded counters from tenancy resolver.
 *   Public verify DESTROYED — anti-enumeration 404.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const RETENTION_ENGINE = readSource(
  "../src/services/governance-lifecycle/retention-engine.service.ts",
);
const EVIDENCE_ROUTES = readSource("../src/routes/evidence.routes.ts");
const METRICS_CATALOG = readSource(
  "../../../packages/shared-runtime/src/ops/metrics.service.ts",
);
const LIFECYCLE_BADGE = readSource(
  "../../../apps/web/components/governance/LifecycleStateBadge.tsx",
);
const GOVERNANCE_SUMMARY = readSource(
  "../../../apps/web/components/governance/GovernanceSummary.tsx",
);
// Phase 12 Point 4 — the Phase G1 `ExportEligibilityPreflight` was a
// duplicate of the Phase G2 `GovernedExportAction` wrapper that
// actually ships (mounted on evidence detail + the reports index). Its
// unique presentation (bounded outcome labels, lifecycle state, honest
// error copy) was migrated onto the wrapper and the duplicate deleted.
// The F.3 contract below now targets the surface operators see.
const EXPORT_PREFLIGHT = readSource(
  "../../../apps/web/components/governance/GovernedExportAction.tsx",
);
const RETENTION_CONFLICT = readSource(
  "../../../apps/web/components/governance/RetentionConflictAlert.tsx",
);
const RETENTION_PAGE = readSource(
  "../../../apps/web/app/(app)/governance/retention/page.tsx",
);

// ===========================================================================
// B0.4 — Retention engine integration
// ===========================================================================

describe("Phase G1 (B0.4) — retention engine consumes inheritance resolver", () => {
  it("retention engine imports resolveTeamRetentionPolicy from the B0 service", () => {
    expect(RETENTION_ENGINE).toMatch(
      /import\s*\{\s*resolveTeamRetentionPolicy\s*\}\s*from\s+"\.\.\/organization\/retention-inheritance\.service\.js"/,
    );
  });

  it("EffectiveRetentionDecision declares the bounded source attribution", () => {
    expect(RETENTION_ENGINE).toMatch(
      /source:\s*"team_policy"\s*\|\s*"org_policy_inherited"\s*\|\s*"none"/,
    );
  });

  it("falls back to org template when no explicit policy matches", () => {
    expect(RETENTION_ENGINE).toMatch(
      /candidates\.length\s*===\s*0[\s\S]*?resolveTeamRetentionPolicy\(input\.teamId/,
    );
    expect(RETENTION_ENGINE).toMatch(
      /inheritance\.source\s*===\s*"org_policy_inherited"[\s\S]*?source:\s*"org_policy_inherited"/,
    );
  });

  it("none fallback when no policy at any tier", () => {
    expect(RETENTION_ENGINE).toMatch(
      /reason:\s*"no_active_policy"[\s\S]*?source:\s*"none"/,
    );
  });

  it("surfaces workspace-overrides-immutable + weaker-than-inherited conflicts", () => {
    expect(RETENTION_ENGINE).toContain('"workspace_overrides_immutable"');
    expect(RETENTION_ENGINE).toContain('"workspace_weaker_than_inherited"');
    expect(RETENTION_ENGINE).toContain('"duplicate_same_scope"');
  });

  it("bumps the inherited-total metric on org template fallback", () => {
    expect(RETENTION_ENGINE).toMatch(
      /bump\(\s*"retention_policy_inherited_total"\s*\)/,
    );
  });
});

// ===========================================================================
// Tenancy observability metrics
// ===========================================================================

describe("Phase G1 — tenancy observability metrics", () => {
  it("metrics catalog declares the new bounded counters", () => {
    expect(METRICS_CATALOG).toContain('"retention_policy_inherited_total"');
    expect(METRICS_CATALOG).toContain('"tenancy_resolution_failure_total"');
    expect(METRICS_CATALOG).toContain('"tenancy_disagreement_total"');
    expect(METRICS_CATALOG).toContain('"governance_inheritance_fallback_total"');
    expect(METRICS_CATALOG).toContain('"governance_inheritance_error_total"');
    expect(METRICS_CATALOG).toContain('"orphan_governance_object_total"');
    expect(METRICS_CATALOG).toContain('"cross_org_resolution_blocked_total"');
  });

});

// ===========================================================================
// Public verify DESTROYED gate
// ===========================================================================

describe("Phase G1 — public verify destroyed-state anti-enumeration", () => {
  it("returns 404 with generic message when evidence.lifecycleState === DESTROYED", () => {
    expect(EVIDENCE_ROUTES).toMatch(
      /lifecycleState\s*===\s*"DESTROYED"[\s\S]*?reply\.code\(404\)\.send\(\{\s*message:\s*"Evidence not found"\s*\}\)/,
    );
  });

  it("records the suppressed outcome in the audit log without leaking state", () => {
    expect(EVIDENCE_ROUTES).toMatch(
      /outcome:\s*"lifecycle_destroyed"/,
    );
  });
});

// ===========================================================================
// F.1 — LifecycleStateBadge
// ===========================================================================

describe("Phase G1 (F.1) — LifecycleStateBadge component", () => {
  it("declares the bounded vocabulary of seven lifecycle states", () => {
    const states = [
      "ACTIVE",
      "UNDER_REVIEW",
      "ON_HOLD",
      "RETENTION_LOCKED",
      "PENDING_DESTRUCTION",
      "DESTROYED",
      "ARCHIVED",
    ];
    for (const s of states) {
      expect(LIFECYCLE_BADGE).toContain(`"${s}"`);
    }
  });

  it("renders blocked-actions hint per state", () => {
    expect(LIFECYCLE_BADGE).toContain("STATE_BLOCKED");
    expect(LIFECYCLE_BADGE).toMatch(/PENDING_DESTRUCTION:[\s\S]*?\["export"/);
  });

  it("supports inheritance source via the optional prop", () => {
    expect(LIFECYCLE_BADGE).toMatch(
      /inheritanceSource\?:\s*"team_policy"\s*\|\s*"org_policy_inherited"\s*\|\s*"none"/,
    );
  });

  it("renders compact and block variants", () => {
    expect(LIFECYCLE_BADGE).toMatch(/compact\s*=\s*true/);
    expect(LIFECYCLE_BADGE).toContain("data-lifecycle-state-badge");
    expect(LIFECYCLE_BADGE).toContain("data-lifecycle-blocked");
  });

  it("exports the isLifecycleStateValue type guard", () => {
    expect(LIFECYCLE_BADGE).toMatch(/export function isLifecycleStateValue/);
  });
});

// ===========================================================================
// F.2 — GovernanceSummary
// ===========================================================================

describe("Phase G1 (F.2) — GovernanceSummary component", () => {
  it("exposes all five operational rows + conflict surface", () => {
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="lifecycle"');
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="retention"');
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="holds"');
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="destruction"');
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="export"');
    expect(GOVERNANCE_SUMMARY).toContain('data-governance-row="conflicts"');
  });

  it("renders retention-source labels for the three resolver outcomes", () => {
    expect(GOVERNANCE_SUMMARY).toContain('team_policy: "Local workspace policy"');
    expect(GOVERNANCE_SUMMARY).toContain(
      'org_policy_inherited: "Inherited from organization"',
    );
    expect(GOVERNANCE_SUMMARY).toContain('none: "No retention policy"');
  });

  it("supports the matter variant for Matter Workspace Overview", () => {
    expect(GOVERNANCE_SUMMARY).toMatch(
      /variant\??:\s*"evidence"\s*\|\s*"matter"/,
    );
  });

  it("explicitly disclaims legal admissibility", () => {
    expect(GOVERNANCE_SUMMARY.replace(/\s+/g, " ")).toMatch(
      /Not a legal admissibility statement/,
    );
  });
});

// ===========================================================================
// F.3 — export eligibility pre-flight (canonical GovernedExportAction)
// ===========================================================================

describe("Phase G1 (F.3) — export eligibility pre-flight", () => {
  it("the duplicate preflight component stays removed", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../../../apps/web/components/governance/ExportEligibilityPreflight.tsx",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("is mounted on the surfaces that actually offer exports", () => {
    // The F.3 capability is only real if it gates a real button.
    //
    // Phase 12 Point 4 (Pass E) — retargeted from the evidence-library
    // `ArtifactPanel`, which had been unmounted when the library preview
    // pane moved to `QueueSelectionPreview`, leaving evidence exports with
    // NO governance preflight. The wrapper now lives on
    // `ArtifactHistorySection`, the canonical Artifacts-tab surface that
    // owns the real "Download latest" buttons.
    const artifactHistory = readSource(
      "../../../apps/web/app/(app)/evidence/[id]/components/ArtifactHistorySection.tsx",
    );
    const reportsIndex = readSource(
      "../../../apps/web/components/reports-experience/ReportsIndex.tsx",
    );
    for (const [name, src] of [
      ["ArtifactHistorySection", artifactHistory],
      ["ReportsIndex", reportsIndex],
    ] as const) {
      expect(src, `${name} must mount the governed export wrapper`).toMatch(
        /<GovernedExportAction/,
      );
      // A2 vocabulary — Report PDF and Verification Package ZIP are
      // never collapsed into one "Export" action.
      expect(src).toMatch(/actionLabel="Download Report PDF"/);
      expect(src).toMatch(
        /actionLabel="Download Verification Package ZIP"/,
      );
    }
  });

  it("renders the bounded outcome label + lifecycle state from the server projection", () => {
    expect(EXPORT_PREFLIGHT).toMatch(/OUTCOME_LABEL\[outcome!\]/);
    expect(EXPORT_PREFLIGHT).toMatch(/Blocked by legal hold/);
    expect(EXPORT_PREFLIGHT).toMatch(/Blocked by lifecycle state/);
    expect(EXPORT_PREFLIGHT).toMatch(/Blocked by active destruction review/);
    expect(EXPORT_PREFLIGHT).toMatch(/Blocked by workspace policy/);
    expect(EXPORT_PREFLIGHT).toMatch(/data-governed-export-lifecycle/);
  });

  it("surfaces the eligibility-check failure instead of swallowing it", () => {
    expect(EXPORT_PREFLIGHT).toMatch(/toSafeUserError\(/);
    expect(EXPORT_PREFLIGHT).toMatch(/Could not check export eligibility/);
    // No bare empty catch on the eligibility read.
    expect(EXPORT_PREFLIGHT).not.toMatch(/\}\s*catch\s*\{\s*\n\s*if \(mountedRef/);
  });

  it("never enables the action unless the server says ALLOWED", () => {
    expect(EXPORT_PREFLIGHT).toMatch(/const allowed = outcome === "ALLOWED"/);
    expect(EXPORT_PREFLIGHT).toMatch(/if \(!allowed\) return;/);
    expect(EXPORT_PREFLIGHT).toMatch(/disabled: !allowed/);
  });
  it("consumes /v1/governance/export-eligibility with teamId + evidenceId", () => {
    expect(EXPORT_PREFLIGHT).toMatch(
      /\/v1\/governance\/export-eligibility\?teamId=\$\{encodeURIComponent/,
    );
    expect(EXPORT_PREFLIGHT).toContain("&evidenceId=${encodeURIComponent(");
  });

  it("renders ALLOWED + the four bounded BLOCKED_* outcomes", () => {
    expect(EXPORT_PREFLIGHT).toContain("ALLOWED");
    expect(EXPORT_PREFLIGHT).toContain("BLOCKED_BY_HOLD");
    expect(EXPORT_PREFLIGHT).toContain("BLOCKED_BY_LIFECYCLE");
    expect(EXPORT_PREFLIGHT).toContain("BLOCKED_BY_REVIEW_GATE");
    expect(EXPORT_PREFLIGHT).toContain("BLOCKED_BY_POLICY");
  });

  it("renders next-step copy for each blocked outcome", () => {
    expect(EXPORT_PREFLIGHT).toContain("data-governed-export-next-step");
    expect(EXPORT_PREFLIGHT).toMatch(/Release the active legal hold/);
    expect(EXPORT_PREFLIGHT).toMatch(/destruction review must resolve/);
  });

  it("the eligibility verdict the UI shows is enforced server-side", () => {
    // Without this, a direct API call bypasses the gate the product
    // told the operator was in force.
    const evidenceRoutes = readSource("../src/routes/evidence.routes.ts");
    const blocks =
      evidenceRoutes.match(/checkExportEligibility\(\{[\s\S]{0,400}?\}\)/g) ?? [];
    expect(
      blocks.length,
      "report + package download routes must both consult checkExportEligibility",
    ).toBeGreaterThanOrEqual(2);
    expect(evidenceRoutes).toMatch(
      /Report download is blocked by evidence export eligibility/,
    );
    expect(evidenceRoutes).toMatch(
      /Verification package download is blocked by evidence export eligibility/,
    );
  });

  it("is read-only — never mutates state", () => {
    const code = stripComments(EXPORT_PREFLIGHT);
    expect(code).not.toMatch(/method:\s*"POST"/);
    expect(code).not.toMatch(/method:\s*"PATCH"/);
    expect(code).not.toMatch(/method:\s*"DELETE"/);
  });

  it("supports per-call actionLabel so Report PDF / Verification Package ZIP are not collapsed", () => {
    expect(EXPORT_PREFLIGHT).toMatch(/actionLabel: string;/);
    expect(EXPORT_PREFLIGHT).toMatch(/data-governed-export-action=\{actionLabel\}/);
  });
});

// ===========================================================================
// F.4 — RetentionConflictAlert + mount
// ===========================================================================

describe("Phase G1 (F.4) — RetentionConflictAlert + retention page mount", () => {
  it("consumes /v1/governance/dashboard and reads policyConflictCount", () => {
    expect(RETENTION_CONFLICT).toContain("/v1/governance/dashboard");
    expect(RETENTION_CONFLICT).toContain("policyConflictCount");
  });

  it("renders nothing when count is zero (no false-positive noise)", () => {
    expect(RETENTION_CONFLICT).toMatch(/count === 0\) return null/);
  });

  it("is mounted on the /governance/retention page", () => {
    expect(RETENTION_PAGE).toContain("RetentionConflictAlert");
    expect(RETENTION_PAGE).toMatch(
      /<RetentionConflictAlert\s+teamId=\{teamId\s*\?\?\s*null\}/,
    );
  });
});

// ===========================================================================
// Vocabulary discipline
// ===========================================================================

describe("Phase G1 — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "LifecycleStateBadge", src: LIFECYCLE_BADGE },
    { name: "GovernanceSummary", src: GOVERNANCE_SUMMARY },
    { name: "GovernedExportAction", src: EXPORT_PREFLIGHT },
    { name: "RetentionConflictAlert", src: RETENTION_CONFLICT },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "tampered", re: /\btampered?\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "forensic proof", re: /\bforensic\s+proof\b/i },
    { name: "compliance attestation", re: /\bcompliance attestation\b/i },
    { name: "kanban", re: /\bkanban\b/i },
    { name: "CRM", re: /\bCRM\b/ },
    { name: "ticket", re: /\bticket\b/i },
    { name: "Slack", re: /\bSlack\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}' (after stripping doc comments)`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});

// =============================================================================
// LEGACY-003 — removed module contract
// =============================================================================

/**
 * LEGACY-003 (2026-08-15) REMOVED `src/services/organization/tenancy-resolver.service.ts` as a caller-less second tenancy authority; see the Phase A1 suite for the full reasoning.
 */
describe("Phase G1 — tenancy resolver stays removed", () => {
  it("the removed module(s) stay removed", () => {
    for (const rel of [
      "../src/services/organization/tenancy-resolver.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});
