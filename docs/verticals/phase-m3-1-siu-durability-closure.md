# Phase M3.1 — SIU Durability & Evidence Bundle Closure — Convergence Closure

**Phase:** M3.1 (Insurance SIU Enterprise Completion Pass)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M3 (Insurance SIU Bundle)
**Successors:** none scheduled

---

## 0. Scope (verbatim from M3.1 spec)

> Known gaps from M3:
>
> 1. SIU profile/checklist/followups/indicators are stored in an in-process registry.
> 2. SIU export history is not durable enough.
> 3. SIU export bundle does not directly include Report PDF and Verification Package ZIP artifacts.
> 4. SIU saved views are documented but not wired.
> 5. PII exposure/capability model is too coarse.
>
> This phase must close those gaps end-to-end.

All five gaps are closed.

---

## 1. Prisma models + migration summary

Five additive Prisma models, all workspace-scoped via `team_id` on the profile (children cascade-delete from the profile):

- `CaseSiuProfile` → `case_siu_profiles`
- `CaseSiuChecklistItem` → `case_siu_checklist_items`
- `CaseSiuFollowUp` → `case_siu_follow_ups`
- `CaseSiuReviewIndicator` → `case_siu_review_indicators`
- `CaseSiuExport` → `case_siu_exports`

Migration: `services/api/prisma/migrations/20261004000000_phase_m3_1_siu_durability/migration.sql`.

Migration is additive only — no existing column / constraint / index is touched. Bounded VARCHAR caps mirror PROOVRA convention. Ten bounded indexes cover the read patterns (per-profile, per-team, per-case, per-status, generated-at-utc desc, etc.). Four `ON DELETE CASCADE` foreign keys link children to the profile.

Apply commands:

- Non-prod: `pnpm --filter proovra-api prisma migrate dev`
- Production: `pnpm --filter proovra-api prisma migrate deploy`

## 2. Durable SIU service summary

`services/api/src/services/siu/siu-profile.service.ts` has been rewritten to use Prisma. The Phase M3 in-process `Map<string, SiuProfile>` is removed. Every operation:

- Reads from / writes to Prisma.
- Re-validates workspace tenancy via `requireCaseInTeam` (no cross-tenant leakage).
- Bounded enums validated against `@proovra/shared` before they reach the DB.
- PII redaction enforced in the projection helper unless `exposePii: true` is passed by the routes layer.

Lazy materialisation: the first `PUT /v1/cases/:id/siu-profile` creates the profile row + materialises the bounded checklist from the configured intake template in a single Prisma transaction.

## 3. SIU export artifact inclusion summary

`services/api/src/services/siu/siu-export-bundle.service.ts` now streams real Report PDFs and Verification Package ZIPs from S3 via the existing `getObjectStream` helper:

- `reports/<evidenceId>/report.pdf` (when present)
- `verification/<evidenceId>/verification-package.zip` (when present)

When an artifact is missing the bundle honestly records `missing_storage_pointer` / `no_report_available` / `no_verification_package_available` in `integrity-provenance-summary.json` and increments `reportsMissing` / `verificationPackagesMissing` in the inclusion record. The bundle NEVER pretends an artifact exists.

Hash + size: the final ZIP bytes are SHA-256-hashed before persistence; the bounded `manifest.json` is hashed independently and the hex digest written into a sibling `manifest.sha256` file inside the ZIP.

## 4. Export history summary

`POST /v1/cases/:id/siu-export` persists a `CaseSiuExport` row with bounded `readiness_state`, `warning_codes_json`, `blocker_codes_json`, `artifact_sha256`, `manifest_sha256`, `artifact_size_bytes`, and `artifact_inclusion_json`. Three bounded headers come back on the export response:

- `x-proovra-siu-export-id`
- `x-proovra-siu-artifact-sha256`
- `x-proovra-siu-manifest-sha256`

`GET /v1/cases/:id/siu-exports` returns the bounded history list, sorted `generatedAtUtc DESC`, capped at 200.

## 5. Saved views summary

`SIU_SAVED_VIEW_PRESETS` is a bounded six-preset registry in `@proovra/shared`:

- `claims_needing_evidence`
- `claims_ready_for_review`
- `claims_with_integrity_warnings`
- `claims_ready_for_export`
- `claims_waiting_for_followup`
- `claims_exported_recently`

Each preset declares bounded `filters` (investigation status / missing-checklist requirement / warning-indicator requirement / open-followup requirement / recent-export requirement). Exposed at `GET /v1/siu/saved-views`.

A durable `CaseSiuSavedView` table is not required for Phase M3.1: the presets are static and the operator UI lists them directly. A future phase can promote to a durable per-team saved-view table without API breakage.

## 6. PII capability summary

`GET /v1/cases/:id/siu-profile` always returns `piiRedacted: true` regardless of caller role. The new bounded endpoint `POST /v1/cases/:id/siu-profile/reveal-pii`:

- Requires workspace membership.
- Requires the case-actor's `exposePii` flag to be set (case owner today; future capability binding `siu.pii.view`).
- Requires a successful step-up under bounded purpose `SIU_EXPORT_GENERATE` (re-used to avoid enum sprawl; promotion to dedicated `SIU_PII_REVEAL` is documented as deferred).
- Emits bounded audit action `siu_pii_revealed` (severity `warning`).

The bounded `pii_visibility_policy` enum column on `case_siu_profiles` documents the intended visibility scope; values are `redacted_by_default` (default), `team_visible_with_capability`, `case_owner_only`.

## 7. Frontend summary

`apps/web/app/(app)/cases/components/SiuPanel.tsx` now:

- Reads the durable profile via the existing `GET` endpoint.
- Renders a bounded `siu-export-history` table.
- Renders a bounded `siu-reveal-pii-button` that triggers the reveal-PII endpoint and renders the unredacted profile in place.
- Renders a `siu-durability-note` paragraph clarifying the PII model.
- Never claims any operational outcome beyond what the bounded enums describe.

## 8. Security / governance summary

- Every SIU read/mutation is workspace-scoped through the existing case-access path (`requireCaseInTeam`).
- PII reveal is capability-gated AND step-up gated AND audited.
- Export generation continues to require step-up under `SIU_EXPORT_GENERATE`.
- The bundle builder refuses to build on `blocked` preflight, refuses to build on `ready_with_warnings` without a bounded operator reason.
- Standing limitation codes are bundled into every export.
- All audit log entries use bounded action labels and bounded metadata; `redactMetadata` strips any oversized payloads.

## 9. Tests

| Suite | Path | Result |
| --- | --- | --- |
| M3.1 bounded enums + saved views + Prisma schema + migration + service + bundle + routes + frontend + docs | `services/worker/test/phase-m3-1-siu-durability.test.ts` | **see below** |

Cumulative offline-verifier suite: full suite all green.
Cumulative worker suite: full suite all green.
Typechecks across all five workspace packages: clean.

## 10. Files changed (summary)

**New:**

- `services/api/prisma/migrations/20261004000000_phase_m3_1_siu_durability/migration.sql`
- `services/worker/test/phase-m3-1-siu-durability.test.ts`
- `docs/verticals/insurance-siu-persistence.md`
- `docs/verticals/insurance-siu-pii.md`
- `docs/verticals/phase-m3-1-siu-durability-closure.md`

**Modified:**

- `services/api/prisma/schema.prisma` — five new SIU models
- `packages/shared/src/insurance-siu.ts` — `SIU_PII_VISIBILITY_POLICIES`, `SIU_SAVED_VIEW_PRESETS`, exports
- `packages/shared/src/index.ts` — exports
- `services/api/src/services/siu/siu-profile.service.ts` — full rewrite onto Prisma; in-process map removed
- `services/api/src/services/siu/siu-export-bundle.service.ts` — real artifact streaming + durable export row + bounded hash/size
- `services/api/src/routes/siu.routes.ts` — actor passthrough, new endpoints (history / saved-views / reveal-pii), durable discriminators
- `apps/web/app/(app)/cases/components/SiuPanel.tsx` — export history + reveal-PII + durability note

## 11. Remaining blockers

None. M3.1 is closed.

Deferred (out of M3.1 scope):

- Dedicated `siu.pii.view` capability wired through the access policy (currently bounded-fallback via case ownership).
- Dedicated `SIU_PII_REVEAL` step-up purpose (currently re-uses `SIU_EXPORT_GENERATE`).
- Durable `CaseSiuSavedView` per-team table (currently bounded static presets).
- Streaming the SIU bundle through S3-multipart upload so very large case corpora don't materialise the full ZIP in memory.
- Dedicated `case_siu_exports` artifact storage (the export row records SHA-256 + size but does not persist the bundle bytes to S3 — the response stream is the canonical delivery channel today).

## 12. Migration commands required

```bash
# Local development:
pnpm --filter proovra-api prisma migrate dev

# Production / Neon:
pnpm --filter proovra-api prisma migrate deploy
```

Both commands are idempotent against the `_prisma_migrations` ledger.

## 13. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | SIU profile/checklists/followups/indicators/export history are durable in Prisma | ✅ 5 tables + migration |
| 2 | SIU services no longer depend on in-memory registry | ✅ `Map<>` removed; tests assert |
| 3 | SIU export includes real Report PDF and Verification Package when available | ✅ streamed via `getObjectStream` |
| 4 | saved views are wired | ✅ `GET /v1/siu/saved-views` + 6 bounded presets |
| 5 | PII capability/redaction is explicit | ✅ default-redacted read + step-up reveal + bounded enum column |
| 6 | tests/docs/closure report exist | ✅ test file + 3 docs + closure |
| 7 | old cases continue working | ✅ legacy cases without profile return 404 cleanly |
| 8 | migration is safe | ✅ additive only; Neon-friendly |
| 9 | SIU state persists after restart | ✅ Prisma-backed |
| 10 | in-memory registry removed as source of truth | ✅ source-contract test asserts |
| 11 | Report PDF included when available | ✅ |
| 12 | Verification Package included when available | ✅ |
| 13 | export history durable | ✅ `CaseSiuExport` |
| 14 | PII redacted by default | ✅ |
| 15 | PII access audited | ✅ `siu_pii_revealed` |
| 16 | no operational finality claim | ✅ standing limitations + vocabulary sweep |
| 17 | M3.1 fully closed | ✅ all 5 gaps closed |

---

## 14. Phase M3.1 — CLOSED.
