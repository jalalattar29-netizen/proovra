/**
 * Phase IA-self-serve-audit-fixes — source-contract pins for the
 * 34-issue audit-implementation pass.
 *
 * Each block below covers one fixed page. The pins are regex over the
 * actual file text, so a future refactor that drops a gate, reverts a
 * rename, or re-introduces a hidden href will trip the suite.
 *
 * Coverage map:
 *   1. Search — /workflows + /investigation inspector gates, section
 *      rename for self-serve.
 *   2. Trust — /governance card surfaceHref gate + body rewrite.
 *   3. Intake Links — feature-disabled rewrite, form label rename,
 *      mode label rename.
 *   4. Teams — landing page exists + matrix / access-review renames.
 *   5. Billing — checkout-panel clarification + "shared evidence
 *      workflows" replacement.
 *   6. Cases List — eyebrow + filter chip + group aria-label.
 *   7. Capture — aria-label, eyebrow, placeholder.
 *   8. Case Detail — empty-state copy rewrites + SIU rename.
 *   9. Evidence Detail — gates for governance / reviewer-ops /
 *      intelligence / intake-links, plus hero + section renames.
 *
 *   10. Vocabulary sweep — page-level grep over the core self-serve
 *       pages confirming the banned phrases are gone.
 *   11. Hidden-link sweep — page-level grep confirming the core
 *       self-serve pages do NOT render bare hrefs to the hidden
 *       surfaces.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  intakeLinksModel,
  intakeLinksSurface,
} from "./_helpers/intake-links-surface";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

// ============================================================================
// 1. Search — inspector gates
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Search inspector gates", () => {
  const SEARCH = readWeb("app/(app)/search/page.tsx");

  it("computes canSeeWorkflows + canSeeInvestigation gates", () => {
    expect(SEARCH).toMatch(
      /const canSeeWorkflows\s*=\s*enterpriseSurfaces;/,
    );
    expect(SEARCH).toMatch(
      /const canSeeInvestigation\s*=\s*enterpriseSurfaces;/,
    );
  });

  it("passes both gates into the Inspector component", () => {
    expect(SEARCH).toMatch(
      /<Inspector[\s\S]{0,500}canSeeWorkflows=\{canSeeWorkflows\}/,
    );
    expect(SEARCH).toMatch(
      /<Inspector[\s\S]{0,500}canSeeInvestigation=\{canSeeInvestigation\}/,
    );
  });

  it("Inspector function signature declares both new props", () => {
    expect(SEARCH).toMatch(
      /canSeeWorkflows: boolean[\s\S]{0,200}canSeeInvestigation: boolean/,
    );
  });

  it("Workflow pointer link is gated on canSeeWorkflows (self-serve sees the ID without a link)", () => {
    expect(SEARCH).toMatch(
      /canSeeWorkflows \?[\s\S]{0,400}<a[\s\S]{0,200}\/workflows\//,
    );
  });

  it("Investigation pivots section is gated on canSeeInvestigation", () => {
    expect(SEARCH).toMatch(
      /canSeeInvestigation && \(row\.evidenceId \|\| row\.caseId\)[\s\S]{0,200}<Section label="Investigation pivots"/,
    );
  });

  it("renders a 'Related evidence' fallback section for self-serve users with a semantic score", () => {
    expect(SEARCH).toMatch(
      /!canSeeInvestigation &&\s*[\s\S]{0,400}<Section label="Related evidence"/,
    );
  });
});

// ============================================================================
// 2. Trust — Governance card gate — REMOVED 2026-07-15
// The authenticated static Trust Hub (`/trust-hub`, with TRUST_CARDS + the
// surfaceHref/canAccessSurface governance-card gate) was deleted as redundant.
// These hub-only assertions were removed with it. Governance remains reachable
// via its canonical `/governance` home, gated by GOVERNANCE_VIEW.
// ============================================================================

// ============================================================================
// 3. Intake Links — copy rewrites
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Intake Links copy", () => {
  const INTAKE = intakeLinksSurface();
  const MODES = intakeLinksModel("vocabulary.ts");

  it("intake-mode labels stay short and plain (no verbose option sentences)", () => {
    // The dropdown became a radio-card group, so the per-mode explanation is
    // a `description` rendered under each card instead of helper text under a
    // select — always visible rather than only for the selected option. The
    // enum values are unchanged, so the backend payload is identical.
    // The COMPACT labels the row chips show are unchanged word-for-word.
    expect(MODES).toMatch(
      /EXTERNAL_PSEUDONYMOUS:\s*\{[\s\S]{0,120}short:\s*"Alias"/,
    );
    expect(MODES).toMatch(
      /EXTERNAL_ANONYMOUS:\s*\{[\s\S]{0,120}short:\s*"Anonymous"/,
    );
    expect(MODES).toMatch(
      /EXTERNAL_ONE_TIME:\s*\{\s*label:\s*"One-time link"/,
    );
    expect(MODES).toMatch(
      /EXTERNAL_REUSABLE:\s*\{\s*label:\s*"Reusable link"/,
    );
    expect(MODES).toMatch(
      /EXTERNAL_PSEUDONYMOUS:\s*\{\s*label:\s*"Display-name link"/,
    );
    expect(MODES).toMatch(
      /EXTERNAL_ANONYMOUS:\s*\{\s*label:\s*"Anonymous link"/,
    );
    // Negative pins — the old verbose forms must stay gone. These
    // were the strings the original test was protecting against
    // (long, technical-sounding option text).
    expect(INTAKE).not.toMatch(/single contributor, single submission/);
    expect(INTAKE).not.toMatch(/Reusable link \(multiple submissions\)/);
    expect(INTAKE).not.toMatch(/Anonymous — no identity recorded/);
    expect(INTAKE).not.toMatch(
      /Alias — contributor chooses a name to display/,
    );
  });

  it("every intake mode carries a plain-language explanation, rendered on its card", () => {
    // Same intent as before — the operator must understand what each mode
    // does without decoding an enum. The explanation now sits on the choice
    // card itself, so it is visible for EVERY option at once rather than only
    // for the one currently selected.
    for (const mode of [
      "EXTERNAL_ONE_TIME",
      "EXTERNAL_REUSABLE",
      "EXTERNAL_ANONYMOUS",
      "EXTERNAL_PSEUDONYMOUS",
    ]) {
      expect(MODES).toMatch(
        new RegExp(`${mode}:\\s*\\{[\\s\\S]{0,320}description:\\s*\n?\\s*"[^"]{20,}"`),
      );
    }
    // Reuse and contributor identity are ONE backend field, so each option
    // must state BOTH consequences rather than implying two settings.
    expect(MODES).toMatch(/no contributor identity is requested or stored/i);
    expect(MODES).toMatch(/Several people can submit through the same link/i);
    // The description is actually rendered on the card (not merely defined).
    expect(INTAKE).toMatch(/description: INTAKE_MODE_VOCABULARY\[mode\]\.description/);
    expect(INTAKE).toMatch(/testAttr="intake-link-mode"/);
  });

  it("feature-disabled state drops platform-administrator / deployment-runbook jargon", () => {
    expect(INTAKE).not.toMatch(/platform administrator/);
    expect(INTAKE).not.toMatch(/deployment runbook/);
    expect(INTAKE).not.toMatch(/deployment-level configuration/);
  });

  it("feature-disabled state uses plain-language IT-admin guidance", () => {
    expect(INTAKE).toMatch(
      /Contact your IT administrator or your PROOVRA support contact/,
    );
  });

  it("form label is plain-language SMB-friendly ('What are you asking for?')", () => {
    // Intake-links-e2e Phase 1 — the field was relabelled again, from
    // the older "Evidence request form" (still jargon for a non-PROOVRA
    // user) to the question form that mirrors how lawyers and claim
    // handlers actually describe the task. The control still binds the
    // template slug, so the wire contract is unchanged.
    // The field is now a labelled `AppListbox` rather than a native select, so
    // the label is a `<Field label=…>` bound by `htmlFor` and echoed as the
    // control's accessible name. Both are pinned.
    expect(INTAKE).toMatch(/label="What are you asking for\?"/);
    expect(INTAKE).toMatch(/ariaLabel="What are you asking for\?"/);
    expect(INTAKE).not.toMatch(/Workflow template</);
  });
});

// ============================================================================
// 4. Teams — landing + matrix renames
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Teams landing + renames", () => {
  // Phase 3 consolidation: the bare `/teams` landing page was deleted
  // (redirects to /collaboration-teams). The canonical workspace-admin
  // landing is now `app/(app)/workspaces/page.tsx`, which renders
  // `components/workspace-admin/WorkspaceAdministrationHome.tsx`. These
  // checks were repointed to the successor sources; each preserves the
  // original intent (gate, org data source, per-org deep link, billing).
  it("the canonical workspaces landing page exists", () => {
    expect(existsSync(webPath("app/(app)/workspaces/page.tsx"))).toBe(true);
  });

  it("the landing page uses PageRouteGate routeId='admin.teams'", () => {
    const SRC = readWeb("app/(app)/workspaces/page.tsx");
    expect(SRC).toMatch(/<PageRouteGate routeId="admin\.teams">/);
  });

  it("the landing page reads useOrganizations() (no new API fetches)", () => {
    const SRC = readWeb(
      "components/workspace-admin/WorkspaceAdministrationHome.tsx",
    );
    expect(SRC).toMatch(/useOrganizations\(\)/);
  });

  it("the landing page renders a per-org governance deep link", () => {
    const SRC = readWeb(
      "components/workspace-admin/WorkspaceAdministrationHome.tsx",
    );
    expect(SRC).toMatch(/href=\{`\/organizations\/\$\{org\.id\}`\}/);
  });

  it("the landing page shows a billing CTA", () => {
    const SRC = readWeb(
      "components/workspace-admin/WorkspaceAdministrationHome.tsx",
    );
    expect(SRC).toMatch(/href="\/billing"[\s\S]{0,200}(Manage billing|Account billing)/);
  });

  it("TeamPermissionMatrix renamed 'Permission matrix' → 'Who can do what'", () => {
    const SRC = readWeb("app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx");
    expect(SRC).toMatch(/Who can do what/);
    expect(SRC).not.toMatch(/>\s*Permission matrix\s*</);
  });

  it("TeamAccessReviewCard renamed 'Access review' → 'Member roles'", () => {
    const SRC = readWeb("app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx");
    expect(SRC).toMatch(/>\s*Member roles\s*</);
    expect(SRC).not.toMatch(/>\s*Access review\s*</);
  });
});

// ============================================================================
// 5. Billing — copy fixes
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Billing copy", () => {
  const BILLING = readWeb("app/(app)/billing/page.tsx");

  it("'operate shared evidence workflows' is gone", () => {
    expect(BILLING).not.toMatch(/operate shared evidence workflows/i);
  });

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — two assertions retired with
   * the surfaces they described.
   *
   * The "share cases and evidence with collaborators" empty state belonged to a
   * per-workspace card list that no longer exists: the page shows ONE billing
   * account, and an account with no workspaces is not an empty state on Billing
   * — it is simply an account that has not created one.
   *
   * The CheckoutPanel clarification ("PAYG, PRO, and TEAM apply to your personal
   * account… each workspace you own can also have its own TEAM subscription")
   * existed because checkout let the user pick a target and the distinction was
   * genuinely confusing. The drawer has no target picker: the page has already
   * selected the account being bought for, and the drawer names it. There is
   * nothing left to disambiguate.
   *
   * What replaced them is asserted instead: the page names its subject.
   */
  it("the page names the billing account it is showing", () => {
    expect(BILLING).toMatch(/AccountSelector/);
    expect(BILLING).toMatch(/accountFromLocator/);
  });
});

// ============================================================================
// 6. Cases List — terminology
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Cases List terminology", () => {
  const CASES = readWeb("components/cases-experience/CasesIndex.tsx");

  it("heading rewritten in plain language (no persona aliasing, no 'Operations Queue', no kicker duplicate)", () => {
    // Phase CASES-PERSONAL-UX (audit-driven follow-up) — the Cases
    // page header is now plain "Cases" without persona aliasing or
    // a kicker duplicate. The prior `Your {terms.casePlural...}`
    // wording is gone.
    expect(CASES).not.toMatch(/Investigation \{terms\.casePlural\}/);
    expect(CASES).not.toMatch(/Operations Queue/);
    expect(CASES).not.toMatch(/Your \{terms\.casePlural\.toLowerCase\(\)\}/);
    expect(CASES).not.toMatch(/data-cases-kicker/);
    expect(CASES).toMatch(
      /<h1 className="cc-title" data-cases-title>\s*\n?\s*Cases\s*\n?\s*<\/h1>/,
    );
  });

  it("legacy 'Open incidents' / 'Open issues' chip is gone (Phase CASES-PERSONAL-UX-CLEANUP removed the chip strip)", () => {
    // The chip strip was removed per spec — the page now exposes
    // only Search, Status filter, Create case, cards, and count.
    // Both the old enterprise label and the prior personal rename
    // must be absent from the surface.
    expect(CASES).not.toMatch(/label="Open incidents"/);
    expect(CASES).not.toMatch(/label="Open issues"/);
  });

  it("legacy 'Operational filters' / 'Filters' chip-group container is gone (chip strip removed)", () => {
    // The aria-labelled chip group container was deleted along with
    // its chip children — nothing on the personal Cases list needs
    // that container anymore.
    expect(CASES).not.toMatch(/aria-label="Filters"/);
    expect(CASES).not.toMatch(/aria-label="Operational filters"/);
  });
});

// ============================================================================
// 7. Capture — terminology
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Capture terminology", () => {
  const CAPTURE = readWeb("app/(app)/capture/page.tsx");
  const SUMMARY = readWeb("app/(app)/capture/_lib/CaptureOperationalSummary.tsx");

  it("CaptureOperationalSummary aria-label uses 'readiness summary' (not 'operational summary')", () => {
    expect(SUMMARY).toMatch(/Capture readiness summary/);
    expect(SUMMARY).not.toMatch(/Capture operational summary —/);
  });

  it("capture page eyebrow is 'Capture & upload' (not 'Evidence intake workspace')", () => {
    expect(CAPTURE).toMatch(/Capture &amp; upload/);
    expect(CAPTURE).not.toMatch(/>\s*Evidence intake workspace\s*</);
  });

  it("material detail note heading renamed 'Reviewer note' → 'Your notes'", () => {
    expect(CAPTURE).toMatch(/<strong>Your notes<\/strong>/);
    expect(CAPTURE).not.toMatch(/<strong>Reviewer note<\/strong>/);
  });

  it("material detail placeholder is plain language", () => {
    expect(CAPTURE).toMatch(
      /placeholder="Add a note about this material \(private to you\)\."/,
    );
    expect(CAPTURE).not.toMatch(
      /placeholder="Add private reviewer comment for this material\."/,
    );
  });
});

// ============================================================================
// 8. Case Detail — empty-state rewrites
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Case Detail empty states", () => {
  const MATTER = readWeb("components/cases-experience/MatterWorkspace.tsx");

  it("Overview-tab degraded-state copy drops 'command-summary projection' + 'reviewer-ops projection'", () => {
    expect(MATTER).not.toMatch(/command-summary projection/);
    expect(MATTER).not.toMatch(/reviewer-ops projection/);
    expect(MATTER).toMatch(
      /the case summary data may be temporarily unavailable/,
    );
  });

  it("Holds-tab empty state drops 'governance surface' + 'step-up-required' and still says what a hold does", () => {
    expect(MATTER).not.toMatch(/matter's governance surface/);
    expect(MATTER).not.toMatch(/step-up-required for sensitive holds/);
    // PHASE 12 POINT 1 (2026-07-31) — this used to pin the exact sentence
    // "Use the Holds panel to place a legal hold". PHASE 12B CLUSTER 8
    // consolidated placement onto the ONE Legal-Hold surface, so the empty
    // state now links there instead of naming an in-tab panel. The literal
    // was never the contract; the INVARIANT is: plain-language explanation of
    // what a hold does, plus a route to where one is actually placed. That is
    // what is asserted now, so a real copy regression still fails while a
    // deliberate consolidation does not.
    expect(MATTER).toMatch(
      /stop records being deleted or destroyed/,
    );
    expect(MATTER).toMatch(/Manage legal holds/);
    expect(MATTER).toMatch(/\/evidence-lifecycle\/legal-holds/);
  });

  it("Decisions-tab empty state drops 'step-up token' + 'workspace's governance flag'", () => {
    expect(MATTER).not.toMatch(/step-up token/);
    expect(MATTER).not.toMatch(/workspace's governance flag/);
    expect(MATTER).toMatch(
      /may require an additional confirmation step when configured by your team/,
    );
  });

  it("Assignments-tab empty state drops 'per-domain assignment surfaces \\(reviewer-ops, governance\\)'", () => {
    expect(MATTER).not.toMatch(
      /per-domain assignment surfaces \(reviewer-ops, governance\)/,
    );
    expect(MATTER).toMatch(/Assign teammate/);
  });

  it("SIU tab label is now 'Investigation profile' (id stays 'siu' for backward compat)", () => {
    expect(MATTER).toMatch(/id:\s*"siu",\s*[\s\S]{0,300}label:\s*"Investigation profile"/);
  });
});

// ============================================================================
// 9. Evidence Detail — gates + renames
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — Evidence Detail gates", () => {
  // Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
  // concatenate the orchestrator + every tab body so source-shape
  // assertions still find the relevant snippets.
  const EVI = [
    "app/(app)/evidence/[id]/page.tsx",
    "app/(app)/evidence/[id]/_tabs/_lib.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx",
    "app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx",
  ].map(readWeb).join("\n\n");

  it("consumes the SERVER-projection gate hooks (no client tier computation)", () => {
    // PHASE 12B Track 1A — enterprise gates come from useEnterpriseSurfaceAccess
    // (envelope.flags), commercial gates from usePlanFeatureGate (planFeatures).
    expect(EVI).toMatch(/useEnterpriseSurfaceAccess/);
    expect(EVI).toMatch(/usePlanFeatureGate/);
  });

  it("computes all four surface gates from server projections", () => {
    expect(EVI).toMatch(/const canSeeReviewerOps\s*=\s*enterpriseSurfaces;/);
    expect(EVI).toMatch(/const canSeeGovernance\s*=\s*enterpriseSurfaces;/);
    expect(EVI).toMatch(/const canSeeIntelligence\s*=\s*enterpriseSurfaces;/);
    expect(EVI).toMatch(/const canSeeIntakeLinks\s*=\s*usePlanFeatureGate\("intakeIncluded"\);/);
  });

  it("Governance trio is gated by canSeeGovernance", () => {
    expect(EVI).toMatch(
      /\{canSeeGovernance \?\s*\(\s*<>[\s\S]{0,500}<GovernanceSummary variant="evidence"/,
    );
    expect(EVI).toMatch(
      /canSeeGovernance[\s\S]{0,1000}<GovernanceIndicators/,
    );
    expect(EVI).toMatch(
      /canSeeGovernance[\s\S]{0,1500}<GovernanceSnapshotPanel/,
    );
  });

  it("EvidenceRequestPanel is gated by canSeeIntakeLinks", () => {
    expect(EVI).toMatch(
      /\{canSeeIntakeLinks \?\s*\(\s*<EvidenceRequestPanel/,
    );
  });

  it("OperationalTimelinePanel is gated by canSeeReviewerOps", () => {
    expect(EVI).toMatch(
      /canSeeReviewerOps && workspace\.reviewWorkflow\?\.teamId[\s\S]{0,200}<OperationalTimelinePanel/,
    );
  });

  it("ReviewerWorkflowCard + EvidenceReviewActionsPanel are gated by canSeeReviewerOps", () => {
    // Phase REVIEW-TAB-STABILITY — the Review tab now renders the
    // workflow card in the always-on top slot (gated on
    // canSeeReviewerOps), and the actions panel separately (also
    // gated). Status changes never swap the layout.
    expect(EVI).toMatch(
      /canSeeReviewerOps \?\s*\(\s*\n?\s*<ReviewerWorkflowCard/,
    );
    expect(EVI).toMatch(
      /canSeeReviewerOps[\s\S]{0,2000}<EvidenceReviewActionsPanel/,
    );
  });

  it("self-serve users see a simplified 'Review status' section instead of the workflow machinery", () => {
    // Phase REVIEW-TAB-STABILITY — the legacy
    // `data-self-serve-review-status` attribute was replaced by the
    // canonical `data-evidence-section="review-status"` so every
    // tab section follows the same data-attr pattern.
    expect(EVI).toMatch(/data-evidence-section="review-status"/);
    // The status section became the Review HERO: the reviewer state is now
    // the heading itself (formatReviewerStatusLabel) rather than a card
    // titled "Review status". The guarantee — self-serve sees the simplified
    // status surface, not the workflow machinery — is unchanged, and the
    // canonical disclaimer still travels with it.
    expect(EVI).toMatch(/formatReviewerStatusLabel\(reviewerStatus\)/);
    expect(EVI).toMatch(/data-evidence-reviewer-disclaimer="true"/);
  });

  it("Intelligence section is gated by canSeeIntelligence", () => {
    // The section kept its gate; only the heading treatment changed — the
    // kicker/icon SectionHeading became a plain canonical section title, and
    // the copy is now "Entities and content summaries". The gate is the
    // contract this test exists for.
    expect(EVI).toMatch(
      /\{canSeeIntelligence \?\s*[\s\S]{0,500}<section className="evidence-detail-section"[\s\S]{0,800}Entities and content summaries/,
    );
  });

  it("Intelligence empty-state copy drops the 'Phase 11 OCR and transcript wiring' leak", () => {
    expect(EVI).not.toMatch(/Phase 11 OCR and transcript wiring/);
  });

  it("hero eyebrow renamed from 'Evidence Review & Defensibility Workspace' to 'Evidence record'", () => {
    expect(EVI).not.toMatch(/Evidence Review &amp; Defensibility Workspace/);
    expect(EVI).toMatch(
      /<p className="evidence-detail-kicker">Evidence record<\/p>/,
    );
  });

  it("error-card eyebrow no longer says 'Evidence Review Workspace'", () => {
    expect(EVI).not.toMatch(/>\s*Evidence Review Workspace\s*</);
  });

  it("review-tab notes section heading renamed away from 'Reviewer Collaboration'", () => {
    expect(EVI).not.toMatch(/Notes &amp; Reviewer Collaboration/);
    expect(EVI).toMatch(/title="Private notes &amp; annotations"/);
  });
});

// ============================================================================
// 10. Vocabulary sweep — banned phrases removed from the core pages
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — banned-phrase sweep", () => {
  // Phrases that should NOT appear in ANY of the core self-serve page
  // files after this phase. Each tuple is (label, regex, files).
  const BANNED: Array<[string, RegExp, string[]]> = [
    [
      "operate shared evidence workflows",
      /operate shared evidence workflows/i,
      ["app/(app)/billing/page.tsx"],
    ],
    [
      "platform administrator (Intake feature-disabled)",
      /platform administrator/,
      ["app/(app)/intake-links/page.tsx"],
    ],
    [
      "Pseudonymous (Intake mode label)",
      /Pseudonymous — contributor chooses an alias/,
      ["app/(app)/intake-links/page.tsx"],
    ],
    [
      "Cases List 'Operations Queue'",
      /Operations Queue/,
      ["components/cases-experience/CasesIndex.tsx"],
    ],
    [
      "Cases List 'Open incidents' filter",
      /label="Open incidents"/,
      ["components/cases-experience/CasesIndex.tsx"],
    ],
    [
      "Capture 'Evidence intake workspace' eyebrow",
      />\s*Evidence intake workspace\s*</,
      ["app/(app)/capture/page.tsx"],
    ],
    [
      "Capture 'Reviewer note' heading",
      /<strong>Reviewer note<\/strong>/,
      ["app/(app)/capture/page.tsx"],
    ],
    [
      "Case Detail 'step-up token'",
      /step-up token/,
      ["components/cases-experience/MatterWorkspace.tsx"],
    ],
    [
      "Case Detail 'reviewer-ops projection'",
      /reviewer-ops projection/,
      ["components/cases-experience/MatterWorkspace.tsx"],
    ],
    [
      "Evidence Detail 'Evidence Review & Defensibility Workspace'",
      /Evidence Review &amp; Defensibility Workspace/,
      ["app/(app)/evidence/[id]/page.tsx"],
    ],
    [
      "Evidence Detail 'Notes & Reviewer Collaboration'",
      /Notes &amp; Reviewer Collaboration/,
      ["app/(app)/evidence/[id]/page.tsx"],
    ],
    // (The Trust Hub 'Lifecycle orchestrator state' banned-copy check was
    // removed 2026-07-15 with the deletion of the authenticated Trust Hub.)
  ];

  for (const [label, re, files] of BANNED) {
    for (const f of files) {
      it(`${f} must not contain: ${label}`, () => {
        const src = readWeb(f);
        expect(src).not.toMatch(re);
      });
    }
  }
});

// ============================================================================
// 11. Hidden-link sweep — none of the core self-serve pages render a bare
//     href to a hidden ENTERPRISE surface (links are either absent, or
//     wrapped in an explicit canAccessSurface gate).
// ============================================================================

describe("Phase IA-self-serve-audit-fixes — hidden-link sweep", () => {
  // Pages that should NOT contain UNGATED hrefs to a hidden surface.
  // We check each href appears either inside a canAccessSurface
  // expression (via a literal "canSee" identifier near the href) OR
  // not at all. The bookkeeping for "near a canSee gate" is
  // approximated by allowing the href only when the file also
  // declares the matching canSee constant — Search and Evidence Detail
  // both fall in this bucket.
  type Check = { page: string; href: string; allowedIfGate: string | null };

  const CHECKS: Check[] = [
    // Settings tree — was already gated this session
    { page: "app/(app)/settings/page.tsx", href: "/security-center", allowedIfGate: "canSeeWorkspaceSecurity" },
    { page: "app/(app)/settings/page.tsx", href: "/security-center", allowedIfGate: "canSeeWorkspaceSecurity" },
    // Search — gated this phase
    { page: "app/(app)/search/page.tsx", href: "/workflows/", allowedIfGate: "canSeeWorkflows" },
    { page: "app/(app)/search/page.tsx", href: "/investigation/", allowedIfGate: "canSeeInvestigation" },
    { page: "app/(app)/search/page.tsx", href: "/integrations", allowedIfGate: "canSeeIntegrations" },
    // (Trust Hub governance-card hidden-link check removed 2026-07-15 with
    // the deletion of the authenticated Trust Hub.)
    // Billing — no hidden hrefs at all
    { page: "app/(app)/billing/page.tsx", href: "/workflows", allowedIfGate: null },
    { page: "app/(app)/billing/page.tsx", href: "/governance", allowedIfGate: null },
  ];

  for (const c of CHECKS) {
    it(`${c.page} ${c.allowedIfGate ? `references ${c.href} only under ${c.allowedIfGate}` : `does NOT reference ${c.href}`}`, () => {
      const src = readWeb(c.page);
      const safe = c.href.replace(/\//g, "\\/");
      const re = new RegExp(`href=["'\`\\{][^"'\\\`\\}]*${safe}`);
      const hasHref = re.test(src);
      if (!c.allowedIfGate) {
        expect(hasHref, `${c.page} must not link to ${c.href}`).toBe(false);
      } else if (hasHref) {
        expect(
          src,
          `${c.page} links to ${c.href} but does not also reference the ${c.allowedIfGate} gate`,
        ).toMatch(new RegExp(c.allowedIfGate));
      } else {
        // If the file no longer references the href at all, that's
        // also fine — the audit just wants no UNGATED reference.
        expect(true).toBe(true);
      }
    });
  }
});
