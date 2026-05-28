# C2PA Raw Manifest Preservation (Phase M2.1)

**Audience:** operators considering whether to bundle raw C2PA manifests inside PROOVRA Verification Packages; forensic reviewers consuming bundled manifests.

---

## 1. What raw-manifest preservation is

A C2PA manifest is a compact JUMBF / CBOR blob embedded inside (or attached to) a media file. The bounded PROOVRA summary in `provenance/c2pa-summary.json` carries the manifest's structure and validation outcome but **does not** carry the manifest bytes.

Phase M2.1 adds an OPT-IN path: when `C2PA_RAW_MANIFEST_EXPORT_ENABLED=true` and the discovered raw manifest is below `C2PA_RAW_MANIFEST_MAX_BYTES`, the Verification Package builder writes the manifest verbatim to:

```
provenance/c2pa-manifests/<item-id>.c2pa
```

The summary's per-file `rawManifest` reference records the bounded status, SHA-256 of the bytes, the size, and the package-relative path.

## 2. Bounded status enum

| Value | Meaning |
| --- | --- |
| `disabled` | `C2PA_RAW_MANIFEST_EXPORT_ENABLED=false`. The honest no-op default. |
| `not_exported` | Export is enabled but the provider did not surface raw manifest bytes for this file. |
| `exported_to_package` | Bytes were bundled at `packageRelativePath` and are recoverable from the ZIP. |
| `exported_to_artifact_store` | Reserved for a future flow where raw manifests live as separate S3 objects (currently unused). |
| `too_large_to_export` | Manifest bytes exceeded the configured cap; a bounded warning is recorded. |
| `unsupported` | Provider mode does not support raw-manifest extraction for this format. |
| `missing` *(offline verifier only)* | Summary claimed a `packageRelativePath` but the file is absent from the ZIP. |

## 3. Env

```env
C2PA_RAW_MANIFEST_EXPORT_ENABLED=false        # opt-in, defaults off
C2PA_RAW_MANIFEST_MAX_BYTES=5242880            # 5 MiB default cap
```

## 4. Why a cap

C2PA manifests can grow large when ingredients chains carry embedded thumbnails or nested derivative manifests. Putting hundreds of MB of provenance into every Verification Package would:

1. Bloat package downloads for procurement reviewers who don't need the raw bytes.
2. Increase S3 / WORM-export storage cost.
3. Risk DoS on tools that load the entire ZIP into memory.

The bounded cap defaults to 5 MiB per file — generous for typical capture manifests, restrictive enough to refuse pathological cases. Operators can lift it (or lower it) to taste.

## 5. Offline verifier reconciliation

The offline verifier reads `provenance/c2pa-summary.json`, walks the per-file `rawManifest.packageRelativePath` entries, and verifies that the claimed file actually exists in the ZIP. If a claim does not match a file, the verifier:

- Emits the bounded warning `C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE`.
- Sets `c2pa.rawManifestExportStatus = "missing"` regardless of what the summary claimed.

This means a tampered summary cannot trick a downstream reviewer into believing raw manifests are present when they are not. The package's SHA-256 chain (`package-checksums.json`) covers both the summary file and any bundled manifest bytes.

## 6. What raw manifests do NOT do

- They do NOT make PROOVRA's hash + custody integrity stronger. A package whose hash chain fails is still failed — bundled raw manifests cannot rescue it.
- They do NOT provide an independent admissibility claim.
- They do NOT validate themselves. External C2PA tooling (e.g. `c2patool`) is still required for cryptographic validation of the raw bytes.

## 7. Operator workflow

1. Confirm storage budget is acceptable for the expected workspace evidence shape.
2. Set `C2PA_RAW_MANIFEST_EXPORT_ENABLED=true` and optionally tune `C2PA_RAW_MANIFEST_MAX_BYTES`.
3. New evidence finalizations automatically populate the bundled manifest reference and (when fresh extraction runs) the bundled bytes.
4. To bundle raw manifests on existing evidence, re-run C2PA extraction via the per-evidence retry endpoint or a full backfill.
