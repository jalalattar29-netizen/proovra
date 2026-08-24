/**
 * Canonical Evidence retention/archive/trash/destruction authority — proofs.
 *
 * These pin the convergence's core rules: product-state precedence, the
 * corrected "retention/lock block DESTRUCTION, not soft-trash" semantics, the
 * max-of-all-boundaries destruction eligibility, single==bulk equivalence (one
 * pure function), and the certificate-timing invariant (never eligible before
 * every boundary clears). Production truth is COMPLIANCE + 2920 days.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveEvidenceProductState,
  computeEffectiveRetentionUntil,
  computeEvidenceDestructionEligibility,
  computeEvidenceLifecycleCapabilities,
  evaluateDestructionCandidate,
} from "../dist/index.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const iso = (s) => new Date(s).toISOString();
const RETAIN_2034 = iso("2034-07-04T00:00:00.000Z"); // ~2920d after a 2026 create
const PAST = iso("2026-06-01T00:00:00.000Z");
const FUTURE = iso("2027-06-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Product state precedence
// ---------------------------------------------------------------------------

test("product state: DESTROYED > TRASHED > ARCHIVED > ACTIVE", () => {
  assert.equal(resolveEvidenceProductState({}), "ACTIVE");
  assert.equal(resolveEvidenceProductState({ archivedAt: PAST }), "ARCHIVED");
  assert.equal(resolveEvidenceProductState({ trashedAt: PAST }), "TRASHED");
  // trash wins over archive when both timestamps are present
  assert.equal(resolveEvidenceProductState({ archivedAt: PAST, trashedAt: PAST }), "TRASHED");
  assert.equal(resolveEvidenceProductState({ lifecycleState: "DESTROYED" }), "DESTROYED");
  assert.equal(resolveEvidenceProductState({ destroyedAt: PAST, trashedAt: PAST }), "DESTROYED");
});

test("retention NEVER changes product state — a retained active record is ACTIVE", () => {
  assert.equal(
    resolveEvidenceProductState({ appRetentionUntil: RETAIN_2034, objectLockRetainUntil: RETAIN_2034 }),
    "ACTIVE",
  );
});

// ---------------------------------------------------------------------------
// Corrected semantics: retention/lock/hold block DESTRUCTION, not soft-trash
// ---------------------------------------------------------------------------

test("CORE: a record retained until 2034 can still be trashed in 2027", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    { appRetentionUntil: RETAIN_2034, objectLockRetainUntil: RETAIN_2034, objectLockMode: "COMPLIANCE" },
    NOW,
  );
  assert.equal(caps.productState, "ACTIVE");
  assert.equal(caps.canTrash, true, "retention must NOT block recoverable trash");
  assert.equal(caps.canArchive, true, "retention must NOT block archive");
  // …but it absolutely cannot be destroyed yet.
  assert.equal(caps.canDestroy, false);
});

test("a legal hold does NOT block recoverable trash, but DOES block destruction", () => {
  const caps = computeEvidenceLifecycleCapabilities({ legalHold: true }, NOW);
  assert.equal(caps.canTrash, true);
  const trashedHeld = computeEvidenceLifecycleCapabilities(
    { trashedAt: PAST, trashGraceUntil: PAST, legalHold: true },
    NOW,
  );
  assert.equal(trashedHeld.canDestroy, false);
  assert.equal(trashedHeld.destructionBlockReason, "LEGAL_HOLD_ACTIVE");
});

test("a PERMANENT record lock blocks trash, restore, and destroy", () => {
  const active = computeEvidenceLifecycleCapabilities({ lockedAt: PAST }, NOW);
  assert.equal(active.canTrash, false);
  assert.equal(active.canArchive, false);
  const trashedLocked = computeEvidenceLifecycleCapabilities(
    { trashedAt: PAST, lockedAt: PAST, trashGraceUntil: PAST },
    NOW,
  );
  assert.equal(trashedLocked.canRestoreFromTrash, false);
  assert.equal(trashedLocked.canDestroy, false);
});

// ---------------------------------------------------------------------------
// Capability matrix per product state
// ---------------------------------------------------------------------------

test("capability matrix: ACTIVE / ARCHIVED / TRASHED / DESTROYED", () => {
  const active = computeEvidenceLifecycleCapabilities({}, NOW);
  assert.deepEqual(
    [active.canArchive, active.canUnarchive, active.canTrash, active.canRestoreFromTrash],
    [true, false, true, false],
  );

  const archived = computeEvidenceLifecycleCapabilities({ archivedAt: PAST }, NOW);
  assert.deepEqual(
    [archived.canArchive, archived.canUnarchive, archived.canTrash, archived.canRestoreFromTrash],
    [false, true, true, false],
    "archived can be restored-to-active or trashed, but not re-archived",
  );

  const trashed = computeEvidenceLifecycleCapabilities({ trashedAt: PAST, trashGraceUntil: PAST }, NOW);
  assert.deepEqual(
    [trashed.canArchive, trashed.canUnarchive, trashed.canTrash, trashed.canRestoreFromTrash],
    [false, false, false, true],
  );

  const destroyed = computeEvidenceLifecycleCapabilities({ lifecycleState: "DESTROYED" }, NOW);
  assert.deepEqual(
    [destroyed.canArchive, destroyed.canUnarchive, destroyed.canTrash, destroyed.canRestoreFromTrash, destroyed.canDestroy],
    [false, false, false, false, false],
    "DESTROYED is terminal and immutable",
  );
});

// ---------------------------------------------------------------------------
// Effective retention = max(app, objectLock)
// ---------------------------------------------------------------------------

test("effective retention is the LATER of app retention and S3 object-lock retain", () => {
  assert.equal(
    computeEffectiveRetentionUntil({ appRetentionUntil: iso("2030-01-01"), objectLockRetainUntil: RETAIN_2034 })?.toISOString(),
    new Date(RETAIN_2034).toISOString(),
  );
  assert.equal(
    computeEffectiveRetentionUntil({ appRetentionUntil: RETAIN_2034, objectLockRetainUntil: iso("2030-01-01") })?.toISOString(),
    new Date(RETAIN_2034).toISOString(),
  );
});

// ---------------------------------------------------------------------------
// Destruction eligibility = max of ALL boundaries, fail-closed precedence
// ---------------------------------------------------------------------------

function trashedInput(over = {}) {
  return { trashedAt: PAST, trashGraceUntil: PAST, ...over };
}

test("destruction eligibility walks every boundary in order", () => {
  // not trashed
  assert.equal(computeEvidenceDestructionEligibility({}, NOW).blockReason, "NOT_TRASHED");
  // trash grace still active
  assert.equal(
    computeEvidenceDestructionEligibility(trashedInput({ trashGraceUntil: FUTURE }), NOW).blockReason,
    "TRASH_GRACE_ACTIVE",
  );
  // app retention active
  assert.equal(
    computeEvidenceDestructionEligibility(trashedInput({ appRetentionUntil: FUTURE }), NOW).blockReason,
    "APP_RETENTION_ACTIVE",
  );
  // object-lock retention active (the hard physical boundary)
  assert.equal(
    computeEvidenceDestructionEligibility(
      trashedInput({ objectLockRetainUntil: RETAIN_2034, objectLockMode: "COMPLIANCE" }),
      NOW,
    ).blockReason,
    "OBJECT_LOCK_RETENTION_ACTIVE",
  );
  // approval required but not present
  assert.equal(
    computeEvidenceDestructionEligibility(
      trashedInput({ destructionApprovalRequired: true, destructionApproved: false }),
      NOW,
    ).blockReason,
    "DESTRUCTION_APPROVAL_REQUIRED",
  );
  // legal hold outranks the time boundaries
  assert.equal(
    computeEvidenceDestructionEligibility(trashedInput({ legalHold: true, appRetentionUntil: FUTURE }), NOW).blockReason,
    "LEGAL_HOLD_ACTIVE",
  );
});

test("fully eligible only when trashed + every boundary passed + no hold + approval satisfied", () => {
  const e = computeEvidenceDestructionEligibility(
    trashedInput({ appRetentionUntil: PAST, objectLockRetainUntil: PAST, destructionApprovalRequired: true, destructionApproved: true }),
    NOW,
  );
  assert.equal(e.eligible, true);
  assert.equal(e.blockReason, null);
});

test("destructionEligibleAt is the MAX of the three time boundaries (production 2034 case)", () => {
  const e = computeEvidenceDestructionEligibility(
    trashedInput({ trashGraceUntil: iso("2027-04-01"), appRetentionUntil: iso("2031-01-01"), objectLockRetainUntil: RETAIN_2034 }),
    NOW,
  );
  assert.equal(e.destructionEligibleAt?.toISOString(), new Date(RETAIN_2034).toISOString());
});

test("INVARIANT: never eligible while ANY boundary is in the future", () => {
  const boundaries = ["trashGraceUntil", "appRetentionUntil", "objectLockRetainUntil"];
  for (const b of boundaries) {
    const e = computeEvidenceDestructionEligibility(
      trashedInput({ appRetentionUntil: PAST, objectLockRetainUntil: PAST, trashGraceUntil: PAST, [b]: FUTURE }),
      NOW,
    );
    assert.equal(e.eligible, false, `${b} in the future must block destruction`);
  }
});

// ---------------------------------------------------------------------------
// Single == bulk: one pure function ⇒ identical verdicts
// ---------------------------------------------------------------------------

test("single and bulk agree by construction — same input, same capabilities", () => {
  // The audited bug: a retained ACTIVE record could be trashed via one path and
  // not the other. Here it is one active record retained to 2034 under
  // COMPLIANCE; single and bulk are the SAME pure call, so they cannot diverge.
  const input = { appRetentionUntil: RETAIN_2034, objectLockRetainUntil: RETAIN_2034, objectLockMode: "COMPLIANCE" };
  const single = computeEvidenceLifecycleCapabilities(input, NOW);
  const bulk = [input, input].map((i) => computeEvidenceLifecycleCapabilities(i, NOW));
  for (const b of bulk) assert.deepEqual(b, single);
  assert.equal(single.productState, "ACTIVE");
  assert.equal(single.canTrash, true, "retained active record is trashable in both paths");
  assert.equal(single.canDestroy, false, "…but not destroyable until 2034");
});

// ---------------------------------------------------------------------------
// Dry-run candidate evaluation shares the authority
// ---------------------------------------------------------------------------

test("dry-run candidate evaluation matches the destruction-eligibility authority", () => {
  const input = trashedInput({ objectLockRetainUntil: RETAIN_2034 });
  const cand = evaluateDestructionCandidate(input, NOW);
  const elig = computeEvidenceDestructionEligibility(input, NOW);
  assert.equal(cand.eligible, elig.eligible);
  assert.equal(cand.blockReason, elig.blockReason);
  assert.equal(cand.productState, "TRASHED");
  assert.equal(cand.trashGraceExpired, true);
});

test("COMPLIANCE object lock is surfaced and treated as a hard boundary", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    trashedInput({ objectLockMode: "COMPLIANCE", objectLockRetainUntil: RETAIN_2034 }),
    NOW,
  );
  assert.equal(caps.objectLockCompliance, true);
  assert.equal(caps.canDestroy, false);
  assert.equal(caps.destructionBlockReason, "OBJECT_LOCK_RETENTION_ACTIVE");
});
