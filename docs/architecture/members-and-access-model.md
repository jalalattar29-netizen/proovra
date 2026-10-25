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
| Collaboration Team (UI: "Teams", one "Collaboration Team") | `collaboration_teams`, `collaboration_team_members` (LEAD > CONTRIBUTOR > VIEWER) | `collaboration-team/collaboration-team.service.ts` |
| Capacity | per ACTIVE Collaboration Team: PRO 2 × 5, TEAM 5 × 10 accepted non-owner members; Enterprise contract-defined | `collaboration-team/billing-guards.ts` (one lock per group) |
| Workspace-wide seat ceiling | only an ACTIVE Enterprise contract's `seat_count` | `billing/workspace-seats.service.ts` |
| Case reach | `case_access` + `case_collaboration_team_access` (restricted when either has a row) | `cases/record-reach` |
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
* CT status columns are `VARCHAR` with values owned by
  `TEAM_TASK_TRANSITIONS` / the service's state checks; every writer goes
  through the service (no other module writes `collaboration_team_members`
  except the standing-reach leg, which only sets REMOVED).

## 5. Open decisions (user approval required)

* **DOM-09** — two delegated-administration models: `MemberDelegatedAdminScope`
  (written by Security Center, enforced nowhere) and `DelegatedAdminGrant`
  (enforced by `require-delegated-tier`, no writer). Choosing which survives is
  a product decision.
* **DOM-13** — whether SSO/SCIM connections are workspace- or
  organization-scoped for Enterprise managed identity.
* **SEC-08** — maximum share-link lifetime, and whether links die with their
  creator's removal.
