/**
 * Search index readiness — ONE eligibility rule, ONE state model.
 *
 * WHY THIS FILE EXISTS
 *
 * Two production workspaces were telling users things that were not true:
 *
 *   "The search index is still catching up — 175 of 393 records are
 *    searchable so far."          (a paid workspace, indefinitely)
 *   "Search is being set up. Try again in a moment."
 *                                 (a personal workspace, indefinitely)
 *
 * Both sentences promise progress. Neither workspace had any progress to make.
 * The index is written only by inline hooks at create/update time, and those
 * hooks are best-effort: a record that existed before its hook was added, or
 * whose hook failed, is never revisited. Nothing reconciles it. The readiness
 * signal was a COUNT COMPARISON — `indexed < eligible` — which cannot tell a
 * job that is running from a job that never started, so it reported "catching
 * up" forever.
 *
 * A count comparison is not a lifecycle. What follows is:
 *
 *   1. ONE eligibility predicate, so the numerator and the denominator can
 *      never be measured against different populations. It previously existed
 *      three times — in the diagnostics SQL, in the reindex SQL, and in the
 *      projection builder — and any drift between them would silently change
 *      what "N of M" meant.
 *
 *   2. A state model with the distinctions the UI has to make, derived from
 *      PERSISTED evidence of progress (`indexed_at_utc`) rather than from the
 *      absence of results. In particular it separates PARTIAL — work is
 *      genuinely advancing — from STALLED, which is what both production
 *      workspaces actually were.
 *
 * Nothing here reads a plan, a workspace name or a capability label.
 * Indexing is not a paid feature and never was.
 */

// ---------------------------------------------------------------------------
// 1. Eligibility — the one predicate
// ---------------------------------------------------------------------------

/**
 * Evidence lifecycle states whose rows must NOT appear in the search index.
 *
 * DESTROYED is gone; PENDING_DESTRUCTION is about to be. Every other state —
 * including soft-deleted (trash), archived and locked — IS indexable, and
 * surfaces with a badge saying so, because a user has to be able to find a
 * record in order to restore it.
 *
 * Hard-deleted rows are physically absent from the source table, so they can
 * neither be indexed nor counted. They are excluded by not existing.
 */
export const SEARCH_NON_INDEXABLE_LIFECYCLE_STATES = [
  "DESTROYED",
  "PENDING_DESTRUCTION",
] as const;

export type SearchNonIndexableLifecycleState =
  (typeof SEARCH_NON_INDEXABLE_LIFECYCLE_STATES)[number];

/**
 * Is this evidence row part of the population the index is supposed to hold?
 *
 * The SINGLE authority. The counting queries and the projection builder all
 * resolve through it, so "N of M" always compares one population with itself.
 */
export function isSearchIndexableLifecycle(
  lifecycleState: string | null | undefined,
): boolean {
  const state = (lifecycleState ?? "ACTIVE").toUpperCase();
  return !SEARCH_NON_INDEXABLE_LIFECYCLE_STATES.includes(
    state as SearchNonIndexableLifecycleState,
  );
}

/**
 * The same predicate as a SQL fragment, for the counting queries.
 *
 * Emitted from the constant above rather than typed out beside it: a list that
 * appears twice is a list that will eventually differ, and the difference
 * would show up as a permanently wrong "N of M" that nobody could explain.
 *
 * @param column the lifecycle column, already qualified by the caller
 */
export function searchIndexableLifecycleSql(column: string): string {
  const values = SEARCH_NON_INDEXABLE_LIFECYCLE_STATES.map((s) => `'${s}'`).join(
    ",",
  );
  return `COALESCE(${column}, 'ACTIVE') NOT IN (${values})`;
}

// ---------------------------------------------------------------------------
// 2. The state model
// ---------------------------------------------------------------------------

export type SearchReadinessState =
  /** No eligible searchable records exist. Not a fault. */
  | "EMPTY_WORKSPACE"
  /** Eligible records exist, none indexed yet, and a run IS progressing. */
  | "INITIALIZING"
  /** Some records indexed, the rest outstanding, and a run IS progressing. */
  | "PARTIAL"
  /** Every currently eligible record is represented. */
  | "READY"
  /** Records are missing and NOTHING is progressing. Needs intervention. */
  | "STALLED"
  /** The most recent run failed, with a safe projected reason. */
  | "FAILED"
  /** This actor may not use search here. */
  | "RESTRICTED"
  /** The search service could not be reached. */
  | "UNAVAILABLE"
  /** Search works; a secondary capability does not. */
  | "DEGRADED";

/** States in which the client should keep asking. Nothing else changes. */
export const SEARCH_READINESS_POLLING_STATES: ReadonlySet<SearchReadinessState> =
  new Set<SearchReadinessState>(["INITIALIZING", "PARTIAL"]);

export function searchReadinessShouldPoll(state: SearchReadinessState): boolean {
  return SEARCH_READINESS_POLLING_STATES.has(state);
}

/**
 * May this state truthfully claim that results are complete?
 *
 * The results count is allowed to render only when it is. In every other state
 * a count is either premature or misleading — "0 results" beside "search is
 * being set up" was both.
 */
export function searchReadinessResultsAreComplete(
  state: SearchReadinessState,
): boolean {
  return state === "READY" || state === "EMPTY_WORKSPACE" || state === "DEGRADED";
}

/** May a search be run and its rows shown at all? */
export function searchReadinessHasUsableResults(
  state: SearchReadinessState,
): boolean {
  return (
    state === "READY" ||
    state === "DEGRADED" ||
    state === "PARTIAL" ||
    state === "STALLED"
  );
}

// ---------------------------------------------------------------------------
// 3. Deriving the state
// ---------------------------------------------------------------------------

/**
 * How recently the index must have advanced for a run to count as ACTIVE.
 *
 * A backfill writes documents continuously, so a workspace with work left and
 * no write in this window is not "catching up" — it is stopped. Ten minutes is
 * far longer than any gap a healthy run produces and far shorter than the
 * indefinite silence both production workspaces were in.
 */
export const SEARCH_INDEX_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

export type SearchReadinessInput = {
  /** Eligible records, by the one predicate above. */
  eligibleCount: number;
  /** Eligible records currently represented in the index. */
  indexedCount: number;
  /** Most recent write to this workspace's index, if any. */
  lastIndexedAtUtc: Date | string | null;
  /** The most recent run's failure, already reduced to a safe reason. */
  lastRunFailedReason?: string | null;
  /** Is the actor allowed to search here at all? */
  authorized: boolean;
  /** Evaluation time, injected so the derivation is testable. */
  now: Date | number;
  /** Window override, for tests. */
  activityWindowMs?: number;
};

export type SearchReadiness = {
  state: SearchReadinessState;
  eligibleCount: number;
  indexedCount: number;
  /** Outstanding records. Never negative, even if the index over-counts. */
  outstandingCount: number;
  lastIndexedAtUtc: string | null;
  /** Whether a run wrote to this index inside the activity window. */
  progressing: boolean;
  failureReason: string | null;
  shouldPoll: boolean;
  resultsAreComplete: boolean;
};

function toMillis(value: Date | string | number | null): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Derive readiness from persisted facts only.
 *
 * Deliberately NOT inputs: the plan, the workspace name, whether the last
 * query returned rows, and whether any optional field was present on the
 * response. Every one of those has been used as a readiness proxy somewhere in
 * this product's history, and every one of them lies in some workspace.
 */
export function deriveSearchReadiness(
  input: SearchReadinessInput,
): SearchReadiness {
  const eligibleCount = Math.max(0, input.eligibleCount);
  const indexedCount = Math.max(0, input.indexedCount);
  const outstandingCount = Math.max(0, eligibleCount - indexedCount);
  const lastMs = toMillis(input.lastIndexedAtUtc);
  const nowMs = typeof input.now === "number" ? input.now : input.now.getTime();
  const windowMs = input.activityWindowMs ?? SEARCH_INDEX_ACTIVITY_WINDOW_MS;
  const progressing = lastMs != null && nowMs - lastMs <= windowMs;
  const lastIndexedAtUtc =
    lastMs == null ? null : new Date(lastMs).toISOString();
  const failureReason = input.lastRunFailedReason ?? null;

  const finish = (state: SearchReadinessState): SearchReadiness => ({
    state,
    eligibleCount,
    indexedCount,
    outstandingCount,
    lastIndexedAtUtc,
    progressing,
    failureReason: state === "FAILED" ? failureReason : null,
    shouldPoll: searchReadinessShouldPoll(state),
    resultsAreComplete: searchReadinessResultsAreComplete(state),
  });

  // Authorization first: a refusal is an answer about the ACTOR, and nothing
  // about the index changes it. Reporting an index state to someone who may
  // not search here would also describe a population they cannot see.
  if (!input.authorized) return finish("RESTRICTED");

  // Nothing to index is a complete state, not a pending one.
  if (eligibleCount === 0) return finish("EMPTY_WORKSPACE");

  // Everything eligible is present. `>=` rather than `===` so a stale document
  // for a since-removed record cannot read as an unfinished job.
  if (indexedCount >= eligibleCount) return finish("READY");

  // Work is outstanding. A recorded failure explains it; otherwise the
  // question is whether anything is actually running.
  if (failureReason) return finish("FAILED");
  if (!progressing) return finish("STALLED");
  return finish(indexedCount === 0 ? "INITIALIZING" : "PARTIAL");
}

/**
 * The operator-facing sentence for a state.
 *
 * Kept beside the derivation so a state cannot acquire a second description
 * somewhere else. Every one of these is checkable against the numbers it is
 * rendered with.
 */
export function describeSearchReadiness(readiness: SearchReadiness): string {
  const { state, indexedCount, eligibleCount } = readiness;
  switch (state) {
    case "EMPTY_WORKSPACE":
      return "No searchable records yet.";
    case "INITIALIZING":
      return "Preparing workspace search…";
    case "PARTIAL":
      return `Indexing in progress — ${indexedCount} of ${eligibleCount} records searchable. Recent records may not appear yet.`;
    case "READY":
      return "";
    case "STALLED":
      return `Indexing is not progressing — ${indexedCount} of ${eligibleCount} records are searchable. The rest will not appear until indexing is restarted.`;
    case "FAILED":
      return "The last indexing run did not finish.";
    case "RESTRICTED":
      return "Search is not available for this workspace.";
    case "UNAVAILABLE":
      return "Search is temporarily unavailable.";
    case "DEGRADED":
      return "Search is available; one secondary capability is not.";
    default:
      return "";
  }
}
