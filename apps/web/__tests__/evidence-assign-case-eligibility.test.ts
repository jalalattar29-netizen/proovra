/**
 * Phase ASSIGN-CASE-ELIGIBILITY — Evidence Detail Assign-to-Case modal.
 *
 * Source-pinned. Asserts:
 *
 *   1. The Evidence Detail page calls
 *      `/v1/cases?eligibleForEvidenceId=<id>` (not the bare
 *      `/v1/cases`) when populating the Assign Case selector.
 *
 *   2. The evidenceId is properly URL-encoded.
 *
 *   3. The Assign Case modal renders the spec-locked empty-state
 *      copy ("No attachable cases are available in this workspace.")
 *      when the server returned an empty list — proving the UI
 *      handles the no-eligibility case cleanly instead of showing
 *      an empty dropdown.
 *
 *   4. The Save assignment button is disabled when there are no
 *      cases at all (cases.length === 0) — defensive belt-and-braces
 *      so a user can't submit the form when the selector is empty.
 *
 *   5. The backend cross-workspace gate is still source-pinned by
 *      the backend test suite (this test only asserts the frontend
 *      stops sending cross-workspace requests in normal use).
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

const DETAIL_PAGE = src("apps/web/app/(app)/evidence/[id]/page.tsx");
const CASES_ROUTES = src("services/api/src/routes/cases.routes.ts");

// ===========================================================================
// Frontend — selector wiring
// ===========================================================================

test("Evidence Detail page requests the eligibility-narrowed case list (not the bare /v1/cases)", () => {
  // The Promise.allSettled pair must call the eligibility URL.
  assert.match(
    DETAIL_PAGE,
    /apiFetch\(\s*\n?\s*`\/v1\/cases\?eligibleForEvidenceId=\$\{encodeURIComponent\(evidenceId\)\}`,?\s*\n?\s*\)/,
  );
});

test("Evidence Detail page no longer calls the unscoped /v1/cases for the Assign Case modal", () => {
  // The old call was `apiFetch("/v1/cases")` — that exact string
  // must not appear inside `loadWorkspace`. We anchor the search
  // to the Promise.allSettled block where the selector is loaded
  // so unrelated cases endpoints (e.g. /v1/cases/:id/...) don't
  // false-match.
  const start = DETAIL_PAGE.indexOf("const [workspaceResult, casesResult] = await Promise.allSettled");
  assert.ok(start > 0, "loadWorkspace Promise.allSettled anchor missing");
  const end = DETAIL_PAGE.indexOf("if (workspaceResult.status !== \"fulfilled\")", start);
  assert.ok(end > start, "loadWorkspace block end anchor missing");
  const block = DETAIL_PAGE.slice(start, end);
  assert.doesNotMatch(block, /apiFetch\("\/v1\/cases"\)/);
});

// ===========================================================================
// Frontend — empty-state copy
// ===========================================================================

test("Assign Case modal renders the spec-locked empty-state copy when cases.length === 0", () => {
  // Find the modal block by its title anchor and assert the empty
  // state appears as a conditional branch.
  const modalStart = DETAIL_PAGE.indexOf('title="Assign evidence to case"');
  assert.ok(modalStart > 0, "Assign Case modal anchor missing");
  const block = DETAIL_PAGE.slice(modalStart, modalStart + 4000);
  assert.match(block, /\{cases\.length === 0 \? \(/);
  assert.match(
    block,
    /No attachable cases are available in this workspace\./,
  );
  assert.match(block, /data-evidence-assign-case-empty/);
});

test("Assign Case modal Save button is disabled when there are no cases", () => {
  const modalStart = DETAIL_PAGE.indexOf('title="Assign evidence to case"');
  const block = DETAIL_PAGE.slice(modalStart, modalStart + 4000);
  // Save assignment must include `cases.length === 0` in its disabled
  // expression so an empty selector cannot submit.
  assert.match(
    block,
    /disabled=\{actionBusy \|\| !selectedCaseId \|\| cases\.length === 0\}/,
  );
  // And the Cancel button still disables itself while a mutation is
  // in flight (consistency with the lifecycle modals from the prior
  // phase).
  assert.match(block, /onClick=\{\(\) => setAssignCaseOpen\(false\)\}\s*\n?\s*disabled=\{actionBusy\}/);
});

test("Assign Case dropdown carries a stable data attribute for E2E", () => {
  assert.match(DETAIL_PAGE, /data-evidence-assign-case-select/);
});

// ===========================================================================
// Backend — cross-workspace gate not weakened (cross-check)
// ===========================================================================

test("Backend attach gate still emits 'Cross-workspace attach is not permitted.' on mismatch", () => {
  assert.match(
    CASES_ROUTES,
    /reply\.code\(403\)\.send\(\{\s*\n?\s*message:\s*"Cross-workspace attach is not permitted\."/,
  );
});

test("Backend evaluateCrossTeamAttach call site still passes both caseTeamId AND evidenceTeamId", () => {
  assert.match(
    CASES_ROUTES,
    /evaluateCrossTeamAttach\(\{\s*\n?\s*caseTeamId: caseItem\.teamId,\s*\n?\s*evidenceTeamId: evidence\.teamId,\s*\n?\s*\}\)/,
  );
});
