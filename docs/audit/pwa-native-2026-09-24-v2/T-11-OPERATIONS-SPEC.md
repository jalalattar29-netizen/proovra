# T-11 SPEC — `/operations` and `/operations/health` (extracted 2026-09-24, session 2)

Source of truth for the native port. `P` = `apps/web/app/(app)/operations/page.tsx`,
`C/` = `…/operations/_components/`, `L/` = `…/operations/_lib/`,
`R` = `services/api/src/routes/ops.routes.ts`.

## Web-side discrepancies found while extracting (decide, don't copy)

1. **Bulk outcome always reported as failed on the web.** Page counts success only for `status === "SUCCEEDED"` (P:1299-1303); server item statuses are `PENDING|COMPLETED|FAILED|SKIPPED` (schema.prisma:10418) and success is written as `COMPLETED` (bulk-actions.service.ts:119). **Native: treat COMPLETED as success; SKIPPED shown separately.** (PWA defect → record for web fix.)
2. "Unresolved" card note "Open or acknowledged." but `summary.open` also counts SUPPRESSED (operations-summary.service.ts:209-213,420).
3. Severity cards set `severity=X` with status any, so list can include RESOLVED rows the count excluded.
4. Two "Check again" refusal branches unreachable (retryable is false whenever refusedReason is set, R:1009-1010; 503 schema_mismatch throws in apiFetch).
5. Resolve never sends `resolutionNote` though server accepts 1–400 chars (R:1475-1477).
6. Saved views drop the SLA filter (P:786-796, P:284-293).
7. Arbitrary `owner` URL value → 400 → UnavailableState (L/filters.ts:160 vs R:1038-1045).
8. Failed grouped read is silent (`groups=[]`, P:455-462) → NoMatch/Clear over real conditions. **Native: surface the failure.**
9. Non-202 remediation (403/409/503, R:1595-1604) throws → generic copy instead of server `remediation.message`. **Native: read the body.**
10. Health: API gate = ACTIVE membership + `identity.member.read`, page gate = `WORKSPACE_HEALTH_VIEW`; alerts ordered severity ASC (least severe first) with `take:100` and no truncation notice. **Native: order most severe first client-side and state the 100 cap.**
11. Health severity colours differ from Operations (WARNING amber vs purple).
12. Assign / bulk-assign errors are plain strings (`"invalid_assignee"`, `"assignee_required"`), not `{code}`.

## Endpoints (Operations)
| # | Call | Sent | Read |
|---|---|---|---|
| 1 | GET /v1/ops/summary?teamId | | `summary`, `workspace.operatorCount` |
| 2 | GET /v1/ops/incidents | teamId, sla?, status?, severity?, category?, owner (≠any), q?, sort, limit=50, cursor? | `incidents[]`, `completeness.complete`, `sla{postures,attentionPostures}`, `pagination.nextCursor` |
| 3 | GET /v1/ops/incident-groups | teamId + status/severity/category/owner/sla/q | `groups[]`, `totals{groups,conditions}` |
| 4 | GET /v1/ops/incident-groups/:groupKey/affected | teamId, cursor? | `records[]`, `pagination.nextCursor` |
| 5 | GET /v1/ops/incidents/:id?teamId | | `incident` (+timeline, timelineComplete), `remediation` |
| 6 | GET /v1/ops/assignable-operators?teamId (only if OPERATIONS_ASSIGN) | | `operators[]{userId,displayName,email,role}`, `selfUserId` |
| 7-10 | saved views GET/POST/PATCH(expectedUpdatedAt)/DELETE | | |
| 11 | POST /v1/ops/workspace-reconcile {teamId} | | `refusedReason?`, `retryable?`; then poll #1 ≤12× (min(750·2^⌊n/3⌋,4000) ms) while readiness RUNNING |
| 12 | POST /v1/ops/incidents/:id/{ack,resolve,suppress} {teamId} | | 409 `{error:{code}}` refusals |
| 13 | POST /v1/ops/incidents/:id/assign {teamId, assigneeUserId|null} | | |
| 14 | POST /v1/ops/incidents/:id/remediate {teamId, actionId} | | `remediation{result,message,reference?}` |
| 15 | POST /v1/ops/bulk-actions {teamId, actionType, targetIds≤200, assigneeUserId?} + step-up `REVIEWER_OPS_BULK_ACTION` | | `items[]{targetId,status}` |

## Gating (Operations)
PageRouteGate `workspace.operations` (OPERATIONS_VIEW, HIDDEN_IF_NO_CAPABILITY), then in-page, in order:
no envelope → `no_envelope`; context_mismatch; account_not_active; no teamId → `no_workspace`;
`!OPERATIONS_VIEW || !readAccess.incidents` → `not_included`. Title for all:
**"Operations isn't available for this workspace"**; bodies:
- not_included: "Operations is available to workspaces that produce operational conditions, or that more than one person shares. This workspace does neither right now, so there is no shared triage queue to show."
- no_workspace: "No workspace is selected yet. Choose a workspace to see its operational conditions."
- context_mismatch: "This workspace couldn't be confirmed. Reload the page, or switch workspace again."
- account_not_active: "This account is suspended, so operational work can't be shown or acted on. Contact a workspace owner."
- no_envelope: "Your access for this workspace hasn't been confirmed. Reload the page, or ask a workspace owner to check your role."

Capabilities: OPERATIONS_ACKNOWLEDGE / _RESOLVE / _SUPPRESS / _ASSIGN / _SAVED_VIEWS_MANAGE; `collaborative = operatorCount > 1`.

## Copy + vocabulary
See the implementation: `apps/mobile/src/product/operations.ts` carries every string verbatim with its
web line reference (severity/status/category/queue-metric/sort/SLA/timeline vocabularies, state copy,
refusal notices, reconciliation notices).

## Health (`/operations/health`)
GET /v1/teams/{id}/operations/health → `state` (HEALTHY|DEGRADED|CRITICAL), `openIncidents{total,bySeverity}`,
`unresolvedIncidents`, `lastIncidentActivityUtc|null`, `evaluatedAtUtc`.
GET /v1/teams/{id}/operations/alerts → `items[]{id,severity,title,safeSummary|null,category,firstSeenAtUtc,lastSeenAtUtc,occurrenceCount}`, `evaluatedAtUtc`.
Poll every 30 s. Gate: WORKSPACE_HEALTH_VIEW; null active space → "No workspace is currently selected. Workspace health describes one workspace at a time."
Title "Workspace health"; subtitle "Unresolved operational conditions recorded against {name ?? "this workspace"}. Every figure below is a record in this workspace — none of it is platform runtime."
Badge "Scope: Workspace"; Refresh. Panel "Current posture" (reasons per state; facts Open conditions / Open or acknowledged / Last condition activity ("No activity recorded") / Evaluated; severity list "{n} open").
Panel "Unresolved conditions" + "Open the conditions queue" → /operations. Empty: "No unresolved conditions are recorded against this workspace as of {time}."
Unavailable copy: posture "{message} Attempted {time}. This is not a statement that the workspace is healthy — the evaluation did not complete." (fallback "Workspace health could not be evaluated."); list "{message} Attempted {time}. The list below is not empty because there is nothing to show; it is empty because it could not be read." (fallback "Workspace conditions could not be listed.").
Footnote: "Platform runtime — process counters, queue depth, worker heartbeat and dependency probes — is not shown here. It is identical for every workspace on the instance and is administered by PROOVRA platform staff."
