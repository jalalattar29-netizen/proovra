# PROOVRA Offline Verification Result Schema

**Schema version:** `PROOVRA_OFFLINE_VERIFICATION_RESULT_V1`.

The CLI and browser verifier both produce a single envelope conforming to this schema. Every field uses bounded enums.

```ts
type OfflineVerificationResult = {
  schemaVersion: "PROOVRA_OFFLINE_VERIFICATION_RESULT_V1";
  verifiedAtUtc: string;
  summary: string; // ≤240 chars, bounded vocabulary
  package: {
    status: "verified" | "partial" | "failed" | "unsupported";
    checksumsStatus: "verified" | "mismatch" | "missing_index" | "unsupported";
    manifestStatus: "verified" | "schema_invalid" | "missing" | "unsupported";
    signatureStatus: "verified" | "failed" | "missing" | "unsupported";
    filesIndexed: number;
    extraFiles: number;
    checksumFailures: Array<{
      path: string;
      reason: "missing" | "sha256_mismatch" | "unreadable";
    }>;
  };
  artifactIntegrity: {
    status: "verified" | "failed" | "missing" | "unsupported";
    itemsChecked: number;
    failures: Array<{
      path: string;
      reason: "missing_file" | "sha256_mismatch" | "missing_recorded_hash";
    }>;
  };
  reportSignature: {
    status: "verified" | "failed" | "missing" | "unsupported";
    detail:
      | "missing"
      | "embedded_pdf_signature_external_tool_required"
      | "package_manifest_signature_verified_separately"
      | "verified"
      | "unsupported"
      | null;
  };
  custodyAttestations: {
    status: "verified" | "partial" | "missing" | "failed" | "unsupported";
    attestationsExpected: number;
    attestationsChecked: number;
    attestationsVerified: number;
    failures: Array<{
      custodyEventId: string;
      reason:
        | "missing_signer_material"
        | "unsupported_algorithm"
        | "signature_invalid"
        | "payload_hash_mismatch_with_recompute_skipped";
    }>;
    canonicalPayloadRecomputeAvailable: boolean;
  };
  timestamping: {
    tsaStatus: "verified" | "missing" | "failed" | "unsupported";
    otsStatus: "verified" | "pending" | "missing" | "failed" | "unsupported";
    tsaDetail:
      | "missing"
      | "rfc3161_external_verification_required"
      | "verified"
      | "unsupported"
      | null;
    otsDetail:
      | "missing"
      | "calendar_network_required"
      | "verified"
      | "pending"
      | "unsupported"
      | null;
  };
  overall: {
    status: "verified" | "partial" | "failed";
    warnings: Array<WarningCode>;
    limitations: Array<LimitationCode>;
  };
};
```

## Bounded warning codes

`PACKAGE_MANIFEST_MISSING`, `PACKAGE_SIGNATURE_MISSING`, `PACKAGE_PUBLIC_KEY_MISSING`, `EXTRA_FILES_NOT_IN_CHECKSUMS`, `CHECKSUMS_MISSING_FILE`, `ATTESTATIONS_FILE_MISSING`, `ATTESTATIONS_DEGRADED`, `ATTESTATIONS_PARTIAL_COVERAGE`, `SIGNER_SNAPSHOT_MISSING`, `TSA_PROOF_MISSING`, `OTS_PROOF_MISSING`, `ARTIFACT_HASH_MISSING_FROM_PACKAGE`, `REPORT_SIGNATURE_MISSING`, `REPORT_SIGNATURE_UNSUPPORTED_FORMAT`, `PRE_P3_1_1_PACKAGE_DETECTED`, `STRICT_MODE_DEGRADED`.

## Bounded limitation codes

`TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION`, `OTS_REQUIRES_BITCOIN_NETWORK`, `AWS_KMS_SIGNATURE_REQUIRES_PUBLIC_KEY`, `EMBEDDED_PDF_SIGNATURE_REQUIRES_EXTERNAL_TOOL`, `NO_LEGAL_ADMISSIBILITY_CLAIM`, `NO_AUTHORSHIP_CLAIM`, `VERIFIER_CANNOT_RECOMPUTE_CANONICAL_PAYLOAD_WITHOUT_CUSTODY_EVENT_DATA`.

The verifier ALWAYS includes `NO_LEGAL_ADMISSIBILITY_CLAIM` and `NO_AUTHORSHIP_CLAIM`. These are not editorial; they are part of the bounded schema.

## Result semantics

- `overall.status === "failed"` if and only if `package.status === "failed"` OR `artifactIntegrity.status === "failed"`.
- `overall.status === "verified"` only if `package.status === "verified"` AND `custodyAttestations.status` is `verified` or `missing`. (Missing attestations from a pre-P3.1.1 package do NOT downgrade an otherwise-clean overall to failed; they leave it as `verified` only when the rest of the package verified.)
- All other outcomes are `partial`.

## What this verifier never reports

- No free-form `error.message` strings.
- No PROOVRA-internal URLs.
- No customer evidence content.
- No legal-admissibility or authenticity claim.
