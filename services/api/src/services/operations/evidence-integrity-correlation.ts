/**
 * EVIDENCE INTEGRITY CORRELATION (Attention Architecture, Phase 3.7).
 *
 * ---------------------------------------------------------------------------
 * THE RETRACTED FINDING
 * ---------------------------------------------------------------------------
 * An earlier audit reported "duplicate TSA failures" and proposed grouping
 * them. That finding is PERMANENTLY RETRACTED, and this module is where the
 * retraction is enforced rather than remembered.
 *
 * Ten records that each failed to be timestamped are TEN records that cannot
 * be proven, not one problem seen four times. They have different owners,
 * different cases, different legal postures, and each one has to be fixed
 * individually before that record is whole. Collapsing them on a shared
 * attribute makes nine of them invisible, and on an evidence platform an
 * invisible unprovable record is the single worst failure mode available.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY GROUP, AND WHAT MAY NOT
 * ---------------------------------------------------------------------------
 * Grouping requires POSITIVE evidence that two failures share a cause. Not
 * evidence that they LOOK alike — evidence that they ARE the same incident.
 *
 * ALLOWED correlators (each is a recorded fact about causation):
 *
 *   providerIncidentId   the provider told us its own incident id
 *   correlationId        something persisted an explicit correlation
 *   batchId / runId      the failures came from one execution
 *   retryExecutionId     they are attempts within one retry run
 *
 * FORBIDDEN, permanently and by name:
 *
 *   failureReason        many unrelated records time out
 *   normalized reason    same, with the coincidence laundered
 *   filename             two files can share a name
 *   provider             everything uses the same provider
 *   workspace            everything is in some workspace
 *   date / same day      time is not causation
 *
 * The forbidden list is not advice. `deriveParentCorrelation` cannot be made
 * to accept those inputs — they are not parameters — and
 * `FORBIDDEN_CORRELATION_SIGNALS` exists so a test can assert the ban rather
 * than a reviewer having to notice it being lifted.
 *
 * ---------------------------------------------------------------------------
 * EVEN WHEN CORRELATION EXISTS
 * ---------------------------------------------------------------------------
 *   Parent Incident
 *    ├ Evidence condition A
 *    ├ Evidence condition B
 *    └ Evidence condition C
 *
 * The children are FULL conditions with their own identity, lifecycle and
 * history. The parent is a convenience for the operator, not a container.
 * Resolving the parent resolves nothing: each child resolves when ITS record
 * recovers, which is the only thing that can make that record provable again.
 */

/**
 * Signals that MAY establish that two integrity failures share one cause.
 * Every one of these is a recorded fact about the execution or the provider,
 * not a resemblance between two rows.
 */
export type CorrelationEvidence = {
  /** An incident id the provider itself issued. */
  providerIncidentId?: string | null;
  /** An explicit correlation id persisted by whatever created the failures. */
  persistedCorrelationId?: string | null;
  /** The batch or run that produced both failures. */
  batchRunId?: string | null;
  /** One retry execution covering both attempts. */
  retryExecutionId?: string | null;
};

/**
 * Named so a test can assert they are absent from the correlation surface.
 * If any of these ever becomes a parameter of `deriveParentCorrelation`, the
 * retracted finding has been quietly reinstated.
 */
export const FORBIDDEN_CORRELATION_SIGNALS: readonly string[] = Object.freeze([
  "failureReason",
  "normalizedFailureReason",
  "fileName",
  "originalFileName",
  "provider",
  "workspaceId",
  "teamId",
  "occurredOnDate",
  "sameDay",
]);

export type ParentCorrelation = {
  /** Stable identity of the PARENT incident. Never an Evidence id. */
  parentFingerprint: string;
  /** Which correlator established it — recorded for the operator. */
  basis: "provider_incident" | "persisted_correlation" | "batch_run" | "retry_execution";
  /** The correlator's raw value, bounded. */
  correlatorId: string;
};

/** Bound the value so a hostile provider header cannot bloat a fingerprint. */
function bounded(value: string): string {
  return value.trim().slice(0, 80).replace(/[^A-Za-z0-9._:-]/g, "");
}

/**
 * PURE. Return the parent correlation for a failure, or null.
 *
 * NULL IS THE DEFAULT AND THE COMMON CASE. A failure with no correlator is an
 * independent condition, full stop — there is no fallback heuristic, no
 * "probably the same outage", no temporal window. If nothing recorded a
 * cause, we do not invent one.
 *
 * Order is by strength of evidence: a provider naming its own incident is
 * better proof than two failures sharing a run id, which is better than
 * nothing.
 */
export function deriveParentCorrelation(
  evidence: CorrelationEvidence | null | undefined,
): ParentCorrelation | null {
  if (!evidence) return null;

  const candidates: ReadonlyArray<{
    value: string | null | undefined;
    basis: ParentCorrelation["basis"];
    prefix: string;
  }> = [
    {
      value: evidence.providerIncidentId,
      basis: "provider_incident",
      prefix: "integrity_parent:provider_incident",
    },
    {
      value: evidence.persistedCorrelationId,
      basis: "persisted_correlation",
      prefix: "integrity_parent:correlation",
    },
    {
      value: evidence.batchRunId,
      basis: "batch_run",
      prefix: "integrity_parent:batch",
    },
    {
      value: evidence.retryExecutionId,
      basis: "retry_execution",
      prefix: "integrity_parent:retry",
    },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value !== "string") continue;
    const id = bounded(candidate.value);
    if (id.length === 0) continue;
    return {
      parentFingerprint: `${candidate.prefix}:${id}`,
      basis: candidate.basis,
      correlatorId: id,
    };
  }

  return null;
}

/**
 * THE CHILD-SURVIVAL RULE, executable.
 *
 * Given a parent's new status, return the child's status. The implementation
 * ignores the parent entirely, which is the point: there is no argument a
 * caller can pass that makes a parent resolution cascade into its children.
 * A child resolves when ITS Evidence recovers, and nothing else.
 */
/**
 * THE PARENT LIFECYCLE POLICY, stated once (closure pass, 2026-08-22).
 *
 * A parent is a convenience for the operator — "these four failed together
 * because that provider was down" — and it is never a container that owns its
 * children. The rules, in the order they matter:
 *
 *   1. ONE CHILD RESOLVES        the siblings are untouched. Each child
 *                                resolves when ITS record recovers, and one
 *                                record recovering says nothing about another.
 *
 *   2. THE PARENT RESOLVES       the children are untouched. Somebody closing
 *                                "the provider outage" has made a statement
 *                                about the provider, not about whether four
 *                                specific records can now be proven.
 *
 *   3. ALL CHILDREN RESOLVE      the parent MAY resolve. This is the only
 *                                direction that carries information, because
 *                                the parent exists to summarise the children
 *                                and an all-resolved summary is resolved.
 *
 * Rule 3 is deliberately permissive ("may") and evaluated by the caller: a
 * parent whose provider incident is still open upstream should stay open even
 * with every child recovered, and this module cannot know that.
 */
export function parentMayResolve(
  childStatuses: ReadonlyArray<string>,
): boolean {
  // An empty parent is not a resolved parent — it is a parent with nothing
  // under it, which should not have been created.
  if (childStatuses.length === 0) return false;
  return childStatuses.every(
    (status) => status === "RESOLVED" || status === "SUPPRESSED",
  );
}

/**
 * And the converse of rule 1, stated as code: a sibling's recovery is not this
 * child's recovery. Implemented as the identity function for the same reason
 * `childStatusAfterParentTransition` is — there is no argument a caller can
 * pass that makes one record's outcome decide another's.
 */
export function childStatusAfterSiblingTransition<T>(
  childStatus: T,
  // Deliberately unconsulted; named so the omission reads as intent.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _siblingStatus: string,
): T {
  return childStatus;
}

export function childStatusAfterParentTransition<T>(
  childStatus: T,
  // Deliberately unconsulted; named so the omission reads as intent.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _parentStatus: string,
): T {
  return childStatus;
}
