/**
 * Filter wire audit + per-type truthful empty-state.
 *
 * The bug the user surfaced: searching by an evidence filename
 * returns results (REPORT/PACKAGE rows that reference the
 * filename), but selecting the Evidence document-type filter
 * makes the rows disappear AND the UI says "Search index
 * preparing (0/N)". The previous fix corrected the empty-state
 * wording but did not explain why — for production users whose
 * `evidence_search_documents` table has REPORT/PACKAGE rows but
 * zero EVIDENCE rows, the Evidence filter genuinely returns 0,
 * and the UI must say so honestly.
 *
 * These tests pin the per-type truthful copy + the queryProbe
 * refresh contract that makes it possible.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/search/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// reloadHealth signature — accepts a probe query
// ============================================================================

test("reloadHealth callback now accepts an optional probe query and forwards it to /v1/search/diagnostics", () => {
  const src = read(PAGE);
  // The callback signature must declare `probeQuery?: string` and
  // append it to the diagnostics URL via URLSearchParams.
  assert.match(
    src,
    /const reloadHealth = useCallback\(\s*\(probeQuery\?: string\) =>/,
  );
  // The fetch URL builder threads `q` into the URL when the probe
  // query is non-empty, bounded to 200 chars to match the backend
  // Zod schema.
  const fnIdx = src.indexOf("const reloadHealth = useCallback(");
  const window = src.slice(fnIdx, fnIdx + 1500);
  assert.match(window, /params\.set\("q",/);
  assert.match(window, /slice\(0, 200\)/);
});

test("after a search returns, the page refetches diagnostics with the current `q` when the probe is stale", () => {
  const src = read(PAGE);
  // The .then() handler that consumes a search result must compare
  // the cached probe `q` to the live filter `q` and call
  // reloadHealth(filter.q) when they diverge — so queryProbe stays
  // fresh for the per-type empty-state branch.
  const idx = src.indexOf(".then((r)");
  assert.ok(idx > 0, "search-result handler missing");
  const window = src.slice(idx, idx + 3500);
  assert.match(window, /searchHealth\?\.queryProbe\?\.q/);
  assert.match(window, /probeStale/);
  assert.match(window, /reloadHealth\(filter\.q\)/);
});

// ============================================================================
// describeFilterEmpty — the truthful per-type copy
// ============================================================================

test("describeFilterEmpty helper exists and ships per-type truthful copy when only the type filter narrowed", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /function describeFilterEmpty\(\s*filter: FilterState \| null,\s*health: SearchDiagnostics \| null,\s*\)/,
  );
  // Pin the contradiction-aware headline shape — when the selected
  // types matched 0 but other types matched, the message names
  // both sides.
  assert.match(src, /No \$\{selectedLabels\} records match/);
  assert.match(
    src,
    /\$\{otherLabels\} records DID match your search/,
  );
  // And the generic fallback survives.
  assert.match(src, /No matches with the current filters/);
});

test("describeFilterEmpty ONLY specialises when documentTypes is the SOLE narrowing dimension", () => {
  const src = read(PAGE);
  // Pin: the helper checks every OTHER narrowing dimension and
  // bails out (returns generic) when any of them is set. The user
  // confusion is specifically the EVIDENCE-filter case; pulling in
  // date / lifecycle / status here would mis-attribute the empty
  // result.
  const fnIdx = src.indexOf("function describeFilterEmpty(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  assert.match(body, /onlyTypeNarrowing/);
  for (const dim of [
    "evidenceTypes",
    "workflowStatuses",
    "reviewStatuses",
    "onLegalHold",
    "exportRestricted",
    "incidentLinked",
    "workflowLinked",
    "contributorScoped",
    "updatedSinceUtc",
    "updatedUntilUtc",
  ]) {
    assert.ok(
      body.includes(dim),
      `describeFilterEmpty must check ${dim} to detect type-only narrowing`,
    );
  }
});

test("describeFilterEmpty only uses queryProbe when probe.q matches the live filter.q", () => {
  const src = read(PAGE);
  const fnIdx = src.indexOf("function describeFilterEmpty(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  // The freshness check prevents the helper from showing
  // "REPORT records DID match" copy that was computed for a
  // different query (race between filter change and refetch).
  assert.match(body, /probe\.q === filter\.q/);
});

// ============================================================================
// Empty-state JSX — passes filter + searchHealth to describeFilterEmpty
// ============================================================================

test("no-match-filtered empty-state branch consumes describeFilterEmpty output", () => {
  const src = read(PAGE);
  // The empty-state JSX must call describeFilterEmpty with
  // (filter, searchHealth) and bind both `headline` and `detail`
  // to the rendered text — so a future refactor that drops the
  // helper or hard-codes copy would fail this pin.
  const branchIdx = src.indexOf(
    'data-search-empty-state-kind="no-match-filtered"',
  );
  assert.ok(branchIdx > 0, "no-match-filtered branch missing");
  const before = src.slice(Math.max(0, branchIdx - 1500), branchIdx);
  assert.match(before, /describeFilterEmpty\(filter, searchHealth\)/);
  // The render uses both halves of the returned shape.
  const after = src.slice(branchIdx, branchIdx + 800);
  assert.match(after, /hint\.headline/);
  assert.match(after, /hint\.detail/);
});

// ============================================================================
// Wire-level pins (mirrors the live curl audit recorded in the turn)
// ============================================================================

test("Frontend serialises documentTypes as a comma-joined uppercase string for the API", () => {
  const src = read(PAGE);
  const runIdx = src.indexOf("async function runSearch(");
  const body = src.slice(runIdx, runIdx + 3000);
  assert.match(
    body,
    /qs\.set\("documentTypes", filter\.documentTypes\.join\(","\)\)/,
  );
});

test("DOCUMENT_TYPES catalog matches the backend SEARCH_DOCUMENT_TYPES uppercase enum (no lowercase leakage)", () => {
  const src = read(PAGE);
  // The catalog the filter rail iterates over MUST be uppercase.
  // The page used to support lowercase /v1/search filter values for
  // legacy URLs; pin that no lowercase string literals for
  // EVIDENCE/CASE/REPORT/PACKAGE/NOTE remain as filter values.
  const catalogIdx = src.indexOf("const DOCUMENT_TYPES: DocumentType[] = [");
  const catalog = src.slice(catalogIdx, catalogIdx + 400);
  assert.match(catalog, /"EVIDENCE"/);
  assert.match(catalog, /"CASE"/);
  assert.match(catalog, /"REPORT"/);
  assert.match(catalog, /"PACKAGE"/);
  assert.match(catalog, /"NOTE"/);
  for (const lower of ['"evidence"', '"case"', '"report"', '"package"', '"note"']) {
    assert.ok(
      !catalog.includes(lower),
      `DOCUMENT_TYPES catalog must NOT contain lowercase ${lower}`,
    );
  }
});

test("Per-type empty-state hint uses friendly DOCUMENT_TYPE_LABEL for both selected and matched types", () => {
  const src = read(PAGE);
  const fnIdx = src.indexOf("function describeFilterEmpty(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  // Labels must come from DOCUMENT_TYPE_LABEL, not raw enum
  // values — so the user sees "Evidence" not "EVIDENCE" in the
  // empty-state copy.
  assert.match(body, /DOCUMENT_TYPE_LABEL\[t\]/);
});
