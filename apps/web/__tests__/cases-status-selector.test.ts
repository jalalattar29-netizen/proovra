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
// Phase CASES-STATUS-LISTBOX (§22) — the accessible custom listbox that
// replaced the native <select> in the Settings tab.
const CASE_STATUS_SELECT = src(
  "apps/web/components/cases-experience/simple-case-detail/CaseStatusSelect.tsx",
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

test("Settings tab renders the CaseStatusSelect listbox wired to the canonical option list", () => {
  // Phase CASES-STATUS-LISTBOX (§22) — the native <select> is
  // replaced by the accessible custom <CaseStatusSelect> listbox.
  // The legacy `data-simple-case-settings-status-select` testid is
  // preserved on the control wrapper so downstream contract tests
  // keep passing; the listbox itself carries the new §22 testids.
  assert.match(SIMPLE_DETAIL, /data-simple-case-settings-status-select/);
  // No native <select> for case status survives in this file.
  assert.doesNotMatch(SIMPLE_DETAIL, /<select\b/);
  // The listbox is fed CASE_STATUS_OPTIONS as its option source.
  assert.match(
    SIMPLE_DETAIL,
    /<CaseStatusSelect[\s\S]{0,300}?options=\{CASE_STATUS_OPTIONS\}/,
  );
  // The label "Case status" is the visible field label.
  assert.match(SIMPLE_DETAIL, />\s*Case status\s*</);
});

test("Listbox component renders one role=option per status via CASE_STATUS_OPTIONS with the §22 option testid", () => {
  // Source-pin the option renderer inside the CaseStatusSelect
  // component: it maps over the passed `options`, emitting a
  // role="option" carrying `data-case-status-select-option` +
  // `data-status={opt.value}` and rendering `opt.label`.
  assert.match(
    CASE_STATUS_SELECT,
    /options\.map\(\(opt, idx\) =>/,
  );
  assert.match(CASE_STATUS_SELECT, /role="option"/);
  assert.match(CASE_STATUS_SELECT, /data-case-status-select-option/);
  assert.match(CASE_STATUS_SELECT, /data-status=\{opt\.value\}/);
  assert.match(CASE_STATUS_SELECT, /\{opt\.label\}/);
  // The trigger + listbox carry the spec-locked §22 testids.
  assert.match(CASE_STATUS_SELECT, /data-case-status-select-trigger/);
  assert.match(CASE_STATUS_SELECT, /data-case-status-select-listbox/);
  // ARIA listbox contract.
  assert.match(CASE_STATUS_SELECT, /aria-haspopup="listbox"/);
  assert.match(CASE_STATUS_SELECT, /role="listbox"/);
  assert.match(CASE_STATUS_SELECT, /aria-activedescendant=/);
});

test("Listbox value is controlled by caseDetail.status (no local mirror that can drift)", () => {
  // The custom listbox holds no committed value of its own — the
  // trigger is always fed `value={caseDetail.status}`. A cancel or
  // server error therefore cannot leave the control stuck on a
  // rejected target.
  assert.match(
    SIMPLE_DETAIL,
    /<CaseStatusSelect[\s\S]{0,200}?value=\{caseDetail\.status\}/,
  );
});

test("Helper text disclaims workflow side effects", () => {
  // §5 — copy now enumerates custody alongside integrity/reports/
  // packages/retention as unchanged by a status change.
  assert.match(
    SIMPLE_DETAIL,
    /Use status to organize this case\. Evidence integrity, reports,\s*\n?\s*packages, custody, and retention are unchanged\./,
  );
});

test("Listbox disable predicate is the same canChangeStatus capability + busy flag", () => {
  assert.match(
    SIMPLE_DETAIL,
    /<CaseStatusSelect[\s\S]{0,400}?disabled=\{!canChangeStatus \|\| busy\}/,
  );
});

test("Listbox surfaces the canonical disabledReasons.changeStatus as the title tooltip", () => {
  assert.match(
    SIMPLE_DETAIL,
    /title=\{viewer\.disabledReasons\.changeStatus \?\? undefined\}/,
  );
});

test("Selecting a status routes through the parent handleStatusChange (parent owns the confirm + POST flow)", () => {
  // The listbox performs no mutation of its own — on select it just
  // calls onSelect(status), which dispatches the parent's
  // handleStatusChange (the confirm-modal + POST owner). Because the
  // trigger is re-bound to `caseDetail.status` every render, a
  // cancel/error leaves the visible status unchanged with no local
  // state to reset.
  assert.match(
    SIMPLE_DETAIL,
    /onSelect=\{\(next\) => \{[\s\S]{0,400}?void handleStatusChange\(next\);/,
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
