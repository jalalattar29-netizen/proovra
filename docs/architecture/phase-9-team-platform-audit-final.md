# PROOVRA — Phase 9 Team Platform Audit (Consolidation + Billing Linkage)

_Status: AUDIT COMPLETE — see Section 12 for Phase 10 readiness._

## 1. Executive summary

`/teams` is a LEGACY workspace-admin surface — it is **not** the constitutional Team product. The URL `/teams` 308-redirects to `/workspaces` (per `apps/web/next.config.js`), while `/teams/[id]` still resolves directly to a pre-G5 workspace-admin member/invite/case detail page wired to `/v1/teams/*` and backed by the legacy `Team` Prisma model (which itself carries workspace tenancy, billing, and organization-binding fields). `/collaboration-teams` is the CANONICAL Team product per Phase 5–7 closure: four PageRouteGate-wrapped pages over the `CollaborationTeam*` model family (10 tables), serving both personal and organization workspaces. The two surfaces do not collide at the URL or Prisma layer, but they collide architecturally — there are two creation endpoints, two member tables, two role enums (TeamRole vs CollaborationTeamRole), and two invite-accept endpoints with confusingly similar paths. **Billing is the critical gap**: `POST /v1/teams` enforces `maxOwnedTeams`, `QUOTA_WORKSPACES`, and `QUOTA_USERS` via `assertUserCanCreateAnotherTeam` / `assertTeamSeatAvailable`, while `POST /v1/collaboration-teams` and its member/invite endpoints enforce **none of these gates** — a FREE-tier user can create unlimited CollaborationTeams and members today. Phase 10 must close billing parity, ship PayPal webhook idempotency, define a cancellation grace period, and pick a canonical Team product to deprecate the other; until that is done, the constitutional Team product is unbilled. Phase 9 closed the vocabulary split safely (legacy `/teams` references in the UI scrubbed to `/workspaces`, a regression test pinned, docs added) without renaming or restructuring any model.

## 2. Constitutional rules carried forward

1. **Team is NOT Workspace.** Team is a collaboration product; Workspace is tenancy + billing boundary. They are distinct concepts.
2. **Workspace kinds remain exactly two**: PERSONAL and ORGANIZATION. No new workspace types.
3. **Team is available in BOTH personal and organization workspaces.** Team is not enterprise-only.
4. **Personal users must be supported** in the canonical Team product without joining an Organization.
5. **Organization users must be supported** in the same canonical Team product (single surface for both).
6. **No fake workspace types** (no "team workspace", no "shared workspace", etc.) — PERSONAL or ORGANIZATION only.
7. **Do NOT rename Team to Workspace or Workspace to Team.** Vocabulary stability is constitutional.
8. **Do NOT collapse the Team and Workspace Prisma models in Phase 9.** Phase 10/11 only via a formal migration.
9. **Billing must gate the constitutional Team product** the same way it gates the legacy `Team` model.
10. **No duplicate visible Team products in navigation.** One canonical sidebar/cmd-K/all-tools entry per concept.
11. **Phase 9 is audit + small safe fixes only.** No route deletions, no schema changes, no billing/Stripe/PayPal credential changes.

## 3. /teams audit (file-by-file)

| path | purpose | meaning | verdict | notes |
|---|---|---|---|---|
| `apps/web/app/(app)/teams/[id]/page.tsx` | Workspace admin detail page (members, invites, cases, activity, danger actions). | WORKSPACE_ADMIN | LEGACY | Phase 2.6/2.6B/2.6C. PageRouteGate `routeId='admin.teams'` (TEAM_VIEW). Calls `/v1/teams/*`. Reads `Team.billingPlan` / `billingStatus`. No Team-collaboration features (assignments, guests, access grants). |
| `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx` | Phase 2.2 member offboarding with ownership transfer pre-flight. | WORKSPACE_ADMIN | LEGACY | Calls `GET /v1/teams/:id/members/:memberId/removal-impact` (ADMIN+) then `DELETE /v1/teams/:id/members/:memberId`. Backend transactionally reassigns owned evidence/cases. |
| `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx` | Phase 2.6 read-only role↔capability reference matrix (OWNER/ADMIN/MEMBER/VIEWER). | WORKSPACE_ADMIN | LEGACY | Static documentation of TeamRole hierarchy backed by backend `rbac.ts`. e2e drift test guards regeneration. |
| `apps/web/app/(app)/teams/[id]/components/DangerConfirmModal.tsx` | Phase 2.6B generic destructive-action modal (revoke invite, unlink case, delete team). | WORKSPACE_ADMIN | LEGACY | Generic on purpose — caller supplies labels, consequence text, handler. Blocks Escape/outside-click while pending. |
| `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx` | Phase 2.6C governance visibility — internal members + pending invites + external collaborators. | WORKSPACE_ADMIN | LEGACY | Calls `GET /v1/teams/:id/access-review` and `/external-collaborators` (ADMIN+). Surfaces only what backend knows; no invented analytics/risk scores. |

**Section summary.** `/teams` is LEGACY workspace-admin surface. Hypothesis CONFIRMED: `/teams` is NOT the constitutional Team product — that lives at `/collaboration-teams`. The `/teams` URL 308-redirects to `/workspaces` per `next.config.js`. The `/teams/[id]/*` pages render pre-G5 workspace-admin UX wired to `/v1/teams/*` backend endpoints. The `Team` Prisma model carries billing fields (`billingPlan`, `billingStatus`, `includedSeats`, `overSeatLimit`) and workspace governance (`organization` FK, `isPersonal` flag, `retentionPolicy`) — it IS operationally a workspace entity, not a team collaboration surface. No constitutional Team product surface appears in `/teams`; the canonical Team UX is segregated under `/collaboration-teams` to avoid URL collision with this legacy workspace-admin path.

## 4. /collaboration-teams audit (file-by-file)

| path | purpose | meaning | verdict | notes |
|---|---|---|---|---|
| `apps/web/app/(app)/collaboration-teams/page.tsx` | Teams overview list (`CreateTeamModal` + `TeamsGrid`). Accessible to personal AND org users. | TEAM_COLLABORATION | CANONICAL | Route id `workspace.collaboration_teams`. Calls `GET/POST /v1/collaboration-teams`. **No frontend capability gate; no plan gate detected** — backend service layer must enforce. |
| `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` | Team detail with query-string tabs (overview, members, invites, assignments, activity, settings). | TEAM_COLLABORATION | CANONICAL | Route id `workspace.collaboration_team_detail`. Uses `collaborationTeamRoleHasPermission` helper. SMS invite UI mentions "available on PAYG and above" but no client-side enforcement. |
| `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` | Phase 7 Collaboration Hub — comments, notifications, guests, access reviews. | TEAM_COLLABORATION | CANONICAL | Reuses route id `workspace.collaboration_team_detail`. Calls `/v1/collaboration-completion/*`. canModerate/canManage = LEAD or ADMIN. No plan gates visible; guests are not plan-gated in UI. |
| `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` | Token-based invite acceptance landing. Maps backend errors to safe surface states (expired, revoked, workspace_required, rate_limited, auth_required). | TEAM_COLLABORATION | CANONICAL | Route id `workspace.collaboration_team_invite_accept`. Calls `POST /v1/collaboration-team-invites/:token/accept`. Token in URL path only — never stored client-side. Domain `ACCOUNT` per Phases 5–7. |

**Section summary.** Four frontend pages; all correctly PageRouteGate-wrapped with matching registry IDs. Routes serve personal AND organization workspaces per constitutional rules. Backend API at `/v1/collaboration-teams*` and `/v1/collaboration-team-invites` with `TEAM_COLLABORATION` meaning. **No billing gates detected in the frontend**; capability checking delegated to backend service layer per RBAC (LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL). All pages CANONICAL; no duplicates or legacy routes found inside this subtree. Routes properly registered. Meaning verified as TEAM_COLLABORATION throughout.

## 5. Backend API audit

| method | path | handler | verdict | personalSupport | orgSupport | billingGuard | duplicationRisk |
|---|---|---|---|---|---|---|---|
| POST | `/v1/teams` | `services/api/src/routes/teams.routes.ts` | LEGACY_WORKSPACE_ADMIN | yes | yes | `assertUserCanCreateAnotherTeam` (maxOwnedTeams) + `QUOTA_WORKSPACES` | Alternative create via `POST /v1/collaboration-teams` (no billing) |
| GET | `/v1/teams` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | `GET /v1/collaboration-teams` returns same semantic shape from disjoint table |
| GET | `/v1/teams/:id` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | `getTeamWorkspaceScope`, `getWorkspaceUsage` (seat/storage limits) | `GET /v1/collaboration-teams/:teamId` |
| GET | `/v1/teams/:id/cases` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no equivalent (collab teams have no case roster surface) |
| GET | `/v1/teams/:id/invites` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | collab invites are part of team detail |
| PATCH | `/v1/teams/:id` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | `PATCH /v1/collaboration-teams/:teamId` (subset of fields) |
| DELETE | `/v1/teams/:id` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | `checkWorkspaceLegalHold` (WORKSPACE+ORG) + active Subscription block + linkedEvidenceCount block | Soft-delete alternative: `POST /v1/collaboration-teams/:teamId/archive` |
| POST | `/v1/teams/:id/invites` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | `allowsTeamWorkspace` + `QUOTA_USERS` entitlement | `POST /v1/collaboration-teams/:teamId/invites/email` (no billing) |
| DELETE | `/v1/teams/:id/invites/:inviteId` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | `POST /v1/collaboration-teams/:teamId/invites/:inviteId/revoke` |
| PATCH | `/v1/teams/:id/members/:memberId` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | `PATCH /v1/collaboration-teams/:teamId/members/:memberId` |
| GET | `/v1/teams/:id/members/:memberId/removal-impact` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent (gap) |
| DELETE | `/v1/teams/:id/members/:memberId` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | `refreshTeamSeatState` post-deletion | `DELETE /v1/collaboration-teams/:teamId/members/:memberId` (no orphan-safety) |
| POST | `/v1/teams/invites/:token/accept` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | `assertTeamSeatAvailable` + `allowsTeamWorkspace` | `POST /v1/collaboration-team-invites/:token/accept` (note path drift) |
| GET | `/v1/teams/:id/activity` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | `GET /v1/collaboration-teams/:teamId/activity` (cursor-paginated) |
| POST | `/v1/teams/:id/cases/link` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent |
| DELETE | `/v1/teams/:id/cases/:caseId` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent |
| GET | `/v1/teams/:id/external-collaborators` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent |
| GET | `/v1/teams/:id/access-review` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent |
| DELETE | `/v1/teams/:id/external-grants/:grantId` | teams.routes.ts | LEGACY_WORKSPACE_ADMIN | yes | yes | none | no collab equivalent |
| GET | `/v1/platform/rbac/matrix` | teams.routes.ts | CANONICAL_COLLAB (shared) | yes | yes | none | none — global RBAC taxonomy |
| GET | `/v1/collaboration-teams` | `services/api/src/routes/collaboration-teams.routes.ts` | CANONICAL_COLLAB | yes | yes | **none** | bifurcated team inventory vs `GET /v1/teams` |
| POST | `/v1/collaboration-teams` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **NONE — billing gap** | duplicate create surface vs `POST /v1/teams` |
| GET | `/v1/collaboration-teams/:teamId` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel detail vs `/v1/teams/:id` |
| PATCH | `/v1/collaboration-teams/:teamId` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel update |
| POST | `/v1/collaboration-teams/:teamId/archive` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | soft-delete vs hard `DELETE /v1/teams/:id` |
| POST | `/v1/collaboration-teams/:teamId/members` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **NONE — seat-gap** | no legacy equivalent (direct add) |
| PATCH | `/v1/collaboration-teams/:teamId/members/:memberId` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel role-change + suspend |
| DELETE | `/v1/collaboration-teams/:teamId/members/:memberId` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel remove (no orphan transfer) |
| POST | `/v1/collaboration-teams/:teamId/invites/email` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **none** | parallel invite |
| POST | `/v1/collaboration-teams/:teamId/invites/sms` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **none — SMS plan gate missing** | no legacy SMS channel |
| POST | `/v1/collaboration-teams/:teamId/invites/link` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **none** | no legacy link-invite |
| POST | `/v1/collaboration-teams/:teamId/invites/:inviteId/revoke` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel revoke |
| POST | `/v1/collaboration-team-invites/:token/accept` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | **none in route layer** | path-shape drift vs `/v1/teams/invites/:token/accept` |
| GET | `/v1/collaboration-teams/:teamId/activity` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | parallel activity (cursor-paginated) |
| GET | `/v1/collaboration-teams/:teamId/assignments` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | no legacy equivalent |
| POST | `/v1/collaboration-teams/:teamId/assignments` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | no legacy equivalent |
| PATCH | `/v1/collaboration-teams/:teamId/assignments/:assignmentId` | collaboration-teams.routes.ts | CANONICAL_COLLAB | yes | yes | none | no legacy equivalent |
| POST | `/v1/organizations` | `services/api/src/routes/team-management.routes.ts` | DEPRECATED | yes | yes | none | dead-end legacy vs `/v1/teams` |
| GET | `/v1/organizations` | team-management.routes.ts | DEPRECATED | yes | yes | none | orphaned vs `/v1/teams` |
| GET | `/v1/organizations/:id` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id` |
| PATCH | `/v1/organizations/:id` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id` |
| POST | `/v1/organizations/:id/members/invite` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id/invites` |
| GET | `/v1/organizations/:id/members` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id` |
| PATCH | `/v1/organizations/:id/members/:memberId/role` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id/members/:memberId` |
| DELETE | `/v1/organizations/:id/members/:memberId` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id/members/:memberId` |
| GET | `/v1/organizations/:id/invitations` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id/invites` |
| DELETE | `/v1/organizations/:id/invitations/:invitationId` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/:id/invites/:inviteId` |
| POST | `/v1/organizations/invitations/:token/accept` | team-management.routes.ts | DEPRECATED | yes | yes | none | vs `/v1/teams/invites/:token/accept` |

**Section summary.** Three route files: `teams.routes.ts` (legacy workspace-admin, billing-enforced), `collaboration-teams.routes.ts` (Phase 5–7 canonical, no billing enforcement), and `team-management.routes.ts` (deprecated, backed by an in-memory mock per audit notes). Personal users are supported everywhere; Organization is optional. The critical asymmetry: legacy `/v1/teams` enforces `maxOwnedTeams`, `QUOTA_WORKSPACES`, `QUOTA_USERS`, and seat availability; canonical `/v1/collaboration-teams` enforces none of these in the route layer. Two invite-accept endpoints exist with confusingly similar paths (`/v1/teams/invites/:token/accept` vs `/v1/collaboration-team-invites/:token/accept` — note the plural/singular drift), creating a high SDK footgun.

## 6. Prisma data model audit

| model | tableMap | concept | usedBy | phase10Recommendation |
|---|---|---|---|---|
| Team | `teams` | WORKSPACE_TENANCY | teams.routes.ts, organizations.routes.ts, workspace-usage.service.ts, workspace-billing.service.ts, billing.service.ts, billing-overview.service.ts, billing.routes.ts; CollaborationTeam FK | KEEP. Carries `billingPlan`, `billingStatus`, `includedSeats`, `overSeatLimit`, `retentionPolicy`, `organizationId`. Do not rename in Phase 10. |
| TeamMember | `team_members` | WORKSPACE_TENANCY | teams.routes.ts, rbac.ts | KEEP. Backs workspace-scoped RBAC. |
| TeamInvite | `team_invites` | WORKSPACE_TENANCY | teams.routes.ts, email.service.js | KEEP through Phase 10; remove only after all outstanding tokens expire. |
| TeamActivity | `team_activities` | WORKSPACE_TENANCY | teams.routes.ts | KEEP. Audit trail. |
| CollaborationTeam | `collaboration_teams` | TEAM_COLLABORATION | collaboration-teams.routes.ts, collaboration-team.service.ts, collaboration-completion.routes.ts, collaboration-completion.service.ts | CANONICAL. Apply billing parity in Phase 10. |
| CollaborationTeamMember | `collaboration_team_members` | TEAM_COLLABORATION | collaboration-team.service.ts, collaboration-completion.service.ts | CANONICAL. Apply seat enforcement in Phase 10. |
| CollaborationTeamInvite | `collaboration_team_invites` | TEAM_COLLABORATION | collaboration-team.service.ts, collaboration-team-delivery.service.ts | CANONICAL. Apply rate limit + SMS plan gate in Phase 10. |
| CollaborationTeamActivity | `collaboration_team_activity` | TEAM_COLLABORATION | collaboration-team.service.ts | CANONICAL. |
| CollaborationTeamComment | `collaboration_team_comments` | TEAM_COLLABORATION | collaboration-completion.service.ts, collaboration-completion.routes.ts | CANONICAL. |
| CollaborationTeamCommentMention | `collaboration_team_comment_mentions` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. |
| CollaborationTeamNotification | `collaboration_team_notifications` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. |
| CollaborationTeamNotificationPreference | `collaboration_team_notification_preferences` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. |
| CollaborationTeamGuest | `collaboration_team_guests` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. Decide guest seat-counting policy in Phase 10. |
| CollaborationTeamAccessReview | `collaboration_team_access_reviews` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. |
| CollaborationTeamAccessReviewItem | `collaboration_team_access_review_items` | TEAM_COLLABORATION | collaboration-completion.service.ts | CANONICAL. |
| CollaborationTeamAssignment | `collaboration_team_assignments` | TEAM_COLLABORATION | collaboration-team.service.ts | CANONICAL. |
| Organization | `organizations` | ORGANIZATION | organizations.routes.ts, organizations-governance.routes.ts, trust-and-governance.routes.ts; Team FK | KEEP. |
| OrganizationMembership | `organization_memberships` | ORGANIZATION | organizations.routes.ts, rbac.ts | KEEP. |
| OrganizationInvite | `organization_invites` | ORGANIZATION | organizations.routes.ts | KEEP. |
| OrganizationAuditEvent | `organization_audit_events` | ORGANIZATION | organizations.routes.ts | KEEP. |
| OrganizationPolicy | `organization_policies` | ORGANIZATION | organizations-governance.routes.ts | KEEP. |
| OrganizationSecurityPolicy | `organization_security_policies` | ORGANIZATION | evidence-review/governance.service.ts | KEEP. |
| Department | `departments` | ORGANIZATION | organizations-governance.routes.ts, governance-control-plane.service.ts | KEEP. Workspace-scoped governance (FK teamId, not org-scoped). |
| DepartmentMembership | `department_memberships` | ORGANIZATION | organizations-governance.routes.ts, governance-control-plane.service.ts | KEEP. |
| Entitlement | `entitlements` | BILLING | billing-enforcement.service.ts, plan-catalog.service.ts | KEEP. User-level. |
| Subscription | `subscriptions` | BILLING | billing.service.ts, billing-checkout.service.ts, billing.routes.ts | KEEP. User + optional Team FK. |
| EntitlementGrant | `entitlement_grants` | ENTITLEMENT | organizations-governance.routes.ts | KEEP. |
| EntitlementUsage | `entitlement_usage` | ENTITLEMENT | workspace-usage.service.ts | KEEP. |

**Section summary — clearly state whether legacy Team backs BOTH workspace and collaboration or whether they are separate tables.** The legacy `Team` table backs **workspace tenancy only**. It is the **parent** of `CollaborationTeam` (via `CollaborationTeam.workspaceId → Team.id`), but it does **not** back the constitutional Team product itself. Phase 5–7 added an entirely separate `CollaborationTeam*` family of **10 tables** (`collaboration_team_*` naming, never `team_*`). They are architecturally distinct: `Team` carries `billingPlan`, `billingStatus`, `includedSeats`, `overSeatLimit`, `retentionPolicy`, `organizationId`, `isPersonal` — workspace tenancy + billing. `CollaborationTeam` carries `teamType`, member/invite/assignment/comment children — ad-hoc project teams within a workspace. **Both are simultaneously alive in the schema**; neither is being renamed to or from the other. This is the canonical Phase 9 decision (see `docs/architecture/team-vs-workspace.md`).

## 7. Billing / plan / entitlement audit (CRITICAL)

### 7.1 Plan constants

Source: `packages/shared-billing/src/plan-catalog.ts`. Plan data is defined in the `PLAN_CAPABILITIES` constant. Plans: `FREE`, `PAYG`, `PRO`, `TEAM`.

| Plan | Member limit (per team) | Owned-team limit | Notes |
|---|---|---|---|
| FREE | 0 | 0 | No team workspaces. |
| PAYG | 0 | 0 | No team workspaces. |
| PRO | 5 | 2 | Personal workspace + up to 2 owned teams. |
| TEAM | 5 | 5 | Workspace-first; `includedSeats=5`. |

Storage: FREE = 250 MB, PAYG = 5 GB, PRO = 100 GB, TEAM = 500 GB.

### 7.2 Enforcement matrix

| Check | Old `/v1/teams` (legacy) | New `/v1/collaboration-teams` (canonical) |
|---|---|---|
| Plan-based `maxOwnedTeams` on team create | YES — `assertUserCanCreateAnotherTeam` at teams.routes.ts:201–246; calls `getPlanCapabilities(plan).maxOwnedTeams`; blocks at line 225–239 | **NO — INCONCLUSIVE / NOT IMPLEMENTED**. No separate creation endpoint found enforcing plan limits; create surface in collaboration-teams.routes.ts has no equivalent gate |
| Email-invite plan gate | YES — `allowsTeamWorkspace` + `QUOTA_USERS` entitlement on `POST /v1/teams/:id/invites` | **NO** — `POST /v1/collaboration-teams/:teamId/invites/email` does not gate |
| SMS invite plan gate (PAYG+) | N/A (no SMS channel in legacy) | **NOT IMPLEMENTED** — SMS route exists but no plan-tier check; email is non-blocking `try/catch` |
| Link invite plan gate | N/A | **NOT IMPLEMENTED** — `POST /v1/collaboration-teams/:teamId/invites/link` has no gate |
| Guest invite plan gate / seat counting | N/A | **PARTIAL** — `/v1/collaboration-teams/:teamId/guests/invite` exists but `getTeamMemberLimit` / `assertTeamSeatAvailable` only count `TeamMember` rows; guests may bypass member cap |
| Seat counting mode | Counted on invite **ACCEPTANCE** (`assertTeamSeatAvailable` at teams.routes.ts:1646); creation explicitly not blocked when full (line 891–914) | None — neither create nor accept currently calls `assertTeamSeatAvailable` |
| Canceled-subscription handling | Personal: `setPersonalPlan(userId, FREE)` (billing.routes.ts:588). Team: `cancelTeamPlan()` (billing.routes.ts:583–586). Team workspace NOT deleted; `billingPlan`/`billingStatus` reset; `overSeatLimit=true` may persist | None — collaboration teams have no separate cancellation handling |
| PayPal `BILLING.SUBSCRIPTION.UPDATED`/`ACTIVATED` webhook | YES — `syncPlanForSubscription()` routes to `activateTeamPlan()` with `plan=TEAM`, `teamId` (webhooks.routes.ts:812–822). **No durable idempotency table** | Same — no separate handler |
| Storage addon webhook validation | `assertWebhookStorageAddonAllowed()` called on accept (webhooks.routes.ts:450). Logs warning but does not fail if team lost TEAM tier between order and webhook | Same |

### 7.3 Gaps

- Seat limit enforcement only on invite ACCEPTANCE, not CREATION. Invites can pile up, burning quota before any member joins. Per spec comment this is intentional, but creates an audit visibility gap.
- No SMS invite gating. SMS delivery is not effectively gated by plan; email delivery is non-blocking (`try/catch`). No plan-level gate on invitation delivery mechanism.
- Guest user seat counting unclear. `/v1/collaboration-teams/:teamId/guests/invite` exists but no explicit seat enforcement or guest-vs-member distinction in `assertTeamSeatAvailable()`.
- PayPal webhook idempotency. No durable idempotency check for PayPal `BILLING.*` events like Stripe has with `stripe_webhook_event`. Duplicate webhook deliveries will re-sync subscription state (not catastrophic but not idempotent).
- Canceled-subscription entitlements. When `subscription.status=CANCELED`, personal plan immediately falls to FREE (line 588). Team workspace remains visible in billing console but inoperable. No explicit grace period or reactivation window documented.
- Storage addon billing cycle enforcement. Legacy monthly storage addons can exist; new addons are `ONE_TIME` only. Webhook handler logs a warning for subscription-based storage addons (webhooks.routes.ts:565–575) but does not fail or attempt recovery.
- Team over-seat-limit state. When `team.overSeatLimit=true`, no explicit remediation route. Existing members can remain; new invites can be created but not accepted. Unclear how operator recovers a team from this state without upgrading subscription.
- Plan downgrade boundary. PRO allows 2 teams + 5 members each; TEAM allows 5 teams + 5 members each. No route explicitly prevents creating 3 teams on PRO or downgrading from TEAM to PRO if user has 4 teams. Workspace existence appears decoupled from current plan state.

### 7.4 Risks

- **CRITICAL — Invite explosion DoS.** Unpaid FREE user can issue unlimited invites to a team, consuming email quota / infrastructure with zero cost or seat commitment. Invites consume seats only on acceptance.
- **HIGH — Subscription cancellation orphans workspaces.** Teams with active members but `CANCELED` billing status remain operational with `overSeatLimit=true`. Operator must manually manage. No UI prevents workspace use or forces remediation.
- **HIGH — PayPal webhook non-idempotency.** Duplicate `subscription.updated` events (common in PayPal) re-execute `activateTeamPlan()` or `cancelTeamPlan()` unnecessarily. State-flapping risk during retry storms.
- **MEDIUM — Guest user entitlement gap.** `/v1/collaboration-teams/:teamId/guests/invite` exists but seat-counting (`getTeamMemberLimit`, `assertTeamSeatAvailable`) only knows about `TeamMember`, not any Guest table. Guests may bypass member limit if counted separately.
- **MEDIUM — Plan downgrade without workspace re-validation.** No route prevents a PRO user (2 teams) from being manually set to FREE (0 teams) without deleting or transferring their teams. Workspace state can become inconsistent with billing entitlement.
- **MEDIUM — Storage addon validation on webhook only.** `assertWebhookStorageAddonAllowed()` is called (webhooks.routes.ts:450). If team loses TEAM billing status between order capture and addon acceptance, webhook handler logs warning but does not fail. Addon still created.
- **LOW — Email delivery non-blocking.** Team invitation emails are fire-and-forget (`try/catch` at teams.routes.ts:930–947, 1043–1056). Failed emails do not surface to user.
- **LOW — No redundancy in PayPal plan ID mapping.** `resolvePayPalPlanId()` looks up env vars. If env var is wrong or missing, subscription creation fails at plan activation time, not checkout time.

### 7.5 Phase 10 blocking debt

- Implement durable PayPal webhook idempotency: add `paypal_webhook_event` table with unique constraint on `paypal_event_id`, similar to `stripe_webhook_event`. Deduplicate before calling `syncPlanForSubscription()`.
- Add team over-seat-limit remediation UI: operator must be able to view teams in `overSeatLimit` state and either (a) upgrade subscription, (b) remove members, or (c) freeze team to read-only.
- Seat counting parity for guests: confirm whether guests consume the team member limit. If yes, update `getTeamMemberLimit()` and `assertTeamSeatAvailable()` to count both `TeamMember` + `Guest` rows. If no, document the policy explicitly.
- Plan downgrade validation: add pre-flight check in `setPersonalPlan()` and `activateTeamPlan()` to ensure current workspace count does not exceed new plan's `maxOwnedTeams`. Either block the plan change or auto-delete/transfer excess workspaces.
- Subscription cancellation grace period: define a grace period (e.g., 30 days) where `CANCELED` subscriptions remain operationally `ACTIVE`. After grace expires, `billingStatus` becomes `LOCKED` (read-only team). Document in UI.
- SMS invite implementation: if SMS invites are planned, implement gating: FREE/PAYG cannot use SMS, PRO/TEAM can. Add SMS route alongside email; treat as gatable feature like Reports / VerificationPackage.
- Invite rate limiting: add per-user-per-team invite rate limit (e.g., 10/hour) to prevent invite explosion DoS. Return 429 if exceeded.
- Webhook signature audit close-loop: ensure all webhook processing failures (custom_id parse failures, `syncPlanForSubscription` exceptions) emit `SecurityEvent`, not just signature failures.

## 8. Navigation / route visibility audit

| Surface | Routes visible | Confusing? | Notes |
|---|---|---|---|
| Sidebar (`AppSidebarV2.tsx`) | `admin.teams @ /workspaces` (icon: Users, label: "Workspaces"); `workspace.collaboration_teams @ /collaboration-teams` (icon: needs custom, label: "Teams") | No | Two distinct primary entries: Workspaces (GOVERNANCE pillar) and Teams (CASES pillar). No duplicate labels. |
| Command Palette (cmd-K) | `admin.teams @ /workspaces` label "Workspaces" domain ACCOUNT; `workspace.collaboration_teams @ /collaboration-teams` label "Teams" domain PERSONAL_WORKSPACE | No | Both have `commandPaletteVisible: true`; indexed once each. |
| All Tools (`/tools`) | `admin.teams @ /workspaces` in "Organization & Settings" group; `workspace.collaboration_teams @ /collaboration-teams` in "Cases & Review" group | No | Clear semantic separation by domain (ACCOUNT vs PERSONAL_WORKSPACE). |
| Account menu / Topbar (`AppTopbarV2.tsx`) | Workspace switcher "Manage organizations →" → `/workspaces`; Actions section: Create org / Join org / Manage orgs → `/workspaces` | No | Topbar workspace switcher uses `/workspaces` (admin.teams). No Teams entry in account menu; Teams discovered via sidebar + cmd-K. |
| Billing / Plan pages | (none) | No | Billing page does not surface Teams/Workspaces routing. |

**Verdict.** No duplicate Team links. `admin.teams @ /workspaces` is the workspace-admin surface, labeled "Workspaces" everywhere; `workspace.collaboration_teams @ /collaboration-teams` is the constitutional Team product, labeled "Teams" everywhere. The legacy `/teams` path 308-redirects to `/workspaces` via `next.config.js`; `/teams/[id]` still resolves directly for backward-compatible deep links. **Hidden-duplicate risk: NONE.** Recommendations: update `routeAccessResolver.ts` and several UI files where href `"/teams"` still appears in code (the redirect masks the behavior, but the literal string causes future-reader confusion). Personal-tier users see both "Workspaces" and "Teams" in the sidebar — this is by design (Team is available in both personal and organization workspaces per constitutional rule 3).

## 9. User journey audit

| # | Journey | Classification | Evidence |
|---|---|---|---|
| 1 | Fresh personal user (no org, FREE plan) lands on app | works | Sidebar shows "Workspaces" + "Teams". Personal workspace auto-created at signup. Both routes accessible. |
| 2 | Personal PRO user opens Teams | works | `workspace.collaboration_teams` is PERSONAL_WORKSPACE domain; PRO plan allows up to 2 owned teams. |
| 3 | Personal user creates Team | **missing billing check** | `POST /v1/collaboration-teams` enforces no `maxOwnedTeams` gate (Section 5/7). FREE user can create unlimited CollaborationTeams. |
| 4 | Personal user invites teammate by email | **missing billing check** | `POST /v1/collaboration-teams/:teamId/invites/email` has no plan gate or rate limit; email delivery is fire-and-forget. |
| 5 | Personal user invites teammate by SMS | **missing billing check** + confusing | UI mentions "available on PAYG and above" but no client-side enforcement; backend SMS route has no plan-tier gate. |
| 6 | Personal user creates reusable invite link | **missing billing check** | `POST /v1/collaboration-teams/:teamId/invites/link` is ungated; `maxUses` 1–1000 / `expiresInDays` 1–30 configurable without plan enforcement. |
| 7 | Recipient accepts an invite via token | works (with caveat) | `POST /v1/collaboration-team-invites/:token/accept` validates token + workspace scope server-side. **Caveat:** path-shape collision with `/v1/teams/invites/:token/accept` is a duplicate-route footgun. |
| 8 | Organization member creates a Team in the org workspace | works (no billing check) | Same canonical route `/collaboration-teams`; same ungated create endpoint. |
| 9 | Organization admin manages a Team | works | `workspace.collaboration_team_detail` tabs (members, invites, assignments, settings) gated by `LEAD`/`ADMIN` server-side. |
| 10 | Billing-limited user hits a limit | **broken on canonical Team product** | Legacy `/v1/teams` correctly returns 403 / quota error. Canonical `/v1/collaboration-teams` does NOT — the user never hits a limit until member acceptance, and even then the seat gate is not wired (Section 5). |
| 11 | Canceled-subscription user tries Team feature | confusing | Team workspace remains operational with `overSeatLimit=true`; no UI surface to recover. No grace-period definition. |
| 12 | Guest / external collaborator flow | **missing billing check** + security ambiguity | `/v1/collaboration-teams/:teamId/guests/invite` exists but seat-counting only inspects `TeamMember`; guests may bypass member cap. Also, legacy `/v1/teams/:id/external-grants/:grantId` revoke is ADMIN+ only (correct). |

**Source-of-truth pointers.** Journeys 3–6 + 10 + 12 are blocked by the Section 7.5 Phase 10 blocking debt; journey 7 is the duplicate-accept-endpoint footgun called out in Section 10; journey 11 is the cancellation-grace-period gap called out in Section 7.

## 10. Consolidation decision

- **Canonical Team collaboration product route:** `/collaboration-teams`
- **Legacy workspace-admin route:** `/workspaces` (with `/teams` 308 redirecting to `/workspaces`; `/teams/[id]` still resolves directly as legacy workspace-admin detail).

**Duplicates.**

- `POST /v1/teams` (Team model, billing-enforced) vs `POST /v1/collaboration-teams` (CollaborationTeam model, NO billing enforcement) — same user can "create a team" via either, only one is plan-gated.
- `GET /v1/teams` (list) vs `GET /v1/collaboration-teams` (list) — both return "teams visible to the actor" from disjoint tables; clients/agents cannot tell which is authoritative.
- Member-management duplicated: `PATCH/DELETE /v1/teams/:id/members/:memberId` (TeamMember + orphan-safe transfer) vs `PATCH/DELETE /v1/collaboration-teams/:teamId/members/:memberId` (CollaborationTeamMember, no orphan transfer).
- Invite-accept duplicated: `POST /v1/teams/invites/:token/accept` vs `POST /v1/collaboration-team-invites/:token/accept` (path uses singular `team` — easy to mistype).
- Activity duplicated: `GET /v1/teams/:id/activity` (50-item cap, no cursor) vs `GET /v1/collaboration-teams/:teamId/activity` (cursor-paginated).
- ENTIRE `/v1/organizations*` family (team-management.routes.ts) is DEPRECATED and overlaps with both — backed by an in-memory mock service per audit notes.
- `routeAccessResolver.ts` lines 162 + 187 produced recovery CTAs labeled "Create or switch organization" and "Open workspaces" but both pointed to href `/teams` (legacy alias); fixed in Section 11.
- Sidebar shows BOTH "Workspaces" and "Teams" as primary entries — not technically duplicate labels but a personal-tier user with no Org will reasonably ask "what's the difference?"

**Redirects required.**

| from | to | reason |
|---|---|---|
| `/teams` | `/workspaces` | ALREADY EXISTS in `apps/web/next.config.js` lines 110–114 (permanent 308). Do not duplicate. |
| `/teams/[id]` | `/workspaces/[id]` | Currently `/teams/[id]` renders the legacy workspace-admin detail page directly (no redirect). To make `/workspaces` the single canonical workspace-admin family, `/teams/[id]` should 308 to `/workspaces/[id]`. **Phase 10 work** — only safe once `/workspaces/[id]` handler exists. |
| `/v1/organizations*` (entire family) | (no redirect — backend deprecation) | team-management.routes.ts is backed by an in-memory mock; not an HTTP redirect candidate. Phase 10 should remove the route file. |

**Routes to hide from discovery.**

- `admin.teams` — keep `sidebarEligible=true`, `allToolsVisible=true` (Workspace administration is a real surface); no hide needed.
- `workspace.collaboration_team_detail`, `workspace.collaboration_team_hub`, `workspace.collaboration_team_invite_accept` — already correctly set `commandPaletteVisible=false`, `allToolsVisible=false`, `sidebarEligible=false` (`routeRegistry.ts` lines 768–770, 784–786, 799–801). No change.
- **No nav entries need to be hidden in Phase 9.** The duplication is conceptual (two team-shaped APIs), not navigational.

**Routes to keep for backcompat.**

- `/teams` (root) — already 308-redirects to `/workspaces`. Keep redirect indefinitely.
- `/teams/[id]` — page file still renders legacy detail. Keep until Phase 10 ships `/workspaces/[id]` replacement + redirect.
- `POST /v1/teams/invites/:token/accept` — keep until all outstanding TeamInvite tokens expire.
- `GET /v1/teams`, `GET /v1/teams/:id`, `DELETE /v1/teams/:id`, and member endpoints — keep through Phase 10 because the legacy `Team` model still backs `Subscription` / `Entitlement` FKs and workspace-admin UX has no replacement yet.
- `GET /v1/platform/rbac/matrix` — keep permanently; move to a non-`/v1/teams` handler file in Phase 10.

**Routes to remove later.**

- `/v1/organizations*` (entire team-management.routes.ts, 9 endpoints) — backed by in-memory mock. Delete in Phase 10 after UI references are scrubbed.
- `apps/web/app/(app)/teams/[id]/page.tsx` + components (MemberRemovalDialog, TeamPermissionMatrix, DangerConfirmModal, TeamAccessReviewCard) — remove once `/workspaces/[id]` is built and a redirect lands.
- `/v1/teams/:id/external-grants/:grantId`, `/v1/teams/:id/external-collaborators`, `/v1/teams/:id/access-review` — fold into `/v1/collaboration-teams` or `/v1/workspaces` in Phase 10; remove `/v1/teams/*` aliases in Phase 11.
- Phase 11 only: collapse `Team` Prisma model into the workspace tenancy contract (rename to `Workspace` at DB layer OR formalize Team-as-workspace). **Do NOT do this in Phase 9 or 10.**
- `ICON_BY_ROUTE_ID` custom icon for `workspace.collaboration_teams` labeled "(needs custom)" — replace in Phase 10.

## 11. Small safe fixes applied in Phase 9

| kind | file | status | reason / changes |
|---|---|---|---|
| LABEL_CLARIFICATION | `apps/web/lib/navigation/routeAccessResolver.ts` (line 162) | APPLIED | NEEDS_ORGANIZATION primaryAction href `"/teams"` → `"/workspaces"`. Label preserved. Pure string-literal change; runtime unchanged due to existing 308. |
| LABEL_CLARIFICATION | `apps/web/lib/navigation/routeAccessResolver.ts` (line 187) | APPLIED | NEEDS_PERSONAL_OR_ORG primaryAction href `"/teams"` → `"/workspaces"`. Label "Open workspaces" preserved. |
| LABEL_CLARIFICATION | `apps/web/app/(app)/organizations/page.tsx` (lines ~239, ~460, ~602) | APPLIED | Three Link hrefs `"/teams"` → `"/workspaces"` in Workspace-administration cross-links. Behavior unchanged by redirect. |
| LABEL_CLARIFICATION | `apps/web/components/command-center/CommandCenter.tsx` (line 4966) | APPLIED | Empty-state "Workspace administration →" href `"/teams"` → `"/workspaces"`. `data-action="empty-open-teams"` preserved for any tests that key off it. |
| LABEL_CLARIFICATION | `apps/web/lib/platform-context/CapabilityDegradedPanel.tsx` (line 107) | APPLIED | Recovery panel Link href `"/teams"` → `"/workspaces"`. |
| LABEL_CLARIFICATION | `apps/web/app/(app)/teams/[id]/page.tsx` (lines ~1201, ~1636) | APPLIED | Two back-link hrefs `"/teams"` → `"/workspaces"`; button text "Back to Teams" → "Back to Workspaces". |
| LABEL_CLARIFICATION | `apps/web/app/invite/[token]/page.tsx` (line 167) | SKIPPED | Would route a button labeled "Go to Teams" to `/workspaces`, actively conflating Team with Workspace (forbidden by constitutional rules 1, 7). The invite-accept flow IS a Team collaboration entry; `/teams` is semantically correct here. Re-scope in a future phase. |
| ROUTE_REGISTRY_METADATA | `apps/web/lib/navigation/routeRegistry.ts` (near line 1120, id `admin.teams`) | APPLIED | Added clarifying comment: "Phase 9 audit note: route id is historical; canonical href is `/workspaces`; this is workspace-admin tenancy, NOT the constitutional Team product (see id=workspace.collaboration_teams)." Pure comment, no behavior change. |
| NEW_TEST | `apps/web/lib/navigation/__tests__/phase9-team-vs-workspace-vocabulary.test.ts` (new file) | APPLIED | Asserts exactly one ROUTE_REGISTRY entry with `href="/collaboration-teams"` and id `workspace.collaboration_teams`, exactly one with `href="/workspaces"` and id `admin.teams`, and zero entries using `href="/teams"`. Uses `node:test` + `node:assert`; no new deps. |
| NEW_TEST | `apps/web/__tests__/phase9-teams-redirect-backcompat.test.ts` (new file) | APPLIED | Asserts `next.config.js` still declares `{ source: '/teams', destination: '/workspaces', permanent: true }`. Reads next.config.js as text to avoid pulling the Next build pipeline. |
| NEW_TEST | `services/api/test/phase9-collaboration-team-billing-parity.test.ts` (new file) | APPLIED | Pins Phase 9 Billing audit finding under `describe.skip(...)` with TODO referencing Phase 10. One active assertion pins the current gap so a silent fix without removing `.skip` fails CI. |
| DOC | `docs/architecture/team-vs-workspace.md` (new file) | APPLIED | Canonical Phase 9 architectural decision: Team-the-product lives at `/collaboration-teams`; `/workspaces` is workspace-admin tenancy; `/teams` is a permanent 308; `/v1/organizations*` is deprecated; rename + enterprise-only prohibitions honoured. |
| DOC | `docs/operations/migration-inventory.md` (append) | APPLIED | New section "Carry-over debt for Phase 10/11 — Team ↔ CollaborationTeam architectural bifurcation" (lines 1063–1154). Records five carry-over items CO-10/11-T1 through CO-10/11-T5. |

## 12. Phase 10 readiness checklist

- [x] Canonical Team product route confirmed (`/collaboration-teams`)
- [x] Legacy workspace-admin route documented (`/workspaces`; `/teams` 308 to `/workspaces`)
- [ ] Billing linkage audited — Phase 10 blocking debt items from Section 7.5:
  - [ ] Durable PayPal webhook idempotency table
  - [ ] Team over-seat-limit remediation UI
  - [ ] Seat counting parity for guests
  - [ ] Plan downgrade pre-flight validation
  - [ ] Subscription cancellation grace period definition + implementation
  - [ ] SMS invite plan gating
  - [ ] Per-user-per-team invite rate limit (anti-DoS)
  - [ ] Webhook processing failure SecurityEvent emission close-loop
- [x] Personal users supported in canonical Team route (`PERSONAL_WORKSPACE` domain on `workspace.collaboration_teams`)
- [x] Organization users supported in canonical Team route (same route)
- [x] No duplicate visible Team products in nav (Section 8 verdict)
- [x] Team is not Workspace (constitutional — `Team` table is workspace tenancy; `CollaborationTeam` is the product; both kept separate)
- [x] No fake workspace types (only PERSONAL + ORGANIZATION)
- [ ] Validation passed (see Section 14 — 2 blocking failures in `services/api/test`, all other suites green)

## 13. Phase 10 recommended scope

- BILLING PARITY: apply `assertUserCanCreateAnotherTeam`, `getPlanCapabilities(plan).maxOwnedTeams`, and equivalents of `QUOTA_USERS` / `QUOTA_WORKSPACES` entitlement assertions to `POST /v1/collaboration-teams` so the constitutional Team product actually obeys plan limits.
- SEAT PARITY: apply `assertTeamSeatAvailable()` (or a CollaborationTeam-aware equivalent) to `POST /v1/collaboration-teams/:teamId/members` and `POST /v1/collaboration-team-invites/:token/accept`.
- SEAT ACCOUNTING FOR GUESTS: decide whether `CollaborationTeamGuest` counts against team member limits; update `getTeamMemberLimit` + `assertTeamSeatAvailable` accordingly; document the policy.
- ORPHAN-SAFETY PARITY: bring the `removal-impact` pre-flight + atomic ownership transfer (evidence + cases + open assignments) to `DELETE /v1/collaboration-teams/:teamId/members/:memberId`.
- WORKSPACE DETAIL UI: build `apps/web/app/(app)/workspaces/[id]/page.tsx` as a first-class replacement for the legacy `/teams/[id]` surface; add `/teams/[id] → /workspaces/[id]` redirect; retire the legacy page in Phase 11.
- UNIFIED INVITE ACCEPT: deprecate one of the two accept endpoints (the singular/plural drift is a footgun). Pick a canonical accept route family.
- REMOVE `/v1/organizations*` (team-management.routes.ts, 9 endpoints): backed by an in-memory mock and overlapping with `/v1/teams` + `/v1/collaboration-teams`.
- NEW CAPABILITY: `TEAM_CREATE` (or `COLLABORATION_TEAM_CREATE`) so creation can be plan-gated at the registry layer in addition to the service layer.
- RBAC HARMONIZATION: decide whether `TeamRole` (OWNER/ADMIN/MEMBER/VIEWER) and `CollaborationTeamRole` (LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL) should converge, or document the intentional split. Today both ship; SDK consumers must implement two role models.
- ICON + LABEL POLISH: Workspaces icon stays Users; Collaboration Teams needs a distinct icon (Navigation audit flagged "needs custom"). Do not ship two Team-shaped sidebar items sharing a generic icon.

## 14. Validation matrix

| command | result | notes |
|---|---|---|
| `cd D:/digital-witness/services/api && npx tsc --noEmit` | PASS | Exit 0. No type errors. No stdout/stderr. |
| `cd D:/digital-witness/apps/web && npx tsc --noEmit` | PASS | Exit 0. No type errors. Log file zero bytes. |
| `cd D:/digital-witness/services/api && npx vitest run` | **FAIL** | Exit 1. 277 test files: 274 passed, 2 failed, 1 skipped. 12944 tests: 12886 passed, **2 failed**, 56 skipped. Both failures are `/teams` vs `/workspaces` vocabulary mismatches — tests still reference legacy route id and a primaryAction href of `/teams`. |
| `cd D:/digital-witness/services/worker && npx vitest run` | PASS | Exit 0. 23 test files / 559 tests, all passed. Duration 2.00 s. |
| `cd D:/digital-witness && pnpm --filter @proovra/shared test` | PASS | Exit 0. 703 tests passed, 0 failed, 0 skipped. |

**Blocking failures (require Phase 10 follow-up or fast-follow patch):**

- `test/phase-38-6-route-exposure.test.ts > Phase 38.6 — resolveRouteAccess workflow independence > NEEDS_ORGANIZATION when route is ORGANIZATION_ONLY but actor is in PERSONAL` — `AssertionError: expected '/workspaces' to be '/teams'` (`primaryAction.href`; src line 192). Test still asserts the legacy `/teams` literal; resolver was correctly updated to `/workspaces` in Phase 9. The test, not the resolver, is the staleness.
- `test/phase-r13-route-persona-matrix.test.ts > Phase R13 — admin.teams (/workspaces) keeps its canonical label > label remains 'Workspaces' (rule: this page IS the personal + org list, NOT a Team page)` — `AssertionError: admin.teams not in registry: expected undefined to be defined` (src line 435). Test expectation under-specifies registry lookup; Phase 10 should refresh the assertion shape.

## 15. Risks + remaining debt

**Risks (carry-forward).**

- INVITE EXPLOSION DoS: FREE-tier user can issue unlimited team invites; seat check at acceptance only. Production impact: bill shock + reputation damage if SMS gateway misused.
- BIFURCATED TEAM CREATION: same user can create a legacy `Team` via `POST /v1/teams` (billing-enforced) and unlimited CollaborationTeams via `POST /v1/collaboration-teams` (NOT billing-enforced). Revenue leak + plan-limit bypass live in production.
- SUBSCRIPTION CANCELLATION ORPHANS WORKSPACES: teams with CANCELED billing remain operational with `overSeatLimit=true`. No grace period; no automated remediation.
- PAYPAL WEBHOOK NON-IDEMPOTENCY: no dedup table for PayPal events. Retried webhooks re-execute plan activation/cancellation. State-flapping risk.
- CONFUSING VOCABULARY FOR PERSONAL USERS: sidebar shows both "Workspaces" and "Teams" to a personal-only user with no Organization. Adoption friction.
- UNGATED SMS INVITES: spec says PAYG+ but UI does not enforce and backend does not gate. Either dead code or unbilled feature.
- LEGACY `/v1/organizations*` LIVE BUT BACKED BY MOCK: any client still calling these routes gets non-durable data.
- PRISMA `Team` MODEL CARRIES BOTH WORKSPACE + BILLING STATE: any future refactor that splits these concerns must migrate `Subscription.teamId`, `Entitlement`, `LegalHold`, and `Case.teamId` references atomically. Fragile.
- TWO INVITE-ACCEPT ENDPOINTS WITH ALMOST-IDENTICAL PATHS: high footgun rate for SDK callers and AI agents.
- ROUTE METADATA RELIES ON UNGATED CAPABILITIES: `workspace.collaboration_teams` has `requiredCapabilities=[]`. A future PageRouteGate refactor that trusts `requiredCapabilities` alone would silently expose paid features to FREE users.

**Remaining debt (Phase 10 blocking).**

- CRITICAL BILLING GAP: `POST /v1/collaboration-teams` enforces NO plan limits. Must be fixed before Phase 10 ships new Team UX.
- CRITICAL SEAT GAP: `POST /v1/collaboration-teams/:teamId/members` (direct add) + email/SMS/link invite endpoints do not call `assertTeamSeatAvailable()`.
- CRITICAL INVITE EXPLOSION DoS: invites are seat-checked at acceptance only. Add per-user-per-team rate limit (e.g., 10/hour) → 429 on exceed.
- CRITICAL PAYPAL WEBHOOK IDEMPOTENCY: no `paypal_webhook_event` dedup table.
- HIGH GUEST SEAT BLINDNESS: `CollaborationTeamGuest` may bypass member caps.
- HIGH OVER-SEAT-LIMIT REMEDIATION MISSING: no UI surface or admin route.
- HIGH PLAN DOWNGRADE VALIDATION MISSING: `setPersonalPlan()` does not validate current workspace count vs new plan's `maxOwnedTeams`.
- MEDIUM CANCELED-SUBSCRIPTION POLICY UNDOCUMENTED: define + implement grace period (e.g., 30 days, then read-only).
- MEDIUM STORAGE ADDON FAILURE MODE: `assertWebhookStorageAddonAllowed()` only logs a warning; addon is still created if team lost TEAM tier mid-flow.
- MEDIUM EMAIL DELIVERY IS FIRE-AND-FORGET: failed invite emails are silently swallowed. Add delivery-status surface.
- ARCHITECTURAL: two creation endpoints, two member tables, two role enums, two invite tables, two accept endpoints. Phase 10 must pick the canonical pair and START deprecating the other.

## 16. Sign-off

Phase 9 closed the Team vs Workspace vocabulary question without renaming or restructuring any model: the constitutional Team product lives at `/collaboration-teams` on the `CollaborationTeam*` model family, the legacy workspace-admin surface lives at `/workspaces` on the `Team` model with `/teams` 308-redirecting in for backcompat, and the deprecated `/v1/organizations*` family is flagged for Phase 10 removal. UI references to the legacy `/teams` URL were scrubbed in seven files (one declined as out-of-scope), a route-registry clarification comment was added, three regression tests were landed (including one `.skip()` marker pinning the billing-parity gap), and two architecture/operations docs were written. Two backend tests fail today because they still assert the pre-fix legacy strings; the production resolvers are correct. **Phase 10 must close the critical billing/seat/idempotency debt enumerated in Sections 7.5 and 15 before the canonical Team product can be commercialized** — until then, `POST /v1/collaboration-teams` and its member/invite endpoints accept FREE-tier traffic with no plan enforcement, and PayPal webhook retries can flap subscription state. Audit is complete; the path forward is documented; the schema and routes were left intact per Phase 9 binding rules.
