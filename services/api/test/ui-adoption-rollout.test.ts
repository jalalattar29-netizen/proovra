/**
 * Phase 28-H — FULL UI ADOPTION ROLLOUT source-contract tests.
 *
 * Phase 28-G shipped the operational component family (governance
 * snapshot panel, operational timeline panel, runtime status banner,
 * export/package eligibility badge, bounded empty-state presets).
 * This file asserts that each operationally-relevant page now consumes
 * those components correctly:
 *
 *   - reviewer-ops landing
 *   - reviewer-ops/sla
 *   - reviewer-ops/policy
 *   - governance dashboard
 *   - observability dashboard
 *   - evidence detail
 *
 * Hard wiring contracts asserted:
 *
 *   1. Each page imports from the operational barrel.
 *   2. RuntimeStatusBanner is rendered (null-safe — only when teamId is
 *      known) so degraded / unknown runtime never goes silent.
 *   3. Pages that have a real "empty-state" slot wire the bounded
 *      preset rather than the old dead "No X." paragraph.
 *   4. Evidence detail uses the eligibility badge AND propagates its
 *      callback to disable the underlying button (fail-closed UX).
 *   5. No forbidden wording appears in any newly-adopted string
 *      literal (tamper / forged / altered content).
 *
 * Pure source-contract — no DOM, no React renderer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const BANNED_WORDING =
  /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;

function assertNoBannedWordingInStringLiterals(src: string, label: string) {
  const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
  const all = stringLiterals.join(" ");
  expect(all, `banned wording leaked into ${label}`).not.toMatch(
    BANNED_WORDING,
  );
}

// =============================================================================
// Reviewer Ops — landing page
// =============================================================================

describe("Reviewer Ops landing page (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/reviewer-ops/page.tsx",
  );

  it("imports the empty-state preset + runtime banner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?OperationalEmptyState[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known (null-safe)", () => {
    expect(src).toMatch(/teamId\s*\?\s*<RuntimeStatusBanner\s+teamId=\{teamId\}\s*\/>/);
  });

  it("renders OperationalEmptyState when the review queue is empty", () => {
    expect(src).toMatch(/rows\.length === 0[\s\S]*?<OperationalEmptyState/);
  });

  it("the empty-state explains runtime dependency, not just 'no rows'", () => {
    expect(src).toContain("emptyStateCode=\"no_review_queue\"");
    expect(src).toMatch(/runtimeDependency=/);
  });

  it("provides actionable links from the empty-state to related operator surfaces", () => {
    expect(src).toMatch(/\/reviewer-ops\/escalations/);
    expect(src).toMatch(/\/reviewer-ops\/sla/);
    expect(src).toMatch(/\/reviewer-ops\/policy/);
    expect(src).toMatch(/\/ops\/observability/);
  });

  it("no banned wording in this page's string literals", () => {
    assertNoBannedWordingInStringLiterals(src, "reviewer-ops/page.tsx");
  });
});

// =============================================================================
// Reviewer Ops — SLA dashboard
// =============================================================================

describe("Reviewer Ops SLA page (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
  );

  it("imports NoWorkloadSnapshotsEmptyState + RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?NoWorkloadSnapshotsEmptyState[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known", () => {
    expect(src).toMatch(/teamId\s*\?\s*<RuntimeStatusBanner\s+teamId=\{teamId\}\s*\/>/);
  });

  it("renders NoWorkloadSnapshotsEmptyState when no reviewer activity is recorded", () => {
    expect(src).toContain("<NoWorkloadSnapshotsEmptyState />");
  });

  it("removed the old dead 'No reviewer activity in this range.' text", () => {
    expect(src).not.toContain("No reviewer activity in this range.");
  });

  it("no banned wording in this page's string literals", () => {
    assertNoBannedWordingInStringLiterals(src, "reviewer-ops/sla/page.tsx");
  });
});

// =============================================================================
// Reviewer Ops — policy admin
// =============================================================================

describe("Reviewer Ops policy page (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/reviewer-ops/policy/page.tsx",
  );

  it("imports RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known", () => {
    expect(src).toMatch(/teamId\s*\?\s*<RuntimeStatusBanner\s+teamId=\{teamId\}\s*\/>/);
  });

  it("the banner sits inside the main render block (above the policy form)", () => {
    const bannerIdx = src.indexOf("RuntimeStatusBanner teamId");
    const policyFormIdx = src.indexOf("SLA overrides (hours)");
    expect(bannerIdx).toBeGreaterThan(0);
    expect(policyFormIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeLessThan(policyFormIdx);
  });

  it("no banned wording in this page's string literals", () => {
    assertNoBannedWordingInStringLiterals(src, "reviewer-ops/policy/page.tsx");
  });
});

// =============================================================================
// Governance dashboard
// =============================================================================

describe("Governance dashboard (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/governance/page.tsx",
  );

  it("imports NoGovernanceIncidentsEmptyState + OperationalEmptyState + RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?NoGovernanceIncidentsEmptyState[\s\S]*?OperationalEmptyState[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known (null-safe)", () => {
    expect(src).toMatch(/teamId\s*\?\s*<RuntimeStatusBanner\s+teamId=\{teamId\}\s*\/>/);
  });

  it("replaces the dead 'No legal holds on record.' paragraph with OperationalEmptyState", () => {
    expect(src).not.toContain("No legal holds on record.");
    expect(src).toContain("emptyStateCode=\"no_evidence_legal_holds\"");
  });

  it("replaces the dead 'No case-level holds on record.' paragraph with OperationalEmptyState", () => {
    expect(src).not.toContain("No case-level holds on record.");
    expect(src).toContain("emptyStateCode=\"no_case_legal_holds\"");
  });

  it("replaces the dead 'No expired records flagged.' paragraph with NoGovernanceIncidentsEmptyState", () => {
    expect(src).not.toContain("No expired records flagged.");
    expect(src).toContain("<NoGovernanceIncidentsEmptyState />");
  });

  it("retention candidates empty-state is wired inside the retention candidates section", () => {
    const retentionSectionIdx = src.indexOf("Retention candidates");
    const incidentsPresetIdx = src.indexOf("<NoGovernanceIncidentsEmptyState />");
    expect(retentionSectionIdx).toBeGreaterThan(0);
    expect(incidentsPresetIdx).toBeGreaterThan(retentionSectionIdx);
  });

  it("no banned wording in this page's string literals", () => {
    assertNoBannedWordingInStringLiterals(src, "governance/page.tsx");
  });
});

// =============================================================================
// Observability dashboard
// =============================================================================

describe("Observability dashboard (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/ops/observability/page.tsx",
  );

  it("imports RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{\s*RuntimeStatusBanner\s*\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner inside the main render", () => {
    expect(src).toMatch(/<RuntimeStatusBanner\s+teamId=\{teamId\}\s*\/>/);
  });

  it("banner is rendered above the header (operator sees runtime state first)", () => {
    const bannerIdx = src.indexOf("RuntimeStatusBanner teamId");
    const headerIdx = src.indexOf("<header style={headerStyle}>");
    expect(bannerIdx).toBeGreaterThan(0);
    expect(headerIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeLessThan(headerIdx);
  });

  it("no banned wording in this page's string literals", () => {
    assertNoBannedWordingInStringLiterals(
      src,
      "ops/observability/page.tsx",
    );
  });
});

// =============================================================================
// Evidence detail
// =============================================================================

describe("Evidence detail page (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  );

  it("imports ExportPackageEligibilityBadge + GovernanceSnapshotPanel + OperationalTimelinePanel + RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?ExportPackageEligibilityBadge[\s\S]*?GovernanceSnapshotPanel[\s\S]*?OperationalTimelinePanel[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner inside the evidence-detail-shell (operator sees runtime state above the hero)", () => {
    expect(src).toMatch(
      /evidence-detail-shell[\s\S]*?<RuntimeStatusBanner\s+teamId=\{workspace\.reviewWorkflow\.teamId\}/,
    );
  });

  it("renders ExportPackageEligibilityBadge for both export and package kinds", () => {
    expect(src).toMatch(
      /<ExportPackageEligibilityBadge[\s\S]*?kind="export"/,
    );
    expect(src).toMatch(
      /<ExportPackageEligibilityBadge[\s\S]*?kind="package"/,
    );
  });

  it("eligibility callback gates each hero button (fail-closed: disabled until eligible)", () => {
    // State variables exist and default to TRUE (disabled).
    expect(src).toMatch(/setExportDisabled\b/);
    expect(src).toMatch(/setPackageDisabled\b/);
    expect(src).toMatch(/useState\(true\);.*\n.*setPackageDisabled/s);
    // Both buttons consume the disabled state.
    expect(src).toMatch(
      /<Button[\s\S]*?onClick=\{\(\) => void downloadReport\(\)\}[\s\S]*?disabled=\{exportDisabled\}/,
    );
    expect(src).toMatch(
      /<Button[\s\S]*?onClick=\{\(\) => void downloadVerificationPackage\(\)\}[\s\S]*?disabled=\{packageDisabled\}/,
    );
  });

  it("disabled-callback treats loading and unknown as blocked (not just !eligible)", () => {
    // Both badges propagate { loading, unknown, eligible }.
    expect(src).toMatch(
      /s\.loading\s*\|\|\s*s\.unknown\s*\|\|\s*!s\.eligible/,
    );
  });

  it("renders GovernanceSnapshotPanel on the overview tab when teamId is known", () => {
    expect(src).toMatch(
      /activeTab === "overview"[\s\S]*?<GovernanceSnapshotPanel/,
    );
    expect(src).toMatch(
      /workspace\.reviewWorkflow\?\.teamId[\s\S]*?<GovernanceSnapshotPanel/,
    );
  });

  it("renders OperationalTimelinePanel on the custody tab when teamId is known", () => {
    expect(src).toMatch(
      /activeTab === "custody"[\s\S]*?<OperationalTimelinePanel/,
    );
    expect(src).toMatch(
      /workspace\.reviewWorkflow\?\.teamId[\s\S]*?<OperationalTimelinePanel/,
    );
  });

  it("eligibility badges are placed in the hero block (operator sees them next to the action buttons)", () => {
    const badgeIdx = src.indexOf("<ExportPackageEligibilityBadge");
    const downloadReportButtonIdx = src.indexOf(
      "void downloadReport()",
    );
    expect(badgeIdx).toBeGreaterThan(0);
    expect(downloadReportButtonIdx).toBeGreaterThan(0);
    expect(badgeIdx).toBeLessThan(downloadReportButtonIdx);
  });

  it("does not expose private notes / storage keys / signature material via the new wiring", () => {
    // The newly-added wiring block must NOT reference any of these.
    // Existing legacy code in the file may legitimately mention them
    // through other named imports — this assertion targets only the
    // *new* operational JSX surface by checking that the operational
    // import line does not include any of the forbidden identifiers.
    const importMatch = src.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*"[\.\/]+components\/operational"/,
    );
    expect(importMatch).not.toBeNull();
    const importList = importMatch?.[1] ?? "";
    for (const forbidden of [
      "privateReviewerNote",
      "decisionNote",
      "signatureBase64",
      "publicKeyPem",
      "otsProofBase64",
      "storageKey",
    ]) {
      expect(importList).not.toContain(forbidden);
    }
  });
});

// =============================================================================
// Cross-page invariants
// =============================================================================

describe("Phase 28-H [cross-page wiring invariants]", () => {
  const ADOPTING_PAGES = [
    "../../../apps/web/app/(app)/reviewer-ops/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/policy/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
    "../../../apps/web/app/(app)/governance/page.tsx",
    "../../../apps/web/app/(app)/ops/observability/page.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  ];

  it("every adopting page imports from the operational barrel exactly once", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      const matches =
        src.match(/from\s*"[\.\/]+components\/operational"/g) ?? [];
      expect(matches.length, `barrel import count wrong in ${rel}`).toBe(1);
    }
  });

  it("every adopting page either uses RuntimeStatusBanner or is the observability dashboard itself", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      // All adopting pages reference RuntimeStatusBanner. The
      // observability dashboard reference is at top-of-page; others
      // wrap it in a teamId null-check.
      expect(src, `RuntimeStatusBanner missing in ${rel}`).toMatch(
        /RuntimeStatusBanner/,
      );
    }
  });

  it("no adopting page uses banned wording in string literals", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      assertNoBannedWordingInStringLiterals(src, rel);
    }
  });

  it("no adopting page hardcodes operational counts (no fake escalations / overdue numbers)", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      expect(src, `fake counter in ${rel}`).not.toMatch(/escalations:\s*\d+,/);
      expect(src, `fake counter in ${rel}`).not.toMatch(/overdue:\s*\d+,/);
      expect(src, `fake counter in ${rel}`).not.toMatch(/incidents:\s*\d+,/);
    }
  });

  it("no adopting page leaks process.env values into rendered text", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      // Pages may legitimately reference NEXT_PUBLIC_* env at the
      // module top — but they should never embed env values into
      // user-visible JSX. We assert no `{process.env.…}` interpolation
      // in JSX.
      expect(src, `env interpolation in ${rel}`).not.toMatch(
        /\{process\.env\.[A-Z_]+\}/,
      );
    }
  });
});
