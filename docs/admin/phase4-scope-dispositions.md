# Phase 4 — Admin scope dispositions

A concise extension of the generated inventory in
`admin-control-plane-completion.md`, which already derives each route's scope,
page gate and API authority from the tree. This adds the one thing a generator
cannot: the **product decision** for each surface, and where the runtime proof
for it lives.

Scope is decided from the final backend query and the product purpose — never
from the folder, the URL or a hook name. Where the two disagreed, the
disagreement was the defect.

Proof files (live PostgreSQL 16, real routes, real authorization):

- `services/api/test/phase4-closure-scope-and-audience.integration.test.ts`
- `services/api/test/phase4-support-access-lifecycle.integration.test.ts`
- `services/api/test/phase4-identity-audience.integration.test.ts`
- `services/api/test/phase4-admin-scope-and-tenant-isolation.integration.test.ts`
- `apps/web/__tests__/phase4-admin-navigation-audience.test.ts`

---

## Platform-global surfaces

Platform authority is the boundary. Membership in any workspace grants
nothing, a `teamId` in the query is not a ticket, and the active header
workspace is not an input — proved A/B/A, twice, against two differently
seeded workspaces.

| Surface | Disposition |
| --- | --- |
| `/admin`, `/admin/dashboard`, `/admin/executive`, `/admin/adoption` | PROVEN_CORRECT |
| `/admin/users`, `/admin/users/:id` | PROVEN_CORRECT |
| `/admin/customers`, `/admin/customers/:id` | PROVEN_CORRECT |
| `/admin/workspaces`, `/admin/workspaces/:id` | PROVEN_CORRECT |
| `/admin/search` | FIXED_AND_RUNTIME_PROVEN — identifier classifier repaired (pushed earlier) |
| `/admin/contact-sales`, `/admin/demo-requests` (+ details) | FIXED_AND_RUNTIME_PROVEN — raw user-agent removed (pushed earlier) |
| `/admin/alerts`, `/admin/audit`, `/admin/timeline`, `/admin/security` | PROVEN_CORRECT |
| `/admin/billing`, `/admin/costs` | PROVEN_CORRECT |
| `/admin/platform/observability`, `/admin/platform-health`, `/admin/platform/readiness` | PROVEN_CORRECT |
| `/admin/platform/analytics` | NOT_APPLICABLE to this table — WORKSPACE-scoped, listed below |
| `/admin/provisioning`, `/admin/enterprise/provision` | FIXED_AND_RUNTIME_PROVEN — personal-container plan grant refused (pushed earlier) |
| `/admin/support-access` | FIXED_AND_RUNTIME_PROVEN — see below; scope corrected to PLATFORM_AUDIT |

## Workspace-scoped surfaces

Authority binds to the exact workspace named in the request. The header cannot
retarget it, substitution in path, query or body is refused without disclosing
the other tenant, and a refusal writes nothing.

| Surface | Disposition |
| --- | --- |
| `/admin/identity/providers` | PROVEN_CORRECT — WORKSPACE_ADMIN_SELF_SERVICE |
| `/admin/identity/scim` | PROVEN_CORRECT — WORKSPACE_ADMIN_SELF_SERVICE |
| `/admin/identity/sessions`, `/admin/identity/runtime` | PROVEN_CORRECT — WORKSPACE_ADMIN_SELF_SERVICE |
| `/admin/identity/timeline` | PROVEN_CORRECT — WORKSPACE_ADMIN_SELF_SERVICE |
| `/admin/identity/access-reviews` | PROVEN_CORRECT — proved through a full decision lifecycle in Phase 3 |
| `/admin/identity/permission-matrix` | PROVEN_CORRECT — WORKSPACE_ADMIN_SELF_SERVICE |
| `/admin/platform/reliability` | FIXED_AND_RUNTIME_PROVEN — see below |
| `/admin/platform/automation` | PROVEN_CORRECT — workspace Operations Center; its own copy already says so |
| `/admin/platform/analytics` | PROVEN_CORRECT — `/v1/analytics/*` is served by `analytics-operations.routes.ts` under `authorizeOrFail`, not by the platform `analytics.routes.ts` |
| `/admin/platform/exports`, `/admin/platform/recovery` | PROVEN_CORRECT as WORKSPACE — the gate is platform (`requirePlatformOpsActor`) but `listExports` narrows on `evidence.teamId` and `listRecoveryReports` on `teamId`. The banner describes what is DISPLAYED, and what is displayed is one workspace's |
| `/admin/security` | PROVEN_CORRECT as WORKSPACE — `/v1/identity/mfa-admin/*` is `authorizeOrFail` |

**`/admin/platform/reliability`** led with the eyebrow *"Platform operations"*
while its own subtitle said *"for this workspace"* and its API answers for
exactly one workspace — refusing even a platform operator who is not a member.
An operator reading "platform" trusts those counts to be the whole estate. The
label now states the real scope. The route was **not** re-homed: moving it
would change nothing about authority and would break existing links.

## Platform control actions

Platform authority server-side, the established step-up boundary, an explicit
target, and no caller-controlled field able to choose whether either applies.

| Surface | Disposition |
| --- | --- |
| `/admin/identity/emergency-revoke` | PROVEN_CORRECT — refused to every workspace identity with zero effect; never an unchallenged success for the operator |
| `/admin/platform/queues` (retry / replay) | PROVEN_CORRECT — step-up gate repaired and proved in Phase 3 |
| `/admin/platform/signers` (promote / retire / revoke) | PROVEN_CORRECT — Phase 1 architecture regression-proved in Phase 3 |
| `/admin/platform/exports`, `/admin/platform/media-graph`, `/admin/platform/recovery` | PROVEN_CORRECT — Phase 3 mutation proofs |
| Support access start / revoke | FIXED_AND_RUNTIME_PROVEN — see below |

## Support access

| Property | Disposition |
| --- | --- |
| Platform-global inventory, not enumerable by any workspace identity | PROVEN_CORRECT |
| Explicit target organization and workspace, never inferred from the header | PROVEN_CORRECT |
| Revocation reachable by the authority whose job it is | FIXED_AND_RUNTIME_PROVEN — `authorizeOrFail` on a caller-supplied `teamId` refused platform staff 403 |
| Effective state distinguishes lapsed from active | FIXED_AND_RUNTIME_PROVEN — projection and filter both ignored the clock |
| Revocation idempotent and convergent under concurrency | PROVEN_CORRECT — four simultaneous revokes, one revocation, `revokedAtUtc` unmoved |
| A revoked grant never becomes effectively ACTIVE again | PROVEN_CORRECT |
| No token, secret or hash in the inventory | PROVEN_CORRECT |
| Effective state recomputed from the store, not cached in the process | PROVEN_CORRECT |
| The console's scope label matches what the page displays | FIXED_AND_RUNTIME_PROVEN — see below |

The page carried the **workspace** banner: *"This page administers your own
active workspace — not the platform."* On the surface that starts break-glass
into a customer organization, that is the most reassuring possible wording for
the least contained action in the product.

It had been true. The support grant listing used to narrow by the supplied
`teamId`, so the page really did show one workspace's rows. The Phase 4
authority fix removed that narrowing — `/v1/support-access/grants` is now
platform staff, listing the actor's grants across every tenant, and
`/v1/break-glass/grants` never narrowed at all. The label was left behind by its
own justification.

It now reads **platform-wide, active workspace as audit scope** — the third
state this console already models for `/admin/provisioning` and
`/admin/customers/:id`. `teamId` still binds authority and audit on `/start`
and `/enter`; it filters nothing that is shown. The claim is pinned by
`the listing is NOT narrowed by any workspace` in the lifecycle proof: two
grants, two organizations, two workspaces, one staff request, both rows back.

**Workspace-owned projection of support grants: NOT_APPLICABLE** — the product
has no surface offering a workspace administrator a view of support grants
affecting their workspace. `/v1/support-access/grants` is gated by
`requirePlatformStaff` and defaults to the caller's own grants; no Admin or
tenant page consumes it for a workspace audience. Building one would be new
product, not a Phase 4 correction.

## Navigation and audience

| Property | Disposition |
| --- | --- |
| Every Admin destination resolves to a real route | PROVEN_CORRECT |
| A platform operator can see and load every destination offered | PROVEN_CORRECT |
| No non-platform identity is offered a platform destination — including a workspace owner holding every workspace capability | PROVEN_CORRECT |
| Every refusal carries a state and a reason to render, so a direct URL is never a blank page | PROVEN_CORRECT |
| The Command Palette never surfaces a destination the sidebar would hide | PROVEN_CORRECT |

The Admin sidebar renders its sections unfiltered. That is correct rather than
lax: the console layout is platform-gated, so every viewer of the sidebar is a
platform operator, and the proof above shows a platform operator can load every
entry it offers. An unfiltered list of destinations you can all reach is not a
leak.
