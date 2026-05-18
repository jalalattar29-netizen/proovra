# Runbook — Stuck workflow instance

**Incident slug**: `workflow-stuck` · **Category**: `WORKER` (operational) · **Default severity**: `WARNING`

## Symptoms
- `EvidenceWorkflowInstance` rows in `SUBMITTED` or `NEEDS_REVIEW` for an unusually long period (configurable; default operator-facing threshold: 7 days).
- `/v1/ops/metrics` → `workflows_submitted_total` rising faster than `workflows_approved_total`.
- Operator user reports "my submission is still pending review" in the workspace.

## Dashboards / metrics
- `/v1/ops/metrics` → counters `workflows_created_total`, `workflows_submitted_total`, `workflows_approved_total`, `workflows_blocked_total`.
- `/v1/workflows/instances?teamId=...&status=SUBMITTED` — list current backlog.
- `/v1/workflows/instances?teamId=...&status=NEEDS_REVIEW` — list rows awaiting reviewer action.

## Safe commands / routes
1. Inspect a specific instance: `GET /v1/workflows/instances/:id?teamId=...` — returns instance + step list with statuses.
2. Assign a reviewer: `POST /v1/workflows/instances/:id/assign-reviewer` — moves SUBMITTED → NEEDS_REVIEW.
3. If a reviewer is already assigned but inactive, reassign to a different reviewer via the same route.
4. Request changes from the contributor: `POST /v1/workflows/instances/:id/request-changes` — moves to CHANGES_REQUESTED so the contributor can re-engage.

## What NOT to do
- **Do not** approve a workflow with unsatisfied required steps. The engine refuses; if you see an error, the system is working as designed.
- **Do not** cancel a SUBMITTED instance without a step-up challenge — Phase 19 step-up gates this action.
- **Do not** delete the row. Workflow instances are part of the audit chain for the evidence they govern.
- **Do not** rewrite the Phase 22 schema to "force-approve". The state machine is the source of truth.

## Rollback / retry guidance
- Most stuck workflows resolve via reviewer assignment.
- For long-stuck workflows tied to an external contributor who has gone silent, transition to `CHANGES_REQUESTED` with a clear note (operator-visible only) and let it expire naturally per retention policy.

## Escalation
- > 50 SUBMITTED instances older than 7 days in a single workspace → page the workspace owner.
- > 200 SUBMITTED instances workspace-wide → page the on-call. Likely cause: reviewer team is offline / understaffed; consider tightening Phase 13 SLA configuration.
