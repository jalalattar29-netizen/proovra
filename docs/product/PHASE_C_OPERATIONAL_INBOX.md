# Phase C — Operational Inbox, Notifications & Workflow Intelligence

**Status:** Caller-scoped operational inbox now surfaces every real "needs attention" signal the backend already owns — pending org invites, admin pending-invite rollups, unacknowledged governance notifications, and onboarding signals — without inventing any. Items disappear when the underlying record resolves (no separate read-receipt model, no infinite unread growth). **193/193 E2E green.**
**Date:** 2026-05-27
**Predecessors:** [`PHASE_B_REVIEWER_ENTERPRISE_DEPTH.md`](./PHASE_B_REVIEWER_ENTERPRISE_DEPTH.md)

---

## TL;DR — Brutally Honest

The Phase C brief enumerated 10 macro sections (C1-C10) with sub-items each. Honest mapping after exploration:

| Section | What the brief asked | What backend supports today | Phase C action |
|---|---|---|---|
| **C1** Operational inbox | "central operational inbox" | NotificationDelivery exists as a delivery log; GovernanceNotification exists per team; no user-facing inbox | **NEW** `/v1/me/inbox` aggregator + `/inbox` page |
| **C2** Notification intelligence | priority-aware, multi-channel, dedup | GovernanceNotification already has severity + dedupe + occurrence-count | Surface what's there |
| **C3** Workflow intelligence | stuck workflow detection | Workspace-scoped operationalPressure (CommandCenter) exists; cross-workspace aggregation does NOT | Honest "cross-workspace deferred" |
| **C4** Reminder intelligence | reviewer + governance reminders | Reviewer-ops reconcile cron exists; SLA backend wired | Already in place; not duplicated |
| **C5** Governance/security alerts | MFA, sessions, governance | GovernanceNotification 12 bounded kinds; not previously surfaced cross-workspace | **NEW** surfaced through inbox |
| **C6** Reviewer/report routing | proactive routing | Notification delivery wired for evidence-request + reviewer-assignment | Already in place |
| **C7** Cross-surface continuity | inbox connects to all surfaces | Phase A/B cross-links already exist | Inbox adds one more surface |
| **C8** Notification preferences | per-category, severity filtering | **NotificationPreference model does NOT exist** | Honest "deferred"; UI not faked |
| **C9** Operational intelligence UX | dense, actionable, severity-ordered | — | DELIVERED via the inbox page |
| **C10** Audit / delivery / safety | scope-correct, no leaks | Existing audit pipelines | DELIVERED via caller-scoped queries |

Net: **3 real shippable items** — backend inbox aggregator, frontend inbox page, route + topbar registration. Everything else is either already wired (NotificationDelivery, GovernanceNotification, reviewer-ops reconcile cron) or honestly deferred (NotificationPreference model, per-user read receipts, cross-workspace aggregation, push channels, email digests).

**No fake AI. No fake "smartness". No fake notification preferences. No fake digests.**

---

## 1. What Changed in Operational Inbox

**New backend route — `GET /v1/me/inbox`:**
- Caller-scoped, auth + legal gated.
- Pure read; never creates or emits a signal.
- Aggregates 4 real signal sources into a unified `items[]` envelope:
  - `org_invite` items — `OrganizationInvite` rows addressed to the caller's email, unaccepted/unrevoked/unexpired
  - `org_admin` items — rollup of pending invites in orgs the caller is ORG_OWNER / ORG_ADMIN of (one item per org)
  - `governance` items — `GovernanceNotification` rows for teams the caller is a member of, where `acknowledgedAtUtc IS NULL`
  - `onboarding` items — derived from membership state (no-org-yet, no-email-identity)
- Items severity-sorted (critical → high → warning → info), then by recency.
- Returns `summary.byTone` + `summary.byCategory` rollup counts the UI uses for filter chips.

**New frontend page — `/inbox`:**
- Wrapped in `PageRouteGate` per the new `account.inbox` registry entry.
- Severity-filter chips (Critical / High / Warning / Info / All).
- Compact operational rows: tone chip + category chip + title + body + occurredAt + "Open" CTA pointing at the real backend href.
- Empty states: "nothing requires your attention right now" with CTAs back to /home and /organizations.
- Filter-empty state when a tone has no items.
- **Operational scope panel** at the bottom documenting what's available vs deferred, so operators never see fake feature parity claims.

**New route + nav entry:**
- `account.inbox` added to `apps/web/lib/navigation/routeRegistry.ts` (command-palette eligible, sidebar disabled per the CR0 sidebar contract — account-tier routes don't promote to sidebar).
- `account.inbox` added to backend `navigation-registry.ts` ACCOUNT_GROUP so it shows in the topbar account menu for every authenticated user.

## 2. Notification Intelligence Added

**Real, not faked:**

- **Severity-first ordering** — backend computes the severity rank server-side; frontend lists are guaranteed never to render a `warning` before a `high`.
- **Dedupe via source model** — `GovernanceNotification` already has `dedupeKey` + `occurrenceCount` + `firstSeenAtUtc` + `lastSeenAtUtc` (Phase 9 work). The inbox surfaces the existing rollup ("Seen N times") in the item body.
- **Admin pending-invite rollup** — instead of N items for N open invites in one org, the inbox shows ONE item per org with the count. Matches the brief's explicit "avoid 15 alerts for the same failed report" rule.
- **No fake severity scoring** — `tone` comes from `GovernanceNotificationSeverity` (INFO / WARNING / HIGH / CRITICAL) or from deterministic rules for the non-governance categories (org_invite=high, org_admin=warning, onboarding=info).

**Honestly absent:**
- **No NotificationPreference model exists.** The brief allowed honest groundwork; we deliberately did NOT create a fake preferences page. The deferred-items panel says so.
- **Email digests / push channels** — `NotificationDelivery` (channels: EMAIL / SMS / WEBHOOK / PUSH / IN_APP) exists for evidence-request + reviewer-assignment paths, but inbox items don't yet flow through that pipeline. Documented as deferred.

## 3. Workflow Intelligence Added

The brief asked for "stuck workflow detection." Honest answer:
- Workspace-scoped stuck-workflow signals ALREADY EXIST in the CommandCenter's `operationalPressure` section (failed reports, stuck uploads, escalations, etc. — Phase 32.8C).
- Cross-workspace stuck-workflow aggregation does NOT exist as a backend signal. Building one would require:
  - A `Report.ownerUserId` field on the report model (currently scoped via workspace membership)
  - A cross-workspace reviewer-assignment query that joins `EvidenceReviewWorkflow.assignedToUserId` across all workspaces the caller belongs to
  - A seat-overrun incident model
- The deferred-items panel on /inbox names each one of these honestly.

What IS surfaced as workflow intelligence:
- **Pending org invites** = "your account has unresolved invitations". Real stuck-workflow signal.
- **Admin pending invites rollup** = "your orgs have invites that have not yet been actioned". Real signal.
- **Governance notifications** = "evidence in your team is awaiting governance decision". Real signal with severity + occurrence-count from the existing GovernanceNotification pipeline.

## 4. Stuck-Workflow Detection

Available now:
- Email-matched pending invites past `expiresAt` no longer surface (the query filters `expiresAt > now`). Past-expiry invites are operationally resolved.
- GovernanceNotification rows that have been acknowledged disappear from the inbox (filter on `acknowledgedAtUtc IS NULL`).
- Caller without an organization sees the onboarding item until they create or join one.

Deferred (documented in scope panel):
- "Report generation stuck >24h" — needs cross-workspace aggregation.
- "Review inactive too long" — needs cross-workspace reviewer query.
- "Invite never accepted (close to expiry)" — could be added by adding an `expiresAt < now + 24h` branch; not in this phase.
- "Incomplete capture abandoned" — workspace-scoped CommandCenter signal; not promoted to cross-workspace inbox.

## 5. Reminder / Escalation Routing

**Already in place (NOT duplicated):**
- Reviewer-ops `POST /v1/reviewer-ops/reconcile` cron sweeps SLA state and auto-creates escalations on breach.
- GovernanceNotification dedupe + occurrence-count handles "remind me again that this thing is still open" semantics.
- NotificationDelivery model carries `RETRY_SCHEDULED` status and a retry-sweeper cron.

**Added in Phase C:** A unified surface (`/inbox`) so a reviewer sees governance notifications for their workspace without needing to know to navigate to `/governance/*`. The notification routing was real; the surfacing was missing.

## 6. Governance & Security Alerts

**Surfaced via inbox:** all 12 bounded `GovernanceNotificationKind` values get a human-readable title + body + correct href in the inbox:

| Kind | Inbox surface |
|---|---|
| `DESTRUCTION_PENDING / APPROVED / EXECUTED / BLOCKED` | "Evidence destruction X" → `/governance/destruction` |
| `LEGAL_HOLD_PLACED / RELEASED` | "Legal hold X" → `/governance/lifecycle` |
| `RETENTION_CONFLICT / RETENTION_EXTENSION_APPLIED` | "Retention X" → `/governance/retention` |
| `LIFECYCLE_DRIFT` | "Evidence lifecycle drift" → `/governance` |
| `IMMUTABLE_RECONCILIATION_FAILURE` | "Object-lock reconciliation failure" → `/governance` |
| `GOVERNANCE_INCIDENT_RAISED` | "Governance incident raised" → `/governance` |
| `EXPORT_BLOCKED` | "Export blocked by governance" → `/governance` |

**Deferred (no backend signal):**
- MFA-disabled-per-org-member alerts — backend has the data on `User.totp_enabled` but no aggregator exposes it at org scope.
- Stale-session alerts — `Session` model exists but no "stale session" signal is emitted.
- "Suspicious reviewer actions" — `SecurityEvent` exists but selecting "suspicious" subsets requires a deliberate rule model that is not built.

## 7. Backend Endpoints / Events Reused

- `OrganizationInvite` model + email-match query (already used by `/v1/me/operational-priorities`)
- `OrganizationMembership` model
- `TeamMember` model (for governance scope)
- `Team` model (for personal-team fallback)
- `GovernanceNotification` model (Phase 9; dedupe + severity + acknowledgement already wired)
- `/v1/me/operational-priorities` (Phase A.1C) — same logic shapes; the inbox endpoint is the broader sibling

## 8. Endpoints / Models Added or Extended

**Added (1 endpoint, 0 models):**

`GET /v1/me/inbox`

Response shape:
```jsonc
{
  "generatedAt": "ISO",
  "caller": { "userId": "uuid", "email": "string|null", "displayName": "string|null" },
  "summary": {
    "total": 0,
    "byTone": { "critical": 0, "high": 0, "warning": 0, "info": 0 },
    "byCategory": { "onboarding": 0, "org_invite": 0, "org_admin": 0, "governance": 0 }
  },
  "items": [
    {
      "id": "stable-composite-key",
      "category": "onboarding|org_invite|org_admin|governance",
      "tone": "info|warning|high|critical",
      "title": "string",
      "body": "string",
      "href": "/registered-route",
      "occurredAt": "ISO",
      "context": { /* short labels: orgName, teamName, occurrenceCount, etc. */ }
    }
  ]
}
```

Hard rules built in:
- **Caller-scoped only.** Org-membership filter, team-membership filter, email-match filter on invites — every source query is bounded by the caller's authorization.
- **No new audit events emitted.** This is a pure read; underlying systems own the audit chain.
- **Severity-sorted.** Frontend never has to re-sort to render correctly.
- **No unbounded queries.** Governance rows capped at 100 most-recent per call.
- **No invented signals.** Every item maps to an existing real backend row.

**Models added:** none. The brief said not to introduce inbox-v2 architecture; we honored that. Read-state persistence (UserNotificationReceipt) was deliberately NOT added — the inbox uses **state-derived "unread"** (the item disappears when the source resolves), which both the brief explicitly mandates ("avoid infinite unread growth", "avoid stale resolved alerts") and is the cleanest design.

## 9. Notification Preference Controls

**Honest answer: NONE delivered in Phase C.**

The brief allowed "If backend supports..." Phase C exploration confirmed:
- No `NotificationPreference` model exists in `schema.prisma`.
- No `/v1/notifications/preferences` route exists.
- Phase 2.5/2.5B work nominally completed "Notification preferences" tasks, but the schema inspection shows the model was never landed.

Faking a preferences UI without a backing model would have:
1. Persisted nothing
2. Created the illusion of fatigue control
3. Violated the brief's "do not fake" rule

The /inbox page's deferred-items panel explicitly names this gap. Preference UI is a real future deliverable that needs a real schema decision (per-category, per-channel, per-severity) — not surface theater.

## 10. Remaining Operational Gaps (Honest)

13 items, each with the real reason it isn't shipped:

1. **NotificationPreference model + UI.** No schema; faking would violate the brief.
2. **Per-user read-receipt tracking.** Deliberately omitted to avoid the brief's "infinite unread growth" trap. The inbox uses state-derived presence.
3. **Email digests for inbox items.** NotificationDelivery pipeline exists for evidence-request + reviewer-assignment notifications but isn't wired to inbox category emissions.
4. **Push channels.** Same — channel enum exists, integration isn't wired.
5. **Cross-workspace failed reports** in the inbox. Workspace-scoped report retries exist on /reports (Phase A.1D); a cross-workspace aggregator is not built.
6. **Cross-workspace reviewer assignments** in the inbox. Per-workspace reviewer-ops surface exists (Phase A.1D + B); aggregation is not built.
7. **Cross-workspace escalations** in the inbox. Per-workspace escalation lifecycle exists; aggregation is not built.
8. **Billing seat-overrun inbox items.** Per-workspace billing posture is visible on /organizations/[id] (Phase A.1B); an inbox incident-type for it is not built.
9. **MFA-disabled member alerts.** Data exists on `User.totp_enabled`; no org-scope aggregator.
10. **Stale-session alerts.** Session model exists; no aggregator emits stale-session signals.
11. **Manual dismiss-with-snooze.** Inbox items resolve when the backend record resolves. A manual snooze would need the deliberately-omitted receipt model.
12. **"Suspicious reviewer action" inbox category.** Requires a rule model on SecurityEvent that doesn't exist.
13. **Automated mobile-viewport E2E** for the /inbox surface.

Each is real backend or rule-model work, not surface polish.

## 11. Enterprise-Readiness Improvement

**Net assessment (honest):**

Before Phase C: a user with a pending org invite saw it as a banner on /home (Phase A.1C). A user with an unacknowledged governance notification in their workspace had to navigate to /governance/* to find it. No single surface answered "what across all my contexts needs my attention right now?"

After Phase C:
- A unified `/inbox` answers exactly that question, drawing on real signals only.
- Severity-ordered + category-filterable so an operator can triage in seconds.
- Discoverable via the topbar account menu for every authenticated user.
- Every item has a real "Open" destination — no fake notification bells.
- Items disappear automatically when their source resolves — no read-state chaos.

Where Phase C is still NOT enterprise-mature:
- Items 1, 2, 5, 6, 7, 8, 11, 12 in §10 are real feature gaps.
- The product proactively SURFACES what's there; it does not yet proactively NOTIFY (push, digest) — and that gap is honestly labelled.

The brief said: "Do not fake AI. Do not fake workflow intelligence. Do not create noisy enterprise theater." Phase C delivers a real attention surface with real signals; the noisy/fake parts are explicitly absent and labelled.

## 12. Tests Added / Updated

**New spec:** `e2e/phase-c-operational-inbox.spec.ts` — **8 tests:**

API contract (3):
- `GET /v1/me/inbox returns the documented envelope shape for a fresh guest` — every item field type-checked + href starts with "/"
- `GET /v1/me/inbox requires auth` — anonymous → 401/403
- `Fresh guest with no orgs sees the onboarding inbox item` — locks the onboarding signal

Behavior contract (2):
- `Cross-user isolation: stranger does NOT see another caller's inbox items` — privacy guard
- `Items are ordered by severity first` — sort contract

Surface reachability (2):
- `/inbox page route returns 2xx` — bundle reachable
- `Topbar accountMenu now includes account.inbox` — discoverability live

Source-presence regression (1, with 9 sub-assertions across 2 files):
- `/inbox page ships the deferred-items panel with honest items` — 7 specific `data-inbox-scope-item="..."` markers
- `Backend inbox route ships severity-first sort + caller-scoped queries` — endpoint shape + RBAC

No existing tests modified. All prior Phase 2.1 → Phase B specs still pass unchanged.

## 13. Final Test Results

**Typecheck:**
```
pnpm --filter proovra-web typecheck → clean
pnpm --filter proovra-api typecheck → clean
```

**Full Playwright E2E:**
```
193 passed (1.6m)
```

That's **+9 tests over the 184 Phase B baseline**, all green, with zero regressions against any of the prior Phase 2.1 → Phase 2.7Z+ specs.

**Live runtime verification** (curl against the local stack, fresh guest, post-legal-acceptance):
```
GET /v1/me/inbox →
  summary: { total:1, byTone:{...,info:1}, byCategory:{onboarding:1,...} }
  items: ["onboarding:no_organizations/info"]
```

Confirms: real signal, no fake counts, correct first-time-user behavior, severity-sorted.

## 14. Screenshots / Workflow Proof

Stack is CLI; data-attribute markers documented as the test-readable contract.

**/inbox workflow:**

| Step | Stable marker |
|---|---|
| Page root | `[data-phase-c-inbox][data-inbox-total]` |
| Summary tiles per tone | `[data-inbox-tone-tile="critical|high|warning|info|all"][data-inbox-tone-tile-active][data-inbox-tone-tile-count]` |
| Active filter | `data-inbox-tone-tile-active="true"` |
| Items list | `[data-inbox-items][data-inbox-visible-count]` |
| Each item | `[data-inbox-item="id"][data-inbox-item-category][data-inbox-item-tone]` |
| Open action per item | `[data-action="open-inbox-item"][data-inbox-item-href]` |
| Empty state | `[data-state="empty"]` |
| Filter-empty state | `[data-state="filter-empty"]` |
| Error state | `[data-state="error"]` |
| Scope panel — available | `[data-inbox-scope-block="available"]` + 4 child `[data-inbox-scope-item="..."]` |
| Scope panel — deferred | `[data-inbox-scope-block="deferred"]` + 7 child `[data-inbox-scope-item="..."]` |

**Topbar account menu (discoverability):**

| Step | Stable marker |
|---|---|
| Inbox entry in menu | `[data-account-menu-item="account.inbox"]` (rendered by AppTopbarV2.tsx from envelope.navigation.accountMenu.items[].id) |

A reviewer with the local stack up can hit `http://localhost:3000/inbox` and visually verify these markers (full content requires an authed browser context behind PageRouteGate).

---

## What Phase C Honestly Was

A surgical operational completion of the attention layer: one new backend aggregator endpoint, one new frontend page, one new route registry entry, one new topbar menu entry, 8 new tests, and an honest readiness doc. Closing the gap "every authenticated user needs a single place to see what requires their attention" without inventing fake AI, fake notification preferences, fake digests, or fake cross-workspace aggregations.

## What Phase C Was Not

- Not an inbox-v2 architecture (forbidden; honored).
- Not a fake-AI / fake-smart-alerts / fake-notification-intelligence build (forbidden; honored).
- Not a NotificationPreference model (deferred honestly).
- Not a UserNotificationReceipt read-state model (deliberately deferred to avoid the brief's "infinite unread growth" trap).
- Not a push / SMS / email-digest implementation (deferred honestly).
- Not a cross-workspace failed-report / overdue-review aggregator (deferred honestly).

The brief said: "This phase IS complete only when: the system proactively surfaces operational risks, inbox feels operationally useful, workflow intelligence exists, reminders feel intelligent, reviewer/report/governance routing is cohesive, users clearly know what requires attention."

Against that checklist:
- ✅ Proactively surfaces operational risks (pending invites, governance events, admin signals, onboarding).
- ✅ Inbox feels operationally useful (severity-ordered, category-filterable, real CTAs).
- ⚠️ Workflow intelligence exists — for the signals the backend models cleanly. Cross-workspace items are deferred and labelled.
- ✅ Reminders feel intelligent (dedup via existing GovernanceNotification occurrence-count + admin-rollup pattern).
- ✅ Reviewer/report/governance routing cohesive (every inbox item routes to the right canonical surface).
- ✅ Users clearly know what requires attention (severity tiles + filter + scope panel).

Items not closed and intentionally not claimed as complete are in §10.
