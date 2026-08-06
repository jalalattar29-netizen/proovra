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

describe("Reviewer console landing page (full adoption)", () => {
  // Phase 12 Point 4 — `/reviewer-ops` was retired in favour of the
  // canonical `/review` console (ReviewerConsole), and the unmounted
  // ReviewerCommandConsole was deleted after its runtime banner,
  // operator pivots and bulk triage were folded in here. The console
  // uses its own bounded loading / error / empty states rather than the
  // OperationalEmptyState preset; the runtime banner is still sourced
  // from the operational barrel and scoped to reviewer_ops.
  const src = readSource(
    "../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx",
  );

  it("imports the runtime banner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[./]+\/operational"/,
    );
  });

  it("scopes RuntimeStatusBanner to reviewer_ops (Phase 32.7 invariant)", () => {
    expect(src).toMatch(
      /<RuntimeStatusBanner[\s\S]{0,400}forDomains=\{\s*\[\s*"reviewer_ops"\s*\]/,
    );
  });

  it("renders an empty-state note when no review workflows exist", () => {
    expect(src).toMatch(
      /rows\.length === 0[\s\S]{0,400}No reviews in this slice/,
    );
  });

  it("provides actionable links from the console to related operator surfaces", () => {
    expect(src).toMatch(/\/reviewer-ops\/escalations/);
    expect(src).toMatch(/\/reviewer-ops\/sla/);
    expect(src).toMatch(/\/governance\/policy/);
    expect(src).toMatch(/\/operations\/observability/);
  });

  it("no banned wording in this console's string literals", () => {
    assertNoBannedWordingInStringLiterals(
      src,
      "reviewer-experience/ReviewerConsole.tsx",
    );
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
      /import\s*\{[\s\S]*?NoWorkloadSnapshotsEmptyState[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[./]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known", () => {
    // Phase 32.7 — banner usage now optionally includes `forDomains`
    // for degradation isolation, and the JSX may be wrapped in `()`
    // with intervening comments explaining the scoping decision.
    // Accept both the legacy single-prop shape and the scoped
    // multi-prop / multi-line shape with comments between.
    expect(src).toMatch(
      /teamId\s*\?\s*\(?[\s\S]{0,800}?<RuntimeStatusBanner[\s\S]{0,400}teamId=\{teamId\}/,
    );
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
  // Phase 32.8B — policy admin consolidated under /governance/policy
  // per Phase 32.8A. /reviewer-ops/policy now redirects here.
  const src = readSource(
    "../../../apps/web/app/(app)/governance/policy/page.tsx",
  );

  it("imports RuntimeStatusBanner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[./]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner only when teamId is known", () => {
    // Phase 32.7 — banner usage now optionally includes `forDomains`
    // for degradation isolation, and the JSX may be wrapped in `()`
    // with intervening comments explaining the scoping decision.
    // Accept both the legacy single-prop shape and the scoped
    // multi-prop / multi-line shape with comments between.
    expect(src).toMatch(
      /teamId\s*\?\s*\(?[\s\S]{0,800}?<RuntimeStatusBanner[\s\S]{0,400}teamId=\{teamId\}/,
    );
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

describe("Governance dashboard (full adoption — Phase 32.8E architecture)", () => {
  // Phase 32.8E — /governance was rebuilt as the Governance Control
  // Plane (GovernanceControlPlane). It uses bounded per-section
  // empty-state notes rather than the Phase 28-G OperationalEmptyState
  // presets; the runtime banner is sourced from the operational barrel
  // and scoped to governance_lifecycle.
  const src = readSource(
    "../../../apps/web/components/governance-experience/GovernanceControlPlane.tsx",
  );

  it("imports the runtime banner from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[./]+\/operational"/,
    );
  });

  it("scopes RuntimeStatusBanner to governance_lifecycle (Phase 32.7 invariant)", () => {
    expect(src).toMatch(
      /<RuntimeStatusBanner[\s\S]{0,400}forDomains=\{\s*\[\s*"governance_lifecycle"\s*\]/,
    );
  });

  it("renders an empty-state note when no evidence-level holds exist", () => {
    expect(src).toMatch(
      /evidenceHolds\.length === 0[\s\S]{0,400}No evidence-level holds placed/,
    );
  });

  it("renders an empty-state note when no case-level holds exist", () => {
    expect(src).toMatch(
      /caseHolds\.length === 0[\s\S]{0,400}No case-level legal holds placed/,
    );
  });

  it("renders an empty-state note when no retention candidates exist", () => {
    expect(src).toMatch(
      /candidates\.length === 0[\s\S]{0,400}No retention candidates awaiting review/,
    );
  });

  it("renders an empty-state note when no pending destruction reviews exist", () => {
    expect(src).toMatch(
      /pendingDestructionReviews\.length === 0[\s\S]{0,400}No destruction reviews pending/,
    );
  });

  it("no banned wording in this control-plane's string literals", () => {
    assertNoBannedWordingInStringLiterals(
      src,
      "governance-experience/GovernanceControlPlane.tsx",
    );
  });
});

// =============================================================================
// Observability dashboard
// =============================================================================

describe("Observability dashboard (full adoption)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
  );

  it("imports RuntimeStatusBanner from the operational barrel", () => {
    // Phase 28-I added the summary-tile rollup which also imports
    // OPS_INK / OPS_SURFACE / OPS_TONES from the same barrel. Match the
    // RuntimeStatusBanner symbol inside the imported set rather than
    // requiring it to be the only import.
    expect(src).toMatch(
      /import\s*\{[\s\S]*?RuntimeStatusBanner[\s\S]*?\}\s*from\s*"[./]+components\/operational"/,
    );
  });

  it("renders RuntimeStatusBanner inside the main render", () => {
    // Phase 32.7 — also accepts banner usage with `forDomains` prop.
    expect(src).toMatch(
      /<RuntimeStatusBanner[\s\S]{0,200}teamId=\{teamId\}/,
    );
  });

  it("banner is rendered above the telemetry content (operator sees runtime state first)", () => {
    // Phase 7C — the page migrated to the shared PageShell/PageHeader; the
    // old `<header style={headerStyle}>` is gone. The runtime banner still
    // renders ahead of the telemetry body so operators read runtime state
    // before the metrics. Anchor on the first content section instead.
    const bannerIdx = src.indexOf("RuntimeStatusBanner teamId");
    const contentIdx = src.indexOf("data-observability-summary");
    expect(bannerIdx).toBeGreaterThan(0);
    expect(contentIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeLessThan(contentIdx);
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
  // Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
  // concatenate the orchestrator + every tab body so source-shape
  // assertions still find the relevant snippets. Operational
  // imports (ExportPackageEligibilityBadge / OperationalTimelinePanel /
  // RuntimeStatusBanner) are split across orchestrator + tabs:
  //   - RuntimeStatusBanner + ExportPackageEligibilityBadge → page.tsx
  //   - OperationalTimelinePanel → EvidenceCustodyTab.tsx
  //   - GovernanceSnapshotPanel → EvidenceOverviewTab.tsx
  const src = [
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx",
  ].map(readSource).join("\n\n");

  it("imports ExportPackageEligibilityBadge + GovernanceSnapshotPanel + OperationalTimelinePanel + RuntimeStatusBanner from the operational barrel", () => {
    // Phase EVIDENCE-IA-DECOMPOSE — the four operational-barrel
    // imports are split across files now (page.tsx, _tabs/
    // EvidenceOverviewTab.tsx, _tabs/EvidenceCustodyTab.tsx). The
    // contract is per-name: each must be imported from a relative
    // path ending in `components/operational`, somewhere in the
    // evidence-detail surface. The concatenated `src` covers all
    // tab files.
    const operationalBarrel = /from\s*"[./]+components\/operational"/;
    for (const name of [
      "ExportPackageEligibilityBadge",
      "GovernanceSnapshotPanel",
      "OperationalTimelinePanel",
      "RuntimeStatusBanner",
    ]) {
      // The name must appear inside an import that resolves to the
      // operational barrel. Match `import { ... NAME ... } from "...operational"`.
      const importLine = new RegExp(
        `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"[\\.\\/]+components\\/operational"`,
      );
      expect(src, `${name} should be imported from components/operational`).toMatch(
        importLine,
      );
    }
    // Sanity — the barrel is actually referenced somewhere.
    expect(src).toMatch(operationalBarrel);
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

  it("eligibility state defaults to enabled (Phase 28-H hotfix — backend gate is authoritative)", () => {
    // State variables exist and default to FALSE (button enabled). The
    // download routes already run enforceSensitiveAction(...) server-side
    // — the client must NOT pre-emptively block downloads when the
    // governance snapshot is missing, 403, or transiently unavailable.
    expect(src).toMatch(/const\s+\[exportDisabled,\s*setExportDisabled\]\s*=\s*useState\(false\)/);
    expect(src).toMatch(/const\s+\[packageDisabled,\s*setPackageDisabled\]\s*=\s*useState\(false\)/);
    // Both buttons consume the disabled state. Phase A0 added an
    // `|| isIntegrityFailed` short-circuit so failed-hash records
    // cannot be downloaded even if the eligibility check says yes
    // — the disabled expression became `exportDisabled ||
    // isIntegrityFailed`. The contract we still want to assert is
    // that the eligibility-derived flag participates in the disabled
    // gate.
    expect(src).toMatch(
      /<Button[\s\S]*?onClick=\{\(\) => void downloadReport\(\)\}[\s\S]*?disabled=\{exportDisabled\b/,
    );
    expect(src).toMatch(
      /<Button[\s\S]*?onClick=\{\(\) => void downloadVerificationPackage\(\)\}[\s\S]*?disabled=\{packageDisabled\b/,
    );
  });

  it("disabled-callback flips the button OFF only on a confirmed non-eligible decision", () => {
    // The callback must require ALL of: !loading && !unknown && !eligible.
    // Loading, unknown, missing-teamId, and 403 paths must leave the
    // button enabled so the backend gate gets a chance to run.
    expect(src).toMatch(
      /!s\.loading\s*&&\s*!s\.unknown\s*&&\s*!s\.eligible/,
    );
    // The old (broken) fail-closed-on-loading expression must NOT exist.
    expect(src).not.toMatch(
      /s\.loading\s*\|\|\s*s\.unknown\s*\|\|\s*!s\.eligible/,
    );
  });

  it("no React state write outside the eligibility callbacks toggles the disabled state", () => {
    // Guard against future regressions that wire setExportDisabled /
    // setPackageDisabled from another source (e.g. effects, plan-cap
    // checks, billing checks). Each setter must appear at most once
    // outside its declaration line — and that one usage must be inside
    // the badge's onEligibilityChange callback.
    const exportSetterUses = src.match(/setExportDisabled\b/g) ?? [];
    const packageSetterUses = src.match(/setPackageDisabled\b/g) ?? [];
    // Each setter appears exactly twice: declaration + one callback.
    expect(exportSetterUses.length).toBe(2);
    expect(packageSetterUses.length).toBe(2);
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
      /import\s*\{([\s\S]*?)\}\s*from\s*"[./]+components\/operational"/,
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
// Phase 28-H hotfix — backend authoritative-gate invariants
// =============================================================================

describe("Download routes (authoritative governance gate)", () => {
  const src = readSource(
    "../../../services/api/src/routes/evidence.routes.ts",
  );

  it("GET /v1/evidence/:id/report/latest exists and runs enforceSensitiveAction(\"download_report\", ...)", () => {
    // The latest-report route is registered.
    expect(src).toMatch(/"\/v1\/evidence\/:id\/report\/latest"/);
    // And the route body invokes the canonical sensitive-action gate
    // with the download_report action name.
    expect(src).toMatch(
      /enforceSensitiveAction\(\s*"download_report"\s*,/,
    );
  });

  it("GET /v1/evidence/:id/verification-package exists and runs enforceSensitiveAction(\"download_package\", ...)", () => {
    expect(src).toMatch(/"\/v1\/evidence\/:id\/verification-package"/);
    expect(src).toMatch(
      /enforceSensitiveAction\(\s*"download_package"\s*,/,
    );
  });

  it("a blocked decision returns 403/503 — never a signed URL leak", () => {
    // The gate rejects with 403 (or 503 for GOVERNANCE_CHECK_FAILED) and
    // never falls through to the signed-URL response. Assert both code
    // branches exist in the route source.
    expect(src).toMatch(
      /decision\.code === "GOVERNANCE_CHECK_FAILED"\s*\?\s*503\s*:\s*403/,
    );
  });

  it("custody event EXPORT_BLOCKED_BY_POLICY is appended when a download is blocked (no silent failure)", () => {
    expect(src).toMatch(
      /CustodyEventType\.EXPORT_BLOCKED_BY_POLICY/,
    );
  });
});

// =============================================================================
// Cross-page invariants
// =============================================================================

describe("Phase 28-H [cross-page wiring invariants]", () => {
  const ADOPTING_PAGES = [
    // Phase 32.8E — /review and /governance are thin wrappers around
    // their experience components; the banner + operational barrel
    // adoption lives inside the component files.
    "../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx",
    "../../../apps/web/components/governance-experience/GovernanceControlPlane.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
    // Phase 32.8B — policy admin moved to /governance/policy.
    "../../../apps/web/app/(app)/governance/policy/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  ];

  it("every adopting page imports from the operational barrel exactly once", () => {
    for (const rel of ADOPTING_PAGES) {
      const src = readSource(rel);
      // Phase 32.8E — some adopting surfaces are now component files
      // sitting next to /operational; their relative import path is
      // `../operational` rather than `../../../components/operational`.
      const matches =
        src.match(/from\s*"(?:[./]+components\/operational|\.\.\/operational)"/g) ?? [];
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
      // The invariant is "no fabricated operational VALUE is rendered".
      // A numeric bound declared in a page-size / limit / cap constant
      // is configuration, not a displayed count, so those declarations
      // are excluded from the scan rather than allowlisted per file —
      // otherwise every page that grows a pagination cap trips this
      // guard for a legitimate pattern.
      const src = readSource(rel).replace(
        /const\s+[A-Z0-9_]*(?:LIMIT|CAP|CAPS|PAGE|STEP|MAX|MIN)[A-Z0-9_]*\s*(?::[^=]+)?=\s*\{[\s\S]*?\n\};/g,
        "",
      );
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
