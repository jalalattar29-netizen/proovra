/**
 * Phase SEARCH-REMEDIATION-3 — preview panel + truthful empty
 * states + worker lifecycle hooks + saved-view rename.
 *
 * Pins:
 *
 *   1. Right-rail empty state renders the `PreviewDefault`
 *      component with three labelled blocks: recent searches,
 *      saved searches, and search tips. None of them sit on the
 *      "select a row to see details" dead-state copy.
 *
 *   2. Result cards expose the document type as a friendly label
 *      via `DOCUMENT_TYPE_LABEL` (not the raw enum).
 *
 *   3. Center empty state distinguishes 4 modes:
 *        - loading
 *        - error (bounded copy; never the raw error string)
 *        - idle (no q yet)
 *        - no-match (q yields zero rows)
 *
 *   4. Worker `processGenerateReport` calls `indexReport` and
 *      `indexPackage` AFTER the verification-package transaction
 *      commits, looking up the new rows by `(evidenceId, version)`
 *      so the existing transactional shape is preserved.
 *
 *   5. Worker hook is best-effort: failure paths call `logger.warn`
 *      and never propagate; the report/package generation pipeline
 *      stays green.
 *
 *   6. Saved-search rename has a new service `renameSavedView`
 *      that enforces creator-only ACL (returns null for any other
 *      caller) and emits `search.saved_view.rename` to the
 *      platform audit log.
 *
 *   7. Saved-search rename has a new PATCH route at
 *      `/v1/search/saved-views/:id` that returns 404 for non-
 *      matching team / creator (anti-enumeration) and accepts
 *      `{ teamId, name }` with name 1..120 chars.
 *
 *   8. Saved-view UI surfaces a Rename button on each row that
 *      calls the new route via a native prompt + apiFetch PATCH.
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

const SEARCH_PAGE = src("apps/web/app/(app)/search/page.tsx");
const SEARCH_ROUTES = src("services/api/src/routes/search.routes.ts");
const SAVED_SEARCH = src(
  "services/api/src/services/search/saved-search.service.ts",
);
const WORKER = src("services/worker/src/processor.ts");

// ===========================================================================
// Right-rail empty state: PreviewDefault
// ===========================================================================

test("Right-rail renders PreviewDefault when no result is selected (replaces the 'Select a result…' dead state)", () => {
  assert.match(
    SEARCH_PAGE,
    /\{!selected \? \(\s*\n?\s*\/\/ Phase SEARCH-REMEDIATION-3[\s\S]{0,800}?<PreviewDefault\b/,
  );
  // The legacy dead-state copy is gone.
  assert.doesNotMatch(
    SEARCH_PAGE,
    /Select a result to inspect pointers and related evidence\./,
  );
});

test("PreviewDefault component declares three labelled sections", () => {
  for (const anchor of [
    "data-search-preview-default-recent",
    "data-search-preview-default-saved",
    "data-search-preview-default-tips",
  ]) {
    assert.ok(
      SEARCH_PAGE.includes(anchor),
      `PreviewDefault must declare ${anchor}`,
    );
  }
});

test("PreviewDefault recent block has empty-state copy + Clear button gated on count > 0", () => {
  assert.match(SEARCH_PAGE, /data-search-preview-default-recent-empty/);
  assert.match(SEARCH_PAGE, /Your recent searches will appear here\./);
  assert.match(
    SEARCH_PAGE,
    /recent\.length > 0 \? \(\s*\n?\s*<button[\s\S]{0,400}?data-search-preview-default-clear-recent/,
  );
});

test("PreviewDefault saved block has empty-state copy", () => {
  assert.match(SEARCH_PAGE, /data-search-preview-default-saved-empty/);
  assert.match(SEARCH_PAGE, /No saved searches yet\./);
});

test("PreviewDefault tips block mentions OCR + filenames + filters", () => {
  assert.match(
    SEARCH_PAGE,
    /Search by filename, case name, report title, package, note,/,
  );
  assert.match(
    SEARCH_PAGE,
    /OCR and transcript text appear in results when available\./,
  );
});

// ===========================================================================
// Result-card type badge uses friendly label
// ===========================================================================

test("Result-card type badge renders DOCUMENT_TYPE_LABEL (not the raw enum string)", () => {
  // Pin both sides separately — the JSX text node sits a few
  // lines after the data-attribute, so an inline window can be
  // fragile across whitespace edits.
  assert.match(SEARCH_PAGE, /data-search-result-type=\{row\.documentType\}/);
  assert.match(
    SEARCH_PAGE,
    /\{DOCUMENT_TYPE_LABEL\[row\.documentType\] \?\? row\.documentType\}/,
  );
  // Anti-regression: the lowercase replace("_", " ") of the
  // previous code path is gone.
  assert.doesNotMatch(
    SEARCH_PAGE,
    /row\.documentType\.toLowerCase\(\)\.replace\("_", " "\)/,
  );
});

// ===========================================================================
// Center empty state — four distinct modes
// ===========================================================================

test("Center empty state has four distinct rendered branches with stable data-kind attributes", () => {
  for (const kind of ["loading", "error", "idle", "no-match"]) {
    assert.ok(
      SEARCH_PAGE.includes(`data-search-empty-state-kind="${kind}"`),
      `center empty-state branch missing for kind=${kind}`,
    );
  }
});

test("Error empty state shows a bounded message (does NOT inline the raw error string)", () => {
  // The four-branch ternary surfaces the bounded copy unconditionally.
  // The raw `error` value is never interpolated into the JSX text.
  assert.match(
    SEARCH_PAGE,
    /data-search-empty-state-kind="error"[\s\S]{0,400}?<strong>Search is temporarily unavailable<\/strong>/,
  );
  // The raw error value cannot reach this block as text.
  const errorBlockStart = SEARCH_PAGE.indexOf(
    'data-search-empty-state-kind="error"',
  );
  const errorBlockEnd = SEARCH_PAGE.indexOf("</div>", errorBlockStart);
  const errorBlock = SEARCH_PAGE.slice(errorBlockStart, errorBlockEnd);
  assert.doesNotMatch(errorBlock, /\{error\}/);
});

test("Idle empty state ('Start searching') fires when there is no query yet", () => {
  // The branch is guarded by `!filter?.q ? ( ... )`. Pin the guard
  // separately from the rendered copy to stay robust to
  // intermediate JSX whitespace.
  assert.match(SEARCH_PAGE, /!filter\?\.q \? \(/);
  assert.match(
    SEARCH_PAGE,
    /<div data-search-empty-state-kind="idle">[\s\S]{0,400}?<strong>Start searching<\/strong>/,
  );
});

test("No-match empty state copy advises to try a different filename / case / report", () => {
  assert.match(SEARCH_PAGE, /data-search-empty-state-kind="no-match"/);
  assert.match(
    SEARCH_PAGE,
    /Try a different filename, case name, report title,\s*\n?\s*note, or record ID\./,
  );
});

// ===========================================================================
// Worker lifecycle hook (report + package)
// ===========================================================================

test("Worker processGenerateReport calls indexPackage after the package tx commits", () => {
  assert.match(
    WORKER,
    /Phase SEARCH-REMEDIATION-3[\s\S]{0,1200}?indexPackage\(\{ packageId: created\.id \}\)/,
  );
});

test("Worker processGenerateReport calls indexReport after the report co-row is persisted", () => {
  assert.match(
    WORKER,
    /Phase SEARCH-REMEDIATION-3[\s\S]{0,2400}?indexReport\(\{ reportId: co\.id \}\)/,
  );
});

test("Worker lifecycle hook is best-effort: every failure path calls logger.warn (never re-throws)", () => {
  assert.match(
    WORKER,
    /catch \(err\) \{\s*\n?\s*logger\.warn\(\s*\n?\s*\{[\s\S]{0,400}?"search_index\.lifecycle_failed",/,
  );
  // The two skip-paths (not-ok results) log + continue rather than throw.
  assert.match(WORKER, /"search_index\.package_skipped"/);
  assert.match(WORKER, /"search_index\.report_skipped"/);
});

// ===========================================================================
// Saved-search rename — service + route + UI
// ===========================================================================

test("Saved-search service exposes renameSavedView with the canonical input contract", () => {
  assert.match(
    SAVED_SEARCH,
    /export type RenameSavedViewInput = \{\s*\n?\s*id: string;\s*\n?\s*teamId: string;\s*\n?\s*actorUserId: string;\s*\n?\s*name: string;\s*\n?\s*\};/,
  );
  assert.match(SAVED_SEARCH, /export async function renameSavedView\(/);
});

test("renameSavedView enforces creator-only ACL and validates name length (1..120 chars)", () => {
  // ACL: returns null when the actor isn't the creator.
  assert.match(
    SAVED_SEARCH,
    /if \(row\.createdByUserId !== input\.actorUserId\) \{[\s\S]{0,200}?return null;/,
  );
  // Length guard: empty or >120 trimmed → null.
  assert.match(
    SAVED_SEARCH,
    /trimmed\.length === 0 \|\| trimmed\.length > 120/,
  );
});

test("renameSavedView writes a search.saved_view.rename audit row using the canonical platform logger", () => {
  assert.match(SAVED_SEARCH, /action:\s*"search\.saved_view\.rename"/);
  assert.match(
    SAVED_SEARCH,
    /resourceType:\s*"saved_search_view"/,
  );
});

test("PATCH /v1/search/saved-views/:id route is registered and returns 404 on null (anti-enumeration)", () => {
  assert.match(
    SEARCH_ROUTES,
    /app\.patch\(\s*\n?\s*"\/v1\/search\/saved-views\/:id",/,
  );
  // Body schema: name 1..120, teamId is uuid.
  assert.match(
    SEARCH_ROUTES,
    /name: z\.string\(\)\.min\(1\)\.max\(120\),/,
  );
  // 404 fallback when service returns null.
  assert.match(
    SEARCH_ROUTES,
    /if \(!updated\) \{\s*\n?\s*return reply\.code\(404\)\.send\(\{ error: \{ code: "not_found" \} \}\);/,
  );
});

test("Saved-view row renders a Rename button next to Delete, wired via apiFetch PATCH", () => {
  assert.match(SEARCH_PAGE, /data-search-saved-view-rename=\{v\.id\}/);
  assert.match(
    SEARCH_PAGE,
    /apiFetch\(\s*\n?\s*`\/v1\/search\/saved-views\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\{\s*\n?\s*method: "PATCH",\s*\n?\s*body: JSON\.stringify\(\{ teamId, name: trimmed \}\),/,
  );
});
