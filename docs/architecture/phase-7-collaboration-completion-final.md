# PROOVRA Phase 7 — Collaboration Completion (Final)

> **Status:** SHIPPED ▸ pinned by Phase R16 source-contract test (45 tests).
> **Author:** Architecture.
> **Date:** 2026-06-01.
> **Predecessors:** Phase 5 (Team backend) + Phase 6 (Team frontend).
> **Validations:** all green (R9 + R10 + R11 + R12 + R13 + R14 + R15 + R16 = 366/366).

Phase 7 completes the collaboration loop. With this phase, a Team
inside PROOVRA can now actually work together — comments, mentions,
notifications, preferences, guests, access review — all without
needing an Organization, and without breaking personal users.

---

## 1. Comments model

**Table:** `collaboration_team_comments`

| Field | Notes |
|-------|-------|
| `id` | UUID PK |
| `team_id` | FK → `collaboration_teams.id` (CASCADE) |
| `workspace_id` | FK → `teams.id` — the parent workspace |
| `author_user_id` | FK → `users.id` (RESTRICT) |
| `target_type` | Bounded: `TEAM` / `ASSIGNMENT` / `CASE` / `EVIDENCE` / `REVIEW` |
| `target_id` | Optional UUID — null for TEAM-wide comments |
| `body` | Sanitised plain text, max 4000 chars |
| `status` | `ACTIVE` / `EDITED` / `DELETED` |
| `created_at` / `updated_at` / `deleted_at_utc` / `deleted_by_user_id` | Audit trail |

**Indices:** `(team_id, created_at DESC)`, `(team_id, target_type, target_id)`.

**Body sanitisation** lives in
`@proovra/shared/sanitiseCollaborationTeamCommentBody` and runs at
the service layer before persistence. Renderers MUST treat the body
as plain text and escape it — never `dangerouslySetInnerHTML`.

---

## 2. Mentions model

**Table:** `collaboration_team_comment_mentions`

| Field | Notes |
|-------|-------|
| `id` | UUID PK |
| `comment_id` | FK → `collaboration_team_comments.id` (CASCADE) |
| `team_id` | Denormalised for index queries |
| `mention_type` | `USER` / `TEAM` / `LEAD` |
| `mentioned_user_id` | Populated for `USER` mentions only |
| `raw_handle` | Raw token from the body (audit; supports unresolvable handles) |
| `created_at` | When the mention was parsed |

**Parser:** `parseCollaborationTeamMentionHandles(body)` in
`@proovra/shared`. Extracts dedup'd lowercase handles. Special tokens
`@team` and `@lead` are recognised and fan out at the service layer.

**Resolution rules** (enforced by the service):
- `@team` notifies every active team member.
- `@lead` notifies every active LEAD member.
- `@handle` resolves against team-member email-local OR display-name
  slugs. **Never resolves outside the team.**
- Author is never notified.

---

## 3. Notifications model

**Table:** `collaboration_team_notifications`

Distinct from the email/SMS `notification_deliveries` table (Phase 8):
this is the **in-app inbox**.

| Field | Notes |
|-------|-------|
| `id` | UUID PK |
| `user_id` | Recipient |
| `workspace_id` | Required — scopes the inbox by workspace |
| `team_id` | Optional — for per-team filtering |
| `type` | Bounded `COLLABORATION_TEAM_NOTIFICATION_TYPES` (10 values) |
| `title` | ≤200 chars |
| `body` | ≤1000 chars; bounded body preview |
| `target_type` / `target_id` | Optional deep link |
| `read_at` | `null` = unread |
| `created_at` | |

**Index:** `(user_id, read_at, created_at DESC)` for the "unread first" inbox + counter.

---

## 4. Notification preferences model

**Table:** `collaboration_team_notification_preferences`

| Field | Default |
|-------|---------|
| `team_id` | FK |
| `user_id` | FK |
| `mentions` | `true` |
| `assignments` | `true` |
| `invite_accepted` | `true` |
| `digest` | `INSTANT` (also: `DAILY`, `MUTED`) |

**Unique** on `(team_id, user_id)`. When digest is `MUTED` OR
specific flag is `false`, the service skips the notification create.

---

## 5. Guest model

**Table:** `collaboration_team_guests`

| Field | Notes |
|-------|-------|
| `id` | UUID PK |
| `team_id` / `workspace_id` | Scope (both FK CASCADE) |
| `email` | Required; lower-cased |
| `expires_at_utc` | **Required** — time-bounded access window |
| `status` | `PENDING` / `ACCEPTED` / `REVOKED` / `EXPIRED` |
| `invited_by_user_id` | Audit |
| `accepted_user_id` | Populated after accept (Phase 8 acceptance flow) |
| `revoked_at_utc` / `revoked_by_user_id` | Audit |
| `scope_note` | Optional 400-char operator note |

**Service rules**:
- Only LEAD / ADMIN can invite or revoke.
- Default TTL is 14 days; max 90 days (`GUEST_MAX_TTL_DAYS`).
- **Guests never become full workspace members in Phase 7.** The
  `accepted_user_id` column is reserved for the Phase 8 acceptance
  flow that will create a TeamMember with role `EXTERNAL`. Pinned by
  R16 ("guests never become full workspace members in this phase").
- Bridge to `ExternalReviewerRoleAssignment`: that model is
  evidence-scoped (Phase 2B); Phase 8 will define the bridge for
  promoting a `CollaborationTeamGuest` to an `ExternalReviewerRoleAssignment`
  when the guest needs evidence-level access.

---

## 6. Access review model

**Tables:** `collaboration_team_access_reviews` + `collaboration_team_access_review_items`

**Review row**: `id`, `team_id`, `workspace_id`, `created_by_user_id`, `status` (`OPEN` / `COMPLETED` / `CANCELLED`), `due_at_utc`, `completed_at_utc`.

**Item row**: `id`, `review_id`, `member_id`, `decision` (`PENDING` / `KEEP` / `REMOVE` / `CHANGE_ROLE`), `decided_by_user_id`, `decided_at`, `notes` (≤600 chars).

**Service rules**:
- Only LEAD / ADMIN can open / decide / complete.
- Opening a review snapshots every ACTIVE member into an item row.
- A `CollaborationTeamActivity` row is emitted for every state change.
- **Not a full Organization access review** — that's Phase 4A.
  This is team-level membership hygiene.

---

## 7. Activity upgrades

**New endpoint:** `GET /v1/collaboration-teams/:teamId/activity/v2`

Returns the same rows as Phase 5 `listTeamActivity` plus:
- **Filters**: `eventType`, `actor`, `since` (ISO timestamp), `until`
- **Pagination**: `limit` + `cursor`
- **Actor enrichment**: response includes a `directory` map
  (`userId → CollaborationTeamUserDirectoryEntry`) so the UI never
  has to render raw UUIDs.

---

## 8. Frontend changes

**New page**: `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` — the **Collaboration Hub**, a single surface that hosts:

- **Comments panel** (left, 2/3 width) — create + list + edit + delete with mention highlighting.
- **Notifications card** (right) — in-app inbox with unread badge + mark-read + mark-all.
- **Preferences card** (right) — per-team toggles for mentions/assignments/invite-accepted + digest mode select.
- **Guests card** (right) — invite by email + expiry select + revoke. Each guest is badged "External".
- **Access review card** (right) — open / per-item decide / complete, with last-completed timestamp.

**Team Detail header** now carries a "Collaboration hub" link (testid: `collaboration-hub-link`) so users discover Phase 7 features without changing the Phase 6 tab structure.

**Route registry**: new `workspace.collaboration_team_hub` entry at `/collaboration-teams/[teamId]/collaboration`, sidebar-invisible (reached via header link).

---

## 9. API routes added

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/collaboration-teams/:teamId/comments` | List comments (with directory) |
| POST | `/v1/collaboration-teams/:teamId/comments` | Create comment (parses mentions, emits notifications, audits) |
| PATCH | `/v1/collaboration-teams/:teamId/comments/:commentId` | Edit (author or LEAD/ADMIN) |
| DELETE | `/v1/collaboration-teams/:teamId/comments/:commentId` | Soft-delete |
| GET | `/v1/collaboration-team-notifications` | Inbox list + unread count |
| POST | `/v1/collaboration-team-notifications/:id/read` | Mark one read |
| POST | `/v1/collaboration-team-notifications/read-all` | Mark all read |
| GET | `/v1/collaboration-teams/:teamId/notification-preferences` | Get pref |
| PATCH | `/v1/collaboration-teams/:teamId/notification-preferences` | Update pref |
| GET | `/v1/collaboration-teams/:teamId/guests` | List guests |
| POST | `/v1/collaboration-teams/:teamId/guests/invite` | Invite guest |
| PATCH | `/v1/collaboration-teams/:teamId/guests/:guestId/revoke` | Revoke guest |
| GET | `/v1/collaboration-teams/:teamId/access-review` | List reviews + items |
| POST | `/v1/collaboration-teams/:teamId/access-review` | Open new review |
| PATCH | `/v1/collaboration-teams/:teamId/access-review/items/:itemId` | Decide |
| POST | `/v1/collaboration-teams/:teamId/access-review/:reviewId/complete` | Complete |
| GET | `/v1/collaboration-teams/:teamId/activity/v2` | Filtered activity |

All mutations go through the Phase 3 canonical workspace resolver, emit
audit via `appendPlatformAuditLog` (`category: "collaboration_team"`),
and surface `requestId` on errors.

---

## 10. Security boundaries

- **No cross-workspace leaks.** Every read filters on `teamId` AND
  `workspaceId`. Pinned by R16 ("no cross-workspace leak").
- **No PII leakage to non-workspace viewers.** The user directory
  helper hides email for non-workspace viewers; `emailMasked` is the
  masked form.
- **No raw mention payloads logged.** The audit metadata records
  bounded counts (`mentionCount`, `notificationCount`), never the
  comment body.
- **Mentions never notify outside the team.** Handle resolution is
  team-scoped — a user not in the team will never resolve and never
  receive a notification.
- **Guests are time-bounded.** Service enforces 1-90 day TTL.
- **Notifications are user-scoped.** The mark-read endpoint rejects
  reads on someone else's notifications.

---

## 11. Validation summary (2026-06-01)

```
pnpm --filter @proovra/shared build              ✓ clean
pnpm --filter proovra-api typecheck              ✓ clean
pnpm --filter proovra-web typecheck              ✓ clean
pnpm --filter proovra-web build                  ✓ clean

R9  personal-first rescue:                       32/32  ✓
R10 personal-first regression (allowlist):       46/46  ✓
R11 domain stabilization:                        21/21  ✓
R12 runtime alignment:                           33/33  ✓
R13 route × persona matrix:                     107/107 ✓
R14 team platform (backend):                     47/47  ✓
R15 team frontend:                               35/35  ✓
R16 collaboration completion (NEW):              45/45  ✓
─────────────────────────────────────────────────────
Total:                                          366/366 ✓
```

---

## 12. Known limitations / Phase 8 recommendation

| Item | Phase |
|------|-------|
| Topbar notification bell (current inbox lives only on the team hub page) | Phase 8 Stage A |
| Mention autocomplete UI (typing `@` shows a member list) | Phase 8 Stage B |
| Guest acceptance flow → automatic TeamMember(EXTERNAL) provisioning | Phase 8 Stage C |
| Bridge from `CollaborationTeamGuest` → `ExternalReviewerRoleAssignment` for evidence-scoped guests | Phase 8 Stage D |
| Daily-digest worker (currently `digest: DAILY` is honored at fanout time but no batched-email worker yet) | Phase 8 Stage E |
| Comment threading (replies) — Phase 7 stores flat comments | Phase 8 Stage F |
| Activity-feed UI upgrade to consume `activity/v2` (currently uses Phase 5 endpoint) | Phase 8 Stage G |
| Notification email delivery for non-INSTANT modes | Phase 8 Stage H |
| Access review CSV export | Phase 8 Stage I |

**Phase 8 recommendation:** ship the **topbar notification bell + mention autocomplete + guest acceptance flow** as the first three stages. Those three together make the collaboration loop feel "real-time" and complete the guest user journey.

---

## 13. What must never change

- The legacy `Team` table stays untouched (DBT-WS-04). Phase 7 added
  7 new tables alongside it; no `teamId` rename, no schema swap.
- Personal users must continue to access every Phase 7 feature
  without an Organization. The Collaboration Hub route is
  `PERSONAL_OR_ORG` — adding `ORGANIZATION_ONLY` to this surface is
  a constitutional violation. Pinned by R16.
- Guest membership stays bounded: a `CollaborationTeamGuest` row
  never automatically creates a `TeamMember` with elevated role.
  The Phase 8 acceptance flow will create `TeamMember` with role
  `EXTERNAL` — bounded, time-limited, audited.
- Mentions never notify outside the team scope. The resolution
  helper consults `CollaborationTeamMember` (status=ACTIVE) only.
- The raw comment body is plain text — no HTML rendering.

Phase 7 is **shipped**.
