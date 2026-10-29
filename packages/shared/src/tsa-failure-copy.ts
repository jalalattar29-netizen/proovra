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

export type TsaFailureCategory = keyof typeof TSA_FAILURE_NOTES;

/**
 * The bounded CATEGORY of a recorded failure code — what operations logs group
 * by (never the provider's text). Null when nothing failed.
 */
export function tsaFailureCategory(code: string | null | undefined, reasonRecorded = false): TsaFailureCategory | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return reasonRecorded ? "UNSPECIFIED" : null;
  if (c === "tsa_provider_quota_exceeded") return "QUOTA";
  if (PROVIDER_DID_NOT_ISSUE.has(c) || c.startsWith("tsa_provider_")) return "NOT_ISSUED";
  if (VALIDATION_NOT_PERFORMED.has(c)) return "NOT_VALIDATED";
  if (VALIDATION_FAILED.has(c)) return "VALIDATION_FAILED";
  return "UNSPECIFIED";
}

/**
 * The note for a recorded failure, or null when nothing failed. `reasonRecorded`
 * says only whether a raw reason exists (a legacy row may carry a reason and no
 * code); its text is never read.
 */
export function tsaFailureNote(code: string | null | undefined, reasonRecorded = false): string | null {
  const category = tsaFailureCategory(code, reasonRecorded);
  return category ? TSA_FAILURE_NOTES[category] : null;
}

/**
 * What stays true of a record whose trusted timestamp was not obtained, and
 * what the platform does about it — said wherever the missing timestamp is
 * (inbox, completion notice, runbook). There is no retry: a token issued now
 * would certify a later moment than the sealing (tsa-no-retry gate).
 */
export const TSA_NOT_OBTAINED_SUPPORT_STATEMENT =
  "The record remains sealed and signed, and OpenTimestamps anchoring proceeds independently. A trusted timestamp cannot be issued later for the sealing moment.";
