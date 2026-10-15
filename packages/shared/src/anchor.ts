import {
  OTS_VERIFICATION_LABELS,
  otsVerificationKeyOfState,
  parseOtsVerificationKey,
  type OtsState,
  type OtsVerificationKey,
} from "./ots-anchoring.js";

/**
 * THE ANCHOR SUMMARY — the anchor.json / manifest projection of the ONE
 * OpenTimestamps state and its verification (`resolveOtsAnchoring`). It
 * derives nothing itself: a transaction id, an anchored-at time or a status
 * string never decides whether a record is anchored or verified.
 */
export type AnchorSemanticsInput = {
  transactionId?: string | null;
  /** The canonical state (ots-anchoring.ts). */
  otsState: OtsState;
  /** The canonical verification; omitted = the conservative reading of the state. */
  otsVerification?: OtsVerificationKey | null;
};

export type AnchorMode =
  | "chain_verified"
  | "attestation_recorded"
  | "chain_verification_pending"
  | "chain_verification_unavailable"
  | "chain_verification_failed"
  | "bitcoin_anchoring_pending"
  | "failed"
  | "unavailable"
  | "not_configured";

export type AnchorSemantics = {
  transactionId: string | null;
  hasTransactionId: boolean;
  otsState: OtsState;
  otsVerification: OtsVerificationKey;
  anchoringLabel: string;
  anchorMode: AnchorMode;
};

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const MODE: Readonly<Record<OtsVerificationKey, AnchorMode>> = {
  CHAIN_VERIFIED: "chain_verified",
  ATTESTATION_RECORDED: "attestation_recorded",
  CHAIN_CONFIRMATIONS_PENDING: "chain_verification_pending",
  CHAIN_UNAVAILABLE: "chain_verification_unavailable",
  CHAIN_FAILED: "chain_verification_failed",
  PENDING: "bitcoin_anchoring_pending",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
  NOT_REQUESTED: "not_configured",
};

export function deriveAnchorSemantics(input: AnchorSemanticsInput): AnchorSemantics {
  const transactionId = normalizeString(input.transactionId);
  const claimed = parseOtsVerificationKey(input.otsVerification);
  const verification =
    input.otsState === "ANCHORED" && claimed && (claimed === "ATTESTATION_RECORDED" || claimed.startsWith("CHAIN_"))
      ? claimed
      : otsVerificationKeyOfState(input.otsState);
  return {
    transactionId,
    hasTransactionId: Boolean(transactionId),
    otsState: input.otsState,
    otsVerification: verification,
    anchoringLabel: OTS_VERIFICATION_LABELS[verification],
    anchorMode: MODE[verification],
  };
}
