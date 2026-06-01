# PROOVRA Phase 8 — Organization Admin Consolidation

> **Status:** SHIPPED ▸ pinned by four Phase 8 source-contract suites
> (`phase-8-org-admin-tab-surface.test.ts`,
> `phase-8-org-admin-personal-user-isolation.test.ts`,
> `phase-8-org-admin-cross-org-isolation.test.ts`,
> `phase-8-vocabulary-and-shell-honesty.test.ts`).
> **Author:** Architecture.
> **Date:** 2026-06-01.
> **Predecessors:** Phase 4A (Trust + Governance) and the Phase R11
> canonical domain model.

Phase 8 introduces **one** new operator surface: a unified
**organization-administration shell** at
`/organizations/[orgId]/admin`. The shell is a **read-and-link-out
aggregator** over the Phase 4A canonical pages. No new domain
nouns, no new workspace kinds, no new policy / governance / trust
data are introduced.

---

## 1. Constitutional alignment

Phase 8 was scoped explicitly to **not** weaken any rule pinned by
the Phase 7 closure constitution. Each rule is restated and the
Phase 8 design decision that honours it is recorded below.

| Rule (Phase 7 closure constitution)                                    | Phase 8 decision                                                                                                                                                                                                                          |
|------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Workspace kinds are only `PERSONAL` and `ORGANIZATION`.                 | No new workspace kind. The shell is page-scoped under `/organizations/[orgId]/admin/*`. There is no `OrgAdminWorkspace`, no `GovernanceWorkspace`, no `OperationsWorkspace`.                                                                |
| Team is **NOT** a workspace.                                            | Phase 8 does not rename, retag, or relocate Team. The Members tab manages **org membership** (`/v1/orgs/:id/members`), not collaboration-team membership. Collaboration Teams remain at `/collaboration-teams/*`.                          |
| Team is a core collaboration feature, must work in BOTH workspace kinds.| Phase 8 does not touch Collaboration Teams. The pre-existing dual-workspace surface (`workspace.collaboration_teams`) keeps its `PERSONAL_OR_ORG` reach.                                                                                   |
| Organization is **optional**.                                           | Every admin route is registered with `domain="ACCOUNT"`, `requiredActiveSpace="NONE"`, `sidebarEligible=false`, `advancedByDefault=true`, no `workflowTags`. Personal-only users never see these in sidebar, persona promotion, or Tools. |
| Reviewer is a role, not a workspace.                                    | Phase 8 does not surface a "Reviewer" tab. Reviewer remains the Review pillar's role.                                                                                                                                                     |
| Governance is a feature area, not a workspace.                          | The Governance / Departments / Access-Reviews tabs are **honest deep-link cards**, not mutation surfaces. CRUD remains on `/governance-platform`.                                                                                          |
| Operations is platform-admin only.                                      | Phase 8 introduces no operator surface in OPERATIONS. The shell sits in ADMIN.                                                                                                                                                            |
| **No fake workspace types.**                                            | Pinned: `phase-8-vocabulary-and-shell-honesty.test.ts` forbids the strings "Organization Workspace", "Org Workspace", "Governance Workspace", "Team Workspace", "Reviewer Workspace", "Operations Workspace" across all 11 shell files.    |

---

## 2. The consolidation pattern

The 10 admin routes follow a single **read-and-link-out** pattern:

1. **Layout shell** (`layout.tsx`) renders the org header + tab bar.
   It reads exactly **one** endpoint — `GET /v1/orgs/:id` — and
   surfaces `name`, `status`, `callerRole`, and the summary tile
   (`memberCount`, `workspaceCount`, `pendingInviteCount`).
2. **Index** (`page.tsx`) is a thin redirect to `/overview` so the
   tab bar always has an active tab.
3. **Each leaf tab** wraps in `<PageRouteGate routeId="account.organization-detail">`
   so denied callers (including non-members of the org) see the
   canonical "request access" panel instead of a blank page.
4. **Only one tab mutates: Members.** Every other tab is either a
   read-only summary (Overview, Audit, Retention) or a deep-link
   card (Departments, Governance, Access Reviews, Security, Trust).

This pattern is what makes Phase 8 zero-debt: aggregation surfaces
do not multiply data ownership. The Phase 4A pages remain the
single writer for every governance / trust / audit concept the
shell summarises.

---

## 3. Pinned route surface

The 10 route IDs are pinned by
`apps/web/lib/navigation/routeRegistry.ts` and mapped to the ADMIN
pillar in `apps/web/lib/navigation/pillarRegistry.ts`. They sit
inside the GOVERNANCE secondary operational group in
`apps/web/lib/navigation/phaseBOperationalGroups.ts`.

| Route ID                                          | Path                                                | Owns?              | Mutating?               | Canonical Phase 4A destination on link-out                                              |
|---------------------------------------------------|-----------------------------------------------------|--------------------|--------------------------|------------------------------------------------------------------------------------------|
| `account.organization_admin`                      | `/organizations/:id/admin`                          | Redirect index     | No                       | n/a (redirects to `/overview`)                                                          |
| `account.organization_admin_overview`             | `/organizations/:id/admin/overview`                 | Read-only summary  | No                       | `/governance-platform`, `/audit-transparency`, `/trust-center`, `/evidence-lifecycle`   |
| `account.organization_admin_members`              | `/organizations/:id/admin/members`                  | **Owns** members   | **Yes** (members, invites) | n/a (canonical writer)                                                                  |
| `account.organization_admin_departments`          | `/organizations/:id/admin/departments`              | Deep-link card     | No                       | `/governance-platform` (Departments)                                                    |
| `account.organization_admin_governance`           | `/organizations/:id/admin/governance`               | Deep-link card     | No                       | `/governance-platform` (Policies, Posture, Lifecycle)                                   |
| `account.organization_admin_access_reviews`       | `/organizations/:id/admin/access-reviews`           | Deep-link card     | No                       | `/governance-platform` (Access Reviews)                                                 |
| `account.organization_admin_retention`            | `/organizations/:id/admin/retention`                | Read-only summary  | No                       | `/evidence-lifecycle` (Retention, Legal Hold, Destruction)                              |
| `account.organization_admin_audit`                | `/organizations/:id/admin/audit`                    | Read-only timeline | No                       | `/audit-transparency` (Federated audit feed)                                            |
| `account.organization_admin_security`             | `/organizations/:id/admin/security`                 | Honest "not configured" rows | No             | `/admin/identity`, `/admin/identity/scim`, `/admin/identity/sessions`, `/settings/security` |
| `account.organization_admin_trust`                | `/organizations/:id/admin/trust`                    | Deep-link card     | No                       | `/trust-center` (Methodology, AI Disclosure, Subprocessors, Status)                     |

Every entry above uses `domain="ACCOUNT"`,
`requiredCapabilities=[]`, `requiredActiveSpace="NONE"`,
`fallbackBehavior="LOAD"`, `workflowTags=[]`,
`advancedByDefault=true`, `commandPaletteVisible=true`,
`allToolsVisible=true`, `sidebarEligible=false`. The combination
is deliberate: cmd-K and All Tools surface the shell for
power-user discovery, but sidebar / persona promotion stays clean
for personal-only users.

### Tab order (ADMIN_TABS)

The shell's `ADMIN_TABS` array in
`apps/web/app/(app)/organizations/[id]/admin/layout.tsx` pins the
operator-facing order:

1. Overview
2. Members
3. Departments
4. Governance
5. Access reviews
6. Retention & Legal hold
7. Audit
8. Security
9. Trust

The index redirect lands on Overview. The tab bar uses the
`segment` field for routing and the `label` field for the rendered
chip. The `description` is the leaf-page subtitle.

---

## 4. Read-only and link-out contract

The shell aggregates; the canonical Phase 4A pages mutate. This is
non-negotiable for Phase 8 because it is what keeps the
constitutional rule "Governance is a feature area, not a
workspace" true. If the org-admin shell were allowed to mutate
governance policies at org scope, we would have implicitly created
an "Organization Governance Workspace" — the exact kind of fake
workspace the Phase 7 anti-confusion suite forbids.

The contract is enforced in three places:

1. **Page-level**: `phase-8-org-admin-tab-surface.test.ts` asserts
   that the Governance, Departments, Access-Reviews, Security, and
   Trust tabs contain `Link` elements to the canonical Phase 4A
   destinations. No `<form>` / `<input>` in the Security tab.
2. **Vocabulary-level**: `phase-8-vocabulary-and-shell-honesty.test.ts`
   asserts that the Security tab renders explicit "Not configured"
   rows with `configureHref` deep-links — never green checkmarks
   or fake-positive readiness.
3. **API-level**: the canonical Phase 4A endpoints
   (`/v1/governance/policies/*`, `/v1/access-reviews/*`,
   `/v1/trust/articles/*`) remain `requireWorkspace`-gated. The
   shell sits in `requiredActiveSpace="NONE"` and therefore
   **cannot** call those endpoints from its own routing context
   even if a future PR tried to wire one up — the gate would 412.

### The one mutating tab: Members

Members is the only canonical writer. It hits:

- `GET    /v1/orgs/:id/members`
- `PATCH  /v1/orgs/:id/members/:membershipId`           (`ORG_ADMIN`+)
- `DELETE /v1/orgs/:id/members/:membershipId`           (`ORG_ADMIN`+)
- `GET    /v1/orgs/:id/invites`
- `POST   /v1/orgs/:id/invites`                         (`ORG_ADMIN`+)
- `POST   /v1/orgs/:id/invites/:inviteId/resend`
- `DELETE /v1/orgs/:id/invites/:inviteId`

All destructive flows route through `useConfirmAction` (the
`ConfirmActionModal` hook). The Phase 7 ban on raw `window.confirm`
is preserved — pinned by the vocabulary suite.

### The honest Security tab

The Security tab is the closest the shell gets to fake-positive
risk. We chose the **honest empty state** path: every readiness
row (`MFA`, `SSO`, `SCIM`, `Sessions`) defaults to
`configured: false` with a `configureHref` pointing at the
canonical configuration surface (`/admin/identity`,
`/admin/identity/scim`, `/admin/identity/sessions`,
`/settings/security`).

This is enforced by source-contract tests — there is no in-shell
`<form>` or `<input>`, and the strings "All set", "Configured",
and "Green" are forbidden as fake-positive readiness labels.

When a future phase ships an `/v1/orgs/:id/security/readiness`
endpoint, the rows will be backed by real signal; until then,
"Not configured" is the truth.

---

## 5. Why Organization stays optional

A natural failure mode for an "org admin shell" is to make
Organization feel **required** — by surfacing it in the sidebar,
by demanding an active org context, or by promoting the route
into persona-default navigation. Phase 8 deliberately avoids all
three:

- **Sidebar**: every admin route is `sidebarEligible=false`.
  Personal-only users see no admin link in the primary nav.
- **Active space**: every admin route is
  `requiredActiveSpace="NONE"`. The shell does **not** demand an
  active workspace. A personal-first user who happens to hold an
  organization membership can still reach the shell from cmd-K or
  the org detail page CTA; the API enforces membership via the
  existing `checkOrgAccess` pathway and 403s with a `requestId`
  for non-members.
- **Persona promotion**: every admin route is
  `advancedByDefault=true` and has no `workflowTags`. Persona
  resolvers will never push the shell into a persona's top-N
  surfacing.

The shell is reachable from exactly one place in the primary UI:
the **"Open Admin"** CTA on the organization detail page
(`/organizations/[id]`). Personal-only users who never visit that
page never see the shell.

---

## 6. Why Team is not a workspace (re-affirmed)

The shell deliberately uses the word **Members** for the
mutating tab — not **Team**. The constitutional rule "Team is NOT
a workspace" applies to the product noun, and "Members" is the
operator label that matches the org-membership data model
(`/v1/orgs/:id/members`, `ORG_OWNER` / `ORG_ADMIN` / etc. roles).

Collaboration Teams remain at `/collaboration-teams/*` and keep
their `PERSONAL_OR_ORG` workspace reach. The Phase 8 shell does
not link to Collaboration Teams from its primary tab bar — they
are a different product noun. The legacy Workspace admin link in
the shell header (`/teams?org=...`) is a deliberate handoff to
the existing per-workspace admin page, not a relabel.

---

## 7. Why governance-platform remains workspace-scoped

The Governance Platform (`/governance-platform`) and its
underlying API surface (`/v1/governance/*`) were built in Phase
4A as **workspace-scoped**: every policy evaluation, every
department membership write, every cross-org assignment is bound
to an active workspace. This is the source of truth for the rule
"Governance is a feature area, not a workspace."

Phase 8 considered (and rejected) two alternatives:

1. **Republish governance mutations at org scope.** This would
   require either (a) a new `/v1/orgs/:id/policies/*` write
   surface duplicating policy CRUD, or (b) a context shim that
   silently promotes the active workspace to one of the org's
   workspaces. Both options create a parallel write path that
   diverges from the Phase 4A audit lineage; both implicitly
   create an "Organization Governance" entity that is not in the
   domain model. Rejected.
2. **Make `requireWorkspace` permissive when the caller is an org
   admin.** This would weaken the Phase 4A invariant that every
   policy evaluation lands on a known workspace, making
   department isolation harder to reason about. Rejected.

The chosen path — **the Governance, Departments, and
Access-Reviews tabs link out to `/governance-platform`** — keeps
the Phase 4A audit lineage intact and keeps Phase 8 zero-debt.

---

## 8. Cross-org isolation contract

The shell's `:id` parameter is the only cross-org isolation
boundary. It is enforced in three layers:

1. **Routing**: every admin page derives `orgId` from
   `useParams<{ id: string }>()`. No page contains a literal UUID.
2. **API call shape**: every `apiFetch` call inside the shell
   uses the path template `/v1/orgs/${orgId}/...`. Pinned by
   `phase-8-org-admin-cross-org-isolation.test.ts`.
3. **Server-side**: `organizations.routes.ts` UUID-validates the
   path param and runs the existing `checkOrgAccess` gate on
   `GET /v1/orgs/:id`, `/:id/members`, and `/:id/audit-events`.
   Non-members receive a 403 with `requestId`.

The shell's error states surface the `requestId` honestly. The
layout header and the Members tab both render
`data-testid="org-admin-error-request-id"` when an `ApiError`
includes a request id.

---

## 9. Server-side mirror — intentionally omitted

The navigation stream deliberately did **not** mirror the 10 new
route IDs in
`services/api/src/services/platform-context/navigation-registry.ts`.
A documentation comment in that file records the reason:

- The admin shell is **page-scoped**, not sidebar or
  account-menu surfaced. There is no "promote to sidebar" code
  path on the API side that would need to know about it.
- `PageRouteGate` uses the **client-side** `routeRegistry`. The
  API does not need a duplicate definition to permit a route
  the user navigated to directly.
- Capability gating happens at the API endpoint via the existing
  `checkOrgAccess` pathway. No new capabilities were introduced.
- The canonical equivalent `account.organization-detail` is also
  not mirrored server-side. Phase 8 follows the established
  pattern.

This omission is **not** a deferral — it is a deliberate design
choice, recorded so a future contributor doesn't "fix" it.

---

## 10. Test pinning

Four source-contract suites pin Phase 8 (380 tests, all green
locally):

| Suite                                                 | Pins                                                                                                                                                |
|-------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `phase-8-org-admin-tab-surface.test.ts`               | 10 route IDs + their `ACCOUNT/NONE/LOAD/false/true/true/true` shape; PageRouteGate wrapping on every leaf; ADMIN pillar mapping; ADMIN_TABS shape; canonical Phase 4A deep-links. |
| `phase-8-org-admin-personal-user-isolation.test.ts`   | Every admin route is `sidebarEligible=false`, no `workflowTags`, `advancedByDefault=true`; layout reads `/v1/orgs/${orgId}`; sidebar has no hard-coded org admin links; collaboration teams remain `PERSONAL_OR_ORG`. |
| `phase-8-org-admin-cross-org-isolation.test.ts`       | Every admin page derives `orgId` from `useParams`; every `/v1/orgs/` fetch is parameterised; `organizations.routes.ts` UUID-validates `:id` and uses `checkOrgAccess`; no literal UUIDs in admin pages. |
| `phase-8-vocabulary-and-shell-honesty.test.ts`        | No fake workspace types in any of the 11 shell files; "Organization" is the canonical operator label; Security tab uses "Not configured" rows with `configureHref` deep-links and no in-shell form/input; no `window.confirm`; no `envelope.workspace.*` reads. |

---

## 11. Final validation matrix

| Validation                                                            | Result                                                                  |
|-----------------------------------------------------------------------|-------------------------------------------------------------------------|
| `services/api` vitest (Phase 8 suites)                                | 380 / 380 pass                                                          |
| `services/api` vitest (Phase 7 anti-confusion suite — regression)     | 8 / 8 pass                                                              |
| `services/api` vitest (Phase 1A/B/CR0/R2/R5/G0/32-8 — regression)     | 235 / 235 pass                                                          |
| `apps/web` `tsc --noEmit`                                             | Clean (exit 0)                                                          |
| `services/api` `tsc --noEmit`                                         | Clean                                                                   |
| Prisma schema changes                                                 | None — Phase 8 is UI-only consolidation                                 |
| New migrations                                                        | None                                                                   |
| New capabilities                                                      | None — reuses existing per-tab API role checks                          |
| Raw `window.confirm` introduced                                       | None — `useConfirmAction` everywhere                                    |
| Direct `envelope.workspace.*` reads                                   | None — all reads via `apiFetch` against `/v1/orgs/:id*`                  |

---

## 12. Items deferred to Phase 9

Phase 8 is **intentionally narrow**. The following items are
recognised and deferred — see the Phase 8 closure section of
`docs/architecture/phase-7-closure-audit.md` for the canonical
list:

1. **Full org-scoped policy mutation surface.** Today the
   Governance / Access-Reviews tabs deep-link to
   `/governance-platform` (workspace-scoped). A future phase may
   add a true `/v1/orgs/:id/policies/*` write surface — but only
   if the domain model is first extended with a first-class
   "org-scoped governance" concept that does not implicitly
   create an "Organization Governance Workspace".
2. **Org-level access-review coordination.** The Access Reviews
   tab today links out per-workspace. Cross-workspace coordination
   (e.g. one org-wide campaign that fans out per workspace) is
   deferred.
3. **Org billing administration.** Phase 8 explicitly does not
   touch billing or Stripe (per the briefing). A future Phase 9
   billing pass may add a Billing tab; until then, billing lives
   on the canonical `TeamWorkspaceCard` surface.
4. **Full SSO / SCIM admin UX.** The Security tab is honest about
   what it does not know. Phase 9 may add real readiness signal
   (an `/v1/orgs/:id/security/readiness` endpoint) backed by
   probes against `/admin/identity` configuration; today the
   shell links out instead of fake-positive readiness.

These deferrals are **constitutional**, not accidental — each one
is a place where Phase 8 chose link-out over a parallel write
surface to keep the Phase 7 closure constitution intact.

---

## 13. Sign-off

Phase 8 ships the org-admin shell at
`/organizations/[orgId]/admin/*` as a read-and-link-out
aggregator over the Phase 4A canonical pages. Members is the only
mutating tab; every other tab is a read-only summary or a deep-
link card. Organization stays optional, Team stays a
collaboration feature, Reviewer stays a role, Governance stays a
feature area, and no new workspace kind is introduced. The shell
is pinned by four source-contract suites and verified clean on
typecheck.
