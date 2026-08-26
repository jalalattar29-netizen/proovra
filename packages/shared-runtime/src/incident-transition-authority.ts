/**
 * THE ONE INCIDENT TRANSITION AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * An operational condition has two kinds of writer, and they used to disagree.
 *
 * OPERATORS transition it deliberately — acknowledge, resolve, suppress. The
 * RECONCILER observes its source on a schedule and writes what it saw. Both
 * wrote `status`, and the reconciler's write was unconditional: a re-observed
 * condition that was RESOLVED or SUPPRESSED went back to OPEN, as a plain
 * `increment`, with `resolvedAtUtc`, the resolver's identity and the operator's
 * resolution note discarded. Nothing in the history said a reopen had
 * happened, so a genuine recurrence and a silently-erased decision were the
 * same row carrying the same event.
 *
 * The same decision tree existed twice — once in the API `recordIncident` and
 * once in the Worker `recordWorkerIncident` — which is how the two drift, and
 * how a rule fixed in one keeps failing in the other.
 *
 * This module is that decision, once, as a pure function of stated facts. It
 * reads no database, holds no clock and performs no I/O. The services keep
 * their own reads and writes; what they share is the RULE.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 * An observation reports what the source SAYS. It never overrules what a
 * person DECIDED, and it never changes status without saying so:
 *
 *   OPEN         + active     -> occurrence only
 *   ACKNOWLEDGED + active     -> occurrence only; the owner keeps the condition
 *   SUPPRESSED   + active     -> occurrence only, recorded as such
 *   RESOLVED     + active     -> an explicit REOPEN with a named reason, a new
 *                                SLA cycle, and the previous cycle history
 *                                left intact
 *
 *   OPEN / ACKNOWLEDGED / SUPPRESSED + recovered -> resolve from domain truth
 *   RESOLVED                         + recovered -> nothing to do
 *
 * ---------------------------------------------------------------------------
 * WHY RESOLUTION ORIGIN IS AN INPUT
 * ---------------------------------------------------------------------------
 * "This was resolved and the source is active again" has two readings, and
 * only the durable origin of the previous resolution tells them apart:
 *
 *   * the source RECOVERED and has now recurred — the normal life of a
 *     condition, and the case the stable fingerprint was designed for; or
 *   * an operator marked it resolved while it was still failing — which the
 *     product now refuses, but which existing rows already contain.
 *
 * They are different events and they are recorded differently. Origin is never
 * inferred from `resolvedAtUtc`, from elapsed time or from the note: those are
 * present in both readings. It comes from the event history, and when the
 * history cannot say, the answer is LEGACY_UNKNOWN and the reopen is the
 * conservative one — it names the ambiguity rather than claiming a recurrence
 * that may never have happened.
 */

/** The lifecycle states a condition can hold. */
export const INCIDENT_TRANSITION_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export type IncidentTransitionStatus =
  (typeof INCIDENT_TRANSITION_STATUSES)[number];

/**
 * What the source said this time.
 *
 * There is deliberately no "unknown" member. A caller that could not read its
 * source has not made an observation, and must not ask for a decision about
 * one.
 */
export type SourceObservation = "SOURCE_ACTIVE" | "SOURCE_RECOVERED";

/**
 * Where a previous resolution came from, read from durable history.
 *
 * LEGACY_UNKNOWN is a real answer rather than a failure: rows resolved before
 * the event vocabulary distinguished the two already exist, and reading them
 * as source recoveries would launder a premature operator close into a
 * recurrence.
 */
export type ResolutionOrigin =
  | "SOURCE_RECOVERY"
  | "OPERATOR"
  | "LEGACY_UNKNOWN";

/** Whether the product lets an operator declare this condition resolved. */
export type OperatorResolutionAuthority =
  /** The source own truth decides. An operator may not claim otherwise. */
  | "SOURCE_TRUTH"
  /** Declared operator-resolvable by the canonical registry. */
  | "OPERATOR_MAY_RESOLVE";

/** The bounded decision vocabulary. Nothing else is a valid answer. */
export const INCIDENT_TRANSITION_DECISIONS = [
  "OBSERVATION_ONLY",
  "PRESERVE_ACKNOWLEDGED",
  "PRESERVE_SUPPRESSED",
  "AUTO_RESOLVE_SOURCE_RECOVERY",
  "REOPEN_SOURCE_RECURRENCE",
  "REOPEN_LEGACY_ACTIVE_SOURCE",
  "REFUSE_MANUAL_RESOLUTION",
] as const;
export type IncidentTransitionDecision =
  (typeof INCIDENT_TRANSITION_DECISIONS)[number];

/** The bounded reasons a reopen carries into the event history. */
export const INCIDENT_REOPEN_REASONS = [
  "SOURCE_RECURRENCE",
  "ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION",
] as const;
export type IncidentReopenReason = (typeof INCIDENT_REOPEN_REASONS)[number];

export type ObservationFacts = {
  currentStatus: IncidentTransitionStatus;
  observation: SourceObservation;
  /**
   * Required when `currentStatus` is RESOLVED, ignored otherwise.
   *
   * `null` is treated as LEGACY_UNKNOWN rather than as a recurrence: an absent
   * provenance must never be read as the more permissive of the two.
   */
  previousResolutionOrigin?: ResolutionOrigin | null;
};

export type ManualResolutionFacts = {
  currentStatus: IncidentTransitionStatus;
  /**
   * What the canonical registry declares about this condition. Never a plan
   * name, never a workspace name, never a category list rebuilt at the call
   * site.
   */
  authority: OperatorResolutionAuthority;
  /**
   * What the source says right now, for a SOURCE_TRUTH condition.
   *
   * `null` means NO OBSERVATION WAS MADE — the probe could not read the
   * subject at all, most often because the record the condition names no
   * longer exists. That is not the same as "the source says it is still
   * failing", and it must not be treated as one: a condition whose subject is
   * gone can never be observed active again, so refusing it would leave it
   * permanently unclosable by anyone.
   */
  observation?: SourceObservation | null;
};

/**
 * Does this decision change `status`?
 *
 * Stated once so no writer re-derives it from a member name, and so adding a
 * member forces the question to be answered here.
 */
export function decisionChangesStatus(
  decision: IncidentTransitionDecision,
): boolean {
  switch (decision) {
    case "AUTO_RESOLVE_SOURCE_RECOVERY":
    case "REOPEN_SOURCE_RECURRENCE":
    case "REOPEN_LEGACY_ACTIVE_SOURCE":
      return true;
    case "OBSERVATION_ONLY":
    case "PRESERVE_ACKNOWLEDGED":
    case "PRESERVE_SUPPRESSED":
    case "REFUSE_MANUAL_RESOLUTION":
      return false;
  }
}

/** True for the two decisions that begin a NEW operational cycle. */
export function decisionIsReopen(
  decision: IncidentTransitionDecision,
): boolean {
  return (
    decision === "REOPEN_SOURCE_RECURRENCE" ||
    decision === "REOPEN_LEGACY_ACTIVE_SOURCE"
  );
}

/** The bounded reason a reopen carries, or null when it is not a reopen. */
export function reopenReasonFor(
  decision: IncidentTransitionDecision,
): IncidentReopenReason | null {
  if (decision === "REOPEN_SOURCE_RECURRENCE") return "SOURCE_RECURRENCE";
  if (decision === "REOPEN_LEGACY_ACTIVE_SOURCE")
    return "ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION";
  return null;
}

/**
 * What ONE source observation may do to a condition.
 *
 * Total over the four statuses and the two observations. Pure, so the API and
 * the Worker can be checked against each other rather than against two prose
 * descriptions that agreed when they were written.
 */
export function decideObservationTransition(
  facts: ObservationFacts,
): IncidentTransitionDecision {
  if (facts.observation === "SOURCE_RECOVERED") {
    if (facts.currentStatus === "RESOLVED") return "OBSERVATION_ONLY";
    // Domain truth outranks a suppression: a silenced condition whose record
    // actually recovered IS resolved, and leaving it suppressed-but-fixed
    // would make the next genuine failure read as a continuation of the old
    // one. Suppression governs NOTIFICATION, not what is true.
    return "AUTO_RESOLVE_SOURCE_RECOVERY";
  }

  switch (facts.currentStatus) {
    case "OPEN":
      return "OBSERVATION_ONLY";
    case "ACKNOWLEDGED":
      // The condition is still failing AND a person still owns it. Both are
      // true at once; the observation records the first and must not erase
      // the second.
      return "PRESERVE_ACKNOWLEDGED";
    case "SUPPRESSED":
      return "PRESERVE_SUPPRESSED";
    case "RESOLVED":
      return facts.previousResolutionOrigin === "SOURCE_RECOVERY"
        ? "REOPEN_SOURCE_RECURRENCE"
        : "REOPEN_LEGACY_ACTIVE_SOURCE";
  }
}

/**
 * May an operator declare this condition resolved right now?
 *
 * Returns REFUSE_MANUAL_RESOLUTION when the answer is no. The caller turns
 * that into one stable domain error; it does not re-derive the rule.
 */
export function decideManualResolution(
  facts: ManualResolutionFacts,
): IncidentTransitionDecision {
  if (facts.authority === "OPERATOR_MAY_RESOLVE") return "OBSERVATION_ONLY";
  // SOURCE_TRUTH: the refusal is grounded in a POSITIVE observation that the
  // condition is still true, and in nothing else.
  //
  // The rule this replaces refused on anything that was not a proven recovery,
  // which swept in the case where no observation could be made at all. That
  // was over-broad in a way that mattered: a condition whose subject has been
  // deleted can never be observed active again, so no sweep would ever reopen
  // it — and refusing the operator too left it permanently unclosable, which
  // is not a safer answer, it is a stuck queue.
  //
  // The property the refusal exists for is unchanged: while the source ITSELF
  // still reports the condition, an operator may not declare it over, because
  // the next sweep would contradict them.
  return facts.observation === "SOURCE_ACTIVE"
    ? "REFUSE_MANUAL_RESOLUTION"
    : "OBSERVATION_ONLY";
}

/** The stable domain error code a refused manual resolution carries. */
export const CONDITION_STILL_ACTIVE = "CONDITION_STILL_ACTIVE" as const;
