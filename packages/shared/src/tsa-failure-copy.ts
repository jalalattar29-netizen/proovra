/**
 * AUD-47 / AUD-48 (2026-10-20) — THE wording for a recorded trusted-timestamp
 * failure, keyed on its bounded failure CODE. A provider's raw response text
 * (tsa_failure_reason) is operator diagnostics: it may carry a provider URL,
 * an HTTP body or another language, and it is never shown on a product
 * surface. Every surface that states why a timestamp is missing reads this.
 */
const PROVIDER_DID_NOT_ISSUE = new Set([
  "tsa_provider_timeout",
  "tsa_provider_unreachable",
  "tsa_provider_http_error",
  "tsa_response_parse_failed",
  "tsa_response_not_granted",
  "tsa_token_missing",
  "tsa_unknown_error",
]);
const VALIDATION_NOT_PERFORMED = new Set(["tsa_trust_anchor_not_configured", "tsa_trust_anchor_refused"]);
const VALIDATION_FAILED = new Set([
  "tsa_token_untrusted",
  "tsa_token_signature_invalid",
  "tsa_nonce_mismatch",
  "tsa_message_imprint_mismatch",
  "tsa_policy_not_accepted",
]);

export const TSA_FAILURE_NOTES = Object.freeze({
  QUOTA: "The timestamp provider's quota was exhausted, so no trusted timestamp was obtained.",
  NOT_ISSUED: "The timestamp provider did not return a usable timestamp token.",
  NOT_VALIDATED: "A timestamp token was received but has not been validated against a trusted authority.",
  VALIDATION_FAILED: "A timestamp token was received but failed validation.",
  UNSPECIFIED: "A trusted timestamp could not be obtained.",
} as const);

/**
 * The note for a recorded failure, or null when nothing failed. `reasonRecorded`
 * says only whether a raw reason exists (a legacy row may carry a reason and no
 * code); its text is never read.
 */
export function tsaFailureNote(code: string | null | undefined, reasonRecorded = false): string | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return reasonRecorded ? TSA_FAILURE_NOTES.UNSPECIFIED : null;
  if (c === "tsa_provider_quota_exceeded") return TSA_FAILURE_NOTES.QUOTA;
  if (PROVIDER_DID_NOT_ISSUE.has(c) || c.startsWith("tsa_provider_")) return TSA_FAILURE_NOTES.NOT_ISSUED;
  if (VALIDATION_NOT_PERFORMED.has(c)) return TSA_FAILURE_NOTES.NOT_VALIDATED;
  if (VALIDATION_FAILED.has(c)) return TSA_FAILURE_NOTES.VALIDATION_FAILED;
  return TSA_FAILURE_NOTES.UNSPECIFIED;
}
