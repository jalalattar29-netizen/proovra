# PROOVRA C2PA Integration (Phase M2)

**Audience:** operators, procurement reviewers, IT security teams, forensic engineers.

---

## 1. What C2PA is

[C2PA](https://c2pa.org) (Coalition for Content Provenance and Authenticity) is an open specification for embedding cryptographically signed provenance information directly into media files. A C2PA manifest can describe:

- The application or device that produced the file.
- A chain of derivative actions (crop, transcode, AI-assist).
- Cryptographic signatures over the file's content claims.

C2PA is a **provenance signal**. It tells you who claims to have produced or modified the file, not whether the content is true.

## 2. What PROOVRA uses C2PA for

PROOVRA treats C2PA as an **additional provenance layer** that runs alongside — never instead of — PROOVRA's own integrity model. We use it to:

1. Detect whether evidence files arrive with C2PA manifests.
2. Validate those manifests (when the provider is enabled).
3. Preserve the bounded result inside the evidence record.
4. Surface that result inside Verification Packages, public verify, evidence detail, and offline verification.

C2PA never overrides PROOVRA's hash + custody + TSA + OTS verdict. Phase M2 enforces this in code (no path can promote C2PA into the overall integrity decision) and in copy (every surface restates the distinction).

## 3. What C2PA does NOT prove

- **Truth.** A signed manifest only describes a claim of provenance. It cannot validate whether the content depicts something that actually happened.
- **Legal admissibility.** No PROOVRA surface makes admissibility claims, and we do not allow C2PA to be the basis for any such claim.
- **Authorship.** Manifest signing keys identify a signer at signing time, not the human author.
- **Replacement for PROOVRA custody.** PROOVRA's hash + custody chain stands on its own. Missing or invalid C2PA does NOT degrade PROOVRA integrity.

These non-claims are encoded as bounded `limitations[]` codes on every C2PA result; see `c2pa-status-model.md`.

## 4. Supported formats

The provider's bounded media-type allowlist (`C2PA_SUPPORTED_MEDIA_TYPES` in `@proovra/shared`):

- Images: `image/jpeg`, `image/png`, `image/svg+xml`, `image/tiff`, `image/webp`, `image/heic`, `image/heif`, `image/avif`, `image/x-adobe-dng`
- Video: `video/mp4`, `video/quicktime`, `video/x-matroska`
- Audio: `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/x-wav`
- Documents: `application/pdf`

Files outside this list short-circuit to bounded `unsupported` without invoking the external tool. We never attempt to embed manifests in formats whose spec we do not support.

## 5. Provider modes (env-driven)

Configured via worker env vars:

| Env | Default | Meaning |
| --- | --- | --- |
| `C2PA_ENABLED` | `false` | Master toggle. When false, all C2PA work is a bounded `disabled` no-op. |
| `C2PA_PROVIDER_MODE` | `detect_only` | One of `disabled`, `detect_only`, `validate`, `embed_supported`. |
| `C2PA_BIN` | unset | Absolute path to `c2patool` (or compatible). When unset in `detect_only`, results degrade honestly to `not_present` with the `C2PA_PROVIDER_DOWNGRADED_TO_DETECT_ONLY` warning. |
| `C2PA_TIMEOUT_MS` | `15000` | Bounded subprocess timeout. |
| `C2PA_MAX_BYTES` | `524288000` | Bounded byte cap per file before the provider short-circuits to `unsupported`. |
| `C2PA_GENERATE_MANIFESTS` | `false` | When false, derivative manifest generation is off. |
| `C2PA_SIGNING_ENABLED` | `false` | When false, generation cannot sign. |
| `C2PA_SIGNING_CERT_PATH` | unset | Path to the C2PA signing certificate (only used when generation is enabled). |
| `C2PA_SIGNING_KEY_PATH` | unset | Path to the C2PA signing private key (only used when generation is enabled). Never read by the detection / validation surface. |

Default = fully disabled. Operators must explicitly enable C2PA. There is no path where the worker silently spawns subprocesses for unconfigured deployments.

## 6. Where C2PA surfaces appear

| Surface | What it shows | Path / testid |
| --- | --- | --- |
| Verification Package ZIP | `provenance/c2pa-summary.json` + `provenance/c2pa-verification.md` | bundled before `package-checksums.json` |
| Offline verifier (CLI + browser + public mount) | `c2pa.status` + `c2pa.validationStatus` + `itemsChecked` + `providerMode` | top-level result field |
| Public verify response | `c2paProvenance` (separate from `verificationPackageIntegrity`) | `GET /public/verify/:id` |
| Public verify page | C2PA panel with bounded copy | `data-testid="c2pa-panel"` |
| Operator evidence detail | C2PA panel sourced from `Evidence.verificationPackageMetadata.c2pa` | (existing surfaces; bounded data) |

The Verification Package always includes the summary file. Old packages from before M2 simply don't have it; the offline verifier reports `c2pa.status="missing"` with a bounded warning — never `failed`.

## 7. Storage

The bounded summary is persisted as a JSON sub-field on `Evidence.verificationPackageMetadata.c2pa`. Phase M2 deliberately does NOT add a new Prisma table — the additive JSON column keeps schema risk to zero. Future phases may promote storage to a dedicated `EvidenceC2paProvenance` table if cross-evidence indexing becomes necessary; the bounded schema is already stable.

Raw C2PA manifests are NOT stored inline in this projection. If we need raw-manifest preservation in a future phase, it will be a separately checksummed artifact in `provenance/c2pa-manifests/<item-id>.c2pa` inside the Verification Package, referenced by hash from the summary.

## 8. Offline verifier behavior

The offline verifier:

- Reads `provenance/c2pa-summary.json` if present.
- Mirrors the bounded summary's `aggregateStatus` / `aggregateValidationStatus` / `itemsChecked` / `providerMode` into the result's `c2pa` block.
- Surfaces `C2PA_PROVIDER_REPORTED_INVALID_MANIFEST` as a bounded warning when the summary reports `invalid`.
- Surfaces `C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR` when the summary reports `error`.
- NEVER runs external C2PA cryptographic validation. Even when the summary reports `valid`, the offline verifier surfaces the standing limitation `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE`.

## 9. Reading the result

See `c2pa-status-model.md` for the full bounded status model.

## 10. Phase M2.1 additions (product surface + portability)

- **Internal evidence detail panel** — `apps/web/app/(app)/evidence/components/C2paPanel.tsx`. Operators see the bounded per-evidence summary plus a retry button. Surfaced via `GET /v1/evidence/:id/c2pa` and `POST /v1/evidence/:id/c2pa/retry`.
- **Operations C2PA page** — `/operations/c2pa`. Provider status, generation readiness, bulk-backfill preview / start / cancel / progress.
- **Bulk backfill** — see `c2pa-backfill.md`.
- **Raw manifest preservation** — see `c2pa-raw-manifests.md`. Opt-in, bounded size cap, additive ZIP contents under `provenance/c2pa-manifests/`.
- **Generation readiness gate** — see `c2pa-generation.md`. Bounded readiness probe; honest "not wired" refusal.

## 11. Related documents

- `c2pa-status-model.md` — bounded result schema with every enum.
- `c2pa-backfill.md` — bulk backfill behavior + safety guarantees.
- `c2pa-generation.md` — readiness gate + honest non-wired refusal.
- `c2pa-raw-manifests.md` — opt-in raw manifest preservation.
- `c2pa-user-guide.md` — for downstream procurement reviewers.
- `verification-package-format.md` — the bundled file layout.
- `offline-verifier.md` — how the offline verifier surfaces C2PA.
- `phase-m2-c2pa-closure.md` — closure report for Phase M2.
- `phase-m2-1-c2pa-product-closure.md` — closure report for Phase M2.1.
