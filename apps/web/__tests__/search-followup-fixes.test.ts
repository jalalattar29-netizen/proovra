/**
 * Search page follow-up — three product/UX fixes pinned end-to-end.
 *
 * Problem 1 — Preview panel "Open …" button.
 *   The inspector must surface a single primary CTA per result type
 *   (Open evidence / Open case / Open report / Open package / Open
 *   note). Previously the only way to navigate was clicking the
 *   monospaced ID under "Pointers", which read as developer surface.
 *
 * Problem 2 — Filter-empty vs index-empty distinction.
 *   When a user applies any non-trivial filter (Evidence, Report,
 *   date range, lifecycle flag, etc.) and the result set comes back
 *   empty, the cause is "the filter narrowed everything away" —
 *   NOT "the workspace is empty" or "the search index is preparing".
 *   The chip + empty-state surface must reflect that.
 *
 * Problem 3 — Saved Views hidden for Personal/SMB users.
 *   The saved-view block is operator chrome; for Personal/SMB it
 *   adds visual noise without value. Gate on the same
 *   `isPlatformAdmin` flag the semantic chip + backfill panel use.
 *   Backend saved-search routes stay untouched.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/search/page.tsx");
const ROUTE = resolve(
  REPO_ROOT,
  "services/api/src/routes/search.routes.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// Problem 1 — Inspector "Open …" primary action button
// ============================================================================

test("Inspector — getOpenAction helper exists and maps every result type to a canonical URL", () => {
  const src = read(PAGE);
  assert.match(src, /function getOpenAction\(/);
  // Five canonical document-type branches.
  assert.match(src, /case "EVIDENCE":/);
  assert.match(src, /case "CASE":/);
  assert.match(src, /case "REPORT":/);
  assert.match(src, /case "PACKAGE":/);
  assert.match(src, /case "NOTE":/);
  // Each label must be the human-readable "Open …" form. After the
  // search-inclusion-audit (trash decision), each label is a
  // ternary on `isInTrash` so the literal "Open evidence" sits on
  // the false branch. Pin both as bare string literals — they
  // appear in the source regardless of the ternary shape.
  assert.match(src, /"Open evidence"/);
  assert.match(src, /"Open case"/);
  assert.match(src, /"Open report"/);
  assert.match(src, /"Open package"/);
  assert.match(src, /"Open note"/);
  // Hrefs hit the existing canonical routes — the trashSuffix is
  // appended as an interpolation, so widen the pin to allow it.
  assert.match(src, /href:\s*`\/evidence\/\$\{row\.evidenceId\}\$\{trashSuffix\}`/);
  assert.match(src, /href:\s*`\/cases\/\$\{row\.caseId\}\$\{trashSuffix\}`/);
});

test("Inspector renders the Open button with data-search-open-action + data-search-open-href attributes", () => {
  const src = read(PAGE);
  // The button is an anchor (native middle-click + cmd-click work).
  assert.match(src, /data-search-open-action=\{row\.documentType\}/);
  assert.match(src, /data-search-open-href=\{openAction\.href\}/);
  // The label binds to openAction.label so the visible text matches
  // the type-specific "Open …" string.
  assert.match(src, /\{openAction\.label\}/);
});

test("Inspector Open button uses a primary-action style (not a pointer-link style)", () => {
  const src = read(PAGE);
  // Find the CSS declaration (NOT the JSX use site) — match the
  // `const inspectorPrimaryButtonStyle: React.CSSProperties = {`
  // line directly.
  const declIdx = src.indexOf(
    "const inspectorPrimaryButtonStyle: React.CSSProperties",
  );
  assert.ok(declIdx > 0, "inspectorPrimaryButtonStyle declaration missing");
  const styleBody = src.slice(declIdx, declIdx + 600);
  assert.match(styleBody, /padding:\s*"8px 14px"/);
  assert.match(styleBody, /fontWeight:\s*600/);
});

// ============================================================================
// Problem 2 — Filter-empty vs index-empty distinction
// ============================================================================

test("hasNarrowingFilters helper exists and excludes 'q' from the filter check", () => {
  const src = read(PAGE);
  assert.match(src, /function hasNarrowingFilters\(filter: FilterState \| null\)/);
  // Slice to the END of the function body — the closing `}` of the
  // helper. Pick the body window using the literal `return false;`
  // sentinel + a small lookahead so the slice stops at that
  // function and never bleeds into the next one (where `filter.q`
  // legitimately appears).
  const fnIdx = src.indexOf("function hasNarrowingFilters(");
  const bodyEnd = src.indexOf("\n}\n", fnIdx);
  assert.ok(bodyEnd > fnIdx, "hasNarrowingFilters body end not found");
  const body = src.slice(fnIdx, bodyEnd);
  assert.match(body, /documentTypes/);
  assert.match(body, /evidenceTypes/);
  assert.match(body, /workflowStatuses/);
  assert.match(body, /reviewStatuses/);
  assert.match(body, /onLegalHold/);
  assert.match(body, /exportRestricted/);
  assert.match(body, /incidentLinked/);
  assert.match(body, /workflowLinked/);
  assert.match(body, /contributorScoped/);
  assert.match(body, /updatedSinceUtc/);
  assert.match(body, /updatedUntilUtc/);
  // Pin that the helper does NOT count `q` as narrowing.
  assert.ok(
    !/filter\.q\b/.test(body),
    "hasNarrowingFilters must NOT consider q a narrowing filter",
  );
});

test("Empty-state branches — hasNarrowingFilters renders the no-match-filtered branch BEFORE empty_workspace/empty_index/partial_index", () => {
  const src = read(PAGE);
  // The branch order matters: the filter-active check must come
  // before the workspace/index health branches, otherwise a
  // user with an EVIDENCE-filter active sees the index-empty copy.
  const filteredIdx = src.indexOf("hasNarrowingFilters(filter) ? (");
  const emptyWorkspaceIdx = src.indexOf(
    'searchHealth?.health === "empty_workspace"',
  );
  const emptyIndexIdx = src.indexOf(
    'searchHealth?.health === "empty_index"',
  );
  assert.ok(filteredIdx > 0, "no-match-filtered branch missing");
  assert.ok(emptyWorkspaceIdx > 0);
  assert.ok(emptyIndexIdx > 0);
  assert.ok(
    filteredIdx < emptyWorkspaceIdx,
    "no-match-filtered must come BEFORE empty_workspace branch",
  );
  assert.ok(
    filteredIdx < emptyIndexIdx,
    "no-match-filtered must come BEFORE empty_index branch",
  );
});

test("Empty-state renders the explicit no-match-filtered kind with a 'clear filters' hint", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-empty-state-kind="no-match-filtered"/);
  assert.match(src, /No matches with the current filters/);
  assert.match(src, /Try clearing one or more filters/);
});

test("Empty-state outer container exposes data-search-empty-state-filters-active so end-to-end can probe state", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /data-search-empty-state-filters-active=\{[^}]*hasNarrowingFilters/,
  );
});

test("Backend health classifier — empty_index now requires indexedTotal === 0, not just indexedEvidence === 0", () => {
  const src = read(ROUTE);
  // The classifier sits inside the GET /v1/search/diagnostics
  // handler. Pin both the source code AND the fact that the new
  // condition uses `indexedTotal`, not `indexedEvidence`, for the
  // empty_index branch.
  const diagIdx = src.indexOf('"/v1/search/diagnostics"');
  assert.ok(diagIdx > 0, "diagnostics route missing");
  // The handler grew with the per-state breakdown
  // (search-inclusion-audit). Widen the slice so we still see the
  // health classifier.
  const handler = src.slice(diagIdx, diagIdx + 14000);
  assert.match(handler, /const health/);
  // The empty_index gate must read indexedTotal === 0.
  // Pin by the ternary shape: ... : indexedTotal === 0 ? "empty_index" : ...
  assert.match(handler, /indexedTotal === 0\s*\?\s*"empty_index"/);
  // And the OLD evidenceIndexed === 0 gate must NOT still be the
  // empty_index trigger (defence in depth — the helper still
  // counts indexedEvidence below for partial_index, that's fine).
  assert.ok(
    !/indexedEvidence === 0\s*\?\s*"empty_index"/.test(handler),
    "stale empty_index gate (indexedEvidence === 0) must be removed",
  );
});

// ============================================================================
// Problem 3 — Saved Views gated on isPlatformAdmin
// ============================================================================

test("Saved views block is gated on isPlatformAdmin (hidden for Personal/SMB users)", () => {
  const src = read(PAGE);
  // The FilterSection label="Saved views" must be wrapped in an
  // isPlatformAdmin ternary, not unconditionally rendered.
  const savedIdx = src.indexOf('<FilterSection label="Saved views">');
  assert.ok(savedIdx > 0, "Saved views FilterSection still rendered");

  // 300-char window before the FilterSection must contain the gate.
  const window = src.slice(Math.max(0, savedIdx - 300), savedIdx);
  assert.match(window, /isPlatformAdmin\s*\?/);
});

test("Saved Views backend fetch still runs unconditionally (so an upgrade does not require a refresh)", () => {
  const src = read(PAGE);
  // The /v1/search/saved-views fetch is in a useEffect keyed on
  // teamId — pin that the fetch site itself is still present + is
  // NOT inside an isPlatformAdmin guard.
  const fetchIdx = src.indexOf("/v1/search/saved-views?teamId=");
  assert.ok(fetchIdx > 0, "saved-views fetch site missing");
  // The 1 KiB preceding the fetch must NOT contain isPlatformAdmin
  // (the gate is on render, not fetch).
  const beforeFetch = src.slice(Math.max(0, fetchIdx - 1000), fetchIdx);
  assert.ok(
    !/isPlatformAdmin[\s\S]{0,300}apiFetch\($/.test(beforeFetch),
    "fetch must remain unconditional",
  );
});

test("Sort param is passed through runSearch to the API query string", () => {
  const src = read(PAGE);
  // Pin runSearch still threads filter.sort into the URL.
  const runIdx = src.indexOf("async function runSearch(");
  assert.ok(runIdx > 0);
  const body = src.slice(runIdx, runIdx + 3000);
  assert.match(body, /qs\.set\("sort", filter\.sort\)/);
});

test("Date range filters are passed as updatedSinceUtc / updatedUntilUtc with bare ISO strings", () => {
  const src = read(PAGE);
  const runIdx = src.indexOf("async function runSearch(");
  const body = src.slice(runIdx, runIdx + 3000);
  assert.match(body, /qs\.set\("updatedSinceUtc", filter\.updatedSinceUtc\)/);
  assert.match(body, /qs\.set\("updatedUntilUtc", filter\.updatedUntilUtc\)/);
});

test("documentTypes filter is serialized with the uppercase enum value (not lowercase)", () => {
  const src = read(PAGE);
  // The DOCUMENT_TYPES catalog must be uppercase to match the
  // backend SEARCH_DOCUMENT_TYPES enum. Pin the array.
  assert.match(src, /const DOCUMENT_TYPES: DocumentType\[\] = \[/);
  assert.match(src, /"EVIDENCE"/);
  assert.match(src, /"CASE"/);
  assert.match(src, /"REPORT"/);
  assert.match(src, /"PACKAGE"/);
  assert.match(src, /"NOTE"/);
  // Hard pin: there are no lowercase "evidence" / "case" string
  // literals being used as filter values.
  const lowercaseLiterals = [
    /"evidence",\s*\n/,
    /"case",\s*\n/,
    /"report",\s*\n/,
    /"package",\s*\n/,
  ];
  for (const re of lowercaseLiterals) {
    assert.ok(
      !re.test(src),
      `unexpected lowercase document-type literal: ${re}`,
    );
  }
});

test("documentTypes is serialized to a comma-joined uppercase string in the URL", () => {
  const src = read(PAGE);
  const runIdx = src.indexOf("async function runSearch(");
  const body = src.slice(runIdx, runIdx + 3000);
  assert.match(
    body,
    /qs\.set\("documentTypes", filter\.documentTypes\.join\(",",?\s*\)\)/,
  );
});
