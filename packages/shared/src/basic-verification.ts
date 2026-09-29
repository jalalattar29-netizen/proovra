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
import { normalizeOtsAnchorCheck, resolveOtsAnchorClaim } from "./ots.js";

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
     * (ET-TSA-01) "TOKEN_VALIDATED": PROOVRA validated the token when it was
     * issued — signature, certificate chain to the configured trust anchor,
     * signer validity at genTime, imprint and nonce — and the imprint read
     * from the token equals the recorded digest. State: verified.
     *
     * (ET-TSA-01) "TOKEN_RECORDED_NOT_VALIDATED": a token was kept from before
     * validation existed and has not been validated since. State: not_checked.
     *
     * "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED": legacy basis, no longer
     * produced (kept in the union for readers of older payloads).
     */
    /**
     * (2026-09-29) "TOKEN_RECORDED_IMPRINT_NOT_COMPARED": a token was issued, but
     * the imprint could not be compared (it was never stored). Unknown, not a
     * mismatch.
     */
    basis:
      | "TOKEN_VALIDATED"
      | "TOKEN_RECORDED_NOT_VALIDATED"
      | "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED"
      | "TOKEN_RECORDED_IMPRINT_NOT_COMPARED"
      | null;
    /** The authority's own time for the token. */
    tokenTimeUtc: string | null;
  };
  anchoring: {
    state: ComponentVerificationState;
    /**
     * BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY: `ots verify` checked the proof's
     * Bitcoin attestation against the chain (state verified).
     * PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED: the proof carries a Bitcoin
     * block attestation for this record (or was recorded anchored before the
     * check existed) but the chain was not checked (state not_checked).
     */
    /**
     * (2026-09-29) ANCHOR_RECORDED_CHECK_NOT_RECORDED: the record was stored as
     * anchored before the platform recorded HOW an anchor was established
     * (ots_anchor_check NULL). The historical proof is kept; no proof-structure
     * or chain check is claimed for it.
     */
    basis:
      | "BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY"
      | "PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED"
      | "ANCHOR_RECORDED_CHECK_NOT_RECORDED"
      | null;
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
  /** evidence.ots_anchor_check — BITCOIN_VERIFIED | PROOF_STRUCTURE | null. */
  otsAnchorCheck?: string | null;
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

  // `tsaStatus` is the PRESENTED status (presentedTsaStatus): STAMPED means
  // the token was validated; RECORDED_NOT_VALIDATED is a kept legacy token.
  const tsa = String(input.tsaStatus ?? "").toUpperCase();
  const tsaPositive = tsa === "STAMPED" || tsa === "GRANTED" || tsa === "VERIFIED" || tsa === "SUCCEEDED";
  const timestampState: ComponentVerificationState =
    tsa === "FAILED"
      ? "failed"
      : tsaPositive
        ? input.tsaImprintMatches === false
          ? "failed"
          : tsa === "STAMPED" && input.tsaImprintMatches === true
            ? "verified"
            : "not_checked"
        : tsa === "RECORDED_NOT_VALIDATED"
          ? "not_checked"
          : tsa === "PENDING"
            ? "pending"
            : "not_issued";
  const timestampBasis: BasicVerification["timestamp"]["basis"] =
    timestampState === "verified"
      ? "TOKEN_VALIDATED"
      : timestampState !== "not_checked"
        ? null
        : tsa === "RECORDED_NOT_VALIDATED"
          ? "TOKEN_RECORDED_NOT_VALIDATED"
          : "TOKEN_RECORDED_IMPRINT_NOT_COMPARED";

  // The shared OTS claim (2026-09-29): a status or a txid is never enough for
  // "verified" — only an anchor verified against the Bitcoin chain is.
  const claim = resolveOtsAnchorClaim({
    status: input.otsStatus,
    anchoredAtUtc: input.otsAnchoredAtUtc,
    anchorCheck: input.otsAnchorCheck ?? null,
    bitcoinTxid: input.otsBitcoinTxid ?? null,
  });
  const anchoringState: ComponentVerificationState =
    claim === "VERIFIED"
      ? "verified"
      : claim === "ANCHORED_NOT_CHECKED"
        ? "not_checked"
        : claim === "PENDING"
          ? "pending"
          : claim === "FAILED"
            ? "failed"
            : "not_issued";
  const anchored = claim === "VERIFIED" || claim === "ANCHORED_NOT_CHECKED";
  const validTxid = typeof input.otsBitcoinTxid === "string" && /^[a-f0-9]{64}$/i.test(input.otsBitcoinTxid);

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
      basis: timestampBasis,
      tokenTimeUtc:
        timestampState === "not_checked" || timestampState === "verified" ? iso(input.tsaGenTimeUtc) : null,
    },
    anchoring: {
      state: anchoringState,
      basis:
        claim === "VERIFIED"
          ? "BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY"
          : claim === "ANCHORED_NOT_CHECKED"
            ? normalizeOtsAnchorCheck(input.otsAnchorCheck ?? null) === "PROOF_STRUCTURE"
              ? "PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED"
              : "ANCHOR_RECORDED_CHECK_NOT_RECORDED"
            : null,
      anchoredAtUtc: anchored ? iso(input.otsAnchoredAtUtc) : null,
      bitcoinTxid: anchored && validTxid ? input.otsBitcoinTxid : null,
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
