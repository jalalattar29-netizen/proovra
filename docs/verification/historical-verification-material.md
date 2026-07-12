# Historical Verification Material (Phase M1.1)

**Status:** introduced in PROOVRA Phase M1.1 (additive, optional).
**File:** `signers/historical-verification-material.json` inside the Verification Package ZIP.

---

## 1. Why this file exists

Before M1.1, the Verification Package referenced the signer's public material indirectly through `signers/signer-registry-snapshot.json` but did not bundle the actual public key bytes. That meant an independent reviewer could verify package integrity (hash chain, manifest signature) but could NOT independently verify the custody attestation signatures inside the package without contacting the live PROOVRA deployment.

M1.1 closes that gap by embedding **bounded public verification material** at package generation time:

- The signer's PUBLIC key (Ed25519 SPKI PEM, or KMS-exported PEM) at the moment the package was signed.
- Bounded metadata: signer id, purpose, provider, key id, key version, algorithm, signer status at signing time.
- An explicit "historical only" interpretation contract.

The file is **never** authoritative for current trust. It is a frozen snapshot — the equivalent of a notary archiving the public key that was in use when a document was sealed.

## 2. What the file looks like

```jsonc
{
  "schemaVersion": "1.0.0",
  "fileType": "proovra.historical-verification-material",
  "generatedAtUtc": "2026-05-28T17:34:00.000Z",
  "packageId": null,
  "evidenceId": "ev_...",
  "signers": [
    {
      "signerId": "...",
      "purpose": "package_manifest",
      "provider": "aws_kms" | "local_pem" | "unsupported",
      "keyId": "...",
      "keyVersion": "...",
      "algorithm": "ED25519_SHA_512" | "RSA_SHA_256" | ...,
      "signerStatusAtSigningTime": "active" | "degraded" | "unknown",
      "verificationMaterial": {
        "type": "ed25519_spki_pem" | "kms_public_key_pem" | "unsupported",
        "pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
        "generatedFrom": "aws_kms.GetPublicKey" | "local_pem_file" | "unavailable",
        "historicalOnly": true
      }
    }
  ],
  "trustInterpretation": {
    "statement": "This file captures signing-time public material only. It does NOT imply that the signer is currently trusted. Rotation, revocation, and key degradation are operational events that this file cannot observe.",
    "boundedCodes": [
      "HISTORICAL_ONLY",
      "DOES_NOT_IMPLY_CURRENT_TRUST",
      "ROTATION_AWARE",
      "REVOCATION_NOT_CHECKED"
    ]
  },
  "revocationAwareness": {
    "checkedAtGenerationTime": false,
    "note": "Consumers must treat current revocation status as unknown."
  }
}
```

Every enum is bounded. Free-form strings appear only in the `statement` and `note` fields and never carry semantics.

## 3. Generation contract

`services/worker/src/verification-package-historical-material.ts` builds the file. The contract:

1. **Public material only.** The function NEVER reads the private key. Only `aws_kms.GetPublicKey` or the published local PEM is consulted.
2. **Best-effort, additive.** If public material cannot be extracted (KMS error, missing PEM, unsupported algorithm), the entry falls back to a `degradedFile()` shape with `verificationMaterial.type = "unsupported"`. Package generation NEVER fails because of this file.
3. **Deterministic ordering.** Signers are emitted in registry-canonical order so the file is byte-reproducible.
4. **Appended before checksums.** The file is appended to the ZIP before `package-checksums.json` so its SHA-256 is recorded by the checksum step.
5. **OpenTelemetry span.** Wrapped in `proovra.package.historical_material.generate` with bounded attributes; no key material is logged.

## 4. Consumer contract

Independent consumers read the file via the `historicalMaterial` path entry and:

- Classify `historicalVerification.status` as one of:
  - `verified` — every bundled entry has type ≠ `unsupported`.
  - `partial` — some entries are `unsupported`; warning `HISTORICAL_VERIFICATION_PARTIAL_COVERAGE` raised.
  - `unsupported` — every entry is `unsupported`; warning `HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM` raised.
  - `missing` — file not present (legacy packages); warning `HISTORICAL_VERIFICATION_MATERIAL_MISSING` raised.
  - `failed` — schema parse failure.
- Always also reports `currentTrustStatus.status = "unknown"`, regardless of historical status.
- Always injects three standing limitations into the top-level `overall.limitations[]`:
  - `HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST`
  - `CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE`
  - `SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING`

These limitations exist on EVERY result so the historical/current distinction can never silently disappear, even if a future bug stops emitting the snapshot.

## 5. Security non-claims

This file makes none of the following claims and consumers must not infer them:

- It does NOT claim the signer is currently trusted.
- It does NOT claim the key has not been rotated.
- It does NOT claim the key has not been revoked.
- It does NOT claim legal admissibility.
- It does NOT claim authorship of the underlying content.

## 6. Backward compatibility

Packages generated before M1.1 do not contain this file. Consumers observe `historicalVerification.status = "missing"` and surface `HISTORICAL_VERIFICATION_MATERIAL_MISSING` — never as a failure. Old packages remain fully verifiable.

## 7. Related documents

- `docs/security/signer-governance.md` — current-trust API and rotation/revocation operational guidance.
- `docs/verification/phase-m1-1-convergence-closure.md` — closure report for Phase M1.1.
