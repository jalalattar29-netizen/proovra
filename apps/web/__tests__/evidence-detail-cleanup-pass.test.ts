/**
 * Phase EVIDENCE-CLEANUP-PASS — acceptance lock for the four
 * targeted post-refactor fixes:
 *
 *   Fix 1 — Duplicate Detection
 *     Backend returns a deduped, grouped `groupedMatches[]` view
 *     (per-record, with combined match reasons + matchedPartsCount)
 *     in addition to the legacy four arrays. UI consumes the
 *     grouped view + runs the title cascade
 *     (rawTitle → displayFileName → originalFileName → type → shortId).
 *     The literal "Digital Evidence Record" fallback string never
 *     appears as a JSX text/label in the panel.
 *
 *   Fix 2 — Mismatch Flags
 *     The "Mismatch flags" card in ComparisonPanel is hidden when
 *     every flag value is null/undefined. Raw field names are not
 *     surfaced to normal users.
 *
 *   Fix 3 — Trust Decision
 *     The Technical Appendix renders a structured
 *     TrustDecisionSummary (verdict / score / per-signal rows) by
 *     default. The raw JSON dump is gated behind `?debug=1` and
 *     hidden from production UI.
 *
 *   Fix 4 — AI Categorization
 *     One canonical `<AiCategorizationPanel>`. The prior wrapper +
 *     hidden-feature card mount on the Review tab are gone. One
 *     disclaimer, one mount.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(__dirname, "../app/(app)/evidence");
const DETAIL_DIR = resolve(EVIDENCE_DIR, "[id]");
const COMPONENTS_DIR = resolve(EVIDENCE_DIR, "components");

function src(rel: string, base: string = DETAIL_DIR): string {
  return readFileSync(resolve(base, rel), "utf8");
}

const REVIEW_TAB = src("_tabs/EvidenceReviewTab.tsx");
const APPENDIX_TAB = src("_tabs/EvidenceTechnicalAppendixTab.tsx");
// The decision presentation moved into its own responsibility file; the tab
// orchestrates and mounts it. Assertions about the decision now read the file
// that owns it.
const DECISION = src("_tabs/technical-appendix/TrustDecisionSummary.tsx");
const DUPLICATES_PANEL = readFileSync(
  resolve(COMPONENTS_DIR, "DuplicateDetectionPanel.tsx"),
  "utf8",
);
const COMPARISON_PANEL = readFileSync(
  resolve(COMPONENTS_DIR, "ComparisonPanel.tsx"),
  "utf8",
);
const AI_PANEL = readFileSync(
  resolve(COMPONENTS_DIR, "AiCategorizationPanel.tsx"),
  "utf8",
);
const LIB_TYPES = readFileSync(
  resolve(EVIDENCE_DIR, "lib/evidence-library-types.ts"),
  "utf8",
);
const EVIDENCE_ROUTES = readFileSync(
  resolve(__dirname, "../../../services/api/src/routes/evidence.routes.ts"),
  "utf8",
);

// ===========================================================================
// Fix 1 — Duplicate Detection
// ===========================================================================

test("Fix 1 — backend duplicates response carries the grouped, deduped view", () => {
  // The grouped view is the load-bearing field — UI consumes it
  // and runs the title cascade. The legacy four arrays stay for
  // back-compat.
  assert.match(EVIDENCE_ROUTES, /groupedMatches,\s*\n?\s*totalRecords:/);
  assert.match(EVIDENCE_ROUTES, /addToGroup\(exactHashMatches,\s*"exact_hash"\)/);
  assert.match(EVIDENCE_ROUTES, /addToGroup\(fingerprintMatches,\s*"fingerprint"\)/);
  assert.match(EVIDENCE_ROUTES, /addToGroup\(partHashMatches,\s*"part_hash"\)/);
  assert.match(EVIDENCE_ROUTES, /addToGroup\(possibleMetadataMatches,\s*"metadata"\)/);
});

test("Fix 1 — backend returns rawTitle (unsubstituted) so the UI cascade can run", () => {
  // The bug root cause: mapEvidenceListItem ran `resolveEvidenceTitle`
  // which substituted "Digital Evidence Record" for null/empty
  // titles. The grouped view must NOT route through that fallback
  // — it returns null when the column is empty so the UI can
  // cascade to displayFileName / originalFileName / type.
  assert.match(
    EVIDENCE_ROUTES,
    /rawTitle:\s*typeof row\.title === "string" && row\.title\.trim\(\)/,
  );
});

test("Fix 1 — TypeScript types expose the grouped match shape", () => {
  assert.match(
    LIB_TYPES,
    /export type EvidenceDuplicateMatchReason\s*=\s*[\s\S]{0,200}"exact_hash"[\s\S]{0,80}"fingerprint"[\s\S]{0,80}"part_hash"[\s\S]{0,80}"metadata"/,
  );
  assert.match(
    LIB_TYPES,
    /export type EvidenceDuplicateGroupedMatch\s*=\s*\{[\s\S]{0,400}rawTitle:\s*string \| null/,
  );
  assert.match(LIB_TYPES, /groupedMatches\?:\s*EvidenceDuplicateGroupedMatch\[\]/);
});

test("Fix 1 — UI panel runs the title cascade (rawTitle → file → type → shortId)", () => {
  assert.match(DUPLICATES_PANEL, /function chooseDisplayTitle\(/);
  // Skips the historical "Digital Evidence Record" sentinel even
  // if some legacy data carries it verbatim.
  assert.match(DUPLICATES_PANEL, /t !== "Digital Evidence Record"/);
  // Cascade order verified by source-order grep.
  const cascadeOrder = DUPLICATES_PANEL.indexOf("match.rawTitle");
  const displayName = DUPLICATES_PANEL.indexOf("match.displayFileName");
  const originalName = DUPLICATES_PANEL.indexOf("match.originalFileName");
  const typeFallback = DUPLICATES_PANEL.indexOf("humaniseType");
  const shortIdFallback = DUPLICATES_PANEL.indexOf("shortId(match.evidenceId)");
  assert.ok(cascadeOrder > 0 && displayName > cascadeOrder, "rawTitle must come before displayFileName");
  assert.ok(originalName > displayName, "displayFileName must come before originalFileName");
  assert.ok(typeFallback > originalName, "originalFileName must come before humaniseType");
  assert.ok(shortIdFallback > typeFallback, "humaniseType must come before shortId fallback");
});

test("Fix 1 — UI no longer renders 'Digital Evidence Record' as a JSX text/label literal", () => {
  // The string may appear inside the `t !== "Digital Evidence Record"`
  // sentinel guard — but never as a JSX text node or label literal.
  assert.doesNotMatch(DUPLICATES_PANEL, />Digital Evidence Record</);
  assert.doesNotMatch(DUPLICATES_PANEL, /label:\s*"Digital Evidence Record"/);
});

test("Fix 1 — UI groups + dedupes via the backend's groupedMatches; legacy per-array render is gone", () => {
  // The panel consumes data.groupedMatches and renders one card
  // per evidenceId. The old DuplicateGroup helper that rendered
  // four separate sections is gone.
  assert.match(DUPLICATES_PANEL, /data\?\.groupedMatches\s*\?\?\s*\[\]/);
  assert.match(DUPLICATES_PANEL, /data-evidence-duplicate-record=\{match\.evidenceId\}/);
  // No more "Exact hash matches" / "Fingerprint matches" / "Part-level
  // hash matches" / "Possible metadata duplicates" section titles —
  // the grouped record card carries combined match reasons.
  assert.doesNotMatch(DUPLICATES_PANEL, /title="Exact hash matches"/);
  assert.doesNotMatch(DUPLICATES_PANEL, /title="Part-level hash matches"/);
});

test("Fix 1 — empty state copy is clean", () => {
  assert.match(
    DUPLICATES_PANEL,
    /No accessible duplicate or related records found\./,
  );
  assert.match(DUPLICATES_PANEL, /data-evidence-duplicate-empty/);
});

test("Fix 1 — match-reason pills surface combined reasons (exact + fingerprint + part)", () => {
  assert.match(DUPLICATES_PANEL, /data-evidence-duplicate-match-reason=\{reason\}/);
  assert.match(DUPLICATES_PANEL, /MATCH_REASON_LABELS:\s*Record<EvidenceDuplicateMatchReason,\s*string>/);
});

// ===========================================================================
// Fix 2 — Mismatch Flags
// ===========================================================================

test("Fix 2 — ComparisonPanel hides the Mismatch flags card when every value is null", () => {
  assert.match(COMPARISON_PANEL, /function hasAnyMismatchFlag\(/);
  // The render call is now wrapped in the guard — the literal
  // "Mismatch flags" string appears only inside the conditional
  // branch.
  assert.match(
    COMPARISON_PANEL,
    /hasAnyMismatchFlag\([\s\S]{0,200}\)\s*\?\s*\n?\s*renderGroup\(\s*\n?\s*"Mismatch flags"/,
  );
});

test("Fix 2 — guard treats null AND undefined as 'no flag set'", () => {
  assert.match(
    COMPARISON_PANEL,
    /if\s*\(value\s*!==\s*null\s*&&\s*value\s*!==\s*undefined\)\s*return\s*true/,
  );
});

// ===========================================================================
// Fix 3 — Trust Decision structured view
// ===========================================================================

test("Fix 3 — Technical Appendix mounts a structured TrustDecisionSummary", () => {
  // The component moved into its own file; the tab mounts it.
  assert.match(DECISION, /export function TrustDecisionSummary\(/);
  assert.match(APPENDIX_TAB, /<TrustDecisionSummary trust=\{trustForRender \?\? null\} \/>/);
  // It is no longer wrapped in a disclosure at all — it renders directly, so
  // it is unconditionally visible rather than merely default-expanded. That
  // is the same guarantee, more strongly held.
  assert.doesNotMatch(APPENDIX_TAB, /<details[\s\S]{0,200}TrustDecisionSummary/);
  assert.match(DECISION, /data-trust-summary/);
});

test("Fix 3 — TrustDecisionSummary renders verdict + score + signal counts + signals", () => {
  assert.match(DECISION, /label: "Verdict", value: trust\.verdictLabel/);
  assert.match(DECISION, /label: "Score", value: trust\.scoreLabel/);
  assert.match(DECISION, /label: "Passed signals"/);
  assert.match(DECISION, /label: "Degraded signals"/);
  assert.match(DECISION, /label: "Failed signals"/);
  assert.match(DECISION, /data-trust-summary-signals/);
  assert.match(DECISION, /data-trust-signal-key=\{signal\.key\}/);
  assert.match(DECISION, /data-trust-signal-status=\{signal\.status\}/);
});

test("Fix 3 — per-signal detail is collapsed by default (`<details>` without `open`)", () => {
  // Each signal row is now itself the disclosure — the summary line is the
  // row and the explanation is its panel, instead of a `<details>` nested
  // inside an always-visible row. The guarantee is unchanged and stronger:
  // rows are collapsed unless `defaultOpen` is passed, and the decision never
  // passes it, so dozens of expanded rows remain impossible.
  const DISCLOSURE = src("_tabs/technical-appendix/TechnicalDisclosure.tsx");
  assert.match(DISCLOSURE, /defaultOpen = false/);
  assert.match(DECISION, /<TechnicalDisclosure\b/);
  assert.doesNotMatch(DECISION, /defaultOpen/);
});

test("Fix 3 — raw JSON dump is gated behind ?debug=1 and not in normal UI", () => {
  // The previous always-on raw-JSON dump is gone. Now it only
  // renders when the URL carries `?debug=1`.
  assert.match(APPENDIX_TAB, /useSearchParams/);
  assert.match(
    APPENDIX_TAB,
    /searchParams\?\.get\("debug"\)\s*===\s*"1"/,
  );
  assert.match(APPENDIX_TAB, /showRawDebugJson\s*\?\s*\(/);
  assert.match(APPENDIX_TAB, /data-evidence-raw-debug-gated/);
});

test("Fix 3 — TrustDecisionSummary handles the null/empty case without rendering a broken card", () => {
  assert.match(DECISION, /data-trust-summary-empty/);
  assert.match(
    DECISION,
    /Trust decision is not yet available for this record\./,
  );
});

// ===========================================================================
// Fix 4 — AI Categorization
// ===========================================================================

test("Fix 4 — Review tab mounts AiCategorizationPanel ONCE and not the legacy wrapper/card", () => {
  // Count REAL JSX mounts (with a prop like evidenceId=…), not
  // JSDoc-comment mentions of the component name.
  const panelMounts =
    (REVIEW_TAB.match(/<AiCategorizationPanel\s+evidenceId=/g) ?? []).length;
  assert.equal(panelMounts, 1, "expected exactly 1 <AiCategorizationPanel evidenceId=…> mount");
  // Legacy wrapper + duplicate card are gone (the JSDoc may still
  // mention them as historical context — only JSX/import literals
  // must be absent).
  assert.doesNotMatch(REVIEW_TAB, /import\s+\{?\s*EvidenceAiCategorizationCard/);
  assert.doesNotMatch(REVIEW_TAB, /<AiCategorizationCardWhenActive\s+evidenceId=/);
  assert.doesNotMatch(REVIEW_TAB, /<EvidenceAiCategorizationCard\s+evidenceId=/);
});

test("Fix 4 — canonical disclaimer + DISABLED handling live inside AiCategorizationPanel", () => {
  assert.match(
    AI_PANEL,
    /AI categorization is advisory and metadata-only\. It does not determine factual truth, authorship,\s*\n?\s*integrity, or legal outcome\./,
  );
  assert.match(AI_PANEL, /data\?\.status === "DISABLED"/);
  assert.match(AI_PANEL, /AI categorization is not active for this record\./);
});

test("Fix 4 — the disclaimer + DISABLED block live inside the collapsed <details>, never as a major page section", () => {
  // The whole panel is wrapped in a `<details>` so the inactive
  // state collapses; the user has to expand it to see the
  // "AI categorization is not active" hint.
  assert.match(
    AI_PANEL,
    /<details[\s\S]{0,600}<summary[\s\S]{0,400}>AI categorization<\/span>/,
  );
});

// ===========================================================================
// Regression
// ===========================================================================

test("Regression — Review tab still mounts notes / legal notes / annotations / comparison / duplicates / AI panels", () => {
  assert.match(REVIEW_TAB, /<ReviewerCommentsPanel/);
  assert.match(REVIEW_TAB, /<LegalNotesPanel/);
  assert.match(REVIEW_TAB, /<AnnotationPanel/);
  assert.match(REVIEW_TAB, /<ComparisonPanel/);
  assert.match(REVIEW_TAB, /<DuplicateDetectionPanel/);
  assert.match(REVIEW_TAB, /<AiCategorizationPanel/);
});

test("Regression — Technical Appendix still carries the existing forensic blocks", () => {
  assert.match(APPENDIX_TAB, /data-evidence-technical-block="hashes"/);
  assert.match(APPENDIX_TAB, /data-evidence-technical-block="event-counts"/);
  assert.match(APPENDIX_TAB, /data-evidence-technical-block="custody-chain"/);
});
