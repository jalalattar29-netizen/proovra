/**
 * THE CANONICAL TRUST-SIGNAL STATE (2026-10-07).
 *
 * One typed state for every verification layer, read by the API, the worker
 * (PDF report and verification package), Public Verify, the web app and the
 * native app. The older `TrustSignalStatus` (passed/partial/pending/missing/
 * failed) is kept as a PROJECTION of this state for stored snapshots and old
 * readers; it is never the source of a claim.
 *
 *   PASSED                              the layer was checked and the check
 *                                       succeeded (and only then)
 *   FAILED                              the check ran and the material is
 *                                       established to be invalid
 *   PENDING                             the process has not finished yet
 *   PRESENT_NOT_INDEPENDENTLY_VERIFIED  the material exists (a token, an
 *                                       attested proof, a signature) but no
 *                                       independent check of it succeeded
 *   NOT_CHECKED                         a check applies and was not run in the
 *                                       evaluation that produced this state
 *   STALE                               the last observation is too old to
 *                                       describe the present
 *   UNAVAILABLE                         the material or the checking service
 *                                       was not available
 *   NOT_APPLICABLE                      informational; this layer does not
 *                                       bear on the integrity assessment
 *
 * Only PASSED counts as a passed signal or may be shown as VERIFIED. Every
 * other state is either a degradation (named) or NOT_APPLICABLE (neither
 * passed nor degraded). No state carries points: PROOVRA reports what was
 * checked, never a confidence score.
 */
import { parseOtsVerificationKey, presentOtsAnchoring, resolveOtsAnchoring, type OtsAnchoring, type OtsAnchoringInput, type OtsState, type OtsVerificationKey } from "./ots-anchoring.js";

export const TRUST_SIGNAL_STATES = [
  "PASSED",
  "FAILED",
  "PENDING",
  "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
  "NOT_CHECKED",
  "STALE",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
] as const;
export type TrustSignalState = (typeof TRUST_SIGNAL_STATES)[number];

/** The stored/legacy status projection of a state. */
export type TrustSignalLegacyStatus =
  | "passed"
  | "partial"
  | "pending"
  | "missing"
  | "failed"
  | "not_applicable";

export type TrustSignalStatePresentation = {
  /** Short badge text shown next to a layer. */
  label: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  legacyStatus: TrustSignalLegacyStatus;
  /** Counted in "passed signals" and eligible for full points. */
  countsAsPassed: boolean;
  /** Counted in "degraded signals" (named in the reviewer reason). */
  countsAsDegraded: boolean;
};

export const TRUST_SIGNAL_STATE_PRESENTATION: Readonly<
  Record<TrustSignalState, TrustSignalStatePresentation>
> = {
  PASSED: { label: "Verified", tone: "success", legacyStatus: "passed", countsAsPassed: true, countsAsDegraded: false },
  FAILED: { label: "Failed", tone: "danger", legacyStatus: "failed", countsAsPassed: false, countsAsDegraded: true },
  PENDING: { label: "Pending", tone: "warning", legacyStatus: "pending", countsAsPassed: false, countsAsDegraded: true },
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: {
    label: "Present, not independently verified",
    tone: "info",
    legacyStatus: "partial",
    countsAsPassed: false,
    countsAsDegraded: true,
  },
  NOT_CHECKED: { label: "Not checked", tone: "neutral", legacyStatus: "partial", countsAsPassed: false, countsAsDegraded: true },
  STALE: { label: "Stale", tone: "warning", legacyStatus: "partial", countsAsPassed: false, countsAsDegraded: true },
  UNAVAILABLE: { label: "Unavailable", tone: "neutral", legacyStatus: "missing", countsAsPassed: false, countsAsDegraded: true },
  NOT_APPLICABLE: {
    label: "Informational",
    tone: "neutral",
    legacyStatus: "not_applicable",
    countsAsPassed: false,
    countsAsDegraded: false,
  },
};

/**
 * THE CUSTOMER-FACING VERIFICATION STATUS (2026-10-08). Every report, package,
 * Public Verify page and app surface states each signal in exactly one of
 * these five words, projected from the canonical state:
 *
 *   VERIFIED        the check ran and succeeded (PASSED, and only PASSED)
 *   FAILED          the check ran and the material is established invalid
 *   NOT_CHECKED     material may exist, but no independent check of it
 *                   succeeded (present-not-verified, not checked, pending,
 *                   stale)
 *   NOT_APPLICABLE  this check does not apply to the record or document
 *   UNAVAILABLE     the material or the checking service was not available
 */
export const VERIFICATION_STATUSES = ["VERIFIED", "FAILED", "NOT_CHECKED", "NOT_APPLICABLE", "UNAVAILABLE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_STATUS_BY_STATE: Readonly<Record<TrustSignalState, VerificationStatus>> = {
  PASSED: "VERIFIED",
  FAILED: "FAILED",
  PENDING: "NOT_CHECKED",
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: "NOT_CHECKED",
  NOT_CHECKED: "NOT_CHECKED",
  STALE: "NOT_CHECKED",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
};

export function toVerificationStatus(state: TrustSignalState): VerificationStatus {
  return VERIFICATION_STATUS_BY_STATE[state];
}

/**
 * QUALIFIERS (2026-10-18). A qualifier describes HOW a status came about; it
 * never changes the status. The status is projected from the state alone
 * (toVerificationStatus), so no qualifier can turn NOT_CHECKED into VERIFIED.
 *
 *   ATTESTATION_RECORDED          an OpenTimestamps proof names a Bitcoin block; not independently checked
 *   PENDING                       the check is waiting on an external step (calendar, confirmations)
 *   TOKEN_KEPT_NOT_VALIDATED      an RFC 3161 token was obtained and kept but not validated
 *   VALIDATED_FROM_RETAINED_TOKEN a VERIFIED timestamp validated later from the token kept at intake
 *   LEGACY_SEAL                   a package seal issued before seals were bound to a published key
 *   VERIFIER_UNAVAILABLE          the independent verifier could not run; nothing was concluded
 */
export const VERIFICATION_QUALIFIERS = [
  "ATTESTATION_RECORDED",
  "PENDING",
  "TOKEN_KEPT_NOT_VALIDATED",
  "VALIDATED_FROM_RETAINED_TOKEN",
  "LEGACY_SEAL",
  "VERIFIER_UNAVAILABLE",
] as const;
export type VerificationQualifier = (typeof VERIFICATION_QUALIFIERS)[number];

export const VERIFICATION_QUALIFIER_LABELS: Readonly<Record<VerificationQualifier, string>> = {
  ATTESTATION_RECORDED: "Attestation recorded",
  PENDING: "Pending",
  TOKEN_KEPT_NOT_VALIDATED: "Token kept, not validated",
  VALIDATED_FROM_RETAINED_TOKEN: "Validated from the token retained at intake",
  LEGACY_SEAL: "Legacy seal",
  VERIFIER_UNAVAILABLE: "Verifier unavailable",
};

export function parseVerificationQualifiers(value: unknown): VerificationQualifier[] {
  if (!Array.isArray(value)) return [];
  return value.filter((q): q is VerificationQualifier => (VERIFICATION_QUALIFIERS as readonly unknown[]).includes(q));
}

export function parseVerificationStatus(value: unknown): VerificationStatus | null {
  return typeof value === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(value)
    ? (value as VerificationStatus)
    : null;
}

export function parseTrustSignalState(value: unknown): TrustSignalState | null {
  return typeof value === "string" && (TRUST_SIGNAL_STATES as readonly string[]).includes(value)
    ? (value as TrustSignalState)
    : null;
}

export function trustSignalStateIsPassed(state: TrustSignalState): boolean {
  return TRUST_SIGNAL_STATE_PRESENTATION[state].countsAsPassed;
}

/**
 * The state of a signal read from a STORED snapshot. Snapshots written before
 * 2026-10-07 carry only the legacy status; their `passed` was awarded on
 * presence for some layers, so it is re-read conservatively:
 *   - an anchoring signal whose summary says the chain was not checked is
 *     PRESENT_NOT_INDEPENDENTLY_VERIFIED, never PASSED;
 *   - the informational package signal is NOT_APPLICABLE;
 *   - a legacy `passed` for any other layer is kept as PASSED only because it
 *     is a HISTORICAL claim of that issued artifact — readers that state
 *     current truth use a live decision, not the snapshot.
 */
export function resolveSnapshotSignalState(signal: {
  key?: string | null;
  state?: unknown;
  status?: string | null;
  summary?: string | null;
  otsVerification?: unknown;
}): TrustSignalState {
  const explicit = parseTrustSignalState(signal.state);
  // An anchoring PASSED is a chain verification ONLY when the snapshot says so.
  // Snapshots written before independent Bitcoin verification existed stored
  // PASSED for a proof that merely NAMED a block: that is an attestation
  // present but never independently verified.
  if (
    signal.key === "bitcoin_anchoring" &&
    explicit === "PASSED" &&
    parseOtsVerificationKey(signal.otsVerification) !== "CHAIN_VERIFIED"
  ) {
    return "PRESENT_NOT_INDEPENDENTLY_VERIFIED";
  }
  if (explicit) return explicit;
  const status = String(signal.status ?? "").toLowerCase();
  if (signal.key === "verification_package") {
    return status === "missing" ? "UNAVAILABLE" : "NOT_APPLICABLE";
  }
  // A legacy anchoring `passed` / `anchored` / `finalized` was awarded when the
  // record carried a Bitcoin attestation (2026-10-18): what that artifact stated
  // at issue is an attestation RECORDED — never independently verified, and
  // never "unavailable" (it was there). Only an explicit CHAIN_VERIFIED counts
  // as verified (above).
  if (signal.key === "bitcoin_anchoring" && (status === "passed" || status === "anchored" || status === "finalized")) {
    return "PRESENT_NOT_INDEPENDENTLY_VERIFIED";
  }
  // Likewise a legacy timestamp `passed` predates "only a validated token
  // passes" (a STAMPED token could pass unvalidated): it says only that a
  // token was recorded.
  if (signal.key === "trusted_timestamp" && status === "passed") {
    return "PRESENT_NOT_INDEPENDENTLY_VERIFIED";
  }
  switch (status) {
    case "passed":
      return "PASSED";
    case "failed":
      return "FAILED";
    case "pending":
      return "PENDING";
    // A historical "degraded" signal was recorded with limitations: present,
    // never passed and never "unavailable".
    case "degraded":
    case "partial":
      return "PRESENT_NOT_INDEPENDENTLY_VERIFIED";
    case "not_applicable":
      return "NOT_APPLICABLE";
    case "missing":
    default:
      return "UNAVAILABLE";
  }
}

// ---------------------------------------------------------------------------
// RFC 3161 — the one reading of a stored timestamp outcome as a trust state.
// ---------------------------------------------------------------------------

/**
 * What a VALIDATED timestamp establishes — and what it does not. Certificate
 * signature and chain validation is not EU qualified-service status: no
 * trusted-list evaluation is performed, so qualification is never claimed
 * (from a certificate subject or otherwise). Every surface that describes a
 * validated timestamp states this sentence.
 */
export const TSA_VALIDATED_QUALIFICATION_STATEMENT =
  "Timestamp token and certificate chain validated; qualified-service status was not independently evaluated.";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Validation could not be PERFORMED (no usable trust anchor in the issuing
 * environment): the token was obtained and kept, and nothing established it
 * to be invalid.
 */
const TSA_VALIDATION_NOT_PERFORMED_CODES = new Set([
  "tsa_trust_anchor_not_configured",
  "tsa_trust_anchor_refused",
]);

/** Validation ran and refused the token. */
/**
 * The bounded failure codes that mean a KEPT token was validated and the
 * validation FAILED. Exported (F-27, independent forward audit) so an operator
 * count of "timestamp validation failures" is the canonical FAILED state, not
 * every raw tsa_status = FAILED (most of which were never obtained).
 */
export const TSA_VALIDATION_FAILED_CODE_LIST = [
  "tsa_token_untrusted",
  "tsa_token_signature_invalid",
  "tsa_nonce_mismatch",
  "tsa_message_imprint_mismatch",
  "tsa_policy_not_accepted",
] as const;
const TSA_VALIDATION_FAILED_CODES: ReadonlySet<string> = new Set(TSA_VALIDATION_FAILED_CODE_LIST);

export type TsaTrustStateInput = {
  /** The PRESENTED status (`presentedTsaStatus`), not the raw column. */
  presentedStatus: string | null | undefined;
  tokenPresent?: boolean | null;
  failureCode?: string | null;
  validatedAtUtc?: Date | string | null;
};

export type TsaTrustState = {
  state: TrustSignalState;
  /** One sentence; never names an internal code. */
  label: string;
  measuredAtUtc: string | null;
};

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function resolveTsaTrustState(input: TsaTrustStateInput): TsaTrustState {
  const status = String(input.presentedStatus ?? "").trim().toUpperCase();
  const code = String(input.failureCode ?? "").trim().toLowerCase();
  // A validated token is a certificate-chain fact, never a qualification.
  if (status === "STAMPED") {
    return {
      state: "PASSED",
      label: "RFC 3161 timestamp validated",
      measuredAtUtc: isoOrNull(input.validatedAtUtc),
    };
  }
  if (status === "RECORDED_NOT_VALIDATED" || status === "GRANTED" || status === "VERIFIED" || status === "SUCCEEDED") {
    return { state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED", label: "Timestamp token recorded; not validated", measuredAtUtc: null };
  }
  if (status === "PENDING") {
    return { state: "PENDING", label: "Timestamp pending", measuredAtUtc: null };
  }
  if (status === "UNAVAILABLE") {
    return { state: "UNAVAILABLE", label: "Timestamp service unavailable", measuredAtUtc: null };
  }
  if (status === "FAILED") {
    if (input.tokenPresent && TSA_VALIDATION_FAILED_CODES.has(code)) {
      return { state: "FAILED", label: "Timestamp token obtained; validation failed", measuredAtUtc: null };
    }
    if (input.tokenPresent && TSA_VALIDATION_NOT_PERFORMED_CODES.has(code)) {
      return {
        state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
        label: "Timestamp token obtained; not validated (no trust anchor was available)",
        measuredAtUtc: null,
      };
    }
    // 2026-10-20 (AUD-16): a kept token whose failure cause was NOT recorded
    // (or is not one PROOVRA knows) is obtained and not validated — and no
    // cause is stated. Saying "no trust anchor was available" invented one,
    // and could stand in front of a token that failed for its digest.
    if (input.tokenPresent) {
      return { state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED", label: "Timestamp token obtained; not validated", measuredAtUtc: null };
    }
    return { state: "UNAVAILABLE", label: "Trusted timestamp not obtained", measuredAtUtc: null };
  }
  return { state: "UNAVAILABLE", label: "Timestamp not recorded", measuredAtUtc: null };
}

// ---------------------------------------------------------------------------
// OpenTimestamps — the one reading of the anchoring state as a trust state.
// ---------------------------------------------------------------------------

export type OtsTrustState = {
  state: TrustSignalState;
  otsState: OtsState;
  /** The derived presentation (CHAIN_VERIFIED is the only PASSED). */
  otsVerification: OtsVerificationKey;
  label: string;
  measuredAtUtc: string | null;
};

/**
 * The anchoring signal per verification key. An attestation the proof merely
 * NAMES is present but not independently verified; only a proof matched to a
 * confirmed block of the active Bitcoin main chain is PASSED.
 */
export const OTS_TRUST_BY_VERIFICATION: Readonly<Record<OtsVerificationKey, TrustSignalState>> = {
  NOT_REQUESTED: "NOT_APPLICABLE",
  PENDING: "PENDING",
  ATTESTATION_RECORDED: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
  CHAIN_CONFIRMATIONS_PENDING: "PENDING",
  // An unavailable verifier changes nothing about the attestation: still
  // recorded, still not independently checked (NOT_CHECKED + VERIFIER_UNAVAILABLE).
  CHAIN_UNAVAILABLE: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
  CHAIN_FAILED: "FAILED",
  CHAIN_VERIFIED: "PASSED",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
};

/**
 * The verification key a STORED anchoring signal states: its own marker when
 * that marker is coherent with the (conservatively re-read) state, otherwise
 * the reading of the state itself. A PASSED without a CHAIN_VERIFIED marker
 * never survives resolveSnapshotSignalState, so it cannot reach here.
 */
export function otsVerificationOfSignalState(state: TrustSignalState, marker: unknown): OtsVerificationKey {
  const claimed = parseOtsVerificationKey(marker);
  if (claimed && OTS_TRUST_BY_VERIFICATION[claimed] === state) return claimed;
  switch (state) {
    case "PASSED":
      return "CHAIN_VERIFIED";
    case "PRESENT_NOT_INDEPENDENTLY_VERIFIED":
      return "ATTESTATION_RECORDED";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "NOT_APPLICABLE":
      return "NOT_REQUESTED";
    default:
      return "UNAVAILABLE";
  }
}

/** The qualifiers an OpenTimestamps verification key carries (never a status). */
export function otsQualifiersOf(verification: OtsVerificationKey): VerificationQualifier[] {
  switch (verification) {
    case "ATTESTATION_RECORDED":
      return ["ATTESTATION_RECORDED"];
    case "CHAIN_CONFIRMATIONS_PENDING":
      return ["ATTESTATION_RECORDED", "PENDING"];
    case "CHAIN_UNAVAILABLE":
      return ["ATTESTATION_RECORDED", "VERIFIER_UNAVAILABLE"];
    case "PENDING":
      return ["PENDING"];
    default:
      return [];
  }
}

/** The canonical OTS state (resolveOtsAnchoring) as a trust state. */
export function resolveOtsTrustState(input: OtsAnchoringInput): OtsTrustState {
  return otsTrustStateOf(resolveOtsAnchoring(input));
}

/**
 * The trust state of an ALREADY RESOLVED anchoring — for a caller that holds
 * the resolution (the verification package resolves the proof it ships once,
 * and every document in it states that one result). A caller that passes no
 * `verification` is read conservatively: ANCHORED is an unchecked attestation.
 */
export function otsTrustStateOf(
  ots: Pick<OtsAnchoring, "state" | "anchoredAtUtc"> & Partial<Pick<OtsAnchoring, "verification" | "chain" | "bitcoinBlockHeight">>,
): OtsTrustState {
  const presentation = presentOtsAnchoring(ots);
  const verification = presentation.verification;
  const chainTime = ots.chain?.checkedAtUtc ?? null;
  return {
    state: OTS_TRUST_BY_VERIFICATION[verification],
    otsState: presentation.state,
    otsVerification: verification,
    label: presentation.sentence,
    measuredAtUtc: verification.startsWith("CHAIN_") ? chainTime : verification === "ATTESTATION_RECORDED" ? ots.anchoredAtUtc : null,
  };
}

/**
 * When the record's digest was first submitted for anchoring: the first
 * OTS_APPLIED custody event (immutable, hash-linked). One reading for the
 * worker (report/package) and the API (Public Verify).
 */
export function resolveOtsCustodyFacts(
  events: ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null }>,
): { submittedAtUtc: string | null } {
  for (const e of events) {
    if (e.eventType === "OTS_APPLIED") return { submittedAtUtc: isoOrNull(e.atUtc ?? null) };
  }
  return { submittedAtUtc: null };
}

/**
 * (2026-10-20, AUD-14/16) What a recorded TSA failure code says about the
 * token, for a surface that does not have the token itself: a validation code
 * means one was received (true), a provider code means none came back
 * (false), and an unknown or absent code says nothing (null) — never guessed.
 */
export function tsaFailureCodeImpliesToken(code: string | null | undefined): boolean | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  if (TSA_VALIDATION_FAILED_CODES.has(c) || TSA_VALIDATION_NOT_PERFORMED_CODES.has(c)) return true;
  if (/^tsa_provider_|^tsa_unknown_error$|^tsa_token_missing$/.test(c)) return false;
  return null;
}
