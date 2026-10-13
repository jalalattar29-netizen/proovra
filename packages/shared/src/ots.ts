/**
 * OpenTimestamps STORAGE vocabulary (2026-10-13).
 *
 * These read what is persisted on the evidence row. They decide nothing a
 * customer sees: the anchoring STATE is resolved from the stored proof bytes
 * by `resolveOtsAnchoring` (ots-anchoring.ts), the one authority.
 */

/** evidence.ots_status as stored. */
export type OtsStoredStatus = "DISABLED" | "PENDING" | "ANCHORED" | "FAILED" | null;

export function normalizeOtsStatusValue(status: string | null | undefined): OtsStoredStatus {
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

/** A well-formed Bitcoin transaction id (64 hex). Format only — never a claim. */
export function isValidOtsBitcoinTxid(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

/**
 * OTS PROOF FAILURES NO RE-RUN CAN REPAIR (ET-REC-06). The stored proof does
 * not commit to this record's digest, cannot be parsed, or attests nothing a
 * valid proof path produces. The worker ends such a job without a change, so
 * Operations must not offer "Resume OTS anchoring" for it. One list for the
 * worker, the executor and the remediation registry.
 */
export const OTS_PERMANENT_PROOF_FAILURES = [
  "PROOF_HASH_MISMATCH",
  "MALFORMED_PROOF",
  "UNSUPPORTED_PROOF_OPERATION",
  "INVALID_ATTESTATION",
] as const;
export type OtsPermanentProofFailure = (typeof OTS_PERMANENT_PROOF_FAILURES)[number];

export function isPermanentOtsProofFailureReason(reason: string | null | undefined): boolean {
  return (OTS_PERMANENT_PROOF_FAILURES as readonly string[]).includes(String(reason ?? ""));
}

/**
 * ET-OTS-04 — the ONLY OTS failure value any surface outside the worker shows.
 * Rows written before the worker wrote bounded codes keep their raw text, so
 * every reader projects through this.
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

/**
 * The Worker's budget-exhausted bridge fingerprint, `OTS:<evidenceId>:GLOBAL_BUDGET_EXHAUSTED`
 * (ET-REC-02). Returns the evidence id, or null for any other shape.
 */
export function parseOtsBudgetExhaustedFingerprint(fingerprint: string): string | null {
  const m = /^OTS:([A-Za-z0-9-]{8,64}):GLOBAL_BUDGET_EXHAUSTED$/.exec(fingerprint);
  return m ? m[1]! : null;
}
