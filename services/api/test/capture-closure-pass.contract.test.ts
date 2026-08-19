/**
 * Phase CAPTURE-CLOSURE — contract locks for the five closure fixes.
 *
 * Each part below has a tightly-scoped source-level test so a future
 * refactor that drops the fix (or reverts to the broken behaviour)
 * fails CI loudly with an actionable message.
 *
 *   Part A — Plan-gated polling MUST stop when reportsIncluded=false
 *            AND the Artifacts tab MUST render an honest banner.
 *   Part B — Donut title is "Records by type" with subtitle clarifying
 *            primary-type semantics.
 *   Part C — Sidebar dropped the duplicate "Technical Review Readiness"
 *            card; the Public Verification block is the compact
 *            shortcut variant, not the full KeyValueGrid.
 *   Part D — CaptureAiAssistant carries an explicit "AI advisory is
 *            not saved" disclaimer.
 *   Part E — Capture material card has an item-level sourceLabel
 *            input that calls updateSessionItem.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
// concatenate the orchestrator + every tab body so source-shape
// assertions still find the relevant snippets.
const PAGE = [
  "page.tsx",
  "_tabs/_lib.tsx",
  "_tabs/EvidenceOverviewTab.tsx",
  "_tabs/EvidenceIntegrityTab.tsx",
  "_tabs/EvidenceCustodyTab.tsx",
  "_tabs/EvidenceReviewTab.tsx",
  "_tabs/EvidenceArtifactsTab.tsx",
  "_tabs/EvidenceDiscussionTab.tsx",
  "_tabs/EvidenceTechnicalAppendixTab.tsx",
  // The redesign extracted three single-responsibility surfaces out of the
  // orchestrator and the appendix tab. They are part of the same page body,
  // so source-shape assertions must keep seeing them.
  "_tabs/EvidenceRecordRail.tsx",
  "_tabs/technical-appendix/TrustDecisionSummary.tsx",
  "_tabs/technical-appendix/TechnicalDisclosure.tsx",
]
  .map((rel) =>
    readFileSync(
      resolve(REPO_ROOT, "apps", "web", "app", "(app)", "evidence", "[id]", rel),
      "utf8",
    ),
  )
  .join("\n\n");
const HOME_DASH = readFileSync(
  resolve(REPO_ROOT, "apps", "web", "components", "home-experience", "HomeDashboardSections.tsx"),
  "utf8",
);
const AI = readFileSync(
  resolve(REPO_ROOT, "apps", "web", "components", "ai", "CaptureAiAssistant.tsx"),
  "utf8",
);
const CAPTURE_PAGE = readFileSync(
  resolve(REPO_ROOT, "apps", "web", "app", "(app)", "capture", "page.tsx"),
  "utf8",
);

describe("Part A — Plan-gated report polling + banner", () => {
  it("shouldPollArtifactReadiness consults workspaceCapabilitySnapshot.reportsIncluded", () => {
    expect(PAGE).toMatch(/const caps\s*=\s*workspace\.workspaceCapabilitySnapshot/);
    expect(PAGE).toMatch(/const reportReachable\s*=\s*\n?\s*caps\?\.reportsIncluded\s*!==\s*false/);
    expect(PAGE).toMatch(
      /const packageReachable\s*=\s*\n?\s*caps\?\.verificationPackageIncluded\s*!==\s*false/,
    );
  });

  it("polling does not return true when plan denies reports AND artifact is unavailable", () => {
    // The combined condition stops the loop; the source-level assertion
    // proves it's gated on the plan caps (avoids endless polling).
    expect(PAGE).toMatch(
      /reportReachable\s*&&\s*!workspace\.artifactStatus\.report\.available/,
    );
  });

  it("Artifacts tab renders the plan-gated banner when reportsIncluded=false", () => {
    expect(PAGE).toMatch(/data-evidence-section="reports-plan-gated"/);
    expect(PAGE).toMatch(/Reports are not included in this plan/);
    // No fake upgrade CTA: the banner must be informational only.
    expect(PAGE).not.toMatch(
      /data-evidence-section="reports-plan-gated"[\s\S]{0,400}?Upgrade now/i,
    );
  });
});

describe("Part B — Donut renamed + truthful subtitle", () => {
  it("title is 'Records by type' (no longer 'Evidence by type')", () => {
    // Read the specific home card; the title literal is the change.
    expect(HOME_DASH).toMatch(/data-self-serve-section="evidence-types"[\s\S]{0,600}?Records by type/);
    // Make sure the old wording is gone from this specific card.
    expect(HOME_DASH).not.toMatch(
      /data-self-serve-section="evidence-types"[\s\S]{0,300}?Evidence by type/,
    );
  });

  it("subtitle reads 'by primary type' so the record-level contract is explicit", () => {
    expect(HOME_DASH).toMatch(/by primary type/);
    expect(HOME_DASH).toMatch(/data-evidence-types-subtitle/);
  });

  it("hover title attribute documents that the count is records-not-files", () => {
    // Phase HOME-RECORDS-BY-TYPE — the title is now a dynamic
    // expression `title={subtitleTitle}` (records vs preserved-files
    // mode), but the records-mode copy literal is still load-bearing
    // and must remain in source so the records view stays honest.
    expect(HOME_DASH).toMatch(/title=\{subtitleTitle\}/);
    expect(HOME_DASH).toMatch(
      /"Counts primary evidence records, not files inside packages\."/,
    );
  });
});

describe("Part C — Sidebar dedup", () => {
  it("sidebar carries the status-and-next-action data hook", () => {
    expect(PAGE).toMatch(/data-evidence-sidebar="status-and-next-action"/);
  });

  it("kept: risk-signals block + operational-summary block + public-verification-shortcut", () => {
    expect(PAGE).toMatch(/data-evidence-side="risk-signals"/);
    expect(PAGE).toMatch(/data-evidence-side="operational-summary"/);
    expect(PAGE).toMatch(/data-evidence-side="public-verification-shortcut"/);
  });

  it("dropped: the duplicate 'Technical Review Readiness' SECTION inside the sidebar", () => {
    // The technicalReadinessSummary string still exists (it's used on
    // other surfaces); what was dropped is the dedicated sidebar
    // block that rendered ONLY that single sentence. We grep for the
    // structural marker: a side-block whose only body was {technicalReadinessSummary}.
    expect(PAGE).not.toMatch(
      /<aside className="evidence-detail-sidebar"[^>]*>\s*<section className="evidence-detail-side-block">\s*<SectionHeading\s*\n\s*kicker="Technical Review Readiness"/,
    );
  });

  it("Public Verification side-block is the compact shortcut shape (no full KeyValueGrid duplication)", () => {
    // The shortcut variant uses the section's SectionHeading title as
    // the publication state. The previous variant rendered a full
    // KeyValueGrid for status/state-detail/views/downloads.
    const block = PAGE.match(
      /data-evidence-side="public-verification-shortcut"[\s\S]{0,2000}?<\/section>/,
    );
    expect(block, "public-verification-shortcut block exists").toBeTruthy();
    // No KeyValueGrid inside the compact shortcut.
    expect(block![0]).not.toMatch(/<KeyValueGrid/);
  });
});

describe("Part D — AI advisor transient disclaimer", () => {
  it("CaptureAiAssistant renders 'AI advisory is not saved' inside the dialog", () => {
    expect(AI).toMatch(/data-capture-ai-transience/);
    expect(AI).toMatch(/AI advisory is not saved/);
  });

  it("disclaimer documents the privacy stance: metadata only, uploads never sent", () => {
    expect(AI).toMatch(/session\s*\n?\s*metadata only \(uploaded contents are never\s*\n?\s*sent\)/);
  });
});

describe("Part E — Capture item sourceLabel input", () => {
  it("capture material card has a sourceLabel input bound to updateSessionItem", () => {
    expect(CAPTURE_PAGE).toMatch(/data-capture-item-source-label/);
    expect(CAPTURE_PAGE).toMatch(/sourceLabel:\s*event\.target\.value/);
  });

  it("input is maxLength=120 (matches Prisma schema VarChar(120))", () => {
    const block = CAPTURE_PAGE.match(
      /data-capture-item-source-label[\s\S]{0,800}?maxLength=\{120\}/,
    );
    expect(block, "sourceLabel input must enforce 120-char cap to match EvidencePart.sourceLabel column").toBeTruthy();
  });

  it("disclaimer text clarifies the field is NOT in public verify / report", () => {
    expect(CAPTURE_PAGE).toMatch(
      /data-capture-item-source-label[\s\S]{0,2000}?Not included in the public verification page or report/,
    );
  });
});
