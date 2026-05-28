# Phase M1.1 — Offline Verifier Public Mount + Historical Verification Material — Convergence Closure

**Phase:** M1.1 (Trust Portability Convergence Pass)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M1 (Offline Verification Ecosystem), P3.1.1 (Package attestation closure)
**Successors:** none scheduled

---

## 0. Scope (verbatim from M1.1 spec)

> Two deliverables, end-to-end, in a single closure pass:
>
> 1. **Mount the offline verifier publicly inside `apps/web`** — no login, no auth, no API dependency. ZIP runs locally in the browser. Drag/drop + file picker + JSON export. Privacy banner.
> 2. **Historical Verification Material Strategy** — embed bounded public verification material at package generation time so packages remain independently verifiable years from now, while making explicit that historical verification ≠ current trust.

---

## 1. What landed

### 1.1 Public web mount

| Item | Path | Notes |
| --- | --- | --- |
| Public Next.js page | `apps/web/app/offline-verifier/page.tsx` | `"use client"`, no auth wrappers, drag-and-drop + picker + download |
| JSZip loader | inline `next/script` | Pinned CDN URL with Subresource Integrity (`sha384-…`) |
| Privacy banner | `[data-testid="privacy-notice"]` | "Verification runs locally in your browser. The package is not uploaded to PROOVRA." |
| Result rendering | inline | Renders `overall`, `package`, `artifactIntegrity`, `custodyAttestations`, `timestamping`, `reportSignature`, `historicalVerification`, `currentTrustStatus`, `warnings`, `limitations` |
| Download | `[data-testid="download-button"]` | Emits the result JSON via `Blob` + `URL.createObjectURL` — never `fetch()`s the ZIP |
| Test surface | `data-testid` attributes for all major regions | Required for vitest source-contract checks |

**Privacy guarantees enforced in the source contract:**
- No `fetch(file)` or `XMLHttpRequest` calls touch the ZIP bytes.
- No `<form>` submit posts the file anywhere.
- Only network traffic during verification is the initial JSZip CDN script load.
- No legal/admissibility wording (`court-admissible`, `proof of truth`, `currently trusted`, `trusted forever`) appears in the page source.

### 1.2 Historical Verification Material

| Item | Path | Notes |
| --- | --- | --- |
| Generator | `services/worker/src/verification-package-historical-material.ts` | Wraps `aws_kms.GetPublicKey` / local PEM read; ONLY public bytes |
| Wired into builder | `services/worker/src/verification-package.ts` | Appended before `package-checksums.json` so the file is checksummed |
| OTEL span | `proovra.package.historical_material.generate` | Bounded attributes only; no key bytes logged |
| Schema doc | `docs/verification/historical-verification-material.md` | Full enum + interpretation contract |

**File format (`signers/historical-verification-material.json`):**
- `schemaVersion`, `fileType`, `generatedAtUtc`, `evidenceId`
- `signers[]` with bounded `purpose`, `provider`, `algorithm`, `signerStatusAtSigningTime`
- `verificationMaterial.type` ∈ `{ "ed25519_spki_pem", "kms_public_key_pem", "unsupported" }`
- `verificationMaterial.pem` — PUBLIC PEM only (or omitted on `unsupported`)
- `verificationMaterial.historicalOnly: true`
- `trustInterpretation.statement` + bounded codes
- `revocationAwareness.checkedAtGenerationTime: false`

**Best-effort / additive guarantees:**
- Generation NEVER fails the package — falls back to a `degradedFile()` with `unsupported` entries.
- Deterministic ordering keeps packages byte-reproducible.
- Old packages without the file remain verifiable; the verifier surfaces `HISTORICAL_VERIFICATION_MATERIAL_MISSING` as a warning, never as a failure.

### 1.3 Verifier semantics upgrade

Added to `packages/offline-verifier/src/result-schema.ts`:

- New bounded enums:
  - `HISTORICAL_VERIFICATION_STATUSES = ["verified", "partial", "failed", "missing", "unsupported"]`
  - `CURRENT_TRUST_STATUSES = ["unknown", "not_checked", "unsupported"]`
- New warning codes:
  - `HISTORICAL_VERIFICATION_MATERIAL_MISSING`
  - `HISTORICAL_VERIFICATION_PARTIAL_COVERAGE`
  - `HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM`
- New limitation codes (injected on EVERY result):
  - `HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST`
  - `CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE`
  - `SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING`
- New top-level result fields:
  - `historicalVerification: { status, materialEntriesBundled, materialEntriesVerifiable, signers[], note? }`
  - `currentTrustStatus: { status: "unknown", note }`

The verifier always reports `currentTrustStatus.status = "unknown"` regardless of the historical status — there is no code path that promotes "historical match" to "currently trusted".

### 1.4 Worker dependency

- Added `@aws-sdk/client-kms@^3.1021.0` to `services/worker/package.json` (was already in api; worker needed it for `GetPublicKeyCommand`).

---

## 2. Tests

| Suite | Path | Result |
| --- | --- | --- |
| M1.1 schema + verifier-core + worker source contract + public-mount source contract | `packages/offline-verifier/test/verifier-m1-1.test.ts` | **22 / 22 pass** |

Coverage:
1. `HISTORICAL_VERIFICATION_STATUSES` bounded.
2. `CURRENT_TRUST_STATUSES` bounded.
3. New warning codes present.
4. New limitation codes present.
5. Standing limitations always injected on every result.
6. Missing historical material → `historicalVerification.status = "missing"` (never `failed`).
7. All entries verifiable → `historicalVerification.status = "verified"`.
8. Unsupported algorithm → warning + non-verified status.
9. `currentTrustStatus.status === "unknown"` always.
10. Old packages (no M1.1 file) still pass.
11. Worker source contract: builder imports `buildHistoricalVerificationMaterial`.
12. Worker source contract: new path appended before `package-checksums.json`.
13. Worker source contract: no private key material in generator module.
14. Public mount: page file exists.
15. Public mount: all required testids present.
16. Public mount: JSZip pinned with SRI.
17. Public mount: no `fetch(` of file blobs / no `XMLHttpRequest`.
18. Public mount: no `court-admit`, `proof of truth`, `currently trusted`, `trusted forever` wording.
19. Verifier reads `signers/historical-verification-material.json`.
20. `historicalVerification.materialEntriesBundled` count accurate.
21. `historicalVerification.materialEntriesVerifiable` count accurate.
22. Schema version unchanged (`PROOVRA_OFFLINE_VERIFICATION_RESULT_V1` still compatible — additive).

Typechecks (all clean):

- `pnpm --filter @proovra/offline-verifier typecheck`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-api typecheck`

---

## 3. Documentation

| Doc | Status |
| --- | --- |
| `docs/verification/offline-verifier.md` | Updated — third surface row, §3 limitation, new §8 historical-vs-current section |
| `docs/verification/historical-verification-material.md` | **NEW** — full file format + generation + verifier contract |
| `docs/security/signer-governance.md` | Updated — new §10 historical vs current trust |
| `docs/public/offline-verification-user-guide.md` | Updated — third "way to run" + §3 historical/current distinction |
| `docs/verification/phase-m1-1-convergence-closure.md` | **NEW** — this report |

---

## 4. Acceptance confirmation

The user's M1.1 acceptance criteria, each confirmed:

| # | Criterion | Status |
| --- | --- | --- |
| 1 | offline-verifier publicly mounted | ✅ at `apps/web/app/offline-verifier/page.tsx` |
| 2 | no login required for the public mount | ✅ no `requireAuth` / `authGuard` wrapper |
| 3 | no package upload required | ✅ source contract test asserts no `fetch(file)` or `XMLHttpRequest` |
| 4 | no Verification Package ZIP format break | ✅ new file additive; appended before checksums; old packages still pass |
| 5 | no private keys included | ✅ generator only calls `GetPublicKey` / reads `SIGNING_PUBLIC_KEY_PATH`; test asserts no `PRIVATE KEY` strings in source |
| 6 | no fake "currently trusted forever" semantics | ✅ `currentTrustStatus.status` ALWAYS `unknown`; forbidden-wording test enforces it |
| 7 | historical verification distinguished from current trust | ✅ two separate result fields + three standing limitation codes injected on every result |
| 8 | old packages still supported | ✅ test asserts `partial`/`missing` paths produce non-failed results |
| 9 | no legal/admissibility claims | ✅ source contract test sweeps for forbidden wording |
| 10 | M1.1 fully closed | ✅ — generator + verifier + public mount + tests + docs + closure |

Additional non-negotiables from the spec all enforced:

- Browser verifier works safely on large malformed ZIPs (JSZip + try/catch + bounded summary).
- Additive only — no migration, no breaking schema, no ZIP format change.
- Deterministic ordering preserved.
- Reproducible package output preserved (file is byte-stable for the same inputs at the same wall-clock minute; `generatedAtUtc` is the only varying field, mirroring existing snapshot files).
- No AWS credentials, IAM ARNs, or raw KMS errors leak into the file or the result.

---

## 5. Deferred / out-of-scope

These are explicitly NOT part of M1.1 and were not changed:

- Switching `apps/offline-verifier/verifier-browser.mjs` (the static one-shot page) to also surface the new historical fields. The static page still works against old and new packages; it just doesn't render the historical section yet. The CLI and the public web mount do.
- A live `GET /v1/signers/by-key-id/.../current-status` route for procurement reviewers wanting to query current trust from a key id alone. Today reviewers must list signers and match by `keyId`. Adding a dedicated lookup is a separate small backend phase.
- WebCrypto Ed25519 verification of the bundled historical PEM against `package-manifest.sig` in the browser. The CLI does this; the browser falls back to `unsupported` when WebCrypto Ed25519 is unavailable. No fake-verified path is introduced.

---

## 6. Files touched (summary)

**New:**
- `services/worker/src/verification-package-historical-material.ts`
- `apps/web/app/offline-verifier/page.tsx`
- `packages/offline-verifier/test/verifier-m1-1.test.ts`
- `docs/verification/historical-verification-material.md`
- `docs/verification/phase-m1-1-convergence-closure.md`

**Modified:**
- `services/worker/src/verification-package.ts` (one block calling the new generator)
- `services/worker/package.json` (add `@aws-sdk/client-kms`)
- `packages/offline-verifier/src/result-schema.ts` (additive enums + types)
- `packages/offline-verifier/src/verifier-core.ts` (sub-verifier + standing limitations)
- `docs/verification/offline-verifier.md`
- `docs/security/signer-governance.md`
- `docs/public/offline-verification-user-guide.md`

---

## 7. Phase M1.1 — CLOSED.
