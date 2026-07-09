/**
 * Phase SEARCH-REMEDIATION — surface contract for the simplified
 * search platform. Pins:
 *
 *   1. Personal users see only EVIDENCE / CASE / REPORT / PACKAGE
 *      / NOTE document types (no unimplemented "WORKFLOW" /
 *      "INCIDENT" chips that previously returned zero hits).
 *
 *   2. The user-facing search-mode picker (Keyword / Hybrid /
 *      Semantic) is gone. The backend continues to choose the
 *      strategy itself; admins can read `modeUsed` /
 *      `fallbackReason` from the response.
 *
 *   3. The page title is "Search" (not "Evidence Discovery").
 *
 *   4. The search input placeholder reflects the real corpus
 *      ("Search evidence, cases, reports, notes, OCR text…").
 *
 *   5. Backend: SEARCH_DOCUMENT_TYPES enum has the four new
 *      entries (so the API accepts documentTypes=CASE etc.).
 *
 *   6. Backend: GET /v1/search/suggest endpoint is registered.
 *
 *   7. Backend: POST /v1/search/reconcile endpoint is registered.
 *
 *   8. Backend: case create + case rename routes call
 *      indexCase() so the search projection stays in sync.
 *
 *   9. Backend: evidence rename route calls indexEvidence().
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
const CASES_ROUTES = src("services/api/src/routes/cases.routes.ts");
const EVIDENCE_ROUTES = src("services/api/src/routes/evidence.routes.ts");
const SHARED_SEARCH = src("packages/shared/src/search.ts");
const CASE_INDEXER = src(
  "services/api/src/services/search/case-indexing.service.ts",
);
const BACKFILL = src("services/api/scripts/backfill-search-index.ts");

// ===========================================================================
// UI simplification
// ===========================================================================

test("Personal DOCUMENT_TYPES chip list exposes only EVIDENCE / CASE / REPORT / PACKAGE / NOTE", () => {
  // Match the literal array — pinned so a refactor that
  // re-introduces WORKFLOW / INCIDENT chips fails here.
  assert.match(
    SEARCH_PAGE,
    /const DOCUMENT_TYPES: DocumentType\[\] = \[\s*\n?\s*"EVIDENCE",\s*\n?\s*"CASE",\s*\n?\s*"REPORT",\s*\n?\s*"PACKAGE",\s*\n?\s*"NOTE",\s*\n?\s*\];/,
  );
});

test("Document-type chip uses the friendly label (no raw enum strings rendered)", () => {
  // The renderer maps the value through DOCUMENT_TYPE_LABEL[t]
  // rather than the previous lowercase enum.
  assert.match(SEARCH_PAGE, /\{DOCUMENT_TYPE_LABEL\[t\]\}/);
  assert.doesNotMatch(
    SEARCH_PAGE,
    /\{t\.toLowerCase\(\)\.replace\("_", " "\)\}/,
  );
});

test("Search-mode picker (Keyword / Hybrid / Semantic) is removed from the UI", () => {
  assert.doesNotMatch(SEARCH_PAGE, /<SearchModeSelector\b/);
  assert.doesNotMatch(SEARCH_PAGE, /aria-label="Search mode"/);
});

test("Page title is 'Search' (not 'Evidence Discovery')", () => {
  // Phase 7C — the /search heading migrated to the shared PageHeader,
  // which owns the single semantic <h1>. The `data-search-title`
  // contract hook now rides on the inner <span style={titleStyle}>
  // that PageHeader renders inside its <h1>, so this pin was updated
  // from `<h1 … data-search-title>` to `<span … data-search-title>`.
  // The invariant is unchanged: the visible title text is exactly
  // "Search" and the `data-search-title` attribute is still present in
  // the DOM for end-to-end probes. This is a pure markup-shape update
  // (element tag), not a copy / behaviour / honesty change.
  assert.match(SEARCH_PAGE, /<span style=\{titleStyle\} data-search-title>\s*\n?\s*Search\s*\n?\s*<\/span>/);
  assert.doesNotMatch(SEARCH_PAGE, /\{terms\.evidence\} Discovery/);
  // The shared PageHeader supplies the single <h1>; the title routes
  // through its `title` prop.
  assert.match(SEARCH_PAGE, /<PageHeader\b/);
});

test("Search input placeholder advertises the real corpus", () => {
  assert.match(
    SEARCH_PAGE,
    /placeholder="Search evidence, cases, reports, notes, OCR text…"/,
  );
});

// ===========================================================================
// Backend: enum + new endpoints + lifecycle hooks
// ===========================================================================

test("SEARCH_DOCUMENT_TYPES includes CASE / REPORT / PACKAGE / NOTE", () => {
  for (const v of ["CASE", "REPORT", "PACKAGE", "NOTE"]) {
    assert.match(SHARED_SEARCH, new RegExp(`"${v}"`));
  }
});

test("GET /v1/search/suggest endpoint is registered", () => {
  assert.match(
    SEARCH_ROUTES,
    /app\.get\(\s*\n?\s*"\/v1\/search\/suggest"/,
  );
});

test("POST /v1/search/reconcile endpoint is registered + queries for orphan evidence + orphan cases", () => {
  assert.match(
    SEARCH_ROUTES,
    /app\.post\(\s*\n?\s*"\/v1\/search\/reconcile"/,
  );
  // The endpoint actually walks both source tables for missing
  // projection rows.
  assert.match(SEARCH_ROUTES, /FROM evidence e/);
  assert.match(SEARCH_ROUTES, /FROM cases c/);
});

test("Case create route calls indexCase() inline (no worker dependency)", () => {
  assert.match(
    CASES_ROUTES,
    /prisma\.case\.create\([\s\S]{0,800}?indexCase\(\{ teamId: created\.teamId, caseId: created\.id \}\)/,
  );
});

test("Case rename route calls indexCase() inline", () => {
  assert.match(
    CASES_ROUTES,
    /prisma\.case\.update\([\s\S]{0,800}?indexCase\(\{ teamId: updated\.teamId, caseId: updated\.id \}\)/,
  );
});

test("Evidence label/rename route calls indexEvidence() inline", () => {
  assert.match(
    EVIDENCE_ROUTES,
    /data: \{ title: body\.label \}[\s\S]{0,2000}?indexEvidence\(\{ teamId: updated\.teamId, evidenceId: id \}\)/,
  );
});

// ===========================================================================
// Case indexer projection shape
// ===========================================================================

test("Case indexer writes documentType='CASE' with team-scoped sourceId upsert key", () => {
  assert.match(CASE_INDEXER, /documentType:\s*"CASE"/);
  assert.match(
    CASE_INDEXER,
    /teamId_documentType_sourceId:\s*\{\s*\n?\s*teamId,\s*\n?\s*documentType:\s*"CASE",\s*\n?\s*sourceId:\s*caseRow\.id,/,
  );
});

test("Case indexer composes searchableText from name + reference + description + last 20 case-notes", () => {
  // Body parts assembly — name / reference / description first.
  assert.match(
    CASE_INDEXER,
    /caseRow\.name \?\? ""[\s\S]{0,200}?caseRow\.referenceNumber \?\? ""[\s\S]{0,200}?caseRow\.description \?\? ""/,
  );
  // Case-comment join, bounded.
  assert.match(
    CASE_INDEXER,
    /caseComment\.findMany\(\{[\s\S]{0,200}?orderBy: \{ createdAt: "desc" \},\s*\n?\s*take: 20,/,
  );
});

// ===========================================================================
// Backfill script
// ===========================================================================

test("Backfill script walks all non-deleted evidence and calls indexEvidence per row", () => {
  assert.match(BACKFILL, /prisma\.evidence\.findMany\(\{[\s\S]{0,500}?where,/);
  assert.match(BACKFILL, /await indexEvidence\(\{\s*\n?\s*teamId: row\.teamId,\s*\n?\s*evidenceId: row\.id,\s*\n?\s*\}\)/);
});

test("Backfill script supports --include-cases for indexing Cases too", () => {
  assert.match(BACKFILL, /includeCases/);
  assert.match(
    BACKFILL,
    /await indexCase\(\{ teamId: row\.teamId, caseId: row\.id \}\)/,
  );
});

test("Backfill script logs indexed/skipped/failed counts per batch", () => {
  assert.match(BACKFILL, /progress {2}scanned=/);
  assert.match(BACKFILL, /indexed=/);
  assert.match(BACKFILL, /skipped=/);
  assert.match(BACKFILL, /failed=/);
});
