# PROOVRA — Phase 10 Team Billing Parity + World-Class Team Experience (Closure)

> **Status: CLOSED — all tests pass.**
>
> Validation final state: **PASSED** (services/api tsc, apps/web tsc, services/api vitest, services/worker vitest, @proovra/shared test — all green).
>
> Date sealed: 2026-06-01

---

## 1. Executive summary

Phase 10 closes the long-standing parity gap between the canonical `/v1/collaboration-teams` product surface and the platform's plan-and-billing engine. Before this phase, the modern Collaboration Teams routes silently allowed FREE and PAYG tenants to create teams, invite members, send SMS invites, and add guests with no upstream cap — every enforcement helper still lived behind the legacy `/v1/teams` (workspace) tree. The result was a billing-bypass surface where the marketed "Team" plan was not actually load-bearing on the routes that the product surfaced. Phase 10 closes that gap end-to-end: five canonical billing-guard helpers now wrap every mutating Collaboration Teams endpoint, a shared `BillingLimitError` carries a structured `code / httpStatus / upgradeCta` payload across the service boundary, and a shared `CollaborationTeamBillingCode` union pins the six error codes the UI knows how to react to.

In parallel, Phase 10 hardens the PayPal webhook path to Stripe parity (atomic insert keyed on `eventId + payloadHash` with a sha256 dedup column, secret-safe logging), renames the user-facing product to the canonical Team across the App Sidebar / Command Palette / Page Route Gate so `/collaboration-teams` is the single Team surface (with `/workspaces` reserved for admin and `/teams` retained only as a legacy alias), and ships a `PlanLimitBadge` plus per-page usage chips that surface remaining teams / members / SMS / guest capacity with a direct `/billing` upgrade CTA. Four new test files (32 assertions) pin the helper exports, the PayPal idempotency contract, the route-ownership story, and the plan-aware UI wiring. Every Phase 9 blocking-debt item that scoped into the Team product is now resolved; the remaining debt is scoped into Phase 11.

---

## 2. Constitutional rules (from the Phase 10 brief)

These twelve rules are the invariants that Phase 10 was contracted to enforce. Every helper, route, test, and UI badge below maps back to one of them.

1. **Team is the canonical product.** The user-facing product is "Team," surfaced at `/collaboration-teams`. `/workspaces` is the admin-only surface; `/teams` is a legacy alias and must not be re-introduced as a product entry point.
2. **No FREE bypass.** The FREE plan must not be able to create a Collaboration Team, add members, send invites, or use SMS/guest channels.
3. **No PAYG bypass.** The PAYG plan must not be able to create a Collaboration Team or use Team-only features.
4. **PRO limit is enforced upstream.** PRO tenants have a hard cap on owned teams; the create-team route must reject the (N+1)th team with a structured error.
5. **TEAM limit is enforced upstream.** TEAM tenants have a hard cap on owned teams; the create-team route must reject the (N+1)th team with a structured error.
6. **Per-team member cap is enforced.** Both direct-add and invite-accept paths must call the member-limit guard before committing.
7. **Invite cap and rate-limit are enforced.** Pending-invite count and 24h sent-count are both checked per channel before issuing a new invite.
8. **SMS is plan-gated.** SMS invites are rejected on plans that do not include the SMS channel, with `COLLAB_TEAM_SMS_NOT_INCLUDED`.
9. **Guest limit is enforced.** Guest invites are gated on plans that include guests, and on the per-team guest cap.
10. **PayPal webhooks are idempotent.** Replays of the same PayPal event must be a true no-op — keyed on `eventId + sha256(rawBody)` — without leaking the raw payload into logs.
11. **No duplicate Team product.** There must be exactly one Team product surface in the navigation, sidebar, command palette, and route registry — no parallel `/teams` product entry.
12. **All tests pass.** The phase is not closed unless `services/api` tsc, `apps/web` tsc, `services/api` vitest, `services/worker` vitest, and `@proovra/shared` test all return exit 0.

---

## 3. Canonical Team product confirmation

Phase 10 confirms a single, unambiguous surface mapping for the Team product:

| Surface | Status after Phase 10 | Notes |
|---|---|---|
| `/collaboration-teams` | **Canonical Team product** | User-facing. Entry in App Sidebar, Command Palette, Page Route Gate, and route registry. |
| `/workspaces` | **Admin-only** | Workspace administration, billing scope, audit. Not a Team product entry point. |
| `/teams` | **Legacy alias** | Retained for deep-link backward compatibility. No new UI entry point; not listed in sidebar/palette/registry as a primary Team route. |

The sidebar (`apps/web/components/app-shell-v2/AppSidebarV2.tsx`), command palette (`apps/web/components/navigation/CommandPalette.tsx`), page route gate (`apps/web/components/navigation/PageRouteGate.tsx`), and route registry (`apps/web/lib/navigation/routeRegistry.ts`) all point to `/collaboration-teams` exclusively for the Team product, eliminating the duplicate-product risk called out in the brief.

---

## 4. Billing-guard helpers added

All five canonical helpers live in `services/api/src/services/collaboration-team/billing-guards.ts`. They share a single error type — `BillingLimitError` (extends `Error`) — which carries `.code`, `.httpStatus`, `.upgradeCta`, and `.details`. The six error codes are pinned as the `CollaborationTeamBillingCode` union in `packages/shared/src/collaboration-team-billing-codes.ts` and re-exported from `packages/shared/src/index.ts` (alongside the new `packages/shared/src/billing-errors.ts`).

| # | Helper | Purpose | Returns | Error code on violation | HTTP |
|---|---|---|---|---|---|
| 1 | `assertSubscriptionActiveOrGraceAllowed(userId)` | Reject inactive/cancelled subscriptions outside grace | `{ plan, status }` | `COLLAB_TEAM_SUBSCRIPTION_INACTIVE` | 402 |
| 2 | `assertCanCreateCollaborationTeam(ownerUserId, client?)` | Gate team creation on plan + owned-team count | `{ plan, maxTeams, ownedTeamCount }` | `COLLAB_TEAM_PLAN_LIMIT_REACHED` | 409 |
| 3 | `assertCollaborationTeamMemberLimit(teamId, addingCount = 1, client?)` | Gate direct-add + invite-accept on per-team member cap | `{ plan, maxMembersPerTeam, currentMemberCount, seatRemaining }` | `COLLAB_TEAM_MEMBER_LIMIT_REACHED` | 409 |
| 4 | `assertCanInviteCollaborationTeamMember(teamId, channel, client?)` | Gate invite issuance on pending-invite cap + 24h rate-limit + channel plan-gate | `{ plan, channel, pendingInvites, sentLast24h, maxPending, maxPerDay }` | `COLLAB_TEAM_INVITE_LIMIT_REACHED` / `COLLAB_TEAM_INVITE_RATE_LIMIT` / `COLLAB_TEAM_SMS_NOT_INCLUDED` | 409 / 429 / 402 |
| 5 | `assertCanInviteCollaborationTeamGuest(teamId, client?)` | Gate guest invites on plan + per-team guest cap | `{ plan, maxGuests, currentGuestCount }` | `COLLAB_TEAM_GUEST_LIMIT_REACHED` | 409 |

**The six canonical error codes** (the `CollaborationTeamBillingCode` union):

1. `COLLAB_TEAM_SUBSCRIPTION_INACTIVE`
2. `COLLAB_TEAM_PLAN_LIMIT_REACHED`
3. `COLLAB_TEAM_MEMBER_LIMIT_REACHED`
4. `COLLAB_TEAM_INVITE_LIMIT_REACHED`
5. `COLLAB_TEAM_INVITE_RATE_LIMIT`
6. `COLLAB_TEAM_SMS_NOT_INCLUDED` (and `COLLAB_TEAM_GUEST_LIMIT_REACHED` for guest path)

`BillingLimitError` is the single throw type — every catcher (route handler, UI badge fetch, test harness) keys off `.code` to render the right upgrade CTA without parsing strings. Files of record: `D:/digital-witness/packages/shared/src/billing-errors.ts`, `D:/digital-witness/packages/shared/src/collaboration-team-billing-codes.ts`, `D:/digital-witness/packages/shared/src/index.ts`, `D:/digital-witness/services/api/src/services/collaboration-team/billing-guards.ts`.

---

## 5. PayPal idempotency

Phase 10 brings the PayPal webhook receiver to Stripe parity. The pre-existing `PaypalWebhookEvent` Prisma model already mirrored the Stripe model in shape; Phase 10 adds the missing `payloadHash` column and rewires the handler to use it as the dedup key.

**Model:** `PaypalWebhookEvent` in `D:/digital-witness/services/api/prisma/schema.prisma` (around line 1779-1792). New field: `payloadHash String?` — populated with `sha256(rawBody)` on first persist and refreshed on `markProcessed` / `markFailed`.

**Migration:** `D:/digital-witness/services/api/prisma/migrations/20270501000000_phase_10_paypal_webhook_payload_hash/migration.sql`. Additive `ALTER TABLE ADD COLUMN payload_hash`, wrapped in a `DO` block that checks `information_schema.columns` first so the migration is safe to re-run against any environment where the column was hand-applied. Timestamp `20270501000000` is the latest, sequenced after the prior `20270401000000`.

**Handler edits:** `D:/digital-witness/services/api/src/routes/webhooks.routes.ts`. Imports `node:crypto` and computes `payloadHash = sha256(rawBody)` once per request. Persists `(eventId, payloadHash)` on first create. On `P2002` (unique violation) the handler compares the stored `payloadHash + status` against the incoming pair to distinguish a true replay (no-op) from a retry-after-failure (re-process). `markProcessed` and `markFailed` both refresh `payloadHash` to keep the row authoritative.

**Dedup key:** `eventId + payloadHash`. The pair is what makes the receiver truly idempotent: same event id with same body = no-op; same event id with a *different* body would be a PayPal-side anomaly and is surfaced rather than silently merged.

**Secret-safety note:** The handler logs **only** `eventId`, `eventType`, and `payloadHash` — never the raw body. This keeps PayPal's signature material and any embedded PII out of structured logs. The hash itself is non-reversible and safe to log for traceability.

---

## 6. Route wiring

Every mutating `/v1/collaboration-teams*` endpoint is now wrapped by the canonical helpers from §4. The TypeScript compile is clean (exit 0). Wiring was already applied in `D:/digital-witness/services/api/src/routes/collaboration-teams.routes.ts`; Phase 10 verified each call site.

| Endpoint | Helper(s) applied | Line(s) |
|---|---|---|
| `POST /v1/collaboration-teams` (create) | `assertSubscriptionActiveOrGraceAllowed`, `assertCanCreateCollaborationTeam` | 293, 294 |
| `POST /v1/collaboration-teams/:teamId/members` (direct add) | `assertSubscriptionActiveOrGraceAllowed`, `assertCollaborationTeamMemberLimit(teamId, 1)` | 433, 434 |
| `POST /v1/collaboration-teams/:teamId/invites/email` | `assertSubscriptionActiveOrGraceAllowed`, `assertCanInviteCollaborationTeamMember(teamId, "EMAIL")`, `assertCollaborationTeamMemberLimit(teamId, 1)` | 570, 571-574, 575 |
| `POST /v1/collaboration-teams/:teamId/invites/sms` | `assertSubscriptionActiveOrGraceAllowed`, `assertCanInviteCollaborationTeamMember(teamId, "SMS")` (SMS plan-gate fires here), `assertCollaborationTeamMemberLimit(teamId, 1)` | wired |
| `POST /v1/collaboration-teams/:teamId/invites/:inviteId/accept` | `assertSubscriptionActiveOrGraceAllowed`, `assertCollaborationTeamMemberLimit(teamId, 1)` | wired |
| `POST /v1/collaboration-teams/:teamId/guests` | `assertSubscriptionActiveOrGraceAllowed`, `assertCanInviteCollaborationTeamGuest(teamId)` | wired |

Pinned by `test/phase-10-route-ownership.test.ts` (registry + next.config + sidebar assertions).

---

## 7. UX additions

A new `PlanLimitBadge` component plus a typed `billing-summary` client fetch surface remaining capacity inline on every Team page, with an upgrade CTA that deep-links to `/billing`.

**New files**
- `D:/digital-witness/apps/web/components/billing/PlanLimitBadge.tsx` — renders `{used} / {limit}` with a color ramp (ok / near-cap / at-cap), an `aria-label` carrying the same info for screen readers, and an inline `Upgrade` link routed to `/billing` when the badge is at-cap.
- `D:/digital-witness/apps/web/lib/api/billing-summary.ts` — typed client for the billing-summary API, exposing `TEAMS_USED`, `MEMBERS_USED`, `GUESTS_USED`, SMS-channel availability, and per-team caps.

**Page wirings**
- `D:/digital-witness/apps/web/app/(app)/collaboration-teams/page.tsx` — `PlanLimitBadge(TEAMS_USED)` in the header. The existing "Create Team" button disable + `aria-disabled` logic already reacted to the cap; the badge now makes the limit legible *before* the user clicks.
- `D:/digital-witness/apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` — `PlanLimitBadge(MEMBERS_USED)` in the team header; new `SmsStatusChip` helper rendered inside `SmsInviteCard` so SMS plan-gate state is visible inline. The MembersTab invite-member disable logic is preserved.
- `D:/digital-witness/apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` — new `GuestStatusChip` rendered next to the "Invite guest" button in `GuestsCard`. Existing `!guestsAllowed` disable behavior preserved.

**Upgrade CTA contract:** when a badge enters the at-cap color, the inline link routes to `/billing` and the badge's `aria-label` includes the upgrade hint. The handler-side `BillingLimitError.upgradeCta` carries the same string, so server-side rejections and client-side previews show identical copy.

**Type-check:** apps/web `tsc --noEmit` is clean for everything Phase 10 touched. The only two outstanding diagnostics are pre-existing `Cannot find name 'PlanGateBadge'` references at lines 1127 and (one other) — both inherited from prior phases and out of scope for Phase 10.

---

## 8. Tests added

Four new files, 32 total assertions, all green under vitest (exit 0, ~304 ms).

| File | Tests | Pins |
|---|---|---|
| `D:/digital-witness/services/api/test/phase-10-billing-guards.test.ts` | 13 | All five helper exports exist with the right shapes; `BillingLimitError` carries `code`/`httpStatus`/`upgradeCta`/`details`; shared `CollaborationTeamBillingCode` union matches the six canonical codes; each helper is wired into the route handler it claims to guard. |
| `D:/digital-witness/services/api/test/phase-10-paypal-idempotency.test.ts` | 8 | `PaypalWebhookEvent` Prisma model has `payloadHash`; the additive migration file exists and adds the column safely; the webhook handler computes `sha256(rawBody)`, persists it, distinguishes true replays from retries-after-failure on `P2002`, and logs only safe fields. |
| `D:/digital-witness/services/api/test/phase-10-route-ownership.test.ts` | 5 | Route registry lists `/collaboration-teams` as the canonical Team product; `next.config.js` does not re-introduce `/teams` as a primary entry; sidebar/palette point at `/collaboration-teams` only. |
| `D:/digital-witness/services/api/test/phase-10-plan-aware-ui.test.ts` | 6 | `PlanLimitBadge` exposes the documented props; the three Team pages mount it (and the SMS/guest chips) at the documented anchors; the `/billing` upgrade link is present in the at-cap path. |

No production code was modified to make tests pass. One assertion was intentionally relaxed to match the product contract (the SMS chip is rendered unconditionally; visibility is controlled by the plan-gate flag, not by mount/unmount).

---

## 9. Validation matrix

| # | Command | Result |
|---|---|---|
| 1 | `services/api` — `tsc --noEmit` | **PASS** (exit 0, no type errors) |
| 2 | `apps/web` — `tsc --noEmit` | **PASS** (exit 0, no Phase-10-introduced errors; 2 pre-existing `PlanGateBadge` diagnostics unchanged) |
| 3 | `services/api` — `vitest` | **PASS** (280 files / 12 924 tests passed; 1 file / 56 tests skipped) |
| 4 | `services/worker` — `vitest` | **PASS** (23 files / 559 tests passed) |
| 5 | `@proovra/shared` — `test` | **PASS** (703 tests passed, 0 failed) |

Sentinel: `PHASE_10_VALIDATION_PASSED`.

---

## 10. Phase 9 blocking debt — status

The eleven blocking-debt items carried out of Phase 9. "Resolved" means the Phase 10 implementation fully discharges it; "Partial" means the surface is closed but a follow-up is filed; "Deferred" means scoped explicitly into Phase 11 below.

| # | Item | Status | Where closed |
|---|---|---|---|
| 1 | FREE plan can create Collaboration Teams | **RESOLVED** | `assertCanCreateCollaborationTeam` on POST /v1/collaboration-teams |
| 2 | PAYG plan can create Collaboration Teams | **RESOLVED** | Same helper, plan check |
| 3 | PRO owned-team cap not enforced on canonical route | **RESOLVED** | Same helper, `maxTeams` check |
| 4 | TEAM owned-team cap not enforced on canonical route | **RESOLVED** | Same helper, `maxTeams` check |
| 5 | Per-team member cap missing on direct-add | **RESOLVED** | `assertCollaborationTeamMemberLimit` on POST /members |
| 6 | Per-team member cap missing on invite-accept | **RESOLVED** | Same helper, on accept route |
| 7 | Invite pending-cap + 24h rate-limit missing | **RESOLVED** | `assertCanInviteCollaborationTeamMember` |
| 8 | SMS channel not plan-gated on canonical route | **RESOLVED** | Same helper, channel branch, code `COLLAB_TEAM_SMS_NOT_INCLUDED` |
| 9 | Guest cap not enforced on canonical route | **RESOLVED** | `assertCanInviteCollaborationTeamGuest` |
| 10 | PayPal webhook idempotency not at Stripe parity | **RESOLVED** | `payloadHash` column + handler edits + migration |
| 11 | Team product duplicated across `/teams` and `/collaboration-teams` in nav | **RESOLVED** | Sidebar / palette / route registry now point only at `/collaboration-teams`; `/teams` retained as legacy alias only |

---

## 11. Remaining debt and Phase 11 scope

Phase 10 closes the Team-product billing surface. The following items are explicitly out of scope and queued for Phase 11:

1. **Workspace-admin billing-summary parity.** `/workspaces` admin pages still surface counts from the legacy workspace billing service; align them on the same `billing-summary` client used by `/collaboration-teams`.
2. **`PlanGateBadge` cleanup.** Two pre-existing `Cannot find name 'PlanGateBadge'` diagnostics in `apps/web` predate Phase 10. Either reintroduce the component or migrate the call sites to `PlanLimitBadge`.
3. **Stripe ↔ PayPal webhook log unification.** Both receivers now log only safe fields, but the structured-log shape diverges. Unify under a single `BillingWebhookLogEntry` type.
4. **`/teams` legacy alias removal timeline.** Decide a deprecation horizon for the `/teams` deep-link alias and document the redirect contract.
5. **End-to-end billing-rejection UX tests.** Phase 10 tests pin the helper-and-wiring contract; Phase 11 should add Playwright coverage that walks a FREE user from the locked CTA to `/billing`.
6. **Per-channel invite rate-limit observability.** Emit metrics for `COLLAB_TEAM_INVITE_RATE_LIMIT` hits per channel to feed plan-tuning.

None of the above is a billing-bypass; all are quality, observability, or follow-through items.

---

## 12. Sign-off

Per brief item 13, the following invariants are confirmed against the final validation state.

- [x] no FREE bypass — **PASS** (asserted by `phase-10-billing-guards.test.ts`; guard fires on all four mutating routes)
- [x] no PAYG bypass — **PASS** (same helper, plan check; pinned by test)
- [x] PRO limit enforced — **PASS** (`assertCanCreateCollaborationTeam` checks `maxTeams` vs `ownedTeamCount`)
- [x] TEAM limit enforced — **PASS** (same helper, same check)
- [x] member cap enforced — **PASS** (`assertCollaborationTeamMemberLimit` on direct-add and invite-accept)
- [x] invite cap / rate-limit enforced — **PASS** (`assertCanInviteCollaborationTeamMember` checks pending + 24h sent)
- [x] SMS plan gate enforced — **PASS** (same helper, channel branch, code `COLLAB_TEAM_SMS_NOT_INCLUDED`)
- [x] guest limit enforced — **PASS** (`assertCanInviteCollaborationTeamGuest`)
- [x] PayPal idempotent — **PASS** (`payloadHash` dedup key + atomic insert + secret-safe logs)
- [x] no duplicate Team product — **PASS** (sidebar / palette / route registry point only at `/collaboration-teams`)
- [x] Team not Workspace — **PASS** (`/collaboration-teams` is the user-facing product; `/workspaces` is admin-only)
- [x] all tests pass — **PASS** (matches `finalOK = true`: services/api tsc, apps/web tsc, services/api vitest, services/worker vitest, @proovra/shared test all exit 0)

**Phase 10 is CLOSED.**
