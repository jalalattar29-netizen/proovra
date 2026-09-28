# PROOVRA PayPal + Billing Page Repair — 2026-09-28

Companion to `proovra-billing-incident-audit-2026-09-28.md` (the incident
evidence). That audit was treated as evidence to verify, not as proof; where
this document disagrees with it, this one is based on code read and tests run
on branch `claude/admiring-meitner-plcagt`.

## 0. Status on the five rails

| Rail | Status |
|---|---|
| Implemented locally | Yes, for the scope in §4. Known gaps are listed in §9 and are NOT fixed. |
| Tests passed | Yes for every billing gate run here (unit, integration on PostgreSQL 16 + Redis, web render, mobile, browser). Full API unit gate still has 2 red tests, both in the Reports workstream (§6). |
| Sandbox verified | **No.** No sandbox credentials, sandbox webhook or EUR sandbox plan set exists in this environment (§8). All provider behaviour here is against an in-process fake of PayPal's documented responses. |
| Deployed | **No.** |
| Verified on the affected production account | **No.** No production read or write was made. The two 50 GB attempts are untouched (§7). |

**PayPal is not "fixed" and Billing is not "complete".** The offered PayPal
flows now have safe creation, correlation, recovery and exactly-once
settlement *in code and against a fake*; that has not been proven against real
PayPal.

## 1. Baseline

* Worktree: cloud checkout of `jalalattar29-netizen/proovra`, branch
  `claude/admiring-meitner-plcagt`, HEAD `e9efd55` ("fix: reconcile billing and
  report artifact lifecycles"), clean `git status`.
* **Your Windows worktree (`D:\digital-witness`) and its uncommitted Reports,
  package, TSA and OTS edits are not present in this checkout.** Nothing here
  touched them; nothing in them was reviewed.
* Deployed revision: not established. The earlier audit's unauthenticated probe
  (new storage-attempt route → 404) is the only deployment evidence; it was not
  repeated (no production access from here).

## 2. The 24 Windows failures — what can and cannot be classified

The pasted Windows excerpt does not contain the full list, and no machine
report was available here, so **the 24 cannot all be named from here**. What
was done instead: the full API unit suite was run on an untouched HEAD
worktree on Linux with the JSON reporter.

**Linux, HEAD `e9efd55`: 25,188 tests, 19 failed, in 14 files.**

| # | File (tests failed) | Classification | Evidence / cause |
|---|---|---|---|
| 1 | `phase-9-authority-writers` (1) | **Billing regression (Codex e9efd55)** | New storage-attempt writer `pending-checkout-attempt.service.ts` was never registered as a `WorkspaceStorageAddon` writer. |
| 2 | `phase-12-db-010-migration-artifact` (1) | **Billing regression** | `20280690000000_billing_storage_attempt_abandoned` shipped without an inventory record. |
| 3 | `phase-12-point6-migration-closure` (2) | **Billing regression** | same migration absent from inventory (279 ≠ 280). |
| 4 | `phase-12-point8-release-artifact` (3) | **Billing regression** | same migration unledgered. |
| 5 | `phase-32-7-2-security-event-mapping-drift` (1) | **Billing regression** | same migration not on the exact-name allowlist. |
| 6 | `phase-12-route-consumer-authority` (1) | **Billing regression** | 5 PayPal call sites unresolved: e9efd55 shifted lines in `paypal.service.ts`, orphaning the line-keyed reviewed origins. |
| 7 | `phase-12-capability-analyzer-adversarial` (2) | Billing regression + stale artifacts | #38 same 5 sites; #37 route inventory hash stale. |
| 8 | `phase-0-audit-engine-governance` (3) | Stale generated artifacts (mixed Billing+Reports commit) | `architecture-facts.json` not regenerated after e9efd55. |
| 9 | `phase-0-audit-self-reference` (1) | Stale generated artifacts | same. |
| 10 | `phase-12-coverage-manifest` (file-level) | Stale generated artifacts | same. |
| 11 | `phase-12b-evidence-operations-entry-matrix` (file-level) | Stale generated artifacts | same. |
| 12 | `phase-13-checkpoint-truth-gate` (2) | Stale generated artifacts | checkpoint counts disagreed with facts. |
| 13 | `phase-ia-self-serve-regression-fix` (1) | **Reports regression** | `tryUserScopedReports` / empty-workspace fallback assertion (the one visible in your excerpt). |
| 14 | `phase-e10-2-operational-readiness` (1) | **Reports regression** | `reports-aggregator.service.ts` 45,508 bytes > pinned 43,714 (+10%). |

Windows-only (from your excerpt): `read-only-scan.test.ts` —
`spawnSync C:\WINDOWS\system32\cmd.exe ENOENT` — passes on Linux at HEAD, so it
is a **Windows/test-harness** failure.

**Unaccounted:** Windows reported 21 files / 24 tests; Linux HEAD shows 14 /
19 plus one Windows-only file. The remaining ~6 files / ~4 tests are not
visible from here and may come from your uncommitted Reports/TSA/OTS edits or
from further Windows-only harness issues. They are **not** assumed harmless.
To get the full list, run on Windows:

```
pnpm --filter proovra-api exec vitest run --reporter=json --outputFile=api-unit.json
```

### Final gate results after this work (Linux)

Final full API unit run: see §6.3. The 12 billing/governance files above
are fixed; the 2 Reports files (#13, #14) remain red and were deliberately not
touched. No test was skipped, deleted or weakened; two source-shape assertions
that encoded the defect itself were rewritten to assert the corrected rule and
say so in place (`phase-9-commercial-invariants`, the Codex render test that
asserted raw PayPal ids *are* shown).

## 3. Offered PayPal flows — transaction matrix

Organization billing is contract-managed; **no organization self-service
checkout exists**, so every self-service row is the Personal account.
Mobile checkout exists only in private-distribution builds
(`EXPO_PUBLIC_PRIVATE_BILLING=enabled`); public builds have none.

Legend — Impl: implemented locally; Test: automated proof here; SB: Sandbox;
Prod: production.

| Flow | UI control → route | Ownership check | Local attempt record (pre-provider) | PayPal resource / idempotency key | Price & currency authority | Return | Webhook | Canonical writer | Payment row | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| FREE → PRO / TEAM | Choose a plan → PayPal → `POST /v1/billing/checkout/paypal` | `BILLING_MANAGE` on PERSONAL/self; managed-identity refused | **NEW** `billing_checkout_attempts` (PLAN) committed under advisory lock before any call | Subscription; `PayPal-Request-Id` = attempt id; `custom_id` = `user::PLAN:attemptId` | Server `getPlanPriceCents(plan, currency)`; currency is one of two server-priced offers; PayPal plan id from env per currency | `?subscription_id` → `/checkout/paypal/subscriptions/:id/confirm` (live read, caller-bound) | `BILLING.SUBSCRIPTION.*` (live read, attempt bound by `custom_id` when response lost) | `syncPlanForSubscription`; entitlement only on ACTIVE | `PAYMENT.SALE.COMPLETED` → `recordPayment` | Impl ✔ Test ✔ SB ✘ Prod ✘ |
| PRO → TEAM (upgrade) / TEAM → PRO (downgrade) | Manage plan → `POST /v1/billing/subscription/plan` | `BILLING_MANAGE` | none (changes an existing subscription) | `revise` (no request id) | **FIXED:** currency now read from the live subscription (PayPal `plan_id` → env map; Stripe `subscription.currency`), not the request's USD default | approval URL if PayPal returns one | `BILLING.SUBSCRIPTION.UPDATED` | `pendingPlan` recorded; plan applied only when PayPal bills the new plan at period end | renewal sale | Impl ✔ Test ✔ (EUR case) SB ✘ Prod ✘ |
| Stale UI / existing subscription | any checkout | same | refused before attempt | none created | — | — | — | `SUBSCRIPTION_ALREADY_ACTIVE` (409) | — | Test ✔ |
| Duplicate click | same | same | open attempt found under lock | **REUSED**: same PayPal resource read live and returned; no second create | — | — | — | — | — | Test ✔ (plan + credit) |
| Renewal | — | — | — | sale id | provider amount recorded; reconcile checks catalog | — | `PAYMENT.SALE.*` | `applyPayPalSubscriptionState` | `recordPayment` keyed by sale id | Impl (pre-existing) SB ✘ |
| Cancellation | Manage plan → Cancel → `POST /v1/billing/subscription/cancel` | `BILLING_CANCEL` | — | provider-first cancel | — | — | `CANCELLED` | **FIXED** `syncPlanForSubscription` (see D1) | — | Impl (pre-existing + D1) |
| Restart / resubscribe | **Not offered** (copy still says "Restart it first") | — | — | — | — | — | — | — | — | **Gap G2** |
| Storage add-on (each SKU) | Add storage → PayPal → `POST /v1/billing/storage-addons/checkout/paypal` | `BILLING_ADDON_PURCHASE` | `workspace_storage_addons` PENDING row (Codex, verified) | Subscription; request id = row id; `custom_id` `sa2|user|-|code|attemptId` | Server catalog currency per SKU (EUR); client currency must match or 409 | same confirm route | `BILLING.SUBSCRIPTION.*` | `upsertWorkspaceStorageAddon` (**FIXED** D2); capacity only ACTIVE/PAST_DUE | renewal sale | Impl ✔ Test ✔ SB ✘ Prod ✘ |
| Multiple storage add-ons | same, sequentially | same | one PENDING PayPal storage attempt at a time per account | — | — | — | — | — | — | Test ✔ (gate) |
| Evidence credit | Buy credits → PayPal → `POST /v1/billing/credits/checkout/paypal` | `BILLING_ADDON_PURCHASE` | **NEW** attempt (EVIDENCE_CREDIT) | Order; `PayPal-Request-Id` = attempt id; `custom_id` = `user::PAYG:attemptId` | `getPlanPriceCents(PAYG, currency)` | `?token` → `/credits/checkout/paypal/:orderId/capture` (**now also `BILLING_ADDON_PURCHASE`**) | `CHECKOUT.ORDER.APPROVED` (captures), `PAYMENT.CAPTURE.*` | `grantEvidenceCredits` keyed by capture id; capture `PayPal-Request-Id` = `proovra-capture-{orderId}` | `recordPayment` keyed by capture id | Impl ✔ Test ✔ (both orders, pending capture) SB ✘ |
| Buyer cancels / closes browser / never returns | — | — | attempt stays PENDING/AWAITING | — | — | cancel URL shows toast | none for an unapproved order | Billing activity shows it; Check status / Abandon | none | Test ✔ |
| Lost create response | — | — | attempt PENDING / `PROVIDER_OUTCOME_UNKNOWN` | resource exists at PayPal with attempt id in `custom_id` | — | — | CREATED (plans/storage) binds it | attempt bound | — | Test ✔ (plans) |
| Delayed / duplicate webhook | — | — | — | — | — | — | lease (**FIXED** D3), dedup by event id | idempotent writers | keyed | Test ✔ |

## 4. What was changed, and why (defects with root-cause evidence)

Severity: C critical (money/entitlement), H high, M medium.

| ID | Sev | Product | Defect (evidence) | Fix |
|---|---|---|---|---|
| D1 | C | Plans | `syncPlanForSubscription` wrote FREE on **any** CANCELED subscription. A PayPal approval that never activated (TRIALING) and is later cancelled/expired at PayPal downgraded a customer whose plan comes from another (e.g. Stripe) subscription or a granted tier. | A cancellation removes entitlement only if that subscription carried it (was not TRIALING) and no other base subscription is ACTIVE/PAST_DUE. Integration test covers Stripe-paid, granted and genuine cases. |
| D2 | H | Storage (Codex) | `upsertWorkspaceStorageAddon` replaced `metadata` wholesale and nulled `externalPaymentId`/provider/expiry when an event omitted them. The CREATED webhook arrives seconds after creation, so the new create diagnostics (debug id, approval-link identity) were erased almost immediately — the exact evidence the incident lacked. | Metadata merged; unnamed fields preserved. Integration test. |
| D3 | H | Webhooks (Codex) | PayPal lease returned "retry later" only when the payload hash matched; a byte-different redelivery during an active lease was reclaimed and processed **concurrently**. | Any active lease defers (503). Unit test fails on old code, passes on new. |
| D4 | C | Plan + credits | PayPal plan and credit checkouts created the provider resource with **no durable local record and no idempotency key**; a credit order was invisible until captured. | `billing_checkout_attempts` + `openCheckoutAttempt` (advisory lock, reuse window), request id + `custom_id` binding, settlement records outcomes. |
| D5 | H | Plan change | `/subscription/plan` defaulted currency to USD (web sends none); an EUR subscriber's PayPal `revise` targeted the USD plan; Stripe likewise. | Currency read from the live provider subscription; unrecognised plan id refuses. |
| D6 | H | Re-check | TRIALING plan rows returning 404 counted as "provider unavailable"; abandoned storage rows (404/unbound) counted as action-required on every re-check forever; mobile said "Your provider is still settling a payment" for any PENDING outcome. | Unified attempt pass with per-attempt outcomes; abandoned attempts never action-required; web + mobile messages built from counts; "waiting" only for provider-confirmed approval. |
| D7 | H | Billing page | Storage card listed pending attempts **with raw PayPal ids and internal references** while history said "No payments yet"; plan/credit attempts appeared nowhere. | History response now carries account-scoped `activity`; one "Billing activity" list with explanation and safe actions; storage card lists capacity only. |
| D8 | M | Abandon | An approval PayPal still shows as open could not be abandoned (dead end until an unannounced expiry). | Abandon allowed with confirmation for APPROVAL_PENDING (cannot charge without approval); refused for APPROVED / capture pending; provider truth still wins afterwards (tested). |
| D9 | M | Adapter | Unknown PayPal status reported as an outage; resume URLs accepted any `https://` host. | `UNSUPPORTED_STATE`; PayPal-hosts-only allowlist. |
| D10 | M | Actions | Per-attempt recheck/abandon had no rate limit, no audit and no per-attempt lock. | Rate limit, audit, transaction-scoped advisory lock (409 on concurrent click). |
| D11 | M | Mobile (private builds) | Storage checkout sent the catalogue display currency (USD) for EUR-only SKUs → now a guaranteed 409; button showed the price with the wrong currency label. | Sends the offer's own currency; label uses the offer's price/currency. |
| D12 | M | Credit capture route | No billing capability check (ownership was proven only by `custom_id`). | `BILLING_ADDON_PURCHASE` required. |
| D13 | M | Routes (Codex) | Storage-only recheck/abandon routes duplicated the action path. | Removed (never deployed); generic routes cover storage. |
| D14 | M | Layout | Activity rows overflowed and clipped at 390px. | `minmax(0,1fr)` track + wrapping actions; browser-tested. |
| D15 | M | Governance (Codex) | Storage writer unregistered; migration uncurated; stale audit artifacts; line-keyed reviews orphaned. | Registered, curated, re-anchored, regenerated. |

Verified from the earlier Codex work and **kept**: durable storage attempt
before the call; `sa2` custom id with attempt UUID; old-format (`sa1`, JSON)
compatibility; webhook lease semantics for Stripe; pre-provider storage
currency rejection; exact approval-link handoff; ABANDONED enum as additive.

## 5. Billing page — control inventory

| Control | Visible when | Authorization | Request | Server outcome | User message | Refresh | Repeated clicks |
|---|---|---|---|---|---|---|---|
| Choose a plan / Manage plan | `actions.planManagement` (server) | `BILLING_MANAGE` | opens drawer | — | — | — | — |
| Plan checkout (Stripe/PayPal) | FREE / granted, offers present | `BILLING_MANAGE` | `{plan, currency}` | 200 approval link; 409 `SUBSCRIPTION_ALREADY_ACTIVE` / `PAYPAL_APPROVAL_PENDING` / `PAYPAL_DIFFERENT_PLAN_PENDING` | server message | on close | button busy; server lock + reuse |
| Resolve pending PayPal approval (drawer) | after a 409 pending | `BILLING_MANAGE` | `{plan, confirmed?}` | provider-first; confirmation text says nothing is cancelled at PayPal | warning shown | yes | busy |
| Upgrade / downgrade | subscriber | `BILLING_MANAGE` | `{plan}` only | provider-confirmed; PayPal returns approval URL or schedules | server `effectSummary` | yes | per-plan busy |
| Cancel subscription | subscriber, `BILLING_CANCEL` | `BILLING_CANCEL` | `{}` | provider-first | period-end date | yes | busy |
| Buy credits | `canBuyEvidenceCredits` | `BILLING_ADDON_PURCHASE` | `{currency}` | order; 409 `CHECKOUT_IN_PROGRESS` while one is being created | — | — | reuse window 2 min |
| Add / Manage storage | offers present | `BILLING_ADDON_PURCHASE` | `{addonKey, billingCycle, currency=offer}` | 409 on currency mismatch or open PayPal storage approval | server message | — | busy + lock |
| Cancel storage | ACTIVE/PAST_DUE, server `canCancel` | add-on capability | addon id | provider-first | — | yes | per-row busy |
| **Check status** (activity) | attempt open, server `canRecheck` | PLAN→`BILLING_MANAGE`; STORAGE/CREDIT→`BILLING_ADDON_PURCHASE`; attempt must belong to the path account | `{}` | provider read + canonical apply | specific per outcome (never "settling" for 401/404/unbound/outage) | history + projection | row busy; 409 `BILLING_ATTEMPT_BUSY` server-side |
| **Continue at PayPal** | only after a fresh check reports an open approval with a PayPal-hosted link | — | link | — | — | — | — |
| **Abandon** (activity) | open and not processing | as Check status | `{confirmed:false}` then `{confirmed:true}` | provider-first; local only; `cancelsAtProvider:false` | confirmation dialog states it cancels nothing at PayPal | yes | row busy + lock |
| Payment row Re-check / Cancel payment / Abandon payment attempt | pending payment rows | view / `BILLING_CANCEL` | `{}` / `{confirmed}` | pre-existing | pre-existing | yes | row busy |
| Re-check purchases and billing | provider-backed accounts | `BILLING_MANAGE` | `{}` | reconcile; 4 per 5 min, one run per account | "Checked N items… X updated… Y waiting for your approval at PayPal… Z could not be confirmed… provider could not be reached for W" | yes | busy + server lease |

## 6. Payment / activity / attempt state model

* **Payments (Billing history table)** — `payments` rows only, i.e. money the
  provider reported moving (or a pending/failed charge it reported). Keyed
  `(provider, providerPaymentId)`. An unapproved checkout never has one.
* **Billing activity** — attempts that have not produced a completed payment:
  storage rows never activated (PENDING any age; FAILED/CANCELED/EXPIRED/
  ABANDONED ≤ 90 days), PLAN/CREDIT attempts (PENDING any age; terminal ≤ 90
  days), and pre-attempt TRIALING PayPal subscriptions. Completed attempts
  leave activity and appear as a payment (and entitlement).
* **States shown**: Waiting for approval · Not confirmed (PayPal never
  confirmed creation) · No record at PayPal (last check 404) · Status unknown
  (last check unreachable / unverifiable) · Processing (approved, capture
  pending) · Being reviewed (amount mismatch) · Failed · Canceled · Expired ·
  Abandoned. Each carries the server's explanation of why no payment or
  entitlement exists yet.
* Account scoping: every query filters by the account in the path
  (`userId`/`ownerUserId` + `teamId: null`); another account's attempt id is a
  404 on read and on every action (tested).

### 6.3 Final gates (Linux, this branch)

| Gate | Result |
|---|---|
| API full unit suite | 25,270 tests: 25,266 passed, 1 pending, **3 failed**; `phase-0-audit-self-reference` failed only because this report was uncommitted (it requires a clean tree) and passes 7/7 after committing. Remaining red: `phase-ia-self-serve-regression-fix` and `phase-e10-2-operational-readiness` — both **Reports workstream, red at HEAD, untouched**. HEAD was 19 failed. No new failure. |
| API billing integration (fresh PostgreSQL 16 + pgvector, Redis) | 10 files, **191 / 191** passed |
| API typecheck | clean except pre-existing `reports-summary-filter-parity.integration.test.ts:253` (Reports, HEAD) |
| API lint (changed files), API build | pass |
| Migrations | `migrate deploy` from empty OK; `migrate diff` shows no drift for the new table (unrelated pre-existing index-name drift unchanged); inventory 281/281, gate failures 0 |
| Architecture audit | `AuditEngineIntegrity = PASS`; `--closure-check ReleaseBlockingClosure = PASS` |
| Web typecheck, lint (billing), production build | pass (pre-existing `SurfaceGate.tsx` hook warning) |
| Web billing render tests | 6 files, 144 / 144 |
| Browser (`billing-layout`, Chromium, prod build) | 52 run: 50 passed; **2 failed — plan-card colour tests, reproduced identically on an untouched HEAD build (pre-existing)**. New activity spec 6 / 6 (1440 and 390px). |
| Mobile | typecheck clean; full suite 1,821 / 1,821 (an earlier run overlapping the API suite had 2 timing failures that pass alone and on rerun; HEAD 1,819 / 1,819) |
| Sandbox | not run |

## 7. Deployment sequence and the two 50 GB attempts

1. Snapshot the two rows (`a2cc1107-…`, `b5c641a3-…`) with the read-only
   queries in the incident audit.
   Or run the read-only verifier (follow-up §11 R7):
   `pnpm --filter proovra-api ops:verify-historical-billing-attempts [--provider]`
   — SELECTs and at most one PayPal GET per subscription; it refuses
   `--apply`/`--abandon`/`--cancel` and writes nothing.
2. Apply `20280690000000_billing_storage_attempt_abandoned`,
   `20280700000000_billing_checkout_attempts` and
   `20280710000000_billing_stripe_attempts_billed_currency` (all additive).
3. Deploy the API; **drain every older API instance** before any abandonment
   (older Prisma clients cannot read `ABANDONED`) and before the first Stripe
   storage checkout (older clients cannot read a `STORAGE_ADDON` attempt).
4. Confirm `POST /v1/billing/accounts/PERSONAL/x/checkout-attempts/<uuid>/recheck`
   answers 401 unauthenticated (not 404). Then deploy the web.
5. As the account holder, open Billing: Billing activity should list two
   "+50 GB storage add-on · €7.99 / month" items.
6. For each: **Check status** (fresh provider read). Expected: "PayPal has no
   record of this checkout any more". **If PayPal returns anything else — above
   all ACTIVE — stop**: the canonical writer applies it; escalate before any
   further action.
7. Only after a 404: **Abandon** → read the confirmation → confirm. Expected
   `ABANDONED`, `cancelsAtProvider:false`, no PayPal call other than GETs.
8. Verify: no payment row, capacity unchanged, provider ids preserved on the
   rows, and a subsequent "Re-check purchases and billing" does not list them
   as needing action.

Historical facts (USD 7.99 PayPal plan, EUR 7.99 local rows) are not
rewritten: the rows keep their stored currency; only new attempts use the
catalogue currency.

## 8. Unresolved provider-side questions and the evidence required

| Question | Needed evidence |
|---|---|
| Why the hosted login/approval failed for `I-4P6XLPVJEMBK` / `I-X3KCTML39FWX` | PayPal Merchant Technical Support case (drafted in the incident audit) |
| Can an `APPROVAL_PENDING` subscription be cancelled by API? (would let Abandon also cancel at PayPal) | Sandbox: create, do not approve, `POST …/cancel`, record status/body |
| When does an unapproved subscription/order start returning 404, and does a late approval still work? | Sandbox timing run |
| `PayPal-Request-Id` retention window for subscriptions and orders (safety of any future replay) | PayPal docs confirmation + sandbox replay after 1h / 24h / 72h |
| Does `revise` accept a plan in another currency? | Sandbox revise PRO-EUR → TEAM-USD |
| Transaction Search API `403 NOT_AUTHORIZED` | Enable the permission on the live app, or keep Activity-page checks |
| Full sandbox proof | Sandbox client id/secret, webhook id + reachable endpoint, EUR (and USD) plans for PRO, TEAM and each storage SKU, a sandbox buyer; then run plan purchase/change, storage, credit (approve+capture, capture pending, decline), return-before/after-webhook, duplicate webhook, lost response |

## 9. Known gaps (updated by the follow-up in §11)

* **G1 Stripe durable attempts** — implemented and tested in the follow-up (§11 R1). Not Stripe-test-mode verified.
* **G2 Restart** — implemented for Stripe (period-end cancellations); PayPal is refused truthfully (§11 R2).
* **G3 Legacy `teamId` rows** — payer-owned rows are now reconciled (§11 R3); rows for a workspace someone else now owns are deliberately left to Operations.
* **G4 Duplicate live subscriptions** — now DETECTED and shown as a CRITICAL action-required banner; never auto-cancelled (§11 R4). Still cannot be prevented at PayPal.
* **G5** A webhook handler exceeding the 5-minute lease can be reclaimed while still running. **Unchanged.**
* **G6 Billed currency** — implemented (§11 R5); legacy rows show no price until observed.
* **G7** Organization accounts show no activity (none is possible: no self-service checkout).

## 10. Files, migrations, compatibility, tests

Commits on `claude/admiring-meitner-plcagt` after `e9efd55`: see `git log`.
New: `billing_checkout_attempts` table + 2 enums (migration
`20280700000000_billing_checkout_attempts`); services
`checkout-attempts`, `paypal-checkout-start`, `checkout-attempt-recovery`,
`billing-activity`; routes `POST …/checkout-attempts/:attemptId/recheck|abandon`;
web `billingMessages.ts`; tests `billing-checkout-attempts.integration.test.ts`
(13), `billing-activity-messages.render.test.tsx` (13),
`e2e/billing-layout/billing-activity.spec.ts` (6, desktop + 390px), plus
updates listed by `git diff --stat e9efd55..HEAD`.

Compatibility: old `custom_id` formats parse unchanged (3-segment plan ids,
`sa1`, JSON); pre-attempt TRIALING subscriptions are treated as legacy plan
attempts; old API instances never read the new table; the removed storage-only
routes were never deployed.

## 11. Follow-up — the seven remaining items

Legend: **Impl** implemented in code · **Tested** automated tests on this branch
(simulated providers, live PostgreSQL 16) · **Sandbox** verified against PayPal
Sandbox / Stripe test mode · **Deployed** on production. Nothing in this
section is Sandbox-verified or deployed.

| # | Item | Impl | Tested | Sandbox | Deployed | Unresolved |
|---|---|---|---|---|---|---|
| R1 | Stripe durable attempts | yes | yes | no | no | Real Stripe behaviour of `Idempotency-Key` reuse and `/expire` not proven |
| R2 | Restart / resubscribe | Stripe yes; PayPal refused truthfully | yes | no | no | Dependent storage add-ons already scheduled to end are NOT restarted (told to the customer) |
| R3 | Legacy `teamId` billing rows | yes (payer-owned only) | yes, incl. cross-owner negative | no | no | Rows for a workspace someone else now owns; dependent-cancellation convergence still `teamId: null` only; production inventory not run |
| R4 | PayPal abandonment + duplicate subscriptions | yes | yes | no | no | Whether PayPal can cancel an `APPROVAL_PENDING` subscription (expected 422); duplicates are detected, not prevented |
| R5 | Actual billed currency | yes | yes | no | no | Legacy rows show no price until a provider event / re-check records it |
| R6 | Reports / Windows test failures | test-level fixes (`3c4d9af`) | partly | n/a | no | Reports summary integration: 3 behavioural failures (Reports source not touched — your local uncommitted Reports work); ~6 Windows files need your JSON report |
| R7 | Two historical PayPal attempts | read-only verifier | ran against local DB only | no | no | Disposition still requires deployment + owner's per-attempt Check status → Abandon |

### R1 — Stripe durable attempts
* `stripe-checkout-start.service.ts`: `startStripePlanCheckout` /
  `startStripeCreditCheckout` / `startStripeStorageCheckout` commit an attempt
  (advisory lock) **before** Stripe is called, then create the Checkout
  Session with `Idempotency-Key: proovra-checkout-<attemptId>`,
  `metadata[attemptId]` and `client_reference_id`, and bind the session id.
  A Stripe 4xx (not 409/429) → `FAILED / PROVIDER_REJECTED`; anything else →
  `PROVIDER_OUTCOME_UNKNOWN` (may exist). A duplicate click within 2 min
  re-reads the open session and returns it (one session, never two).
* PLAN attempts now share one lock and block **across providers**: an open
  Stripe plan checkout refuses a PayPal one (`PLAN_CHECKOUT_ALREADY_OPEN`, copy
  names the card checkout) and vice versa.
* `stripe-settlement.service.ts` is the one settlement for a session, used by
  `checkout.session.completed`, the new `checkout.session.expired` handler and
  the per-attempt re-check. Credits are granted only when `payment_status=paid`
  AND the amount equals the catalogue price (else `NEEDS_REVIEW`); completed
  but unpaid is `CAPTURE_PENDING` (never abandonable). **Defect fixed:** the
  webhook previously granted a credit on `checkout.session.completed` without
  checking `payment_status`. **Defect fixed:** monthly storage lifecycle
  webhooks were dropped because the billing-cycle parser rejected `MONTHLY`.
* Recovery: Stripe attempts are read live (`GET /checkout/sessions/:id`);
  401/404/400 are classified (not "outage"). Abandon of an open session
  **expires it at Stripe** (`cancelsAtProvider: true` only when Stripe
  confirms); if Stripe cannot confirm, nothing is written and the row stays
  open (`PROVIDER_CANCEL_FAILED`).
* Billing activity: Stripe rows say "Card" / "Stripe", never PayPal; storage
  attempts carry their SKU. Web resume links accept only
  `https://checkout.stripe.com` (plus PayPal hosts); the checkout drawer now
  validates the Stripe redirect host too.
* Migration `20280710000000_billing_stripe_attempts_billed_currency`
  (additive; drain older API instances before the first Stripe storage checkout).

### R2 — Restart
`POST /v1/billing/subscription/resume` (BILLING_MANAGE) →
`subscription-resume.service.ts`: Stripe `cancel_at_period_end=false`
provider-first; local row changes only on Stripe's confirmation; ended
subscriptions refused. PayPal: `409 PROVIDER_CANNOT_RESTART` — "PayPal ends a
subscription as soon as it is cancelled … after that you can subscribe again".
The plan-change refusal no longer says "Restart it first" for PayPal. Web:
"Restart subscription" in Manage plan, with confirmation.

### R3 — Legacy `teamId` rows
Personal "Re-check purchases and billing" now covers subscriptions and
recurring storage rows where `userId`/`ownerUserId` is this person AND
(`teamId` is null OR that workspace is still owned by this person). A row the
person paid for against a workspace now owned by someone else is **not**
reconciled into either account. Read-only inventory for production:

```sql
SELECT s.id, s.provider, s.status, s.plan, s.team_id,
       (t.owner_user_id = s.user_id) AS payer_owns_workspace
FROM subscriptions s LEFT JOIN teams t ON t.id = s.team_id
WHERE s.team_id IS NOT NULL AND s.status IN ('ACTIVE','PAST_DUE','TRIALING');
```

### R4 — PayPal abandonment + duplicates
Abandoning an open PayPal **plan** approval now asks PayPal to cancel it;
`cancelsAtProvider` is true only on PayPal's 2xx. PayPal documents cancel for
ACTIVE/SUSPENDED only, so a 422 is expected and the attempt is abandoned
locally (the confirmation says so and does not promise a provider stop).
PayPal storage and credit abandonment remain local-only (unchanged). Two
live base subscriptions now raise a CRITICAL action-required banner with no
"nothing charged" reassurance; neither is cancelled automatically.

### R5 — Billed currency
`subscriptions.billed_currency` / `billed_unit_amount_cents` are written from
the provider (PayPal plan id / last payment, Stripe subscription currency /
unit amount) by the canonical writers. The plan card prints that currency, or
no figure when unknown — never the display-currency guess.

### R6 — Reports / Windows
Unchanged from `3c4d9af`: `phase-ia-self-serve-regression-fix`,
`phase-e10-2-operational-readiness`, the Reports integration typecheck and the
Windows `read-only-scan` harness issue are fixed at test level. Open: the
Reports summary integration test's 3 behavioural failures (`packagesFailed`
0 vs 1, empty `package_blocked`) — diagnosis points at fixture plan
eligibility; not fixed because the aggregator is part of your uncommitted
Reports work. The remaining ~6 Windows-only files need the JSON report.

### R7 — Historical attempts
`pnpm --filter proovra-api ops:verify-historical-billing-attempts [--provider]`
prints each row's status, checkout state, binding, activation, payment
references, and (with `--provider`) one PayPal GET result. It refuses
`--apply`/`--write`/`--abandon`/`--cancel`/`--fix`. Disposition remains §7
steps 5–8, after deployment. Historical facts are not rewritten.

### Follow-up gates (Linux, this branch)
