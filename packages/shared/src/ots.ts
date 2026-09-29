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
  /**
   * (2026-09-29) The record's Bitcoin txid, when the caller holds it. A
   * positive, chain-checked claim keeps its txid precondition: with the key
   * present and no valid txid, a BITCOIN_VERIFIED anchor reads
   * ANCHORED_NOT_CHECKED. Never promotes anything.
   */
  bitcoinTxid?: string | null;
}): OtsAnchorClaim {
  const effective = resolveEffectiveOtsStatus({
    status: input.status,
    anchoredAtUtc: input.anchoredAtUtc,
  });
  if (effective === "ANCHORED") {
    const chainChecked = normalizeOtsAnchorCheck(input.anchorCheck) === "BITCOIN_VERIFIED";
    const txidRequiredButMissing =
      "bitcoinTxid" in input && !isValidOtsBitcoinTxid(input.bitcoinTxid ?? null);
    return chainChecked && !txidRequiredButMissing ? "VERIFIED" : "ANCHORED_NOT_CHECKED";
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
      return { label: "ANCHORED · VERIFIED", tone: "success" };
    case "ANCHORED_NOT_CHECKED":
      return { label: "ANCHORED · CHAIN NOT CHECKED", tone: "info" };
    case "PENDING":
      return { label: "PENDING", tone: "warning" };
    case "FAILED":
      return { label: "FAILED", tone: "warning" };
    case "UNAVAILABLE":
      return { label: "DISABLED", tone: "neutral" };
    case "NOT_CONFIGURED":
      return { label: "Unavailable", tone: "neutral" };
  }
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
 * The Worker's budget-exhausted bridge fingerprint, `OTS:<evidenceId>:GLOBAL_BUDGET_EXHAUSTED`
 * (ET-REC-02). Returns the evidence id, or null for any other shape.
 */
export function parseOtsBudgetExhaustedFingerprint(fingerprint: string): string | null {
  const m = /^OTS:([A-Za-z0-9-]{8,64}):GLOBAL_BUDGET_EXHAUSTED$/.exec(fingerprint);
  return m ? m[1]! : null;
}
