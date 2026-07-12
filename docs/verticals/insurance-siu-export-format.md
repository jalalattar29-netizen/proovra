# SIU Export Bundle Format (Phase M3)

**Audience:** insurer engineering teams ingesting PROOVRA SIU bundles; SIU operators auditing what the bundle contains.

---

## 1. ZIP layout

```
siu-summary.json
claim-timeline.json
evidence-checklist.json
review-indicators.json
follow-ups.json
integrity-provenance-summary.json
custody-audit-summary.json
verification/
  independent-verification.md
manifest.json
README.md
```

Future-deferred entries (will be additive when wired in a follow-up phase):

```
verification/
  verification-package.zip      # per-evidence verification package
reports/
  report.pdf                    # per-evidence report
```

The current Phase M3 bundle bundles the bounded JSON projections only; per-evidence Verification Packages and Report PDFs continue to be retrievable via their existing artifact routes. A future phase can stream them into the ZIP directly.

## 2. `siu-summary.json`

```jsonc
{
  "schemaVersion": "PROOVRA_SIU_EXPORT_V1",
  "generatedAtUtc": "2026-05-28T18:00:00.000Z",
  "caseId": "<uuid>",
  "teamId": "<uuid>",
  "profile": { /* bounded SIU profile */ },
  "readiness": "ready" | "ready_with_warnings",
  "warningExportReason": "Operator-supplied bounded reason or null.",
  "totals": {
    "warnings": 0,
    "blockers": 0,
    "requiredChecklistItems": 0,
    "satisfiedChecklistItems": 0,
    "openFollowUps": 0
  },
  "limitations": [
    "SIU_BUNDLE_IS_NOT_A_FRAUD_DETERMINATION",
    "SIU_BUNDLE_DOES_NOT_PROVE_CONTENT_TRUTH",
    "SIU_BUNDLE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
    "REVIEW_INDICATORS_ARE_OPERATIONAL_SIGNALS_NOT_FINDINGS",
    "PROOVRA_DOES_NOT_REPLACE_INSURER_CORE_SYSTEMS"
  ],
  "note": "Bounded operator-readable note (≤240 chars).",
  "includedEvidenceIds": ["<uuid>", "..."]
}
```

## 3. Standing limitations (always present)

Every SIU export bundle ships with the bounded `limitations[]` array in §2. These codes restate, in machine-readable form, that the bundle is operational and not a legal claim. Downstream insurers SHOULD record these limitations alongside the imported case data.

## 4. `claim-timeline.json`

Bounded operational projection. Events include:

- `profile_created`
- `incident_date_declared`
- `follow_up_requested`
- `follow_up_received`
- `review_indicator_added`

Events are sorted by UTC. The bundle includes an explicit `note` clarifying that the timeline is not a legal record and does not make admissibility claims.

## 5. `evidence-checklist.json`

Per-item status (`missing` / `submitted` / `mapped` / `satisfied` / `waived`), required-vs-optional flag, evidence ids mapped to each item.

## 6. `review-indicators.json`

Bounded indicator objects:

```jsonc
{
  "code": "DUPLICATE_MEDIA_DETECTED",
  "explanation": "Bounded operator-readable explanation (≤240 chars).",
  "evidenceId": "<uuid|null>",
  "observedAtUtc": "...",
  "severity": "info" | "warning" | "block_export"
}
```

Indicators are operational signals. The bundle's `README.md` explicitly states they are NOT fraud findings.

## 7. `follow-ups.json`

History + status of every follow-up evidence request. Bounded fields: `id`, `checklistItemId`, `status`, `dueByUtc`, `requestedAtUtc`, `note`, `intakeLinkId`, `receivedAtUtc`, `returnedEvidenceIds`.

## 8. `integrity-provenance-summary.json`

Bounded inventory of the evidence rows included in the bundle. The per-evidence integrity / custody / TSA / OTS verdicts live inside each evidence's Verification Package — this file only lists which evidence ids are present.

## 9. `custody-audit-summary.json`

Aggregate bounded counts mirrored from the preflight totals. Per-evidence custody events are bundled inside each evidence's Verification Package.

## 10. `verification/independent-verification.md`

Operator-readable guidance for independently checking each bundled Verification Package against its `package-checksums.json` (SHA-256) and `package-manifest.sig` with standard tooling, and reviewing live integrity/current-trust status on the PROOVRA Public Verify page. Restates the standing limitations.

## 11. `manifest.json`

Bounded file inventory:

```jsonc
{
  "schema": "PROOVRA_SIU_EXPORT_MANIFEST",
  "version": 1,
  "schemaVersion": "PROOVRA_SIU_EXPORT_V1",
  "generatedAtUtc": "...",
  "caseId": "...",
  "teamId": "...",
  "files": [{ "path": "...", "sizeBytes": 0 }],
  "limitations": [/* the five standing codes */],
  "note": "Bounded operator-readable note (≤240 chars)."
}
```

A signed-manifest variant is reserved for a future phase; when the existing PROOVRA signer is configured for SIU artifacts, the manifest will be accompanied by a detached `manifest.sig` envelope identical in shape to the Verification Package envelope.

## 12. Preflight contract

Before producing a bundle, the bounded preflight evaluates:

- required checklist coverage
- per-evidence integrity (hash / legal-hold / lifecycle)
- presence of Report PDF + Verification Package
- open follow-ups
- review indicator severities

Bounded states:

- `ready` — no warnings, no blockers
- `ready_with_warnings` — warnings only; export requires a bounded operator reason (≥8 chars)
- `blocked` — at least one blocker; export is refused with HTTP 409
- `unavailable` — preflight could not run (missing profile)

## 13. Backward / forward compatibility

The bundle is additive only. Future phases may add files; recipients MUST tolerate unknown files. `schemaVersion` is the stable Phase M3 anchor — its value will only change when a breaking layout change is made.
