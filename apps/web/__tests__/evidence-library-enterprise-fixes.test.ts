/**
 * Phase EVIDENCE-LIBRARY-ENTERPRISE-FIXES — acceptance lock for the
 * 7 surgical fixes applied after the operations-workspace redesign
 * was rolled back. Each test pins a single behaviour by regex
 * against the source so a future refactor cannot silently regress
 * any one fix.
 *
 *   FIX 1 — title cascade. `getDisplayTitle` substitutes the
 *           backend "Digital Evidence Record" sentinel with the
 *           displayFileName → originalFileName → multipart →
 *           type+shortId → "Evidence record {id}" chain.
 *
 *   FIX 2 — preview surfaces extra operational info. The queue
 *           selection preview now renders verification-status +
 *           item-count next to the existing status/type/case rows
 *           WITHOUT redesigning the panel.
 *
 *   FIX 3 — duplicate detection cleanup. (Already source-pinned by
 *           the prior `evidence-detail-cleanup-pass` test; we add a
 *           cross-check here that the title cascade is the SAME
 *           cascade DuplicateDetectionPanel uses, so the panel
 *           inherits the FIX 1 fallback.)
 *
 *   FIX 4 — ComparisonPanel raw key/value grid lives behind a
 *           `<details data-comparison-technical-details>`
 *           disclosure with a `summariseGroup()` one-liner up
 *           front. Data is preserved, just one click deeper.
 *
 *   FIX 5 — AiCategorizationPanel renders the legal disclaimer
 *           exactly ONCE. The DISABLED-state paragraph and the
 *           "Legal boundary" duplicate card are gone.
 *
 *   FIX 6 — Reviewer/legal/annotation enterprise panels and the
 *           preview's reviewer-assignment + due-date rows are
 *           gated on `canSeeReviewerOps`. Personal Space hides
 *           them entirely; backend authorization is unchanged.
 *
 *   FIX 7 — Data-accuracy fixes from the prior pass remain in
 *           place. Re-asserted here so a reviewer running ONLY
 *           this file gets the full enterprise-fixes contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const STATUS_LIB = src("apps/web/app/(app)/evidence/lib/evidence-library-status.ts");
const COMPARISON_PANEL = src("apps/web/app/(app)/evidence/components/ComparisonPanel.tsx");
const AI_PANEL = src("apps/web/app/(app)/evidence/components/AiCategorizationPanel.tsx");
const QUEUE_PREVIEW = src("apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx");
const REVIEW_TAB = src("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx");
const PAGE = src("apps/web/app/(app)/evidence/page.tsx");
const ROUTES = src("services/api/src/routes/evidence.routes.ts");
const DUPLICATE_PANEL = src("apps/web/app/(app)/evidence/components/DuplicateDetectionPanel.tsx");

// ===========================================================================
// FIX 1 — Title cascade substitutes "Digital Evidence Record" sentinel
// ===========================================================================

test("FIX 1 — GENERIC_TITLE_SENTINELS lists every legacy backend fallback", () => {
  assert.match(
    STATUS_LIB,
    /GENERIC_TITLE_SENTINELS\s*=\s*new\s+Set<string>\(\s*\[\s*\n?\s*"Digital Evidence Record",\s*\n?\s*"Evidence record",\s*\n?\s*"Untitled evidence record",/,
  );
});

test("FIX 1 — isGenericFallbackTitle treats null/empty AND sentinel strings as 'no title set'", () => {
  assert.match(
    STATUS_LIB,
    /function isGenericFallbackTitle\(value: string \| null \| undefined\): boolean \{\s*\n?\s*const trimmed = value\?\.trim\(\);\s*\n?\s*return !trimmed \|\| GENERIC_TITLE_SENTINELS\.has\(trimmed\);/,
  );
});

test("FIX 1 — getDisplayTitle short-circuits the user title only when non-sentinel", () => {
  assert.match(
    STATUS_LIB,
    /const direct = item\.title\?\.trim\(\);\s*\n?\s*if \(direct && !isGenericFallbackTitle\(direct\)\) return direct;/,
  );
});

test("FIX 1 — getDisplayTitle cascade order is title → displayFileName/originalFileName → multipart → type+shortId → 'Evidence record {id}'", () => {
  assert.match(
    STATUS_LIB,
    /const fileLabel = item\.displayFileName\?\.trim\(\) \|\| item\.originalFileName\?\.trim\(\);\s*\n?\s*if \(fileLabel\) return fileLabel;\s*\n?\s*const multipart = buildMultipartPackageLabel\(item\);\s*\n?\s*if \(multipart\) return multipart;[\s\S]{0,400}?return id \? `Evidence record \$\{id\.slice\(0, 8\)\}` : "Evidence record";/,
  );
});

// ===========================================================================
// FIX 2 — Preview surfaces verification status + item count
// ===========================================================================

test("FIX 2 — QueueSelectionPreview imports getVerificationStatusLabel from the shared status lib", () => {
  assert.match(
    QUEUE_PREVIEW,
    /import \{\s*\n?\s*getDisplayTitle,\s*\n?\s*getEvidenceTypeLabel,\s*\n?\s*getRecordStatusLabel,\s*\n?\s*getVerificationStatusLabel,\s*\n?\s*\} from "\.\.\/lib\/evidence-library-status";/,
  );
});

test("FIX 2 — QueueSelectionPreview renders the integrity line under Status with a stable data attribute", () => {
  assert.match(
    QUEUE_PREVIEW,
    /<p data-preview-integrity>\{getVerificationStatusLabel\(item\.verificationStatus\)\}<\/p>/,
  );
});

test("FIX 2 — Multipart records surface their item count next to the type label", () => {
  assert.match(
    QUEUE_PREVIEW,
    /\{getEvidenceTypeLabel\(item\)\}\s*\n?\s*\{item\.itemCount > 1 \? ` · \$\{item\.itemCount\} items` : ""\}/,
  );
});

// ===========================================================================
// FIX 3 — DuplicateDetectionPanel inherits the FIX 1 title cascade
// ===========================================================================

test("FIX 3 — DuplicateDetectionPanel skips the legacy 'Digital Evidence Record' sentinel in its title cascade", () => {
  assert.match(DUPLICATE_PANEL, /chooseDisplayTitle/);
  // The cascade MUST treat the legacy backend stamp as "no title
  // set" instead of rendering it verbatim. We assert the sentinel
  // guard exists in the cascade rather than asserting absence of
  // the string (the guard literal itself contains the string).
  assert.match(
    DUPLICATE_PANEL,
    /if \(t && t !== "Digital Evidence Record"\) return t;/,
  );
});

// ===========================================================================
// FIX 4 — Comparison raw payloads behind a Technical-details disclosure
// ===========================================================================

test("FIX 4 — ComparisonPanel exposes a summariseGroup helper that produces a short one-liner", () => {
  assert.match(COMPARISON_PANEL, /function summariseGroup\(/);
  assert.match(COMPARISON_PANEL, /fragments\.push\(`SHA-256 \$\{String\(sha256\)\.slice\(0, 8\)\}…`\)/);
});

test("FIX 4 — Raw key/value grid is wrapped in <details data-comparison-technical-details> with a 'Technical details' summary", () => {
  assert.match(
    COMPARISON_PANEL,
    /<details data-comparison-technical-details>\s*\n?\s*<summary[\s\S]{0,300}?>\s*\n?\s*Technical details\s*\n?\s*<\/summary>/,
  );
});

test("FIX 4 — The summary line still renders BEFORE the disclosure so reviewers see context without expanding", () => {
  const cardBlock = COMPARISON_PANEL.slice(
    COMPARISON_PANEL.indexOf("function renderGroup("),
    COMPARISON_PANEL.indexOf("function renderGroup(") + 1500,
  );
  const summaryIdx = cardBlock.indexOf("summariseGroup(group)");
  const detailsIdx = cardBlock.indexOf("data-comparison-technical-details");
  assert.ok(summaryIdx > 0, "summariseGroup call must render in the card");
  assert.ok(detailsIdx > summaryIdx, "Technical-details disclosure must follow the summary line");
});

// ===========================================================================
// FIX 5 — AiCategorizationPanel renders the legal disclaimer ONCE
// ===========================================================================

test("FIX 5 — Canonical inline AI disclaimer still sits at the top of the panel", () => {
  assert.match(
    AI_PANEL,
    /AI categorization is advisory and metadata-only\. It does not determine factual truth, authorship,\s*\n?\s*integrity, or legal outcome\./,
  );
});

test("FIX 5 — The legacy 'Legal boundary' duplicate card is gone", () => {
  // The duplicate card used to render `<strong>Legal boundary</strong>`
  // inside the result grid. Source must no longer contain that node.
  assert.doesNotMatch(AI_PANEL, /<strong>Legal boundary<\/strong>/);
});

test("FIX 5 — The DISABLED-state path no longer re-renders data.legalDisclaimer", () => {
  // Strip JS line/block comments before matching so the
  // explanatory comment in the source ("we used to repeat the
  // backend-stamped `data.legalDisclaimer` here too") does not
  // trip the absence assertion.
  const stripped = AI_PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const disabledBlock = stripped.slice(
    stripped.indexOf('data?.status === "DISABLED"'),
    stripped.indexOf('data?.status === "DISABLED"') + 800,
  );
  assert.doesNotMatch(disabledBlock, /data\.legalDisclaimer/);
  assert.match(disabledBlock, /AI categorization is not active for this record\./);
});

// ===========================================================================
// FIX 6 — Reviewer-ops gating on preview + review tab
// ===========================================================================

test("FIX 6 — QueueSelectionPreview accepts the canSeeReviewerOps prop with a back-compat default", () => {
  assert.match(QUEUE_PREVIEW, /canSeeReviewerOps\?:\s*boolean;/);
  assert.match(QUEUE_PREVIEW, /canSeeReviewerOps = true,/);
});

test("FIX 6 — Preview's reviewer-assignment row is gated on canSeeReviewerOps", () => {
  assert.match(
    QUEUE_PREVIEW,
    /\{canSeeReviewerOps \? \(\s*\n?\s*<p data-preview-assigned-reviewer>/,
  );
});

test("FIX 6 — Preview's due-date row is gated on canSeeReviewerOps", () => {
  assert.match(
    QUEUE_PREVIEW,
    /\{canSeeReviewerOps \? \(\s*\n?\s*<p data-preview-due-date>/,
  );
});

test("FIX 6 — Evidence Library page computes canSeeReviewerOps via canAccessSurface and passes it down", () => {
  assert.match(PAGE, /import \{ canAccessSurface \} from/);
  assert.match(PAGE, /import \{ useSurfaceUserContext \} from/);
  assert.match(
    PAGE,
    /const canSeeReviewerOps = canAccessSurface\(surfaceUserCtx, "\/reviewer-ops"\);/,
  );
  assert.match(PAGE, /canSeeReviewerOps=\{canSeeReviewerOps\}/);
});

test("FIX 6 — EvidenceReviewTab gates ReviewerComments/LegalNotes/Annotation panels behind canSeeReviewerOps", () => {
  // The three mounts MUST sit inside the canSeeReviewerOps branch.
  const gateBlock = REVIEW_TAB.slice(
    REVIEW_TAB.indexOf("data-evidence-review-enterprise-panels"),
    REVIEW_TAB.indexOf("data-evidence-review-enterprise-panels") + 1500,
  );
  assert.match(gateBlock, /<ReviewerCommentsPanel evidenceId=\{evidence\.id\} \/>/);
  assert.match(gateBlock, /<LegalNotesPanel evidenceId=\{evidence\.id\} \/>/);
  assert.match(gateBlock, /<AnnotationPanel evidenceId=\{evidence\.id\}/);
  // The wrapping conditional must be on canSeeReviewerOps.
  assert.match(
    REVIEW_TAB,
    /\{canSeeReviewerOps \? \(\s*\n?\s*<div\s*\n?\s*className="evidence-detail-embedded-panels"\s*\n?\s*data-evidence-review-enterprise-panels/,
  );
});

test("FIX 6 — Governance descriptor is gated on canSeeReviewerOps (it describes the hidden panels)", () => {
  assert.match(
    REVIEW_TAB,
    /\{workspace\.governance && canSeeReviewerOps \? \(/,
  );
});

// ===========================================================================
// FIX 7 — Data-accuracy fixes from the prior pass remain in place
// ===========================================================================

test("FIX 7 — Backend GET /v1/evidence/library-summary endpoint still exists", () => {
  assert.match(
    ROUTES,
    /app\.get\(\s*\n?\s*"\/v1\/evidence\/library-summary"/,
  );
});

test("FIX 7 — Real package readiness predicate (verificationPackages.some, NOT latestReportVersion) is intact", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(
    body,
    /PACKAGES_READY_PREDICATE[\s\S]{0,400}verificationPackages:\s*\{\s*some:\s*\{\s*\}\s*\}/,
  );
  const packagesPredicateBlock = body.slice(
    body.indexOf("PACKAGES_READY_PREDICATE"),
    body.indexOf("PACKAGES_READY_PREDICATE") + 400,
  );
  assert.doesNotMatch(packagesPredicateBlock, /latestReportVersion/);
});

test("FIX 7 — Workspace-total label discipline is intact", () => {
  assert.match(PAGE, /workspaceScopeDetail\s*=\s*`Workspace total · \$\{filters\.scope\}`/);
  assert.match(PAGE, /pageScopeDetail\s*=\s*"On this page"/);
});

// ===========================================================================
// Regression — none of the hard-rule violations come back
// ===========================================================================

test("HARD RULE — no quick-filter chip strip / clickable KPI cards re-introduced", () => {
  assert.doesNotMatch(PAGE, /EvidenceQuickFilters/);
  assert.doesNotMatch(PAGE, /onApplyQuickFilter/);
  assert.doesNotMatch(PAGE, /applyQuickFilter/);
});

test("HARD RULE — existing filters / saved views / bulk selection / EvidenceMetrics still mount", () => {
  assert.match(PAGE, /<EvidenceFilters/);
  assert.match(PAGE, /<SavedViewsMenu/);
  assert.match(PAGE, /<BulkActionsToolbar/);
  assert.match(PAGE, /<EvidenceMetrics items=\{metrics\}/);
});
