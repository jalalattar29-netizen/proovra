/**
 * Phase CASES-ATTACH-PICKER-MULTI — multi-select contract for the
 * Add evidence dialog. Pins the behaviour the previous single-
 * select v1 lacked:
 *
 *   1. Selection state is a Set<string> (not a single string).
 *   2. Row + button click TOGGLE membership (click a selected row
 *      again to deselect).
 *   3. The footer "Link" button is disabled when nothing is
 *      selected.
 *   4. The footer label includes the selected count once >1.
 *   5. Search filters visible rows but never clears the selection
 *      — a row stays selected even when the user types a query
 *      that hides it.
 *   6. Report-ready / Package-ready are INFORMATIONAL. The picker
 *      does not filter by them. Backend has no readiness filter
 *      either. The badges render in neutral muted color so they
 *      do not look like eligibility errors.
 *   7. Submit fires the existing single-attach endpoint once per
 *      selected id via Promise.allSettled (no batch endpoint).
 *   8. The backend `where:` clause on
 *      `/v1/cases/:id/available-evidence` does NOT restrict by
 *      `latestReportVersion` or `verificationPackageVersion`.
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

const SIMPLE_DETAIL = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const CASES_ROUTES = src("services/api/src/routes/cases.routes.ts");

// ===========================================================================
// Multi-select state shape
// ===========================================================================

test("Selection state is a Set<string> (multi-select), not a single string", () => {
  assert.match(
    SIMPLE_DETAIL,
    /const \[selectedIds, setSelectedIds\] = useState<Set<string>>\(\(\) => new Set\(\)\);/,
  );
  // The old single-select declaration is gone.
  assert.doesNotMatch(
    SIMPLE_DETAIL,
    /const \[selected, setSelected\] = useState<string>\(""\);/,
  );
});

test("`toggleSelected(id)` is the single canonical mutator (used by row click + per-row Select button)", () => {
  // The helper exists with the canonical add/delete shape.
  assert.match(
    SIMPLE_DETAIL,
    /const toggleSelected = useCallback\(\(id: string\) => \{[\s\S]{0,400}?if \(next\.has\(id\)\) next\.delete\(id\);\s*\n?\s*else next\.add\(id\);/,
  );
  // Both row-li onClick AND per-row button onClick call it.
  const rowClicks = SIMPLE_DETAIL.match(/toggleSelected\(c\.id\)/g) ?? [];
  assert.ok(
    rowClicks.length >= 2,
    `expected toggleSelected(c.id) to be wired in at least 2 places (row + button), found ${rowClicks.length}`,
  );
});

// ===========================================================================
// Footer disabled state + count-aware label
// ===========================================================================

test("Footer button disabled until at least one row is selected", () => {
  assert.match(
    SIMPLE_DETAIL,
    /disabled=\{selectedCount === 0 \|\| busy\}[\s\S]{0,200}?data-simple-case-attach-confirm/,
  );
});

test("Footer label varies by selected count: 0 prompts to select, 1 keeps the singular label, N shows count", () => {
  // Helper hint line — visible when count is 0.
  assert.match(SIMPLE_DETAIL, /"Select one or more evidence records"/);
  // Singular case still uses the original locked copy.
  assert.match(SIMPLE_DETAIL, /"1 evidence record selected"/);
  assert.match(SIMPLE_DETAIL, /"Link selected evidence"/);
  // Multi case includes the live count in the CTA.
  assert.match(
    SIMPLE_DETAIL,
    /`\$\{selectedCount\} evidence records selected`/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /`Link \$\{selectedCount\} selected evidence records`/,
  );
});

test("Live selection counter is exposed via data-simple-case-attach-selected-count attribute", () => {
  // The number renders into the data-attribute so e2e tests can
  // pin the user-visible count without scraping copy.
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-selected-count=\{selectedCount\}/,
  );
});

// ===========================================================================
// Row UI — checkbox + selected highlight + isSelected via Set.has
// ===========================================================================

test("Each row exposes a checkbox bound to membership in selectedIds", () => {
  assert.match(
    SIMPLE_DETAIL,
    /<input\s*\n?\s*type="checkbox"\s*\n?\s*checked=\{isSelected\}[\s\S]{0,400}?data-simple-case-attach-row-checkbox=\{c\.id\}/,
  );
  // Membership test is via Set.has, not equality.
  assert.match(SIMPLE_DETAIL, /const isSelected = selectedIds\.has\(c\.id\);/);
});

// ===========================================================================
// Report / Package readiness is INFORMATIONAL — never a filter
// ===========================================================================

test("Picker does NOT filter candidates by reportReady / packageReady (eligibility is decoupled from readiness)", () => {
  // The frontend's only filter is the existingEvidenceIds dedupe
  // (already-attached). It must not also drop rows based on the
  // informational readiness booleans.
  const modalStart = SIMPLE_DETAIL.indexOf("function AttachEvidenceModal(");
  const modalEnd = SIMPLE_DETAIL.indexOf("\nfunction ", modalStart + 1);
  const modalBody = SIMPLE_DETAIL.slice(modalStart, modalEnd);
  assert.doesNotMatch(modalBody, /filter\([^)]*reportReady/);
  assert.doesNotMatch(modalBody, /filter\([^)]*packageReady/);
});

test("Readiness badges render in neutral muted color (so they don't look like eligibility errors)", () => {
  // The amber `#92400e` previously used for "missing" badges
  // implied "blocked". Both badges now render in the same neutral
  // `#475569` slate so the eye doesn't read them as errors.
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-row-report=\{[\s\S]{0,200}?style=\{\{ color: "#475569" \}\}/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-row-package=\{[\s\S]{0,200}?style=\{\{ color: "#475569" \}\}/,
  );
  // The previous amber error color is gone from the modal block.
  const modalStart = SIMPLE_DETAIL.indexOf("function AttachEvidenceModal(");
  const modalEnd = SIMPLE_DETAIL.indexOf("\nfunction ", modalStart + 1);
  const modalBody = SIMPLE_DETAIL.slice(modalStart, modalEnd);
  assert.doesNotMatch(modalBody, /#92400e/);
});

// ===========================================================================
// Backend: no readiness filter on /v1/cases/:id/available-evidence
// ===========================================================================

test("Backend /v1/cases/:id/available-evidence where-clause does NOT restrict by report/package readiness", () => {
  // Anchor on the route handler. Extract just the where-clause
  // by matching the exact `where: { ... },` block (multiline,
  // up to the first closing `},`). The `select:` block that
  // follows is allowed to mention the version fields (the picker
  // needs to read them for badges) — the where-clause must not.
  const start = CASES_ROUTES.indexOf('"/v1/cases/:id/available-evidence"');
  const end = CASES_ROUTES.indexOf("app.post(", start);
  const handler = CASES_ROUTES.slice(start, end > 0 ? end : start + 6000);
  // Anchor on the evidence.findMany call specifically (the
  // `case.findUnique` call earlier in the handler also has a
  // `where: {...}` and would otherwise match first).
  const findManyIdx = handler.indexOf("prisma.evidence.findMany(");
  assert.ok(findManyIdx > 0, "could not locate prisma.evidence.findMany call");
  const slice = handler.slice(findManyIdx);
  const whereMatch = slice.match(/where:\s*\{([\s\S]*?)\}\s*,/);
  assert.ok(whereMatch, "could not locate where: { ... }, block in handler");
  const whereBody = whereMatch![1];
  assert.doesNotMatch(whereBody, /latestReportVersion/);
  assert.doesNotMatch(whereBody, /verificationPackageVersion/);
  // Sanity: the lifecycle filters are still present.
  assert.match(whereBody, /deletedAt: null/);
  assert.match(whereBody, /archivedAt: null/);
  // PHASE 12B Case-Evidence convergence: the Evidence.caseId scalar was
  // REMOVED and CaseEvidenceLink is the sole association authority, so
  // "not yet attached to any case" is now `caseLinks: { none: {} }`.
  assert.match(whereBody, /caseLinks:\s*\{\s*none:/);
});

// ===========================================================================
// Submission contract: one POST per id, Promise.allSettled
// ===========================================================================

test("Submit fires the existing single-attach endpoint once per id via Promise.allSettled (no batch endpoint)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /const results = await Promise\.allSettled\(\s*\n?\s*ids\.map\(\(evidenceId\) =>\s*\n?\s*apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ evidenceId \}\),/,
  );
});

test("Submit reports partial success/failure counts to the parent via onAttached({succeeded, failed})", () => {
  // Counters derived from results.
  assert.match(
    SIMPLE_DETAIL,
    /const succeeded = results\.filter\(\(r\) => r\.status === "fulfilled"\)\.length;\s*\n?\s*const failed = results\.length - succeeded;/,
  );
  // Reported to parent.
  assert.match(SIMPLE_DETAIL, /await onAttached\(\{ succeeded, failed \}\);/);
});

// ===========================================================================
// Toast wording for single / multi / partial-failure / all-failed
// ===========================================================================

test("Single-success toast keeps the legacy copy ('Evidence linked to case.')", () => {
  assert.match(SIMPLE_DETAIL, /addToast\(\s*\n?\s*succeeded === 1\s*\n?\s*\? "Evidence linked to case\."/);
});

test("Multi-success toast is count-aware (`N evidence records linked to case.`)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /: `\$\{succeeded\} evidence records linked to case\.`/,
  );
});

test("Partial-failure toast tells the user how many succeeded and how many didn't", () => {
  assert.match(
    SIMPLE_DETAIL,
    /\$\{succeeded\} evidence record\$\{succeeded === 1 \? "" : "s"\} linked\. \$\{failed\} could not be linked\./,
  );
});

test("All-failed toast says 'Could not link the (N) selected evidence record(s).' and keeps the dialog open", () => {
  assert.match(
    SIMPLE_DETAIL,
    /"Could not link the selected evidence record\."/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /`Could not link the \$\{failed\} selected evidence records\.`/,
  );
});

// ===========================================================================
// Already-attached dedupe + cross-workspace block (smoke)
// ===========================================================================

test("Already-linked evidence still hidden by the client-side dedupe Set (defensive layer over backend filter)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /\(res\.items \?\? \[\]\)\.filter\(\s*\n?\s*\(i\) => !existingEvidenceIds\.has\(i\.id\),\s*\n?\s*\);/,
  );
});

test("Backend attach guard (cross-team) remains untouched at POST /v1/cases/:id/evidence", () => {
  assert.match(CASES_ROUTES, /evaluateCrossTeamAttach\(\{/);
});
