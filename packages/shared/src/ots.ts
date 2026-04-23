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
