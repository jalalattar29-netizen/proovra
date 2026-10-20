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
import { resolveTsaProofStatus, tsaProofComponentState } from "./tsa-status.js";
import {
  resolveOtsAnchoring,
  toOtsAnchoringView,
  type OtsAnchoringInput,
  type OtsChainView,
  type OtsState,
  type OtsVerificationKey,
} from "./ots-anchoring.js";

import { buildProvenanceTimeline, CAPTURE_TIME_NOT_AVAILABLE } from "./provenance-time.js";
import {
  storedBytesCheckStatusOf,
  storedBytesIntegrityContradicts,
  storedBytesIntegrityCopy,
  type StoredBytesCheckStatus,
  type StoredBytesIntegrity,
} from "./stored-bytes-integrity.js";

// UC-TRUST-002 / UC-PROV-001 — the canonical proof-status and provenance-time
// modules travel with this one (every consumer of Basic Verify needs them).
export * from "./tsa-status.js";
export * from "./provenance-time.js";
// UC-PROV-007 — the whole-word forbidden-phrase matcher (report-artifact.ts is
// re-exported from the barrel by name).
export { findForbiddenArtifactPhrases } from "./report-artifact.js";

export const COMPONENT_VERIFICATION_STATES = [
  "verified",
  "pending",
  "failed",
  "not_issued",
  "not_checked",
] as const;
export type ComponentVerificationState = (typeof COMPONENT_VERIFICATION_STATES)[number];

/** "verified" ONLY for an anchor independently verified against the Bitcoin main chain. */
export const OTS_COMPONENT_STATE: Readonly<Record<OtsVerificationKey, ComponentVerificationState>> = {
  NOT_REQUESTED: "not_issued",
  PENDING: "pending",
  ATTESTATION_RECORDED: "not_checked",
  CHAIN_CONFIRMATIONS_PENDING: "pending",
  CHAIN_UNAVAILABLE: "not_checked",
  CHAIN_FAILED: "failed",
  CHAIN_VERIFIED: "verified",
  FAILED: "failed",
  UNAVAILABLE: "not_checked",
};

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
      /**
       * UC-TRUST-001 — the unsigned digest columns agree with the digests the
       * signed fingerprint certifies. Null when not compared (legacy payload).
       */
      digestColumnsMatchSignedFingerprint?: boolean | null;
    };
    /** SHA-256 (hex) of the original evidence, as signed at finalization. */
    fileSha256: string | null;
    /** SHA-256 of the canonical fingerprint the signature covers. */
    fingerprintHash: string | null;
    /**
     * UC-PROV-001 — the PROOVRA SERVER clock when the record was created from
     * the submission. It is NOT a capture time and no device declared it.
     */
    serverReceivedAtUtc?: string | null;
    /** The capturing device's own clock, as the client reported it; not proven. */
    deviceDeclaredCaptureAtUtc?: string | null;
    /** "Device-declared capture time …" or "Capture time not available". */
    captureTimeStatement?: string;
    /**
     * @deprecated Wire alias of `serverReceivedAtUtc`, kept for older readers.
     * Despite its name it is the server-received time; never render it as a
     * device-declared capture time.
     */
    capturedAtUtcDeclared: string | null;
    /** Server time the record was finalized and signed. */
    finalizedAtUtc: string | null;
  };
  /**
   * ET-SM-07 — THE STORED BYTES, as last rechecked. `original` above is a
   * statement about PROOVRA's signed records; this is the separate statement
   * about the stored file itself: whether it was re-read at its exact recorded
   * version and matched the signed hash, and how recently. Only
   * `verified_current` may be presented as current integrity of the stored
   * file; stale, pending and unknown are shown as what they are. Optional on
   * the wire: a payload from before this field carries none.
   */
  storedBytes?: StoredBytesIntegrity;
  /**
   * UC-TRUST-005 — THE HEADLINE, incorporating the stored bytes. The recorded
   * checks alone never produce "verified": a stored file that does not match
   * its signed digest (or is gone) makes the headline failed, and one not
   * re-verified inside the freshness window makes it "recorded_only" (recorded
   * integrity verified; the current stored file is not stated as verified).
   */
  verdict?: {
    state: "verified" | "recorded_only" | "failed" | "not_checked";
    storedBytesCheck: StoredBytesCheckStatus | null;
    label: string;
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
      /** A token was obtained but never validated (no trust anchor was available). */
      | "TOKEN_OBTAINED_NOT_VALIDATED"
      | null;
    /** The authority's own time for the token. */
    tokenTimeUtc: string | null;
  };
  /**
   * THE BITCOIN ANCHORING SIGNAL (2026-10-13) — the canonical OpenTimestamps
   * state (ots-anchoring.ts) and the facts the stored proof itself yields.
   * `state` is the generic component word; readers show `otsState` through
   * `status` / `sentence` and never re-derive it.
   */
  anchoring: {
    state: ComponentVerificationState;
    otsState: OtsState;
    /** The canonical verification key (CHAIN_VERIFIED is the only "verified"). */
    otsVerification: OtsVerificationKey;
    /** "Attestation recorded" | "Independently verified" | "Pending" | … */
    status: string;
    /** "Bitcoin attestation recorded" | "Independently verified against the Bitcoin main chain" | … */
    label: string;
    sentence: string;
    /** "Not independently checked against Bitcoin" for an unchecked attestation, else null. */
    secondaryStatus: string | null;
    /** The bounded chain facts, when a chain check is recorded for this proof. */
    chain: OtsChainView | null;
    /** Bounded failure / unavailability code; null otherwise. */
    failureCode: string | null;
    proofSha256: string | null;
    attestationType: "BITCOIN_BLOCK_HEADER" | "PENDING_CALENDAR" | null;
    /** From the executed proof path; null unless ANCHORED. */
    bitcoinBlockHeight: number | null;
    /** Only when the executed proof path derives it. */
    bitcoinTxid: string | null;
    submittedAtUtc: string | null;
    /** When PROOVRA recorded ANCHORED — not a Bitcoin block time. */
    anchoredAtUtc: string | null;
    validator: string;
  };
  report: {
    issued: boolean;
    latestVersion: number | null;
    issuedAtUtc: string | null;
    /** A digest of the issued PDF is recorded, so a copy can be checked. */
    digestRecorded: boolean;
    /** ET-PKG-12: that digest (SHA-256 hex), so the check is possible. */
    sha256: string | null;
  };
  package: {
    issued: boolean;
    /** The package paired with the latest report, when there is one. */
    certifiesReportVersion: number | null;
    assembledAtUtc: string | null;
    /** Format 5: the seal binds every entry, including the report. */
    sealed: boolean;
    /**
     * ET-PKG-02: SHA-256 of the exact package file PROOVRA issued, and the
     * fingerprint (SHA-256 of the DER SubjectPublicKeyInfo) of the key that
     * sealed it. A seal key found only inside a package vouches for nothing;
     * these let a recipient check the package they hold against PROOVRA.
     * Null when not recorded (packages issued before 2026-09-29).
     */
    packageSha256: string | null;
    sealKeyFingerprint: string | null;
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
  /** UC-TRUST-001 — do the digest columns agree with the signed fingerprint? */
  digestColumnsMatchSignedFingerprint?: boolean | null;
  /** ET-SM-07 — the stored-bytes recheck state, resolved by the authority. */
  storedBytes?: StoredBytesIntegrity | null;
  /** Evidence.capturedAtUtc — the SERVER clock at record creation (UC-PROV-001). */
  capturedAtUtc: Date | string | null;
  /** Evidence.deviceTimeIso — the device clock the client reported. */
  deviceTimeIso?: string | null;
  signedAtUtc: Date | string | null;
  tsaStatus: string | null;
  /**
   * (2026-10-17) THE TSA TRUST AUTHORITY'S INPUTS (resolveTsaTrustState): a
   * FAILED status with a kept token whose validation was not performed (no
   * trust anchor) is "not checked", exactly as the matrix and the signal say —
   * never "failed". Absent from older callers: the status alone is read.
   */
  tsaTokenPresent?: boolean | null;
  tsaFailureCode?: string | null;
  tsaImprintMatches: boolean | null;
  tsaGenTimeUtc: Date | string | null;
  /** The OpenTimestamps record (ots-anchoring.ts OtsAnchoringInput). */
  ots: OtsAnchoringInput;
  latestReport: { version: number; generatedAtUtc: Date; pdfSha256: string | null } | null;
  pairedPackage: {
    reportVersion: number | null;
    version: number;
    generatedAtUtc: Date;
    packageFormatVersion: number | null;
    packageSha256?: string | null;
    sealSigningKeySha256?: string | null;
  } | null;
}): BasicVerification {
  const iso = (v: Date | string | null | undefined) =>
    v == null ? null : v instanceof Date ? v.toISOString() : String(v);
  const checks = input.integrity;
  const columnsMatch = input.digestColumnsMatchSignedFingerprint ?? null;
  // UC-TRUST-001 / UC-TRUST-005 — a digest column that disagrees with the
  // signed fingerprint, or a stored file that contradicts the signed digest,
  // is a failed original: the signature over the fingerprint no longer vouches
  // for the bytes PROOVRA holds.
  const storedContradicts = storedBytesIntegrityContradicts(input.storedBytes ?? null);
  const anyFalse =
    [checks.fingerprintMatches, checks.signatureValid, checks.custodyChainValid].some((c) => c === false) ||
    columnsMatch === false ||
    storedContradicts;
  const allTrue = [checks.fingerprintMatches, checks.signatureValid, checks.custodyChainValid].every(
    (c) => c === true,
  );

  // `tsaStatus` is the PRESENTED status (presentedTsaStatus): STAMPED means
  // the token was validated; RECORDED_NOT_VALIDATED is a kept legacy token.
  const tsa = String(input.tsaStatus ?? "").toUpperCase();
  // ONE TSA AUTHORITY (2026-10-20, AUD-14): the state is the canonical proof
  // status read through resolveTsaTrustState. A provider outage (no token) is
  // "not issued", never "failed"; only a token whose validation was refused,
  // or whose imprint does not match, is.
  const tsaProof = resolveTsaProofStatus({
    tsaStatus: tsa || null,
    // The PRESENTED status is passed: STAMPED here already means validated.
    tsaValidatedAtUtc: tsa === "STAMPED" ? "validated" : null,
    tsaTokenPresent: input.tsaTokenPresent ?? null,
    tsaFailureCode: input.tsaFailureCode ?? null,
  });
  const timestampState: ComponentVerificationState = tsaProofComponentState(tsaProof, input.tsaImprintMatches);
  const timestampBasis: BasicVerification["timestamp"]["basis"] =
    timestampState === "verified"
      ? "TOKEN_VALIDATED"
      : timestampState !== "not_checked"
        ? null
        : tsa === "RECORDED_NOT_VALIDATED"
          ? "TOKEN_RECORDED_NOT_VALIDATED"
          : tsa === "FAILED"
            ? "TOKEN_OBTAINED_NOT_VALIDATED"
            : "TOKEN_RECORDED_IMPRINT_NOT_COMPARED";

  // THE ONE OTS AUTHORITY (2026-10-13): the state is resolved from the stored
  // proof bytes, never from a status, a txid or a recording time.
  const ots = resolveOtsAnchoring(input.ots);
  const anchoringState: ComponentVerificationState = OTS_COMPONENT_STATE[ots.verification];
  const otsView = toOtsAnchoringView(ots);
  const anchored = ots.state === "ANCHORED";

  const latest = input.latestReport;
  const pkg = input.pairedPackage;
  const originalState: ComponentVerificationState = anyFalse ? "failed" : allTrue ? "verified" : "not_checked";
  const storedCheck = input.storedBytes ? storedBytesCheckStatusOf(input.storedBytes) : null;
  const verdictState: NonNullable<BasicVerification["verdict"]>["state"] =
    originalState === "failed"
      ? "failed"
      : originalState !== "verified"
        ? "not_checked"
        : storedCheck === "VERIFIED"
          ? "verified"
          : "recorded_only";
  const timeline = buildProvenanceTimeline({
    serverReceivedAtUtc: input.capturedAtUtc,
    deviceTimeIso: input.deviceTimeIso ?? null,
  });
  const deviceDeclared = timeline.entries.find((e) => e.kind === "DEVICE_OBSERVED")?.atUtc ?? null;
  return {
    schema: "PROOVRA_BASIC_VERIFICATION",
    version: 1,
    checkedAtUtc: input.now.toISOString(),
    original: {
      state: originalState,
      basis: originalState === "verified" ? "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN" : null,
      checks: {
        fingerprintMatchesSignedHash: checks.fingerprintMatches,
        signatureValid: checks.signatureValid,
        custodyChainValid: checks.custodyChainValid,
        digestColumnsMatchSignedFingerprint: columnsMatch,
      },
      fileSha256: input.fileSha256,
      fingerprintHash: input.fingerprintHash,
      serverReceivedAtUtc: iso(input.capturedAtUtc),
      deviceDeclaredCaptureAtUtc: deviceDeclared,
      captureTimeStatement: deviceDeclared
        ? `Device-declared capture time (reported by the capture client, not proven): ${deviceDeclared}`
        : CAPTURE_TIME_NOT_AVAILABLE,
      capturedAtUtcDeclared: iso(input.capturedAtUtc),
      finalizedAtUtc: iso(input.signedAtUtc),
    },
    ...(input.storedBytes ? { storedBytes: input.storedBytes } : {}),
    verdict: {
      state: verdictState,
      storedBytesCheck: storedCheck,
      label:
        verdictState === "verified"
          ? "Recorded integrity verified; stored file re-verified"
          : verdictState === "recorded_only"
            ? storedCheck === "STALE" && input.storedBytes?.lastVerifiedAtUtc
              ? `Recorded integrity verified; stored file last verified ${input.storedBytes.lastVerifiedAtUtc}`
              : "Recorded integrity verified; the current stored file is not stated as verified"
            : verdictState === "failed"
              ? storedContradicts
                ? "Integrity review required: the stored file does not match its signed digest"
                : columnsMatch === false
                  ? "Integrity review required: recorded digests disagree with the signed fingerprint"
                  : "Integrity review required"
              : "Not checked",
    },
    timestamp: {
      state: timestampState,
      basis: timestampBasis,
      tokenTimeUtc:
        timestampState === "not_checked" || timestampState === "verified" ? iso(input.tsaGenTimeUtc) : null,
    },
    anchoring: {
      state: anchoringState,
      otsState: ots.state,
      otsVerification: ots.verification,
      status: otsView.status,
      label: otsView.label,
      sentence: otsView.sentence,
      secondaryStatus: otsView.secondaryStatus,
      chain: otsView.chain,
      failureCode: ots.failureCode,
      proofSha256: ots.proofSha256,
      attestationType: ots.attestationType,
      bitcoinBlockHeight: anchored ? ots.bitcoinBlockHeight : null,
      bitcoinTxid: anchored ? ots.bitcoinTxid : null,
      submittedAtUtc: ots.submittedAtUtc,
      anchoredAtUtc: anchored ? ots.anchoredAtUtc : null,
      validator: ots.validator,
    },
    report: {
      issued: latest !== null,
      latestVersion: latest?.version ?? null,
      issuedAtUtc: latest ? latest.generatedAtUtc.toISOString() : null,
      digestRecorded: Boolean(latest?.pdfSha256),
      sha256: latest?.pdfSha256 ?? null,
    },
    package: {
      issued: pkg !== null,
      certifiesReportVersion: pkg ? (pkg.reportVersion ?? pkg.version) : null,
      assembledAtUtc: pkg ? pkg.generatedAtUtc.toISOString() : null,
      sealed: (pkg?.packageFormatVersion ?? 0) >= 5,
      packageSha256: pkg?.packageSha256 ?? null,
      sealKeyFingerprint: pkg?.sealSigningKeySha256 ?? null,
      latestReportLacksPackage: latest !== null && pkg === null,
    },
  };
}

/**
 * ET-SM-07 — the stored-file recheck as one row of the Verify page, in the
 * page's single vocabulary, for web and native alike. ONLY a recheck inside
 * the cadence reads "Verified"; an out-of-date or never-made one is
 * "Not checked" with its own badge, never a green tick.
 */
const STORED_BYTES_ROW: Record<StoredBytesCheckStatus, { state: ComponentVerificationState; badge: string }> = {
  VERIFIED: { state: "verified", badge: "Verified" },
  STALE: { state: "not_checked", badge: "Stale" },
  PENDING: { state: "pending", badge: "Pending" },
  MISMATCH: { state: "failed", badge: "Mismatch" },
  UNAVAILABLE: { state: "failed", badge: "Unavailable" },
  UNKNOWN: { state: "not_checked", badge: "Not yet rechecked" },
};

/**
 * UC-TRUST-008 — ONLY a passing recheck of the pinned version inside the
 * short freshness window reads "Verified"; an older one reads "Stale" with its
 * last-verified time, never a green tick.
 */
export function storedBytesVerificationRow(integrity: StoredBytesIntegrity): {
  state: ComponentVerificationState;
  badge: string;
  label: string;
  detail: string;
  checkStatus: StoredBytesCheckStatus;
} {
  const checkStatus = storedBytesCheckStatusOf(integrity);
  // A transient storage outage on a record never verified is not a failure.
  const row =
    checkStatus === "UNAVAILABLE" && integrity.state !== "failed"
      ? { state: "not_checked" as const, badge: "Unavailable" }
      : STORED_BYTES_ROW[checkStatus];
  return { ...row, ...storedBytesIntegrityCopy(integrity), checkStatus };
}
