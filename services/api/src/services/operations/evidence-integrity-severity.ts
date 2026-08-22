/**
 * EVIDENCE INTEGRITY SEVERITY POLICY (Attention Architecture, Phase 3.6).
 *
 * ---------------------------------------------------------------------------
 * ONE POLICY, WRITTEN DOWN
 * ---------------------------------------------------------------------------
 * Every TSA and OTS failure is a genuine integrity gap, and they are not all
 * the same size. A provider that timed out will very likely succeed on the
 * next retry; a message-imprint mismatch will never succeed and means the
 * thing we tried to timestamp is not what we thought it was. Filing both at
 * one severity throws away the only signal an operator has for deciding what
 * to open first, and "everything is CRITICAL" is operationally identical to
 * "nothing is".
 *
 * So severity is DERIVED, from signals that actually exist on the row:
 *
 *   failure class      what the reason code says went wrong
 *   condition age      how long this has been failing
 *   legal posture      whether the record is under a legal hold
 *
 * ---------------------------------------------------------------------------
 * SEVERITY IS NOT IDENTITY (Phase 3.1 / 3.6)
 * ---------------------------------------------------------------------------
 * Nothing in this module participates in the condition's fingerprint. The
 * fingerprint is `<class>:<evidenceId>` and nothing else, so a failure that
 * escalates from WARNING to CRITICAL as it ages is still the SAME condition
 * with the same history — not a second one. Deriving identity from anything
 * that can change is how a single unresolved problem becomes four rows.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST READ THE PROVIDER'S ERROR STRING?
 * ---------------------------------------------------------------------------
 * `tsaFailureReason` / `otsFailureReason` are free-text on the schema and
 * carry provider-authored content. They are CLASSIFIED here — matched against
 * a bounded set of known codes and substrings — and never rendered raw into a
 * severity decision or a fingerprint. An unrecognised reason falls to
 * `UNKNOWN`, which is deliberately treated as serious rather than trivial: we
 * do not know that it is retryable, and guessing in the optimistic direction
 * is how a permanent cryptographic failure sits in a WARNING bucket for a
 * month.
 */

import type { IncidentSeverity } from "@proovra/shared";

/**
 * What kind of failure this is. Derived from the persisted reason code, which
 * the TSA/OTS pipelines write as bounded machine-readable strings.
 */
export type IntegrityFailureClass =
  /** Provider unreachable / timed out / 5xx. Expected to succeed on retry. */
  | "RETRYABLE_PROVIDER"
  /** Credentials, URL, or provider configuration is wrong. Needs an operator. */
  | "CONFIGURATION"
  /** Quota, budget or rate limit exhausted. Needs a decision, not a retry. */
  | "QUOTA"
  /** Imprint / digest / parse / signature failure. Retrying cannot fix this. */
  | "CRYPTOGRAPHIC"
  /** The pipeline gave up after exhausting its retries. */
  | "RETRY_EXHAUSTED"
  /** The reason code is not one we recognise. Treated as serious. */
  | "UNKNOWN";

/**
 * Reason-code classification.
 *
 * Matched as case-insensitive SUBSTRINGS against the persisted reason,
 * because both pipelines compose codes (`OTS_GLOBAL_BUDGET_EXHAUSTED`,
 * `TSA_HTTP_504_GATEWAY_TIMEOUT`) rather than emitting a closed enum. Order
 * matters: the first matching entry wins, and the list is ordered so that the
 * most specific and most serious classes are tested before the general ones —
 * a "retry exhausted after timeout" is retry-exhausted, not retryable.
 */
const REASON_CLASSIFIERS: ReadonlyArray<{
  match: readonly string[];
  failureClass: IntegrityFailureClass;
}> = [
  {
    failureClass: "CRYPTOGRAPHIC",
    match: [
      "imprint",
      "digest_mismatch",
      "hash_mismatch",
      "parse",
      "malformed",
      "invalid_token",
      "signature_invalid",
      "cert_invalid",
      "untrusted",
    ],
  },
  {
    failureClass: "RETRY_EXHAUSTED",
    match: ["retry_exhausted", "max_attempts", "attempts_exceeded", "gave_up"],
  },
  {
    failureClass: "QUOTA",
    match: ["budget_exhausted", "quota", "rate_limit", "429", "throttl"],
  },
  {
    failureClass: "CONFIGURATION",
    match: [
      "unauthorized",
      "forbidden",
      "401",
      "403",
      "not_configured",
      "missing_credential",
      "invalid_url",
      "dns",
    ],
  },
  {
    failureClass: "RETRYABLE_PROVIDER",
    match: [
      "timeout",
      "timed_out",
      "econnreset",
      "unavailable",
      "502",
      "503",
      "504",
      "network",
      "temporarily",
    ],
  },
];

export function classifyIntegrityFailure(
  reason: string | null | undefined,
): IntegrityFailureClass {
  if (!reason) return "UNKNOWN";
  const normalized = reason.toLowerCase();
  for (const classifier of REASON_CLASSIFIERS) {
    if (classifier.match.some((needle) => normalized.includes(needle))) {
      return classifier.failureClass;
    }
  }
  return "UNKNOWN";
}

/** How long a failure may sit before age alone escalates it. */
export const AGE_ESCALATION_DAYS = 7;
export const AGE_CRITICAL_DAYS = 30;

export type IntegritySeverityInput = {
  failureClass: IntegrityFailureClass;
  /** When this condition was first observed. */
  firstSeenAtUtc: Date;
  now: Date;
  /**
   * Whether the Evidence is under an active legal hold. A record someone is
   * legally obliged to preserve, whose integrity proof is missing, is a
   * different problem from the same gap on an ordinary record.
   */
  underLegalHold: boolean;
};

const RANK: Record<IncidentSeverity, number> = {
  INFO: 1,
  WARNING: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function maxSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * BASE severity by failure class.
 *
 * The ordering encodes one judgement: how likely is this to fix itself?
 *
 *   RETRYABLE_PROVIDER  WARNING   the pipeline will retry; if it keeps
 *                                 failing, age escalates it.
 *   QUOTA               HIGH      nothing will retry successfully until
 *                                 somebody raises a limit or pays for one.
 *   CONFIGURATION       HIGH      a human must change something.
 *   RETRY_EXHAUSTED     HIGH      the pipeline has already given up.
 *   UNKNOWN             HIGH      we cannot show it is benign.
 *   CRYPTOGRAPHIC       CRITICAL  the proof is unobtainable for this input,
 *                                 and on an evidence platform an unprovable
 *                                 record is the worst outcome there is.
 */
const BASE_SEVERITY: Record<IntegrityFailureClass, IncidentSeverity> = {
  RETRYABLE_PROVIDER: "WARNING",
  QUOTA: "HIGH",
  CONFIGURATION: "HIGH",
  RETRY_EXHAUSTED: "HIGH",
  UNKNOWN: "HIGH",
  CRYPTOGRAPHIC: "CRITICAL",
};

/**
 * PURE. The whole policy in one place, so "why is this CRITICAL?" has one
 * answer and a test can ask it without a database.
 */
export function deriveIntegritySeverity(
  input: IntegritySeverityInput,
): IncidentSeverity {
  let severity = BASE_SEVERITY[input.failureClass];

  // AGE. A transient failure that is still failing a week later was not
  // transient. This escalates and never de-escalates: an old problem does not
  // become less serious by being looked at.
  const ageMs = input.now.getTime() - input.firstSeenAtUtc.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays >= AGE_CRITICAL_DAYS) {
    severity = maxSeverity(severity, "CRITICAL");
  } else if (ageDays >= AGE_ESCALATION_DAYS) {
    severity = maxSeverity(severity, "HIGH");
  }

  // LEGAL POSTURE. Preservation obligations do not tolerate a missing proof.
  if (input.underLegalHold) {
    severity = maxSeverity(severity, "CRITICAL");
  }

  return severity;
}

/** Operator-readable one-liner explaining the class. Never provider text. */
export function describeFailureClass(
  failureClass: IntegrityFailureClass,
): string {
  switch (failureClass) {
    case "RETRYABLE_PROVIDER":
      return "the timestamping provider was unreachable or timed out";
    case "CONFIGURATION":
      return "the provider rejected our credentials or configuration";
    case "QUOTA":
      return "a quota, budget or rate limit was exhausted";
    case "CRYPTOGRAPHIC":
      return "the proof could not be produced or verified for this input";
    case "RETRY_EXHAUSTED":
      return "the pipeline exhausted its retries";
    case "UNKNOWN":
      return "the failure reason is not one we classify";
  }
}
