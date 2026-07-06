/**
 * Phase CASES-STATUS-MANUAL — single-dropdown status selector for
 * the Personal / Small-Business Case Detail Settings tab.
 *
 * Pins:
 *
 *   1. A single `<select>` exposes all six statuses (Open,
 *      Investigating, On hold, Resolved, Closed, Archived).
 *   2. The dedicated Archive / Restore / Move-to-X buttons that
 *      preceded this dropdown are gone.
 *   3. The dropdown is controlled — its `value` is driven from
 *      `caseDetail.status`, never local state, so a Cancel or
 *      server error reverts the visible selection.
 *   4. On change the canonical `useConfirmAction()` modal opens
 *      with the spec-locked copy ("Change case status", "Change
 *      this case from X to Y? …").
 *   5. The confirm step POSTs to the existing
 *      `/v1/cases/:id/status` endpoint with `{ toStatus }`.
 *   6. On success the toast reads "Case status updated."
 *   7. On error the toast surfaces a clean error message and the
 *      dropdown re-renders to the prior status (no local-state
 *      drift).
 *   8. Helpers expose `CASE_STATUS_OPTIONS` as the canonical
 *      ordered list and `ALLOWED_STATUS_TRANSITIONS` derives from
 *      it (any → any, self-transitions excluded).
 *   9. The user-friendly labels never expose raw enum strings
 *      (no "ON_HOLD" / "OPEN" in JSX text positions).
 *  10. No `window.confirm` reintroduced.
 *  11. The matter-workspace evidence list, reports/packages list,
 *      and notes list are not touched by the status-change handler
 *      (no client-side mutation of those tabs).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ALLOWED_STATUS_TRANSITIONS,
  CASE_STATUS_OPTIONS,
  caseStatusLabel,
} from "../components/cases-experience/simple-case-detail/helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const SIMPLE_DETAIL = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
// Loaded for potential future helper-tier pins; currently unused.
// Prefixed with `_` so the unused-vars rule accepts it without
// reintroducing the import error.
const _HELPERS = src(
  "apps/web/components/cases-experience/simple-case-detail/helpers.ts",
);
void _HELPERS;
const LIFECYCLE = src(
  "services/api/src/services/cases/case-lifecycle.service.ts",
);

// ===========================================================================
// Canonical option list — single source of truth
// ===========================================================================

test("CASE_STATUS_OPTIONS lists exactly the six statuses in canonical order with user-friendly labels", () => {
  assert.deepEqual(
    CASE_STATUS_OPTIONS.map((o) => [o.value, o.label]),
    [
      ["OPEN", "Open"],
      ["INVESTIGATING", "Investigating"],
      ["ON_HOLD", "On hold"],
      ["RESOLVED", "Resolved"],
      ["CLOSED", "Closed"],
      ["ARCHIVED", "Archived"],
    ],
  );
});

test("caseStatusLabel humanises every backend enum value (no raw enum leaks)", () => {
  assert.equal(caseStatusLabel("OPEN"), "Open");
  assert.equal(caseStatusLabel("INVESTIGATING"), "Investigating");
  assert.equal(caseStatusLabel("ON_HOLD"), "On hold");
  assert.equal(caseStatusLabel("RESOLVED"), "Resolved");
  assert.equal(caseStatusLabel("CLOSED"), "Closed");
  assert.equal(caseStatusLabel("ARCHIVED"), "Archived");
});

test("ALLOWED_STATUS_TRANSITIONS is any → any (every status can move to every other status)", () => {
  for (const opt of CASE_STATUS_OPTIONS) {
    const targets = ALLOWED_STATUS_TRANSITIONS[opt.value] ?? [];
    const expected = CASE_STATUS_OPTIONS.filter(
      (other) => other.value !== opt.value,
    ).map((other) => other.value);
    assert.deepEqual([...targets].sort(), [...expected].sort());
  }
});

// ===========================================================================
// Settings tab — single dropdown + canonical confirm + endpoint
// ===========================================================================

test("Settings tab renders ONE status <select> with all six options", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-settings-status-select/);
  // The <option> renderer maps over the canonical option list,
  // tagging each row with a data-attribute carrying the value.
  // We assert the renderer shape (one map over CASE_STATUS_OPTIONS
  // that emits `<option value={opt.value} ...>{opt.label}</option>`).
  assert.match(
    SIMPLE_DETAIL,
    /\{CASE_STATUS_OPTIONS\.map\(\(opt\) => \(\s*\n?\s*<option\s*\n?\s*key=\{opt\.value\}\s*\n?\s*value=\{opt\.value\}\s*\n?\s*data-simple-case-settings-status-option=\{opt\.value\}\s*\n?\s*>\s*\n?\s*\{opt\.label\}\s*\n?\s*<\/option>/,
  );
  // The label "Case status" is the visible field label.
  assert.match(SIMPLE_DETAIL, />\s*Case status\s*</);
});

test("Dropdown value is controlled by caseDetail.status (no local mirror that can drift)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /<select[\s\S]{0,400}?data-simple-case-settings-status-select[\s\S]{0,400}?value=\{caseDetail\.status\}/,
  );
});

test("Helper text disclaims workflow side effects", () => {
  assert.match(
    SIMPLE_DETAIL,
    /Use status to organize your case\. This does not change\s*\n?\s*evidence integrity, reports, packages, or retention\./,
  );
});

test("Dropdown disable predicate is the same canChangeStatus capability + busy flag", () => {
  assert.match(
    SIMPLE_DETAIL,
    /<select[\s\S]{0,800}?data-simple-case-settings-status-select[\s\S]{0,600}?disabled=\{!canChangeStatus \|\| busy\}/,
  );
});

test("Dropdown surfaces the canonical disabledReasons.changeStatus as the title tooltip", () => {
  assert.match(
    SIMPLE_DETAIL,
    /title=\{viewer\.disabledReasons\.changeStatus \?\? undefined\}/,
  );
});

test("Dropdown onChange snaps the visible value back to the current status before calling handleStatusChange", () => {
  // The select is controlled; resetting `e.target.value` before
  // dispatching the handler means the visible option does NOT
  // change to the rejected target if the user cancels or the
  // request fails. The next render re-binds `value` to whatever
  // the new envelope says.
  assert.match(
    SIMPLE_DETAIL,
    /onChange=\{\(e\) => \{\s*\n?\s*const next = e\.target\.value;[\s\S]{0,400}?e\.target\.value = caseDetail\.status;\s*\n?\s*void handleStatusChange\(next\);/,
  );
});

// ===========================================================================
// Confirm modal copy + endpoint
// ===========================================================================

test("Status change opens the canonical useConfirmAction modal with spec-locked copy", () => {
  assert.match(
    SIMPLE_DETAIL,
    /const ok = await confirm\(\{\s*\n?\s*title:\s*"Change case status",[\s\S]{0,800}?confirmLabel:\s*"Change status",\s*\n?\s*tone:\s*"neutral",\s*\n?\s*testId:\s*"simple-case-settings-status",/,
  );
  // Description mentions the from/to labels via caseStatusLabel.
  assert.match(
    SIMPLE_DETAIL,
    /Change this case from \$\{caseStatusLabel\(\s*\n?\s*caseDetail\.status,\s*\n?\s*\)\} to \$\{caseStatusLabel\(\s*\n?\s*toStatus,\s*\n?\s*\)\}\?/,
  );
  // Reassurance line that org-only.
  assert.match(
    SIMPLE_DETAIL,
    /This only updates case organization\. Linked evidence, reports, verification packages, notes, and audit history remain unchanged\./,
  );
});

test("On confirm, change POSTs to the existing /v1/cases/:id/status endpoint with { toStatus }", () => {
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/status`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ toStatus \}\),/,
  );
});

test("Success toast reads 'Case status updated.'", () => {
  assert.match(
    SIMPLE_DETAIL,
    /addToast\("Case status updated\.", "success"\);/,
  );
});

test("Same-status pick is a no-op (early return before confirm fires)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /if \(toStatus === caseDetail\.status\) return false;/,
  );
});

test("Error path surfaces a bounded toast (no raw JSON / no stack trace)", () => {
  // PROOVRA Feedback System — the status-change error path routes through
  // toSafeUserError(), which maps known codes/status to safe copy and, for
  // anything unmapped, uses the section fallback WITHOUT ever echoing the
  // raw backend message. The pre-migration raw `err.message` passthrough
  // must be gone.
  assert.match(
    SIMPLE_DETAIL,
    /addToast\(\s*\n?\s*toSafeUserError\(err, \{ message: "Could not change status\." \}\)\.message,\s*\n?\s*"error",\s*\n?\s*\);/,
  );
  assert.ok(
    !/err instanceof Error \? err\.message : "Could not change status\."/.test(
      SIMPLE_DETAIL,
    ),
    "raw err.message passthrough must be removed from the status-change path",
  );
});

// ===========================================================================
// Backend audit + transition mirror
// ===========================================================================

test("Backend still emits `cases.status_changed` for every transition (back-compat for analytics)", () => {
  assert.match(LIFECYCLE, /action:\s*"cases\.status_changed"/);
});

test("Backend still emits `cases.restored` on ARCHIVED → OPEN (no frontend dependency on it)", () => {
  assert.match(
    LIFECYCLE,
    /if \(from === "ARCHIVED" && input\.toStatus === "OPEN"\)[\s\S]{0,400}?action:\s*"cases\.restored"/,
  );
});

test("Backend keeps the legal-hold guard for transitions into CLOSED or ARCHIVED", () => {
  assert.match(LIFECYCLE, /const CLOSURE_STATUSES = new Set\(\["CLOSED",\s*"ARCHIVED"\]\)/);
  assert.match(
    LIFECYCLE,
    /CLOSURE_STATUSES\.has\(input\.toStatus\)[\s\S]{0,400}?active_legal_hold_blocks_closure/,
  );
});

// ===========================================================================
// No regressions
// ===========================================================================

test("No raw enum labels (ON_HOLD / OPEN literal text) appear in the Settings dropdown JSX", () => {
  // The option labels go through CASE_STATUS_OPTIONS; the raw
  // enum should never appear inside `>...<` text positions.
  // (Anchoring on the JSX text would require parsing the AST;
  // instead we check for the underscored enum names directly in
  // the Settings status block.)
  const start = SIMPLE_DETAIL.indexOf("data-simple-case-settings-status");
  const end = SIMPLE_DETAIL.indexOf("</div>", start + 200);
  const block = SIMPLE_DETAIL.slice(start, end > 0 ? end : start + 3000);
  // Forbid uppercase-with-underscore enum strings inside `>...<`.
  assert.doesNotMatch(block, />\s*ON_HOLD\s*</);
  assert.doesNotMatch(block, />\s*ARCHIVED\s*</);
  assert.doesNotMatch(block, />\s*INVESTIGATING\s*</);
});

test("No window.confirm reintroduced on the Settings status flow", () => {
  assert.doesNotMatch(SIMPLE_DETAIL, /window\.confirm\(/);
  assert.doesNotMatch(SIMPLE_DETAIL, /globalThis\.confirm\(/);
});

test("Status change handler does NOT mutate evidence / report / notes envelopes (it just calls onReload)", () => {
  // The handler's success path is the only place that touches
  // case state: a single onReload() call. It must NOT directly
  // poke the evidence/reports/notes envelopes.
  const handlerStart = SIMPLE_DETAIL.indexOf("const handleStatusChange = useCallback");
  const handlerEnd = SIMPLE_DETAIL.indexOf("\n  );", handlerStart);
  const handler = SIMPLE_DETAIL.slice(handlerStart, handlerEnd);
  assert.match(handler, /await onReload\(\);/);
  // Forbid direct mutations of any tab's state.
  assert.doesNotMatch(handler, /setEvidenceItems/);
  assert.doesNotMatch(handler, /setComments/);
  assert.doesNotMatch(handler, /setDeliverables/);
});
