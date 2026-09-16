# PROOVRA - Final Commercial Residual Closure

Date: 2026-09-16

## Verdict

Closed in code.

This closure implements the residual findings from
`docs/admin/audits/FINAL_COMMERCIAL_EVIDENCE_STORAGE_OUTPUT_AUDIT.md`:

- normal FREE personal accounts may buy supported personal storage add-ons;
- a FREE storage add-on buys bytes only and does not alter plan, evidence
  record allowance, credits, output entitlement, or Public Verify;
- storage offer projection, checkout authorization, and webhook fulfillment now
  use the same policy/catalog answer;
- evidence final-slot settlement is serialized per commercial subject before
  plan capacity is evaluated;
- PayPal plan changes remain provider-pending until confirmed by provider
  state/webhook.

## Product Invariants

Storage, evidence capacity, evidence credits, and output entitlement remain
separate dimensions:

- FREE + storage add-on: more storage only.
- FREE + evidence credit: paid record outputs only for the credit-funded record.
- PRO/TEAM: plan allowances and output entitlement remain plan-led.
- TEAM rolling allowance remains the rolling 500 records / 30 days rule unless
  a hard Enterprise-style contract cap says otherwise.
- ENTERPRISE capacity remains contract-managed, not self-service add-on led.

## Code Closure

The canonical storage policy now lives in `resolveStorageAddonEntitlement`.
FREE returns `FREE_STORAGE`, PRO/TEAM/PAYG return `PLAN`, and ENTERPRISE returns
`NONE`.

The API offer catalog maps `FREE_STORAGE` to the personal add-on SKUs
`PERSONAL_10_GB`, `PERSONAL_50_GB`, and `PERSONAL_200_GB`. The billing
projection, checkout gate, and storage add-on fulfillment path no longer depend
on an evidence-credit ledger grant to decide storage eligibility.

The old `hasSettledEvidenceCreditGrant` adapter was removed after the last
runtime consumer was eliminated.

Evidence completion settlement now takes a subject-level PostgreSQL advisory
transaction lock before evaluating included capacity. Counts are evaluated in a
stable `(createdAt, id)` order so two different pending evidence records racing
for one final slot cannot both settle as included plan usage.

PayPal plan change application no longer treats a local subscription revision
write as provider confirmation. The web client shows a pending message and
refreshes instead of presenting the plan change as confirmed.

## Focused Proof Added

- shared policy/source tests prove FREE storage is no longer credit-gated.
- API projection tests prove FREE receives personal storage offers before and
  after a settled evidence-credit purchase.
- integration settlement tests prove final-slot races serialize for FREE and
  PRO, with only the eligible record settling as plan-funded.
- UI render tests prove FREE opens the storage drawer and displays add-on
  choices instead of routing to plan selection.
- PayPal transition tests prove PayPal plan changes remain pending until
  provider confirmation.

## Operational Boundary

No production deployment was performed as part of this closure. This artifact
records code, tests, commit, and push only.
