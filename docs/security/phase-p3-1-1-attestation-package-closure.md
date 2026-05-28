# Phase P3.1.1 — Verification Package Attestation Closure Report

**Audience:** product engineers, ops, procurement.

---

## 1. Package changes

Every newly generated Verification Package now includes three additional files. Pre-P3.1.1 packages are unchanged — the new files are purely additive.

| Path | Format | Source |
| --- | --- | --- |
| `custody/attestations.json` | JSON v1 | `services/worker/src/verification-package-attestations.ts` |
| `custody/attestation-verification.md` | Markdown | same |
| `signers/signer-registry-snapshot.json` | JSON v1 | same |

The existing `package-checksums.json` automatically lists these new files with their SHA-256.

## 2. New files (deterministic content)

### custody/attestations.json
Schema: `PROOVRA_CUSTODY_ATTESTATIONS` v1. Contains the bounded attestation set sorted by `custodyEventSequence ASC`, plus `missingAttestations` for events without coverage. Caps at 5000 entries. The bounded `degradedReason` enum is the honest signal for total coverage failure.

### custody/attestation-verification.md
Step-by-step external-verifier procedure. References the canonical payload projection, the bounded outcome model, and the explicit "no legal admissibility" disclosure.

### signers/signer-registry-snapshot.json
Schema: `PROOVRA_SIGNER_REGISTRY_SNAPSHOT` v1. Exactly 4 signer entries (one per purpose, fixed order), plus a `health` block with bounded overall + reason enum. Reflects env state at package generation time.

## 3. Manifest integration

The existing `package-manifest.json` schema is NOT modified. The new files surface through `package-checksums.json` (the canonical index every package already publishes). Each new file appears with `path`, `sizeBytes`, `sha256`, and `contentType` — same format as every other file in the ZIP.

## 4. Signer snapshot summary

Built from env vars at package-generation time:
- `SIGNER_PROVIDER` decides `provider` (`aws_kms` | `local_pem` | `disabled`).
- `SIGNING_KEY_ID` / `SIGNING_KEY_VERSION` + `PACKAGE_SIGNING_KEY_ID` / `PACKAGE_SIGNING_KEY_VERSION` populate each signer's `keyId` / `keyVersion`.
- `KMS_KEY_ID` populates `kmsKeyArn` for AWS KMS only.
- Health overall is `healthy` when env is consistent, `degraded` on misconfiguration (with a bounded `reason`), `unavailable` when `provider=disabled`.

Never includes raw KMS credentials, private PEM contents, or AWS access keys.

## 5. Attestation inclusion policy

- **Best-effort default.** Generation continues when attestation lookup fails; `degradedReason` is recorded inside `attestations.json`.
- **Strict mode** via `VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true`. Generation throws `AttestationStrictModeFailureError` when degraded.
- The strict-mode failure path captures a Sentry exception (operator-safe context: `packageKind` only) and emits the bounded `package_attestation_generation_failure_total` metric.

## 6. Strict / degraded mode

| Mode | Env | Behaviour on degraded |
| --- | --- | --- |
| Best-effort | unset (default) | Package generation succeeds; `degradedReason` set in JSON. |
| Strict | `VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true` | Package generation throws `AttestationStrictModeFailureError`. |

## 7. Offline verification compatibility

- Pre-existing offline-verifier scripts in older packages are NOT modified by P3.1.1.
- New packages' offline verifier (the one generated inside the ZIP — see `verification-package.ts`) is unchanged. It does not depend on the new attestation files.
- A verifier that wants to validate attestations follows `custody/attestation-verification.md`.

## 8. Observability changes

### OTEL spans
- `proovra.package.attestations.collect` — wraps the attestations + signer-snapshot + readme build.
- `proovra.package.signer_snapshot.generate` — wraps the signer-snapshot generation.

Allowed attributes: `operation`, `status`, `attestationCount`, `missingCount`, `packageKind`, `signerPurpose`, `durationMs`.

### Sentry breadcrumbs / exceptions
- `captureException()` called with bounded operator-safe context (`stage`, `packageKind`) on:
  - Attestation collection failure.
  - Signer snapshot generation failure.
  - Strict-mode failure.

Never includes: signatures, private keys, KMS credentials, evidence content, raw custody payloads.

### New audit events
- `verification_package_attestations_included`
- `verification_package_attestations_degraded`
- `verification_package_attestations_missing`
- `signer_snapshot_included`
- `package_attestation_verification_failed`

### New metric keys
- `package_attestations_included_total`
- `package_attestations_degraded_total`
- `package_attestations_missing_total`
- `signer_snapshot_included_total`
- `package_attestation_generation_failure_total`

## 9. Tests

- `services/worker/test/phase-p3-1-1-package-attestation-closure.test.ts` — **24 source-contract tests**.
- API typecheck: clean. Worker typecheck: clean.

## 10. Remaining blockers

**None.** Every acceptance line is met:

- ✅ New Verification Packages include custody attestations.
- ✅ New Verification Packages include signer registry snapshot.
- ✅ Package manifest references attestation files (via `package-checksums.json`).
- ✅ Degraded + strict modes exist and are documented.
- ✅ Existing package verification compatibility preserved (additive only).
- ✅ No sensitive material leaks (verified by test).
- ✅ OTEL spans actually wired.
- ✅ Sentry breadcrumbs scrubbed.
- ✅ Tests + docs + closure report exist.

## 11. Explicit acceptance confirmation

| Rule | Confirmed |
| --- | --- |
| Existing package format not broken | ✅ — additive-only invariant enforced by test |
| Existing offline verification still works | ✅ — no existing path renamed; checksums index automatic |
| New attestation files are additive | ✅ |
| No private keys included | ✅ — test asserts |
| No custody event rewritten | ✅ — canonical projection is read-only |
| No historical artifacts mutated | ✅ |
| No fake attestation claim | ✅ — degraded state explicit |
| No legal overclaim | ✅ — test verifies absence of forbidden phrases |
| P3.1.1 fully closed | ✅ |

Phase P3.1.1 is closed.
