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

import type {
  NotApplicableDisposition,
  ResolutionAuthority,
  SourceActivity,
} from "./ops/source-lifecycle.js";

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

/**
 * WHETHER THE PRODUCT LETS AN OPERATOR DECLARE THIS CONDITION RESOLVED.
 *
 * The vocabulary is now the canonical source lifecycle contract's, re-exported
 * here so callers that already import this module do not have to learn a
 * second import path for the same idea.
 *
 * It used to be a two-member type declared HERE and decided per
 * `IncidentCategory` in the API's remediation registry. Both of those are
 * gone: authority is a property of the SOURCE, and the third member —
 * NO_DIRECT_RESOLUTION — exists because "an operator may not close this AND
 * nothing can observe its recovery" is a real state the two-member vocabulary
 * could only express by lying in one direction.
 */
export type { ResolutionAuthority } from "./ops/source-lifecycle.js";

/** The bounded decision vocabulary. Nothing else is a valid answer. */
export const INCIDENT_TRANSITION_DECISIONS = [
  "OBSERVATION_ONLY",
  "PRESERVE_ACKNOWLEDGED",
  "PRESERVE_SUPPRESSED",
  "AUTO_RESOLVE_SOURCE_RECOVERY",
  "REOPEN_SOURCE_RECURRENCE",
  "REOPEN_LEGACY_ACTIVE_SOURCE",
  /** The source itself still reports the condition. */
  "REFUSE_MANUAL_RESOLUTION",
  /**
   * The source could not be READ. Distinct from the refusal above and
   * deliberately so: "still failing" and "we could not check" are different
   * facts, an operator is owed the difference, and collapsing them would make
   * a transient database fault indistinguishable from a real active condition.
   */
  "REFUSE_ACTIVITY_UNKNOWN",
  /**
   * Nobody in this workspace can truthfully declare this condition over, and
   * no probe exists that could. There is no Resolve control for these at all;
   * this is what refuses one that arrives anyway.
   */
  "REFUSE_NO_DIRECT_RESOLUTION",
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
   * What the canonical SOURCE contract declares about this condition.
   *
   * Resolved from the condition's own source — fingerprint first — and never
   * from a plan name, a workspace name, a severity or a category list rebuilt
   * at the call site. Declaring it per category is the defect this replaced:
   * four sources write category WORKER, so a category-level rule was a rule
   * about a set nobody had enumerated.
   */
  authority: ResolutionAuthority;
  /**
   * What the source says RIGHT NOW, for a SOURCE_TRUTH condition.
   *
   * Four states, all of them real and none of them collapsible:
   *
   *   ACTIVE          the condition is still true. Refused.
   *   RECOVERED       positively observed to be over. Allowed.
   *   UNKNOWN         the probe could not read the source. Refused, with its
   *                   own code, because "we could not check" is not "it is
   *                   fine" — and it is not "it is still broken" either.
   *   NOT_APPLICABLE  the subject the condition names cannot be identified at
   *                   all, most often a record that has been deleted. What
   *                   that permits is declared per source, because a subject
   *                   that is gone can never be observed active again and
   *                   refusing would leave the condition unclosable forever.
   */
  activity?: SourceActivity | null;
  /**
   * What this source says NOT_APPLICABLE permits. Required whenever `activity`
   * can be NOT_APPLICABLE; the conservative REFUSE is assumed when absent.
   */
  notApplicableDisposition?: NotApplicableDisposition;
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
    case "REFUSE_ACTIVITY_UNKNOWN":
    case "REFUSE_NO_DIRECT_RESOLUTION":
      return false;
  }
}

/** True for every decision that declines a manual resolution. */
export function decisionRefusesManualResolution(
  decision: IncidentTransitionDecision,
): boolean {
  return (
    decision === "REFUSE_MANUAL_RESOLUTION" ||
    decision === "REFUSE_ACTIVITY_UNKNOWN" ||
    decision === "REFUSE_NO_DIRECT_RESOLUTION"
  );
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
  // NO_DIRECT_RESOLUTION: refused on the CONTRACT, before any probe is
  // consulted, because there is nothing to consult. The workspace cannot
  // observe this source's recovery and must not assert it; the projection does
  // not offer a Resolve control, and this is what answers one that arrives
  // from a stale tab or a direct API call anyway.
  if (facts.authority === "NO_DIRECT_RESOLUTION") {
    return "REFUSE_NO_DIRECT_RESOLUTION";
  }

  // OPERATOR_DECISION: the condition records something that HAPPENED and its
  // completion is a human conclusion. No probe exists and none is asked for —
  // asking would be inventing a technical fact to gate a judgement.
  if (facts.authority === "OPERATOR_DECISION") return "OBSERVATION_ONLY";

  // SOURCE_TRUTH: the source decides, and the four probe answers are four
  // different decisions.
  switch (facts.activity) {
    case "RECOVERED":
      // The ONLY answer that permits a source-truth resolution.
      return "OBSERVATION_ONLY";
    case "ACTIVE":
      // While the source ITSELF still reports the condition, an operator may
      // not declare it over: the next sweep would contradict them, minutes
      // later and silently.
      return "REFUSE_MANUAL_RESOLUTION";
    case "NOT_APPLICABLE":
      // The subject cannot be identified. Whether that is closable is a
      // property of the SOURCE — a deleted evidence record can never be
      // observed active again and must stay closable; a workspace-level count
      // cannot become unidentifiable, so NOT_APPLICABLE there means the probe
      // is wrong and must resolve nothing.
      return facts.notApplicableDisposition === "ALLOW_OPERATOR_CLOSE"
        ? "OBSERVATION_ONLY"
        : "REFUSE_ACTIVITY_UNKNOWN";
    case "UNKNOWN":
    case null:
    case undefined:
    default:
      // FAIL CLOSED. A missing observation is not a recovery. This is the
      // branch that turns a database fault into a refusal instead of into a
      // false all-clear.
      return "REFUSE_ACTIVITY_UNKNOWN";
  }
}

/** The stable domain error code a refused manual resolution carries. */
export const CONDITION_STILL_ACTIVE = "CONDITION_STILL_ACTIVE" as const;

/**
 * The stable domain error code for a probe that could not read its source.
 *
 * A SEPARATE code from `CONDITION_STILL_ACTIVE` on purpose. The operator did
 * not do anything wrong and the condition is not necessarily still true — the
 * platform simply could not check, and the honest thing to tell them is
 * exactly that rather than an assertion the server cannot back.
 */
export const CONDITION_ACTIVITY_UNKNOWN = "CONDITION_ACTIVITY_UNKNOWN" as const;

/**
 * The stable domain error code for a condition nobody may directly resolve.
 *
 * Reached only by a request the projection never offered.
 */
export const CONDITION_NOT_DIRECTLY_RESOLVABLE =
  "CONDITION_NOT_DIRECTLY_RESOLVABLE" as const;

/** The refusal code one refusing decision carries, or null when it allows. */
export function manualResolutionErrorCode(
  decision: IncidentTransitionDecision,
):
  | typeof CONDITION_STILL_ACTIVE
  | typeof CONDITION_ACTIVITY_UNKNOWN
  | typeof CONDITION_NOT_DIRECTLY_RESOLVABLE
  | null {
  if (decision === "REFUSE_MANUAL_RESOLUTION") return CONDITION_STILL_ACTIVE;
  if (decision === "REFUSE_ACTIVITY_UNKNOWN") return CONDITION_ACTIVITY_UNKNOWN;
  if (decision === "REFUSE_NO_DIRECT_RESOLUTION") {
    return CONDITION_NOT_DIRECTLY_RESOLVABLE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DURABLE RESOLUTION PROVENANCE — ONE TABLE, BOTH HOSTS
// ---------------------------------------------------------------------------

/**
 * The event types that record a resolution, and what each one means.
 *
 * It lived TWICE — once in the API's incident service and once in the Worker's
 * emitter — as "duplicated as data rather than imported". Both copies describe
 * the SAME rows in the SAME table, so the duplication had nothing to recommend
 * it beyond the import boundary that no longer exists: the decision that reads
 * this table is already here.
 *
 * Provenance is read from the EVENT HISTORY and from nothing else. Neither
 * `resolvedAtUtc`, nor `resolvedByUserId`, nor the note, nor elapsed time can
 * distinguish "the source recovered" from "a person said it was fine": the
 * first two are written by both paths and the last is written by neither.
 */
export const RESOLUTION_EVENT_ORIGINS: Readonly<
  Record<string, ResolutionOrigin>
> = Object.freeze({
  /** Written by a recovery sweep from the source's own observable truth. */
  resolved_by_domain_truth: "SOURCE_RECOVERY",
  /** Written by `transitionIncident` when an operator resolved it. */
  resolved: "OPERATOR",
});

/** The canonical event type for a reopen. Never an `increment`. */
export const REOPENED_EVENT = "reopened";
/** The canonical event type for a still-failing suppressed condition. */
export const OCCURRENCE_WHILE_SUPPRESSED_EVENT = "occurrence_while_suppressed";
/** The canonical event type for a resolution the SOURCE decided. */
export const RESOLVED_BY_DOMAIN_TRUTH_EVENT = "resolved_by_domain_truth";
