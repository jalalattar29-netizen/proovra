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
import { resolveOtsProofStatus, type OtsProofStatus, type OtsProofStatusInput } from "./ots-status.js";

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
}): TrustSignalState {
  const explicit = parseTrustSignalState(signal.state);
  if (explicit) return explicit;
  const status = String(signal.status ?? "").toLowerCase();
  if (signal.key === "verification_package") {
    return status === "missing" ? "UNAVAILABLE" : "NOT_APPLICABLE";
  }
  // A legacy anchoring `passed` predates any recorded chain check: it was
  // awarded for a proof's presence. Only an explicit PASSED state (written
  // from a recorded BITCOIN_VERIFIED check) may ever read as verified.
  if (signal.key === "bitcoin_anchoring" && status === "passed") {
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
const TSA_VALIDATION_FAILED_CODES = new Set([
  "tsa_token_untrusted",
  "tsa_token_signature_invalid",
  "tsa_nonce_mismatch",
  "tsa_message_imprint_mismatch",
  "tsa_policy_not_accepted",
]);

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
    if (input.tokenPresent && (TSA_VALIDATION_NOT_PERFORMED_CODES.has(code) || !code)) {
      return {
        state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
        label: "Timestamp token obtained; not validated (no trust anchor was available)",
        measuredAtUtc: null,
      };
    }
    return { state: "UNAVAILABLE", label: "Trusted timestamp not obtained", measuredAtUtc: null };
  }
  return { state: "UNAVAILABLE", label: "Timestamp not recorded", measuredAtUtc: null };
}

// ---------------------------------------------------------------------------
// OpenTimestamps — the one reading of an anchor as a trust state.
// ---------------------------------------------------------------------------

export type OtsTrustStateInput = OtsProofStatusInput & {
  /**
   * When the canonical verifier last recorded its check (the `observedAtUtc`
   * of the OTS_APPLIED custody event that wrote the check). Null when not
   * recorded; a chain verification is then stated without a time.
   */
  anchorCheckedAtUtc?: Date | string | null;
};

export type OtsTrustState = {
  state: TrustSignalState;
  proofStatus: OtsProofStatus;
  label: string;
  measuredAtUtc: string | null;
};

/**
 * An attested proof is NOT a verified anchor. Only a recorded
 * BITCOIN_VERIFIED check (the canonical `ots verify` against the chain) is
 * PASSED; a proof read by structure alone is PRESENT_NOT_INDEPENDENTLY_VERIFIED.
 */
export function resolveOtsTrustState(input: OtsTrustStateInput): OtsTrustState {
  const proofStatus = resolveOtsProofStatus(input);
  switch (proofStatus) {
    case "VERIFIED":
      return {
        state: "PASSED",
        proofStatus,
        label: "Anchored in Bitcoin; verified against the Bitcoin chain",
        measuredAtUtc: isoOrNull(input.anchorCheckedAtUtc),
      };
    case "ANCHORED_UNVERIFIED":
      return {
        state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
        proofStatus,
        label: "Anchoring proof present; not independently chain-verified",
        measuredAtUtc: isoOrNull(input.anchorCheckedAtUtc),
      };
    case "SUBMITTED":
    case "PENDING":
      return { state: "PENDING", proofStatus, label: "Bitcoin anchoring pending", measuredAtUtc: null };
    case "STALE_UNKNOWN":
      return {
        state: "STALE",
        proofStatus,
        label: "Anchoring state unknown (pending longer than expected)",
        measuredAtUtc: null,
      };
    case "FAILED":
      return { state: "FAILED", proofStatus, label: "Anchoring failed", measuredAtUtc: null };
    case "NOT_REQUESTED":
    default:
      return { state: "UNAVAILABLE", proofStatus, label: "Anchoring not recorded", measuredAtUtc: null };
  }
}

/**
 * The OTS facts that live in the custody chain (immutable, hash-linked):
 *   - submittedAtUtc: the first OTS_APPLIED event (the proof was requested);
 *   - anchorCheckedAtUtc: the latest OTS_APPLIED event that recorded the
 *     check now on the record (its `observedAtUtc`, else the event time).
 * One reading for the worker (report/package) and the API (Public Verify).
 */
export function resolveOtsCustodyFacts(
  events: ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null; payload?: unknown }>,
  currentAnchorCheck: string | null | undefined,
): { submittedAtUtc: string | null; anchorCheckedAtUtc: string | null } {
  let submittedAtUtc: string | null = null;
  let anchorCheckedAtUtc: string | null = null;
  for (const e of events) {
    if (e.eventType !== "OTS_APPLIED") continue;
    const at = isoOrNull(e.atUtc ?? null);
    if (!submittedAtUtc) submittedAtUtc = at;
    const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
    if (currentAnchorCheck && p.anchorCheck === currentAnchorCheck) {
      anchorCheckedAtUtc = isoOrNull(typeof p.observedAtUtc === "string" ? p.observedAtUtc : null) ?? at;
    }
  }
  return { submittedAtUtc, anchorCheckedAtUtc };
}
