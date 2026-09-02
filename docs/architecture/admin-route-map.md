# Admin route map

**Generated.** Regenerate with:

```bash
node apps/web/scripts/admin-inventory.mjs --markdown
```

Hand-writing this table would produce a document that was true on the day it
was written. Every column is read out of the tree: the registry entry, the
`PageRouteGate` the page renders, and — for each `/v1/...` path the page calls —
the handler that serves it, the authority that handler runs, and what `teamId`
does inside it.

## How to read the columns

**Actual scope** comes from following the request, not from the folder or the
hook name. Both mislead, and each misled in a different direction:

- `/admin/platform/queues` calls `useTeamId()` and sends `?teamId=`, which looks
  workspace-scoped. Its route header says the queues are GLOBAL and the
  workspace is only the audit scope.
- `/admin/platform/reliability` shows no Prisma `where` in its handler at all,
  which looked platform-wide. `countUploadSessionsByTeam({ teamId })` narrows it
  to one workspace inside the service.

So the **teamId role** column distinguishes:

| Value | Meaning |
| --- | --- |
| `FILTER` | Proven: an inline `where`, or a Prisma call carrying `teamId`. |
| `FILTER_CANDIDATE` | The handler passes `teamId` to something. A scoping service and an audit-recording call are the same shape, so this is a request for a human to read the handler — never an assertion. |
| `AUTHZ` | It decides who may call. |
| `AUDIT` | It is recorded and nothing else. |

Every non-`PLATFORM` row has a reviewed decision in
`apps/web/lib/navigation/adminScopeDispositions.ts`, and
`admin-scope-dispositions.test.ts` fails if one is missing, stale, or
contradicted by the navigation's scope badge.

## The map

| Route | Purpose | Nav section | In nav | Detail | Declared | Actual | teamId role | Authority | Visual | Parent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin` | Live platform posture, customers, workspaces, people, commercial atten | overview | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/adoption` | Read-only feature adoption, DERIVED from real entity counts across eve | commercial | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/alerts` | Current alert-worthy platform signals, grouped by severity: open incid | security | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/audit` | Tamper-evident, hash-chained record of privileged admin actions with o | audit | yes | — | PLATFORM_ADMIN | PLATFORM | ? | PLATFORM_ADMIN, UNRESOLVED | SHARED_SHELL | `/admin` |
| `/admin/billing` | Who pays for what, and what needs attention. Every attention row names | commercial | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/contact-sales` | Submissions from the public /contact-sales form. Records persist even  | customers | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/contact-sales/:id` | One-record view of a contact-sales inquiry submitted via the public fo | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin/contact-sales` |
| `/admin/costs` | Read-only view of estimated provider costs across every workspace. All | commercial | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/customers` | Read-only roster of every customer organization: plan, workspaces, sea | customers | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/customers/:id` | Read-only customer detail: overview, identity posture, evidence operat | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | ? | UNRESOLVED, PLATFORM_ADMIN | SHARED_SHELL | `/admin/customers` |
| `/admin/dashboard` | Product activity, geography, funnel and platform events for the select | commercial | yes | — | PLATFORM_ADMIN | PLATFORM | — | NONE_FOUND | SHARED_SHELL | `/admin` |
| `/admin/demo-requests` | Review inbound demo requests, inspect source and spam context, route q | customers | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/demo-requests/:id` | Qualification | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin/demo-requests` |
| `/admin/evidence-ops` | Platform-wide, read-only health of the evidence pipeline — uploads, si | evidence | yes | — | PLATFORM_ADMIN | PLATFORM | AUDIT | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/evidence-ops/records` |  | evidence | yes | — | PLATFORM_ADMIN | PLATFORM | AUDIT | PLATFORM_ADMIN | SHARED_SHELL | `/admin/evidence-ops` |
| `/admin/executive` | Read-only, honest platform KPIs. Gross revenue, customers, leads and u | commercial | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/identity` | Administer who belongs to this workspace, what extra access they hold, | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_UNCLASSIFIED | — | — | SHARED_SHELL | `/admin` |
| `/admin/identity/access-reviews` | Periodic and triggered certification of the access people and machines | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | ?/FILTER_CANDIDATE | UNRESOLVED, AUTH_ONLY | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/permission-matrix` | The authoritative role → permission projection, plus one member | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE/AUDIT | AUTH_ONLY | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/providers` | SSO connections. Multiple providers per workspace supported. JIT provi | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | FILTER/? | AUTH_ONLY, UNRESOLVED | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/runtime` | SOC console for live session governance. Inspect active sessions, quar | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | FILTER_CANDIDATE/?/FILTER | AUTH_ONLY, UNRESOLVED, AUTHORIZE(identity.org_ | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/scim` | SCIM Operations | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE/? | AUTH_ONLY, UNRESOLVED | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/sessions` | Who is signed in, on what, for how long, and what the workspace policy | accounts | yes | — | PLATFORM_ADMIN | PLATFORM | — | — | SHARED_SHELL | `/admin/identity` |
| `/admin/identity/timeline` | Workspace-wide identity events: SSO logins, SCIM syncs, session revoca | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | FILTER | AUTH_ONLY | SHARED_SHELL | `/admin/identity` |
| `/admin/operations` | Every operational condition on the platform, with the workspace and cu | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | FILTER/? | PLATFORM_ADMIN, UNRESOLVED | SHARED_SHELL | `/admin` |
| `/admin/platform-health` | Read-only, platform-wide health. Every service row is a real probe res | operations | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/platform/analytics` | Operational analytics require the ANALYTICS_VIEW capability (team writ | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | AUDIT/FILTER | AUTH_ONLY | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/automation` | Automation visibility requires the AUTOMATION_VIEW capability (team wr | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_FILTERED | FILTER | AUTH_ONLY | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/exports` | Inspect Report PDF + Verification Package exports. Verify reproducibil | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE | PLATFORM_OPS_ACTOR | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/media-graph` | Live counters and gauges for the media-intelligence async queue and th | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | ?/FILTER_CANDIDATE | PLATFORM_ADMIN, UNRESOLVED, AUTH_ONLY | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/observability` | Platform observability | operations | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/queues` | Inspect queues, triage failed jobs, replay safe jobs, and detect worke | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE/? | PLATFORM_OPS_ACTOR, UNRESOLVED | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/readiness` | A truthful, configuration-derived view of backup / preservation postur | operations | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/recovery` | What the PROOVRA application can validate at the application layer. In | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE | PLATFORM_OPS_ACTOR | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/reliability` | Internal-only view of upload session health for this workspace. Stalle | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE | AUTH_ONLY | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/runbooks` | The procedure an incident | operations | yes | — | PLATFORM_ADMIN | PLATFORM | — | — | SHARED_SHELL | `/admin/platform` |
| `/admin/platform/runbooks/:slug` |  | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | — | — | SHARED_SHELL | `/admin/platform/runbooks` |
| `/admin/platform/signers` | Inspect the active signer per artifact kind, run KMS health probes, st | operations | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | FILTER_CANDIDATE/? | PLATFORM_OPS_ACTOR, UNRESOLVED | SHARED_SHELL | `/admin/platform` |
| `/admin/provisioning` | Activate an enterprise customer end-to-end — no manual database edits. | customers | yes | — | PLATFORM_ADMIN | PLATFORM_AUDIT_SCOPED | AUDIT/? | PLATFORM_ADMIN, UNRESOLVED | SHARED_SHELL | `/admin` |
| `/admin/search` | Read-only search across organizations, users, workspaces, demo & conta | audit | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/security` | Multi-factor posture, member factor lifecycle and security events for  | security | yes | — | PLATFORM_ADMIN | WORKSPACE_UNCLASSIFIED | — | — | SHARED_SHELL | `/admin` |
| `/admin/support-access` | Restricted internal capabilities. Every action here carries dual ident | accounts | yes | — | PLATFORM_ADMIN | WORKSPACE_CANDIDATE | ?/AUDIT/FILTER_CANDIDATE | UNRESOLVED, AUTHORIZE(identity.org_policy.mana | SHARED_SHELL | `/admin` |
| `/admin/timeline` | A single, read-only chronological feed of platform-operational events  | security | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/users` | Every person on the platform, with the commercial context that answers | accounts | yes | — | PLATFORM_ADMIN | PLATFORM | AUDIT | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/users/:id` | Person unavailable | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin/users` |
| `/admin/workspaces` | Every workspace on the platform, by kind and lifecycle. A closed works | workspaces | yes | — | PLATFORM_ADMIN | PLATFORM | — | PLATFORM_ADMIN | SHARED_SHELL | `/admin` |
| `/admin/workspaces/:id` | Active, but will not renew | — | **no** | yes | PLATFORM_ADMIN | PLATFORM | AUDIT | PLATFORM_ADMIN | SHARED_SHELL | `/admin/workspaces` |

47 admin pages · 1066 API routes traced


## What the numbers mean now

| | Before | Now |
| --- | --- | --- |
| Pages on the shared enterprise shell | 38 / 47 | **47 / 47** |
| Non-detail pages missing from navigation | 7 | **0** |
| Pages with no registry entry | 9 | **0** |
| Page gates on the layout id instead of their own | 8 | **0** |
| Scope findings with no reviewed disposition | all | **0** |

The 19 remaining scope findings are not open questions — each has an argued
disposition and the navigation badge agrees with it. Three surfaces are
platform-wide with a workspace-shaped audit envelope (queues, signers,
media-graph, each verified in source); the rest are genuinely one tenant's data
and now say so. None was MOVED, and that is deliberate: the page gate
(PLATFORM_ADMIN) is stricter than the tenant APIs behind these surfaces, so
relocating them to a workspace URL would widen the audience from platform
operators to every workspace admin. That is a product decision, not a refactor.
