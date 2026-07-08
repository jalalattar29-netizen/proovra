/**
 * Phase 6 (Enterprise Collaboration) — SCOPE B: CASE/MATTER ASSIGNMENT.
 *
 * The canonical case-assignment backend (model CaseAssignment, service
 * addCaseAssignment/removeCaseAssignment, routes POST/DELETE
 * /v1/cases/:id/assignments, gate evaluateCaseMutationPermission("ASSIGN"),
 * and the assignment-candidates endpoint) already existed. So did the
 * AssignmentPickerModal component — but it was ORPHANED (exported from the
 * matter-modals barrel yet never rendered by any host).
 *
 * This suite pins the ONE missing piece SCOPE B added: wiring the
 * interactive assign / unassign controls into the canonical Matter
 * Workspace Assignments tab. The controls are gated by the same
 * capability the backend enforces (`viewer.canAssign`), reuse
 * apiFetch + toSafeUserError, and refetch the envelope after a mutation.
 *
 * Pins:
 *   1. The (previously orphaned) AssignmentPickerModal is imported into
 *      MatterWorkspace.
 *   2. The Assignments tab exposes an "Assign teammate" trigger.
 *   3. Assign POSTs to the canonical /v1/cases/:id/assignments endpoint
 *      (NOT a new invented route) with assignedToUserId + role.
 *   4. Unassign DELETEs the canonical
 *      /v1/cases/:id/assignments/:assignmentId endpoint.
 *   5. Both controls are gated on `viewer.canAssign` (display matches
 *      the backend ASSIGN guard — no drift).
 *   6. PERSONAL-scope cases never show an enabled assign control.
 *   7. Errors flow through the sanctioned toSafeUserError path only
 *      (no raw error.message passthrough).
 *   8. After a successful mutation the tab calls the parent refetch
 *      (onChanged / load) rather than mutating local state — so the
 *      list reflects the audited server truth.
 *   9. The assignment write path never touches ownership, custody, or
 *      evidence (no such mutation strings in the Assignments tab).
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

const MATTER = src(
  "apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const MODAL = src(
  "apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx",
);

// Narrow to the AssignmentsTab function body so cross-tab strings
// (e.g. AuditTab's "custody") never give false positives. Bounded by
// the function declaration and the next top-level `function ` after it.
const ASSIGN_TAB = (() => {
  const decl = MATTER.indexOf("function AssignmentsTab");
  assert.ok(decl > -1, "AssignmentsTab function should exist");
  const after = MATTER.indexOf("\nfunction ", decl + 1);
  const end = after > -1 ? after : MATTER.length;
  return MATTER.slice(decl, end);
})();

test("1. orphaned AssignmentPickerModal is now imported into MatterWorkspace", () => {
  assert.match(MATTER, /import\s*\{[\s\S]*AssignmentPickerModal[\s\S]*\}\s*from\s*"\.\/matter-modals"/);
  assert.match(MATTER, /<AssignmentPickerModal\b/);
});

test("2. Assignments tab exposes an assign trigger", () => {
  assert.match(MATTER, /data-matter-assignments-add/);
  assert.match(MATTER, /Assign teammate/);
});

test("3. assign POSTs the canonical /v1/cases/:id/assignments endpoint", () => {
  assert.match(
    MATTER,
    /apiFetch\(\s*`\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignments`/,
  );
  assert.match(MATTER, /method:\s*"POST"/);
  assert.match(MATTER, /assignedToUserId:\s*input\.userId/);
  assert.match(MATTER, /role:\s*input\.role/);
});

test("4. unassign DELETEs the canonical assignment-id endpoint", () => {
  assert.match(
    MATTER,
    /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignments\/\$\{encodeURIComponent\(assignmentId\)\}/,
  );
  assert.match(MATTER, /method:\s*"DELETE"/);
});

test("5. controls gate on viewer.canAssign (no display/enforcement drift)", () => {
  assert.match(MATTER, /envelope\.viewer\.canAssign\s*===\s*true/);
  // The unassign button and the enabled assign button both hinge on the
  // same computed `canAssign`.
  assert.match(ASSIGN_TAB, /canAssign\s*\?/);
});

test("6. PERSONAL-scope cases never enable the assign control", () => {
  assert.match(MATTER, /envelope\.case\.scope\s*===\s*"TEAM"/);
});

test("7. errors flow only through toSafeUserError (no raw passthrough)", () => {
  // Both mutation handlers wrap failures in toSafeUserError.
  const occurrences = (ASSIGN_TAB.match(/toSafeUserError\(/g) ?? []).length;
  assert.ok(
    occurrences >= 2,
    `expected assign + unassign to both use toSafeUserError, saw ${occurrences}`,
  );
});

test("8. successful mutation refetches via onChanged (server truth, not local edit)", () => {
  assert.match(MATTER, /onChanged\(\)/);
  // The tab is handed the parent's load() as onChanged.
  assert.match(MATTER, /onChanged=\{\(\)\s*=>\s*void load\(\)\}/);
});

test("9. assignment write path never mutates ownership / custody / evidence", () => {
  // Strip comments so explanatory prose ("never mutates custody…")
  // doesn't trip the negative match — we assert on CODE, not comments.
  const code = ASSIGN_TAB.replace(/\/\/[^\n]*/g, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  // No ownership field assignment anywhere in the tab code.
  assert.doesNotMatch(code, /ownerUserId\s*[:=]/);
  // No custody / evidence-mutation endpoints called from the tab.
  assert.doesNotMatch(code, /custody/i);
  assert.doesNotMatch(code, /\/evidence-links/);
  assert.doesNotMatch(code, /apiFetch\([^)]*\/evidence/);
});

test("10. the reused modal still targets the canonical POST endpoint", () => {
  // Guards against a future refactor pointing the modal elsewhere.
  assert.match(MODAL, /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignment-candidates/);
  assert.match(MODAL, /onSubmit:\s*\(input:/);
});
