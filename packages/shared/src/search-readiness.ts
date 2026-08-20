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
 *   2. A state model whose "is work in progress" answer comes from the DURABLE
 *      reconciliation run row — not from `MAX(indexed_at_utc)`, which cannot
 *      tell a queued run from a running one, a running run that has not
 *      written yet from a finished one, or a finished-with-nothing-to-do run
 *      from a crash. The timestamp survives as informational `lastIndexedAt`
 *      and decides nothing.
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
 * What the DURABLE run row says about this workspace's last reconciliation.
 *
 * This is the authority for "is work in progress". It replaces a timestamp
 * heuristic that could not tell a queued run from a running one, a running run
 * that had not written yet from a finished one, or a finished-with-nothing-to-do
 * run from a crash. The projection is deliberately narrow: no lock key, no row
 * id, no error text.
 */
export type SearchRunFacts = {
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL";
  /** True only while a RUNNING row is still inside its lease. */
  leaseValid: boolean;
  /** Bounded category. Present only on a failed run. */
  failureCategory?: string | null;
  /** Whether a real continuation of a bounded run is persisted. */
  continuationScheduled?: boolean;
};

export type SearchReadinessInput = {
  /** Eligible records, by the one predicate above. */
  eligibleCount: number;
  /** Eligible records currently represented in the index. */
  indexedCount: number;
  /**
   * Index documents whose source row is gone or has become ineligible.
   *
   * The OTHER direction of drift, and it does not show up in the counts above
   * at all: a destroyed record's leftover document keeps the workspace at
   * `indexed >= eligible` while Search is still answering for a record
   * governance decided no longer exists. Calling that READY would report the
   * index as correct precisely when it is not.
   *
   * Optional so a caller that cannot measure it says so by omission rather than
   * by asserting zero.
   */
  unresolvedRemovals?: number;
  /**
   * Most recent write to this workspace's index.
   *
   * INFORMATIONAL ONLY. It is projected to operators as `lastIndexedAt` and it
   * decides nothing: a recent write is not proof a backfill is running, and an
   * old one is not proof that one stalled. The run row decides.
   */
  lastIndexedAtUtc: Date | string | null;
  /**
   * The latest Search reconciliation run for this workspace, or `null` when
   * none has ever been recorded. `null` is not "idle" — with work outstanding
   * it is the strongest possible evidence that nothing is coming.
   */
  run: SearchRunFacts | null;
  /** Is the actor allowed to search here at all? */
  authorized: boolean;
  /**
   * Could the search service be reached at all?
   *
   * Defaults to `true`, and is the FIRST thing checked after authorization: an
   * unreachable service has no counts, and deriving STALLED from counts nobody
   * could read would blame the index for a transport failure.
   */
  serviceReachable?: boolean;
  /**
   * Secondary capabilities that are configured for this workspace and are not
   * currently answering — semantic search, NL query, embeddings.
   *
   * Deterministic search still works, so this is DEGRADED rather than
   * UNAVAILABLE, and it never suppresses a real index state: a workspace that
   * is genuinely STALLED reports STALLED even with every secondary capability
   * healthy, and a converged one with a broken secondary reports DEGRADED.
   */
  degradedCapabilities?: ReadonlyArray<string>;
  /** Evaluation time, injected so the derivation is testable. */
  now: Date | number;
};

export type SearchReadiness = {
  state: SearchReadinessState;
  eligibleCount: number;
  indexedCount: number;
  /** Outstanding records. Never negative, even if the index over-counts. */
  outstandingCount: number;
  /** Documents awaiting removal. Never negative. */
  unresolvedRemovals: number;
  /** Informational. Never an input to `state`. */
  lastIndexedAtUtc: string | null;
  /** A real run holds a valid lease right now. */
  progressing: boolean;
  /** The durable run's status, so an operator sees what readiness read. */
  runStatus: SearchRunFacts["status"] | null;
  failureReason: string | null;
  /** Named secondary capabilities that are not answering. Never a reason text. */
  degradedCapabilities: ReadonlyArray<string>;
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
  const unresolvedRemovals = Math.max(0, input.unresolvedRemovals ?? 0);
  const lastMs = toMillis(input.lastIndexedAtUtc);
  const lastIndexedAtUtc =
    lastMs == null ? null : new Date(lastMs).toISOString();
  const run = input.run;
  const degradedCapabilities = [...(input.degradedCapabilities ?? [])];

  // A run is PROGRESSING only when a durable row says RUNNING and its lease is
  // still valid. A crashed process leaves a RUNNING row behind; without the
  // lease check that row would read as work in progress forever.
  const progressing = run?.status === "RUNNING" && run.leaseValid === true;

  const finish = (state: SearchReadinessState): SearchReadiness => ({
    state,
    eligibleCount,
    indexedCount,
    outstandingCount,
    unresolvedRemovals,
    lastIndexedAtUtc,
    progressing,
    runStatus: run?.status ?? null,
    failureReason:
      state === "FAILED" ? (run?.failureCategory ?? "unexpected_error") : null,
    degradedCapabilities,
    shouldPoll: searchReadinessShouldPoll(state),
    resultsAreComplete: searchReadinessResultsAreComplete(state),
  });

  // Authorization first: a refusal is an answer about the ACTOR, and nothing
  // about the index changes it. Reporting an index state to someone who may
  // not search here would also describe a population they cannot see.
  if (!input.authorized) return finish("RESTRICTED");

  // Then reachability. An unreachable service produced no counts, so every
  // derivation below would be reasoning about zeros it never measured — and
  // "0 of 0 indexed" is EMPTY_WORKSPACE, which is a confident lie about a
  // transport failure.
  if (input.serviceReachable === false) return finish("UNAVAILABLE");

  // Nothing to index is a complete state, not a pending one. Independent of
  // run history: an empty workspace with a failed run is still empty.
  //
  // A leftover document with no source row is NOT nothing, though: the index
  // is answering for a record that no longer exists, which is drift to
  // reconcile rather than an empty workspace.
  if (eligibleCount === 0 && unresolvedRemovals === 0) {
    return finish("EMPTY_WORKSPACE");
  }

  // Everything eligible is present AND nothing is awaiting removal.
  //
  // `>=` rather than `===` on the first half so a stale document for a
  // since-removed record cannot read as an unfinished indexing job — that
  // record's document is counted by `unresolvedRemovals`, which is the half
  // that refuses READY.
  if (indexedCount >= eligibleCount && unresolvedRemovals === 0) {
    // …unless the CURRENT run failed. Converged counts with a failed run mean
    // the failure happened after convergence or did no damage — but a run that
    // failed and is not superseded is still the latest word on this index, and
    // calling that READY would hide it.
    if (run?.status === "FAILED") return finish("FAILED");
    // Deterministic search is complete. A secondary capability that is
    // configured and not answering is reported HERE and only here: it may
    // qualify a working index, never mask a broken one.
    if (degradedCapabilities.length > 0) return finish("DEGRADED");
    return finish("READY");
  }

  // ---- Work is outstanding. Only a real run can claim it is being done. ----

  // No run has ever been recorded. This is the strongest evidence available
  // that nothing is coming — it is what both production workspaces were.
  if (!run) return finish("STALLED");

  if (run.status === "FAILED") return finish("FAILED");

  if (run.status === "RUNNING") {
    // A RUNNING row past its lease is a crashed process. The run wrapper
    // force-fails it on the next claim; until then it must not read as work.
    if (!run.leaseValid) return finish("STALLED");
    return finish(indexedCount === 0 ? "INITIALIZING" : "PARTIAL");
  }

  // The run COMPLETED and drift remains.
  //
  // "Still processing" would be a lie: the process that was supposed to close
  // this gap finished. The only honest way this is temporary is if a real
  // continuation is persisted — a bounded run that scheduled its own next
  // batch. Otherwise the work is outstanding with nothing assigned to it.
  if (run.continuationScheduled === true) {
    return finish(indexedCount === 0 ? "INITIALIZING" : "PARTIAL");
  }
  return finish("STALLED");
}

// ---------------------------------------------------------------------------
// 4. The ONE diagnostics contract
// ---------------------------------------------------------------------------

/**
 * What the API projects and the console renders — the same declaration.
 *
 * This shape used to exist twice: once implicitly in the route's reply object
 * and once as a hand-written `type SearchReadinessProjection` in the web page.
 * Two declarations of one wire contract is how a field gets added on one side
 * and read as `undefined` on the other, which for a readiness projection means
 * the console silently falls back to whatever its own default happens to be —
 * i.e. it invents a state.
 *
 * Everything here is SAFE to hand a browser. What is deliberately absent:
 *   - the run's row id and lock key (internal, and a lock key names the
 *     mechanism an attacker would need to contend for),
 *   - the triggering user (another person's action),
 *   - error text of any kind — `failureReason` is one of a small closed set of
 *     categories, never a message, a stack or a SQL fragment.
 */
export type SearchReadinessProjection = {
  state: SearchReadinessState;
  eligibleCount: number;
  indexedCount: number;
  outstandingCount: number;
  /** Documents awaiting removal from the index. */
  unresolvedRemovals: number;
  /** INFORMATIONAL. Renders as "last indexed"; decides nothing. */
  lastIndexedAtUtc: string | null;
  /** A real run holds a valid lease right now. */
  progressing: boolean;
  /** The durable run's status, or `null` when none has ever been recorded. */
  runStatus: SearchRunFacts["status"] | null;
  runStartedAtUtc: string | null;
  runFinishedAtUtc: string | null;
  /** Bounded category, never a message. Present only in FAILED. */
  failureReason: string | null;
  /** Named secondary capabilities that are not answering. */
  degradedCapabilities: ReadonlyArray<string>;
  /** Whether the client should keep asking. */
  shouldPoll: boolean;
  /** Whether a result count may truthfully be presented as complete. */
  resultsAreComplete: boolean;
  /**
   * Whether THIS actor may start a rebuild.
   *
   * SERVER-PROJECTED, never inferred by the client from a plan, a workspace
   * label or a role string. The endpoint that would run the rebuild and the
   * control that offers it resolve through the same capability, so a control
   * the client shows is a control the wire will accept.
   */
  canRecover: boolean;
};

/**
 * Project readiness onto the wire contract.
 *
 * The single place the two are joined, so the route cannot assemble a
 * differently-shaped object by hand.
 */
export function projectSearchReadiness(
  readiness: SearchReadiness,
  extra: {
    runStartedAtUtc: string | null;
    runFinishedAtUtc: string | null;
    canRecover: boolean;
  },
): SearchReadinessProjection {
  return {
    state: readiness.state,
    eligibleCount: readiness.eligibleCount,
    indexedCount: readiness.indexedCount,
    outstandingCount: readiness.outstandingCount,
    unresolvedRemovals: readiness.unresolvedRemovals,
    lastIndexedAtUtc: readiness.lastIndexedAtUtc,
    progressing: readiness.progressing,
    runStatus: readiness.runStatus,
    runStartedAtUtc: extra.runStartedAtUtc,
    runFinishedAtUtc: extra.runFinishedAtUtc,
    failureReason: readiness.failureReason,
    degradedCapabilities: readiness.degradedCapabilities,
    shouldPoll: readiness.shouldPoll,
    resultsAreComplete: readiness.resultsAreComplete,
    canRecover: extra.canRecover,
  };
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
