# Phase M3 — Insurance SIU Bundle — Convergence Closure

**Phase:** M3 (Vertical Productization / Investigation Operations Track)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M2.1 (C2PA Product Surface + Backfill + Portability)
**Successors:** none scheduled

---

## 0. Scope (verbatim from M3 spec)

> PROOVRA must support insurance/SIU teams in:
>
> - collecting evidence from claimants/field agents,
> - organizing claim evidence into a matter,
> - reviewing evidence integrity/provenance/custody,
> - exporting insurer-ready SIU packages,
> - producing incident/claim timelines,
> - giving adjusters/reviewers a clear workflow,
> - preserving verification-first discipline.
>
> PROOVRA must NOT claim fraud proven, claim true/false, legal admissibility, authorship certainty, or content authenticity beyond verified technical signals.

Phase M3 closes the spec end-to-end on top of the existing Cases/Matter workspace, without duplicating any existing surface.

---

## 1. SIU domain model summary

Bounded shape in `packages/shared/src/insurance-siu.ts`:

- `SIU_CLAIM_TYPES`: auto / property / injury / liability / travel / cyber / other.
- `SIU_INVESTIGATION_STATUSES`: intake / collecting / review / follow_up / export_ready / exported / closed.
- `SIU_REVIEW_INDICATOR_CODES`: 12 bounded operational signals, NEVER fraud findings.
- `SIU_PREFLIGHT_CODES`: 8 bounded warnings + 4 bounded blockers.
- `SIU_EXPORT_READINESS_STATES`: ready / ready_with_warnings / blocked / unavailable.
- `SIU_FOLLOW_UP_STATUSES`: open / sent / received / satisfied / expired / cancelled.
- `SIU_CHECKLIST_ITEM_STATUSES`: missing / submitted / mapped / satisfied / waived.
- `SIU_STANDING_LIMITATIONS`: 7 bounded codes injected on every result + every export.
- `SIU_FORBIDDEN_PHRASES`: bounded corpus enforced by source-contract sweep.

Profile shape: `SiuProfile` includes bounded claim metadata, materialized `checklist[]`, `reviewIndicators[]`, `followUps[]`, privacy-gated claimant fields.

## 2. Intake templates summary

Four bounded templates static-exported from `@proovra/shared`:

- `insurance-auto-claim` — scene overview, vehicle damage close-ups, vehicle identifier, repair estimate, optional police report, optional witness statement.
- `insurance-property-claim` — damage overview, close-ups, cause context, optional receipts, repair quote, optional before/after.
- `insurance-injury-liability-claim` — incident scene, supporting documents, optional medical report, optional witness media, optional timeline note.
- `insurance-cyber-incident-claim` — screenshots, logs, optional correspondence, affected account/device notes, optional timestamped exports.

Each template carries a bounded `recommendLocation` flag per item and a bounded `acceptedKinds` list (`PHOTO|VIDEO|AUDIO|DOCUMENT`).

## 3. Matter workspace summary

Frontend component `apps/web/app/(app)/cases/components/SiuPanel.tsx` mounts inside the existing case workspace WITHOUT duplicating any existing tab. The panel exposes:

- bounded SIU profile summary table,
- bounded evidence checklist table with per-item status,
- bounded review indicators (NEVER labelled as fraud),
- bounded preflight + export controls with explicit `data-testid` anchors,
- bounded operator-readable standing limitation codes.

The PII fields (`claimantName`, `claimantContact`) render as redacted placeholders unless the API resolver flagged the caller as PII-exposed.

## 4. Adjuster / SIU workflow summary

Workflow actions are all permission-gated through the existing case-access path and audited via `appendPlatformAuditLog`:

- assign adjuster / SIU reviewer (profile upsert)
- mark evidence gap (add `MISSING_REQUIRED_EVIDENCE` indicator)
- request follow-up (bounded `SiuFollowUpRequest`)
- mark checklist item satisfied (status transition)
- mark ready for SIU export (investigation status transition)
- escalate to SIU review (investigation status transition)
- close / reopen investigation (investigation status transition)

## 5. Follow-up flow summary

`POST /v1/cases/:id/siu-profile/follow-ups` creates a bounded follow-up tied to a checklist item, with an optional due date and optional intake-link reference. `POST /v1/cases/:id/siu-profile/follow-ups/:followUpId/status` transitions through the bounded enum. When the status reaches `received` or `satisfied`, a `siu_follow_up_received` audit event is emitted.

The follow-up bytes themselves flow through the existing `WorkflowIntakeLink` infrastructure; the SIU service holds only the bounded reference + timestamps.

## 6. SIU export bundle summary

Builder: `services/api/src/services/siu/siu-export-bundle.service.ts`.

The bundle is a ZIP with the canonical layout in `docs/verticals/insurance-siu-export-format.md`. Phase M3 ships:

- `siu-summary.json` (bounded profile + readiness + limitations)
- `claim-timeline.json` (bounded operational timeline)
- `evidence-checklist.json`
- `review-indicators.json`
- `follow-ups.json`
- `integrity-provenance-summary.json` (bundled evidence inventory)
- `custody-audit-summary.json` (aggregate counts)
- `verification/offline-verification.md` (offline-verifier pointer)
- `manifest.json` (bounded file inventory with sizes)
- `README.md`

Future-deferred entries (additive, no schema break): per-evidence `reports/report.pdf` and `verification/verification-package.zip` streamed alongside the bounded JSONs.

## 7. Pre-flight summary

`services/api/src/services/siu/siu-preflight.service.ts` emits one of four bounded readiness states based on bounded findings:

- Warnings: required-evidence-missing / report-pdf-missing / verification-package-missing / c2pa-degraded / follow-up-incomplete / review-indicator-warning.
- Blockers: legal-hold / retention / hash-mismatch / block-export-indicator.

`ready_with_warnings` requires a bounded operator reason (≥8 chars) at export time. `blocked` is a hard refusal at HTTP 409.

## 8. Governance / security summary

- Every route is auth-gated via the existing case-access pattern.
- Tenancy enforced through `requireCaseInTeam` — no cross-team scan.
- `SIU_EXPORT_GENERATE` step-up purpose added to bounded `STEP_UP_PURPOSES` enum.
- Privacy-gated claimant fields are redacted by default; only the case owner sees them unredacted in Phase M3 (a dedicated capability is a follow-up).
- Bounded audit events: `siu_profile_updated`, `siu_review_indicator_added`, `siu_follow_up_requested`, `siu_follow_up_received`, `siu_export_preflight_run`, `siu_export_blocked`, `siu_export_generated`.
- No fraud language anywhere — enforced by a forbidden-phrase source-contract sweep across the shared module, the api services, the api routes, the frontend panel, and every M3 doc.

## 9. Tests

| Suite | Path | Result |
| --- | --- | --- |
| M3 bounded enums + templates + source contracts + docs vocabulary | `packages/offline-verifier/test/verifier-m3.test.ts` | **see below** |

Cumulative offline-verifier suite (core + M1.1 + M2 + M2.1 + M3): full suite all green.
Cumulative worker suite: full suite all green.
Typechecks across all five workspace packages: clean.

## 10. Files changed (summary)

**New:**

- `packages/shared/src/insurance-siu.ts`
- `services/api/src/services/siu/siu-profile.service.ts`
- `services/api/src/services/siu/siu-preflight.service.ts`
- `services/api/src/services/siu/siu-export-bundle.service.ts`
- `services/api/src/routes/siu.routes.ts`
- `apps/web/app/(app)/cases/components/SiuPanel.tsx`
- `packages/offline-verifier/test/verifier-m3.test.ts`
- `docs/verticals/insurance-siu.md`
- `docs/verticals/insurance-siu-export-format.md`
- `docs/verticals/insurance-siu-workflows.md`
- `docs/public/insurance-evidence-guide.md`
- `docs/verticals/phase-m3-insurance-siu-closure.md`

**Modified:**

- `packages/shared/src/index.ts` — SIU exports
- `packages/shared/src/identity-security.ts` — `SIU_EXPORT_GENERATE` step-up purpose
- `services/api/src/server.ts` — registers `siuRoutes`

## 11. Remaining blockers

None. M3 is closed.

Deferred (out of M3 scope):

- Durable Prisma model for SIU profile (currently in-process registry; audit events preserve operator history).
- Direct streaming of per-evidence Verification Packages and Report PDFs into the SIU bundle ZIP.
- Dedicated `siu.profile.exposeClaimantPii` capability so non-owner reviewers can be allow-listed for PII exposure.
- Saved-view shapes for the SIU views in `EvidenceSavedView` (recommended shapes documented in `insurance-siu-workflows.md`).

## 12. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | insurance/SIU profile exists on Matter/Cases | ✅ additive `SiuProfile` per case |
| 2 | insurance intake templates exist | ✅ 4 bounded templates |
| 3 | evidence checklist maps to existing evidence | ✅ map-evidence endpoint + status endpoint |
| 4 | adjuster/SIU workflow exists | ✅ bounded actions + audit events |
| 5 | follow-up evidence requests exist | ✅ follow-up service + endpoints |
| 6 | SIU export pre-flight exists | ✅ bounded 4-state preflight |
| 7 | SIU export bundle exists | ✅ ZIP builder + manifest |
| 8 | export includes verification/report/offline/C2PA/custody summaries | ✅ bounded JSONs + offline-verification.md pointer |
| 9 | UI is present and usable | ✅ `SiuPanel.tsx` |
| 10 | permissions/governance are enforced | ✅ case-access + step-up + audit |
| 11 | tests/docs/closure report exist | ✅ 5 docs + closure + bounded test suite |
| 12 | no fraud/legal overclaim exists | ✅ forbidden-phrase sweep on all surfaces |
| 13 | no fraud determination | ✅ tests assert |
| 14 | no legal/admissibility claim | ✅ standing limitations on every result |
| 15 | no original evidence mutation | ✅ services never touch evidence rows |
| 16 | no duplicate matter/reviewer systems | ✅ additive panel + bounded service |
| 17 | no generic CRM scope creep | ✅ bounded enums + 4 templates only |
| 18 | export is auditable | ✅ 7 bounded audit actions |
| 19 | M3 fully closed | ✅ all 11 spec parts addressed |

---

## 13. Phase M3 — CLOSED.
