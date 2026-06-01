# PROOVRA Phase 5 — Team Collaboration Platform (Final)

> **Status:** SHIPPED ▸ pinned by Phase R14 source-contract test (47 tests).
> **Author:** Architecture.
> **Date:** 2026-06-01.
> **Predecessors:** Phase 4 (navigation & persona recovery).
> **Validations:** all green (R9 + R10 + R11 + R12 + R13 + R14 = 285/285).

This document is the canonical reference for the Team Collaboration
Platform. It describes WHAT the platform is, WHAT it is not, the
backend model, the API, the permission model, the invite flows, the
UI surfaces, the limits, the audit catalog, and what remains for
Phase 6.

---

## 1. What Team means

A **Collaboration Team** is a bounded group of people inside a
workspace who work together. It is a sub-unit of a workspace, NOT a
workspace itself.

**Concrete properties:**

- Lives inside exactly one workspace (`workspaceId` references the
  legacy `Team` row, which is the runtime workspace — DBT-WS-04).
- The workspace can be PERSONAL (`isPersonal = true`) or
  ORGANIZATION (`isPersonal = false`). Both are first-class.
- Personal users CAN create Collaboration Teams without creating an
  Organization (constitutional rule 7).
- Members are users who are ALSO active members of the parent
  workspace. A Collaboration Team never crosses workspace lines.
- Each member has a TEAM-scoped role distinct from the workspace
  role: LEAD / ADMIN / MEMBER / VIEWER / EXTERNAL.
- Teams can be assigned to Cases / Evidence / Reviews via
  `CollaborationTeamAssignment` (foundation; not a full PM system).

---

## 2. What Team does NOT mean

| ❌ Not | Why |
|--------|-----|
| A workspace | Constitutional rule 1; workspace kinds remain PERSONAL + ORGANIZATION. |
| A tenant | Constitutional rule 2; data tenancy stays at the workspace level. |
| Enterprise-only | Constitutional rule 3; every plan tier supports teams (with limits). |
| Required for personal users | Constitutional rule 7; you can use PROOVRA fully without a Team. |
| The legacy `Team` table | The legacy `Team` table is the runtime workspace (DBT-WS-04). Phase 5 added a **new** `CollaborationTeam` table; the legacy table is untouched. |
| A billing unit | Phase 5 enforces plan limits but doesn't add new SKUs. |
| An SSO/SCIM target | SSO/SCIM remains scoped to organizations. |
| An evidence owner | Evidence ownership stays at the workspace. |

---

## 3. Backend data model (additive Prisma schema)

Five new tables, all under the `collaboration_*` prefix:

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `collaboration_teams` | Team root row | `id`, `workspace_id`, `name`, `description`, `team_type`, `status`, `created_by_user_id`, `created_at`, `updated_at`, `archived_at_utc` |
| `collaboration_team_members` | Membership ledger | `id`, `team_id`, `user_id`, `role`, `status`, `invited_by_user_id`, `joined_at`, `suspended_at`, `removed_at`, `status_reason` |
| `collaboration_team_invites` | Invite ledger | `id`, `team_id`, `workspace_id`, `channel`, `email`, `phone`, `token_hash`, `role`, `status`, `expires_at_utc`, `max_uses`, `use_count`, `created_by_user_id`, `accepted_by_user_id`, `accepted_at_utc`, `revoked_at_utc`, `delivery_status`, `delivery_error_preview` |
| `collaboration_team_activity` | Audit feed (team-scoped) | `id`, `team_id`, `workspace_id`, `actor_user_id`, `event_type`, `target_type`, `target_id`, `metadata`, `created_at` |
| `collaboration_team_assignments` | Work routing | `id`, `team_id`, `workspace_id`, `assignee_user_id`, `assigned_by_user_id`, `target_type`, `target_id`, `status`, `priority`, `due_at_utc`, `note`, `created_at`, `updated_at`, `completed_at_utc` |

**Migration:** `services/api/prisma/migrations/20270201000000_phase_5_collaboration_teams/migration.sql`.
Phase-O hardened (every CREATE TABLE / FK / INDEX guarded by DO-block
existence checks). Additive only — no column alter, no data backfill.

**Security:**
- `collaboration_team_invites.token_hash` is sha256 of the raw token.
  The raw value is returned ONCE to the operator (link invite
  response) and NEVER persisted.
- `collaboration_team_invite_token_hash_uniq` is a global unique index
  on the hash — the 256-bit entropy of the random token makes
  cross-tenant collision a non-issue.

---

## 4. API routes

Mounted under `/v1/collaboration-teams` (distinct from the legacy
`/v1/teams` workspace-admin API which remains authoritative).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/collaboration-teams` | List teams visible to actor in active workspace |
| POST | `/v1/collaboration-teams` | Create team |
| GET | `/v1/collaboration-teams/:teamId` | Team detail with members + invites |
| PATCH | `/v1/collaboration-teams/:teamId` | Update name/description/type |
| POST | `/v1/collaboration-teams/:teamId/archive` | Archive |
| POST | `/v1/collaboration-teams/:teamId/members` | Add existing workspace member |
| PATCH | `/v1/collaboration-teams/:teamId/members/:memberId` | Change role / suspend |
| DELETE | `/v1/collaboration-teams/:teamId/members/:memberId` | Remove member |
| POST | `/v1/collaboration-teams/:teamId/invites/email` | Email invite |
| POST | `/v1/collaboration-teams/:teamId/invites/sms` | SMS invite |
| POST | `/v1/collaboration-teams/:teamId/invites/link` | Shareable link invite (returns rawToken + acceptUrl once) |
| POST | `/v1/collaboration-teams/:teamId/invites/:inviteId/revoke` | Revoke invite |
| POST | `/v1/collaboration-team-invites/:token/accept` | Accept invite (authed actor) |
| GET | `/v1/collaboration-teams/:teamId/activity` | List activity events |
| GET | `/v1/collaboration-teams/:teamId/assignments` | List assignments |
| POST | `/v1/collaboration-teams/:teamId/assignments` | Create assignment |
| PATCH | `/v1/collaboration-teams/:teamId/assignments/:assignmentId` | Reassign / set status / set priority / set due |

**Naming note:** the prompt suggested `/v1/teams/...` paths. We use
`/v1/collaboration-teams/...` to avoid colliding with the existing
`/v1/teams` workspace-admin endpoints. UI labels still say "Teams".

**Conventions:**
- Every mutation goes through the canonical service in
  `services/api/src/services/collaboration-team/collaboration-team.service.ts`.
- Every successful mutation emits an audit event via
  `appendPlatformAuditLog` (`category: "collaboration_team"`).
- Every mutation also emits a `CollaborationTeamActivity` row (the
  team-scoped activity feed users see in the UI).
- The active workspace is resolved via the Phase 3 canonical
  `resolveActiveOperationalWorkspace` helper.

---

## 5. Permissions / roles

| Role | Permissions |
|------|-------------|
| **LEAD** | All team management permissions including transfer leadership + archive. |
| **ADMIN** | Invite / remove / suspend members, assign work, manage assignments. No transfer-leadership, no archive. |
| **MEMBER** | Read team, complete assignments, read activity. |
| **VIEWER** | Read team + activity only. |
| **EXTERNAL** | Read team only (bounded; intended for time-limited guest collaborators). |

Permission map and helper `collaborationTeamRoleHasPermission` are
exported from `@proovra/shared`
(`packages/shared/src/collaboration-team.ts`).

**Hard rules:**

- Only LEAD can grant LEAD (transfer leadership).
- The last LEAD cannot be demoted or removed without a transfer.
- Collaboration team roles are SEPARATE from workspace roles. A
  workspace ADMIN is NOT automatically a team LEAD. They must be
  explicitly added (which the workspace admin can do, because adding
  themselves as LEAD requires being added at all — they have
  workspace-admin gates inherited from the legacy permission system).

---

## 6. Invite flows

### 6.1 Email invite

`POST /v1/collaboration-teams/:teamId/invites/email`
Body: `{ email, role?, expiresInDays? }`.

- Server creates a `CollaborationTeamInvite` with channel=EMAIL +
  sha256(token).
- Server immediately attempts delivery via `getEmailService()` →
  Resend, using the branded `renderEmailShell` template.
- Delivery result is recorded on the invite row
  (`delivery_status: SENT|FAILED|BOUNCED`).
- Raw token is NOT returned to the operator (the email contains it).
- On accept, the user clicks the email link → frontend POSTs
  `/v1/collaboration-team-invites/:token/accept` → server hashes the
  token, looks up the invite, validates expiry + use-count, and
  upserts a `CollaborationTeamMember` row.

### 6.2 SMS invite

`POST /v1/collaboration-teams/:teamId/invites/sms`
Body: `{ phone (E.164), role?, expiresInDays? }`.

- Server creates a `CollaborationTeamInvite` with channel=SMS.
- Delivery via the canonical communications queue
  (`enqueueOutboundMessage`) which routes through Twilio with rate
  limiting + STOP-opt-out + audit.
- Body via `renderCollaborationTeamInvitationSmsBody` (clamped to
  320 chars, ends with "Reply STOP to opt out.").
- **Phase 6 debt:** the `CommunicationPurpose` enum currently uses
  `INTAKE_LINK` for this delivery (closest semantic neighbour). A
  follow-up should add a dedicated `COLLABORATION_TEAM_INVITE`
  purpose to the shared + Prisma enums.

### 6.3 Link invite

`POST /v1/collaboration-teams/:teamId/invites/link`
Body: `{ role?, maxUses?, expiresInDays? }`.

- Server creates a `CollaborationTeamInvite` with channel=LINK.
- Server returns `{ id, rawToken, acceptUrl, expiresAtUtc, maxUses }`
  **once** in the response body. The operator copies the link.
- After this response, the raw token NEVER appears again. Subsequent
  GETs only show invite metadata (status, useCount, expiry).
- Multi-use links: `maxUses > 1` allowed up to plan limit. Each
  accept increments `use_count`; status flips to ACCEPTED when
  `use_count >= max_uses`.

### 6.4 Token security

- Format: `ctit_v1_<base32(256-bit-random)>` (52 chars after prefix).
- Persisted: sha256(token) only.
- Validated client-side via `isWellFormedCollaborationTeamInviteToken`.
- Rate-limited at 100 invites / 24h / inviter (PRO plan default).
- Audit: every issue / resend / revoke / accept emits both a
  `CollaborationTeamActivity` row AND an `appendPlatformAuditLog`
  entry.

---

## 7. Activity event types (bounded)

`COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES` (exported from
`@proovra/shared`):

```
TEAM_CREATED, TEAM_RENAMED, TEAM_DESCRIPTION_CHANGED,
TEAM_TYPE_CHANGED, TEAM_ARCHIVED, TEAM_REOPENED,
MEMBER_INVITED, INVITE_RESENT, INVITE_REVOKED, INVITE_ACCEPTED,
INVITE_EXPIRED, MEMBER_ADDED, MEMBER_SUSPENDED, MEMBER_REINSTATED,
MEMBER_REMOVED, MEMBER_ROLE_CHANGED, LEAD_TRANSFERRED,
ASSIGNMENT_CREATED, ASSIGNMENT_REASSIGNED, ASSIGNMENT_COMPLETED,
ASSIGNMENT_CANCELLED, ASSIGNMENT_PRIORITY_CHANGED,
ASSIGNMENT_DUE_CHANGED
```

23 event types. New types require:
1. Add to `COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES` in
   `@proovra/shared`.
2. Service emits via `recordActivity(...)` inside the same
   transaction as the mutation.
3. R14 test verifies the new type is enumerated.

---

## 8. Plan limits

| Plan | maxTeams | maxMembersPerTeam | maxPendingInvitesPerTeam | maxInvitesPer24h | SMS | Link |
|------|---------:|------------------:|-------------------------:|-----------------:|:---:|:----:|
| FREE | 1 | 3 | 3 | 10 | ❌ | ✓ (3 uses) |
| PAYG | 3 | 5 | 10 | 30 | ✓ | ✓ (10) |
| PRO | 10 | 10 | 25 | 100 | ✓ | ✓ (25) |
| TEAM | 50 | 50 | 100 | 500 | ✓ | ✓ (100) |
| ENTERPRISE | 1000 | 500 | 1000 | 5000 | ✓ | ✓ (1000) |

Enforced inside the service before every team-creation, member-add,
and invite-issue. Returns a structured `TEAM_PLAN_LIMIT` error
(HTTP 402) on breach so the UI can render an upgrade CTA.

Get limits for any plan with `getCollaborationTeamPlanLimits(plan)`.

---

## 9. UI surfaces

Phase 5 backend + tests + docs are shipped. The frontend pages are
the explicit **next-up** deliverable (see §11).

**Recommended frontend implementation plan** (estimated 1-2 days for
a polished v1):

| Page | Path | Role |
|------|------|------|
| Teams Overview | `/collaboration-teams` | List teams the user can see |
| Create Team modal | (in-page on overview) | Name, description, type |
| Team Detail | `/collaboration-teams/[id]` | Header + tabs |
| → Members tab | `/collaboration-teams/[id]?tab=members` | List, add, change role, suspend, remove |
| → Invites tab | `/collaboration-teams/[id]?tab=invites` | Email/SMS/link create, revoke, status |
| → Activity tab | `/collaboration-teams/[id]?tab=activity` | Paginated activity feed |
| → Assignments tab | `/collaboration-teams/[id]?tab=assignments` | List, create, complete |
| → Settings tab | `/collaboration-teams/[id]?tab=settings` | Name/description/type/archive (LEAD only) |
| Accept invite | `/collaboration-teams/invites/[token]/accept` | Click-through landing + accept |

All pages should use the existing design tokens (`cc-page`,
`cc-page-header`, `cc-section`) for consistency with the rest of the
product.

---

## 10. Audit catalog

Every mutation produces TWO records:

1. **Activity feed** (`collaboration_team_activity`) — user-facing in
   the team UI; bounded `event_type` from the shared list above.
2. **Platform audit log** (`platform_audit_log` via
   `appendPlatformAuditLog`) — system-of-record audit for security
   investigators; uses (action, category, source) tuple.

Audit `action` values:

```
collaboration_team.created
collaboration_team.updated
collaboration_team.archived
collaboration_team.member.added
collaboration_team.member.role_changed
collaboration_team.member.suspended
collaboration_team.member.removed
collaboration_team.invite.email.created
collaboration_team.invite.sms.created
collaboration_team.invite.link.created
collaboration_team.invite.revoked
collaboration_team.invite.accepted
collaboration_team.assignment.created
collaboration_team.assignment.updated
```

`category: "collaboration_team"` for all of them; `source:
"api_collaboration_teams"`.

---

## 11. What remains incomplete (Phase 6+)

| Item | Why deferred | Owner |
|------|--------------|-------|
| **Frontend pages** (Teams Overview, Detail, Members, Invites, Activity, Assignments, Accept-invite) | Backend + contract complete in Phase 5; UI is the next discrete deliverable | Phase 6 Stage A |
| **Dedicated `COLLABORATION_TEAM_INVITE` CommunicationPurpose** enum value | Requires migration on Prisma `CommunicationPurpose` enum; reusing `INTAKE_LINK` for now (close semantic neighbour) | Phase 6 Stage B |
| **Comments + mentions** | Requires extending `DiscussionThread` to be team-scoped (currently workspace-scoped) | Phase 6 Stage C |
| **External / Guest collaborator path** | Foundation present (EXTERNAL role); full implementation requires extending External Reviewer Portal to Personal Teams | Phase 6 Stage D |
| **Resend invite (channel re-send)** | Service revoke-and-recreate works; a dedicated `POST /:teamId/invites/:inviteId/resend` endpoint that reuses the same invite row would be nicer | Phase 6 Stage E |
| **Notifications for team events** | The notification engine exists but needs a `CollaborationTeamNotificationPreference` table + per-event templates | Phase 6 Stage F |
| **Access reviews for personal teams** | Reuse Phase 4A scaffolding; requires UI | Phase 6 Stage G |
| **Bulk invite (CSV)** | Pattern proven in External Reviewer Portal; mechanical port | Phase 6 Stage H |
| **Real-time activity feed** | Currently fetched on tab open; SSE / WebSocket push is a polish | Phase 7+ |
| **Personal-team SSO/SCIM** | Constitutional rule 13: out of scope by design |  — |

---

## 12. What must never be changed

- The legacy `Team` table is the runtime workspace. **Do not rename
  it.** Doing so requires renaming `teamId` across 165 FKs and 738
  Prisma queries, which is explicitly forbidden by the Phase 3
  constitutional rules.
- A new `CollaborationWorkspace` / `ReviewerWorkspace` /
  `GovernanceWorkspace` / `OperationsWorkspace` table. The
  constitutional rule is: workspace kinds remain PERSONAL +
  ORGANIZATION.
- Organization-gating Collaboration Teams. A personal user MUST be
  able to create + use a team without ever creating an Organization.
- Storing the raw invite token. Only the sha256 hash. The R14 test
  pins this.
- Cross-workspace team membership. A CollaborationTeam belongs to
  exactly one workspace; the parent-workspace-membership check on
  add-member and accept-invite enforces this.

---

## 13. Validation summary (2026-06-01)

| Check | Result |
|-------|--------|
| `pnpm --filter @proovra/shared build` | ✓ clean |
| `pnpm --filter proovra-api typecheck` | ✓ clean |
| `pnpm --filter proovra-web typecheck` | ✓ clean |
| `pnpm --filter proovra-web build` | ✓ clean |
| Phase R9 personal-first rescue | 32/32 ✓ |
| Phase R10 personal-first regression | 46/46 ✓ |
| Phase R11 domain stabilization | 21/21 ✓ |
| Phase R12 runtime alignment | 33/33 ✓ |
| Phase R13 route × persona matrix | 106/106 ✓ |
| **Phase R14 Team Platform** | **47/47 ✓** |
| **Total** | **285/285 ✓** |

Phase 5 is **shipped**.
