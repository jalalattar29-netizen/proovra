/**
 * THE VERIFICATION DISCLOSURE VOCABULARY (2026-10-18).
 *
 * PROOVRA has three access surfaces:
 *
 *   A. the owner / workspace evidence  — everything the viewer's role permits;
 *   B. the canonical Public Verify page (pvr_) — the record's permanent,
 *      unguessable reference. It opens without login, never depends on a share
 *      link and never offers the original files. It ALWAYS states the complete
 *      verification truth; what it discloses about the record's CONTENT is the
 *      record's disclosure policy below;
 *   C. a reviewer share (pvs_) — revocable, optionally expiring and
 *      use-limited, disclosing what its own profile allows.
 *
 * The disclosure policy has two independent parts:
 *
 *   mode                  VERIFICATION_ONLY (default) | CONTENT_PREVIEW
 *   showRecordedLocation  false (default); meaningful only with CONTENT_PREVIEW
 *
 * This module is VOCABULARY ONLY: the types, the labels, the fail-closed
 * parser and the plain-language description of a policy. The disclosure
 * DECISION (which fields leave the API) is made once, server-side, by the
 * Public Verify projection (services/api/src/services/public-verify/
 * public-verify-projection.ts). No client decides what to show from a policy:
 * clients render what the API returned.
 */

export const VERIFICATION_DISCLOSURE_MODES = ["VERIFICATION_ONLY", "CONTENT_PREVIEW"] as const;
export type VerificationDisclosureMode = (typeof VERIFICATION_DISCLOSURE_MODES)[number];

export const VERIFICATION_DISCLOSURE_MODE_LABELS: Readonly<Record<VerificationDisclosureMode, string>> = {
  VERIFICATION_ONLY: "Verification only",
  CONTENT_PREVIEW: "Content preview",
};

export type VerificationDisclosurePolicy = {
  mode: VerificationDisclosureMode;
  /** Always false unless mode is CONTENT_PREVIEW. */
  showRecordedLocation: boolean;
};

export const DEFAULT_VERIFICATION_DISCLOSURE_POLICY: VerificationDisclosurePolicy = Object.freeze({
  mode: "VERIFICATION_ONLY",
  showRecordedLocation: false,
});

export function parseVerificationDisclosureMode(value: unknown): VerificationDisclosureMode | null {
  return typeof value === "string" && (VERIFICATION_DISCLOSURE_MODES as readonly string[]).includes(value)
    ? (value as VerificationDisclosureMode)
    : null;
}

/**
 * A stored policy, read FAIL CLOSED: an unknown mode is VERIFICATION_ONLY, and
 * the location flag counts only with CONTENT_PREVIEW (the database refuses the
 * other combination; this reader does not trust that it never happened).
 */
export function parseVerificationDisclosurePolicy(row: {
  verificationDisclosureMode?: unknown;
  showRecordedLocation?: unknown;
} | null | undefined): VerificationDisclosurePolicy {
  const mode = parseVerificationDisclosureMode(row?.verificationDisclosureMode) ?? "VERIFICATION_ONLY";
  return {
    mode,
    showRecordedLocation: mode === "CONTENT_PREVIEW" && row?.showRecordedLocation === true,
  };
}

/**
 * The words for a value that EXISTS but is not disclosed. Never "Not
 * recorded", "N/A" or "Not applicable" for withheld data: those say the value
 * does not exist.
 */
export const WITHHELD_BY_DISCLOSURE_POLICY = "Withheld by the record’s disclosure policy";

/** How the Public Verify page was reached. Never decides what is shown on its own. */
export const PUBLIC_VERIFY_IDENTIFIER_KINDS = [
  /** pvr_ — the permanent canonical reference. */
  "CANONICAL_REFERENCE",
  /** a REPORT/PACKAGE pvs_ link an issued artifact printed: the canonical page. */
  "LEGACY_ARTIFACT_LINK",
  /** a record-id link inside its bounded grace: the canonical page. */
  "LEGACY_RECORD_ID",
  /** an owner-created reviewer share (pvs_ OWNER_SHARE). */
  "REVIEWER_SHARE",
] as const;
export type PublicVerifyIdentifierKind = (typeof PUBLIC_VERIFY_IDENTIFIER_KINDS)[number];

/**
 * What the API states about the disclosure it applied — so a page can say what
 * it shows and why, never decide it.
 */
export type PublicVerifyDisclosureFacts = {
  /** The disclosure that applied to this answer. */
  mode: VerificationDisclosureMode;
  recordedLocation: boolean;
  /** RECORD_POLICY for every canonical identifier; REVIEWER_SHARE for a pvs_ share. */
  source: "RECORD_POLICY" | "REVIEWER_SHARE";
  originalDownload: boolean;
  /** The sentence for every withheld value. */
  withheldStatement: typeof WITHHELD_BY_DISCLOSURE_POLICY;
};

/** "Item 1", "Item 2", … — the only public label when names are withheld. */
export function genericItemLabel(zeroBasedIndex: number): string {
  return `Item ${zeroBasedIndex + 1}`;
}

/** The one description of a multipart record (never its first part's MIME type). */
export function multipartRecordKindLabel(itemCount: number): string {
  return `Multipart package · ${itemCount} items`;
}

/**
 * What an anonymous visitor of the pvr_ page sees under a policy, in plain
 * language — the owner's "what visitors will see" preview. Served by the API
 * (GET /v1/evidence/:id/verification-disclosure); clients print it.
 */
export function describeVerificationDisclosure(policy: VerificationDisclosurePolicy): {
  shown: string[];
  withheld: string[];
  never: string[];
} {
  const always = [
    "The complete verification result: file integrity, record signature, trusted timestamp, OpenTimestamps, storage protection and package checks",
    "The permanent verification reference and when the page was checked",
    "A generic item inventory (Item 1, Item 2, …) with each item's kind, approximate size and SHA-256",
    "Report and package version history with their issue times",
    "A public-safe custody summary and aggregated access activity",
  ];
  const never = [
    "Original file downloads",
    "Email addresses, IP addresses or browser details",
    "Internal record, account or storage identifiers",
  ];
  if (policy.mode === "VERIFICATION_ONLY") {
    return {
      shown: always,
      withheld: [
        "Title and description",
        "Original file names and the roles you assigned",
        "Content previews",
        "Recorded location and device time",
      ],
      never,
    };
  }
  return {
    shown: [
      ...always,
      "Title and description",
      "Original file names and the roles you assigned",
      "Safe content previews",
      "Device-reported capture time",
      ...(policy.showRecordedLocation ? ["Recorded (device-reported) location, with a map shown only after the visitor agrees"] : []),
    ],
    withheld: policy.showRecordedLocation ? [] : ["Recorded location"],
    never,
  };
}
