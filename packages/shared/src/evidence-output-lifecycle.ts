/**
 * COMMERCIAL + EVIDENCE OUTPUT LIFECYCLE CLOSURE (2026-09-08).
 *
 * THE PURE STATE MACHINE for "what is going on with this record's PDF report
 * and verification package?", stated once so the API projection, the Reports
 * aggregator and the browser cannot answer it three different ways.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THREE QUESTIONS THAT WERE ONE BOOLEAN
 * ---------------------------------------------------------------------------
 * Every artifact surface in the product asked one thing — "is there a Report
 * row?" — and rendered the answer as `available` / `pending`. That collapses
 * three genuinely independent facts:
 *
 *   1. COMMERCIAL ELIGIBILITY  may this record have these outputs at all?
 *   2. GENERATION EXECUTION    has anything been asked to produce them, and
 *                              how did that go?
 *   3. ARTIFACT AVAILABILITY   does a finished artifact exist right now?
 *
 * With them collapsed, "no report row" meant `pending: true` — forever — for
 * a Free account that was never entitled to one and for which no job was ever
 * enqueued. The product told those customers their report was "still being
 * generated" for the life of the record, counted them as an operational
 * backlog, and offered no action because the only action was gated on a
 * `failed` state the server could not produce.
 *
 * Keeping the three axes apart is the whole fix. A surface that needs one
 * sentence gets {@link deriveEvidenceOutputState}; a surface that needs to
 * explain itself reads the axes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------
 * It decides nothing commercial. `resolveEvidenceOutputEntitlements`
 * (@proovra/shared-billing) is the ONE authority for axis 1 and this module
 * takes its verdict as an input. It reads no database, no plan name and no
 * funding row. It is a total function over three enums.
 */

// ===========================================================================
// AXIS 1 — COMMERCIAL ELIGIBILITY
// ===========================================================================

/**
 * May this record have this output, given the workspace's effective plan AND
 * how the record's own completion was funded?
 *
 * Two values, deliberately. "Not included" is not a failure, not a pending
 * state and not an error; it is the product working as sold. Anything richer
 * belongs in the REASON, not in the state.
 */
export const OUTPUT_COMMERCIAL_ELIGIBILITIES = [
  "NOT_INCLUDED",
  "ELIGIBLE",
] as const;
export type OutputCommercialEligibility =
  (typeof OUTPUT_COMMERCIAL_ELIGIBILITIES)[number];

/**
 * Why an output is not included. Bounded so a surface can render copy without
 * a server-supplied sentence, and so no free text reaches the browser.
 *
 * `NOT_INCLUDED_IN_PLAN` is the only value today. It is an enum rather than a
 * boolean because the next reason (a contract that excludes an output, a
 * suspended commercial lifecycle) must be addable without changing the shape.
 */
export const OUTPUT_INELIGIBILITY_REASONS = ["NOT_INCLUDED_IN_PLAN"] as const;
export type OutputIneligibilityReason =
  (typeof OUTPUT_INELIGIBILITY_REASONS)[number];

// ===========================================================================
// AXIS 2 — GENERATION EXECUTION
// ===========================================================================

/**
 * The customer-safe projection of `ReportGenerationRequest.state`.
 *
 * DELIBERATELY NARROWER THAN THE PERSISTED MACHINE. The request row carries
 * `QUEUED | PROCESSING | SUCCEEDED | FAILED_RETRYABLE | FAILED_TERMINAL |
 * BLOCKED_STALE | BLOCKED_POLICY`, plus attempt counts and a bounded terminal
 * reason code. A customer needs to know whether work is happening, whether it
 * can be retried, and whether something is blocking it — not which of two
 * internal blocking conditions applied.
 *
 * `SUCCEEDED` has no member here on purpose: a succeeded request is described
 * by axis 3 (the artifact exists). Projecting it twice is how a "succeeded but
 * no artifact" contradiction becomes renderable.
 */
export const OUTPUT_GENERATION_STATES = [
  /** Nothing has ever been asked to produce this output. */
  "NOT_REQUESTED",
  /** A durable request exists and is waiting for a worker. */
  "QUEUED",
  /** A worker holds the claim right now. */
  "PROCESSING",
  /** The attempt failed and the intent is still valid. Retry is meaningful. */
  "RETRYABLE_FAILURE",
  /** The attempt failed and this request will not be re-run as it stands. */
  "TERMINAL_FAILURE",
  /** Refused before any work: stale policy version, or a policy block. */
  "BLOCKED",
] as const;
export type OutputGenerationState = (typeof OUTPUT_GENERATION_STATES)[number];

/**
 * The persisted request states, restated as an INPUT type.
 *
 * Not imported from the runtime package: this module must stay dependency-free
 * and the mapping below is total over this union, so a new persisted state is
 * a compile error here rather than a silent default.
 */
export type PersistedReportRequestState =
  | "QUEUED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "BLOCKED_STALE"
  | "BLOCKED_POLICY";

/**
 * THE REQUEST STATES THAT MEAN "THE SYSTEM STILL OWES AN ANSWER".
 *
 * ---------------------------------------------------------------------------
 * RELIABILITY CLOSURE (2026-09-09) — WHY THIS NEEDED A NAME
 * ---------------------------------------------------------------------------
 * Billing counts finalized records that have no report yet and calls the
 * result "eligible without outputs". The count was `status: SIGNED` plus
 * `reports: { none: {} }`, which is a fair description of the artifact table
 * and an unfair description of the customer's situation: a record whose
 * generation is QUEUED, claimed by a worker right now, or waiting on a retry
 * also has no report row, and counting it says "you have not generated this"
 * about work the product is in the middle of doing.
 *
 * These three states are the ones where the request is live. Naming them here,
 * beside the persisted union they are drawn from, keeps the reading in the
 * module that owns the vocabulary rather than as an array literal in a billing
 * projection.
 *
 * This is NOT a second claim predicate. The worker's claim uses the complement
 * — `state notIn [SUCCEEDED, FAILED_TERMINAL, BLOCKED_STALE, BLOCKED_POLICY]`
 * — and remains the only thing that decides what a worker may take. The two
 * lists partition `PersistedReportRequestState` exactly, and a contract test
 * pins that partition so neither can drift alone.
 */
export const IN_FLIGHT_REPORT_REQUEST_STATES = [
  "QUEUED",
  "PROCESSING",
  "FAILED_RETRYABLE",
] as const satisfies ReadonlyArray<PersistedReportRequestState>;

/**
 * The complement: a request in one of these has stopped, however it stopped.
 *
 * Exported so the partition can be asserted rather than assumed.
 */
export const SETTLED_REPORT_REQUEST_STATES = [
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "BLOCKED_STALE",
  "BLOCKED_POLICY",
] as const satisfies ReadonlyArray<PersistedReportRequestState>;

/**
 * THE persisted-state → customer-state mapping. One place, total.
 *
 * `SUCCEEDED` maps to `NOT_REQUESTED` because, from the customer's side, a
 * finished request is not an ongoing operation: the artifact it produced is
 * axis 3's business, and if a NEWER generation is later requested this axis
 * describes that one. Callers that hold a succeeded request and no artifact
 * have a reconciliation problem, not a projection problem.
 */
export function projectReportRequestState(
  state: PersistedReportRequestState,
): OutputGenerationState {
  switch (state) {
    case "QUEUED":
      return "QUEUED";
    case "PROCESSING":
      return "PROCESSING";
    case "FAILED_RETRYABLE":
      return "RETRYABLE_FAILURE";
    case "FAILED_TERMINAL":
      return "TERMINAL_FAILURE";
    case "BLOCKED_STALE":
    case "BLOCKED_POLICY":
      return "BLOCKED";
    case "SUCCEEDED":
      return "NOT_REQUESTED";
  }
}

/**
 * Terminal reason CLASSES a customer surface may act on.
 *
 * The persisted `terminalReasonCode` is a bounded internal code (64 chars) and
 * is NOT projected raw — it names worker branches. This is the class, which is
 * the only part a surface needs, because it decides whether an action exists:
 *
 *   COMMERCIAL   the record was not entitled when the attempt ran. Becoming
 *                entitled makes a NEW request meaningful, so this class is the
 *                one that may be superseded (see
 *                `isCommerciallyObsoleteTerminalReason`).
 *   INTEGRITY    the record itself cannot produce a truthful artifact — a hash
 *                mismatch, a missing signing key. Never retried.
 *   POLICY       governance refused. Resolvable only by governance.
 *   TECHNICAL    the pipeline failed and exhausted its budget. An operator
 *                path may exist.
 */
export const OUTPUT_TERMINAL_REASON_CLASSES = [
  "COMMERCIAL",
  "INTEGRITY",
  "POLICY",
  "TECHNICAL",
] as const;
export type OutputTerminalReasonClass =
  (typeof OUTPUT_TERMINAL_REASON_CLASSES)[number];

/**
 * The worker error codes that mean "this record was not commercially entitled
 * when the attempt ran".
 *
 * THIS LIST IS LOAD-BEARING. It is what makes a terminal commercial failure
 * SUPERSEDABLE after an upgrade, and it must contain only reasons that a
 * change of entitlement genuinely resolves. A technical or integrity failure
 * added here would become silently retryable forever.
 */
const COMMERCIAL_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "REPORT_NOT_INCLUDED_IN_PLAN",
  "VERIFICATION_PACKAGE_NOT_INCLUDED",
  "REPORT_NOT_INCLUDED",
]);

/**
 * Is this terminal reason one that a change of commercial entitlement makes
 * obsolete?
 *
 * Used by the generation authority to decide whether a NEW request may be
 * created for a record whose previous request is `FAILED_TERMINAL`. Every
 * other terminal class stays terminal.
 */
export function isCommerciallyObsoleteTerminalReason(
  terminalReasonCode: string | null | undefined,
): boolean {
  if (!terminalReasonCode) return false;
  return COMMERCIAL_TERMINAL_REASONS.has(terminalReasonCode.trim().toUpperCase());
}

/** The class of a bounded terminal reason code. Unknown codes read TECHNICAL. */
export function classifyTerminalReason(
  terminalReasonCode: string | null | undefined,
): OutputTerminalReasonClass {
  const code = (terminalReasonCode ?? "").trim().toUpperCase();
  if (!code) return "TECHNICAL";
  if (COMMERCIAL_TERMINAL_REASONS.has(code)) return "COMMERCIAL";
  if (
    code === "EVIDENCE_INTEGRITY_FAILED" ||
    code === "FAILED_HASH_MISMATCH" ||
    code === "SIGNING_KEY_NOT_FOUND" ||
    code === "OWNER_USER_NOT_FOUND" ||
    code === "EVIDENCE_STORAGE_NOT_SET"
  ) {
    return "INTEGRITY";
  }
  if (code.startsWith("BLOCKED") || code.includes("POLICY") || code.includes("STALE")) {
    return "POLICY";
  }
  return "TECHNICAL";
}

// ===========================================================================
// AXIS 3 — ARTIFACT AVAILABILITY
// ===========================================================================

/**
 * Does a finished artifact exist?
 *
 * There is no `SUPERSEDED` member. Supersession is a property of a VERSION,
 * not of the record's current output: version 1 is superseded by version 2,
 * and both exist. It travels as metadata on the version list.
 */
export const OUTPUT_ARTIFACT_AVAILABILITIES = ["NO_ARTIFACT", "READY"] as const;
export type OutputArtifactAvailability =
  (typeof OUTPUT_ARTIFACT_AVAILABILITIES)[number];

// ===========================================================================
// THE DERIVED CUSTOMER-FACING STATE
// ===========================================================================

/**
 * The single sentence a surface renders.
 *
 * Derived from the three axes by {@link deriveEvidenceOutputState} and NEVER
 * persisted: it is a function of facts that already have their own storage, so
 * a column for it would be a fourth authority that can disagree with them.
 */
export const EVIDENCE_OUTPUT_STATES = [
  /** The plan (and this record's funding) do not include this output. */
  "NOT_INCLUDED",
  /** Included, nothing produced yet, and asking for it is a real action. */
  "ELIGIBLE_NOT_GENERATED",
  "QUEUED",
  "GENERATING",
  "RETRYABLE_FAILURE",
  "TERMINAL_FAILURE",
  "BLOCKED",
  /** An artifact exists and can be downloaded. */
  "READY",
] as const;
export type EvidenceOutputState = (typeof EVIDENCE_OUTPUT_STATES)[number];

export type EvidenceOutputAxes = {
  eligibility: OutputCommercialEligibility;
  generation: OutputGenerationState;
  availability: OutputArtifactAvailability;
  /**
   * Has the record reached the point where an output could exist at all?
   * A draft or uploading record is not "eligible but ungenerated" — nothing
   * has happened yet — so it reports NOT_REQUESTED rather than inviting an
   * action that would be refused.
   */
  finalized: boolean;
};

/**
 * THE derivation. Total, pure, and ordered so the most consequential fact
 * wins.
 *
 * ORDER MATTERS AND IS THE POINT:
 *
 *   1. READY first. An artifact that exists is downloadable, and that stays
 *      true when the plan later stops including NEW generation. This is what
 *      makes a downgrade lose the ability to generate without losing what the
 *      customer already paid for.
 *   2. Then live work, so an in-flight retry after an upgrade is not reported
 *      as "not included" for the seconds before it lands.
 *   3. Then commercial ineligibility, which is why nothing is happening.
 *   4. Then the failure and blocked states.
 *   5. Then eligible-but-ungenerated, which is the one that carries an action.
 */
export function deriveEvidenceOutputState(
  axes: EvidenceOutputAxes,
): EvidenceOutputState {
  if (axes.availability === "READY") return "READY";

  if (axes.generation === "QUEUED") return "QUEUED";
  if (axes.generation === "PROCESSING") return "GENERATING";

  if (axes.eligibility === "NOT_INCLUDED") return "NOT_INCLUDED";

  if (axes.generation === "BLOCKED") return "BLOCKED";
  if (axes.generation === "RETRYABLE_FAILURE") return "RETRYABLE_FAILURE";
  if (axes.generation === "TERMINAL_FAILURE") return "TERMINAL_FAILURE";

  // Eligible, nothing in flight, nothing produced. Only a finalized record can
  // be asked for an output; before that there is simply nothing to generate.
  return axes.finalized ? "ELIGIBLE_NOT_GENERATED" : "NOT_INCLUDED";
}

/**
 * Which action, if any, a surface may offer for a state.
 *
 * Returned as a bounded verb rather than a boolean so the browser never has to
 * decide between "Generate" and "Regenerate" from the absence of a version —
 * that inference is exactly how a first generation came to be labelled a
 * regeneration.
 */
export const OUTPUT_ACTIONS = ["GENERATE", "RETRY", "REGENERATE", "NONE"] as const;
export type OutputAction = (typeof OUTPUT_ACTIONS)[number];

export function outputActionFor(input: {
  state: EvidenceOutputState;
  eligibility: OutputCommercialEligibility;
  /** Class of the terminal reason, when the state is TERMINAL_FAILURE. */
  terminalReasonClass?: OutputTerminalReasonClass | null;
}): OutputAction {
  switch (input.state) {
    case "READY":
      // A new version is only meaningful while the record is still entitled to
      // produce one. After a downgrade the existing artifact stays
      // downloadable and regeneration stops being offered.
      return input.eligibility === "ELIGIBLE" ? "REGENERATE" : "NONE";
    case "ELIGIBLE_NOT_GENERATED":
      return "GENERATE";
    case "RETRYABLE_FAILURE":
      return "RETRY";
    case "TERMINAL_FAILURE":
      /*
       * A terminal COMMERCIAL failure on a now-eligible record is not a retry
       * of the old attempt — the old attempt is history and stays that way. It
       * is a first generation under the entitlement the customer now holds, so
       * the verb is GENERATE.
       *
       * Every other terminal class offers nothing: an integrity failure cannot
       * be re-promoted into an artifact, and a technical one that exhausted its
       * budget needs an operator, not a customer button.
       */
      return input.eligibility === "ELIGIBLE" &&
        input.terminalReasonClass === "COMMERCIAL"
        ? "GENERATE"
        : "NONE";
    case "NOT_INCLUDED":
    case "QUEUED":
    case "GENERATING":
    case "BLOCKED":
      return "NONE";
  }
}

// ===========================================================================
// RELIABILITY CLOSURE (2026-09-09) — BLOCKED IS NOT ALWAYS FOREVER
// ===========================================================================

/**
 * The bounded terminal reason codes a `BLOCKED_STALE` / `BLOCKED_POLICY`
 * request may carry, split by whether the blocker is a CONDITION OF THE WORLD
 * that can end, or a statement about the request itself that never changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `isCommerciallyObsoleteTerminalReason` made a terminal COMMERCIAL refusal
 * supersedable, and that closed the permanent lockout for one class. Three
 * other classes were left behind, and they are equally recoverable:
 *
 *   policy_version_changed   a workspace governance policy was edited between
 *                            a request's creation and its execution. That is a
 *                            RACE, not a refusal — the very next request would
 *                            have carried the new version and run.
 *   legal_hold_active        holds are placed and released.
 *   organization_not_active  suspensions are lifted.
 *
 * Because the request's idempotency key is anchored on the artifact version it
 * is trying to advance past, and a blocked request produces no artifact, every
 * later request for that record computed the SAME key, collapsed onto the
 * terminal row and returned `already_terminal`. The customer's Generate button,
 * the Reports page and the Operations remediation all dead-ended, permanently,
 * on a condition that had since gone away.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not make a blocked request retryable. It says only that a NEW request
 * MAY be minted — and the writer still has to confirm, against the CURRENT
 * source of truth, that the blocker is genuinely gone. A reason code is a
 * record of what was true once; it is never permission to act now.
 */
const RECOVERABLE_BLOCKED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "POLICY_VERSION_CHANGED",
  "LEGAL_HOLD_ACTIVE",
  "ORGANIZATION_NOT_ACTIVE",
]);

/**
 * Reasons that describe the REQUEST rather than the world, and so can never be
 * resolved by waiting. Stated explicitly rather than left as "everything else"
 * so that adding a new blocked reason is a deliberate classification.
 */
const NON_RECOVERABLE_BLOCKED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "WORKSPACE_MISMATCH",
  "WORKSPACE_NOT_FOUND",
  "NO_PRINCIPAL",
  "EVIDENCE_NOT_FOUND",
]);

/**
 * Is this blocked terminal reason one whose blocker can END?
 *
 * Unknown codes answer FALSE. A blocked reason nobody has classified must not
 * become silently supersedable, because supersession is what lets a new
 * generation run — the conservative default is the one that cannot invent
 * permission.
 */
export function isRecoverableBlockedTerminalReason(
  terminalReasonCode: string | null | undefined,
): boolean {
  if (!terminalReasonCode) return false;
  const code = terminalReasonCode.trim().toUpperCase();
  if (NON_RECOVERABLE_BLOCKED_TERMINAL_REASONS.has(code)) return false;
  return RECOVERABLE_BLOCKED_TERMINAL_REASONS.has(code);
}

/** Exposed for the contract test and for operator projections. */
export function listRecoverableBlockedTerminalReasons(): readonly string[] {
  return [...RECOVERABLE_BLOCKED_TERMINAL_REASONS];
}

/** Exposed for the contract test. */
export function listNonRecoverableBlockedTerminalReasons(): readonly string[] {
  return [...NON_RECOVERABLE_BLOCKED_TERMINAL_REASONS];
}

// ===========================================================================
// GENERATION INTENT — THE VERB, AS A COMMAND
// ===========================================================================

/**
 * What an actor is ASKING FOR. Distinct from {@link OutputAction}, which is
 * what a surface may OFFER.
 *
 * They are the same three words and they are not the same thing: the action is
 * a projection the server computes and the browser renders, while the intent is
 * a command the browser sends and the server RE-DERIVES before it acts. The
 * server never trusts the intent to be correct — it uses it only to record what
 * the actor believed, and refuses when belief and truth disagree in a way that
 * matters.
 *
 * `forceRegenerate` used to be sent as a hard-coded `true` for all three verbs,
 * which meant a FIRST generation entered the regeneration-only legal-hold
 * branch and burned its own idempotency key on a record that had nothing to
 * preserve.
 */
export const GENERATION_INTENTS = ["GENERATE", "RETRY", "REGENERATE"] as const;
export type GenerationIntent = (typeof GENERATION_INTENTS)[number];

/**
 * THE ONE RULE that turns an output state into `forceRegenerate`.
 *
 * `forceRegenerate` authorizes REPLACING a finalised artifact, and that is true
 * of exactly one situation: an artifact already exists. Not "the caller asked
 * for a regeneration", not "the endpoint is the regenerate endpoint" — the
 * artifact itself is the fact that decides it, and the server reads that fact
 * from persistence rather than from the request body.
 */
export function resolveForceRegenerate(input: {
  availability: OutputArtifactAvailability;
}): boolean {
  return input.availability === "READY";
}

/**
 * The intent implied by a canonical action, so a surface that holds an action
 * can send the matching command without inventing a mapping of its own.
 */
export function intentForOutputAction(
  action: OutputAction,
): GenerationIntent | null {
  switch (action) {
    case "GENERATE":
      return "GENERATE";
    case "RETRY":
      return "RETRY";
    case "REGENERATE":
      return "REGENERATE";
    case "NONE":
      return null;
  }
}

// ===========================================================================
// THE TYPED OUTCOME OF ASKING FOR GENERATION
// ===========================================================================

/**
 * What actually happened when generation was requested.
 *
 * ---------------------------------------------------------------------------
 * WHY A VOCABULARY AND NOT A BOOLEAN
 * ---------------------------------------------------------------------------
 * The API answered `202 { enqueued: boolean, reason?: string }`, and every
 * browser surface collapsed `enqueued: false` into one sentence — "Generation
 * is already under way for this record." That sentence was true for exactly one
 * of the six reasons it was shown for. A customer whose request was lost to a
 * Redis outage, and a customer whose record was permanently blocked, were both
 * told the work was in progress.
 *
 * These members are the answers a person can act on differently. Anything finer
 * belongs in a log.
 */
export const GENERATION_REQUEST_OUTCOMES = [
  /** A new unit of work is durable and scheduled. */
  "ENQUEUED",
  /** Durable, and it joined work that was already live. */
  "ALREADY_ACTIVE",
  /** The row is durable but the queue refused it. A reconciler owns it. */
  "QUEUE_UNAVAILABLE",
  /** The record's plan and funding do not include this output. */
  "NOT_INCLUDED",
  /** A governance or lifecycle condition refuses it, and still does. */
  "RECOVERABLE_BLOCKED",
  /** The previous attempt ended in a state nothing will reopen. */
  "TERMINAL",
  /** A new request superseded a recoverable terminal one. */
  "SUPERSEDED",
  /** The request could not be persisted at all. */
  "REQUEST_PERSIST_FAILED",
  /** No such record, or it is not visible to this actor. */
  "EVIDENCE_NOT_FOUND",
  /** A request with no principal cannot be audited, so it is refused. */
  "REQUESTER_REQUIRED",
] as const;
export type GenerationRequestOutcome =
  (typeof GENERATION_REQUEST_OUTCOMES)[number];

/**
 * Did this outcome put new work into the system?
 *
 * The single question every surface was answering wrongly. `SUPERSEDED` counts:
 * a superseding request IS new work, and it is the outcome an upgraded customer
 * gets on the click that finally works. `QUEUE_UNAVAILABLE` does not: the row is
 * durable and a reconciler owns it, but nothing is scheduled yet and telling the
 * customer otherwise is the falsehood this vocabulary exists to end.
 */
export function generationOutcomeAcceptedWork(
  outcome: GenerationRequestOutcome,
): boolean {
  return outcome === "ENQUEUED" || outcome === "SUPERSEDED";
}
