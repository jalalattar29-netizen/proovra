# Subscription Lifecycle Plan Transition Closure

## Executive verdict

Verdict: ARCHITECTURE FIXED - LIMITED VALIDATION REMAINS.

The production-observed `SUBSCRIPTION_ALREADY_ACTIVE` failure was reproduced from source as an authority mismatch in the checkout route. The billing projection and plan-transition resolver already understood the distinction between a FREE effective commercial entitlement and a provider-backed paid subscription, but the checkout duplicate-subscription guard still asked the older question: "is there any live Subscription row?"

That allowed a stale/live row beside an effective FREE account to override the canonical transition resolver. FREE -> PRO and FREE -> TEAM could be resolved correctly as purchases by the Billing surface and then rejected by the checkout endpoint.

## Root cause

FREE -> PRO failure: `POST /v1/billing/checkout/{stripe,paypal}` called `duplicateSubscriptionRefusal`, which directly used `findLivePersonalSubscription(userId)`. A stale non-terminal `Subscription` row was treated as an active paid relationship even when `resolveCommercialContext({ type: "PERSONAL_ACCOUNT" }).scope.plan` was FREE.

FREE -> TEAM failure: same root cause. TEAM is not special in the current self-service ladder; the checkout guard incorrectly blocked the purchase before provider checkout.

PRO -> TEAM failure: for a real PRO provider-backed subscription, checkout is supposed to be refused and the canonical `/v1/billing/subscription/plan` path is supposed to update the existing provider subscription. The fix preserves that guard. The observed failure can occur when a UI path calls checkout for PRO -> TEAM; the route still returns `SUBSCRIPTION_ALREADY_ACTIVE` in that misuse case and points at `/v1/billing/subscription/plan`.

Shared or multiple root cause: shared backend guard mismatch for FREE cases; PRO -> TEAM is a caller-flow misuse protected by the same guard.

## Authorities

Effective commercial entitlement is the entitlement/display/capability truth. The canonical resolver is `resolveCommercialContext`, which composes personal/workspace scope, plan capabilities, lifecycle, storage, credits, and enterprise contract state.

Paid subscription lifecycle is provider-backed recurring billing truth. The durable evidence is a `Subscription` row with a provider, provider subscription id, non-terminal provider status, plan, period/cancellation fields, and pending-plan fields.

FREE in DB means effective commercial FREE unless another canonical entitlement says otherwise. A historical or stale `Subscription` row does not by itself make the account paid.

ACTIVE in DB means the provider lifecycle row is non-terminal for that row. It is not sufficient by itself to answer whether a paid subscription should block checkout; the resolver must decide whether the account has a provider-backed paid subscription that must be changed.

Provider-backed paid subscription means a live provider subscription that the canonical transition resolver classifies as a subscription to change rather than a new subscription to start.

## Fix

Changed `duplicateSubscriptionRefusal` in `services/api/src/routes/billing.routes.ts` to ask `resolvePersonalPlanTransition({ userId, targetPlan })`.

If the transition is `NEW_SUBSCRIPTION`, checkout proceeds. If the transition is anything else, checkout is refused with the existing `SUBSCRIPTION_ALREADY_ACTIVE` envelope and `changeEndpoint: /v1/billing/subscription/plan`.

This keeps duplicate paid-subscription protection while preventing stale rows, FREE representation, credits, or add-ons from masquerading as active paid subscription lifecycle.

## Transition behavior covered

START: FREE/no paid subscription -> PRO or TEAM resolves as `NEW_SUBSCRIPTION` and may enter checkout.

CHANGE: PRO -> TEAM and TEAM -> PRO resolve through `resolvePersonalPlanTransition` and `applyPersonalPlanChange`, reusing the existing provider subscription.

CANCEL/DOWNGRADE TO FREE: paid -> FREE remains routed to the cancellation authority.

Same plan: resolver returns `NO_CHANGE`; no provider mutation is required.

Enterprise: self-service enterprise remains refused by `assertSelfServicePlan` and organization billing projection remains contract-managed.

Credits and storage add-ons: existing projection/integration tests continue to prove FREE + evidence-credit storage Option B and granted/storage behavior; this change does not touch those systems.

## Proof run

Focused unit route/resolver tests:

`corepack pnpm -C D:\digital-witness --filter proovra-api exec vitest run test/billing-plan-change-route.test.ts test/billing-plan-transition.test.ts`

Result: PASS, 2 files, 60 tests.

Focused live PostgreSQL billing selection integration:

`$env:P7_TEST_REDIS_URL='redis://127.0.0.1:56911'; corepack pnpm -C D:\digital-witness --filter proovra-api exec vitest run --config vitest.integration.config.ts test/billing-plan-selection.integration.test.ts`

Result: PASS, 1 file, 22 tests.

API typecheck:

`corepack pnpm -C D:\digital-witness --filter proovra-api typecheck`

Result: PASS.

API build:

`corepack pnpm -C D:\digital-witness --filter proovra-api build`

Result: PASS.

Diff whitespace:

`git diff --check`

Result: PASS.

## Broader validation limits

An accidental broad API unit run executed 803 test files and 24,706 tests. The changed billing route test passed in that run, but the broad command failed on stale canonical audit artifacts because source files changed after the current audit artifacts were generated. I did not regenerate or stage those audit artifacts in this fix.

The full requested matrix was not completely run here: Playwright billing journeys, full clean DB, full Build Test gate, worker full suite, web full suite, and remote CI were not completed in this run.

## Files changed

- `services/api/src/routes/billing.routes.ts`
- `services/api/test/billing-plan-change-route.test.ts`
- `docs/admin/audits/SUBSCRIPTION_LIFECYCLE_PLAN_TRANSITION_CLOSURE.md`

## Migrations authored

None.

## Production touched

No.

## Final verdict

ARCHITECTURE FIXED - LIMITED VALIDATION REMAINS.

SUBSCRIPTION LIFECYCLE + PLAN TRANSITION CLOSURE COMPLETE
