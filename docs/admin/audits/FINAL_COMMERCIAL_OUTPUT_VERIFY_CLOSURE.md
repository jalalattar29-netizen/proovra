# PROOVRA — FINAL COMMERCIAL / OUTPUT / VERIFY CLOSURE

**Closes:** `docs/admin/audits/FINAL_COMMERCIAL_OUTPUT_VERIFY_EXPERIENCE_AUDIT.md`
**Date:** 2026-09-10
**Mode:** implementation + validation + commit + push. No Production mutation.

---

## A. EXECUTIVE RESULT

All three **P1** findings, all five **P2** findings and all twelve **P3** findings are closed.
The repo-wide TSA no-retry gate is built, armed and proven to fail on a real planted call.

Three things were found during implementation that the audit had not seen, and all three are
fixed here:

1. **A real product bug in my own first draft of Product Option B.** `resolveStorageAddonEntitlement`
   reached the evidence-credit arm for *any* plan that was not PRO/TEAM/PAYG, so an ENTERPRISE
   organization holding a historical credit grant would have been offered a self-service storage
   purchase — replacing a term of a signed agreement with a card payment. Caught by this closure's
   own test; ENTERPRISE is now excluded before the credit arm.
2. **A third Cases render site** (`SimpleCaseDetail.tsx:1917`) still printing "Report missing" from
   the artifact boolean. The audit named two; there were three.
3. **Two bugs in the first draft of the TSA gate itself** — it stripped string literals and then
   looked for one (so the `tsaStatus` check passed by finding nothing), and its producer pattern
   flagged `tsaRetryable`, the code that *reports* the absence of a safe remediation. Both fixed,
   both pinned by negative controls.

**One audit premise was wrong and is corrected here.** P3-11 concluded that no output-failure
notification exists. It read `NOTIFICATION_EVENT_TYPES` — the transactional *email* vocabulary —
and missed the attention architecture, where `report_failure` and `verification_package_failure`
already carry the `notification` channel and are derived at read time from `OperationalIncident`
rows. No event type was added, because adding one would have produced either an orphan with no
producer (the exact defect P3-5 removes) or a duplicate of a path that already works. See §Q.

**Residual:** one pre-existing failure in the API unit run
(`phase-12-point7-closure-gate`), proven below to be structural to a unit-only run and
independent of these changes; and web ESLint, which cannot execute in this environment because
its plugin packages are not installed.

### VERDICT: **2 — ARCHITECTURE SOUND, LIMITED NON-CORRECTNESS ITEMS REMAIN**

Verdict 1 is withheld for one reason and it is a matter of proof, not of code: §26 requires the
full required validation to be green, and two of its items could not be *executed* in this
environment — web ESLint (packages absent) and the Point-7 closure gate (its proof suites are
`*.integration.test.ts`, which the unit project excludes by suffix). Every closure item itself is
implemented and proven; what is missing is a run, not a fix. Declaring verdict 1 on a gate I could
not execute would be the kind of claim this whole programme exists to remove.

**Counts:** P1 3/3 closed · P2 5/5 closed · P3 12/12 closed · new defects found and fixed: 3.

---

## B. PRODUCT DECISION IMPLEMENTED

| Decision | Implementation |
|---|---|
| FREE remains FREE | `PLAN_CAPABILITIES` still has exactly five rows; no plan's capabilities changed. Pinned by a test. |
| Evidence credits stay record-level | `resolveEvidenceOutputEntitlements({plan, funding})` unchanged. A credit-funded record earns report + package + public verify; the account's plan does not move. |
| No PAYG subscription tier introduced | No `PAYG_V2`, no `FREE_WITH_CREDITS`, no synthetic overlay. The published Pay-per-evidence column is a **product offer**, not a plan row, and carries `plan: "FREE"` explicitly. |
| Credits grant no storage / AI / PRO / TEAM capability | The published offer projects `PLAN_CAPABILITIES.FREE`'s storage and AI values, with the account named in the cell. |
| **FREE with valid credit state MAY buy storage add-ons** | `resolveStorageAddonEntitlement({plan, hasSettledEvidenceCreditGrant})` — one new canonical pure policy in `@proovra/shared-billing`, beside its precedent `resolveWorkspaceIntakeEntitlement`. |

**"Has evidence credits" is defined as: at least one settled `PURCHASE` or `ADMIN_GRANT` row in the
credit ledger.** Not a balance — deliberately. The customer who most needs storage is the one who
has *spent* their credits, because those spends are the records occupying the space; a balance rule
would deny the add-on at the exact moment it is needed and would flicker on and off as the wallet
moved. The chosen signal is durable, server-written (verified provider webhook, the reconciler
re-reading settled provider state, or an audited platform-admin grant), and cannot be produced by a
failed payment, an abandoned checkout, a cart, a query parameter or a frontend boolean.

---

## C. CANONICAL AUTHORITY MAP (after closure)

No authority was replaced. One was added, one was extended, one stopped being a second authority.

| Concern | Authority | Change |
|---|---|---|
| Output state | `packages/shared/src/evidence-output-lifecycle.ts` · `deriveEvidenceOutputState` | **extended** — `NOT_APPLICABLE` state, `OutputRecordApplicability` axis replacing the `finalized` boolean |
| Output action | same file · `outputActionFor` | extended (total over the new state) |
| Output eligibility (per record) | `resolveEvidenceOutputEntitlements` (@proovra/shared-billing) | unchanged |
| Eligibility loader | `evidence-output-eligibility.service.ts` | **extended** — `resolveEvidenceOutputEligibilityByRecord`, the one grouping-by-commercial-subject implementation |
| Status → record axis | `evidence-artifact-status.service.ts` · `resolveOutputRecordApplicability` | **new**, one mapping, three consumers |
| **Storage-addon entitlement** | `@proovra/shared-billing` · `resolveStorageAddonEntitlement` | **new** canonical pure policy |
| Credit-customer fact | `evidence-credits.service.ts` · `hasSettledEvidenceCreditGrant` | **new** host adapter (a read, not a rule) |
| Reviewer readiness | `evidence-intelligence.service.ts` | **no longer an authority** — receives the canonical projection, decides nothing commercial |
| Everything else (generation request, worker claim, versioning, credits, TSA, OTS, download authorization, legal hold, incidents) | unchanged | — |

---

## D. P1-1 — evidence-intelligence stopped being a second output authority

**Defect.** It answered "does this record have its outputs?" from `reportReady` / `packageReady` —
artifact-row presence, no commercial or lifecycle input — and its answer reached the same page as
the canonical one. On a FREE record the Artifacts tab said *"Reports are not included for this
record"* while the Overview tab said *"Needs review — Generate the PDF report before external
review"* and Risk Signals showed two WARNING entries.

**Implementation.**
- `EvidenceIntelligenceInput.outputs` is **required**, not optional: an optional field would let a
  caller omit it and silently fall back to the defect. Both call sites in `evidence.routes.ts` now
  resolve `buildEvidenceArtifactStatus` *first* and hand the projection in. On the review-workspace
  route the projection was built ~400 lines *after* the intelligence call; it moved above its first
  consumer. `GET /v1/evidence/:id` had no projection at all and now resolves one.
- Two predicates replace the booleans: `outputAbsenceIsReviewGap` (NOT_INCLUDED, NOT_APPLICABLE and
  READY are never gaps) and `outputParticipatesInReadinessScore`.
- The two absence alerts ("Report not ready", "Verification package missing") are **deleted** from
  this module. The route already builds a canonical alert block from `outputs.*.state` that
  deliberately emits nothing for NOT_INCLUDED; emitting a second alert here could only duplicate or
  contradict it. What remains is the INTEGRITY case, which the output block does not cover because
  it is a fact about the record.
- "Confirm OpenTimestamps Bitcoin anchoring **or generate a package** for independent review" is
  gone. There is no standalone package action in this product — generation is paired — so that verb
  named a control that does not exist.
- A finalized NOT_INCLUDED record now returns `READY_FOR_EXTERNAL_REVIEW` with integrity-based
  reasons instead of falling through to "Needs review" with a filler reason.
- A terminal integrity failure gets its own verdict rather than being explained by whichever issues
  happened to be in the list.
- **The readiness score excludes an excluded output from the denominator** rather than scoring it
  zero. The score was a fixed four-signal average with report and package as two of four, so a Free
  record's ceiling was 50% however complete its evidence was — the number was measuring the price
  plan. A QUEUED or FAILED output stays in the denominator and scores zero, because there the
  absence really is an incomplete step.

**Proof.** Cross-surface agreement is asserted **behaviourally** over every state: no state whose
canonical action is NONE may also be reported as a review gap. Plus WIRING assertions that the
module imports no commercial authority, that both call sites hand in the projection, and that the
projection is resolved before its first consumer.

---

## E. P1-2 — Pricing, storage add-ons, settlement, enforcement

### Pricing

`projectPublishedPlan`'s type parameter is narrowed to `"FREE" | "PRO" | "TEAM"`, so
`projectPublishedPlan("PAYG")` is now a **compile error** — the defect is unrepresentable rather
than merely fixed. The Pay-per-evidence column is built by a new `projectEvidenceCreditOffer` from
three sources: `EVIDENCE_CREDIT_PRODUCT` (price, grant, no expiry), `PLAN_CAPABILITIES.FREE` (the
subscription entitlements a buyer keeps) and `resolveEvidenceOutputEntitlements(FREE,
EVIDENCE_CREDIT)` (what one funded record earns, from the one authority, never restated as
literals).

The web type is `PricingEvidenceCreditOffer`, deliberately **not** a `PricingCatalogPlan`: a shape
that cannot be mistaken for a subscription tier cannot be rendered as one.

Page cells now read `250 MB (Free account)` and `10 ops / month (Free account)`, and the card gains
*"Free storage allowance, with paid storage add-ons once you hold a credit"*.

### Storage add-on capability

One pure policy, in the package that owns commercial policy, shaped exactly like its precedent:

```
PRO | TEAM | PAYG(grandfathered)  -> purchasable, source: PLAN
ENTERPRISE                        -> NOT purchasable (contract term, never self-service)
otherwise, settled credit grant   -> purchasable, source: EVIDENCE_CREDIT
otherwise                         -> not purchasable
```

PAYG is in the plan arm because pre-ledger PAYG buyers may hold no credit-grant row, and removing a
right from an existing account is not a refactor.

### Payment / settlement / enforcement — traced end to end

| Step | Change |
|---|---|
| Pricing page | states the capability (`storageAddonsPurchasable`) |
| Billing projection | `addonsEligible` was `scope.plan !== "FREE"` — a plan name standing in for a commercial decision. It now derives from the offer catalog, which consults the canonical policy. The ledger fact is read **once** per projection. |
| Locked-notice copy | names both routes, not just Pro |
| Offer catalog | `storageAddonOffersForPlan(plan, { hasSettledEvidenceCreditGrant })` — *which* offers stays a catalog question; *whether* is the commercial one |
| Checkout gate | `scope.plan === FREE → 409` replaced by the canonical capability + `STORAGE_ADDON_NOT_INCLUDED`; the accepted add-on keys are checked against the same offer catalog rather than re-listed |
| Settlement | unchanged — `upsertWorkspaceStorageAddon` has no plan check |
| Allowance | unchanged — `getActiveWorkspaceStorageAddonBytes` sums ACTIVE/PAST_DUE rows regardless of plan |
| Growth enforcement | unchanged — honours the allowance automatically |

**Test matrix:** FREE no credits (denied) · FREE with settled grant (allowed, source EVIDENCE_CREDIT)
· PRO/TEAM (unchanged, source PLAN) · ENTERPRISE (denied) · grandfathered PAYG (allowed) · no
pseudo-plan introduced · the fact is a ledger grant and never a balance/CONSUMPTION/client value ·
only one module decides it (asserted across four files).

Failed payment and abandoned checkout are excluded structurally: neither writes a ledger grant row.

---

## F. P1-3 — `NOT_APPLICABLE` split from `NOT_INCLUDED`

`EvidenceOutputAxes.finalized: boolean` became `record: OutputRecordApplicability`
(`NOT_FINALIZED | INTEGRITY_FAILED | FINALIZED`) — one field rather than two, and a union rather
than a boolean, because the boolean could not express the third case and every caller holding it
had to fold a terminal integrity failure into "not finalized yet", which is a false promise.

Ordering: `READY` → `INTEGRITY_FAILED` → live work → `NOT_FINALIZED` → commercial → failures →
eligible. An integrity failure outranks a commercial exclusion because nothing below it can ever
become true for such a record.

`OUTPUT_NOT_APPLICABLE_REASONS` (`NOT_FINALIZED | INTEGRITY_FAILED`) travels with the state, because
the two end differently: finalization is coming and an integrity failure is not.

**The type change forced every consumer.** Compiling caught all five call sites plus four test
files; nothing was found by search.

Total switches updated: `outputActionFor`, the aggregator's two legacy mappers, the web mappers,
`OUTPUT_STATE_COPY`, `OUTPUT_STATE_LABEL`, `ArtifactLifecyclePanel`, the package-download route.
No default branches were added.

**Copy** — no plan name in either arm. Integrity: *"This record did not pass its integrity check…
To capture this material as evidence, re-upload or re-capture it as a new record."* Not finalized:
*"Outputs become available once this record is finalized."* Asserted by a test that strips comments
first and then forbids "Pro", "Team", "Enterprise" and "Pay-per-evidence" in that arm.

---

## G. TSA — repo-wide hard gate

`services/api/test/tsa-no-retry-repo-wide.gate.test.ts`. Ten tests.

Scans `services/**` and `packages/**` (excluding `node_modules`, `dist`, build output and test
files), strips comments and string literals in one left-to-right pass, and compares every
executable reference to `createEvidenceTimestamp` against a **two-entry, exact-path** allowlist:
the module that defines it and the finalization service that calls it. Not a directory prefix — a
prefix would let a sibling inherit the permission.

Also asserts: the report/package pipeline references it in none of seven named modules; no producer
shape exists (`enqueueTsa*(`, `retryTsa*(`, `tsaRetry{Job,Queue,Producer,Sweep}`, `TSA_RETRY*`,
`RETRY_TSA*`, `REQUEST_TSA*`, `STAMP_TSA*`); the only writer of a positive `tsaStatus` is the
stored-token repair script; and that script never references the authority.

A corpus-size assertion (`> 500` files, plus two named files present) guards against a silently
empty walk — without it every other assertion passes vacuously.

**Negative control, on real files.** A `createEvidenceTimestamp` call was appended to
`services/worker/src/processor.ts` and a `RETRY_TSA` work name to
`services/api/src/routes/billing.routes.ts`. The gate failed 3 of 10 tests, naming both files.
Both were reverted; `git diff --quiet services/worker/src/processor.ts` → clean, and the billing
route's remaining diff is the P1-2 storage gate only.

**Two bugs the gate had, caught by running it:** it stripped strings and then looked for
`tsaStatus: "STAMPED"` (passing by finding nothing — the worst way for a gate to pass), and its
first producer pattern flagged `tsaRetryable` in the admin cohorts service, which is the code that
*reports* the absence of a safe remediation. Both are now pinned by negative controls, including
one asserting that the false positive stays clean.

---

## H. P2-1 — legacy `team_id IS NULL` records

New outcome `WORKSPACE_UNRESOLVED`, distinct from `EVIDENCE_NOT_FOUND`. The writer's
`evidence_workspace_unresolved` refusal used to map to *"This evidence record is not available"* —
on a record the customer could see, open and download from.

The **action is withdrawn** rather than offered-and-refused: `actionUnavailableReason` on the
projection, set when the record has no workspace. The **state is untouched**, so an existing
artifact on such a record stays READY and downloadable — the same separation of ownership from
generation the downgrade path relies on. The Artifacts tab renders a truthful sentence in place of
the button.

**No backfill performed.** `docs/architecture/legacy-null-workspace-evidence-backfill.md` records
the exact population queries, why this is not a migration (it changes tenancy, cannot fail closed
for owners with no personal workspace, and must carry `organization_id` with it), and an
operator-gated script design modelled on `reconcile-ots-never-attempted.ts`. New records cannot
join the population: `createEvidence` resolves and writes `effectiveTeamId` unconditionally.

---

## I. P2-2 — Reports fallback resolves the record's commercial subject

`GET /v1/reports` passed `{ ownerUserId: caller, teamId: null }` — the caller's personal plan —
and applied it to every row, while its own access clause matches rows in any workspace the caller
is an active member of.

`resolveEvidenceOutputEligibilityByRecord` groups rows by commercial subject and asks the canonical
resolver once per distinct subject. `selectNonEntitledEvidenceIds` was refactored onto it, so there
is **one** grouping implementation rather than two. `ownerUserId` and `teamId` are selected on
**both** evidence branches — including the no-`deleted_at` fallback, which is what a deployment
lacking that column actually runs.

---

## J. P2-3 — mobile

The download control now renders **only** when the server says READY and a URL was minted; every
other state renders a server-derived sentence. Hidden rather than disabled because the mobile
`Button` primitive has no disabled affordance, and adding one to show a control that can never be
pressed on this screen would be the same dead button at lower opacity.

Mobile also now reads the **side-effect-free** `/artifacts/status` endpoint first. It previously
called `/report/latest` on every screen open — which emits custody and audit events for a real
download, recording a download nobody performed.

`reportStateMessage` is total over `EvidenceOutputState`, imported from `@proovra/shared` (mobile
already depends on it), so no enum is duplicated and a new state is a compile error rather than a
blank card.

The Reports empty state no longer promises a report capture will not produce.

---

## K. P2-4 — Cases

The matter-workspace service projects the canonical state per row (grouped eligibility + one
bounded request query, no N+1). Two shared presentation helpers live beside the canonical labels:
`caseOutputNeedsAttention` (total; READY, NOT_INCLUDED, NOT_APPLICABLE, QUEUED and GENERATING are
never case work) and `caseOutputLabel`.

`summariseDeliverables` and `deriveNeedsAttention` consult the predicate. **Three** render sites
were corrected — the audit named two. Copy moved from "missing a report" to "still needs its report
generated", which is only ever true where an action or an operator step exists.

Cases re-derives nothing: asserted that neither file references `deriveEvidenceOutputState`.

---

## L. P2-5 — dead component deleted

`FreeReportsLockedNotice.tsx` removed (`git rm`) after re-proving zero consumers. Its allowlist
entry in `phase-g5-vocabulary-contracts.test.ts` was removed with a note. The existing
`assert.doesNotMatch(ROUTE, /FreeReportsLockedNotice/)` assertion stays valid and is now doubly
true. Its copy had claimed "Shareable verification link" is unlocked by upgrading, beside two
sentences in the same card saying public verification stays free — and a docblock asserting the
download endpoints are plan-gated, which they deliberately are not.

---

## M. P3-1 — forensic checklist reads the archive

`court-admissibility-checklist.json` hard-coded five presence fields `true` while
`createVerificationPackage`'s `reportPdf` is optional. The conditional ones are now inputs, taking
the **same expression** `buildArtifactBoundaries` is given (asserted: exactly two occurrences of
`reportIncluded: Boolean(data.reportPdf)`), so two files describing one archive cannot disagree.
The four that remain `true` are unconditional appends and are documented as such.

---

## N. P3-9 — runtime schema requirements

`report_generation_requests` and `evidence_credit_ledger_entries` declared, **with** their
uniqueness properties (`idempotency_key`, `evidence_id`) — asserted through `pg_index` rather than
by index name, because the property the code depends on is the uniqueness, not the name a generator
chose.

These were the most dangerous omission in that file precisely because every *reader* degrades
gracefully: an absent `report_generation_requests` would produce no error anywhere — every record
would read `NOT_REQUESTED`, every Generate click would return `REQUEST_PERSIST_FAILED`, and the
preflight would report the release healthy.

Four negative contract tests added. The fixture's strict "unrecognised probe" throw is what forced
them to be wired rather than assumed.

One existing contract was **recalibrated, not weakened**: the failure message's line bound was a
flat `< 30` calibrated for eight requirements and broke at twelve. It is now expressed as three
lines per missing object plus fixed overhead — the property that actually matters — so it still
fails if a requirement starts contributing a paragraph.

---

## O. P3 correctness cleanup

| # | Change |
|---|---|
| P3-2 | `LEGAL_HOLD_ACTIVE`, `ORGANIZATION_NOT_ACTIVE`, `WORKSPACE_MISMATCH`, `WORKSPACE_NOT_FOUND`, `NO_PRINCIPAL` classify as **POLICY**, not TECHNICAL. Listed explicitly, not widened by pattern. Exhaustive tests incl. the worker's lowercase spellings. |
| P3-5 | `EXCHANGE_PACKAGE` removed from `REPORT_ARTIFACT_TYPES` — no producer, no processor branch. Safe at the DB (plain VARCHAR, no row carries it). The Exchange Package product is untouched and has its own builder, kinds and state machine. |
| P3-6 | `"evidence.report.generate"` → `"evidence.generate_report" satisfies Permission`. |
| P3-7 | The precheck asks about every artifact the request produces. A REPORT request checks the **pair**; still one action, no second generation path. A test pins that today's flags agree on every row — which is *why* the check had to stop assuming it. |
| P3-8 | The typed outcome decides before `deduplicated`, so a supersession-race loser reads QUEUED rather than "already in progress". |
| P3-10 | Superseded: the web-side `UserReportRow` no longer needs to grow, because the fallback and the aggregator now hand the browser identical `outputs` blocks; the local structural type stays honest (optional fields, documented) and no server-only module is imported into web. |
| P3-12 | Source/CSS responsive review below. |

---

## P. Verify page

**P3-3.** The absent-package branch said *"Package-level integrity can be checked independently from
the downloaded verification package"* — beside a badge reading "Unavailable", pointing at a download
that does not exist, and implying the package is what makes independent verification possible. It
now reads: *"No downloadable package is available for this record, and its integrity assessment does
not depend on one. The fingerprint, signature, timestamp, anchoring and custody materials are
published on this page and can each be checked independently with standard tooling."*

**P3-4.** The verification-package signal carried 5 of 40 points and awarded 3 when absent, so a
FREE record scored 95 where an identical paid record scored 100 — two points measuring the price
plan. It also fed `degradedSignals`, which drives `degradedButUsable` and the
`VERIFIED_WITH_DEGRADED_SIGNALS` headline, so a record could read "verified with supporting
limitations" because of an artifact its owner had not bought.

The signal is now **informational**: `maxPoints: 0` in all three branches, so it adds nothing to
numerator or denominator. It remains in the list and still says truthfully whether a package
exists. Its status is `passed` in both the present and absent-with-materials cases so it cannot
degrade the headline; the genuinely bare case keeps `missing`, and that is not a commercial
statement.

The exemption in the product decision ("unless the package contains a forensic proof element not
otherwise represented") does not apply: every proof it bundles — fingerprint, signature, public key,
RFC 3161 token, OTS proof, custody chain, storage protection — is already a scored signal in the
same list. Scoring it double-counted the assurance and charged for the convenience.

---

## Q. Notifications (P3-11) — a corrected premise, and a deliberate non-addition

The finding read `NOTIFICATION_EVENT_TYPES` (transactional email), found no output member, and
concluded no notification exists. There is a second notification architecture, and it already
covers the failure case:

```
notification-classification.ts
  report_failure               channels: ["notification", "operational_condition"]
  verification_package_failure channels: ["notification", "operational_condition"]
                               conditionAuthority: "operations"
```

The personal inbox **derives** these at read time from `OperationalIncident` rows (category
REPORT / PACKAGE) — it is not a push feed. So a worker retry, a reconciler replay and an idempotent
request replay all produce the same single item, structurally. There is nothing to deduplicate
because nothing is written per notification, which is exactly the non-spam property §16 asks for.

**No event type was added.** Two candidates were considered and both rejected on the architecture's
own terms:

- `OUTPUT_GENERATION_FAILED` would duplicate a path that already works.
- `OUTPUT_READY` has no producer that respects the module boundary — completion is known only in
  the worker, which must not import `services/api/src`, and the one internal API endpoint is for
  media intelligence. Adding the type without a producer would create an **orphan**, which is the
  precise defect P3-5 removes three sections above. Adding it to the attention feed would violate
  that table's stated discipline — `onboarding` is excluded because "rendering it as attention
  manufactures a workload out of an empty workspace", and a finished report is not work either.

Three tests pin this: the classification, the read-time derivation, and the deliberate absence of
any `output_ready` category.

---

## R. Cross-surface state matrix

One meaning per state, on every surface.

| State | Artifacts tab | Overview / risk signals | Reports row | Cases | Mobile | Action |
|---|---|---|---|---|---|---|
| `NOT_INCLUDED` | "not included for this record" | **silent** (not a gap, not scored) | "Report not included" | "Report not included", not attention | plan-neutral sentence | NONE |
| `NOT_APPLICABLE` | finalization *or* integrity sentence | integrity verdict when INTEGRITY_FAILED | "not generated yet" (legacy vocab) | "not applicable", not attention | "available once finalized" | NONE |
| `ELIGIBLE_NOT_GENERATED` | "your plan includes… " + Generate | gap + paired verb | Generate | attention | "generate from the web app" | GENERATE |
| `QUEUED` / `GENERATING` | queued / generating | in-progress, not a "generate" prompt | "generating — refresh shortly" | **not** attention | "being generated" | NONE |
| `RETRYABLE_FAILURE` | failed + Retry | gap | Retry | attention | "did not complete" | RETRY |
| `TERMINAL_FAILURE` | stopped + class copy | gap, points at Artifacts | Generate iff COMMERCIAL | attention | "open on web for the reason" | GENERATE\|NONE |
| `BLOCKED` | governance explanation | gap | "blocked — reason" | attention | "blocked by governance" | NONE |
| `READY` | version cards + Regenerate | ready | Download ×2 | "Report ready" | Download | REGENERATE\|NONE |

---

## S–X. Journeys

**S. FREE.** Evidence persisted with a real workspace id; TSA attempted once inside finalize; OTS
requested plan-blind; **no** generation request created; report and package `NOT_INCLUDED`; Verify
page fully functional (publication state defaults PUBLISHED, plan-independent); **no** Generate
anywhere; Overview no longer marks paid-output absence as a review deficiency; Cases does not call
it missing; mobile promises no report; Operations opens nothing.

**T. FREE + credit.** Credit consumed at completion inside the transaction (conditional decrement +
unique `evidence_id`); funded record earns report + package + public verify; **no plan mutation**;
no PAYG plan row assigned.

**U. FREE + credit + storage add-on.** Canonical capability permits it; offers render; checkout
gate accepts; settlement writes `WorkspaceStorageAddon`; allowance and growth enforcement pick it up
with no plan check. Ordinary FREE without a grant stays denied.

**V. FREE → PRO → FREE.** Historical evidence becomes `ELIGIBLE_NOT_GENERATED` on the next read; no
automatic bulk generation; Billing states the count and links to Reports; one paired generation
path; no credit consumed; queued/generating/ready coherent; on downgrade the artifacts stay
downloadable (`READY` outranks eligibility) and Regenerate disappears.

**W. TEAM.** The workspace is the commercial subject — the viewer's personal plan can no longer
override it (P2-2). OWNER/ADMIN/REVIEWER generate; CONTRIBUTOR/VIEWER download only; external
reviewers have no artifact route.

**X. ENTERPRISE.** Unchanged, and deliberately so — no audit finding required a change. Suspension
blocks new generation (recoverable, superseded on reactivation) while every existing artifact stays
downloadable; legal hold remains stronger than any commercial permission. **New:** ENTERPRISE is
explicitly excluded from self-service storage add-ons.

---

## Y. Output failure invariants — re-verified, unchanged

Report succeeds + package fails → the request is **not** SUCCEEDED (the job throws
`VERIFICATION_PACKAGE_INCOMPLETE_*`, retryable); the committed report stays downloadable; no false
package artifact. Retry does not re-TSA (now gate-proven repo-wide). Regenerate creates a new
version; prior versions untouched. Lost-enqueue and worker-crash recovery unchanged. The partial
failure harness was not modified.

---

## Z. TSA / OTS proof

TSA: one definition, one caller, zero producers, one positive-status writer (the stored-token
repair, which never contacts the provider). Proven repo-wide, with negative controls on real files.
OTS: untouched by this closure; the initialization reconciler, upgrade ladder and Operations
dispositions are unchanged.

---

## AA. Historical versions / download / authorization

Untouched. `/reports/:version` and `/verification-packages/:version` call the same gate helpers as
`/latest`; no download route consults a plan; `READY` outranks eligibility in the state machine, and
the P2-1 change deliberately withdraws only the *action*, never the state — so ownership survives
where generation does not.

---

## AB. Duplicate sweep (post-implementation)

| Pattern | Result |
|---|---|
| `PLAN_CAPABILITIES.PAYG` | CANONICAL (grandfather resolution) + retained storage-addon arm. **Zero** in any published projection — compile-enforced. |
| `plan === "FREE" && credits > 0` | **zero** across the four commercial files (asserted). |
| `reportReady` / `packageReady` | DISPLAY only. No decision reads them: Cases, Overview, risk signals, the score and mobile all read the canonical state. |
| `_count.reports` | DISPLAY only (case/reviewer snapshots), never an action. |
| `deriveEvidenceOutputState` | one definition; Cases/web assert they do not call it. |
| `"Report missing"` / `"Verification package missing"` | **zero** in `apps/web` and `services/api/src`. |
| local output-state unions | none — mobile imports the shared type. |
| `forceRegenerate` | CANONICAL (derived from availability) + LEGACY decoder that strips it. |

---

## AC. Responsive review (P3-12) — source/CSS level, honestly bounded

**This was a static review of stylesheets and component source, not a runtime measurement.** I did
not boot the API: `services/api/.env` carries live Production credentials and any local boot reaches
Production, which is outside this task's safety envelope (§28).

- **Reports rows** — actions stack full-width ≤ 640px including the `GovernedExportAction` wrapper's
  inner button; `white-space: normal` ≤ 640px and `nowrap` scoped to ≥ 641px, mutually exclusive.
- **Evidence Artifacts** — the new `NOT_APPLICABLE` arm reuses `app-alert`, which is the same
  flow-layout primitive as the other seven arms; it introduces no fixed width, no grid and no
  `nowrap`.
- **Pricing** — the two cells I changed are longer strings in an existing auto-fit grid cell; no new
  layout.
- **Verify page** — the replaced sentence is longer prose in an existing flow container.
- **Billing add-on CTA** — unchanged markup.
- **Mobile** — the replaced control is a `Card` + `Text`, which wrap natively.

**Unverified:** live 320–430px rendering of the Verify page and the artifact history section.
Stated as unverified rather than claimed.

---

## AD. Test results — exact exit codes

| Gate | Result | Exit |
|---|---|---|
| `@proovra/shared` build | ok | **0** |
| `@proovra/shared-billing` build | ok | **0** |
| `@proovra/shared-runtime` build | ok | **0** |
| API `tsc --noEmit` | 0 errors | **0** |
| Worker `tsc --noEmit` (tsconfig.json) | 0 errors | **0** |
| Worker `tsc --noEmit` (tsconfig.build.json) | 0 errors | **0** |
| Web `tsc --noEmit` | 0 errors | **0** |
| Mobile `tsc --noEmit` | 0 errors | **0** |
| **API unit suite** (`vitest run`) | **24 782 passed**, 1 failed, 802 files | **1** ¹ |
| New closure suite | **69 passed** | **0** |
| New TSA repo-wide gate | **10 passed** | **0** |
| `db-preflight-runtime-schema` | **15 passed** | **0** |
| **Worker suite** | **891 passed**, 50 files | **0** |
| **Web suite** (`node:test`) | **3 050 passed**, 0 failed, 4 skipped | **0** |
| **Mobile suite** | **8 passed** | **0** |
| **Web production build** (`next build`) | ok | **0** |
| ESLint — API src (11 files) | clean | **0** |
| ESLint — API new tests (3 files) | clean | **0** |
| ESLint — Worker | clean | **0** |
| ESLint — Web | **NOT RUNNABLE** ² | — |
| `git diff --check` | clean | **0** |
| `pnpm audit:architecture` | `AuditEngineIntegrity = PASS` | **0** |
| API integration project | started, **killed by a 40-min timeout before completion** — see §AO | **124** |

**¹ The one API failure is pre-existing and structural, not caused by these changes.**
`phase-12-point7-closure-gate` requires its scenarios to have been *executed in this run*, and its
proof suites are `*.integration.test.ts` — which `vitest.config.ts` excludes by file suffix
(line 71). A unit-only run can therefore never satisfy it. Proven independent of my changes: all
**18** recorded suite hashes in `docs/architecture/point7-proven-scenarios.json` still match the
current tree (`{match: 18, drift: 0, missing: 0}`), and that artifact is untouched by this work.

**² Web ESLint cannot execute in this environment:** `apps/web/node_modules/.bin` is empty and
`@typescript-eslint/parser` / `eslint-plugin` are not resolvable from the root config — the same
install-state gap that put `tsc` and `next` off PATH there. Pre-existing: I changed no manifest and
no lockfile (`git status` shows zero `package.json` / `pnpm-lock` modifications). The web changes
are covered by `tsc --noEmit` (0 errors), 3 050 node:test assertions and a successful production
build.

**No test was weakened.** Four tests were updated and each is stated here with its reason:

| Test | Change | Why it is not a weakening |
|---|---|---|
| `case-detail-personal-ux` — `summariseDeliverables` | fixture carries canonical `outputs`; a 4th row added | **Strengthened**: the new row (NOT_INCLUDED) is the case the old shape could not express, and the expected `needsAttention` drops 2 → 1 because two of the three were never real work |
| `case-detail-personal-ux` — `deriveNeedsAttention` | fixture carries canonical `outputs` | Order contract unchanged and still asserted; a **new** test added proving an excluded output produces no case work while the integrity item still fires |
| `billing-redesign` — locked-notice copy | pin updated to the corrected sentence | Still a strict match, still asserted on the **server**, which was the original test's point |
| `db-preflight` — message line bound | flat `< 30` → 3 lines per missing object + overhead | Expresses the actual property; still fails if a requirement grows a paragraph |

Four test files had `finalized:` → `record:` migrated by the compiler's demand (P1-3), with no
assertion changed.

No `.skip`, no conditional skip, no allowlist widened without proof, no catch-and-ignore, no sleep,
no Production dependency.

---

## AE. Build results

Web production `next build` completed and emitted the full route table (App Router, middleware
35.9 kB, shared JS 103 kB). All three shared packages and `@proovra/ui` build clean.

---

## AF. Generated proof stability (§27)

Order followed exactly: source edits finished → generator run → freshness gate re-run → generator
run a second time → byte-comparison.

- `pnpm audit:architecture` → exit 0, `AuditEngineIntegrity = PASS`.
- Second run → `architecture-facts.json`, `current-runtime-capability-map.json` and
  `audit-governance-inventory.json` **byte-identical** (md5 diff empty).
- `scripts/admin-ledger/deletion-proof.mjs --markdown` regenerated
  `docs/admin/phase7-deletion-proof.md` (884 → 883 web files, the deleted component) — **byte-identical**
  on a second run.
- No generated proof was hand-edited.

---

## AG. Files changed

50 modified, 1 deleted, 4 added. Full list in the commit.

**Added:** `services/api/test/tsa-no-retry-repo-wide.gate.test.ts` ·
`services/api/test/commercial-output-verify-closure.test.ts` ·
`docs/architecture/legacy-null-workspace-evidence-backfill.md` · this report.

**Deleted:** `apps/web/components/reports-experience/FreeReportsLockedNotice.tsx`.

**Not staged, deliberately:** `docs/admin/audits/FINAL_ADVERSARIAL_E2E_CLOSURE_AUDIT.md`
(pre-existing untracked, unrelated) and the `admin-enterprise-product-audit` generator side-output
(untracked, never tracked, unrelated to this closure).

---

## AH. Migrations authored

**None.** No schema change was required. The two P3-9 declarations describe objects that already
exist and are supplied by migrations already in the tree (`20271113000000`, `20271227000000`). The
P2-1 tenancy repair is documented as an operator-gated script design, deliberately not a migration.

## AI. Production mutation

**NO.** No deploy, no migration applied, no data repair, no backfill, no TSA retry, no report
regeneration, no credit consumed, no checkout, no storage purchase, no object mutation. The API was
never booted locally (it would reach Production credentials). All database work was via
testcontainers.

---

## AN. Remote CI status

**NOT OBSERVABLE** from this environment. No authenticated remote CI surface was reachable, so no
claim is made about the remote run. The local gates in §AD are what was actually executed.

---

## AO. Remaining limitations

1. **Web ESLint not executed** — plugin packages absent from this environment (§AD ²).
2. **Point-7 closure gate not executed** — its proof suites are integration suites excluded from
   the unit project by suffix; zero hash drift proves these changes did not invalidate the artifact.
3. **Live responsive rendering unverified** at 320–430px for Verify and artifact history (§AC).
4. **The legacy null-workspace backfill is designed, not performed** — by decision (§H). The
   product is truthful without it.
5. **The API integration project did not complete.** Docker was available and it was started
   (testcontainers spun up 47+ Postgres containers); it was killed by a 40-minute timeout while
   still running — exit **124**.

   It rewrites `docs/architecture/point5-family-proven-cases.json` as it goes, because that ledger
   records the cases *executed in this run*. The partial rewrite was therefore **restored from
   HEAD** rather than committed: a truncated governed proof artifact would have erased 300 recorded
   cases and silently downgraded nine family proofs to unproven. Verified restored, JSON-valid and
   clean before commit.

   What it leaves uncovered, precisely: the integration project proves the Point-5 and Point-7
   families, and **none of their suites were modified by this work** — all 18 recorded Point-7
   suite hashes still match the tree (`drift: 0`) and the Point-5 ledger is byte-identical to HEAD.
   The changes made here are covered by the 24 782-assertion API unit run, 79 new closure and gate
   assertions, the worker, web and mobile suites, five typechecks and a production build.

   A concurrency hazard worth recording: running the unit project while the integration project is
   live makes the unit run fail spuriously, because the unit suite READS the ledger the integration
   suite is mid-way through rewriting. Observed here as 21 phantom Point-5 failures. The two
   projects must not be run simultaneously.
