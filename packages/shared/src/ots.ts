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
 * is never enough for VERIFIED. Neither is a recorded BITCOIN_VERIFIED check on
 * its own (2026-10-12): VERIFIED also requires the recorded chain evidence
 * (`chain`), so a caller that does not hold it can never overstate.
 */
/**
 * THE RECORDED EVIDENCE OF AN INDEPENDENT BITCOIN CHAIN CHECK (2026-10-12),
 * persisted as evidence.ots_chain_*. A check that verified is claimable only
 * with every field present: the verifier, when it verified, and the block it
 * verified against (height, hash, time) with its confirmation count.
 */
export type OtsChainEvidenceInput = {
  chainVerificationStatus?: string | null;
  chainVerifiedAtUtc?: Date | string | null;
  chainBlockHeight?: number | string | null;
  chainBlockHash?: string | null;
  chainBlockTimeUtc?: Date | string | null;
  chainConfirmations?: number | string | null;
  chainVerifier?: string | null;
};

const CHAIN_HASH = /^[0-9a-f]{64}$/i;
const validDate = (v: Date | string | null | undefined) =>
  v != null && Number.isFinite((v instanceof Date ? v : new Date(v)).getTime());
const nonNegativeInt = (v: unknown) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

/** True only when a VERIFIED chain check is recorded with all of its evidence. */
export function isCompleteOtsChainEvidence(input: OtsChainEvidenceInput | null | undefined): boolean {
  if (!input || input.chainVerificationStatus !== "VERIFIED") return false;
  const confirmations = nonNegativeInt(input.chainConfirmations);
  return (
    validDate(input.chainVerifiedAtUtc) &&
    nonNegativeInt(input.chainBlockHeight) !== null &&
    typeof input.chainBlockHash === "string" &&
    CHAIN_HASH.test(input.chainBlockHash) &&
    validDate(input.chainBlockTimeUtc) &&
    confirmations !== null &&
    confirmations > 0 &&
    typeof input.chainVerifier === "string" &&
    input.chainVerifier.trim().length > 0
  );
}

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
  /**
   * (2026-09-29) The record's Bitcoin txid, when the caller holds it. A
   * positive, chain-checked claim keeps its txid precondition: with the key
   * present and no valid txid, a BITCOIN_VERIFIED anchor reads
   * ANCHORED_NOT_CHECKED. Never promotes anything.
   */
  bitcoinTxid?: string | null;
  /** evidence.ots_chain_* — required for VERIFIED; absent reads as unverified. */
  chain?: OtsChainEvidenceInput | null;
}): OtsAnchorClaim {
  const effective = resolveEffectiveOtsStatus({
    status: input.status,
    anchoredAtUtc: input.anchoredAtUtc,
  });
  if (effective === "ANCHORED") {
    const chainChecked = normalizeOtsAnchorCheck(input.anchorCheck) === "BITCOIN_VERIFIED";
    const txidRequiredButMissing =
      "bitcoinTxid" in input && !isValidOtsBitcoinTxid(input.bitcoinTxid ?? null);
    return chainChecked && !txidRequiredButMissing && isCompleteOtsChainEvidence(input.chain)
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

/** A claim a server sent, or null when it is not one of the six. */
export function parseOtsAnchorClaim(value: unknown): OtsAnchorClaim | null {
  return value === "VERIFIED" ||
    value === "ANCHORED_NOT_CHECKED" ||
    value === "PENDING" ||
    value === "FAILED" ||
    value === "UNAVAILABLE" ||
    value === "NOT_CONFIGURED"
    ? value
    : null;
}

/**
 * THE OTS BADGE (2026-09-29) — tone and label from the ONE claim, for the web
 * and native verify pages.
 *
 * The badges were keyed on a valid txid: green "ANCHORED" beside a sentence
 * saying the chain was not checked, and "ANCHORING PENDING" for an anchor
 * recorded without a txid. Green is now reserved for an anchor verified
 * against the Bitcoin chain; a recorded anchor whose chain was not checked is
 * informational, never a success and never "pending".
 */
export function otsClaimBadge(claim: OtsAnchorClaim): {
  label: string;
  tone: "success" | "warning" | "neutral" | "info";
} {
  switch (claim) {
    case "VERIFIED":
      return { label: "VERIFIED", tone: "success" };
    case "ANCHORED_NOT_CHECKED":
      return { label: "ATTESTATION RECORDED", tone: "info" };
    case "PENDING":
      return { label: "PENDING", tone: "warning" };
    case "FAILED":
      return { label: "UNAVAILABLE", tone: "warning" };
    case "UNAVAILABLE":
      return { label: "UNAVAILABLE", tone: "neutral" };
    case "NOT_CONFIGURED":
      return { label: "Unavailable", tone: "neutral" };
  }
}

/** The customer-facing status word for a claim (see ots-truth OTS_PUBLIC_STATUSES). */
export const OTS_ANCHOR_CLAIM_LABELS: Readonly<Record<OtsAnchorClaim, string>> = {
  VERIFIED: "Verified",
  ANCHORED_NOT_CHECKED: "Attestation recorded",
  PENDING: "Pending",
  FAILED: "Unavailable",
  UNAVAILABLE: "Unavailable",
  NOT_CONFIGURED: "Unavailable",
};

/**
 * OTS PROOF FAILURES NO RE-RUN CAN REPAIR (ET-REC-06, 2026-09-29).
 *
 * The recorded proof does not commit to this record's digest, or cannot be
 * parsed. The worker ends such a job as `proof_invalid_terminal` without a
 * change, so Operations must not offer "Resume OTS anchoring" for it or answer
 * QUEUED. One list for the worker, the executor and the remediation registry.
 */
export const OTS_PERMANENT_PROOF_FAILURES = ["PROOF_HASH_MISMATCH", "MALFORMED_PROOF"] as const;
export type OtsPermanentProofFailure = (typeof OTS_PERMANENT_PROOF_FAILURES)[number];

export function isPermanentOtsProofFailureReason(reason: string | null | undefined): boolean {
  return (OTS_PERMANENT_PROOF_FAILURES as readonly string[]).includes(String(reason ?? ""));
}

/**
 * ET-OTS-04 — the ONLY OTS failure value any surface outside the worker shows.
 *
 * A stamp-call failure used to be persisted as the raw error text
 * ("Command failed: ots stamp -c <calendar> /tmp/ots-…/fingerprint-<id>.json …")
 * and served on public Verify, the custody timeline and the report. The worker
 * now writes only the bounded proof codes; rows written before keep their raw
 * text, so every reader projects through this.
 */
export const OTS_FAILURE_CODES = [
  ...OTS_PERMANENT_PROOF_FAILURES,
  // Written by the upgrade ladder when the global retry budget runs out.
  "OTS_GLOBAL_BUDGET_EXHAUSTED",
  "OTS_PROCESSING_FAILED",
] as const;
export type OtsFailureCode = (typeof OTS_FAILURE_CODES)[number];

export function boundedOtsFailureCode(raw: string | null | undefined): OtsFailureCode | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return (OTS_FAILURE_CODES as readonly string[]).includes(value) ? (value as OtsFailureCode) : "OTS_PROCESSING_FAILED";
}

export const OTS_FAILURE_CODE_LABELS: Readonly<Record<OtsFailureCode, string>> = {
  PROOF_HASH_MISMATCH: "The timestamp proof does not commit to this record's fingerprint.",
  MALFORMED_PROOF: "The timestamp proof could not be read.",
  OTS_GLOBAL_BUDGET_EXHAUSTED: "The proof did not anchor on the public chain within the retry budget.",
  OTS_PROCESSING_FAILED: "OpenTimestamps processing did not complete for this record.",
};

/**
 * The Worker's budget-exhausted bridge fingerprint, `OTS:<evidenceId>:GLOBAL_BUDGET_EXHAUSTED`
 * (ET-REC-02). Returns the evidence id, or null for any other shape.
 */
export function parseOtsBudgetExhaustedFingerprint(fingerprint: string): string | null {
  const m = /^OTS:([A-Za-z0-9-]{8,64}):GLOBAL_BUDGET_EXHAUSTED$/.exec(fingerprint);
  return m ? m[1]! : null;
}
