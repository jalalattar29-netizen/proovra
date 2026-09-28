/**
 * BASIC PUBLIC VERIFICATION (Decision B, 2026-09-29).
 *
 * A valid, published, non-revoked verification link always answers with THIS
 * projection — whether the evidence owner is Free, paid, or has cancelled. An
 * independent reviewer never loses the ability to check the fundamental
 * original-evidence claim because the owner stopped paying.
 *
 * It carries ONLY what the checks establish: identifiers a reviewer can match
 * against their own copy (the SHA-256 of the original, the signed fingerprint
 * hash), the real chronology, what each proof component actually verified, and
 * whether a report / package has been ISSUED. It never carries original bytes,
 * a PDF or ZIP, a download URL, a title, a file name, a case name, a person, a
 * custody actor or protected technical detail.
 *
 * Every component answers in one vocabulary: verified | pending | failed |
 * not_issued | not_checked. "verified" means the check named in `basis` was
 * performed and passed — never "a record of it exists".
 */

export const COMPONENT_VERIFICATION_STATES = [
  "verified",
  "pending",
  "failed",
  "not_issued",
  "not_checked",
] as const;
export type ComponentVerificationState = (typeof COMPONENT_VERIFICATION_STATES)[number];

export type BasicVerification = {
  schema: "PROOVRA_BASIC_VERIFICATION";
  version: 1;
  /** When this answer was computed. */
  checkedAtUtc: string;
  original: {
    state: ComponentVerificationState;
    /** What "verified" means here. */
    basis: "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN" | null;
    checks: {
      fingerprintMatchesSignedHash: boolean | null;
      signatureValid: boolean | null;
      custodyChainValid: boolean | null;
    };
    /** SHA-256 (hex) of the original evidence, as signed at finalization. */
    fileSha256: string | null;
    /** SHA-256 of the canonical fingerprint the signature covers. */
    fingerprintHash: string | null;
    /** Declared by the capturing client; not independently proven. */
    capturedAtUtcDeclared: string | null;
    /** Server time the record was finalized and signed. */
    finalizedAtUtc: string | null;
  };
  timestamp: {
    state: ComponentVerificationState;
    /**
     * "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED": a token was issued and
     * its message imprint equals the recorded digest; this service does not
     * validate the authority's signature or certificate chain, so the state is
     * not_checked rather than verified.
     */
    basis: "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED" | null;
    /** The authority's own time for the token. */
    tokenTimeUtc: string | null;
  };
  anchoring: {
    state: ComponentVerificationState;
    basis: "BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY" | null;
    /** When the anchor was confirmed — a fact that may post-date any report. */
    anchoredAtUtc: string | null;
    bitcoinTxid: string | null;
  };
  report: {
    issued: boolean;
    latestVersion: number | null;
    issuedAtUtc: string | null;
    /** A digest of the issued PDF is recorded, so a copy can be checked. */
    digestRecorded: boolean;
  };
  package: {
    issued: boolean;
    /** The package paired with the latest report, when there is one. */
    certifiesReportVersion: number | null;
    assembledAtUtc: string | null;
    /** Format 5: the seal binds every entry, including the report. */
    sealed: boolean;
    /** True when the latest report has no package yet. */
    latestReportLacksPackage: boolean;
  };
};

export function buildBasicVerification(input: {
  now: Date;
  integrity: {
    fingerprintMatches: boolean | null;
    signatureValid: boolean | null;
    custodyChainValid: boolean | null;
  };
  fileSha256: string | null;
  fingerprintHash: string | null;
  capturedAtUtc: Date | string | null;
  signedAtUtc: Date | string | null;
  tsaStatus: string | null;
  tsaImprintMatches: boolean | null;
  tsaGenTimeUtc: Date | string | null;
  otsStatus: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: Date | string | null;
  latestReport: { version: number; generatedAtUtc: Date; pdfSha256: string | null } | null;
  pairedPackage: { reportVersion: number | null; version: number; generatedAtUtc: Date; packageFormatVersion: number | null } | null;
}): BasicVerification {
  const iso = (v: Date | string | null | undefined) =>
    v == null ? null : v instanceof Date ? v.toISOString() : String(v);
  const checks = input.integrity;
  const anyFalse = [checks.fingerprintMatches, checks.signatureValid, checks.custodyChainValid].some(
    (c) => c === false,
  );
  const allTrue = [checks.fingerprintMatches, checks.signatureValid, checks.custodyChainValid].every(
    (c) => c === true,
  );

  const tsa = String(input.tsaStatus ?? "").toUpperCase();
  const timestampState: ComponentVerificationState =
    tsa === "FAILED"
      ? "failed"
      : tsa === "STAMPED" || tsa === "GRANTED"
        ? input.tsaImprintMatches === false
          ? "failed"
          : "not_checked"
        : tsa === "PENDING"
          ? "pending"
          : "not_issued";

  const ots = String(input.otsStatus ?? "").toUpperCase();
  const validTxid = typeof input.otsBitcoinTxid === "string" && /^[a-f0-9]{64}$/i.test(input.otsBitcoinTxid);
  const anchoringState: ComponentVerificationState =
    ots === "ANCHORED" && validTxid
      ? "verified"
      : ots === "ANCHORED" || ots === "PENDING"
        ? "pending"
        : ots === "FAILED"
          ? "failed"
          : "not_issued";

  const latest = input.latestReport;
  const pkg = input.pairedPackage;
  return {
    schema: "PROOVRA_BASIC_VERIFICATION",
    version: 1,
    checkedAtUtc: input.now.toISOString(),
    original: {
      state: anyFalse ? "failed" : allTrue ? "verified" : "not_checked",
      basis: allTrue ? "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN" : null,
      checks: {
        fingerprintMatchesSignedHash: checks.fingerprintMatches,
        signatureValid: checks.signatureValid,
        custodyChainValid: checks.custodyChainValid,
      },
      fileSha256: input.fileSha256,
      fingerprintHash: input.fingerprintHash,
      capturedAtUtcDeclared: iso(input.capturedAtUtc),
      finalizedAtUtc: iso(input.signedAtUtc),
    },
    timestamp: {
      state: timestampState,
      basis: timestampState === "not_checked" ? "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED" : null,
      tokenTimeUtc: timestampState === "not_checked" ? iso(input.tsaGenTimeUtc) : null,
    },
    anchoring: {
      state: anchoringState,
      basis: anchoringState === "verified" ? "BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY" : null,
      anchoredAtUtc: anchoringState === "verified" ? iso(input.otsAnchoredAtUtc) : null,
      bitcoinTxid: anchoringState === "verified" ? input.otsBitcoinTxid : null,
    },
    report: {
      issued: latest !== null,
      latestVersion: latest?.version ?? null,
      issuedAtUtc: latest ? latest.generatedAtUtc.toISOString() : null,
      digestRecorded: Boolean(latest?.pdfSha256),
    },
    package: {
      issued: pkg !== null,
      certifiesReportVersion: pkg ? (pkg.reportVersion ?? pkg.version) : null,
      assembledAtUtc: pkg ? pkg.generatedAtUtc.toISOString() : null,
      sealed: (pkg?.packageFormatVersion ?? 0) >= 5,
      latestReportLacksPackage: latest !== null && pkg === null,
    },
  };
}
