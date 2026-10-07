# Verification Package Format (post-P3.1.1, post-M1.1, post-M2)

**Audience:** anyone unpacking a PROOVRA Verification Package and verifying its contents independently with standard tooling.

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
  "packageId": "<uuid>",            // null only on packages issued before 2026-10-07
  "signers": [
    {
      "signerPurpose": "report_pdf",
      "signerId": "report_pdf:aws_kms:<keyId>:<keyVersion>",
      "provider": "aws_kms",
      "keyId": "<keyId>",
      "keyVersion": "<keyVersion>",
      "algorithm": "ED25519_SHA_512",
      "status": "active",
      "verificationMaterialRef": "package-manifest-public-key.pem",
      "kmsKeyArn": null                 // never emitted since 2026-10-07 (account id, region)
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

- Downstream tooling that ignores unknown files keeps working unchanged.
- A verifier that wants to check the new files MAY look for them; absence is not a failure.
- The canonical existing files (`package-manifest.json`, `package-manifest.sig`, `package-manifest-public-key.pem`, `evidence/`, `custody/`, `package-checksums.json`) are unchanged in name, content schema, and append order.

## 7. Honest limitations

- Attestations carry cryptographic continuity ONLY. They do NOT prove evidence authenticity, operator identity, or anything legally admissible.
- Attestations require the signer's public material to remain published. Destroying old public keys after rotation makes old attestations unverifiable.
- The attestation set is bounded — `attestations[]` caps at 5000 entries. Larger custody chains require operator backfill via the api's `/v1/operations/custody-attestations/backfill` route.

## 8. Package identity, supersession and the certified digest (2026-10-07)

- **`packageId`** is minted by the worker before any document is built and is the `verification_packages` row id. The same value appears in `package-manifest.json`, `package-seal.json`, `package-mode.json`, `custody/attestations.json`, both `signers/*` files, `disclosure-manifest.json` and the README. A retried build that never committed leaves no id behind; a committed package's id never changes.
- **Supersession.** `package-manifest.json → supersedesPackage` and `package-seal.json → supersedesPackageId` name the package of the previous report version. The earlier package is never modified.
- **Certified digest.** `package-manifest.json → evidenceFileSha256` is the digest the evidence signature's fingerprint and the RFC 3161 token certify (single file: SHA-256 of the file; multipart: see `evidenceFileSha256Semantics`). The README states it and quotes it in its commands.
- **Consistency gate.** `validatePackageConsistency` (`@proovra/shared`) runs over every package before it is sealed; any contradiction between documents fails generation.

## 9. Disclosure profiles

One generator, one seal and signer, two projections per report version:

| Profile | Carries | For |
| --- | --- | --- |
| `FULL_FORENSIC` | originals, the issued report, complete custody payloads, identity/device details, storage/version facts, every verification material | authorized custodians and investigators — requires `evidence.download_package` **and** `evidence.download_original` |
| `EXTERNAL_DISCLOSURE` | every cryptographic commitment (file digests, fingerprintHash, signature, RFC 3161 token, OTS proof, custody hash chain, report digest); emails, internal ids, storage/KMS/server paths, network/device identifiers and map links removed; coordinates rounded to 2 decimals; originals, the report and `fingerprint.json` withheld with their SHA-256 | sharing outside the workspace — `evidence.download_package`, or an EVIDENCE-scope external review grant with package download |

`disclosure-manifest.json` lists every withheld file and every withheld or coarsened field, with its reason. An `EXTERNAL_DISCLOSURE` seal has `reportFile: null` and verifies as `REPORT_COMMITTED_WITHHELD`. Redacted custody payloads cannot be re-hashed to their `eventHash`; chain links remain checkable. Packages issued before profiles are labelled **LEGACY** and never relabelled.

## 10. `timestamp-validation.json`

What PROOVRA's RFC 3161 validation established for the record's token: status and canonical trust state, message imprint and whether it equals the evidence digest, serial, genTime, policy OID, signer and token-certificate fingerprints, the trust anchor PROOVRA used, validation time, per-check results (`PASSED` / `FAILED` / `NOT_EVALUATED` / `NOT_APPLICABLE` / `NOT_RECORDED` / `UNAVAILABLE`) and the failure code. `qualifiedStatus.evaluated` is always `false`: PROOVRA does not evaluate EU Trusted List (qualified) status and claims none. A verifier validates the chain against a trust store they select.

## 11. Binding a package to PROOVRA (public, unauthenticated)

| Endpoint | Returns |
| --- | --- |
| `GET /public/signing-keys` | every registered key: id, version, SPKI SHA-256 fingerprint, `ACTIVE` / `SUPERSEDED` / `REVOKED`, validity interval, successor. Public keys only; revoked and superseded keys stay listed. |
| `GET /public/verification-packages/:packageId` | one package's record: profile, report version, package and seal SHA-256, seal-key fingerprint and its registry status (`BOUND`, `BOUND_KEY_REVOKED`, `KEY_NOT_PUBLISHED`, `NOT_SEALED`), supersession links |
| `GET /public/verification-packages/by-sha256/:sha256` | the same, for the SHA-256 of the exact ZIP held (works for legacy packages) |

The human page is `<REPORT_VERIFY_BASE_URL>/package/<packageId>` (named in the README). These reads return no evidence content and do not publish the evidence record. They are rate-limited per client and per lookup key, `Cache-Control: no-store`, and answer one bounded 404 for unknown and malformed ids. If a package is not listed, or the record is unreachable, external key binding is unavailable and the package's attribution to PROOVRA cannot be confirmed from outside it.
