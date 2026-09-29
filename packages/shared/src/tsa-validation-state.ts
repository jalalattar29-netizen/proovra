/**
 * THE ONE READING OF A STORED TIMESTAMP STATUS (ET-TSA-01, 2026-09-29).
 *
 * Since 2026-09-29 a row is written STAMPED only after its RFC 3161 token was
 * validated (signature, chain to the environment's trust anchor, signer
 * validity at genTime, imprint, nonce, policy), and `tsaValidatedAtUtc`
 * records when. Rows written before then were STAMPED from the reply's TEXT —
 * nothing validated the token. Those rows are not failures (the token is kept
 * and may well be genuine) and they are not validated timestamps either.
 *
 * `presentedTsaStatus` is the status every surface shows and reasons about:
 *   STAMPED with a validation time  -> "STAMPED"
 *   STAMPED without one             -> "RECORDED_NOT_VALIDATED"
 *   anything else                   -> the stored value, unchanged
 *
 * Apply it where a row leaves the database. Surfaces that treat STAMPED as a
 * positive trusted-timestamp claim then never make that claim for an
 * unvalidated token, and label RECORDED_NOT_VALIDATED with
 * TSA_RECORDED_NOT_VALIDATED_LABEL.
 */
export const TSA_RECORDED_NOT_VALIDATED = "RECORDED_NOT_VALIDATED" as const;

export const TSA_RECORDED_NOT_VALIDATED_LABEL = "Recorded, not validated";

export function presentedTsaStatus(row: {
  tsaStatus: string | null | undefined;
  tsaValidatedAtUtc?: Date | string | null | undefined;
}): string | null {
  const stored = row.tsaStatus == null ? null : String(row.tsaStatus);
  if (stored === null) return null;
  if (stored.trim().toUpperCase() === "STAMPED" && !row.tsaValidatedAtUtc) {
    return TSA_RECORDED_NOT_VALIDATED;
  }
  return stored;
}
