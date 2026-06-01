# PROOVRA Phase 6 — Team Collaboration Frontend (Final)

> **Status:** SHIPPED ▸ pinned by Phase R15 source-contract test (35 tests).
> **Author:** Architecture.
> **Date:** 2026-06-01.
> **Predecessors:** Phase 5 (Team Collaboration backend).
> **Validations:** all green (R9 + R10 + R11 + R12 + R13 + R14 + R15 = 321/321).

Phase 6 is the user-facing companion to the Phase 5 backend. It turns
the `/v1/collaboration-teams` API into a real, enterprise-grade
product experience.

---

## 1. Routes created

| Route | Page file | Purpose |
|-------|-----------|---------|
| `/collaboration-teams` | `apps/web/app/(app)/collaboration-teams/page.tsx` | Teams overview + create-team modal |
| `/collaboration-teams/[teamId]` | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` | Team detail with 6 tabs: Overview · Members · Invites · Assignments · Activity · Settings |
| `/collaboration-teams/invites/[token]/accept` | `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` | Accept-invite landing |

**Route registry IDs** (in `apps/web/lib/navigation/routeRegistry.ts`):

- `workspace.collaboration_teams` — sidebar-visible, command-palette-visible, all-tools-visible, `PERSONAL_OR_ORG` (no Organization required), no capability gate (server enforces per-team permissions).
- `workspace.collaboration_team_detail` — sidebar/Cmd-K/Tools invisible (deep link only).
- `workspace.collaboration_team_invite_accept` — sidebar/Cmd-K/Tools invisible, `requiredActiveSpace: "NONE"` (accept-flow works for unauthenticated → signin → return-here).

**URL naming choice**: We use `/collaboration-teams` (not `/teams`) to avoid colliding with the legacy `/teams/[id]` workspace-admin deep-link from Phase 4. UI label everywhere is "Teams" — the URL path is implementation detail.

---

## 2. API client

**`apps/web/lib/api/collaboration-teams.ts`** — typed wrappers around the canonical `apiFetch` helper.

| Function | Endpoint | Notes |
|----------|----------|-------|
| `listTeams({ includeArchived? })` | `GET /v1/collaboration-teams` | |
| `createTeam({ name, description?, teamType? })` | `POST /v1/collaboration-teams` | |
| `getTeam(teamId)` | `GET /v1/collaboration-teams/:teamId` | |
| `updateTeam(teamId, patch)` | `PATCH /v1/collaboration-teams/:teamId` | |
| `archiveTeam(teamId)` | `POST /v1/collaboration-teams/:teamId/archive` | |
| `addExistingMember(teamId, { userId, role? })` | `POST /v1/collaboration-teams/:teamId/members` | |
| `updateMember(teamId, memberId, patch)` | `PATCH /v1/collaboration-teams/:teamId/members/:memberId` | |
| `removeMember(teamId, memberId)` | `DELETE /v1/collaboration-teams/:teamId/members/:memberId` | |
| `inviteByEmail(teamId, { email, role?, expiresInDays? })` | `POST /v1/collaboration-teams/:teamId/invites/email` | Raw token NEVER returned. |
| `inviteBySms(teamId, { phone, role?, expiresInDays? })` | `POST /v1/collaboration-teams/:teamId/invites/sms` | Raw token NEVER returned. |
| `createInviteLink(teamId, { role?, maxUses?, expiresInDays? })` | `POST /v1/collaboration-teams/:teamId/invites/link` | Returns `{ rawToken, acceptUrl }` exactly once. |
| `revokeInvite(teamId, inviteId)` | `POST /v1/collaboration-teams/:teamId/invites/:inviteId/revoke` | |
| `acceptInvite(rawToken)` | `POST /v1/collaboration-team-invites/:token/accept` | |
| `listActivity(teamId, { limit?, cursor? })` | `GET /v1/collaboration-teams/:teamId/activity` | Cursor pagination. |
| `listAssignments(teamId, { status? })` | `GET /v1/collaboration-teams/:teamId/assignments` | |
| `createAssignment(teamId, payload)` | `POST /v1/collaboration-teams/:teamId/assignments` | |
| `updateAssignment(teamId, assignmentId, patch)` | `PATCH /v1/collaboration-teams/:teamId/assignments/:assignmentId` | |

**Error handling**: every function throws `ApiError` (which carries `requestId`) on non-2xx. Pages surface `requestId` in their error UI for support troubleshooting.

**Security**: only `createInviteLink` ever returns `rawToken`. Pinned by R15.

---

## 3. Pages walkthrough

### 3.1 Teams Overview (`/collaboration-teams`)

- **Header**: "Teams in this workspace" + subtitle explaining that no Organization is required + "Create Team" button.
- **Empty state**: "No Teams yet" with a clear CTA. No fake workspace terminology.
- **Loading state**: skeleton cards.
- **Error state**: red-toned panel with message + `requestId` + Retry button.
- **Grid**: responsive cards (auto-fill 280px min). Each card shows name, description, type badge, member/invite/assignment counts, last-activity date, your role.
- **Create Team modal**: name (max 120) · description (max 600) · template (GENERAL/INVESTIGATION/LEGAL/REVIEW/COMPLIANCE). On submit, redirects to `/collaboration-teams/[teamId]`.

### 3.2 Team Detail (`/collaboration-teams/[teamId]?tab=...`)

Single page with 6 query-driven tabs. Header carries the team name + breadcrumb + role-aware action buttons (Invite people · Settings).

| Tab | Content |
|-----|---------|
| **Overview** | 4 stat cards (active members · pending invites · open assignments · your role). Cards link to corresponding tabs. |
| **Members** | List with role select + suspend + remove actions. Last-LEAD protection (UI disables the demote/remove buttons and shows tooltip). |
| **Invites** | 3 invite-creator cards (email · SMS · link) + pending-invites table with status/delivery/revoke. Link invites show the `rawToken+acceptUrl` ONCE in a copy-to-clipboard panel; subsequent navigation never re-exposes them. |
| **Assignments** | List + status filter + create-assignment modal. Status state machine surfaced (Start → Complete). |
| **Activity** | Chronological activity feed; bounded event types rendered with friendly labels + the raw enum value as a code chip. |
| **Settings** | Edit name/description/template (LEAD/ADMIN only) + danger-zone archive. |

Every mutation shows a toast (`addToast`) on success. Errors include `requestId` in the toast message.

### 3.3 Accept Invite (`/collaboration-teams/invites/[token]/accept`)

10-state state machine: `checking → accepting → success | invalid | expired | revoked | auth_required | workspace_required | rate_limited | error`.

- **Client-side shape check** via `isWellFormedCollaborationTeamInviteToken` (fast-fail on obviously bad tokens — no backend round-trip for typos).
- **Safe messaging for invalid tokens**: We never expose team / inviter / role for invalid or expired tokens. Same generic copy regardless of cause.
- **Auth-required**: redirects to `/signin?next=<here>` so the user returns to the accept flow after authentication.
- **Workspace-required**: explains the user must join the parent workspace first, with a CTA to `/workspaces`.
- **Success**: 700ms toast then `router.replace` to the team detail.
- **The raw token is never logged** (pinned by R15).

---

## 4. Components created

All inline in the three page files (no shared component dump):

- **`TeamCard`** — overview grid card.
- **`TeamTypeBadge`** / **`StatusBadge`** / **`RoleBadge`** — bounded vocab badges.
- **`EmptyState`** / **`LoadingState`** / **`ErrorState`** — full-page non-data states.
- **`CreateTeamModal`** — overlay modal (focus-trap-light; click-outside dismiss).
- **`MembersTab` / `MemberRow`** — member list + role-change + suspend + remove.
- **`InvitesTab`** with **`EmailInviteCard` / `SmsInviteCard` / `LinkInviteCard`** + **`LinkInviteResult`** (copy-to-clipboard one-shot panel).
- **`InviteRow`** — pending-invite row with revoke action.
- **`RoleSelect`** / **`ExpirySelect`** — bounded enum form helpers with role help text per option.
- **`AssignmentsTab` / `AssignmentRow` / `CreateAssignmentModal`** — assignment CRUD.
- **`ActivityTab`** — chronological feed with bounded `activityLabel` for every `CollaborationTeamActivityEventType`.
- **`SettingsTab`** — name/description/type edit + danger-zone archive.
- **`Panel`** (accept page) — accent-tinted state panel with kicker + title + body + optional actions + requestId.

The pages reuse global design tokens (`cc-page`, `cc-page-header`, `cc-section`, `cc-kicker`, `cc-title`, `cc-subtitle`, `cc-meta`, `cc-quick-action`, `cases-filter-chip`) so the surface feels native to the rest of the product.

---

## 5. Navigation / route registry changes

**`apps/web/lib/navigation/routeRegistry.ts`** — three new entries:

```ts
workspace.collaboration_teams       /collaboration-teams                       sidebar:T  cmd-K:T  tools:T  PERSONAL_OR_ORG  DEGRADED
workspace.collaboration_team_detail /collaboration-teams/[teamId]              sidebar:F  cmd-K:F  tools:F  PERSONAL_OR_ORG  DEGRADED
workspace.collaboration_team_invite_accept /collaboration-teams/invites/[token]/accept  sidebar:F  cmd-K:F  tools:F  NONE  LOAD
```

- No new sidebar pillar; "Teams" appears as a single clean entry under the workspace group.
- No capability gate at the **frontend route** level — the backend enforces per-team permissions on every mutation. This lets personal users land on `/collaboration-teams` without any "Activate organization" wall.
- Phase R10 page-existence allowlist updated to cover the two dynamic routes.

---

## 6. Invite UX implemented

- **Email**: simple form (email · role · expiry). Submission shows toast; pending invite row appears with delivery status (PENDING → SENT → DELIVERED/FAILED/BOUNCED).
- **SMS**: same shape with E.164 phone validation (HTML pattern). Plan-tier message ("PAYG and above") shown beneath the form. Server-side plan-limit errors surface in the toast with `requestId`.
- **Link**: form with role · maxUses · expiry. On generate, the **`LinkInviteResult`** panel shows the secure URL once with a Copy button. The component instructs the operator that it's "visible once" — closing the panel drops the token from React state and it's never re-rendered.

The Invites tab also lists pending + recent invites with channel · recipient · role · expiry · delivery status, and a Revoke action for LEAD/ADMIN.

---

## 7. Role UX

The detail page uses bounded vocabulary throughout:

- **LEAD** — "manages team & leadership"
- **ADMIN** — "manages members & work"
- **MEMBER** — "participates in team work"
- **VIEWER** — "read-only"
- **EXTERNAL** — "limited collaborator"

These appear in invite-role dropdowns alongside the role name and drive UI visibility:
- Quick-Invite button only renders if `team.member.invite` permission.
- Settings button only renders if `team.update_settings` permission.
- Member suspend/remove + role select only renders if `canManage`.
- Last-LEAD protection disables demote/remove with a tooltip.

The role helpers come from `@proovra/shared` (`collaborationTeamRoleHasPermission`) so they never drift from the Phase 5 backend.

---

## 8. Assignments UX

A pragmatic foundation, not generic PM:

- List/filter by status (OPEN/IN_PROGRESS/COMPLETED/REASSIGNED/CANCELLED).
- Create modal: targetType (CASE/EVIDENCE/REVIEW) · targetId · assignee (team-level or a specific member) · priority · due (datetime) · note.
- Row actions: Start (OPEN→IN_PROGRESS) · Complete (any→COMPLETED) — gated by `team.assignment.complete` / `team.assignment.reassign` permissions.

No sprint planner, no Gantt — just bounded work routing per the Phase 5 constitution.

---

## 9. Activity UX

The Activity tab renders the bounded `COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES` (23 types) with human-readable labels via the `activityLabel(event)` switch. Every row shows actor (via id, pending Phase 7 user-directory enrichment), timestamp, target type if any, and the raw enum value as a small monospace chip for support troubleshooting.

---

## 10. Settings UX

LEAD/ADMIN can edit name/description/template. Save button is disabled until the form is dirty; clean form state is restored on save.

Danger zone: archive button gated to LEAD only (via `team.archive` permission). Native `confirm()` is used for the irreversible-action ack; Phase 7 will swap for the canonical `ConfirmActionModal`.

---

## 11. Tests added

**`services/api/test/phase-r15-team-frontend.test.ts`** — 35 source-contract tests covering:

- 4 API client tests (canonical exports, shared imports, apiFetch usage, rawToken-only-in-link-return).
- 5 route registry tests (3 new route ids registered with correct metadata; collaboration_teams is PERSONAL_OR_ORG not ORGANIZATION_ONLY; accept route is NONE/LOAD).
- 3 page-existence tests on disk.
- 14 page-content tests (testids, tabs array, no fake-workspace strings, link-invite-result presence, requestId surfacing, etc.).
- 2 navigation integration tests (sidebar visibility + deep-link-only invisibility).
- 2 constitutional tests (no "Team Workspace"/"Reviewer Workspace"/etc. literal; no ORGANIZATION_ONLY gate on collaboration_teams).

Also updated **R10** allowlist to cover the new dynamic routes (`/collaboration-teams/[teamId]`, `/collaboration-teams/invites/[token]/accept`).

---

## 12. Validation summary (2026-06-01)

```
pnpm --filter @proovra/shared build              ✓ clean
pnpm --filter proovra-api typecheck              ✓ clean
pnpm --filter proovra-web typecheck              ✓ clean
pnpm --filter proovra-web build                  ✓ clean

R9  personal-first rescue:                       32/32  ✓
R10 personal-first regression (allowlist updated):46/46  ✓
R11 domain stabilization:                        21/21  ✓
R12 runtime alignment:                           33/33  ✓
R13 route × persona matrix:                     107/107 ✓
R14 team platform (backend):                     47/47  ✓
R15 team frontend (NEW):                         35/35  ✓
────────────────────────────────────────────────────
Total:                                          321/321 ✓
```

---

## 13. Remaining limitations (Phase 7+)

| Item | Phase |
|------|-------|
| User directory enrichment in Activity tab (currently shows user id; should show display name + avatar) | Phase 7 Stage A |
| Resend-invite endpoint + UI (revoke+recreate is the current path) | Phase 7 Stage B |
| Bulk-invite (CSV) UI | Phase 7 Stage C |
| ConfirmActionModal swap (native `confirm()` is used for archive + member removal) | Phase 7 Stage D |
| Real-time activity feed (SSE/WS) — currently polled on tab open | Phase 7 Stage E |
| Inline `@mentions` resolved against team directory | Phase 7 Stage F |
| Team-scoped comments (DiscussionThread extension) | Phase 7 Stage G |
| External collaborator full path (EXTERNAL role foundation exists; portal integration pending) | Phase 7 Stage H |
| Per-event notification preferences UI | Phase 7 Stage I |
| Personal-team access reviews UI | Phase 7 Stage J |
| Mobile-first responsive polish (current UI is responsive but not mobile-first optimized) | Phase 7 Stage K |
| Accessibility audit + keyboard-driven invite flow | Phase 7 Stage L |
| Dedicated `COLLABORATION_TEAM_INVITE` CommunicationPurpose enum (still reuses `INTAKE_LINK`) | Phase 7 Stage M |

---

## 14. What must never change

- The Teams overview route MUST be reachable by personal users. Adding a capability gate or `ORGANIZATION_ONLY` requirement to `workspace.collaboration_teams` violates constitutional rule 5-7. R15 pins this.
- Per-team permissions stay on the BACKEND (`collaborationTeamRoleHasPermission`). The frontend asks the backend; it never decides on its own.
- The raw invite token only appears in the **link-invite response** and the **`LinkInviteResult`** copy panel. Any other component receiving the token is a security regression.
- No fake workspace terminology in Phase 6 surfaces. R15 pins "Team Workspace" / "Reviewer Workspace" / "Governance Workspace" / "Operations Workspace" as forbidden literal strings across all four Phase 6 files.
- The `/teams/[id]` legacy workspace-admin page is NOT replaced or removed by Phase 6. The new platform uses `/collaboration-teams/...` to coexist.

---

## 15. Phase 7 recommendation

Build user-directory enrichment first (Stage A) so the Activity tab and member rows become more humane. Then ship comments + mentions + notifications (Stages F/G/I) as a triad — those three together complete the "collaboration loop" promise made by the Phase 5 backend.

Phase 6 is **shipped**.
