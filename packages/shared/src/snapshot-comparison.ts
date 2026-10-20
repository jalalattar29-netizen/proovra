/**
 * THE LEGACY SNAPSHOT NORMALIZER — FOR COMPARISONS ONLY (2026-10-18).
 *
 * An issued report or package is a snapshot of what was true when it was
 * issued, written in that release's words. Comparing it with the record now
 * must compare FACTS, never wording: copy improves between releases, and an
 * improvement in wording is not a change in the evidence.
 *
 * This module reads any stored signal — today's shape or a legacy one — into
 * its canonical comparable state, and states how a snapshot's anchoring stood
 * at issue. It is read-only and never a truth engine: the live state always
 * comes from the canonical decision (buildEvidenceTrustDecision) and the
 * matrix; a snapshot is only ever the "at issue" side of a comparison.
 *
 *   legacy passed                → VERIFIED (a historical claim of that artifact)
 *   legacy partial / degraded    → NOT_CHECKED
 *   legacy anchored / finalized  → ATTESTATION_RECORDED (never independently verified)
 *   missing otsState             → the snapshot's own Bitcoin signal, then its
 *                                  stored OTS status word, else UNAVAILABLE
 *
 * The per-signal rules are resolveSnapshotSignalState's (trust-signal-state);
 * this module adds the comparison and the issue-time anchoring.
 */
import {
  OTS_STATES,
  OTS_VERIFICATION_KEYS,
  type OtsState,
  type OtsVerificationKey,
} from "./ots-anchoring.js";
import {
  otsVerificationOfSignalState,
  resolveSnapshotSignalState,
  toVerificationStatus,
  type TrustSignalState,
  type VerificationStatus,
} from "./trust-signal-state.js";

export type ComparableSignal = {
  key: string;
  state: TrustSignalState;
  status: VerificationStatus;
  /** bitcoin_anchoring only. */
  otsVerification?: OtsVerificationKey;
};

type StoredSignalLike = {
  key?: string | null;
  state?: unknown;
  status?: string | null;
  summary?: string | null;
  otsVerification?: unknown;
};

/** A stored or live signal as its canonical comparable state (no words). */
export function comparableSignalOf(signal: StoredSignalLike | null | undefined): ComparableSignal | null {
  if (!signal || typeof signal !== "object") return null;
  const key = String(signal.key ?? "");
  const state = resolveSnapshotSignalState(signal);
  return {
    key,
    state,
    status: toVerificationStatus(state),
    ...(key === "bitcoin_anchoring" ? { otsVerification: otsVerificationOfSignalState(state, signal.otsVerification) } : {}),
  };
}

/** Progress of an OpenTimestamps verification: only a higher rank is an advance. */
const OTS_PROGRESS: Readonly<Record<OtsVerificationKey, number>> = {
  FAILED: 0,
  CHAIN_FAILED: 0,
  NOT_REQUESTED: 1,
  UNAVAILABLE: 1,
  PENDING: 2,
  ATTESTATION_RECORDED: 3,
  CHAIN_CONFIRMATIONS_PENDING: 3,
  CHAIN_UNAVAILABLE: 3,
  CHAIN_VERIFIED: 4,
};

/**
 * 2026-10-20 (AUD-11) — is `later` the same OTS verification as `stated`, or
 * FORWARD progress from it (attestation recorded -> chain verified)? A failure,
 * or a lower rank, is a regression and stays a contradiction. The one ranking
 * above decides, so issuance checks and the live "since issue" statements
 * cannot disagree about what counts as progress.
 */
export function otsVerificationProgressionCompatible(stated: OtsVerificationKey, later: OtsVerificationKey): boolean {
  if (stated === later) return true;
  if (later === "FAILED" || later === "CHAIN_FAILED") return false;
  return OTS_PROGRESS[later] >= OTS_PROGRESS[stated];
}

const STATUS_PROGRESS: Readonly<Record<VerificationStatus, number>> = {
  FAILED: 0,
  UNAVAILABLE: 1,
  NOT_APPLICABLE: 1,
  NOT_CHECKED: 2,
  VERIFIED: 3,
};

/**
 * How one signal moved between an issued snapshot and now:
 *   SAME       the same canonical state (wording differences are ignored)
 *   ADVANCED   a legitimate improvement (e.g. a kept token validated later,
 *              an attestation independently verified)
 *   REGRESSED  the signal FAILED now and did not then — the only alarm
 *   CHANGED    any other change of state
 */
export type SignalMovement = "SAME" | "ADVANCED" | "REGRESSED" | "CHANGED";

export function signalMovement(
  atIssue: StoredSignalLike | null | undefined,
  now: StoredSignalLike | null | undefined,
): SignalMovement {
  const before = comparableSignalOf(atIssue);
  const after = comparableSignalOf(now);
  if (!before && !after) return "SAME";
  if (!before || !after) return after?.status === "FAILED" ? "REGRESSED" : "CHANGED";
  if (after.status === "FAILED" && before.status !== "FAILED") return "REGRESSED";
  if (before.otsVerification && after.otsVerification) {
    const b = OTS_PROGRESS[before.otsVerification];
    const a = OTS_PROGRESS[after.otsVerification];
    return a === b ? "SAME" : a > b ? "ADVANCED" : "CHANGED";
  }
  if (before.state === after.state) return "SAME";
  const b = STATUS_PROGRESS[before.status];
  const a = STATUS_PROGRESS[after.status];
  if (a === b) return "SAME";
  return a > b ? "ADVANCED" : "CHANGED";
}

const OTS_STATE_OF_VERIFICATION: Readonly<Record<OtsVerificationKey, OtsState>> = {
  NOT_REQUESTED: "NOT_REQUESTED",
  PENDING: "PENDING",
  ATTESTATION_RECORDED: "ANCHORED",
  CHAIN_CONFIRMATIONS_PENDING: "ANCHORED",
  CHAIN_UNAVAILABLE: "ANCHORED",
  CHAIN_FAILED: "ANCHORED",
  CHAIN_VERIFIED: "ANCHORED",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
};

function verificationOfState(state: OtsState): OtsVerificationKey {
  switch (state) {
    case "ANCHORED":
      return "ATTESTATION_RECORDED";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "NOT_REQUESTED":
      return "NOT_REQUESTED";
    default:
      return "UNAVAILABLE";
  }
}

/** A pre-canonical stored OTS status word, read as a lifecycle state. */
function legacyOtsStatusWord(value: unknown): OtsState | null {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s === "ANCHORED" || s === "CONFIRMED" || s === "FINALIZED" || s === "UPGRADED" || s === "COMPLETE") return "ANCHORED";
  if (s === "PENDING" || s === "SUBMITTED" || s === "STAMPED") return "PENDING";
  if (s === "FAILED") return "FAILED";
  if (s === "NOT_REQUESTED" || s === "DISABLED") return "NOT_REQUESTED";
  return null;
}

export type SnapshotAnchoringAtIssue = {
  otsState: OtsState;
  otsVerification: OtsVerificationKey;
  /** Where the issue-time state was read from. */
  source: "SNAPSHOT_OTS_STATE" | "SNAPSHOT_BITCOIN_SIGNAL" | "SNAPSHOT_OTS_STATUS" | "NONE";
};

/**
 * How an issued artifact's anchoring stood AT ISSUE, from its own snapshot:
 * its recorded otsState (written by every worker since 2026-10-13); for an
 * older artifact, its own Bitcoin signal; then its stored OTS status word.
 * Never the record's current state.
 */
export function snapshotAnchoringAtIssue(
  anchorSnapshot: unknown,
  trustDecisionSnapshot: unknown,
): SnapshotAnchoringAtIssue {
  const anchor =
    anchorSnapshot && typeof anchorSnapshot === "object" && !Array.isArray(anchorSnapshot)
      ? (anchorSnapshot as Record<string, unknown>)
      : null;
  const recorded = anchor?.otsState;
  if (typeof recorded === "string" && (OTS_STATES as readonly string[]).includes(recorded)) {
    const state = recorded as OtsState;
    const claimed = anchor?.otsVerification;
    const verification =
      typeof claimed === "string" &&
      (OTS_VERIFICATION_KEYS as readonly string[]).includes(claimed) &&
      OTS_STATE_OF_VERIFICATION[claimed as OtsVerificationKey] === state
        ? (claimed as OtsVerificationKey)
        : verificationOfState(state);
    return { otsState: state, otsVerification: verification, source: "SNAPSHOT_OTS_STATE" };
  }
  const signals =
    trustDecisionSnapshot && typeof trustDecisionSnapshot === "object"
      ? (trustDecisionSnapshot as { signals?: unknown }).signals
      : null;
  const bitcoin = Array.isArray(signals)
    ? (signals as StoredSignalLike[]).find((s) => s && s.key === "bitcoin_anchoring")
    : undefined;
  const comparable = comparableSignalOf(bitcoin);
  if (comparable?.otsVerification) {
    return {
      otsState: OTS_STATE_OF_VERIFICATION[comparable.otsVerification],
      otsVerification: comparable.otsVerification,
      source: "SNAPSHOT_BITCOIN_SIGNAL",
    };
  }
  const word = legacyOtsStatusWord(anchor?.otsStatus);
  if (word) return { otsState: word, otsVerification: verificationOfState(word), source: "SNAPSHOT_OTS_STATUS" };
  return { otsState: "UNAVAILABLE", otsVerification: "UNAVAILABLE", source: "NONE" };
}

/**
 * Whether anchoring advanced after an artifact was issued — and how. NONE when
 * the artifact already stated the anchoring the record has now (an attestation
 * recorded before issue did not "advance" since).
 */
export type OtsAdvanceSinceIssue = "NONE" | "PENDING_SINCE_ISSUE" | "ATTESTATION_RECORDED_SINCE_ISSUE" | "CHAIN_VERIFIED_SINCE_ISSUE";

export function otsAdvanceSinceIssue(atIssue: OtsVerificationKey, now: OtsVerificationKey): OtsAdvanceSinceIssue {
  if (OTS_PROGRESS[now] <= OTS_PROGRESS[atIssue]) return "NONE";
  if (now === "CHAIN_VERIFIED") return "CHAIN_VERIFIED_SINCE_ISSUE";
  if (OTS_PROGRESS[now] === 3) return "ATTESTATION_RECORDED_SINCE_ISSUE";
  if (now === "PENDING") return "PENDING_SINCE_ISSUE";
  return "NONE";
}
