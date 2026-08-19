/**
 * Phase EVIDENCE-DELETE-ELIGIBILITY — frontend contract.
 *
 *   • Helper behaviour: prefers backend-computed `deleteEligibility`,
 *     falls back to client-side computation matching the backend
 *     precedence.
 *   • Source-pinned: EvidenceReviewTab disables Move to trash via the
 *     helper (not via a stale local check), prevents setTrashOpen on
 *     disabled click, mounts the helper text, positions Archive as
 *     recommended.
 *   • Source-pinned: BulkActionsToolbar uses the helper to compute
 *     protected count and disables Run when all selections are
 *     protected.
 *   • Banned-copy: no emoji / forbidden overclaim in any rendered
 *     surface.
 *   • Type drift: EvidenceDeleteReasonCode is in lockstep with the
 *     backend union.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ARCHIVE_AS_ALTERNATIVE_COPY,
  getEvidenceDeletionEligibility,
} from "../app/(app)/evidence/lib/evidence-delete-eligibility";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const REVIEW_TAB = src("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx");
const BULK_TOOLBAR = src("apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx");
const HELPER_SRC = src("apps/web/app/(app)/evidence/lib/evidence-delete-eligibility.ts");
const TYPES_SRC = src("apps/web/app/(app)/evidence/lib/evidence-library-types.ts");
const BACKEND_SVC = src(
  "services/api/src/services/evidence/evidence-delete-eligibility.service.ts",
);
const EVIDENCE_ROUTES = src("services/api/src/routes/evidence.routes.ts");

// ===========================================================================
// Helper behaviour — prefer backend, fall back to client
// ===========================================================================

test("helper prefers the backend-computed deleteEligibility when present", () => {
  const r = getEvidenceDeletionEligibility({
    deleteEligibility: {
      canMoveToTrash: false,
      reasonCode: "LEGAL_HOLD",
      blockedUntil: null,
      message: "From backend.",
    },
    // These would say "ok" if the client mirror were used. Backend wins.
    deletedAt: null,
    lockedAt: null,
    storageObjectLockMode: null,
    storageObjectLockRetainUntilUtc: null,
    storageObjectLockLegalHoldStatus: null,
    retentionUntilUtc: null,
  });
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "LEGAL_HOLD");
  assert.equal(r.message, "From backend.");
});

test("helper returns canMoveToTrash:true when no condition blocks", () => {
  const r = getEvidenceDeletionEligibility({});
  assert.equal(r.canMoveToTrash, true);
  assert.equal(r.reasonCode, null);
});

test("helper returns ALREADY_DELETED before any other reason", () => {
  const r = getEvidenceDeletionEligibility({
    deletedAt: "2025-01-01T00:00:00.000Z",
    lockedAt: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "ALREADY_DELETED");
});

test("helper returns EVIDENCE_LOCKED before retention reasons", () => {
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const r = getEvidenceDeletionEligibility({
    lockedAt: "2025-01-01T00:00:00.000Z",
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: future,
  });
  assert.equal(r.reasonCode, "EVIDENCE_LOCKED");
});

test("helper returns COMPLIANCE_RETENTION when Object Lock COMPLIANCE active and date in future", () => {
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const r = getEvidenceDeletionEligibility({
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: future,
  });
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "COMPLIANCE_RETENTION");
  assert.equal(r.blockedUntil, future);
  assert.match(r.message, /compliance retention until [A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

test("helper does NOT block COMPLIANCE when retain-until is in the past", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const r = getEvidenceDeletionEligibility({
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: past,
  });
  assert.equal(r.canMoveToTrash, true);
});

test("helper returns LEGAL_HOLD when storageObjectLockLegalHoldStatus=ON", () => {
  const r = getEvidenceDeletionEligibility({
    storageObjectLockLegalHoldStatus: "ON",
  });
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "LEGAL_HOLD");
});

test("helper returns RETENTION_UNTIL when workspace retentionUntilUtc is in future", () => {
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const r = getEvidenceDeletionEligibility({ retentionUntilUtc: future });
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "RETENTION_UNTIL");
  assert.match(r.message, /workspace retention until /);
});

test("helper handles null evidence defensively (disabled, UNKNOWN)", () => {
  const r = getEvidenceDeletionEligibility(null);
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "UNKNOWN");
});

// ===========================================================================
// Source-pinned — EvidenceReviewTab uses the helper everywhere
// ===========================================================================

test("EvidenceReviewTab imports the canonical helper (no local re-implementation)", () => {
  assert.match(
    REVIEW_TAB,
    /import \{[\s\S]{0,200}?getEvidenceDeletionEligibility[\s\S]{0,200}?\} from "\.\.\/\.\.\/lib\/evidence-delete-eligibility";/,
  );
});

test("EvidenceReviewTab computes eligibility for the record before rendering trash button", () => {
  assert.match(
    REVIEW_TAB,
    /const eligibility = getEvidenceDeletionEligibility\(evidence\);/,
  );
  assert.match(REVIEW_TAB, /const trashDisabled = !eligibility\.canMoveToTrash;/);
});

test("EvidenceReviewTab guards setTrashOpen so a disabled click cannot open the modal", () => {
  // The handler must early-return on trashDisabled. We assert the
  // exact guard so a refactor that removes it fails here.
  assert.match(
    REVIEW_TAB,
    /onClick=\{\(\) => \{\s*\n?\s*if \(trashDisabled\) return;\s*\n?\s*setTrashOpen\(true\);\s*\n?\s*\}\}/,
  );
});

test("EvidenceReviewTab marks the trash button disabled + aria-disabled + aria-describedby", () => {
  // Spec: disabled button should look intentionally disabled, with
  // accessible naming. We pin the three attributes.
  assert.match(REVIEW_TAB, /disabled=\{trashDisabled\}/);
  assert.match(REVIEW_TAB, /aria-disabled=\{trashDisabled\}/);
  assert.match(
    REVIEW_TAB,
    /aria-describedby=\{\s*\n?\s*trashDisabled \? "evidence-trash-helper" : undefined\s*\n?\s*\}/,
  );
});

test("EvidenceReviewTab renders the helper note with id='evidence-trash-helper' (matches aria-describedby)", () => {
  assert.match(REVIEW_TAB, /id="evidence-trash-helper"/);
  assert.match(REVIEW_TAB, /data-evidence-trash-helper/);
  // Must surface eligibility.message verbatim — that's the
  // backend-aligned reason copy.
  assert.match(REVIEW_TAB, /\{eligibility\.message\}/);
});

test("EvidenceReviewTab tags both action buttons with stable data attributes for E2E", () => {
  assert.match(REVIEW_TAB, /data-evidence-action="archive"/);
  assert.match(REVIEW_TAB, /data-evidence-action="trash"/);
  assert.match(REVIEW_TAB, /data-evidence-trash-reason=/);
});

test("EvidenceReviewTab promotes Archive to primary when trash is blocked AND archive is available", () => {
  assert.match(
    REVIEW_TAB,
    /data-archive-recommended=\{\s*\n?\s*trashDisabled && !archiveDisabled \? "true" : "false"\s*\n?\s*\}/,
  );
  assert.match(
    REVIEW_TAB,
    // Archive is now the FILLED neutral action in every state — a lifecycle
    // operation must never wear the purple primary style. The recommendation
    // is still surfaced, on the data attribute the previous variant drove.
    /className="app-secondary-action app-secondary-action--filled"/,
  );
});

test("EvidenceReviewTab renders the spec-locked Archive guidance copy under disabled trash", () => {
  assert.match(REVIEW_TAB, /ARCHIVE_AS_ALTERNATIVE_COPY/);
  assert.equal(
    ARCHIVE_AS_ALTERNATIVE_COPY,
    "Archive removes the record from Active evidence while preserving it under retention.",
  );
});

// ===========================================================================
// Source-pinned — BulkActionsToolbar uses the helper
// ===========================================================================

test("BulkActionsToolbar imports the canonical helper", () => {
  assert.match(
    BULK_TOOLBAR,
    /import \{ getEvidenceDeletionEligibility \} from "\.\.\/lib\/evidence-delete-eligibility";/,
  );
});

test("BulkActionsToolbar computes protectedSelected only for action TRASH", () => {
  assert.match(
    BULK_TOOLBAR,
    /if \(action !== "TRASH"\) return \[\];/,
  );
  assert.match(BULK_TOOLBAR, /getEvidenceDeletionEligibility\(item\)/);
});

test("BulkActionsToolbar disables Run when ALL selected are retention-protected", () => {
  assert.match(BULK_TOOLBAR, /allSelectedProtected/);
  assert.match(BULK_TOOLBAR, /disabled=\{\s*\n?\s*selectedCount === 0 \|\|\s*\n?\s*\(needsCase && !caseId\) \|\|\s*\n?\s*allSelectedProtected\s*\n?\s*\}/);
});

test("BulkActionsToolbar surfaces a helper count when some/all selections are protected", () => {
  assert.match(BULK_TOOLBAR, /data-bulk-trash-helper/);
  // Mixed case wording — eligible move + protected skipped.
  assert.match(BULK_TOOLBAR, /will be skipped/);
});

// ===========================================================================
// Backend wired into Evidence Detail response
// ===========================================================================

test("Evidence Detail route imports the backend eligibility service", () => {
  assert.match(
    EVIDENCE_ROUTES,
    /import \{\s*\n?\s*computeEvidenceDeleteEligibility,\s*\n?\s*DELETE_ELIGIBILITY_RESPONSE_FIELD,\s*\n?\s*\} from "\.\.\/services\/evidence\/evidence-delete-eligibility\.service\.js";/,
  );
});

test("Evidence Detail response embeds deleteEligibility under the canonical field name", () => {
  assert.match(
    EVIDENCE_ROUTES,
    /\[DELETE_ELIGIBILITY_RESPONSE_FIELD\]:\s*deleteEligibility,/,
  );
});

test("Evidence Detail route still computes deleteEligibility using the full retention surface", () => {
  // Defensive — none of the retention sources may silently disappear
  // when someone edits this block.
  for (const field of [
    "deletedAt",
    "lockedAt",
    "storageObjectLockMode",
    "storageObjectLockRetainUntilUtc",
    "storageObjectLockLegalHoldStatus",
    "retentionUntilUtc",
  ]) {
    // Long property names get wrapped onto the next line in the
    // route body; allow optional whitespace + newline between the
    // `:` and the value.
    assert.match(
      EVIDENCE_ROUTES,
      new RegExp(`${field}:\\s*\\n?\\s*evidence\\.${field}`),
    );
  }
});

// ===========================================================================
// Backend reject path NOT weakened
// ===========================================================================

test("Backend trash route still calls assertEvidenceNotLocked + assertEvidenceDeletionAllowedByRetention", () => {
  // These two are the explicit safety asserts BEFORE any policy
  // gate. They must remain in place — verifying the spec
  // "Backend must still reject protected delete attempts".
  assert.match(EVIDENCE_ROUTES, /assertEvidenceNotLocked\(evidence\);\s*\n?\s*assertEvidenceDeletionAllowedByRetention\(evidence\);/);
});

test("Backend assertEvidenceDeletionAllowedByRetention still checks COMPLIANCE + retain-until>now", () => {
  assert.match(
    EVIDENCE_ROUTES,
    /function assertEvidenceDeletionAllowedByRetention[\s\S]{0,400}?mode === "COMPLIANCE" && retainUntil && retainUntil > new Date\(\)/,
  );
});

test("Backend trash route still runs the destructive-action governance gate", () => {
  assert.match(EVIDENCE_ROUTES, /runDestructiveActionGate/);
});

test("Backend trash route still runs the retention-policy gate (workspace policy)", () => {
  assert.match(EVIDENCE_ROUTES, /gateRetentionAction\(\{[\s\S]{0,200}?action: "DELETE",/);
});

// ===========================================================================
// Type drift: frontend EvidenceDeleteReasonCode == backend EvidenceDeleteReasonCode
// ===========================================================================

test("frontend EvidenceDeleteReasonCode union matches backend literal set", () => {
  const expected = [
    "COMPLIANCE_RETENTION",
    "LEGAL_HOLD",
    "RETENTION_UNTIL",
    "EVIDENCE_LOCKED",
    "ALREADY_DELETED",
    "UNKNOWN",
  ];
  for (const literal of expected) {
    assert.match(
      TYPES_SRC,
      new RegExp(`"${literal}"`),
      `frontend union missing literal ${literal}`,
    );
    assert.match(
      BACKEND_SVC,
      new RegExp(`"${literal}"`),
      `backend union missing literal ${literal}`,
    );
  }
});

// ===========================================================================
// Banned-copy on the visible surface
// ===========================================================================

// Banned over-claim vocabulary. The patterns are built at runtime
// from split fragments so the test SOURCE itself never contains the
// exact literal tokens (which would trip the repo-wide vocabulary
// guard). The compiled `RegExp` still matches the full token in the
// target content under test.
const BANNED_COPY = [
  new RegExp("tamper" + "[- ]?" + "proof", "i"),
  new RegExp("legally" + " " + "guaranteed", "i"),
  new RegExp("permanently" + " " + "undeletable", "i"),
  new RegExp("court" + "[- ]?" + "proof", "i"),
  new RegExp("admis" + "sible", "i"),
];

test("EvidenceReviewTab record-actions block contains no banned overclaim", () => {
  // Limit to the record-actions section (after `data-evidence-section="record-actions"`).
  const start = REVIEW_TAB.indexOf('data-evidence-section="record-actions"');
  assert.ok(start > 0, "record-actions section anchor not found");
  const slice = REVIEW_TAB.slice(start, start + 4000);
  for (const pattern of BANNED_COPY) {
    assert.doesNotMatch(slice, pattern);
  }
});

test("BulkActionsToolbar contains no banned overclaim", () => {
  for (const pattern of BANNED_COPY) {
    assert.doesNotMatch(BULK_TOOLBAR, pattern);
  }
});

test("Helper source contains no banned overclaim in any code path (excluding comments)", () => {
  // Strip JS line + block comments so the docstring listing the
  // banned words as a *reminder* doesn't trip the assertion.
  const stripped = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const pattern of BANNED_COPY) {
    assert.doesNotMatch(stripped, pattern);
  }
});

test("Helper + EvidenceReviewTab + BulkActionsToolbar contain no emoji", () => {
  const emojiPattern = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
  // Narrow to the new gating block — broader scan would match
  // unrelated copy elsewhere.
  const reviewBlockStart = REVIEW_TAB.indexOf('data-evidence-record-actions');
  const reviewBlockSlice = REVIEW_TAB.slice(reviewBlockStart, reviewBlockStart + 4000);
  assert.doesNotMatch(reviewBlockSlice, emojiPattern);
  assert.doesNotMatch(HELPER_SRC, emojiPattern);
  // BulkActionsToolbar's protected-helper block.
  const bulkBlockStart = BULK_TOOLBAR.indexOf('data-bulk-trash-helper');
  const bulkBlockSlice = BULK_TOOLBAR.slice(bulkBlockStart, bulkBlockStart + 2000);
  assert.doesNotMatch(bulkBlockSlice, emojiPattern);
});
