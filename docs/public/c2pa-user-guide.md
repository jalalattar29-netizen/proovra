# C2PA Provenance — User Guide

**Audience:** procurement reviewers, IT security teams, third parties evaluating PROOVRA Verification Packages.

---

## 1. What you will see

A PROOVRA Verification Package generated from Phase M2 onward contains a `provenance/` directory:

```
provenance/
  c2pa-summary.json
  c2pa-verification.md
```

The PROOVRA public verify page and the offline verifier both surface a **C2PA Provenance** panel that reports one of these bounded states:

- `not_present` — no C2PA manifest was found on the evidence file.
- `present` — a manifest was detected; the operator chose detection-only mode.
- `valid` — a manifest was detected and cryptographically validated.
- `invalid` — a manifest was detected and validation failed.
- `unsupported` — the file format or provider mode cannot validate here.
- `disabled` — PROOVRA's C2PA provider is operationally disabled at this deployment.
- `error` — extraction failed for an operational reason.

The offline verifier additionally surfaces `missing` for packages generated before Phase M2 (no `provenance/c2pa-summary.json`).

## 2. What this does NOT tell you

C2PA is a provenance signal. It does NOT make any of the following claims:

- It does **not** tell you whether the content depicts something true.
- It does **not** make a legal-admissibility claim.
- It does **not** override PROOVRA's hash + custody + timestamp integrity. A missing or invalid C2PA result never on its own marks the evidence as failed.
- It does **not** identify a human author. Manifest signatures identify whatever signing key the manifest's creator used.

These non-claims are recorded as bounded `limitations[]` codes on every result. If you see them, that is by design — not a defect.

## 3. How to inspect the bundled summary directly

Open `provenance/c2pa-summary.json` in any text editor. You will find:

- `schemaVersion: "PROOVRA_C2PA_RESULT_V1"`
- `aggregateStatus` — the bounded top-level state for the evidence.
- `aggregateValidationStatus` — `not_checked` / `valid` / `invalid` / `unsupported` / `error`.
- `itemsChecked` — how many files were evaluated.
- `files[]` — per-file results with bounded enums.
- `limitations[]` — the standing distinction codes (always present).

## 4. How to run your own C2PA validation

The PROOVRA offline verifier does NOT run external C2PA cryptographic validation. To independently verify a manifest:

1. Install Adobe's [c2patool](https://github.com/contentauth/c2patool) or any C2PA-compatible verifier.
2. Extract the original evidence file from the Verification Package (under `evidence/`).
3. Run `c2patool --info <file>` (or `--detailed`).

The result of running c2patool yourself is independent of PROOVRA's summary. Compare them only if both are available.

## 5. Privacy

PROOVRA's C2PA pipeline never:

- Mutates the original evidence file.
- Strips existing C2PA metadata.
- Embeds C2PA manifests in unsupported formats.
- Spawns the c2patool subprocess when `C2PA_ENABLED=false`.
- Includes raw stderr / stdout / private key bytes in any result, log, or telemetry.

The bounded summary stores no raw file content — only structured enums + counts.

## 6. Raw manifest preservation (Phase M2.1)

If the package was generated with raw-manifest preservation enabled, you will also find:

```
provenance/c2pa-manifests/<item-id>.c2pa
```

The file is the verbatim raw manifest. PROOVRA's offline verifier checks that the file exists for every claimed reference in `c2pa-summary.json` and will surface a bounded `C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE` warning if the summary claims a path that is not present. The bytes are covered by the package's SHA-256 chain.

Raw manifests do NOT make any PROOVRA integrity decision stronger. They are provided as a convenience so you can run external C2PA tooling against the raw bytes without re-extracting from the original evidence file.

## 7. What you might still need external tools for

The offline verifier does not bundle C2PA cryptographic validation tooling. If you need an independent cryptographic check of the manifest signature, install Adobe's [c2patool](https://github.com/contentauth/c2patool) (or any compatible verifier) and run it against either the original evidence file (under `evidence/...`) or the bundled raw manifest (under `provenance/c2pa-manifests/...`).

## 8. Related documents

- `c2pa.md` — engineering description of the integration.
- `c2pa-status-model.md` — every bounded enum value.
- `offline-verification-user-guide.md` — broader offline-verification user guide.
