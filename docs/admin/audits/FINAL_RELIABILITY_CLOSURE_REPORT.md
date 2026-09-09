# PROOVRA — FINAL EVIDENCE OUTPUT + INTEGRITY RELIABILITY CLOSURE

**Mode:** IMPLEMENTATION. Closes the 4 P1, 9 P2 and P3 findings of
`FINAL_FORENSIC_AUDIT_EVIDENCE_OUTPUT_AND_INTEGRITY.md`.

---

## A. BASELINE / HEAD

| | |
|---|---|
| Baseline (`origin/main` at start) | `92f014fd` — *chore(proof): regenerate the artifacts, and correct two checkpoint scalars* |
| HEAD at report time | `239c0b7a` |
| Branch | `main` |
| Commits ahead of baseline | 15 |
| Schema changed | **NO** |
| Migrations added | **NO** |

The audit's verdict was **SOUND — TARGETED RELIABILITY CLOSURE REQUIRED**, with
**0 P0, 4 P1, 9 P2 and ~12 P3**. Everything below is that closure. No authority
listed in the audit's "already correct, do not rebuild" section was redesigned.

---

## B. P1-1 REPORT RECONCILER

**Old defect.** `reconcileStrandedReportRequests` existed, was correct, and
**had no caller**. `createReportGenerationRequest` commits the durable row and
*then* enqueues; a crash, a Redis outage or a container eviction between those
two effects left a `QUEUED` row that nothing would ever pick up. The customer
saw "generating" forever. The only sweep that ran — `runLifecycleRecovery` —
scans `Evidence.reports: { none: {} }`, so it could not see a stranded
*regeneration* at all: that record already has a report.

**Implementation.** `services/worker/src/lifecycle-recovery.ts` now runs the
reconciler inside its existing tick, and its result type carries
`requestsReenqueued`, `requestLeasesReleased` and `requestsRetired` so the
recovery is observable rather than silent.

**Scheduler.** `services/worker/src/index.ts` →
`startLifecycleRecoveryScheduler()`, `setInterval` at
`LIFECYCLE_RECOVERY_INTERVAL_MS` (default **5 min**), guarded by a re-entrancy
flag and `LIFECYCLE_RECOVERY_ENABLED`. This is production worker source, called
from the boot path — not a script, not a manual runbook.

It is deliberately **not** a new sweep. A registered sweep is a unit of work
with obligations attached; adding one to say "the same tick, five minutes
apart" buys a second thing that can be disabled and a second set of obligations
to keep truthful. All three scans are one responsibility — repair a handoff lost
between a commit and a queue — so splitting them across timers would let a
deployment run half of that repair. `packages/shared/src/queue-integrity/registry.ts`
now names `services/worker/src/lifecycle-recovery.ts` as the reconciler for both
`GENERATE_REPORT` and `UPGRADE_OTS`; before this change that field was untrue.

**Recovery matrix.**

| Stranded shape | Predicate | Repair |
|---|---|---|
| Expired `PROCESSING` claim | `state = PROCESSING AND claimedAtUtc < now − REPORT_CLAIM_LEASE_MS` (15 min) | → `FAILED_RETRYABLE`, claim cleared |
| Artifact exists, terminal write lost | `state IN (PROCESSING, FAILED_RETRYABLE)` with a matching Report row | → `SUCCEEDED` (never re-run: that would duplicate the artifact) |
| Attempt ceiling burned | `state = FAILED_RETRYABLE AND attemptCount >= 12` | → `FAILED_TERMINAL`. Ordered **before** the re-enqueue pass so a retired row is never re-scheduled in the same tick |
| Durable but never scheduled | `state IN (QUEUED, FAILED_RETRYABLE) AND attemptCount < 12` | re-enqueued through the canonical producer |

Convergence rather than collision: the job id is deterministic in the request
id, so a second enqueue collapses onto the first.

---

## C. P1-2 BLOCKED SUPERSESSION

**Old defect.** A request blocked by a condition that later ended was a dead
end. The idempotency key `REPORT:<id>:v0` was already taken by the terminal row,
so every later click collapsed onto it and returned the same refusal. Release
the legal hold, reactivate the organization, let the policy settle — the button
still did nothing, forever.

**Recoverable reasons** (`packages/shared/src/evidence-output-lifecycle.ts`):
`POLICY_VERSION_CHANGED`, `LEGAL_HOLD_ACTIVE`, `ORGANIZATION_NOT_ACTIVE`.

**Non-recoverable reasons:** `WORKSPACE_MISMATCH`, `WORKSPACE_NOT_FOUND`,
`NO_PRINCIPAL`, `EVIDENCE_NOT_FOUND` — these describe the *request*, not the
world, so waiting cannot resolve them.

**Unknown codes answer NOT recoverable.** Supersession is what lets new
generation run; the conservative default is the one that cannot invent
permission.

**Current-state revalidation.** Classification alone would let a stale label
authorize work. `blockerStillActive()` re-reads the world:
`POLICY_VERSION_CHANGED` is never still active (the new request captures the
current version by construction); `LEGAL_HOLD_ACTIVE` asks
`EvidenceLegalHold(evidenceId, status: ACTIVE)` — the *same* predicate the
worker's claim path uses, and deliberately not case-scoped holds, which govern
export rather than generation; `ORGANIZATION_NOT_ACTIVE` resolves the workspace's
Organization and checks `status`. **It fails closed:** any error, and any
unclassified reason, answers "still active" and supersedes nothing.

**Chain head, not base.** The new key is `…:s<headOrdinal + 1>` where the
ordinal is read from the highest existing member of the chain. Reading the base
would mint `:s1` a second time and collide with the unique index — turning a
legitimate retry into a permanent refusal.

**Concurrency.** The new key is itself unique, so three simultaneous
supersessions of one chain produce exactly one live row and every caller is
told about that same row. **Old blocked rows are never mutated** — the refusal
really happened, and it stays readable as the audit record of it.

**Legal Hold's export-blocking policy is untouched.** This change fixes only
the generation-request defect around it.

---

## D. P1-3 OTS INIT RETRIES

**Old swallowed behaviour.** `createOpenTimestamp` has two failure vocabularies.
It *returns* `status: "FAILED"` for failures it can describe — domain facts
about the record, correctly persisted. It *throws* for the rest: binary missing,
no network, calendar timeout — facts about the **deployment**, true of every
record captured during the outage.

`ensureEvidenceOtsInitialized` caught the throw and returned
`initialized: false`. The processor returned normally, so the BullMQ job
**completed successfully on the first transient failure**.
`RETRY_POLICIES.TIMESTAMP_AUTHORITY` grants 20 attempts with exponential
backoff and not one was ever consumed, because nothing threw. A single blip
left the record at `otsStatus = NULL` for the rest of its life — invisible to
Operations, which does not scan NULL.

**New retry behaviour.** `OtsInitializationTransientError` is thrown. It writes
**no OTS column**, so an outage is never persisted as a per-record integrity
failure; the record stays honestly "never attempted" while the queue keeps
trying.

**Attempts / backoff.** `attempts: 20`, `backoff: exponential`,
`backoffDelayMs: 60_000` — the policy that already existed and is now actually
reachable.

---

## E. P1-4 OTS LOST-ENQUEUE RECOVERY

**Old defect.** `requestEvidenceOtsAnchoring` never throws, by design — a
finalized record is finalized whether or not the calendar is reachable, and
failing a completion because a queue was down would trade a durable signature
for a timestamp. But the returned `{requested:false}` was only logged. Nothing
retried. **This is the audit's Critical Question 1, and the honest answer was
NONE.**

**Scheduler.** The same `LifecycleRecoverySweep` tick (5 min).

**Scan predicate** (`neverAttemptedOtsWhere`): `deletedAt IS NULL AND
fingerprintCanonicalJson IS NOT NULL AND otsStatus IS NULL AND otsProofBase64
IS NULL AND createdAt BETWEEN (now − 30d) AND (now − 30min)`.
`fingerprintCanonicalJson` is the content OTS stamps, written by the finalize
transaction — a stronger test than reading `status` because it is the actual
input rather than a label describing it. Both OTS columns must be null: a record
holding proof bytes has entered the lifecycle whatever its status says.

**Aging.** The 30-minute floor is the handoff window — a record finalized
seconds ago is not stranded, it is in flight. The 30-day ceiling matches the
global anchoring budget.

**Bounded by a limit, not a cursor, deliberately.** The population is
self-draining (a record leaves it by acquiring any OTS status), oldest-first, so
the backlog shrinks by a batch per tick until every tick scans nothing. A cursor
would add durable state that can itself be wrong and buy nothing.

**Operations visibility.** `evidence_integrity.ots_initialization_stalled` is a
first-class operational condition with its own probe
(`observeOtsInitializationStalled`), whose recovery test is deliberately the
weakest possible: **any** OTS state resolves it. PENDING resolves it because
the record is now the aged-pending condition's business; FAILED because it is
the ots_failure condition's; ANCHORED and DISABLED because there is nothing left
to want. The source asks one question — did the handoff happen — and stops
asserting itself the moment the answer is yes.

**Not a duplicate writer.** The reconciler calls `enqueueOtsUpgradeJob` with
`delayMs: 0`. It is not a second producer, not a second queue and not a second
state machine; it repairs *scheduling* only.

---

## F. REPORT GENERATE / RETRY / REGENERATE SEMANTICS

Three verbs, one request type, and the distinction is now derived rather than
sent. `GENERATION_INTENTS` names what an actor is *asking for*; `OutputAction`
names what a surface may *offer*. They are the same three words and not the same
thing: the action is a projection the server computes, the intent is a command
the browser sends and **the server re-derives before it acts**.

`resolveForceRegenerate(intent, state)` is the single derivation:

| Intent | `forceRegenerate` | Meaning |
|---|---|---|
| `GENERATE` | `false` | first generation; there is no artifact to overwrite |
| `RETRY` | `false` | the same intent, again; still no artifact |
| `REGENERATE` | `true` | there IS an artifact, and the new one becomes v+1 |

The first Generate is therefore **never** forced regeneration. Retry is
distinct from Regenerate because their baseline versions differ, which makes
their idempotency keys differ (`REPORT:<id>:v0` vs `REPORT:<id>:v3:force`) —
so a retry collapses onto the in-flight attempt while a regenerate mints new
work. Regenerate still produces a new immutable version; nothing overwrites.

---

## G. ARTIFACT VERSION RESERVATION

**Where N is allocated.** `services/worker/src/processor.ts`, inside the
`$transaction`, immediately after the advisory lock and **before any object is
written**:

```
SELECT pg_advisory_xact_lock(hashtext($evidenceId))
reservation = tx.report.aggregate({ where: { evidenceId }, _max: { version } })
reservedVersion = (_max.version ?? 0) + 1
```

**Old defect.** `prepareReportArtifacts` computed `provisionalVersion = max+1`
and built both storage keys from it — *outside* the transaction, before the lock
that serializes generation for the record. The lock protected only the database
work. Two runnable requests at one baseline both held N, and that pair is
reachable: a completion request (`REPORT:<id>:v0`) still retrying when the OTS
upgrade anchors and asks for a forced regeneration (`REPORT:<id>:v0:force`) is
two different idempotency keys, so nothing collapsed them. Both would build,
both would upload to `reports/<id>/vN.pdf`, and only then would the unique index
elect a winner — leaving the object at that key holding the **loser's** bytes
while the surviving row described the winner's. An evidentiary artifact whose
stored bytes are not the bytes its row describes is not a reachable state.

**Locking.** `pg_advisory_xact_lock(hashtext(evidenceId))`, held for the whole
transaction including the artifact uploads, so the second generation waits
rather than racing.

**Storage key.** Re-derived from the reserved number:
`reports/<id>/v<N>.pdf`, `verification/<id>/v<N>.zip`, plus
`identitySnapshot.reviewerSummaryVersion`. Every downstream consumer reads
`prepared.*`, which is re-pointed once before its first use — threading a second
variable through ~30 call sites would have left 30 chances to read the stale one.

**Concurrency proof.** The unique index on `(evidenceId, version)` is a
backstop, not an allocator. Allocation now happens inside the serialized
boundary; Object Lock and the append-only key scheme are unchanged.

---

## H. REPORT/PACKAGE PARTIAL FAILURE

**Request state.** A run that persists the Report and fails to build the
Verification Package no longer reports `SUCCEEDED`. `packageTechnicalFailure`
distinguishes "this plan does not include a package" from "we could not build
one", and only the former is a clean terminal.

**Retry.** The request stays retryable and the reconciler's ordinary ladder
applies; the Report is not rebuilt (it exists), the package converges.

**Incident.** `recordPackageGenerationIncident` raises an operational incident
for the technical failure, so a half-produced output pair is visible to
operators rather than only to the customer.

**Convergence.** Output-pair completeness guards mean the record does not claim
a package version it does not have: `verificationPackageVersion` is written
`null` at Report creation and set only when the package row lands.

---

## I. PACKAGE REMEDIATION

`remediation-registry.ts` keeps `ots_failure: DIRECT_REMEDIATION` and
`tsa_failure: NO_SAFE_REMEDIATION_AUTHORITY`. Package remediation re-enters the
canonical generation path — it does not construct a package by a side door —
so it inherits the version reservation, the Object Lock write and the incident
resolution.

---

## J. PACKAGE VERSION TRUTH

A Report can no longer claim a package version that does not exist.
`verificationPackageVersion` starts `null` and is set from the package row's own
version, which is the reserved N — not the provisional one, and not the report's
version assumed to match.

---

## K. PACKAGE DOWNLOAD STATE TRUTH

The verification-package endpoint answers from the canonical package state
switch, so a **terminal** request is never returned as `202 pending`. The three
questions — is it commercially eligible, is generation in flight, does an
artifact exist — are answered from the three axes rather than from one
overloaded flag.

---

## L. REPORTS PAGE AUTHORITY

`reports-aggregator.service.ts` and `reports.routes.ts` project
`outputs.<report|verificationPackage>.{state, action, terminalReasonClass,
downloadable}`. The Reports page renders `action`; it no longer computes one.

**No second action calculator remains** — see the sweep in AD.

---

## M. TYPED GENERATION OUTCOMES

`GENERATION_REQUEST_OUTCOMES` replaces boolean-ish returns, and
`GENERATION_OUTCOME_MESSAGE` maps each to copy. The specific defect: a queue
outage rendered as "already under way", which tells a customer their work is
progressing when nothing was scheduled.

### M1. GLOBAL OUTPUT ACTION AUTHORITY

**Pre-fix action authorities found (4):**

1. Evidence Detail — local `reportsIncluded && !hasReport` logic.
2. Reports page — its own `canGenerate` / `canRetry` derivation.
3. Evidence library preview — `capabilities.reportsIncluded` gate.
4. AI Copilot — `_count.reports > 0`.

**Post-fix:** all four consume the server's `OutputAction`. The canonical
authority is `deriveEvidenceOutputState` → `outputActionFor` in
`packages/shared/src/evidence-output-lifecycle.ts`. Labels come from one table,
`apps/web/lib/evidence/generation-labels.ts`; which label a surface may show is
still decided by the server.

### M2. EVIDENCE DETAIL ARTIFACTS UX

`ArtifactLifecyclePanel` is a `switch` over `output.state` with **no `default`**,
so TypeScript proves it total over all eight states.

| State | Renders |
|---|---|
| `NOT_INCLUDED` | plan explanation, no control |
| `ELIGIBLE_NOT_GENERATED` | "Generate report & verification package" |
| `QUEUED` | queued status; panel stays visible; no duplicate control |
| `GENERATING` | generating status; no duplicate control |
| `READY` | **the action** — REGENERATE (this was the bug: rendering nothing made the whole regeneration path, confirmation dialog and all, unreachable code) |
| `RETRYABLE_FAILURE` | "Retry report & verification package" |
| `TERMINAL_FAILURE` | terminal explanation |
| `BLOCKED` | governance explanation + action when the server offers one |
| READY + downgraded | server returns `action: NONE` → control disappears, **downloads stay** |
| READY + failed regeneration | v1 stays downloadable; the v2 failure is its own state |

### M3. HEADER DOWNLOAD TRUTH

`reportArtifactAvailable` / `packageArtifactAvailable` were added to the header's
disabled gates, with reason copy from `OUTPUT_STATE_COPY`. **Download is not a
commercial question:** an existing artifact belongs to the customer regardless of
the current plan or the state of any current request.

### M4. EVIDENCE PREVIEW

Old: gated on `capabilities.reportsIncluded`, so a downgraded workspace was told
its report was unavailable *while the report existed and was downloadable*.
New: record-aware — availability comes from the artifact, the offer comes from
the canonical action.

### M5. AI COPILOT

Old: derived the offer from `_count.reports`, which offered "Generate Report" on
a record whose plan does not include one. New: renders the canonical action and
reads the typed outcome through `readGenerationOutcome`, so `enqueued: false`
can never produce a queued-success message.

### M6. CROSS-SURFACE ACTION MATRIX

All four surfaces — Evidence Detail, Reports, Evidence Preview, AI Copilot —
read the same server-computed `action` for the same record. None of them can
offer Generate/Retry/Regenerate authority the others deny.

---

## N. HISTORICAL VERSION DOWNLOADS

Two versioned download routes serve `v<N>` for both artifact types through the
shared `assertArtifactDownloadAllowed` gate — the same governance, tenancy and
anti-enumeration behaviour as the latest-version routes. Reads that *pin* a
version use `where: { evidenceId, version }` and correctly do not order; every
read of "the latest" still orders by `version: desc`, so a delayed regeneration
write cannot freeze a page on v1.

---

## O. MOBILE REPORTS FIX

The Reports index rendered three full-width actions in a dense row; at 320px
that was the source of its horizontal overflow. It uses
`GENERATION_ACTION_LABEL_COMPACT`, whose words are a strict prefix of the
canonical label — a documented compact surface, per R30, not an improvised
rename.

---

## P. OPERATIONS / NOTIFICATIONS

Two new conditions — `evidence_integrity.ots_initialization_stalled` and the
package technical-failure incident — are registered in the operations source
lifecycle with activity probes, so they appear, recover and close like every
other condition. The tenant Operations backlog probes keep their commercial
narrowing (`outputEntitledEvidenceWhere`) and the `isPlanDenial` short-circuit
that keeps a commercial refusal out of the DLQ and the incident bridge.

`observeOtsPendingAged` now binds `ctx.evidenceWhere` like its siblings.

---

## Q. LEGACY `teamId = NULL` GOVERNANCE

**ACCEPTED, NOT CHANGED — and the reason matters.** Both download routes' hold
and export-eligibility gates sit inside `if (evidenceForGate?.teamId)`, so rows
with a null team bypass them.

Personal evidence is written with `team_id = NULL`. Adding a naive `teamId`
requirement to those gates would block downloads for every personal record on
the platform. The correct fix is to resolve the personal workspace and bind the
gate to it — the `workspaceEvidenceWhere` shape used elsewhere — which is a
governance change to hold enforcement, and this task was explicitly told not to
change hold policy. It is recorded here as the follow-up it is.

---

## R. PACKAGE SIGNER PROVENANCE

`manifestSignature.signerKeyId` was read from `process.env.PACKAGE_SIGNING_KEY_ID`
— the key **this host would sign with today**, not the key that signed the
package being described. Identical until the first rotation, after which every
historical package is reported as signed by a key that did not exist when it was
built.

Now `null`. The package *is* signed — that status is a fact about bytes the
worker always writes — and the authoritative key id travels inside the artifact
in `MANIFEST.json.sig`, which is where a verifier looks. Neither UI consumer
reads the field; both read `.status`. Trust Center's claim that
"VerificationPackage signing fields are never mutated when keys rotate" was
corrected: there are no such fields.

Persisting a per-package signer key id is a schema change. Inventing one here
would either backfill historical rows with today's key — the same false claim in
a column — or ship a column null for every existing row. **Deferred to a change
that can migrate and backfill honestly.**

---

## S. P3 CLOSURE TABLE

| # | P3 finding | Disposition | Reason |
|---|---|---|---|
| 1 | Regenerate route's RBAC docblock says REVIEWER lacks `evidence.generate_report` | **FIXED** | `ROLE_PERMISSIONS.REVIEWER` grants it, and MEMBER is not a canonical role. Comment corrected; permission table untouched. |
| 2 | `otsInitializationNeedsUpgrade` cites the wrong degradation rule | **FIXED** | `resolveEffectiveOtsStatus` degrades on missing `anchoredAtUtc`, not on the txid. Behaviour was and is correct; only the citation moved. |
| 3 | OTS processor header describes a "soft ceiling of 10 / `stuck: true`" that does not exist | **FIXED** | Replaced with what is actually there (the 30-day budget) and a pointer to the aging condition it was reaching for. |
| 4 | `observeOtsPendingAged` does not bind `ctx.evidenceWhere` | **FIXED** | Not a leak — the incident was already tenant-scoped — but the file's own stated rule is "a fingerprint is not an authorization". Binding costs nothing. |
| 5 | `manifestSignature.signerKeyId` read from host env | **FIXED** | See R. Now null rather than a false attribution; the durable column is deferred. |
| 6 | `historicalOutputEligibility` counts in-flight and blocked records as "eligible" | **FIXED (in-flight) / ACCEPTED (blocked)** | Live requests are excluded: a record we are generating is not one the customer failed to generate. Held records stay counted — a hold is an export policy, not a commercial ineligibility, and restating a Legal decision as a billing number is out of scope. |
| 7 | The two OTS producers use different default delays | **ACCEPTED — documented** | Not a disagreement. Initialization must not wait (API and reconciler both enqueue at zero); upgrade must (the calendar takes hours). Unifying them would make one phase wrong. |
| 8 | The OTS initialization reconciler is limit-bounded, not cursor-bounded | **ACCEPTED — documented** | The population is self-draining and ordered oldest-first, so it converges; a cursor would add durable state that can itself be wrong. |
| 9 | Platform-admin `evidence-health.service.ts` counts platform-wide with no commercial narrowing | **ACCEPTED** | It is the platform operator's view; narrowing it would hide records from the only role entitled to see all of them. The *tenant* surfaces are narrowed, which is where the audit's concern actually bites. |
| 10 | The grandfather cap is frozen at downgrade and never recomputed downward | **PRODUCT_DECISION_REQUIRED** | Recomputing would silently shrink an allowance a customer was told they keep. That is a commercial promise, not a defect. |
| 11 | `createEvidenceTimestamp` makes an external call inside the finalize transaction while holding the advisory lock | **ACCEPTED** | Real, and a performance concern rather than a correctness one. Moving it restructures the TSA single-shot authority, which this task was told not to redesign. Recorded as follow-up. |
| 12 | Legacy `teamId = NULL` evidence bypasses the governance and export gates on both download routes | **PRODUCT_DECISION_REQUIRED** | See Q. The correct fix binds the gate to the resolved personal workspace, which changes hold enforcement — explicitly out of scope here. A naive `teamId` requirement would break every personal download. |

---

## T. TSA SAFETY

**NO RETRY WAS ADDED. Proven by absence, in four places:**

- No queue, no job name, no `RETRY_POLICIES` entry and no registry entry for a
  TSA re-attempt exists at HEAD.
- No route enqueues one; no button offers one.
- `remediation-registry.ts` still classifies `tsa_failure` as
  `NO_SAFE_REMEDIATION_AUTHORITY` **with a written reason**.
- `createEvidenceTimestamp` is still called exactly once, from finalize, and is
  never contacted again afterwards.

The existing repair path is unchanged: it re-parses **stored bytes** offline
and contacts nothing.

---

## U. OTS COMMERCIAL SEPARATION

**Still plan-blind.** Nothing added in this change consults a plan, an
entitlement or a capability before stamping:

- `neverAttemptedOtsWhere` has no commercial term — it reads `deletedAt`,
  `fingerprintCanonicalJson`, the two OTS columns and `createdAt`.
- The reconciler calls the canonical producer for `UPGRADE_OTS` with no
  commercial input.
- `OtsInitializationTransientError` writes no OTS column and asks no commercial
  question.
- OTS remains outside the report job; the deleted write block stays deleted.

Integrity is what no tier weakens. Report and Verification Package are the
commercial outputs, and the commercial question is asked once, about them.

---

## V. CREDIT SAFETY

**No extra credit consumption.** `EvidenceCreditLedgerEntry` keeps its UNIQUE
`evidence_id` and is still settled inside the completion transaction. Nothing in
this change writes a ledger entry, funds an old FREE record retroactively, or
adds a second funding path.

The consequences fall out of the shape rather than out of rules: a retry cannot
double-charge (the unique constraint), a regeneration cannot charge again (the
record is already funded), and a downgrade cannot un-fund what was funded.

---

## W. DOWNLOAD MATRIX

| Situation | Report PDF | Verification Package ZIP |
|---|---|---|
| Artifact exists, plan includes outputs | **Enabled** | **Enabled** |
| Artifact exists, workspace downgraded to FREE | **Enabled** | **Enabled** |
| Artifact exists, current regeneration failed | **Enabled** (v1) | **Enabled** (v1) |
| Artifact exists, historical version requested | **Enabled** (`v<N>` route) | **Enabled** (`v<N>` route) |
| No artifact, plan includes outputs | Absent — the surface offers Generate instead | Absent |
| No artifact, FREE (`NOT_INCLUDED`) | Absent, and no 404-producing control | Absent |
| Cross-tenant / unknown id | **404**, byte-identical to "missing" | **404** |
| Legal hold active | Governed by the existing export policy — **unchanged by this task** | Same |

Download is independent of the current plan and of the state of any current
request. This is the single most important customer-facing correction in the
release, and it was already correct in the routes; what changed is that the
browser surfaces stopped disabling controls the server was willing to serve.

---

## X. FREE → PRO USER JOURNEY

A historical FREE record with no artifacts, after the workspace upgrades. Each
row is what the customer actually sees, traced from the rendered component
condition rather than inferred from backend capability.

| # | Page | Tab | Canonical state | Visible control | API | Result | Next state |
|---|---|---|---|---|---|---|---|
| 1 | `/evidence/[id]` | Artifacts | `ELIGIBLE_NOT_GENERATED` | **"Generate report & verification package"** | `POST /v1/evidence/:id/report` with `intent: GENERATE` | request row committed, then enqueued | `QUEUED` |
| 2 | `/evidence/[id]` | Artifacts | `QUEUED` | no control; queued status, panel visible | — | worker claims the request | `GENERATING` |
| 3 | `/evidence/[id]` | Artifacts | `GENERATING` | no control; generating status | — | version reserved under the lock, artifacts written | `READY` |
| 4 | `/evidence/[id]` | Artifacts | `READY` | **"Regenerate report & verification package"** + both downloads | `GET …/report`, `GET …/verification-package` | v1 served | `READY` |
| 5 | `/evidence/[id]` | header | `READY` | "Download Report PDF" / "Download Verification Package ZIP" | same routes | v1 served | `READY` |
| 6 | `/reports` | — | `READY` | compact "Regenerate report & package" + downloads | same routes | identical action to row 4 | `READY` |

**First click is GENERATE, not forced regeneration.** `resolveForceRegenerate`
returns `false` for the `GENERATE` intent, so the idempotency key is
`REPORT:<id>:v0` (no `:force`) and the "already REPORTED" guard is not bypassed
— there is nothing to bypass, because there is no artifact.

**No Evidence Credit is consumed.** The record was funded when it was created;
`EvidenceCreditLedgerEntry` has a UNIQUE `evidence_id` and this path writes
none. Generating a report for a historical FREE record after an upgrade charges
nothing, and no wallet balance is retroactively applied to it either.

**On downgrade back to FREE:** rows 4–6 keep both downloads and lose the
Regenerate control, because the server returns `action: NONE` while the
artifacts still exist. Nothing about that decision is made in the browser.

---

## Y. FAILURE-INJECTION RESULTS

Legend: **BEHAVIOURAL** = executed against live PostgreSQL 16;
**CONTRACT** = source/type-level proof; **PRE-EXISTING** = already covered by a
suite that predates this change.

| # | Scenario | Method | Result |
|---|---|---|---|
| R1 | finalize succeeds, OTS queue unavailable | BEHAVIOURAL — `family-evidence-finalization.integration.test.ts` (`the finalized record is the durable intent…`, `a record still inside the handoff window is left alone`) | **PASS** — evidence stays SIGNED, no fake OTS FAILED, the sweep finds it, the canonical job is queued |
| R2 | OTS initialization throws | BEHAVIOURAL — `a transient stamp failure consumes an attempt instead of reporting success` | **PASS** — the throw propagates; the job does not complete successfully on the first transient failure |
| R3 | repeated OTS initialization failures | BEHAVIOURAL (recovery) + CONTRACT (aging window) | **PASS** — no permanent invisible NULL; the sweep keeps seeing the record; `ots_initialization_stalled` is registered with an activity probe that auto-resolves on any OTS state |
| R4 | report request row persists, enqueue fails | PRE-EXISTING BEHAVIOURAL — report-authority case 23/24 | **PASS** |
| R5 | regeneration request persists, enqueue fails | BEHAVIOURAL — new `report-generation-supersession-recovery.integration.test.ts` | **PASS** — recovered, still QUEUED, still `forceRegenerate: true` |
| R6 | PROCESSING lease expires | BEHAVIOURAL — new suite + PRE-EXISTING case 21 | **PASS** — the dead claim is released, a live one is not stolen |
| R7 | retry budget exhausted | BEHAVIOURAL — new suite | **PASS** — retired to `FAILED_TERMINAL` and not re-enqueued in the same pass |
| R8 | `policy_version_changed` | BEHAVIOURAL — new suite | **PASS** — old row immutable, `:s1` minted, one logical request under concurrency |
| R9 | `legal_hold_active` | BEHAVIOURAL — new suite | **PASS** — first Generate is not Regenerate semantics; an ACTIVE hold is not superseded and reports `terminalIsRecoverable: true`; once released the same click works |
| R10 | organization reactivated | CONTRACT — `blockerStillActive` resolves Organization status; classification proven behaviourally alongside R8 | **PASS** |
| R11 | non-recoverable blocked reason | BEHAVIOURAL — new suite | **PASS** — never bypassed, three attempts, one row |
| R12 | two concurrent requests, different keys | BEHAVIOURAL (allocation under `pg_advisory_xact_lock`) + CONTRACT (append-only key assertions) | **PASS** — allocation is inside the serialized boundary; no shared version, no shared final key |
| R13 | Report persists, Package build fails | CONTRACT — `packageTechnicalFailure` + output-pair guards | **PASS** — not falsely SUCCEEDED; recovery converges |
| R14 | Report exists, package missing | CONTRACT — remediation registry + canonical generation path | **PASS** |
| R15 | package upload succeeds, DB persistence fails | CONTRACT — `verificationPackageVersion` written only from the package row | **PASS** — no false package availability |
| R16 | historical version download | CONTRACT — two versioned routes through the shared gate; `phase-ia-forward-path` pins that pinned reads do not order and latest reads do | **PASS** |
| R17 | package endpoint, terminal request | CONTRACT — canonical package-state switch | **PASS** — terminal never returned as 202 |
| R18 | Reports action == Evidence Detail action | CONTRACT — both render the server's `action` | **PASS** |
| R19 | generation result reason mapping | CONTRACT — `GENERATION_OUTCOME_MESSAGE` | **PASS** — queue unavailable is no longer "already under way" |
| R20 | legal-hold / cross-tenant / versioned-download negatives | PRE-EXISTING BEHAVIOURAL — anti-enumeration 404 suites | **PASS** |
| R21–R30 | UX/action-authority scenarios | CONTRACT + render tests | **PASS** — the total `switch`, the four converted surfaces, and the label table (with the one documented compact surface) |

---

## AD. DUPLICATE-AUTHORITY SWEEP

**No duplicate Report, Package or OTS authority was created.** Every fix
extended an existing authority or gave an existing one a caller.

| Question | Authority | Callers |
|---|---|---|
| What may a surface offer? | `deriveEvidenceOutputState` → `outputActionFor` (`packages/shared/src/evidence-output-lifecycle.ts`) | 3 server projections: `evidence-artifact-status.service.ts`, `reports-aggregator.service.ts`, `reports.routes.ts`. **Zero browser derivations.** |
| Is this intent a forced regeneration? | `resolveForceRegenerate` | the API route only; the worker reads the durable row |
| May a worker claim this request? | `resolveAndClaimReportRequest` (`state notIn TERMINAL`) | the worker only |
| Has this blocker ended? | `blockerStillActive` | the durable writer only |
| Which request states are live? | `IN_FLIGHT_REPORT_REQUEST_STATES` + its complement | billing count; the worker's claim uses the complement, and a contract test pins that the two partition the persisted union exactly |
| Who writes OTS columns? | `buildOtsEvidenceUpdateData` (`ots-state.ts`) | initialization and upgrade — two phases, one writer |
| Who enqueues OTS work? | the canonical `UPGRADE_OTS` producer | API authority, worker follow-up, reconciler. One job id (`ots-upgrade-<evidenceId>`) so all three collapse onto one unit of work |

**Verified by sweep at HEAD:**

- `_count.reports` as an action source: **0 occurrences** (one mention, in the
  comment recording its removal).
- Surviving `reportsIncluded` reads on evidence surfaces: **2**, both correct —
  one is the *fallback* branch after availability has already been asked
  (`QueueSelectionPreview`), the other is a polling heuristic OR'd with
  availability (`shouldPollArtifactReadiness`). Neither disables a download and
  neither computes an action.
- TSA retry producers: **0**.

---

## AE. FILES CHANGED

**65 files, +58,616 / −1,670.** Excluding generated artifacts (`audit-output/`,
`docs/`, machine-written JSON): **51 files, +4,725 / −390.**

| Area | Files |
|---|---|
| `services/api` | 24 |
| `apps/web` | 15 |
| `docs` | 8 (this report, the forensic audit, the button matrix, generated maps) |
| `services/worker` | 7 |
| `packages/shared-runtime` | 4 |
| `audit-output` | 4 (machine-generated) |
| `packages/shared` | 3 |

**Schema:** unchanged. **Migrations:** none added.

---

## Z. TEST RESULTS

### The full integration project — 111 suites, live PostgreSQL 16

The first complete run at this change came back **2 failed / 109 passed
(1,775 tests passed, 2 failed)**. Both failures were mine, and both were suites
that had been passing *for the wrong reason*:

**1. `ots-integrity-lifecycle` — "an outage leaves the record never-attempted".**
The case called a local helper that swallows the processor's declared retry
signal, then asserted the OTS columns were null. That assertion was true for two
opposite reasons: the right one (we must not invent a per-record integrity
failure out of a deployment-wide outage) and the wrong one (nothing was ever
going to try again). The case could not tell them apart — which is precisely how
the swallowed initialization failure survived a suite written to cover it.

It now asserts the throw, because the throw is the only thing that makes BullMQ
consume an attempt and schedule the backoff. Renamed to say so. **12/12 green.**

**2. `operations-convergence` — "reconciliation contacts no TSA provider and
mutates no token".** A source-text guard matched `(update|create|upsert)` as a
bare substring within 200 characters of a forbidden field name. **The word
"create" is inside "createdAt"** — so the ordinary `createdAt: { lte: ... }` in
my new OTS scan's WHERE clause, sitting near `otsStatus: true` in the following
SELECT, read as a write of an integrity column.

The invariant is unchanged and worth keeping; the pattern now names an actual
Prisma mutation (a dot, the verb, an optional `Many`, an open paren).
`createdAt` cannot match that and `client.evidence.update(` still can. A guard
that fires on a field name is a guard someone eventually silences. **12/12
green.**

### The new behavioural suite

`services/api/test/report-generation-supersession-recovery.integration.test.ts`
— **11/11 green**, and it earned its place immediately: see the defect below.

It records no proof and claims no family credit, deliberately. The governed
Point-5 suite is keyed by file SHA and by a single shared run id, so appending
cases to it discards the recorded proof for nine families and forces a full
re-run to restore them.

### The defect the new suite found

`createReportGenerationRequest`'s deduplicated path **selected
`terminalReasonCode` from the database and left it out of the object it
returned.** The API service decides between two customer-facing answers with
`isRecoverableBlockedTerminalReason(persisted.terminalReasonCode ?? null)`, and
`null` classifies as not-recoverable.

So a record blocked by an **ACTIVE legal hold** — a condition that lifts the
moment someone releases it — was reported as `TERMINAL`: *"the previous
generation attempt stopped and cannot be retried in its current state."* The
truthful answer is `RECOVERABLE_BLOCKED`: *"it becomes possible again when the
block is lifted."* The person most affected is the one who can fix it. One field
read and discarded turned a self-service unblock into a support ticket.

Only the deduplicated path was wrong; a freshly created row is `QUEUED` and
genuinely has no terminal reason.

### The API unit project

**24,566 tests. 8 failures across 9 files on the first pass — every one mine.**

- **6 were artifact staleness** (`phase-0-audit-engine-governance`,
  `phase-12-capability-analyzer-adversarial`, `phase-12-closure-gate`,
  `phase-12-coverage-manifest`, `phase-12-route-consumer-authority`,
  `phase-12-wiring-registry`, `phase-12b-evidence-operations-entry-matrix`) —
  the canonical audit artifacts had not been regenerated since the source
  changed. That is what GATE 7 is for. After regeneration: **178/178 green.**

- **2 were real contract breaks** from the label consolidation.
  `phase-g3-2-final-live-operations-closure` and `phase-g5-smoke-contracts`
  matched the literal `actionLabel="Download Report PDF"` in `ReportsIndex`. The
  invariant they protect — both downloads inside `GovernedExportAction`, because
  a download outside it skips the governance gate — was never broken. The
  *method* broke: pinning a vocabulary discipline to one file's spelling of it is
  the one way of checking it that cannot see the actual failure, which was four
  surfaces having drifted to four spellings. They now assert the surfaces read
  the shared constants, and one test pins what those constants say.
  **110/110 green.**

### The Point-5 family proof gate

**17/17 green.** The artifact carries **14 suites, ONE runId, ONE binding, 300
proven cases** — compared case-for-case against `origin/main`: **none lost, none
gained.**

This also closes a **pre-existing** defect: the artifact on `origin/main`
carried records from *two* different runs.

---

## AA. TYPECHECK / LINT / BUILD

| Check | Result |
|---|---|
| `tsc --noEmit` — `services/api` | **exit 0** |
| `tsc --noEmit` — `services/worker` | **exit 0** |
| `tsc --noEmit` — `apps/web` | **exit 0** |
| `pnpm -r lint` (9 projects) | **exit 0** — 1 problem, **0 errors**, 1 warning |
| `pnpm -C services/api run build` | **exit 0** |
| `pnpm -C services/worker run build` | **exit 0** |
| `pnpm -C apps/web run build` (`next build`) | **exit 0** — compiled successfully |

The single lint warning is `react-hooks/exhaustive-deps` at
`apps/web/components/surface/SurfaceGate.tsx:163`. **Pre-existing and untouched
by this change** — that file's last commit is `b618342c`, which is not in this
range.

The worker build is the real one (`tsconfig.build.json`), not the permissive
typecheck config: `services/worker/tsconfig.json` has no `rootDir`, so a
cross-service import typechecks clean while the build and the Docker image fail.

### GATE 7 — the audit engine

| | |
|---|---|
| `pnpm audit:architecture` | regenerated 5 artifacts, 1,142 routes, 352 audit files inventoried |
| `--engine-check` | **PASS, exit 0** |
| `--closure-check` | **PASS, exit 0** — `ReleaseBlockingClosure: PASS`, `ArchitectureBacklog: EMPTY`, `undisposedRoutes: 0` |

The engine check failed the first time on `UnreviewedOriginConsumers = 1`, and
the cause was a mistake earlier in this same change. The worker's demo-request
follow-up fetch had been re-anchored in
`capability-authority/manifests/origin-resolutions.json` from `:438` to `:440`,
on the expectation that the OTS initialization reconciler's import would land
above it. **That import went into `lifecycle-recovery.ts` instead**, nothing
above the call moved, and the `:440` anchor pointed at no call site — so the
review it carried stopped counting.

The site is back at `:438`, re-read there, verdict unchanged. The wrong anchor
is recorded in the evidence field rather than quietly reverted: a manifest keyed
by `file:line` is only worth having if a bad anchor is corrected out loud. That
entry's history is now four re-anchors deep, and mine is the only one that
invalidated a review for a change that never happened.

---

## AB. CLEAN-DB

**NOT RUN.**

**Exact reason:** the instruction was to avoid the Clean-DB gate unless schema,
migrations or bootstrap changed. Verified mechanically over the whole commit
range rather than asserted — filtering the changed-file list for `migration` and
`schema.prisma` returns nothing.

No `schema.prisma` change, no migration directory touched, no bootstrap or seed
path modified. Every change is application logic, projections, comments and
tests. A Clean-DB boot would have proven nothing the live-PostgreSQL integration
project did not already prove against the same schema.

---

## AC. MIGRATIONS

| | |
|---|---|
| Added | **NO** |
| Applied | **NO** |
| Why | Nothing in this closure needs a column. |

The one place a column was genuinely wanted — a durable per-package signer key
id, so `manifestSignature.signerKeyId` could name the key that actually signed
each Verification Package — was **deferred rather than improvised**. Adding it
here would have forced a choice between backfilling historical rows with today's
key (the same false claim, now in a column) and shipping a column that is null
for every existing package. Both belong to a change that can migrate and
backfill honestly. Until then the API says `null`, which is true, and the
authoritative key id travels inside the artifact in `MANIFEST.json.sig`.

### The final full integration pass, at final HEAD

Because source changed after the first complete run, the whole project was run
again rather than claiming the earlier run covered it.

**112 files, 111 passed, 1,763 tests passed, 25 skipped.**

The one non-pass was infrastructure, not product:
`phase13-public-write-bounds` lost its testcontainer during setup —
`(HTTP code 409) container stopped/paused ... is not running` — so all 25 of its
tests skipped rather than ran, after six hours of continuous container churn on
this host. A skipped suite is not a passing suite, so it was re-run in isolation
rather than written off: **25/25 green.** It is not one of the 14 recording
suites, so the proof artifact was untouched by that re-run.

---

## AD-2. FINAL NUMBERS

| Gate | Result |
|---|---|
| Integration project (112 files) | **111 passed**, 1 container flake, re-run **25/25 green** |
| API unit project | **24,566 tests green** after the 8 fixes |
| Point-5 family proof gate | **17/17**, 14 suites, **one runId** `b10a202b`, 300 cases |
| `tsc --noEmit` × 3 | **exit 0** |
| `pnpm -r lint` | **exit 0**, 0 errors, 1 pre-existing warning |
| Production builds × 3 | **exit 0** |
| `audit:architecture --engine-check` | **PASS, exit 0** |
| `audit:architecture --closure-check` | **PASS, exit 0** |

---

## AF. COMMITS

19 commits, oldest first.

| # | SHA | Subject |
|---|---|---|
| 1 | `bba2b498` | fix(integrity): make OTS initialization durably recoverable |
| 2 | `4f0bc9d5` | fix(worker): schedule report-request and OTS reconciliation |
| 3 | `82bd5f05` | fix(reports): recover resolvable blocked requests |
| 4 | `473b1dee` | fix(reports): serialize version allocation and converge partial generation |
| 5 | `dcb9f6cc` | fix(api): derive regeneration intent, type generation outcomes, serve history |
| 6 | `5710ee47` | fix(web): make Evidence Detail render the canonical output lifecycle |
| 7 | `471b1ccc` | fix(web): one output-action authority across every surface |
| 8 | `8fcd705c` | fix(operations): make the two new conditions visible and provable |
| 9 | `56cf3392` | fix(proof): restore the proven-cases artifact |
| 10 | `91eec824` | fix(worker): recover both halves of finalization in one sweep |
| 11 | `856babc8` | fix(api): stop attributing today's signing key to older packages |
| 12 | `fc7a56db` | fix(billing): a record we are generating is not one you have not generated |
| 13 | `842d7bb0` | fix(api): bind the aged-pending probe to the workspace, like its siblings |
| 14 | `623f5fb4` | docs: correct four notes that described code which is not there |
| 15 | `239c0b7a` | docs(worker): the reconcilers are not separate, say so |
| 16 | `7c08e8e8` | fix(reports): a lifted-able block is not a dead request |
| 17 | `8486743a` | test(web): assert the download labels through the shared table |
| 18 | `f3cae617` | chore(proof): regenerate the architecture artifacts, and un-move an anchor |
| 19 | `2cb41757` | chore(proof): re-record the Point-5 family proof from one run |

Commit 9 (`56cf3392`) is a repair of my own error: a `git add -A` during a
mid-flight integration run captured a partially-written proof artifact with six
suites zeroed. Restored byte-identically from `origin/main`. Recorded rather
than rebased away, because the artifact is a governed proof and its history
should show when it was briefly wrong.

**70 files changed, +59,260 / −1,688.** Excluding machine-generated artifacts:
roughly 51 files, +4,700 / −390.

---

## AJ. PRODUCTION BOUNDARY

> **Production deployed: NO**
> **Production migrations applied: NO**
> **Production data changed: NO**
> **Historical OTS reconciliation executed on Production: NO**

Nothing in this change touched a Production system. No deploy command was run,
no migration was applied anywhere, no Production database was read or written,
and the OTS initialization reconciler has never been executed against Production
data — it exists, it is scheduled in worker source, and it has run only against
disposable PostgreSQL 16 containers in the integration project.

The local API's `.env` holds live Production credentials, so any local API boot
would reach Production. No API was booted outside the test harness, which
overrides `DATABASE_URL` to its own container before anything reads it.

`git push` targets `origin main` only. No force push, no branch deletion, no tag
movement, no history rewrite.

---

## DEFINITION OF DONE

| | Item | Evidence |
|---|---|---|
| ✅ | Report reconciler is actually scheduled in production worker source | `index.ts` → `startLifecycleRecoveryScheduler()`, 5-min interval, calls `runLifecycleRecovery` → `reconcileStrandedReportRequests` |
| ✅ | Queued report requests lost before Redis enqueue are automatically recovered | reconciler stage 4; integration case 23/24 |
| ✅ | Regeneration requests are covered by recovery | **R5**, new suite — recovered, still QUEUED, still `forceRegenerate: true` |
| ✅ | Expired PROCESSING leases are recovered | **R6**, new suite — dead claim released, live claim not stolen |
| ✅ | Report retry budget reaches truthful terminal state | **R7**, new suite — retired at 12 attempts, not re-enqueued in the same pass |
| ✅ | Recoverable BLOCKED requests can be superseded after blocker removal | **R8/R9b**, new suite — `:s1` minted once the hold is released |
| ✅ | Non-recoverable blocks cannot be bypassed | **R11**, new suite — three attempts, one row; unknown reasons fail closed |
| ✅ | Old blocked requests remain immutable history | **R8** asserts the prior row's state and reason are untouched |
| ✅ | First Generate is NOT forced regeneration | `resolveForceRegenerate(GENERATE) === false`; key has no `:force` |
| ✅ | Retry semantics are distinct from Regenerate | different baseline version → different idempotency key |
| ✅ | Regenerate still creates a new immutable version | version reserved under the lock; `report.create`, never `update` |
| ✅ | OTS transient initialization failures actually retry | **R2** — the throw is asserted; 20 attempts now reachable |
| ✅ | OTS lost enqueue automatically recovers | **R1** — sweep finds it, canonical job queued |
| ✅ | Aged OTS NULL is operationally visible | `ots_initialization_stalled` registered with an activity probe |
| ✅ | OTS NULL condition auto-resolves | any OTS state resolves it, deliberately the weakest test |
| ✅ | No duplicate OTS writer | one state machine (`buildOtsEvidenceUpdateData`), one queue, one job id |
| ✅ | **No TSA retry** | no queue, job, policy, route or button exists; `NO_SAFE_REMEDIATION_AUTHORITY` intact |
| ✅ | TSA repair semantics unchanged | still re-parses stored bytes offline, contacts nothing |
| ✅ | Artifact version is reserved before final storage upload | inside `pg_advisory_xact_lock`, before any `putObjectBuffer` |
| ✅ | Two concurrent generations cannot share final version/key | allocation moved inside the serialized boundary |
| ✅ | Object Lock preserved | `applyRetentionOrThrow` → `headObject` read-back untouched |
| ✅ | No old artifact overwrite | version-scoped keys; no `update` against an existing artifact row |
| ✅ | Report cannot claim nonexistent package version | `verificationPackageVersion` starts null, set only from the package row |
| ✅ | Report+Package partial failure has automatic convergence | `packageTechnicalFailure` + retryable request + reconciler |
| ✅ | Package technical failure is visible operationally | `recordPackageGenerationIncident` |
| ✅ | Package remediation actually works | re-enters the canonical generation path, inheriting reservation and Object Lock |
| ✅ | Verification-package endpoint never reports terminal work as pending | total switch over all 8 states; 202 only for QUEUED/GENERATING |
| ✅ | Reports page consumes canonical state/action | renders the server's `action`; computes none |
| ✅ | Evidence Detail and Reports show same action for same record | both read one server-computed projection |
| ✅ | No dead Report-page Generate/Retry controls | READY renders its action; the regeneration path is reachable |
| ✅ | Queue outage is not shown as "already under way" | `QUEUE_UNAVAILABLE` is its own outcome with its own copy |

**One item is worth reading twice.** "Recoverable BLOCKED requests can be
superseded" and "the customer is told the truth about them" are different
claims, and the second one was false until the last commit but one: the
deduplicated path dropped `terminalReasonCode`, so a liftable legal hold was
reported as a dead request. The Definition of Done did not ask about that, and
it would have been ticked honestly and wrongly if the new behavioural suite had
not been written.

---

## VERDICT

**CLOSED.** 4 P1, 9 P2 and the P3 set are dispositioned — fixed, accepted with a
written reason, or referred as a product decision (see S). Two items are
explicitly deferred and named: a durable per-package signer key id (needs a
migration), and binding the download governance gates for legacy
`teamId = NULL` records (changes hold enforcement, which was out of scope).

Neither the TSA single-shot authority, the OTS plan-blindness, the credit
ledger, Object Lock, tenant containment, nor Legal Hold's export policy was
altered.

---

## AG. FINAL SHA

`e34d450a7f948f792b2ed187407a2c5b06ba77f2` (`e34d450a`)

## AH. PUSH

Pushed to `origin main`, fast-forward, no force:

    92f014fd..e34d450a  main -> main

`git rev-list --left-right --count origin/main...HEAD` → **`0  0`**

## AI. GIT STATUS

`git status --porcelain` → **empty**. Clean tracked tree, nothing untracked,
nothing stashed.
