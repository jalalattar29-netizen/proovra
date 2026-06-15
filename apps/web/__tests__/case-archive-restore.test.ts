/**
 * Phase CASES-STATUS-MANUAL — backend lifecycle + audit contract.
 *
 * The personal/SB Settings tab no longer renders dedicated Archive
 * or Restore buttons (those affordances were folded into the one
 * status dropdown — see `cases-status-selector.test.ts` for the
 * frontend pins). This file pins the surviving backend contract:
 *
 *   - Every status can transition to every other status (case
 *     status is organizational metadata, not a workflow state
 *     machine). The legacy ladder rows are gone from the source.
 *   - The legal-hold guard at `CLOSURE_STATUSES` still rejects
 *     ANY transition into CLOSED or ARCHIVED while a hold is
 *     active.
 *   - The dedicated `cases.restored` audit event still fires on
 *     `ARCHIVED → OPEN` (analytics back-compat).
 *   - The canonical `cases.status_changed` audit event fires on
 *     every transition (no parallel logging system).
 *   - Authorization for status mutations is unchanged
 *     (`gateCaseMutation(reply, "STATUS_CHANGE", ...)`).
 *   - No schema change.
 *   - The Personal-mode SimpleCaseDetail no longer renders
 *     Restore Case / Archive Case as dedicated buttons.
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
// Backend state machine — any → any
// ===========================================================================

test("Backend status transitions: every status can move to every other status", () => {
  // The table is now derived from the canonical STATUS_VALUES
  // list with Object.fromEntries — pin the source pattern so a
  // refactor that re-introduces hardcoded ladder rows fails here.
  assert.match(
    LIFECYCLE,
    /const STATUS_VALUES = \[\s*\n?\s*"OPEN",\s*\n?\s*"INVESTIGATING",\s*\n?\s*"ON_HOLD",\s*\n?\s*"RESOLVED",\s*\n?\s*"CLOSED",\s*\n?\s*"ARCHIVED",\s*\n?\s*\] as const;/,
  );
  assert.match(
    LIFECYCLE,
    /const ALLOWED_TRANSITIONS: Record<string, string\[\]> = Object\.fromEntries\(\s*\n?\s*STATUS_VALUES\.map\(\(from\) => \[\s*\n?\s*from,\s*\n?\s*STATUS_VALUES\.filter\(\(to\) => to !== from\),\s*\n?\s*\]\),\s*\n?\s*\);/,
  );
  // Anti-regression: the prior hardcoded ladder rows are gone.
  assert.doesNotMatch(LIFECYCLE, /OPEN:\s*\["INVESTIGATING",\s*"ON_HOLD"/);
  assert.doesNotMatch(LIFECYCLE, /ARCHIVED:\s*\["OPEN"\]/);
  assert.doesNotMatch(LIFECYCLE, /ARCHIVED:\s*\["CLOSED"\]/);
});

// ===========================================================================
// Audit event: cases.restored still fires on ARCHIVED → OPEN
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
  assert.match(
    LIFECYCLE,
    /client\.caseAssignment\.updateMany\(\{\s*\n?\s*where:\s*\{\s*caseId:\s*existing\.id,\s*status:\s*"ACTIVE"\s*\},\s*\n?\s*data:\s*\{\s*\n?\s*status:\s*"REMOVED",/,
  );
});

// ===========================================================================
// Route — no special-casing for any status
// ===========================================================================

test("POST /v1/cases/:id/status accepts every status in the enum (no route-level branch per status)", () => {
  assert.match(
    ROUTE,
    /"OPEN",\s*\n?\s*"INVESTIGATING",\s*\n?\s*"ON_HOLD",\s*\n?\s*"RESOLVED",\s*\n?\s*"CLOSED",\s*\n?\s*"ARCHIVED"/,
  );
  // No dedicated restore route was ever added.
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
// Frontend helpers — mirror of the backend any-to-any table
// ===========================================================================

test("Frontend ALLOWED_STATUS_TRANSITIONS mirrors the backend any-to-any table", () => {
  // Helpers derives the map from CASE_STATUS_OPTIONS so we only
  // need to pin the canonical option list and the Object.fromEntries
  // shape — every from-row will list every other status.
  assert.match(
    HELPERS,
    /export const CASE_STATUS_OPTIONS:[\s\S]{0,200}?\{ value: "OPEN", label: "Open" \},[\s\S]{0,200}?\{ value: "INVESTIGATING", label: "Investigating" \},[\s\S]{0,200}?\{ value: "ON_HOLD", label: "On hold" \},[\s\S]{0,200}?\{ value: "RESOLVED", label: "Resolved" \},[\s\S]{0,200}?\{ value: "CLOSED", label: "Closed" \},[\s\S]{0,200}?\{ value: "ARCHIVED", label: "Archived" \}/,
  );
  assert.match(
    HELPERS,
    /export const ALLOWED_STATUS_TRANSITIONS: Record<string, ReadonlyArray<string>> =\s*\n?\s*Object\.fromEntries\(/,
  );
});

// ===========================================================================
// Personal Settings tab no longer renders dedicated Archive/Restore buttons
// ===========================================================================

test("Personal Settings tab no longer renders dedicated Archive Case / Restore Case buttons", () => {
  // The previous v2 of this surface had two buttons:
  //   - data-simple-case-settings-status-archive
  //   - data-simple-case-settings-status-restore
  // Both are gone now; their action lives inside the single
  // status <select>.
  assert.doesNotMatch(COMPONENT, /data-simple-case-settings-status-archive/);
  assert.doesNotMatch(COMPONENT, /data-simple-case-settings-status-restore/);
  // The legacy "Move to <X>" labels must not reappear.
  for (const banned of [
    "Move to Investigating",
    "Move to On Hold",
    "Move to Resolved",
    "Move to Closed",
    "Close case",
  ]) {
    assert.doesNotMatch(COMPONENT, new RegExp(banned));
  }
});

test("Personal Settings tab exposes a single status <select> in its place", () => {
  assert.match(COMPONENT, /data-simple-case-settings-status-select/);
});

test("No window.confirm reintroduced (Phase Final-D3 guard cross-check)", () => {
  assert.doesNotMatch(COMPONENT, /window\.confirm\(/);
  assert.doesNotMatch(COMPONENT, /globalThis\.confirm\(/);
});

// ===========================================================================
// Enterprise MatterWorkspace untouched
// ===========================================================================

test("Enterprise MatterWorkspace surface has NO new Restore UI (Personal-mode SimpleCaseDetail owns the dropdown)", () => {
  assert.doesNotMatch(MATTER_WORKSPACE, /Restore Case/);
  assert.doesNotMatch(MATTER_WORKSPACE, /data-simple-case-settings-status-restore/);
});
