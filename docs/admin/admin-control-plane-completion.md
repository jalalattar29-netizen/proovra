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

**47 routes** · 0 completed · 47 pending · 1066 API routes traced

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
| `/admin` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | overview | /admin |
| `/admin/adoption` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | commercial | /admin |
| `/admin/alerts` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | security | /admin |
| `/admin/audit` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN, UNRESOLVED | audit | /admin |
| `/admin/billing` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | commercial | /admin |
| `/admin/contact-sales` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | customers | /admin |
| `/admin/contact-sales/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | PLATFORM_ADMIN | contextual | /admin/contact-sales |
| `/admin/costs` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | commercial | /admin |
| `/admin/customers` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | customers | /admin |
| `/admin/customers/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | UNRESOLVED, PLATFORM_ADMIN | contextual | /admin/customers |
| `/admin/dashboard` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | NONE_FOUND | commercial | /admin |
| `/admin/demo-requests` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | customers | /admin |
| `/admin/demo-requests/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | PLATFORM_ADMIN | contextual | /admin/demo-requests |
| `/admin/evidence-ops` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | evidence | /admin |
| `/admin/evidence-ops/records` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | evidence | /admin/evidence-ops |
| `/admin/executive` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | commercial | /admin |
| `/admin/identity` | WORKSPACE_UNCLASSIFIED | adminNavigation registry | PLATFORM_ADMIN |  | accounts | /admin |
| `/admin/identity/access-reviews` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | UNRESOLVED, AUTH_ONLY | accounts | /admin/identity |
| `/admin/identity/permission-matrix` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | AUTH_ONLY | accounts | /admin/identity |
| `/admin/identity/providers` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | AUTH_ONLY, UNRESOLVED | accounts | /admin/identity |
| `/admin/identity/runtime` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | AUTH_ONLY, NONE_FOUND, AUTHORIZE(identity.org_policy.manage) | accounts | /admin/identity |
| `/admin/identity/scim` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | AUTH_ONLY, UNRESOLVED | accounts | /admin/identity |
| `/admin/identity/sessions` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN |  | accounts | /admin/identity |
| `/admin/identity/timeline` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | AUTH_ONLY | accounts | /admin/identity |
| `/admin/operations` | WORKSPACE_FILTERED | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN, UNRESOLVED | operations | /admin |
| `/admin/platform-health` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | operations | /admin |
| `/admin/platform/analytics` | WORKSPACE_FILTERED | adminNavigation registry | ANALYTICS_VIEW | AUTH_ONLY | operations | /admin/platform |
| `/admin/platform/automation` | WORKSPACE_FILTERED | adminNavigation registry | AUTOMATION_VIEW | AUTH_ONLY | operations | /admin/platform |
| `/admin/platform/exports` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | PLATFORM_OPS_ACTOR | operations | /admin/platform |
| `/admin/platform/media-graph` | WORKSPACE_CANDIDATE | handler trace | PLATFORM_TELEMETRY_VIEW | PLATFORM_ADMIN, UNRESOLVED, AUTH_ONLY | operations | /admin/platform |
| `/admin/platform/observability` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | PLATFORM_ADMIN | operations | /admin/platform |
| `/admin/platform/queues` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | PLATFORM_OPS_ACTOR | operations | /admin/platform |
| `/admin/platform/readiness` | PLATFORM | adminNavigation registry | PLATFORM_TELEMETRY_VIEW | PLATFORM_ADMIN | operations | /admin/platform |
| `/admin/platform/recovery` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | PLATFORM_OPS_ACTOR | operations | /admin/platform |
| `/admin/platform/reliability` | WORKSPACE_CANDIDATE | adminNavigation registry | OPS_CENTER_VIEW | AUTH_ONLY | operations | /admin/platform |
| `/admin/platform/runbooks` | PLATFORM | adminNavigation registry | RUNBOOKS_VIEW |  | operations | /admin/platform |
| `/admin/platform/runbooks/:slug` | PLATFORM | handler trace | RUNBOOKS_VIEW |  | contextual | /admin/platform/runbooks |
| `/admin/platform/signers` | WORKSPACE_CANDIDATE | handler trace | OPS_CENTER_VIEW | PLATFORM_OPS_ACTOR | operations | /admin/platform |
| `/admin/provisioning` | PLATFORM_AUDIT_SCOPED | handler trace | PLATFORM_ADMIN | PLATFORM_ADMIN, UNRESOLVED | customers | /admin |
| `/admin/search` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | audit | /admin |
| `/admin/security` | WORKSPACE_UNCLASSIFIED | adminNavigation registry | PLATFORM_ADMIN |  | security | /admin |
| `/admin/support-access` | WORKSPACE_CANDIDATE | adminNavigation registry | PLATFORM_ADMIN | UNRESOLVED, AUTHORIZE(identity.org_policy.manage) | accounts | /admin |
| `/admin/timeline` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | security | /admin |
| `/admin/users` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | accounts | /admin |
| `/admin/users/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | PLATFORM_ADMIN | contextual | /admin/users |
| `/admin/workspaces` | PLATFORM | adminNavigation registry | PLATFORM_ADMIN | PLATFORM_ADMIN | workspaces | /admin |
| `/admin/workspaces/:id` | PLATFORM | handler trace | PLATFORM_ADMIN | PLATFORM_ADMIN | contextual | /admin/workspaces |

## Backend contract

| Route | Method | Endpoint | Authority | teamId role |
| --- | --- | --- | --- | --- |
| `/admin` | GET | `/v1/admin/overview` | PLATFORM_ADMIN | NONE |
| `/admin/adoption` | GET | `/v1/admin/adoption` | PLATFORM_ADMIN | NONE |
| `/admin/alerts` | GET | `/v1/admin/alerts` | PLATFORM_ADMIN | NONE |
| `/admin/audit` | GET | `/v1/admin/audit-log` | PLATFORM_ADMIN | NONE |
| `/admin/audit` | GET | `undefined` | UNRESOLVED | ? |
| `/admin/audit` | GET | `/v1/admin/audit-log/verify` | PLATFORM_ADMIN | NONE |
| `/admin/billing` | GET | `/v1/admin/billing/detail` | PLATFORM_ADMIN | NONE |
| `/admin/contact-sales` | GET | `/v1/admin/contact-sales` | PLATFORM_ADMIN | NONE |
| `/admin/contact-sales` | PATCH | `/v1/admin/contact-sales/:id` | PLATFORM_ADMIN | NONE |
| `/admin/contact-sales/:id` | GET+PATCH | `/v1/admin/contact-sales/:id` | PLATFORM_ADMIN | NONE |
| `/admin/costs` | GET | `/v1/admin/costs` | PLATFORM_ADMIN | NONE |
| `/admin/customers` | GET | `/v1/admin/customers` | PLATFORM_ADMIN | NONE |
| `/admin/customers/:id` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/customers/:id` | GET | `/v1/admin/customers/:id` | PLATFORM_ADMIN | NONE |
| `/admin/dashboard` | GET | `/v1/admin/analytics/dashboard` | NONE_FOUND | NONE |
| `/admin/demo-requests` | GET | `/v1/admin/demo-requests` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests` | GET+PATCH | `/v1/admin/demo-requests/:id` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests` | GET+PATCH | `/v1/admin/demo-requests/:id` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/:id/route` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/:id/follow-up/send` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests` | POST | `/v1/admin/demo-requests/follow-up/run` | PLATFORM_ADMIN | NONE |
| `/admin/demo-requests/:id` | GET | `/v1/admin/demo-requests/:id` | PLATFORM_ADMIN | NONE |
| `/admin/evidence-ops` | GET | `/v1/admin/evidence-health` | PLATFORM_ADMIN | AUDIT |
| `/admin/evidence-ops/records` | GET | `/v1/admin/evidence-health/records` | PLATFORM_ADMIN | AUDIT |
| `/admin/executive` | GET | `/v1/admin/executive` | PLATFORM_ADMIN | NONE |
| `/admin/identity` | — | (no API call) | — | — |
| `/admin/identity/access-reviews` | GET | `undefined` | UNRESOLVED | ? |
| `/admin/identity/access-reviews` | POST | `/v1/identity/access-reviews/regenerate` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/access-reviews` | POST | `/v1/identity/access-reviews/regenerate` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/permission-matrix` | GET | `/v1/admin/identity/role-matrix` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/permission-matrix` | GET | `/v1/admin/identity/permission-matrix` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/permission-matrix` | POST | `/v1/admin/identity/elevations` | AUTH_ONLY | AUDIT |
| `/admin/identity/providers` | GET+POST | `/v1/admin/identity/providers` | AUTH_ONLY | FILTER |
| `/admin/identity/providers` | GET+POST | `/v1/admin/identity/providers` | AUTH_ONLY | FILTER |
| `/admin/identity/providers` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/identity/runtime` | GET | `/v1/admin/identity/sessions` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/runtime` | GET | `/v1/admin/identity/quarantined-sessions` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/sessions/reconcile-stale` | NONE_FOUND | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/admin/identity/emergency-revoke` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/runtime` | POST | `/v1/identity-security/reconcile` | AUTHORIZE(identity.org_policy.manage) | FILTER |
| `/admin/identity/scim` | GET+POST | `/v1/admin/identity/scim/tokens` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/scim` | GET+POST | `/v1/admin/identity/scim/tokens` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/identity/scim` | GET | `/v1/scim/reconciliation/preview` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `/v1/scim/reconciliation/execute` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/scim` | GET | `/v1/scim/sync-failures` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/identity/scim` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/identity/sessions` | — | (no API call) | — | — |
| `/admin/identity/timeline` | GET | `/v1/admin/identity/timeline` | AUTH_ONLY | FILTER |
| `/admin/operations` | GET | `/v1/admin/incidents` | PLATFORM_ADMIN | FILTER |
| `/admin/operations` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/platform-health` | GET | `/v1/admin/platform-health` | PLATFORM_ADMIN | NONE |
| `/admin/platform/analytics` | GET | `/v1/analytics/_window` | AUTH_ONLY | NONE |
| `/admin/platform/analytics` | GET | `/v1/analytics/operations` | AUTH_ONLY | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/reviewer` | AUTH_ONLY | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/governance` | AUTH_ONLY | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/automation` | AUTH_ONLY | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/analytics/artifacts` | AUTH_ONLY | AUDIT |
| `/admin/platform/analytics` | GET | `/v1/automation/webhooks` | AUTH_ONLY | FILTER |
| `/admin/platform/analytics` | GET | `/v1/automation/webhook-deliveries` | AUTH_ONLY | FILTER |
| `/admin/platform/automation` | GET | `/v1/automation/rules` | AUTH_ONLY | FILTER |
| `/admin/platform/automation` | GET | `/v1/automation/runs` | AUTH_ONLY | FILTER |
| `/admin/platform/exports` | GET | `/v1/operations/exports` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET | `/v1/operations/exports/object-lock` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/exports` | GET+POST | `/v1/operations/exports/:id` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/media-graph` | GET | `/v1/admin/platform/metrics` | PLATFORM_ADMIN | NONE |
| `/admin/platform/media-graph` | POST | `undefined` | UNRESOLVED | ? |
| `/admin/platform/media-graph` | POST | `/v1/ops/media-intelligence/dlq/replay` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/metrics` | PLATFORM_ADMIN | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/alerts` | PLATFORM_ADMIN | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/readiness` | PLATFORM_ADMIN | NONE |
| `/admin/platform/observability` | GET | `/v1/admin/platform/health-snapshot` | PLATFORM_ADMIN | NONE |
| `/admin/platform/queues` | GET | `/v1/operations/queues` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/workers` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET | `/v1/operations/queues/replay-safety` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/queues` | GET+POST | `/v1/operations/queues/workers` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/readiness` | GET | `/v1/operations/readiness` | PLATFORM_ADMIN | NONE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-backup` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/recovery` | POST | `/v1/operations/recovery/validate-restore` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/recovery` | GET | `/v1/operations/recovery/reports/:id` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/reliability` | GET | `/v1/reliability/summary` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/platform/reliability` | GET | `/v1/reliability/upload-sessions` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/platform/reliability` | POST | `/v1/reliability/upload-sessions/:evidenceId/mark-abandoned` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/platform/reliability` | POST | `/v1/reliability/upload-sessions/:evidenceId/request-review` | AUTH_ONLY | FILTER_CANDIDATE |
| `/admin/platform/runbooks` | — | (no API call) | — | — |
| `/admin/platform/runbooks/:slug` | — | (no API call) | — | — |
| `/admin/platform/signers` | GET | `/v1/operations/signers` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET | `/v1/operations/custody-attestations` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/custody-attestations/backfill` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/signers` | POST | `/v1/operations/custody-attestations/backfill` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/platform/signers` | GET+POST | `/v1/operations/signers/:id` | PLATFORM_OPS_ACTOR | FILTER_CANDIDATE |
| `/admin/provisioning` | POST | `/v1/admin/enterprise/provision` | PLATFORM_ADMIN | AUDIT |
| `/admin/provisioning` | PATCH | `undefined` | UNRESOLVED | ? |
| `/admin/search` | GET | `/v1/admin/search` | PLATFORM_ADMIN | NONE |
| `/admin/security` | — | (no API call) | — | — |
| `/admin/support-access` | GET | `undefined` | UNRESOLVED | ? |
| `/admin/support-access` | GET | `undefined` | UNRESOLVED | ? |
| `/admin/support-access` | POST | `/v1/support-access/enter` | AUTHORIZE(identity.org_policy.manage) | AUDIT |
| `/admin/support-access` | POST | `/v1/support-access/revoke` | AUTHORIZE(identity.org_policy.manage) | FILTER_CANDIDATE |
| `/admin/support-access` | POST | `/v1/support-access/start` | AUTHORIZE(identity.org_policy.manage) | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/activate` | AUTHORIZE(identity.org_policy.manage) | AUDIT |
| `/admin/support-access` | POST | `/v1/break-glass/revoke` | AUTHORIZE(identity.org_policy.manage) | FILTER_CANDIDATE |
| `/admin/timeline` | GET | `/v1/admin/timeline` | PLATFORM_ADMIN | NONE |
| `/admin/users` | GET | `/v1/admin/users` | PLATFORM_ADMIN | AUDIT |
| `/admin/users/:id` | GET | `/v1/admin/users/:id` | PLATFORM_ADMIN | NONE |
| `/admin/workspaces` | GET | `/v1/admin/workspaces` | PLATFORM_ADMIN | NONE |
| `/admin/workspaces/:id` | GET | `/v1/admin/workspaces/:id` | PLATFORM_ADMIN | AUDIT |

## Verification evidence

| Route | Fixture | Desktop | Mobile | RTL | States | Authz | Contract | Breadcrumb | Return |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin` | — | — | — | — | — | — | — | — | — |
| `/admin/adoption` | — | — | — | — | — | — | — | — | — |
| `/admin/alerts` | — | — | — | — | — | — | — | — | — |
| `/admin/audit` | — | — | — | — | — | — | — | — | — |
| `/admin/billing` | — | — | — | — | — | — | — | — | — |
| `/admin/contact-sales` | — | — | — | — | — | — | — | — | — |
| `/admin/contact-sales/:id` | — | — | — | — | — | — | — | `Platform admin / Customers / Contact sales / Sales inquiry` | `← Back to list → /admin/contact-sales` |
| `/admin/costs` | — | — | — | — | — | — | — | — | — |
| `/admin/customers` | — | — | — | — | — | — | — | — | — |
| `/admin/customers/:id` | — | — | — | — | — | — | — | `Platform admin / Customers / Customer directory / Customer` | `← Back to roster → /admin/customers` |
| `/admin/dashboard` | — | — | — | — | — | — | — | — | — |
| `/admin/demo-requests` | — | — | — | — | — | — | — | — | — |
| `/admin/demo-requests/:id` | — | — | — | — | — | — | — | `Platform admin / Customers / Demo requests / Demo request` | `← Back to list → /admin/demo-requests` |
| `/admin/evidence-ops` | — | — | — | — | — | — | — | — | — |
| `/admin/evidence-ops/records` | — | — | — | — | — | — | — | — | — |
| `/admin/executive` | — | — | — | — | — | — | — | — | — |
| `/admin/identity` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/access-reviews` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/permission-matrix` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/providers` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/runtime` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/scim` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/sessions` | — | — | — | — | — | — | — | — | — |
| `/admin/identity/timeline` | — | — | — | — | — | — | — | — | — |
| `/admin/operations` | — | — | — | — | — | — | — | — | — |
| `/admin/platform-health` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/analytics` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/automation` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/exports` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/media-graph` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/observability` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/queues` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/readiness` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/recovery` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/reliability` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/runbooks` | — | — | — | — | — | — | — | — | — |
| `/admin/platform/runbooks/:slug` | — | — | — | — | — | — | — | `Platform admin / Platform operations / Runbooks` | `← All runbooks → /admin/platform/runbooks` |
| `/admin/platform/signers` | — | — | — | — | — | — | — | — | — |
| `/admin/provisioning` | — | — | — | — | — | — | — | — | — |
| `/admin/search` | — | — | — | — | — | — | — | — | — |
| `/admin/security` | — | — | — | — | — | — | — | — | — |
| `/admin/support-access` | — | — | — | — | — | — | — | — | — |
| `/admin/timeline` | — | — | — | — | — | — | — | — | — |
| `/admin/users` | — | — | — | — | — | — | — | — | — |
| `/admin/users/:id` | — | — | — | — | — | — | — | `Platform admin / Accounts & access / People / Account` | `← All people → /admin/users` |
| `/admin/workspaces` | — | — | — | — | — | — | — | — | — |
| `/admin/workspaces/:id` | — | — | — | — | — | — | — | `Platform admin / Workspaces / Workspace inventory / Workspace` | `← All workspaces → /admin/workspaces` |

## Internal composition

| Route | Lines | cards/tables/sections | Open findings |
| --- | --- | --- | --- |
| `/admin` | 806 | 0c/0t/10s |  |
| `/admin/adoption` | 239 | 0c/1t/1s |  |
| `/admin/alerts` | 275 | 2c/0t/1s |  |
| `/admin/audit` | 718 | 4c/0t/2s |  |
| `/admin/billing` | 714 | 7c/5t/9s |  |
| `/admin/contact-sales` | 703 | 3c/1t/0s |  |
| `/admin/contact-sales/:id` | 609 | 5c/0t/0s |  |
| `/admin/costs` | 602 | 7c/3t/9s |  |
| `/admin/customers` | 463 | 0c/1t/0s |  |
| `/admin/customers/:id` | 1105 | 12c/1t/0s |  |
| `/admin/dashboard` | 865 | 11c/3t/8s |  |
| `/admin/demo-requests` | 1188 | 3c/0t/2s |  |
| `/admin/demo-requests/:id` | 522 | 5c/0t/0s |  |
| `/admin/evidence-ops` | 736 | 4c/0t/7s | HARDCODED_STATUS_HEX |
| `/admin/evidence-ops/records` | 547 | 2c/1t/0s |  |
| `/admin/executive` | 623 | 3c/2t/7s |  |
| `/admin/identity` | 296 | 13c/3t/7s | HARDCODED_STATUS_HEX |
| `/admin/identity/access-reviews` | 498 | 4c/1t/1s | HARDCODED_STATUS_HEX |
| `/admin/identity/permission-matrix` | 733 | 6c/1t/5s | HARDCODED_STATUS_HEX |
| `/admin/identity/providers` | 949 | 9c/1t/3s | HARDCODED_STATUS_HEX |
| `/admin/identity/runtime` | 553 | 1c/2t/3s | HARDCODED_STATUS_HEX |
| `/admin/identity/scim` | 1242 | 7c/4t/0s | HARDCODED_STATUS_HEX |
| `/admin/identity/sessions` | 56 | 6c/5t/20s |  |
| `/admin/identity/timeline` | 249 | 0c/1t/1s |  |
| `/admin/operations` | 483 | 2c/2t/2s |  |
| `/admin/platform-health` | 363 | 3c/0t/2s |  |
| `/admin/platform/analytics` | 811 | 0c/0t/9s | HARDCODED_STATUS_HEX |
| `/admin/platform/automation` | 585 | 0c/2t/5s | HARDCODED_STATUS_HEX |
| `/admin/platform/exports` | 829 | 0c/4t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/media-graph` | 696 | 0c/0t/5s | HARDCODED_STATUS_HEX |
| `/admin/platform/observability` | 1552 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/queues` | 753 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/readiness` | 604 | 8c/0t/6s | HARDCODED_STATUS_HEX |
| `/admin/platform/recovery` | 610 | 0c/2t/0s | HARDCODED_STATUS_HEX |
| `/admin/platform/reliability` | 447 | 0c/0t/3s | HARDCODED_STATUS_HEX |
| `/admin/platform/runbooks` | 197 | 1c/0t/0s |  |
| `/admin/platform/runbooks/:slug` | 180 | 0c/0t/0s |  |
| `/admin/platform/signers` | 1065 | 0c/3t/0s | HARDCODED_STATUS_HEX |
| `/admin/provisioning` | 773 | 8c/1t/4s | HARDCODED_STATUS_HEX |
| `/admin/search` | 332 | 1c/0t/0s |  |
| `/admin/security` | 87 | 15c/6t/25s |  |
| `/admin/support-access` | 938 | 6c/2t/4s |  |
| `/admin/timeline` | 263 | 0c/1t/1s |  |
| `/admin/users` | 467 | 2c/2t/1s |  |
| `/admin/users/:id` | 557 | 7c/2t/6s |  |
| `/admin/workspaces` | 427 | 1c/1t/0s |  |
| `/admin/workspaces/:id` | 591 | 6c/1t/6s |  |
