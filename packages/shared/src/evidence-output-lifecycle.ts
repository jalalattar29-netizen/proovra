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
