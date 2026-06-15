/**
 * Phase CASES-PERSONAL-UX-CLEANUP — surface contract for the
 * simplified Cases experience. Source-pinned so every assertion
 * lives in compiled code, not in a runtime DOM. Covers:
 *
 *   - Cases list: no chip strip rendered. The legacy
 *     `data-matter-queue-filter` chips and the prior 6-chip
 *     toolbar are gone. The list page exposes only Search,
 *     Status filter, Create Case, cards, count, and empty
 *     states.
 *
 *   - Case Overview: no duplicate-nav CTA card. The "Open
 *     evidence list" / "Open reports & packages" buttons that
 *     duplicated the tab strip have been removed.
 *
 *   - Settings status: a single Archive ↔ Restore button at any
 *     time. No "Move to Investigating / On Hold / Resolved" or
 *     "Close case" buttons render. (The Archive ↔ Restore
 *     contract itself is pinned by
 *     `case-archive-restore.test.ts`.)
 *
 *   - Remove from case: enabled regardless of `linkId` —
 *     depends only on `viewer.canUnlinkEvidence ||
 *     viewer.canUnlinkLegacyEvidence`. Legacy `Evidence.caseId`
 *     attachments unlink through the same DELETE route.
 *
 *   - Notes: delete-own-note is wired end-to-end. Frontend
 *     renders a Delete button only on the viewer's own notes;
 *     it calls DELETE /v1/cases/:id/comments/:commentId via
 *     the canonical confirm modal. Backend route gates on
 *     case-member access AND author identity, returning 403
 *     `comment_forbidden` for non-authors.
 *
 *   - No `window.confirm` reintroduced anywhere.
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

const CASES_INDEX = src(
  "apps/web/components/cases-experience/CasesIndex.tsx",
);
const SIMPLE_DETAIL = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const LIFECYCLE = src(
  "services/api/src/services/cases/case-lifecycle.service.ts",
);
const CASE_WORKSPACE_ROUTE = src(
  "services/api/src/routes/case-workspace.routes.ts",
);

// ===========================================================================
// Cases list — chip strip removed
// ===========================================================================

test("Cases list no longer renders ANY of the legacy filter-chip data attributes", () => {
  // The chip strip rendered a `data-matter-queue-filter=<key>`
  // attribute per chip via the FilterToggle helper. Both the chips
  // and the helper itself are gone.
  assert.doesNotMatch(CASES_INDEX, /data-matter-queue-filter=\{/);
  assert.doesNotMatch(CASES_INDEX, /data-matter-queue-filter="[a-z-]+"/);
});

test("Cases list no longer defines the FilterToggle component (dead-code removed)", () => {
  // Anti-regression: the FilterToggle component (and the
  // `cases-filter-chip` class string it owned) used to be defined
  // even after the chips were removed. It must not come back.
  assert.doesNotMatch(CASES_INDEX, /function FilterToggle\(/);
  assert.doesNotMatch(CASES_INDEX, /className=`cases-filter-chip /);
});

test("Cases list still wires the canonical search + status + create + cards path (smoke)", () => {
  // Anti-regression: removing the chips must not collapse the
  // shipped controls.
  assert.match(CASES_INDEX, /data-matter-queue-search-input/);
  assert.match(CASES_INDEX, /data-matter-queue-status-select/);
  assert.match(CASES_INDEX, /data-create-case-trigger/);
});

// ===========================================================================
// Case Overview — duplicate-nav CTA card removed
// ===========================================================================

test("Case Overview no longer renders the duplicate-nav CTA card", () => {
  // The old Overview tab bottom card duplicated the tab strip with
  // "Open evidence list" / "Open reports & packages" links. Both
  // must be gone.
  assert.doesNotMatch(SIMPLE_DETAIL, /Open evidence list/);
  assert.doesNotMatch(SIMPLE_DETAIL, /Open reports & packages/);
  // The associated `onGoTo*` callback wiring on OverviewTab is also
  // gone (props removed).
  assert.doesNotMatch(SIMPLE_DETAIL, /onGoToEvidence/);
  assert.doesNotMatch(SIMPLE_DETAIL, /onGoToReports/);
});

// ===========================================================================
// Settings status — no legacy ladder
// ===========================================================================

test("Settings status section no longer renders any `Move to <X>` button", () => {
  for (const banned of [
    "Move to Investigating",
    "Move to On Hold",
    "Move to Resolved",
    "Move to Closed",
    "Close case",
  ]) {
    assert.doesNotMatch(SIMPLE_DETAIL, new RegExp(banned));
  }
});

test("Settings status section is one <select> dropdown (Phase CASES-STATUS-MANUAL)", () => {
  // Phase CASES-STATUS-MANUAL folded the prior Archive/Restore
  // buttons into the canonical status dropdown. The two
  // dedicated data-attributes are gone; their replacement is a
  // single `data-simple-case-settings-status-select` <select>.
  assert.doesNotMatch(SIMPLE_DETAIL, /data-simple-case-settings-status-archive/);
  assert.doesNotMatch(SIMPLE_DETAIL, /data-simple-case-settings-status-restore/);
  assert.match(SIMPLE_DETAIL, /data-simple-case-settings-status-select/);
});

// ===========================================================================
// Remove from case — works for both attachment paths
// ===========================================================================

test("Remove-from-case enable check depends ONLY on viewer.canUnlink* (legacy attachments must work)", () => {
  // Personal users typically attach evidence via the legacy
  // `Evidence.caseId` column (so `link.id` is null on the
  // envelope). The frontend must NOT short-circuit on `linkId ===
  // null` because the backend DELETE route handles BOTH paths.
  // Source-pin: the disable predicate is the viewer flag pair.
  assert.match(
    SIMPLE_DETAIL,
    /!\(\s*\n?\s*viewer\.canUnlinkEvidence \|\|\s*\n?\s*viewer\.canUnlinkLegacyEvidence\s*\n?\s*\)/,
  );
  // Anti-regression: the prior defensive `item.linkId === null`
  // disable must be gone.
  assert.doesNotMatch(
    SIMPLE_DETAIL,
    /item\.linkId === null \|\| !viewer\.canUnlinkEvidence/,
  );
});

test("Remove-from-case DELETE still targets /v1/cases/:id/evidence/:evidenceId (single canonical route)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence\/\$\{evidenceId\}`,\s*\{\s*\n?\s*method: "DELETE",\s*\n?\s*\}\)/,
  );
});

// ===========================================================================
// Notes — delete-own-note (backend route + frontend UI + audit)
// ===========================================================================

test("Backend route DELETE /v1/cases/:id/comments/:commentId is registered with the canonical mutation gate", () => {
  // Same `gateCaseMutation("COMMENT", ...)` predicate used by every
  // other comment-side mutation. Author-only enforcement happens
  // inside the service layer (see `comment_forbidden` test below),
  // not as a parallel auth surface.
  assert.match(
    CASE_WORKSPACE_ROUTE,
    /app\.delete\(\s*\n?\s*"\/v1\/cases\/:id\/comments\/:commentId",[\s\S]{0,1500}?gateCaseMutation\(\s*\n?\s*reply,\s*\n?\s*"COMMENT"/,
  );
  // The route delegates to the dedicated service function — no
  // inline Prisma delete that would bypass the author check.
  assert.match(CASE_WORKSPACE_ROUTE, /deleteCaseComment\(\{/);
});

test("Backend service rejects non-authors with `comment_forbidden` (mapped to HTTP 403)", () => {
  // Author predicate lives on the service so the same rule fires
  // from any caller (route, test, future surface).
  assert.match(
    LIFECYCLE,
    /export async function deleteCaseComment[\s\S]{0,800}?existing\.authorUserId !== input\.actorUserId[\s\S]{0,200}?comment_forbidden/,
  );
  // The HTTP mapping is owned by handleCaseError → 403.
  assert.match(
    CASE_WORKSPACE_ROUTE,
    /comment_forbidden[\s\S]{0,200}?403/,
  );
});

test("Backend service emits a `cases.comment_deleted` audit event on success", () => {
  // Reuses the canonical appendPlatformAuditLog helper (no
  // parallel logger).
  assert.match(
    LIFECYCLE,
    /action:\s*"cases\.comment_deleted",\s*\n?\s*category:\s*"cases\.lifecycle"/,
  );
});

test("Frontend NotesTab renders a Delete button only on the viewer's own notes", () => {
  // The per-row Delete button is gated on `c.authorUserId ===
  // viewerUserId`. Pin the gate so a refactor can't widen the
  // affordance to other users' notes.
  assert.match(
    SIMPLE_DETAIL,
    /c\.authorUserId === viewerUserId \? \(\s*\n?\s*<button[\s\S]{0,400}?data-simple-case-notes-delete=\{c\.id\}/,
  );
});

test("Frontend NotesTab Delete uses the canonical useConfirmAction modal with the spec-locked copy", () => {
  assert.match(
    SIMPLE_DETAIL,
    /const ok = await confirm\(\{\s*\n?\s*title:\s*"Delete this note\?"[\s\S]{0,500}?confirmLabel:\s*"Delete note",\s*\n?\s*tone:\s*"danger",\s*\n?\s*testId:\s*"simple-case-notes-delete"/,
  );
});

test("Frontend NotesTab Delete posts DELETE to /v1/cases/:id/comments/:commentId (no parallel endpoint)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/comments\/\$\{commentId\}`,\s*\{\s*\n?\s*method:\s*"DELETE",\s*\n?\s*\}\)/,
  );
});

// ===========================================================================
// No window.confirm anywhere on this surface
// ===========================================================================

test("No window.confirm / globalThis.confirm reintroduced on the simplified Case Detail surface", () => {
  assert.doesNotMatch(SIMPLE_DETAIL, /window\.confirm\(/);
  assert.doesNotMatch(SIMPLE_DETAIL, /globalThis\.confirm\(/);
});

test("No window.confirm / globalThis.confirm reintroduced on the Cases list surface", () => {
  assert.doesNotMatch(CASES_INDEX, /window\.confirm\(/);
  assert.doesNotMatch(CASES_INDEX, /globalThis\.confirm\(/);
});
