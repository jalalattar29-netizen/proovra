export type EffectiveOtsStatus =
  | "DISABLED"
  | "PENDING"
  | "ANCHORED"
  | "FAILED"
  | null;

export type OtsAnchorCompletenessInput = {
  status?: string | null;
  bitcoinTxid?: string | null;
  anchoredAtUtc?: Date | string | null;
};

export function normalizeOtsStatusValue(
  status: string | null | undefined
): EffectiveOtsStatus {
  const text = typeof status === "string" ? status.trim().toUpperCase() : "";

  switch (text) {
    case "DISABLED":
    case "PENDING":
    case "ANCHORED":
    case "FAILED":
      return text;
    default:
      return null;
  }
}

export function isValidOtsBitcoinTxid(
  value: string | null | undefined
): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

export function isCompleteOtsAnchor(
  input: OtsAnchorCompletenessInput
): boolean {
  return (
    normalizeOtsStatusValue(input.status) === "ANCHORED" &&
    Boolean(input.anchoredAtUtc)
  );
}

export function resolveEffectiveOtsStatus(
  input: OtsAnchorCompletenessInput
): EffectiveOtsStatus {
  const status = normalizeOtsStatusValue(input.status);
  if (status === "ANCHORED" && !isCompleteOtsAnchor(input)) {
    return "PENDING";
  }
  return status;
}

/**
 * HOW AN ANCHOR WAS ESTABLISHED (2026-09-29) — persisted as
 * `evidence.ots_anchor_check` when the upgrade processor proves an anchor.
 *
 *   BITCOIN_VERIFIED  `ots verify` confirmed the proof's Bitcoin block
 *                     attestation against the Bitcoin chain.
 *   PROOF_STRUCTURE   `ots info` showed, offline, that the proof commits to
 *                     THIS record's hash and carries a Bitcoin block-header
 *                     attestation. The attestation itself was NOT checked
 *                     against the chain.
 *   null              Not recorded (every row anchored before this column
 *                     existed). Nothing about the check is known.
 */
export type OtsAnchorCheck = "BITCOIN_VERIFIED" | "PROOF_STRUCTURE";

export function normalizeOtsAnchorCheck(value: string | null | undefined): OtsAnchorCheck | null {
  return value === "BITCOIN_VERIFIED" || value === "PROOF_STRUCTURE" ? value : null;
}

/**
 * THE ONE OTS CLAIM every surface may make — report, package manifest,
 * anchor.json, public Verify, web and mobile.
 *
 *   VERIFIED              anchored AND verified against Bitcoin
 *   ANCHORED_NOT_CHECKED  anchored by proof structure, or anchored before the
 *                         check was recorded — the chain was not checked
 *   PENDING               a proof exists and is awaiting a Bitcoin anchor
 *   FAILED                the proof is established to be unusable
 *   UNAVAILABLE           OTS disabled for this record
 *   NOT_CONFIGURED        no OTS state at all
 *
 * A status string, a txid, an anchored-at time or the mere presence of a proof
 * is never enough for VERIFIED.
 */
export type OtsAnchorClaim =
  | "VERIFIED"
  | "ANCHORED_NOT_CHECKED"
  | "PENDING"
  | "FAILED"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";

export function resolveOtsAnchorClaim(input: {
  status: string | null | undefined;
  anchoredAtUtc: Date | string | null | undefined;
  anchorCheck: string | null | undefined;
  proofPresent?: boolean | null;
}): OtsAnchorClaim {
  const effective = resolveEffectiveOtsStatus({
    status: input.status,
    anchoredAtUtc: input.anchoredAtUtc,
  });
  if (effective === "ANCHORED") {
    return normalizeOtsAnchorCheck(input.anchorCheck) === "BITCOIN_VERIFIED"
      ? "VERIFIED"
      : "ANCHORED_NOT_CHECKED";
  }
  if (effective === "PENDING") return "PENDING";
  if (effective === "FAILED") return "FAILED";
  if (input.proofPresent) return "PENDING";
  if (effective === "DISABLED") return "UNAVAILABLE";
  return "NOT_CONFIGURED";
}

/** True only for an anchor verified against Bitcoin. */
export function isPublicAnchoringVerified(input: Parameters<typeof resolveOtsAnchorClaim>[0]): boolean {
  return resolveOtsAnchorClaim(input) === "VERIFIED";
}

export const OTS_ANCHOR_CLAIM_LABELS: Readonly<Record<OtsAnchorClaim, string>> = {
  VERIFIED: "OpenTimestamps Bitcoin anchoring verified",
  ANCHORED_NOT_CHECKED:
    "OpenTimestamps proof anchored to a Bitcoin block; not checked against the Bitcoin chain",
  PENDING: "OpenTimestamps proof present; Bitcoin anchoring pending",
  FAILED: "OpenTimestamps anchoring failed",
  UNAVAILABLE: "OpenTimestamps unavailable",
  NOT_CONFIGURED: "OpenTimestamps not configured",
};
