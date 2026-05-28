# Phase M3.2 — SIU Governance & Export Persistence — Convergence Closure

**Phase:** M3.2 (Final Insurance SIU Enterprise Completion Pass)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M3.1 (SIU Durability)
**Successors:** none scheduled

---

## 0. Scope (verbatim from M3.2 spec)

> This phase must close the remaining 4 deferred gaps:
>
> 1. Dedicated `siu.pii.view` capability
> 2. Dedicated `SIU_PII_REVEAL` step-up purpose
> 3. Durable `CaseSiuSavedView` table + custom per-team saved views
> 4. Persist SIU export ZIP bytes to S3/object storage and support downloading previous exports

All four gaps are closed end-to-end.

---

## 1. PII capability changes

- Three bounded SIU capability identifiers added to `@proovra/shared`:
  - `siu.pii.view`
  - `siu.pii.edit`
  - `siu.pii.export`
- Bounded evaluator at `services/api/src/services/siu/siu-capabilities.service.ts`.
- Phase M3.2 decision: bounded "case owner only" fallback because the existing bounded permission enum does NOT yet declare these strings. The bounded decision shape (`SiuCapabilityDecision`) is stable, so binding each capability to a role through the access policy in a follow-up phase does NOT require any route changes.
- The route layer audits BOTH the outcome and the bounded `reason` (`case_owner_fallback` / `denied_by_default`) so operators can see at-a-glance whether a successful reveal was access-policy-authorised or fallback-authorised.

## 2. `SIU_PII_REVEAL` step-up purpose

- Added to bounded `STEP_UP_PURPOSES` in `packages/shared/src/identity-security.ts`.
- The PII reveal endpoint now calls `requireStepUpForSensitiveAction({ purpose: "SIU_PII_REVEAL", … })` instead of the M3.1 re-used `SIU_EXPORT_GENERATE`.
- Independently auditable — PII reveals and bundle exports no longer share a step-up purpose.

## 3. Saved-view durability

- Prisma model `CaseSiuSavedView` → `case_siu_saved_views` (added by migration `20261005000000_phase_m3_2_siu_governance_export`).
- Bounded `filter_json` validated by `SiuSavedViewFilterSchema`; bounded `sort_json` validated by `SiuSavedViewSortSchema` — both are `.strict()` zod objects with bounded enums on every key.
- Bounded `visibility` enum: `private` / `team` / `organization`.
- Service at `services/api/src/services/siu/siu-saved-views.service.ts` with `listCustomSavedViews` / `createSavedView` / `updateSavedView` / `deleteSavedView` / `markSavedViewUsed`. Every operation is workspace-scoped.
- Routes:
  - `GET /v1/siu/saved-views` (static presets, M3.1)
  - `GET /v1/siu/saved-views/custom?teamId=…`
  - `POST /v1/siu/saved-views`
  - `PATCH /v1/siu/saved-views/:id?teamId=…`
  - `DELETE /v1/siu/saved-views/:id?teamId=…`
  - `POST /v1/siu/saved-views/:id/use`
- Tenancy: every CRUD verifies team membership via `teamMember`. Private rows are creator-gated for PATCH/DELETE/USE.

## 4. Export persistence

- Bundle builder now uploads the ZIP via `putObjectBuffer({ immutable: true })` after the bundle is assembled.
- Bounded storage-key convention: `siu-exports/<teamId>/<caseId>/<artifactSha16>.zip`.
- Row creation order:
  1. Build bundle bytes + compute SHA-256.
  2. Attempt S3 upload (immutable, with bounded metadata headers).
  3. Create `CaseSiuExport` row with `export_status = "generated"` on success, `"failed"` on upload error (with bounded `error_code` + `error_message`).
- When `S3_BUCKET` is unconfigured, the row is recorded as `failed` with bounded code `siu_export_storage_unconfigured` — honest copy; the response stream still ships the bytes for compatibility.

## 5. Previous export download

- Route: `GET /v1/cases/:id/siu-exports/:exportId/download`.
- Tenancy: re-verifies `case → siuProfile.teamId === teamId`.
- Bounded refusal when the row's status is not `generated` or `downloaded` (HTTP 409 with bounded reason).
- Streams the bundle bytes from S3 via the existing `getObjectStream`.
- Updates `download_status` → `downloaded` + `downloaded_at_utc` on each successful download (subsequent downloads still work).
- Emits bounded audit action `siu_export_downloaded` with the bounded metadata (export id + SHA-256).
- Storage keys are NEVER returned in any JSON response.

## 6. Frontend summary

- `SiuPanel` extended:
  - Export history table adds a bounded `Action` column with a `siu-export-download-link` `<a download>` element targeting the new download endpoint.
  - Bounded note `siu-history-storage-note` clarifies that storage keys are never rendered.
  - Download link only renders for `generated` / `downloaded` rows; `pending` / `failed` show `—`.
  - PII reveal still uses the existing button; under the hood the step-up purpose is now `SIU_PII_REVEAL` (handled by the backend).
- No raw storage keys, no PII fields beyond the redacted defaults.

## 7. Tests

| Suite | Path |
| --- | --- |
| Bounded enums + step-up + schema + migration + service + routes + UI + docs | `services/worker/test/phase-m3-2-siu-governance-export.test.ts` |

Cumulative offline-verifier suite: full suite all green.
Cumulative worker suite: full suite all green.
Typechecks across all five workspace packages: clean.

## 8. Files changed (summary)

**New:**

- `services/api/prisma/migrations/20261005000000_phase_m3_2_siu_governance_export/migration.sql`
- `services/api/src/services/siu/siu-capabilities.service.ts`
- `services/api/src/services/siu/siu-saved-views.service.ts`
- `services/worker/test/phase-m3-2-siu-governance-export.test.ts`
- `docs/verticals/insurance-siu-saved-views.md`
- `docs/verticals/phase-m3-2-siu-governance-export-closure.md`

**Modified:**

- `services/api/prisma/schema.prisma` — `CaseSiuSavedView` model
- `packages/shared/src/insurance-siu.ts` — `SIU_CAPABILITIES`, `SIU_EXPORT_STATUSES`, `SIU_SAVED_VIEW_VISIBILITY`
- `packages/shared/src/identity-security.ts` — `SIU_PII_REVEAL` step-up purpose
- `packages/shared/src/index.ts` — exports
- `services/api/src/services/siu/siu-export-bundle.service.ts` — S3 upload + download function + bounded failure states
- `services/api/src/routes/siu.routes.ts` — capability-evaluated reveal-PII under `SIU_PII_REVEAL`, saved-view CRUD, download endpoint
- `apps/web/app/(app)/cases/components/SiuPanel.tsx` — download links + storage-safety note
- `docs/verticals/insurance-siu-pii.md` — Phase M3.2 reveal contract

## 9. Migration commands required

```bash
# Non-prod:
pnpm --filter proovra-api prisma migrate dev

# Production / Neon:
pnpm --filter proovra-api prisma migrate deploy
```

Migration is additive only — one new table (`case_siu_saved_views`), no changes to existing tables.

## 10. Remaining blockers

None. M3.2 is closed.

Deferred (out of M3.2 scope):

- Bind each SIU capability to a role through the bounded access-policy permission enum (currently the bounded `case_owner_fallback` path applies). The route layer never needs to change; only the evaluator does.
- Replace the bundle's full-buffer upload with an S3 multipart upload for very large case corpora.
- Per-row signed URL flow for downstream insurers that prefer S3-presigned download links instead of api-streamed downloads.

## 11. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Dedicated `siu.pii.view` implemented | ✅ bounded enum + evaluator + route gate |
| 2 | Dedicated `siu.pii.export` implemented | ✅ bounded enum entry, evaluator-callable |
| 3 | `SIU_PII_REVEAL` implemented | ✅ bounded step-up purpose, route uses it |
| 4 | `SIU_EXPORT_GENERATE` no longer used for PII reveal | ✅ reveal route uses `SIU_PII_REVEAL` exclusively |
| 5 | Custom saved views durable | ✅ Prisma model + CRUD + bounded filter/sort |
| 6 | SIU export bytes persisted to storage | ✅ `putObjectBuffer({ immutable: true })` |
| 7 | Previous exports downloadable | ✅ `/v1/cases/:id/siu-exports/:exportId/download` |
| 8 | Storage keys not exposed | ✅ never serialised in any response; source-contract test |
| 9 | PII redacted by default | ✅ inherited from M3.1 default-redacted projection |
| 10 | No fraud / legal claims | ✅ forbidden-phrase sweep on every new artifact |
| 11 | M3.2 fully closed | ✅ all four deferred gaps closed |

---

## 12. Phase M3.2 — CLOSED.
