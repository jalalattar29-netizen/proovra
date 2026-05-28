# Phase P2 — Final Closure Report

**Audience:** product engineers, ops leads, procurement reviewers.

**Purpose:** confirm that Phase P2 (Immutable Operations Platform) is closed end-to-end across all 11 parts.

---

## 1. P2.2 — WORM Export Frontend (CLOSED)

- New page: `apps/web/app/(app)/operations/exports/page.tsx`.
- Consumes the five P2.1 endpoints: list, Object Lock status, detail, manifest, verify.
- Renders:
  - Object Lock platform-status panel with bounded `verified` / `claimed-but-unsupported` / `disabled` / `skipped` states.
  - Export-history table with kind / version / generated / size / Object Lock / signed columns.
  - Inspect drawer with manifest JSON viewer, copy-hash, copy-JSON, signature status table, and the reproducibility verifier with its five bounded outcome states.
- The "IMMUTABLE" pill is gated on `objectLockMode === "verified" && it.objectLockStoredMode !== null`. No fake-green path exists.

## 2. P2.3 — Queue Operations Backend (CLOSED)

- New services:
  - `services/api/src/services/operations/queue-replay-safety.service.ts` — bounded matrix covering 17 known queues.
  - `services/api/src/services/operations/queue-inventory.service.ts` — lazy queue handles, inventory projection, failed-job listing with stack sanitisation, worker-health derivation.
  - `services/api/src/services/operations/queue-replay-action.service.ts` — retry / replay / cancel actions, reason-required, audit event chain.
- New routes: `services/api/src/routes/operations-queues.routes.ts` registers 7 endpoints.
- Step-up gating: `requires_step_up` jobs route through purpose `QUEUE_JOB_REPLAY`.
- `forbidden` jobs hard-refuse with bounded code `replay_forbidden`.

## 3. P2.4 — Queue Operations Frontend (CLOSED)

- New page: `apps/web/app/(app)/operations/queues/page.tsx`.
- Sections: queue overview cards, worker health panel (only renders when degraded/missing), failed-jobs table with replay-safety badges, replay dialog with reason input + step-up integration.
- Replay button is HIDDEN for `forbidden` and `unknown` categories — operator sees explanatory copy referring to the audit center.
- Replay reason is required (≥1 char) at both UI and backend.
- `StepUpModal` is mounted; `requires_step_up` rows route through `runStepUpAction`.

## 4. P2.5 — DR / Recovery Backend (CLOSED)

- New service: `services/api/src/services/operations/recovery-validation.service.ts`.
- Backup validation: DB connectivity, Object Lock platform mode, recent exports presence, 24h audit-trail continuity, plus explicit `unsupported` entries for infra-layer DB + S3 backups.
- Restore validation: Prisma migration history, Object Lock retention, 7d audit lineage, Redis reachability, plus explicit `unsupported` entries for full DR rehearsal + cross-region failover. **Step-up gated** via purpose `RESTORE_VALIDATION_EXECUTE`.
- Persistence: reports stored as `SecurityEvent` rows with bounded event types; no new Prisma model required.
- New routes: `services/api/src/routes/operations-recovery.routes.ts` registers 5 endpoints.

## 5. P2.6 — DR / Recovery Frontend (CLOSED)

- New page: `apps/web/app/(app)/operations/recovery/page.tsx`.
- Readiness summary with Object Lock mode + last-backup / last-restore outcome badges.
- Honest **Unsupported Domains** panel listing the categories the app cannot validate.
- Run-backup and Run-restore buttons (restore is step-up gated).
- Recent-reports table + drawer with the full check list, per-check outcome badge, recommended action.
- No "all systems go" copy. No "backup guaranteed". No "restore guaranteed". Verified by test.

## 6. P2.7 — Tests / Docs / E2E (CLOSED)

- `services/api/test/phase-p2-final-closure.test.ts` — **32 source-contract tests** covering P2.2 through P2.7.
- Combined P2 / P2.0 / P2.0B / P1.1 suites: **88 tests passing**.
- API typecheck: clean.
- Web typecheck: clean.
- 5 new docs (this file makes 6): `worm-exports.md`, `queue-operations.md`, `replay-safety.md`, `recovery-validation.md`, `immutable-operations-runbook.md`, plus this closure report.

## 7. Routes added (P2 total)

```
GET  /v1/operations/exports                                    (P2.1)
GET  /v1/operations/exports/object-lock                        (P2.1)
GET  /v1/operations/exports/:id                                (P2.1)
GET  /v1/operations/exports/:id/manifest                       (P2.1)
POST /v1/operations/exports/:id/verify                         (P2.1)

GET  /v1/operations/queues                                     (P2.3)
GET  /v1/operations/queues/workers                             (P2.3)
GET  /v1/operations/queues/replay-safety                       (P2.3)
GET  /v1/operations/queues/:queueName/failed                   (P2.3)
POST /v1/operations/queues/:queueName/jobs/:jobId/retry        (P2.3)
POST /v1/operations/queues/:queueName/jobs/:jobId/replay       (P2.3, step-up)
POST /v1/operations/queues/:queueName/jobs/:jobId/cancel       (P2.3)

GET  /v1/operations/recovery                                   (P2.5)
POST /v1/operations/recovery/validate-backup                   (P2.5)
POST /v1/operations/recovery/validate-restore                  (P2.5, step-up)
GET  /v1/operations/recovery/reports                           (P2.5)
GET  /v1/operations/recovery/reports/:id                       (P2.5)
```

## 8. Bounded registries extended

### Step-up purposes (`packages/shared/src/identity-security.ts`)
- `QUEUE_JOB_REPLAY` (P2.3)
- `RESTORE_VALIDATION_EXECUTE` (P2.5)

### Security event types (`packages/shared/src/security.ts`)
- `export_reproducibility_verified`, `object_lock_status_checked` (P2.1)
- `queue_job_replay_attempted`, `queue_job_replay_forbidden`, `queue_job_replay_succeeded`, `queue_job_replay_failed`, `queue_worker_stalled_detected` (P2.3)
- `backup_validation_started`, `backup_validation_completed`, `restore_validation_started`, `restore_validation_completed`, `restore_validation_failed`, `recovery_report_generated` (P2.5)

### Metrics (`packages/shared-runtime/src/ops/metrics.service.ts`)
- `export_generation_total`, `export_verification_total`, `export_reproducibility_failure_total`, `object_lock_status_checked_total` (P2.1)
- `queue_replay_total`, `queue_replay_forbidden_total`, `queue_replay_safe_total`, `queue_replay_step_up_total`, `dlq_job_total`, `worker_stalled_total`, `worker_heartbeat_missing_total` (P2.3)
- `backup_validation_total`, `restore_validation_total`, `restore_validation_failure_total`, `recovery_report_generation_total` (P2.5)

## 9. Replay safety matrix (canonical)

| Queue | Job kind | Category |
| --- | --- | --- |
| report | GenerateReport | requires_step_up |
| report | PurgeDeletedEvidenceJob | forbidden |
| report-dlq | GenerateReport | requires_step_up |
| evidence-purge | PurgeDeletedEvidenceJob | **forbidden** |
| ots-upgrade | UpgradeOts | requires_step_up |
| search-indexing | RebuildSearchDocument | safe |
| media-intelligence | RunMediaIntelligence | safe |
| media-intelligence-dlq | RunMediaIntelligence | safe |
| mi-derived-assets | GenerateDerivedAsset | safe |
| mi-exif | ExifExtraction | safe |
| mi-ocr | OcrExtraction | safe |
| mi-transcript | TranscriptExtraction | safe |
| mi-search-index | MiSearchIndex | safe |
| graph-reconcile | ReconcileTeamGraph | safe |
| graph-domain-sync | GraphDomainSync | safe |
| graph-timeline-sync | GraphTimelineSync | safe |
| graph-search-projection | GraphSearchProjection | safe |
| org-health-refresh | RefreshOrgHealthProjection | safe |

## 10. Object Lock honest status model

Per export row, the IMMUTABLE badge renders ONLY when:

1. The platform-wide `verifyObjectLockConfiguration()` probe returned `verified`, AND
2. The row's `storageObjectLockMode` is `GOVERNANCE` or `COMPLIANCE`.

In every other case, the UI either renders "no lock" or a warning badge "STORED ... (platform unverified)". There is no path that produces a fake-green IMMUTABLE.

## 11. DR honesty summary

**Validated at the app layer:**
- DB connectivity, Object Lock platform mode, sampled artifact presence, audit-trail continuity, Prisma migration history, Redis / queue reachability.

**NOT validated by PROOVRA (explicitly unsupported):**
- Infrastructure database backups
- Infrastructure S3 backups
- Full disaster-recovery rehearsal
- Cross-region failover
- Infrastructure-layer restore orchestration

The frontend renders the unsupported-domains panel on every load and reports include the same list per check.

## 12. Multi-tenant / security summary

Every P2 operations route uses the same actor gate (`requireOpsActor` / `requireOpsReader`):

- 404 anti-enumeration when the caller is not a workspace member.
- 403 `member_inactive` when the member is suspended.
- Permission check via `evaluateMemberAccess({ permission: "identity.member.read" })`.
- Step-up gated for destructive / high-risk actions (`QUEUE_JOB_REPLAY`, `RESTORE_VALIDATION_EXECUTE`).
- Audit emission on every mutation.

Verified by source-contract test: `tenant gating: every operations route uses the same actor gate`.

## 13. Files changed (P2.2 → P2.7)

**Backend services:**
- `services/api/src/services/operations/queue-replay-safety.service.ts` (new)
- `services/api/src/services/operations/queue-inventory.service.ts` (new)
- `services/api/src/services/operations/queue-replay-action.service.ts` (new)
- `services/api/src/services/operations/recovery-validation.service.ts` (new)

**Backend routes:**
- `services/api/src/routes/operations-queues.routes.ts` (new)
- `services/api/src/routes/operations-recovery.routes.ts` (new)
- `services/api/src/server.ts` (registers both new modules)

**Frontend:**
- `apps/web/app/(app)/operations/exports/page.tsx` (new)
- `apps/web/app/(app)/operations/queues/page.tsx` (new)
- `apps/web/app/(app)/operations/recovery/page.tsx` (new)

**Bounded registries:**
- `packages/shared/src/identity-security.ts` (added `QUEUE_JOB_REPLAY`, `RESTORE_VALIDATION_EXECUTE`)

**Tests:**
- `services/api/test/phase-p2-final-closure.test.ts` (32 tests)

**Docs:**
- `docs/operations/worm-exports.md`
- `docs/operations/queue-operations.md`
- `docs/operations/replay-safety.md`
- `docs/operations/recovery-validation.md`
- `docs/operations/immutable-operations-runbook.md`
- `docs/operations/phase-p2-final-closure.md` (this file)

## 14. Remaining blockers

**None.** All acceptance lines from the spec are met:

- `/operations/exports` is usable end-to-end.
- Export manifests are inspectable; reproducibility verification is wired.
- Object Lock status is visible and honest.
- `/operations/queues` is usable; failed jobs + DLQ visible; replay safety enforced.
- Worker health surface present.
- `/operations/recovery` is usable; backup + restore validation exist with honest scope; recovery reports persist + are inspectable.
- All high-risk operations are gated + audited.
- Tests + docs added.
- No fake operational claims remain.

## 15. Explicit acceptance confirmation

| Acceptance line | Confirmed |
| --- | --- |
| No fake WORM claims | ✅ — IMMUTABLE badge double-gated; test covers it |
| No fake immutable badges | ✅ — only on `verified` platform + stored mode |
| No unsafe replay | ✅ — `forbidden` hard-refused; matrix is canonical |
| No hidden DLQ state | ✅ — failed-jobs endpoint per queue; sanitized stack |
| No fake backup guarantees | ✅ — unsupported domains panel + per-report list |
| No fake restore guarantees | ✅ — same + restore is step-up gated |
| No frontend/backend mismatch | ✅ — source-contract tests assert route paths align with frontend calls |
| P2.2 through P2.7 complete | ✅ — see sections 1–6 |

Phase P2 — Immutable Operations Platform is closed.
