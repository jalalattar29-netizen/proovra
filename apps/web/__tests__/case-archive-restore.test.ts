/**
 * Phase CASES-PERSONAL-UX-CLEANUP — Archive ↔ Restore lifecycle
 * contract. Replaces the prior CASE-ARCHIVE-RESTORE pinning to
 * reflect the simplified Personal / Small-Business contract:
 *
 *   - Archive is reachable in one click from every active status
 *     (no ladder through INVESTIGATING / ON_HOLD / RESOLVED /
 *     CLOSED). The backend state machine row now permits
 *     `<active> → ARCHIVED` directly.
 *
 *   - Restore lands the case in OPEN (not CLOSED), so the user
 *     ends up on a visible state in the personal mental model.
 *
 *   - The Settings tab exposes exactly ONE status button at any
 *     given time: "Archive Case" when active, "Restore Case" when
 *     ARCHIVED. The legacy "Move to <X>" transition loop is gone.
 *
 *   - The audit event `cases.restored` keeps firing, but on the
 *     ARCHIVED → OPEN edge instead of the old ARCHIVED → CLOSED
 *     edge.
 *
 *   - No new routes, no schema change, no relaxed authorization,
 *     no parallel logging system, no `window.confirm`.
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
// Backend state machine — one-hop archive + OPEN-target restore
// ===========================================================================

test("Every active status permits a one-hop ARCHIVED transition", () => {
  assert.match(
    LIFECYCLE,
    /OPEN:\s*\["INVESTIGATING",\s*"ON_HOLD",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    LIFECYCLE,
    /INVESTIGATING:\s*\["ON_HOLD",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    LIFECYCLE,
    /ON_HOLD:\s*\["INVESTIGATING",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    LIFECYCLE,
    /RESOLVED:\s*\["CLOSED",\s*"INVESTIGATING",\s*"ARCHIVED"\]/,
  );
  assert.match(LIFECYCLE, /CLOSED:\s*\["ARCHIVED",\s*"RESOLVED"\]/);
});

test("ARCHIVED restores to OPEN (not CLOSED) so the user lands on a visible state", () => {
  assert.match(LIFECYCLE, /ARCHIVED:\s*\["OPEN"\]/);
  // Anti-regression: the prior CLOSED-target stub is gone.
  assert.doesNotMatch(LIFECYCLE, /ARCHIVED:\s*\["CLOSED"\]/);
});

// ===========================================================================
// Audit event — `cases.restored` fires on the new ARCHIVED → OPEN edge
// ===========================================================================

test("Restore emits a dedicated `cases.restored` audit event when from===ARCHIVED && to===OPEN", () => {
  assert.match(
    LIFECYCLE,
    /if \(from === "ARCHIVED" && input\.toStatus === "OPEN"\) \{\s*\n?\s*await appendPlatformAuditLog\(\{[\s\S]{0,400}?action:\s*"cases\.restored"/,
  );
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
  assert.match(LIFECYCLE, /import \{ appendPlatformAuditLog \} from/);
  assert.match(
    LIFECYCLE,
    /action:\s*"cases\.restored",\s*\n?\s*category:\s*"cases\.lifecycle"/,
  );
});

test("Existing `cases.status_changed` audit event STILL fires on every transition (back-compat)", () => {
  assert.match(LIFECYCLE, /action:\s*"cases\.status_changed"/);
});

// ===========================================================================
// Authorization + legal-hold + cascade — none weakened
// ===========================================================================

test("Status mutations reuse the existing STATUS_CHANGE permission gate — no relaxed auth surface", () => {
  assert.match(
    ROUTE,
    /"\/v1\/cases\/:id\/status"[\s\S]{0,400}?gateCaseMutation\(reply,\s*"STATUS_CHANGE"/,
  );
  assert.match(
    PERMISSION,
    /case "STATUS_CHANGE":[\s\S]{0,400}?isOwnerOrAdmin \|\| isTeamWriter/,
  );
});

test("Legal-hold guard still applies to ARCHIVED-target transitions (CLOSURE_STATUSES contains ARCHIVED)", () => {
  assert.match(LIFECYCLE, /const CLOSURE_STATUSES = new Set\(\["CLOSED",\s*"ARCHIVED"\]\)/);
  assert.match(
    LIFECYCLE,
    /if \(CLOSURE_STATUSES\.has\(input\.toStatus\)\)[\s\S]{0,400}?active_legal_hold_blocks_closure/,
  );
});

test("Closure cascade body is untouched — restoring to OPEN does NOT reactivate removed assignments", () => {
  // Restoring to OPEN is NOT in CLOSURE_STATUSES so the cascade
  // does not fire at all on restore. Pin the cascade shape so a
  // future "reactivate on restore" regression still fails here.
  assert.match(
    LIFECYCLE,
    /client\.caseAssignment\.updateMany\(\{\s*\n?\s*where:\s*\{\s*caseId:\s*existing\.id,\s*status:\s*"ACTIVE"\s*\},\s*\n?\s*data:\s*\{\s*\n?\s*status:\s*"REMOVED",/,
  );
});

// ===========================================================================
// Route — no special-casing for restore
// ===========================================================================

test("POST /v1/cases/:id/status accepts toStatus 'OPEN' with no new branch (state-machine alone unlocks the path)", () => {
  // The body schema enum already includes every state. Restore is
  // a state transition the table now permits — no route-level
  // special-case for it.
  assert.match(
    ROUTE,
    /"OPEN",\s*\n?\s*"INVESTIGATING",\s*\n?\s*"ON_HOLD",\s*\n?\s*"RESOLVED",\s*\n?\s*"CLOSED",\s*\n?\s*"ARCHIVED"/,
  );
  assert.doesNotMatch(ROUTE, /"\/v1\/cases\/:id\/restore"/);
});

// ===========================================================================
// Schema — no changes
// ===========================================================================

test("No new Prisma model / enum value added for the simplified lifecycle (schema-stable)", () => {
  const SCHEMA = src("services/api/prisma/schema.prisma");
  assert.match(
    SCHEMA,
    /enum CaseStatus \{\s*\n?\s*OPEN\s*\n?\s*INVESTIGATING\s*\n?\s*ON_HOLD\s*\n?\s*RESOLVED\s*\n?\s*CLOSED\s*\n?\s*ARCHIVED\s*\n?\s*\}/,
  );
  assert.doesNotMatch(SCHEMA, /model CaseRestoreEvent/);
});

// ===========================================================================
// Frontend helpers — ALLOWED_STATUS_TRANSITIONS mirrors backend
// ===========================================================================

test("helpers.ts ALLOWED_STATUS_TRANSITIONS mirrors the new backend table (every row, OPEN-target restore)", () => {
  assert.match(
    HELPERS,
    /OPEN:\s*\["INVESTIGATING",\s*"ON_HOLD",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    HELPERS,
    /INVESTIGATING:\s*\["ON_HOLD",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    HELPERS,
    /ON_HOLD:\s*\["INVESTIGATING",\s*"RESOLVED",\s*"ARCHIVED"\]/,
  );
  assert.match(
    HELPERS,
    /RESOLVED:\s*\["CLOSED",\s*"INVESTIGATING",\s*"ARCHIVED"\]/,
  );
  assert.match(HELPERS, /CLOSED:\s*\["ARCHIVED",\s*"RESOLVED"\]/);
  assert.match(HELPERS, /ARCHIVED:\s*\["OPEN"\]/);
});

// ===========================================================================
// Settings tab — single Archive ↔ Restore button, no legacy ladder
// ===========================================================================

test("Settings tab renders a DEDICATED Restore Case button when current status is ARCHIVED", () => {
  assert.match(
    COMPONENT,
    /\{caseDetail\.status === "ARCHIVED" \? \(\s*\n?\s*<Button[\s\S]{0,400}?data-simple-case-settings-status-restore[\s\S]{0,300}?Restore Case\s*\n?\s*<\/Button>/,
  );
  // The data-attribute on the restore button locks the OPEN target.
  assert.match(COMPONENT, /data-simple-case-settings-status-to="OPEN"/);
});

test("Settings tab renders a DEDICATED Archive Case button when status is NOT ARCHIVED", () => {
  assert.match(
    COMPONENT,
    /\) : \(\s*\n?\s*<Button[\s\S]{0,400}?data-simple-case-settings-status-archive[\s\S]{0,300}?Archive Case\s*\n?\s*<\/Button>/,
  );
  assert.match(COMPONENT, /data-simple-case-settings-status-to="ARCHIVED"/);
});

test("Settings status section no longer iterates `allowedTransitions` (legacy ladder removed)", () => {
  assert.doesNotMatch(COMPONENT, /allowedTransitions\.map\(\(toStatus\) => \(/);
  // The intermediate "Move to <X>" labels must not appear anywhere
  // in the Settings status JSX.
  assert.doesNotMatch(COMPONENT, /Move to Investigating/);
  assert.doesNotMatch(COMPONENT, /Move to On Hold/);
  assert.doesNotMatch(COMPONENT, /Move to Resolved/);
  assert.doesNotMatch(COMPONENT, /Close case/);
});

test("Archive + Restore buttons are gated on canChangeStatus (the envelope's existing capability)", () => {
  for (const anchorName of [
    "data-simple-case-settings-status-restore",
    "data-simple-case-settings-status-archive",
  ]) {
    const anchor = COMPONENT.indexOf(anchorName);
    assert.ok(anchor > 0, `${anchorName} not found`);
    const window = COMPONENT.slice(Math.max(0, anchor - 300), anchor + 300);
    assert.match(window, /disabled=\{!canChangeStatus \|\| busy\}/);
  }
});

test("Restore uses the canonical useConfirmAction() modal with spec-locked copy", () => {
  assert.match(
    COMPONENT,
    /const ok = await confirm\(\{\s*\n?\s*title:\s*"Restore Case",\s*\n?\s*description:\s*\n?\s*"This will return the case to the active case list\. Linked evidence, reports, verification packages, comments, notes, and audit history remain unchanged\."/,
  );
  assert.match(COMPONENT, /confirmLabel:\s*"Restore Case"/);
  assert.match(COMPONENT, /testId:\s*"simple-case-settings-restore"/);
});

test("Archive uses the canonical useConfirmAction() modal with spec-locked copy", () => {
  assert.match(
    COMPONENT,
    /const ok = await confirm\(\{\s*\n?\s*title:\s*"Archive Case",\s*\n?\s*description:[\s\S]{0,400}?"This hides the case from the active list\. Linked evidence, reports, verification packages, comments, notes, and audit history remain preserved and unchanged\./,
  );
  assert.match(COMPONENT, /confirmLabel:\s*"Archive Case"/);
  assert.match(COMPONENT, /testId:\s*"simple-case-settings-archive"/);
});

test("Restore POSTs to /v1/cases/:id/status with toStatus 'OPEN' (re-uses handleStatusChange)", () => {
  assert.match(
    COMPONENT,
    /const handleRestore = useCallback\(async \(\)[\s\S]{0,800}?await handleStatusChange\("OPEN"\);/,
  );
});

test("Archive POSTs to /v1/cases/:id/status with toStatus 'ARCHIVED' (re-uses handleStatusChange)", () => {
  assert.match(
    COMPONENT,
    /const handleArchive = useCallback\(async \(\)[\s\S]{0,800}?await handleStatusChange\("ARCHIVED"\);/,
  );
});

test("Settings tab no longer renders the legacy 'Archived is a final status' copy", () => {
  assert.doesNotMatch(
    COMPONENT,
    /Archived is a final status — no further transitions are available from here\./,
  );
});

test("No window.confirm reintroduced (Phase Final-D3 guard cross-check)", () => {
  assert.doesNotMatch(COMPONENT, /window\.confirm\(/);
  assert.doesNotMatch(COMPONENT, /globalThis\.confirm\(/);
});

// ===========================================================================
// Enterprise MatterWorkspace untouched
// ===========================================================================

test("Enterprise MatterWorkspace surface has NO new Restore UI (Personal-mode SimpleCaseDetail owns it)", () => {
  assert.doesNotMatch(MATTER_WORKSPACE, /Restore Case/);
  assert.doesNotMatch(MATTER_WORKSPACE, /data-simple-case-settings-status-restore/);
});
