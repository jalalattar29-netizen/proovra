# PROOVRA — Phase 7 Closure Audit (Phases 1–7)

_Status: **CLOSED** — all source-contract + behavioral tests pass._

This document is the operator-facing audit record for the
Enterprise Architecture Recovery program (Phases 1–7). It records,
per phase: scope, constitutional alignment, the surfaces shipped,
the canonical contract tests that pin the work, and the residual
debt (if any).

## Constitutional rules (Phase 7 closure constitution)

1. Workspace kinds are **only** `PERSONAL` and `ORGANIZATION`.
2. Team is **NOT** a workspace.
3. Team is **NOT** a tenant.
4. Team is **NOT** enterprise-only.
5. Team is a **core collaboration feature**.
6. Team must work in **BOTH** Personal Workspace and Organization
   Workspace.
7. Organization is **optional**.
8. Reviewer is a **role / capability**, not a workspace.
9. Governance is a **feature area**, not a workspace.
10. Operations is **platform-admin only**.
11. **No fake workspace types** — no `Team Workspace`,
    `Reviewer Workspace`, `Governance Workspace`,
    `Operations Workspace`, etc.

These rules are pinned by
`services/api/test/phase-7-team-vs-workspace-anti-confusion.test.ts`.

---

## Phase-by-phase audit

| Phase | Scope                                              | Canonical surfaces                                                                 | Pinning tests                                                                                                          | Residual debt |
|------:|----------------------------------------------------|------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|---------------|
| **1A**| 8-pillar IA reset                                  | `pillarRegistry.ts` (HOME, CAPTURE, CASES, REVIEW, GOVERNANCE, OPERATIONS, ADMIN, TRUST) | `phase-1a-pillar-ia.test.ts`, `phase-b-ia-reset.test.ts`                                                              | None — pillar map covers every registered route id; legacy `/ops/*` and `/dashboard/{batch-analysis,quotas}` 308-redirect to `/operations/*`. |
| **1B**| Trust + capture + custody runtime                  | Trust hub, capture SDK, mobile capture, device attestation, citizen capture, signed provenance | `phase-1b-trust-runtime.test.ts`, `phase-r10-personal-first-regression.test.ts`                                       | None.         |
| **2A**| Reviewer Workspace product (coding, hotkeys, QC)   | `/review` reviewer console, coding schemas, disagreements, QC, metrics             | `phase-2a-reviewer-workspace.test.ts`                                                                                  | None.         |
| **2B**| External Reviewer Portal (SSO + invitations)       | `/portal`, invitation lifecycle, SSO federation, bulk operations                   | `phase-2b-external-reviewer-portal.test.ts`                                                                            | None.         |
| **3A**| Enterprise redaction platform (policy + video)     | `/redaction`, policy engine, provider clients (Rekognition / Azure DI / Deepgram)  | `phase-3a-redaction-platform.test.ts`, `phase-3a-closure-detection-intelligence.test.ts`                              | None.         |
| **3B**| Intelligence platform (executive + audit + cost)   | `/executive`, `/intelligence-platform`, `/audit-transparency`, `/budget-center`    | `phase-3b-intelligence-platform.test.ts`                                                                               | None.         |
| **4A**| Trust Center + enterprise governance               | `/trust-center`, `/governance-platform`, departments, delegated admin, access reviews, cross-org | `phase-4a-trust-and-governance.test.ts`                                                                                | None.         |
| **4B**| Product packaging + lifecycle                      | `/packaging`, `/evidence-lifecycle`, `/exchange`, legal hold, retention, destruction | `phase-4b-packaging-and-lifecycle.test.ts`                                                                             | None.         |
| **5** | Collaboration Teams foundation                     | `/collaboration-teams` index, member / invitation / assignment / activity, plan limits | `phase-r15-collaboration-teams.test.ts`                                                                                | None.         |
| **6** | Collaboration Teams workspace UI                   | `/collaboration-teams/[teamId]` overview + tabs (Members, Invites, Assignments, Activity, Settings), `/collaboration-teams/invites/[token]/accept` | `phase-r16-collaboration-completion.test.ts`                                                                           | None.         |
| **7** | Collaboration Teams completion                     | `/collaboration-teams/[teamId]/collaboration` (comments, mentions, guests, access reviews), notification preferences | `phase-r16-collaboration-completion.test.ts`, `phase-7-team-vs-workspace-anti-confusion.test.ts`                       | None.         |

---

## Vocabulary contracts (Team / Workspace)

The PROOVRA target operating model has **two** workspace kinds:

- **Personal Workspace** — every authenticated user has one. Backed
  by `Team` row with `isPersonal = true` (legacy DB debt; the
  product surface is the Workspace concept).
- **Organization Workspace** — optional, multi-user. Backed by
  `Team` row associated with an Organization.

The constitutional rule "Team is NOT a workspace" applies to the
**product noun**: when an operator sees the word **Team** in the
product UI, it refers to a **collaboration sub-unit** (members,
invitations, assignments, activity, comments, mentions, guest
collaboration). When they see **Workspace**, it refers to the
operational tenancy boundary (evidence ownership, case ownership,
reports, capture pipeline).

### `/teams` vs `/collaboration-teams` resolution

| URL                          | Purpose                                                                                       | Status                                |
|------------------------------|-----------------------------------------------------------------------------------------------|---------------------------------------|
| `/teams`                     | Legacy workspace-list URL                                                                     | 308-redirect to `/workspaces`         |
| `/workspaces`                | Canonical operator surface for selecting / creating / managing workspaces                     | Canonical (registry id `admin.teams`) |
| `/teams/[id]`                | Per-workspace admin page (pre-G5 carryover; backend `Team.id` is the workspace identifier)    | Canonical for workspace admin         |
| `/collaboration-teams`       | Phase 5 — Collaboration Teams index (the constitutional Team product)                         | Canonical (`workspace.collaboration_teams`) |
| `/collaboration-teams/[teamId]` | Phase 6 — Per-Collaboration-Team detail (Members / Invites / Assignments / Activity / Settings) | Canonical (`workspace.collaboration_team_detail`) |
| `/collaboration-teams/[teamId]/collaboration` | Phase 7 — Collaboration hub (comments, mentions, guests, access reviews)         | Canonical (`workspace.collaboration_team_hub`) |
| `/collaboration-teams/invites/[token]/accept` | Phase 6 — Invitation accept landing                                              | Canonical (`workspace.collaboration_team_invite_accept`) |

**Audit conclusion:** the two URL families are **deliberately distinct**:

- `/teams` (and `/workspaces`) → **workspace tenancy**.
- `/collaboration-teams/*` → **Collaboration Teams product**.

The `Team` Prisma model backs both concepts as legacy debt; the
**runtime distinction** is enforced at the URL + route-id + page
level. Renaming the DB table is a non-trivial follow-up tracked in
`docs/architecture/legacy-debt-register.md`.

---

## Migration safety (Phases 5 & 7)

The Phase 5 + Phase 7 migrations
(`20270201000000_phase_5_collaboration_teams` +
`20270301000000_phase_7_collaboration_completion`) follow the
Phase O additive-only pattern:

- `CREATE TABLE IF NOT EXISTS ... ( ... );` (note the **terminating
  semicolon** inside the EXECUTE block — required by the
  `INDEX_COLUMN_RISK` regex in the safety gate).
- Per-column existence guards (`information_schema.columns`) before
  every `CREATE INDEX` / `ALTER TABLE`.
- Idempotent re-application — running the migration twice is a
  no-op.

The safety gate (`services/api/scripts/full-migration-audit.mjs`)
reports zero `INDEX_COLUMN_RISK` findings for these two migrations.

---

## Frontend hardening (R9 / R10 / G4 / G5)

| Concern                                          | Resolution                                                                                                                     |
|--------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| Personal users blocked by `activeSpace = null`   | `routeAccessResolver` accepts `workspace` + `personalSpace` fragments; PageRouteGate / Sidebar / CommandPalette / Tools pass them. |
| Direct `envelope.workspace.*` reads everywhere   | `lib/platform-context/useTeamWorkspaceGate.ts` exposes `useWorkspaceFragment()` + `usePersonalSpaceFragment()` as canonical centralised readers. |
| Raw `window.confirm()` in collaboration UI       | `useConfirmAction` hook with `ConfirmActionModal` replaces all raw confirms in Team detail + collaboration hub (delete, revoke, archive). |
| Worker observability missing `OTEL_SERVICE_NAME` | `docker-compose.yml` declares `OTEL_SERVICE_NAME=proovra-worker` under the worker service; pinned by `phase-p2-0b-observability-wiring.test.ts`. |
| Vocabulary regressions                           | `phase-7-team-vs-workspace-anti-confusion.test.ts` forbids `Team Workspace` / `Reviewer Workspace` / `Governance Workspace` / `Operations Workspace` as quoted UI strings and asserts the bounded workspace-kind enum. |

---

## Final validation matrix

| Validation                 | Result                                                                                                                                         |
|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `services/api` vitest      | 270 files, 12,489 tests, 0 failures, 52 skipped                                                                                                |
| `services/worker` vitest   | 23 files, 559 tests, 0 failures                                                                                                                |
| `packages/shared` node test| 703 tests, 0 failures                                                                                                                          |
| `services/api` typecheck   | Clean                                                                                                                                          |
| `services/worker` typecheck| Clean                                                                                                                                          |
| `apps/web` typecheck       | Clean                                                                                                                                          |
| `apps/mobile` typecheck    | Pre-existing missing-module errors (`expo-crypto`, `@noble/ed25519`, `@noble/hashes`). Not introduced by Phase 7; tracked separately.          |
| Migration safety gate      | 0 `INDEX_COLUMN_RISK` findings on Phase 5 + Phase 7 migrations                                                                                 |

---

## Sign-off

Phase 7 is **closed** under the constitutional rules above. No new
features, no new architecture, no new workspace types were
introduced during closure. The remaining mobile-typecheck noise is
pre-existing dependency-resolution debt unrelated to Phases 1–7
and tracked separately.

---

## Phase 8 closure — Organization administration consolidation

> **Status:** SHIPPED ▸ pinned by four Phase 8 source-contract suites.
> **Detail:** see `docs/architecture/phase-8-org-admin-consolidation.md`.
> **Constitutional rules touched:** none weakened; all 11 rules above
> remain pinned.

Phase 8 introduces **one** new operator surface — a unified
organization-administration shell at `/organizations/[orgId]/admin`
— as a **read-and-link-out aggregator** over the Phase 4A canonical
pages. There are **no schema changes**, **no new policies**, **no
new capabilities**, and **no new workspace kinds**. All mutations
stay on the Phase 4A canonical pages they already lived on; the
shell only **owns** organization-membership mutations
(`/v1/orgs/:id/members`, `/v1/orgs/:id/invites`) via the Members
tab.

### What shipped

| Surface                                           | Owner                                                                                                   |
|---------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `/organizations/:id/admin` (shell + tab bar)      | Layout + index redirect. Reads `GET /v1/orgs/:id` only.                                                  |
| `/organizations/:id/admin/overview`               | Read-only summary. Reads org / members / audit. Deep-links to Governance / Audit / Trust / Lifecycle.    |
| `/organizations/:id/admin/members`                | **Owns** org members + invites. Uses `useConfirmAction` (no raw `window.confirm`). API enforces ORG_ADMIN+. |
| `/organizations/:id/admin/departments`            | Deep-link card → `/governance-platform`.                                                                 |
| `/organizations/:id/admin/governance`             | Deep-link card → `/governance-platform`.                                                                 |
| `/organizations/:id/admin/access-reviews`         | Deep-link card → `/governance-platform`.                                                                 |
| `/organizations/:id/admin/retention`              | Read-only summary → `/evidence-lifecycle`.                                                               |
| `/organizations/:id/admin/audit`                  | Read-only timeline → `/audit-transparency`.                                                              |
| `/organizations/:id/admin/security`               | Honest "Not configured" rows → `/admin/identity`, `/admin/identity/scim`, `/admin/identity/sessions`, `/settings/security`. |
| `/organizations/:id/admin/trust`                  | Deep-link card → `/trust-center`.                                                                        |

### Route IDs registered

The 10 new route IDs are pinned in
`apps/web/lib/navigation/routeRegistry.ts`, mapped to the ADMIN
pillar in `apps/web/lib/navigation/pillarRegistry.ts`, and slotted
into the GOVERNANCE secondary operational group in
`apps/web/lib/navigation/phaseBOperationalGroups.ts`. Every entry
uses `domain="ACCOUNT"`, `requiredCapabilities=[]`,
`requiredActiveSpace="NONE"`, `fallbackBehavior="LOAD"`,
`workflowTags=[]`, `advancedByDefault=true`,
`commandPaletteVisible=true`, `allToolsVisible=true`,
`sidebarEligible=false`. This combination keeps Organization
optional (no sidebar / persona promotion) while making the shell
discoverable via cmd-K + All Tools.

| #  | Route ID                                          | Path                                                 |
|---:|---------------------------------------------------|------------------------------------------------------|
|  1 | `account.organization_admin`                      | `/organizations/:id/admin`                           |
|  2 | `account.organization_admin_overview`             | `/organizations/:id/admin/overview`                  |
|  3 | `account.organization_admin_members`              | `/organizations/:id/admin/members`                   |
|  4 | `account.organization_admin_departments`          | `/organizations/:id/admin/departments`               |
|  5 | `account.organization_admin_governance`           | `/organizations/:id/admin/governance`                |
|  6 | `account.organization_admin_access_reviews`       | `/organizations/:id/admin/access-reviews`            |
|  7 | `account.organization_admin_retention`            | `/organizations/:id/admin/retention`                 |
|  8 | `account.organization_admin_audit`                | `/organizations/:id/admin/audit`                     |
|  9 | `account.organization_admin_security`             | `/organizations/:id/admin/security`                  |
| 10 | `account.organization_admin_trust`                | `/organizations/:id/admin/trust`                     |

### Tests added

| Suite                                                              | Pins                                                                                                                                                |
|--------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `services/api/test/phase-8-org-admin-tab-surface.test.ts`          | 10 route IDs + shape; PageRouteGate wrapping on every leaf; ADMIN pillar mapping; ADMIN_TABS shape; canonical Phase 4A deep-links.                  |
| `services/api/test/phase-8-org-admin-personal-user-isolation.test.ts` | Every admin route is `sidebarEligible=false`, no `workflowTags`, `advancedByDefault=true`; layout reads `/v1/orgs/${orgId}`; no hard-coded sidebar entries; Collaboration Teams remain `PERSONAL_OR_ORG`. |
| `services/api/test/phase-8-org-admin-cross-org-isolation.test.ts`  | Every admin page derives `orgId` from `useParams`; every `/v1/orgs/` fetch is parameterised; `organizations.routes.ts` UUID-validates `:id` and uses `checkOrgAccess`; no literal UUIDs in admin pages. |
| `services/api/test/phase-8-vocabulary-and-shell-honesty.test.ts`   | No fake workspace types in any shell file; "Organization" is the canonical operator label; Security tab uses honest "Not configured" rows; no `window.confirm`; no `envelope.workspace.*` reads.       |

All four suites pass locally (380 tests). The Phase 7
anti-confusion suite (`phase-7-team-vs-workspace-anti-confusion.test.ts`)
remains green (8 / 8).

### Constitutional check (Phase 8)

| Rule (Phase 7 closure constitution)                  | Phase 8 status                                                                                                                        |
|-------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| Workspace kinds are only `PERSONAL` and `ORGANIZATION`. | **Preserved.** No new workspace kind. The shell is page-scoped only.                                                                  |
| Team is **NOT** a workspace.                          | **Preserved.** Phase 8 does not rename Team and does not surface a Team tab. The Members tab handles org membership, not Team membership. |
| Team is a core collaboration feature, both kinds.     | **Preserved.** Collaboration Teams (`/collaboration-teams/*`) are untouched.                                                          |
| Organization is **optional**.                         | **Preserved.** Every admin route is `sidebarEligible=false` + `requiredActiveSpace="NONE"` + no `workflowTags` + `advancedByDefault=true`. |
| Reviewer is a role, not a workspace.                  | **Preserved.** No Reviewer tab.                                                                                                       |
| Governance is a feature area, not a workspace.        | **Preserved.** Governance / Departments / Access-Reviews are **deep-link cards** to `/governance-platform`, not mutation surfaces.    |
| Operations is platform-admin only.                    | **Preserved.** No new OPERATIONS surface.                                                                                              |
| No fake workspace types.                              | **Preserved.** Pinned by `phase-8-vocabulary-and-shell-honesty.test.ts` across all 11 shell files.                                    |

### Items deferred to Phase 9

The following surfaces are recognised gaps that Phase 8
deliberately did **not** ship — because closing them would
require weakening at least one constitutional rule above. They
are pinned here as the canonical deferred list for Phase 9.

1. **Full org-scoped policy mutation surface.** The Governance,
   Departments, and Access-Reviews tabs deep-link to
   `/governance-platform` (workspace-scoped). A future
   org-scoped policy writer requires extending the domain model
   first.
2. **Org-level access-review coordination.** Today, access-review
   campaigns are workspace-scoped. Cross-workspace fan-out from
   a single org-wide campaign is deferred.
3. **Org billing administration.** Phase 8 explicitly does not
   touch billing or Stripe. Billing remains on the canonical
   `TeamWorkspaceCard` surface.
4. **Full SSO / SCIM administration UX.** The Security tab is
   honest about what it does not know — every row defaults to
   "Not configured" with a deep-link to `/admin/identity`. A
   future `/v1/orgs/:id/security/readiness` endpoint will replace
   the honest empty state with real signal.

### Sign-off (Phase 8)

Phase 8 is **closed** under the same constitutional rules that
closed Phase 7. The org-admin shell ships as a read-and-link-out
aggregator. No schema changes, no new capabilities, no new
workspace kinds, no new policies. Mutations stay on the Phase 4A
canonical pages they already lived on, except for org-membership
mutations which were already canonical at `/v1/orgs/:id/members`
+ `/v1/orgs/:id/invites`. Four source-contract suites pin the
work; the Phase 7 anti-confusion suite remains green.
