# Verification Package Format (post-P3.1.1, post-M1.1, post-M2)

**Audience:** anyone unpacking a PROOVRA Verification Package and verifying its contents offline.

---

## 1. Stability promise

Existing files retain their canonical paths and content. Each phase only **adds** new files (existing ZIPs from before those phases do not have them, and their absence is not a failure):

| Path | Purpose | Content type | Schema | Phase |
| --- | --- | --- | --- | --- |
| `custody/attestations.json` | Detached cryptographic attestations over each custody event's canonical payload | `application/json` | `PROOVRA_CUSTODY_ATTESTATIONS` v1 | P3.1.1 |
| `custody/attestation-verification.md` | Step-by-step external-verifier procedure | `text/markdown` | n/a | P3.1.1 |
| `signers/signer-registry-snapshot.json` | Signer state at package generation time | `application/json` | `PROOVRA_SIGNER_REGISTRY_SNAPSHOT` v1 | P3.1.1 |
| `signers/historical-verification-material.json` | Bounded public signing-time material | `application/json` | `PROOVRA_HISTORICAL_VERIFICATION_MATERIAL` v1 | M1.1 |

The `package-checksums.json` index automatically lists every new file (the canonical SHA-256 source of truth for every file in the ZIP). We do **NOT** emit separate `.sha256` companions — the checksums index is the single source.

## 2. `custody/attestations.json` shape

```jsonc
{
  "schemaVersion": 1,
  "schema": "PROOVRA_CUSTODY_ATTESTATIONS",
  "generatedAtUtc": "2026-05-28T10:00:00.000Z",
  "evidenceId": "<uuid>",
  "packageId": null,
  "custodyEventsCount": 12,
  "attestationsCount": 11,
  "attestations": [
    {
      "custodyEventId": "<uuid>",
      "custodyEventSequence": 1,
      "canonicalPayloadHash": "<hex>",
      "signature": "<base64>",
      "algorithm": "ED25519_SHA_512",
      "signerId": "custody_event:aws_kms:<keyId>:<keyVersion>",
      "keyId": "<keyId>",
      "keyVersion": "<keyVersion>",
      "provider": "aws_kms",
      "signedAtUtc": "...",
      "verificationStatus": "pending",
      "verificationError": null
    }
    // ... sorted by custodyEventSequence ASC
  ],
  "missingAttestations": [
    {
      "custodyEventId": "<uuid>",
      "custodyEventSequence": 7,
      "reason": "no_attestation_recorded"
    }
  ],
  "degradedReason": null,
  "verificationInstructionsRef": "custody/attestation-verification.md",
  "scope": "These detached attestations cryptographically link the recorded signer to a hash of the canonical custody payload. They do NOT carry a legal-admissibility assertion."
}
```

### Bounded enums

- `degradedReason`: `null` | `"no_attestations_recorded"` | `"custody_events_unreachable"` | `"attestation_lookup_failed"`
- `missingAttestations[].reason`: `"no_attestation_recorded"` | `"attestation_envelope_malformed"`
- `verificationStatus`: `"verified"` | `"pending"` | `"invalid"`
- `provider`: `"aws_kms"` | `"local_pem"`
- `algorithm`: `"ED25519_SHA_512"` (for `aws_kms`) | `"ED25519"` (for `local_pem`)

## 3. `signers/signer-registry-snapshot.json` shape

```jsonc
{
  "schemaVersion": 1,
  "schema": "PROOVRA_SIGNER_REGISTRY_SNAPSHOT",
  "generatedAtUtc": "...",
  "evidenceId": "<uuid>",
  "packageId": null,
  "signers": [
    {
      "signerPurpose": "report_pdf",
      "signerId": "report_pdf:aws_kms:<keyId>:<keyVersion>",
      "provider": "aws_kms",
      "keyId": "<keyId>",
      "keyVersion": "<keyVersion>",
      "algorithm": "ED25519_SHA_512",
      "status": "active",
      "verificationMaterialRef": "kms://GetPublicKey",
      "kmsKeyArn": "<operator-safe-kms-arn-or-alias>"
    }
    // verification_package, export_manifest, custody_event follow in
    // fixed order
  ],
  "health": {
    "overall": "healthy",
    "checkedAtUtc": "...",
    "reason": null
  }
}
```

### Bounded enums

- `health.overall`: `"healthy"` | `"degraded"` | `"unavailable"`
- `health.reason`: `null` | `"provider_disabled"` | `"kms_key_id_unset"` | `"missing_pem_path"` | `"unknown_error"`

## 4. Strict vs best-effort mode

- **Best-effort (default).** Package generation succeeds even when attestations are unavailable. `custody/attestations.json` carries a `degradedReason` so the consumer sees the honest state.
- **Strict.** Set `VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true` on the worker. Package generation throws `AttestationStrictModeFailureError` when attestations are degraded, and the worker job fails.

Strict mode is opt-in. We do NOT recommend enabling it unless the workspace's procurement contract requires it.

## 5. Deterministic ordering

- `attestations[]` ordered by `custodyEventSequence ASC`.
- `missingAttestations[]` ordered by `custodyEventSequence ASC`.
- `signers[]` ordered by purpose: `report_pdf`, `verification_package`, `export_manifest`, `custody_event`.
- `package-checksums.json` `files[]` is sorted by `path` (canonical existing behaviour).

## 6. Compatibility with pre-P3.1.1 packages

- An offline verifier that ignores unknown files keeps working unchanged.
- A verifier that wants to check the new files MAY look for them; absence is not a failure.
- The canonical existing files (`package-manifest.json`, `package-manifest.sig`, `package-manifest-public-key.pem`, `evidence/`, `custody/`, `package-checksums.json`) are unchanged in name, content schema, and append order.

## 7. Honest limitations

- Attestations carry cryptographic continuity ONLY. They do NOT prove evidence authenticity, operator identity, or anything legally admissible.
- Attestations require the signer's public material to remain published. Destroying old public keys after rotation makes old attestations unverifiable.
- The attestation set is bounded — `attestations[]` caps at 5000 entries. Larger custody chains require operator backfill via the api's `/v1/operations/custody-attestations/backfill` route.
