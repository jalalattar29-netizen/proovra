# PROOVRA — FINAL FORENSIC IMPLEMENTATION AUDIT
## Commercial truth · Evidence output lifecycle · OTS/TSA · Report/Package

**Mode:** AUDIT ONLY. No code changed, no commits, no migrations, no production mutation.
**HEAD audited:** `92f014fd` (branch `main`, tree clean except untracked `docs/admin/audits/`).
**Method:** source-first. No test suites were executed (see §47 note at the end).
**Date:** 2026-09-09.

Everything below is derived from reading the current source. Where a claim is
inferred rather than proven from source, it is labelled **UNPROVEN**.

---

## A. CURRENT ARCHITECTURE MAP

One authority per question, unless noted.

| Question | Canonical module / function | Verdict |
|---|---|---|
| Effective commercial plan (pure decision) | `packages/shared-billing/src/plan-catalog.ts:resolveWorkspaceEffectivePlan` | ONE |
| Plan capability table | `plan-catalog.ts:PLAN_CAPABILITIES` / `getPlanCapabilities` | ONE |
| Workspace commercial context (API adapter) | `services/api/src/services/billing/commercial-context.service.ts:resolveCommercialContext` / `resolveCommercialPlan` | ONE (adapter) |
| Workspace commercial context (worker adapter) | `services/worker/src/workspace-billing.ts:resolveEffectivePlanForEvidence` | Adapter — delegates the DECISION to `resolveWorkspaceEffectivePlan`. Not a second authority. |
| Evidence admission (personal) | `plan-catalog.ts:resolvePersonalEvidenceAdmission`, called from `billing-enforcement.service.ts:assertWorkspaceAllowsEvidenceCreation` | ONE |
| Evidence usage counting | `billing-enforcement.service.ts:countPersonalEvidenceRecords` | ONE |
| Evidence credit wallet | `services/api/src/services/billing/evidence-credits.service.ts` — two writers of `entitlements.credits` only (`applyCreditGrant`, `consumeEvidenceCreditForCompletion`) | ONE |
| Funding provenance of a record | `EvidenceCreditLedgerEntry` (UNIQUE `evidence_id`); readers `resolveEvidenceFunding[Many]` (API) and `workspace-billing.ts:resolveEvidenceFundingSource` (worker) — both read the same row | ONE fact, two thin readers |
| Output entitlement (record-aware) | `plan-catalog.ts:resolveEvidenceOutputEntitlements` | ONE |
| Record-aware eligibility loader | `services/api/src/services/billing/evidence-output-eligibility.service.ts` | ONE |
| Output state machine (pure) | `packages/shared/src/evidence-output-lifecycle.ts` | ONE |
| Report generation request (writer) | `packages/shared-runtime/src/reports/report-generation-request.ts:createReportGenerationRequest` | ONE |
| Report generation producer (API) | `services/api/src/services/reports/report-generation-authority.service.ts:requestReportGeneration` | ONE |
| Report generation producer (worker) | `services/worker/src/processor.ts:enqueueReportJob` → `report-generation-authority.ts:requestReportGenerationFromWorker` | ONE |
| Report execution / claim | `services/worker/src/report-generation-authority.ts:resolveAndClaimReportRequest` + `processor.ts:runReportGeneration` | ONE |
| Verification package generation | inside the report job (`processor.ts` → `verification-package.ts`) — **no separate request, no separate queue** | ONE pipeline |
| Artifact lifecycle projection (per record) | `services/api/src/services/evidence-artifact-status.service.ts:buildEvidenceArtifactStatus` | ONE |
| Artifact lifecycle projection (list) | `services/api/src/services/reports/reports-aggregator.service.ts` | Uses the same shared derivation, then **re-maps into a lossy legacy vocabulary and re-derives the action** — see AS-2 |
| Report download authorization | `GET /v1/evidence/:id/report/latest` — `getEvidenceWithReadAccess` + `enforceSensitiveAction("download_report")` + `checkExportEligibility` | ONE. **No commercial gate.** |
| Package download authorization | `GET /v1/evidence/:id/verification-package` — same three + `gateVerificationAction("PUBLISH_PACKAGE")` | ONE. **No commercial gate on an existing artifact.** |
| TSA | `services/api/src/services/timestamp.service.ts:createEvidenceTimestamp` — **exactly one call site**, `evidence-complete.service.ts:912` | ONE, single-shot |
| TSA safe repair | `services/api/src/scripts/repair-tsa-failed-with-token.ts` — re-parses the STORED token, never contacts the provider | ONE, offline |
| OTS initialization | `services/worker/src/ots-lifecycle.ts:ensureEvidenceOtsInitialized` | ONE |
| OTS upgrade | `services/worker/src/ots-upgrade.processor.ts:processOtsUpgrade` | ONE |
| OTS column writer | `services/worker/src/ots-state.ts:buildOtsEvidenceUpdateData` | ONE |
| OTS anchoring request (API) | `services/api/src/services/integrity/ots-anchoring-authority.service.ts:requestEvidenceOtsAnchoring` | ONE |
| OTS reconciliation | `services/worker/src/scripts/reconcile-ots-never-attempted.ts` — **manual CLI only, nothing schedules it** | see N/O |
| Public Verify | `apps/web/app/verify/[token]` + its API projection; reads `Evidence` integrity columns directly | ONE, independent of artifacts |
| Operations incident authority | `operations-source-registry.ts` + `operations-source-probes.ts` + `evidence-integrity-conditions.service.ts` | ONE |
| Incident active-state / auto-resolve | `packages/shared-runtime/src/incident-transition-authority.ts:decideObservationTransition` | ONE |
| Historical output eligibility (Billing) | `billing-account-projection.service.ts` → `historicalOutputEligibility` | ONE, count only |
| Upgrade/downgrade grandfathering | `services/api/src/services/billing.service.ts:setPersonalPlan` writing `legacyRecordCapOverride`; interpreted once in `commercial-context.service.ts:limits` | ONE writer, ONE reader |
| Storage accounting for artifacts | `services/worker/src/workspace-billing.ts:assertWorkspaceAllowsReportArtifact` / `...VerificationPackageArtifact` | ONE each |

**Zero-consumer / dead authority found:** `services/worker/src/report-generation-authority.ts:reconcileStrandedReportRequests` — exported, fully implemented, referenced only by `services/api/test/phase-12-point5-report-authority.integration.test.ts:765`. **No production caller.** (P1-1)

**False registry declaration found:** `packages/shared/src/queue-integrity/registry.ts` declares
`reconciler: "services/worker/src/lifecycle-recovery.ts"` for `JOB_NAMES.UPGRADE_OTS`.
`lifecycle-recovery.ts` contains **zero** OTS logic (grep for `ots` → no matches). (P1-4)

**Name collision, not a duplicate authority:** `services/api/src/services/evidence-review/governance.service.ts` returns
`publicVerifyIncluded/reportIncluded/verificationPackageIncluded: false` for reviewer notes. Those are
DISCLOSURE flags ("does this note appear in the public verify view / report"), not commercial ones.
Correct as written; the field names are unfortunate.

---

## B. COMMERCIAL PLAN TRUTH

All values from `PLAN_CAPABILITIES` at HEAD.

| | FREE | PAYG (legacy row) | PRO | TEAM | ENTERPRISE |
|---|---|---|---|---|---|
| `maxEvidenceRecords` (lifetime) | **3** | null | **100** | null | null |
| `maxEvidenceRecordsPerMonth` | null | null | **null** | **500** | null |
| `paygCreditsRequiredPerCompletion` | 0 | **1** | 0 | 0 | 0 |
| `reportsIncluded` | false | true | true | true | true |
| `verificationPackageIncluded` | false | true | true | true | true |
| `publicVerifyIncluded` | **true** | true | true | true | true |
| billingShape | SINGLE_OCCUPANT | SINGLE_OCCUPANT | SINGLE_OCCUPANT | SHARED | BOTH |

**FREE** — 3 records, **lifetime, not monthly** (`maxEvidenceRecordsPerMonth: null`). No report, no
verification package. **Public Verify IS included.** TSA runs (integrity layer, plan-blind — see E).
OTS enters the lifecycle for every finalized record on every plan
(`evidence-complete.service.ts:1326` consults no plan, no entitlement, no funding).

**PRO** — 100 **lifetime**, `maxEvidenceRecordsPerMonth: null`, so there is no month reset. Record
#100 is admitted (`currentRecordCount < effectiveLifetimeRecordCap`, i.e. 99 < 100). Record #101:
`withinPlanAllowance` false → falls through to the wallet → allowed as `EVIDENCE_CREDIT` if a credit
exists, otherwise refused `PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS` (409). Credit overflow **works**.

**TEAM** — rolling **500 per 30 days**, no lifetime cap. Enforced in
`billing-enforcement.service.ts` by counting `Evidence.createdAt >= now() - 30 days`. Credit overflow
is reachable (SCENARIO 7 in `commercial-output-journeys.test.ts` pins that the monthly branch no
longer returns before the wallet is consulted). Note that a member's personal wallet cannot fund a
SHARED workspace — `WorkspaceScope.credits` is 0 for them by construction.

**ENTERPRISE** — no catalog cap; the contract supplies limits via
`services/api/src/services/billing/enterprise-contract-limits.ts` and
`resolveEnterpriseContract`. `resolvePersonalEvidenceAdmission` is not the path for an ORGANIZATION
workspace, so **the consumer credit wallet does not overflow an Enterprise contract cap** — there is
no code path from an Enterprise workspace admission to `EVIDENCE_CREDIT_PRODUCT`. There is no
contract flag that re-enables it.

**PAYG** — **not a sellable plan.** `PLAN_CAPABILITIES.PAYG` is a grandfather resolution row only;
no production write path sets `entitlements.plan = 'PAYG'`. The product is
`EVIDENCE_CREDIT_PRODUCT` (1 credit, €5, never expires, 1 credit per completion), layered over FREE.
One credit funds one NEW Evidence completion.

### Plan-name derivation sweep (whole executable repo)

`grep` for `=== "FREE"|"PRO"|"TEAM"|"ENTERPRISE"|"PAYG"` across `services`, `apps`, `packages`
(excluding tests/dist). Classification of every live hit:

| Site | Class |
|---|---|
| `analytics.routes.ts:705-708` | **telemetry-only** (tier breakdown counters) |
| `ops.routes.ts`, `saved-views.service.ts`, `SavedViews.tsx`, `capability-registry.ts:86`, `AppSidebarV2.tsx:484` | **not a plan** — `visibility`/`scope` enum whose member happens to be spelled `TEAM` |
| `billing-account-projection.service.ts:1122,1202,1551` | **presentation** (Enterprise contract copy; FREE add-on ineligibility line) |
| `collaboration-team/billing-guards.ts:212` | **presentation** (`planDisplayName`) |
| `enterprise-provisioning.service.ts:217,226` | **provisioning** |
| `platform-context.service.ts:121-125` | **validation** (`isPlanType` guard) |
| `platform-context.service.ts:1024` | **diagnostic** (duplicate-personal-workspace heuristic reason tag) |
| `demo-lead-scoring.service.ts`, `admin/*` pages | **telemetry / presentation** |
| `AiSection.tsx:425`, `BillingOverview.tsx:155`, `pricing/page.tsx` | **presentation** |

**No product-behaviour site derives an output decision from a plan name.** Zero defects in this sweep.
The frontend has no plan-based output gating left: `useEvidenceArtifactActions.ts` documents and
implements the removal of `if (!workspaceCaps.reportsIncluded) return` from both download handlers.

---

## C. RECORD FUNDING PROVENANCE

**Bound to the record, not the wallet.** `EvidenceCreditLedgerEntry.evidence_id` is UNIQUE. A
`CONSUMPTION` row for an evidence id IS the statement "this record was credit-funded".

- **Admission** decides funding: `resolvePersonalEvidenceAdmission` returns
  `{allowed:true, funding:"PLAN"|"EVIDENCE_CREDIT"}` — plan allowance first, always, then one credit.
- **Settlement** happens at completion, **inside the completion transaction**
  (`evidence-complete.service.ts` → `settleEvidenceCompletionFunding(..., tx)` →
  `consumeEvidenceCreditForCompletion(..., tx)`). A rolled-back completion rolls back the spend.
- **Double-spend guard** is the conditional decrement
  (`updateMany where credits >= required`) plus the UNIQUE insert (P2002 rolls the whole transaction
  back). Two concurrent completions for one record cannot both burn a credit.
- **Retry** cannot re-consume: `consumeEvidenceCreditForCompletion` returns
  `alreadyConsumed: true` when a `CONSUMPTION` row already exists for the evidence id.
- **Regeneration** never touches the ledger. The only credit-consuming call site is the completion
  path; `assertWorkspaceAllowsReportArtifact` / `...VerificationPackageArtifact` perform a storage
  check only.
- **Output eligibility uses provenance**: `resolveEvidenceOutputEligibility` loads
  `resolveEvidenceFunding(evidenceId)` and hands it to `resolveEvidenceOutputEntitlements`, which
  returns `reportsIncluded: true` unconditionally for `EVIDENCE_CREDIT`.
- **Funding survives downgrade**: the ledger row is immutable and is never re-read against the
  current plan.

### The explicit scenario, proven from source

1. FREE user completes record **A**. Admission: `withinPlanAllowance` true (0 < 3) → `funding: "PLAN"`.
   No ledger row written.
2. User later buys 5 credits → `applyCreditGrant` writes a `PURCHASE` row and increments
   `entitlements.credits`. **It writes nothing against A.**
3. `resolveEvidenceFunding(A)` reads `findUnique({where:{evidenceId: A}})` → no row → `"PLAN"`.
   `resolveEvidenceOutputEntitlements({plan:"FREE", funding:"PLAN"})` → `reportsIncluded: false`.
   **A stays unfunded.** ✅
4. Record **B** is created past the FREE allowance → admission returns `EVIDENCE_CREDIT` → at
   completion a `CONSUMPTION` row is written with `evidence_id = B`.
5. `resolveEvidenceFunding(B)` → `"EVIDENCE_CREDIT"` → report and package included. **B is funded.** ✅

**A wallet balance can never retroactively fund a historical record.** This is structural: the
question is asked of a row keyed by evidence id, not of a balance.

---

## D. OUTPUT STATE MACHINE

`packages/shared/src/evidence-output-lifecycle.ts` — pure, total, three axes, never persisted.

**Axis 1 (eligibility):** `NOT_INCLUDED | ELIGIBLE`, from `resolveEvidenceOutputEntitlements(plan, funding)`.
**Axis 2 (generation):** projected from the latest `ReportGenerationRequest.state` by
`projectReportRequestState`. `SUCCEEDED → NOT_REQUESTED` (deliberate: a finished request is described
by axis 3).
**Axis 3 (availability):** `NO_ARTIFACT | READY`, from the existence of a `Report` / `VerificationPackage` row.

**Precedence in `deriveEvidenceOutputState` (order is the design):**
`READY` → `QUEUED` → `GENERATING` → `NOT_INCLUDED` → `BLOCKED` → `RETRYABLE_FAILURE` →
`TERMINAL_FAILURE` → (`finalized ? ELIGIBLE_NOT_GENERATED : NOT_INCLUDED`).

**Actions** come from `outputActionFor` — `GENERATE | RETRY | REGENERATE | NONE`, never inferred
from the presence of a version.

### Can Report and Package disagree?

**On axis 1 and axis 3, yes. On axis 2, structurally no.**
`buildEvidenceArtifactStatus` reads ONE request row —
`prisma.reportGenerationRequest.findFirst({where:{evidenceId}, orderBy:{createdAtUtc:"desc"}})` —
with **no `artifactType` filter**, and hands the same `generation` value to both projections. That is
consistent with the pipeline: `createReportGenerationRequest` defaults `artifactType` to `"REPORT"`
and **no call site anywhere passes `VERIFICATION_PACKAGE` or `EXCHANGE_PACKAGE`** (verified by grep).
The package's only independent input is the governance `blocked` metadata, folded into axis 2 as
`BLOCKED`.

### Edge cases

| Combination | Result | Prevented / correct? |
|---|---|---|
| artifact exists + terminal request | `READY` (READY wins) | ✅ correct — the artifact is downloadable |
| artifact exists + plan downgraded | `READY`, action `NONE` (no Regenerate) | ✅ exactly the intended downgrade behaviour |
| no artifact + no request + eligible + finalized | `ELIGIBLE_NOT_GENERATED`, action `GENERATE` | ✅ |
| no artifact + no request + not eligible | `NOT_INCLUDED`, action `NONE` | ✅ |
| no artifact + no request + **not finalized** | `NOT_INCLUDED` | ✅ deliberate — nothing to generate yet |
| request `FAILED_TERMINAL` but artifact exists | `READY` | ✅ |
| request `PROCESSING` but artifact exists | `READY` | ✅ (READY precedes live work) |
| package missing, report exists | package `ELIGIBLE_NOT_GENERATED` + `GENERATE` | ⚠️ reachable (see W); the action regenerates BOTH |
| report missing, package exists | report `ELIGIBLE_NOT_GENERATED` | not reachable by any current writer — the package is only written after the report row |
| eligible + `BLOCKED` | `BLOCKED`, action **`NONE` forever** | ❌ **P1-2** — see H |

**Not persisted anywhere.** No `output_state` column exists. Confirmed by grep.

---

## E. FREE EVIDENCE END-TO-END

Walked from `POST /v1/evidence` → `createEvidence` → `completeEvidence`.

| Step | Source | Result |
|---|---|---|
| Create | `evidence.service.ts:166` — every row gets a real `teamId` (the owner's personal Team) | ✅ |
| Admission | `assertWorkspaceAllowsEvidenceCreation` → `resolvePersonalEvidenceAdmission({plan:"FREE", cap:3})` | ✅ 3 allowed, 4th refused before insert |
| Finalize | `evidence-complete.service.ts` `$transaction` with `pg_advisory_xact_lock` | ✅ |
| Signature / fingerprint | `signer.signFingerprintHex` inside the tx | ✅ |
| **TSA** | `createEvidenceTimestamp` at line 912, **inside** the tx, **plan-blind** | ✅ FREE gets RFC-3161. A TSA failure never throws (it returns `status:"FAILED"` and preserves the token bytes when it has them), so completion is never lost to a TSA outage |
| **OTS** | `requestEvidenceOtsAnchoring` at line 1326, **after commit**, consults no plan/entitlement/funding | ✅ FREE enters the OTS lifecycle. Pricing's "Every plan includes OpenTimestamps" is now true in code |
| Report enqueue | `if (final.shouldEnqueueReport)` — false for FREE | ✅ nothing enqueued |
| Report state | eligibility `NOT_INCLUDED`, generation `NOT_REQUESTED`, availability `NO_ARTIFACT` → **`NOT_INCLUDED`** | ✅ not "pending forever" |
| Package state | same → **`NOT_INCLUDED`**, legacy `unavailable:true`, `unavailableReason:"NOT_INCLUDED_IN_PLAN"` | ✅ |
| Report backlog | `operations-source-probes.ts` applies `outputEntitledEvidenceWhere` → the FREE record is excluded from `pipeline.report_backlog` | ✅ |
| Package backlog | same narrowing | ✅ |
| Commercial failure incident | `requestReportGeneration` refuses with `not_included_in_plan` **before any row exists**; the worker's own denial calls `job.discard()` and takes the `isPlanDenial` branch which **skips `captureException` and the DLQ/incident bridge** | ✅ none |
| Public Verify | `publicVerifyIncluded: true` on FREE; the verify page reads Evidence integrity columns, not artifacts | ✅ |
| Notifications | no incident → no notification | ✅ |

**One residual on FREE:** if the OTS job never runs (Q1/Q2 below), Evidence Detail says
*"Not yet anchored — OpenTimestamps anchoring has not started for this evidence item yet"*
(`_tabs/_lib.tsx:526`) permanently, and nothing in Operations sees it. The copy is correct only
while the promise behind it holds.

---

## F. PAYG END-TO-END

| Step | Proof |
|---|---|
| Create with credit | `resolvePersonalEvidenceAdmission` — plan allowance is spent first; only then `availableEvidenceCredits >= 1` → `funding: "EVIDENCE_CREDIT"` |
| Exactly one credit consumed | `consumeEvidenceCreditForCompletion` decrements by `EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion` (1) once, guarded by the UNIQUE `evidence_id` |
| Settlement is transactional | called with the completion `tx` |
| Report/Package eligible | `resolveEvidenceOutputEntitlements({plan:"FREE", funding:"EVIDENCE_CREDIT"})` → all three true |
| First generation charges nothing extra | the only ledger writer is the completion path |
| Retry charges nothing | `alreadyConsumed` short-circuit; and retry runs the report job, which never touches the ledger |
| Regeneration charges nothing | same; the UI confirmation says so explicitly ("No evidence credit is charged.") |
| Downgrade later | the ledger row is immutable; `resolveEvidenceFunding` still answers `EVIDENCE_CREDIT` |
| Existing outputs downloadable | neither download route has a commercial gate |
| No frontend plan-only block | removed from both handlers in `useEvidenceArtifactActions.ts` |
| Intake for a credit buyer | `resolveWorkspaceIntakeEntitlement` opens intake on a positive wallet balance for SINGLE_OCCUPANT |

**Correct end to end.** No defect found in the PAYG path.

---

## G. FREE → PRO HISTORICAL FLOW

- **No automatic backfill.** `setPersonalPlan` writes the plan and (conditionally) the grandfather
  cap. It enqueues nothing. `billing-account-projection.service.ts` produces
  `historicalOutputEligibility` as a **count plus a link to `/reports`** — no job.
- **Record A becomes `ELIGIBLE_NOT_GENERATED`**: eligibility flips to `ELIGIBLE`, generation is still
  `NOT_REQUESTED`, availability `NO_ARTIFACT`, `finalized` true.
- **Action becomes `GENERATE`** (`outputActionFor`), rendered by
  `EvidenceArtifactsTab.tsx:GenerateOutputsButton` as *"Generate report & verification package"*, with
  **no confirmation dialog** (correct — only REGENERATE confirms).
- **The request is auditable**: `POST /v1/evidence/:id/reports/regenerate` emits
  `evidence.report.regenerate_requested` with the actor, and `ReportGenerationRequest` records
  `requestedByUserId`, `purpose: "operator_regenerate"`, `expectedPolicyVersion`.
- **No credit consumed** — proven in C.
- **Report v1 and Package v1** are produced by the one job (`provisionalVersion = max+1 = 1`).
- **Operations does not call pre-generation absence a failure** — `outputEntitledEvidenceWhere`
  returns `null` once the plan includes reports, so the whole population is in scope for the backlog
  probe *from that point on*. Note this means an upgraded account's historical records **do** start
  counting toward `pipeline.report_backlog` (HIGH at 20, CRITICAL at 100) even though the customer has
  not asked for any of them. See P2-9.
- **Multiple old FREE records:** all of them read `ELIGIBLE_NOT_GENERATED` and each carries its own
  Generate action. There is no bulk generate. The Billing banner links to `/reports` unfiltered
  (deliberately — the `ReportLifecycleFilter` vocabulary has no "eligible but not generated" member).

---

## H. FAILED_TERMINAL COMMERCIAL SUPERSESSION

**The commercial case is correctly closed.**

`createReportGenerationRequest` computes `baseKey = REPORT:<id>:v<baselineVersion>[:force]`. Before
inserting it reads the row at `baseKey`; if that row is `FAILED_TERMINAL` **and**
`isCommerciallyObsoleteTerminalReason(terminalReasonCode)`, it appends a supersession ordinal derived
from a `count(...)` of existing `:s` keys — `REPORT:<id>:v0:force:s1`. Two concurrent callers compute
the same ordinal and the UNIQUE index elects one winner.

- The old row is **never rewritten and never deleted** — it is the audit record of a refusal that
  really happened. ✅
- `COMMERCIAL_TERMINAL_REASONS` = `REPORT_NOT_INCLUDED_IN_PLAN`, `VERIFICATION_PACKAGE_NOT_INCLUDED`,
  `REPORT_NOT_INCLUDED`. Nothing technical or integrity-class is in the set. ✅
- Commercial supersession cannot bypass funding: the new request still reaches the worker's own
  `resolveEvidenceOutputEntitlements` gate at `processor.ts:2063`. ✅
- The customer-facing verb after upgrade is **`GENERATE`, not a dead retry** (`outputActionFor`
  returns `GENERATE` for `TERMINAL_FAILURE` + `ELIGIBLE` + `terminalReasonClass === "COMMERCIAL"`). ✅

### ❌ P1-2 — THE SAME LOCKOUT SURVIVES FOR EVERY *BLOCKED* TERMINAL

`TERMINAL_JOB_EXECUTION_STATES` = `SUCCEEDED | FAILED_TERMINAL | BLOCKED_STALE | BLOCKED_POLICY`.
The supersession rule keys on `state === "FAILED_TERMINAL"` **only**, and on a commercial reason code
**only**. Every `BLOCKED_*` terminal therefore poisons its idempotency key permanently.

`resolveAndClaimReportRequest` writes these blocked terminals:

| Reason code | State | Resolvable in the real world? |
|---|---|---|
| `policy_version_changed` | `BLOCKED_STALE` | **Yes** — it is a race, not a refusal |
| `legal_hold_active` | `BLOCKED_POLICY` | **Yes** — holds are released |
| `organization_not_active` | `BLOCKED_POLICY` | **Yes** — suspensions are lifted |
| `workspace_mismatch`, `workspace_not_found`, `no_principal` | `BLOCKED_POLICY` | no |

The most reachable is `policy_version_changed`. A workspace admin editing the governance policy
between a request's creation and its execution bumps `WorkspaceGovernancePolicy.version`; the worker
compares it against `expectedPolicyVersion` and writes `BLOCKED_STALE`. That is correct behaviour for
that attempt. What follows is not:

1. No report exists, so `baselineVersion` stays `0` forever.
2. Every later request — the customer's Generate button, the Reports page, the Operations
   remediation, the `lifecycle-recovery` sweep — computes the same key and collapses onto the
   terminal row.
3. `requestReportGeneration` returns `{requested:true, enqueued:false, reason:"already_terminal"}`.
4. The record's derived state is `BLOCKED`, and `outputActionFor("BLOCKED")` returns **`NONE`**.
5. `remediation-executor.ts:313` maps any non-`SUCCEEDED` terminal to `NOT_ELIGIBLE`, so the operator
   console cannot break out of it either.

**That record can never be given a report by any path in the product.** The mechanism is exactly the
one the 2026-09-08 supersession fix was written for; the fix was scoped to the commercial class only.

Aggravating factor: the Generate route always passes `forceRegenerate: true` (see AC/P2-5), so the
legal-hold branch fires even for a **first** generation, and burns the `:v0:force` key on a record
that has no artifact to preserve.

---

## I. PRO → FREE DOWNGRADE

Walked with an existing Report vN + Package vN.

| Question | Answer | Source |
|---|---|---|
| Artifacts remain? | Yes. `setPersonalPlan` writes `entitlements.plan` and nothing else; no delete path is reachable from a plan change | `billing.service.ts` |
| Downloads still work? | **Yes.** `GET /v1/evidence/:id/report/latest` and `GET /v1/evidence/:id/verification-package` contain no plan, capability or entitlement read on the artifact-exists path | `evidence.routes.ts:10455`, `:10963` |
| Frontend hides them? | **No.** Both handlers had their `reportsIncluded` prechecks removed; `downloadable` is derived from `artifactStatus.state === "READY"` | `useEvidenceArtifactActions.ts`, `EvidenceArtifactsTab.tsx` |
| Server authorization intact? | Yes — read access, `enforceSensitiveAction`, `checkExportEligibility`, `gateVerificationAction` all still run | as above |
| Automatic regeneration? | No writer exists | — |
| New generation eligibility | Current commercial state, unless the record's own funding says otherwise: `deriveEvidenceOutputState` returns `READY` and `outputActionFor` returns `NONE` because `eligibility !== "ELIGIBLE"` — so **Regenerate is not offered** after a downgrade, which is correct | `evidence-output-lifecycle.ts:outputActionFor` case `READY` |

**Correct.** This is the cleanest part of the closure.

---

## J. TEAM → PRO GRANDFATHERING

`setPersonalPlan(userId, "PRO")` with 350 existing personal records:

```
nextCaps.maxEvidenceRecords = 100 (not null)
existing = countPersonalEvidenceRecords(userId) = 350
350 > 100 → legacyRecordCapOverride = 350
```

Interpreted in exactly one place — `commercial-context.service.ts:428`:
`effectiveLifetimeRecordCap = scope.legacyRecordCapOverride ?? capabilities.maxEvidenceRecords`.

- Downgrade allowed ✅
- 350 existing preserved and reachable ✅ (nothing reads the cap to hide or invalidate a record)
- PRO does **not** grant 100 additional free records — the cap is 350, and `currentRecordCount` is
  350, so `withinPlanAllowance` is false ✅
- Record 351 needs a credit or a higher plan ✅
- **Upgrade back to TEAM clears the override** (`maxEvidenceRecords === null` → write `null`) ✅
- **TEAM→PRO→TEAM→PRO does not compound**: each downgrade recomputes from the live count; each
  upgrade to an uncapped plan clears it ✅
- The count uses `countPersonalEvidenceRecords`, the same predicate the enforcement path compares
  against ✅
- Tri-state write (`null` = don't touch, `{override: null}` = clear) prevents a failed count from
  erasing a real grandfather ✅

**One asymmetry (P3):** the frozen cap is not recomputed downward. A customer grandfathered at 350
who then deletes 200 records holds a cap of 350 against a count of 150 and receives 200 free records
above PRO's 100. Bounded by their own history; not exploitable beyond it.

---

## K. REPORT DOWNLOAD — COMPLETE MATRIX

Route: `GET /v1/evidence/:id/report/latest`. Gates in order:
`requireAuth` → `getEvidenceWithReadAccess` → (if `teamId`) `enforceSensitiveAction("download_report")`
→ `checkExportEligibility` → `report.findFirst(orderBy version desc)` → `headObject` → `presignGetObject`.
**There is no commercial read anywhere in this route.**

| # | Case | Button? | Request sent? | Server allows? | Download? | Why |
|---|---|---|---|---|---|---|
| A | Plan includes reports | Yes | Yes | Yes | ✅ | state `READY` |
| B | Downgraded, artifact exists | **Yes** | Yes | **Yes** | ✅ | `READY` wins in `deriveEvidenceOutputState`; route has no plan gate |
| C | PAYG-funded record | Yes | Yes | Yes | ✅ | funding-aware eligibility; route has no plan gate anyway |
| D | OTS `PENDING` | Yes | Yes | Yes | ✅ | OTS is not an input to download |
| E | OTS `FAILED` | Yes | Yes | Yes | ✅ | same |
| F | TSA `FAILED` | Yes | Yes | Yes | ✅ | same |
| G | TSA safe-repaired from stored token | Yes | Yes | Yes | ✅ | repair also enqueues a regeneration so the new version carries the corrected state |
| H | Newer version exists | Yes | Yes | Yes | ✅ **latest only** | the route always serves `orderBy: {version:"desc"}` |
| I | **Old version explicitly requested** | listed in history | — | — | ❌ **no route exists** | see P2-10 |
| J | Report exists, package missing | Yes (report button) | Yes | Yes | ✅ | independent artifacts |
| K | Latest request `FAILED_TERMINAL` | Yes | Yes | Yes | ✅ | `READY` precedes axis 2 |
| L | Authorization revoked (membership not ACTIVE) | n/a | Yes | **No** | ❌ 404 | `getEvidenceWithReadAccess` requires `status === "ACTIVE"` |
| M | Cross-workspace actor | n/a | Yes | **No** | ❌ **404, byte-identical to missing** | anti-enumeration closure at `evidence.routes.ts:2765` |
| N | **Evidence under legal hold** | Yes | Yes | **No** | ❌ 403 `BLOCKED_BY_HOLD` | `checkExportEligibility` blocks on a direct hold **or a hold on any linked case** |
| O | Lifecycle `ON_HOLD` / `RETENTION_LOCKED` / `PENDING_DESTRUCTION` / `DESTROYED` | Yes | Yes | **No** | ❌ 403 `BLOCKED_BY_LIFECYCLE` | same service |

**Case N/O note:** this is a deliberate export-containment policy, not a defect — but it is worth
stating plainly that under PROOVRA a legal hold **prevents the holder from downloading the report**,
which is the opposite of the usual preservation-only reading of a hold. The UI is honest about it
(`GovernedExportAction` disables the button and shows the reason from
`GET /v1/governance/export-eligibility`).

**Legacy caveat (P3):** both governance gates are inside `if (evidenceForGate?.teamId)`. Rows
predating the HOME-DATA-OWNERSHIP change (`team_id NULL`) skip the policy gate, the export-eligibility
gate and the legal-hold check entirely; only ownership applies.

---

## L. VERIFICATION PACKAGE DOWNLOAD — COMPLETE MATRIX

Route: `GET /v1/evidence/:id/verification-package`. Same gates plus
`gateVerificationAction({action:"PUBLISH_PACKAGE"})`.
**No commercial read on the artifact-exists path.**

| Case | Result | Source |
|---|---|---|
| Plan downgraded, package exists | ✅ presigned URL | no commercial gate before `presignGetObject` |
| PAYG-funded record | ✅ | as above |
| OTS pending | ✅ | not an input |
| OTS anchored | ✅ | not an input |
| TSA failed | ✅ | not an input |
| Package v1 while v2 exists | ✅ **v2 served** (latest only); v1 unreachable | same defect as K-I |
| Report exists, package missing, **eligible** | **202 `verification_package_pending`** | ⚠️ returned even when the generation request is `FAILED_TERMINAL` — see P2-13 |
| Report exists, package missing, **not eligible** | 409 `verification_package_not_included` | ✅ the honest answer; replaces the old permanent 202 |
| Package blocked by governance | 409 `verification_package_blocked` + bounded outcome/reason | ✅ |
| Package exists, Report row missing | ✅ served | not reachable by any current writer |
| Legal hold | 403 `BLOCKED_BY_HOLD` | `checkExportEligibility` |
| Cross-tenant actor | 404, indistinguishable from missing | `getEvidenceWithReadAccess` |
| Expired / revoked access | 404 (non-ACTIVE membership) | same |
| Not finalized, no package | 404 `verification_package_not_found` | ✅ |

**Server authority:** `prisma.verificationPackage.findFirst({orderBy:{version:"desc"}})` → `headObject`
(a zero-byte or missing object degrades to 404) → `presignGetObject(600s)`.

---

## M. TSA × OTS × REPORT GENERATION MATRIX

**Derived, not assumed.** Grep of every `throw createWorkerError(...)` in `processor.ts` shows the
gates are: evidence missing, not SIGNED, missing sha256/fingerprint/signature/signing key, owner
missing, **`REPORT_NOT_INCLUDED_IN_PLAN`**, storage not set, object not found, hash mismatch, signing
key not found. **Neither `tsaStatus` nor `otsStatus` appears in any gate.**

| TSA | OTS | First Report may start? | Package may start? | Blocks? | Report truthful? | Later anchor → v+1? |
|---|---|---|---|---|---|---|
| STAMPED | NULL | ✅ | ✅ | no | ✅ "Anchoring not recorded" (falls through to anchor-mode label) | ✅ when the OTS job eventually runs |
| STAMPED | PENDING | ✅ | ✅ | no | ✅ "OTS proof present; Bitcoin anchoring pending" | ✅ `enqueueReportJob(force, "ots_anchored")` on `FULLY_ANCHORED` |
| STAMPED | ANCHORED | ✅ | ✅ | no | ✅ "OpenTimestamps Bitcoin anchoring verified" (requires txid **or** anchoredAt) | n/a |
| STAMPED | FAILED | ✅ | ✅ | no | ✅ "OpenTimestamps anchoring failed"; `custody-model.ts:139` records it | no (terminal) |
| FAILED | any | ✅ | ✅ | **no** | ✅ the report states the TSA failure; it does not claim a timestamp | unchanged |
| PENDING/other | any | ✅ | ✅ | no | ✅ | unchanged |

**Intentional?** Yes, and correctly so: a report is a *rendering* of integrity state, not a
certificate of success. Blocking generation on a failed timestamp would deny the customer the
document that records the failure. The one guard that matters is presentational and it holds:
`resolveOtsPresentationEvidence` degrades `ANCHORED`-without-`anchoredAtUtc` back to `PENDING`, and
`mapPublicAnchoringLabelFromOts` requires a valid 64-hex txid **or** an anchor time before it will say
"verified".

---

## N. OTS INITIALIZATION DURABILITY — CRITICAL QUESTION #1

**Traced code, not comments.**

1. `completeEvidence` commits its `$transaction` (status SIGNED, signature, TSA columns, custody chain,
   credit settlement).
2. **After** the commit, `evidence-complete.service.ts:1326`:
   `await requestEvidenceOtsAnchoring({evidenceId, trigger:"evidence.completed"})`.
3. `requestEvidenceOtsAnchoring` is `try { enqueueCanonicalWork(...) } catch { return {requested:false, reason:"failed"} }`.
   Its docblock says, correctly: **"IT NEVER THROWS."**
4. `enqueueCanonicalWork` catches a missing/unreachable Redis and returns
   `{enqueued:false, reason:"queue_unavailable:<msg>"}` (`canonical-queue-client.ts:152`).
5. The return value at the call site is **discarded**. Completion succeeds.

**Is the enqueue awaited?** Yes — but the awaited value is a bounded failure, not a throw.
**Does the completion endpoint fail?** No, by design.
**Is there a durable DB outbox?** **No.** Nothing is written to record the intent. The Evidence row's
OTS columns stay NULL, which is indistinguishable from "the job is about to run".
**Is there a canonical retry / reconciler?** **No production one.**
- `services/worker/src/lifecycle-recovery.ts` — the module the canonical work registry names as the
  UPGRADE_OTS reconciler — contains **zero** OTS logic. It scans `Evidence(status=SIGNED, reports:{none:{}})`
  and re-requests **report** generation only.
- `services/worker/src/scripts/reconcile-ots-never-attempted.ts` exists and is correct, but it is a
  **manual CLI**, dry-run by default, and its own header states *"it has never been run against
  Production."* Nothing schedules it (`grep` of `services/worker/src/index.ts` finds a timer for
  capture-reaper, orphan-scan, lifecycle-recovery, MFA GC, redaction, trash-grace, search-index,
  intelligence-run, retention, destruction, immutable-storage, archive, webhook, exchange-package,
  reviewer, org-invite and automation sweeps — **and no OTS sweep**).
**Does any background scanner find finalized Evidence with `otsStatus` NULL?** **No.**
`evidence-integrity-conditions.service.ts:349-357` selects only
`tsaStatus = FAILED`, `otsStatus = FAILED`, and `otsStatus IN (PENDING, SUBMITTED, UPGRADING)`.
**NULL is not in the scan**, so no `OperationalIncident` is ever opened, and therefore the
`ots.resume_anchoring` remediation — which *would* work on such a record — is unreachable, because
`executeRemediation` is keyed on an incident id.
**Can a record remain NULL forever?** **Yes.**

### Classification: **RELIABILITY_GAP**

Missing durable recovery authority: a scheduled sweep over
`Evidence(deletedAt: null, fingerprintCanonicalJson: not null, otsStatus: null, otsProofBase64: null)`
that re-enters `requestEvidenceOtsAnchoring`. The logic already exists in
`reconcile-ots-never-attempted.ts`; what is absent is a scheduler and an operational signal.

---

## O. OTS RETRY EXHAUSTION — CRITICAL QUESTION #2

**The premise in the brief is more generous than the code.** BullMQ attempts are never consumed on
this path, because the failure never reaches BullMQ.

Traced:

1. `processOtsUpgrade` finds `!evidence.otsProofBase64` → calls `ensureEvidenceOtsInitialized`.
2. `ensureEvidenceOtsInitialized` calls `createOpenTimestamp`. A **throw** (binary missing, no
   network, timeout) is caught at `ots-lifecycle.ts:172-186` and returns
   `{initialized:false, reason:"not_finalized"}` — deliberately leaving the columns NULL so an outage
   is not persisted as a per-record integrity failure. That reasoning is sound.
3. Back in the processor (`ots-upgrade.processor.ts:222-247`): `init.initialized` is false, so no
   follow-up is enqueued; the function logs `status: "skipped_not_finalized"` and **`return`s
   normally**.
4. The BullMQ job therefore **completes successfully on attempt 1**. `RETRY_POLICIES.TIMESTAMP_AUTHORITY`
   (`attempts: 20`, exponential 60s) is never engaged, because nothing throws.

**So there is no "retry exhaustion" — there is no retry at all.** A single transient failure of the
OTS binary or calendar strands the record permanently at `otsStatus = NULL`.

- Periodic retry after the job ends? **None.**
- Global reconciler? **None scheduled** (see N).
- Does Operations detect it? **No** — NULL is excluded from the integrity scan.
- Terminal incident? **No.**
- Does NULL get requeued? **Only by a human running the CLI.**
- Can it read "Not yet anchored" forever? **Yes** — that is exactly the string
  `_tabs/_lib.tsx:526` renders, and its own copy promises the anchoring "has not started … yet".

**The 30-day `OTS_GLOBAL_BUDGET_EXHAUSTED` path does not cover this record either**, because that
branch lives in the PENDING-proof arm of the processor and is only reached by a record that already
holds a proof.

### Classification: **RELIABILITY_GAP**

Missing: (a) the initialization failure must consume an attempt (throw, or explicitly re-enqueue with
a delay); (b) the never-attempted population needs a scheduled sweep; (c) an aged NULL needs to be a
visible operational condition, distinct from FAILED.

---

## P. OTS STATE MACHINE

`ots-state.ts:buildOtsEvidenceUpdateData` is the only writer of the OTS columns.

| Transition | Writer | Condition | Retry | Custody | Operations | Notifications | Public Verify |
|---|---|---|---|---|---|---|---|
| NULL → PENDING | `ots-lifecycle.ts` init | stamp returns PENDING | follow-up enqueued when `needsUpgrade` | `OTS_APPLIED` (`otsPhase:"proof_created"`) | aged-pending condition after 24h (WARNING) / 72h (HIGH) | yes (aged) | "proof present, anchoring pending" |
| NULL → ANCHORED | init | stamp returns ANCHORED (rare) | follow-up only if no txid | `OTS_APPLIED` | none | none | "verified" if txid or anchoredAt |
| NULL → FAILED | init | `createOpenTimestamp` returns a **structured** FAILED | none | `OTS_FAILED` | `evidence_integrity.ots_failure` → `ots.resume_anchoring` | yes | "anchoring failed" |
| NULL → NULL | init | `createOpenTimestamp` **throws** | **none** ❌ | none | **none** ❌ | none | "Not yet anchored" |
| PENDING → ANCHORED | upgrade processor | `classification.kind === "FULLY_ANCHORED"` (verify or info confirms) | n/a | `OTS_APPLIED` (`anchored` / `anchored_via_info` / `anchor_material_recovered`) | condition auto-resolves | resolves | "verified" |
| PENDING → PENDING | upgrade | `STILL_PENDING` / `ANCHOR_MATERIAL_RECOVERED` | re-enqueue at +1h with `selfJobId` | `OTS_APPLIED` (pending phases) | aged after window | yes | "pending" |
| PENDING → FAILED (budget) | upgrade | `isOtsGlobalBudgetExhausted(createdAt, now)` > 30d | **stops** | `OTS_FAILED` (`global_budget_exhausted`) | `recordWorkerIncident` CRITICAL, `evidence_integrity.ots_budget_exhausted` | yes (P1 in inbox) | "failed" |
| PENDING → FAILED (hard) | upgrade | command errored and not pending-like | throws `OTS_UPGRADE_FAILED` → BullMQ retries (20) | `OTS_FAILED` | `ots_failure` condition | yes | "failed" |
| ANCHORED → ANCHORED | upgrade | already anchored **with a defensible txid** → early return | n/a | none | n/a | n/a | n/a |
| `*` → DISABLED | init | `createOpenTimestamp` returns DISABLED (feature off) | none | `OTS_APPLIED` | none | none | "Anchoring not recorded" |

### Illegal transitions

- **ANCHORED → PENDING (persisted):** prevented. `shouldPreserveAnchoredState` keeps `ANCHORED` when
  the effective status is ANCHORED without a defensible txid. The PENDING *display* degradation in
  `resolveEffectiveOtsStatus` / `resolveOtsPresentationEvidence` is presentational only and never
  written.
- **FAILED → re-initialization:** prevented. `ensureEvidenceOtsInitialized` returns
  `already_initialized` for **any** record holding proof bytes, whatever its status, so a FAILED
  record with a proof is never re-stamped (documented reason: re-stamping would reset the calendar's
  anchoring clock). A FAILED record with **no** proof bytes (the structured-FAILED case) *would* be
  re-initialized if a job ran — but the reconciliation script deliberately excludes `FAILED`, and no
  other producer targets it.
- **PENDING → NULL:** impossible. `buildOtsEvidenceUpdateData` never writes NULL to `otsStatus`
  outside the DISABLED branch.
- **Overwrite of an upgraded proof by a late initializer:** prevented by the conditional
  `updateMany({where: {otsProofBase64: null}})` race guard.

---

## Q. OTS CONCURRENCY

| Race | Mechanism | Verdict |
|---|---|---|
| A. Duplicate finalize | `pg_advisory_xact_lock(hashtext(evidenceId))` + a `updateMany` finalize claim re-asserting the precondition | ✅ one finalize |
| B. Duplicate OTS job | job id is `ots-upgrade-<evidenceId>` from `buildCanonicalJobId`; BullMQ refuses a duplicate id, and the client reports it as `collapsed` | ✅ one live job |
| C. Two `createOpenTimestamp` calls | possible (the calendar call is outside any transaction), but the **persistence** is `updateMany where otsProofBase64 IS NULL` — the loser discards its own stamp | ✅ one stored proof, one custody event |
| D. Initialization vs upgrade | same processor, same job id; the upgrade arm requires `otsProofBase64` to exist | ✅ mutually exclusive |
| E. Upgrade vs manual Report regeneration | independent rows; the report reads OTS columns, never writes them (the whole OTS write block was deleted from the report transaction) | ✅ no interference |
| F/G. Anchor vs downgrade/upgrade of plan | OTS consults no commercial state at all | ✅ |
| H. Anchor while a Report job is running | the anchor's `enqueueReportJob(force)` computes `baselineVersion` from the current max; if the in-flight job commits first the key differs and a genuine new version is produced; if it commits second, both runs hold the same `provisionalVersion` | ⚠️ see U / P2-9 |
| I. Same Evidence in two workers | one live job id; and the `updateMany` guard covers the residual | ✅ |

**Duplicate custody event:** not possible for OTS — the custody append is inside the same transaction
as the conditional update and only runs when `claimed.count > 0`.
**Stale overwrite:** not possible — same guard.
**Ordering:** the follow-up enqueue uses `selfJobId` so a running job can schedule its own successor
without collapsing onto itself. That mechanism is load-bearing and correct
(`queue.ts:458-480`, `ots-upgrade.processor.ts:640`).

---

## R. OTS RETRY / GLOBAL BUDGET

**Two separate systems, and a record can fall between them.**

| System | Scope | Trigger | Effect |
|---|---|---|---|
| BullMQ attempts (`RETRY_POLICIES.TIMESTAMP_AUTHORITY`, 20, exponential 60s) | one scheduled run | only a **throw** — i.e. the hard `OTS_UPGRADE_FAILED` branch | job retried, then dead-lettered |
| Self re-enqueue ladder | across runs | every PENDING outcome | new job at +1h under the same stable id |
| Global budget (`OTS_GLOBAL_BUDGET_DAYS`, 30, from `Evidence.createdAt`) | the record's whole anchoring life | evaluated in the PENDING arm | writes `FAILED` + `OTS_GLOBAL_BUDGET_EXHAUSTED` + a CRITICAL incident, and **stops re-enqueueing** |
| Operations aging (`OTS_OPERATIONS_WARNING_HOURS` 24 / `..._HIGH_HOURS` 72) | read-only | evaluated by `observeOtsPendingAged` | opens/escalates a condition; ceiling is HIGH, never CRITICAL, deliberately |

The separation of the aging window from the budget is **correct and well argued**
(`packages/shared-runtime/src/ops/ots-aging.ts:133-180`): binding them produced a surface with no
useful middle.

### The gap between the two systems

A record at `otsStatus = NULL` is governed by **neither**:
- the budget predicate is only evaluated in the PENDING arm, which requires a stored proof;
- the aging predicate returns false immediately (`OTS_PENDING_STATUSES` does not contain NULL);
- BullMQ has no job to retry, because the initialization failure returned success.

This is the same population as N/O. It is the one hole in an otherwise carefully bounded design.

The "soft ceiling of 10 attempts / `stuck: true`" described in the file header
(`ots-upgrade.processor.ts:60-68`) has **no implementation at HEAD** — there is no per-evidence
attempt counter and no `stuck` field produced by this processor. The header describes an intent that
the Point-5 rewrite superseded; the 30-day budget is the only real ceiling. (P3 — stale comment.)

---

## S. HISTORICAL OTS RECONCILIATION

`services/worker/src/scripts/reconcile-ots-never-attempted.ts`, read only — **not executed**.

| Property | Verdict | Evidence |
|---|---|---|
| Dry-run default | ✅ | `apply: false`; the non-apply branch returns before any write |
| `--apply` explicit | ✅ | only `--apply` sets it |
| Scoped | ✅ | `--team-id`, `--evidence-id` fold into `finalizedScope` |
| Idempotent | ✅ | enqueues the deterministic `ots-upgrade-<id>` (BullMQ collapses); and the initializer's own `otsProofBase64 IS NULL` guard rejects anything that gained a proof between scan and run |
| Cursor bounded | ⚠️ **`take: limit` + `orderBy [createdAt asc, id asc]`, not a cursor.** Re-running before the enqueued jobs complete re-selects the same head of the population. Harmless (the job ids collapse) but it is a bound, not a cursor |
| Never-attempted only | ✅ | acts on `CATEGORIES.NEVER_ATTEMPTED = {otsStatus: null, otsProofBase64: null}` |
| Excludes FAILED / PENDING / ANCHORED | ✅ | the other three categories are **counted and never acted on** |
| No TSA interaction | ✅ | no TSA column is read or written anywhere in the file |
| Uses the canonical OTS queue path | ✅ | `enqueueOtsUpgradeJob` |
| No direct OTS DB write | ✅ | the only Prisma calls are `count` and `findMany` |

**Product/legal semantics.** The script prints, on every run:
> *"a proof created now attests existence no later than TODAY, not the original capture time.
> Capture, TSA and OTS times remain three separate facts on the record."*

That statement is upheld by the rest of the system:

- `Evidence` keeps `capturedAtUtc`, `signedAtUtc`, `tsaGenTimeUtc` and `otsAnchoredAtUtc` as four
  distinct columns; nothing collapses them.
- The report renders **"OTS Anchored At (UTC)"** as its own row (`technical-model.ts:316`), beside
  the TSA rows, never as the record's timestamp.
- `mapPublicAnchoringLabelFromOts` will not say "verified" without an anchor time or txid, and the
  anchor time it shows is the real one.
- The custody event written by the initializer carries `trigger` (`"ots_backfill"` for this path),
  so a later anchor is **explicable from the chain rather than inferred from a gap**.
- Public Verify surfaces `anchoredAtUtc` and `upgradedAtUtc` separately from the TSA block
  (`verify/[token]/page.tsx:360-371`).

**No surface was found that would misrepresent a backfilled anchor as original-time anchoring.**

The header's own gate — *"PRODUCT/LEGAL REVIEW REQUIRED before this is run anywhere real"* — is the
right posture and should be honoured.

---

## T. TSA SAFETY AUDIT

Repo-wide search (`services`, `apps`, `packages`, `scripts`; excluding `node_modules`, `dist`) for
`retryTsa`, `tsa retry`, `enqueueTsa`, `TSA_RETRY`, `timestamp retry`, `reissue timestamp`,
`re-stamp`, `restamp`:

- **Zero production hits.** Every match is a test assertion pinning the *absence*
  (`commercial-output-journeys.test.ts:397`, `commercial-output-lifecycle-closure.test.ts:487`,
  `free-integrity-vs-paid-output-boundary.test.ts:247,274`,
  `workspace-operations-readiness.test.ts:357`, `operations-remediation-registry.test.ts:259,270`), or
  refers to an unrelated `abandonedAtUtc` re-stamp in upload sessions.
- **One TSA call site in the whole repository:** `evidence-complete.service.ts:912`. Verified by grep
  on `createEvidenceTimestamp`.
- **No TSA queue, job name or work-registry entry exists.** `JOB_NAMES` has no timestamp member.
- **No user retry button.** `remediation-registry.ts` gives `tsa_failure` the disposition
  `NO_SAFE_REMEDIATION_AUTHORITY` with an explicit `unsafeReason`:
  > *"Re-contacting the authority now would mint a token whose genTime is later than the evidence it
  > certifies, and presenting that as the record's timestamp would assert something untrue."*
- **No Operations action recontacts the TSA.** The only two remediation action ids are
  `ots.resume_anchoring` and `report.regenerate_artifacts`.
- **Safe repair never contacts the provider.** `repair-tsa-failed-with-token.ts` decodes the **stored**
  `tsa_token_base64` to a temp file and runs `openssl ts -reply -in <file> -text` — the same
  subprocess the live path runs — then re-parses. Dry-run by default, `--limit` capped at 1000, and it
  never writes a fake success (`granted === true` + serial + genTime + imprint match are all required).
- **TSA FAILED stays FAILED** unless that same stored token re-parses as granted.
- **OTS processing never mutates TSA.** `ots-state.ts` writes only `ots*` columns; the OTS
  reconciliation script reads no TSA column.
- The migration `20270830000000_evr_p10_tsa_retry_tracking` is an **empty restored marker file** with
  no SQL. No table, no column, no behaviour.

**One residual worth stating (not a defect):** `createEvidenceTimestamp` is awaited **inside** the
finalize `$transaction`, so a slow TSA holds a database transaction and an advisory lock open for the
duration of `TSA_TIMEOUT_MS`. It is bounded and it never fails the completion (all failure paths
return a `status:"FAILED"` result rather than throwing), but it is an external network call inside a
transaction. **P3 / performance, not correctness.**

**Verdict: TSA safety is CORRECT and is the strongest-held invariant in this area of the codebase.**

---

## U. REPORT VERSIONING

- **Sequence:** `provisionalVersion = (max(version) ?? 0) + 1`, computed in `prepareReportArtifacts`
  (`processor.ts:2429-2432`) — **outside** the finalize transaction.
- **Storage key:** `reports/<evidenceId>/v<N>.pdf` — unique per version, never a "latest" alias. ✅
- **No overwrite of a row:** `@@unique([evidenceId, version])` on `reports`.
- **Object Lock:** `putObjectBuffer({immutable: true})` applies the configured
  `ObjectLockMode` + `ObjectLockRetainUntilDate` when Object Lock is enabled;
  `applyRetentionOrThrow` then re-asserts retention and `headObject` reads the applied lock back into
  the row. `ObjectLockLegalHoldStatus` is deliberately never sent (see the S3 legal-hold decision).
- **Custody:** `REPORT_IDENTITY_CONTEXT_RECORDED` inside the transaction; `REPORT_GENERATED` and
  `VERIFICATION_PACKAGE_GENERATED` on their respective commits.
- **Latest pointer:** `Evidence.latestReportVersion` + `orderBy: {version:"desc"}` everywhere.
- **Serialization:** the finalize transaction takes `pg_advisory_xact_lock(hashtext(evidenceId))`
  **before** the upload, so two runs for one record cannot interleave their writes.

### ❌ P2-9 — TWO CONCURRENT RUNS CAN CHOOSE THE SAME NEXT VERSION

`provisionalVersion` and both storage keys are computed **before** the advisory lock is taken.
Two runnable requests for one record at the same baseline therefore both hold `N`, both write to
`reports/<id>/vN.pdf`, and the advisory lock only serializes their **database** work.

What prevents it *most* of the time is the idempotency key: two concurrent completion fan-outs both
compute `REPORT:<id>:v0` and produce one row; two operator regenerates both compute
`REPORT:<id>:v3:force` and produce one row.

**What does not collapse is a `force` request against a non-`force` one at the same baseline.**
Concretely reachable: a PRO record's completion request (`:v0`) is retrying; the OTS upgrade anchors
and calls `enqueueReportJob(forceRegenerate:true)` → key `:v0:force` → a **second** runnable request.
Both compute `provisionalVersion = 1`.

Outcome: the second uploader **overwrites the current version of `reports/<id>/v1.pdf`** (a PUT to an
Object-Locked key creates a new object version; the lock protects old versions, it does not reject
the PUT — there is no `If-None-Match` precondition anywhere in `storage.ts`), and then its
`tx.report.create` raises P2002 and the whole transaction rolls back. The surviving `reports` row
describes the **first** run while the bytes at that key are the **second** run's.

Impact is bounded — both runs render the same record at the same version, so the content is
substantively equivalent, and `sizeBytes` / lock metadata on the row may simply not match the object.
But for an evidentiary artifact "the stored bytes are not the bytes this row describes" is not a
state the platform should be able to reach. **P2**, because reachability requires a retrying first
generation coinciding with an anchor.

The correct shape is to re-derive the version **inside** the advisory lock and to key the object on
the version the transaction actually claims.

---

## V. PACKAGE VERSIONING

- Same `@@unique([evidenceId, version])`, same `v<N>` key shape (`verification/<id>/v<N>.zip`), same
  Object Lock and retention treatment.
- **Version is shared, not independent:** the package is written with `version: prepared.version`, the
  same integer as the report. There is no separate package sequence.
- **Do the versions always match?** They match *when both succeed*. They can diverge, and the
  divergence is silent — see W.

### What happens when Report v2 succeeds and Package v2 fails

1. The report transaction commits `Report{version:2, verificationPackageVersion: 2}` — the package
   version is written **optimistically at report-row creation**
   (`processor.ts:3443`: `verificationPackageVersion: prepared.verificationPackageIncluded ? prepared.version : null`),
   i.e. before the package exists.
2. The package build/upload/persist runs afterwards in its own `$transaction`. On failure the `catch`
   at `processor.ts:4243` logs, captures, writes an audit row — and **swallows**.
3. The `ReportGenerationRequest` is still marked **`SUCCEEDED`**.
4. Result: `Report{version:2}.verificationPackageVersion = 2`, while
   `max(VerificationPackage.version) = 1` and `Evidence.verificationPackageVersion = 1`.

**How the UI projects it:** `buildEvidenceArtifactStatus` reads the package table, so
`outputs.verificationPackage` reads `NO_ARTIFACT` at v2 but `READY` at v1 — the projection returns
`verificationPackage.version = 1` **and** `report.verificationPackageVersion = 2` in the **same
response**. A consumer trusting the report row's pointer is misled. **P2-8.**

The customer-facing state is at least actionable: the package projects as `READY` (v1) with the
report at v2, and there is no surface that says "your package is a version behind".

---

## W. REPORT/PACKAGE ATOMICITY

**They are ONE request and ONE job, but TWO independent persistence units.**

| Failure point | Retry semantics | Duplicate artifacts | Orphaned objects | Status projection | Operations incident | Convergence |
|---|---|---|---|---|---|---|
| PDF build fails | throws → `isRetriableError` default **true** → `FAILED_RETRYABLE` → BullMQ retry | no | no | `RETRYABLE_FAILURE` + `RETRY` action | DLQ+incident only when non-retryable | ✅ |
| PDF uploaded, `tx.report.create` fails | transaction rolls back; **the S3 object stays** | no row | **yes — an orphan `reports/<id>/vN.pdf`** | unchanged | no | the next run reuses the same key |
| Report OK, ZIP build fails | swallowed | no | no | package `ELIGIBLE_NOT_GENERATED` | **`pipeline.package_generation_denied` only for a governance denial**; a build failure gets `package_generation_failed_total` + a log, **no incident** | only if a human clicks Generate |
| Report OK, ZIP uploaded, package tx fails | swallowed | no row | **yes — an orphan `verification/<id>/vN.zip`** | as above | none | as above |
| Worker dies after storage upload, before DB | job retried; new run picks the **same** version and re-uploads | no | overwritten | unchanged | no | ✅ |
| Worker dies after report tx, before package | lease expires → `reconcileStrandedReportRequests` would release it — **but that reconciler never runs** (P1-1). BullMQ's stalled-job recovery may redeliver; the redelivered job hits `status === REPORTED && !forceRegenerate && existingReport` and **returns immediately**, so the package is never built | no | no | package `ELIGIBLE_NOT_GENERATED` | no | ❌ only a human Generate closes it |

**The operator's escape hatch for this case is broken.** See AF/P2-7: the `PACKAGE`-category
remediation dispatches `regenerateArtifacts(..., forceRegenerate: false)`, and the report job's very
first guard is `if (evidence.status === REPORTED && !forceRegenerate) { if (existingReport) return; }`.
For the exact population the condition names — a REPORTED record missing its package — the action is
a **no-op reported to the operator as `QUEUED`**, and the incident never resolves.

---

## X. OBJECT STORAGE

| Property | Report | Package |
|---|---|---|
| Key | `reports/<evidenceId>/v<N>.pdf` | `verification/<evidenceId>/v<N>.zip` |
| Deterministic vs versioned | **versioned** — the version is in the key | same |
| Overwrite possible? | **Yes at the same version** — a plain `PutObject`, no `If-None-Match`, no conditional write (`storage.ts` has no precondition parameter) | same |
| Object Lock mode | from `readObjectLockDefaults()` when `immutable: true` and Object Lock is enabled; mode + retain-until sent on the PUT | same |
| Legal hold header | **never sent** — deliberately inert (`// No ObjectLockLegalHoldStatus. See readObjectLockDefaults.`) | same |
| Retention re-asserted | `applyRetentionOrThrow` after the PUT, then `headObject` reads the applied lock into the row | same |
| Delete behaviour | no delete path is reachable from report/package generation | same |
| Regeneration | always a new `v<N+1>` key | same |

**Can old artifacts be silently replaced?** For a **different** version, no — the key differs.
For the **same** version, the only thing standing between two writers is the idempotency key on the
request row, and P2-9 shows a reachable pair it does not collapse. Object Lock preserves the previous
object *version*, but a `GET` on the key returns the newest one, so from the product's point of view
the artifact was replaced.

---

## Y. PUBLIC VERIFY

- **Independent of Report and Package.** The verify page reads
  `storageAndTimestamping.ots`, `otsStatus`, `otsHash`, `otsBitcoinTxid`, `otsAnchoredAtUtc`,
  `otsUpgradedAtUtc`, `otsFailureReason`, `otsProofPresent`, plus the TSA and signature blocks —
  all Evidence columns. No `Report` or `VerificationPackage` read gates the page.
- **Current integrity truth**, not a snapshot: the fields come from the live Evidence row.
- **TSA status, OTS status, latest evidence state** all surfaced, and separately.
- **Anti-enumeration:** a malformed or unknown verify token answers 404 byte-identically to a missing
  record (established closure; consistent with `getEvidenceWithReadAccess`'s 404-for-everything rule).
- **Expired / revoked access:** handled by the token layer, not by a commercial check.
- **Historical timing semantics:** capture, TSA and OTS times are rendered as three separate facts;
  `upgradedAtUtc` is distinct from `anchoredAtUtc`.
- **FREE specifically:** `publicVerifyIncluded: true` on FREE in the catalog, and
  `resolveEvidenceOutputEntitlements` returns `publicVerifyIncluded: true` for a credit-funded record
  regardless of plan. `evidence.routes.ts:4274` reads the record-aware value with the workspace
  capability as fallback. **FREE gets Public Verify.** ✅

---

## Z. REPORT CONTENT TRUTHFULNESS

| Field | Source | Fallback | Truthful? |
|---|---|---|---|
| TSA status/provider/serial/genTime/imprint | `Evidence.tsa*`, written once at finalize | none invented | ✅ |
| TSA token presence | `tsaTokenBase64Present` boolean | — | ✅ |
| OTS status | `canonicalMaterials.otsState.effectiveStatus ?? otsStatus`, passed through `resolveOtsPresentationEvidence` | degrades `ANCHORED`-without-`anchoredAtUtc` → `PENDING` | ✅ |
| OTS public label | `mapPublicAnchoringLabelFromOts` — requires a valid 64-hex txid **or** an anchor time before saying "verified" | falls back to `mapAnchorModePublicLabel` → "Anchoring not recorded" | ✅ |
| "OTS Anchored At (UTC)" | `evidence.otsAnchoredAtUtc` verbatim | null renders as absent | ✅ — a backfilled anchor shows its real (recent) time |
| Signature / hash / signing key | Evidence columns; the job throws `SIGNED_EVIDENCE_CRYPTO_STATE_INCOMPLETE` rather than render a partial set | — | ✅ |
| Custody | full chain with `prevEventHash`/`eventHash` preserved; payloads passed through a presentation normalizer that does not alter the hashed bytes | — | ✅ |
| Public Verify link | `buildVerifyUrl(evidence.id)` | — | ✅ |
| Report version | `prepared.version` | — | ✅ |
| Verification Package Version row | `evidence.verificationPackageVersion`, suppressed in external mode | null renders as absent | ⚠️ can be stale relative to the report row's own pointer — see P2-8 |

**"Can the report state *anchored* when the source is only pending?"** No. Two independent guards
(`resolveOtsPresentationEvidence` and `mapPublicAnchoringLabelFromOts`) both require anchoring
material. `custody-model.ts:139` records an OTS failure explicitly rather than omitting it.

**No misleading prose found.**

---

## AA. PACKAGE CONTENT TRUTHFULNESS

Emitted entries (`verification-package.ts`):

- `proovra-report.pdf` — **the exact report PDF built in this run** (`finalized.finalizedReportPdf`,
  not a re-render), named `proovra-verification-report-v<N>.pdf` in the report bundle
- `fingerprint.json` (the canonical JSON that was signed and stamped)
- `signature.txt` (`Evidence.signatureBase64`)
- `timestamp.tsr` — the raw RFC-3161 token, **emitted only when `tsaTokenBase64` is present**
- `opentimestamps-proof.ots` — **only when the proof bytes decode**; never fabricated
- `opentimestamps.json` — the companion state file, emitted whenever any OTS state exists, and
  **`ANCHORED` without a valid txid degrades to `PENDING` in the companion**
- custody / forensic-custody exports, audit export, access export, intelligence and
  technical-metadata manifests, `README.txt`, `package-checksums.json` (SHA-256 of every packaged
  file), `package-manifest.sig` (Ed25519 over the manifest, schema `PROOVRA_SIGNED_PACKAGE_MANIFEST`)
- Every generated manifest is appended **before** `package-checksums.json` so its own SHA-256 is
  recorded in the index — a stated and enforced ordering contract

**DB metadata vs ZIP contents:** `Evidence.verificationPackageMetadata` records
`manifestPresent`, `signedManifestPresent`, `checksumIndexPresent`, `auditExportIncluded`,
`custodyExportIncluded`, `accessExportIncluded` from the **actual** artifact-presence result of this
build, and `EvidenceArtifactStatus.manifestSignature` reports `SIGNED` only when a
`VerificationPackage` row exists. Consistent.

**One inconsistency:** `manifestSignature.signerKeyId` is read from `process.env.PACKAGE_SIGNING_KEY_ID`
on the **API** host rather than from the package row, so a key rotation would retroactively relabel
historical packages. **P3.**

---

## AB. GENERATE / RETRY / REGENERATE UX

`EvidenceArtifactsTab.tsx` — the copy table `OUTPUT_STATE_COPY` is `Record<EvidenceOutputState, …>`,
so a new state is a compile error, not a silent blank.

| State | Copy | Button | Disabled | API | Confirm | Refresh | Failure msg |
|---|---|---|---|---|---|---|---|
| `NOT_INCLUDED` | "A {noun} is not included for this evidence record." | none | — | — | — | — | — |
| `ELIGIBLE_NOT_GENERATED` | "No {noun} has been generated for this record yet. Generate one to download it." | **Generate report & verification package** | while busy | `POST .../reports/regenerate` | **no** | `reloadWorkspace()` | ⚠️ see below |
| `QUEUED` | "…queued for generation. Re-check shortly." | none | — | — | — | — | — |
| `GENERATING` | "…being generated. Re-check status once it completes." | none | — | — | — | — | — |
| `RETRYABLE_FAILURE` | "The last attempt to build the {noun} failed." | **Retry generation** | while busy | same | no | yes | ⚠️ |
| `TERMINAL_FAILURE` | class-specific prose (`terminalFailureCopy`) — COMMERCIAL / INTEGRITY / POLICY / TECHNICAL | **Generate** only for COMMERCIAL+eligible; otherwise none | — | same | no | yes | ⚠️ |
| `BLOCKED` | "{noun} generation is blocked by a policy decision." | **none** | — | — | — | — | — |
| `READY` | — | **Regenerate** only while `eligibility === "ELIGIBLE"` | while busy | same | **yes**, inline dialog | yes | ⚠️ |

**Strengths.** The verb comes from the server (`data-evidence-generate-verb={action}`), never from
the presence of a version. Only REGENERATE confirms, and its dialog states the three facts that
matter: new immutable version, previous versions retained, **"No evidence credit is charged."**
One button for both artifacts, correctly, because they are one job.

### ❌ P2-11 — THE FAILURE MESSAGE IS WRONG FOR FIVE OF SIX REASONS

`useEvidenceArtifactActions.ts:generateOutputs`:

```
if (res.enqueued)                      → "Generation requested…"
else if (res.reason === "not_included_in_plan") → "…not entitled…"
else                                   → "Generation is already under way for this record."
```

and the server's own `message` for `enqueued: false` is
*"An active report job already exists for this evidence. No new job enqueued."*

`enqueued: false` is returned for: `already_terminal` (including the permanent BLOCKED lockout of
P1-2), `queue_unavailable` (**Redis is down**), `request_persist_failed`, `evidence_not_found`,
`requester_required`, and a genuine collapse onto live work. **Five of those six are not "already
under way."** A customer whose record is permanently locked out, and a customer whose request was
lost to a Redis outage that nothing will reconcile, are both told the work is in progress.

### ❌ P2-5 — GENERATE ALWAYS SENDS `forceRegenerate: true`

There is one endpoint for all three verbs, and it hard-codes `forceRegenerate: true`. For a **first**
generation that has two consequences:

1. `resolveAndClaimReportRequest` runs its legal-hold branch (`if (request.forceRegenerate)`) and
   refuses with `BLOCKED_POLICY / legal_hold_active` — even though the branch's own comment says
   *"first generation is not [refused], because there is nothing yet to preserve."* The code has no
   artifact-existence test, so the comment describes an intent the implementation does not hold.
2. The refusal writes a terminal row at `REPORT:<id>:v0:force`, which is the exact key every future
   Generate click will compute. Combined with P1-2, releasing the hold does not restore the action.

**No dead buttons on Evidence Detail** otherwise — every rendered control maps to a state whose
server action exists. The dead buttons are on the Reports page (AC).

---

## AC. REPORTS PAGE

`reports-aggregator.service.ts` derives each row from the **same** shared state machine, then maps it
into the legacy five-value vocabulary (`ready | pending | failed | unavailable | not_requested`), and
**`ReportsIndex.tsx` re-derives the action verb from that vocabulary**. The envelope carries no
`action` and no `terminalReasonClass`.

| Canonical state | Reports lifecycle | Reports action offered | Detail action | Agreement |
|---|---|---|---|---|
| `READY` | `ready` | download | download / Regenerate | ✅ |
| `QUEUED` / `GENERATING` | `pending` | none | none | ✅ |
| `NOT_INCLUDED` | `unavailable` | none | none | ✅ |
| `ELIGIBLE_NOT_GENERATED` | `not_requested` | **GENERATE** | GENERATE | ✅ |
| `RETRYABLE_FAILURE` | `failed` | **RETRY** | RETRY | ✅ |
| `TERMINAL_FAILURE` (COMMERCIAL, eligible) | `failed` | **"Retry generation"** | **"Generate…"** | ⚠️ wrong label |
| `TERMINAL_FAILURE` (INTEGRITY / POLICY / TECHNICAL) | `failed` | **"Retry generation"** | **none** | ❌ **dead button** |
| `BLOCKED` | **`not_requested`** | **"Generate report & package"** | **none** | ❌ **dead button + contradiction** |

The aggregator's own docblock claims *"a row in the list and the same record's detail page cannot
disagree."* At HEAD they disagree in three of eight states, because the disagreement was introduced by
the **mapping**, not by the derivation. **P2-6.**

Both dead buttons post to `/reports/regenerate` and receive `already_terminal` → `enqueued:false` →
the "already under way" toast of P2-11.

Other Reports-page findings:
- Records are not omitted: the population is SIGNED/REPORTED in workspace scope, and `unavailable` is
  its own rendered state rather than a filter-out.
- **Historical versions are not findable here** — the row exposes `report.version` (latest) only.
- `FreeReportsLockedNotice.tsx` exists for the plan-excluded case. ✅

---

## AD. EVIDENCE DETAIL ARTIFACTS

- **Report/Package state** — from `outputs.report.state` / `outputs.verificationPackage.state`. ✅
- **Generate / Retry / Regenerate** — from `outputs.*.action`. ✅
- **Download** — enabled from `artifactStatus`, not from a non-empty history array (an explicitly
  documented correction). ✅
- **Version list** — `ArtifactHistorySection` lists every `v1, v2, …` with date, size and a "Latest" /
  "Immutable recorded" marker.
- **Storage disclosure** — `getStorageProtectionSummary` returns the applied Object Lock mode,
  retain-until and legal-hold status from the object itself, not from the row alone. ✅
- **Integrity is separate from artifacts** — `EvidenceIntegrityTab` owns TSA/OTS/signature;
  `EvidenceArtifactsTab` owns reports/packages/public verification counters. ✅
- **No plan-name frontend authority** — verified by grep; the two download prechecks were removed. ✅

### ❌ P2-10 — THE VERSION LIST PROMISES A DOWNLOAD THAT DOES NOT EXIST

The regenerate confirmation says: *"Previous versions are retained and **remain downloadable**."*
The history section lists every version. **There is no API route that serves a specific version.**
Grep for `report/:version`, `reports/:version`, `verification-package/:version`, `?version=` across
`services/api/src/routes` returns nothing; both endpoints are hard-coded to
`orderBy: {version: "desc"}`. The single download button always fetches the latest.

Retained: yes (the objects and rows exist, under Object Lock). Downloadable: **no, not through the
product.** The copy should say "retained", or the route should exist.

---

## AE. BILLING

`billing-account-projection.service.ts:1327-1367` → `historicalOutputEligibility`.

- **Asked only when `caps.reportsIncluded`** — on a plan that excludes reports the number would be
  every finalized record, and rendering it would be an upsell dressed as a status. ✅
- **A count, never a job.** No enqueue, no request row, nothing written. ✅
- **Scope is correct**: `teamId` when present, otherwise the owner's personal team plus legacy
  `teamId: null` rows.
- **Predicate**: `status: "SIGNED", reports: { none: {} }`.
- **Link**: `/reports` unfiltered, with an explicit note that a lifecycle deep-link would land the
  customer on a different population than the number they clicked. ✅
- **No "credits unlock old FREE records" claim** anywhere — `BillingOverview.tsx:680` states the
  opposite ("…the automatic backfill this program deliberately does not do").
- **Plan projection** is the server's; the browser computes no commercial verdict
  (`"eligible" is a commercial verdict and the browser must not compute one`).

**Accuracy caveat (P3):** the count includes records whose generation is currently `QUEUED`/`PROCESSING`
and records whose request is `BLOCKED`/`FAILED_TERMINAL`, so it can over-state what a click will
actually produce. It also excludes `REPORTED` records missing only a package.

---

## AF. OPERATIONS

### Condition classification

| Source id | Class | Correct? |
|---|---|---|
| `pipeline.report_backlog` | OPERATIONAL | ✅ — narrowed by `outputEntitledEvidenceWhere` so a non-entitled record is not a backlog |
| `pipeline.package_backlog` | OPERATIONAL | ✅ same narrowing |
| `pipeline.report_generation_failed` | OPERATIONAL | ✅ opened only for a non-retryable, **non-commercial** failure (`isPlanDenial` short-circuits before the DLQ/incident bridge) |
| `pipeline.package_generation_denied` | POLICY | ✅ classification; ❌ its remediation — see below |
| `evidence_integrity.ots_failure` | INTEGRITY | ✅ direct remediation `ots.resume_anchoring` |
| `evidence_integrity.ots_budget_exhausted` | INTEGRITY | ✅ CRITICAL, terminal, lifts to P1 in the inbox |
| `evidence_integrity.ots_pending_aged` | OPERATIONAL | ✅ WARNING at 24h, HIGH at 72h, **ceiling HIGH by design** (a pending public anchor does not make a record unprovable) |
| `evidence_integrity.tsa_failure` | INTEGRITY | ✅ `NO_SAFE_REMEDIATION_AUTHORITY` with a stated reason |
| commercial exclusion | **no condition at all** | ✅ correct — the request is refused before a row exists |

### Verdicts

- **Non-entitled FREE is not an incident.** ✅ Three independent guards: the API precheck, the worker
  producer precheck, and `outputEntitledEvidenceWhere` on the counters.
- **Technical report failure is an incident.** ✅
- **OTS failure is INTEGRITY/OPERATIONAL, with the two windows correctly separated.** ✅
- **OTS NULL never-attempted handling is intentional in `reconcile-ots-never-attempted.ts`** —
  but **not** in Operations: NULL is absent from the integrity scan, so the population is invisible.
  ❌ (this is the Operations face of N/O).
- **Backlog counters truthful** for the tenant surface. ⚠️ The **platform-admin** snapshot
  `operations/evidence-health.service.ts` counts `SIGNED && latestReportVersion IS NULL` and
  `REPORTED && verificationPackageVersion IS NULL` platform-wide with **no** commercial narrowing, so
  every FREE record inflates it. **P3** (operator metric, not a customer surface) — but it will
  mislead whoever reads it.
- **Auto-resolution truthful.** ✅ `decideObservationTransition` resolves only on
  `SOURCE_RECOVERED`, preserves `ACKNOWLEDGED`, and treats domain truth as outranking suppression.
- **Remediation validity:** `ots.resume_anchoring` ✅ (goes through the one request authority and
  translates `collapsed` / `queue_unavailable` / `failed` into distinct operator answers).

### ❌ P2-7 — `report.regenerate_artifacts` IS A NO-OP FOR THE PACKAGE CONDITION

`remediation-executor.ts:270` dispatches `requestReportGeneration({forceRegenerate: false})`.
`processor.ts:2957` opens with:

```
if (evidence.status === EvidenceStatus.REPORTED && !forceRegenerate) {
  const existingReport = …; if (existingReport) { log("Report already generated, skipping"); return; }
}
```

A `PACKAGE`-category incident, by construction, names a record that **has** a report and is
`REPORTED`. The job therefore returns before `prepareReportArtifacts`, the package is never built, the
request is marked `SUCCEEDED`, and the operator is shown `QUEUED` with
*"Regenerate report & verification package was requested by an operator and accepted."*
The condition never resolves, because `observeEvidenceArtifact` keeps reading
`verificationPackageVersion == null`.

The `forceRegenerate: false` choice is defended in the source as "this executor's gate authorizes
requesting generation, not overwriting a finalised artifact" — a sound principle that happens to make
the action inert for the one category it is registered against.

---

## AG. NOTIFICATIONS

- **Active attention vs immutable history** — separated by `OperationalIncident.status` +
  `OperationalIncidentEvent`; `decideObservationTransition` is the one authority for the transition.
- **Resolution** — `AUTO_RESOLVE_SOURCE_RECOVERY` fires only when the probe reports the domain fact
  recovered, and it overrides a suppression deliberately ("suppression governs NOTIFICATION, not what
  is true"). ✅
- **Duplicates** — prevented by the per-condition fingerprint
  (`OTS:<evidenceId>:GLOBAL_BUDGET_EXHAUSTED`, `evidence_integrity:<class>:<evidenceId>`,
  one workspace-level row for threshold conditions). ✅
- **OTS pending** — surfaces on notifications and operations, not on Home for the denied-package
  class (`surfaces` flags are explicit per source). ✅
- **OTS failed / budget exhausted** — `humanizeOtsFailureReason` maps the known codes to one
  operator sentence and truncates unknown free-form stderr at 240 chars; it never invents a failure
  mode. ✅
- **Report failure** — only real technical failures reach the inbox.
- **Package failure** — only the **governance-denied** class opens a condition. A package **build**
  failure opens nothing (see W). ❌ P2 (covered under W).
- **Commercial exclusion never looks like a system failure.** ✅ No incident, no notification, no
  backlog contribution; the customer sees `NOT_INCLUDED` with plain copy.

---

## AH. AUTHORIZATION MATRIX

Canonical roles from `packages/shared/src/permissions.ts`.

| Action | Gate | OWNER | ADMIN | REVIEWER | CONTRIBUTOR | VIEWER | External | Revoked | Cross-tenant |
|---|---|---|---|---|---|---|---|---|---|
| Generate / Retry / Regenerate | `getEvidenceWithRecordAccess(…, "evidence.generate_report")` | ✅ | ✅ | **✅** | ❌ | ❌ | ❌ | 404 | 404 |
| Download Report | read access + `requirePermission(role, "evidence.download_report")` + governance + export eligibility | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 404 | 404 |
| Download Package | same + `gateVerificationAction("PUBLISH_PACKAGE")` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 404 | 404 |
| View Report / Package status | `GET /v1/evidence/:id/artifacts/status`, read access | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 404 | 404 |
| Public Verify | token, unauthenticated | — | — | — | — | — | ✅ | — | — |
| Operations remediation | the **domain** permission (`evidence.generate_report` / `evidence.publish_verify`), never a generic `operations.retry` | ✅ | ✅ | ✅/depends | ❌ | ❌ | ❌ | — | incident scoped by `teamId` |

- **Membership must be `ACTIVE`** on every path (`getEvidenceWithReadAccess`, the two governance
  gates, `createEvidence`). A SUSPENDED/REVOKED row authorizes nothing.
- **Cross-tenant is 404, byte-identical to missing**, on both read and record-access helpers.
- **No frontend-only authority** — the UI decides only whether to *offer* a control.
- **`operations.retry` deliberately does not exist**, with a stated rationale.

**P3 — the regenerate route's docblock is wrong.** It claims *"OWNER, ADMIN and MEMBER hold it;
VIEWER and REVIEWER do not."* `ROLE_PERMISSIONS.REVIEWER` at `permissions.ts:429` **includes**
`evidence.generate_report`. The code is fine; the comment that was added to correct an earlier wrong
comment is itself wrong.

---

## AI. LEGAL HOLD / RETENTION

Proven contract, not assumed:

| Operation | Under an ACTIVE hold | Where |
|---|---|---|
| **Generate (first)** | **BLOCKED** in practice — the UI always sends `forceRegenerate: true`, and the claim path refuses `legal_hold_active` for any force request. The code's *intent* (comment) is to allow a first generation | `report-generation-authority.ts:239-253` + `evidence.routes.ts:10395` |
| **Regenerate** | **BLOCKED** — correct: regeneration replaces a finalised artifact, which is a mutation of preserved material | same |
| **Download Report** | **BLOCKED (403 `BLOCKED_BY_HOLD`)** — a direct hold **or a hold on any linked case** | `export-governance.service.ts:70-100` |
| **Download Package** | **BLOCKED** — same gate | same |
| **Delete / destroy** | blocked by the destruction-governance layer; `DESTROYED` / `PENDING_DESTRUCTION` also block export | `export-governance.service.ts:104-118` |
| **Retention** | untouched by holds. `S3_OBJECT_LOCK_LEGAL_HOLD` is deliberately inert and the header is never sent | `storage.ts:330` |
| **Artifact overwrite/deletion caused by a hold** | **impossible** — no hold path writes storage | verified by grep |

Hold eligibility itself is governed by the `FEATURE_LEGAL_HOLD` entitlement, not by the plan catalog's
`enterpriseFeatures.legalHold` — that flag was renamed `destructionGovernance` precisely to stop it
reading as a second hold authority.

**Legacy caveat (P3):** rows with `teamId = null` bypass the hold check entirely, because both
governance gates sit inside `if (evidenceForGate?.teamId)`.

---

## AJ. STORAGE / BILLING METERS

| Question | Answer | Source |
|---|---|---|
| Report storage metered? | Yes — `assertWorkspaceAllowsReportArtifact({incomingBytes})` → `assertWorkspaceStorageAvailable` | `workspace-billing.ts:477` |
| Package storage metered? | Yes — `assertWorkspaceAllowsVerificationPackageArtifact` | `:516` |
| Regeneration storage | counted (a new version is new bytes); the UI says so in the confirm dialog | — |
| OTS proof storage | a column on `Evidence`, not an object; not metered | — |
| **Report regeneration consumes an evidence credit?** | **No.** The only credit-consuming call site is `settleEvidenceCompletionFunding` in the completion transaction | grep on `consumeEvidenceCreditForCompletion` |
| **OTS consumes an evidence credit?** | **No.** `ensureEvidenceOtsInitialized` takes an evidence id and has no parameter through which a commercial input could be supplied | `ots-lifecycle.ts` |
| **Verification Package metered as ExchangePackage?** | **No.** Different model (`EvidenceExchangePackage`), different builder (`exchange-package-builder.ts`), different queue | verified |
| Duplicate meter? | none found | — |

The two artifact guards **also** re-assert the commercial entitlement (throwing
`REPORT_NOT_INCLUDED` / `VERIFICATION_PACKAGE_NOT_INCLUDED`) — both codes are in
`COMMERCIAL_TERMINAL_REASONS`, so a denial there remains supersedable after an upgrade. ✅

---

## AK. FAILURE INJECTION MATRIX

| Injected failure | Durable state | Retry | User sees | Operations | Converges? |
|---|---|---|---|---|---|
| **Redis unavailable at finalize (OTS)** | Evidence SIGNED, `otsStatus` NULL | **none** | "Not yet anchored" **forever** | **nothing** | ❌ **RELIABILITY GAP (Q1)** |
| **Redis unavailable at finalize (report)** | request row `QUEUED`, unscheduled | `lifecycle-recovery` after 15 min, **only** for a record with no report at all | `QUEUED` | none | ⚠️ partial — regenerations are not covered, and `reconcileStrandedReportRequests` never runs |
| **DB unavailable during finalize** | transaction rolls back; credit not spent | client retry | error | none | ✅ |
| **OTS calendar unavailable (init)** | `otsStatus` NULL, job **succeeds** | **none** | "Not yet anchored" forever | **nothing** | ❌ **RELIABILITY GAP (Q2)** |
| **OTS calendar unavailable (upgrade)** | `PENDING`, proof refreshed | +1h ladder, 30-day budget | "pending anchoring" | aged condition at 24h/72h | ✅ |
| **TSA unavailable** | `tsaStatus = FAILED`, token bytes preserved when available | **never** (by design) | "timestamp could not be obtained" | `tsa_failure`, `NO_SAFE_REMEDIATION_AUTHORITY` | ✅ terminal, honestly |
| **S3 upload fails (report)** | request `FAILED_RETRYABLE` (default-retriable) | BullMQ ×5 | `RETRYABLE_FAILURE` + Retry | incident on a non-retryable DLQ move | ✅ |
| **Package builder fails** | request **`SUCCEEDED`**, no package row | none | package `ELIGIBLE_NOT_GENERATED` + Generate | **no incident** | ⚠️ only by a human click |
| **PDF builder fails** | `FAILED_RETRYABLE` | ×5 | `RETRYABLE_FAILURE` | as above | ✅ |
| **Worker dies after storage upload** | orphan object at `v<N>`; no row | job retried, same key re-used | unchanged | none | ✅ (orphan remains) |
| **Worker dies after report tx, before package** | report v<N>, no package v<N>; request `PROCESSING` then lease-expired | redelivery hits the `REPORTED && !force` early return → **package never built** | package `ELIGIBLE_NOT_GENERATED` | none | ❌ human only |
| **Network timeout mid-run** | as above per phase | per phase | per phase | per phase | mostly ✅ |
| **Duplicate queue delivery** | `resolveAndClaimReportRequest` — terminal → `replay` no-op; live claim → `noop` | none needed | unchanged | `queue_replay_noop_total` / `queue_claim_lost_total` | ✅ |
| **Stale retry (expired lease)** | claim predicate accepts `PROCESSING` past `leaseFloor`; `markRequestTerminal` refuses to overwrite a terminal state | ✅ | unchanged | — | ✅ |
| **Downgrade during generation** | the worker re-reads entitlement at `processor.ts:2063` and at the storage guard | terminal commercial denial, supersedable | `NOT_INCLUDED` | none | ✅ |
| **Upgrade during generation** | the in-flight run proceeds; a queued commercial-denied row is superseded by the next request | ✅ | `QUEUED`/`GENERATING` wins over `NOT_INCLUDED` in the derivation | — | ✅ |

---

## AL. QUEUE DURABILITY

| Work | Queue | Producer | Job id | Attempts / backoff | Duplicates | Crash recovery | Stalled | DLQ | Reconciler |
|---|---|---|---|---|---|---|---|---|---|
| Evidence finalization follow-up (OTS) | `ots-upgrade` | `requestEvidenceOtsAnchoring` (API) — **the one API producer** | `ots-upgrade-<evidenceId>` | 20 / exp 60s | id is the dedupe | ❌ **none for a lost enqueue** | BullMQ default | none | **registry names `lifecycle-recovery.ts`, which has no OTS code** ❌ |
| OTS initialization | same job, no-proof arm | — | same | **never engaged** (no throw) | conditional `updateMany` | ❌ **none** | — | — | manual CLI only ❌ |
| OTS upgrade | same | `enqueueOtsUpgradeJob` (worker, with `selfJobId`) | same | 20 / exp 60s | id + `selfJobId` | ✅ ladder + 30-day budget | ✅ | ✅ | the ladder itself |
| Report / package generation | `report` | `requestReportGeneration` (API), `enqueueReportJob` (worker) | `report-<requestId>` | 5 / exp 1s | `ReportGenerationRequest.idempotencyKey` UNIQUE + deterministic job id | conditional claim + 15-min lease | ✅ | `reportDlqQueue` + `recordWorkerIncident` | `lifecycle-recovery` (partial); `reconcileStrandedReportRequests` **unscheduled** ❌ |
| Package remediation | none — rides the report queue | — | — | — | — | — | — | — | — |

### Commit → enqueue gaps

1. **Finalize → OTS enqueue.** Wide open. No outbox, no reconciler, no visibility. **P1-4.**
2. **Report request commit → enqueue.** Narrowed by `lifecycle-recovery` (15 min – 7 days,
   first-generation only, `reports: {none: {}}`). **Not covered:** a stranded *regeneration*, a
   record older than 7 days, and everything `reconcileStrandedReportRequests` was written to cover
   (expired leases, retry-budget retirement, unbounded re-enqueue). **P1-1.**

---

## AM. DUPLICATE AUTHORITIES

Searched the whole executable repo for parallel implementations.

| Concept | Implementations | Verdict |
|---|---|---|
| Effective plan | `resolveWorkspaceEffectivePlan` (pure) + two **adapters** (API `commercial-context`, worker `workspace-billing`) that both delegate the decision | ✅ ONE authority |
| Evidence admission | `resolvePersonalEvidenceAdmission` + `assertWorkspaceAllowsEvidenceCreation` | ✅ policy + enforcement |
| Credit settlement | `consumeEvidenceCreditForCompletion` — one function, one call site | ✅ |
| Output entitlement | `resolveEvidenceOutputEntitlements` — called by the API resolver, the worker gate, the worker storage guards, `lifecycle-recovery` and `enqueueReportJob` | ✅ ONE, five consumers |
| Report request writer | `createReportGenerationRequest` | ✅ ONE |
| Report producer | API `requestReportGeneration`, worker `enqueueReportJob` — **two producers**, both routed through the one writer, both carrying the commercial precheck | ✅ acceptable, deliberate |
| Report worker | `processor.ts:runReportGeneration` | ✅ ONE |
| OTS initialization | `ensureEvidenceOtsInitialized` | ✅ ONE |
| OTS upgrade | `processOtsUpgrade` | ✅ ONE |
| OTS column writer | `buildOtsEvidenceUpdateData` | ✅ ONE |
| OTS anchoring request | `requestEvidenceOtsAnchoring` (API) + `enqueueOtsUpgradeJob` (worker self-ladder + CLI) | ✅ one per host, by design |
| TSA repair | `repair-tsa-failed-with-token.ts` | ✅ ONE, offline |
| Artifact status | `buildEvidenceArtifactStatus` (detail) + `reports-aggregator` (list) — both call `deriveEvidenceOutputState` | ⚠️ ONE derivation, **TWO action derivations** — the aggregator omits `action` and the browser re-derives. **P2-6** |
| Operations resolution | `decideObservationTransition` | ✅ ONE |
| Notification active state | same | ✅ ONE |
| Download authorization | one route each; the client performs none | ✅ ONE |
| Terminal-reason classification | `isCommerciallyObsoleteTerminalReason` / `classifyTerminalReason`, shared by the writer, the worker and the projection | ✅ ONE |

**Unapproved parallel authorities: one — the Reports page's action derivation.**

---

## AN. DEAD / LEGACY CODE (proven zero-consumer only)

| Item | Status |
|---|---|
| `reconcileStrandedReportRequests` | **zero production consumers**; one test. Live, correct, unreachable. **P1-1** |
| Report-owned OTS creation | **fully removed** — the sixty-line write block, the stamp creation and `enqueueOtsUpgradeRetry` are gone from `processor.ts`, replaced by comments explaining why a disabled copy was not left behind |
| Old plan-only output gates (frontend) | removed from both download handlers |
| Old permanent `202 verification_package_pending` for a non-entitled record | replaced by `409 verification_package_not_included` |
| Personal-workspace `410` package path | retired |
| `PLAN_CAPABILITIES.PAYG` | **retained on purpose** as a grandfather resolution row; no writer assigns it. Correctly documented as never advertised |
| `20270830000000_evr_p10_tsa_retry_tracking` | empty restored marker; no SQL, no schema effect |
| "soft ceiling of 10 attempts / `stuck: true`" (OTS header comment) | **describes an implementation that no longer exists**. P3 stale comment |
| `otsInitializationNeedsUpgrade` docblock | claims `resolveEffectiveOtsStatus` degrades an ANCHORED-without-**txid** proof; it actually degrades on a missing **anchoredAtUtc**. P3 stale comment |
| `deprecated` queues | none found for this family |

---

## AO. TEST COVERAGE QUALITY

Mapped each invariant to a test. **Most of the commercial suite asserts SOURCE TEXT (reads a file and
regexes it) rather than runtime behaviour** — that is honest contract-pinning and is called out where
it matters.

| Invariant | Test | Class |
|---|---|---|
| PRO lifetime (100, no month reset) | `commercial-output-journeys.test.ts` SCENARIO 6; `billing-commercial-correctness.test.ts` | **COVERED** |
| Credit non-retroactivity | SCENARIO 3 + `free-integrity-vs-paid-output-boundary.test.ts` | **COVERED** |
| Free OTS (integrity is plan-blind) | SCENARIO 1 + `ots-integrity-lifecycle.integration.test.ts` | **COVERED** |
| OTS idempotency (no re-stamp) | `ots-integrity-lifecycle.integration.test.ts` OTS-6 | **COVERED** (integration) |
| **OTS finalize→enqueue durability** | — | **NOT COVERED** |
| **OTS init retry exhaustion / never-attempted recovery** | `reconcile-ots-never-attempted` script tests exist for the script; nothing tests that a stranded record is ever recovered | **NOT COVERED** |
| TSA no retry | SCENARIO 12; `commercial-output-lifecycle-closure.test.ts:487`; `free-integrity-vs-paid-output-boundary.test.ts:247,274`; `workspace-operations-readiness.test.ts:357` | **COVERED** (source-text, ×4 independent files) |
| Report append-only | `phase-12-point5-report-authority.integration.test.ts` | **COVERED** |
| Package append-only | `phase-32-6-1-package-state-machine.test.ts` | **PARTIALLY COVERED** — version divergence untested |
| Paid artifact after downgrade | SCENARIO 9 + 10 | **COVERED** |
| FAILED_TERMINAL commercial supersession | SCENARIO 5 | **COVERED** |
| **BLOCKED_STALE / BLOCKED_POLICY supersession** | — | **NOT COVERED** (and not implemented) |
| Public verify | `phase-2-public-verify-output-context.test.ts` | **COVERED** |
| Operations filtering (commercial narrowing) | `operations-source-lifecycle-contract.test.ts`, `attention-arch-closure-free-visibility.test.ts` | **COVERED** |
| Notification resolution | `operations-correlation-lifecycle.integration.test.ts` | **COVERED** |
| Authorization | `evidence-commercial-denial-contract.integration.test.ts` + the Phase-1 negative harness | **COVERED** |
| Cross-tenant denial | anti-enumeration probes (phase-37-95) | **COVERED** |
| Storage failure | — | **PARTIALLY COVERED** |
| **Report/package partial failure** | — | **NOT COVERED** |
| **Version collision under two concurrent requests** | `phase-12-point5-report-authority.integration.test.ts` covers the idempotency key, not the `provisionalVersion` race | **NOT COVERED** |
| **`reconcileStrandedReportRequests` is actually scheduled** | the test calls it directly, which is precisely why its absence from production went unnoticed | **NOT COVERED** |

---

## AP. UI / UX TRUTH AUDIT

Searched the artifact surfaces for `pending`, `not included`, `failed`, `retry`, `regenerate`,
`anchored`, `timestamp`, `verification`, `ready`.

| Copy | Where | Truthful? |
|---|---|---|
| "A report is not included for this evidence record." | FREE, detail | ✅ |
| "No report has been generated for this record yet. Generate one to download it." | after upgrade | ✅ |
| "…is queued for generation / is being generated." | QUEUED / GENERATING | ✅ |
| "The attempt ran while this record was not entitled… Your current plan includes it, so it can be generated now." | COMMERCIAL terminal after upgrade | ✅ excellent |
| "This record cannot produce a truthful artifact…" | INTEGRITY terminal | ✅ |
| "Report generation is blocked by a policy decision." | BLOCKED | ⚠️ true, but permanent with no path out (P1-2) |
| "Not yet anchored — OpenTimestamps anchoring has not started for this evidence item **yet**." | OTS NULL | ⚠️ **becomes false** in the stranded case (Q1/Q2) |
| "Previous versions are retained and **remain downloadable**." | regenerate confirm | ❌ **P2-10** — no route serves them |
| "No evidence credit is charged." | regenerate confirm | ✅ proven |
| "An active report job already exists for this evidence." / "Generation is already under way." | any `enqueued:false` | ❌ **P2-11** — wrong for five of six reasons |
| "Verification package is being generated. Poll …" (202) | eligible + no package | ⚠️ **P2-13** — also returned when generation terminally failed |
| "Verification packages are not included for this evidence record." | 409 | ✅ |
| "Retry generation" on a Reports row whose terminal class is INTEGRITY/TECHNICAL | Reports page | ❌ **P2-6** — dead button |
| "Generate report & package" on a BLOCKED Reports row | Reports page | ❌ **P2-6** — dead button, contradicts the detail page |
| Pricing "Every plan includes OpenTimestamps" | pricing | ✅ now true in code (subject to the reliability gap) |

---

## AQ. RESPONSIVE / MOBILE (source audit; no Playwright run)

Surfaces inspected: Evidence Detail artifacts tab, Reports index, Billing upgrade notice,
Operations, Public Verify.

**Reports index (`reports.css`, 301 lines).** Good structure: `overflow-wrap: anywhere` on the title,
a `@media (max-width: 640px)` block that stacks the three row actions full-width, an explicit fix for
the `GovernedExportAction` wrapper (`> * > .rpt-row__action`) so the governed download stretches too,
and a wrapping pagination rule.

### ❌ P2-12 — THE MOBILE WRAP FIX IS OVERRIDDEN BY SOURCE ORDER

```
line 259–261   @media (max-width: 640px) { .rpt-row__action { white-space: normal; } }
line 262       }                      ← media block closes
line 275–277   .rpt-row__action { white-space: nowrap; }
```

Both selectors have identical specificity (`0,0,1,0`); a media query adds none. The **later** rule
wins at every viewport, including ≤640px. The comment above the media rule states the intent exactly
— *"A full-width button no longer needs to refuse to wrap, and refusing at 320px is what would push a
long label past its own edge"* — and the intent is defeated.

Effect at 320–375px: "Download verification package" and "Regenerate report & verification package"
cannot wrap inside a 100%-width button, so the label overflows its own box. Whether that produces a
document-level horizontal scrollbar depends on the ancestor's overflow, which I did not run —
**UNPROVEN** at the pixel level, **proven** as a defeated rule.

Other observations (source-level, not pixel-verified):
- The regenerate confirm dialog is an `app-inner-surface` block with `app-page-header__actions`; no
  fixed widths. Likely fine.
- `ArtifactHistorySection` renders version metadata as inline `span`s in a `ul`; long report
  filenames are not rendered there (only `v<N>`, date, size), so filename overflow is not a risk on
  this surface.
- Public Verify and Operations use the shared `app-*` / `ops-*` primitives, which carry their own
  responsive rules; no hard-coded pixel widths were found in the artifact-related blocks.

---

## AR. P0 FINDINGS

**None.**

Explicitly checked and **not** present:
- tenant escape — every read path is `teamId`-bound or 404s (`getEvidenceWithReadAccess`,
  `resolveEvidenceRecordAccess`, `workspaceEvidenceWhere`, `workspaceIncidentWhere`, the remediation
  executor's `findFirst({id, teamId})`);
- cross-tenant download — 404, byte-identical to missing;
- custody corruption — the chain is append-only, hashes are preserved through the presentation
  normalizer, and every custody write is inside the transaction that justifies it;
- timestamp falsification — the TSA is contacted exactly once, from one call site, and never again;
  `tsaStatus` is written once inside the finalize claim;
- TSA retry changing an original-time claim — **no retry mechanism exists anywhere in the repository**;
- unauthorized regeneration — `forceRegenerate` is an authorization outcome persisted on a row, never
  a boolean on a queue message; a draining legacy job is minted as **non-force** so it cannot
  escalate its own privileges;
- artifact overwrite — the only reachable case (P2-9) requires a narrow race, produces
  substantively-equivalent bytes for the same record and version, and cannot cross records or tenants.

---

## AS. P1 FINDINGS

### P1-1 — The report-generation reconciler is never scheduled
`services/worker/src/report-generation-authority.ts:452` `reconcileStrandedReportRequests` has **zero
production callers** (repo-wide grep; the only reference is a test). Three guarantees the architecture
states in prose therefore do not hold at runtime:
- committed-but-unscheduled requests are recovered **only** by `lifecycle-recovery`, which covers
  first generations of records with **no report at all**, aged 15 min – 7 days;
- expired `PROCESSING` leases are never released (only the claim predicate can pick them up, and only
  if a job is redelivered);
- `REPORT_RECONCILE_MAX_ATTEMPTS` never retires an unfixable request to `FAILED_TERMINAL`, so the
  customer projection can never say "generation stopped" for that class.

`requestReportGeneration` tells its callers *"the row stays QUEUED; the worker's stranded-request
reconciler re-enqueues it."* For a regeneration, or a record older than 7 days, nothing does.

### P1-2 — A BLOCKED terminal permanently locks a record out of report generation
`createReportGenerationRequest` supersedes only `FAILED_TERMINAL` with a **commercial** reason.
`BLOCKED_STALE` (`policy_version_changed`) and `BLOCKED_POLICY` (`legal_hold_active`,
`organization_not_active`) are terminal and are **not** supersedable, so the idempotency key at that
baseline version is burned forever. Every later request — customer button, Reports page, Operations
remediation, recovery sweep — collapses onto the terminal row and returns `already_terminal`.
`outputActionFor("BLOCKED")` returns `NONE`, and the operator path maps the terminal to
`NOT_ELIGIBLE`. **No path in the product can give that record a report.**
Most reachable trigger: a workspace governance-policy edit between a request's creation and its
execution. Aggravated by P2-5 (Generate always forces, so a legal hold burns the `:v0:force` key on a
record with nothing to preserve).

### P1-3 — OTS initialization failure is unrecoverable and invisible (Critical Question 2)
A throw from `createOpenTimestamp` is caught in `ots-lifecycle.ts:172`, and the processor returns
**success**. The 20-attempt `TIMESTAMP_AUTHORITY` budget is never engaged, no follow-up is enqueued,
`otsStatus` stays NULL, and NULL is excluded from
`evidence-integrity-conditions.service.ts`'s scan — so no condition, no notification, no operator
action. One transient failure strands the record permanently while the UI says
"anchoring has not started **yet**".

### P1-4 — The commit→OTS-enqueue window has no recovery authority (Critical Question 1)
`requestEvidenceOtsAnchoring` never throws and its result is discarded; a Redis outage at finalize
leaves a durable, signed record with `otsStatus` NULL and **no durable record of the intent**. The
canonical work registry declares `reconciler: "services/worker/src/lifecycle-recovery.ts"` for
`UPGRADE_OTS`; that module contains **no OTS code at all**. The only real recovery is a manual CLI
that its own header says has never been run against Production.

---

## AT. P2 FINDINGS

- **P2-5 — Generate always sends `forceRegenerate: true`.** A first generation on a held record is
  refused as `legal_hold_active`, contradicting the claim path's own comment, and burns the key.
- **P2-6 — The Reports page is a second action authority.** The aggregator emits no `action`; the
  browser re-derives it from a lossy five-value vocabulary. Result: a dead "Retry generation" on
  INTEGRITY/POLICY/TECHNICAL terminals, a dead "Generate" on `BLOCKED` (where the detail page
  correctly offers nothing), and a "Retry" label where the canonical verb is "Generate".
- **P2-7 — The Operations PACKAGE remediation is inert.** `report.regenerate_artifacts` dispatches
  `forceRegenerate: false`; the report job's first guard returns immediately for a `REPORTED` record
  with an existing report — which is exactly the population a package condition names. The operator is
  told `QUEUED` and the incident never resolves.
- **P2-8 — `Report.verificationPackageVersion` is written before the package exists.** On a package
  failure the report row claims a package version that is not in the `verification_packages` table,
  and the artifact-status response carries both numbers.
- **P2-9 — Two concurrent requests can claim the same artifact version.** `provisionalVersion` and
  both storage keys are computed outside the advisory lock; a `:v0` and a `:v0:force` request for one
  record do not collapse. The DB unique constraint elects a winner, but the object at that key can
  hold the loser's bytes.
- **P2-10 — "Previous versions … remain downloadable" is false.** No versioned download route exists;
  both endpoints hard-code `orderBy: {version: "desc"}`.
- **P2-11 — "Generation is already under way" is returned for five wrong reasons**, including a Redis
  outage that nothing will reconcile and the permanent lockout of P1-2.
- **P2-12 — The Reports mobile wrap rule is dead.** `.rpt-row__action { white-space: nowrap }` at
  line 275 overrides the `white-space: normal` inside the ≤640px media block at line 259 (equal
  specificity, later wins).
- **P2-13 — `202 verification_package_pending` for a terminally-failed generation.** The package route
  checks eligibility and then finalization, but never the request state, so an eligible record whose
  generation terminally failed is told the package "is being generated".

---

## AU. P3 FINDINGS

- Platform-admin `operations/evidence-health.service.ts` counts signed-without-report and
  reported-without-package platform-wide with **no** commercial narrowing.
- The regenerate route's RBAC docblock says REVIEWER lacks `evidence.generate_report`; the permission
  table grants it.
- `otsInitializationNeedsUpgrade`'s comment attributes a txid-based degradation to
  `resolveEffectiveOtsStatus`, which degrades on a missing `anchoredAtUtc`.
- The OTS processor header still describes a "soft ceiling of 10 attempts / `stuck: true`" that has no
  implementation at HEAD.
- `historicalOutputEligibility` counts in-flight and blocked records as "eligible".
- The grandfather cap is frozen at downgrade and never recomputed downward if records are deleted.
- `observeOtsPendingAged` reads the evidence row by id without binding `ctx.evidenceWhere`, unlike its
  sibling `observeEvidenceArtifact` (harmless — the incident is already tenant-scoped — but
  inconsistent with the stated rule "a fingerprint is not an authorization").
- The two OTS producers use different default delays (API `enqueueCanonicalWork` → registry default;
  worker `enqueueOtsUpgradeJob` → 5 minutes).
- `manifestSignature.signerKeyId` is read from the API host's env rather than from the package row.
- `createEvidenceTimestamp` performs an external network call inside the finalize transaction while
  holding an advisory lock.
- Legacy `teamId = null` evidence bypasses the governance and export-eligibility gates on both
  download routes.
- `reconcile-ots-never-attempted.ts` is limit-bounded, not cursor-bounded.

---

## AV. WHAT IS ALREADY CORRECT AND MUST NOT BE REBUILT

1. **The three-axis output state machine** (`evidence-output-lifecycle.ts`). Pure, total, unpersisted,
   with the precedence order stated as the design. It is the correct model and every surface that
   consumes it directly is right.
2. **Record-bound funding.** `EvidenceCreditLedgerEntry` with a UNIQUE `evidence_id`, settled inside
   the completion transaction, read identically by both hosts. Non-retroactivity, retry-safety and
   downgrade-survival all fall out of the shape rather than out of rules.
3. **TSA single-shot.** One call site, no queue, no job, no route, no button, and an offline repair
   path that re-parses stored bytes. The `NO_SAFE_REMEDIATION_AUTHORITY` disposition with a written
   reason is exemplary. **Do not add a TSA retry for any reason.**
4. **OTS decoupled from the report job.** Integrity is plan-blind; the commercial question is asked
   once and decides only Report and Package. The deleted write block was deleted, not disabled.
5. **Download is not a commercial question.** Both routes, and both browser handlers, treat an
   existing artifact as the customer's property. This is the single most important customer-facing
   correction in the release.
6. **Commercial supersession by ordinal.** Derived from database state, not a clock; the old row is
   preserved as the audit record of a real refusal.
7. **The claim/lease/replay design** in `resolveAndClaimReportRequest` — conditional claim, lease
   floor in the predicate, terminal-write guarded by `state notIn TERMINAL`, tenancy re-derived from
   the evidence row.
8. **The two OTS windows** (30-day budget vs 24h/72h operations aging), and the written argument for
   why binding them was a defect.
9. **Object-Lock-versioned artifact keys** and the `applyRetentionOrThrow` → `headObject` read-back.
10. **The anti-enumeration 404** on every evidence access denial class.
11. **Billing's count-not-job** treatment of historical eligibility, and its refusal to deep-link into
    a filter vocabulary that cannot express the population.
12. **The commercial narrowing of the tenant Operations backlog probes**
    (`outputEntitledEvidenceWhere`), and the `isPlanDenial` short-circuit that keeps a commercial
    refusal out of the DLQ and the incident bridge.

---

## AW. CRITICAL QUESTION 1 — COMMIT → OTS ENQUEUE FAILURE

> *Evidence finalization commits successfully, but the OTS enqueue never becomes durable.
> What exact system repairs this automatically?*

## **NONE. RELIABILITY GAP.**

- `requestEvidenceOtsAnchoring` catches everything and returns `{requested:false, reason:"queue_unavailable"|"failed"}`.
- The return value is **discarded** at `evidence-complete.service.ts:1326`.
- **No durable outbox row is written.** The intent exists only as the absence of OTS columns.
- **No scheduled sweep looks for it.** `services/worker/src/index.ts` starts eighteen interval
  schedulers; none is an OTS reconciler.
- The canonical work registry's `reconciler: "services/worker/src/lifecycle-recovery.ts"` for
  `UPGRADE_OTS` is **false** — that module has no OTS code.
- **No operational condition is raised.** `otsStatus = NULL` is excluded from the integrity scan
  (`evidence-integrity-conditions.service.ts:349-357` selects only `FAILED` and the PENDING family),
  so `evidence_integrity.ots_failure` never opens and the working
  `ots.resume_anchoring` remediation is unreachable for this population.
- The only repair is a human running
  `node dist/scripts/reconcile-ots-never-attempted.js --apply`, whose header states it has never been
  run against Production.

**Missing authority:** a scheduled, bounded, idempotent sweep over
`Evidence(deletedAt: null, fingerprintCanonicalJson NOT NULL, otsStatus IS NULL, otsProofBase64 IS NULL, createdAt < now() - grace)`
that calls `requestEvidenceOtsAnchoring`, plus an aged-NULL operational condition distinct from
`ots_failure`.

---

## AX. CRITICAL QUESTION 2 — OTS RETRY EXHAUSTION

> *OTS initialization repeatedly throws, queue attempts exhaust, Evidence remains `otsStatus = NULL`.
> What exact system guarantees future retry or terminal visibility?*

## **NONE. RELIABILITY GAP — and the premise is more generous than the code.**

**Queue attempts never exhaust, because they are never consumed.**

1. `createOpenTimestamp` throws.
2. `ots-lifecycle.ts:172-186` catches it and returns `{initialized:false, reason:"not_finalized"}`,
   deliberately leaving the columns NULL so a calendar outage is not persisted as a per-record
   integrity failure. **That reasoning is correct.**
3. `ots-upgrade.processor.ts:222-247` sees `init.initialized === false`, enqueues no follow-up, logs
   `skipped_not_finalized`, and **returns normally**.
4. The BullMQ job **completes successfully on attempt 1**. `attempts: 20` is never engaged.

Therefore:

- **Periodic retry after job exhaustion?** There is no exhaustion, and no periodic retry.
- **Global reconciler?** None scheduled.
- **Does Operations detect it?** No — NULL is not scanned.
- **Terminal incident?** No. The 30-day `OTS_GLOBAL_BUDGET_EXHAUSTED` path lives in the PENDING arm
  and requires a stored proof, which this record never obtained.
- **Does NULL eventually get requeued?** Only by the manual CLI.
- **Can it read "Not yet anchored" forever?** **Yes** — verbatim, from
  `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:526`, whose own copy promises that anchoring
  "has not started for this evidence item **yet**".

**Missing authority:** the initialization failure must either consume an attempt (throw, so the 20×
exponential ladder engages) or explicitly re-enqueue with a delay; and the never-attempted population
needs the scheduled sweep and the aged-NULL condition described in AW.

---

## AY. EXISTING REPORT / PACKAGE DOWNLOAD ANSWER

> *If an Evidence already has a Report / Verification Package stored, can the user download it even if…*

| Condition | Report | Package | Exact source reason |
|---|---|---|---|
| **Current plan no longer includes reports** | **YES** | **YES** | Neither `GET /v1/evidence/:id/report/latest` nor `GET /v1/evidence/:id/verification-package` reads a plan, capability or entitlement on the artifact-exists path — the commercial branch in the package route is inside `if (!latest)`. The browser's `reportsIncluded` prechecks were removed from both handlers. `deriveEvidenceOutputState` returns `READY` before it ever consults eligibility. |
| **OTS is pending** | **YES** | **YES** | OTS is not an input to either route, to `deriveEvidenceOutputState`, or to the artifact-status projection's availability axis. |
| **OTS failed** | **YES** | **YES** | Same. `otsStatus = FAILED` affects only the integrity presentation and the Operations condition. |
| **TSA failed** | **YES** | **YES** | Same. No gate in either route, and `prepareReportArtifacts` has no TSA gate either. |
| **A newer version exists** | **YES — but only the newest** | **YES — but only the newest** | Both routes are hard-coded to `findFirst({orderBy:{version:"desc"}})`. There is no route that serves an older version, so an explicitly requested v1 is **NOT** downloadable (P2-10). |
| **The report generation request is terminal** | **YES** | **YES** | `deriveEvidenceOutputState` returns `READY` on `availability === "READY"` before it looks at axis 2, and neither route reads `ReportGenerationRequest` at all. |

**In every case the answer is subject to the non-commercial gates, which still apply and still deny:**
non-`ACTIVE` membership or a cross-tenant actor → **404**; an active legal hold on the record **or on
any linked case** → **403 `BLOCKED_BY_HOLD`**; lifecycle `ON_HOLD` / `RETENTION_LOCKED` /
`PENDING_DESTRUCTION` / `DESTROYED` → **403 `BLOCKED_BY_LIFECYCLE`**; a workspace governance policy or
workflow-template export policy that denies → **403**; a governance lookup failure → **503**
(fail-closed).

---

## AZ. FINAL SOURCE / ARCHITECTURE VERDICT

## **2. EVIDENCE OUTPUT + INTEGRITY ARCHITECTURE SOUND — TARGETED RELIABILITY CLOSURE REQUIRED**

The commercial model is correct and singular. Funding is bound to the record and cannot be
retroactively conferred by a wallet. The output state machine is a genuine three-axis separation, pure
and total, and the surfaces that consume it directly are truthful. Integrity has been cleanly
decoupled from commerce: TSA is single-shot with no retry path anywhere in the repository, and OTS now
enters the lifecycle for every finalized record on every plan. Downloading an artifact that already
exists is no longer a commercial question, on either the server or the client. Every P0 class was
checked and none is present.

What is not closed is **durability of the request-to-work handoff**, in two places:

- the OTS lifecycle has **no automatic entry-point recovery at all** (AW, AX), and the population it
  strands is invisible to Operations because `otsStatus = NULL` is excluded from the integrity scan;
- the report lifecycle's recovery sweep exists, is correct, and **is not scheduled** (P1-1), while a
  resolvable `BLOCKED` terminal permanently burns a record's idempotency key with no path out for
  either the customer or the operator (P1-2).

Neither is an architectural error. Both are wiring: one scheduler call, one predicate widened from
`FAILED_TERMINAL`-commercial to include the recoverable blocked reasons, one scan widened to include
NULL, and one initialization failure made to consume its retry budget. The shapes those fixes need
already exist in the codebase.

The four P1s are closable without redesigning anything in AV.

---

## RUNTIME VISUAL VERIFICATION STATUS

**NOT PERFORMED.** No browser session, no screenshots, no Playwright, no dev server. Every UI finding
above (AB, AC, AD, AP, AQ) is derived from reading component source, copy tables and CSS. The one
responsive finding (P2-12) is **proven as a defeated CSS rule** by source order and specificity; its
**pixel consequence** at 320–375px is **UNPROVEN**.

Runtime verification that would add value, in priority order:
1. Evidence Detail at 320 / 375 / 430 px with a long report filename and a `TERMINAL_FAILURE` state.
2. The Reports row action stack at 320 px, to measure the P2-12 overflow.
3. The Generate → toast path for a `BLOCKED` record, to see P1-2 and P2-11 together.

**Per the audit rules, the architecture verdict above is NOT downgraded for the absence of screenshots.**

---

## §47 NOTE — TESTS EXECUTED

**None.** No Clean-DB run, no API suite, no Worker suite, no Web suite, no Shared suite, no Point-7
browser proof, no Playwright. Every conclusion in this document is derived from reading the source at
`92f014fd`. Where source alone could not settle a question, the finding is labelled **UNPROVEN**
rather than resolved by a test run.

---

**EVIDENCE OUTPUT + INTEGRITY FINAL FORENSIC AUDIT COMPLETE — AUDIT ONLY, NO CHANGES MADE**
