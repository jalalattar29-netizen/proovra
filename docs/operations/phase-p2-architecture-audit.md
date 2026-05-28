# Phase P2 — Operational Architecture Audit (Part 1 deliverable)

**Audience:** product engineers implementing P2; procurement reviewers; future authors.

**Purpose:** before implementing, document exactly what operational infrastructure already exists in the codebase, what is missing, and where the boundary between "extend" and "build new" lies. The P2 spec explicitly says: *"DO NOT IMPLEMENT BEFORE THIS."*

---

## 1. What is already in place

### 1.1 BullMQ queues (18 queues identified)

| Queue | Worker file | Idempotent enqueue? | DLQ pair? | Replay code? |
| --- | --- | --- | --- | --- |
| `report` | `services/worker/src/processor.ts` | yes (`buildReportJobId`) | `report-dlq` | no |
| `report-dlq` | (passthrough) | n/a | self | no |
| `ots-upgrade` | `services/worker/src/ots-upgrade.processor.ts` | yes (per-evidence) | no | no |
| `evidence-purge` | `services/worker/src/processor.ts` | yes (env-key) | no | no |
| `search-indexing` | `services/worker/src/search-indexing.processor.ts` | yes | no | no |
| `media-intelligence` | `services/worker/src/media-intelligence.processor.ts` | yes | `media-intelligence-dlq` | **yes** |
| `media-intelligence-dlq` | (sink) | n/a | self | **yes** (`replayMediaIntelligenceDlq`) |
| `mi-derived-assets` | `services/worker/src/derived-assets.processor.ts` | yes | no | **yes** (`retryDerivedAssetJob`) |
| `mi-exif`, `mi-ocr`, `mi-transcript`, `mi-search-index` | `services/worker/src/subsystem-queue-processors.ts` | yes | no | no |
| `graph-reconcile`, `graph-domain-sync`, `graph-timeline-sync`, `graph-search-projection` | `services/worker/src/subsystem-queue-processors.ts` | yes | no | no |
| `org-health-refresh` | `services/worker/src/subsystem-queue-processors.ts` | yes | no | no |

### 1.2 Existing replay / retry surface

- `services/api/src/queue/media-intelligence-queue.ts`:
  - `replayMediaIntelligenceDlq({ maxJobs })` — drains the MI DLQ via `job.retry()`, capped at 200.
  - `retryMediaIntelligenceJob(jobId)` — single-job retry.
  - "NEVER mutates job payloads, NEVER changes job ids" is verbatim from the file.
- `services/api/src/queue/derived-assets-queue.ts`: `retryDerivedAssetJob(jobId)`.
- Routes (in `ops.routes.ts`):
  - `POST /v1/ops/media-intelligence/dlq/replay` — step-up gated via `requireOpsActorAction()`.
  - `POST /v1/ops/media-intelligence/runs/:runId/retry` — same gate.

### 1.3 Worker observability primitives

- `services/worker/src/observability.ts`:
  - `heartbeat(workerId)` — emits a structured JSON line every `WORKER_HEARTBEAT_INTERVAL_MS` (default 30s).
  - `snapshotQueueHealth(queues)` — every `WORKER_QUEUE_HEALTH_INTERVAL_MS` (default 60s); samples waiting/active/delayed/completed/failed/paused + `oldestPendingAgeSeconds` for **3 of 18** queues (report, ots-upgrade, evidence-purge).
- No central stuck-worker detector. No automatic move-to-DLQ on staleness. BullMQ `lockDuration` is not customised (default 30s applies).

### 1.4 Export generation

| Surface | File | Output | Manifest? | Signing? |
| --- | --- | --- | --- | --- |
| Report PDF | `services/worker/src/report-v2/build-report-pdf.ts` | binary PDF | none | optional KMS PDF sign (`services/worker/src/pdf/signPdf.ts`) gated on `assertPdfSigningProductionSafetyOrThrow()` |
| Verification Package ZIP | `services/worker/src/verification-package.ts` | ZIP via `archiver` | type fields exist (`manifestPresent`, `signedManifestPresent`, `checksumIndexPresent`) but no canonical manifest *schema* is exported | per-file SHA-256 included |
| Governance / Destruction certificate | `apps/web/components/governance/DestructionCertificate.tsx` + `services/api/src/routes/governance-lifecycle.routes.ts` | rendered on demand from lifecycle state | none | none |
| Audit export | `services/api/src/routes/admin-audit.routes.ts` | unknown JSON shape | none | none |
| Recovery export | — | not implemented | n/a | n/a |

### 1.5 Signing infrastructure

- `services/api/src/signing/signer.ts` — abstract `EvidenceSigner`.
- `services/api/src/signing/kms-signer.ts` — AWS KMS implementation using `@aws-sdk/client-kms`.
- `LocalPemEvidenceSigner` — local PEM (`ed25519SignHexWithKeyPath`).
- Today signs: evidence fingerprint hash, optionally the report PDF body. **Manifests are not signed today** (because no manifest exists).

### 1.6 Object Lock integration

- `services/api/src/storage.ts` (mirrored by worker):
  - `verifyObjectLockConfiguration()` on startup returns a bounded result enum: `verified` / `claimed-but-unsupported` / `disabled` / `skipped`.
  - `applyObjectRetention()` / `applyDefaultObjectRetention()` issue `PutObjectRetentionCommand` / `PutObjectLegalHoldCommand`.
- Evidence + EvidencePart rows track per-object: `storageObjectLockMode`, `storageObjectLockRetainUntilUtc`, `storageObjectLockLegalHoldStatus`.
- **No operational route exposes this state today.** The Object Lock verification result is computed at startup but only logged.

### 1.7 Reproducibility primitives

- `services/api/src/stream-hash.ts` — `sha256HexFromStream()`.
- Evidence schema: `hashSemantics` (`"single_file"` / `"multipart_composite"`) + `multipartManifestSha256` for the canonical newline-joined per-part digest.
- **No export-level reproducibility verifier exists today.** No code regenerates an export and compares hashes.

### 1.8 Frontend operational surfaces today

- `apps/web/app/(app)/operations/reliability/page.tsx` — upload-pipeline reliability console (sessions + queue policy metadata, NOT live queue state).
- `apps/web/app/(app)/ops/page.tsx` — Ops Center hub.
- `apps/web/app/(app)/ops/runbooks/page.tsx`, `/ops/observability/page.tsx`, `/ops/analytics/page.tsx`, `/ops/media-graph/page.tsx`.
- Route registry: `OPS` domain established. Capability gates: `OPS_CENTER_VIEW`, `OBSERVABILITY_VIEW`, `RUNBOOKS_VIEW`.
- Design tokens reusable from `apps/web/app/(app)/admin/identity/ui-tokens.ts` (`TOKENS`, `pageStyle`, `cardStyle`, `tableStyle`, `badgeStyle`, etc.).

### 1.9 Backup / restore

- **No application-layer backup or restore code exists.** Confirmed by exhaustive scan of `services/api/scripts/`, `services/worker/scripts/`, root `scripts/`.
- `docs/recovery/` exists. Runbooks under `docs/operations/`.
- The platform delegates DB backups to the managed Postgres provider; S3 retention to bucket policy + Object Lock.
- P2's DR validation must be **honest** about this: we can validate what the application can reach — manifests, export reproducibility, audit-trail completeness — but we cannot independently validate infra-layer backups without an out-of-band probe.

---

## 2. The eight required maps

### 2.1 Replay safety matrix

| Job kind | Category | Why | Step-up needed? |
| --- | --- | --- | --- |
| `RebuildSearchDocument` (search-indexing) | **safe** | append-only upsert | no |
| `RunMediaIntelligence` + `mi-*` derivatives | **safe** | read-only analysis; upsert of intelligence runs | no |
| `RefreshOrgHealthProjection` | **safe** | bounded upsert keyed `(teamId, sampledAtUtc)` | no |
| `ReconcileTeamGraph` + `graph-*` subsystems | **safe** | projection upserts | no |
| `GenerateDerivedAsset` (thumbnails) | **safe** | S3 PUT upsert | no |
| `UpgradeOts` (ots-upgrade) | **safe with step-up** | external blockchain anchor attempt; safe to re-attempt but cumulative cost | yes |
| `GenerateReport` | **safe with step-up** | idempotent overall but performs PDF signing + artifact moves — a partial-failure replay is the most risk-bearing path; require step-up | yes |
| `PurgeDeletedEvidenceJob` (evidence-purge) | **forbidden** | hard-deletes evidence rows + S3 objects. Replay would either no-op (already gone) or attempt to delete data that has since been re-created. Operator should diagnose, not re-run. | n/a |

### 2.2 DLQ topology map

Today:
- Explicit DLQ pair: `report` ↔ `report-dlq`, `media-intelligence` ↔ `media-intelligence-dlq`.
- All other 14 queues fall back to BullMQ's built-in `failed` state.
- **Gap**: there is no canonical DLQ contract — failed jobs in `report-dlq` have no replay route today; only MI does.

### 2.3 Queue observability map

- Per-queue: BullMQ native counts are reachable via `queue.getJobCounts()`. Available everywhere; surfaced nowhere.
- Heartbeat: stdout log only; no metric.
- Queue health snapshot: log only; covers 3/18 queues.
- Bounded metric registry: `jobs_started_total`, `jobs_failed_total`, `jobs_retry_exhausted_total`, `media_intelligence_enqueue_total/failed_total`, `derived_assets_enqueue_total/failed_total`, `search_indexing_*`. No `worker_heartbeat_missing_total`, no `dlq_job_total`.

### 2.4 Export reproducibility map

- Per-file hashes exist (`fileSha256`, multipart composite).
- Per-export manifests do **not** exist.
- The verification package builder *references* manifest fields in its type, but the canonical manifest schema is not exported.
- There is no service that regenerates an export and checks the result against a stored hash.

### 2.5 Backup / restore gap map

- **App-layer backups**: none. P2 must NOT claim otherwise.
- **App-layer restores**: none.
- **What we *can* honestly validate at the app layer:**
  - That every previously-exported manifest still verifies (hash + signature) — *manifest integrity validation*.
  - That every export's referenced S3 objects still exist and have the expected SHA-256 — *artifact presence validation*.
  - That Object Lock metadata persisted at PUT time still matches the live retention/legalHold state — *retention drift validation*.
  - That the audit trail for each export has no gaps in `createdAt` between expected sentinel events — *audit-trail continuity validation*.

### 2.6 Immutable operations risk map

| Risk | Surface affected |
| --- | --- |
| Fake WORM claim if Object Lock disabled or unsupported | Frontend export pages; we must read `verifyObjectLockConfiguration()` result and surface honestly. |
| Reproducibility claim without verifier | Export UI must not promise "reproducible" unless verifier ran + passed. |
| Replay of forbidden destructive job | Queue operations console must hard-refuse the destructive `evidence-purge` replay path. |
| Cross-tenant operational leakage | Every operational read must filter on `teamId`. |

### 2.7 Worker failure-mode map

- Default BullMQ `lockDuration` (30s). Workers that block longer than that mark jobs as stalled.
- Heartbeat staleness is not auto-acted-on; an operator must read the log.
- Recommendation for P2: compute heartbeat staleness against `WORKER_HEARTBEAT_INTERVAL_MS * 3` as the default "missing" threshold.

### 2.8 Operational UX gap map

- No /operations/exports.
- No /operations/queues.
- No /operations/recovery.
- `/operations/reliability` exists but is upload-pipeline-only.
- The `OPS` route domain + design tokens are available; we should reuse, not invent.

---

## 3. Implementation principles for P2

1. **Extend, do not replace.** Generalize the MI DLQ pattern (`replayMediaIntelligenceDlq`) to a queue-generic surface that covers all queues, but keep MI's existing wiring intact for backward compatibility.
2. **Honest WORM gating.** The frontend MUST conditionally render the "Immutable storage" badge based on the result of `verifyObjectLockConfiguration()` — never as a constant.
3. **Honest reproducibility gating.** A "Reproducible" badge appears only after the verifier has successfully re-derived the manifest hash.
4. **Honest DR scope.** P2 ships *what the app can validate at the app layer*. The runbook explicitly states what infra-layer backups are NOT covered.
5. **Replay safety enforced at the route layer.** The route refuses forbidden replays with a bounded error code; the UI never offers the button for forbidden jobs.
6. **Bounded vocabulary everywhere.** Failure reasons, replay categories, validation outcomes are all enums — no free-form strings to operators.

This document is the canonical input for the P2.1 through P2.10 implementation steps. Subsequent docs (`worm-exports.md`, `queue-operations.md`, `recovery-validation.md`, `replay-safety.md`, `immutable-operations-runbook.md`) refer back to this file for any "where does X live today" question.
