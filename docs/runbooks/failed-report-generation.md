# Runbook — Failed report generation

**Incident slug**: `failed-report-generation` · **Category**: `REPORT` · **Default severity**: `WARNING`

## Symptoms
- BullMQ `reportQueue` job moved to failed state; row visible in `reportDlqQueue`.
- `jobs_failed_total` counter increased; `jobs_retry_exhausted_total` if retries hit cap.
- Worker logger emits `pdf.report.generate` error with `reportId` + `evidenceId`.
- Operator sees stale "Generating report…" status in the evidence UI.

## Dashboards / metrics
- `/v1/ops/metrics` → `counters.jobs_started_total`, `jobs_failed_total`, `jobs_retry_exhausted_total`.
- BullMQ admin (if connected) → reportQueue + reportDlqQueue lengths.

## Safe commands / routes
1. Re-enqueue from the operator UI (Phase 8/12 admin surface). The Phase 20 master reconcile does NOT auto-retry report jobs by design — operator decides.
2. Inspect the failed job: `GET /v1/admin/reports/:id` (Phase 6+).

## What NOT to do
- **Do not** delete `Evidence` rows. Retention + legal hold + ownership are governed by Phase 9/14; deleting bypasses the chain.
- **Do not** touch `services/worker/src/pdf/report.ts`. That file is the canonical PDF generator and is locked by the phase brief.
- **Do not** drop the DLQ row before reviewing the failure — it is the only record of what happened.

## Rollback / retry guidance
- Most failures are transient (OpenAI / storage / OTS). Retry once from the DLQ.
- If the failure is deterministic (e.g. corrupt source asset), the report owner should regenerate from a fresh capture.

## Escalation
- Sustained failure rate (> 5/hour for the same evidence) → page worker on-call; likely upstream provider regression.
