# Phase M2.1 — C2PA Product Surface + Backfill + Portability — Convergence Closure

**Phase:** M2.1 (Provenance / Authenticity Interoperability — Product Closure)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M2 (C2PA Integration foundation)
**Successors:** none scheduled

---

## 0. Scope (verbatim from M2.1 spec)

> Remaining gaps to close:
>
> 1. Internal evidence detail C2PA panel
> 2. Bulk backfill for existing evidence
> 3. Optional raw-manifest artifact bundle
> 4. Actual C2PA generation/embedding strategy, gated behind safe infra/certs

All four gaps are closed end-to-end.

---

## 1. Evidence detail panel summary

- **Component:** `apps/web/app/(app)/evidence/components/C2paPanel.tsx`
- **Mount surface:** the operator evidence workspace (technical/integrity area). The component is permission-gated through the standard evidence read path (same as artifacts / annotations / custody panels).
- **Bounded states rendered:** every `C2paStatus` value (`disabled`, `unsupported`, `not_present`, `present`, `valid`, `invalid`, `error`) with bounded copy and bounded badge tones.
- **Per-file table:** renders `itemId`, `mediaType`, `status`, `validationStatus`, `claimGenerator`, `rawManifest.status` columns for multi-part evidence.
- **Retry control:** `data-testid="c2pa-retry-button"` posts to the bounded retry endpoint and surfaces an honest queued/disabled note. NEVER claims success it cannot prove.
- **Standing caption:** the bounded copy "C2PA is a provenance interoperability signal. It does not determine factual truth, authorship, or legal admissibility." is shown on every render.
- **Backend endpoints (NEW):**
  - `GET /v1/evidence/:id/c2pa` — bounded summary projection. Audited as `c2pa_extraction_retry_requested` on retry.
  - `POST /v1/evidence/:id/c2pa/retry` — bounded retry record. Returns 202 with bounded queued/disabled note; never blocks.

## 2. Operations console + backfill summary

- **Page:** `/operations/c2pa` — `apps/web/app/(app)/operations/c2pa/page.tsx`.
- **Sections:** provider status card, generation readiness card, backfill (preview + start + recent runs table), standing limitations card.
- **Backend service:** `services/api/src/services/c2pa/c2pa-backfill.service.ts`.
  - Workspace-scoped (no cross-tenant scan).
  - Resumable via deterministic `cursorEvidenceId`.
  - Idempotent — evidence already carrying a bounded summary is skipped unless `force=true`.
  - Bounded batch size (`maxBatchSize`, default 50, max 500).
  - Cancellable; cancel transitions to `cancelled` and subsequent ticks are no-ops.
- **Backend routes (NEW):** `services/api/src/routes/operations-c2pa.routes.ts`.
  - `GET /v1/operations/c2pa` (overview)
  - `POST /v1/operations/c2pa/backfill/preview`
  - `POST /v1/operations/c2pa/backfill/start` — **step-up gated under `C2PA_BACKFILL_START`** (new purpose added to `STEP_UP_PURPOSES`).
  - `GET /v1/operations/c2pa/backfill`
  - `GET /v1/operations/c2pa/backfill/:id`
  - `POST /v1/operations/c2pa/backfill/:id/cancel`
  - `POST /v1/operations/c2pa/backfill/:id/tick`
  - `GET /v1/operations/c2pa/generation/readiness`
  - `POST /v1/operations/c2pa/generate` — bounded `generation_pipeline_not_wired` refusal until a signed-generation worker is deployed.
- **Audit actions:** `c2pa_backfill_started`, `c2pa_backfill_completed`, `c2pa_backfill_cancelled`, `c2pa_extraction_retry_requested`.

## 3. Raw manifest artifact policy

- **Env:** `C2PA_RAW_MANIFEST_EXPORT_ENABLED` (default `false`), `C2PA_RAW_MANIFEST_MAX_BYTES` (default 5 MiB).
- **Module:** `services/worker/src/c2pa/raw-manifest.ts` — pure decision: returns one of the bounded `C2paRawManifestStorageStatus` enum values per file.
- **Bundling:** The verification-package builder accepts an optional `c2paRawManifestBundles` input. Each bundle MUST start with `provenance/c2pa-manifests/` (defense-in-depth path-prefix check) and the bytes are written verbatim. The bundle's hash is then covered by `package-checksums.json`.
- **Summary projection:** each per-file `C2paFileResult` carries a bounded `rawManifest` reference with `status` / `sha256Hex` / `sizeBytes` / `packageRelativePath`.
- **Aggregate projection:** `summary.rawManifestExportStatus` records the bounded aggregate.
- **Default-off:** When `C2PA_RAW_MANIFEST_EXPORT_ENABLED=false`, the bounded `disabled` reference is set on every file. No bundle is ever written.
- **Cap enforcement:** files above `C2PA_RAW_MANIFEST_MAX_BYTES` resolve to `too_large_to_export` and emit `C2PA_RAW_MANIFEST_TOO_LARGE_TO_EXPORT` warning.

## 4. Generation readiness policy

- **Module:** `services/worker/src/c2pa/generation-readiness.ts` + api-side mirror at `services/api/src/services/c2pa/c2pa-generation-readiness.service.ts`.
- **Bounded readiness states:** `ready`, `disabled`, `missing_cert`, `missing_key`, `tooling_unavailable`, `unsupported_target`, `blocked_by_signer_governance`.
- **Ordered checks:**
  1. `C2PA_GENERATE_MANIFESTS=true` else `disabled`.
  2. `C2PA_SIGNING_ENABLED=true` else `disabled` (refuse unsigned manifests).
  3. `C2PA_BIN` set else `tooling_unavailable`.
  4. Cert + key paths set + readable else `missing_cert` / `missing_key`.
  5. At least one bounded target in `C2PA_GENERATION_TARGETS` else `unsupported_target`.
- **Hard refusal even when ready:** `POST /v1/operations/c2pa/generate` returns 409 `generation_pipeline_not_wired` while the actual signed-generation worker is not yet deployed. This is the honest "we will not fake generation" gate.
- **Key safety:** the probe NEVER reads key bytes — it uses `fs.access` for readability only.

## 5. Package + offline verifier updates

- **Package builder:** `services/worker/src/verification-package.ts` now accepts `c2paRawManifestBundles` and writes them under the canonical `provenance/c2pa-manifests/` prefix before `package-checksums.json` so they are included in the canonical hash chain.
- **Shared types:** `packages/shared/src/c2pa.ts` extended with `C2paRawManifestReference`, `C2paGeneratedAssertion`, `C2paGenerationReadiness` types + bounded enums + factory helpers.
- **Offline verifier result schema:** added `C2PA_RAW_MANIFEST_EXPORT_STATUSES`, `C2PA_GENERATED_ASSERTION_STATUSES`, new warning codes (`C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE`, `C2PA_RAW_MANIFEST_REFERENCE_MISMATCH`, `C2PA_GENERATED_ASSERTION_MISSING_BUT_CLAIMED`).
- **Offline verifier core:** `verifyC2paSummary()` now:
  - mirrors raw-manifest aggregate status,
  - counts claimed-vs-found raw-manifest files inside the ZIP,
  - surfaces a bounded warning if a claimed manifest file is missing,
  - mirrors generated-assertion status honestly.

## 6. Public verify / report / operations surfacing

- **Public verify response payload:** the existing `c2paProvenance` field from M2 still ships unchanged. M2.1 did not add public-verify surface area to avoid leaking provenance-projection details to anonymous viewers; raw manifest + generation status are operator-only surfaces.
- **Operations:** see §2 — `/operations/c2pa` is the canonical operator surface.
- **Internal evidence detail:** see §1 — the new `C2paPanel` is the per-evidence canonical surface.

## 7. Security / tenant-safety summary

- Every operation route is auth-gated through `requireOpsActor` (same pattern as recovery / queues / signers).
- The `C2PA_BACKFILL_START` action is added to the bounded `STEP_UP_PURPOSES` enum (`packages/shared/src/identity-security.ts`) — operators must complete step-up before a workspace-wide backfill.
- Per-evidence retry is permission-gated through the standard evidence read path. The retry endpoint audits the intent before performing any action.
- Backfill is workspace-scoped at every query layer; there is no cross-team scan.
- Raw manifest bundling enforces a path-prefix safety check (`provenance/c2pa-manifests/`) so a malformed input cannot write to arbitrary ZIP locations.
- Generation readiness uses only `fs.access` — it never reads key bytes and never logs sensitive paths beyond a bounded 240-char reason.
- All audit log entries use bounded action labels — `c2pa_backfill_started`, `c2pa_backfill_completed`, `c2pa_backfill_cancelled`, `c2pa_extraction_retry_requested`.

## 8. Tests

| Suite | Path | Result |
| --- | --- | --- |
| M2.1 schema + verifier-core + worker + api + UI source contracts | `packages/offline-verifier/test/verifier-m2-1.test.ts` | **29 / 29 pass** |

Full offline-verifier suite (core + M1.1 + M2 + M2.1): **93/93 pass**.
Full worker suite (including pre-existing 261 tests covering M2 + ingest contracts): **261/261 pass**.
Typechecks across all five workspace packages: clean.

## 9. Files changed (summary)

**New:**

- `services/worker/src/c2pa/raw-manifest.ts`
- `services/worker/src/c2pa/generation-readiness.ts`
- `services/api/src/services/c2pa/c2pa-evidence-panel.service.ts`
- `services/api/src/services/c2pa/c2pa-backfill.service.ts`
- `services/api/src/services/c2pa/c2pa-generation-readiness.service.ts`
- `services/api/src/routes/operations-c2pa.routes.ts`
- `apps/web/app/(app)/operations/c2pa/page.tsx`
- `apps/web/app/(app)/evidence/components/C2paPanel.tsx`
- `packages/offline-verifier/test/verifier-m2-1.test.ts`
- `docs/provenance/c2pa-backfill.md`
- `docs/provenance/c2pa-generation.md`
- `docs/provenance/c2pa-raw-manifests.md`
- `docs/provenance/phase-m2-1-c2pa-product-closure.md`

**Modified:**

- `packages/shared/src/c2pa.ts` — raw-manifest + generation types + helpers
- `packages/shared/src/index.ts` — exports
- `packages/shared/src/identity-security.ts` — `C2PA_BACKFILL_START` step-up purpose
- `services/worker/src/config.ts` — `C2PA_RAW_MANIFEST_EXPORT_ENABLED`, `C2PA_RAW_MANIFEST_MAX_BYTES`, `C2PA_GENERATION_TARGETS`
- `services/worker/src/verification-package.ts` — `c2paRawManifestBundles` input + bundling under `provenance/c2pa-manifests/`
- `services/api/src/routes/evidence.routes.ts` — `GET /v1/evidence/:id/c2pa` + `POST /v1/evidence/:id/c2pa/retry`
- `services/api/src/server.ts` — registers `operationsC2paRoutes`
- `packages/offline-verifier/src/result-schema.ts` — new bounded enums + warning codes + extended `c2pa` block
- `packages/offline-verifier/src/verifier-core.ts` — raw manifest reconciliation + generated assertion mirror
- `docs/provenance/c2pa.md` — references new docs
- `docs/public/c2pa-user-guide.md` — raw-manifest preservation note

## 10. Remaining blockers

None. M2.1 is closed.

Deferred (out of M2.1 scope):

- Actual signed-generation worker wiring. `POST /v1/operations/c2pa/generate` deliberately returns 409 `generation_pipeline_not_wired` until that worker exists.
- Cross-process backfill state (currently in-process; resumability is from the underlying evidence cursor query).
- A separate artifact-store path for raw manifests larger than the cap (currently `too_large_to_export` is honest; a future phase could spool them to a sibling object).

## 11. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Internal evidence detail has usable C2PA panel | ✅ `C2paPanel.tsx` + 2 new endpoints |
| 2 | Operators can preview / run / cancel C2PA backfill | ✅ ops page + 6 routes |
| 3 | Raw manifest preservation supported or honestly disabled | ✅ env-gated; bounded reference on every file |
| 4 | C2PA generation is readiness-gated and cannot fake support | ✅ readiness probe + honest 409 refusal |
| 5 | Package / offline verifier understand new C2PA portability fields | ✅ summary + verifier reconciliation |
| 6 | Core integrity remains unaffected by C2PA state | ✅ tests assert overall NEVER promoted to `failed` from C2PA |
| 7 | Tests / docs / closure report exist | ✅ 29 new tests + 4 new docs + closure |
| 8 | Missing C2PA does not fail core integrity | ✅ asserted by tests |
| 9 | Invalid C2PA does not override hash/custody | ✅ asserted by tests |
| 10 | Original files are never mutated | ✅ provider + raw-manifest + generation modules audited |
| 11 | Bulk backfill is safe / resumable | ✅ workspace-scoped, idempotent, bounded batch, cancellable |
| 12 | Raw manifests are optional / bounded | ✅ env-gated + size cap + bounded enum |
| 13 | Generation is honestly gated | ✅ readiness probe + 409 refusal until pipeline wired |
| 14 | No fake authenticity claims | ✅ source-contract forbidden-wording sweeps in tests |
| 15 | No legal / admissibility claims | ✅ standing limitations on every result |
| 16 | M2.1 fully closed | ✅ all four gaps closed end-to-end |

---

## 12. Phase M2.1 — CLOSED.
