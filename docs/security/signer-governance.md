# Signer Governance (Phase P3.1)

**Audience:** IT security admins + procurement reviewers.

**Canonical path:** `/operations/signers`.

---

## 1. What this surface gives operators

A single screen that answers, per artifact kind:

- Which signer is currently active.
- What provider it uses (AWS KMS / local PEM / disabled).
- Whether the provider is healthy right now.
- What's staged for the next rotation.
- A full audit timeline of past rotations + health checks.

Plus a custody-attestation panel for verifying detached attestations and triggering bounded-batch backfills.

## 2. The registry is a read-model

P3.1 does not introduce a dedicated `Signer` Prisma table. The registry is a deterministic projection:

| Field | Source |
| --- | --- |
| Current active signer per purpose | env vars (`SIGNER_PROVIDER`, `SIGNING_KEY_ID`, `SIGNING_KEY_VERSION`, `PACKAGE_SIGNING_KEY_ID`, `PACKAGE_SIGNING_KEY_VERSION`, `KMS_KEY_ID`) |
| Staged signers / rotation history | `SecurityEvent` rows with event types `signer_staged` / `signer_promoted` / `signer_retired` / `signer_revoked` |

This means:
- Promoting a staged signer **does not automatically swap env vars**. The promote audit event records operator intent; the actual operational rollover happens at the next deploy with the new env vars in place.
- Historical artifacts (`Report.pdfSignerKeyId`, `VerificationPackage` signing fields) are **never mutated** by any P3.1 action.

## 3. Bounded enums

- **Purposes** (4): `report_pdf`, `verification_package`, `export_manifest`, `custody_event`.
- **Providers** (3): `aws_kms`, `local_pem`, `disabled`.
- **Statuses** (6): `active`, `staged`, `retiring`, `retired`, `revoked`, `degraded`.
- **Health states** (8): `healthy`, `degraded`, `unreachable`, `permission_denied`, `key_disabled`, `region_mismatch`, `unsupported_algorithm`, `unknown`.

## 4. Step-up gating

| Action | Step-up purpose |
| --- | --- |
| Promote staged signer | `SIGNER_PROMOTE` |
| Retire signer | `SIGNER_RETIRE` |
| Revoke signer | `SIGNER_REVOKE` |
| Custody attestation backfill | `CUSTODY_ATTESTATION_BACKFILL` |

All four require a non-empty `reason` (bounded to 240 chars).

## 5. Backend contract

| Method | Path | Step-up |
| --- | --- | --- |
| GET | `/v1/operations/signers?teamId` | — |
| GET | `/v1/operations/signers/:id?teamId` | — |
| GET | `/v1/operations/signers/:id/health?teamId` | — |
| GET | `/v1/operations/signers/:id/audit?teamId` | — |
| POST | `/v1/operations/signers/stage` | — |
| POST | `/v1/operations/signers/:id/preview` | — |
| POST | `/v1/operations/signers/:id/promote` | `SIGNER_PROMOTE` |
| POST | `/v1/operations/signers/:id/retire` | `SIGNER_RETIRE` |
| POST | `/v1/operations/signers/:id/revoke` | `SIGNER_REVOKE` |

## 6. KMS health probe

The probe issues `GetPublicKeyCommand` against the configured `KMS_KEY_ID`. It returns one of the 8 bounded states; the `recommendedAction` field is operator-facing and never carries a raw AWS error message.

The probe NEVER includes:
- IAM role ARNs
- AWS access key material
- KMS key policy text
- Raw error stacks

It MAY include:
- The bounded health state
- Algorithm string (e.g. `ED25519_SHA_512`)
- A `kms://GetPublicKey` material reference

## 7. Local-dev fallback

- `SIGNER_PROVIDER=local-pem` with `SIGNING_PRIVATE_KEY_PATH` + `SIGNING_PUBLIC_KEY_PATH` is fully supported. The probe checks file existence.
- `SIGNER_PROVIDER=disabled` returns the `degraded` health state. Useful for tests.
- AWS is NEVER required for local dev.

## 8. Migration plan (when DB-backed registry is needed)

If a future requirement demands a queryable `Signer` table (e.g. cross-workspace rotation coordination, per-environment overrides, key fingerprint indexing), the migration is:

1. Add `Signer` Prisma model with the fields enumerated in P3.1's spec §2.
2. Backfill from env (current active) + audit events (staged history).
3. Switch the registry service to read from the table.
4. Keep env as a deployment-time fallback when the table is empty.

The read-model approach today guarantees no migration risk; the bounded enums + service interface are stable for the future move.

## 9. Honest scope

- The registry does NOT prove cryptographic admissibility of any artifact.
- The registry does NOT claim historical artifacts are tamper-proof — that property comes from S3 Object Lock + custody-chain hashing, not from this surface.
- Promote / retire / revoke transitions are **audit events**, not cryptographic key operations. Rotating the actual key material happens at the deployment / KMS layer.

## 10. Historical vs current trust (Phase M1.1)

Phase M1.1 introduced `signers/historical-verification-material.json` inside the Verification Package — a frozen snapshot of the **public** signing material that was active when the package was generated. This intersects with signer governance in three ways:

1. **Historical material is generated from this surface.** The worker calls `aws_kms.GetPublicKey` (or reads the published local PEM) at package-build time and bundles ONLY the public bytes. The private key never leaves AWS KMS / the operator's secure key store. See `services/worker/src/verification-package-historical-material.ts`.

2. **Current trust is NOT in the package.** The offline verifier always reports `currentTrustStatus.status = "unknown"`. Rotation, retirement, and revocation events happen here in `/operations/signers` and can only be observed by contacting the live deployment. The package CANNOT carry a "currently trusted" claim because that would be stale the moment the next rotation happens.

3. **Operator responsibility on rotation/revoke.** Once a signer is `retired` or `revoked` in this registry, packages generated BEFORE that event still contain the historical public material and remain offline-verifiable against their signing-time signer. They do NOT retroactively become invalid. Reviewers wanting to know "is the signer that signed this package currently trusted?" must call the live signer registry via `GET /v1/operations/signers` (or `/operations/signers/:id`) and inspect the `status` field for the matching `keyId`. The bounded current statuses (`active`, `staged`, `retiring`, `retired`, `revoked`, `degraded`) live in this surface; the offline package cannot carry them.

4. **Honest non-claim.** Bundling historical material does NOT imply we vouch for the signer in perpetuity. The package documents what was true at signing time; current trust is always a live question.

The full schema and verifier contract for historical material live in `docs/verification/historical-verification-material.md`.
