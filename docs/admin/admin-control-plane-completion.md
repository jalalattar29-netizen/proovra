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

**35 routes** · 35 completed · 0 pending · 1161 API routes traced

## Status

| Route | Kind | Family | Status | Reason / blocker |
| --- | --- | --- | --- | --- |
| `/admin` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.7 screens at 1440, 7.1 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/adoption` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/alerts` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/audit` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.8 screens at 1440, 7.9 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/billing` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.2 screens at 1440, 4.7 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/contact-sales` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1 screens at 1440, 1.1 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/contact-sales/:id` | dynamic | Commercial | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.5 screens at 1440, 3.4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/costs` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/customers` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1 screens at 1440, 1.2 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/customers/:id` | dynamic | Customers | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.3 screens at 1440, 6.6 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/dashboard` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/demo-requests` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.3 screens at 1440, 2.8 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/demo-requests/:id` | dynamic | Commercial | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2.1 screens at 1440, 3.8 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/evidence-ops` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.2 screens at 1440, 8.2 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/evidence-ops/records` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.2 screens at 1440, 1.5 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/executive` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/operations` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.8 screens at 1440, 6.6 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform-health` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/platform/exports` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1 screens at 1440, 1.2 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/media-graph` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2.4 screens at 1440, 5.6 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/observability` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.6 screens at 1440, 5.4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/queues` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2.3 screens at 1440, 5.4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/readiness` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/platform/recovery` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.4 screens at 1440, 1.9 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/runbooks` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 4.2 screens at 1440, 10.1 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/runbooks/:slug` | dynamic | Runbooks | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 3.9 screens at 1440, 7.7 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/platform/signers` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.2 screens at 1440, 2.1 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/provisioning` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/search` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/support-access` | static | (unassigned) | NO_INTERNAL_RECOMPOSITION_REQUIRED | Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen. |
| `/admin/timeline` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2.2 screens at 1440, 4.4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/users` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.6 screens at 1440, 2.3 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/users/:id` | dynamic | People | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2.7 screens at 1440, 4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/workspaces` | static | (unassigned) | REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 1.4 screens at 1440, 1.9 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |
| `/admin/workspaces/:id` | dynamic | Workspaces | CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED | Recomposed on this branch and verified in the browser: 2 screens at 1440, 4 at 390, matrix clean across 10 platform-admin runs and 6 refused roles. |

## Scope and authorization

| Route | Scope | Scope source | Capability | Backend authority | Nav | Parent |
| --- | --- | --- | --- | --- | --- | --- |
| `/admin` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | overview | /admin |
| `/admin/adoption` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | insight | /admin |
| `/admin/alerts` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/audit` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/billing` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | platform | /admin |
| `/admin/contact-sales` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
| `/admin/contact-sales/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/contact-sales |
| `/admin/costs` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | platform | /admin |
| `/admin/customers` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
| `/admin/customers/:id` | PLATFORM_AUDIT_SCOPED | handler trace | PLATFORM_ADMIN | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP | contextual | /admin/customers |
| `/admin/dashboard` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | insight | /admin |
| `/admin/demo-requests` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin, requirePlatformAdminOrInternalKey | customers | /admin |
| `/admin/demo-requests/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/demo-requests |
| `/admin/evidence-ops` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | evidence | /admin |
| `/admin/evidence-ops/records` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | evidence | /admin/evidence-ops |
| `/admin/executive` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | insight | /admin |
| `/admin/operations` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | platform | /admin |
| `/admin/platform-health` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | platform | /admin |
| `/admin/platform/exports` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | requirePlatformOpsActor | evidence | /admin/platform |
| `/admin/platform/media-graph` | WORKSPACE_CANDIDATE | handler trace | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin, requirePlatformOpsActor, requireDomainActionOnOpsSurface | evidence | /admin/platform |
| `/admin/platform/observability` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin | platform | /admin/platform |
| `/admin/platform/queues` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | platform | /admin/platform |
| `/admin/platform/readiness` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | requirePlatformAdmin | platform | /admin/platform |
| `/admin/platform/recovery` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | evidence | /admin/platform |
| `/admin/platform/runbooks` | PLATFORM | adminNavigation registry | RUNBOOKS_VIEW |  | runbooks | /admin/platform |
| `/admin/platform/runbooks/:slug` | PLATFORM | handler trace | RUNBOOKS_VIEW |  | contextual | /admin/platform/runbooks |
| `/admin/platform/signers` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | evidence | /admin/platform |
| `/admin/provisioning` | PLATFORM_AUDIT_SCOPED | handler trace | PLATFORM_ADMIN | requirePlatformAdmin, requireStepUpForSensitiveAction, +STEP_UP, requireAuthAndLegal | customers | /admin |
| `/admin/search` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/support-access` | WORKSPACE_FILTERED | handler trace | PLATFORM_ADMIN | requirePlatformStaff, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | security | /admin |
| `/admin/timeline` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | security | /admin |
| `/admin/users` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
| `/admin/users/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | requirePlatformAdmin | contextual | /admin/users |
| `/admin/workspaces` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | requirePlatformAdmin | customers | /admin |
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
| `/admin/operations` | GET | `/v1/admin/incidents` | requirePlatformAdmin | FILTER |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/acknowledge` | requirePlatformAdmin | NONE |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/resolve` | requirePlatformAdmin | NONE |
| `/admin/operations` | POST | `/v1/admin/incidents/:id/assign` | requirePlatformAdmin | NONE |
| `/admin/operations` | GET | `/v1/admin/security-events` | requirePlatformAdmin | FILTER |
| `/admin/platform-health` | GET | `/v1/admin/platform-health` | requirePlatformAdmin | NONE |
| `/admin/platform/exports` | GET | `/v1/operations/exports` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET | `/v1/operations/exports/object-lock` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET | `/v1/operations/exports/:id` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/exports` | POST | `/v1/operations/exports/:id/verify` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | GET | `/v1/ops/media-intelligence/runs` | requirePlatformAdmin | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | GET | `/v1/admin/platform/metrics` | requirePlatformAdmin | NONE |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/runs/:runId/retry` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/runs/:runId/dismiss` | requireDomainActionOnOpsSurface | AUDIT |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/dlq/replay` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/metrics` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/alerts` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/readiness` | requirePlatformAdmin | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/health-snapshot` | requirePlatformAdmin | NONE |
| `/admin/platform/queues` | GET | `/v1/operations/queues` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/workers` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/replay-safety` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/:queueName/failed` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/queues` | POST | `/v1/operations/queues/:queueName/jobs/:jobId/retry` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/queues` | POST | `/v1/operations/queues/:queueName/jobs/:jobId/replay` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/readiness` | GET | `/v1/operations/readiness` | requirePlatformAdmin | NONE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-backup` | requirePlatformOpsActor | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-restore` | requirePlatformOpsActor, requireStepUpForSensitiveAction, +STEP_UP | FILTER_CANDIDATE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery/reports/:id` | requirePlatformOpsActor | FILTER_CANDIDATE |
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
| `/admin/provisioning` | GET | `/v1/orgs/:id/invites` | requireAuthAndLegal | AUDIT |
| `/admin/provisioning` | POST | `/v1/orgs/:id/invites/:inviteId/resend` | requireAuthAndLegal | NONE |
| `/admin/provisioning` | DELETE | `/v1/orgs/:id/invites/:inviteId` | requireAuthAndLegal | NONE |
| `/admin/search` | GET | `/v1/admin/search` | requirePlatformAdmin | NONE |
| `/admin/support-access` | GET | `/v1/support-access/grants` | requirePlatformStaff | FILTER_CANDIDATE |
| `/admin/support-access` | GET | `/v1/break-glass/grants` | requirePlatformStaff | FILTER |
| `/admin/support-access` | POST | `/v1/support-access/enter` | requirePlatformStaff, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | AUDIT |
| `/admin/support-access` | POST | `/v1/support-access/revoke` | requirePlatformStaff | FILTER_CANDIDATE |
| `/admin/support-access` | POST | `/v1/support-access/start` | requirePlatformStaff, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/activate` | requirePlatformStaff, authorizeOrFail, requireStepUpForSensitiveAction, AUTHORIZE(?), +STEP_UP | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/revoke` | requirePlatformStaff, authorizeOrFail, AUTHORIZE(?) | FILTER_CANDIDATE |
| `/admin/timeline` | GET | `/v1/admin/timeline` | requirePlatformAdmin | NONE |
| `/admin/users` | GET | `/v1/admin/users` | requirePlatformAdmin | AUDIT |
| `/admin/users` | GET | `/v1/admin/lifecycle-requests` | requirePlatformAdmin | NONE |
| `/admin/users/:id` | GET | `/v1/admin/users/:id` | requirePlatformAdmin | NONE |
| `/admin/workspaces` | GET | `/v1/admin/workspaces` | requirePlatformAdmin | NONE |
| `/admin/workspaces/:id` | GET | `/v1/admin/workspaces/:id` | requirePlatformAdmin | AUDIT |

## Verification evidence

| Route | Fixture | Desktop | Mobile | RTL | States | Authz | Contract | Breadcrumb | Return |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin--desktop.png` | `artifacts/admin-visual-review/screenshots/admin--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/adoption` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-adoption--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-adoption--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/alerts` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-alerts--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-alerts--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/audit` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-audit--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-audit--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/billing` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-billing--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-billing--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/contact-sales` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-contact-sales--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-contact-sales--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/contact-sales/:id` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-contact-sales-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-contact-sales-id--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Customers / Contact sales / Sales inquiry` | `← Back to list → /admin/contact-sales` |
| `/admin/costs` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-costs--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-costs--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/customers` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-customers--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-customers--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/customers/:id` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-customers-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-customers-id--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Customers / Customer directory / Customer` | `← Back to roster → /admin/customers` |
| `/admin/dashboard` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-dashboard--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-dashboard--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/demo-requests` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-demo-requests--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-demo-requests--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/demo-requests/:id` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-demo-requests-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-demo-requests-id--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Customers / Demo requests / Demo request` | `← Back to list → /admin/demo-requests` |
| `/admin/evidence-ops` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/evidence-ops/records` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops-records--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-evidence-ops-records--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/executive` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-executive--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-executive--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/operations` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-operations--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-operations--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform-health` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-health--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-health--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/exports` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-exports--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-exports--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/media-graph` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-media-graph--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-media-graph--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/observability` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-observability--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-observability--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/queues` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-queues--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-queues--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/readiness` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-readiness--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-readiness--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/recovery` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-recovery--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-recovery--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/runbooks` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/platform/runbooks/:slug` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks-slug--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-runbooks-slug--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Platform operations / Runbooks` | `← All runbooks → /admin/platform/runbooks` |
| `/admin/platform/signers` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-platform-signers--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-platform-signers--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/provisioning` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-provisioning--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-provisioning--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/search` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-search--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-search--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/support-access` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-support-access--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-support-access--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/timeline` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-timeline--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-timeline--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#state-captures` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/users` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-users--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-users--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/users/:id` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-users-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-users-id--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Accounts & access / People / Account` | `← All people → /admin/users` |
| `/admin/workspaces` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-workspaces--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-workspaces--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | — | — |
| `/admin/workspaces/:id` | `services/api/scripts/seed-admin-fixture.ts` | `artifacts/admin-visual-review/screenshots/admin-workspaces-id--desktop.png` | `artifacts/admin-visual-review/screenshots/admin-workspaces-id--mobile.png` | `artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320` | `docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx` | `artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts` | `apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json` | `Platform admin / Workspaces / Workspace inventory / Workspace` | `← All workspaces → /admin/workspaces` |

## Internal composition

| Route | Lines | cards/tables/sections | Open findings |
| --- | --- | --- | --- |
| `/admin` | 1005 | 0c/0t/10s |  |
| `/admin/adoption` | 283 | 0c/1t/1s |  |
| `/admin/alerts` | 318 | 1c/0t/1s |  |
| `/admin/audit` | 1106 | 3c/1t/2s |  |
| `/admin/billing` | 766 | 7c/5t/9s |  |
| `/admin/contact-sales` | 840 | 3c/1t/0s |  |
| `/admin/contact-sales/:id` | 676 | 5c/0t/0s |  |
| `/admin/costs` | 670 | 8c/3t/10s |  |
| `/admin/customers` | 555 | 0c/1t/0s |  |
| `/admin/customers/:id` | 1224 | 12c/1t/0s |  |
| `/admin/dashboard` | 946 | 9c/3t/9s |  |
| `/admin/demo-requests` | 1340 | 3c/0t/2s |  |
| `/admin/demo-requests/:id` | 536 | 5c/0t/0s |  |
| `/admin/evidence-ops` | 790 | 4c/0t/7s |  |
| `/admin/evidence-ops/records` | 629 | 2c/1t/0s |  |
| `/admin/executive` | 731 | 4c/2t/8s |  |
| `/admin/operations` | 731 | 2c/2t/2s |  |
| `/admin/platform-health` | 568 | 3c/0t/4s |  |
| `/admin/platform/exports` | 860 | 0c/4t/0s |  |
| `/admin/platform/media-graph` | 1135 | 0c/1t/6s |  |
| `/admin/platform/observability` | 1664 | 0c/2t/0s |  |
| `/admin/platform/queues` | 869 | 0c/2t/0s |  |
| `/admin/platform/readiness` | 624 | 8c/0t/6s |  |
| `/admin/platform/recovery` | 653 | 0c/2t/0s |  |
| `/admin/platform/runbooks` | 199 | 1c/0t/0s |  |
| `/admin/platform/runbooks/:slug` | 233 | 0c/0t/0s |  |
| `/admin/platform/signers` | 1223 | 0c/3t/0s |  |
| `/admin/provisioning` | 775 | 13c/1t/4s |  |
| `/admin/search` | 410 | 1c/0t/0s |  |
| `/admin/support-access` | 1150 | 6c/2t/4s |  |
| `/admin/timeline` | 529 | 0c/1t/1s |  |
| `/admin/users` | 510 | 2c/2t/1s |  |
| `/admin/users/:id` | 721 | 7c/2t/6s |  |
| `/admin/workspaces` | 465 | 1c/1t/0s |  |
| `/admin/workspaces/:id` | 678 | 6c/1t/6s |  |
