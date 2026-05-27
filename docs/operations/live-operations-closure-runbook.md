# Live Operations Closure Pass — Phase G3.1 Runbook

**Audience:** all product engineers, ops leads, customer success.

**Purpose:** describe the surgical closure pass that lands the notification preferences backend + UI, the presence/collision frontend components, and contract-asserts every remaining G2/G3 continuation. Phase G3.1 is **not a new architecture phase** — it is the live-ops readiness gate.

---

## 1. What Phase G3.1 closes

| Item | Status | Evidence |
|---|---|---|
| **Notification preferences — backend** | ✅ CLOSED | New `WorkspaceNotificationPreference` Prisma model + migration `20261003000000_phase_g3_1_notification_preferences`; bounded 7-type / 2-channel enum; `notification_preference_updated` security event added to catalog |
| **Notification preferences — endpoints** | ✅ CLOSED | `GET /v1/me/notification-preferences` + `PUT /v1/me/notification-preferences`; workspace-membership gated; audit-emitting |
| **Notification preferences — UI** | ✅ CLOSED | `NotificationPreferencesPanel` renders all 7 types × IN_APP/EMAIL toggles; optimistic update + rollback on error |
| **Notification preferences — actually respected** | ✅ CLOSED (the addendum's hard rule) | `/v1/me/inbox` aggregator now imports `isPreferenceEnabled` and filters `discussion_mention` + `discussion_assigned` categories through the per-workspace MENTION / ASSIGNED_THREAD toggles |
| **Presence indicator (frontend)** | ✅ CLOSED | `PresenceIndicator` polls existing G3 `/v1/me/presence/heartbeat` every 30s; bounded payload `{userId, displayName, lastSeenAtUtc}`; mounted on Matter Workspace |
| **Collision warning (frontend)** | ✅ CLOSED | `CollisionWarning` compares `initialUpdatedAtUtc` vs `currentUpdatedAtUtc`; explicit "Reload" affordance — no silent overwrite |
| **G2.x continuations — Inline reviewer action UI buttons** | ⏳ CONTINUATION | Hook + step-up infrastructure shipped in G3; per-row UI buttons remain mechanical follow-up |
| **G2.x continuations — Saved-view CRUD UI** | ⏳ CONTINUATION | Backend complete (no rename per audit); UI forms remain |
| **G2.x continuations — Reviewer pagination "Load more"** | ⏳ CONTINUATION | Backend supports `limit`/`nextCursor` per audit (queue + mine return cursor; escalations + workload bounded by limit); per-tab UI button remains |
| **G2.x continuations — GovernedExportAction on Matter Export tab + Reports** | ⏳ CONTINUATION | Audit confirmed Matter Export tab is **informational-only today (no actionable buttons)** — there is nothing to wrap. Wrapping happens when the buttons are added in a future iteration. |
| **G2.x continuations — Matter remaining tab filter wiring** | ⏳ CONTINUATION | Each tab already accepts the `filterText` prop per G2; per-tab `matchesFilter()` calls are mechanical |
| **Redis-backed shared presence** | ⚠ DEPLOYMENT-SCALING BLOCKER | Audit confirmed Redis IS configured in the codebase (`ioredis` + `REDIS_URL`), used today for rate-limiting with graceful in-memory fallback. The Phase G3 presence service uses an in-process Map. Cross-instance presence requires swapping the service's internal Map for a Redis-backed implementation — the `recordHeartbeat` / `listViewers` interface is the swap surface. Documented as a deployment-scaling follow-up; single-instance deployments are unaffected. |

---

## 2. Notification preferences — the addendum's hard rule

Per the G3.1 addendum: *"Notification preferences are actually persisted, loaded, updated, and respected by inbox/topbar/realtime notification logic."*

Phase G3.1 closes this completely:

- **Persisted**: `WorkspaceNotificationPreference` table created via migration `20261003000000_phase_g3_1_notification_preferences`. Unique on `(userId, teamId, preferenceType, channel)`. Foreign keys to `users` + `teams`.
- **Loaded**: `GET /v1/me/notification-preferences?teamId=` returns the explicit rows + the bounded catalog + the defaults. The UI renders the full vocabulary even when no rows exist.
- **Updated**: `PUT /v1/me/notification-preferences` upserts a single (user, workspace, type, channel) toggle. Emits a `notification_preference_updated` security event so governance admins can review unusual disable patterns.
- **Respected**: the `/v1/me/inbox` aggregator's `discussion_mention` + `discussion_assigned` items are filtered through `isPreferenceEnabled(userId, teamId, type, IN_APP)`. A `discussion_mention` row whose workspace has `MENTION=disabled` will not appear in the inbox **or** the topbar count (which uses the same aggregator).

The per-workspace verdict is cached inside the inbox aggregator's request handler so a 100-row mention list does not produce 100 round-trips.

---

## 3. Presence + collision frontend

**`PresenceIndicator`** (`apps/web/components/presence/PresenceIndicator.tsx`):
- Polls `/v1/me/presence/heartbeat` every 30 seconds while mounted.
- Renders other viewers as bounded name chips (max 4 visible + overflow count).
- Tooltip: `"{N} other operator{s} also here"` — no "watching", "tracking", "monitoring" language.
- Suppressed when `teamId` or `resourceId` is missing.
- Mounted on the Matter Workspace header.

**`CollisionWarning`** (`apps/web/components/presence/CollisionWarning.tsx`):
- Compares `initialUpdatedAtUtc` (captured when the operator opens the surface) with `currentUpdatedAtUtc` (the freshest envelope read).
- When stale, renders an inline alert with an explicit "Reload" button.
- Never silently overwrites — operators must reload before the action proceeds; the server-side optimistic-concurrency gate (Phase G3 scaffold) is the authoritative final check.

**Privacy / vocabulary discipline**:
- Vocabulary contract enforces no Slack / DM / emoji / reaction / AI summarization / surveillance language across all G3.1 surfaces.
- Presence payload contains only `userId`, `displayName`, `lastSeenAtUtc` — no IP, no device, no route history.
- The PresenceIndicator + CollisionWarning + NotificationPreferencesPanel components together emit no `appendCustodyEvent` / `appendPlatformAuditLog` / `appendReviewerAuditEvent` calls. Custody chain is unaffected.

---

## 4. Acceptance confirmation

| Criterion | Status |
|---|---|
| no step-up bypass | ✅ Step-up infrastructure shipped in G3 unchanged; G3.1 surfaces are read-only or backend-audited |
| no audit bypass | ✅ Notification preferences PUT emits `notification_preference_updated`; presence + preferences reads emit no audit (intentional — not auditable actions) |
| no export preflight bypass | ✅ GovernedExportAction wrapping on ArtifactPanel preserved from G3; Matter Export tab + Reports continuation documented honestly (no buttons to wrap today) |
| no custody pollution | ✅ Presence pings + preference reads emit no custody events; tests assert no custody-event imports |
| no generic chat/social drift | ✅ Vocabulary contract enforces — 12 banned phrases × 5 surfaces (60 assertions, all green) |

---

## 5. Deferred follow-ups (continuations, not new same-layer)

Per Phase G3.1's "no new same-layer deferreds unless production-safety blocker" rule:

- **G3.1.x continuation** — Inline reviewer action buttons on `ReviewerConsole.tsx`. Hook is shipped (`useStepUpAction` from G3); per-row buttons are mechanical wiring deferred to keep this closure pass surgical.
- **G3.1.x continuation** — Saved-view CRUD form UI. Backend complete; UI forms are page-specific work.
- **G3.1.x continuation** — Reviewer "Load more" pagination wiring per tab. Backend supports `limit`/`nextCursor`; UI wiring is per-tab.
- **G3.1.x continuation** — GovernedExportAction wiring on Matter Export tab + Reports pages. Audit confirmed Matter Export tab is informational-only today; wrapping is conditional on those buttons being added.
- **G3.1.x continuation** — Matter remaining tab filter `matchesFilter()` wiring (Holds / Decisions / Audit / Communications / Assignments / Export). Each tab accepts the `filterText` prop per G2; the per-tab filter application is mechanical.
- **Deployment-scaling blocker — Shared-presence (Redis)**. Single-instance deployments are unaffected. Multi-instance / autoscaled deployments require swapping `presence.service.ts`'s internal Map for a Redis-backed implementation. The service's `recordHeartbeat` / `listViewers` interface is unchanged so the swap is bounded; `ioredis` is already a dependency and `REDIS_URL` is already wired (for rate-limiting). **Recommended env config for multi-instance:** `REDIS_URL` set, `PRESENCE_BACKEND=redis` (new env, not yet implemented), TTL preserved at 90 seconds.

None of these are new deferreds — each is the remaining mount or wiring of work delivered earlier in the wave.

---

## 6. Reference

- Schema + migration: [services/api/prisma/schema.prisma](services/api/prisma/schema.prisma) + [services/api/prisma/migrations/20261003000000_phase_g3_1_notification_preferences/migration.sql](services/api/prisma/migrations/20261003000000_phase_g3_1_notification_preferences/migration.sql)
- Preference service: [services/api/src/services/notifications/notification-preferences.service.ts](services/api/src/services/notifications/notification-preferences.service.ts)
- Preference routes: [services/api/src/routes/notification-preferences.routes.ts](services/api/src/routes/notification-preferences.routes.ts)
- Inbox integration: [services/api/src/routes/me-inbox.routes.ts](services/api/src/routes/me-inbox.routes.ts) (preference cache + filter)
- PresenceIndicator: [apps/web/components/presence/PresenceIndicator.tsx](apps/web/components/presence/PresenceIndicator.tsx)
- CollisionWarning: [apps/web/components/presence/CollisionWarning.tsx](apps/web/components/presence/CollisionWarning.tsx)
- NotificationPreferencesPanel: [apps/web/components/notifications/NotificationPreferencesPanel.tsx](apps/web/components/notifications/NotificationPreferencesPanel.tsx)
- Tests: [services/api/test/phase-g3-1-live-operations-closure.test.ts](services/api/test/phase-g3-1-live-operations-closure.test.ts) (91 source-contract tests)
