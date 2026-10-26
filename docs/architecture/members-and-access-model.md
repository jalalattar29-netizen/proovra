# Members & Access model — decision record (members audit, 2026-10-26)

**Status:** accepted. Records the decisions the members & access remediation
(audit e76891bc3) applied, and the three naming/structural items the audit asked
to be documented rather than refactored. Companion to `team-vs-workspace.md`
and `domain-debt-register.md`.

## 1. The model

| Concept | Storage | Authority |
|---|---|---|
| Workspace | `teams` (Prisma `Team`; never renamed) | `resolveWorkspaceKind`, `resolveWorkspaceLifecyclePolicy` |
| Workspace membership | `team_members` (`TeamRole` OWNER > ADMIN > MEMBER > VIEWER) | `identity/rbac.service.ts`, `identity/membership-provisioning.service.ts` |
| Collaboration Team (UI: "Teams", one "Collaboration Team") | `collaboration_teams`, `collaboration_team_members` (LEAD > ADMIN > MEMBER > VIEWER, plus EXTERNAL) | `collaboration-team/collaboration-team.service.ts` |
| Delegated administration | role + `member_capability_grants` + `member_delegated_admin_scopes`, one permission engine | `middleware/authorize.ts`, `middleware/require-workspace-permission.ts`, `identity/rbac.service.ts` |
| Capacity | per ACTIVE Collaboration Team: PRO 2 × 5, TEAM 5 × 10 accepted non-owner members; Enterprise contract-defined | `collaboration-team/billing-guards.ts` (one lock per group) |
| Workspace-wide seat ceiling | only an ACTIVE Enterprise contract's `seat_count` | `billing/workspace-seats.service.ts` |
| Case reach | `case_access` + `case_collaboration_team_access`; restricted while `cases.restricted_at_utc` is set (a grant sets it; only a manager removing the last entry lifts it; a departure never does) | `cases/case-visibility.ts`, `cases/record-reach` |
| Lifecycle | `closedAtUtc`; one closure leg set `closeWorkspacesTx` | `workspace/workspace-closure.service.ts` |
| Audit | `admin_audit_logs` via `emitTenantAudit` / `emitPlatformAudit`, in the mutation's transaction | `audit/tenant-audit.service.ts` |
| Lifecycle notices | `notification_deliveries` as the outbox | `notifications/membership-lifecycle-notice.ts` |

History tables (`team_activities`, `organization_audit_events`,
`evidence_lifecycle_events`, `custody_events`, `admin_audit_logs`) are
append-only at the database (`proovra_refuse_history_rewrite`).

## 2. DOM-04 — "PERSONAL" and "SINGLE_OCCUPANT" on a multi-member workspace

A Personal Workspace on PRO or TEAM has members. Two identifiers predate that:

* **`WorkspaceKind = PERSONAL`** names *whose* workspace it is — the account's
  own, created with it, closed only with it, never transferable — not how many
  people are in it. It stays. The UI says "Personal Workspace".
* **`billingShape: "SINGLE_OCCUPANT" | "SHARED"`** names the *payer*, not the
  occupancy: SINGLE_OCCUPANT means the plan is the owner's personal entitlement
  (one payer), SHARED means the workspace row carries its own commercial
  columns (Enterprise provisioning). A PRO/TEAM Personal Workspace with members
  is correctly SINGLE_OCCUPANT: one person pays. The identifier is load-bearing
  in ~20 call sites (enforcement, eligibility, analytics scope) and is not
  renamed; every reader must treat it as "who pays", never as "who is here".
  Member and capacity questions are answered by the capacity authorities in §1,
  never by `billingShape`.

## 3. DOM-07 — Evidence and Case rows carry no foreign key to Team or User

Deliberate. Evidence and custody outlive every tenant-side lifecycle: a
workspace closes (rows stay), an account is anonymised (rows stay), a member is
removed (ownership is transferred with a custody record, LIFE-17). A foreign
key with CASCADE would erase evidence with its tenant; RESTRICT would make
closure impossible; SET NULL would destroy attribution. The tenant relation is
enforced by the canonical scope predicates (`workspaceEvidenceWhere`,
`workspaceCaseWhere`, record reach) and by the fact that no product path
deletes a Team or a User: no workspace kind has a self-service hard delete
(Phase A), users are anonymised in place, and `teams.owner_user_id` restricts
deletion (DOM-06).

## 4. DOM-08 — `collaboration_team_*.team_id` and text statuses

* The `team_id` column on `collaboration_team_members` /
  `collaboration_team_invites` / `collaboration_team_activity` references
  `collaboration_teams`, not `teams`. Renaming the column is not worth a
  migration window; the Prisma relation names (`CollaborationTeamMembers`
  etc.) and this record are the disambiguation. Code must never join it to
  `teams.id`.
* CT role and status columns stay `VARCHAR`, but the database now refuses any
  value outside the shared vocabulary (`@proovra/shared` collaboration-team.ts):
  `CHECK … NOT VALID` constraints on every role/status column of
  `collaboration_teams`, `_members`, `_invites` and `_assignments` (migration
  `20281026000600_collaboration_vocabulary_checks`). `NOT VALID` binds every new
  write; validating existing rows is a later operator step once the readiness
  count reads 0. Proof: `members-collaboration-vocabulary.integration.test.ts`.
* No composite (workspace, team) foreign key: `collaboration_team_*` rows carry
  `workspace_id` beside `team_id`, and every writer derives both from the loaded
  team row, never from the request.

## 5. Decisions taken (owner, 2026-10-25)

### 5.1 DOM-09 — one delegated-administration authority

Both models were writable and enforced (the earlier note here, "enforced
nowhere", was wrong): member delegated scopes inside the permission engine, and
tier grants behind `require-delegated-tier`. The permission engine is kept.

* Every former tier gate asks the engine for its domain's permission through
  `requireWorkspacePermission` (any-of only for destruction approval, which a
  retention manager OR a security-policy manager could approve).
* Two precise permissions were added so no tier spills into a neighbouring
  domain: `governance.exchange.manage` (exchange packages, chain transfers,
  cross-org review) and `governance.department.manage` (department
  memberships).
* Migration `20281026000500_delegated_admin_convergence` carries each live tier
  grant of an ACTIVE member as capability grants of exactly the permissions its
  tier admitted (a scope would have widened it); tier rows end `CONVERGED` /
  `RETIRED_NO_EFFECT` / `RETIRED_NO_MEMBER` and stay as history.
* The managed writer: grant `POST /v1/identity/members/:id/delegated-admin`,
  update `PATCH /v1/identity/delegated-admin/:id` (expiry/reason, step-up,
  audited previous/resulting), revoke `DELETE /v1/identity/delegated-admin/:id`,
  inspect in the member roster. Concurrent grants resolve to one winner. Tier
  routes answer 410 `DELEGATED_ADMIN_TIERS_RETIRED`.
* Proof: `members-delegated-admin.integration.test.ts` (migration exactness and
  idempotency, coverage of every former route per tier, no widening, the
  managed writer, revocation, concurrency),
  `phase-12-new-005-permission-guard-membership.integration.test.ts`.

### 5.2 Unassigned members — who may be given work

| Plan | Non-owner, not placed in an ACTIVE Collaboration Team | Placed member | OWNER |
|---|---|---|---|
| FREE / PAYG | no collaboration | — | capability + reach |
| PRO, TEAM | refused: reviewer assignment, queue claim, escalation, case assignment (`ASSIGNEE_NOT_PLACED`, 422); not offered as an operator | capability + reach | exempt from placement; still needs capability + reach |
| ENTERPRISE | contract: direct eligible assignment by default; placement required when `assignment_requires_team_placement` is TRUE on the ACTIVE contract; no ACTIVE contract → placement required | capability + reach | as above |

Placement is necessary, never sufficient. Authority:
`assignment/assignee-eligibility.ts` (`assertWorkAssigneeEligible`) and
`assignment/placement-policy.ts`. Proof:
`members-unassigned-rule.integration.test.ts`.

### 5.3 SEC-08 — share links

* `pvr_` Public Verify references and REPORT / PACKAGE tokens are publication
  state: no time expiry while published, unaffected by their creator leaving,
  ended only by unpublish/revoke or the evidence/workspace lifecycle, so an
  issued report's QR code keeps verifying.
* Owner share links and external-review grants are creator-scoped: 7-day
  default, 30-day self-service maximum, renewal an explicit audited action;
  revoked when the creator is removed, suspended or loses the authority; an
  OWNER/ADMIN may move eligible grants to Workspace ownership in the removal
  flow; workspace closure ends them. Migration `20281026000400_share_grant_lifetimes`.
  Proof: `members-share-lifecycle.integration.test.ts`.

### 5.5 DOM-13 — SSO and SCIM belong to the Organization

| Organization-owned | Workspace-scoped |
|---|---|
| IdP connections (`sso_connections`), verified domains, SSO policy, SCIM credentials (`scim_provisioning_tokens`), SCIM users (`external_identity_mappings`), SCIM groups (`scim_groups`) | membership and role (`team_members`), Collaboration Team placement, Case access, operational assignment |

* Every identity row carries `organization_id` (migration
  `20281026000700_organization_scoped_identity`); `team_id` stays as the
  Workspace a row was configured from — for a connection or a SCIM token, the
  Organization's default provisioning Workspace. Any Workspace of the
  Organization addresses the same configuration.
* One live (ACTIVE or SUSPENDED) connection per provider per Organization; one
  live SCIM group per external id per Organization; external identities are
  unique per Organization, so two Organizations never collide and a subject
  linked in one means nothing in another. Legacy per-workspace duplicates were
  reconciled forward (earliest kept; others `DISABLED` /
  `DUPLICATE_PROVIDER_IN_ORGANIZATION`, or merged as projections).
* An Organization SCIM group reaches Workspaces through
  `scim_group_workspace_projections` (workspace + the role granted there). The
  provisioning authority (`scim-groups.service.ts`) applies membership in every
  ACTIVE projection — an existing membership changes role, a missing one is
  provisioned seat-enforced; removing undoes only the ADMIN this group granted
  (membership-grant provenance), never elevates; a member reference must be an
  identity of the Organization. Projections are managed by an Organization
  identity admin (`/v1/admin/identity/scim/groups…`).
* A directory deactivation suspends the identity in every Workspace of the
  Organization (never a Workspace OWNER); reactivation restores exactly what
  the directory suspended.
* Organization suspension sets connections and tokens `SUSPENDED` (resume
  restores exactly those); closure or contract termination REVOKES them,
  archives groups and projections and unlinks external identities, in the
  closure transaction (`ORG_IDENTITY_ENDED`). The SSO login policy refuses a
  non-ACTIVE Organization or a closed Workspace before any write.
* Writes to identity configuration need, besides the Workspace permission, an
  Organization identity role (ORG_OWNER / ORG_ADMIN / ORG_SECURITY_ADMIN —
  the set that administers verified domains):
  `services/identity/organization-identity-authority.ts`
  (`ORGANIZATION_IDENTITY_ADMIN_REQUIRED`). A SYSTEM Organization (one
  Workspace's container) needs nothing more than the Workspace authority.
* Proof: `members-organization-identity.integration.test.ts` (multi-workspace
  Organization, duplicate-provider prevention, group placement into two
  Workspaces, Organization-wide deactivation, cross-organization isolation,
  suspension, termination, Organization authority, migration reconciliation).

### 5.4 ENT-08 — one commercial authority

`billing/commercial-offer.service.ts` resolves each self-service offer
(product, plan, currency, amount, interval) from the same catalogue functions
the Pricing page and Billing screen render. Stripe checkout (plans, evidence
credits, storage add-ons) and plan changes charge only the configured Price,
read back first: unconfigured, shared between products, or disagreeing on
active/currency/amount/interval is refused `PAYMENTS_UNAVAILABLE` before
anything is created. The inline `price_data` fallback is gone. PayPal already
read its plan back (`assertPayPalPlanIsActive`). Proof:
`members-commercial-offer.test.ts` (every product × currency × interval).
The live Stripe configuration itself is an operator check.

## 6. Rules recorded by the remediation (2026-10-26)

These follow from the model in §1 and the owner decisions in §5. Each is
enforced in code and proven behaviourally; the test named is the proof.

- **LIFE-13 — account closure and other members.** Other members of a
  Personal or Owned workspace the person owns are a *consequence*, not a
  blocker: account closure closes those workspaces through `closeWorkspacesTx`, which
  revokes ACTIVE and SUSPENDED memberships with reach ended and sends each
  member WORKSPACE_CLOSED, the same rule workspace closure already follows.
  The preflight returns `WORKSPACE_MEMBERS_LOSE_ACCESS` with a count, and Web
  and mobile show it before the person confirms. An Organization workspace
  (or one whose kind cannot be proven) never closes as a side effect of one
  account: while it has other members it still blocks
  (`WORKSPACE_MEMBERS_ACTIVE`) and ends through organization offboarding.
  Legal holds, organization ownership and live billing still block. Proof: `members-lifecycle-closure`
  "LIFE-13 …", `account-closure-consequences.render.test.tsx`.
- **ACC-12 — reach is case-level only.** There is no per-record grant. A
  person reaches a record through workspace membership or, when the record is
  linked to a restricted case, through that case's list (`case_access`) or an
  ACTIVE Collaboration Team granted the case. An external reviewer reaches a
  record only through an external-review grant. A per-record grant would be a
  second access system and is not built.
- **ACC-10 — Collaboration Teams on a case.** An ACTIVE Collaboration Team of
  the same workspace may be granted a case. Its ACTIVE members reach it, and
  archiving the team withdraws that reach. Proof: `members-case-team-access`.
- **ROLE-04 — workspace rank.** OWNER > ADMIN > MEMBER > VIEWER, strictly:
  - an ADMIN acts on MEMBER and VIEWER only;
  - only the OWNER appoints, demotes, suspends or removes an ADMIN;
  - nobody acts on themselves through these commands.

  Refusal `rank_insufficient`. Proof: `members-membership-commands`
  "ROLE-04 …".
- **CT-18 — Collaboration Team rank.** Only a LEAD or the workspace OWNER acts
  on a LEAD (`LEAD_PROTECTED`). The last effective LEAD cannot be removed or
  demoted, even by two concurrent demotions. Proof:
  `members-collaboration-capacity` "CT-18 …".
- **LIFE-15 — leaving.** A MEMBER, VIEWER or ADMIN may leave a workspace
  (`POST /v1/teams/:id/leave`). The OWNER may not (`owner_cannot_leave`), and
  the last-ADMIN check runs under an advisory lock. Proof:
  `members-membership-commands` "LIFE-15 …".
- **ENT-04 — capacity is per Collaboration Team.** PRO and TEAM have no
  workspace-wide member pool: the workspace may hold any number of members.
  Only placement in an ACTIVE Collaboration Team is capped (PRO 5, TEAM 10
  non-owner members per group), and work assignment also requires that
  placement (§5.2). Proof: `members-collaboration-capacity` "ENT-04 …".
- **CT-10 — Enterprise capacity.** Enterprise follows its contract (§5.2).
  Without an ACTIVE contract there is no capacity (typed
  `ENTERPRISE_CONTRACT_REQUIRED`). An ACTIVE contract that names no
  collaboration limits takes the Enterprise contract defaults published in the
  catalogue (1000 Collaboration Teams, 500 members each). Those defaults are
  the standard contract terms; setting the contract fields changes them.
- **SEC-03 — step-up.** Irreversible destruction needs a fresh factor: case
  delete (`CASE_DELETE`) and Collaboration Team delete. Moving evidence to the
  trash or to the archive does not, because both can be reversed from the same
  screen and legal holds still refuse them. Permanent destruction goes through
  the governed destruction review.
