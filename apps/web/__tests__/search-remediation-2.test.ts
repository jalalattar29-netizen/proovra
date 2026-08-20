/**
 * Phase SEARCH-REMEDIATION-2 — coverage extension + type-ahead UI.
 * Pins:
 *
 *   1. New REPORT / PACKAGE / NOTE indexers exist and write to the
 *      same `evidence_search_documents` table with the canonical
 *      `(teamId, documentType, sourceId)` upsert key.
 *
 *   2. Note add (create case comment) inline-indexes the new note
 *      AND re-indexes the parent case (so a comment's body
 *      contributes to its case's searchable text).
 *
 *   3. Note delete (delete case comment) drops the note's index
 *      row AND re-indexes the parent case.
 *
 *   4. Reconcile endpoint covers reports + packages + notes
 *      orphans in addition to evidence + cases.
 *
 *   5. Backfill script supports `--all` to walk all five entity
 *      types.
 *
 *   6. Frontend search input is wrapped in a positioned container
 *      that renders the SearchTypeahead dropdown.
 *
 *   7. Frontend has a per-workspace recent-searches localStorage
 *      key + push helper called on every submit.
 *
 *   8. Frontend SearchTypeahead renders three sections:
 *      - recent-searches list (when query < 2 chars)
 *      - live suggestions list (when query >= 2 chars and rows exist)
 *      - empty-state hint (when query >= 2 chars and no rows)
 *
 *   9. Frontend wires keyboard navigation (ArrowUp / ArrowDown /
 *      Enter / Escape) on the search input.
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

const ARTIFACT_INDEXER = src(
  "services/api/src/services/search/artifact-indexing.service.ts",
);
const LIFECYCLE = src(
  "services/api/src/services/cases/case-lifecycle.service.ts",
);
const SEARCH_ROUTES = src("services/api/src/routes/search.routes.ts");
const BACKFILL = src("services/api/scripts/backfill-search-index.ts");
const SEARCH_PAGE = src("apps/web/app/(app)/search/page.tsx");
const SEARCH_CSS = src("apps/web/app/(app)/search/search.css");

// ===========================================================================
// Backend: artifact indexers
// ===========================================================================

test("artifact-indexing exposes indexReport / indexPackage / indexNote", () => {
  assert.match(ARTIFACT_INDEXER, /export async function indexReport\(/);
  assert.match(ARTIFACT_INDEXER, /export async function indexPackage\(/);
  assert.match(ARTIFACT_INDEXER, /export async function indexNote\(/);
});

test("artifact-indexing uses the canonical (teamId, documentType, sourceId) upsert key", () => {
  assert.match(
    ARTIFACT_INDEXER,
    /teamId_documentType_sourceId:\s*\{\s*\n?\s*teamId:\s*input\.teamId,\s*\n?\s*documentType:\s*input\.documentType,\s*\n?\s*sourceId:\s*input\.sourceId,/,
  );
});

test("Report indexer composes title from displayTitleSnapshot ?? evidence.title ?? filename fallbacks", () => {
  assert.match(
    ARTIFACT_INDEXER,
    /row\.displayTitleSnapshot \?\?[\s\S]{0,200}?row\.evidence\.title \?\?[\s\S]{0,200}?row\.evidence\.displayFileName \?\?[\s\S]{0,200}?row\.evidence\.originalFileName \?\?/,
  );
});

test("Package indexer synthesises a meaningful title from evidence filename + package version", () => {
  assert.match(
    ARTIFACT_INDEXER,
    /`\$\{evidenceName\} — Verification Package v\$\{row\.version\}`/,
  );
});

test("Note indexer uses the comment's body first-line as the title and indexes the full body", () => {
  // Just pin the canonical first-line extraction + full-body
  // indexing — the exact regex literal escaping is unstable to
  // pin verbatim.
  assert.match(ARTIFACT_INDEXER, /const firstLine = row\.body\.split\(/);
  assert.match(ARTIFACT_INDEXER, /const searchableText = clip\(row\.body, MAX_BODY\)/);
});

test("Report / Package indexer deletes the projection row when source evidence is deleted (anti-zombie)", () => {
  assert.match(
    ARTIFACT_INDEXER,
    /row\.evidence\.deletedAt[\s\S]{0,400}?deleteMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*teamId:\s*row\.evidence\.teamId,\s*\n?\s*documentType:\s*"REPORT"/,
  );
  assert.match(
    ARTIFACT_INDEXER,
    /row\.evidence\.deletedAt[\s\S]{0,400}?deleteMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*teamId:\s*row\.evidence\.teamId,\s*\n?\s*documentType:\s*"PACKAGE"/,
  );
});

// ===========================================================================
// Lifecycle hooks: note add + note delete
// ===========================================================================

test("addCaseComment service inline-indexes the new note + re-indexes the parent case", () => {
  // Anchor: the createComment service file. Both indexCalls live
  // inside the same closure right after the create.
  assert.match(
    LIFECYCLE,
    /client\.caseComment\.create\([\s\S]{0,2000}?indexNote\(\{ noteId: row\.id \}, client\)/,
  );
  assert.match(
    LIFECYCLE,
    /client\.caseComment\.create\([\s\S]{0,2400}?indexCase\(\s*\n?\s*\{ teamId: existing\.teamId!, caseId: existing\.id \},/,
  );
});

test("deleteCaseComment service drops the NOTE projection row + re-indexes the parent case", () => {
  assert.match(
    LIFECYCLE,
    /client\.caseComment\.delete\([\s\S]{0,800}?deleteMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*teamId:\s*existing\.teamId!,\s*\n?\s*documentType:\s*"NOTE",/,
  );
  assert.match(
    LIFECYCLE,
    /client\.caseComment\.delete\([\s\S]{0,1500}?indexCase\(\s*\n?\s*\{ teamId: existing\.teamId!, caseId: existing\.caseId \},/,
  );
});

// ===========================================================================
// Reconcile endpoint extension
// ===========================================================================

test("Reconcile endpoint queries orphans for REPORT / PACKAGE / NOTE in addition to evidence + cases", () => {
  // Each query uses the document-type literal as the LEFT JOIN
  // filter. Pin all three new ones.
  assert.match(SEARCH_ROUTES, /document_type = 'REPORT'/);
  assert.match(SEARCH_ROUTES, /document_type = 'PACKAGE'/);
  assert.match(SEARCH_ROUTES, /document_type = 'NOTE'/);
});

test("Reconcile endpoint response carries per-type orphan/indexed/failed counters for all five types", () => {
  for (const block of [
    "evidence: {",
    "cases: {",
    "reports: {",
    "packages: {",
    "notes: {",
  ]) {
    assert.ok(
      SEARCH_ROUTES.includes(block),
      `reconcile response must include ${block}`,
    );
  }
});

// ===========================================================================
// Backfill script extension
// ===========================================================================

test("Backfill script supports --all flag and routes through every indexer", () => {
  assert.match(BACKFILL, /--all/);
  assert.match(
    BACKFILL,
    /for \(const kind of \["REPORT", "PACKAGE", "NOTE"\] as const\)/,
  );
  assert.match(BACKFILL, /await indexReport\(/);
  assert.match(BACKFILL, /await indexPackage\(/);
  assert.match(BACKFILL, /await indexNote\(/);
});

// ===========================================================================
// Frontend: typeahead UI
// ===========================================================================

test("Search input is wrapped in a positioned container and the SearchTypeahead dropdown is mounted alongside", () => {
  // REDESIGN/SEARCH — the anchor moved off an inline
  // `style={{ position: "relative", flex: 1 }}` wrapper and onto the
  // canonical `.search-form__field` class, which declares `position: relative`
  // in search.css. The invariant is unchanged: ONE positioned wrapper holds
  // both the <input> and the dropdown, so the typeahead cannot detach from
  // the field it belongs to.
  assert.match(
    SEARCH_PAGE,
    /className="search-form__field">[\s\S]{0,900}<input/,
  );
  assert.match(SEARCH_PAGE, /<SearchTypeahead\b/);
  // …and the positioning is really declared, not merely named.
  assert.match(SEARCH_CSS, /\.search-form__field \{[^}]*position: relative;/);
});

test("Search input has aria-autocomplete='list' and aria-expanded driven by suggestOpen", () => {
  assert.match(SEARCH_PAGE, /aria-autocomplete="list"/);
  assert.match(SEARCH_PAGE, /aria-expanded=\{suggestOpen\}/);
});

test("Search input wires ArrowUp / ArrowDown / Enter / Escape via onKeyDown", () => {
  // Anchor on the onKeyDown handler shape — all four keys appear.
  assert.match(SEARCH_PAGE, /onKeyDown=\{\(e\) => \{/);
  for (const key of ['"ArrowDown"', '"ArrowUp"', '"Enter"', '"Escape"']) {
    assert.ok(
      SEARCH_PAGE.includes(key),
      `search input keyboard handler must cover ${key}`,
    );
  }
});

test("Recent searches use a per-workspace localStorage key and cap at 10 entries", () => {
  // PHASE 12 REMEDIATION — WEB-002 (2026-08-06). INTENTIONAL CONTRACT CHANGE.
  //
  //   OLD: `const recentKey = \`proovra:search:recent:${teamId}\`;`
  //   NEW: `const recentKey = tenantStorageKey(teamId ?? null, "search:recent");`
  //
  // WHY the production architecture requires it: the old key WAS
  // workspace-scoped, so there was never a cross-tenant leak — but it lived
  // in its own namespace, outside the canonical
  // `proovra:tenant:<workspaceId>:<key>` namespace that `tenantStorageKey`
  // owns. A tenant-scoped purge iterates the canonical namespace, so it
  // walked straight past this entry: switching or leaving a workspace
  // cleared every other tenant-scoped draft and left the search history
  // behind on the device.
  //
  // The property this test exists for — PER-WORKSPACE scoping, capped at 10
  // — is unchanged and asserted below, now against the canonical helper. A
  // one-time migration off the legacy key is also pinned, so an existing
  // user keeps their history AND the stray key stops surviving purges.
  assert.match(
    SEARCH_PAGE,
    /const recentKey = tenantStorageKey\(teamId \?\? null, "search:recent"\);/,
  );
  assert.match(
    SEARCH_PAGE,
    /import \{ tenantStorageKey \} from "\.\.\/\.\.\/\.\.\/lib\/platform-context\/tenantStorage";/,
  );
  // Legacy-key migration: read once, rewrite canonically, then remove.
  assert.match(SEARCH_PAGE, /const legacyRecentKey = `proovra:search:recent:\$\{teamId\}`;/);
  assert.match(SEARCH_PAGE, /window\.localStorage\.removeItem\(legacyRecentKey\)/);
  assert.match(SEARCH_PAGE, /\.slice\(0, 10\)/);
});

test("submitQuery pushes the trimmed query onto recents", () => {
  assert.match(
    SEARCH_PAGE,
    /updateFilter\(\{ q: trimmed\.length > 0 \? trimmed : undefined \}\);\s*\n?\s*pushRecent\(trimmed\);/,
  );
});

test("Suggest endpoint is called debounced + abortable, only for queries ≥ 2 chars", () => {
  assert.match(SEARCH_PAGE, /if \(trimmed\.length < 2\) \{\s*\n?\s*setSuggestions\(\[\]\);\s*\n?\s*return;\s*\n?\s*\}/);
  assert.match(SEARCH_PAGE, /window\.setTimeout\(async \(\) => \{/);
  assert.match(SEARCH_PAGE, /new AbortController\(\)/);
  assert.match(SEARCH_PAGE, /\/v1\/search\/suggest\?teamId=/);
});

test("SearchTypeahead renders three labelled sections (recent / suggestions / empty hint)", () => {
  assert.match(SEARCH_PAGE, /data-search-typeahead\b/);
  assert.match(SEARCH_PAGE, /data-search-typeahead-recent\b/);
  assert.match(SEARCH_PAGE, /data-search-typeahead-suggestions\b/);
  assert.match(SEARCH_PAGE, /data-search-typeahead-empty\b/);
});

test("SearchTypeahead Clear-recent button uses onMouseDown (so it fires before the input's blur closes the dropdown)", () => {
  // Pin the prevent-default-on-mousedown pattern itself. The previous version
  // anchored on the wording of the comment above it, which made a comment edit
  // look like a behaviour regression.
  assert.match(
    SEARCH_PAGE,
    /onMouseDown=\{\(e\) => \{[\s\S]{0,400}?e\.preventDefault\(\);[\s\S]{0,200}?onClearRecent\(\)/,
  );
  // Every commit path in the list must do the same, or a mouse pick on a
  // suggestion is swallowed by the input's blur.
  const picks = [...SEARCH_PAGE.matchAll(/onMouseDown=\{\(e\) => \{/g)];
  assert.ok(picks.length >= 3, "recent rows, suggestion rows and Clear all need it");
});

test("SearchTypeahead suggestion rows badge each suggestion with its documentType", () => {
  assert.match(
    SEARCH_PAGE,
    /data-search-typeahead-suggestion-type=\{\w+\.documentType\}/,
  );
  // …and the visible chip states the kind in the same words the result rows
  // use, rather than echoing the raw wire enum.
  assert.match(
    SEARCH_PAGE,
    /DOCUMENT_TYPE_LABEL\[\w+\.documentType\] \?\? \w+\.documentType/,
  );
});
