# PROOVRA — Phase 8 Organization & Governance Layer (Closure)

_Status: **CLOSED** — all source-contract + behavioral tests pass._

This document is the operator-facing audit record for Phase 8 of
the Enterprise Architecture Recovery program — the Organization &
Governance Layer. It records the constitutional ground rules,
the new operator surfaces shipped, the reuse map onto the existing
Phase 4A canonical pages, the pinning tests, the validation matrix,
the vocabulary contracts that remain enforced, and the surfaces
deferred to Phase 9.

A companion implementation-detail document lives at
`docs/architecture/phase-8-org-admin-consolidation.md`. This file
is the canonical Phase 8 **closure** record and mirrors the
structure of `docs/architecture/phase-7-closure-audit.md`.

---

## Constitutional rules (Phase 8 closure constitution)

1. Workspace kinds are **only** `PERSONAL` and `ORGANIZATION`.
2. Team is **NOT** a workspace.
3. Team is **NOT** a tenant.
4. Team is **NOT** enterprise-only.
5. Team is a **core collaboration feature** and must work in
   **BOTH** Personal Workspace and Organization Workspace.
6. Organization is **optional** — personal users are never
   blocked, gated, or sidebar-degraded by Organization absence.
7. Organization is the **enterprise governance umbrella** — it
   is the legal / billing / SSO / SCIM / departments / retention
   container, not a second tenancy boundary.
8. Governance is a **feature area inside Organization**, not a
   workspace, not a tenant, not a parallel product.
9. Reviewer is a **role / capability**, not a workspace.
10. Operations is **platform-admin only**.
11. **No fake workspace types** — no `Team Workspace`,
    `Reviewer Workspace`, `Governance Workspace`,
    `Operations Workspace`, `Organization Workspace`-as-third-kind,
    etc.
12. Do **not rename** Team or Workspace at the product-noun
    level — the runtime distinction is enforced at URL +
    route-id + page-text level, not by DB-table renames.
13. **No second Team product.** `/collaboration-teams/*` is the
    one Team product; Phase 8 does not introduce another.
14. **No parallel Organization system.** Phase 8 reuses the
    Phase 4A Organization graph in full — no shadow tables, no
    forked policies, no second access-review engine.
15. Organization administration surfaces are
    **read-and-link-out aggregators** over the Phase 4A
    canonical pages, except for org-membership mutations which
    were already canonical at the org endpoints.
16. Personal users are **never** blocked by Phase 8 surfaces —
    every admin route is `sidebarEligible=false`,
    `requiredActiveSpace="NONE"`, no `workflowTags`, and
    `advancedByDefault=true`.

These rules are pinned by the four Phase 8 source-contract
suites and by the carry-over Phase 7 anti-confusion suite at
`services/api/test/phase-7-team-vs-workspace-anti-confusion.test.ts`.

---

## Organization model decision

Phase 8 **reused** the existing Phase 4A Organization graph in
full. The shipped surface set is backed by the already-canonical
`Organization`, `OrganizationMembership`, `Department`,
`DepartmentMembership`, `WorkspaceGovernancePolicy`,
`EvidenceRetentionPolicy`, `EvidenceLegalHold`, `AccessReview`,
`AccessReviewCampaign`, `DelegatedAdminGrant`,
`CrossOrgReviewGrant`, `SecurityEvent`, and `TrustCenterArticle`
Prisma models — no new model was introduced, no field was
added, no relation was rewired, and **no migration was generated**.
The Organization & Governance Layer is a **read-and-link-out
consolidation** over surfaces that already existed; the only
mutation path the shell owns directly is org membership +
invites, which had been canonical at `/v1/orgs/:id/members` and
`/v1/orgs/:id/invites` since Phase 4A.

---

## New surfaces shipped

The 10 route IDs are pinned in
`apps/web/lib/navigation/routeRegistry.ts`, mapped to the ADMIN
pillar in `apps/web/lib/navigation/pillarRegistry.ts`, and slotted
into the GOVERNANCE secondary operational group in
`apps/web/lib/navigation/phaseBOperationalGroups.ts`. Every entry
uses `domain="ACCOUNT"`, `requiredCapabilities=[]`,
`requiredActiveSpace="NONE"`, `fallbackBehavior="LOAD"`,
`workflowTags=[]`, `advancedByDefault=true`,
`commandPaletteVisible=true`, `allToolsVisible=true`,
`sidebarEligible=false`. This combination keeps Organization
optional while making the shell discoverable via cmd-K + All
Tools.

| #  | Surface                                                         | File (under `apps/web/app/(app)/organizations/[id]/admin/`) | Route ID                                          |
|---:|------------------------------------------------------------------|-------------------------------------------------------------|---------------------------------------------------|
|  1 | `/organizations/:id/admin` shell (layout + tab bar)             | `layout.tsx`                                                | `account.organization_admin`                      |
|  2 | `/organizations/:id/admin` index redirect → `/overview`         | `page.tsx`                                                  | (uses shell route id)                             |
|  3 | `/organizations/:id/admin/overview`                             | `overview/page.tsx`                                         | `account.organization_admin_overview`             |
|  4 | `/organizations/:id/admin/members`                              | `members/page.tsx`                                          | `account.organization_admin_members`              |
|  5 | `/organizations/:id/admin/departments`                          | `departments/page.tsx`                                      | `account.organization_admin_departments`          |
|  6 | `/organizations/:id/admin/governance`                           | `governance/page.tsx`                                       | `account.organization_admin_governance`           |
|  7 | `/organizations/:id/admin/access-reviews`                       | `access-reviews/page.tsx`                                   | `account.organization_admin_access_reviews`       |
|  8 | `/organizations/:id/admin/retention`                            | `retention/page.tsx`                                        | `account.organization_admin_retention`            |
|  9 | `/organizations/:id/admin/audit`                                | `audit/page.tsx`                                            | `account.organization_admin_audit`                |
| 10 | `/organizations/:id/admin/security`                             | `security/page.tsx`                                         | `account.organization_admin_security`             |
| 11 | `/organizations/:id/admin/trust`                                | `trust/page.tsx`                                            | `account.organization_admin_trust`                |

That is the 11 admin shell pages (layout + index + 9 tab leaves)
plus the 10 route registry entries that pin them.

---

## Reuse map — every admin tab deep-links to a Phase 4A canonical page

The Organization & Governance Layer is **deliberately** a
read-and-link-out aggregator. Every mutation continues to live
on the Phase 4A canonical page it has lived on since Phase 4A
shipped. The only mutations the shell owns are org members +
invites.

| Admin tab                                            | Phase 4A canonical destination                                                                     | Mutation owner            |
|------------------------------------------------------|----------------------------------------------------------------------------------------------------|---------------------------|
| Overview (`/admin/overview`)                         | Deep-links to Governance / Audit / Trust / Lifecycle cards                                         | Read-only                 |
| Members (`/admin/members`)                           | `/v1/orgs/:id/members`, `/v1/orgs/:id/invites`                                                     | **The shell** (canonical) |
| Departments (`/admin/departments`)                   | `/governance-platform`                                                                             | `/governance-platform`    |
| Governance (`/admin/governance`)                     | `/governance-platform`                                                                             | `/governance-platform`    |
| Access Reviews (`/admin/access-reviews`)             | `/governance-platform`                                                                             | `/governance-platform`    |
| Retention (`/admin/retention`)                       | `/evidence-lifecycle`                                                                              | `/evidence-lifecycle`     |
| Audit (`/admin/audit`)                               | `/audit-transparency`                                                                              | `/audit-transparency`     |
| Security (`/admin/security`)                         | `/admin/identity`, `/admin/identity/scim`, `/admin/identity/sessions`, `/settings/security`        | `/admin/identity/*`       |
| Trust (`/admin/trust`)                               | `/trust-center`                                                                                    | `/trust-center`           |

---

## Pinning tests

Four new Phase 8 source-contract suites pin the work, and the
carry-over Phase 7 anti-confusion suite continues to apply.

| Suite                                                                       | Pins                                                                                                                                                                                              |
|-----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `services/api/test/phase-8-org-admin-tab-surface.test.ts`                   | 10 route IDs + shape; PageRouteGate wrapping on every leaf; ADMIN pillar mapping; ADMIN_TABS shape; canonical Phase 4A deep-links.                                                                |
| `services/api/test/phase-8-org-admin-personal-user-isolation.test.ts`       | Every admin route is `sidebarEligible=false`, no `workflowTags`, `advancedByDefault=true`; layout reads `/v1/orgs/${orgId}`; no hard-coded sidebar entries; Collaboration Teams remain `PERSONAL_OR_ORG`. |
| `services/api/test/phase-8-org-admin-cross-org-isolation.test.ts`           | Every admin page derives `orgId` from `useParams`; every `/v1/orgs/` fetch is parameterised; `organizations.routes.ts` UUID-validates `:id` and uses `checkOrgAccess`; no literal UUIDs in admin pages. |
| `services/api/test/phase-8-vocabulary-and-shell-honesty.test.ts`            | No fake workspace types in any shell file; "Organization" is the canonical operator label; Security tab uses honest "Not configured" rows; no `window.confirm`; no `envelope.workspace.*` reads.   |
| `services/api/test/phase-7-team-vs-workspace-anti-confusion.test.ts` (carry-over) | Forbids `Team Workspace` / `Reviewer Workspace` / `Governance Workspace` / `Operations Workspace` as quoted UI strings; pins the bounded workspace-kind enum to `PERSONAL` + `ORGANIZATION` only. |

---

## Validation matrix

| Command                                                                  | Result                                                                                                                  |
|--------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `cd D:/digital-witness/services/api && npx tsc --noEmit`                | Exit code 0. No TypeScript errors emitted (empty stdout/stderr).                                                        |
| `cd D:/digital-witness/apps/web && npx tsc --noEmit`                    | Exit code 0. No TypeScript errors emitted (empty stdout/stderr).                                                        |
| `cd D:/digital-witness/services/api && npx vitest run`                  | Exit code 0. Test Files: 275 passed \| 1 skipped (276). Tests: 12,888 passed \| 52 skipped (12,940). Duration ~11.85s.   |
| `cd D:/digital-witness/services/worker && npx vitest run`               | Exit code 0. Test Files: 23 passed (23). Tests: 559 passed (559). Duration ~1.82s.                                       |
| `cd D:/digital-witness && pnpm --filter @proovra/shared test`           | Exit code 0. node --test runner reports tests 703, pass 703, fail 0, skipped 0, duration_ms 561.14.                      |

All five validations pass with zero blocking failures.

---

## Recommendations for Phase 9

The following surfaces are recognised gaps that Phase 8
deliberately did **not** ship — because closing them would
require either extending the Phase 4A domain model or weakening
at least one constitutional rule above. They are pinned here as
the canonical Phase 9 backlog.

1. **Full org-scoped policy mutation surface.** The Governance,
   Departments, and Access-Reviews tabs currently deep-link to
   the workspace-scoped `/governance-platform`. A future
   org-scoped policy writer requires extending the domain
   model (org-as-policy-scope) before the shell can host the
   mutations directly.
2. **Org-level access-review coordination.** Access-review
   campaigns are workspace-scoped today. Cross-workspace
   fan-out from a single org-wide campaign — i.e., one
   `AccessReviewCampaign` orchestrating reviews across every
   workspace owned by the organization — is deferred.
3. **Org billing administration UX.** Phase 8 explicitly does
   not touch billing or Stripe. Billing continues to live on
   the canonical `TeamWorkspaceCard` workspace surface; a
   future org-level billing page should fold both into one
   coherent view.
4. **Full SSO / SCIM administration UX.** The Security tab is
   honest about what it does not know — every row defaults to
   "Not configured" with a deep-link to `/admin/identity`,
   `/admin/identity/scim`, `/admin/identity/sessions`, and
   `/settings/security`. A future `/v1/orgs/:id/security/readiness`
   endpoint will replace the honest empty state with real
   signal, and the Security tab can then host real mutations.
5. **Finer-grained per-tab capability checks.** Every admin
   route currently shares the `account.organization-detail`
   capability gate (via the broader `account` domain + the
   `checkOrgAccess` route handler). A future iteration should
   split this into per-tab capability strings (e.g.,
   `org.admin.audit:read`, `org.admin.members:write`,
   `org.admin.retention:read`) so that delegated admins can be
   granted tab-by-tab access without inheriting the whole
   surface.
6. **Per-tab route IDs with explicit capability gates** instead
   of relying on the shared `account.organization-detail` gate.
   Once item 5 lands, every leaf route should declare its own
   `requiredCapabilities` array and the layout-level gate
   should be removed in favour of per-leaf enforcement.

---

## Vocabulary contracts

The Phase 8 closure preserves the four vocabulary contracts
established at Phase 7 closure. Each is pinned by
`services/api/test/phase-7-team-vs-workspace-anti-confusion.test.ts`,
which remains green after Phase 8.

| Contract                  | Meaning                                                                                                                                                                |
|---------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Organization ≠ Workspace  | An **Organization** is the optional enterprise umbrella (legal entity, SSO, SCIM, departments, retention, audit). A **Workspace** is the operational tenancy boundary (evidence, cases, reports, capture). |
| Department ≠ Workspace    | A **Department** is a sub-unit *inside* an Organization (governance scoping, delegated admin scoping). It is **not** a tenancy boundary; evidence is not departmental.   |
| Governance ≠ Workspace    | **Governance** is a feature area (policies, retention, legal hold, access reviews) accessible from both Personal and Organization workspaces. It is **not** a third workspace kind. |
| Team ≠ Workspace          | A **Team** is a collaboration sub-unit (members, invites, assignments, comments, mentions, guests) that must work in **both** workspace kinds. The `Team` Prisma model is legacy DB debt; the product noun is Workspace. |

All four contracts are enforced by quoted-string forbiddance in
`phase-7-team-vs-workspace-anti-confusion.test.ts` and by the
bounded workspace-kind enum assertion in the same suite.

---

## Sign-off

Phase 8 is **closed** under the constitutional rules above. The
Organization & Governance Layer ships as a read-and-link-out
aggregator over the Phase 4A canonical pages — no new Prisma
model, no new migration, no new capability, no new workspace
kind, and no parallel Organization system was introduced.
Mutations stay on the Phase 4A canonical pages they already
lived on, except for organization membership and invitations
which were already canonical at `/v1/orgs/:id/members` and
`/v1/orgs/:id/invites`. Four source-contract suites pin the
work; the Phase 7 anti-confusion suite remains green; and the
full validation matrix (TypeScript on `services/api` and
`apps/web`, vitest on `services/api` and `services/worker`,
node test on `@proovra/shared`) passes with zero failures.
