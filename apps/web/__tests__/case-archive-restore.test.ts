/**
 * Phase CASE-ARCHIVE-RESTORE — Archive ↔ Restore lifecycle contract.
 *
 * Source-pinned across backend + frontend. Asserts:
 *
 *   1. Backend state machine adds `ARCHIVED → CLOSED` (one-hop
 *      restore). Every other transition is unchanged.
 *
 *   2. Backend emits a dedicated `cases.restored` audit event in
 *      addition to the existing `cases.status_changed` event, with
 *      the spec's payload (caseId, actorUserId, previousStatus,
 *      restoredStatus, reason). Uses the existing
 *      `appendPlatformAuditLog` infrastructure — no parallel
 *      logging system.
 *
 *   3. The `cases.restored` event fires ONLY when from===ARCHIVED
 *      AND to===CLOSED (not on every status change).
 *
 *   4. The same `STATUS_CHANGE` authorization gate is reused — no
 *      new auth surface, no relaxed permission.
 *
 *   5. The legal-hold guard (`CLOSURE_STATUSES`) still applies to
 *      the restore-to-CLOSED transition (fail-closed when an
 *      active hold exists on the case).
 *
 *   6. The closure-cascade body is untouched — restoring to CLOSED
 *      doesn't reactivate any previously-removed assignments
 *      (history preserved).
 *
 *   7. The route at POST /v1/cases/:id/status accepts toStatus
 *      "CLOSED" with no special-casing — the state-machine change
 *      alone unlocks the path.
 *
 *   8. The Settings tab renders a dedicated "Restore Case" button
 *      (not the generic "Close case" label) when current status is
 *      ARCHIVED, gated on the same canChangeStatus capability.
 *
 *   9. The restore confirmation uses the canonical
 *      `useConfirmAction()` modal with the spec-locked title +
 *      description + button label. No `window.confirm`.
 *
 *  10. Enterprise MatterWorkspace surface is untouched (the
 *      Personal-mode SimpleCaseDetail owns the restore UI).
 *
 *  11. No schema change, no evidence mutation, no report/package
 *      mutation, no custody mutation, no retention change.
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

const LIFECYCLE = src("services/api/src/services/cases/case-lifecycle.service.ts");
const PERMISSION = src("services/api/src/services/cases/case-permission.service.ts");
const ROUTE = src("services/api/src/routes/case-workspace.routes.ts");
const COMPONENT = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const HELPERS = src(
  "apps/web/components/cases-experience/simple-case-detail/helpers.ts",
);
const MATTER_WORKSPACE = src(
  "apps/web/components/cases-experience/MatterWorkspace.tsx",
);

// ===========================================================================
// Backend state machine
// ===========================================================================

test("ARCHIVED is no longer terminal — the state machine permits ARCHIVED → CLOSED", () => {
  assert.match(LIFECYCLE, /ARCHIVED:\s*\["CLOSED"\]/);
  // Anti-regression: the prior terminal stub is gone.
  assert.doesNotMatch(LIFECYCLE, /ARCHIVED:\s*\[\],\s*\/\/\s*terminal/);
});

test("Every other transition is unchanged", () => {
  // Spot-pin each row of the table that is NOT touched by this phase.
  assert.match(LIFECYCLE, /OPEN:\s*\["INVESTIGATING",\s*"ON_HOLD",\s*"RESOLVED"\]/);
  assert.match(LIFECYCLE, /INVESTIGATING:\s*\["ON_HOLD",\s*"RESOLVED"\]/);
  assert.match(LIFECYCLE, /ON_HOLD:\s*\["INVESTIGATING",\s*"RESOLVED"\]/);
  assert.match(LIFECYCLE, /RESOLVED:\s*\["CLOSED",\s*"INVESTIGATING"\]/);
  assert.match(LIFECYCLE, /CLOSED:\s*\["ARCHIVED",\s*"RESOLVED"\]/);
});

// ===========================================================================
// Audit event
// ===========================================================================

test("Restore emits a dedicated `cases.restored` audit event with the spec payload", () => {
  // The new audit block fires only when from===ARCHIVED AND
  // to===CLOSED. The payload carries caseId, actorUserId,
  // previousStatus, restoredStatus, reason.
  assert.match(
    LIFECYCLE,
    /if \(from === "ARCHIVED" && input\.toStatus === "CLOSED"\) \{\s*\n?\s*await appendPlatformAuditLog\(\{[\s\S]{0,400}?action:\s*"cases\.restored"/,
  );
  // Payload field set.
  for (const field of [
    "caseId: existing.id",
    "actorUserId: input.actorUserId",
    "previousStatus: from",
    'restoredStatus: input.toStatus',
  ]) {
    assert.ok(
      LIFECYCLE.includes(field),
      `cases.restored audit metadata must include ${field}`,
    );
  }
});

test("Restore audit event reuses the canonical appendPlatformAuditLog infrastructure (no parallel logger)", () => {
  // The `cases.restored` emission must use the SAME helper as
  // every other lifecycle audit event — no new logging system.
  // Source-pinned by the import + the explicit call.
  assert.match(LIFECYCLE, /import \{ appendPlatformAuditLog \} from/);
  assert.match(
    LIFECYCLE,
    /action:\s*"cases\.restored",\s*\n?\s*category:\s*"cases\.lifecycle"/,
  );
});

test("Existing `cases.status_changed` audit event STILL fires on every transition (back-compat)", () => {
  // Restore writes BOTH events — the canonical status_changed AND
  // the dedicated restored event. Analytics consumers counting
  // status_changed must keep working.
  assert.match(LIFECYCLE, /action:\s*"cases\.status_changed"/);
});

// ===========================================================================
// Authorization + legal-hold + cascade — none weakened
// ===========================================================================

test("Restore reuses the existing STATUS_CHANGE permission gate — no relaxed auth surface", () => {
  // The route handler runs `gateCaseMutation("STATUS_CHANGE", ...)`
  // for every status change. There is no separate restore-specific
  // permission path.
  assert.match(
    ROUTE,
    /"\/v1\/cases\/:id\/status"[\s\S]{0,400}?gateCaseMutation\(reply,\s*"STATUS_CHANGE"/,
  );
  // STATUS_CHANGE permission rules unchanged.
  assert.match(
    PERMISSION,
    /case "STATUS_CHANGE":[\s\S]{0,400}?isOwnerOrAdmin \|\| isTeamWriter/,
  );
});

test("Legal-hold guard still applies to the restore transition (target is CLOSED, which is in CLOSURE_STATUSES)", () => {
  assert.match(LIFECYCLE, /const CLOSURE_STATUSES = new Set\(\["CLOSED",\s*"ARCHIVED"\]\)/);
  assert.match(
    LIFECYCLE,
    /if \(CLOSURE_STATUSES\.has\(input\.toStatus\)\)[\s\S]{0,400}?active_legal_hold_blocks_closure/,
  );
});

test("Closure cascade body is untouched — restoring to CLOSED does NOT reactivate removed assignments", () => {
  // The cascade still fires on transition TO CLOSED/ARCHIVED but
  // its body is unchanged: it deactivates ACTIVE assignments. After
  // archive, all assignments are already REMOVED; restoring to
  // CLOSED re-runs the cascade (no-op, idempotent), it never
  // reactivates anything. Source-pin the cascade shape so any
  // future "reactivate on restore" regression fails here.
  assert.match(
    LIFECYCLE,
    /client\.caseAssignment\.updateMany\(\{\s*\n?\s*where:\s*\{\s*caseId:\s*existing\.id,\s*status:\s*"ACTIVE"\s*\},\s*\n?\s*data:\s*\{\s*\n?\s*status:\s*"REMOVED",/,
  );
});

// ===========================================================================
// Route — no special-casing for restore
// ===========================================================================

test("POST /v1/cases/:id/status accepts toStatus 'CLOSED' with no new branch (state-machine alone unlocks the path)", () => {
  // The body schema enum already includes every state including
  // CLOSED. Restore is just a state transition the table now
  // permits — there is no route-level special-case for it.
  assert.match(
    ROUTE,
    /"OPEN",\s*\n?\s*"INVESTIGATING",\s*\n?\s*"ON_HOLD",\s*\n?\s*"RESOLVED",\s*\n?\s*"CLOSED",\s*\n?\s*"ARCHIVED"/,
  );
  // No new route added for restore — Phase requirement: "Implement
  // using the existing lifecycle service. Do NOT create duplicate
  // lifecycle systems."
  assert.doesNotMatch(ROUTE, /"\/v1\/cases\/:id\/restore"/);
});

// ===========================================================================
// Schema — no changes
// ===========================================================================

test("No new Prisma model / enum value added for restore (schema-stable)", () => {
  const SCHEMA = src("services/api/prisma/schema.prisma");
  // `CaseStatus` enum is unchanged.
  assert.match(
    SCHEMA,
    /enum CaseStatus \{\s*\n?\s*OPEN\s*\n?\s*INVESTIGATING\s*\n?\s*ON_HOLD\s*\n?\s*RESOLVED\s*\n?\s*CLOSED\s*\n?\s*ARCHIVED\s*\n?\s*\}/,
  );
  // No `CaseRestoreEvent` table or similar parallel system.
  assert.doesNotMatch(SCHEMA, /model CaseRestoreEvent/);
});

// ===========================================================================
// Frontend Settings tab — Restore button + canonical confirm
// ===========================================================================

test("helpers.ts ALLOWED_STATUS_TRANSITIONS map mirrors the new backend ARCHIVED → CLOSED entry", () => {
  assert.match(HELPERS, /ARCHIVED:\s*\["CLOSED"\]/);
});

test("Settings tab renders a DEDICATED Restore Case button when current status is ARCHIVED", () => {
  // The Restore button uses its own primary-variant Button (not via
  // the generic transition loop) so the spec-locked copy doesn't
  // leak the "Move to Closed" / "Close case" label.
  assert.match(
    COMPONENT,
    /\{caseDetail\.status === "ARCHIVED" \? \(\s*\n?\s*<Button[\s\S]{0,400}?data-simple-case-settings-status-restore[\s\S]{0,300}?Restore Case\s*\n?\s*<\/Button>/,
  );
  // Generic transition loop is now the ELSE branch so it cannot
  // also render a Close-case button for the ARCHIVED row.
  assert.match(COMPONENT, /\) : \(\s*\n?\s*allowedTransitions\.map\(\(toStatus\) => \(/);
});

test("Restore button is gated on canChangeStatus (the existing capability the envelope already exposes)", () => {
  // Two anchors near each other — JSX attribute order is `disabled`
  // BEFORE `data-simple-case-settings-status-restore`, so do an
  // anchored window search around the data attribute and assert
  // the disabled expression appears in the same Button element.
  const anchor = COMPONENT.indexOf("data-simple-case-settings-status-restore");
  assert.ok(anchor > 0, "Restore button data attribute not found");
  const window = COMPONENT.slice(Math.max(0, anchor - 300), anchor + 300);
  assert.match(window, /disabled=\{!canChangeStatus \|\| busy\}/);
});

test("Restore uses the canonical useConfirmAction() modal with the spec-locked copy", () => {
  // Title + description + button copy + tone all locked.
  assert.match(
    COMPONENT,
    /const ok = await confirm\(\{\s*\n?\s*title:\s*"Restore Case",\s*\n?\s*description:\s*\n?\s*"This will return the case to the active case list\. Linked evidence, reports, verification packages, comments, notes, and audit history remain unchanged\."/,
  );
  assert.match(COMPONENT, /confirmLabel:\s*"Restore Case"/);
  assert.match(COMPONENT, /tone:\s*"neutral"/);
  assert.match(COMPONENT, /testId:\s*"simple-case-settings-restore"/);
});

test("Restore POSTs to /v1/cases/:id/status with toStatus 'CLOSED' (re-uses handleStatusChange)", () => {
  // No new fetch path. The dedicated restore handler delegates to
  // the same `handleStatusChange("CLOSED")` mutation used by every
  // other lifecycle transition.
  assert.match(
    COMPONENT,
    /const handleRestore = useCallback\(async \(\)[\s\S]{0,600}?await handleStatusChange\("CLOSED"\);/,
  );
});

test("Archive button no longer surfaces when the case is ARCHIVED (it's hidden by the dedicated-restore branch)", () => {
  // Source-pin: in the ARCHIVED branch the only Button rendered is
  // the Restore Case button. The Archive label only appears inside
  // the ELSE branch (generic transition loop), so it cannot render
  // when status === "ARCHIVED".
  const archivedBranchStart = COMPONENT.indexOf(
    'caseDetail.status === "ARCHIVED" ? (',
  );
  const elseBranchStart = COMPONENT.indexOf(") : (", archivedBranchStart);
  const archivedBranch = COMPONENT.slice(archivedBranchStart, elseBranchStart);
  assert.doesNotMatch(archivedBranch, /Archive case/);
});

test("Settings tab terminal-state copy is no longer ARCHIVED-specific (no transitions == empty body, not 'final status')", () => {
  // Old copy said "Archived is a final status …" — that's wrong now.
  assert.doesNotMatch(
    COMPONENT,
    /Archived is a final status — no further transitions are available from here\./,
  );
});

test("No window.confirm reintroduced (Phase Final-D3 guard cross-check)", () => {
  // Anti-regression: a refactor must not silently swap the
  // canonical hook back to the browser primitive.
  assert.doesNotMatch(COMPONENT, /window\.confirm\(/);
  assert.doesNotMatch(COMPONENT, /globalThis\.confirm\(/);
});

// ===========================================================================
// Enterprise MatterWorkspace untouched
// ===========================================================================

test("Enterprise MatterWorkspace surface has NO new Restore UI (Personal-mode SimpleCaseDetail owns it)", () => {
  // Restore is a Personal-mode affordance. Enterprise users hit
  // the same backend endpoint via API; the legacy MatterWorkspace
  // does not (and should not) sprout a new button.
  assert.doesNotMatch(MATTER_WORKSPACE, /Restore Case/);
  assert.doesNotMatch(MATTER_WORKSPACE, /data-simple-case-settings-status-restore/);
});
