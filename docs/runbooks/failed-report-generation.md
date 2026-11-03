# Runbook — Failed report generation

**Incident slug**: `failed-report-generation` · **Category**: `REPORT` · **Default severity**: `WARNING`

## Published but never committed (`platform.unreferenced_published_artifacts`)

Every report PDF and package ZIP is published under Object Lock before its row
commits, and the worker records a publication intent first. When the commit
fails or the worker dies in between, the object stays in the bucket until its
retention ends, and no row references it. A retry of the same request with the
same bytes reuses that object; a retry whose bytes differ publishes another.

Operations opens **one** platform condition while any such object appeared in
the last week (older than a day, so a commit still in flight is not counted).
It shows the recent count and the total. It closes when a week passes with
none. The objects cannot be deleted early; the condition is about why commits
fail after publication.

- Read the worker log for `GenerateReportJob attempt raised an error` and the
  report or package commit refusals in the same window.
- Count what is outstanding from the database:
  `SELECT family, count(*) FROM artifact_publication_intents i WHERE NOT EXISTS
  (SELECT 1 FROM reports r WHERE r.storage_key = i.storage_key) AND NOT EXISTS
  (SELECT 1 FROM verification_packages p WHERE p.storage_key = i.storage_key)
  GROUP BY family;`
- Reconciling against the provider bill needs a bucket inventory, which this
  runbook cannot do.

## Symptoms
- BullMQ `reportQueue` job moved to failed state; row visible in `reportDlqQueue`.
- `jobs_failed_total` counter increased; `jobs_retry_exhausted_total` if retries hit cap.
- Worker logger emits `pdf.report.generate` error with `reportId` + `evidenceId`.
- Operator sees stale "Generating report…" status in the evidence UI.

## Dashboards / metrics
- `/v1/admin/platform/metrics` → `counters.jobs_started_total`, `jobs_failed_total`, `jobs_retry_exhausted_total`.
- BullMQ admin (if connected) → reportQueue + reportDlqQueue lengths.

## Safe commands / routes
1. Re-enqueue from the operator UI (Phase 8/12 admin surface). The Phase 20 master reconcile does NOT auto-retry report jobs by design — operator decides.
2. Inspect the failure through the platform evidence-health surface:
   `/admin/evidence-ops` for the aggregate, and `/admin/evidence-ops/records`
   for the individual records behind each figure. There is no per-report job
   inspection endpoint — a Report row is written only on SUCCESS, so a failed
   generation leaves a DLQ entry and an evidence record without a report
   rather than a Report to read.

## What NOT to do
- **Do not** delete `Evidence` rows. Retention + legal hold + ownership are governed by Phase 9/14; deleting bypasses the chain.
- **Do not** touch `services/worker/src/pdf/report.ts`. That file is the canonical PDF generator and is locked by the phase brief.
- **Do not** drop the DLQ row before reviewing the failure — it is the only record of what happened.

## Rollback / retry guidance
- Most failures are transient (OpenAI / storage / OTS). Retry once from the DLQ.
- If the failure is deterministic (e.g. corrupt source asset), the report owner should regenerate from a fresh capture.

## Escalation
- Sustained failure rate (> 5/hour for the same evidence) → page worker on-call; likely upstream provider regression.
