# PROOVRA — FINAL COMMERCIAL + OUTPUT + VERIFY EXPERIENCE AUDIT

**Scope:** Reports · Verification Packages · Verify Page · all plans · all states · backend + frontend + UI/UX
**Mode:** AUDIT ONLY — no product code modified, no migration authored, no commit, no push, no deploy, no Production mutation.
**Date:** 2026-09-10
**HEAD:** `214315a527771aec8dbc84ea7ff4ddff34fbbda6`
**Method:** re-derived from current source at HEAD. Prior audit documents were deliberately not used as evidence.

---

## A. EXECUTIVE VERDICT

### VERDICT: **3 — MATERIAL OUTPUT/COMMERCIAL GAPS REMAIN**

The **core** of this system is genuinely closed and is, on the evidence, some of the strongest work in the repository. The three-axis output state machine (`packages/shared/src/evidence-output-lifecycle.ts`), the single entitlement authority (`resolveEvidenceOutputEntitlements`), the durable `ReportGenerationRequest` with a version-anchored idempotency key and a two-condition supersession rule, the worker's four refusals and atomic claim, the separation of *commercial eligibility to generate* from *ownership of an artifact already made*, the TSA no-retry invariant, the OTS recovery ladder, and per-record credit idempotency enforced by a unique index — all of these hold under adversarial reading and are proven by executable tests against real PostgreSQL.

Verdict 1 is nevertheless unreachable, and verdict 2 understates the problem, because the closure stopped at the **canonical surfaces** and did not reach three older ones that are still live on the primary customer journeys:

1. **`evidence-intelligence.service.ts` never received the commercial closure.** It computes `reviewerDecision`, `reviewerAlerts` and a `librarySummary` readiness score from `reportReady`/`packageReady` booleans with *zero* commercial input. On a FREE record this puts two WARNING risk signals ("Report not ready", "Verification package missing") and the guidance **"Generate the PDF report before external review"** on the *default* tab of Evidence Detail — one click away from the Artifacts tab, which correctly says *"Reports are not included for this record."* This is precisely the collapsed-boolean defect the 2026-09-08/09 closure removed everywhere else, still shipping on the most-visited record surface.

2. **The public Pricing page advertises entitlements that no purchase path can grant.** `buildPricingCatalogResponse` projects `PLAN_CAPABILITIES.PAYG` into the published `payg` object, in direct contradiction of that row's own instruction ("*Nothing may advertise these values*"). The Pricing comparison table therefore renders **5 GB storage** and **50 AI ops/month** for "Pay per evidence". A real evidence-credit buyer is on FREE by design: 250 MB, 10 AI ops/month, and **no storage add-on is purchasable on FREE**. That is not only a false advertisement, it is a functional dead end — a credit buyer who fills 250 MB has bought credits they cannot spend.

3. **A record that is not finalized, or whose integrity failed, is described as a commercial exclusion.** `deriveEvidenceOutputState` returns `NOT_INCLUDED` when `finalized === false`, and the Artifacts tab renders that state with plan copy. So a PRO customer looking at their own still-uploading record is told reports are not included in their plan, and — worse — a `FAILED_HASH_MISMATCH` record on ENTERPRISE is told the same thing. An integrity failure is attributed to a billing plan on a forensic surface.

Add one outright dead button (mobile "Download Report", always enabled, silently no-ops when no report exists) and a dead Generate path for legacy `team_id IS NULL` personal records, and the disqualifying criteria in §37 are met several times over.

**None of the findings is a forensic or security invariant violation.** TSA is never re-contacted; tenant containment holds; anti-enumeration holds; download authorization is never weakened by commercial state; legal hold is never weakened by commercial state. Verdict 4 does not apply.

**Counts:** P0 = 0 · P1 = 3 · P2 = 5 · P3 = 12.

---

## B. ARCHITECTURE AUTHORITIES

One authority per concern was found for every concern in the brief. Duplicates found are listed at the end of this section and in §AC.

| Concern | Authority | File · symbol | Inputs | Outputs | Consumers |
|---|---|---|---|---|---|
| Plan / commercial context | canonical | `packages/shared-billing/src/plan-catalog.ts` · `resolveWorkspaceEffectivePlan` (+ `resolveCommercialPlan` as the API entry point) | workspaceKind, billingPlan, billingStatus, ownerPlan | `{ plan, source }` | eligibility resolver, worker `resolveEffectivePlanForEvidence`, billing projection |
| Report / package eligibility (per record) | canonical | `packages/shared-billing/src/plan-catalog.ts` · `resolveEvidenceOutputEntitlements` | plan, funding | `{reportsIncluded, verificationPackageIncluded, publicVerifyIncluded}` | API `evidence-output-eligibility.service.ts`, worker `processor.ts`, `evidence-complete.service.ts` |
| Record-aware eligibility loader | canonical | `services/api/src/services/billing/evidence-output-eligibility.service.ts` · `resolveEvidenceOutputEligibility` / `…Many` | evidenceId, ownerUserId, teamId, [plan] | axis-1 vocabulary + booleans | artifact-status, reports aggregator, `/v1/reports`, generation authority |
| Output state (axes → one state) | canonical | `packages/shared/src/evidence-output-lifecycle.ts` · `deriveEvidenceOutputState` | 3 axes + `finalized` | `EvidenceOutputState` | artifact-status, aggregator, `/v1/reports`, package download route |
| Output action (the verb) | canonical | same file · `outputActionFor` | state, eligibility, terminalReasonClass | `GENERATE\|RETRY\|REGENERATE\|NONE` | Evidence Detail, Reports page, Copilot |
| Generation-request creation | canonical | `packages/shared-runtime/src/reports/report-generation-request.ts` · `createReportGenerationRequest` | evidenceId, purpose, artifactType, forceRegenerate, principal | durable row + `{deduplicated, superseded, terminalReasonCode}` | API authority, worker authority (only two callers) |
| Generation request (API producer) | canonical | `services/api/src/services/reports/report-generation-authority.service.ts` · `requestReportGeneration` | evidenceId, purpose, intent | `GenerationRequestOutcome` | regenerate route, completion fan-out, Operations remediation, TSA-repair script |
| Generation request (worker producer) | canonical | `services/worker/src/report-generation-authority.ts` · `requestReportGenerationFromWorker` | evidenceId, purpose, machineId | enqueued/reason | OTS upgrade, lifecycle recovery |
| Regeneration force flag | canonical | `evidence-output-lifecycle.ts` · `resolveForceRegenerate` (artifact availability only) | availability | boolean | API generation authority |
| Credit accounting | canonical | `services/api/src/services/billing/evidence-credits.service.ts` · `consumeEvidenceCreditForCompletion` | userId, evidenceId, tx client | consumed/alreadyConsumed | `billing-enforcement.service.ts` **only** |
| Version allocation | canonical | `services/worker/src/processor.ts` (`prepared.version`, allocated inside the finalize transaction against `Report`/`VerificationPackage` max version) | evidenceId | integer | report + package writes |
| Package generation | canonical | `services/worker/src/verification-package.ts` · `createVerificationPackage` (one caller) | assembled package data | ZIP buffer | `processor.ts` |
| Public verification | canonical | `services/api/src/routes/evidence.routes.ts` · `GET /public/verify/:id` | evidence id | public projection | `apps/web/app/verify/[token]/page.tsx` |
| Verify page truth | canonical | `packages/shared/src/trust-decision.ts` · `buildEvidenceTrustDecision` (snapshot preferred, live fallback) | evidence integrity fields + custody events | `TrustDecision` | verify route, report, package |
| Publication state | canonical | `services/api/src/services/governance/publication.service.ts` (`Evidence.publicVerifyState`, default `PUBLISHED`) | transition | state | verify route (404 unless `PUBLISHED`) |
| TSA state | canonical | `services/api/src/services/timestamp.service.ts` · `createEvidenceTimestamp`, called from **exactly one** place: `evidence-complete.service.ts:912` | fileSha256 digest | tsa* columns | none else |
| OTS state | canonical | `services/worker/src/ots-state.ts` (sole writer) via `ots-lifecycle.ts` via the `ots-upgrade` queue | job | ots* columns | reconcilers, verify, report |
| OTS request | canonical | `services/api/src/services/integrity/ots-anchoring-authority.service.ts` · `requestEvidenceOtsAnchoring` | evidenceId, trigger | requested/reason | completion fan-out, Operations remediation |
| Artifact download authorization | canonical | `enforceSensitiveAction("download_report"\|"download_package")` + `checkExportEligibility` — both applied identically on `/latest` and `/:version` | teamId, role, evidence | allow/deny | 4 download routes |
| Historical artifact authorization | canonical | **same two functions** — the version routes call the same gate helpers | — | — | `/v1/evidence/:id/reports/:version`, `/v1/evidence/:id/verification-packages/:version` |
| Legal hold / export governance | canonical | `services/api/src/services/governance-lifecycle/export-governance.service.ts` · `checkExportEligibility` | evidenceId, teamId, actor | outcome + reason | download routes, `GovernedExportAction` |
| Recovery / reconciliation | canonical | `services/worker/src/lifecycle-recovery.ts` (+ `reconcileStrandedReportRequests`, `ots-initialization-reconciler.ts`) | sweep | enqueues only | worker sweeps |
| Operations incident creation | canonical | `services/api/src/services/dashboard/incident-generator.service.ts` (narrowed by `outputEntitledEvidenceWhere`) | workspace scope | incidents | Operations |
| Operations remediation | canonical | `services/api/src/services/operations/remediation-registry.ts` + `remediation-executor.ts` | incident, action id | bounded `RemediationResult` | Operations |
| Notification creation | canonical | `packages/shared/src/notifications.ts` · `NOTIFICATION_EVENT_TYPES` (24 members) | — | — | delivery pipeline |

### Duplicates / second authorities found

| # | Concern | Second authority | Status |
|---|---|---|---|
| D1 | Reviewer readiness for a record | `services/api/src/services/evidence-intelligence.service.ts` · `buildEvidenceReviewDecision`, `buildReviewerAlerts`, `buildLibrarySummary` | **REAL DUPLICATE — P1-1.** Answers "does this record have its outputs" from artifact presence alone, with no commercial axis, and reaches the UI beside the canonical answer. |
| D2 | Commercial subject for a Reports row | `services/api/src/routes/reports.routes.ts:~330` resolves eligibility with `teamId: null, ownerUserId: caller` | **REAL DUPLICATE — P2-2.** The caller's personal plan, not the record's workspace. |
| D3 | Deliverable readiness on Cases | `apps/web/components/cases-experience/simple-case-detail/helpers.ts` · `summariseDeliverables` / `deriveNeedsAttention` | **REAL DUPLICATE — P2-4** (bounded: `casesIncluded ⊆ reportsIncluded` today). |
| D4 | Wire contract for `/v1/reports` | `apps/web/components/reports-experience/ReportsIndex.tsx` declares its own structural `UserReportRow` | P3 — cosmetic duplicate, currently honest. |

**Result: one authority per concern, with four named exceptions, one of which is a P1.**

---

## C. COMMERCIAL PLAN MATRIX (backend truth)

Derived from `PLAN_CAPABILITIES` + `resolveEvidenceOutputEntitlements` + `resolvePersonalEvidenceAdmission` + `resolveWorkspaceIntakeEntitlement`. **PAYG is not a sellable plan** — it is a grandfather-resolution row; the sellable artefact is `EVIDENCE_CREDIT_PRODUCT` layered over FREE.

| Dimension | FREE | Credit wallet (over FREE) | PRO | TEAM | ENTERPRISE |
|---|---|---|---|---|---|
| Evidence capture | yes | yes | yes | yes | yes |
| Record cap | 3 lifetime | unlimited while credits last | 100 lifetime | 500 / rolling 30d | contract (`resolveEffectiveContractEvidenceCap`) |
| Report included | **no** | **yes (per funded record)** | yes | yes | yes |
| Verification package included | **no** | **yes (per funded record)** | yes | yes | yes |
| Public verification included | **yes** | yes | yes | yes | yes |
| Historical download of an existing artifact | yes (governance-gated only) | yes | yes | yes | yes |
| Regeneration allowed | n/a (nothing to regenerate) | yes | yes | yes | yes |
| External review | no | no | yes | yes | yes |
| Generation consumes credit | n/a | **no** | no | no | no |
| First generation consumes credit | n/a | **no** — the credit is spent at *completion*, not at generation | no | no | no |
| Retry consumes credit | n/a | **no** | no | no | no |
| Regeneration consumes credit | n/a | **no** | no | no | no |
| Storage included | 250 MB | **250 MB** (unchanged by credits) | 100 GB | 500 GB | 500 GB + contract |
| Storage add-ons purchasable | **no** | **no** | yes | yes | contract |
| Intake | no | **yes** while balance ≥ 1 | yes | yes | yes |
| Cases | no | no | yes | yes | yes |
| AI ops / month | 10 | **10** (unchanged by credits) | 100 | 500 | custom |
| Workspace shape | SINGLE_OCCUPANT | SINGLE_OCCUPANT | SINGLE_OCCUPANT | SHARED | BOTH |
| Commercial subject | personal entitlement | personal entitlement | personal entitlement | workspace subscription | organization contract |

### Surface-by-surface comparison against that truth

| Surface | Agrees? | Note |
|---|---|---|
| Pricing page (`/pricing`) | **NO** | Renders `catalog.payg.storageLabel` = **5 GB** and `catalog.payg.aiAdvisoryMonthlyOperations` = **50 ops / month** from the grandfather row. Backend truth for a credit buyer is 250 MB / 10 ops. **P1-2.** |
| Billing page | yes | `historicalOutputEligibility` count + link; storage-addon unavailability explained; no CTA implies automatic backfill. |
| Evidence Detail → Artifacts | yes | Total switch over `EvidenceOutputState`; renders the server's action verb only. |
| Evidence Detail → Overview / Risk Signals | **NO** | Plan-blind "Report not ready", "Verification package missing", "Generate the PDF report before external review". **P1-1.** |
| Reports page | yes (workspace aggregator) / **NO** (user-scoped fallback) | Fallback resolves the caller's personal plan. **P2-2.** |
| Verify page | yes for gating; **partly no** for copy/score | See §I. |
| Home / Operations | yes | Backlog populations narrowed by `outputEntitledEvidenceWhere`; commercial denial no longer opens an incident. |
| Notifications | n/a | No output-lifecycle event type exists at all. **P3-11.** |
| AI Copilot | yes | Consumes `outputs.report.action` from `buildEvidenceArtifactStatus`; renders nothing when `NONE`; reads the typed outcome. |
| Cases | **partly no** | "Report missing" / needsAttention from artifact presence. **P2-4.** |
| Mobile | **NO** | Empty state promises reports on FREE; always-enabled Download button. **P2-3, P1-adjacent.** |

---

## D. FREE JOURNEYS

### Scenario F1 — FREE user creates Evidence

Traced through `evidence.service.ts::createEvidence` → `evidence-complete.service.ts`.

| Step | Behaviour | Evidence |
|---|---|---|
| Evidence persisted | **yes**, with a real `teamId` (personal Team row) | `evidence.service.ts:395` |
| Credit settlement | none — FREE lifetime allowance covers records 1–3; the 4th is refused `402 INSUFFICIENT_EVIDENCE_CREDITS` | `billing-enforcement.service.ts:757` |
| TSA attempted | **yes** — `createEvidenceTimestamp` runs before the commercial question is ever asked | `evidence-complete.service.ts:912` |
| OTS initiated | **yes** — `requestEvidenceOtsAnchoring`, explicitly plan-blind ("*Integrity is not sold*") | `evidence-complete.service.ts:1326` |
| Report request created | **no** — `final.shouldEnqueueReport` is `resolveEvidenceOutputEntitlements(...).reportsIncluded` = false | `evidence-complete.service.ts:1142,1331` |
| Report state | `NOT_INCLUDED` (eligibility NOT_INCLUDED, generation NOT_REQUESTED, availability NO_ARTIFACT) | `evidence-artifact-status.service.ts` |
| Package state | `NOT_INCLUDED` | same |
| Verify Page | **works** — `publicVerifyState` defaults to `PUBLISHED` and is plan-independent | `schema.prisma:165`, `evidence.routes.ts:12415` |
| Evidence Detail → Artifacts | "Reports are not included for this record… your evidence record itself is signed and preserved — the chain of custody is intact, and public verification still works" + **no action** | `EvidenceArtifactsTab.tsx:204` |
| Evidence Detail → Overview | **"Needs review"** + "Evidence report is not yet generated" + **"Generate the PDF report before external review"** — *contradicts the Artifacts tab* | `evidence-intelligence.service.ts:243` → `EvidenceOverviewTab.tsx:165` |
| Evidence Detail → Risk Signals | two WARNING signals: "Report not ready", "Verification package missing" | `evidence-intelligence.service.ts:498,505` → `_lib.tsx:697` |
| Reports page | row reads "Report not included for this record" / "Package not included for this record"; **no Generate button** (`action === NONE`) | `ReportsIndex.tsx:1071,1188` |
| Billing | no `historicalOutputEligibility` block (only computed `if (caps.reportsIncluded)`); upgrade CTA + credit purchase | `billing-account-projection.service.ts:1329` |
| Operations | **nothing** — `outputEntitledEvidenceWhere` removes FREE records from the report-backlog population; a commercial denial opens no incident | `evidence-output-eligibility.service.ts:324`, `processor.ts:4626` |
| Notifications | none | no such event type |

**Required answers**

1. **Can FREE Evidence exist without a Report?** Yes, permanently and by design. No request row is ever created.
2. **Without a Package?** Yes.
3. **Does Verify Page still work?** Yes — plan-independent, gated only on publication state, finalization, lifecycle and integrity.
4. **Is integrity visible without paid outputs?** Yes — hash, Ed25519 signature, RFC 3161 timestamp, OpenTimestamps, custody chain and storage protection all render on `/verify/:id` and on the Integrity tab.
5. **Is any "Generate" action incorrectly exposed?** On the canonical surfaces, **no** (`outputActionFor` returns `NONE`). On Evidence Detail **Overview**, **yes** — as prose guidance ("Generate the PDF report before external review"). **P1-1.**
6. **Is any Download button enabled without an artifact?** On web, **no** (`reportDownloadable = reportStatus.available === true`). On **mobile, yes** — `apps/mobile/app/(stack)/evidence/[id].tsx:112` renders an always-enabled "Download Report" whose handler is `if (reportUrl) …`, so it silently does nothing.

### Scenario F2 — FREE → PRO with historical Evidence

**Does existing Evidence become eligible automatically?** Yes, immediately: eligibility is computed per read from the *current* effective plan plus the record's funding. Nothing is stored, so nothing has to be backfilled.

**Does the plan change enqueue generation?** **No** — deliberately. `billing-account-projection.service.ts:1329` documents the decision: "*A COUNT, and deliberately not a job… the action stays theirs, one record at a time.*"

**Should it?** The decision is defensible and consistently implemented: an automatic backfill would spend storage and worker capacity on an unmade decision, and the customer is told the number and shown where to act.

**Where the user discovers it**

| Page | Section | Copy | Action |
|---|---|---|---|
| **Billing** | "Evidence" panel | "*N existing evidence records are now eligible for a report and verification package.*" | link **"Open Reports"** (`/reports`) |
| **Reports** | each row | status badge "Report not generated yet" | button **"Generate report & package"** (compact label) |
| **Evidence Detail → Artifacts** | lifecycle panel | "Your current plan includes a report and verification package for this record… records captured before this entitlement applied are not produced automatically. Generating uses no evidence credit; it does use workspace storage." | button **"Generate report & verification package"** |
| **AI Copilot** | Suggested actions | "This record is entitled to a report and does not have one yet." | confirm-then-execute |
| Home | — | nothing (correct — Home's pipeline counters are entitlement-narrowed) | — |

**The exact button:** `GENERATION_ACTION_LABEL.GENERATE` = **"Generate report & verification package"** (compact form on Reports rows).

**Click trace (verified end to end)**

```
button (data-evidence-action="generate-outputs", verb=GENERATE)
  -> POST /v1/evidence/:id/reports/regenerate  { intent: "GENERATE" }
  -> getEvidenceWithRecordAccess(userId, id, "evidence.generate_report")   [403 if not OWNER/ADMIN/REVIEWER]
  -> FAILED_HASH_MISMATCH -> 409 EVIDENCE_INTEGRITY_FAILED (no request row)
  -> requestReportGeneration({ purpose: "operator_regenerate", intent })
       -> resolveEvidenceOutputEligibility  (NOT_INCLUDED -> 202 outcome NOT_INCLUDED, nothing created)
       -> forceRegenerate DERIVED from Report existence   (false for a first generation)
       -> createReportGenerationRequest  (idempotency key REPORT:<id>:v0, supersedes a recoverable terminal)
       -> triggerEvidenceReported (automation, best effort)
       -> enqueueCanonicalWork(GENERATE_REPORT, commandId = requestId)
  -> 202 { enqueued, reason, outcome, message }
  -> worker processGenerateReport
       -> resolveAndClaimReportRequest  (replay / stale / scope / hold / org / atomic claim)
       -> runReportGeneration  -> Report row + VerificationPackage row + custody events
       -> markRequestTerminal(SUCCEEDED, resultReportId)
  -> browser polls artifacts/status; panel advances QUEUED -> GENERATING -> READY
```

**Intermediate states — no blank UI at any point.** `ArtifactLifecyclePanel` is a total `switch` over all eight members of `EvidenceOutputState`; a new state is a compile error, not an empty panel.

| State | Rendered |
|---|---|
| `ELIGIBLE_NOT_GENERATED` | "Your current plan includes a report and verification package for this record" + Generate |
| `QUEUED` | "Report and verification package are queued for generation" (`aria-live="polite"`) |
| `GENERATING` | "Generating report and verification package…" |
| taking longer | separate `stalePending` banner + "Re-check status" |
| `READY` | no alert (the version cards are the content) + Regenerate |

**Two ways F2 can still fail** — see P2-1 (legacy `team_id IS NULL` rows produce a dead Generate) and P2-2 (the `/v1/reports` fallback).

---

## E. FREE → TEAM / FREE → ENTERPRISE

| Question | FREE → TEAM | FREE → ENTERPRISE |
|---|---|---|
| Does historical Evidence become eligible? | Only records **in the workspace whose plan changed**. A TEAM subscription is bought for a SHARED workspace; records still in the buyer's Personal Space keep the personal plan. | Same, via the Organization contract. |
| Whose commercial context governs? | `resolveWorkspaceEffectivePlan`: `PERSONAL` → owner entitlement; `OWNED` → the workspace's own live TEAM subscription; `ORGANIZATION` → the parent Organization's ENTERPRISE coverage. | Same function. `OWNED` + a raw `ENTERPRISE` string **fails closed to FREE** (`LEGACY_AMBIGUOUS_FAIL_CLOSED`). |
| Personal vs Organization workspace | A TEAM-plan account keeps its Personal Space; `allowsPersonalWorkspacePurchase` answers only "may this plan be bought *for* a personal space". | Enterprise `billingShape: BOTH`. |
| Workspace transfer effects | Evidence carries its own `teamId`; moving a record moves its commercial subject. The worker refuses a request whose recorded `teamId` disagrees with the evidence row (`workspace_mismatch`, `BLOCKED_POLICY`). | Same. |
| Contract requirements | none | `Organization.status` must be `ACTIVE` — otherwise the worker writes `BLOCKED_POLICY / organization_not_active`, which is a **recoverable** blocked reason and is superseded once the suspension lifts. |
| Outputs automatic? | No. Same count-and-link journey. | No. |
| Ambiguous UI from a contract feature? | **One**: self-service workspace creation is refused as a platform rule, so a FREE user who "upgrades to TEAM" is upgrading their Personal Space tier, not acquiring a team workspace. The Billing copy handles this; no output surface is affected. | **No** — Enterprise-only flags (`legalHold`, `destructionGovernance`, …) are enforced by `assertEnterpriseFeature` and never gate report/package outputs. |

---

## F. PAYG / CREDIT JOURNEYS

PAYG exists **only** as a credit wallet over FREE (`EVIDENCE_CREDIT_PRODUCT`: 1 credit, €5, 1 credit per completion, no expiry).

### Scenario P1 — no subscription, credit available

| Step | Behaviour |
|---|---|
| Capture | allowed — `resolvePersonalEvidenceAdmission` admits on `availableEvidenceCredits >= 1` past the FREE lifetime cap |
| Finalization | credit consumed **inside the completion transaction** (`consumeEvidenceCreditForCompletion(params, client)`) |
| Idempotency key | **the row itself** — `evidence_credit_ledger_entries.evidence_id` is `UNIQUE` (migration `20271227000000`, line 99). A retried completion for the same record returns `alreadyConsumed: true`. |
| Atomicity | `entitlement.updateMany({ where: { credits: { gte: required } }, data: { decrement } })` — a conditional decrement at the database, so two concurrent transactions cannot both take the last credit |
| Double-click safety | proven twice: the conditional decrement, and the unique `evidence_id` which raises `P2002` and rolls back the decrement with it |
| Report + package generation | fully included for that record — `funding === "EVIDENCE_CREDIT"` short-circuits `resolveEvidenceOutputEntitlements` to all-true regardless of plan |
| Retry charging | **never** — no credit call exists anywhere on the generation path |
| Regeneration charging | **never** |
| Upgrade interaction | credits do not expire and are unaffected; a plan that includes reports simply makes funding irrelevant |
| Downgrade interaction | a credit-funded record keeps its outputs forever — the funding is a property of the *record* |
| Refund / reversal if generation fails | **none exists, and none is needed**: the credit paid for the *record's completion*, which succeeded. The report is a downstream deliverable that can be retried indefinitely at no charge. |

### Scenario P2 — no remaining credit

| Question | Answer |
|---|---|
| Can Evidence still be captured? | **No**, past the FREE allowance: `402 INSUFFICIENT_EVIDENCE_CREDITS`, `publicMessage: "You have used your included records and have no evidence credits left. Buy more to continue."` Records already created and finalized are untouched. |
| Can an in-flight record finalize? | Only if a credit is available at completion; otherwise the completion transaction raises the same `402` and rolls back. |
| Does TSA/OTS still proceed for already-finalized records? | Yes — unrelated to the wallet. |
| Is Verify Page available? | Yes for every finalized record. |
| Are outputs withheld? | For records funded by the FREE allowance, yes (never included). For credit-funded records, no — they keep everything. |
| What does the user see? | Billing "Evidence" panel: balance, credits-per-purchase, `offered.next` shortage sentence, **"Buy credits"**. |
| After buying, how does historical Evidence generate? | **It does not, and cannot.** A credit is forward-funding: it is spent at completion and there is no path that attaches one to a record already finished. The Pricing card copy was corrected for exactly this ("one **NEW** evidence item"). This is coherent — but note the FreeReportsLockedNotice component still carries the opposite implication (see P2-5). |

### The PAYG dead end — P1-2

A credit buyer stays on FREE for **storage** (250 MB) and **AI** (10 ops/month), and FREE cannot purchase storage add-ons (`billing-account-projection.service.ts` composes the "which tier unlocks this" sentence precisely because the server refuses). The published Pricing table meanwhile shows 5 GB and 50 ops/month for that column. A customer who buys credits to record a few large videos will be refused by `assertWorkspaceAllowsStorageGrowth` with no purchasable remedy and no honest prior warning.

---

## G. PRO JOURNEY

| Step | Behaviour |
|---|---|
| Capture → finalize | `assertWorkspaceAllowsEvidenceCreation` (100 lifetime), storage growth gate |
| TSA | attempted inside the finalize claim, once, never again |
| OTS | requested after commit, plan-blind, job id `ots-upgrade-<evidenceId>` is its own dedupe |
| Output eligibility | `reportsIncluded: true` |
| Generation trigger | **automatic** — `shouldEnqueueReport` is true, so the completion fan-out creates the request with `requestedByMachineId: "api.evidence-complete"` and enqueues it |
| Timing | immediately after the completion transaction commits, outside it |
| UI | Artifacts panel enters `QUEUED` → `GENERATING` → `READY`; page polls `GET /v1/evidence/:id/artifacts/status` (side-effect free, `artifact_status_polled_total`) |
| Recovery | request row committed before enqueue; a lost enqueue is re-enqueued by `reconcileStrandedReportRequests` (≤ 12 claims, then a truthful terminal); a dead worker's claim expires after `REPORT_CLAIM_LEASE_MS` and the claim predicate itself recovers it |
| Credit behaviour | none at any point |
| Regeneration | `READY` → action `REGENERATE` → confirmation dialog → new version; v1 stays downloadable |

---

## H. TEAM JOURNEY

Commercial authority: `resolveWorkspaceEffectivePlan` with `workspaceKind = OWNED|ORGANIZATION` and the workspace's **own** live TEAM subscription. The actor's personal plan never participates.

| Canonical role | Generate | Regenerate | Retry | Download report | Download package | Historical download | Public verify | Manage links |
|---|---|---|---|---|---|---|---|---|
| OWNER | yes | yes | yes | yes | yes | yes | yes | yes |
| ADMIN | yes | yes | yes | yes | yes | yes | yes | yes |
| REVIEWER | yes | yes | yes | yes | yes | yes | yes | yes (`evidence.publish_verify`) |
| CONTRIBUTOR | **no** | no | no | yes | yes | yes | yes | no |
| VIEWER | **no** | no | no | yes | yes | yes | yes | no |
| EXTERNAL_CONTRIBUTOR | no | no | no | **no** | **no** | no | yes (public page only) | no |
| PUBLIC_VERIFIER | no | no | no | no | no | no | yes | no |

Source: `packages/shared/src/permissions.ts` (`evidence.generate_report`, `evidence.download_report`, `evidence.download_package`). `EXTERNAL_CONTRIBUTOR` and `PUBLIC_VERIFIER` hold **empty** permission arrays; the external-review portal (`external-portal.routes.ts`, `portal-projection.service.ts`) exposes **no** report or package download path at all.

Membership must be `ACTIVE`: every download route reads `teamMember` and passes `role` only when `status === "ACTIVE"`, so a suspended or removed member falls through to the no-role branch of `enforceSensitiveAction`.

Seat/plan effects: `maxWorkspaceSeats` (TEAM = 10) bounds accepted seats; it has no effect on output rights. Team assignment (`caseLinks`) affects only case-scoped legal hold, which blocks **export**, not generation.

---

## I. ENTERPRISE JOURNEY

| Aspect | Behaviour |
|---|---|
| Contract authority | `Organization` row: `status` + the provisioned ENTERPRISE workspace billing. `resolveWorkspaceEffectivePlan` returns ENTERPRISE only when the org workspace's billing is live. |
| Report / package inclusion | both `true` |
| Legal hold | gated by the `FEATURE_LEGAL_HOLD` entitlement (not by `PLAN_CAPABILITIES.legalHold`, which now governs *destruction governance* only). An `ACTIVE` `EvidenceLegalHold` blocks **regeneration** (worker branch, only when `forceRegenerate`) and **export/download** (`checkExportEligibility → BLOCKED_BY_HOLD`). It does **not** block a first generation — the documented decision is "there is nothing yet to preserve". |
| Retention | `retentionUntilUtc` participates in `enforceSensitiveAction`; the retention sweeper reads `publicVerifyState`. |
| Reviewer access | canonical roles as §H; external reviewers get no artifact download. |
| Public verification | included; the `publicVerifyState` gate is the only control. |
| SSO/SCIM | irrelevant to outputs — no output path consults `ssoScim`. |
| Contract-based feature ambiguity | none found on the output surfaces. |

**Lifecycle matrix**

| Contract state | Effective plan | New generation | Existing artifact download | Verify page |
|---|---|---|---|---|
| ACTIVE | ENTERPRISE | yes | yes | yes |
| PENDING (billing not live) | FREE (fail closed) | refused `NOT_INCLUDED` before any row | **yes** | yes |
| SUSPENDED (`Organization.status ≠ ACTIVE`) | FREE | worker writes `BLOCKED_POLICY / organization_not_active` — **recoverable**, superseded when reactivated | **yes** | yes |
| TERMINATED | FREE | as above | **yes** | yes |
| Amended / downgraded | per new plan | per new plan | **yes** | yes |

The separation the brief asks for holds exactly: `deriveEvidenceOutputState` puts `READY` first, so **availability outranks eligibility** — an artifact that exists stays downloadable and only the *action* disappears. No download route consults a plan.

---

## J. VERIFY PAGE

### Chain

```
/verify/<uuid>  (Next.js client page)
  -> GET /public/verify/:id        (unauthenticated)
     rate limit 1: per resolved client IP (trustedClientIpKey)
     rate limit 2: per evidence id
     uuid parse failure                -> 404 "Evidence not found"   (byte-identical to missing)
     lifecycleState in TRASHED|DESTROYED -> excluded by the WHERE     -> 404
     publicVerifyState != PUBLISHED    -> 404 (audited denialReason)
     status = FAILED_HASH_MISMATCH     -> 404 (audited)
     lifecycleState = DESTROYED        -> 404 (audited)
     not finalized                     -> 409 EVIDENCE_NOT_FINALIZED
     missing crypto material           -> 404 "Evidence not signed"
     signing key row missing           -> 503 VERIFICATION_TEMPORARILY_UNAVAILABLE + operational.alert
  -> recompute canonical hash, verify Ed25519, evaluate custody chain,
     resolveEffectiveOtsStatus, getStorageProtectionSummary, getAnchorStatus
  -> trustDecision = report/package SNAPSHOT if present, else buildEvidenceTrustDecision LIVE
```

### What it shows, by state

| Case | Verify page |
|---|---|
| FREE evidence, no report | **Full integrity verification.** Hash, signature, TSA, OTS, custody, storage, identity all render. Package card shows badge **"Unavailable"**. Trust decision computed **live**. |
| PRO/TEAM/ENTERPRISE, READY | Same plus package version/date; trust decision comes from the artifact **snapshot** (`REPORT_SNAPSHOT` or `VERIFICATION_PACKAGE_SNAPSHOT`) |
| TSA success | `timestampDigestMatches` computed by comparing `tsaMessageImprint` against `tsaInputDigestHex ?? fileSha256` |
| TSA failure | status projected as-is; `timestampDigestMatches = null`; **does not** block `overallIntegrity` (only a *mismatch* does) |
| OTS pending | `effectiveOtsStatus` via `resolveEffectiveOtsStatus`; anchored-at suppressed unless truly `ANCHORED` |
| OTS anchored | calendar + txid + anchoredAt |
| OTS failed | `otsFailureReason` projected |
| Report absent | no report block; verification unaffected |
| Package absent | badge "Unavailable"; **but** the adjacent copy still says "*Package-level integrity can be checked independently from the downloaded verification package*" — P3-3 |
| Newer regeneration exists | "Anchoring has advanced since this package was generated. A newer report/package may be available." + `newerReportAvailable` |
| Old artifact version | the page always reflects the **latest**; historical versions are an authenticated surface |
| Legal hold active | **verify still works** — hold governs export, not publication |
| Evidence archived | works (archive is not a publication state) |
| Workspace closed | works — the route reads no workspace lifecycle |
| Membership removed | irrelevant — the route is unauthenticated |
| Link revoked / suspended | `publicVerifyState` `UNPUBLISHED` / `SUSPENDED` → 404, audited with the real reason |

### Critical questions

1. **Does Verify require a Report?** **No.**
2. **Does it require a Package?** **No.**
3. **Is public verification independent from paid outputs?** **Yes** — `publicVerifyIncluded: true` on every plan, and the route consults no commercial field. *With one qualification*: see P3-4.
4. **Can a downgraded customer keep existing Verify links?** **Yes** — nothing revokes on plan change.
5. **Can a revoked link still resolve?** **No** — `publicVerifyState !== "PUBLISHED"` is a 404 before any body is composed.
6. **Cross-tenant leak?** No. The route is intentionally public for `PUBLISHED` records; `teamId` is selected for the intelligence count and **never** projected.
7. **Sensitive internal fields hidden?** Yes. Storage bucket/key are read for the protection summary and not returned; emails are masked (`maskPublicEmail`); no signed URL is minted.
8. **Does it claim factual truth or legal admissibility?** **No.**
9. **Does it distinguish integrity from factual authenticity?** **Yes**, explicitly and repeatedly.

**P3-4 (qualification):** `buildVerificationPackageSignal` awards 5/5 when a package exists and **3/5** ("Technical materials available") when it does not. The package's existence is a *commercial* fact on FREE, so a FREE record scores 38/40 ≈ 95 where a paid one scores 40/40. `STRONGLY_VERIFIED` needs ≥ 90 and `VERIFIED` needs ≥ 78, so no headline verdict changes today — but a commercial input has reached a public integrity score, and the margin is 5 points.

---

## K. REPORT CONTENT CONTRACT (v2)

Sections actually generated (`services/worker/src/report-v2/sections/`): cover · executive-summary · forensic-integrity-statement · technical-summary · custody · custody-hash-chain · gallery · intelligence-summary · lifecycle-summary · certifications · legal-interpretation · technical-appendix.

| Field | Source of truth | DB field | Render path | Missing-data behaviour |
|---|---|---|---|---|
| Evidence metadata | Evidence row snapshot at generation | `title`, `type`, `mimeType`, `sizeBytes`, … | `build-view-model.ts` | omitted, never invented |
| Hashes | `fileSha256`, `multipartManifestSha256`, `hashSemantics` | same | technical-model | multipart note when semantics differ |
| Timestamps | `tsaGenTimeUtc`, `signedAtUtc`, `capturedAtUtc` | same | truth-model | "not reported" |
| TSA proof | `tsaStatus`, `tsaMessageImprint`, `tsaSerialNumber`, `tsaTokenBase64` | same | `truth-model.ts:175-194` | four honest labels: "Trusted timestamp recorded" / "not finalized" / "**could not be obtained**" / "not reported" |
| OTS status | `otsStatus`, `otsBitcoinTxid`, `otsCalendar` | same | truth-model, with the honesty rule applied | pending stated as pending |
| Chain of custody | `CustodyEvent` (forensic subset), hash-chained | — | `custody-model.ts`, `custody-hash-chain.ts` | chain break stated |
| Access activity | `CustodyEvent` (access subset) | — | separate section | separated from forensic by design |
| Decision grid | `buildEvidenceTrustDecision` snapshot | `trustDecisionSnapshot` | executive-summary | live fallback flagged in consistency source |
| QR / Verify URL | derived from evidence id | — | cover | — |
| Gallery | evidence parts | `EvidencePart` | gallery | omitted |
| Technical appendix | full crypto materials | — | technical-appendix | — |
| Reviewer notes | reviewer summary | `reviewerSummaryVersion` | technical-summary bridge | omitted |
| Warnings / missing proof | PDF signature status (`SIGNED` / `UNSIGNED_OPT_OUT` / `SIGNING_UNAVAILABLE` / `SIGNING_FAILED`) | `pdfSignatureStatus`, `pdfSigningWarning` | canonical shared copy | a legacy NULL renders as `SIGNING_UNAVAILABLE`, never as signed |

**Prohibited-claim scan: clean.** Every occurrence of "admissibility", "authentic" and "prove" in the report modules is a *disclaimer*: "*This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.*" No "court ready", no "verified" as an unqualified assertion, no "legally admissible".

**A report never claims a TSA it does not have.** A `FAILED` status renders "Trusted timestamp could not be obtained" — there is no branch that can print a positive timestamp claim from a failed row.

---

## L. VERIFICATION PACKAGE CONTRACT

Built by `services/worker/src/verification-package.ts::createVerificationPackage` (one caller), signed as a whole with the `verification_package` signer.

| Entry | Required | Omitted when | Source |
|---|---|---|---|
| `evidence-manifest.json` | yes | — | Evidence row |
| preserved original(s) | yes | package mode excludes them | S3 |
| `fingerprint.json` | yes | — | `fingerprintCanonicalJson` |
| `signature.txt` | yes | — | `signatureBase64` |
| `opentimestamps.json` | conditional | no OTS state exists | ots columns |
| `opentimestamps-proof.ots` | conditional | `otsProofBase64` null | same |
| `custody.json` / `forensic-custody.json` / `access-activity.json` | yes | — | `CustodyEvent`, split by classification |
| `anchor.json` | conditional | no anchor | anchor status |
| `package-manifest.json` + `.verify.txt` | yes | — | built |
| `package-mode.json` | yes | — | mode |
| `integrity-summary.json` | yes | — | computed |
| `trust-decision.json` | yes | — | snapshot |
| `canonical-record.json` | conditional | — | `proovra.canonical-record/v1` |
| `original-linkage.json`, `case-metadata.json`, `capture-context.json` | conditional | absent inputs | — |
| `audit-access-report.json`, `duplicate-digests.json`, `review-artifact-boundaries.json` | yes | — | — |
| `court-admissibility-checklist.json` | yes | — | `buildCourtReadinessChecklist` |
| `README.txt` | yes | — | verification instructions |
| `certifications/*.json` | conditional | none attested | `EvidenceCertification` |
| `reports/proovra-report-vN.pdf` | **optional in the builder** | `data.reportPdf` null | rendered PDF |
| `provenance/chain.json`, `custody/attestations.json` | conditional | — | — |
| `signers/signer-registry-snapshot.json`, `signers/historical-verification-material.json` | yes | — | signer registry (retired keys preserved) |
| `package-checksums.json` | yes | — | SHA-256 of every entry, written last |
| `MANIFEST.json.sig` | yes | — | Ed25519 over the manifest |

**Version binding — the critical invariant holds.** The package version is allocated in the same transaction as the report version and written to `Report.verificationPackageVersion`; the artifact's key carries `report_version` metadata; storage is written `immutable: true`. A package is never published at a version whose report was not committed — and if the package fails after the report commits, the *request* is thrown into `FAILED_RETRYABLE` rather than reported SUCCEEDED (see §M).

**Finding P3-1:** `buildCourtReadinessChecklist` hard-codes `reportArtifactIncluded: true`, `certificationTemplateIncluded: true`, `caseMetadataIncluded: true`, `originalLinkageIncluded: true` while its sibling `buildArtifactBoundaries` correctly takes `reportIncluded: Boolean(data.reportPdf)`. Today the single caller always supplies a PDF, so the claim is accidentally true; the field is nonetheless a *claim about the archive's own contents that does not read them*, inside a file named `court-admissibility-checklist.json`.

---

## M. GENERATION / RETRY / REGENERATION

| | GENERATE | RETRY | REGENERATE |
|---|---|---|---|
| Offered when | `ELIGIBLE_NOT_GENERATED`, or `TERMINAL_FAILURE` + eligible + terminal class `COMMERCIAL` | `RETRYABLE_FAILURE` | `READY` **and** still `ELIGIBLE` |
| Commercial requirement | eligible | eligible | eligible (a downgrade turns this into `NONE`) |
| Governance requirement | none blocking first generation | none | active legal hold **blocks** (`forceRegenerate` branch) |
| `forceRegenerate` | **false** — derived from artifact absence | false | **true** — derived from artifact presence |
| Idempotency key | `REPORT:<id>:v0` | same key (the failed row is reused/claimed) | `REPORT:<id>:vN:force` |
| Version behaviour | creates v1 | completes v1 | creates vN+1; v1..vN untouched |
| Credit | none | none | none |
| Confirmation | none | none | **yes** — inline confirm/cancel in `GenerateOutputsButton` |
| UI label | "Generate report & verification package" | "Retry report & verification package" | "Regenerate report & verification package" |
| API route | `POST /v1/evidence/:id/reports/regenerate` (one endpoint, three verbs, `intent` is audit-only) | same | same |
| Worker | claim → run | claim → run | claim → legal-hold check → run |

**Verified invariants**

- *First generation is not a force-regenerate.* `resolveForceRegenerate({ availability })` reads persistence, and the route no longer passes `forceRegenerate: true`. This closed the defect where a first Generate entered the regeneration-only legal-hold branch and burned `REPORT:<id>:v0:force` on a terminal row.
- *Retry does not create misleading history.* `markRequestRetryable` clears `claimedAtUtc`, writes no `completedAtUtc`, and reuses the same row.
- *Regenerate creates a new immutable version.* Version allocated in the finalize transaction; storage written `immutable: true` with Object Lock metadata.
- *Old versions remain downloadable.* `GET /v1/evidence/:id/reports/:version` and `…/verification-packages/:version` exist and call the **same** gate helpers as `/latest`.
- *TSA is never re-stamped.* See §P.

---

## N. FAILURE MATRIX

| Failure | Request row | User UI | Operations | Notification | Recovery | Terminal condition |
|---|---|---|---|---|---|---|
| Report render failure (retryable) | `FAILED_RETRYABLE` + bounded code | `RETRYABLE_FAILURE` — "Report generation failed… The evidence record and its integrity state are unaffected." + **Retry** | REPORT incident → "Regenerate report & verification package" | digest only | BullMQ retry + stranded sweep | 12 claims → truthful terminal |
| Report upload failure | as above (`isRetriableError`) | as above | as above | — | as above | as above |
| Report DB failure | as above | as above | as above | — | as above | as above |
| Package build failure (technical) | **`FAILED_RETRYABLE`** — the job *throws* `VERIFICATION_PACKAGE_INCOMPLETE_<phase>` so the request is not marked SUCCEEDED with half its output missing. The committed report stays downloadable. | report `READY`, package download disabled with reason | `recordPackageGenerationIncident` | — | BullMQ retry; completeness guard permits the re-run | reconciler retires the row |
| Package upload / DB failure | same | same | same | — | same | same |
| Package **governance** denial | request still succeeds | `BLOCKED` + `verificationPackageMetadata.{outcome,reason}` persisted; Reports row "Package blocked — <reason>" | INFO log, **no** Sentry, `package_generation_blocked_total` | — | resolves when governance resolves | — |
| Worker crash mid-generation | stays `PROCESSING` with a stale `claimedAtUtc` | `GENERATING`, then the stale banner | — | — | **claim predicate itself** accepts `PROCESSING` + expired lease | — |
| Queue unavailable at request time | `QUEUED`, durable | outcome `QUEUE_UNAVAILABLE` — "*We could not schedule generation right now. The request is saved and will be picked up automatically*" | — | — | `reconcileStrandedReportRequests` | ≤ 12 claims |
| Lost enqueue (commit-then-crash) | `QUEUED` | as above | — | — | same sweep | — |
| Lease expiry | reclaimed | — | — | — | atomic claim | — |
| OTS init throw | — | Integrity tab pending | `ots_initialization_stalled` → **READ_ONLY_GUIDANCE** (no button) | — | `ots-initialization-reconciler.ts` age-thresholded scan | — |
| OTS pending too long | — | "Bitcoin anchoring pending" | `ots_pending_aged` → READ_ONLY_GUIDANCE | — | upgrade ladder | — |
| OTS failed | — | failure reason shown | `ots_failure` → **DIRECT_REMEDIATION** "Resume OTS anchoring" | — | `requestEvidenceOtsAnchoring` | — |
| **TSA failed** | — | timestamp absent, stated plainly | `tsa_failure` → **NO_SAFE_REMEDIATION_AUTHORITY** with an explicit unsafe-reason paragraph | — | **none by design** | permanent, correctly |
| Signing key missing | `FAILED_TERMINAL` / `SIGNING_KEY_NOT_FOUND` → class **INTEGRITY** → action `NONE` | "Report generation stopped" | REPORT incident | — | operator | terminal |
| Storage unavailable | retryable | `RETRYABLE_FAILURE` | REPORT incident | — | retry | — |
| Commercial denial reached the worker | `FAILED_TERMINAL` / `REPORT_NOT_INCLUDED_IN_PLAN` → class **COMMERCIAL** → **supersedable** | `NOT_INCLUDED` | **nothing** — `job.discard()`, no incident, warn log only | — | supersession on upgrade | not permanent |

**No state silently strands.** Every branch either writes a terminal row, releases the claim, or is owned by a named reconciler.

---

## O. EXISTING-ARTIFACT DOWNLOAD MATRIX

The product's rule, and it is implemented rather than merely stated: **`deriveEvidenceOutputState` returns `READY` before it looks at eligibility**, and no download route reads a plan.

| Condition | Report download | Package download | Historical versions | Why |
|---|---|---|---|---|
| Plan downgraded | **YES** | **YES** | YES | availability outranks eligibility; only the action becomes `NONE` |
| Subscription cancelled | YES | YES | YES | same |
| Past due | YES | YES | YES | `PAST_DUE` is still live at the plan layer; the bounded grace clock gates *paid mutations*, not reads |
| OTS pending | YES | YES | YES | integrity state, not a download gate |
| OTS failed | YES | YES | YES | same |
| TSA failed | YES | YES | YES | same |
| Newer generation failed | YES | YES | YES | the committed artifact is untouched |
| Latest generation terminal | YES | YES | YES | same |
| **Legal hold active** | **NO** — 403 `BLOCKED_BY_HOLD` | **NO** | **NO** | export governance; custody event `EXPORT_BLOCKED_BY_POLICY` appended |
| Case-scoped legal hold | **NO** | **NO** | **NO** | `checkExportEligibility` consults linked cases |
| Lifecycle `ON_HOLD` / `PENDING_DESTRUCTION` / `DESTROYED` | **NO** | **NO** | **NO** | `BLOCKED_BY_LIFECYCLE` |
| Workspace archived | YES (if governance allows) | YES | YES | no archive gate on download |
| Member suspended (`status ≠ ACTIVE`) | **NO** | **NO** | **NO** | role not passed to `enforceSensitiveAction` |
| Removed member | **NO** (404 from read access) | NO | NO | tenant containment |
| External reviewer | **NO** | **NO** | **NO** | empty permission set; no portal route exists |
| Enterprise contract terminated | **YES** | **YES** | YES | commercial state does not revoke ownership |

**Commercial eligibility and download authorization are cleanly separated.** The four historical plan-only gates (`assertWorkspaceAllowsReport`, `…Package`, `…ReportStorage`, `…PackageStorage`) were *deleted* with a zero-consumer proof rather than left dormant — the right call, and the note explaining why is exemplary.

---

## P. HISTORICAL VERSIONS

| Element | Status |
|---|---|
| Version list endpoint | `GET /v1/evidence/:id/review-workspace` → `artifactVersions.history` (`listEvidenceArtifacts`) |
| Versioned report download | `GET /v1/evidence/:id/reports/:version` — `^[1-9][0-9]{0,6}$` |
| Versioned package download | `GET /v1/evidence/:id/verification-packages/:version` |
| Latest selection | `orderBy: { version: "desc" }` |
| UI history | `ArtifactHistorySection` with `onDownloadReportVersion` / `onDownloadVerificationPackageVersion` wired to those routes |
| Authorization | **identical to `/latest`** — the same gate functions are called, not re-implemented |
| Cross-tenant denial | 404 in the same shape as a missing record; a missing version answers 404 in the same shape as a missing record, so neither enumerates the other |
| Legal hold / export governance | applies equally — a held record's history is exactly as unreachable as its latest version |
| Downgrade | history stays downloadable; only Regenerate disappears |

**`v1` remains `v1`; `v2` never overwrites `v1`.** Versions are allocated monotonically inside the finalize transaction, each stored under its own Object-Locked key, and no code path writes an existing version's key. The client-side handler carries an explicit note: "*NO COMMERCIAL PRECHECK… an artifact that exists belongs to the customer who generated it*".

---

## Q. TSA — HARD FORENSIC INVARIANT

**Executable TSA call sites in the entire repository: one.**

```
services/api/src/services/timestamp.service.ts :: createEvidenceTimestamp
  called from exactly:
    services/api/src/services/evidence-complete.service.ts:912   (inside the finalize claim)
```

| Path | Calls TSA? | Evidence |
|---|---|---|
| Report generation (`processor.ts`) | **NO** | no import, no reference |
| Package generation | **NO** | no import |
| Retry | **NO** | same job |
| Regenerate | **NO** | same job |
| Operations remediation | **NO** | `remediation-registry.ts` gives `tsa_failure` the disposition `NO_SAFE_REMEDIATION_AUTHORITY` with an explicit paragraph explaining why |
| Copilot | **NO** | `SUGGESTABLE_ACTIONS` has four members, none TSA |
| Admin | **NO** | no admin TSA route exists |
| Queue registry | **NO** | there is no TSA work name |

**If TSA previously failed and the implementation is later fixed — what happens to old Evidence?**

Nothing automatic, and nothing *should* happen. A timestamp asserts that a digest existed at a moment. Re-contacting the authority now would mint a token whose `genTime` is later than the evidence it certifies; presenting that as the record's timestamp would assert something untrue. The record stays valid evidence with the timestamp layer honestly absent, and the report prints "Trusted timestamp could not be obtained".

**The one safe remediation, and it is already built:** `services/api/src/scripts/repair-tsa-failed-with-token.ts`. It applies **only** to records where the provider *did* return a token that the legacy parser mis-read (`tsaStatus = 'FAILED'` while `tsaTokenBase64` is populated). It re-parses the **stored** token, promotes the row to `STAMPED`, and requests a report regeneration so the artifact reflects the corrected column. Its own header states it never re-contacts the provider, and a guard test pins that sentence. This is the correct and only remediation shape.

**Guard quality:** the absence is protected by *source-text* assertions (`commercial-output-journeys.test.ts` SCENARIO 12/13). That is the right kind of proof for an absence, but it is a regex over `processor.ts` only — see §AF.

---

## R. OTS LIFECYCLE

```
finalize (post-commit, plan-blind)
  -> requestEvidenceOtsAnchoring({ trigger: "evidence.completed" })   [never throws]
       job id = ots-upgrade-<evidenceId>                              [the id IS the dedupe]
  -> ots-upgrade queue -> ots-lifecycle.ts -> ots-state.ts            [sole writer]
       PENDING -> ANCHORED | FAILED
  -> on ANCHORED: requestReportGenerationFromWorker(purpose: "ots_upgrade_completed",
                                                    forceRegenerate: true)
Recovery:
  ots-initialization-reconciler.ts   age-thresholded scan for otsStatus IS NULL after
                                     the handoff window; enqueues only, writes no column,
                                     asks nothing commercial
  lifecycle-recovery.ts              declares UPGRADE_OTS among RECOVERED_WORK_TYPES
  scripts/reconcile-ots-never-attempted.ts   operator-gated historical backfill (separate,
                                     deliberately requires a human decision)
```

| Question | Answer |
|---|---|
| Automatic retry? | Yes — the upgrade ladder plus the initialization reconciler. |
| Idempotent? | Yes — the deterministic job id collapses duplicates. |
| Does OTS pending block Report generation? | **No.** Report generation reads no OTS column as a precondition. The report simply records the OTS state as it stands, and the *anchored* completion triggers a regeneration so a later version carries the anchor. |
| Aged pending → Operations? | Yes — `ots_pending_aged`, READ_ONLY_GUIDANCE, no button, because none would help. |
| Lost initial enqueue? | Recovered by the initialization reconciler (this was the window it was built for). |

---

## S. OPERATIONS

| Condition | Visible | Severity | Copy | Remediation | Automatic recovery | Resolves when |
|---|---|---|---|---|---|---|
| TSA failure | yes | integrity | "*This record's timestamp could not be obtained when it was finalized, and that cannot be corrected after the fact…*" | **none offered** + explicit unsafe reason | no | never (correctly) |
| OTS failure | yes | integrity | — | "Resume OTS anchoring" | yes | source truth converges |
| OTS initialization stalled | yes | integrity | "*PROOVRA retries this automatically… no manual timestamp creation is required and none is offered*" | none | yes | anchor lands |
| OTS pending aged | yes | integrity | "*Bitcoin anchoring is inherently slow… this resolves on its own*" | none | yes | anchor lands |
| Report retryable failure | yes | REPORT | — | "Regenerate report & verification package" | BullMQ + sweep | report exists |
| Package incomplete | yes | PACKAGE | — | **the same action** (one pipeline, one button) | yes | package exists |
| Queue lost | no incident | — | — | the row's own reconciler | yes | enqueued |
| Lease expired | no incident | — | — | claim predicate | yes | claimed |
| Blocked generation | yes | REPORT | — | executor returns `NOT_ELIGIBLE`, not a false success | on blocker release | superseded |
| Terminal failure | yes | REPORT | — | `NOT_ELIGIBLE` (only `SUCCEEDED` maps to `ALREADY_SATISFIED`) | no | operator |
| **Commercial exclusion** | **no** | — | — | — | — | — |

**"No Operations card may advertise remediation that cannot affect the population it shows" — satisfied.** The three cases where no safe action exists (TSA failure, OTS stalled, OTS pending aged) are typed as `NO_SAFE_REMEDIATION_AUTHORITY` / `READ_ONLY_GUIDANCE` and render guidance rather than a button. The incident is never resolved by *enqueuing*; it resolves when the source domain's own truth converges.

One nit (P3-8): `remediation-executor.ts` maps `requested.deduplicated` to `ALREADY_IN_PROGRESS` before checking `superseded`, so the loser of a supersession race is told "already in progress" rather than "queued". Harmless; the row is live either way.

---

## T. NOTIFICATIONS

`NOTIFICATION_EVENT_TYPES` has 24 members. **None** of them concerns report or package generation, OTS, or TSA.

| Event | Notification today | Should it be one? |
|---|---|---|
| Report ready | none | Arguably not for a synchronous click (the page polls); **yes** for the async case — a user who clicks Generate and closes the tab learns nothing. |
| Package ready | none | no — same pipeline as the report |
| Output failure (terminal) | none directly; surfaces via Operations + `OPERATIONS_DIGEST` | Operations-only is defensible for a workspace-level view, but the *person who clicked* is not notified. |
| OTS issue | Operations only | correct — no user action exists |
| TSA failure | Operations only | correct — no user action exists |
| Generation blocked | Operations only | correct — the blocker's owner is the actor |
| Generation recovered | none | Operations-only is correct |
| Eligibility after upgrade | Billing count only | correct — a notification here would be an upsell |

**Spam / duplicate risk: none found.** There is nothing to duplicate. `deliverEmail` idempotency and `NotificationDelivery` as the attempt authority remain intact for the events that do exist.

**P3-11:** the async-failure gap. A customer whose generation terminally fails after they navigate away has no push signal; the record page and Operations are the only surfaces. This is a design gap, not a defect.

---

## U. BILLING UX

| Plan | What Billing communicates | Buttons |
|---|---|---|
| FREE | lifetime allowance used/included, credits available, credits-per-purchase, the shortage sentence, and *why storage add-ons are not offered plus which tier unlocks them* | **Buy credits**, plan offers |
| FREE + credits | balance + "one credit records one **new** evidence item" | **Buy credits** |
| PRO | included lifetime records, storage meter, `historicalOutputEligibility` count + **Open Reports** | plan offers, add-ons |
| TEAM | workspace billing authority (the workspace's own subscription), rolling-30-day allowance period stated explicitly, seats | plan offers, add-ons |
| ENTERPRISE | contract summary; no wallet, no admission block ("*allowance is a term of the agreement rather than a wallet plus a cap*") | contact |

**Does any CTA imply that upgrading automatically generated historical outputs?** **No.** The one sentence that touches it is a count and a link: "*N existing evidence records are now eligible for a report and verification package. Open Reports*". "Eligible for" is precisely correct and the link goes to the surface that carries the action.

Buttons audited: **Open Reports** (real route), **Buy credits** (real checkout), **Upgrade** (plan offers, server-decided), **View plan**, **Re-check purchases** (reconciliation). No dead CTA found on Billing.

---

## V. REPORTS PAGE UX

`ReportsIndex.tsx` renders `row.outputs.*.action` and computes nothing.

| Canonical state | Status text | Primary button | Disabled reason | Secondary | Download |
|---|---|---|---|---|---|
| `NOT_INCLUDED` | "Report not included for this record" / "Package not included for this record" | **none** (`action = NONE`) | — | Open evidence | — |
| `ELIGIBLE_NOT_GENERATED` | "Report not generated yet" | **Generate report & package** | — | Open evidence | — |
| `QUEUED` | "Report generating — refresh shortly" | none | — | Open evidence | — |
| `GENERATING` | "Report generating — refresh shortly" | none | — | Open evidence | — |
| `RETRYABLE_FAILURE` | "Report generation failed" | **Retry report & package** | — | Open evidence | — |
| `BLOCKED` (governance) | "Package blocked — <reason>" | none | reason inline | Open evidence | — |
| `TERMINAL_FAILURE` (COMMERCIAL, now eligible) | "Report generation failed" | **Generate report & package** | — | Open evidence | — |
| `TERMINAL_FAILURE` (INTEGRITY/TECHNICAL/POLICY) | "Report generation failed" | **none** | — | Open evidence | — |
| `READY` | — | **Regenerate report & package** | — | Open evidence | **Download report PDF** + **Download verification package**, both through `GovernedExportAction` |

**No dead button. No wrong verb. No duplicate authority** — the action verb, the status text and the download affordance all come from the server, and the compact label is a strict prefix of the canonical one rather than a second name.

The one caveat is the fallback path (P2-2), which can hand this page an eligibility resolved against the wrong commercial subject.

---

## W. EVIDENCE DETAIL UX

| Area | Behaviour |
|---|---|
| Header | share/lock/archive affordances carry truthful `title` reasons, including an explicit integrity-failed reason |
| **Overview** | **P1-1** — plan-blind "Recommended next actions" and readiness prose |
| Artifacts | total switch over the 8 states; no blank panel in any state; Generate/Retry/Regenerate strictly from `output.action`; regeneration behind a confirm/cancel step; history section with per-version downloads |
| Integrity | TSA failure explained without a retry action; OTS pending explained accurately; anchoring refresh offered while the anchor can still move and **not** gated on commercial artifacts |
| Review | reviewer alerts from `buildResolvedReviewerAlerts`, which correctly suppresses `NOT_INCLUDED`… **but** inherits the plan-blind base alerts from `evidenceIntelligence.reviewerAlerts` (**P1-1**) |
| Risk signals | rendered from those same alerts — two WARNING signals on every FREE record |
| Downloads | disabled unless `available === true`; disabled reason from `OUTPUT_STATE_COPY[state].reason(...)` or the governance blocked reason |
| Blocked reason | truthful; `BLOCKED` used to render *nothing at all* and now renders an explanation |
| Non-finalized / integrity-failed records | **P1-3** — rendered as `NOT_INCLUDED` with plan copy |

---

## X. AI COPILOT

Re-derived from current source.

| Check | Result |
|---|---|
| Consumes the canonical output action? | **Yes** — `ai-evidence.routes.ts` calls `buildEvidenceArtifactStatus` and reads `outputs.report.action`; when it is `NONE` no action is offered |
| `_count.reports` authority? | **Removed** from the action path (still used for a display-only `reportAvailable` on case/reviewer snapshots) |
| Plan-name authority? | none |
| TSA retry? | impossible — `SUGGESTABLE_ACTIONS` is a four-member allowlist and `CRITICAL_ACTIONS` throws |
| Governance bypass? | no — execution goes through `POST /v1/evidence/:id/reports/regenerate` with normal authz and audit |
| Fake queued success? | **fixed** — `readGenerationOutcome` parses the typed body; a 202 is no longer treated as proof |
| Human confirmation | mandatory (`confirmationRequired: true`, enforced in `buildSuggestedAction`) |

Outcomes surfaced: `ENQUEUED`, `SUPERSEDED`, `ALREADY_ACTIVE`, `QUEUE_UNAVAILABLE`, `NOT_INCLUDED`, `RECOVERABLE_BLOCKED`, `TERMINAL`, `REQUEST_PERSIST_FAILED`, `EVIDENCE_NOT_FOUND`, `REQUESTER_REQUIRED` — each with distinct bounded copy from `GENERATION_OUTCOME_MESSAGE`.

**P3-6:** the proposal carries `requiredPermission: "evidence.report.generate"`, which is **not** a member of the canonical `Permission` union (the real name is `evidence.generate_report`). Nothing consumes it today, so it is nomenclature drift on an audit field rather than a gate.

---

## Y. MOBILE / RESPONSIVE

**Method note:** this section is a static review of CSS and component source. I did **not** boot the API locally, because `services/api/.env` carries live Production credentials and any local API boot would reach Production — outside the audit's safety envelope. Breakpoint behaviour below is read from the stylesheets, not measured in a browser.

### Web breakpoints (320 / 360 / 375 / 390 / 430 / 768)

| Surface | Finding |
|---|---|
| Reports rows | `@media (max-width: 640px)`: actions stack full-width, including the `GovernedExportAction` wrapper's inner button (`.rpt-row__actions > * > .rpt-row__action`). `white-space: normal` at ≤ 640px and `nowrap` scoped to `min-width: 641px` — the two are now mutually exclusive rather than source-order dependent, which fixes a previously dead override. **No overflow expected at 320px.** |
| Reports pagination | `justify-content: space-between` at ≤ 640px; both controls truthfully disabled at the ends. |
| Evidence Artifacts | uses `app-*` primitives and `evidence-detail-*` grids with `repeat(auto-fit, minmax(...))`. |
| Verify page | wide technical tables are the highest-risk area and were not measured. |
| Billing output CTA | `bill-panel__note` is prose with an inline link — no fixed width. |
| Generation confirm | inline confirm/cancel in `app-page-header__actions` — wraps. |
| Historical versions | `ArtifactHistorySection` — not individually measured. |

**Residual risk:** unverified. A live 320px pass over Verify and the artifact history section should be run before claiming §25 closed.

### Native mobile app (`apps/mobile`) — **two real defects**

- **Dead button.** `apps/mobile/app/(stack)/evidence/[id].tsx:112` renders "Download Report" unconditionally and enabled; `onPress` is `if (reportUrl) void Linking.openURL(reportUrl)`. On any record with no report — every FREE record — pressing it does nothing, with no message. (**P2-3a**)
- **False promise.** `apps/mobile/app/(tabs)/reports.tsx:40` — empty state reads "*No reports yet. Capture evidence to generate signed reports.*" On FREE, capturing evidence never generates a report. (**P2-3b**)

The mobile app consumes none of the canonical output vocabulary: no `outputs.*.state`, no `action`, no eligibility.

---

## Z. AUTHORIZATION / TENANT CONTAINMENT

| Actor | Latest report | Versioned report | Latest package | Versioned package | Regenerate | Public verify |
|---|---|---|---|---|---|---|
| Wrong tenant | 404 (indistinguishable from missing) | 404 | 404 | 404 | 404 | public if `PUBLISHED` |
| Wrong workspace, same tenant | 404 | 404 | 404 | 404 | 404 | — |
| Removed member | 404 | 404 | 404 | 404 | 404 | — |
| Suspended member (`status ≠ ACTIVE`) | 403 governance | 403 | 403 | 403 | 403 | — |
| VIEWER | 200 | 200 | 200 | 200 | **403** | — |
| CONTRIBUTOR | 200 | 200 | 200 | 200 | **403** | — |
| External reviewer | no route | no route | no route | no route | no route | public page only |
| Public/unauthenticated | — | — | — | — | — | 200 / 404 / 409 / 429 / 503 |

**Opaque denial where required.** Malformed uuid → 404 (not a Zod 400). Cross-tenant → 404. Missing version → 404 in the same shape as a missing record. Publication-gated, integrity-failed and destroyed records → 404 with the real reason recorded only in the audit row. Rate limiting is two-bucket (resolved client IP **and** evidence id) so rotating IPs cannot enumerate one record's history.

**No enumeration leak found on any output or verify route.**

---

## AA. LEGAL HOLD / RETENTION / EXPORT

| Operation | Blocked by an active hold? | Authority |
|---|---|---|
| First generation | **NO** — "there is nothing yet to preserve" | worker branch runs only when `forceRegenerate` |
| Regeneration | **YES** — `BLOCKED_POLICY / legal_hold_active`, a **recoverable** terminal | `report-generation-authority.ts:239` |
| Report download | **YES** — 403 `BLOCKED_BY_HOLD` + `EXPORT_BLOCKED_BY_POLICY` custody event | `checkExportEligibility` |
| Package download | **YES** | same |
| Historical version download | **YES** | same gate |
| Export bundle | **YES** | same |
| Deletion / destruction | **YES** | `computeEvidenceLifecycleCapabilities` |
| Public verify | **NO** — publication is not export | by design |
| Billing eligibility count | **not excluded**, deliberately: "*A held record is commercially eligible; what it cannot do is leave the workspace*" | `billing-account-projection.service.ts` |

Case-scoped holds block export via `caseLinks`; they deliberately do **not** block generation, and `blockerStillActive` mirrors that scope exactly so the writer cannot mint a request the worker will immediately re-block.

**No commercial state weakens a legal hold anywhere.** The hold formula takes no commercial input; a FREE workspace's hold is exactly as binding as an Enterprise one.

Related and correct: `S3_OBJECT_LOCK_LEGAL_HOLD` remains deliberately inert and refuses at boot if enabled — do not re-wire `PutObjectLegalHold`.

---

## AB. CREDITS / IDEMPOTENCY

| Invariant | Proven by |
|---|---|
| One capture = at most one credit | `evidence_credit_ledger_entries.evidence_id` **UNIQUE** (migration `20271227000000` line 99) + the early `alreadyConsumed` read |
| Generate after upgrade does not charge historical capture again | no credit call exists on the generation path (`consumeEvidenceCreditForCompletion` has exactly one caller, in `billing-enforcement.service.ts`, reached only from completion settlement) |
| Retry does not charge | same |
| Regeneration does not charge | same |
| Concurrent clicks cannot double-charge | conditional decrement `credits: { gte: required }` in the WHERE **plus** the unique-index insert as a serialization point; a `P2002` rolls the decrement back with the transaction |
| Rolled-back completion rolls back the spend | the function requires the completion's transaction client and refuses to be called against the global one (documented; enforced by the parameter) |
| Purchase idempotency | partial unique index on `(provider, providerRef)` for `PURCHASE` entries |

**No credit-consuming call exists anywhere on the report, package, retry or regeneration paths.** Credits fund *records*, not *deliverables* — and the implementation matches that statement exactly.

---

## AC. DATABASE / SCHEMA TRUTH

| Table | Prisma | Migration | Worker expectation | API projection | Drift |
|---|---|---|---|---|---|
| `report_generation_requests` | `ReportGenerationRequest` | `20271113000000_point5_report_generation_authority` | claim/terminal writes match | projected narrower than persisted (deliberate) | none |
| `reports` | `Report` | present | version, storage, snapshot, pdf signature columns | matches | none |
| `verification_packages` | `VerificationPackage` | present | version, packageType | matches | **no `signerKeyId` column** — the API returns `signerKeyId: null` rather than guessing from `process.env`. Correct, deliberate, documented, deferred to a change that can migrate honestly. |
| `evidence` (TSA fields) | 11 `tsa*` columns | present | written once at finalize | projected on verify + report | none |
| `evidence` (OTS fields) | 8 `ots*` columns | present | `ots-state.ts` sole writer | projected | none |
| `evidence_credit_ledger_entries` | unique `evidenceId`, unique `grantRef` | `20271227000000`, `20280301000000` | worker reads via a thin adapter | matches | none |
| `entitlements` | `credits`, `plan`, `active` | present | conditional decrement | matches | none |
| `operational_incidents` | present + declared in preflight | present | — | — | none |
| `prisma/migrations-held/` | empty (README only) | — | — | — | nothing withheld |

**Model/physical drift: none found.**

**P3-9 (preflight gap):** `services/api/scripts/runtime-schema-requirements.mjs` declares 6 requirements, none of which covers `report_generation_requests` or `evidence_credit_ledger_entries`. Every *reader* degrades safely (`.catch(() => …)` / async IIFE), so a missing table would not crash — it would make every record read `NOT_REQUESTED` and every Generate click return `REQUEST_PERSIST_FAILED`, a silent product-wide output outage that `db:preflight` would report as healthy. These two tables are now load-bearing for the whole output experience and belong in that declaration.

---

## AD. DUPLICATE / LEGACY SWEEP

| Pattern | Matches | Classification |
|---|---|---|
| `forceRegenerate` | 6 in the shared writer, 17 in the API authority, 14 in the worker processor, 9 in the worker authority, 7 in evidence routes, 3 in `queue-integrity/legacy.ts` | **CANONICAL** + **LEGACY (decoder only)**. The legacy decoder exists to *strip* the flag from draining payloads; `mintRequestForLegacyJob` hard-codes `false`. Correct. |
| `_count.reports` | `ai-case.routes.ts:251`, `ai-reviewer.routes.ts:186`, `case-workspace.routes.ts:869`, `cases.routes.ts:1564`, `matter-workspace.service.ts:794` | **DISPLAY** (fed to `deriveCanonicalArtifactAvailability`, which is honestly axis-3-only) — but its *renderings* on Cases are **BUG** (P2-4) |
| `reportsIncluded` | catalog + eligibility resolver + pricing projection | CANONICAL, except the PAYG projection (**BUG**, P1-2) |
| `billingPlan` | `resolveWorkspaceEffectivePlan` inputs only | CANONICAL |
| "Generate report" | canonical labels in `generation-labels.ts` | CANONICAL |
| "Retry generation" | none outside the canonical label map | — |
| "Regenerate" | canonical | CANONICAL |
| Old report routes | none — the four current routes are the only ones | — |
| Old package routes | none | — |
| Legacy output enums | `ReportLifecycle` / `PackageLifecycle` (five-value) in the aggregator | **LEGACY, retained deliberately** for existing consumers; the canonical `outputs.*` block travels alongside and the mapping is one-way |
| Legacy report booleans | `report.available` / `pending` / `unavailable` on the artifact-status shape | **LEGACY, retained**, and now *derived from the state* rather than from absence |
| Manual recovery scripts | `repair-tsa-failed-with-token.ts`, `reconcile-ots-never-attempted.ts` | **CANONICAL, operator-gated**, both documented as never auto-run |
| `assertWorkspaceAllowsReport*` | **deleted** with a zero-consumer proof | correctly removed rather than left dormant |
| `FreeReportsLockedNotice` | zero consumers | **DEAD** (P2-5) |
| `PLAN_CAPABILITIES.PAYG` | grandfather row | **LEGACY** — but *advertised*, which the row forbids (P1-2) |

---

## AE. ORPHAN SWEEP

| Orphan | Kind | Severity |
|---|---|---|
| `apps/web/components/reports-experience/FreeReportsLockedNotice.tsx` | component with **zero consumers**, containing self-contradictory copy and a stale docblock | **P2-5** |
| `REPORT_ARTIFACT_TYPES` member `"EXCHANGE_PACKAGE"` | vocabulary member with **no producer** — no code ever creates a request with that `artifactType` | P3-5 |
| `requiredPermission: "evidence.report.generate"` | a permission string matching no canonical `Permission` | P3-6 |
| Output-lifecycle notification events | **no event types exist**, so nothing is orphaned — but the async-failure path has no user-facing clearing behaviour | P3-11 |
| `VerificationPackage.signerKeyId` | field the projection wants and the schema does not have; the API returns `null` honestly | documented, deliberate, not an orphan |
| Mobile "Download Report" | **button that always fails** when no report exists | **P2-3a** |
| Evidence Detail "Generate the PDF report before external review" | **prose action with no reachable control** on `NOT_INCLUDED` records | **P1-1** |

Every state in `EvidenceOutputState` has a renderer (total switch). Every canonical action has a reachable backend. Every reconciler named in the work registry is topology-checked in both directions. Every job has a producer.

**Unexplained orphans: zero. Explained orphans requiring closure: five.**

---

## AF. CONTRADICTION SWEEP

| # | Surface A says | Surface B says | Truth | Finding |
|---|---|---|---|---|
| 1 | Evidence Detail **Artifacts**: "Reports are not included for this record" | Evidence Detail **Overview**: "Needs review… Generate the PDF report before external review" | A | **P1-1** |
| 2 | Pricing: Pay-per-evidence includes **5 GB** storage, **50 AI ops/month** | Backend: a credit buyer is FREE — 250 MB, 10 ops, and no add-on purchasable | B | **P1-2** |
| 3 | Artifacts tab on a `CREATED`/`UPLOADING`/`UPLOADED` PRO record: "not included in your plan" | Billing: PRO includes reports | Billing | **P1-3** |
| 4 | Artifacts tab on a `FAILED_HASH_MISMATCH` ENTERPRISE record: "not included in your plan" | The record failed its integrity check | integrity | **P1-3** |
| 5 | Mobile: "Capture evidence to generate signed reports" | FREE never generates a report | backend | **P2-3b** |
| 6 | Mobile: enabled "Download Report" | No report exists | backend | **P2-3a** |
| 7 | Reports page (fallback): "Report not included for this record" on a TEAM-workspace record | Backend: TEAM includes reports | backend | **P2-2** |
| 8 | Reports page: "Generate report & package" on a legacy `team_id IS NULL` record | Request writer: `evidence_workspace_unresolved` → "This evidence record is not available." | writer | **P2-1** |
| 9 | Cases: "Report missing", counted into "needs attention" | The record may be `NOT_INCLUDED`, `QUEUED` or `GENERATING` | canonical state | **P2-4** |
| 10 | `FreeReportsLockedNotice`: "✓ Shareable verification link" unlocked by upgrading | The same card, twice: "public verification links remain available on the Free plan" / "Public verification of existing evidence stays free" | the latter | **P2-5** |
| 11 | `FreeReportsLockedNotice` docblock: "report download endpoints are still authorization-gated on the plan/entitlement" | The download routes read no plan, deliberately | the routes | **P2-5** |
| 12 | Verify page: package badge "Unavailable" | Adjacent copy: "*can be checked independently from the downloaded verification package*" | badge | **P3-3** |
| 13 | `court-admissibility-checklist.json`: `reportArtifactIncluded: true` | `data.reportPdf` is optional and unread by the checklist | the archive | **P3-1** |
| 14 | Verify trust score: package absence costs 2 points | Public verification is plan-independent | tension | **P3-4** |

**Contradictions NOT found (checked and clear):** Pricing vs backend for report/package/public-verify inclusion (machine-sourced from one catalog, with a drift test); UI Generate vs backend NONE on the canonical surfaces; UI downloadable vs a 404 route; UI "previous versions downloadable" vs a missing route (the routes now exist); report says TSA valid while the DB says failed; verify says authenticated while proof is missing.

---

## AG. TEST-QUALITY AUDIT

| Invariant | Strongest proof today | Adequate? |
|---|---|---|
| Three-axis derivation is total and correctly ordered | UNIT — real function execution over all state combinations | yes |
| Entitlement per plan × funding | UNIT — pure function executed | yes |
| Commercial supersession of a terminal | **INTEGRATION** vs PostgreSQL 16 (`report-generation-supersession-recovery.integration.test.ts`) | yes |
| Blocked supersession requires the blocker to be gone | **INTEGRATION** | yes |
| Supersession advances from the chain HEAD | **INTEGRATION** | yes |
| Stranded-request recovery | **INTEGRATION** | yes |
| Point-5 request authority (claim, replay, stale, scope) | **INTEGRATION** (`phase-12-point5-report-authority.integration.test.ts`) | yes |
| Credit idempotency | UNIT + **DB unique index** | yes |
| Partial package failure is not SUCCEEDED | CONTRACT (`partial-package-failure-contract.test.ts`) | adequate |
| Package state machine | CONTRACT (`phase-32-6-1-package-state-machine.test.ts`) | adequate |
| Copilot consumes the canonical action | CONTRACT (`copilot-output-action-contract.test.ts`) | adequate |
| Public verify consistency | CONTRACT (`public-verify-consistency.test.ts`) | adequate |
| FREE integrity vs paid output boundary | CONTRACT (`free-integrity-vs-paid-output-boundary.test.ts`) | adequate |
| Plan catalog vs pricing drift | CONTRACT (`commercial-plan-authority-drift.test.ts`) | **did not catch P1-2** — it checks catalog↔pricing agreement, not "is this row sellable" |
| **TSA has exactly one call site** | **SOURCE-TEXT** — a regex over `processor.ts` only | **HIGH-RISK.** The invariant is repo-wide; the guard is one file. A new TSA caller in `me-inbox.routes.ts`, an admin route or a script would pass. |
| **TSA repair never re-contacts the provider** | **SOURCE-TEXT** — asserts a comment string is present | **HIGH-RISK.** The guard proves a sentence exists, not that the code obeys it. |
| Report copy carries no prohibited claim | SOURCE-TEXT | acceptable (copy is source) |
| No dead download button | **none** | **GAP** — no test asserts a download control is disabled when `available === false`; mobile has none at all |
| Non-finalized records render truthfully | **none** | **GAP** — P1-3 exists because nothing asserts it |
| Overview/risk-signal copy agrees with the canonical state | **none** | **GAP** — P1-1 exists because nothing asserts cross-tab agreement |

**Recommendation:** the two TSA guards should become repo-wide AST/grep gates over `services/**` and `packages/**` with an explicit allowlist of one call site, rather than a regex over a single file. That is the single highest-value test change in this audit.

---

## AH. THE THIRTY REQUIRED ANSWERS

1. **FREE creates Evidence — what exactly happens?** The record is created with a real `teamId`, uploaded, hashed, fingerprinted, Ed25519-signed, RFC 3161 timestamped, custody-chained, and committed as `SIGNED`; OpenTimestamps anchoring is requested after the commit, plan-blind. **No report generation request is created.** The record's report and package states are `NOT_INCLUDED`.
2. **Does Verify Page work for FREE?** Yes, fully — hash, signature, TSA, OTS, custody, storage, identity and a live trust decision.
3. **Does FREE get a Report?** No, ever, until the workspace becomes entitled.
4. **Does FREE get a Package?** No.
5. **FREE upgrades to PRO — what exactly changes?** Eligibility is recomputed on every read, so every finalized record becomes `ELIGIBLE_NOT_GENERATED` immediately. Nothing is generated. Any earlier `FAILED_TERMINAL / REPORT_NOT_INCLUDED_IN_PLAN` row becomes *supersedable* so the Generate button works instead of dead-ending.
6. **Which page tells them historical Evidence is now eligible?** **Billing** — "N existing evidence records are now eligible for a report and verification package" with an **Open Reports** link. Also per-record on Evidence Detail → Artifacts, and per-row on Reports.
7. **Which exact button do they press?** **"Generate report & verification package"** (compact: "Generate report & package" on Reports rows).
8. **Does generation happen automatically?** No — deliberately, per record, by the customer.
9. **What appears while queued?** "Report and verification package are queued for generation. Work has been accepted and is waiting for a worker. This page checks for completion on its own."
10. **What appears while generating?** "Generating report and verification package… Both artifacts are produced by one job."
11. **What appears when ready?** No alert; the version cards appear with Download report PDF, Download verification package, and Regenerate.
12. **What if generation fails?** Retryable → "Report generation failed… The evidence record and its integrity state are unaffected." + **Retry**. Terminal → "Report generation stopped" + class-specific copy; an action only for a COMMERCIAL terminal on a now-eligible record.
13. **What if the Package alone fails?** The committed report stays downloadable, the **request is not marked SUCCEEDED** — the job throws `VERIFICATION_PACKAGE_INCOMPLETE_<phase>` (retryable), a PACKAGE incident opens, and BullMQ plus the completeness guard re-run it. A *governance* denial instead persists a bounded `{outcome, reason}` blob and renders "Package blocked — <reason>".
14. **What if the user downgrades after outputs exist?** Every artifact stays. `deriveEvidenceOutputState` returns `READY` before it consults eligibility, and `outputActionFor` returns `NONE` for `READY` when not eligible — so downloads persist and Regenerate disappears.
15. **Can the old Report still download?** **Yes.**
16. **Can the old Package still download?** **Yes.**
17. **Can v1 download after v2 exists?** **Yes** — `GET /v1/evidence/:id/reports/1`, behind the identical gate as `/latest`.
18. **Does Regenerate consume a credit?** **No.**
19. **Does Retry consume a credit?** **No.**
20. **Does TSA ever retry?** **No.** One executable call site, inside finalize, and no queue, job, route or button exists to re-run it.
21. **What happens to historical TSA failures after a software fix?** Nothing automatic. Where the provider genuinely returned a token that the legacy parser mis-read, the operator-gated `repair-tsa-failed-with-token.ts` re-parses the **stored** token and requests a report regeneration. Where no token exists, the failure is permanent and is stated plainly.
22. **Does OTS pending block Report generation?** **No.**
23. **What if the initial OTS enqueue is lost?** `ots-initialization-reconciler.ts` finds it on an age-thresholded scan and enqueues the same deterministic job id. It writes no OTS column and asks nothing commercial.
24. **What if the Report enqueue is lost?** The row is already committed `QUEUED`; the caller returns `QUEUE_UNAVAILABLE` with honest copy, and `reconcileStrandedReportRequests` re-enqueues it, bounded at 12 claims before a truthful terminal.
25. **What if the worker dies mid-generation?** The claim predicate accepts `PROCESSING` with an expired lease, so a replacement worker takes it. `markRequestTerminal` writes only over a non-terminal state, so the dead worker's late failure cannot overwrite the replacement's success.
26. **What if the Enterprise contract is suspended?** New generation is refused (`BLOCKED_POLICY / organization_not_active`, recoverable and superseded on reactivation). **Every existing artifact stays downloadable.** Verify pages keep working.
27. **What happens if legal hold is active?** First generation proceeds; regeneration is blocked (recoverable); **all downloads and exports are blocked** with a custody event; deletion and destruction are blocked; the public Verify page continues to work; the billing eligibility count still includes the record.
28. **Can viewer / member / admin / owner generate?** OWNER, ADMIN and REVIEWER: yes. CONTRIBUTOR and VIEWER: **no** (403) — they may download only. ("MEMBER" is a DB role, not a canonical one.)
29. **Can an external reviewer download?** **No.** `EXTERNAL_CONTRIBUTOR` and `PUBLIC_VERIFIER` hold empty permission sets and the external portal exposes no artifact route.
30. **What exactly does the public Verify Page expose?** Evidence id, title/filename, type, capture method, verification status, masked submitter identity, workspace/organization name snapshots, timestamps, canonical fingerprint + recomputed hash + signature verdict, the public key, TSA fields, OTS fields, storage protection summary, the forensic custody chain and access-activity summary, certifications, redaction badge, media-intelligence advisory, the trust decision, and package/report version metadata when present. It exposes **no** storage bucket or key, no signed URL, no `teamId`, no plan, no governance state, no raw email, and it makes no claim of factual truth or legal admissibility.

---

## AI. FINAL PLAN / JOURNEY MATRIX

| Plan | Workspace | Role | Evidence | Report | Package | Verify | Action | Download | Regen | Credit | Ops | Notif | Expected UX |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FREE | Personal | OWNER | SIGNED | NOT_INCLUDED | NOT_INCLUDED | ✅ | NONE | — | — | — | none | none | "Reports are not included for this record" + integrity intact **(today also shows a contradictory Overview — P1-1)** |
| FREE | Personal | OWNER | UPLOADING | NOT_INCLUDED | NOT_INCLUDED | ❌ 409 | NONE | — | — | — | none | none | correct by accident |
| FREE→PRO | Personal | OWNER | SIGNED | ELIGIBLE_NOT_GENERATED | ELIGIBLE_NOT_GENERATED | ✅ | **GENERATE** | — | — | none | none | none | Billing count → Reports → Generate |
| FREE→PRO | Personal | OWNER | SIGNED, legacy `teamId NULL` | ELIGIBLE_NOT_GENERATED | same | ✅ | GENERATE (**dead — P2-1**) | — | — | none | none | none | button returns "This evidence record is not available." |
| FREE→TEAM | Owned/Org | OWNER | SIGNED | ELIGIBLE_NOT_GENERATED | same | ✅ | GENERATE | — | — | none | none | none | workspace subscription governs |
| FREE→ENTERPRISE | Organization | ADMIN | SIGNED | ELIGIBLE_NOT_GENERATED | same | ✅ | GENERATE | — | — | none | none | none | org contract governs |
| PRO | Personal | OWNER | SIGNED→REPORTED | READY v1 | READY v1 | ✅ | REGENERATE | ✅ both | ✅ | none | none | none | automatic on completion |
| PRO | Personal | OWNER | REPORTED, pkg failed | READY | RETRYABLE via request | ✅ | RETRY | report ✅ | — | none | PACKAGE incident | digest | truthful split |
| PRO→FREE | Personal | OWNER | REPORTED | **READY** | **READY** | ✅ | **NONE** | ✅ both + v1..vN | ❌ | none | none | none | keeps what was paid for |
| TEAM | Owned | VIEWER | REPORTED | READY | READY | ✅ | NONE (403) | ✅ both | ❌ | none | view only | — | look, download, not act |
| TEAM | Owned | REVIEWER | REPORTED | READY | READY | ✅ | REGENERATE | ✅ | ✅ | none | act | — | full |
| TEAM | Owned | external reviewer | REPORTED | READY | READY | ✅ public only | none | ❌ | ❌ | none | ❌ | — | portal has no artifact route |
| TEAM→FREE | Owned | OWNER | REPORTED | READY | READY | ✅ | NONE | ✅ | ❌ | none | none | — | same as PRO→FREE |
| ENTERPRISE ACTIVE | Organization | ADMIN | REPORTED | READY | READY | ✅ | REGENERATE | ✅ | ✅ | none | full | digest | full |
| ENTERPRISE SUSPENDED | Organization | ADMIN | REPORTED | READY | READY | ✅ | NONE (`organization_not_active`, recoverable) | **✅** | ❌ | none | REPORT incident | digest | ownership survives suspension |
| ENTERPRISE + legal hold | Organization | ADMIN | REPORTED | READY | READY | ✅ | NONE for regen | **❌ 403 BLOCKED_BY_HOLD** | ❌ | none | — | — | hold beats everything |
| PAYG with credit | Personal | OWNER | SIGNED (credit-funded) | ELIGIBLE→READY | ELIGIBLE→READY | ✅ | GENERATE→REGENERATE | ✅ | ✅ | **1 at completion only** | none | none | record-level entitlement on a FREE account |
| PAYG without credit | Personal | OWNER | cannot finalize past the FREE allowance | n/a | n/a | ✅ for existing | — | ✅ existing | — | 402 at completion | none | none | "Buy more to continue"; **storage remains 250 MB — P1-2** |
| any | any | any | FAILED_HASH_MISMATCH | **NOT_INCLUDED (wrong — P1-3)** | same | ❌ 404 | NONE | ❌ | ❌ | — | integrity | — | should say "integrity failed", says "not in your plan" |

---

## AJ. FINDINGS

### P1

---

**P1-1 — The reviewer/readiness projection is a second output authority with no commercial input**

- **File / symbol:** `services/api/src/services/evidence-intelligence.service.ts` — `buildEvidenceReviewDecision` (line 225), `buildReviewerAlerts` (line 465), `buildLibrarySummary` (line 582); consumed at `services/api/src/routes/evidence.routes.ts:4891` (`baseAlerts`, filtered only for one unrelated label) and `:9335` (`reviewerDecision`); rendered at `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx:165` and `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:697`.
- **Root cause:** the 2026-09-08/09 closure replaced the collapsed `available/pending` boolean on the *artifact-status* projection and added a canonical alert block that suppresses `NOT_INCLUDED`. It did not touch `evidence-intelligence.service.ts`, which computes the same question from `reportReady`/`packageReady` and whose output is merged into the same alert array and the same page.
- **Affected plans:** FREE always; any plan for a record in `BLOCKED`, `QUEUED`, `GENERATING`, or terminal state; any downgraded workspace.
- **Journey:** every visit to Evidence Detail on a record without artifacts.
- **Backend impact:** none — no gate consults it.
- **Frontend impact:** the Overview tab renders "Recommended next actions" containing **"Generate the PDF report before external review"** and **"Confirm OpenTimestamps Bitcoin anchoring or generate a package for independent review"**; Risk Signals render two WARNING entries ("Report not ready", "Verification package missing"); the record is labelled **"Needs review"**.
- **UI/UX impact:** two tabs of one page state opposite things about the same record. The Overview recommends an operation whose canonical action is `NONE` and, for the package, an operation that **has no endpoint at all**.
- **Forensic impact:** the "Evidence readiness score" is degraded by a commercial decision, on a surface reviewers read as a readiness judgement.
- **Commercial impact:** an in-product upsell rendered as an operational deficiency, without an upgrade path attached.
- **Fix:** give `buildEvidenceIntelligence` the canonical `EvidenceOutputProjection` (it already exists on the same request — `artifactStatus` is built a few lines away) and suppress the report/package issue, alert, next-action and score contribution when the state is `NOT_INCLUDED`. Do not compute a second eligibility; pass the one already resolved.
- **Migration:** no. **Production action:** no. **Test missing:** yes — a cross-tab agreement test asserting that no `NOT_INCLUDED` record produces a report/package issue, alert, or next-action anywhere in the review-workspace envelope.

---

**P1-2 — Pricing advertises Pay-per-evidence entitlements that no purchase path grants**

- **File / symbol:** `services/api/src/services/billing-pricing.service.ts:133` `projectPublishedPlan` and `:174` `buildPricingCatalogResponse` (`payg:` key), reading `PLAN_CAPABILITIES.PAYG`; rendered at `apps/web/app/pricing/page.tsx:525` (storage) and `:587` (AI ops).
- **Root cause:** `PLAN_CAPABILITIES.PAYG` was retired to a grandfather-resolution row with an explicit instruction — "*Nothing may advertise these values: Pricing and Billing render `EVIDENCE_CREDIT_PRODUCT`, never this row*" — and the pricing projection was not changed to match. `projectPublishedPlan` still accepts `"PAYG"` in its type parameter.
- **Affected plans:** every prospective and actual evidence-credit buyer.
- **Journey:** public Pricing → buy credits → capture → hit 250 MB → discover no add-on is purchasable on FREE.
- **Backend impact:** none (the numbers are inert) — but the *consequence* is a real hard stop in `assertWorkspaceAllowsStorageGrowth` with no remedy.
- **Frontend impact:** the comparison table shows **5 GB** and **50 ops / month** in the Pay-per-evidence column; truth is 250 MB and 10.
- **Commercial impact:** a published entitlement that cannot be obtained. This is the most serious commercial defect in the audit.
- **Fix (two parts):** (a) narrow `projectPublishedPlan` to `"FREE" | "PRO" | "TEAM"` and build the `payg` object from `EVIDENCE_CREDIT_PRODUCT` plus `PLAN_CAPABILITIES.FREE` for the entitlements a credit buyer actually holds; the price and credits already come from the product descriptor. (b) Decide the storage question explicitly — either allow storage add-ons on FREE-with-credits, or state the 250 MB ceiling on the Pay-per-evidence card. Leaving it unstated is the part that turns a copy defect into a dead end.
- **Migration:** no. **Production action:** none required, but the published page should be corrected before further credit sales. **Test missing:** yes — assert that no published catalog field is sourced from `PLAN_CAPABILITIES.PAYG`. The existing `commercial-plan-authority-drift.test.ts` checks catalog↔pricing *agreement*, which is exactly why it passed.

---

**P1-3 — A non-finalized or integrity-failed record is described as a commercial exclusion**

- **File / symbol:** `packages/shared/src/evidence-output-lifecycle.ts:~330` — `deriveEvidenceOutputState` returns `axes.finalized ? "ELIGIBLE_NOT_GENERATED" : "NOT_INCLUDED"`; rendered at `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx:204`.
- **Root cause:** the `finalized` field's own docblock says a non-finalized record "*reports NOT_REQUESTED rather than inviting an action that would be refused*" — but `NOT_REQUESTED` is a member of `OutputGenerationState`, not of `EvidenceOutputState`, and the derivation returns `NOT_INCLUDED`, which is a **commercial verdict**. The doc and the code describe different behaviours, and the UI renders the commercial one with plan copy.
- **Affected plans:** PRO, TEAM, ENTERPRISE, and any credit-funded record — i.e. every entitled customer.
- **Journey:** (a) the window between upload and finalize, on every record; (b) permanently, for every `FAILED_HASH_MISMATCH` record.
- **Frontend impact:** "**Reports are not included for this record.** Report PDFs and verification packages are included with Pay-per-evidence credits and with the Pro, Team and Enterprise plans." — shown to a Pro/Team/Enterprise customer.
- **Forensic impact:** the integrity-failed case is the serious one. A record whose recomputed SHA-256 disagreed with the stored value is told its *billing plan* is the reason it has no report. The page already computes `isIntegrityFailed` for the header affordances and does not pass it to the Artifacts tab.
- **Fix:** add a distinct member — `NOT_APPLICABLE` (not finalized) — to `EvidenceOutputState`, return it when `!finalized`, and give it its own copy ("Outputs are produced after this record is finalized"). Because `ArtifactLifecyclePanel` is a total switch, the compiler will force the renderer to handle it. Separately, branch the panel on `FAILED_HASH_MISMATCH` to state the integrity reason, matching the 409 the regenerate route already returns.
- **Migration:** no. **Production action:** no. **Test missing:** yes — a state test over the `finalized: false` and `FAILED_HASH_MISMATCH` inputs asserting the rendered copy contains no plan name.

---

### P2

**P2-1 — Generate is a dead button on legacy `team_id IS NULL` personal records.**
`packages/shared-runtime/src/reports/report-generation-request.ts:~165` refuses `evidence_workspace_unresolved`; `report-generation-authority.service.ts:~225` maps it to `EVIDENCE_NOT_FOUND`; `evidence.routes.ts:97` renders "This evidence record is not available." Those rows are *listed* — `evidenceScopeFor` (`packages/shared-runtime/src/workspace-scope.ts:145`) has an explicit `{ ownerUserId, teamId: null }` arm, and `/v1/reports` has its own — and their eligibility resolves correctly, so the product offers an action it then refuses with a message implying the record does not exist. New rows always carry a `teamId`; the population is historical and its size cannot be measured without touching Production. **Fix:** either resolve the personal Team id inside the writer for owner-scoped rows, or return a distinct `WORKSPACE_UNRESOLVED` outcome with honest copy and suppress the action. A backfill is the durable answer and belongs to a separate, operator-gated change. **Test missing:** yes.

**P2-2 — The Reports user-scoped fallback resolves the wrong commercial subject.**
`services/api/src/routes/reports.routes.ts:~330` calls `resolveEvidenceOutputEligibilityMany({ evidenceIds, ownerUserId: userId, teamId: null })` — the **caller's personal plan** — while the same route's `accessClause` can return rows from every workspace the caller is an active member of. Triggered by `ReportsIndex.tsx:405` when the active workspace's unfiltered list is empty, and by a 404 from the aggregator. A FREE-plan user with records in a TEAM workspace sees "Report not included for this record" and no Generate. **Fix:** group the page's rows by `teamId` and resolve eligibility per group, or drop cross-workspace rows from the fallback. **Test missing:** yes.

**P2-3 — The mobile app has a dead download button and a false empty state.**
(a) `apps/mobile/app/(stack)/evidence/[id].tsx:112` — "Download Report" is always rendered enabled; the handler no-ops when `reportUrl` is null. (b) `apps/mobile/app/(tabs)/reports.tsx:40` — "Capture evidence to generate signed reports" on a plan that never generates one. The mobile app consumes none of the canonical output vocabulary. **Fix:** read `GET /v1/evidence/:id/artifacts/status` and render `outputs.report.state`/`action`; disable the control with the server's reason when not `READY`.

**P2-4 — Cases surfaces restate a commercial exclusion (and in-flight work) as a deficiency.**
`apps/web/components/cases-experience/simple-case-detail/helpers.ts:114-163` counts `!reportReady || !packageReady` into `needsAttention` and emits "N evidence records are missing a report"; `SimpleCaseDetail.tsx:1162`, `MatterWorkspace.tsx:1069`, `EvidenceLinkModal.tsx:375` render "Report missing" / "No report". Bounded today because `casesIncluded ⊆ reportsIncluded`, but it survives a **downgrade** (cases persist) and it is wrong for `QUEUED`/`GENERATING` on every plan. **Fix:** project `outputs.report.state` onto the matter-workspace evidence rows and branch on it.

**P2-5 — `FreeReportsLockedNotice` is an orphan carrying two contradictions.**
`apps/web/components/reports-experience/FreeReportsLockedNotice.tsx` has zero consumers (`/reports/page.tsx` documents its removal). Its unlock checklist claims "✓ Shareable verification link" while the same card says twice that public verification stays free, and its docblock asserts "*The report download endpoints are still authorization-gated on the plan/entitlement*" — which the download routes deliberately are not. **Fix:** delete the component. Nothing renders it, and its copy would be wrong if anything did.

---

### P3

| # | Finding | File |
|---|---|---|
| P3-1 | `court-admissibility-checklist.json` hard-codes `reportArtifactIncluded`/`certificationTemplateIncluded`/`caseMetadataIncluded`/`originalLinkageIncluded` as `true` while `data.reportPdf` is optional and unread by the checklist; its sibling `buildArtifactBoundaries` derives the same fact correctly. A claim inside a forensic archive should read the archive. | `services/worker/src/verification-package.ts:1836` |
| P3-2 | `classifyTerminalReason` maps `LEGAL_HOLD_ACTIVE` and `ORGANIZATION_NOT_ACTIVE` to `TECHNICAL` rather than `POLICY`. Unreachable today (those codes only appear on `BLOCKED_*` states, which project to `BLOCKED`, not `TERMINAL_FAILURE`), but latent. | `packages/shared/src/evidence-output-lifecycle.ts:~245` |
| P3-3 | Verify page shows the package badge "Unavailable" beside copy that says integrity "*can be checked independently from the downloaded verification package*". | `apps/web/app/verify/[token]/page.tsx:2436` |
| P3-4 | The public trust score awards 3/5 rather than 5/5 for a missing verification package — a commercial input into a public integrity score (5 points of 100; no headline verdict changes today). | `packages/shared/src/trust-decision.ts:1115` |
| P3-5 | `REPORT_ARTIFACT_TYPES` member `"EXCHANGE_PACKAGE"` has no producer anywhere. | `packages/shared-runtime/src/reports/report-generation-request.ts:45` |
| P3-6 | Copilot proposals carry `requiredPermission: "evidence.report.generate"`, which is not a canonical `Permission` (`evidence.generate_report` is). Currently consumed by nothing. | `services/api/src/routes/ai-evidence.routes.ts:406` |
| P3-7 | `requestReportGeneration`'s commercial precheck reads only `reportsIncluded`, never `verificationPackageIncluded`, regardless of `artifactType`. Equal on every catalog row today. | `services/api/src/services/reports/report-generation-authority.service.ts:~170` |
| P3-8 | `remediation-executor` maps `deduplicated` to `ALREADY_IN_PROGRESS` before consulting `superseded`, so the loser of a supersession race is told the wrong thing. | `services/api/src/services/operations/remediation-executor.ts:~315` |
| P3-9 | `runtime-schema-requirements.mjs` declares nothing for `report_generation_requests` or `evidence_credit_ledger_entries`, both now load-bearing. Readers degrade rather than crash, which is exactly what makes the absence silent. | `services/api/scripts/runtime-schema-requirements.mjs` |
| P3-10 | `apps/web/.../ReportsIndex.tsx` declares its own structural copy of the `/v1/reports` wire type instead of importing the server's `UserReportRow`. Currently honest (`caseTitle`/`intakeCustomerId` are marked optional and the route does not send them). | `ReportsIndex.tsx:119` |
| P3-11 | No notification event exists for any output-lifecycle outcome. A customer who clicks Generate and navigates away learns nothing about a terminal failure. | `packages/shared/src/notifications.ts:87` |
| P3-12 | Mobile responsive behaviour at 320–430px for the Verify page and the artifact history section was not measured (local API boot is unsafe — see §Y). Unverified, not failed. | — |

---

## AK. RECOMMENDED CLOSURE SEQUENCE

Ordered so each step is independently shippable and nothing depends on a later one.

1. **P1-2 (a)** — build the published `payg` catalog object from `EVIDENCE_CREDIT_PRODUCT` + `PLAN_CAPABILITIES.FREE`; narrow `projectPublishedPlan`'s type parameter so the grandfather row is unreachable from the pricing path. Add the "no published field may come from `PLAN_CAPABILITIES.PAYG`" test. *(Highest customer-facing risk, smallest change.)*
2. **P1-2 (b)** — make the storage decision explicit: allow storage add-ons for a FREE account holding credits, **or** state the 250 MB ceiling on the Pay-per-evidence card. Do not ship (a) without (b).
3. **P1-1** — pass the existing `artifactStatus` projection into `buildEvidenceIntelligence` and suppress the report/package issue, alert, next-action and score contribution on `NOT_INCLUDED`. Add the cross-tab agreement test.
4. **P1-3** — add `NOT_APPLICABLE` to `EvidenceOutputState`, return it for `!finalized`, let the compiler force the renderer, and branch the Artifacts panel on `FAILED_HASH_MISMATCH`.
5. **§AF hardening** — convert the two TSA guards from single-file regexes into repo-wide gates over `services/**` and `packages/**` with a one-entry allowlist. *(Do this before any further work touches the finalize path.)*
6. **P2-3** — put the mobile evidence and reports screens on `GET /v1/evidence/:id/artifacts/status`; disable the download control with the server's reason.
7. **P2-2** — group the `/v1/reports` fallback by `teamId` and resolve eligibility per group.
8. **P2-1** — return a distinct `WORKSPACE_UNRESOLVED` outcome with honest copy and suppress the action for legacy null-workspace rows. Schedule the backfill as a separate operator-gated change.
9. **P2-4** — project `outputs.report.state` onto matter-workspace evidence rows; branch the Cases readiness copy on it.
10. **P2-5** — delete `FreeReportsLockedNotice.tsx`.
11. **P3-1** — make `buildCourtReadinessChecklist` read `data.reportPdf` and the other optional inputs, exactly as `buildArtifactBoundaries` does.
12. **P3-9** — declare `report_generation_requests` and `evidence_credit_ledger_entries` in `runtime-schema-requirements.mjs`.
13. **P3-2, P3-5, P3-6, P3-7, P3-8, P3-10** — small correctness/nomenclature cleanups, batchable.
14. **P3-3, P3-4** — verify-page copy, and an explicit product decision on whether package presence may contribute to a public trust score.
15. **P3-12** — a live 320px pass over Verify and the artifact history section once a safe (non-Production-credentialed) environment exists.

---

## AL. REPOSITORY SAFETY

- Source changes: **none**
- Migrations authored or applied: **none**
- Commits: **none**
- Pushes: **none**
- Deploys: **none**
- Production mutations: **none**
- Production reports regenerated: **none**
- Backfills run: **none**
- TSA retried: **none**
- Credits consumed: **none**
- Temporary audit fixtures created: **none** (no scratch files were written; this report is the only artifact)
- Local API boot: **deliberately not performed** — `services/api/.env` carries live Production credentials

```
HEAD                 214315a527771aec8dbc84ea7ff4ddff34fbbda6
origin/main          214315a527771aec8dbc84ea7ff4ddff34fbbda6
divergence           0 ahead / 0 behind
git status           ?? docs/admin/audits/FINAL_ADVERSARIAL_E2E_CLOSURE_AUDIT.md   (pre-existing, untouched)
                     ?? docs/admin/audits/FINAL_COMMERCIAL_OUTPUT_VERIFY_EXPERIENCE_AUDIT.md   (this report)
Production touched   NO
```

---

**FINAL COMMERCIAL + OUTPUT + VERIFY AUDIT COMPLETE**
