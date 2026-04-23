import type { Prisma } from "@prisma/client";
import { isCompleteOtsAnchor, isValidOtsBitcoinTxid } from "@proovra/shared";

type OtsStatus = "DISABLED" | "PENDING" | "ANCHORED" | "FAILED";

type OtsStateInput = {
  status: OtsStatus;
  proofBase64?: string | null;
  hash?: string | null;
  calendar?: string | null;
  bitcoinTxid?: string | null;
  anchoredAtUtc?: Date | string | null;
  upgradedAtUtc?: Date | string | null;
  failureReason?: string | null;
};

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanTxid(value: string | null | undefined): string | null {
  const trimmed = clean(value);
  return trimmed && isValidOtsBitcoinTxid(trimmed) ? trimmed.toLowerCase() : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const trimmed = clean(value);
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function failureReason(value: string | null | undefined): string {
  return clean(value) ?? "OTS operation failed without a structured reason.";
}

export function buildOtsEvidenceUpdateData(
  input: OtsStateInput
): Prisma.EvidenceUpdateInput {
  const bitcoinTxid = cleanTxid(input.bitcoinTxid);
  const anchoredAtUtc = toDate(input.anchoredAtUtc);
  const upgradedAtUtc = toDate(input.upgradedAtUtc);

  switch (input.status) {
    case "DISABLED":
      return {
        otsProofBase64: null,
        otsHash: null,
        otsStatus: "DISABLED",
        otsCalendar: null,
        otsBitcoinTxid: null,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: null,
        otsFailureReason: null,
      };

    case "PENDING":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "PENDING",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: bitcoinTxid,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: null,
      };

case "ANCHORED": {
  if (
    !isCompleteOtsAnchor({
      status: input.status,
      anchoredAtUtc,
    })
  ) {
    return {
      otsProofBase64: clean(input.proofBase64),
      otsHash: clean(input.hash),
      otsStatus: "PENDING",
      otsCalendar: clean(input.calendar),
      otsBitcoinTxid: bitcoinTxid,
      otsAnchoredAtUtc: null,
      otsUpgradedAtUtc: upgradedAtUtc,
      otsFailureReason: null,
    };
  }

  return {
    otsProofBase64: clean(input.proofBase64),
    otsHash: clean(input.hash),
    otsStatus: "ANCHORED",
    otsCalendar: clean(input.calendar),
    otsBitcoinTxid: bitcoinTxid,
    otsAnchoredAtUtc: anchoredAtUtc,
    otsUpgradedAtUtc: upgradedAtUtc ?? anchoredAtUtc,
    otsFailureReason: null,
  };
}

    case "FAILED":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "FAILED",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: null,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: failureReason(input.failureReason),
      };
  }
}
