# Admin route map

**Generated.** Regenerate with:

```bash
node apps/web/scripts/admin-route-scope-audit.mjs --map
```

Hand-writing this table would produce a document that was true on the day it
was written. Every column below is read from the tree: the registry entry, the
`PageRouteGate` the page renders, and the API paths and workspace hooks its code
actually uses.

## How to read the two scope columns

**Declared scope** is `requiredActiveSpace` on the registry entry — what the
sidebar, the command palette and the route gate all believe.

**Actual scope** is what the page's code does. `Workspace in fact` means the
page resolves the operator's OWN active workspace (via `useTeamId`,
`useActiveSpaceId`, `useWorkspaceId` or a sibling) or sends that workspace as a
`?teamId=` parameter — so a platform-wide operator sees one tenant, or sees
nothing when no workspace is selected.

A page inspecting a workspace it was given by route param is **not** flagged;
that is a platform admin looking at a chosen tenant, which is correct.

**Gate** is the routeId the page's own `PageRouteGate` uses. `layout only` means
the page renders no gate of its own and inherits `platform.admin` from
`app/(app)/admin/layout.tsx`. That is not a defect while the page's registry
entry requires nothing more than the layout enforces — it is reported only when
it does.

## The map

| Route | Registry id | Declared scope | Actual scope | Authority | API surface | Gate | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin` | `platform.admin` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/adoption` | `platform.adoption` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.adoption` | — |
| `/admin/alerts` | `platform.alerts` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.alerts` | — |
| `/admin/audit` | `platform.audit` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 3 × /v1/admin | `layout only` | — |
| `/admin/billing` | `platform.billing` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/contact-sales` | `platform.contact_sales` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 2 × /v1/admin | `layout only` | — |
| `/admin/contact-sales/:id` | `platform.contact_sales_detail` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `admin.contactSales` | — |
| `/admin/costs` | `platform.costs` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.costs` | — |
| `/admin/customers` | `platform.customers` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/customers/:id` | `platform.customer_detail` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 2 × /v1/admin | `layout only` | — |
| `/admin/dashboard` | `platform.dashboard` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/demo-requests` | `platform.demo_requests` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 6 × /v1/admin | `layout only` | — |
| `/admin/demo-requests/:id` | `platform.demo_request_detail` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `admin.demoRequests` | — |
| `/admin/evidence-ops` | `platform.evidence_ops` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/evidence-ops/records` | `platform.evidence_records` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/executive` | `platform.executive` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.executive` | — |
| `/admin/identity` | `admin.identity` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | none | `admin.identity` | PLATFORM_READS_WORKSPACE |
| `/admin/identity/access-reviews` | `admin.identity_access_reviews` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 3 endpoints | `layout only` | PLATFORM_READS_WORKSPACE |
| `/admin/identity/permission-matrix` | `admin.identity_permission_matrix` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 3 × /v1/admin | `layout only` | PLATFORM_READS_WORKSPACE |
| `/admin/identity/providers` | `admin.identity_providers` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 2 × /v1/admin | `layout only` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/identity/runtime` | `admin.identity_runtime` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 4 × /v1/admin | `layout only` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/identity/scim` | `admin.identity_scim` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 2 × /v1/admin | `layout only` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/identity/sessions` | `admin.identity_sessions` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | none | `layout only` | — |
| `/admin/identity/timeline` | `admin.identity_timeline` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | PLATFORM_READS_WORKSPACE |
| `/admin/operations` | `platform.operations` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 2 × /v1/admin | `layout only` | — |
| `/admin/platform-health` | `platform.platform_health` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.platform_health` | — |
| `/admin/platform/analytics` | `platform.analytics` | PLATFORM_ADMIN | **Workspace in fact** | ANALYTICS_VIEW | 8 endpoints | `platform.analytics` | PLATFORM_READS_WORKSPACE |
| `/admin/platform/automation` | `platform.automation` | PLATFORM_ADMIN | **Workspace in fact** | AUTOMATION_VIEW | 2 endpoints | `platform.automation` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/platform/exports` | `operations.exports` | PLATFORM_ADMIN | **Workspace in fact** | OPS_CENTER_VIEW | 3 endpoints | `operations.exports` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/platform/media-graph` | `platform.media_graph` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_TELEMETRY_VIEW | 1 × /v1/admin | `platform.media_graph` | PLATFORM_READS_WORKSPACE |
| `/admin/platform/observability` | `platform.observability` | PLATFORM_ADMIN | Platform | PLATFORM_TELEMETRY_VIEW | 4 × /v1/admin | `platform.observability` | — |
| `/admin/platform/queues` | `platform.queue_ops` | PLATFORM_ADMIN | **Workspace in fact** | OPS_CENTER_VIEW | 4 endpoints | `platform.queue_ops` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/platform/readiness` | `operations.readiness` | PLATFORM_ADMIN | Platform | PLATFORM_TELEMETRY_VIEW | 1 endpoint | `operations.readiness` | — |
| `/admin/platform/recovery` | `operations.recovery` | PLATFORM_ADMIN | **Workspace in fact** | OPS_CENTER_VIEW | 4 endpoints | `operations.recovery` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/platform/reliability` | `platform.reliability` | PLATFORM_ADMIN | **Workspace in fact** | OPS_CENTER_VIEW | 4 endpoints | `platform.reliability` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/platform/runbooks` | `platform.runbooks` | PLATFORM_ADMIN | Platform | RUNBOOKS_VIEW | none | `platform.runbooks` | — |
| `/admin/platform/runbooks/:slug` | `platform.runbook_document` | PLATFORM_ADMIN | Platform | RUNBOOKS_VIEW | none | `platform.runbook_document` | — |
| `/admin/platform/signers` | `operations.signers` | PLATFORM_ADMIN | **Workspace in fact** | OPS_CENTER_VIEW | 5 endpoints | `operations.signers` | PLATFORM_READS_WORKSPACE, PLATFORM_SCOPES_API_BY_TEAM |
| `/admin/provisioning` | `platform.provisioning` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 2 × /v1/admin | `platform.provisioning` | PLATFORM_READS_WORKSPACE |
| `/admin/search` | `platform.search` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.search` | — |
| `/admin/security` | `platform.security` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | none | `layout only` | PLATFORM_READS_WORKSPACE |
| `/admin/support-access` | `platform.support_access` | PLATFORM_ADMIN | **Workspace in fact** | PLATFORM_ADMIN | 7 endpoints | `layout only` | PLATFORM_READS_WORKSPACE |
| `/admin/timeline` | `platform.timeline` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `platform.timeline` | — |
| `/admin/users` | `platform.users` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/users/:id` | `platform.person_detail` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/workspaces` | `platform.workspaces` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |
| `/admin/workspaces/:id` | `platform.workspace_detail` | PLATFORM_ADMIN | Platform | PLATFORM_ADMIN | 1 × /v1/admin | `layout only` | — |

47 admin pages · 18 with a scope contradiction

## What is closed, and what is not

**Closed.**

- `UNREGISTERED` → 0. Nine pages rendered with no registry entry — the seven
  `/admin/identity` children plus the two commercial detail pages. Each is now
  registered at exactly the authority the layout already enforced, and the two
  `:id` routes are in the dynamic-route allowlist.
- `GATE_MISMATCH` → 0. Eight pages gated on the layout's `platform.admin` while
  registered under their own id, which made each structurally unable to require
  anything the layout did not.
- One API-authority defect found by this audit and fixed in `c07c3ef2`: the four
  platform `/v1/operations/*` families authorized on `identity.member.read`,
  which every authenticated user holds in their own personal workspace. Proven
  live before fixing — an ordinary member read all eight endpoints, received
  `kmsKeyArn`, and started a platform DR validation.

**Open, and why it is not a mechanical edit.**

Eighteen pages read the operator's own workspace while presenting as platform
surfaces. Each needs one of three decisions, and the right one differs per page:

1. **The page should be platform-wide** — it is mislabelled by its own code.
   The fix is a workspace selector with an explicit "all workspaces" default,
   which needs the API to support an unscoped read. Some do not.
2. **The page is genuinely workspace-scoped** — it belongs under `/operations/*`
   with tenant authority. But moving it there BROADENS who can use it, and
   queue replay, signer backfill and DR validation are not tenant operations.
   Several of these cannot move without changing what they are allowed to do.
3. **The `teamId` is an audit scope, not a filter** — which is the case for
   queues, whose own route header says the queues are global and the workspace
   is only what operator actions are recorded against. Here the page is correct
   and the LABEL is wrong.

`/admin/platform/queues` is the clearest illustration of why the classification
work done previously was not equivalent to moving anything: it is labelled
`scope: "WORKSPACE"`, it calls `useTeamId()`, and it is nevertheless showing
platform-wide data. Moving it to a tenant route on the strength of the label
would have been wrong in both directions at once.
