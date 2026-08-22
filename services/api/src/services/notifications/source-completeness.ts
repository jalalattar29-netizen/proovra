/**
 * SOURCE COMPLETENESS (Attention Architecture, Phase 2.2 / 2.3).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 * ---------------------------------------------------------------------------
 * "It wasn't in the list, so it must be resolved."
 *
 * That inference is correct only when the list was EXHAUSTIVE. The inbox
 * aggregation is not: every source is capped (`take: PER_CATEGORY_TAKE`), and
 * every optional source is wrapped in a bounded try/catch that returns an
 * EMPTY ARRAY when the query throws. So a source can be absent from a response
 * for three completely different reasons:
 *
 *   1. it genuinely resolved                  -> absence means resolved
 *   2. it fell past the cap (item 51 of 50)   -> absence means nothing
 *   3. the query failed and returned []       -> absence means nothing
 *
 * `syncInboxSnapshots` used to treat all three the same and stamp
 * `resolvedAtUtc = now, resolutionSource = "SOURCE_STATE"` on every snapshot
 * absent from the current evaluation. A single failed `evidence.findMany` —
 * exactly the schema-drift failure the degraded-source wrapper was written for
 * — would therefore mark EVERY outstanding integrity failure in that category
 * as resolved, permanently, with system provenance attached. That is not a
 * display bug; it is fabricated evidence of remediation, and it is
 * unrecoverable because a false resolution is indistinguishable from a true
 * one after the fact.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * RESOLUTION REQUIRES POSITIVE EVIDENCE.
 *
 * Either the domain says so (Evidence.tsaStatus moved to ANCHORED, the invite
 * was accepted, the incident was resolved by an operator), or the evaluation
 * that failed to see it was EXHAUSTIVE and known to be so. Absence from a
 * capped, degraded, timed-out or partial read is not evidence of anything.
 *
 * The same descriptor drives Phase 2.3's honesty rule: a surface that cannot
 * prove it saw everything must not render "0 issues" or "all clear".
 */

/** Why an evaluation of one source could not be trusted to be exhaustive. */
export type IncompletenessReason =
  /** The source query threw; the aggregation substituted an empty array. */
  | "SOURCE_FAILED"
  /** The query hit its `take` limit, so rows beyond it were never read. */
  | "CAP_REACHED";

export type SourceEvaluation =
  | { status: "COMPLETE" }
  | { status: "INCOMPLETE"; reason: IncompletenessReason };

export type SourceCompleteness = {
  /** One verdict per known source. TOTAL over the sources handed in. */
  bySource: Readonly<Record<string, SourceEvaluation>>;
  /** True when at least one source could not be read exhaustively. */
  anyIncomplete: boolean;
  /** The incomplete ones, named, so the UI can say WHICH. */
  incompleteSources: readonly string[];
  /**
   * PHASE 2.3 — may a surface built on this evaluation claim everything is
   * fine? False whenever anything was incomplete. "0 issues" over a partial
   * read is the most damaging sentence an operations product can print.
   */
  mayAssertAllClear: boolean;
};

export type SourceCompletenessInput = {
  /** Every source the aggregation is expected to evaluate. */
  knownSources: readonly string[];
  /** Sources whose query threw and fell back to an empty result. */
  degradedSources: readonly string[];
  /** Per-source "this query hit its take limit" flags. */
  truncated: Readonly<Record<string, boolean>>;
};

/**
 * PURE. Build the completeness descriptor for one aggregation run.
 *
 * A source named in neither the degraded list nor the truncated map is
 * COMPLETE — those are the unbounded core reads (org memberships, invites)
 * whose absence really does mean resolved.
 */
export function buildSourceCompleteness(
  input: SourceCompletenessInput,
): SourceCompleteness {
  const degraded = new Set(input.degradedSources);
  const bySource: Record<string, SourceEvaluation> = {};
  const incompleteSources: string[] = [];

  for (const source of input.knownSources) {
    if (degraded.has(source)) {
      bySource[source] = { status: "INCOMPLETE", reason: "SOURCE_FAILED" };
      incompleteSources.push(source);
      continue;
    }
    if (input.truncated[source] === true) {
      bySource[source] = { status: "INCOMPLETE", reason: "CAP_REACHED" };
      incompleteSources.push(source);
      continue;
    }
    bySource[source] = { status: "COMPLETE" };
  }

  // A degraded source we did not expect is still a degraded source. Record it
  // rather than dropping it — an unknown name here means the aggregation grew
  // a source and forgot to declare it, and silently trusting that read is the
  // failure mode this module exists to prevent.
  for (const source of input.degradedSources) {
    if (bySource[source]) continue;
    bySource[source] = { status: "INCOMPLETE", reason: "SOURCE_FAILED" };
    incompleteSources.push(source);
  }

  return {
    bySource,
    anyIncomplete: incompleteSources.length > 0,
    incompleteSources,
    mayAssertAllClear: incompleteSources.length === 0,
  };
}

/**
 * THE GATE.
 *
 * May a caller conclude "this item is gone from the source, therefore it is
 * resolved"? Only when that source was read exhaustively on THIS evaluation.
 *
 * Fails closed on an unknown source name: a source nobody declared is a source
 * nobody can vouch for, and the cost of a missed auto-resolution (a stale row
 * in History) is trivially smaller than the cost of a fabricated one.
 */
export function mayInferResolutionFromAbsence(
  completeness: SourceCompleteness,
  sourceType: string,
): boolean {
  return completeness.bySource[sourceType]?.status === "COMPLETE";
}

/** The subset of sources this evaluation may draw conclusions about. */
export function exhaustivelyEvaluatedSources(
  completeness: SourceCompleteness,
): string[] {
  return Object.entries(completeness.bySource)
    .filter(([, evaluation]) => evaluation.status === "COMPLETE")
    .map(([source]) => source);
}
