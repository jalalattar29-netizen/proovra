/**
 * THE RFC 3161 VALIDATION RECORD (2026-10-07) — `timestamp-validation.json`.
 *
 * A bounded statement of what PROOVRA's canonical validator
 * (services/api/src/services/timestamp/validate-tsa-token.ts — `openssl ts
 * -verify` against the environment's trust anchor at the stamped time) did
 * and did not establish for one record's token. Built only from recorded
 * facts: the record's TSA columns and the validation evidence the validator
 * returned (kept in the TIMESTAMP_APPLIED custody event since 2026-10-07).
 *
 * Four separate questions, never merged:
 *   1. token structure and message imprint      (this record)
 *   2. certificate chain to a trust store        (PROOVRA's anchor here; the
 *                                                 verifier must use their own)
 *   3. service qualification / trust-list status (NOT evaluated by PROOVRA)
 *   4. legal effect                              (jurisdiction and context;
 *                                                 never stated here)
 */
import { resolveTsaProofStatus } from "./ots-status.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import { resolveTsaTrustState } from "./trust-signal-state.js";

export type TsaCheckResult = "PASSED" | "FAILED" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "NOT_RECORDED" | "UNAVAILABLE";

/** What the validator reports about a successful validation (custody payload `tsaValidation`). */
export type TsaValidationEvidence = {
  /** SHA-256 fingerprints of the self-signed roots the validator trusted. */
  trustAnchorSha256: string[];
  /** SHA-256 fingerprints of every certificate carried in the token (signer first). */
  tokenCertificateSha256: string[];
  /** True when the original query (with its nonce) was checked. */
  nonceChecked: boolean;
  /** True when a policy-OID allowlist was enforced. */
  policyAllowlistEnforced: boolean;
};

export function parseTsaValidationEvidence(value: unknown): TsaValidationEvidence | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const hexList = (x: unknown) =>
    Array.isArray(x) ? x.filter((h): h is string => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) : [];
  if (typeof v.nonceChecked !== "boolean" || typeof v.policyAllowlistEnforced !== "boolean") return null;
  return {
    trustAnchorSha256: hexList(v.trustAnchorSha256),
    tokenCertificateSha256: hexList(v.tokenCertificateSha256),
    nonceChecked: v.nonceChecked,
    policyAllowlistEnforced: v.policyAllowlistEnforced,
  };
}

const FAILED_CHECK: Readonly<Record<string, keyof TimestampValidationRecord["checks"]>> = {
  tsa_token_signature_invalid: "signature",
  tsa_token_untrusted: "certificateChain",
  tsa_message_imprint_mismatch: "messageImprint",
  tsa_nonce_mismatch: "nonce",
  tsa_policy_not_accepted: "policy",
};

export type TimestampValidationRecord = {
  schema: "PROOVRA_TIMESTAMP_VALIDATION";
  version: 1;
  /** NOT_REQUESTED | PENDING | VALIDATED | RECORDED_NOT_VALIDATED | FAILED */
  status: string;
  trustState: string;
  statusLabel: string;
  tokenFile: string | null;
  tokenSha256: string | null;
  messageImprint: { hashAlgorithm: string | null; digestHex: string | null };
  /** The digest PROOVRA asked the authority to certify. */
  requestedDigestHex: string | null;
  /** Whether the token's imprint equals the evidence digest it should certify. */
  imprintMatchesEvidenceDigest: boolean | null;
  serialNumber: string | null;
  genTimeUtc: string | null;
  policyOid: string | null;
  signerCertificateSha256: string | null;
  tokenCertificateSha256: string[] | null;
  trustAnchor: { sha256: string[] | null; selectedBy: string };
  validatedAtUtc: string | null;
  checks: {
    signature: TsaCheckResult;
    certificateChain: TsaCheckResult;
    signerValidityAtGenTime: TsaCheckResult;
    messageImprint: TsaCheckResult;
    nonce: TsaCheckResult;
    policy: TsaCheckResult;
  };
  failureCode: string | null;
  qualifiedStatus: {
    evaluated: false;
    statement: string;
  };
  legalEffect: string;
};

export const TSA_QUALIFIED_STATUS_NOT_EVALUATED =
  "PROOVRA did not evaluate whether this timestamp authority's service was qualified (for example on an EU Trusted List under eIDAS) at the stamped time. No qualified status is claimed. A verifier who needs it must check the relevant trusted list for the service identified by the signer certificate above, as of the generation time.";

export const TSA_LEGAL_EFFECT_STATEMENT =
  "The legal effect of this timestamp depends on the jurisdiction and the context in which it is presented. This record states technical validation results only.";

export function buildTimestampValidationRecord(input: {
  tsaStatus: string | null | undefined;
  tsaValidatedAtUtc: Date | string | null | undefined;
  tsaFailureCode: string | null | undefined;
  tokenIncluded: boolean;
  tokenSha256: string | null;
  tsaHashAlgorithm: string | null | undefined;
  tsaMessageImprint: string | null | undefined;
  tsaInputDigestHex: string | null | undefined;
  evidenceDigestHex: string | null | undefined;
  tsaSerialNumber: string | null | undefined;
  tsaGenTimeUtc: Date | string | null | undefined;
  tsaPolicyOid: string | null | undefined;
  tsaSignerCertSha256: string | null | undefined;
  tokenPresent: boolean;
  evidence: TsaValidationEvidence | null;
}): TimestampValidationRecord {
  const iso = (v: Date | string | null | undefined) => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const presented = presentedTsaStatus({ tsaStatus: input.tsaStatus, tsaValidatedAtUtc: input.tsaValidatedAtUtc ?? null });
  const status = resolveTsaProofStatus({ tsaStatus: input.tsaStatus, tsaValidatedAtUtc: input.tsaValidatedAtUtc ?? null });
  const trust = resolveTsaTrustState({
    presentedStatus: presented,
    tokenPresent: input.tokenPresent,
    failureCode: input.tsaFailureCode ?? null,
    validatedAtUtc: input.tsaValidatedAtUtc ?? null,
  });
  const imprint = input.tsaMessageImprint?.toLowerCase() ?? null;
  const evidenceDigest = input.evidenceDigestHex?.toLowerCase() ?? null;

  let checks: TimestampValidationRecord["checks"];
  if (status === "VALIDATED") {
    checks = {
      signature: "PASSED",
      certificateChain: "PASSED",
      signerValidityAtGenTime: "PASSED",
      messageImprint: "PASSED",
      nonce: input.evidence ? (input.evidence.nonceChecked ? "PASSED" : "NOT_APPLICABLE") : "NOT_RECORDED",
      policy: input.evidence ? (input.evidence.policyAllowlistEnforced ? "PASSED" : "NOT_EVALUATED") : "NOT_RECORDED",
    };
  } else {
    const all: TsaCheckResult = "NOT_EVALUATED";
    checks = { signature: all, certificateChain: all, signerValidityAtGenTime: all, messageImprint: all, nonce: all, policy: all };
    const code = String(input.tsaFailureCode ?? "");
    const failed = FAILED_CHECK[code];
    if (failed) checks[failed] = "FAILED";
    if (code === "tsa_trust_anchor_not_configured" || code === "tsa_trust_anchor_refused") {
      checks.certificateChain = "UNAVAILABLE";
    }
  }

  return {
    schema: "PROOVRA_TIMESTAMP_VALIDATION",
    version: 1,
    status,
    trustState: trust.state,
    statusLabel: trust.label,
    tokenFile: input.tokenIncluded ? "timestamp.tsr" : null,
    tokenSha256: input.tokenIncluded ? input.tokenSha256 : null,
    messageImprint: { hashAlgorithm: input.tsaHashAlgorithm ?? null, digestHex: imprint },
    requestedDigestHex: input.tsaInputDigestHex?.toLowerCase() ?? null,
    imprintMatchesEvidenceDigest: imprint && evidenceDigest ? imprint === evidenceDigest : null,
    serialNumber: input.tsaSerialNumber ?? null,
    genTimeUtc: iso(input.tsaGenTimeUtc),
    policyOid: input.tsaPolicyOid ?? null,
    signerCertificateSha256: input.tsaSignerCertSha256?.toLowerCase() ?? null,
    tokenCertificateSha256: input.evidence ? input.evidence.tokenCertificateSha256 : null,
    trustAnchor: {
      sha256: input.evidence ? input.evidence.trustAnchorSha256 : null,
      selectedBy:
        "PROOVRA validated against the trust anchor configured for its environment. A bundled or listed root is not trustworthy merely because it appears here: verify the chain against a trust store you select.",
    },
    validatedAtUtc: status === "VALIDATED" ? iso(input.tsaValidatedAtUtc) : null,
    checks,
    failureCode: status === "VALIDATED" ? null : input.tsaFailureCode ?? null,
    qualifiedStatus: { evaluated: false, statement: TSA_QUALIFIED_STATUS_NOT_EVALUATED },
    legalEffect: TSA_LEGAL_EFFECT_STATEMENT,
  };
}
