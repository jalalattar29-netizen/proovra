# PROOVRA Insurance SIU Bundle (Phase M3)

**Audience:** insurance / SIU operators and engineering teams integrating the SIU surface with insurer-side platforms.

---

## 1. What this is

PROOVRA's Insurance SIU bundle is an additive layer on top of the existing Cases/Matter workspace. It helps SIU teams:

- collect evidence from claimants and field agents,
- organize that evidence into a claim matter,
- review integrity / provenance / custody signals,
- produce a bounded export bundle that an insurer can ingest.

## 2. What this is NOT

- It is NOT a fraud-detection engine.
- It is NOT a legal-admissibility module.
- It is NOT a generic insurance CRM.
- It is NOT a claims-payout / policy-administration system.
- It is NOT a replacement for the insurer's core platform.

These non-claims are encoded as bounded standing limitation codes on every SIU response and export. See `insurance-siu-export-format.md` §3.

## 3. Bounded vocabulary

PROOVRA's SIU surface uses operational language only:

- "review indicator"
- "follow-up needed"
- "evidence gap"
- "provenance warning"
- "integrity warning"
- "inconsistent metadata"

PROOVRA's SIU surface NEVER uses:

- words like "fraud detected", "fake evidence", "guilty", "deception confirmed",
- legal terms like "legally admissible" or "court-ready proof",
- authorship determinations beyond bounded technical signals.

The bounded forbidden corpus lives in `@proovra/shared`'s `SIU_FORBIDDEN_PHRASES` array and is enforced by a source-contract test sweep at build time.

## 4. SIU profile

A bounded JSON object attached to a Case via the SIU service. Fields:

- `claimType` ∈ `auto | property | injury | liability | travel | cyber | other`
- `investigationStatus` ∈ `intake | collecting | review | follow_up | export_ready | exported | closed`
- `claimNumber`, `policyReference`, `incidentDate`, `incidentLocation`, `lossDescription`
- `assignedAdjusterUserId`, `assignedSIUReviewerUserId`
- `claimantName`, `claimantContact` — privacy-gated (redacted by default)
- `intakeTemplateId` — bounded reference to the SIU intake template
- `checklist[]` — materialised evidence checklist for the template
- `reviewIndicators[]` — bounded operational signals (NOT findings)
- `followUps[]` — open and historical follow-up requests

## 5. Intake templates

Four bounded templates ship with M3:

- `insurance-auto-claim`
- `insurance-property-claim`
- `insurance-injury-liability-claim`
- `insurance-cyber-incident-claim`

Each template defines a list of required and optional checklist items, with bounded `acceptedKinds` (PHOTO / VIDEO / AUDIO / DOCUMENT) and an optional `recommendLocation` flag. Templates are static and exported from `@proovra/shared`.

## 6. Review indicators (NOT fraud findings)

Bounded codes:

- `DUPLICATE_MEDIA_DETECTED`
- `MISSING_REQUIRED_EVIDENCE`
- `GENERIC_MIME_TYPE_OBSERVED`
- `SCREENSHOT_LIKE_FILE_NAME`
- `FILE_LAST_MODIFIED_OLDER_THAN_INCIDENT`
- `CAPTURE_TIMESTAMP_INCONSISTENT_WITH_CONTEXT`
- `RECOMMENDED_LOCATION_MISSING`
- `EVIDENCE_HASH_CUSTODY_MISMATCH`
- `FOLLOW_UP_OVERDUE`
- `REVIEWER_FLAGGED_FOR_FOLLOW_UP`

Each indicator carries an `info` / `warning` / `block_export` severity. PROOVRA NEVER labels these as fraud findings.

## 7. API surface

| Method | Path | Purpose | Step-up |
| --- | --- | --- | --- |
| GET | `/v1/siu/intake-templates` | List bounded templates | — |
| GET | `/v1/cases/:id/siu-profile` | Load profile (PII redacted by default) | — |
| PUT | `/v1/cases/:id/siu-profile` | Upsert profile | — |
| POST | `/v1/cases/:id/siu-profile/checklist/:itemId/map-evidence` | Map evidence to a checklist item | — |
| POST | `/v1/cases/:id/siu-profile/checklist/:itemId/status` | Set checklist item status | — |
| POST | `/v1/cases/:id/siu-profile/indicators` | Add a review indicator | — |
| POST | `/v1/cases/:id/siu-profile/follow-ups` | Create a follow-up request | — |
| POST | `/v1/cases/:id/siu-profile/follow-ups/:followUpId/status` | Update follow-up status | — |
| GET | `/v1/cases/:id/siu-export/preflight` | Run the bounded preflight | — |
| POST | `/v1/cases/:id/siu-export` | Generate the SIU bundle | **`SIU_EXPORT_GENERATE`** |

## 8. Storage model (honest)

The Phase M3 SIU profile is held in an in-process registry keyed by case id. Promotion to a durable Prisma model is documented as a deferred follow-up. Audit events for every profile mutation are emitted via `appendPlatformAuditLog` so operators retain a complete audit trail even with in-process storage.

## 9. Related documents

- `insurance-siu-workflows.md` — adjuster / SIU reviewer workflow.
- `insurance-siu-export-format.md` — bundle ZIP layout.
- `insurance-evidence-guide.md` — claimant-facing guide.
- `phase-m3-insurance-siu-closure.md` — closure report.
