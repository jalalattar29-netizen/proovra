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
const SEARCH_STATES = src(
  "apps/web/app/(app)/search/components/SearchStates.tsx",
);
const SEARCH_GUIDANCE = src(
  "apps/web/app/(app)/search/components/SearchGuidance.tsx",
);
const SEARCH_ROUTES = src("services/api/src/routes/search.routes.ts");
const SAVED_SEARCH = src(
  "services/api/src/services/search/saved-search.service.ts",
);
const WORKER = src("services/worker/src/processor.ts");

// ===========================================================================
// Right-rail empty state: PreviewDefault
// ===========================================================================

test("Right-rail renders the guidance column when no result is selected (never a dead gutter)", () => {
  // REDESIGN/SEARCH — `PreviewDefault` is deleted. It rendered the same
  // three ideas the canonical SearchGuidancePanel does — recent searches,
  // saved searches, tips — from ~150 lines of inline styles, in its own
  // typography and its own link colour. The invariant is unchanged: the
  // right rail is useful before a row is selected, and the legacy dead-state
  // copy stays gone.
  assert.match(
    SEARCH_PAGE,
    /\{!selected \? \([\s\S]{0,400}?<SearchGuidancePanel\b/,
  );
  assert.doesNotMatch(
    SEARCH_PAGE,
    /Select a result to inspect pointers and related evidence\./,
  );
  assert.doesNotMatch(SEARCH_PAGE, /function PreviewDefault\(/);
});

test("The guidance column declares three labelled sections plus a support card", () => {
  for (const anchor of [
    "data-search-guidance-recent",
    "data-search-guidance-saved",
    "data-search-guidance-tips",
    "data-search-support-card",
  ]) {
    assert.ok(
      SEARCH_GUIDANCE.includes(anchor),
      `the guidance column must declare ${anchor}`,
    );
  }
  // Each section is named for assistive technology, not just visually.
  for (const id of [
    "search-recent-label",
    "search-saved-label",
    "search-tips-label",
  ]) {
    assert.ok(SEARCH_GUIDANCE.includes(`aria-labelledby="${id}"`));
  }
});

test("Guidance recent block has empty-state copy + Clear gated on count > 0", () => {
  assert.match(SEARCH_GUIDANCE, /data-search-guidance-recent-empty/);
  assert.match(SEARCH_GUIDANCE, /Your recent searches will appear here\./);
  assert.match(
    SEARCH_GUIDANCE,
    /recent\.length > 0 \? \(\s*\n?\s*<button[\s\S]{0,400}?data-search-guidance-clear-recent/,
  );
  // The list is the console's own tenant-scoped store, and clearing it is
  // wired to the same handler that owns that store.
  assert.match(SEARCH_PAGE, /onClearRecent=\{clearRecent\}/);
});

test("Guidance saved block has empty-state copy and states each view's visibility", () => {
  assert.match(SEARCH_GUIDANCE, /data-search-guidance-saved-empty/);
  assert.match(SEARCH_GUIDANCE, /No saved searches yet\./);
  // A TEAM view is visible to the whole workspace; the list says so rather
  // than rendering every entry as if it were private.
  assert.match(SEARCH_GUIDANCE, /view\.visibility === "TEAM" \? "Team" : "Private"/);
  // `null` means not loaded / no authority — distinct from an empty list.
  assert.match(SEARCH_GUIDANCE, /saved === null \|\| saved\.length === 0/);
  assert.match(SEARCH_PAGE, /savedViews === null\s*\n?\s*\? null/);
});

test("Guidance tips block mentions OCR + filenames + filters", () => {
  assert.match(
    SEARCH_GUIDANCE,
    /Search by filename, case name, report title, package, note,/,
  );
  assert.match(
    SEARCH_GUIDANCE,
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
  // REDESIGN/SEARCH — the branch mounts the canonical SearchUnavailableState
  // instead of hand-rolling <strong>…</strong> copy. The invariants are
  // unchanged and stronger: the copy is bounded and lives in one place, and
  // the transport's own message can still never reach the screen.
  assert.match(
    SEARCH_PAGE,
    /data-search-empty-state-kind="error"[\s\S]{0,400}?<SearchUnavailableState/,
  );
  assert.match(
    SEARCH_STATES,
    /title="Search is temporarily unavailable"/,
  );
  // Nothing from the failure envelope is interpolated into this branch.
  const errorBlockStart = SEARCH_PAGE.indexOf(
    'data-search-empty-state-kind="error"',
  );
  const errorBlockEnd = SEARCH_PAGE.indexOf("</div>", errorBlockStart);
  const errorBlock = SEARCH_PAGE.slice(errorBlockStart, errorBlockEnd);
  assert.doesNotMatch(errorBlock, /\{error\}/);
  assert.doesNotMatch(errorBlock, /searchFailure\.message/);
});

test("Connection-failure language is reachable ONLY from a real transport/service failure", () => {
  // A refusal is not an outage. The classifier decides which state is true
  // from the transport's own answer, and only the `unavailable` kind may
  // use connection language — the restricted branch renders a different
  // component entirely, and the outage banner is gated on the same kind.
  assert.match(SEARCH_PAGE, /function classifySearchFailure\(/);
  assert.match(SEARCH_PAGE, /status === 403[\s\S]{0,200}?kind: "restricted"/);
  assert.match(
    SEARCH_PAGE,
    /searchFailure\?\.kind === "unavailable" \? <SearchUnavailableAlert \/> : null/,
  );
  // The copy itself lives on the unavailable state and nowhere else.
  const connectionCopy = [
    ...SEARCH_STATES.matchAll(/secure connection to the data indexing service/g),
  ];
  assert.equal(connectionCopy.length, 1);
  assert.doesNotMatch(SEARCH_PAGE, /could not reach the search service/i);
});

test("Restricted state offers no Retry — retrying the same grant cannot change the answer", () => {
  assert.match(
    SEARCH_PAGE,
    /data-search-empty-state-kind="restricted"[\s\S]{0,300}?<SearchRestrictedState/,
  );
  const start = SEARCH_STATES.indexOf("export function SearchRestrictedState");
  assert.ok(start > 0, "SearchRestrictedState must exist");
  const end = SEARCH_STATES.indexOf("\nexport ", start + 1);
  const body = SEARCH_STATES.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /onRetry|Retry/);
});

test("Pristine empty state fires when there is no query yet, and is not a zero-result answer", () => {
  // REDESIGN/SEARCH — the branch mounts the canonical SearchPristineState.
  // The guard is unchanged; what is pinned additionally is the semantic that
  // motivated the state in the first place: nothing has been ASKED yet, so
  // the copy must not claim a count or a failure.
  assert.match(SEARCH_PAGE, /!filter\?\.q \? \(/);
  assert.match(
    SEARCH_PAGE,
    /<div data-search-empty-state-kind="idle">[\s\S]{0,200}?<SearchPristineState \/>/,
  );
  const start = SEARCH_STATES.indexOf("export function SearchPristineState");
  assert.ok(start > 0, "SearchPristineState must exist");
  const end = SEARCH_STATES.indexOf("\nexport ", start + 1);
  const body = SEARCH_STATES.slice(start, end === -1 ? undefined : end);
  assert.match(body, /kind="pristine"/);
  assert.doesNotMatch(body, /0 results|No matching|unavailable/i);
});

test("Filtered no-match and empty-workspace are distinct states, in that order", () => {
  // With a filter active, "this workspace has no records" is a false
  // explanation for an empty result — the filter is what removed them.
  const filtered = SEARCH_PAGE.indexOf('data-search-empty-state-kind="no-match-filtered"');
  const workspace = SEARCH_PAGE.indexOf('data-search-empty-state-kind="empty-workspace"');
  assert.ok(filtered > 0 && workspace > 0);
  assert.ok(filtered < workspace);
  // They render different components with different words.
  assert.match(
    SEARCH_PAGE,
    /data-search-empty-state-kind="empty-workspace"[\s\S]{0,400}?has no records yet/,
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
