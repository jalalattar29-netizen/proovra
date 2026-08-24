/**
 * EVIDENCE LIFECYCLE — the browser holds no decision.
 *
 * WHAT THIS SUITE USED TO ASSERT
 * ---------------------------------------------------------------------------
 * That the client-side mirror computed the right answer: COMPLIANCE retention
 * blocks trash, `retentionUntilUtc` in the future blocks trash, the S3
 * legal-hold column blocks trash, and the precedence between them matched the
 * backend's. Those assertions were faithful to the code and the code was wrong.
 * Retention does not block a recoverable soft-trash — it blocks physical
 * destruction — and a browser cannot see the legal-hold tables at all, so its
 * "no hold, go ahead" was a guess.
 *
 * WHAT IT ASSERTS NOW
 * ---------------------------------------------------------------------------
 * That the module reads the server's canonical projection and computes nothing:
 * the same input produces the same answer as the server did, a missing
 * projection produces a REFUSAL rather than an optimistic guess, and no
 * retention column is read anywhere in the file.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ARCHIVE_AS_ALTERNATIVE_COPY,
  getEvidenceDeletionEligibility,
  getEvidenceLifecycle,
  getRetentionPosture,
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

const FAR_FUTURE = new Date(Date.now() + 3000 * 24 * 60 * 60 * 1000).toISOString();

/** A projection as the API would emit it, with the parts under test overridden. */
function projection(over: Record<string, unknown> = {}) {
  return {
    lifecycle: {
      productState: "ACTIVE",
      canArchive: true,
      canUnarchive: false,
      canTrash: true,
      canRestoreFromTrash: false,
      trashBlockReason: null,
      trashGraceUntilUtc: null,
      appRetentionUntilUtc: null,
      objectLockRetainUntilUtc: null,
      effectiveRetentionUntilUtc: null,
      objectLockCompliance: false,
      legalHold: false,
      destructionEligibleAtUtc: null,
      destructionBlockReason: null,
      ...over,
    },
  } as never;
}

// ===========================================================================
// The helper reads the projection and nothing else
// ===========================================================================

test("a retained record CAN be moved to trash", () => {
  // The headline correction. This exact record — retained until 2034, under
  // COMPLIANCE Object Lock — is the one the old mirror refused, and refusing it
  // was the bug: moving it to trash deletes nothing.
  const r = getEvidenceDeletionEligibility(
    projection({
      appRetentionUntilUtc: FAR_FUTURE,
      objectLockRetainUntilUtc: FAR_FUTURE,
      effectiveRetentionUntilUtc: FAR_FUTURE,
      objectLockCompliance: true,
      destructionBlockReason: "OBJECT_LOCK_RETENTION_ACTIVE",
      destructionEligibleAtUtc: FAR_FUTURE,
    }),
  );
  assert.equal(r.canMoveToTrash, true);
  assert.equal(r.reasonCode, null);
});

test("a legal hold blocks trash and says so", () => {
  const r = getEvidenceDeletionEligibility(
    projection({ canTrash: false, trashBlockReason: "LEGAL_HOLD_ACTIVE", legalHold: true }),
  );
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "LEGAL_HOLD");
  assert.match(r.message, /legal hold/i);
});

test("a permanently locked record blocks trash", () => {
  const r = getEvidenceDeletionEligibility(
    projection({ canTrash: false, trashBlockReason: "EVIDENCE_LOCKED" }),
  );
  assert.equal(r.reasonCode, "EVIDENCE_LOCKED");
});

test("an already-trashed record reports ALREADY_DELETED, not an error", () => {
  const r = getEvidenceDeletionEligibility(
    projection({
      productState: "TRASHED",
      canTrash: false,
      canRestoreFromTrash: true,
      trashBlockReason: "ALREADY_IN_STATE",
    }),
  );
  assert.equal(r.canMoveToTrash, false);
  assert.equal(r.reasonCode, "ALREADY_DELETED");
});

test("a destroyed record is terminal", () => {
  const r = getEvidenceDeletionEligibility(
    projection({
      productState: "DESTROYED",
      canArchive: false,
      canTrash: false,
      canRestoreFromTrash: false,
      trashBlockReason: "TERMINAL_DESTROYED",
    }),
  );
  assert.equal(r.canMoveToTrash, false);
  assert.match(r.message, /tombstone/i);
});

test("NO projection means refuse, never guess", () => {
  // A response that predates the projection, or a record still loading. The
  // conservative answer is the only safe one: an enabled control the server
  // will reject is worse than a disabled one.
  for (const input of [null, undefined, {} as never]) {
    const r = getEvidenceDeletionEligibility(input);
    assert.equal(r.canMoveToTrash, false, "must not enable trash without a verdict");
    assert.equal(r.reasonCode, "UNKNOWN");
  }
});

test("the legacy deleteEligibility field is used verbatim when the projection is absent", () => {
  const r = getEvidenceDeletionEligibility({
    deleteEligibility: {
      canMoveToTrash: false,
      reasonCode: "LEGAL_HOLD",
      blockedUntil: null,
      message: "From the server.",
    },
  } as never);
  assert.equal(r.message, "From the server.");
});

test("getEvidenceLifecycle returns the projection, or null", () => {
  assert.equal(getEvidenceLifecycle(projection())?.productState, "ACTIVE");
  assert.equal(getEvidenceLifecycle(null), null);
  assert.equal(getEvidenceLifecycle({} as never), null);
});

// ===========================================================================
// Retention is reported as a fact, independently of availability
// ===========================================================================

test("retention posture states what retention constrains — destruction", () => {
  const p = getRetentionPosture(
    projection({
      effectiveRetentionUntilUtc: FAR_FUTURE,
      objectLockCompliance: true,
      canTrash: true,
    }),
  );
  assert.match(p.retainedUntilLabel ?? "", /^Retained until [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.equal(p.objectLockLabel, "Object Lock: Compliance");
  assert.match(p.destructionNote ?? "", /^Physical destruction unavailable until /);
  // And it says nothing about trash, because retention has nothing to say
  // about trash.
  assert.doesNotMatch(p.destructionNote ?? "", /trash/i);
});

test("an expired retention deadline reports no posture at all", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const p = getRetentionPosture(projection({ effectiveRetentionUntilUtc: past }));
  assert.equal(p.retainedUntilLabel, null);
  assert.equal(p.destructionNote, null);
});

// ===========================================================================
// Source-pinned: no decision may return to the browser
// ===========================================================================

test("the helper reads no raw retention column", () => {
  // Comments stripped: the module header NAMES these columns to explain what it
  // stopped doing, and a docstring describing a removed behaviour is not that
  // behaviour returning.
  const body = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /\/\/[^\n]*/g,
    "",
  );
  for (const column of [
    "storageObjectLockMode",
    "storageObjectLockRetainUntilUtc",
    "storageObjectLockLegalHoldStatus",
    "retentionUntilUtc",
  ]) {
    assert.ok(
      !body.includes(column),
      `the browser must not read ${column} — it cannot see the hold tables`,
    );
  }
});

test("EvidenceReviewTab drives every lifecycle control from the projection", () => {
  assert.match(REVIEW_TAB, /const lifecycle = getEvidenceLifecycle\(evidence\);/);
  assert.match(REVIEW_TAB, /const trashDisabled = !eligibility\.canMoveToTrash;/);
  assert.match(REVIEW_TAB, /lifecycle\?\.canArchive/);
  assert.match(REVIEW_TAB, /lifecycle\?\.canUnarchive/);
  assert.match(REVIEW_TAB, /lifecycle\?\.canRestoreFromTrash/);
});

test("EvidenceReviewTab guards setTrashOpen so a disabled click cannot open the modal", () => {
  assert.match(
    REVIEW_TAB,
    /onClick=\{\(\) => \{\s*\n?\s*if \(trashDisabled\) return;\s*\n?\s*setTrashOpen\(true\);\s*\n?\s*\}\}/,
  );
});

test("EvidenceReviewTab marks the disabled trash control accessibly", () => {
  assert.match(REVIEW_TAB, /disabled=\{trashDisabled\}/);
  assert.match(REVIEW_TAB, /aria-disabled=\{trashDisabled\}/);
  assert.match(REVIEW_TAB, /id="evidence-trash-helper"/);
  assert.match(REVIEW_TAB, /\{eligibility\.message\}/);
});

test("EvidenceReviewTab tags the actions and the retention block for E2E", () => {
  assert.match(REVIEW_TAB, /data-evidence-action="archive"/);
  assert.match(REVIEW_TAB, /data-evidence-action="trash"/);
  assert.match(REVIEW_TAB, /data-evidence-retention-posture/);
  assert.match(REVIEW_TAB, /data-evidence-tombstone/);
});

test("the Archive guidance no longer frames retention as the reason", () => {
  assert.equal(
    ARCHIVE_AS_ALTERNATIVE_COPY,
    "Archive removes the record from Active evidence and keeps it fully available.",
  );
  assert.match(REVIEW_TAB, /ARCHIVE_AS_ALTERNATIVE_COPY/);
});

test("BulkActionsToolbar asks the projection for all four lifecycle actions", () => {
  assert.match(BULK_TOOLBAR, /getEvidenceLifecycle\(item\)/);
  for (const cap of [
    "lifecycle.canArchive",
    "lifecycle.canUnarchive",
    "lifecycle.canTrash",
    "lifecycle.canRestoreFromTrash",
  ]) {
    assert.ok(BULK_TOOLBAR.includes(cap), `bulk availability must consult ${cap}`);
  }
  assert.match(BULK_TOOLBAR, /allSelectedProtected/);
  assert.match(BULK_TOOLBAR, /data-bulk-trash-helper/);
});

// ===========================================================================
// Wire contract
// ===========================================================================

test("the Evidence Detail response carries the canonical projection", () => {
  assert.match(EVIDENCE_ROUTES, /\[EVIDENCE_LIFECYCLE_RESPONSE_FIELD\]: lifecycleProjection,/);
  assert.match(EVIDENCE_ROUTES, /projectEvidenceLifecycle\(/);
});

test("list rows carry the same projection", () => {
  assert.match(EVIDENCE_ROUTES, /\[EVIDENCE_LIFECYCLE_RESPONSE_FIELD\]: projectEvidenceLifecycleSync\(/);
});

test("the backend service derives the legacy shape rather than computing it", () => {
  assert.match(BACKEND_SVC, /export function toLegacyDeleteEligibility/);
  assert.match(BACKEND_SVC, /toEvidenceLifecycleProjection\(/);
  // The retention reason codes stay in the union for wire compatibility and
  // must be unreachable — no branch may produce them.
  assert.ok(
    !/reasonCode: "COMPLIANCE_RETENTION"/.test(BACKEND_SVC),
    "no branch may still emit COMPLIANCE_RETENTION",
  );
  assert.ok(
    !/reasonCode: "RETENTION_UNTIL"/.test(BACKEND_SVC),
    "no branch may still emit RETENTION_UNTIL",
  );
});

test("frontend and backend reason unions stay in lockstep", () => {
  for (const literal of [
    "COMPLIANCE_RETENTION",
    "LEGAL_HOLD",
    "RETENTION_UNTIL",
    "EVIDENCE_LOCKED",
    "ALREADY_DELETED",
    "UNKNOWN",
  ]) {
    assert.match(TYPES_SRC, new RegExp(`"${literal}"`), `frontend union missing ${literal}`);
    assert.match(BACKEND_SVC, new RegExp(`"${literal}"`), `backend union missing ${literal}`);
  }
});

// ===========================================================================
// Copy policy
// ===========================================================================

const BANNED_COPY = [
  new RegExp("tamper" + "[- ]?" + "proof", "i"),
  new RegExp("legally" + " " + "guaranteed", "i"),
  new RegExp("permanently" + " " + "undeletable", "i"),
  new RegExp("court" + "[- ]?" + "proof", "i"),
  new RegExp("admis" + "sible", "i"),
];

test("the record-actions block contains no banned overclaim", () => {
  const start = REVIEW_TAB.indexOf('data-evidence-section="record-actions"');
  assert.ok(start > 0, "record-actions section anchor not found");
  const slice = REVIEW_TAB.slice(start, start + 6000);
  for (const pattern of BANNED_COPY) assert.doesNotMatch(slice, pattern);
});

test("BulkActionsToolbar contains no banned overclaim", () => {
  for (const pattern of BANNED_COPY) assert.doesNotMatch(BULK_TOOLBAR, pattern);
});

test("the helper contains no banned overclaim outside comments", () => {
  const stripped = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const pattern of BANNED_COPY) assert.doesNotMatch(stripped, pattern);
});

test("no emoji in the lifecycle surfaces", () => {
  const emojiPattern = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
  const reviewBlockStart = REVIEW_TAB.indexOf("data-evidence-record-actions");
  assert.doesNotMatch(REVIEW_TAB.slice(reviewBlockStart, reviewBlockStart + 4000), emojiPattern);
  assert.doesNotMatch(HELPER_SRC, emojiPattern);
  const bulkBlockStart = BULK_TOOLBAR.indexOf("data-bulk-trash-helper");
  assert.doesNotMatch(BULK_TOOLBAR.slice(bulkBlockStart, bulkBlockStart + 2000), emojiPattern);
});
