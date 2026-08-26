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
 * The API now needs the same window for a different question: when does a
 * record still sitting at `otsStatus = PENDING` become an operational
 * condition an operator should see? Those are two readings of one fact — "this
 * proof has been trying to anchor for too long" — and defining a second
 * threshold for the second reading would produce the state this codebase has
 * paid for before: a workspace whose Operations page says a record is fine
 * while the Worker has already given up on it, or the reverse.
 *
 * So the threshold and the predicate live here, imported by both. The Worker
 * re-exports them under their existing names, so nothing about its give-up
 * behaviour changes.
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
 * The three qualifying facts, all read from the Evidence row:
 *
 *   * `otsStatus` is one of the still-trying statuses — a settled or failed
 *     proof is a different condition and has its own source;
 *   * an anchoring start instant is known;
 *   * that instant is older than the canonical global budget.
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
  budgetMs?: number,
): boolean {
  const status = evidence.otsStatus;
  if (!status) return false;
  if (!OTS_PENDING_STATUSES.includes(status)) return false;
  return isOtsGlobalBudgetExhausted({
    // The SAME fallback chain the Worker uses to decide it has spent the
    // budget: the earliest pinned upgrade if one exists, the record's own
    // creation otherwise.
    firstAttemptAtUtc: evidence.otsAnchoredAtUtc ?? evidence.createdAt,
    nowUtc,
    budgetMs,
  });
}
