# Review escalation and reminder notifications — actual behaviour

**Status:** verified against code on branch `team/review-remediation` (base `110e576d6`), 2026-11-23.
**Proof:** `services/api/test/team-escalation-notification-truth.integration.test.ts` (live PostgreSQL, persisted `ReviewEscalation`, `ReviewerOpsReminder` and `NotificationDelivery` rows).

This page settles two contradictory statements in the 2026-11-22 review-ops audit material ("the reconcile auto-escalates **and emails**" vs "engine auto-escalations send **no email**"). Both are half right: an automatic escalation sends no email, but the same reconcile pass sends the assignee an *overdue reminder* when the SLA flips to BREACHED.

## Summary

| # | What happens | Persisted record | Email sent | To whom | Entitlement gate | Code |
|---|---|---|---|---|---|---|
| a | **Automatic escalation** by the reviewer-ops reconcile (SLA breached, or escalation deadline passed) | `ReviewEscalation` reason `REVIEW_OVERDUE`, severity HIGH, `createdByUserId = null`; HIGH also opens an incident | **None.** `createEscalation` sends no email | — (the open escalation reaches owners/admins through the inbox / Operations Center) | Yes — reconcile skips non-entitled workspaces | `reviewer-operations-engine.service.ts:1670` (gate), `:1711-1720` (create); `escalation-engine.service.ts:279-575` (no send) |
| a′ | **Stuck-workflow escalation** in the same reconcile pass | `ReviewEscalation` (CRITICAL stuck rows) | **None** | — | Yes (same pass) | `reviewer-operations-engine.service.ts:1979` |
| a″ | **SLA flip to BREACHED** inside reconcile (`reconcileReviewSlas`) | `slaStatus = BREACHED`, `SLA_BREACHED` workflow event | `REVIEW_OVERDUE_REMINDER`, once per BREACHED transition | the review's **assignee** | Yes when called from reconcile | `reviewer-operations-engine.service.ts:1682`; `review-operations.service.ts:1047` |
| b | **Manual Escalate** by a person (`recordLifecycleTransition` decision `ESCALATE`) | `ReviewEscalation` reason `REVIEWER_ESCALATED`, **unassigned** (`routeToWorkspaceAdmins: true`) so owners/admins see it | `REVIEW_ESCALATED` (after commit, best effort) | the review's **current assignee** — not the owners/admins the escalation is routed to | Route requires `REVIEW_ESCALATION` (`review-operations.routes.ts:334`) | `review-operations.service.ts:738-791` (send at `:790`); `review-notifications.service.ts:196-210` |
| b′ | **Operator escalation** route (`POST /v1/reviewer-ops/escalations`) | `ReviewEscalation` | **None** | — | reviewer-ops route gate | `reviewer-ops.routes.ts:1674` |
| c | **Due-soon / inactivity reminders** (`sweepDueSoonReminders`, `sweepInactivityReminders` schedule; `deliverScheduledReminders` sends) | `ReviewerOpsReminder` SCHEDULED → DELIVERED / SUPPRESSED / FAILED | `REVIEW_DUE_SOON_REMINDER` / `REVIEW_INACTIVITY_REMINDER` | the review's **assignee** (only if still assigned, open, not paused) | Yes — only ever called from reconcile | `reviewer-operations-engine.service.ts:1741-1763`; `reminder-engine.service.ts:223-287` |
| d | **Cron SLA sweep** `POST /v1/review-operations/reconcile-slas` (worker `review-sla-reconcile`, every 15 min, no `teamId` = every workspace) | `slaStatus = BREACHED`, `SLA_BREACHED` event | `REVIEW_OVERDUE_REMINDER` | the review's **assignee** | **Yes** (since 2026-11-23, D-ESC-1) — rows in non-entitled workspaces are skipped (`skippedNotEntitled`) | `review-operations.routes.ts:516-532`; `services/worker/src/api-delivery-sweeps.ts:112-116`; `review-operations.service.ts:949-1070` |

Every review email goes through `dispatchToAssignee` (`review-notifications.service.ts:130-168`): no assignee → no email. `sendEmailNotification` then applies, in order, the `NOTIFICATIONS_ENABLED` flag (`notifications/index.ts:270`) and the member's per-workspace email preference — `REVIEW_ESCALATED` → `ESCALATION`, the three reminders → `SLA_NEAR_BREACH` (`notifications/index.ts:179-193`). These are **opt-in**: with no preference row the delivery is recorded `SKIPPED / recipient_preference_off`. Every attempt, sent or skipped, leaves a `NotificationDelivery` row.

## Entitlement gating after TEAM-SPEC R1

- `runReconcile` returns `skippedReason: "reviewer_operations_not_included"` without touching anything when the workspace lacks `REVIEW_ESCALATION` (`reviewer-operations-engine.service.ts:1667-1673`). That covers (a), (a′), (a″) and (c): reminders are scheduled and delivered **only** from inside reconcile, so a non-entitled workspace gets no due-soon or inactivity mail, and previously scheduled rows stay SCHEDULED (if the workspace is re-entitled, the next delivery pass closes anything older than 24 h unsent — `reminder-engine.service.ts:229-237`).
- The all-teams reconcile sweep also filters teams by the same capability before calling reconcile (`reviewer-ops.routes.ts:2225`).
- **Gated (fixed 2026-11-23):** the separate cron SLA sweep (d). It calls `reconcileReviewSlas` with no `teamId`; each row is now checked against the workspace's `REVIEW_ESCALATION` entitlement (cached per workspace) and skipped otherwise, so a workspace downgraded from TEAM is neither flipped to BREACHED nor mailed. Before the fix it was — that case was pinned by the integration test before it was flipped.

## D-ESC-1 (fixed 2026-11-23)

**The cron SLA sweep emailed non-entitled workspaces.** `reconcileReviewSlas` (`services/api/src/services/review-operations/review-operations.service.ts`) had no entitlement check and the route `POST /v1/review-operations/reconcile-slas` added none. Fix: the candidate loop skips a row whose workspace lacks `REVIEW_ESCALATION` (`automationEntitled`, cached per workspace like `dueSoonFor`), so the all-workspace cron and the per-workspace reconcile share one rule. Proof: `services/api/test/team-escalation-notification-truth.integration.test.ts` case (c) — first written to pin the leak (PRO review flipped and mailed), then flipped with the fix to expect no flip and zero deliveries, plus a TEAM control that is still flipped.

## Not email, but related

- `createEscalation` also fires the automation trigger `ESCALATION_CREATED` (`escalation-engine.service.ts:446`), a security event and a tenant audit row. A workspace's own automation rules could act on that trigger; PROOVRA itself sends nothing there.
- An unassigned open escalation is shown to owners and admins in the inbox; that is the canonical discovery path, and email is a best-effort convenience (`review-notifications.service.ts:18-31`).
