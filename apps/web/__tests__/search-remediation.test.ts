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
const REINDEX_SERVICE = src("services/api/src/services/search/reindex.service.ts");
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

/**
 * ===========================================================================
 * THE DOCUMENT-TYPE FACTS, DERIVED — NOT A SECOND COPY OF THE LIST
 * ===========================================================================
 * The case here used to pin the chip array as LITERAL SOURCE TEXT — a regex
 * spelling out `"EVIDENCE", "CASE", "REPORT", "PACKAGE", "NOTE"` in order.
 * That is a duplicate of the list it is checking, and it failed the moment
 * INTAKE_LINK was added: a chip that is legitimate, indexed, and the entire
 * point of making an intake request findable before any evidence comes back.
 *
 * The pin could not tell the two cases apart. "Someone re-introduced an
 * unimplemented WORKFLOW chip", which is what the test was written for, and
 * "someone added a real type", which is what happened, are the same edit to a
 * literal array. So the facts are DERIVED from the three authorities instead:
 *
 *   CANONICAL   packages/shared/src/search.ts — SEARCH_DOCUMENT_TYPES, the
 *               enum GET /v1/search validates `documentTypes` against.
 *   INDEXED     the projection and the indexers that actually WRITE a
 *               documentType into evidence_search_documents.
 *   CHIPS       the personal filter list on the page.
 *
 * and the properties held are the ones that were meant all along: a chip is a
 * type the API accepts; a chip is a type something indexes (a chip for a type
 * nothing writes is exactly the zero-hits filter this phase removed); and
 * every type that IS indexed can be labelled and opened.
 */
function arrayLiteral(source: string, declaration: RegExp): string[] {
  const at = source.search(declaration);
  assert.notStrictEqual(at, -1, `declaration not found: ${declaration}`);
  /* The ARRAY's bracket, not the one in `DocumentType[]`. */
  const open = source.indexOf("= [", at) + 2;
  const close = source.indexOf("]", open);
  assert.ok(open !== -1 && close > open, "malformed array literal");
  return [...source.slice(open, close).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

/** Every value the API's document-type enum accepts. */
const CANONICAL_TYPES = arrayLiteral(
  SHARED_SEARCH,
  /export const SEARCH_DOCUMENT_TYPES = \[/,
);

/** Every type something actually writes into the index. */
const ARTIFACT_INDEXER = src(
  "services/api/src/services/search/artifact-indexing.service.ts",
);
const SEARCH_PROJECTION = src("packages/shared/src/search-projection.ts");
const INDEXED_TYPES = [
  ...new Set(
    [SEARCH_PROJECTION, ARTIFACT_INDEXER, CASE_INDEXER]
      .flatMap((file) => [...file.matchAll(/documentType: "([A-Z_]+)"/g)])
      .map((m) => m[1]),
  ),
].sort();

/** The chips the personal filter rail offers. */
const CHIP_TYPES = arrayLiteral(
  SEARCH_PAGE,
  /const DOCUMENT_TYPES: DocumentType\[\] = \[/,
);

test("the three document-type authorities parse", () => {
  // A derivation that silently produced an empty set would make every case
  // below vacuously true, which is the failure mode a derived test has and a
  // literal one does not.
  assert.ok(CANONICAL_TYPES.length >= 5, "SEARCH_DOCUMENT_TYPES did not parse");
  assert.ok(INDEXED_TYPES.length >= 5, "no indexer document types parsed");
  assert.ok(CHIP_TYPES.length >= 5, "DOCUMENT_TYPES did not parse");
});

test("every document-type chip is a type the API accepts", () => {
  for (const t of CHIP_TYPES) {
    assert.ok(
      CANONICAL_TYPES.includes(t),
      `chip "${t}" is not in SEARCH_DOCUMENT_TYPES — the API would refuse it`,
    );
  }
});

test("no chip offers a type nothing indexes (the zero-hits filter)", () => {
  for (const t of CHIP_TYPES) {
    assert.ok(
      INDEXED_TYPES.includes(t),
      `chip "${t}" filters on a type no indexer writes — it can only return nothing`,
    );
  }
});

test("every indexed document type has a label and an Open destination", () => {
  const from = SEARCH_PAGE.indexOf("function getOpenAction(");
  assert.notStrictEqual(from, -1, "getOpenAction not found");
  const openBody = SEARCH_PAGE.slice(from, SEARCH_PAGE.indexOf("\nfunction ", from + 1));
  const labelFrom = SEARCH_PAGE.indexOf("const DOCUMENT_TYPE_LABEL");
  assert.notStrictEqual(labelFrom, -1, "DOCUMENT_TYPE_LABEL not found");
  const labelBody = SEARCH_PAGE.slice(labelFrom, SEARCH_PAGE.indexOf("};", labelFrom));
  for (const t of INDEXED_TYPES) {
    // Substring, not a regex: the label map is written `TYPE: "Label",` and
    // the switch `case "TYPE":`, both exact shapes. A regex here would need
    // escapes that say nothing extra.
    assert.ok(
      labelBody.includes(`${t}: "`),
      `indexed type ${t} has no DOCUMENT_TYPE_LABEL entry — the row renders the raw enum`,
    );
    assert.ok(
      openBody.includes(`case "${t}":`),
      `indexed type ${t} has no case in getOpenAction — a result of this type cannot be opened`,
    );
  }
});

test("a canonical type that nothing indexes is not offered as a chip", () => {
  for (const t of CANONICAL_TYPES) {
    if (INDEXED_TYPES.includes(t)) continue;
    assert.ok(
      !CHIP_TYPES.includes(t),
      `${t} is offered as a chip but no indexer writes it`,
    );
  }
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
  // REDESIGN/SEARCH — the console owns its header again. PageHeader's slot
  // API forced the search FORM into a "primaryAction" slot and rendered the
  // heading as an inline-styled <span> inside a foreign <h1>; the canonical
  // `.search-header` restores a real <h1> and gives the form its own panel.
  // The invariants are unchanged and re-pinned below: the visible title text
  // is exactly "Search", `data-search-title` is still in the DOM for
  // end-to-end probes, and the page renders exactly one <h1>.
  // The <h1> gained the CANONICAL title-icon row — the same
  // `.app-title-row` / `.app-title-icon` pair /cases, /notifications and the
  // Evidence Library use. The invariants this test protects are unchanged and
  // asserted below: the visible title text is exactly "Search", the probe
  // attribute is still in the DOM, and there is exactly one <h1>.
  assert.match(
    SEARCH_PAGE,
    /<h1 className="search-header__title app-title-row" data-search-title>/,
  );
  assert.match(SEARCH_PAGE, /<span data-search-title-text>Search<\/span>/);
  assert.match(SEARCH_PAGE, /className="app-title-icon"/);
  assert.doesNotMatch(SEARCH_PAGE, /\{terms\.evidence\} Discovery/);
  assert.equal(
    (SEARCH_PAGE.match(/<h1\b/g) ?? []).length,
    1,
    "the search console must render exactly one <h1>",
  );
  // The supporting line is a sibling paragraph — not a badge, not an action.
  assert.match(SEARCH_PAGE, /className="search-header__description"/);
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
  /*
   * The endpoint still walks both source tables — through the reindex
   * service, not through a copy of the queries.
   *
   * It used to carry its own, and that duplication had a cost that was not
   * theoretical: when the reindex learned to refresh documents written by an
   * older build of the projection, this route did not, so the one entry point
   * an operator actually reaches kept reporting "0 orphans, complete" over an
   * index full of stale documents. Asserting the SQL lived HERE is what made
   * the second copy look correct.
   */
  assert.match(SEARCH_ROUTES, /runWorkspaceReindexBodyUnderLock/);
  assert.doesNotMatch(SEARCH_ROUTES, /FROM evidence e/);
  assert.match(REINDEX_SERVICE, /FROM evidence e/);
  assert.match(REINDEX_SERVICE, /FROM cases c/);
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
