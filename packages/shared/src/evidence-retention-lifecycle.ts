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
 *   Only a permanent record LOCK (`lockedAt`) or a terminal state blocks trash.
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
export type EvidenceProductState = "ACTIVE" | "ARCHIVED" | "TRASHED" | "DESTROYED";

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
  | "DESTRUCTION_APPROVAL_REQUIRED";

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
  if (String(input.lifecycleState ?? "").toUpperCase() === "DESTROYED" || toDate(input.destroyedAt)) {
    return "DESTROYED";
  }
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
  return maxDate(toDate(input.appRetentionUntil), toDate(input.objectLockRetainUntil));
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
  const objectLockRetainUntil = toDate(input.objectLockRetainUntil);
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
  if (state !== "TRASHED") {
    return { ...base, eligible: false, blockReason: "NOT_TRASHED" };
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
  canDestroy: boolean;

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
  const destroyed = productState === "DESTROYED";

  return {
    productState,

    // Archive only organises the active working set; it never applies to a
    // trashed or destroyed record.
    canArchive: active && !locked,
    canUnarchive: archived && !locked,
    // Recoverable soft-trash: allowed from the working set regardless of
    // retention/hold; blocked only by a permanent lock or a terminal state.
    canTrash: (active || archived) && !locked && !destroyed,
    canRestoreFromTrash: trashed && !locked,
    canDestroy: elig.eligible,

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
