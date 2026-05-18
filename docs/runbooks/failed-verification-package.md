# Runbook — Failed verification package generation

**Incident slug**: `failed-verification-package` · **Category**: `PACKAGE` · **Default severity**: `WARNING`

## Symptoms
- Verification-package job failed in worker logs (`verification-package` entry).
- Operator sees stale "Building package…" state for an evidence item.

## Dashboards / metrics
- `/v1/ops/metrics` → `jobs_failed_total`.
- Worker logs grep `verification-package` + `evidenceId`.

## Safe commands / routes
1. Re-enqueue from the operator UI when source assets + OTS anchor are present.
2. Inspect related OTS state (Phase 11) — packages cannot finalise before the OTS anchor is `COMPLETE`.

## What NOT to do
- **Do not** rewrite `verification-package` internals — locked by phase brief.
- **Do not** alter OTS/TSA records to "speed up" a package. The package is downstream of OTS by design.

## Rollback / retry guidance
- Single failure → retry.
- Repeated failures on the same evidence → check `EvidenceAnchor.otsStatus` (Phase 11). If `NOT_ANCHORED_YET`, wait; the package will build once the anchor completes.

## Escalation
- > 10 package failures / hour across the workspace → page on-call. Likely cause: storage write failure or OTS calendar regression.
