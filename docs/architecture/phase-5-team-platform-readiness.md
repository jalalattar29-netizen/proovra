# PROOVRA Phase 5 — Team Collaboration Platform Readiness

> **Status:** READY ▸ pending board approval of the Phase 5 charter.
> **Author:** Architecture (Phase 4 closure).
> **Date:** 2026-06-01.
> **Predecessors:** Phase 3 (runtime alignment), Phase 4 (navigation
>   & persona recovery).
> **Supersedes nothing.**

This document is the bridge from the **Phase 4 closure state** to a
world-class **Phase 5 Team Collaboration Platform** — built on top of
the canonical Phase 3 helpers, persona-aware nav from Phase 4, and
the constitutional Target Operating Model — without violating any
non-negotiable.

The constitutional rules remain in force:

1. Workspace kinds are only **PERSONAL** and **ORGANIZATION**.
2. **Team is NOT a workspace.**
3. **Team is NOT enterprise-only.**
4. Team is a core collaboration feature available in **both** the
   Personal Workspace and the Organization Workspace.
5. Organization is optional.
6. Personal users must be fully functional.

Phase 5 inherits all 6 and treats them as the floor.

---

## 1. What Team entry points exist today (Phase 4 inventory)

After Phase 4, the following Team-related surfaces ship:

| Surface | Status | File / Route | Notes |
|---------|--------|--------------|-------|
| `/workspaces` page (workspace list) | ✅ Shipped | `apps/web/app/(app)/workspaces/page.tsx` → renders `WorkspaceAdministrationHome` | Lists Personal + Org workspaces; provides switcher. NOT a Team page. |
| `/teams` legacy alias | ✅ Shipped | `apps/web/app/(app)/teams/page.tsx` → redirects to `/workspaces` (via `next.config.js`) + back-compat render | Old bookmarks survive. |
| `/teams/[id]` per-team detail | ✅ Shipped | `apps/web/app/(app)/teams/[id]/page.tsx` | Shows TeamPermissionMatrix, members, access reviews, DangerConfirmModal. Used by Org admins. |
| `/organizations` + `/organizations/[id]` | ✅ Shipped | `apps/web/app/(app)/organizations/...` | Org list + detail. |
| `/org-invites/[token]/accept` | ✅ Shipped | Accept-invite landing for org invitations. |
| Workspace switcher (topbar) | ✅ Shipped | `AppTopbarV2.tsx` lines 384-530 | Lists Personal + Orgs; switches active context. |
| Org invitation flow | ✅ Shipped (partial) | `services/api/src/routes/organizations.routes.ts` + UI in `/organizations/[id]` | Email-based org invites work. |
| External Reviewer Portal | ✅ Shipped | Phase 2B — full SSO + email-delivery + bulk invite + portal session. | External collaborators ARE supported for review surfaces. |

**What does NOT exist as a first-class Team surface today:**

- ❌ A dedicated "Team" page that is NOT the workspace list — a place
  where a personal user can name a collaboration unit, invite
  collaborators, and assign them work without spinning up an
  Organization.
- ❌ A unified Team invitation flow that supports BOTH email and SMS
  (only org-tier email invites + the External Reviewer Portal SMS
  exist; the Phase 1 audit confirmed there is no first-class personal
  "invite someone to my Team" surface).
- ❌ A Team invite link (sharable URL) for personal users.
- ❌ Ownership transfer UI for Teams.
- ❌ An activity feed showing what teammates are doing inside a Team.
- ❌ A unified notifications channel for Team activity.
- ❌ Inline `@mentions` across Cases / Evidence / Reports that
  resolve to Team members.
- ❌ A bounded "guest collaborator" path for personal Teams (the
  External Reviewer Portal is org-only today).

---

## 2. What Team features are incomplete today

| Feature | Current state | Gap |
|---------|---------------|-----|
| **Email invites** | Org-tier shipped (`services/api/src/routes/organizations.routes.ts`); External Reviewer Portal also has it (Phase 2B). | No personal-tier `/teams/invite` endpoint. |
| **SMS invites** | External Reviewer Portal only (`render*SmsBody` helpers in `@proovra/shared/communications`). | Not wired to Team invites. |
| **Invite links** | Not implemented anywhere. | New surface. |
| **Roles** | Workspace-level roles (OWNER / ADMIN / MEMBER / VIEWER) exist via `TeamMember.role` + capability registry. | No Team-scoped role concept (a personal user can't say "Alice is my Team's Reviewer but not my Personal Workspace's"). |
| **Ownership transfer** | Org-tier shipped (`/organizations/[id]` Danger Zone). | Not on Personal Teams. |
| **Assignments** | Case-level `CaseMembership` + review assignment shipped. | Not surfaced at the Team level. |
| **Activity feed** | `EvidenceTimeline`, `ReviewerActivityLog` exist per surface. | No unified Team activity stream. |
| **Notifications** | Notification engine shipped (Phase 8 + governance-operations). | Not subscribed to Team-level events. |
| **Comments** | `EvidenceAnnotation` + `DiscussionThread` shipped. | Not Team-scoped (organization-scoped). |
| **Mentions** | `parseMentionTokens` exists in `@proovra/shared/collaboration`. | No member-directory resolver for personal Teams. |
| **External collaborators** | External Reviewer Portal — org-only. | Personal Teams need bounded guest path. |
| **Guest access** | Read-only Public Verify links shipped. | No bounded guest-with-comment-rights. |
| **Audit trail** | `AuditEvent` table + governance audit-transparency shipped. | Surfaces Org-only today. |
| **Access reviews** | Phase 4A shipped for Org. | Not for personal Teams. |

---

## 3. What Phase 5 must build (the Team Platform)

The deliverable shape (10 stages, mirroring Phase 3/4):

| Stage | Title | Net change |
|-------|-------|------------|
| 1 | Pre-flight audit + safety check | Read-only |
| 2 | Personal Team domain model: `Team` (collaboration sub-unit, NOT workspace) | Schema extension (new table + FK); migration |
| 3 | Team invitation service: email + SMS + link, deduplicated wire format | New API endpoints |
| 4 | Team roles overlay (Team-scoped roles distinct from workspace roles) | Schema extension |
| 5 | Team management UI: list, create, invite, role assign, ownership transfer | New pages under `/teams/...` |
| 6 | Team activity feed + unified notifications | New aggregation service |
| 7 | Mentions + comments resolution to Team directory | Extend existing helpers |
| 8 | External collaborator path for personal Teams (bounded; reuse External Reviewer Portal) | Extension |
| 9 | Team audit trail surface + access reviews for personal Teams | Reuse Phase 4A scaffolding |
| 10 | Run validations (R9-R14 tests + safety gate) + Phase 6 readiness doc |

---

## 4. World-class Team capabilities (target spec)

A "world-class" Team Platform per the Phase 4 brief MUST support:

| Capability | Definition | Phase 5 acceptance test |
|------------|------------|--------------------------|
| **Email invites** | Send branded email with accept-link; track bounce; expire. | Phase 2B parity — bulk + retry + audit. |
| **SMS invites** | Send via Twilio (existing provider); STOP support; phone normalisation. | Existing `@proovra/shared/communications` helpers reused. |
| **Invite links** | Sharable URL with bounded expiry + revocation + per-link role. | Phase 4 invitation-link contract test. |
| **Roles** | At minimum: OWNER / ADMIN / MEMBER / VIEWER + role grants per Team. | Permission matrix UI + audit on every grant change. |
| **Ownership transfer** | Owner can transfer to another OWNER/ADMIN with a confirmation challenge. | Matches Org-tier flow. |
| **Assignments** | Cases + Evidence Requests can be assigned to a Team or a specific Team member. | Cross-references Phase 4A `CaseMembership`. |
| **Activity feed** | Time-ordered list of Team events with redaction-aware filtering. | Bounded vocabulary; no fake events. |
| **Notifications** | Email + in-app + (opt-in) SMS for Team events. | Reuses Phase 8 notification engine. |
| **Comments** | Inline + thread comments on Cases / Evidence / Reports scoped to the Team. | Reuses `DiscussionThread`. |
| **Mentions** | `@member` resolves to a Team directory entry with notification + audit. | `parseMentionTokens` extended with directory resolver. |
| **External collaborators** | A non-member can be invited with a bounded role + audit + revocation. | External Reviewer Portal reused. |
| **Guest access** | A read-only or comment-only guest can view specific evidence + leave comments. | Bounded; expires; audit-logged. |
| **Audit trail** | Every Team-mutating action emits an audit event; viewable by OWNER/ADMIN. | Reuses `AuditEvent` table; surface at `/teams/[id]/audit`. |
| **Access reviews** | OWNER/ADMIN can periodically review Team members and revoke. | Reuses Phase 4A access-review machinery. |

---

## 5. What current Team UI must be replaced or expanded

| Surface | Current | Phase 5 action |
|---------|---------|----------------|
| `/teams/[id]/page.tsx` | Renders org-only TeamPermissionMatrix + Access Review Card | **Expand**: detect whether Team is org-owned or personal-owned; render appropriate variant. Add invitation UI, activity feed, comments. |
| `/teams` (legacy alias) | Redirects to `/workspaces` | **Replace** with a new `/teams` index page that lists the user's Teams across all their workspaces. Keep `/workspaces` as the workspace switcher. |
| Workspace switcher | Topbar dropdown | **Keep** as-is; add a "Teams in this workspace" submenu. |
| Sidebar | After Phase 4, Teams are NOT a sidebar item for personal users (only `/workspaces` accessible via Cmd-K) | **Add** a sidebar "Teams" item when the user has ≥1 personal Team (sidebar-eligible: true; gated on `TEAM_VIEW`). |

---

## 6. What backend APIs exist today

| Endpoint | Purpose | Source |
|----------|---------|--------|
| `GET /v1/teams` | List teams the user is a member of. | `services/api/src/routes/teams.routes.ts` |
| `GET /v1/teams/:id` | Team detail. | same |
| `POST /v1/teams` | Create team (currently coupled to org creation flow). | same |
| `POST /v1/teams/:id/invite` | Invite user (org-tier; email-only). | `services/api/src/routes/organizations.routes.ts` |
| `GET /v1/teams/workspace-admin` | Workspace administration envelope. | `services/api/src/services/workspace-admin/workspace-admin.service.ts` |
| `POST /v1/external-portal/invite` | External reviewer invitation. | `services/api/src/routes/external-portal.routes.ts` |
| `POST /v1/external-portal/sms-invite` | SMS invitation (External Reviewer). | same |
| `GET /v1/teams/:id/audit` | Per-team audit (org-only today). | implied by Phase 4A |

---

## 7. What backend APIs are missing

| Endpoint | Purpose | Phase 5 requirement |
|----------|---------|---------------------|
| `POST /v1/teams/:id/invites/email` | Personal-Team email invite (no org required). | Need |
| `POST /v1/teams/:id/invites/sms` | Personal-Team SMS invite. | Need |
| `POST /v1/teams/:id/invites/link` | Create shareable invite link. | Need |
| `POST /v1/teams/:id/invites/:inviteId/revoke` | Revoke pending invite. | Need |
| `POST /v1/teams/:id/transfer-ownership` | Personal-Team ownership transfer. | Need (Org-tier exists; replicate). |
| `GET /v1/teams/:id/activity` | Unified activity feed. | Need (Org-tier exists for some scopes; consolidate). |
| `GET /v1/teams/:id/members/directory` | Team member directory for mentions. | Need. |
| `POST /v1/teams/:id/access-reviews` | Personal-Team access review. | Need (Phase 4A scaffolding reuse). |

---

## 8. How Team remains available in Personal and Organization workspaces

This is the constitutional bridge — Team CANNOT become Workspace,
CANNOT require Organization, and MUST remain available to personal
users.

| Workspace context | Team availability in Phase 5 |
|-------------------|-------------------------------|
| **Personal Workspace** | The user IS the OWNER of their Personal Team (the bootstrap row). They can invite collaborators (email/SMS/link) to form additional Personal Teams that live alongside their Personal Workspace. **No Organization is created.** Teams are stored as new `TeamMember` rows with the workspace context pointing to the user's personal `Team.id`. |
| **Organization Workspace** | Same Team primitives; Teams are scoped to the org. Org admins can require approval for new Team creation (a config knob, NOT a hard gate). |

The schema change in Phase 5 Stage 2 is **additive only**: a new
`Team` table (NOT the existing `Team` table which is actually the
runtime Workspace, legacy debt DBT-WS-04). Phase 5 will need to
either:
- (a) rename the legacy `Team` table to `Workspace` and add a new
  `Team` table; **OR**
- (b) keep the legacy `Team` table and add a new `CollaborationTeam`
  table.

**Recommendation: (b)** — option (a) requires a global `teamId`
rename, which the Phase 3 + Phase 4 non-negotiables explicitly
forbid. Option (b) is purely additive and ships in one phase.

---

## 9. What Phase 5 MUST NOT do (inherited non-negotiables)

| ❌ Out of scope | Why |
|----------------|-----|
| Make Team a Workspace (rename legacy `Team` → `Workspace`) | Constitutional rule 2; requires global `teamId` rename which Phase 3 explicitly forbids. |
| Make Team require Organization | Constitutional rule 4. |
| Make Team enterprise-only | Constitutional rule 3. |
| Introduce a 3rd workspace kind | Constitutional rule 1; no new workspace kinds. |
| Migrate Evidence ownership to a Team table | Constitutional rule 14 (inherited from Phase 3). |
| Migrate Case ownership to a Team table | Same. |
| Build SSO/SCIM for personal Teams | Constitutional rule 13; SSO/SCIM is Enterprise tier. |
| Replace `TeamMember` with a brand new tenancy model | Backward-compat with 165 FKs + 738 Prisma queries. |
| Add billing per-Team for personal users | Phase 5 is platform, not billing; billing is Phase 6+. |

---

## 10. Phase 5 deliverable shape (proposed)

| Stage | Title | New files | Net change |
|-------|-------|-----------|------------|
| 1 | Pre-flight audit + safety check | doc | read-only |
| 2 | `CollaborationTeam` + `CollaborationTeamMember` Prisma models + Phase-O migration | 1 migration file | additive schema |
| 3 | `team-invitation.service.ts` (email + SMS + link) | service + routes | additive |
| 4 | Team roles overlay + capability extension | extend capability-registry | additive |
| 5 | `/teams` index + `/teams/:id` expansion + invitation modal | UI | new pages |
| 6 | Team activity feed + notification subscription | service + UI | additive |
| 7 | Mention directory resolver + comment scope wiring | extend existing helpers | additive |
| 8 | External collaborator + guest paths for personal Teams | reuse External Reviewer Portal | additive |
| 9 | Personal Team audit trail + access reviews | reuse Phase 4A scaffolding | additive |
| 10 | Validation (R9-R14 tests + safety gate) + Phase 6 readiness | tests | additive |

---

## 11. Phase 5 gating preconditions (as of 2026-06-01)

- [x] Phase R9 (32) + R10 (46) + R11 (21) + R12 (33) + R13 (106) =
      **238 source-contract tests passing**.
- [x] `pnpm --filter @proovra/shared build` clean.
- [x] `pnpm --filter proovra-api typecheck` clean.
- [x] `pnpm --filter proovra-web typecheck` clean.
- [x] `pnpm --filter proovra-web build` clean.
- [x] Phase 4 route × persona matrix is the canonical visibility
      source (`docs/architecture/phase-4-route-persona-matrix.md`).
- [x] Canonical denial vocabulary in `@proovra/shared` is consumed by
      `PageRouteGate.tsx`.
- [x] Platform-OPS routes are PLATFORM_ADMIN-gated; no normal user
      sees them.
- [x] No forbidden "Team Workspace" / "Reviewer Workspace" /
      "Governance Workspace" / "Operations Workspace" literal in
      user-facing UI strings.
- [x] Personal-First invariant intact — every Personal user has a
      bootstrap `Team` row with `isPersonal = true`.
- [x] Constitutional rule 4 (Team available in Personal + Org)
      preserved.

Phase 5 is ready to build.

---

## 12. Rollback strategy

Phase 4 added/modified ONLY:

- 2 new doc files (`phase-4-route-persona-matrix.md`,
  `phase-5-team-platform-readiness.md`).
- 1 new test file (`phase-r13-route-persona-matrix.test.ts`).
- Registry metadata edits on 12 routes in `routeRegistry.ts`
  (`requiredActiveSpace`, `fallbackBehavior`, visibility flags).
- 1 filter in `AppSidebarV2.tsx` (5 lines).
- 1 copy-helper migration in `PageRouteGate.tsx`.
- 3 string edits in billing/evidence-library helpers.

Rollback is **trivial**: revert these files. No schema, no data,
no production behaviour change beyond persona-aware visibility.
Phase 5 should preserve the same property — every change MUST be
either an additive schema change OR a copy/projection/import
migration, never a behaviour swap.
