# PROOVRA Offline Verifier

**Audience:** anyone who has received a PROOVRA Verification Package and wants to verify it without logging into PROOVRA.

---

## 1. What the verifier is

Three surfaces, same bounded algorithm:

| Surface | How to run | Use when |
| --- | --- | --- |
| **CLI** (Node) | `npx @proovra/offline-verifier package.zip` | Scripted / CI / forensic-lab workflows |
| **Browser** (static page) | Open `apps/offline-verifier/index.html` locally | One-shot ad-hoc verification, no Node installed |
| **Public web mount** (Next.js) | Browse to `<deployment>/offline-verifier` | No-install, no-login, drag-and-drop from any browser (Phase M1.1) |

All three run **entirely on your machine**. The browser surfaces NEVER upload the package; the CLI never calls PROOVRA APIs. The public web mount loads the page shell from the PROOVRA deployment but the verification algorithm — including all hashing and signature checks — runs inside the browser. The bytes of the ZIP never leave your device.

## 2. What is verified offline

- `package-checksums.json` — every file's SHA-256 recomputed and compared.
- `package-manifest.json` — schema sanity.
- `package-manifest.sig` — Ed25519 signature over the manifest hash, verified with the bundled `package-manifest-public-key.pem`.
- `custody/attestations.json` — structural integrity of every detached attestation envelope (P3.1.1).
- `signers/signer-registry-snapshot.json` — shape sanity.
- `signers/historical-verification-material.json` — historical signing-time public material bundle (M1.1). Surfaces `historicalVerification.status` when present.
- `provenance/c2pa-summary.json` — bounded C2PA provenance summary (M2). Surfaces `c2pa.status` + `c2pa.validationStatus`. The offline verifier NEVER runs external C2PA cryptographic validation.
- `timestamps/tsa.tsr` + `opentimestamps-proof.ots` — presence + bounded structural sanity.

## 3. What is NOT verified offline (honest limitations)

- **RFC3161 TSA signature chain** — requires the TSA's certificate chain. Use an RFC3161-capable tool with the published cert.
- **OpenTimestamps Bitcoin anchor** — requires the OpenTimestamps client (`ots verify`) and Bitcoin network access.
- **Custody attestation signatures** — the signer's public material is REFERENCED from the snapshot but not bundled. Use the PROOVRA API endpoint `POST /v1/operations/custody-attestations/:id/verify` when bound to the live deployment.
- **Embedded PDF signature** — use a PDF-signing toolchain.
- **Current signer trust status (M1.1)** — `currentTrustStatus.status` is ALWAYS `unknown` offline. Rotation, revocation, and degradation events cannot be observed without contacting the live PROOVRA signer registry. See §8.
- **C2PA cryptographic validation (M2)** — The offline verifier does NOT bundle C2PA validation tooling. Even when the bundled summary reports `valid`, the verifier surfaces the standing limitation `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE`. Use `c2patool` or another compatible verifier against the original evidence files for an independent cryptographic check.

These limitations are surfaced explicitly in the result's `limitations[]` array using bounded codes.

## 4. CLI

```
npx @proovra/offline-verifier <path-to-package.zip> [--json] [--strict] [--out FILE]
```

Exit codes:
- `0` — overall=`verified` (or `partial` without `--strict`)
- `1` — overall=`failed`
- `2` — overall=`partial` AND `--strict`, or argument error

## 5. Browser

Open `apps/offline-verifier/index.html`. The page:
- Displays a clear "verification runs locally; the package is never uploaded" notice.
- Loads JSZip from a pinned CDN URL with Subresource Integrity.
- Uses WebCrypto for SHA-256. Uses WebCrypto Ed25519 for the package signature when the browser supports it; otherwise reports the signature as `unsupported` (no fake-verified path).
- Exports the result as JSON.

## 6. Old-package compatibility

Packages generated BEFORE P3.1.1 do not contain the attestation files. The verifier reports `custodyAttestations.status="missing"` with a `PRE_P3_1_1_PACKAGE_DETECTED` warning. Old packages NEVER hard-fail because of missing attestations.

## 7. Result schema

See `docs/verification/offline-verification-result-schema.md` for the full bounded schema.

## 8. Historical vs current trust (Phase M1.1)

The result distinguishes two fundamentally different questions:

| Field | Question | Possible statuses |
| --- | --- | --- |
| `historicalVerification.status` | Does the bundled signing-time public material match the package signatures? | `verified` / `partial` / `failed` / `missing` / `unsupported` |
| `currentTrustStatus.status` | Is the signer currently trusted by PROOVRA right now? | ALWAYS `unknown` (offline) |

This distinction is enforced as a standing limitation: every result — past, present, and future — carries the limitation codes:

- `HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST`
- `CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE`
- `SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING`

This is intentional. We do not allow the offline verifier to imply perpetual trust; rotation and revocation are operational concerns that can only be answered by the live deployment. See `docs/verification/historical-verification-material.md` for the snapshot file format and `docs/security/signer-governance.md` for the current-trust API.
