/**
 * THE ONE OTS ANCHORING-AGE AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MOVED
 * ---------------------------------------------------------------------------
 * `OTS_GLOBAL_BUDGET_DAYS` and `isOtsGlobalBudgetExhausted` lived in
 * `services/worker/src/ots-upgrade.processor.ts`, where they decide when the
 * Worker STOPS re-enqueueing an anchoring attempt.
 *
 * The API asks a DIFFERENT question of the same timestamp: when does a record
 * still sitting at `otsStatus = PENDING` become an operational condition an
 * operator should see? Both answers are arithmetic over one instant, so both
 * live here — but they are two policies, not one, and the second half of this
 * file explains at length why binding them together was a defect rather than a
 * simplification.
 *
 * The Worker re-exports the budget under its existing names, so nothing about
 * its give-up behaviour changes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It performs no I/O and contacts no provider. It is arithmetic over a
 * timestamp the caller has already read. Observing that a proof is aged does
 * NOT retry it, re-anchor it, replace it, or touch the Evidence row in any
 * way — the only writes any caller makes from this answer are to
 * `OperationalIncident` and its event/SLA/metric satellites.
 */

/**
 * How long an OTS proof may keep trying before the platform stops.
 *
 * Thirty days is the Worker's long-standing global budget: past it, the
 * processor marks the row FAILED with `OTS_GLOBAL_BUDGET_EXHAUSTED` and makes
 * no further attempts.
 */
export const OTS_GLOBAL_BUDGET_DAYS_DEFAULT = 30;

/** The configured budget in days, falling back to the default. */
export function readOtsGlobalBudgetDays(): number {
  const raw = process.env.OTS_GLOBAL_BUDGET_DAYS;
  if (!raw) return OTS_GLOBAL_BUDGET_DAYS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : OTS_GLOBAL_BUDGET_DAYS_DEFAULT;
}

/** The same budget in milliseconds. */
export function getOtsGlobalBudgetMs(): number {
  return readOtsGlobalBudgetDays() * 24 * 60 * 60 * 1000;
}

/**
 * Has this record been trying to anchor for longer than the budget?
 *
 * `firstAttemptAtUtc` is the earliest known anchoring instant — the Worker
 * passes `otsAnchoredAtUtc` when one exists and the record's `createdAt`
 * otherwise, because OTS submission happens at finalize. A null means nothing
 * is known about when it started, which is NOT the same as "a long time ago"
 * and therefore answers false.
 */
export function isOtsGlobalBudgetExhausted(params: {
  firstAttemptAtUtc: Date | null;
  nowUtc: Date;
  budgetMs?: number;
}): boolean {
  if (!params.firstAttemptAtUtc) return false;
  const budget = params.budgetMs ?? getOtsGlobalBudgetMs();
  return params.nowUtc.getTime() - params.firstAttemptAtUtc.getTime() > budget;
}

/** The OTS statuses that mean "still trying". */
export const OTS_PENDING_STATUSES: readonly string[] = Object.freeze([
  "PENDING",
  "SUBMITTED",
  "UPGRADING",
]);

/** The OTS statuses that mean the proof landed. */
export const OTS_SETTLED_STATUSES: readonly string[] = Object.freeze([
  "ANCHORED",
  "UPGRADED",
  "CONFIRMED",
  "COMPLETE",
]);

/**
 * IS THIS RECORD AN AGED-PENDING OTS CONDITION, RIGHT NOW?
 *
 * The single predicate behind `evidence_integrity.ots_pending_aged`. Five
 * callers share it — discovery, manual-resolution validation, recovery
 * detection, recurrence detection and the posture projection — so a record
 * that opens a condition and a record that closes one are decided by the same
 * arithmetic rather than by two comparisons that agreed the day they were
 * written.
 *
 * The two qualifying facts, both read from the Evidence row:
 *
 *   * `otsStatus` is one of the still-trying statuses — a settled or failed
 *     proof is a different condition and has its own source;
 *   * the anchoring start instant is older than the OPERATIONS AGING WINDOW.
 *
 * THAT WINDOW IS NOT THE RETRY BUDGET. It used to be: this predicate compared
 * against `OTS_GLOBAL_BUDGET_DAYS`, so a proof became visible to an operator
 * at the exact moment the Worker stopped trying — thirty days of silence and
 * then a condition that arrived too late to act on. The budget still governs
 * the Worker and is untouched; the boundary here is the operations policy
 * declared below.
 *
 * A record whose status is unreadable is not aged; it is unknown, and the
 * caller distinguishes those.
 */
export function isOtsPendingAged(
  evidence: {
    otsStatus: string | null;
    otsAnchoredAtUtc: Date | null;
    createdAt: Date;
  },
  nowUtc: Date,
  /** Override for tests. Defaults to the operations warning boundary. */
  agingMs?: number,
): boolean {
  const status = evidence.otsStatus;
  if (!status) return false;
  if (!OTS_PENDING_STATUSES.includes(status)) return false;
  // The SAME fallback chain the Worker uses to decide it has spent the budget:
  // the earliest pinned upgrade if one exists, the record's own creation
  // otherwise, because OTS submission happens at finalize.
  const startedAt = evidence.otsAnchoredAtUtc ?? evidence.createdAt;
  const window = agingMs ?? getOtsOperationsWarningMs();
  return nowUtc.getTime() - startedAt.getTime() >= window;
}

// ===========================================================================
// THE OPERATIONS AGING POLICY — A DIFFERENT QUESTION FROM THE RETRY BUDGET
// ===========================================================================

/**
 * WHY THIS IS NOT `OTS_GLOBAL_BUDGET_DAYS`.
 *
 * ---------------------------------------------------------------------------
 * THE CONFLATION
 * ---------------------------------------------------------------------------
 * When `evidence_integrity.ots_pending_aged` was given a real producer, it
 * reused the thirty-day retry budget as its alert threshold. The reasoning was
 * that there is "one window in the product" and two windows would drift.
 *
 * That was the right instinct applied to the wrong pair of questions. The
 * budget answers HOW LONG THE PLATFORM MAY KEEP TRYING; this answers WHEN AN
 * OPERATOR SHOULD BE TOLD. They are not two readings of one fact — they are
 * two facts, and binding them together produced a surface with no useful
 * middle: a proof that had been stuck for a week was invisible, and the moment
 * it became visible was the same moment the Worker gave up on it, at which
 * point the operator's information was already too late to be worth having.
 *
 * So there are now two windows, DELIBERATELY, and each is named for the
 * question it answers. The budget is untouched at thirty days: nothing here
 * changes when the Worker stops, retries, re-enqueues or gives up.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CONTROLS, AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 * When the READ-ONLY operational condition appears, and how severe it reads.
 * It performs no I/O, contacts no calendar server, and no caller writes an
 * Evidence, proof, hash or custody row from its answer.
 *
 * ---------------------------------------------------------------------------
 * WHY CRITICAL IS NOT REACHABLE
 * ---------------------------------------------------------------------------
 * A pending OpenTimestamps anchor does not make a record unprovable. The
 * record's RFC3161 trusted timestamp is unaffected and independent; what is
 * outstanding is a SECOND, public-chain proof. Ranking that CRITICAL would put
 * it beside records that cannot be timestamped at all and make the queue's
 * genuinely worst rows harder to find.
 *
 * CRITICAL for a pending anchor is reachable only from an explicit contractual
 * SLA authority that says so about a specific workspace — never from a plan
 * name, a workspace label, or the age alone. No such authority exists today,
 * so this function's ceiling is HIGH and the type says so.
 */

/** Below this, a pending anchor is normal and produces no condition. */
export const OTS_OPERATIONS_WARNING_HOURS_DEFAULT = 24;

/** At or above this, the same condition reads HIGH. */
export const OTS_OPERATIONS_HIGH_HOURS_DEFAULT = 72;

/** The two boundaries, in hours. Server-owned; both hosts read this one copy. */
export type OtsOperationsAgingPolicy = {
  readonly warningHours: number;
  readonly highHours: number;
};

function envHours(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The configured aging policy.
 *
 * An override that inverts the two boundaries is REJECTED rather than
 * normalised: a deployment whose HIGH window is shorter than its WARNING
 * window has said something contradictory, and silently reordering it would
 * ship a severity ladder nobody chose. The defaults are used instead.
 */
export function readOtsOperationsAgingPolicy(): OtsOperationsAgingPolicy {
  const warningHours = envHours(
    "OPS_OTS_PENDING_WARNING_HOURS",
    OTS_OPERATIONS_WARNING_HOURS_DEFAULT,
  );
  const highHours = envHours(
    "OPS_OTS_PENDING_HIGH_HOURS",
    OTS_OPERATIONS_HIGH_HOURS_DEFAULT,
  );
  if (!(warningHours < highHours)) {
    return {
      warningHours: OTS_OPERATIONS_WARNING_HOURS_DEFAULT,
      highHours: OTS_OPERATIONS_HIGH_HOURS_DEFAULT,
    };
  }
  return { warningHours, highHours };
}

/** The warning boundary in milliseconds — the window discovery compares to. */
export function getOtsOperationsWarningMs(): number {
  return readOtsOperationsAgingPolicy().warningHours * 60 * 60 * 1000;
}

/**
 * The earliest known anchoring instant for a record.
 *
 * The SAME fallback chain the Worker uses to decide it has spent the budget:
 * the pinned upgrade attempt if one exists, the record's own creation
 * otherwise, because OTS submission happens at finalize.
 */
function anchoringStartedAt(evidence: {
  otsAnchoredAtUtc: Date | null;
  createdAt: Date;
}): Date {
  return evidence.otsAnchoredAtUtc ?? evidence.createdAt;
}

/**
 * How long this record has been trying to anchor, in whole hours, or null.
 *
 * Null when the record is not in a still-trying status at all — a settled or
 * failed proof is a different condition with its own source, and returning a
 * number for it would invite a caller to compare an age that means nothing.
 */
export function otsPendingAgeHours(
  evidence: {
    otsStatus: string | null;
    otsAnchoredAtUtc: Date | null;
    createdAt: Date;
  },
  nowUtc: Date,
): number | null {
  const status = evidence.otsStatus;
  if (!status) return null;
  if (!OTS_PENDING_STATUSES.includes(status)) return null;
  const elapsed = nowUtc.getTime() - anchoringStartedAt(evidence).getTime();
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / (60 * 60 * 1000));
}

/**
 * WHAT SHOULD OPERATIONS SAY ABOUT THIS PENDING ANCHOR?
 *
 * The single severity ladder for `evidence_integrity.ots_pending_aged`, read
 * by discovery, by the recovery sweep and by the tests from this one place.
 *
 *   NONE      still inside the normal anchoring window; no condition at all
 *   WARNING   past the warning boundary and short of the high one
 *   HIGH      past the high boundary
 *
 * `NONE` is a real answer and the reason this returns a word rather than a
 * boolean: "no condition" and "a quiet condition" are different, and a caller
 * that received `false` for both would have had to re-derive which it was.
 */
export function otsPendingOperationalPosture(
  evidence: {
    otsStatus: string | null;
    otsAnchoredAtUtc: Date | null;
    createdAt: Date;
  },
  nowUtc: Date,
  policy: OtsOperationsAgingPolicy = readOtsOperationsAgingPolicy(),
): "NONE" | "WARNING" | "HIGH" {
  const hours = otsPendingAgeHours(evidence, nowUtc);
  if (hours == null) return "NONE";
  if (hours >= policy.highHours) return "HIGH";
  if (hours >= policy.warningHours) return "WARNING";
  return "NONE";
}
