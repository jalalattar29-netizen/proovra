# Runbook — Stuck upload

**Incident slug**: `stuck-upload` · **Category**: `UPLOAD` · **Default severity**: `WARNING`

## Symptoms
- `operational_incidents` row with `category=UPLOAD` and `fingerprint` starting `upload:` is open.
- `stalled_uploads` gauge is non-zero on `/v1/ops/metrics`.
- Phase 12 `upload_stalled` SecurityEvents are visible in the /security UI.
- Operator user reports "upload spinner stuck" for an evidence item.

## Dashboards / metrics
- `/v1/ops/metrics` → `gauges.stalled_uploads`, `counters.upload_stalled`, `counters.upload_abandoned`.
- `/v1/ops/incidents?status=OPEN&category=UPLOAD`.
- /security UI → events `upload_stalled`, `upload_abandoned`, `recovery_review_required`.

## Safe commands / routes
1. `POST /v1/ops/reconcile` (cron secret) — refreshes gauges + reconciles stuck QUEUED communications.
2. For a specific upload: `GET /v1/uploads/sessions/:id/status` (Phase 12) to inspect the upload session state.
3. If a single upload is stuck, the contributor / operator can retry the upload session via the existing UI — the Phase 12 reconciler closes abandoned sessions after the configured `UPLOAD_ABANDONED_HOURS`.

## What NOT to do
- **Do not delete** the upload session row directly. Phase 12 governs lifecycle; manual deletion drops audit history.
- **Do not bypass** S3 Object Lock retention. The storage layer rejects `bypassGovernance=true` by convention (no call site sets it).
- **Do not** drop the related `evidence` row.

## Rollback / retry guidance
- If the upload is in `UPLOADING` but the underlying S3 multipart upload is gone (rare), use the Phase 12 admin reconcile route to mark it abandoned. Contributor can re-initiate.
- Retry by the contributor / operator initiating a fresh upload session — this preserves the audit trail.

## Escalation
- If gauge stays elevated > 1 hour after reconcile, page the ops on-call. Likely cause: storage outage (see [storage-write-failure.md](./storage-write-failure.md)) or worker queue stalled.
