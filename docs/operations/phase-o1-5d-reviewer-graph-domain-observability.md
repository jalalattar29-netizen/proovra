# Phase O1.5D — Reviewer Ops + Graph + SIU followup/timeline Observability

**Status:** CLOSED. 11 / 11 required spans emitted, contract-enforced.

## Reviewer Ops (5)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.reviewer.assignment.create` | `services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts` | `assignReviewerToWorkflow` | `{name="proovra.reviewer.assignment.create"}` |
| `proovra.reviewer.assignment.complete` | same | `approveReview` (outcome=approved) | `{name="proovra.reviewer.assignment.complete"}` |
| `proovra.reviewer.queue.build` | same | `listReviewerOpsQueue` | `{name="proovra.reviewer.queue.build"}` |
| `proovra.reviewer.console.load` | same | `buildDashboard` | `{name="proovra.reviewer.console.load"}` |
| `proovra.reviewer.reconcile` | same | `runReconcile` | `{name="proovra.reviewer.reconcile"}` |

Attributes: `proovra.team_id`, `proovra.operation`, `proovra.outcome` (assignment complete). NEVER reviewer notes, workflow body, PII.

## Graph (4)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.graph.reconcile` | `services/worker/src/subsystem-queue-processors.ts` | `processGraphReconcileJob` | `{name="proovra.graph.reconcile"}` |
| `proovra.graph.timeline.build` | same | `processGraphTimelineSyncJob` | `{name="proovra.graph.timeline.build"}` |
| `proovra.graph.domain.sync` | same | `processGraphDomainSyncJob` | `{name="proovra.graph.domain.sync"}` |
| `proovra.graph.search.projection` | same | `processGraphSearchProjectionJob` | `{name="proovra.graph.search.projection"}` |

Attributes: `proovra.team_id`, `proovra.operation`. NEVER raw graph data.

## SIU followup + timeline (2)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.siu.followup.request` | `services/api/src/services/siu/siu-profile.service.ts` | `createFollowUpRequest` | `{name="proovra.siu.followup.request"}` |
| `proovra.siu.timeline.build` | `services/api/src/services/siu/siu-export-bundle.service.ts` | emitted just before `buildClaimTimelinePayload(input.profile)` | `{name="proovra.siu.timeline.build"}` |

Attributes: `proovra.team_id`, `proovra.case_id`, `proovra.operation`. NEVER claimant PII, contact details.

## Dashboard mapping

Reviewer ops + graph operations + SIU traces are now sub-steppable in Grafana Tempo. Filter by `service.name="proovra-api"` for reviewer + SIU spans, `service.name="proovra-worker"` for graph spans.

## Alert mapping

Reviewer reconcile failure / graph reconcile failure / SIU followup failure use the trace-derived alert rules in `infra/grafana/alerts/proovra-operations-alerts.yaml`. Thresholds are baselined post-deploy as operators identify the noise floor.
