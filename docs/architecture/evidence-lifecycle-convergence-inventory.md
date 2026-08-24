# Evidence Lifecycle Convergence — implementation inventory

Baseline: `origin/main` @ `9d902eea` (the additive shared authority, no runtime wiring).
Canonical authority: `packages/shared/src/evidence-retention-lifecycle.ts`.

Classification: **KEEP** (unchanged) / **MIGRATE** (rewired onto the canonical
authority) / **DELETE** (removed after zero-consumer proof) / **COMPAT-READ**
(kept as a thin presentation/compatibility mapper with no decision authority).

---

## A. READ AUTHORITIES

| # | Authority | Location | Today | Verdict |
|---|-----------|----------|-------|---------|
| A1 | Frontend delete eligibility | `apps/web/app/(app)/evidence/lib/evidence-delete-eligibility.ts` | Independent client mirror: retention/Object-Lock/legal-hold predicates decide `canMoveToTrash`. Blocks trash on retention — **wrong semantics**. | **DELETE** (replaced by a lifecycle-capability presentation mapper) |
| A2 | Backend delete eligibility | `services/api/src/services/evidence/evidence-delete-eligibility.service.ts` | Second copy of the same predicates; blocks trash on COMPLIANCE retention + `retentionUntilUtc`. | **MIGRATE** → thin wrapper over `computeEvidenceLifecycleCapabilities` |
| A3 | Evidence Library scope/status | `apps/web/app/(app)/evidence/lib/evidence-library-status.ts`, `evidence-library-types.ts`, `components/EvidenceFilters.tsx` | Scope union `active\|archived\|deleted\|locked`; `getEvidenceScope` derives from raw timestamps. User label "Deleted". | **MIGRATE** → `resolveEvidenceProductState`, scopes Active/Archived/Trash |
| A4 | Evidence Details lifecycle UI | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx` | Consumes A1; renders "cannot move to trash until \<retention date\>". | **MIGRATE** |
| A5 | Bulk action availability | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx` | Consumes A1 (`protectedSelected`, `allSelectedProtected`). | **MIGRATE** |
| A6 | Governance lifecycle projections | `services/api/src/routes/governance-lifecycle.routes.ts`, `case-workspace.routes.ts`, `ai/evidence-analysis-snapshot.service.ts` | Read `lifecycleState` directly for governance surfaces. | **KEEP** (governance state pointer is legitimate; now includes TRASHED) |
| A7 | List/detail projections | `services/api/src/routes/evidence.routes.ts` (`mapEvidenceListItem`, `toSafeEvidence`, scope filter L2217-2223) | Scope filter keys off raw `archivedAt`/`deletedAt`. | **MIGRATE** → `lifecycleState` |

## B. WRITE AUTHORITIES

| # | Authority | Location | Today | Verdict |
|---|-----------|----------|-------|---------|
| B1 | Single archive | `evidence.routes.ts` `POST /v1/evidence/:id/archive` (L5991) | Inline `data:{archivedAt:new Date()}` + inline guards. | **MIGRATE** → canonical service |
| B2 | Single unarchive | `POST /v1/evidence/:id/unarchive` (L6098) | Inline `archivedAt:null`. | **MIGRATE** |
| B3 | Single trash | `DELETE /v1/evidence/:id` (L6290) | Inline `deletedAt/deletedAtUtc/deletedByUserId/deleteScheduledForUtc`; **`assertEvidenceDeletionAllowedByRetention` wrongly blocks soft-trash**. | **MIGRATE** |
| B4 | Single restore-from-trash | `POST /v1/evidence/:id/restore` (L6382) | Inline clear; **owner-only auth bypass** (`ownerUserId !== userId → 403`), no capability check. | **MIGRATE** |
| B5 | Bulk archive/unarchive/trash/restore | `POST /v1/evidence/bulk` (L6922/6939/6975/7005) | Four more inline copies of B1–B4 with slightly different guards. | **MIGRATE** |
| B6 | Retention reconciliation | `services/api/src/services/governance/retention-sweeper.service.ts` (L113) | Writes `retentionReconciliationFlaggedAtUtc` only. Not a lifecycle-state writer. | **KEEP** |
| B7 | `PurgeDeletedEvidenceJob` | `services/worker/src/processor.ts#processPurgeDeletedEvidence` (L4677) | Independent executor: own eligibility checks, S3 deletes, **`tx.evidence.delete` hard-deletes the row** — no tombstone, no DESTROYED state, no certificate. Also **skips archived records entirely**. | **MIGRATE** → trigger/adapter; executor logic **DELETE** |
| B8 | Governance destruction orchestrator | `services/worker/src/governance/destruction-orchestrator.worker.ts` | Sets `status:"STORAGE_DELETED"` **without deleting anything**, then `lifecycleState:"DESTROYED"` + certificate hash. **This is the certificate defect (§16).** | **MIGRATE** → trigger/adapter; executor logic **DELETE** |
| B9 | Phase-4B `executeDestruction` | `services/api/src/services/lifecycle/destruction-governance.service.ts` (L454) | Third executor: S3 deletes, then `lifecycleState:"DESTROYED"`, then certificate. No durable lease, no post-delete verification, no re-computation of eligibility. | **MIGRATE** → trigger/adapter; executor logic **DELETE** |
| B10 | `executeApprovedReview` | `services/api/src/services/governance-lifecycle/destruction-review.service.ts` (L567) | **Fourth** executor: DESTROYED + certificate hash with **zero storage deletion**. | **MIGRATE** → trigger/adapter; executor logic **DELETE** |
| B11 | Governance lifecycle orchestrator | `services/api/src/services/governance-lifecycle/lifecycle-orchestrator.service.ts` (L452) | Canonical `lifecycleState` writer + ledger for governance transitions. | **KEEP**, but DESTROYED becomes reachable only from the canonical executor |
| B12 | Workspace teardown | `services/api/src/routes/teams.routes.ts` (L1694) | `updateMany` reassigns `ownerUserId`; reads `deletedAt` as a filter only. | **KEEP** |
| B13 | Retention-on-create | `services/api/src/services/governance.service.ts` (L1177) | Writes `retentionUntilUtc`. Not lifecycle state. | **KEEP** |
| B14 | Publication state | `services/api/src/services/governance/publication.service.ts` (L83) | Writes `publicVerifyState`. | **KEEP** (§23 adds an explicit trash→unpublish rule) |
| B15 | Storage quota | `services/api/src/services/workspace-usage.service.ts` (L255), `services/worker/src/workspace-billing.ts` (L255) | Excludes `deletedAt != null` — **trashed bytes stop counting while still stored (§22)**. | **MIGRATE** |

## C. MISSING (to be built)

| # | Capability | Note |
|---|-----------|------|
| C1 | Canonical lifecycle mutation service | archive/unarchive/trash/restore, one implementation, single + bulk |
| C2 | `TRASHED` lifecycle state + backfill | schema convergence (§6) |
| C3 | Canonical physical destruction executor | lease → reload → recompute → delete → verify → tombstone → certificate (§14) |
| C4 | Trash-grace reconciliation producer | scan expired grace, evaluate, observe/enqueue (§18) |
| C5 | Non-mutating dry-run candidate report | `evaluateDestructionCandidate` over trashed records (§13) |
| C6 | Production safety flag | automatic destruction observe-only by default (§19) |

## D. SANCTIONED DISPOSABLE PROOF INFRASTRUCTURE (§7) — located, running

| Component | Provisioning | Status |
|-----------|--------------|--------|
| PostgreSQL 16 + pgvector | `p12-pg` container (`pgvector/pgvector:pg16`, host 55432); `@testcontainers/postgresql` fallback in `services/api/test/integration-harness.ts` | UP |
| Redis | `p12-redis` (`redis:7-alpine`, host 56379) | UP |
| S3 (MinIO) | `p7-minio` (`minio/minio:latest`, host 59000), bucket `point7-local-bucket`, guarded by `e2e/point7/_storage-target.ts` (loopback + disposable-bucket only) | UP |
| Migration/schema gates | `services/api` scripts: `db:raw-schema-verify`, `db:migration-inventory`, `db:drift-check`, `db:diff-guard`, `migration-rehearsal.mjs`, `db:preflight` | available |
| Integration runner | `pnpm --filter @proovra/api test:integration` (vitest `test/**/*.integration.test.ts`) | available |

No production AWS/S3 is touched by any gate in this program.
