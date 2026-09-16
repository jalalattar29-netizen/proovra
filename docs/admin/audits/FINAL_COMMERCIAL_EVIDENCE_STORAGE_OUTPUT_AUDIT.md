# PROOVRA — Final Commercial + Evidence + Storage + Output Code Audit

Date: 2026-09-16
Mode: read-only static/source forensic audit
Scope: commercial plans, evidence credits and limits, storage/add-ons, report/package outputs, public Verify, transitions, frontend/backend parity, duplicate authorities, and test coverage.

## Executive Verdict

**Verdict: mostly coherent after the recent billing closure work, with bounded residual risk.**

The current codebase has a recognizable commercial authority model:

- The canonical sellable recurring plan matrix is in `packages/shared-billing/src/plan-catalog.ts`.
- Evidence credits are a wallet product, not a plan. Credit-funded records receive paid outputs at the record level.
- Storage is enforced separately from evidence-count allowance, and add-ons increase storage only.
- Plan changes route through a server-side transition resolver instead of browser plan comparisons.
- Existing report/package downloads are governed by artifact existence and export/governance access, not by a current-plan recheck that would strand already-generated artifacts.
- Public Verify is a publication/access surface for bounded public projections, not a subscription checkout surface.

The largest remaining risks are not a single obvious broken line. They are edge-contract risks around concurrency, cross-provider asymmetry, and migration/legacy states:

1. Evidence admission is checked before insert/finalization and credit spend is atomic at completion, but plan-slot admission itself is count-based and not visibly serialized for the last included FREE/PRO slot.
2. Stripe upgrades are immediate; PayPal plan revisions are pending until provider/webhook confirmation. That is intentional in code, but the product and tests must continue to state it plainly.
3. Enterprise has strong contract-first storage/evidence handling in the audited paths, but there are still many enterprise/governance surfaces; this audit only followed commercial/evidence/storage/output paths.
4. Static audit found strong unit/integration coverage names for the major corrections, but not full end-to-end browser/provider coverage for every transition permutation.

No product code, migrations, browser runs, broad tests, commits, pushes, or deploys were performed for this audit.

## A. Commercial Source Of Truth

Canonical authority:

- `packages/shared-billing/src/plan-catalog.ts`
- `packages/shared-billing/src/workspace.ts`
- API adapters in `services/api/src/services/billing/commercial-context.service.ts`
- Billing projections in `services/api/src/services/billing/billing-account-projection.service.ts`
- Worker adapter in `services/worker/src/workspace-billing.ts`

Plan catalog observed:

| Plan/product | Recurring plan? | Evidence allowance | Storage | Reports/pkg | Public Verify | Notes |
| --- | ---: | --- | --- | --- | --- | --- |
| FREE | yes | 3 lifetime/non-destroyed personal records | 250 MB | no/no | yes | Free can use public verify capability, but report/package outputs are not included. |
| Evidence credit | no | 1 credit funds 1 additional completion | no plan storage change | yes/yes for that funded record | yes | `EVIDENCE_CREDIT_PRODUCT`; credits do not expire. |
| PAYG | legacy row only | credit-bound | 5 GB legacy | yes/yes | yes | Not sellable; retained for historical `entitlements.plan = PAYG`. |
| PRO | yes | 100 lifetime/non-destroyed personal records | 100 GB | yes/yes | yes | Can buy personal storage add-ons. |
| TEAM | yes | 500 records per rolling 30 days | 500 GB | yes/yes | yes | A tier for the personal subject, not necessarily a separate workspace. |
| ENTERPRISE | contract | uncapped unless contract states monthly cap | contract-first, fallback 500 GB | yes/yes | yes | Self-service checkout/add-ons excluded; contract governs capacity. |

The pricing service reinforces that PAYG is not a sellable plan: `services/api/src/services/billing-pricing.service.ts` builds the credit column from `EVIDENCE_CREDIT_PRODUCT`, FREE subscription entitlements, and record-level output entitlements.

## B. Evidence Record Limits

Authority:

- `resolvePersonalEvidenceAdmission` in `packages/shared-billing/src/plan-catalog.ts`
- `assertWorkspaceAllowsEvidenceCreation` and `settleEvidenceCompletionFunding` in `services/api/src/services/billing-enforcement.service.ts`
- `countPersonalEvidenceRecords` in `services/api/src/services/billing-enforcement.service.ts`

Observed behavior:

- FREE and PRO are lifetime-cap plans.
- TEAM uses a rolling 30-day cap.
- Enterprise uses contract monthly cap when present; hard contract caps do not fall through to consumer credits.
- Evidence count excludes `deletedAt != null` and `lifecycleState = DESTROYED`.
- Personal records count both legacy `teamId = null` and owner personal-team rows.
- At creation, admission is read-only and does not spend credits.
- At completion, the funding source is settled and credit-funded completions burn exactly one credit inside the completion transaction.

Important distinction:

- Trashed/deleted records release an evidence slot.
- Trashed/deleted records still consume storage until lifecycle state reaches `DESTROYED`.

Residual risk:

- The count-based allowance decision is not visibly locked at creation for the exact last slot. Completion has stronger credit atomicity, but concurrent included-plan completions near FREE/PRO caps deserve a focused race test if not already covered.

## C. Credits

Authority:

- `EVIDENCE_CREDIT_PRODUCT` in `packages/shared-billing/src/plan-catalog.ts`
- `services/api/src/services/billing/evidence-credits.service.ts`
- Credit checkout routes in `services/api/src/routes/billing.routes.ts`

Observed behavior:

- Credits grant one funded evidence completion per purchase.
- Credits do not expire.
- Credits are granted by provider-settled payment, admin grant, or dev-only route in dev mode.
- Grants and ledger entries are written in one transaction and are idempotent by provider/admin reference.
- Credit consumption uses an atomic `updateMany` with `credits >= required`, then writes a unique evidence ledger row.
- A credit-funded record’s output rights are later resolved from the ledger row.
- Storage add-on eligibility for a credit customer is based on having ever received a settled credit grant, not current positive balance.

Answer to common edge cases:

- Buying a credit does not convert FREE into PRO.
- Buying a credit does not increase included storage.
- Spending a credit does not remove the durable right to buy storage add-ons as a credit customer.
- Deleting evidence does not appear to automatically refund a consumed credit in the audited paths.
- Existing credit balance is a wallet value; the immutable ledger is the provenance/history.

## D. Storage And Add-Ons

Authority:

- `resolveStorageAddonEntitlement` in `packages/shared-billing/src/plan-catalog.ts`
- `storageAddonOffersForPlan`, `getWorkspaceUsage`, and `assertWorkspaceStorageAvailable` in `services/api/src/services/workspace-usage.service.ts`
- Storage checkout/cancel routes in `services/api/src/routes/billing.routes.ts`

Observed behavior:

- Base storage comes from plan/contract.
- Active recurring storage add-on bytes are added to the base limit.
- `storageBytesOverride` can raise the effective limit but does not reduce below plan/add-ons.
- Evidence bytes, report bytes, and verification package bytes count toward storage.
- ACTIVE, ARCHIVED, and TRASHED evidence consume storage.
- Only DESTROYED evidence stops consuming storage.
- Storage limit refusal is `STORAGE_LIMIT_REACHED`.

Storage add-on catalog:

- PRO: personal add-ons `+10 GB`, `+50 GB`, `+200 GB`.
- TEAM: team-sized add-ons `+100 GB`, `+500 GB`, `+1 TB`, even when TEAM is the personal tier.
- FREE: no recurring storage add-ons unless the account is a settled evidence-credit customer.
- Evidence-credit customer: personal add-ons are purchasable.
- ENTERPRISE: no self-service storage add-ons; contract-managed.
- Grandfathered PAYG: limited legacy personal offers retained.

Residual risk:

- Billing projection uses the entitlement-aware offer path, but `getWorkspaceUsage` still calls `getAvailableStorageAddonOffers(scope)` without threading `hasSettledEvidenceCreditGrant`; this is acceptable if the billing projection overrides offer visibility for real customer action surfaces, but it is a duplicate-adapter smell worth pinning with tests.

## E. Outputs: Report And Verification Package

Authority:

- `resolveEvidenceOutputEntitlements` in `packages/shared-billing/src/plan-catalog.ts`
- `resolveEvidenceOutputEligibility` in `services/api/src/services/billing/evidence-output-eligibility.service.ts`
- Worker checks in `services/worker/src/processor.ts` and `services/worker/src/workspace-billing.ts`
- Artifact status in `services/api/src/services/evidence-artifact-status.service.ts`
- Download routes in `services/api/src/routes/evidence.routes.ts`

Observed behavior:

- FREE plan-funded records: reports/packages not included.
- Credit-funded records: reports/packages included even when the account remains FREE.
- PRO/TEAM/ENTERPRISE plan-funded records: reports/packages included.
- Worker report/package generation resolves both current plan and record funding before generating.
- API artifact status resolves record-level eligibility so FREE records show `NOT_INCLUDED` rather than permanently pending.
- Existing generated artifacts remain downloadable when present, subject to evidence access, governance export eligibility, object existence, and integrity status.
- The evidence detail page follows artifact availability and disabled reasons, not only current plan flags.

Important lifecycle answer:

- A downgrade should not delete reports/packages already generated.
- A downgrade can prevent newly generating outputs for records not entitled under the current record-level eligibility, but existing artifacts remain artifacts.

Residual risk:

- Historical records that were created under FREE and later upgraded may show historical output eligibility in billing projection. The code intentionally avoids auto-generating artifacts from the billing page, but this is a product boundary that should stay explicitly tested: upgrade may make old records eligible for generation, but should not silently spend storage/work.

## F. Public Verify

Authority:

- Public route: `GET /public/verify/:id` in `services/api/src/routes/evidence.routes.ts`
- Publication state machine: `services/api/src/services/governance/publication.service.ts`
- UI route: `apps/web/app/verify/[token]/page.tsx`
- Authenticated publication panel: `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx`

Observed behavior:

- Public Verify depends on `publicVerifyState === PUBLISHED`.
- It returns a bounded public projection and deliberately excludes private identity/workspace details unless configured.
- Public page views are tracked separately from technical verification/report generation timestamps.
- Publish/withdraw/suspend/restore are governance/publication state transitions.
- Public Verify is included for FREE, credit-funded, PRO, TEAM, and ENTERPRISE in the plan/output catalog.

Commercial answer:

- Public Verify is not a paid report/package download.
- Once a public verification record is published, anonymous access is governed by publication state and public projection policy, not checkout status.

## G. Plan Transitions

Authority:

- `services/api/src/services/billing/plan-transition.service.ts`
- `services/api/src/routes/billing.routes.ts`

Observed behavior:

- Self-service ladder is `FREE -> PRO -> TEAM`.
- `ENTERPRISE` is not self-service.
- `PAYG` is not assignable.
- Checkout is only for `NEW_SUBSCRIPTION`.
- Existing live subscription changes use `/v1/billing/subscription/plan`.
- Moving to FREE is cancellation, not checkout.
- Stripe upgrades update the existing subscription item immediately with proration.
- Stripe downgrades are scheduled at period end.
- PayPal revisions are recorded pending because PayPal does not confirm the same immediate capacity change.
- Stale subscription rows no longer necessarily block checkout if the commercial context says the user is effectively FREE.

This directly addresses the duplicate-subscription class of defect: a PRO customer should not buy TEAM via a second subscription checkout; the server routes them to a provider subscription change.

## H. Frontend/Backend Parity

Audited frontend areas:

- `apps/web/app/(app)/billing/page.tsx`
- `apps/web/app/(app)/billing/_sections/*`
- `apps/web/app/(app)/evidence/[id]/page.tsx`
- `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx`
- `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx`
- `apps/web/app/verify/[token]/page.tsx`

Observed parity:

- Billing page reads server projection actions such as `canBuyEvidenceCredits`.
- The checkout drawer has separate flows for plan, credit, and storage add-on checkout.
- Credits checkout sends currency only; quantity/price/product are server-owned.
- Storage UI distinguishes locked/no-catalog cases from real add-on catalogs.
- Plan drawer treats Enterprise as contract-managed and uses server routes for plan changes/cancellation.
- Evidence detail disables report/package downloads based on artifact availability and bounded disabled reasons.
- Existing artifact downloads are not hidden purely because the current plan no longer includes generation.
- Public Verify UI calls the public API route and renders its bounded projection.

Remaining mismatch/smell:

- Some evidence library helper code still derives fallback capability booleans from billing/team features for list previews. The more important detailed/download paths use artifact availability, but list/preview surfaces remain a place where old plan-only wording can reappear.

## I. Duplicate Authority Audit

Resolved or converged authorities:

- Plan matrix: centralized in shared billing.
- Output entitlement: centralized in `resolveEvidenceOutputEntitlements`.
- Record output eligibility: API resolver plus worker thin adapter.
- Evidence credit admission: centralized in `resolvePersonalEvidenceAdmission`.
- Storage add-on entitlement: centralized in `resolveStorageAddonEntitlement`.
- Plan transition: centralized in `resolvePersonalPlanTransition`.
- Public Verify publication: centralized in governance publication service.

Potential duplicate/adapter risks:

- Storage offer visibility has multiple consumers; ensure every customer-facing surface passes the settled-credit-grant fact when relevant.
- Evidence list/preview helpers still include fallback feature booleans; detailed artifact status is better, but preview copy can drift.
- Report generation authority and worker both understand terminal commercial refusals; tests should keep both `REPORT_NOT_INCLUDED_IN_PLAN` and package-not-included paths aligned.

## J. Required Journey Matrix

| Journey | Static result |
| --- | --- |
| FREE creates first 3 records | Allowed by plan allowance if storage/lifecycle permit. |
| FREE creates 4th without credit | Blocked by evidence admission. |
| FREE buys credit then creates beyond 3 | Allowed; credit is spent on successful completion. |
| FREE credit-funded record output | Report/package/public verify included for that record. |
| FREE plan-funded record output | Report/package not included; public verify included. |
| FREE buys storage without credit history | Not self-service purchasable. |
| FREE with settled credit history buys storage | Personal storage add-ons purchasable. |
| PRO under 100 records | Allowed if storage/lifecycle permit. |
| PRO over 100 with credit | Additional record can be credit-funded. |
| TEAM under 500 rolling 30 days | Allowed if storage/lifecycle permit. |
| TEAM over rolling cap with credit | Code falls through to wallet unless contract cap is hard. |
| Enterprise with contract cap | Contract capacity governs; hard caps do not fall through to consumer credit. |
| Downgrade PRO/TEAM | Provider-first, lower tier at period end for Stripe; PayPal pending/provider-driven. Existing data not deleted. |
| Upgrade PRO/TEAM | Stripe immediate/prorated; PayPal pending/provider-driven. |
| Cancel subscription | Provider-first cancellation; dependent storage add-on cancellation is tracked. Evidence remains. |
| Existing report download after downgrade | Download depends on artifact/access/governance, not current plan generation entitlement. |
| Public verify after downgrade | Published public route remains governed by publication state and bounded projection. |

## K. Findings

### P1 — Last-slot concurrency is not visibly serialized

The code has strong credit-spend atomicity, but FREE/PRO plan-slot admission is count-based. A focused test should prove two concurrent finalizations near the last included slot cannot both settle as `PLAN` beyond the cap.

Files:

- `services/api/src/services/billing-enforcement.service.ts`
- `services/api/src/services/billing/evidence-credits.service.ts`

### P2 — Storage offer adapter paths need a parity pin

`resolveStorageAddonEntitlement` is the right authority, and billing projection appears to use it. `getWorkspaceUsage` still exposes available storage add-ons through a scope-only helper that cannot know settled credit-grant history. If that field leaks to a customer action surface, a real evidence-credit customer may see no storage offers.

Files:

- `packages/shared-billing/src/plan-catalog.ts`
- `services/api/src/services/workspace-usage.service.ts`
- `services/api/src/services/billing/billing-account-projection.service.ts`

### P2 — PayPal transition semantics require explicit UX/test coverage

Stripe upgrades become effective immediately; PayPal revisions are pending/provider-driven. The code is honest about this, but it is commercially sensitive and must remain explicit in UI copy and tests.

Files:

- `services/api/src/services/billing/plan-transition.service.ts`
- `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx`

### P3 — Evidence list previews still carry fallback plan-feature language

Detailed evidence/artifact views are record/artifact-aware. Some list preview helpers still read capability booleans as fallback. This is lower risk because downloads hit gated endpoints, but copy can still mislead.

Files:

- `apps/web/app/(app)/evidence/lib/evidence-library-helpers.ts`
- `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx`

## L. Test Coverage Audit

Relevant coverage discovered by static file/test-name scan:

- `services/api/test/billing-plan-transition.test.ts`
- `services/api/test/billing-plan-change-route.test.ts`
- `services/api/test/billing-plan-selection.integration.test.ts`
- `services/api/test/billing-commercial-correctness.test.ts`
- `services/api/test/pricing-hardening-plan-capabilities.test.ts`
- `services/api/test/free-integrity-vs-paid-output-boundary.test.ts`
- `services/api/test/point7/plan-matrix.integration.test.ts`
- `services/api/test/worker-report-plan-gate-sentry.contract.test.ts`
- `services/api/test/worker-plan-resolver-parity.contract.test.ts`
- `services/api/test/public-verify-consistency.test.ts`
- `services/worker/test/offline-verifier-decommission.test.ts`
- `apps/web/__tests__/render/billing-plan-selection.render.test.tsx`
- `apps/web/__tests__/render/billing-plan-chooser.render.test.tsx`
- `services/api/test/wcr-commercial-lifecycle.integration.test.ts`

Gaps to add or confirm:

- Concurrent FREE/PRO final-slot completion race.
- Evidence-credit customer storage offers in every customer-facing projection.
- PayPal upgrade/downgrade pending UX and route response.
- Historical FREE record after upgrade: eligible display, explicit no auto-generation, storage impact.
- Existing artifacts after downgrade remain downloadable from detail and list preview.
- Enterprise contract hard cap versus TEAM rolling cap with credits.
- Public Verify remains available after subscription cancellation when publication remains `PUBLISHED`.

## M. Final 25 Questions

1. Is FREE limited to 3 evidence records? Yes, plan allowance is 3 lifetime/non-destroyed personal records.
2. Does FREE include reports? No, unless the individual record was credit-funded.
3. Does FREE include verification packages? No, unless the individual record was credit-funded.
4. Does FREE include Public Verify? Yes.
5. Does a credit create a PAYG plan? No.
6. Does a credit expire? No.
7. Does one credit fund one evidence completion? Yes.
8. Does a credit-funded record earn reports/packages? Yes.
9. Does buying a credit increase storage? No.
10. Can a settled credit customer buy storage add-ons? Yes, through the storage entitlement rule.
11. Can plain FREE buy storage add-ons? No.
12. Does PRO include 100 records? Yes, lifetime/non-destroyed.
13. Can PRO use credits after 100? Yes, wallet fallback exists.
14. Does TEAM include 500 records? Yes, rolling 30 days.
15. Can TEAM use credits after the rolling cap? Yes for catalog TEAM; not for hard Enterprise contract caps.
16. Is Enterprise self-service? No.
17. Are Enterprise storage/evidence limits contract-first? Yes.
18. Does storage count reports and packages? Yes.
19. Do trashed records consume storage? Yes.
20. Do destroyed records consume storage? No, after lifecycle reaches `DESTROYED`.
21. Are existing artifacts deleted on downgrade/cancel? No audited path deletes them as part of transition.
22. Are existing artifacts downloadable after downgrade? Yes, if artifact/access/governance checks pass.
23. Can checkout create a second subscription for an already-live subscriber? Server route refuses and points to plan change.
24. Does Public Verify depend on current subscription checkout state? No; it depends on publication state and bounded public projection.
25. Were code changes/tests/deploys performed by this audit? No; only this markdown artifact was created.

FINAL COMMERCIAL + EVIDENCE + STORAGE + OUTPUT CODE AUDIT COMPLETE
