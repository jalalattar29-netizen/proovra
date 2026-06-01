# PROOVRA Phase 9 — Team vs Workspace Consolidation

> **Status:** DECIDED (Phase 9 audit synthesis).
> **Author:** Architecture.
> **Date:** 2026-06-01.
> **Predecessors:** Phase 7 closure constitution, Phase 8
> organization-admin consolidation.

Phase 9 was an **audit phase**. Its job was to inventory the
historical conflation of "Team" (the collaboration product) with
"Team" (the legacy Prisma model that backs workspace-admin
tenancy) and to record, in writing, the surface boundaries that
must hold going forward. No new domain nouns, no workspace
kinds, and no Prisma migrations are introduced by Phase 9. The
permitted Phase 9 fixes were limited to nav hiding,
legacy-route redirects, label clarifications, missing route
registry metadata, regression tests, and this document.

---

## 1. Constitutional alignment

The Phase 9 rules — restated here verbatim — are binding and
must remain binding for all future phases:

| Phase 9 rule                                                                       | Phase 9 honouring decision                                                                                                                                                  |
|------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Team is NOT Workspace.**                                                          | Workspace kinds remain only `PERSONAL` and `ORGANIZATION`. No `TeamWorkspace` exists in Prisma, in the platform-context resolver, or in the navigation registry.            |
| **Workspace kinds remain ONLY `PERSONAL` and `ORGANIZATION`.**                      | The platform-context `WorkspaceKind` union is closed. No Phase 9 fix may extend it.                                                                                          |
| **Team is a collaboration feature available in BOTH `PERSONAL` and `ORGANIZATION` workspaces.** | `/collaboration-teams/*` routes register as `requiredActiveSpace="PERSONAL_OR_ORG"` and are pinned by the Phase 5/6 collaboration-team tests.                          |
| **Organization is OPTIONAL.**                                                       | Personal-only users see `/collaboration-teams` in sidebar without ever provisioning an Organization.                                                                          |
| **Team must not become enterprise-only.**                                           | Billing/plan limits may cap collaboration-team capacity (member count, storage) but must not gate the **existence** of `/collaboration-teams` behind a plan tier.            |
| **Team permissions are separate from Workspace permissions.**                       | `CollaborationTeamMembership.role` and `Workspace`-level membership grants are distinct tables and distinct authorization scopes.                                            |
| **Team roles are separate from Organization roles.**                                | A user can be `ORG_OWNER` of the parent Organization while being a `VIEWER` of an individual Collaboration Team, and vice versa.                                              |
| **Billing/plan limits may control Team capacity but must NOT redefine Team as Workspace.** | Stripe/PayPal plan metadata may set numeric ceilings; it must not flip any `Collaboration*` row into a `Workspace` row.                                                  |
| **Do NOT rename Team to Workspace or Workspace to Team.**                           | The legacy Prisma `Team` model remains the workspace-tenancy backing table. It is not renamed. The product-facing "Team" remains the `CollaborationTeam*` family.            |
| **Do NOT create new workspace types.**                                              | No `OrgAdminWorkspace`, no `CollaborationWorkspace`, no `ReviewerWorkspace`. Pinned by the Phase 8 vocabulary test.                                                          |
| **Do NOT touch billing/Stripe/PayPal provider credentials.**                        | Phase 9 fixes are forbidden from editing billing service code or credential storage.                                                                                          |
| **Do NOT log secrets.**                                                             | Phase 9 documentation and regression tests must not emit Stripe keys, PayPal client secrets, JWTs, or session cookies into logs or test snapshots.                            |

---

## 2. The two "Team" surfaces

Phase 9 inventory confirmed that two distinct concepts share the
word "Team" in the codebase. They must remain distinct.

### 2.1 Team-the-product (Collaboration Teams)

* **Product home:** `/collaboration-teams` and
  `/collaboration-teams/[teamId]/*`.
* **Prisma backing:** the `CollaborationTeam*` family of models
  (`CollaborationTeam`, `CollaborationTeamMembership`,
  `CollaborationTeamInvite`, and related projection tables).
* **Scope:** a user-facing collaboration unit. Available in
  **both** `PERSONAL` and `ORGANIZATION` workspaces.
* **Permissions:** governed by
  `CollaborationTeamMembership.role` and the collaboration-team
  capability resolver. Independent of workspace-admin roles.
* **Plan gating:** plan limits may cap the **number** of
  collaboration teams or **members per team**. Plan limits must
  not remove the feature for any tier; a Free-tier personal user
  is still allowed at least one Collaboration Team.

### 2.2 Workspace-admin tenancy (legacy `Team` Prisma model)

* **Product home:** `/workspaces` (workspace-admin shell).
* **Prisma backing:** the legacy `Team` model in
  `services/api/prisma/schema.prisma`. This is **not** renamed
  by Phase 9. Renaming it would break migrations, audit history,
  and the Phase 8 organization-admin shell. The user-facing
  label everywhere is "Workspace".
* **Scope:** tenancy and billing surface. A `Team` row in this
  legacy sense is the tenancy boundary that owns `Workspace*`
  data and is the subject of `/v1/workspaces/*` API calls.
* **Permissions:** governed by workspace-admin membership roles
  (owner / admin / member / viewer per the workspace-admin
  service). Independent of collaboration-team roles.

The two are **never** joined into a single table, a single
permission model, or a single sidebar entry. The Phase 9 audit
explicitly forbids any future PR that proposes to merge them.

---

## 3. Route surface decisions

Phase 9 inventory pinned the following routing decisions. These
are the only legacy-route redirects permitted under the Phase 9
"allowed fixes" set.

### 3.1 `/teams` is a permanent 308 to `/workspaces`

* `/teams` was a historical alias for the workspace-admin shell
  while the legacy `Team` Prisma model was still surfaced under
  that label.
* Phase 9 establishes `/workspaces` as the **only** canonical
  workspace-admin path.
* `/teams` is preserved as a **permanent (308) redirect** to
  `/workspaces` in `apps/web/next.config.js`. The redirect is
  permanent so that:
  * external bookmarks, audit-log links, and Stripe webhook
    notification URLs continue to resolve;
  * search engines collapse the legacy URL into the canonical
    URL;
  * the redirect is safe to keep indefinitely — there is no
    Phase 9-permitted action to remove it.

### 3.2 `/collaboration-teams` is the canonical Team-the-product path

* `/collaboration-teams` is registered in the route registry
  with `requiredActiveSpace="PERSONAL_OR_ORG"`,
  `sidebarEligible=true`, and `commandPaletteVisible=true`.
* No redirect points **at** `/collaboration-teams` from
  `/teams`. Conflating the two would re-introduce the exact
  ambiguity Phase 9 was created to eliminate.

### 3.3 `/v1/organizations*` is deprecated and pending removal

* The legacy `/v1/organizations` API surface predates the
  Phase 8 `/v1/orgs/:id` consolidation.
* Phase 9 marks `/v1/organizations*` as **deprecated**. New
  consumers must use `/v1/orgs/:id` (per the Phase 8 admin
  shell).
* Removal of `/v1/organizations*` is **not** a Phase 9 action.
  It is deferred to a future phase that owns API-surface
  retirement. Until that phase ships, `/v1/organizations*` must
  continue to respond, and Phase 9 fixes must not delete its
  handlers.

---

## 4. What Phase 9 does NOT change

* No Prisma migration is generated.
* No backend route handler is edited.
* No billing logic, Stripe key, or PayPal credential is
  touched.
* No page is deleted.
* No workspace kind, persona kind, or pillar is added.
* No existing test file is modified (regression tests added in
  Phase 9 live in new files).
* No file in `services/api/scripts/audit-output/*.json` is
  hand-edited — those are generator outputs.

---

## 5. Cross-references

* Phase 4 navigation/persona readiness:
  `docs/architecture/phase-4-navigation-persona-readiness.md`.
* Phase 5/6 collaboration-team contracts:
  `docs/architecture/phase-5-team-platform-final.md`,
  `docs/architecture/phase-6-team-frontend-final.md`.
* Phase 7 closure audit (constitutional rules):
  `docs/architecture/phase-7-closure-audit.md`.
* Phase 8 organization-admin consolidation:
  `docs/architecture/phase-8-org-admin-consolidation.md`.
* Canonical domain model:
  `docs/architecture/proovra-domain-model.md`.
* Architecture invariants (Team vs Workspace invariants are
  enumerated alongside the workspace-kind invariants):
  `docs/architecture/architecture-invariants.md`.
