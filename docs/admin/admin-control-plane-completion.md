# Admin control plane — completion ledger

<!--
  GENERATED. Do not edit by hand.
    node scripts/admin-ledger/generate.mjs

  Route list, navigation, scope, endpoints and composition are DERIVED —
  from the file tree, the navigation registry, a live trace of every API
  route, and a source scan. A page cannot be omitted by forgetting a row.

  Verification evidence is the one hand-maintained input, in
  scripts/admin-ledger/evidence.json, and every claim there names the
  artefact that backs it.
-->

**47 routes** · 0 completed · 47 pending · 1070 API routes traced

## Status

| Route | Kind | Family | Status | Reason / blocker |
| --- | --- | --- | --- | --- |
| `/admin` | static | (unassigned) | PENDING |  |
| `/admin/adoption` | static | (unassigned) | PENDING |  |
| `/admin/alerts` | static | (unassigned) | PENDING |  |
| `/admin/audit` | static | (unassigned) | PENDING |  |
| `/admin/billing` | static | (unassigned) | PENDING |  |
| `/admin/contact-sales` | static | (unassigned) | PENDING |  |
| `/admin/contact-sales/:id` | dynamic | Commercial | PENDING |  |
| `/admin/costs` | static | (unassigned) | PENDING |  |
| `/admin/customers` | static | (unassigned) | PENDING |  |
| `/admin/customers/:id` | dynamic | Customers | PENDING |  |
| `/admin/dashboard` | static | (unassigned) | PENDING |  |
| `/admin/demo-requests` | static | (unassigned) | PENDING |  |
| `/admin/demo-requests/:id` | dynamic | Commercial | PENDING |  |
| `/admin/evidence-ops` | static | (unassigned) | PENDING |  |
| `/admin/evidence-ops/records` | static | (unassigned) | PENDING |  |
| `/admin/executive` | static | (unassigned) | PENDING |  |
| `/admin/identity` | static | (unassigned) | PENDING |  |
| `/admin/identity/access-reviews` | static | (unassigned) | PENDING |  |
| `/admin/identity/permission-matrix` | static | (unassigned) | PENDING |  |
| `/admin/identity/providers` | static | (unassigned) | PENDING |  |
| `/admin/identity/runtime` | static | (unassigned) | PENDING |  |
| `/admin/identity/scim` | static | (unassigned) | PENDING |  |
| `/admin/identity/sessions` | static | (unassigned) | PENDING |  |
| `/admin/identity/timeline` | static | (unassigned) | PENDING |  |
| `/admin/operations` | static | (unassigned) | PENDING |  |
| `/admin/platform-health` | static | (unassigned) | PENDING |  |
| `/admin/platform/analytics` | static | (unassigned) | PENDING |  |
| `/admin/platform/automation` | static | (unassigned) | PENDING |  |
| `/admin/platform/exports` | static | (unassigned) | PENDING |  |
| `/admin/platform/media-graph` | static | (unassigned) | PENDING |  |
| `/admin/platform/observability` | static | (unassigned) | PENDING |  |
| `/admin/platform/queues` | static | (unassigned) | PENDING |  |
| `/admin/platform/readiness` | static | (unassigned) | PENDING |  |
| `/admin/platform/recovery` | static | (unassigned) | PENDING |  |
| `/admin/platform/reliability` | static | (unassigned) | PENDING |  |
| `/admin/platform/runbooks` | static | (unassigned) | PENDING |  |
| `/admin/platform/runbooks/:slug` | dynamic | Runbooks | PENDING |  |
| `/admin/platform/signers` | static | (unassigned) | PENDING |  |
| `/admin/provisioning` | static | (unassigned) | PENDING |  |
| `/admin/search` | static | (unassigned) | PENDING |  |
| `/admin/security` | static | (unassigned) | PENDING |  |
| `/admin/support-access` | static | (unassigned) | PENDING |  |
| `/admin/timeline` | static | (unassigned) | PENDING |  |
| `/admin/users` | static | (unassigned) | PENDING |  |
| `/admin/users/:id` | dynamic | People | PENDING |  |
| `/admin/workspaces` | static | (unassigned) | PENDING |  |
| `/admin/workspaces/:id` | dynamic | Workspaces | PENDING |  |

## Scope and authorization

| Route | Scope | Scope source | Capability | Backend authority | Nav | Parent |
| --- | --- | --- | --- | --- | --- | --- |
| `/admin` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | overview | /admin |
| `/admin/adoption` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | commercial | /admin |
| `/admin/alerts` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/audit` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | audit | /admin |
| `/admin/billing` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | commercial | /admin |
| `/admin/contact-sales` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
| `/admin/contact-sales/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/contact-sales |
| `/admin/costs` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | commercial | /admin |
| `/admin/customers` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
| `/admin/customers/:id` | PLATFORM_AUDIT_SCOPED | handler trace | PLATFORM_ADMIN | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | contextual | /admin/customers |
| `/admin/dashboard` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | commercial | /admin |
| `/admin/demo-requests` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin, requirePlatformAdminOrInternalKey | customers | /admin |
| `/admin/demo-requests/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/demo-requests |
| `/admin/evidence-ops` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | evidence | /admin |
| `/admin/evidence-ops/records` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | evidence | /admin/evidence-ops |
| `/admin/executive` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | commercial | /admin |
| `/admin/identity` | WORKSPACE_UNCLASSIFIED | adminNavigation registry | PLATFORM_ADMIN |  | accounts | /admin |
| `/admin/identity/access-reviews` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | resolveAuthorizedWorkspaceSubject, requireStepUpForSensitiveAction, +STEP_UP | accounts | /admin/identity |
| `/admin/identity/permission-matrix` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | resolveAdminWorkspace, requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | accounts | /admin/identity |
| `/admin/identity/providers` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | accounts | /admin/identity |
| `/admin/identity/runtime` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP, requireIntegrationCronSecret, authorizeOrFail, AUTHORIZE(?) | accounts | /admin/identity |
| `/admin/identity/scim` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | requireIdentityAdmin, requireScimAdmin, requireStepUpForSensitiveAction, +STEP_UP | accounts | /admin/identity |
| `/admin/identity/sessions` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN |  | accounts | /admin/identity |
| `/admin/identity/timeline` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requireIdentityAdmin | accounts | /admin/identity |
| `/admin/operations` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | operations | /admin |
| `/admin/platform-health` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | operations | /admin |
| `/admin/platform/analytics` | WORKSPACE_FILTERED | adminNavigation registry | ANALYTICS_VIEW | AUTH_ONLY, gateAnalyticsRead, requireTeamCapability | operations | /admin/platform |
| `/admin/platform/automation` | WORKSPACE_FILTERED | adminNavigation registry | AUTOMATION_VIEW | requireTeamCapability | operations | /admin/platform |
| `/admin/platform/exports` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | requirePlatformOpsActor | operations | /admin/platform |
| `/admin/platform/media-graph` | WORKSPACE_CANDIDATE | handler trace | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin, requireDomainActionOnOpsSurface | operations | /admin/platform |
| `/admin/platform/observability` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin | operations | /admin/platform |
| `/admin/platform/queues` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | operations | /admin/platform |
| `/admin/platform/readiness` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin | operations | /admin/platform |
| `/admin/platform/recovery` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | operations | /admin/platform |
| `/admin/platform/reliability` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | requireAdminMember | operations | /admin/platform |
| `/admin/platform/runbooks` | PLATFORM | adminNavigation registry | RUNBOOKS_VIEW |  | operations | /admin/platform |
| `/admin/platform/runbooks/:slug` | PLATFORM | handler trace | RUNBOOKS_VIEW |  | contextual | /admin/platform/runbooks |
| `/admin/platform/signers` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | operations | /admin/platform |
| `/admin/provisioning` | PLATFORM_AUDIT_SCOPED | handler trace | PLATFORM_ADMIN | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | customers | /admin |
| `/admin/search` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | audit | /admin |
| `/admin/security` | WORKSPACE_UNCLASSIFIED | adminNavigation registry | PLATFORM_ADMIN |  | security | /admin |
| `/admin/support-access` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?), requireStepUpForSensitiveAction, +STEP_UP | accounts | /admin |
| `/admin/timeline` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/users` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | accounts | /admin |
| `/admin/users/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/users |
| `/admin/workspaces` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | workspaces | /admin |
| `/admin/workspaces/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/workspaces |

## Backend contract

| Route | Method | Endpoint | Authority | teamId role |
| --- | --- | --- | --- | --- |
| `/admin` | GET | `/v1/admin/overview` | requirePlatformAdmin | NONE |
| `/admin/adoption` | GET | `/v1/admin/adoption` | requirePlatformAdmin | NONE |
| `/admin/alerts` | GET | `/v1/admin/alerts` | requirePlatformAdmin | NONE |
| `/admin/audit` | GET | `/v1/admin/audit-log` | requirePlatformAdmin | NONE |
| `/admin/audit` | GET | `/v1/admin/audit-log/export` | requirePlatformAdmin | NONE |
| `/admin/audit` | GET | `/v1/admin/audit-log/verify` | requirePlatformAdmin | NONE |
| `/admin/billing` | GET | `/v1/admin/billing/detail` | requirePlatformAdmin | NONE |
| `/admin/contact-sales` | GET | `/v1/admin/contact-sales` | requirePlatformAdmin | NONE |
| `/admin/contact-sales` | GET+PATCH | `/v1/admin/contact-sales/:id` | requirePlatformAdmin | NONE |
| `/admin/contact-sales` | GET+PATCH | `/v1/admin/contact-sales/:id` | requirePlatformAdmin | NONE |
| `/admin/contact-sales/:id` | GET+PATCH | `/v1/admin/contact-sales/:id` | requirePlatformAdmin | NONE |
| `/admin/costs` | GET | `/v1/admin/costs` | requirePlatformAdmin | NONE |
| `/admin/customers` | GET | `/v1/admin/customers` | requirePlatformAdmin | NONE |
| `/admin/customers/:id` | POST | `/v1/admin/orgs/:id/suspend` | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | AUDIT |
| `/admin/customers/:id` | POST | `/v1/admin/orgs/:id/resume` | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | AUDIT |
| `/admin/customers/:id` | GET | `/v1/admin/customers/:id` | requirePlatformAdmin | NONE |
| `/admin/dashboard` | GET | `/v1/admin/analytics/dashboard` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | GET | `/v1/admin/demo-requests` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | GET+PATCH | `/v1/admin/demo-requests/:id` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | GET+PATCH | `/v1/admin/demo-requests/:id` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/:id/route` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/:id/follow-up/send` | requirePlatformAdmin | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/follow-up/run` | requirePlatformAdminOrInternalKey | NONE |
| `/admin/demo-requests/:id` | GET | `/v1/admin/demo-requests/:id` | requirePlatformAdmin | NONE |
| `/admin/evidence-ops` | GET | `/v1/admin/evidence-health` | requirePlatformAdmin | AUDIT |
| `/admin/evidence-ops/records` | GET | `/v1/admin/evidence-health/records` | requirePlatformAdmin | AUDIT |
| `/admin/executive` | GET | `/v1/admin/executive` | requirePlatformAdmin | NONE |
| `/admin/identity` | — | (no API call) | — | — |
| `/admin/identity/access-reviews` | GET | `/v1/identity/access-reviews` | resolveAuthorizedWorkspaceSubject | FILTER_CANDIDATE |
| `/admin/identity/access-reviews` | POST | `/v1/identity/access-reviews/regenerate` | resolveAuthorizedWorkspaceSubject | FILTER_CANDIDATE |
| `/admin/identity/access-reviews` | POST | `/v1/identity/access-reviews/:id/decision` | resolveAuthorizedWorkspaceSubject, requireStepUpForSensitiveAction, +STEP_UP | FILTER |
| `/admin/identity/permission-matrix` | GET | `/v1/admin/identity/role-matrix` | resolveAdminWorkspace | FILTER_CANDIDATE |
| `/admin/identity/permission-matrix` | GET | `/v1/admin/identity/permission-matrix` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/permission-matrix` | POST | `/v1/admin/identity/elevations` | resolveAdminWorkspace, requireStepUpForSensitiveAction, +STEP_UP | AUDIT |
| `/admin/identity/providers` | GET+POST | `/v1/admin/identity/providers` | requireIdentityAdmin | FILTER |
| `/admin/identity/providers` | GET+POST | `/v1/admin/identity/providers` | requireIdentityAdmin | FILTER |
| `/admin/identity/providers` | POST | `/v1/admin/identity/providers/:id/transition` | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/identity/providers` | POST | `/v1/admin/identity/providers/:id/policy` | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/identity/runtime` | GET | `/v1/admin/identity/sessions` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/runtime` | GET | `/v1/admin/identity/quarantined-sessions` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/sessions/:id/quarantine` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/sessions/:id/release` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/sessions/:id/score` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/emergency-revoke` | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/identity-security/reconcile` | requireIntegrationCronSecret, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | FILTER |
| `/admin/identity/scim` | GET+POST | `/v1/admin/identity/scim/tokens` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/scim` | GET+POST | `/v1/admin/identity/scim/tokens` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `/v1/admin/identity/scim/tokens/:id/rotate` | requireScimAdmin | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `/v1/admin/identity/scim/tokens/:id/revoke` | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/identity/scim` | GET | `/v1/scim/reconciliation/preview` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `/v1/scim/reconciliation/execute` | requireIdentityAdmin, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/identity/scim` | GET | `/v1/scim/sync-failures` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `/v1/scim/sync-failures/:id/replay` | requireIdentityAdmin | FILTER_CANDIDATE |
| `/admin/identity/sessions` | — | (no API call) | — | — |
| `/admin/identity/timeline` | GET | `/v1/admin/identity/timeline` | requireIdentityAdmin | FILTER |
| `/admin/operations` | GET | `/v1/admin/incidents` | requirePlatformAdmin | FILTER |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/acknowledge` | requirePlatformAdmin | NONE |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/resolve` | requirePlatformAdmin | NONE |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/assign` | requirePlatformAdmin | NONE |
| `/admin/platform-health` | GET | `/v1/admin/platform-health` | requirePlatformAdmin | NONE |
| `/admin/platform/analytics` | GET | `/v1/analytics/_window` | AUTH_ONLY | NONE |
| `/admin/platform/analytics` | GET | `/v1/analytics/operations` | gateAnalyticsRead | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/reviewer` | gateAnalyticsRead | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/governance` | gateAnalyticsRead | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/automation` | gateAnalyticsRead | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/artifacts` | gateAnalyticsRead | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/automation/webhooks` | requireTeamCapability | FILTER |
| `/admin/platform/analytics` | GET | `/v1/automation/webhook-deliveries` | requireTeamCapability | FILTER |
| `/admin/platform/automation` | GET | `/v1/automation/rules` | requireTeamCapability | FILTER |
| `/admin/platform/automation` | GET | `/v1/automation/runs` | requireTeamCapability | AUDIT |
| `/admin/platform/exports` | GET | `/v1/operations/exports` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET | `/v1/operations/exports/object-lock` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET | `/v1/operations/exports/:id` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | POST | `/v1/operations/exports/:id/verify` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | GET | `/v1/admin/platform/metrics` | requirePlatformAdmin | NONE |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/runs/:runId/retry` | requireDomainActionOnOpsSurface | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/dlq/replay` | requireDomainActionOnOpsSurface | FILTER_CANDIDATE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/metrics` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/alerts` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/readiness` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/health-snapshot` | requirePlatformAdmin | NONE |
| `/admin/platform/queues` | GET | `/v1/operations/queues` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/workers` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/replay-safety` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/:queueName/failed` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | POST | `/v1/operations/queues/:queueName/jobs/:jobId/replay` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/queues` | POST | `/v1/operations/queues/:queueName/jobs/:jobId/retry` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | POST | `/v1/operations/queues/:queueName/jobs/:jobId/replay` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/readiness` | GET | `/v1/operations/readiness` | requirePlatformAdmin | NONE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-backup` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-restore` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery/reports/:id` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/reliability` | GET | `/v1/reliability/summary` | requireAdminMember | FILTER_CANDIDATE |
| `/admin/platform/reliability` | GET | `/v1/reliability/upload-sessions` | requireAdminMember | FILTER_CANDIDATE |
| `/admin/platform/reliability` | POST | `/v1/reliability/upload-sessions/:evidenceId/mark-abandoned` | requireAdminMember | FILTER_CANDIDATE |
| `/admin/platform/reliability` | POST | `/v1/reliability/upload-sessions/:evidenceId/request-review` | requireAdminMember | FILTER_CANDIDATE |
| `/admin/platform/runbooks` | — | (no API call) | — | — |
| `/admin/platform/runbooks/:slug` | — | (no API call) | — | — |
| `/admin/platform/signers` | GET | `/v1/operations/signers` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET | `/v1/operations/custody-attestations` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/custody-attestations/:id/verify` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/custody-attestations/backfill` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET | `/v1/operations/signers/:id` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET | `/v1/operations/signers/:id/audit` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET | `/v1/operations/signers/:id/health` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/signers/:id/preview` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/signers/:id/promote` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/signers/:id/retire` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/signers/:id/revoke` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/provisioning` | POST | `/v1/admin/enterprise/provision` | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | AUDIT |
| `/admin/provisioning` | PATCH | `/v1/admin/orgs/:id/plan` | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | AUDIT |
| `/admin/search` | GET | `/v1/admin/search` | requirePlatformAdmin | NONE |
| `/admin/security` | — | (no API call) | — | — |
| `/admin/support-access` | GET | `/v1/support-access/grants` | requirePlatformStaff | FILTER |
| `/admin/support-access` | GET | `/v1/break-glass/grants` | requirePlatformStaff | FILTER |
| `/admin/support-access` | POST | `/v1/support-access/enter` | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?) | AUDIT |
| `/admin/support-access` | POST | `/v1/support-access/revoke` | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?) | FILTER_CANDIDATE |
| `/admin/support-access` | POST | `/v1/support-access/start` | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?) | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/activate` | requirePlatformStaff, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/revoke` | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?) | FILTER_CANDIDATE |
| `/admin/timeline` | GET | `/v1/admin/timeline` | requirePlatformAdmin | NONE |
| `/admin/users` | GET | `/v1/admin/users` | requirePlatformAdmin | AUDIT |
| `/admin/users/:id` | GET | `/v1/admin/users/:id` | requirePlatformAdmin | NONE |
| `/admin/workspaces` | GET | `/v1/admin/workspaces` | requirePlatformAdmin | NONE |
| `/admin/workspaces/:id` | GET | `/v1/admin/workspaces/:id` | requirePlatformAdmin | AUDIT |

## Verification evidence

| Route | Fixture | Desktop | Mobile | RTL | States | Authz | Contract | Breadcrumb | Return |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin` | — | `artifacts/admin-visual-review/screenshots/admin--desktop.png` | `artifacts/admin-visual-review/screenshots/admin--mobile.png` | — | — | — | — | — | — |
| `/admin/adoption` | — | `artifacts/admin-visual-review/screenshots/admin-adoption--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-adoption--mobile.png` | — | — | — | — | — | — |
| `/admin/alerts` | — | `artifacts/admin-visual-review/screenshots/admin-alerts--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-alerts--mobile.png` | — | — | — | — | — | — |
| `/admin/audit` | — | `artifacts/admin-visual-review/screenshots/admin-audit--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-audit--mobile.png` | — | — | — | — | — | — |
| `/admin/billing` | — | `artifacts/admin-visual-review/screenshots/admin-billing--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-billing--mobile.png` | — | — | — | — | — | — |
| `/admin/contact-sales` | — | `artifacts/admin-visual-review/screenshots/admin-contact-sales--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-contact-sales--mobile.png` | — | — | — | — | — | — |
| `/admin/contact-sales/:id` | — | `artifacts/admin-visual-review/screenshots/admin-contact-sales-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-contact-sales-id--mobile.png` | — | — | — | — | `Platform admin / Customers / Contact sales / Sales inquiry` | `← Back to list → /admin/contact-sales` |
| `/admin/costs` | — | `artifacts/admin-visual-review/screenshots/admin-costs--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-costs--mobile.png` | — | — | — | — | — | — |
| `/admin/customers` | — | `artifacts/admin-visual-review/screenshots/admin-customers--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-customers--mobile.png` | — | — | — | — | — | — |
| `/admin/customers/:id` | — | `artifacts/admin-visual-review/screenshots/admin-customers-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-customers-id--mobile.png` | — | — | — | — | `Platform admin / Customers / Customer directory / Customer` | `← Back to roster → /admin/customers` |
| `/admin/dashboard` | — | `artifacts/admin-visual-review/screenshots/admin-dashboard--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-dashboard--mobile.png` | — | — | — | — | — | — |
| `/admin/demo-requests` | — | `artifacts/admin-visual-review/screenshots/admin-demo-requests--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-demo-requests--mobile.png` | — | — | — | — | — | — |
| `/admin/demo-requests/:id` | — | `artifacts/admin-visual-review/screenshots/admin-demo-requests-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-demo-requests-id--mobile.png` | — | — | — | — | `Platform admin / Customers / Demo requests / Demo request` | `← Back to list → /admin/demo-requests` |
| `/admin/evidence-ops` | — | `artifacts/admin-visual-review/screenshots/admin-evidence-ops--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops--mobile.png` | — | — | — | — | — | — |
| `/admin/evidence-ops/records` | — | `artifacts/admin-visual-review/screenshots/admin-evidence-ops-records--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops-records--mobile.png` | — | — | — | — | — | — |
| `/admin/executive` | — | `artifacts/admin-visual-review/screenshots/admin-executive--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-executive--mobile.png` | — | — | — | — | — | — |
| `/admin/identity` | — | `artifacts/admin-visual-review/screenshots/admin-identity--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/access-reviews` | — | `artifacts/admin-visual-review/screenshots/admin-identity-access-reviews--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-access-reviews--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/permission-matrix` | — | `artifacts/admin-visual-review/screenshots/admin-identity-permission-matrix--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-permission-matrix--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/providers` | — | `artifacts/admin-visual-review/screenshots/admin-identity-providers--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-providers--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/runtime` | — | `artifacts/admin-visual-review/screenshots/admin-identity-runtime--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-runtime--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/scim` | — | `artifacts/admin-visual-review/screenshots/admin-identity-scim--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-scim--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/sessions` | — | `artifacts/admin-visual-review/screenshots/admin-identity-sessions--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-sessions--mobile.png` | — | — | — | — | — | — |
| `/admin/identity/timeline` | — | `artifacts/admin-visual-review/screenshots/admin-identity-timeline--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-identity-timeline--mobile.png` | — | — | — | — | — | — |
| `/admin/operations` | — | `artifacts/admin-visual-review/screenshots/admin-operations--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-operations--mobile.png` | — | — | — | — | — | — |
| `/admin/platform-health` | — | `artifacts/admin-visual-review/screenshots/admin-platform-health--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-health--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/analytics` | — | `artifacts/admin-visual-review/screenshots/admin-platform-analytics--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-analytics--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/automation` | — | `artifacts/admin-visual-review/screenshots/admin-platform-automation--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-automation--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/exports` | — | `artifacts/admin-visual-review/screenshots/admin-platform-exports--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-exports--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/media-graph` | — | `artifacts/admin-visual-review/screenshots/admin-platform-media-graph--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-media-graph--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/observability` | — | `artifacts/admin-visual-review/screenshots/admin-platform-observability--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-observability--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/queues` | — | `artifacts/admin-visual-review/screenshots/admin-platform-queues--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-queues--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/readiness` | — | `artifacts/admin-visual-review/screenshots/admin-platform-readiness--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-readiness--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/recovery` | — | `artifacts/admin-visual-review/screenshots/admin-platform-recovery--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-recovery--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/reliability` | — | `artifacts/admin-visual-review/screenshots/admin-platform-reliability--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-reliability--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/runbooks` | — | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks--mobile.png` | — | — | — | — | — | — |
| `/admin/platform/runbooks/:slug` | — | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks-slug--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks-slug--mobile.png` | — | — | — | — | `Platform admin / Platform operations / Runbooks` | `← All runbooks → /admin/platform/runbooks` |
| `/admin/platform/signers` | — | `artifacts/admin-visual-review/screenshots/admin-platform-signers--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-signers--mobile.png` | — | — | — | — | — | — |
| `/admin/provisioning` | — | `artifacts/admin-visual-review/screenshots/admin-provisioning--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-provisioning--mobile.png` | — | — | — | — | — | — |
| `/admin/search` | — | `artifacts/admin-visual-review/screenshots/admin-search--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-search--mobile.png` | — | — | — | — | — | — |
| `/admin/security` | — | `artifacts/admin-visual-review/screenshots/admin-security--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-security--mobile.png` | — | — | — | — | — | — |
| `/admin/support-access` | — | `artifacts/admin-visual-review/screenshots/admin-support-access--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-support-access--mobile.png` | — | — | — | — | — | — |
| `/admin/timeline` | — | `artifacts/admin-visual-review/screenshots/admin-timeline--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-timeline--mobile.png` | — | — | — | — | — | — |
| `/admin/users` | — | `artifacts/admin-visual-review/screenshots/admin-users--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-users--mobile.png` | — | — | — | — | — | — |
| `/admin/users/:id` | — | `artifacts/admin-visual-review/screenshots/admin-users-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-users-id--mobile.png` | — | — | — | — | `Platform admin / Accounts & access / People / Account` | `← All people → /admin/users` |
| `/admin/workspaces` | — | `artifacts/admin-visual-review/screenshots/admin-workspaces--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-workspaces--mobile.png` | — | — | — | — | — | — |
| `/admin/workspaces/:id` | — | `artifacts/admin-visual-review/screenshots/admin-workspaces-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-workspaces-id--mobile.png` | — | — | — | — | `Platform admin / Workspaces / Workspace inventory / Workspace` | `← All workspaces → /admin/workspaces` |

## Internal composition

| Route | Lines | cards/tables/sections | Open findings |
| --- | --- | --- | --- |
| `/admin` | 806 | 0c/0t/10s |  |
| `/admin/adoption` | 251 | 0c/1t/1s |  |
| `/admin/alerts` | 290 | 2c/0t/1s |  |
| `/admin/audit` | 849 | 3c/1t/2s |  |
| `/admin/billing` | 727 | 7c/5t/9s |  |
| `/admin/contact-sales` | 771 | 3c/1t/0s |  |
| `/admin/contact-sales/:id` | 650 | 5c/0t/0s |  |
| `/admin/costs` | 614 | 7c/3t/9s |  |
| `/admin/customers` | 463 | 0c/1t/0s |  |
| `/admin/customers/:id` | 1171 | 12c/1t/0s |  |
| `/admin/dashboard` | 882 | 11c/3t/8s |  |
| `/admin/demo-requests` | 1307 | 3c/0t/2s |  |
| `/admin/demo-requests/:id` | 522 | 5c/0t/0s |  |
| `/admin/evidence-ops` | 736 | 4c/0t/7s | HARDCODED_STATUS_HEX |
| `/admin/evidence-ops/records` | 547 | 2c/1t/0s |  |
| `/admin/executive` | 637 | 3c/2t/7s |  |
| `/admin/identity` | 296 | 13c/3t/7s | HARDCODED_STATUS_HEX |
| `/admin/identity/access-reviews` | 516 | 4c/1t/1s | HARDCODED_STATUS_HEX |
| `/admin/identity/permission-matrix` | 745 | 6c/1t/5s | HARDCODED_STATUS_HEX |
| `/admin/identity/providers` | 967 | 9c/1t/3s | HARDCODED_STATUS_HEX |
| `/admin/identity/runtime` | 676 | 1c/2t/3s | HARDCODED_STATUS_HEX |
| `/admin/identity/scim` | 1343 | 7c/4t/0s | HARDCODED_STATUS_HEX |
| `/admin/identity/sessions` | 56 | 6c/5t/20s |  |
| `/admin/identity/timeline` | 324 | 0c/1t/1s |  |
| `/admin/operations` | 513 | 2c/2t/2s |  |
| `/admin/platform-health` | 363 | 3c/0t/2s |  |
| `/admin/platform/analytics` | 811 | 0c/0t/9s | HARDCODED_STATUS_HEX |
| `/admin/platform/automation` | 664 | 0c/2t/5s | HARDCODED_STATUS_HEX |
| `/admin/platform/exports` | 845 | 0c/4t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/media-graph` | 716 | 0c/0t/5s | HARDCODED_STATUS_HEX |
| `/admin/platform/observability` | 1571 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/queues` | 801 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/readiness` | 604 | 8c/0t/6s | HARDCODED_STATUS_HEX |
| `/admin/platform/recovery` | 648 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/reliability` | 456 | 0c/0t/3s | HARDCODED_STATUS_HEX |
| `/admin/platform/runbooks` | 197 | 1c/0t/0s |  |
| `/admin/platform/runbooks/:slug` | 193 | 0c/0t/0s |  |
| `/admin/platform/signers` | 1192 | 0c/3t/0s | HARDCODED_STATUS_HEX |
| `/admin/provisioning` | 806 | 8c/1t/4s | HARDCODED_STATUS_HEX |
| `/admin/search` | 364 | 1c/0t/0s |  |
| `/admin/security` | 91 | 13c/6t/25s |  |
| `/admin/support-access` | 963 | 6c/2t/4s |  |
| `/admin/timeline` | 414 | 0c/1t/1s |  |
| `/admin/users` | 467 | 2c/2t/1s |  |
| `/admin/users/:id` | 557 | 7c/2t/6s |  |
| `/admin/workspaces` | 427 | 1c/1t/0s |  |
| `/admin/workspaces/:id` | 591 | 6c/1t/6s |  |
