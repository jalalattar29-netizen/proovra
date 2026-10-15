/**
 * CANONICAL EVIDENCE RETENTION / ARCHIVE / TRASH / DESTRUCTION AUTHORITY.
 *
 * ONE domain module that answers every product- and governance-level question
 * about an Evidence record's lifecycle *posture* (as distinct from its capture
 * status CREATED→…→REPORTED, which is `evidence-lifecycle-contract.ts`):
 *
 *   - current product state (ACTIVE / ARCHIVED / TRASHED / DESTROYED)
 *   - can archive / unarchive / trash / restore-from-trash / destroy?
 *   - the trash recovery-grace deadline
 *   - the effective retention deadline (app + S3 Object Lock, whichever later)
 *   - legal-hold posture
 *   - the earliest lawful physical-destruction time
 *   - destruction eligibility, with the concrete block reason
 *
 * WHY THIS EXISTS (the audit finding it closes): these calculations were spread
 * across the frontend `evidence-delete-eligibility.ts`, the backend
 * `evidence-delete-eligibility.service.ts`, governance services, and the purge
 * worker — several partial, drifting copies. This is the single authority; every
 * surface (Evidence Library, Evidence Details, single + bulk routes, the
 * trash-grace reconciliation worker, the destruction executor, the dry-run tool)
 * must derive from it and never re-implement it.
 *
 * PURITY: no I/O, no clock reads. `now` is injected so the same function is used
 * by a request handler, a worker tick, a dry-run report, and a unit test and
 * always agrees. Callers pass the effective legal-hold verdict and the
 * approval verdict they resolved from their own stores (the union legal-hold
 * evaluator, the destruction-review record) — this module never guesses them.
 *
 * CORRECTED SEMANTICS (the convergence's central fix):
 *   ARCHIVE ≠ TRASH ≠ DESTRUCTION.
 *   Retention and S3 Object Lock block PHYSICAL DESTRUCTION — they do NOT block
 *   recoverable soft-trash. A record retained until 2034 can be trashed in 2027
 *   (TRASHED + RETAINED) and simply cannot be physically destroyed before 2034.
 *   A permanent record LOCK (`lockedAt`), a terminal state, or an active LEGAL
 *   HOLD blocks trash. The hold is in that list and retention is not, because
 *   the two obligations differ: a retention deadline says "these bytes must
 *   still exist on <date>", which a recoverable trash does not contradict,
 *   while a legal hold says "preserve this record and SUSPEND ROUTINE
 *   DISPOSITION on it" — and moving a record to trash is routine disposition,
 *   since it leaves the working set and starts the grace clock the reconciler
 *   reads to nominate it for destruction.
 *   S3 COMPLIANCE retention is a HARD lower bound on physical deletion and is
 *   never bypassed.
 */

// ---------------------------------------------------------------------------
// Product-level state
// ---------------------------------------------------------------------------

/**
 * The four states a regular user ever needs. Governance-internal postures
 * (UNDER_REVIEW, ON_HOLD, RETENTION_LOCKED, DESTRUCTION_PENDING) are modelled
 * on `EvidenceLifecycleState` in the schema and surfaced only to governance
 * users; they are NOT product states and are not returned here.
 */
export type EvidenceProductState =
  | "ACTIVE"
  | "ARCHIVED"
  | "TRASHED"
  /**
   * RETENTION ARCHIVE (owner decision 2026-10-14). The 90-day Trash has ended
   * but a retention barrier still prevents final purge. Listed in Archived
   * evidence, read-only, restorable only through the verified archive-restore
   * workflow. Never "permanently deleted": the preserved versions still exist.
   */
  | "RETENTION_ARCHIVED"
  | "DESTROYED";

/**
 * How trustworthy the caller's reading of STORAGE retention is. Object-version
 * retain-until metadata read from storage is the authority; a database column
 * is a cache. Anything other than VERIFIED fails closed: no purge.
 *
 *   VERIFIED      every required object version was listed and its retention
 *                 read (Object Lock off by configuration counts: no barrier)
 *   MISSING       a required version under Object Lock carries no retain-until
 *   INCONSISTENT  storage reports an earlier retain-until than PROOVRA recorded,
 *                 or a newer data version appeared that is not recorded
 *   UNAVAILABLE   the listing or a read failed / was partial
 */
export type StorageRetentionTruth = "VERIFIED" | "MISSING" | "INCONSISTENT" | "UNAVAILABLE";

/**
 * The reason a lifecycle capability is unavailable. Stable string literals —
 * both the UI and the route guards branch on these, so new reasons are appended,
 * never renamed.
 */
export type EvidenceLifecycleBlockReason =
  | "ALREADY_IN_STATE"
  | "EVIDENCE_LOCKED"
  | "TERMINAL_DESTROYED"
  | "NOT_TRASHED"
  | "TRASH_GRACE_ACTIVE"
  | "APP_RETENTION_ACTIVE"
  | "OBJECT_LOCK_RETENTION_ACTIVE"
  | "LEGAL_HOLD_ACTIVE"
  | "DESTRUCTION_APPROVAL_REQUIRED"
  // ET-SEC-06 — the canonical destruction executor holds a decided claim on the
  // record (PENDING_DESTRUCTION with a claim stamp). No other lifecycle change
  // may interleave: restore and destruction must never both succeed.
  | "DESTRUCTION_IN_PROGRESS"
  // RETENTION ARCHIVE — storage retention could not be read completely and
  // consistently, so nothing may be purged (fail closed).
  | "RETENTION_METADATA_UNVERIFIED"
  // RETENTION ARCHIVE — an archive restore is in progress for this record.
  | "ARCHIVE_RESTORE_IN_PROGRESS";

/**
 * The subset of persisted Evidence columns + resolved verdicts the authority
 * needs. Deliberately narrow so a list-row projection, a detail projection, a
 * worker row, or a test fixture can all satisfy it without a full Prisma row.
 *
 * Dates accept `Date | string | null` so the same input works server-side
 * (Date) and over the wire (ISO string).
 */
export interface EvidenceRetentionLifecycleInput {
  /** Terminal governance state pointer (`Evidence.lifecycleState`). */
  lifecycleState?: string | null;
  /** Legacy archive event timestamp (`Evidence.archivedAt`). */
  archivedAt?: Date | string | null;
  /** Legacy trash event timestamp (`Evidence.deletedAt` / `deletedAtUtc`). */
  trashedAt?: Date | string | null;
  /** Physical-destruction event timestamp (set only after verified deletion). */
  destroyedAt?: Date | string | null;
  /** Permanent record lock (`Evidence.lockedAt`) — blocks trash and destroy. */
  lockedAt?: Date | string | null;

  /** Trash recovery-grace deadline (`Evidence.deleteScheduledForUtc`). */
  trashGraceUntil?: Date | string | null;
  /** Application/workspace retention deadline (`Evidence.retentionUntilUtc`). */
  appRetentionUntil?: Date | string | null;
  /** S3 Object Lock retain-until (`Evidence.storageObjectLockRetainUntilUtc`). */
  objectLockRetainUntil?: Date | string | null;
  /** S3 Object Lock mode (`Evidence.storageObjectLockMode`) — GOVERNANCE|COMPLIANCE. */
  objectLockMode?: string | null;
  /**
   * RETENTION ARCHIVE — the latest retain-until across EVERY required stored
   * object version (originals, parts, every report, every package, every
   * derived artifact), as read from storage. When supplied it is the
   * authoritative object-retention bound; a later-created artifact with a
   * later retain-until therefore extends the boundary.
   */
  requiredObjectRetainUntil?: Date | string | null;
  /**
   * How complete and consistent that storage reading was. When supplied and
   * not VERIFIED, destruction fails closed (RETENTION_METADATA_UNVERIFIED).
   * Absent = the caller did not read storage (projection only, no purge
   * decision is taken from it).
   */
  storageRetentionTruth?: StorageRetentionTruth | null;
  /** RETENTION ARCHIVE — an archive restore request is open (REQUESTED/RUNNING). */
  archiveRestoreInProgress?: boolean | null;

  /**
   * The EFFECTIVE legal-hold verdict the caller resolved from the union of
   * evidence/case/workspace holds (fail-closed). The authority does not read
   * any store; it trusts this boolean. Absent ⇒ treated as no hold.
   */
  legalHold?: boolean | null;

  /**
   * Whether this record's workspace policy REQUIRES an approved destruction
   * review/request before physical destruction. Resolved by the caller from
   * workspace governance capability (never from a plan name).
   */
  destructionApprovalRequired?: boolean | null;
  /** Whether an approved destruction review/request currently exists. */
  destructionApproved?: boolean | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isFuture(value: Date | null, now: Date): boolean {
  return value !== null && value.getTime() > now.getTime();
}

/** The later of two instants (nulls ignored). Used to combine retention bounds. */
function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// Product-state resolution
// ---------------------------------------------------------------------------

/**
 * The record's product state, by strict precedence. DESTROYED is terminal and
 * wins over everything; then TRASHED (a trash event happened); then ARCHIVED;
 * else ACTIVE.
 *
 * Retention does NOT appear here — a retained record is ACTIVE (or ARCHIVED, or
 * TRASHED); retention is a *constraint on destruction*, not a product state.
 * That separation is the whole point of the convergence.
 */
export function resolveEvidenceProductState(
  input: EvidenceRetentionLifecycleInput,
): EvidenceProductState {
  // DESTROYED is terminal and is asserted two ways: the state pointer, and the
  // physical-destruction timestamp the canonical executor writes only after it
  // has verified the objects are gone. Either is sufficient; neither is
  // inferred from a trash timestamp.
  const state = String(input.lifecycleState ?? "").toUpperCase();
  if (state === "DESTROYED" || toDate(input.destroyedAt)) return "DESTROYED";

  // `lifecycle_state` IS the product-state authority once the convergence
  // migration has run. A pointer that names a product state is taken verbatim.
  if (state === "TRASHED") return "TRASHED";
  if (state === "RETENTION_ARCHIVED") return "RETENTION_ARCHIVED";
  if (state === "ARCHIVED") return "ARCHIVED";

  // ACTIVE is deliberately NOT taken verbatim, and the asymmetry is the
  // conservative direction. ACTIVE is the column DEFAULT, so it is also what a
  // row reads as when nobody has set it — which makes "pointer says ACTIVE" a
  // weaker claim than "pointer says TRASHED". If a stale projection, an
  // un-migrated row, or a future writer that forgets the pointer leaves ACTIVE
  // next to a trash timestamp, resolving ACTIVE would put a trashed record back
  // on the active shelf and re-expose it. Falling through cannot: the only way
  // to reach ACTIVE below is for every lifecycle event timestamp to be clear.

  // Fallback for the cases the pointer cannot answer:
  //
  //   1. a GOVERNANCE-INTERNAL posture (UNDER_REVIEW / ON_HOLD /
  //      RETENTION_LOCKED / PENDING_DESTRUCTION). Those are not product states
  //      and deliberately survive the backfill, so the product state of such a
  //      record still comes from its lifecycle EVENT timestamps;
  //   2. a caller that projected only the timestamps (a list row from an older
  //      client, a fixture, a wire payload that predates the migration).
  //
  // The timestamps are read here as compatibility evidence, never as a
  // competing authority: when the pointer names a product state, this code is
  // unreachable.
  if (toDate(input.trashedAt)) return "TRASHED";
  if (toDate(input.archivedAt)) return "ARCHIVED";
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// Effective retention
// ---------------------------------------------------------------------------

/**
 * The single effective retention deadline: the LATER of application retention
 * and S3 Object Lock retain-until. Per §7/§9/§35 destruction must honour the
 * MAXIMUM applicable boundary, and S3 physical retain-until is never shortened.
 */
export function computeEffectiveRetentionUntil(
  input: EvidenceRetentionLifecycleInput,
): Date | null {
  return maxDate(
    toDate(input.appRetentionUntil),
    maxDate(toDate(input.objectLockRetainUntil), toDate(input.requiredObjectRetainUntil)),
  );
}

// ---------------------------------------------------------------------------
// Destruction eligibility
// ---------------------------------------------------------------------------

export interface EvidenceDestructionEligibility {
  eligible: boolean;
  /**
   * The earliest instant physical destruction could be lawful based on the
   * time boundaries alone: max(trashGraceUntil, appRetentionUntil,
   * objectLockRetainUntil). `null` when no boundary is known. Non-time blocks
   * (hold, approval, not-trashed) are reported separately via `blockReason`.
   */
  destructionEligibleAt: Date | null;
  effectiveRetentionUntil: Date | null;
  objectLockRetainUntil: Date | null;
  trashGraceUntil: Date | null;
  legalHold: boolean;
  /** The first unmet condition, or null when eligible. */
  blockReason: EvidenceLifecycleBlockReason | null;
}

/**
 * Whether a record may be PHYSICALLY DESTROYED right now, and if not, why.
 *
 * Every one of these must hold (fail-closed precedence):
 *   1. product state is TRASHED (destruction only proceeds from trash)
 *   2. no active legal hold
 *   3. trash recovery grace has expired
 *   4. application retention has expired
 *   5. S3 Object Lock retain-until has expired (COMPLIANCE = hard boundary)
 *   6. required destruction approval, if any, is satisfied
 *
 * `destructionEligibleAt` is the max of the three time boundaries so a caller
 * can show "eligible after <date>" truthfully.
 */
export function computeEvidenceDestructionEligibility(
  input: EvidenceRetentionLifecycleInput,
  now: Date,
): EvidenceDestructionEligibility {
  const trashGraceUntil = toDate(input.trashGraceUntil);
  const appRetentionUntil = toDate(input.appRetentionUntil);
  // The recorded column and the storage reading are combined by MAX: a
  // storage reading never shortens what PROOVRA recorded (an earlier reading
  // than the record is INCONSISTENT and fails closed below).
  const objectLockRetainUntil = maxDate(
    toDate(input.objectLockRetainUntil),
    toDate(input.requiredObjectRetainUntil),
  );
  const effectiveRetentionUntil = computeEffectiveRetentionUntil(input);
  const legalHold = input.legalHold === true;

  // The time floor: the latest of every applicable boundary.
  const destructionEligibleAt = maxDate(maxDate(trashGraceUntil, appRetentionUntil), objectLockRetainUntil);

  const base = {
    destructionEligibleAt,
    effectiveRetentionUntil,
    objectLockRetainUntil,
    trashGraceUntil,
    legalHold,
  };

  const state = resolveEvidenceProductState(input);
  if (state === "DESTROYED") {
    return { ...base, eligible: false, blockReason: "TERMINAL_DESTROYED" };
  }
  // Destruction proceeds from TRASHED — the ordinary path, where a user put the
  // record in the trash and its grace window has elapsed — OR from
  // PENDING_DESTRUCTION, the governance state machine's own marker for
  // "approved for destruction".
  //
  // The second is not a loophole; excluding it was the bug. A retention-expired
  // record that a governance workspace reviews and approves for destruction has
  // never been in anybody's trash: the retention reconciler flags it, a reviewer
  // approves it, and the review executor destroys it. Requiring a detour through
  // the user-facing trash would make PENDING_DESTRUCTION mean nothing, and it
  // would put a record an operator has decided to destroy back on a shelf where
  // an ordinary user could restore it.
  //
  // Every other boundary below applies identically to both. Nothing is skipped
  // for the governance path — retention, Object Lock, holds, the permanent lock
  // and the approval requirement are all still checked, and the approval
  // requirement is the one that makes this route deliberate.
  const pendingDestruction =
    String(input.lifecycleState ?? "").toUpperCase() === "PENDING_DESTRUCTION";
  // RETENTION ARCHIVE — a record that left the Trash for the archive becomes
  // purge-eligible exactly when every barrier that put it there has ended.
  if (state !== "TRASHED" && state !== "RETENTION_ARCHIVED" && !pendingDestruction) {
    return { ...base, eligible: false, blockReason: "NOT_TRASHED" };
  }
  if (input.archiveRestoreInProgress === true) {
    return { ...base, eligible: false, blockReason: "ARCHIVE_RESTORE_IN_PROGRESS" };
  }
  // A permanent record lock is a hard, non-expiring block on destruction (it
  // also blocks trash upstream). Checked before the time boundaries because it
  // never lifts on its own.
  if (toDate(input.lockedAt) !== null) {
    return { ...base, eligible: false, blockReason: "EVIDENCE_LOCKED" };
  }
  // Legal hold is the hardest gate after terminal/state/lock — fail closed.
  if (legalHold) {
    return { ...base, eligible: false, blockReason: "LEGAL_HOLD_ACTIVE" };
  }
  if (isFuture(trashGraceUntil, now)) {
    return { ...base, eligible: false, blockReason: "TRASH_GRACE_ACTIVE" };
  }
  if (isFuture(appRetentionUntil, now)) {
    return { ...base, eligible: false, blockReason: "APP_RETENTION_ACTIVE" };
  }
  // S3 Object Lock is the hard PHYSICAL boundary and is never bypassed.
  if (isFuture(objectLockRetainUntil, now)) {
    return { ...base, eligible: false, blockReason: "OBJECT_LOCK_RETENTION_ACTIVE" };
  }
  // A partial, failed or inconsistent storage reading is never permission.
  if (input.storageRetentionTruth != null && input.storageRetentionTruth !== "VERIFIED") {
    return { ...base, eligible: false, blockReason: "RETENTION_METADATA_UNVERIFIED" };
  }
  if (input.destructionApprovalRequired === true && input.destructionApproved !== true) {
    return { ...base, eligible: false, blockReason: "DESTRUCTION_APPROVAL_REQUIRED" };
  }
  return { ...base, eligible: true, blockReason: null };
}

// ---------------------------------------------------------------------------
// Full capability projection — the one shape both UI and routes consume
// ---------------------------------------------------------------------------

export interface EvidenceLifecycleCapabilities {
  productState: EvidenceProductState;

  canArchive: boolean;
  canUnarchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  /** RETENTION ARCHIVE — the verified archive restore may be requested. */
  canRestoreFromArchive: boolean;
  canDestroy: boolean;

  /**
   * Why recoverable soft-trash is unavailable, or null when it is available.
   *
   * Distinct from `destructionBlockReason`, and the distinction is the point:
   * a record retained until 2034 has `destructionBlockReason` set and
   * `trashBlockReason` NULL. The UI must never render a retention deadline as
   * a reason it cannot trash something.
   */
  trashBlockReason: EvidenceLifecycleBlockReason | null;

  /**
   * Why archive is unavailable, or null when it is available.
   *
   * Reported separately from `trashBlockReason` because the two answers differ
   * in the ordinary case: an ARCHIVED record cannot be archived again but can
   * still be trashed. They coincide under a legal hold, which blocks both.
   */
  archiveBlockReason: EvidenceLifecycleBlockReason | null;

  trashGraceUntil: Date | null;
  appRetentionUntil: Date | null;
  objectLockRetainUntil: Date | null;
  effectiveRetentionUntil: Date | null;
  objectLockCompliance: boolean;
  legalHold: boolean;
  destructionEligibleAt: Date | null;

  /** Why destruction is not yet possible (null when it is). */
  destructionBlockReason: EvidenceLifecycleBlockReason | null;
}

/**
 * The single capability projection. Both Evidence Details and the Evidence
 * Library bulk-selection UI, and both the single and bulk route guards, derive
 * their action availability from THIS — never from ad-hoc per-surface logic
 * (§12/§13/§37). Single and bulk therefore agree by construction.
 *
 * Trash/archive availability encodes the corrected semantics:
 *   - archive: ACTIVE only, not locked, not terminal.
 *   - trash:   ACTIVE or ARCHIVED, not locked, not terminal. Retention, Object
 *              Lock, and legal hold do NOT block recoverable trash.
 *   - restore-from-trash: TRASHED only, not locked.
 *   - destroy: full destruction-eligibility (all boundaries + hold + approval).
 */
export function computeEvidenceLifecycleCapabilities(
  input: EvidenceRetentionLifecycleInput,
  now: Date,
): EvidenceLifecycleCapabilities {
  const productState = resolveEvidenceProductState(input);
  const locked = toDate(input.lockedAt) !== null;
  const elig = computeEvidenceDestructionEligibility(input, now);

  const active = productState === "ACTIVE";
  const archived = productState === "ARCHIVED";
  const trashed = productState === "TRASHED";
  const inArchive = productState === "RETENTION_ARCHIVED";
  const destroyed = productState === "DESTROYED";

  // The trash verdict, computed once and reported both as a boolean and as a
  // reason so no surface has to re-derive "why not".
  //
  // A LEGAL HOLD blocks trash; retention and Object Lock do NOT. That is not an
  // inconsistency — the two are different kinds of obligation. A retention
  // deadline says "these bytes must still exist on <date>", which a recoverable
  // soft-trash does not contradict: nothing is deleted and the record restores
  // intact. A legal hold says "preserve this record and suspend routine
  // disposition on it", and moving a record to trash IS routine disposition —
  // it hides the record from the working set and starts the grace clock that
  // the reconciler later reads. Blocking it is the conservative reading, and it
  // preserves the protection the pre-convergence code already had.
  const trashBlockReason: EvidenceLifecycleBlockReason | null = destroyed
    ? "TERMINAL_DESTROYED"
    : trashed || inArchive
      ? "ALREADY_IN_STATE"
      : locked
        ? "EVIDENCE_LOCKED"
        : elig.legalHold
          ? "LEGAL_HOLD_ACTIVE"
          : null;

  // ARCHIVE UNDER A LEGAL HOLD — corrected 2026-08-24.
  //
  // This used to be `active && !locked`, and it disagreed with the runtime.
  // `canArchiveEvidence` in the governance layer already refused a held record
  // with `blocked_by_legal_hold`, so the projection offered an Archive button
  // whose click returned 409 — and, worse, that governance layer short-circuits
  // for PERSONAL-scope records (`teamId === null`), so held personal evidence
  // was not merely offered the action but actually archived by it.
  //
  // The hold now decides here, in the one authority both single and bulk paths
  // consult, which closes the personal-scope gap by construction: the
  // capability gate runs before the governance gate and applies to every scope.
  //
  // WHY A HOLD BLOCKS ARCHIVE AT ALL, when it is not a deletion: archive
  // removes the record from the default working set, and a preservation
  // obligation is precisely the period during which a reviewer must be able to
  // find the record where they expect it. It is the same reasoning that makes a
  // hold block trash while a retention deadline does not.
  const archiveBlockReason: EvidenceLifecycleBlockReason | null = destroyed
    ? "TERMINAL_DESTROYED"
    : archived || trashed || inArchive
      ? "ALREADY_IN_STATE"
      : locked
        ? "EVIDENCE_LOCKED"
        : elig.legalHold
          ? "LEGAL_HOLD_ACTIVE"
          : null;

  return {
    productState,

    // Archive only organises the active working set; it never applies to a
    // trashed or destroyed record, and never to one under a legal hold.
    canArchive: active && archiveBlockReason === null,
    canUnarchive: archived && !locked,
    // Recoverable soft-trash: allowed from the working set regardless of
    // retention or Object Lock; blocked only by a permanent lock, a legal hold,
    // or a terminal state.
    canTrash: (active || archived) && trashBlockReason === null,
    canRestoreFromTrash: trashed && !locked,
    canRestoreFromArchive: inArchive && !locked && input.archiveRestoreInProgress !== true,
    canDestroy: elig.eligible,
    trashBlockReason,
    archiveBlockReason,

    trashGraceUntil: elig.trashGraceUntil,
    appRetentionUntil: toDate(input.appRetentionUntil),
    objectLockRetainUntil: elig.objectLockRetainUntil,
    effectiveRetentionUntil: elig.effectiveRetentionUntil,
    objectLockCompliance: String(input.objectLockMode ?? "").toUpperCase() === "COMPLIANCE",
    legalHold: elig.legalHold,
    destructionEligibleAt: elig.destructionEligibleAt,
    destructionBlockReason: elig.blockReason,
  };
}

/**
 * Dry-run / worker candidate evaluation for ONE record — the same authority the
 * scheduled trash-grace reconciliation and the manual dry-run report consume, so
 * the report can never disagree with what the worker would do. Non-mutating.
 */
export interface DestructionCandidateEvaluation extends EvidenceDestructionEligibility {
  productState: EvidenceProductState;
  /** True when the trash grace window has elapsed (the worker's scan trigger). */
  trashGraceExpired: boolean;
}

/**
 * RETENTION ARCHIVE — what happens to a TRASHED record when its 90-day Trash
 * ends (owner decision 2026-10-14). Pure; the reconciler supplies the storage
 * reading and the hold verdict.
 *
 *   STAY_IN_TRASH       the Trash period has not ended (or the record is not
 *                       TRASHED)
 *   RETENTION_ARCHIVE   at least one barrier remains: a legal hold, app or
 *                       contractual retention, an unexpired retain-until on any
 *                       required object version, a permanent lock — or a
 *                       storage reading that is not VERIFIED (fail closed: the
 *                       record stays recoverable, nothing is deleted)
 *   PURGE_ELIGIBLE      every barrier has ended; the canonical purge path may
 *                       take it (it re-checks everything under its lease)
 */
export type TrashExitDecision = "STAY_IN_TRASH" | "RETENTION_ARCHIVE" | "PURGE_ELIGIBLE";

export interface TrashExitEvaluation {
  decision: TrashExitDecision;
  /** max(trash end, required retain-until, app retention) — the earliest possible purge. */
  purgeEligibleAt: Date | null;
  /** The barrier that keeps the record, for RETENTION_ARCHIVE. */
  barrier:
    | "LEGAL_HOLD"
    | "APP_RETENTION"
    | "OBJECT_RETENTION"
    | "EVIDENCE_LOCKED"
    | "METADATA_MISSING"
    | "METADATA_INCONSISTENT"
    | "STORAGE_UNAVAILABLE"
    | null;
}

export function evaluateTrashExit(
  input: EvidenceRetentionLifecycleInput,
  now: Date,
): TrashExitEvaluation {
  const state = resolveEvidenceProductState(input);
  const trashGraceUntil = toDate(input.trashGraceUntil);
  const elig = computeEvidenceDestructionEligibility(input, now);
  const purgeEligibleAt = elig.destructionEligibleAt;
  if (state !== "TRASHED" || trashGraceUntil === null || isFuture(trashGraceUntil, now)) {
    return { decision: "STAY_IN_TRASH", purgeEligibleAt, barrier: null };
  }
  const truth = input.storageRetentionTruth ?? "UNAVAILABLE";
  const barrier: TrashExitEvaluation["barrier"] =
    toDate(input.lockedAt) !== null
      ? "EVIDENCE_LOCKED"
      : input.legalHold === true
        ? "LEGAL_HOLD"
        : truth === "UNAVAILABLE"
          ? "STORAGE_UNAVAILABLE"
          : truth === "MISSING"
            ? "METADATA_MISSING"
            : truth === "INCONSISTENT"
              ? "METADATA_INCONSISTENT"
              : isFuture(toDate(input.appRetentionUntil), now)
                ? "APP_RETENTION"
                : isFuture(elig.objectLockRetainUntil, now)
                  ? "OBJECT_RETENTION"
                  : null;
  return barrier === null
    ? { decision: "PURGE_ELIGIBLE", purgeEligibleAt, barrier: null }
    : { decision: "RETENTION_ARCHIVE", purgeEligibleAt, barrier };
}

export function evaluateDestructionCandidate(
  input: EvidenceRetentionLifecycleInput,
  now: Date,
): DestructionCandidateEvaluation {
  const elig = computeEvidenceDestructionEligibility(input, now);
  const trashGraceUntil = toDate(input.trashGraceUntil);
  return {
    ...elig,
    productState: resolveEvidenceProductState(input),
    trashGraceExpired: trashGraceUntil === null ? false : trashGraceUntil.getTime() <= now.getTime(),
  };
}

// ---------------------------------------------------------------------------
// The WIRE projection — one shape, both sides
// ---------------------------------------------------------------------------

/**
 * The lifecycle facts a client is allowed to render, as JSON.
 *
 * This exists so the browser can stop computing lifecycle decisions. Before the
 * convergence `apps/web/.../evidence-delete-eligibility.ts` carried a full
 * client-side mirror of the retention, Object Lock and legal-hold predicates
 * with a comment instructing future readers to keep its precedence in step with
 * the backend's by hand. It did not stay in step, and it could not: the browser
 * cannot see the legal-hold tables at all, so its answer was a guess dressed as
 * a decision.
 *
 * Every field here is a RESULT. There is deliberately nothing on this shape a
 * client could use to re-derive a verdict of its own — no raw lock mode next to
 * a raw retain-until inviting a comparison — only the verdicts themselves and
 * the dates a human needs to read.
 */
export interface EvidenceLifecycleProjection {
  productState: EvidenceProductState;

  canArchive: boolean;
  canUnarchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  canRestoreFromArchive: boolean;

  /** Why trash is unavailable, or null. NEVER a retention deadline. */
  trashBlockReason: EvidenceLifecycleBlockReason | null;
  /** Why archive is unavailable, or null. NEVER a retention deadline. */
  archiveBlockReason: EvidenceLifecycleBlockReason | null;

  /** ISO. When the recoverable window closes. */
  trashGraceUntilUtc: string | null;
  /** ISO. Application/workspace retention deadline. */
  appRetentionUntilUtc: string | null;
  /** ISO. S3 Object Lock retain-until. */
  objectLockRetainUntilUtc: string | null;
  /** ISO. The later of the two above. */
  effectiveRetentionUntilUtc: string | null;
  objectLockCompliance: boolean;
  legalHold: boolean;

  /** ISO. The earliest instant physical destruction could be lawful. */
  destructionEligibleAtUtc: string | null;
  destructionBlockReason: EvidenceLifecycleBlockReason | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Serialise the capability projection for the wire. The ONE place a lifecycle
 * response body is shaped, so a list row and a detail response cannot describe
 * the same record differently.
 */
export function toEvidenceLifecycleProjection(
  input: EvidenceRetentionLifecycleInput,
  now: Date,
): EvidenceLifecycleProjection {
  const caps = computeEvidenceLifecycleCapabilities(input, now);
  return {
    productState: caps.productState,
    canArchive: caps.canArchive,
    canUnarchive: caps.canUnarchive,
    canTrash: caps.canTrash,
    canRestoreFromTrash: caps.canRestoreFromTrash,
    canRestoreFromArchive: caps.canRestoreFromArchive,
    trashBlockReason: caps.trashBlockReason,
    archiveBlockReason: caps.archiveBlockReason,
    trashGraceUntilUtc: iso(caps.trashGraceUntil),
    appRetentionUntilUtc: iso(caps.appRetentionUntil),
    objectLockRetainUntilUtc: iso(caps.objectLockRetainUntil),
    effectiveRetentionUntilUtc: iso(caps.effectiveRetentionUntil),
    objectLockCompliance: caps.objectLockCompliance,
    legalHold: caps.legalHold,
    destructionEligibleAtUtc: iso(caps.destructionEligibleAt),
    destructionBlockReason: caps.destructionBlockReason,
  };
}

/** The canonical response field name. Pinned by tests on both sides. */
export const EVIDENCE_LIFECYCLE_RESPONSE_FIELD = "lifecycle" as const;

// ---------------------------------------------------------------------------
// The retention contract: S3 Object Lock COMPLIANCE, 2920 days
// (owner decision 2026-10-15; Production: S3_OBJECT_LOCK_MODE=COMPLIANCE,
// S3_OBJECT_LOCK_RETAIN_DAYS=2920)
// ---------------------------------------------------------------------------

/**
 * EVIDENCE IS PRESERVED FOR 2920 DAYS ("eight years" in product language).
 *
 * The configured `S3_OBJECT_LOCK_RETAIN_DAYS` (2920 in Production) and the
 * bucket's own 2920-day default are the existing authority; this constant is
 * the floor configuration may raise but never lower: a deployment that sets a
 * shorter value still writes 2920 days, and says so
 * (`resolvePlatformRetentionDays`). It is a DAY COUNT, applied in UTC
 * milliseconds — never re-expressed as calendar years or anniversaries.
 *
 * Enterprise / workspace contracts extend a record beyond this through the
 * record's application retention (`Evidence.retentionUntilUtc`); nothing here
 * shortens an applied lock. S3 itself refuses a shorter retain-until on a
 * locked version (COMPLIANCE always), and no routine path sends a bypass.
 */
export const EVIDENCE_OBJECT_RETENTION_DAYS = 2920;

export type ObjectLockModeName = "GOVERNANCE" | "COMPLIANCE";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention a deployment writes: `max(2920 days, configured days)`.
 * `configuredBelowContract` is true when configuration asked for less — the
 * readiness posture reports it; the write never follows it.
 */
export function resolvePlatformRetentionDays(configuredDays: number | null | undefined): {
  days: number;
  configuredBelowContract: boolean;
} {
  const configured =
    typeof configuredDays === "number" && Number.isInteger(configuredDays) && configuredDays > 0
      ? configuredDays
      : null;
  return {
    days: Math.max(EVIDENCE_OBJECT_RETENTION_DAYS, configured ?? 0),
    configuredBelowContract: configured !== null && configured < EVIDENCE_OBJECT_RETENTION_DAYS,
  };
}

/**
 * The lock mode is a DEPLOYMENT fact (`S3_OBJECT_LOCK_MODE`, COMPLIANCE in
 * Production). There is NO default: a missing or unrecognised value is an
 * incomplete configuration (`null`), reported as such — never silently
 * replaced by a mode nobody chose.
 */
export function resolveObjectLockModeName(configured: string | null | undefined): ObjectLockModeName | null {
  const v = String(configured ?? "").trim().toUpperCase();
  return v === "COMPLIANCE" || v === "GOVERNANCE" ? v : null;
}

/**
 * The STRONGER of two modes. A record whose stored objects are COMPLIANCE
 * keeps COMPLIANCE for everything written for it later; COMPLIANCE is never
 * downgraded.
 */
export function strongestObjectLockMode(
  ...modes: Array<string | null | undefined>
): ObjectLockModeName | null {
  const named = modes.map(resolveObjectLockModeName).filter((m): m is ObjectLockModeName => m !== null);
  if (named.includes("COMPLIANCE")) return "COMPLIANCE";
  return named.includes("GOVERNANCE") ? "GOVERNANCE" : null;
}

export interface EvidenceRetentionHorizonInput {
  /** The latest retain-until S3 reported for the sealed original and its parts. */
  sealedOriginalRetainUntil: Date | string | null | undefined;
  /**
   * The latest retain-until read from storage across EVERY required object
   * version (`Evidence.latestRequiredRetainUntilUtc`, written by the
   * version-aware sweep). A later stored value wins over any projection.
   */
  storageRetainUntil?: Date | string | null | undefined;
  /** When the record was sealed (signedAtUtc, else its creation). */
  sealedAt: Date | string | null | undefined;
  /** Application / contractual retention (`Evidence.retentionUntilUtc`). */
  appRetentionUntil: Date | string | null | undefined;
  platformRetentionDays: number;
}

/**
 * THE evidence-level retention horizon: the instant until which every
 * required object of the record must stay locked.
 *
 *   max(the original's applied lock, the latest stored version lock,
 *       the contractual retention, sealedAt + the platform period)
 *
 * It is FIXED per record — it moves only when one of those facts moves (an
 * authorized contractual extension, a lock storage reports). Later artifacts
 * (reports, packages, previews, derived files) are locked TO it, never to
 * "now + 2920 days" — so regenerating a report cannot ratchet a record's
 * preservation forward, and no artifact can make the record purgeable
 * earlier.
 */
export function computeEvidenceRetentionHorizon(input: EvidenceRetentionHorizonInput): Date | null {
  const sealedAt = toDate(input.sealedAt);
  return maxDate(
    maxDate(
      maxDate(toDate(input.sealedOriginalRetainUntil), toDate(input.storageRetainUntil)),
      toDate(input.appRetentionUntil),
    ),
    sealedAt ? new Date(sealedAt.getTime() + input.platformRetentionDays * DAY_MS) : null,
  );
}

/**
 * The least time a write may still be locked for: a retain-until closer than
 * this cannot be honoured by a store whose clock may drift.
 */
export const MINIMUM_FUTURE_LOCK_MS = 60 * 60 * 1000;

/**
 * A record whose retention horizon has ended cannot receive a new immutable
 * object: inventing a fresh horizon inside a storage writer would be an
 * unaudited extension. The write fails closed; extending a record's retention
 * is an authorized, audited policy operation (`Evidence.retentionUntilUtc`).
 */
export class RetentionHorizonEndedError extends Error {
  readonly code = "RETENTION_HORIZON_ENDED" as const;
  readonly retriable = false;
  constructor(readonly horizon: Date) {
    super(`RETENTION_HORIZON_ENDED: the record's retention horizon ended at ${horizon.toISOString()}`);
    this.name = "RetentionHorizonEndedError";
  }
}

/**
 * The retain-until for ONE object write.
 *
 *   SEAL      the original/parts at finalization: max(now + platform period,
 *             contractual retention) — or the record's existing horizon when
 *             it was already sealed (a repeat finalization never extends).
 *   ARTIFACT  anything written later for an existing record: its horizon.
 *             Past the horizon the write is refused
 *             (`RetentionHorizonEndedError`) — never silently extended.
 */
export function resolveObjectRetainUntil(input: {
  kind: "SEAL" | "ARTIFACT";
  now: Date;
  platformRetentionDays: number;
  horizon: Date | null;
  appRetentionUntil: Date | string | null | undefined;
  alreadySealed: boolean;
}): Date {
  if (input.kind === "SEAL" && !input.alreadySealed) {
    return maxDate(
      new Date(input.now.getTime() + input.platformRetentionDays * DAY_MS),
      toDate(input.appRetentionUntil),
    )!;
  }
  const horizon =
    input.horizon ?? new Date(input.now.getTime() + input.platformRetentionDays * DAY_MS);
  if (horizon.getTime() - input.now.getTime() < MINIMUM_FUTURE_LOCK_MS) {
    throw new RetentionHorizonEndedError(horizon);
  }
  return horizon;
}

// ---------------------------------------------------------------------------
// AUD-010 — PRODUCTION OBJECT LOCK POSTURE (fail closed).
//
// The contract above is only as good as the deployment that writes under it.
// `S3_OBJECT_LOCK_ENABLED` used to default to false and `S3_OBJECT_LOCK_MODE`
// accepted GOVERNANCE, so a production deployment could boot writing evidence
// with no lock, or with a lock an administrator can remove. In production the
// deployment must state exactly the contract: enabled, COMPLIANCE, and a
// period that is absent (the 2920-day default) or at least 2920 days.
// ---------------------------------------------------------------------------

export type ObjectLockPostureViolation =
  | "object_lock_disabled"
  | "object_lock_mode_not_compliance"
  | "object_lock_retain_days_below_contract";

/**
 * Pure: the ways this environment's Object Lock configuration falls short of
 * the evidence retention contract. Empty when it states the contract exactly.
 * Callers decide WHEN it applies (production); the rule is the same for the
 * API and the worker.
 */
export function objectLockPostureViolations(
  env: Readonly<Record<string, string | undefined>>,
): ObjectLockPostureViolation[] {
  const out: ObjectLockPostureViolation[] = [];
  if (String(env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() !== "true") {
    out.push("object_lock_disabled");
  }
  if (resolveObjectLockModeName(env.S3_OBJECT_LOCK_MODE) !== "COMPLIANCE") {
    out.push("object_lock_mode_not_compliance");
  }
  const rawDays = String(env.S3_OBJECT_LOCK_RETAIN_DAYS ?? "").trim();
  if (rawDays.length > 0) {
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < EVIDENCE_OBJECT_RETENTION_DAYS) {
      out.push("object_lock_retain_days_below_contract");
    }
  }
  return out;
}

/** What a startup probe of the evidence bucket's Object Lock found. */
export type ObjectLockBucketProbe =
  | { mode: "disabled" }
  | { mode: "skipped"; reason: string }
  | { mode: "claimed-but-unsupported"; bucket: string; reason: string }
  | {
      mode: "verified";
      configured: {
        bucket: string;
        defaultMode: string | null;
        defaultRetainDays: number | null;
      };
    };

export type ObjectLockBootstrapDecision =
  | { action: "start"; level: "info" | "warn"; event: string }
  | { action: "refuse"; event: string; reason: string };

/**
 * THE startup decision for the API and the worker (AUD-010). In production
 * every shortfall refuses to start — there is no bypass:
 *
 *   - the environment does not state the contract (see above);
 *   - the probe was skipped (the bucket could not be asked) or found the
 *     bucket cannot hold locks;
 *   - the bucket carries a DEFAULT retention that is not COMPLIANCE for at
 *     least 2920 days (an object written without an explicit lock would
 *     inherit it). No default retention is acceptable: every writer sends an
 *     explicit COMPLIANCE lock.
 *
 * Outside production the same findings are reported as warnings so local
 * development and CI fixtures still boot.
 */
export function decideObjectLockBootstrap(
  probe: ObjectLockBucketProbe,
  options: { production: boolean; env: Readonly<Record<string, string | undefined>> },
): ObjectLockBootstrapDecision {
  if (!options.production) {
    if (probe.mode === "disabled") return { action: "start", level: "info", event: "object_lock.disabled" };
    if (probe.mode === "verified") return { action: "start", level: "info", event: "object_lock.verified" };
    if (probe.mode === "skipped") {
      return { action: "start", level: "warn", event: "object_lock.verification_skipped" };
    }
    return { action: "start", level: "warn", event: "object_lock.claimed_but_unsupported" };
  }
  const config = objectLockPostureViolations(options.env);
  if (config.length > 0) {
    return { action: "refuse", event: "object_lock.bootstrap_failed", reason: config.join(",") };
  }
  switch (probe.mode) {
    case "disabled":
      return { action: "refuse", event: "object_lock.bootstrap_failed", reason: "object_lock_disabled" };
    case "skipped":
      return {
        action: "refuse",
        event: "object_lock.bootstrap_failed",
        reason: `object_lock_unverified: ${probe.reason}`,
      };
    case "claimed-but-unsupported":
      return {
        action: "refuse",
        event: "object_lock.bootstrap_failed",
        reason: `object_lock_unsupported_by_bucket: ${probe.reason}`,
      };
    case "verified": {
      const { defaultMode, defaultRetainDays } = probe.configured;
      if (defaultMode !== null && resolveObjectLockModeName(defaultMode) !== "COMPLIANCE") {
        return {
          action: "refuse",
          event: "object_lock.bootstrap_failed",
          reason: "bucket_default_retention_not_compliance",
        };
      }
      if (defaultRetainDays !== null && defaultRetainDays < EVIDENCE_OBJECT_RETENTION_DAYS) {
        return {
          action: "refuse",
          event: "object_lock.bootstrap_failed",
          reason: "bucket_default_retention_below_contract",
        };
      }
      return { action: "start", level: "info", event: "object_lock.verified" };
    }
  }
}
