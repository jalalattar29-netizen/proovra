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
  toEvidenceLifecycleProjection,
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

test("a legal hold blocks BOTH trash and destruction", () => {
  // CORRECTED IN THE WIRING PASS. The additive foundation asserted that a hold
  // blocked destruction only, on the same reasoning that keeps retention from
  // blocking trash: trash deletes nothing. Wiring it to the runtime showed the
  // two obligations are not alike.
  //
  // A retention deadline says "these bytes must still exist on <date>", and a
  // recoverable trash does not contradict that. A legal hold says "preserve
  // this record and SUSPEND ROUTINE DISPOSITION on it" — and moving a record to
  // trash IS routine disposition: it leaves the working set and starts the
  // grace clock the reconciler later reads to nominate it for destruction.
  //
  // It is also what the system already did. `canDeleteEvidence` refused a
  // held record and Phase R1 deliberately extended that refusal to the bulk
  // path after finding held workspace evidence could be trashed in bulk.
  // Adopting the foundation's reading verbatim would have silently dropped a
  // protection that was added on purpose — so the authority moved to the
  // runtime's position rather than the runtime to the authority's.
  const caps = computeEvidenceLifecycleCapabilities({ legalHold: true }, NOW);
  assert.equal(caps.canTrash, false);
  assert.equal(caps.trashBlockReason, "LEGAL_HOLD_ACTIVE");

  const trashedHeld = computeEvidenceLifecycleCapabilities(
    { trashedAt: PAST, trashGraceUntil: PAST, legalHold: true },
    NOW,
  );
  assert.equal(trashedHeld.canDestroy, false);
  assert.equal(trashedHeld.destructionBlockReason, "LEGAL_HOLD_ACTIVE");
  // A record already in the trash when the hold lands can still be RESTORED —
  // restoring returns it to the working set, which is preservation, not
  // disposition.
  assert.equal(trashedHeld.canRestoreFromTrash, true);
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

// ===========================================================================
// CONVERGENCE PASS — the state pointer becomes the authority
// ===========================================================================

test("lifecycleState is the product-state authority for TRASHED and ARCHIVED", () => {
  // The whole point of the schema migration: the state is a state, not a
  // timestamp. A pointer that names a product state is taken verbatim.
  assert.equal(resolveEvidenceProductState({ lifecycleState: "TRASHED" }), "TRASHED");
  assert.equal(resolveEvidenceProductState({ lifecycleState: "ARCHIVED" }), "ARCHIVED");
  assert.equal(resolveEvidenceProductState({ lifecycleState: "DESTROYED" }), "DESTROYED");
});

test("a governance-internal posture falls through to the lifecycle timestamps", () => {
  // UNDER_REVIEW / ON_HOLD / RETENTION_LOCKED / PENDING_DESTRUCTION are not
  // product states and deliberately survive the backfill, so the product state
  // of such a record still comes from its events.
  for (const posture of [
    "UNDER_REVIEW",
    "ON_HOLD",
    "RETENTION_LOCKED",
    "PENDING_DESTRUCTION",
  ]) {
    assert.equal(
      resolveEvidenceProductState({ lifecycleState: posture }),
      "ACTIVE",
      `${posture} with no events is ACTIVE`,
    );
    assert.equal(
      resolveEvidenceProductState({ lifecycleState: posture, trashedAt: "2026-01-01T00:00:00Z" }),
      "TRASHED",
      `${posture} with a trash event is TRASHED`,
    );
  }
});

test("a pointer saying ACTIVE does not override a trash timestamp", () => {
  // ACTIVE is the column DEFAULT, so it is also what a row reads as when
  // nobody set it — a weaker claim than an explicit TRASHED. Resolving ACTIVE
  // here would put a trashed record back on the active shelf.
  assert.equal(
    resolveEvidenceProductState({
      lifecycleState: "ACTIVE",
      trashedAt: "2026-01-01T00:00:00Z",
    }),
    "TRASHED",
  );
  assert.equal(
    resolveEvidenceProductState({
      lifecycleState: "ACTIVE",
      archivedAt: "2026-01-01T00:00:00Z",
    }),
    "ARCHIVED",
  );
});

test("the destruction timestamp alone is terminal", () => {
  // Written only after verified deletion, so it is a positive record that the
  // bytes are gone — sufficient on its own.
  assert.equal(
    resolveEvidenceProductState({
      lifecycleState: "TRASHED",
      destroyedAt: "2026-01-01T00:00:00Z",
    }),
    "DESTROYED",
  );
});

// ===========================================================================
// trashBlockReason — retention never appears in it
// ===========================================================================

const CONV_NOW = new Date("2027-06-01T00:00:00Z");
const CONV_FAR = "2034-06-14T00:00:00Z";

test("a record retained until 2034 can be trashed in 2027", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    {
      lifecycleState: "ACTIVE",
      appRetentionUntil: CONV_FAR,
      objectLockRetainUntil: CONV_FAR,
      objectLockMode: "COMPLIANCE",
    },
    CONV_NOW,
  );
  assert.equal(caps.canTrash, true, "retention must not block a recoverable trash");
  assert.equal(caps.trashBlockReason, null);
  // …and still cannot be destroyed, which is where the boundary belongs.
  assert.equal(caps.canDestroy, false);
  assert.equal(caps.destructionBlockReason, "NOT_TRASHED");
});

test("a legal hold blocks trash; a lock blocks trash; a tombstone blocks trash", () => {
  const held = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ACTIVE", legalHold: true },
    CONV_NOW,
  );
  assert.equal(held.canTrash, false);
  assert.equal(held.trashBlockReason, "LEGAL_HOLD_ACTIVE");

  const locked = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ACTIVE", lockedAt: "2026-01-01T00:00:00Z" },
    CONV_NOW,
  );
  assert.equal(locked.canTrash, false);
  assert.equal(locked.trashBlockReason, "EVIDENCE_LOCKED");

  const destroyed = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "DESTROYED" },
    CONV_NOW,
  );
  assert.equal(destroyed.canTrash, false);
  assert.equal(destroyed.trashBlockReason, "TERMINAL_DESTROYED");
  assert.equal(destroyed.canArchive, false);
  assert.equal(destroyed.canRestoreFromTrash, false);
});

test("an archived record can still be trashed", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ARCHIVED", archivedAt: "2026-01-01T00:00:00Z" },
    CONV_NOW,
  );
  assert.equal(caps.canTrash, true);
  assert.equal(caps.canUnarchive, true);
  assert.equal(caps.canArchive, false);
});

// ===========================================================================
// The wire projection
// ===========================================================================

test("the projection carries verdicts and dates, and no raw lock mode to re-derive from", () => {
  const p = toEvidenceLifecycleProjection(
    {
      lifecycleState: "TRASHED",
      trashedAt: "2027-01-01T00:00:00Z",
      trashGraceUntil: "2027-04-01T00:00:00Z",
      appRetentionUntil: CONV_FAR,
      objectLockRetainUntil: CONV_FAR,
      objectLockMode: "COMPLIANCE",
    },
    CONV_NOW,
  );
  assert.equal(p.productState, "TRASHED");
  assert.equal(p.canRestoreFromTrash, true);
  assert.equal(p.objectLockCompliance, true);
  assert.equal(p.effectiveRetentionUntilUtc, new Date(CONV_FAR).toISOString());
  assert.equal(p.destructionBlockReason, "APP_RETENTION_ACTIVE");
  // Every date is an ISO string, so the shape is JSON-safe as-is.
  for (const key of [
    "trashGraceUntilUtc",
    "appRetentionUntilUtc",
    "objectLockRetainUntilUtc",
    "effectiveRetentionUntilUtc",
    "destructionEligibleAtUtc",
  ]) {
    const v = p[key];
    assert.ok(v === null || typeof v === "string", `${key} must be ISO or null`);
  }
  // There is no raw mode string on the wire — only the verdict — so a client
  // has nothing to compare a date against.
  assert.equal("objectLockMode" in p, false);
});

// ===========================================================================
// archiveBlockReason — a legal hold blocks archive (corrected 2026-08-24)
// ===========================================================================
//
// Before this, `canArchive` was `active && !locked`, which disagreed with the
// runtime: the governance layer already refused a held record, so the
// projection advertised an Archive button whose click returned 409. Worse, that
// governance layer allows unconditionally when `teamId` is null, so a held
// PERSONAL record was not merely offered the action — it was archived by it.
// The hold now decides here, in the one authority the single route, the bulk
// route and every read surface all consult.

test("ACTIVE with no hold: archive is available and has no block reason", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ACTIVE" },
    CONV_NOW,
  );
  assert.equal(caps.canArchive, true);
  assert.equal(caps.archiveBlockReason, null);
});

test("ACTIVE under a legal hold: archive is refused, and says why", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ACTIVE", legalHold: true },
    CONV_NOW,
  );
  assert.equal(caps.canArchive, false, "a legal hold must block archive");
  assert.equal(caps.archiveBlockReason, "LEGAL_HOLD_ACTIVE");
  // The two answers coincide under a hold, which is the whole point: one
  // preservation obligation, not two independently drifting verdicts.
  assert.equal(caps.canTrash, false);
  assert.equal(caps.trashBlockReason, "LEGAL_HOLD_ACTIVE");
});

test("retention is still NOT an archive block — only a hold is", () => {
  const caps = computeEvidenceLifecycleCapabilities(
    {
      lifecycleState: "ACTIVE",
      appRetentionUntil: CONV_FAR,
      objectLockRetainUntil: CONV_FAR,
      objectLockMode: "COMPLIANCE",
    },
    CONV_NOW,
  );
  assert.equal(caps.canArchive, true, "retention must not block archive");
  assert.equal(caps.archiveBlockReason, null);
});

test("archive block reasons follow the same precedence as trash", () => {
  const locked = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ACTIVE", lockedAt: "2026-01-01T00:00:00Z" },
    CONV_NOW,
  );
  assert.equal(locked.canArchive, false);
  assert.equal(locked.archiveBlockReason, "EVIDENCE_LOCKED");

  const destroyed = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "DESTROYED", legalHold: true },
    CONV_NOW,
  );
  assert.equal(destroyed.canArchive, false);
  assert.equal(
    destroyed.archiveBlockReason,
    "TERMINAL_DESTROYED",
    "a tombstone outranks a hold — the record is already gone",
  );

  const archived = computeEvidenceLifecycleCapabilities(
    { lifecycleState: "ARCHIVED", archivedAt: "2026-01-01T00:00:00Z" },
    CONV_NOW,
  );
  assert.equal(archived.canArchive, false);
  assert.equal(archived.archiveBlockReason, "ALREADY_IN_STATE");
  // …but an ARCHIVED record with no hold can still be trashed, so the two
  // reasons are genuinely independent outside the hold case.
  assert.equal(archived.canTrash, true);
  assert.equal(archived.trashBlockReason, null);
});

test("the wire projection carries archiveBlockReason", () => {
  const held = toEvidenceLifecycleProjection(
    { lifecycleState: "ACTIVE", legalHold: true },
    CONV_NOW,
  );
  assert.equal(held.canArchive, false);
  assert.equal(held.archiveBlockReason, "LEGAL_HOLD_ACTIVE");

  const free = toEvidenceLifecycleProjection({ lifecycleState: "ACTIVE" }, CONV_NOW);
  assert.equal(free.canArchive, true);
  assert.equal(free.archiveBlockReason, null);
});
