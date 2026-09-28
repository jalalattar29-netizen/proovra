# PROOVRA Billing Incident Audit - 2026-09-28

## Decision

Billing is **not release-ready** and PayPal is **not proven fixed**. The two
production 50 GB attempts are now correlated read-only across the database,
PayPal application-scoped webhook records, fresh provider reads, and merchant
Activity. Neither attempt charged the merchant account and both may be
locally marked `ABANDONED` after the repaired API is deployed and performs its
final provider-first recheck. The approval-page failure itself remains
unexplained by PayPal evidence, so no causal claim is made from the discovered
USD/EUR inconsistency.

Readiness must be stated on four separate rails:

| Rail | Result |
|---|---|
| Locally implemented | Partial: storage recovery, webhook retry leases, paid Stripe upgrade collection, canonical EUR storage offers, and pre-provider currency-mismatch rejection are implemented locally. Open defects remain below. |
| Sandbox verified | No. No usable sandbox credentials or configured sandbox plan/price set was available. |
| Deployed | No. Production does not expose the new storage-attempt route (unauthenticated probe returned 404). |
| Affected account verified | Read-only correlation complete; no charge found. Local disposition remains intentionally unperformed until the repair is deployed. |

## Commercial Rules

1. `FREE`, `PRO`, and `TEAM` are one Personal-account ladder. `ENTERPRISE` is
   contract-managed and `PAYG` is not a plan; an evidence credit is a product.
2. A Personal account may have at most one live base subscription. A stale UI
   must receive `SUBSCRIPTION_ALREADY_ACTIVE`/change-plan handling, never a
   second checkout.
3. Stripe upgrades are immediate only after the prorated difference is paid.
   Stripe downgrades are scheduled at period end. PayPal revisions take effect
   at the next billing cycle and may require buyer approval.
4. Storage add-ons are recurring monthly subscriptions. Historical `ONE_TIME`
   rows remain grandfathered and cannot be cancelled as subscriptions.
5. Storage contributes capacity only in `ACTIVE` or grace-state `PAST_DUE`;
   never-active `FAILED`, `PENDING`, `ABANDONED`, `CANCELED`, and `EXPIRED` do
   not contribute.
6. One evidence-credit purchase grants the catalog quantity exactly once and
   only after a provider-confirmed successful Stripe payment or PayPal capture.
7. Organization billing is contract-managed. There is no organization
   self-service checkout in the current product.

## Transaction Matrix

Legend: `L` locally covered, `S` sandbox proof, `P` production proof, `RED`
known release blocker.

| Product/action | Provider | Entry and account | Provider/local lifecycle | Status |
|---|---|---|---|---|
| Initial PRO/TEAM purchase (also FREE -> paid) | Stripe | Web Billing, Personal; `BILLING_MANAGE` | Checkout Session -> verified webhook -> `syncPlanForSubscription`; no durable pre-provider attempt or request id | L; S no; P no; **RED lost response/attempt visibility** |
| Initial PRO/TEAM purchase (also FREE -> paid) | PayPal | Web Billing, Personal; `BILLING_MANAGE` | Subscription -> local `TRIALING` row -> return/webhook -> canonical writer; gate blocks a second visible pending row | L; S no; P no; **RED provider object precedes local row and no create idempotency key** |
| PRO <-> TEAM change | Stripe | Web Manage plan, Personal | Existing subscription update/schedule; upgrade now uses `always_invoice` + `error_if_incomplete`; downgrade schedule preserves old entitlement | L unit proof; S no; P no |
| PRO <-> TEAM change | PayPal | Web Manage plan, Personal | `revise`; `pendingPlan` retains current entitlement until provider plan id confirms transition | L unit proof; S no; P no; approval behavior unproved |
| Renewal | Stripe | Webhook + account/scheduled reconcile | Invoice payment keyed by provider invoice id; subscription writer ordered by provider timestamp | L; S no; P no |
| Renewal | PayPal | Webhook + account/scheduled reconcile | Sale/capture keyed by provider id; live subscription read converges state | L; S no; P no |
| Base cancellation | Stripe | Web/mobile management, Personal; `BILLING_CANCEL` | Provider-first `cancel_at_period_end`; local terminal state waits for webhook/reconcile; dependent add-on obligations durable | L; S no; P no |
| Base cancellation | PayPal | Web/mobile management, Personal; `BILLING_CANCEL` | Provider-first immediate cancel; dependent add-on obligations durable | L; S no; P no |
| Resubscribe/restart after scheduled cancellation | Stripe/PayPal | No route or control | Service error tells customer to restart first, but no restart authority exists | **Unsupported and RED copy/flow gap** |
| Monthly storage purchase | Stripe | Web Billing, Personal; `BILLING_ADDON_PURCHASE` | Checkout Session -> webhook -> storage writer; no durable pre-provider attempt/request id | L; S no; P no; **RED lost response/attempt visibility** |
| Monthly storage purchase | PayPal | Web Billing, Personal; `BILLING_ADDON_PURCHASE` | Durable storage row before provider; row id is `PayPal-Request-Id` and `sa2` custom id; return/webhook/reconcile CAS writes | L integration proof; S no; P plan-read only; deployed no |
| Storage resize/change | Stripe/PayPal | No direct resize operation | Buy another recurring add-on and/or cancel an existing one; no atomic replace | Supported only as separate buy/cancel operations |
| Storage cancellation | Stripe | Web/mobile, Personal | Provider-first period-end schedule; capacity retained until terminal provider fact | L; S no; P no |
| Storage cancellation | PayPal | Web/mobile, Personal | Provider-first immediate cancellation; terminal provider fact removes capacity | L; S no; P no |
| Evidence-credit purchase | Stripe | Web Billing, Personal; `BILLING_ADDON_PURCHASE` | Payment Checkout Session -> webhook -> idempotent credit ledger + payment | L; S no; P no; **RED no pre-provider attempt/account-wide discovery** |
| Evidence-credit purchase | PayPal | Web Billing, Personal; `BILLING_ADDON_PURCHASE` | Order approval -> capture with stable `proovra-capture-{orderId}` -> capture-id keyed credit/payment | L race/idempotency proof; S no; P no; **RED order create has no durable attempt/idempotency key** |
| Organization checkout | Any | Not offered | Enterprise contract provisioning only | Unsupported by design |
| Native purchase | Any | Not offered | Mobile source explicitly marks the three checkout transactions unresolved; reads, history, recheck, and cancellation remain | Unsupported pending distribution policy |

No checkout enables Stripe automatic tax or sends an application-computed tax
amount. PayPal recurring tax, if any, is a property of the configured provider
plan. Tax behavior therefore requires provider-catalog inspection before launch;
the application source alone cannot prove the customer total.

## Canonical State Map

| Layer | States and authority |
|---|---|
| Local checkout attempt | Provider-unbound create-in-progress; awaiting approval; provider processing; failed/canceled/expired; locally abandoned. Only PayPal storage currently models every pre-provider boundary durably. |
| Provider resource | Stripe Checkout Session/subscription/invoice; PayPal order/subscription/capture. Provider id plus provider timestamp is immutable evidence. |
| Payment | `PENDING`, `SUCCEEDED`, `FAILED`, `REFUNDED`, `CANCELED`, `EXPIRED`, `ABANDONED`; `recordPayment` is keyed by `(provider, providerPaymentId)` and settlement cannot move backwards. |
| Entitlement | Base plan through `syncPlanForSubscription`; storage through `upsertWorkspaceStorageAddon`; credits through `grantEvidenceCredits`. Browser query parameters grant nothing. |
| Scheduled transition | `pendingPlan` + `pendingPlanEffectiveAtUtc` or `cancelAtPeriodEnd`; current paid entitlement remains until provider-confirmed effect. |

`ABANDONED` is a local customer disposition, not provider cancellation. A later
provider-proven successful payment or active subscription must still win.

## Confirmed Defects And Disposition

1. **PayPal storage attempts were not durable/recoverable.** The local repair
   creates the attempt before the provider call, uses its UUID as the PayPal
   idempotency key and custom-id binding, classifies provider failures, and
   exposes per-attempt recheck/abandon actions. This is implemented, not
   deployed or production-verified.
2. **Webhook crash could become permanent data loss.** Stripe treated every
   duplicate id as processed. PayPal treated an identical `RECEIVED` payload as
   processed. A crash after inserting the dedupe row suppressed all later
   delivery. Both now use a five-minute processing lease: active duplicates get
   a retryable non-2xx, expired/failed rows are atomically reclaimed, and only
   `PROCESSED` is a durable no-op. A processed PayPal event is deduplicated by
   its immutable provider event id even if a later delivery has different
   bytes; the hash mismatch is logged as telemetry and cannot reopen business
   processing for another payload/account.
3. **Stripe upgrade could grant before collecting the proration.** The update
   used `create_prorations`, then unconditionally wrote `ACTIVE`. It now uses
   `always_invoice` and `error_if_incomplete`, and refuses a non-active result.
4. **Pricing advertised the wrong storage lifecycle.** The pricing DTO said
   `ONE_TIME` while both checkout routes sell monthly subscriptions. It now
   publishes `MONTHLY`.
5. **Provider-create durability is incomplete outside PayPal storage.** Stripe
   plan/storage/credit and PayPal plan/credit create a provider resource before
   a durable local attempt (or never create an attempt). They also lack a stable
   provider create key. This remains release-blocking.
6. **Account-wide recheck cannot discover an unknown provider resource.** It
   follows stored subscription/payment/add-on references. An unbound storage
   attempt is reported accurately, but no action replays its stable PayPal
   create request; an uncaptured credit order with no local payment cannot be
   discovered. This remains release-blocking.
7. **Attempt presentation is product-asymmetric.** PayPal storage attempts are
   now visible. PayPal plan `TRIALING`/plan transitions are visible through the
   plan projection. Stripe Checkout Sessions and evidence-credit orders have no
   account-scoped attempt row and can still coexist with “No payments yet.”
8. **Resubscription is promised but absent.** `SUBSCRIPTION_CANCELLING` tells a
   customer to restart first; there is no restart endpoint or control.
9. **Legacy tenancy bindings need explicit compatibility proof.** Reconciliation
   currently filters Personal subscriptions/add-ons to `teamId: null`, while
   comments and candidate selection say legacy rows with a team id belong to
   the payer's Personal account. Do not delete or rewrite these rows; add a
   bounded compatibility query/backfill after production inventory.

## The Two Production 50 GB Attempts

Disposition completed read-only on 2026-09-28 for payer
`54b5d495-e16f-4253-b22d-ef68056b7315`:

| Local attempt | Provider creation evidence | Current provider status | Charge evidence | First failure boundary | Safe action |
|---|---|---|---|---|---|
| `a2cc1107-cf53-4b74-9cda-9a93dcbe6555` | Provider id `I-4P6XLPVJEMBK`; create audit success `2026-09-26T09:46:38.110Z`; provider event created `09:46:38.009Z`, received `09:46:45.021Z`; resource create/state time `09:46:37Z` | Historical event says `APPROVAL_PENDING`; fresh subscription GET and transaction GET both say `404 RESOURCE_NOT_FOUND / INVALID_RESOURCE_ID` (read debug ids `1a8af3a42e6fd`, `fdbb99846a237`) | No local payment, activation, or payment webhook. Merchant Activity has no 26 September transaction and searches for the provider id and `7.99` return none. | Provider creation succeeded; failure occurred after the CREATED event and approval URL issuance, but before buyer approval, activation, or payment. PayPal supplied no error event identifying why its approval page failed. | Safe to mark the local row `ABANDONED` only through the repaired endpoint after deployment and its final provider-first recheck. Preserve the provider id and evidence; do not cancel, delete, or grant capacity. |
| `b5c641a3-4e54-45a5-9743-a9627189ec1e` | Provider id `I-X3KCTML39FWX`; create audit success `2026-09-26T15:01:25.029Z`; provider event created `15:01:24.890Z`, received `15:01:31.751Z`; resource create/state time `15:01:24Z` | Historical event says `APPROVAL_PENDING`; fresh subscription GET and transaction GET both say `404 RESOURCE_NOT_FOUND / INVALID_RESOURCE_ID` (read debug ids `78c7719068565`, `bff43eb2eec5c`) | No local payment, activation, or payment webhook. Merchant Activity has no 26 September transaction and searches for the provider id and `7.99` return none. | Provider creation succeeded; failure occurred after the CREATED event and approval URL issuance, but before buyer approval, activation, or payment. PayPal supplied no error event identifying why its approval page failed. | Safe to mark the local row `ABANDONED` only through the repaired endpoint after deployment and its final provider-first recheck. Preserve the provider id and evidence; do not cancel, delete, or grant capacity. |

### Create-request comparison

Both historical provider events contain the resource returned by creation and
agree on every commercial and identity field:

| Field | Attempt 1 | Attempt 2 |
|---|---|---|
| `plan_id` | `P-4LY16495HW371901BNHQPWMQ` | `P-4LY16495HW371901BNHQPWMQ` |
| Inline `plan` pricing override | Absent; `plan_overridden=false` | Absent; `plan_overridden=false` |
| Provider plan currency/price | USD 7.99 monthly | USD 7.99 monthly |
| Local row | EUR 7.99, `PENDING` | EUR 7.99, `PENDING` |
| Environment | Live (`api-m.paypal.com`) | Live (`api-m.paypal.com`) |
| Approval destination | HTTPS `www.paypal.com/webapps/billing/subscriptions` with a provider token (token redacted) | Same live host/path with a different provider token (token redacted) |
| Provider event | `WH-6T310724RY064093D-7N446358Y6393561T`; event-read debug id `ee9ed7a1ac01b` | `WH-6JL985984Y407002P-6RR24957CT290150S`; event-read debug id `80008aab3545a` |

The deployed application did not retain the original create-response body, so
the exact original response copy of each approval URL is unavailable. The
values above are the approval links PayPal retained on each exact created
resource in its immutable CREATED event; they are not reconstructed from the
currently ACTIVE plan.

Today's OAuth response identifies application `APP-4EB57196GR392360F`. The
current live client/secret fingerprints match the root and both retained
production configurations. Most importantly, that application can read both
historical webhook events by id. PayPal documents the Webhooks Events dashboard
and event records as application-scoped, so this is provider evidence that
today's reads use the same live application that received creation events for
both subscriptions. The merchant Activity check was performed while directly
signed into the intended merchant account; no merchant payer id was returned
by these APIs, so that exact provider field is unavailable and is not guessed.
Provider references: [Webhooks Events dashboard](https://developer.paypal.com/api/rest/webhooks/events-dashboard/),
[Show subscription details](https://developer.paypal.com/api/subscriptions/v1/subscriptions-get/),
and [Subscriptions integration](https://developer.paypal.com/platforms/subscriptions/integrate/).

Direct PayPal login outside either approval URL succeeded. The authenticated
Activity page opened independently and was searched by date, each provider id,
and amount. This separates account-login viability from the failing approval
link.

### Currency trace and causality

USD entered at `CheckoutDrawer.tsx`: the drawer used
`projection.plan.currency ?? "USD"` for every product. A Free/non-subscription
plan projection has no plan currency, so the fallback was USD; the storage
request sent it to the API. The API accepted that client currency,
`getStorageAddonCurrency` normalized it, and PayPal plan resolution selected
the USD plan above. The create payload itself contained only `plan_id`,
`custom_id`, and `application_context`; there was no inline `plan` override.

EUR was written when the CREATED webhook called
`upsertWorkspaceStorageAddon` without currency or amount. That writer fell
back to the `PERSONAL_50_GB` catalogue definition (`currency: EUR`,
`priceCents: 799`). Thus the provider resource was USD while the local row was
EUR.

The mismatch is confirmed, but **it is not a proven cause of the approval-page
failure**. PayPal accepted both create requests, selected the configured USD
plan, returned live approval URLs, and emitted CREATED events. There is no
provider rejection or error event that attributes the browser failure to
currency. The exact cause therefore remains unknown.

The local repair makes each storage SKU's server catalogue currency
authoritative, sends the selected storage offer's currency from Billing,
rejects a stale/mismatched currency before a local attempt or provider call,
uses that currency for provider-plan mapping, and preserves an existing
attempt's currency/amount when later lifecycle events omit pricing.

The original successful subscription-create `paypal-debug-id` is unavailable.
The deployed `paypalRequest` implementation parsed the JSON body and discarded
successful response headers, and neither the audit, analytics event, nor
storage metadata contains that field. The ids above are debug ids from the
later read-only GETs and event reads, not create-request debug ids. The exact
missing field for each row is therefore the successful create response's
`paypal-debug-id`; it cannot be reconstructed from the ACTIVE-plan read.
PayPal Transaction Search API access returned `403 NOT_AUTHORIZED`, so the
authenticated merchant Activity page was used as the independent read-only
ledger check.

### Approval redirect and failure boundary

The create route returned PayPal's subscription resource unchanged. The Web
Billing client selected the resource link whose `rel` was `approve` (falling
back to `payer-action`) and assigned that `href` directly to
`window.location.href`. It did not parse, reserialize, encode, truncate, reuse,
or replace the approval token. Each application-scoped CREATED event ties a
different approval-link token to its own subscription id. The historical
response body and browser network trace were not retained, however, so source
inspection plus the CREATED events establishes the implemented handoff path,
not a byte-for-byte capture of either historical browser assignment.

The available browser evidence shows that the PayPal-hosted subscription
journey reached PayPal's login form, displayed `Some of your information isn't
correct. Please try again.`, and eventually reached
`/webapps/billing/error`. Direct login outside the approval link subsequently
succeeded. There is no retained evidence showing whether credentials were
accepted within either approval journey, whether two-factor authentication was
requested or completed, or whether failure occurred in post-login approval.
The first confirmed failing step is therefore **inside PayPal's hosted
authentication/approval journey**, after PROOVRA handed off to PayPal and
before approval, activation, or charge. It cannot be narrowed honestly to
PayPal login versus PayPal approval.

| Attempt | Last confirmed success | First confirmed failure | Classification | Currency contribution | Exact missing provider evidence and next action |
|---|---|---|---|---|---|
| `a2cc1107-cf53-4b74-9cda-9a93dcbe6555` / `I-4P6XLPVJEMBK` | PayPal created the live subscription at `2026-09-26T09:46:37Z`, emitted CREATED event `WH-6T310724RY064093D-7N446358Y6393561T` at `09:46:38.009Z`, and supplied its distinct live approval link; PROOVRA received the event at `09:46:45.021Z`. Browser evidence confirms arrival at PayPal login, but is not timestamped or retained per attempt. | The PayPal-hosted journey did not produce approval/activation/payment and eventually showed the generic billing error page. Exact error-page UTC time and response are unavailable. | Not a confirmed PROOVRA redirect failure. PayPal login versus approval remains unknown. | Not established. PayPal accepted the USD create and emitted CREATED; no provider error attributes the hosted-page failure to currency. | Missing original create `paypal-debug-id`, error-page correlation/request id, HAR/network response, authentication/2FA outcome, approval/risk/compliance decision, expiry/invalidation reason, and buyer eligibility/funding result. Ask PayPal Merchant Technical Support to correlate the subscription id, event id, create time, live app id, merchant id, and approval token supplied only through its secure channel. |
| `b5c641a3-4e54-45a5-9743-a9627189ec1e` / `I-X3KCTML39FWX` | PayPal created the live subscription at `2026-09-26T15:01:24Z`, emitted CREATED event `WH-6JL985984Y407002P-6RR24957CT290150S` at `15:01:24.890Z`, and supplied its own distinct live approval link; PROOVRA received the event at `15:01:31.751Z`. Browser evidence confirms arrival at PayPal login, but is not timestamped or retained per attempt. | The PayPal-hosted journey did not produce approval/activation/payment and eventually showed the generic billing error page. Exact error-page UTC time and response are unavailable. | Not a confirmed PROOVRA redirect failure. PayPal login versus approval remains unknown. | Not established. PayPal accepted the USD create and emitted CREATED; no provider error attributes the hosted-page failure to currency. | Missing original create `paypal-debug-id`, error-page correlation/request id, HAR/network response, authentication/2FA outcome, approval/risk/compliance decision, expiry/invalidation reason, and buyer eligibility/funding result. Ask PayPal Merchant Technical Support to correlate the subscription id, event id, create time, live app id, merchant id, and approval token supplied only through its secure channel. |

No privacy-preserving record available here identifies the buyer account used
inside either hosted journey, whether it matched the merchant account, whether
it had limitations, or whether its funding source was eligible. Those states
are not inferred. Likewise, fresh 404s prove that the resources are unavailable
to today's read, but do not prove when or why they expired or were invalidated.

The repository contains no retained server-log entry for either subscription
or event id beyond this audit evidence. Sentry is wired in the application, but
this task has no Sentry event export or authenticated Sentry connector, so no
historical Sentry record could be inspected. The unavailable fields are the
original successful-create response headers, the unredacted response body in a
secure log, and any exception/breadcrumb/request record at the browser failure
time. No claim is made that such a Sentry event exists.

### Ready-to-send PayPal support case

This case is prepared but was not submitted:

**Subject:** Two live subscriptions created successfully but PayPal-hosted
login/approval did not complete

**Question for PayPal:** Why did login/approval fail for these two successfully
created live subscriptions, and were the subscriptions expired, invalidated,
restricted, or affected by a PayPal service error?

**Correlation data:**

- Environment: live; application id `APP-4EB57196GR392360F`; plan id
  `P-4LY16495HW371901BNHQPWMQ` (USD 7.99 monthly, no inline plan override).
- Subscription `I-4P6XLPVJEMBK`; CREATED event
  `WH-6T310724RY064093D-7N446358Y6393561T`; provider resource time
  `2026-09-26T09:46:37Z`; event time `2026-09-26T09:46:38.009Z`.
- Subscription `I-X3KCTML39FWX`; CREATED event
  `WH-6JL985984Y407002P-6RR24957CT290150S`; provider resource time
  `2026-09-26T15:01:24Z`; event time `2026-09-26T15:01:24.890Z`.
- Later subscription-read debug ids: `1a8af3a42e6fd` and `78c7719068565`;
  later transaction-read debug ids: `fdbb99846a237` and `bff43eb2eec5c`.
- Original create debug ids and exact error-page timestamps/correlation ids were
  not retained. Add the merchant account identifier from the authenticated
  support profile. Share each approval token only in PayPal's secure support
  channel, never in ordinary email or this report.

### Sandbox and future diagnostics

No sandbox reproduction was attempted. The retained sandbox configuration has
an API endpoint and client configuration, but no isolated EUR storage-plan id
and no sandbox buyer email/password. Those three items, plus an isolated
webhook endpoint, are required before the requested end-to-end reproduction can
be claimed. A new live purchase was not substituted.

The local repair now captures the successful create HTTP status and
`paypal-debug-id`, provider resource id, environment, a one-way client-id
fingerprint, plan id, currency, and a redacted approval-link identity (relation,
host, path, sorted query-key names, and a one-way link fingerprint). It never
persists query values or approval tokens. The browser validates the PayPal HTTPS
host but assigns the exact provider string without URL reserialization. Tests
prove correlation-field persistence, token non-persistence, exact approval-link
handoff, and rejection of a client/server currency mismatch before any local
attempt or PayPal call.

**Conclusion C. Historical cause cannot be recovered from available records.**
The PayPal-hosted failure requires PayPal's internal authentication, approval,
risk, account, and resource-lifecycle logs. The support case above is ready,
and future attempts will retain the safe correlation evidence that these two
attempts lack. This conclusion does not claim the approval error was fixed by
the currency repair.

These are the exact read-only production queries run for the affected payer:

```sql
SELECT id, addon_key, billing_cycle, status, payment_provider,
       external_subscription_id, external_payment_id, amount_cents, currency,
       created_at, activated_at_utc, current_period_end, canceled_at_utc,
       provider_state_at_utc,
       metadata->>'checkoutState' AS checkout_state,
       metadata->>'providerHttpStatus' AS provider_http_status,
       metadata->>'providerDebugId' AS provider_debug_id
FROM workspace_storage_addons
WHERE owner_user_id = '54b5d495-e16f-4253-b22d-ef68056b7315'
  AND addon_key = 'PERSONAL_50_GB'
ORDER BY created_at DESC;

SELECT provider, provider_payment_id, amount_cents, currency, status, created_at
FROM payments
WHERE user_id = '54b5d495-e16f-4253-b22d-ef68056b7315'
ORDER BY created_at DESC;
```

For every non-null PayPal subscription id, perform read-only provider calls:

```text
GET /v1/billing/subscriptions/{subscription_id}
GET /v1/billing/subscriptions/{subscription_id}/transactions?start_time={before-attempt}&end_time={now}
```

No production mutation, approval, cancellation, capture, revision, or new live
purchase was performed.

## Migration And Rolling Deployment

`20280690000000_billing_storage_attempt_abandoned` is unusual as a date but is
consistent with this repository's synthetic ordered series (`202806400` ...
`202806800`). Its SQL is additive (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) and
rewrites no row. The migration scanner classifies it safe.

The deployment is not fully backward compatible after the first `ABANDONED`
write: an old generated Prisma client does not know the enum value and may fail
to deserialize a row. Safe order:

1. Snapshot the two affected rows and verify migration inventory/checksum.
2. Apply the additive migration during a controlled API rollout window.
3. Deploy new API instances and drain old API instances before exposing the
   abandon action.
4. Deploy the web UI only after the new API route returns non-404.
5. Verify health, then read the affected account and run account-wide recheck.
6. For each attempt, compare local row, PayPal subscription/transactions,
   payment row, capacity projection, and UI state. Do not create a live test
   purchase.
7. Use sandbox, with isolated plan ids and webhook endpoint, for plan purchase
   or change, storage, and credit lifecycles before declaring release ready.

## Verification Record

- Consolidated billing unit regression set: 225/225 passed across eight files,
  including plan transitions, lifecycle/account projection, payment lifecycle,
  route behavior, provider classification, commercial correctness, webhook
  leases, and PayPal settlement.
- Billing reconciliation integration suite: 53/53 passed against disposable
  PostgreSQL 16 and Redis. The first rerun was blocked because the existing
  `uc6b-redis` test container was stopped; after starting that disposable
  container, the isolated suite passed. This was an environment issue, not a
  billing assertion failure.
- Billing runtime proof suite: 28/28 passed against a fully migrated dedicated
  disposable PostgreSQL database and local Redis, including pre-provider
  currency-mismatch rejection and preservation of an existing attempt's
  commercial fields when a provider event omits pricing. Earlier harness
  startup attempts ran no cases (missing default Redis, then a stopped
  Testcontainers instance, then an intentionally empty unmigrated database);
  none is counted as test evidence.
- Focused Web Billing checkout render suite: 51/51 passed, including the new
  selected-storage-offer currency assertion. The earlier broader Web Billing
  render run was 75/75; mobile billing tests were 18/18.
- API production build passed. Web production build and typecheck passed; the
  web build retains the existing `SurfaceGate.tsx:163` hook-dependency warning.
- Focused changed-file ESLint and `git diff --check`: passed.
- API typecheck: billing sources clean after the helper correction; full check
  remains red only at the unrelated dirty report test
  `reports-summary-filter-parity.integration.test.ts:253` (`A` is referenced
  outside the test that declares it). The failing lines are part of the
  uncommitted reports workstream, not HEAD or this billing audit.
- Full API unit invocation also reported pre-existing/environment failures:
  missing `services/api/.env` in the staging census, route-consumer analyzer
  debt, generated worker twin files, and the new untracked migration absent
  from the release inventory. These are not billing test failures, but the
  migration inventory finding must be resolved before deployment.
- Architecture closure remains red (dynamic/unreviewed/ambiguous/unmatched
  consumers and reachability debt). Audit artifacts were not regenerated or
  suppressed.
- Sandbox E2E: not run; credentials and isolated provider catalog unavailable.
- Production mutation: none.

## Stop Conditions Before Release

Do not claim billing or PayPal fixed until all of the following are true:

1. Generic durable attempts and stable create idempotency cover every offered
   checkout, or each uncovered product is disabled.
2. Account-wide and per-attempt recovery cover every modeled attempt without
   inventing provider truth.
3. Restart/resubscribe is implemented or the instruction/control is removed.
4. Legacy `teamId` billing rows are inventoried and compatibility behavior is
   tested against production-shaped data.
5. Stripe and PayPal sandbox lifecycles pass for plan, storage, and credits,
   including return/webhook order inversions and lost-response replay.
6. The two live 50 GB attempts are dispositioned from PayPal records and local
   rows, and the affected account projection agrees.
