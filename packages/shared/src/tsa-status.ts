/**
 * THE CANONICAL RFC 3161 PROOF STATUS (UC-TRUST-002, 2026-10-01), built on
 * `presentedTsaStatus`:
 *   NOT_REQUESTED, PENDING, VALIDATED, RECORDED_NOT_VALIDATED, NOT_OBTAINED, FAILED
 *
 * Only VALIDATED may be shown as an applied/trusted timestamp. A legacy token
 * kept without validation is "Recorded, not validated" — never "Applied".
 * (The OpenTimestamps state lives in ots-anchoring.ts.)
 *
 * ONE AUTHORITY (2026-10-20, AUD-14): the status is the reading of
 * `resolveTsaTrustState` — the matrix's authority — so every surface (owner
 * web, mobile, provenance chain, package provenance, basic verification,
 * custody lines, technical rows) states the same thing. A stored FAILED is
 * three different facts and is never one "Timestamp failed":
 *   a kept token validation refused         FAILED        "Validation failed"
 *   a kept token never validated            RECORDED_NOT_VALIDATED
 *   no token (provider outage, refusal)     NOT_OBTAINED  "Not obtained"
 * Whether a token was kept is therefore a REQUIRED input.
 */
import { presentedTsaStatus } from "./tsa-validation-state.js";
import { resolveTsaTrustState } from "./trust-signal-state.js";
import type { ComponentVerificationState } from "./basic-verification.js";

export const TSA_PROOF_STATUSES = [
  "NOT_REQUESTED",
  "PENDING",
  "VALIDATED",
  "RECORDED_NOT_VALIDATED",
  "NOT_OBTAINED",
  "FAILED",
] as const;
export type TsaProofStatus = (typeof TSA_PROOF_STATUSES)[number];

/** The token's presence: the stored token itself, or a boolean the caller derived from it. */
export type TsaTokenPresence = { tsaTokenPresent: boolean | null } | { tsaTokenBase64: string | null | undefined };

export type TsaProofStatusInput = {
  tsaStatus: string | null | undefined;
  tsaValidatedAtUtc?: Date | string | null | undefined;
  tsaFailureCode?: string | null | undefined;
} & TsaTokenPresence;

function tokenPresentOf(row: TsaProofStatusInput): boolean | null {
  if ("tsaTokenPresent" in row) return row.tsaTokenPresent;
  return typeof row.tsaTokenBase64 === "string" ? row.tsaTokenBase64.length > 0 : false;
}

export function resolveTsaProofStatus(row: TsaProofStatusInput): TsaProofStatus {
  const presented = String(presentedTsaStatus(row) ?? "").trim().toUpperCase();
  if (!presented) return "NOT_REQUESTED";
  const trust = resolveTsaTrustState({
    presentedStatus: presented,
    tokenPresent: tokenPresentOf(row),
    failureCode: row.tsaFailureCode ?? null,
    validatedAtUtc: row.tsaValidatedAtUtc ?? null,
  });
  switch (trust.state) {
    case "PASSED":
      return "VALIDATED";
    case "PRESENT_NOT_INDEPENDENTLY_VERIFIED":
      return "RECORDED_NOT_VALIDATED";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    default:
      // UNAVAILABLE: requested and not obtained (or not recorded at all).
      return presented === "FAILED" || presented === "UNAVAILABLE" ? "NOT_OBTAINED" : "NOT_REQUESTED";
  }
}

/** Only a validated token may be presented as an applied trusted timestamp. */
export function tsaProofStatusIsValidated(status: TsaProofStatus): boolean {
  return status === "VALIDATED";
}

export const TSA_PROOF_STATUS_LABELS: Readonly<Record<TsaProofStatus, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Pending",
  VALIDATED: "RFC 3161 timestamp validated",
  RECORDED_NOT_VALIDATED: "Recorded, not validated",
  NOT_OBTAINED: "Not obtained",
  FAILED: "Validation failed",
};

/** The one tone per status (never amber "pending" for a token that is simply not validated). */
export const TSA_PROOF_STATUS_TONE: Readonly<Record<TsaProofStatus, "success" | "neutral" | "warning" | "danger">> = {
  NOT_REQUESTED: "neutral",
  PENDING: "warning",
  VALIDATED: "success",
  RECORDED_NOT_VALIDATED: "neutral",
  NOT_OBTAINED: "neutral",
  FAILED: "danger",
};

/**
 * The component state a verification surface draws. Only a validated token
 * whose message imprint was compared and matched is "verified"; an imprint
 * that does not match is "failed" whatever the token says.
 */
export function tsaProofComponentState(status: TsaProofStatus, imprintMatches?: boolean | null): ComponentVerificationState {
  if (imprintMatches === false && (status === "VALIDATED" || status === "RECORDED_NOT_VALIDATED")) return "failed";
  switch (status) {
    case "VALIDATED":
      return imprintMatches === true ? "verified" : "not_checked";
    case "RECORDED_NOT_VALIDATED":
      return "not_checked";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    default:
      return "not_issued";
  }
}

/**
 * AUD-17 — what a token's own generation time and serial ARE: facts of a
 * validated token, or claims of a token nobody validated. A surface prints
 * them as plain facts only for VALIDATED; otherwise with this qualifier, or
 * not at all.
 */
export function tsaTokenClaimsBasis(status: TsaProofStatus): "VALIDATED_TOKEN" | "CLAIMED_BY_UNVALIDATED_TOKEN" | null {
  if (status === "VALIDATED") return "VALIDATED_TOKEN";
  if (status === "RECORDED_NOT_VALIDATED" || status === "FAILED") return "CLAIMED_BY_UNVALIDATED_TOKEN";
  return null;
}
export const TSA_UNVALIDATED_CLAIM_QUALIFIER = "claimed by the token; not validated";

export function parseTsaProofStatus(value: unknown): TsaProofStatus | null {
  return typeof value === "string" && (TSA_PROOF_STATUSES as readonly string[]).includes(value)
    ? (value as TsaProofStatus)
    : null;
}

/**
 * AUD-15 (2026-10-20) — A TSA CUSTODY EVENT, READ BY THE ONE AUTHORITY. The
 * report's custody lines said "Timestamp: validated" / "Token validated" for
 * ANY event whose payload said STAMPED — including legacy events written
 * before validation existed. The event's own validation fact
 * (tsaValidatedAtUtc), failure code and token facts decide, exactly as for the
 * record. A token is present when the event recorded its serial, imprint or
 * generation time.
 */
export function tsaProofStatusOfCustodyPayload(
  payload: Record<string, unknown> | null | undefined,
  eventType: string,
): TsaProofStatus {
  const p = payload ?? {};
  const str = (k: string): string | null => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  const status = str("tsaStatus") ?? (eventType === "TIMESTAMP_FAILED" ? "FAILED" : null);
  return resolveTsaProofStatus({
    tsaStatus: status,
    tsaValidatedAtUtc: str("tsaValidatedAtUtc"),
    tsaTokenPresent: Boolean(str("tsaSerialNumber") || str("tsaMessageImprint") || str("tsaGenTimeUtc")),
    tsaFailureCode: str("tsaFailureCode"),
  });
}

/** The one headline a TSA custody line states for each status. */
export const TSA_CUSTODY_EVENT_HEADLINE: Readonly<Record<TsaProofStatus, string>> = {
  VALIDATED: "Trusted timestamp applied and validated",
  RECORDED_NOT_VALIDATED: "Timestamp token received; not validated",
  NOT_OBTAINED: "Trusted timestamp not obtained",
  FAILED: "Timestamp token received; validation failed",
  PENDING: "Timestamp pending",
  NOT_REQUESTED: "Timestamp not requested",
};
