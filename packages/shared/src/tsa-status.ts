/**
 * THE CANONICAL RFC 3161 PROOF STATUS (UC-TRUST-002, 2026-10-01), built on
 * `presentedTsaStatus`:
 *   NOT_REQUESTED, PENDING, VALIDATED, RECORDED_NOT_VALIDATED, FAILED
 *
 * Only VALIDATED may be shown as an applied/trusted timestamp. A legacy token
 * kept without validation is "Recorded, not validated" — never "Applied".
 * (The OpenTimestamps state lives in ots-anchoring.ts.)
 */
import { presentedTsaStatus, TSA_RECORDED_NOT_VALIDATED } from "./tsa-validation-state.js";

export const TSA_PROOF_STATUSES = [
  "NOT_REQUESTED",
  "PENDING",
  "VALIDATED",
  "RECORDED_NOT_VALIDATED",
  "FAILED",
] as const;
export type TsaProofStatus = (typeof TSA_PROOF_STATUSES)[number];

export function resolveTsaProofStatus(row: {
  tsaStatus: string | null | undefined;
  tsaValidatedAtUtc?: Date | string | null | undefined;
}): TsaProofStatus {
  const presented = String(presentedTsaStatus(row) ?? "").trim().toUpperCase();
  if (presented === "STAMPED") return "VALIDATED";
  if (presented === TSA_RECORDED_NOT_VALIDATED) return "RECORDED_NOT_VALIDATED";
  if (presented === "FAILED") return "FAILED";
  if (presented === "PENDING") return "PENDING";
  return "NOT_REQUESTED";
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
  FAILED: "Timestamp failed",
};

export function parseTsaProofStatus(value: unknown): TsaProofStatus | null {
  return typeof value === "string" && (TSA_PROOF_STATUSES as readonly string[]).includes(value)
    ? (value as TsaProofStatus)
    : null;
}
