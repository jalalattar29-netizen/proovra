/**
 * Phase CASES-ATTACH-PICKER — Case Detail Add evidence flow.
 * Pins:
 *
 *   1. Page-level `attachOpen` state owns the modal. The header
 *      "Add evidence" button opens it (no longer just switches
 *      tabs).
 *
 *   2. Exactly one Add evidence affordance exists on the surface
 *      — the header. The previous in-tab and empty-state Add
 *      evidence buttons are gone (data-attributes
 *      `data-simple-case-attach-trigger` and
 *      `data-simple-case-attach-empty` no longer exist).
 *
 *   3. Empty-state copy points users to the header CTA: "Use Add
 *      evidence above to link files, photos, videos, or documents
 *      to this case."
 *
 *   4. The legacy native `<select>` picker is gone. The picker is
 *      now a searchable dialog with a search input, a row list,
 *      per-row Select buttons, and a footer "Link selected
 *      evidence" button gated on selection.
 *
 *   5. Picker rows render the canonical `getDisplayTitle()`
 *      output, never the raw `${type} — ${status} — ${shortId}`
 *      string the old select used.
 *
 *   6. Backend `GET /v1/cases/:id/available-evidence` exposes the
 *      filename fields the picker needs (additive — every prior
 *      field still emitted) AND filters out archived evidence in
 *      addition to the existing deleted/attached filters.
 *
 *   7. Attach POST stays on `POST /v1/cases/:id/evidence` with
 *      `{ evidenceId }` — the route's cross-team guard
 *      (`evaluateCrossTeamAttach`) is the authority for security.
 *
 *   8. Remove-from-case wiring is untouched (smoke pin).
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
// Single page-level entry point
// ===========================================================================

test("attachOpen state lives at the page level (not inside EvidenceTab)", () => {
  // The page-level useState declaration must be present.
  assert.match(
    SIMPLE_DETAIL,
    /\/\/ Phase CASES-ATTACH-PICKER[\s\S]{0,800}?const \[attachOpen, setAttachOpen\] = useState\(false\);/,
  );
  // The previous in-tab declaration is gone.
  const tabStart = SIMPLE_DETAIL.indexOf("function EvidenceTab(");
  const tabEnd = SIMPLE_DETAIL.indexOf("\nfunction ", tabStart + 1);
  const tabBody = SIMPLE_DETAIL.slice(tabStart, tabEnd);
  assert.doesNotMatch(tabBody, /const \[attachOpen, setAttachOpen\] = useState/);
});

test("Header 'Add evidence' button opens the modal (not just switches tab)", () => {
  // The header mount passes `setAttachOpen(true)` as onAddEvidence.
  assert.match(
    SIMPLE_DETAIL,
    /<SimpleCaseHeader[\s\S]{0,600}?onAddEvidence=\{\(\) => setAttachOpen\(true\)\}/,
  );
  // Anti-regression: the previous "switch to evidence tab" handler
  // is gone (that's what made the button feel dead).
  assert.doesNotMatch(
    SIMPLE_DETAIL,
    /onAddEvidence=\{\(\) => setActiveTab\("evidence"\)\}/,
  );
});

test("Header 'Add evidence' button is gated on viewer.canLinkEvidence", () => {
  assert.match(
    SIMPLE_DETAIL,
    /canLinkEvidence=\{viewer\.canLinkEvidence\}/,
  );
  // The button JSX uses the prop.
  assert.match(
    SIMPLE_DETAIL,
    /disabled=\{!canLinkEvidence\}[\s\S]{0,200}?data-simple-case-action="add-evidence"/,
  );
});

test("Exactly one Add evidence trigger exists — header only (duplicates removed)", () => {
  // The duplicate triggers (Evidence tab top-right + empty state)
  // are gone.
  assert.doesNotMatch(SIMPLE_DETAIL, /data-simple-case-attach-trigger/);
  // Match `data-simple-case-attach-empty` ONLY when not followed
  // by `-list` (the legitimate empty-state copy inside the modal).
  assert.doesNotMatch(SIMPLE_DETAIL, /data-simple-case-attach-empty(?!-list)/);
  // The single header trigger is still rendered.
  assert.match(SIMPLE_DETAIL, /data-simple-case-action="add-evidence"/);
});

// ===========================================================================
// Empty-state copy points at the header CTA
// ===========================================================================

test("Empty-state copy points at the header CTA (no in-tab Add button)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /Use <em>Add evidence<\/em> above to link files, photos,\s*\n?\s*videos, or documents to this case\./,
  );
});

// ===========================================================================
// Modal mounted once, at page level
// ===========================================================================

test("AttachEvidenceModal is mounted exactly once — at page level — with onAttached refreshing the page", () => {
  // The page-level mount block uses `evidenceItems` and `reload`
  // (page-scope identifiers). That proves it's not the old in-tab
  // mount.
  assert.match(
    SIMPLE_DETAIL,
    /\{attachOpen \? \(\s*\n?\s*<AttachEvidenceModal[\s\S]{0,1200}?existingEvidenceIds=\{new Set\(evidenceItems\.map[\s\S]{0,1600}?await reload\(\);/,
  );
  // Only one `<AttachEvidenceModal` JSX usage in the whole file.
  const mounts = SIMPLE_DETAIL.match(/<AttachEvidenceModal\b/g) ?? [];
  assert.equal(mounts.length, 1, "AttachEvidenceModal must be mounted exactly once");
});

// ===========================================================================
// Searchable picker — replaces the native <select>
// ===========================================================================

test("Native <select> picker is gone (data-simple-case-attach-select removed) — only `-selected-count` is allowed", () => {
  // The legacy native <select> wore `data-simple-case-attach-select`.
  // The new picker exposes `data-simple-case-attach-selected-count`
  // for the live selection counter — that one is intentional and
  // must not be matched as a regression.
  assert.doesNotMatch(SIMPLE_DETAIL, /data-simple-case-attach-select(?!ed-count)\b/);
});

test("Picker has a real search input (Search evidence by name, type, or record ID)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /placeholder="Search evidence by name, type, or record ID"/,
  );
  assert.match(SIMPLE_DETAIL, /data-simple-case-attach-search/);
});

test("Picker renders one row per candidate via getDisplayTitle (not the raw type — status — shortId string)", () => {
  // Row title is wrapped in a data-attribute marker and renders
  // `getDisplayTitle(c)`.
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-row-title[\s\S]{0,200}?\{getDisplayTitle\(c\)\}/,
  );
  // The old "${c.type} — ${c.status} — ${c.id.slice(0, 8)}"
  // template is gone from the modal.
  assert.doesNotMatch(
    SIMPLE_DETAIL,
    /\{c\.type\} — \{c\.status\} — \{c\.id\.slice\(0,\s*8\)\}/,
  );
});

test("Picker exposes per-row Select buttons + row-click toggle (multi-select)", () => {
  // Row-click TOGGLES selection (multi-select), not assigns.
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-row=\{c\.id\}[\s\S]{0,400}?onClick=\{\(\) => toggleSelected\(c\.id\)\}/,
  );
  // Per-row Select button still present + also toggles.
  assert.match(SIMPLE_DETAIL, /data-simple-case-attach-row-select=\{c\.id\}/);
});

test("Footer confirm button is disabled when no rows are selected and shows a count-aware label", () => {
  // The disabled predicate now reads from `selectedCount`, not
  // a single-string selection. Label varies by count.
  assert.match(
    SIMPLE_DETAIL,
    /disabled=\{selectedCount === 0 \|\| busy\}\s*\n?\s*data-simple-case-attach-confirm/,
  );
  // Single-select label preserved for the 1-selected case.
  assert.match(SIMPLE_DETAIL, /"Link selected evidence"/);
  // Multi-select label includes the count.
  assert.match(
    SIMPLE_DETAIL,
    /`Link \$\{selectedCount\} selected evidence records`/,
  );
});

test("Loading / no-candidates / no-match empty states each have spec-locked copy + data-attributes", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-attach-loading[\s\S]{0,200}?Loading available evidence/);
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-empty-list[\s\S]{0,200}?No available evidence to link\. Upload or capture\s*\n?\s*evidence first, then return to this case\./,
  );
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-attach-no-match[\s\S]{0,200}?No matching evidence found\. Try a different name or\s*\n?\s*record ID\./,
  );
});

test("Search filters by name/type/status/short-id (haystack includes title, displayFileName, originalFileName, id, slice(0,8))", () => {
  // Pin the haystack composition.
  for (const field of [
    "name",
    'c.title ?? ""',
    'c.displayFileName ?? ""',
    'c.originalFileName ?? ""',
    "c.type",
    "c.status",
    "c.id",
    "c.id.slice(0, 8)",
  ]) {
    assert.ok(
      SIMPLE_DETAIL.includes(field),
      `search haystack must include ${field}`,
    );
  }
});

// ===========================================================================
// Attach success/error behaviour
// ===========================================================================

test("Multi-attach fires one POST per selected evidenceId via Promise.allSettled (no batch endpoint exists in backend)", () => {
  // Each selected id is sent to the same single-attach endpoint.
  // The frontend never tries to invent a batch endpoint.
  assert.match(
    SIMPLE_DETAIL,
    /Promise\.allSettled\(\s*\n?\s*ids\.map\(\(evidenceId\) =>\s*\n?\s*apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ evidenceId \}\),/,
  );
});

test("Successful rows are removed from the selection so the user can retry only failed rows", () => {
  // Anti-regression: a partial-success run must drop the
  // fulfilled ids from selectedIds (so the next click only
  // retries the failures).
  assert.match(
    SIMPLE_DETAIL,
    /setSelectedIds\(\(prev\) => \{\s*\n?\s*const next = new Set\(prev\);\s*\n?\s*results\.forEach\(\(r, idx\) => \{\s*\n?\s*if \(r\.status === "fulfilled"\) next\.delete\(ids\[idx\]\);/,
  );
});

test("Page-level onAttached receives {succeeded, failed} and renders count-aware toasts", () => {
  // The page-side handler branches on count to choose the right
  // toast: success / partial / all-failed.
  assert.match(
    SIMPLE_DETAIL,
    /onAttached=\{async \(\{ succeeded, failed \}\) => \{/,
  );
  // Single + multi success messages.
  assert.match(SIMPLE_DETAIL, /"Evidence linked to case\."/);
  assert.match(
    SIMPLE_DETAIL,
    /`\$\{succeeded\} evidence records linked to case\.`/,
  );
  // Partial-failure message.
  assert.match(
    SIMPLE_DETAIL,
    /linked\. \$\{failed\} could not be linked\./,
  );
});

test("All-failed run keeps the dialog open (so the user can retry without losing selection)", () => {
  // Pin the early-return inside the guard. The dialog close
  // (`setAttachOpen(false)`) lives AFTER the guard so it only
  // runs when at least one attach succeeded.
  assert.match(
    SIMPLE_DETAIL,
    /if \(succeeded === 0 && failed > 0\) \{[\s\S]{0,800}?return;\s*\n?\s*\}/,
  );
  // Sanity: setAttachOpen(false) appears AFTER the guard so the
  // close-dialog path is gated by "at least one succeeded".
  const guardIdx = SIMPLE_DETAIL.indexOf("if (succeeded === 0 && failed > 0)");
  const closeIdx = SIMPLE_DETAIL.indexOf("setAttachOpen(false);", guardIdx);
  assert.ok(closeIdx > guardIdx, "setAttachOpen(false) must come after the all-failed guard");
});

// ===========================================================================
// Backend additive extension
// ===========================================================================

test("Backend /v1/cases/:id/available-evidence selects the filename fields the picker needs", () => {
  // Anchor on the available-evidence route and look at the
  // immediately-following findMany select block.
  const start = CASES_ROUTES.indexOf('"/v1/cases/:id/available-evidence"');
  assert.ok(start > 0, "available-evidence route not found");
  const window = CASES_ROUTES.slice(start, start + 5000);
  for (const field of [
    "title: true",
    "displayFileName: true",
    "originalFileName: true",
    "mimeType: true",
    "verificationStatus: true",
    "latestReportVersion: true",
    "verificationPackageVersion: true",
    "_count: { select: { parts: true } }",
  ]) {
    assert.ok(
      window.includes(field),
      `available-evidence select must include ${field}`,
    );
  }
});

test("Backend /v1/cases/:id/available-evidence now also excludes archived evidence (was previously only deleted + attached)", () => {
  const start = CASES_ROUTES.indexOf('"/v1/cases/:id/available-evidence"');
  const window = CASES_ROUTES.slice(start, start + 2000);
  // The where-clause must include all three lifecycle filters.
  assert.match(window, /deletedAt: null/);
  assert.match(window, /archivedAt: null/);
  assert.match(window, /caseId: null/);
});

test("Backend /v1/cases/:id/available-evidence response shape stays backward-compatible (every prior field is still emitted)", () => {
  const start = CASES_ROUTES.indexOf('"/v1/cases/:id/available-evidence"');
  const window = CASES_ROUTES.slice(start, start + 5000);
  for (const field of [
    "id: e.id",
    "type: String(e.type)",
    "status: String(e.status)",
    "createdAt: e.createdAt.toISOString()",
  ]) {
    assert.ok(
      window.includes(field),
      `available-evidence response must still emit ${field}`,
    );
  }
});

test("Backend /v1/cases/:id/available-evidence keeps owner-scope authorization (cross-workspace blocked at the read layer)", () => {
  const start = CASES_ROUTES.indexOf('"/v1/cases/:id/available-evidence"');
  const window = CASES_ROUTES.slice(start, start + 3000);
  // The handler checks the case belongs to the caller AND filters
  // evidence by that same owner.
  assert.match(window, /caseItem\.ownerUserId !== ownerUserId/);
  assert.match(window, /ownerUserId,\s*\n?\s*deletedAt: null/);
});

// ===========================================================================
// Remove-from-case still works (smoke pin — no regression)
// ===========================================================================

test("Remove-from-case still wired to DELETE /v1/cases/:id/evidence/:evidenceId (no regression)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence\/\$\{evidenceId\}`,\s*\{\s*\n?\s*method: "DELETE",\s*\n?\s*\}\)/,
  );
});

test("Remove-from-case button still rendered + still uses canonical confirm modal", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-evidence-remove=\{item\.id\}/);
  assert.match(SIMPLE_DETAIL, /testId:\s*"simple-case-evidence-remove"/);
});
