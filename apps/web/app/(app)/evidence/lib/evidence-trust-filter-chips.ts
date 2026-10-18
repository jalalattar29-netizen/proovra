/**
 * Phase HOME-PROOF — the visible chip strip for trust-signal filters, as
 * words. A filter value arrives as stored codes ("PENDING,UPGRADING,QUEUED",
 * "ANCHORED", "FAILED"); a chip never shows the raw code. Bitcoin anchoring
 * values are said in the shared OpenTimestamps vocabulary — a stored ANCHORED
 * is "Attestation recorded", never "Anchored" or "Verified".
 */
import { VERIFICATION_DISCLOSURE_MODE_LABELS, parseVerificationDisclosureMode } from "@proovra/shared";
import { humaniseCode, otsFilterValueLabel } from "../../../../lib/ots-presentation";

export type TrustChipKey = "tsaStatus" | "otsStatus" | "verificationDisclosure" | "verificationStatus" | "status" | "type";

export type TrustChipFilters = {
  tsaStatus?: string;
  otsStatus?: string;
  /** The verification page's disclosure (VERIFICATION_ONLY, CONTENT_PREVIEW). */
  verificationDisclosure?: string;
  verificationStatus?: string;
};

/**
 * "Verification only / Content preview" — the shared disclosure vocabulary.
 * An unknown value is never echoed as a raw code.
 */
export function verificationDisclosureFilterLabel(raw: string): string {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((v) => parseVerificationDisclosureMode(v.trim().toUpperCase()))
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .map((v) => VERIFICATION_DISCLOSURE_MODE_LABELS[v]),
    ),
  ).join(" / ");
}

/** A comma-separated filter value in words, each distinct word once. */
export function humaniseTrustFilterValue(raw: string): string {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => humaniseCode(v.toUpperCase())),
    ),
  ).join(" / ");
}

const isSet = (v: string | undefined): v is string => Boolean(v && v !== "all");

export function trustFilterChips(filters: TrustChipFilters): Array<{ key: TrustChipKey; label: string }> {
  const chips: Array<{ key: TrustChipKey; label: string }> = [];
  if (isSet(filters.tsaStatus)) {
    chips.push({ key: "tsaStatus", label: `Trust timestamp: ${humaniseTrustFilterValue(filters.tsaStatus)}` });
  }
  if (isSet(filters.otsStatus)) {
    chips.push({ key: "otsStatus", label: `Bitcoin anchoring: ${otsFilterValueLabel(filters.otsStatus)}` });
  }
  if (isSet(filters.verificationDisclosure)) {
    const words = verificationDisclosureFilterLabel(filters.verificationDisclosure);
    if (words) chips.push({ key: "verificationDisclosure", label: `Verification page: ${words}` });
  }
  // Phase HOME-CLOSURE — the "needs integrity review" filter reads as one
  // phrase, not its raw enum union ("REVIEW_REQUIRED, FAILED").
  if (isSet(filters.verificationStatus)) {
    const vsLabel = /REVIEW_REQUIRED.*FAILED|FAILED.*REVIEW_REQUIRED/i.test(filters.verificationStatus)
      ? "Needs integrity review"
      : humaniseTrustFilterValue(filters.verificationStatus);
    chips.push({ key: "verificationStatus", label: vsLabel });
  }
  return chips;
}
