# PHASE 12 — POINT 5 (QUEUE + WORKER INTEGRITY): CONVERGENCE PASS — 2026-08-04

**STATUS: VERIFIED CLOSED.** See the final section — every requirement of the
original contract is measured, and the outstanding list is empty.

The sections below are kept in the order they were written, including the
intermediate states where a metric was demoted or a claim withdrawn. That
sequence IS the evidence: a number that only ever went up would not be one.

---

## 1. What changed in production code

### 1.1 The canonical envelope gained a bounded `traceparent`

Converging fifteen producers onto `enqueueCanonicalJob` would have silently
deleted the `_otel` job-data carrier every one of them injected, ending
api-request-to-worker-handler distributed tracing. Rather than accept that
regression, the envelope now carries a W3C `traceparent`, validated by SHAPE —
a malformed value is a rejection, not a pass-through. The worker's extractor
reads BOTH the new field and the legacy `_otel` blob, so jobs already sitting in
Redis keep their traces while they drain.

### 1.2 `ReportGenerationRequest` wired end to end

`forceRegenerate` — the flag that lets a run overwrite a finalised evidentiary
artifact — was an unverified boolean on a BullMQ payload. Anything able to write
to Redis could set it. It is now persisted on a durable request row by the
authorized synchronous path, and the queue carries only that row's id.

| Piece | Module |
|---|---|
| ONE writer (both services call it, neither owns it) | `packages/shared-runtime/src/reports/report-generation-request.ts` |
| api producer | `services/api/src/services/reports/report-generation-authority.service.ts` |
| worker resolve / claim / terminal / reconcile | `services/worker/src/report-generation-authority.ts` |
| processor entry point | `services/worker/src/processor.ts` (`processGenerateReport`) |

The idempotency key is anchored on the artifact version the request advances
PAST (`REPORT:<id>:v3:force`), so two concurrent regenerate clicks collapse to
one row while a later legitimate regenerate still gets its own — a key without
the version would make the second click a silent no-op, and a key with a
timestamp would produce two reports.

Refusals implemented, each written terminally BEFORE any storage write:

* **replay** — a terminal request returns its stored result; no second artifact,
  no second completion event;
* **stale** — recorded policy version no longer matches the workspace's current;
* **scope** — request workspace disagrees with the evidence row's workspace;
* **lifecycle** — owning organization is not ACTIVE;
* **legal hold** — an ACTIVE hold blocks a REGENERATION (which replaces
  preserved material); first generation is not blocked, because there is nothing
  yet to preserve;
* **lost claim** — the claim is a conditional UPDATE, so two workers racing
  produce one winner and one bounded no-op.

Legacy drain: a pre-Point-5 job names an evidence id, and is minted into a
request with `forceRegenerate: FALSE`. A draining payload cannot escalate its
own privileges by surviving in a queue.

`reconcileStrandedReportRequests` covers all four stranded shapes: committed but
never enqueued, expired claims, completed artifact with no terminal request
state, and terminal rows protected from stale overwrite.

### 1.3 Payload-trusted tenancy removed from every processor

`derived-assets`, `media-intelligence` and `mi-embed` destructured `teamId` off
the wire and used it to scope reads, writes, AI-policy lookups and
per-workspace SPEND gates — meaning the tenant CHARGED for a provider call was
whichever one the message named. All three now load a durable row and derive the
workspace from it. The gate's `NOT_YET_CONVERGED` allowlist is **deleted**, not
emptied by convention.

### 1.4 All 17 BullMQ chains on one enqueue authority and one strict decode

`services/worker/src/queue.ts` lost twelve private enqueue helpers, twelve
job-id builders, fifteen inline retry policies and `genericIdempotentEnqueue`.
The api lost `report-queue.ts` entirely and gained
`services/api/src/queue/canonical-queue-client.ts` as its single transport
client. `packages/shared/src/report-queue.ts` is deleted.

---

## 2. Production defects found and fixed

1. **`enqueueMediaIntelligenceAnalysis` accepted an OPTIONAL `runId`**, and
   `evidence-finalization-fanout.service.ts` called it with none. Those jobs ran
   with no run row to record state on — invisible to operators, unrecoverable by
   any reconciler. The run row is now mandatory.
2. **Three drifted definitions of the media-intelligence kind catalog** (api
   producer, worker branch set, `run-tracker.service.ts`). The tracker's list
   was missing four kinds the worker implements and a producer enqueues, which
   is *why* `runId` had become optional. Now one list.
3. **The text-similarity promotion path was unreachable.** It was gated on an
   optional `textKind` payload field that no producer anywhere set. Preserved
   rather than deleted: it is now two bounded run kinds.
4. **`graph-reconcile`'s "deterministic" job id discriminated on `reason` and
   `evidenceId`**, neither of which the job reads. Completing three records in a
   workspace produced three identical full rebuilds. Now one live job per
   workspace.
5. **`graph-domain-sync`'s domain filter was an unvalidated payload field** — an
   unknown value produced a job that completed as a silent no-op. It is now
   encoded in the command id against a closed catalog, validated before any
   database access.
6. **`mi-embed` re-embedded chunks already embedded** between enqueue and
   execution, spending provider budget on completed work. The batch is now
   selected from current state.
7. **OTS had two stable job ids** (`ots-upgrade-<id>` and
   `ots-upgrade-followup-<id>`) with separate attempt budgets, both runnable at
   once. Now one.
8. **A regression introduced during this pass and then fixed**: collapsing the
   OTS self-reschedule onto the caller's own active job reproduced the original
   production incident (evidence stuck OTS-PENDING with an empty queue). Fixed
   via `selfJobId` on the shared authority, with behavioral proofs for both the
   self-reference path and the parallel-producer path.

---

## 3. Registry corrections

* **`EXTRACT_EXIF`**: `MediaIntelligenceRun` → `EvidencePart`. The entry said
  the job "shares the media-intelligence processor by design" — that sharing WAS
  the defect: one function served two queues whose commands meant different
  things, so the payload had to carry both a run id and a part id and trust
  whichever was present.
* **`GENERATE_DERIVED_ASSET`**: `MediaIntelligenceRun` →
  `EvidencePartDerivedAsset`, the row that actually models the work and already
  carried the right unique index.

---

## 4. Verified state at this commit

| Check | Result |
|---|---|
| `@proovra/shared` build | clean |
| `@proovra/shared-runtime` build | clean |
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| Point-5 closure gate | **57 / 57 green** |
| Worker suite | **848 / 848 passed, 47 / 47 files, 0 skipped, 0 todo** |
| API suite | **21,315 / 21,315 passed, 634 / 634 files** |

The closure gate gained five assertions and lost its allowlist:
payload-trusted tenancy / policy / storage all measured at 0; every registered
processor proven to reach the strict decoder; no module outside the shared
authority may declare a queue or job name.

Eight worker source-regex test files were rewritten onto registry or behavioral
assertions rather than deleted, so every guarantee they encoded survives.

---

## 4b. Second pass — red-tree recovery, legacy classification, gate hardening

### Phase A: the 50 API failures, classified and closed

Every failing assertion was classified individually. The counts:

| Classification | Count | Disposition |
|---|---|---|
| `STALE_SOURCE_PIN` | 41 | Rewritten against the registry or the live value |
| `STALE_FIXTURE` (byte pins) | 5 | Rebaselined 48,348 → 47,556 with recorded rationale |
| `STALE_MOCK_SEAM` | 2 | Re-pointed at the new collaborator |
| `REAL_PRODUCTION_REGRESSION` | 2 | Fixed in production code first |

**API suite: 21,315 passed / 634 files / 0 failed.**

Two of the fifty were not stale at all:

1. **`media_intelligence_runs_kind_bounded` rejected five job kinds the worker
   implements.** The CHECK constraint enumerated eight while twelve were
   reachable. `compute_perceptual_hashes`, `extract_ocr_azure`,
   `extract_transcript_deepgram` and `extract_technical_metadata` were all
   enqueued by real producers and all refused by the database, so a run row
   could not be created for them. **This is the root cause behind the optional
   `runId`** found in the first pass: the producer could not create the durable
   row, so it was allowed to proceed without one. Fixed by migration
   `20271114000000_point5_media_intelligence_kind_catalog` (strict superset) plus
   a matching drift patch. The drift-patch absorption guard was widened from
   "absorbed by the 2026-06 consolidation" to "absorbed by SOME migration" — the
   narrow form would have pushed the next author to backdate a patch into a
   migration already applied in production.

2. **The evidence-purge processor still parsed the retired Phase-X.1 envelope**
   while its producer had already been converged. Those two no longer agreed, and
   the parser was TOLERANT — for a hard-delete job that means a malformed or
   tampered payload gets repaired into a runnable destruction command. Now on the
   strict decoder.

### Phase B: worker test count reconciled

`856` **cannot** be reproduced from any verifiable same-boundary snapshot — no
JSON report, runner log or census artifact was ever preserved, and the tree was
uncommitted. It is now classified `HAND_REPORTED_ONLY / NON_AUTHORITATIVE`.

It is also not reproducible *in principle*: several worker suites generate one
assertion per queue or per call site (`phase-final-worker-visibility` iterates 17
queue names), so a raw total is a function of the tree and two totals are not
comparable by subtraction.

**New authoritative baseline**: `docs/architecture/worker-test-census.json` —
47 files / 848 tests / 0 skipped / 0 todo, per file, regenerable via
`services/worker/scripts/build-test-census.mjs`.

Structural delta attributable to Point-5 test rewrites, measured against git
HEAD: `phase-ia-ots-forward-retry-lifecycle` −6, `phase-o1-4-span-emission` +4,
`subsystem-queues` −1 = **−3 static cases**, every one re-expressed as a
behavioral assertion in the closure gate. `LostBehavioralTests = 0`.

### Phase C: all thirteen changed payload shapes classified

`UnclassifiedLegacyJobShapes = 0`. Seventeen adapters, each with old schema,
owner, backlog command, drain command, retention bound and removal condition.

* **16 `adaptable`** — the old payload contains a durable entity id. The adapter
  extracts it and discards every tenant/policy/storage field by construction.
* **1 `quarantine`** — `GenerateDerivedAsset`. Its old payload has no id for an
  `EvidencePartDerivedAsset` row, and `assetKind` selects which pipeline runs;
  reconstructing a durable row from an untrusted discriminator is the move this
  phase removes.
* **Per-job quarantine** — `RunMediaIntelligence` without `runId` and the
  extraction jobs without `evidencePartId` fall to quarantine even though their
  family is adaptable, because those fields were optional and such jobs really
  exist.

`LegacyJobQuarantined` is thrown, not returned, so it cannot be mistaken for a
decode result. It dead-letters with a bounded reason, produces no external side
effect, is counted under `queue_legacy_quarantined_total` (separate from
malformed, because it is not a bug), and re-enters only through an
owner-approved replay that creates a fresh canonical request.
`SilentlyDroppedLegacyJobs = 0`.

The report chain's adapter is the sharpest: it yields the evidence id and
DISCARDS `forceRegenerate`, so a draining legacy job can produce a first
artifact and cannot overwrite a finalised one — a legacy payload cannot escalate
its own privileges by surviving in a queue.

### Phase J (partial): the gate caught two more real bugs

The gate's "every processor decodes" check was **per module**, and that coarseness
hid the evidence-purge break above — `processor.ts` owns both the report job and
the purge job, so the report path's decoder satisfied the check for both. It is
now **per work name**: each registered job's processor must name its own registry
key AND call a decoder.

That immediately caught a second bug: **`mi-exif` was bound to
`processMediaIntelligenceJob`**, the same function the `media-intelligence` queue
uses. That sharing is precisely why the old payload had to carry both a run id
and a part id and trust whichever was present — one function with two
identities. Every EXIF job would have failed its job-name check after the split.
`mi-exif` now has its own entry point, `processExifQueueJob`, decoding under its
own work name against its own authority.

**Closure gate: 57/57.**

---

## 4c. Third pass — live-database proof, flake root cause, family matrix

Disposable **PostgreSQL 16.11** and Redis 7 were stood up in Docker for this
pass (`p5-pg16`, `p5-redis`).

### Phase L (partial): full migration chain replays clean

`prisma migrate deploy` against a fresh PG16 database applied the entire chain
including both Point-5 migrations. Verified directly in the live database:

* `media_intelligence_runs_kind_bounded` now enumerates **all 14** kinds
  (12 reachable + the 2 retained historical ones);
* `report_generation_requests` exists with all 20 columns and all 5 indexes,
  including the `idempotency_key` unique index that resolves concurrent
  requests.

### Phase D: the report authority, proven against a real database — 30/30

`test/phase-12-point5-report-authority.integration.test.ts` drives the REAL
producer, durable writer, canonical enqueue path, strict decoder, resolve/claim
transition, terminal writer and reconciler against live PostgreSQL. Nothing
under test is mocked; the queue transport is a recording fake so the wire form
can be inspected, and the generation body is never reached because every case
is about what happens before it runs or what the durable row says after.

Proven: authorization-before-creation; commit-before-enqueue; payload carries
only the request id; `forceRegenerate` absent from the wire; five tamper
variants refused with the durable row byte-identical afterwards; workspace and
organization derived from persistence; policy version reloaded and stale
requests BLOCKED_STALE without a storage write; legal hold blocking
regeneration but NOT first generation; suspended organization denied;
cross-workspace request BLOCKED_POLICY with the evidence row and artifact count
unchanged; replay returning the stored terminal result without claiming or
incrementing; a late worker unable to overwrite SUCCEEDED; a three-way
concurrent race producing exactly one winner; an expired lease recovered and a
fresh one not stolen; enqueue failure leaving a recoverable QUEUED row; the
reconciler restoring it exactly once and never touching terminal rows; and the
legacy drain minting a NON-force request and collapsing onto an existing one
without escalating it.

### Phase I: the destruction flake, root-caused

**Not load. An unmocked outbound S3 call in a unit test.**

`services/api/.env` sets `S3_BUCKET=proovra-evidence-prod-eu`, vitest loads it,
and `certifyDestruction` uploads the certificate artifact whenever a bucket is
configured. The upload sits inside `try { … } catch {}` — deliberately, so a
storage outage cannot invalidate a certificate that is already durable — which
means the failure is never LOUD, only SLOW: the AWS SDK's retry and backoff run
to completion before the catch is reached.

The same defect had already been fixed once in this file for
`copyObjectStorageClass`, with a comment describing this exact failure mode.
`certifyDestruction` reaches storage through a different function,
`putObjectBuffer`, which was never stubbed — so the bug survived in the half of
the file nobody re-read.

Fixed by stubbing the storage boundary, not by raising a timeout. Test time went
from a 5,010 ms timeout to **42 ms, stable across five consecutive isolated
runs** and green in the full suite.

A **self-deriving guard** was added: it reads the service sources, computes
which storage entry points they can reach, and fails if any is unstubbed. It
immediately found two more — `getObjectStream` and `deleteObject`, the latter on
the actual evidence-destruction path — which are now stubbed too.

### Phase G (first half) + Phase H (per family): 176 assertions

`test/phase-12-point5-family-tamper-matrix.test.ts` parametrises the payload
contract across every family, derived from the registry so a new family cannot
be added without inheriting every case. Cases 1–8 and 24 plus the legacy
disposition, per BullMQ chain, against the real decoder and the real enqueue
authority.

The three families with no BullMQ chain — invite delivery, webhooks/providers,
notifications — are asserted to be genuinely sweep-only rather than skipped, and
each of their sweeps is checked for a durable authority.

### Verified state after this pass

| Check | Result |
|---|---|
| `packages/shared` typecheck | 0 errors |
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| Point-5 closure gate | **57 / 57** |
| Nine-family contract matrix | **176 / 176** |
| API unit suite | **21,492 / 21,492 across 635 files** |
| API integration suite | **22 / 22 across 5 files** (live PG16) |
| Worker suite | **848 / 848 across 47 files** |

Test-count delta reconciles exactly, with no unexplained movement:

```
21,309 (prior session)
  + 176  family tamper matrix (new file)
  +   6  closure gate 51 -> 57
  +   1  phase-4b stays-removed guard 64 -> 65
= 21,492  observed
```

---

## 4d. Fourth pass — Step 0 reconciliations, and a third unreachable-path defect

### 0.1 — "30/30" vs "22/22" was a reporting error, now structurally impossible

Both numbers were measured correctly and measured **different units**. The
report-authority suite was a SINGLE `it()` containing 105 `expect()` calls
covering the 30 spec properties; "22" was vitest CASES across the five
integration files. Nothing forced the two to agree, and the mega-test also
meant the first failing assertion aborted the remaining 29 properties.

Fixed at the cause: the suite is now **29 discrete cases**, one per property,
named for the property it proves, with the harness in `beforeAll`/`afterAll` and
each case seeding its own fixtures. The count is machine-countable and the two
numbers cannot drift apart again.

**Authoritative report-authority count: 29/29.**
API integration project: **50/50 across 5 files** (was 22; −1 mega-case,
+29 discrete cases, +0 elsewhere).

### 0.2 — "12 reachable" vs "14 allowed" was correct, and hid a live defect

Both numbers were right. `12` is the QUEUE vocabulary
(`MEDIA_INTELLIGENCE_JOB_KINDS`); `14` is the RUN-ROW vocabulary and the DB
CHECK. The difference is exactly `compute_duplicates` and `compute_lineage` —
legacy-only, retained because historical rows carry them and narrowing the
constraint would make those rows unreadable through any revalidating path.

Six sets were derived independently — DB CHECK (from the migration SQL, and
verified against live PG16), shared registry, run-row catalog, producer-emitted,
processor-handled, reserved-drain — and reconciled in
`test/phase-12-point5-job-kind-reconciliation.test.ts` (9 assertions). All four
required metrics are enforced there, not asserted in prose:
`JobKindMismatches = 0`, `UnclassifiedAllowedJobKinds = 0`,
`ProducibleUnprocessedJobKinds = 0`, `DatabaseRejectedReachableJobKinds = 0`.

**Deriving the producer set caught a third defect in the same capability.**
The text-similarity promotion path was unreachable *twice over*:

1. originally it was selected by an optional `textKind` payload field that **no
   producer anywhere set** (found and fixed in pass 1, by turning the selector
   into a run kind);
2. that made it ADDRESSABLE but still not REACHABLE — **nothing emitted the new
   kind**. The capability was still dead code.

Both halves are now wired. `enqueueTextSimilarityPass` fires at the only correct
trigger — after OCR or transcript text durably exists, since the pass compares
this record's text against others' — and commits the `MediaIntelligenceRun`
BEFORE enqueuing its id, the same ordering every converged chain uses. The gate
asserts producer, kind, DB acceptance, branch and commit-ordering together, so
"reachable" is now a checked property rather than a claim.

### Verified state after this pass

| Check | Result |
|---|---|
| `services/worker` typecheck | 0 errors |
| API unit suite | **21,501 / 21,501 across 636 files** |
| API integration suite | **50 / 50 across 5 files** (live PG16) |
| Worker suite | **848 / 848 across 47 files** |

Both deltas reconcile exactly:

```
API unit:     21,492 + 9 (job-kind gate)                = 21,501  observed
Integration:  22 − 1 (mega-case) + 29 (discrete cases)  = 50      observed
```

---

## 5. NOT DONE — Point 5 is NOT closed

1. **Nine-family matrix: HALF built.** The payload-contract half (cases 1-8, 24,
   plus legacy disposition) is proven for all nine families — 176 assertions.
   The STATE-MACHINE half (cases 9-30: cross-workspace concealment, lifecycle
   denial, policy reload, idempotent duplicate execution, one-winner
   concurrency, no-partial-mutation, reconciler recovery, exactly-once audit,
   stale-overwrite protection) is proven for **reports/packages only** — 29
   discrete cases against live PostgreSQL 16.
   `QueueFamiliesBehaviorallyProven = 1/9` under the full definition; 9/9 for
   the contract half alone. The honest figure is **1/9**.

   Eight families still need state-machine proof: redaction, invite delivery,
   retention/destruction, webhooks/providers, notifications, evidence
   finalization, reconciliation, intelligence/operations.

2. **17 DB-outbox sweeps: NOT AUDITED.** Registered and structurally present,
   but scheduler/selector/lease/claim/terminal-writer was not walked per sweep,
   and none of the 14 required behavioral proofs (two-instance one-winner,
   stale-lease recovery, active-lease respect, poisoned-row visibility,
   truthful terminal state) exists. `DbOutboxSweepsConverged` is UNVERIFIED.

3. **Reconcilers: one of several proven.** `reconcileStrandedReportRequests` is
   proven against live PostgreSQL (recovers exactly once, never touches terminal
   rows). `search-index-reconciler.ts` and `intelligence-run-reconciler.ts`
   remain structurally present only. `RECONCILER_PENDING = []` currently proves
   every unit of work NAMES a reconciler that EXISTS — not that it recovers
   correctly.

4. **Queue and sweep observability projection: NOT BUILT.** The counters exist
   and are incremented (`queue_payload_rejected_total`,
   `queue_legacy_quarantined_total`, `queue_claim_lost_total`,
   `queue_stale_request_blocked_total`, …) but no tenant-scoped operator surface
   reads them, and no UI states were added.

5. **Cleanup sweep: PARTIAL.** Duplicate producers, job-id builders, retry
   policies and payload schemas are deleted, and several stays-removed guards
   exist. The full Phase-K inventory — generated JS twins, temporary scripts,
   disconnected reconcilers — has not been swept. The worker census generator
   (`services/worker/scripts/build-test-census.mjs`) is currently an UNOWNED
   one-off: it must either be wired into a package script and CI gate, or
   deleted.

6. **The closure gate still reads the registry as its source of truth** for the
   17/17 counts. It verifies every registry path against the filesystem, so it
   cannot name a deleted file — but it does not independently discover queues
   and sweeps from the runtime and diff them against the registry. A manually
   curated registry should not prove its own completeness.

7. **Migration rehearsal: PARTIAL.** The full chain replays clean on disposable
   PG16 and both Point-5 objects are verified in the live database. NOT done:
   production-like pre-migration fixtures, rerun/idempotency verification,
   schema-vs-database drift check, and API/Worker boot against the
   post-migration schema.

8. **Final sequential certification: NOT RUN.** Web typecheck, mobile typecheck,
   repository lint, and the three production builds were not executed in this
   pass.

9. Both Point-5 migrations remain **OWNER_MIGRATION_PENDING**:
   `20271113000000_point5_report_generation_authority` and
   `20271114000000_point5_media_intelligence_kind_catalog`.


**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

## 4e. Bounded Unit 1 — family state machines (partial: 3/9)

Disposable PostgreSQL 16.11 + Redis 7; full migration chain applied, both
Point-5 migrations confirmed present.

### Infrastructure built

* `test/point5/family-coverage-manifest.ts` — maps every one of the **34
  registered runtime units** to the behavioural case identifiers that must
  prove it, with a CLOSED set of inapplicability reasons and a
  NON-WAIVABLE list (tenancy, concurrency, idempotency) no unit may waive.
* `test/point5/family-harness.ts` — shared real-state conformance harness.
  Drivers know how to seed, execute and read; the harness owns the assertions
  and implements no production decision.
* `test/phase-12-point5-family-proof-gate.test.ts` — DERIVES
  `QueueFamiliesBehaviorallyProven` from registry + manifest + suite existence,
  cross-checked in both directions so the manifest cannot prove itself.

### Families proven — 3 of 9

| Family | Units | Cases |
|---|---|---|
| redaction | 2/2 (`RenderRedactionDerivative`, `RedactionStrandedReconciler`) | 12 |
| webhooks_providers | 1/1 (`WebhookDispatcherSweep`) | 12 |
| reports_packages | 1/2 covered by the 29-case suite; `ExchangePackageBuilderSweep` mapped, suite present | 29 |

### THREE production defects found in the webhook dispatcher

All three were invisible because nothing had ever driven this module against a
real database.

1. **Total silent webhook-delivery outage.** `LifecycleWebhookDelivery.endpointId`
   has a foreign key to `LifecycleWebhookEndpoint` (`webhook_endpoints`), but
   `endpointFindUnique` looked that id up in `prisma.webhookEndpoint` — a
   different model mapping to `integration_webhook_endpoints`. The lookup
   returned `null` for every real delivery, and the caller treats a missing
   endpoint as unrecoverable: **every delivery was marked FAILED without the
   request ever being attempted**, and the failure looked like a legitimately
   deactivated endpoint. It survived because the two models have similar
   shapes, the id is a UUID valid against both, and the `as unknown as` shim
   that exists to work around a stale generated client also suppressed the type
   error that would have caught it.

2. **The documented atomic claim did not exist.** The registry declares
   `PENDING -> DISPATCHING (conditional_update_many)` and
   `conditional_state_claim` idempotency. `DISPATCHING` appeared nowhere in the
   module. The tick polled due rows and dispatched them, so two dispatcher
   instances — or two overlapping ticks of one instance, since the interval is
   5s and the HTTP timeout is 30s — both saw the same PENDING row and both
   POSTed it. **Customer endpoints received duplicate deliveries.** Fixed with a
   real conditional UPDATE plus registry-sourced lease recovery, so a dispatcher
   that dies mid-flight cannot strand a row in a non-polled state.

3. **The signature was computed but never persisted.** It was sent in the
   header and the `signature` column stayed empty, leaving no durable record of
   what was actually signed. Now written with the claim, before the request.

### Verified

| Check | Result |
|---|---|
| worker typecheck | 0 errors |
| API unit | **21,511 / 21,511 across 637 files** |
| API integration | **74 / 74 across 7 files** (live PG16) |
| Worker | **848 / 848 across 47 files** |

Deltas reconcile exactly: `21,501 + 10 = 21,511`; `50 + 12 + 12 = 74`.

### Bounded Unit 1 is NOT complete

`QueueFamiliesBehaviorallyProven = 3/9`. Six families still need
state-machine suites, covering **30 of the 34 registered units**:

* `invite_delivery` (1 unit), `notifications` (2), `evidence_finalization` (1),
  `retention_destruction` (6), `intelligence_operations` (7),
  `reconciliation` (12).

The manifest already maps all of them, so each remaining family is a suite
against an already-identified executor — and the gate will not credit any of
them until that suite exists and covers every unit.

---

## 4f. Bounded Unit 2 — the 29/30 correction, an executed-proof gate, and family 3a

### The 29-versus-30 discrepancy, resolved and made structurally impossible

Both figures were measured; neither was wrong on its own terms.

* The registry has **34** processing units.
* Units with an executed behavioural proof at the start of this pass: **4** —
  `RenderRedactionDerivative`, `RedactionStrandedReconciler`,
  `WebhookDispatcherSweep`, `GenerateReportJob`. So **30** remained.
* The six families listed as remaining sum to **29**.

The missing unit is **`ExchangePackageBuilderSweep`**. It sits in
`reports_packages` — a family the old gate had already credited as PROVEN —
so it appeared in neither column: not in the proven set (nothing had ever
executed it) and not in the six-family remainder (its family was not listed).

The gate's credit rule was the cause. It counted a family proven when its
suite FILE existed and every registered unit was MAPPED. Both are properties
of source, not of execution.

**The mechanism is now execution-based.** State-machine suites call
`provenCase(...)` after each assertion passes; `recordSuiteProof(import.meta.url)`
writes the executed identifiers plus the SHA-256 of the suite's own bytes to
`docs/architecture/point5-family-proven-cases.json`; the gate re-hashes each
file and discards any record whose bytes changed. Deleting a case, deleting a
suite or skipping a suite all remove credit until the integration project is
re-run. A conservation assertion requires
`proven + unproven === registered === manifest`, so a unit cannot fall between
two hand-written lists again.

The manifest also became suite-plural (`suites: string[]`), because forcing a
six-unit family into one file produces exactly the unreviewable mega-suites
this phase exists to remove.

### Production defects found and fixed — family 3a

All five were invisible because nothing had driven these modules against a
real database.

1. **The shared governance run lock was not a lock.**
   `runGovernanceReconciliation` documents "One RUNNING row per (kind,
   lockKey)" and described an "advisory + RUNNING-row check". There is no
   advisory lock in the module; it read for a RUNNING row and, finding none,
   created one. Two callers interleave through that gap trivially — the
   interval scheduler and an operator-triggered run, or two worker instances.
   Both created a RUNNING row and both ran the body. This governs
   RETENTION, DESTRUCTION_SWEEP, IMMUTABLE_STORAGE and LIFECYCLE_DRIFT.

2. **The destruction orchestrator's claim was not a claim.** Same shape:
   `findFirst` for a non-terminal `DestructionExecution`, then `create`. The
   registry declared the mechanism `unique_execution_constraint`; no such
   constraint existed. **Two sweeps over one approved review produced two
   executions, two certificates, two lineage hashes and two
   `destruction_executed` ledger rows** — duplicate irreversible destruction
   with duplicate evidence of it.

3. **The archive auto-transition sweep had no claim at all**, and derives an
   evidence row's current tier from its latest transition row. Two ticks read
   the same tier and both wrote a PENDING transition, so the same object was
   copied to the archive storage class twice and billed twice.

4. **Two fail-open reads.** `archive-tier-auto-transition` ended its workspace
   query in `.catch(() => [])`, so any database error became "there are no
   workspaces" and the tick logged `sweep_completed` with zero teams — a total
   outage of retention tiering indistinguishable, in every log and metric,
   from a healthy idle run. And `gatherDestructionFacts` defaulted a MISSING
   evidence row to `lifecycleState: "ACTIVE"`, a fact set the canonical gate
   allows; the run only stopped later, incidentally, when the tombstone UPDATE
   threw.

5. **The capture-draft reaper appended duplicate audit events.** Its
   in-transaction re-read takes no lock at READ COMMITTED, so two reapers both
   saw DRAFT, both wrote EXPIRED (same value, harmless) and both appended an
   EXPIRED event — two ledger rows for one expiry.

Plus two found while running the suite:

6. **`report-v2/asset-data-url.ts` resolved assets from `process.cwd()`.**
   `sections/cover.ts` calls it at module scope, so the failure is an
   IMPORT-time throw: any entry point launched from a directory other than
   `services/worker` cannot load the processor module at all, and the error
   names a missing PNG rather than the cause. Now resolved relative to the
   module, with the cwd paths kept last so existing deployments still work.

7. **Concurrent purges died on a raw foreign-key violation.** Everything the
   purge reads is read outside its destruction transaction, so a loser wrote a
   custody event against an already-deleted row and crashed with P2003, then
   retried, for work that was correctly complete. A re-read of `deletedAt`
   inside the transaction makes the loser a bounded no-op.

### Registry corrections — five claims that described intentions

The registry declared claim transitions whose states and lease fields do not
exist on the declared durable authority. Each is now either implemented or
corrected to describe what actually arbitrates:

| Unit | Was | Now |
|---|---|---|
| `DestructionOrchestratorSweep` | `QUEUED -> PROCESSING`, `unique_execution_constraint` (absent) | `PLANNED -> EXECUTING`, index-arbitrated, 30-min lease on `startedAtUtc` — **implemented** |
| `RetentionReconciliationSweep` | 30-min lease, `advisory_lock` | 60-min lease matching `RUN_LOCK_LEASE_MS`; `advisory_lock` removed — it was a comment, never code |
| `ArchiveAutoTransitionSweep` | `QUEUED -> RUNNING` on `Evidence.startedAtUtc` (no such state, no such column) | `none -> PENDING` on the transition row, index-arbitrated, no lease |
| `CaptureDraftReaperSweep` | `QUEUED -> RUNNING`, lease on `expiresAtUtc` (that is the draft's expiry, not a lease) | `DRAFT -> EXPIRED`, `conditional_update_many`, no lease |
| `PurgeDeletedEvidenceJob` | `QUEUED -> PROCESSING`, `conditional_update_many` (absent) | deterministic job id + in-transaction re-read; `conditional_state_claim` removed |

### Migration — a THIRD Point-5 migration

`20271115000000_point5_atomic_sweep_claims` adds three partial unique indexes:

* `governance_reconciliation_runs_running_lock_uniq` on (kind, lock_key)
  WHERE status = 'RUNNING';
* `destruction_executions_active_review_uniq` on (destruction_review_id)
  WHERE status NOT IN (COMPLETED, FAILED, ROLLED_BACK);
* `archive_tier_transitions_active_evidence_uniq` on (evidence_id)
  WHERE state IN (PENDING, EXECUTING, RESTORE_REQUESTED).

Pre-existing duplicates are resolved FORWARD before each index is built —
newest row keeps the slot, older rows move to a terminal FAILED state with a
bounded reason. Nothing is deleted and no outcome is invented. Guarded in the
repository's Phase-O `information_schema` DO-block pattern (the safety gate
reads an 800-character window, so each guard sits immediately before its
`EXECUTE` and the resolution UPDATEs are outside the block).

Replayed on a fresh disposable PostgreSQL 16 (`p5_replay`); all three indexes
verified by `pg_indexes`. All three registered in
`docs/architecture/raw-schema-ownership.json` under `UNIQUE_DECLARATION`
(859 -> 862 objects), and `db:raw-schema-verify` reports 0 unregistered
divergences and 0 objects proposed for removal.

### Cleanup

Eight dead symbols orphaned by the first Point-5 pass removed (six source-pin
constants in tests, one unused import, and the retired
`PurgeDeletedEvidenceJobData` type in `processor.ts`). Repository lint for
`services/api` and `services/worker` is now **0 errors / 0 warnings**.

### Verified state after this pass

| Check | Result |
|---|---|
| `@proovra/shared` build | clean |
| `@proovra/shared-runtime` build | clean |
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| `services/api` lint | 0 / 0 |
| `services/worker` lint | 0 / 0 |
| Migration chain replay (fresh PG16) | clean, 217 migrations |
| `db:raw-schema-verify` | 862 registered, 0 unregistered, 0 removals |
| API unit suite | **21,515 / 21,515 across 637 files** |
| API integration suite | **95 / 95 across 8 files** (live PG16) |
| Worker suite | **848 / 848 across 47 files** |

Both deltas reconcile exactly:

```
API unit:     21,511 + 4  (family-proof gate 10 -> 14 cases)   = 21,515
Integration:     74 + 21  (family-retention-destruction suite) =     95
```

### Family state — 2/9, not 3/9

The executed-proof gate DEMOTED `reports_packages`: it was credited while
`ExchangePackageBuilderSweep` had never been driven. The honest figure was
never 3/9.

| Family | Units proven / registered |
|---|---|
| redaction | 2 / 2 — PROVEN |
| webhooks_providers | 1 / 1 — PROVEN |
| reports_packages | 1 / 2 (`ExchangePackageBuilderSweep` unproven) |
| retention_destruction | 2 / 6 (`PurgeDeletedEvidenceJob`, `DestructionOrchestratorSweep`) |
| invite_delivery | 0 / 1 |
| notifications | 0 / 2 |
| evidence_finalization | 0 / 1 |
| intelligence_operations | 0 / 7 |
| reconciliation | 0 / 12 |

`QueueFamiliesBehaviorallyProven = 2/9`.
Units with executed Layer-B proof: **6 / 34**. Remaining: **28**.

Both numbers are asserted in `test/phase-12-point5-family-proof-gate.test.ts`,
which also asserts `POINT 5 CLOSURE` is `false`. Raising either without a
green run that produced it fails immediately.

### Still NOT DONE

Items 2 and 4-8 of section 5 stand unchanged. Item 1 advances from 1/9 to 2/9
and item 3 is unchanged. Item 9 gains a third migration:
`20271115000000_point5_atomic_sweep_claims`, also **OWNER_MIGRATION_PENDING**.

Remaining per family, with the executors already identified in the manifest:

* `retention_destruction` — 4 units (`RetentionReconciliationSweep`,
  `ArchiveAutoTransitionSweep`, `CaptureDraftReaperSweep`,
  `MfaChallengeGcSweep`). The production fixes for three of them are IN, and
  are not yet covered by a state-machine suite.
* `reports_packages` — 1 unit (`ExchangePackageBuilderSweep`).
* `evidence_finalization` — 1, `invite_delivery` — 1, `notifications` — 2,
  `intelligence_operations` — 7, `reconciliation` — 12.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

## 4g. Bounded Unit 3 — four families closed, three defects, one wording correction

### Correction to the previous section's prose

Section 4f said "one family completed". That was wrong as English and did not
match its own metric: the pass took `QueueFamiliesBehaviorallyProven` from an
over-credited 3/9 to a measured 2/9 while proving two of six retention units.
The METRIC in that section was correct and is unchanged; only the sentence
describing it was not. No number has been adjusted to fit prose here or there.

### Families closed in this pass

| Family | Units | Suite |
|---|---|---|
| retention_destruction | 6/6 | `family-retention-destruction.integration.test.ts` (51 cases) |
| reports_packages | 2/2 | report-authority (29) + `family-exchange-package` (11) |
| evidence_finalization | 1/1 | `family-evidence-finalization.integration.test.ts` (12) |
| invite_delivery | 1/1 | `family-invite-delivery.integration.test.ts` (11) |

`QueueFamiliesBehaviorallyProven = 6/9`. Executed runtime units: **13 / 34**.

### Production defects found and fixed

8. **`destruction_reviews` claimed a unique constraint that did not exist.**
   The datamodel comment says "Only one active review per evidence at a time
   … the unique constraint here protects against races". There is none, and
   the retention reconciler's "atomic" creation is a `findFirst` inside a
   transaction followed by a `create` — which at READ COMMITTED takes no lock.
   A GLOBAL run and a WORKSPACE-SCOPED run hold different lock keys and may
   therefore overlap by design, so both saw no active review and both created
   one; the second write also rebound `Evidence.activeDestructionReviewId`,
   orphaning the first review while leaving it PENDING in the operator's
   queue. Fixed by `destruction_reviews_active_evidence_uniq` plus P2002
   handling that narrows to contention and re-throws everything else.

9. **The exchange package builder's only concurrency control was an
   in-process `Set`.** `_inFlight` is per-PROCESS, so two worker instances
   each held their own empty one, both selected the same BUILDING package,
   both assembled the ZIP, both uploaded it to object storage and both wrote
   a terminal state — duplicate artifact bytes, duplicate storage cost, and a
   `payload_sha256` recorded by whichever finished last. Replaced with
   `claimPackageBuild`, a conditional `ON CONFLICT … DO UPDATE … WHERE`
   against the existing UNIQUE on `package_id`, with `started_at_utc` as a
   30-minute lease. A caller that loses the claim now does nothing at all.

10. **The purge's in-transaction re-read was not a lock.** The fix recorded in
    section 4f reduced the failure but did not remove it: at READ COMMITTED
    both transactions still see the row, because neither has committed its
    delete. Concurrent purges continued to die on a raw P2003 foreign-key
    violation and retry, for work already correctly complete. Now a
    `SELECT … FOR UPDATE`, which actually serialises them.

### Registry corrections in this pass

`ExchangePackageBuilderSweep` declared `QUEUED → RUNNING` with a 20-minute
lease. No such states, and no lease at all. Corrected to the implemented
claim and to `EXCHANGE_BUILD_LEASE_MS`.

### Manifest correction — a fictional executor path

`DemoFollowUpSweep` named
`services/api/src/services/marketing/demo-request.service.ts`. There is no
`marketing/` directory. The real entry point is `processDueDemoFollowUps` in
`services/api/src/services/demo-follow-up.service.ts`. A unit whose executor
cannot be located is a unit nobody checked, so the gate now asserts every
manifest executor path exists on disk.

### Migration

`20271115000000_point5_atomic_sweep_claims` — still the third and last Point-5
migration, amended (it has never been applied anywhere) to add the fourth
partial unique index. It now supplies:

* `governance_reconciliation_runs_running_lock_uniq` (kind, lock_key) WHERE RUNNING
* `destruction_executions_active_review_uniq` (destruction_review_id) WHERE non-terminal
* `destruction_reviews_active_evidence_uniq` (evidence_id) WHERE active
* `archive_tier_transitions_active_evidence_uniq` (evidence_id) WHERE in-flight

Full chain replayed on a fresh disposable PostgreSQL 16 (`p5_replay2`); all
four indexes verified by `pg_indexes`. Registered in
`raw-schema-ownership.json` under `UNIQUE_DECLARATION` (859 → 863 objects);
`db:raw-schema-verify` reports 0 unregistered divergences.

### Verified state after this pass

| Check | Result |
|---|---|
| `@proovra/shared` build | clean |
| `@proovra/shared-runtime` build | clean |
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| `services/api` lint | 0 / 0 |
| `services/worker` lint | 0 / 0 |
| Migration chain replay (fresh PG16) | clean, 4 indexes verified |
| `db:raw-schema-verify` | 863 registered, 0 unregistered, 0 removals |
| API unit suite | **21,516 / 21,516 across 637 files** |
| API integration suite | **159 / 159 across 11 files** (live PG16) |
| Worker suite | **848 / 848 across 47 files** |

Deltas reconcile exactly:

```
API unit:     21,515 + 1  (gate: manifest-executor-path assertion)     = 21,516
Integration:      95 + 30 (retention +30) + 11 + 12 + 11               =    159
```

### Remaining — 21 units in 3 families

| Family | Units remaining |
|---|---|
| notifications | 2 (`MfaRecoveryDigestSweep`, `DemoFollowUpSweep`) |
| intelligence_operations | 7 |
| reconciliation | 12 |

`13 proven + 21 remaining = 34 registered`, asserted by the conservation test.

Items 2 and 4–8 of section 5 (the 17-sweep audit, observability projection,
cleanup sweep, independent topology gate, migration rehearsal completion,
final certification) remain as recorded.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

## 4h. Bounded Unit 4 — notifications closed, two duplicate-send defects

### Family closed

`notifications` 2/2 — `MfaRecoveryDigestSweep` and `DemoFollowUpSweep`, driven
through their real executors in
`test/point5/family-notifications.integration.test.ts` (17 cases).

`QueueFamiliesBehaviorallyProven = 7/9`. Executed runtime units: **15 / 34**.

### Production defects found and fixed — both CRITICAL, both duplicate sends

11. **The MFA recovery digest sent duplicate emails.** The order was: read
    today's `MfaRecoveryAdminDigestLog` row, send, then write it. That is
    check-then-act across an EXTERNAL side effect. Two ticks — the interval
    scheduler and an operator-triggered run, or two worker instances — both
    read no row, both SENT the digest, and only then did the second INSERT
    collide. The unique constraint caught the duplicate ROW; the admin had
    already received the duplicate EMAIL.

    The INSERT is now the claim, taken BEFORE the send. Exactly one caller
    wins the `(userId, sentDate)` slot and is the only one permitted to
    contact the provider. If that caller's send fails it DELETES its own
    claim, which preserves the original guarantee that an undelivered digest
    is not recorded as delivered. The `msg.includes("Unique")` string match
    that stood in for error classification was replaced with a `P2002` check —
    the string form would also have swallowed an unrelated failure whose
    message happened to contain the word.

12. **The demo follow-up sweep had no claim at all.** `processDueDemoFollowUps`
    selected due rows and called the provider per row. Two ticks both selected
    the same request and both sent, so a prospect received the same follow-up
    twice. Fixed with the same conditional lease-push the invite sweep already
    uses — `nextFollowUpAt` is the lease, and only the caller matching exactly
    one row may send.

### A stale source pin, rewritten rather than obeyed

`phase-r8-1-7-mfa-recovery-operations-polish.test.ts` test 9 asserted by REGEX
that the digest log `create` sat after the failure branch — it pinned the
write-after-send ordering that defect 11 removed. Production code was not
changed to satisfy it. The test now asserts the two properties it was actually
protecting (a failed send leaves no delivered row; the claim precedes the
transport), and both are additionally proven against a live database in the
notifications family suite.

### Follow-up finding recorded, NOT fixed (out of Point-5 scope)

`services/worker/src/mfa-recovery-digest.ts` posts to Resend with a raw
`fetch` rather than through `services/api/src/services/email.service.ts`,
giving the platform two email transport owners with different retry and
classification behaviour. Medium risk, no Point-5 invariant affected.
Recorded here as a follow-up rather than expanded into this phase.

### Verified state after this pass

| Check | Result |
|---|---|
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| `services/api` lint | 0 / 0 |
| `services/worker` lint | 0 / 0 |
| API unit suite | **21,516 / 21,516 across 637 files** |
| API integration suite | **176 / 176 across 12 files** (live PG16) |
| Worker suite | **848 / 848 across 47 files** |

Integration delta reconciles exactly: `159 + 17 = 176`. The API unit total is
unchanged at 21,516: the four gate pins were edited in place, and the stale
source pin was rewritten rather than added to or removed.

### Remaining — 19 units in 2 families

| Family | Units remaining |
|---|---|
| intelligence_operations | 7 |
| reconciliation | 12 |

`15 proven + 19 remaining = 34 registered`, asserted by the conservation test.

Blocks B and C (17-sweep matrix, legacy adapter closure, observability
projection, cleanup, independent topology gate, migration rehearsal
completion, final certification) are not started.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

## 4i. Bounded Unit 5 — the three contradictions, and intelligence/operations

**Point 5 is still NOT closed.** The list in section 5 is shorter, not empty.

### 0.5 — OCR/Transcript: two authorities became one

Both capabilities had two registered paths.

| | path | what it did |
|---|---|---|
| REAL | `media-intelligence` queue, run kinds `extract_ocr_azure` / `extract_transcript_deepgram` | durable `MediaIntelligenceRun`, policy reload, atomic claim with a generation fence, budget-gated provider call, terminal write, stranded-run reconciler |
| STUB | the `mi-ocr` and `mi-transcript` queues | resolved the part, logged `not_configured_completed`, **returned success** |

The stub path claimed an `EvidencePart` durable authority it never wrote to, an
`ai_provider` boundary it never called, and a reconciler with no way to find its
work. "Completed" for extraction that never ran is a false terminal state.

**Deleting it was safe by measurement, not by argument.** `enqueueOcrJob` and
`enqueueTranscriptJob` had **no caller in any commit of this repository**
(established with `git log -S` across all refs), so neither queue has ever held
a job, no in-flight legacy payload can exist, and neither needs a legacy
adapter. Removed: two queues, two producers, two processors, two worker
registrations, two registry entries, two legacy adapters, and the three
operator projections that named them.

What replaces `not_configured_completed` is an explicit refusal.
`providerNotConfiguredReason` is evaluated in the internal extract route
**before** the parts query, before object storage and before
`runProviderOperation`, yielding `provider_not_configured:<PROVIDER>` — which
the worker persists as a FAILED run. No completion claim, no run stuck
PROCESSING, no provider budget consumed, no retry loop that a configuration
change would not end.

`OCR authorities = 1`. `Transcript authorities = 1`.
`CURRENT_RUNTIME no-op processors = 0`.

**Conservation, recomputed from the settled tree:** 36 -> **34 registry
entries**, 34 -> **32 processing units**, 17 -> **15 BullMQ jobs**, 19 -> **17
queue objects** (15 processed + 2 DLQ sinks). The two closure-gate cases that
pinned those as literals were rewritten as an identity between four
independently derived sets, so a future removal moves all of them at once or
fails.

### 0.1 — Invite rotation: retry is not rotation

The contradiction, stated precisely. This family ROTATES the invite token on
every sweeper attempt, because tokens are stored only as hashes and the raw one
cannot be recovered. So a "retry" carried a **different accept URL** under an
**unchanged provider idempotency key**. A provider still holding an ambiguous
first attempt is entitled to suppress the second as a duplicate — leaving the
recipient with a link the rotation had already killed, and no further attempt
able to reach them under that key. A dead invitation, indistinguishable in every
log from a delivered one.

The two are now distinct operations:

* **RETRY** — same content, same durable intent, same key. Only the attempt
  counter moves.
* **ROTATION** — new content. The current intent is SUPERSEDED (CANCELLED,
  `superseded_by_rotation`, lease cleared) and a SUCCESSOR intent is committed
  with its own id, its own minted key and `contentVersion + 1`.

Content identity is a bounded fingerprint over (inviteId, tokenHash, expiry),
derived from the STORED HASH so it distinguishes a rotated invitation from an
unrotated one without exposing the token. The supersede is a conditional UPDATE
and doubles as the concurrency claim, so two callers rotating one invitation
mint one token and send one email. `retryCount` carries forward to the
successor, so the max-attempts ceiling bounds the whole chain rather than
resetting on every rotation.

Seven proofs, all against live PostgreSQL 16, with a provider fake that actually
honours idempotency keys: an ordinary retry reuses the key; the counter moves
and the key does not; a rotation supersedes its predecessor; the rotated link
gets a new intent and a new key; the superseded intent cannot send even when
re-scheduled by hand; a key-deduping provider cannot suppress the rotated link;
two simultaneous rotations produce one successor, one email and one audited
rotation.

Two smaller corrections rode along: the operator-resend path now follows the
chain to the LIVE intent instead of reading the newest row, and the intent it
creates when none exists is built by the same builder as every other — that
branch previously wrote no provider key at all.

### 0.2 — The stored provider key is internal state

The key lives in exactly one place
(`NotificationDelivery.metadata.idempotencyKey`), so "exposed keys = 0" reduces
to "no surface returns a delivery row's metadata".
`test/phase-12-point5-provider-key-projection.test.ts` DISCOVERS every module
that reads the `notificationDelivery` delegate, requires each to be classified
against a closed set (writer / projector / counter / scheduler), and EXECUTES
every projector with a row carrying a genuinely minted key. The end-to-end half
— absence from the audit trail and from stdout/stderr during a real
rotate-and-send — is proven in the invite-delivery family suite.

`Exposed provider idempotency keys = 0`.

### Family 9 — intelligence and operations: PROVEN

Four job units driven through the SHARED conformance harness (not four
hand-written suites) plus the reconciler, against live PostgreSQL 16 **with
pgvector**.

The pgvector requirement is itself a finding. The earlier "full chain replays
clean" rehearsals ran on plain `postgres:16`, where `CREATE EXTENSION vector`
is unavailable — so `evidence_semantic_chunks.embedding_vector` and its ivfflat
index were silently absent, and `EmbedSemanticChunks` could not have been driven
at all. A disposable `pgvector/pgvector:pg16` was stood up (`p5-pgv`), the full
chain replayed, and the column and index verified present. The suite FAILS
rather than skips when the extension is missing.

`IntelligenceOperationsStateMachine = PROVEN` (5 / 5 units).

### Production defects found and fixed

13. **The derived-asset replay guard was dead code.** It tested
    `status === "READY"` — a value `evidence_part_derived_assets_status_bounded`
    FORBIDS and that no code path writes (the module writes COMPLETED / FAILED /
    UNSUPPORTED). So the guard never fired and **every replayed job re-ran the
    pipeline in full**: re-fetching source bytes, re-encoding through sharp or
    ffmpeg, re-uploading the object and rewriting a row whose checksum was
    already recorded against the evidence. Duplicate storage and encode cost on
    completed work, silently — the no-op log line that would have revealed it
    was unreachable too. It now guards on COMPLETED and UNSUPPORTED.

14. **`mi-embed` was invisible to the queue-health heartbeat.** A live,
    registered BullMQ unit that calls a paid AI provider, and the sampler never
    sampled it: a backlog or a stall on the embedding chain produced no
    heartbeat signal at all. It was missed because the contract test guarding
    the sampler carried a HAND-WRITTEN list of queue-name identifiers, so it
    only ever proved the sampler covered the queues somebody remembered. That
    test now DISCOVERS the list from `queue.ts` — which is what surfaced this —
    and asserts exact coverage rather than "at least 14".

### Registry corrections

`GenerateDerivedAsset` declared a `conditional_update_many` claim from PENDING
to PENDING with a 20-minute lease on `updatedAtUtc`. No such update exists and
there is no lease: the entry described an intention. Corrected to what actually
arbitrates — the deterministic job id, the (teamId, evidencePartId, assetKind)
unique index, and the terminal-status replay guard fixed above.

### Test-count reconciliation — every delta explained

```
API unit:        21,552 - 20 (tamper matrix 176 -> 156: two families removed)
                        + 16 (ocr-transcript authority gate, new file)
                        +  9 (provider-key projection gate, new file)
                 = 21,557 observed across 640 files (638 + 2)

API integration:    243 +  9 (family-intelligence-operations, new file)
                        +  1 (reconciler A0: never invents a run row)
                        +  9 (invite: 7 rotation proofs + 2 projection-safety)
                 =    262 observed across 16 files (15 + 1)

Worker:              848 -  2  =  846 across 47 files
```

The worker delta is NOT a lost test. `phase-o1-4-span-emission` generates one
case per `new Worker(` site in the worker bootstrap; two registrations were
removed, so two generated cases were too. No behavioural assertion was dropped —
the cases that pinned `not_configured_completed` were replaced by their inverse,
which asserts the pattern cannot return.

`UnexplainedTestReduction = 0`. `UnexpectedSkips = 0`.

### Verified state after this pass

| Check | Result |
|---|---|
| `@proovra/shared` build | clean |
| `@proovra/shared-runtime` build | clean |
| `services/api` typecheck | 0 errors |
| `services/worker` typecheck | 0 errors |
| `services/api` lint | 0 errors / 0 warnings |
| `services/worker` lint | 0 errors / 0 warnings |
| Migration chain replay (fresh PG16 + pgvector) | clean; vector column + ivfflat index verified |
| API unit suite | **21,557 / 21,557 across 640 files** |
| API integration suite | **262 / 262 across 16 files** (live PG16 + pgvector) |
| Worker suite | **846 / 846 across 47 files** |

`QueueFamiliesBehaviorallyProven = 8/9`. Executed runtime units: **20 / 32**.
`20 proven + 12 remaining = 32 registered`, asserted by the conservation test.

### Still NOT DONE — the remaining list

1. **`reconciliation` family — 12 units, not driven.** `RebuildSearchDocument`,
   `IndexMediaIntelligence`, `ReconcileTeamGraph`, `SyncTeamGraphDomain`,
   `SyncTeamGraphTimeline`, `RefreshGraphSearchProjection`,
   `RefreshOrgHealthProjection`, `LifecycleRecoverySweep`, `OrphanArtifactScan`,
   `ImmutableStorageReconciliationSweep`, `ReviewerReconciliationSweep`,
   `SearchIndexStrandedReconciler`. This is the only family remaining and the
   one that would move the metric to 9/9.
2. **17-sweep integrity matrix — NOT BUILT.** (Section 5 item 2, unchanged.)
3. **Legacy adapter / quarantine closure — NOT RE-VERIFIED** in this pass beyond
   removing the two adapters whose subject cannot exist.
4. **Queue-scoped cleanup sweep — PARTIAL.** The OCR/transcript runtime is gone;
   the wider inventory is not swept.
5. **Independent topology gate — NOT BUILT.** The closure gate still reads the
   registry as its own source of truth for the converged counts. Its
   registration case now says so explicitly rather than implying a 1:1 mapping
   it cannot check (`safeRegisterWorker`'s first argument is a WorkerKind
   LABEL, not a queue name — `"derived-assets"` labels `mi-derived-assets`).
6. **Migration rehearsal — PARTIAL.** The chain replays clean on disposable
   PG16 + pgvector and the Point-5 objects are verified in a live database.
   NOT done: production-like pre-migration fixtures, rerun/idempotency
   verification, schema-vs-database drift check, and API/Worker boot against
   the post-migration schema.
7. **Final sequential certification — NOT RUN.**
8. Three Point-5 migrations remain **OWNER_MIGRATION_PENDING**:
   `20271113000000_point5_report_generation_authority`,
   `20271114000000_point5_media_intelligence_kind_catalog`,
   `20271115000000_point5_atomic_sweep_claims`.

### Deferred, recorded, NOT reopened into Point 5

* `services/worker/src/mfa-recovery-digest.ts` still posts to Resend with a raw
  `fetch` rather than the canonical transport (recorded in 4h).
* The internal extract route reports `success: true` when every part is skipped
  as oversize or storage-reference-less. Bounded, and not a Point-5 invariant,
  but it is a completion claim for work that did not run.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

# PHASE 12 — POINT 5 WORKER + QUEUE INTEGRITY VERIFIED CLOSED

Every requirement of the original Point-5 contract is satisfied and measured.
The "NOT DONE" list that opened section 5 is now empty.

## Step 1 — provider-not-configured is a bounded durable outcome

Ten cases in `test/point5/provider-not-configured.integration.test.ts`, driving
the worker branch, the internal route, the adapter probe, the refusal and the
terminal writer end to end against live PostgreSQL 16. The only substitution is
TRANSPORT: `callInternalMediaIntelligenceExtract` reaches the harness's own
Fastify instance through `app.inject` instead of over HTTP, so every decision
is the real one.

| Requirement | Result |
|---|---|
| configuration checked before provider/storage cost | PROVEN — the run's part has a bucket/key that does not exist; a storage read would have thrown instead of returning a refusal |
| run does not remain PROCESSING | `OCR stuck PROCESSING = 0`, `Transcript stuck PROCESSING = 0` |
| truthful supported state | `FAILED` + `provider_not_configured:<PROVIDER>` |
| no completion claim | `false completion = 0` |
| no provider usage/cost | `providerUsageEvent` count unchanged across the refusal |
| no infinite reconciliation loop | three reconciler ticks over an aged terminal row change nothing |
| reconciler does not re-enqueue while unconfigured | `attemptCount` unchanged |
| authorized retry possible once configured | a new run row is the only way back in, and the probe is live rather than latched |
| bounded reason, no credentials | ≤ 240 chars, no key/secret/token/endpoint/URL |
| wrong tenant concealed | the route is never reached; the run stays PENDING and its tenant is not rebound |

No new status was invented: `FAILED` plus a bounded `lastError` already
expressed this truthfully.

## Step 2 — reconciliation 12/12

`test/point5/family-reconciliation.integration.test.ts`, 18 cases, one suite
rather than twelve.

The family's units CONVERGE rather than terminate — the registry records
`claim: null` for eleven of the twelve — so the shared harness gained an
explicit `convergent` mode. For these units, "terminal state is not
overwritten" means a second execution over unchanged sources reaches the same
projection. Enumerating a terminal status they cannot produce and then
asserting the code preserves it would have proven nothing.

| Group | Units | How |
|---|---|---|
| workspace-addressed projections | `ReconcileTeamGraph`, `SyncTeamGraphDomain`, `SyncTeamGraphTimeline`, `RefreshGraphSearchProjection`, `RefreshOrgHealthProjection`, `IndexMediaIntelligence` | one driver factory through the shared conformance harness |
| source-addressed projection | `RebuildSearchDocument` | same harness, composite `<kind>:<sourceId>` command |
| sweeps | `LifecycleRecoverySweep`, `SearchIndexStrandedReconciler`, `OrphanArtifactScan`, `ImmutableStorageReconciliationSweep`, `ReviewerReconciliationSweep` | compact binding tests against the real selector, authority, tenant derivation and launch |

`ImmutableStorageReconciliationSweep` is the one unit with real locking
(`runGovernanceReconciliation`), so its concurrency is tested directly rather
than inherited: three simultaneous runs leave at most one RUNNING row.

Two properties worth stating because they are easy to get backwards:

* **Lifecycle recovery is entitlement-gated, and that is correct.** A FREE
  workspace is skipped, not recovered — a reconciler that re-enqueued a report
  the workspace is not entitled to would be manufacturing billable work. Both
  the skip and the launch are proven.
* **The workspace-agnostic sweeps are agnostic BY DESIGN.** Each row carries
  its own tenant. What must hold is attribution, not exclusion, and that is
  what is asserted.

`RECONCILER_PENDING = []`. Every stranded-capable authority names a reconciler
that some registered unit actually reaches; orphan and duplicate reconcilers
are both zero.

## Step 3 — fresh nine-family proof

The artifact was deleted and regenerated by a full integration run.

```
QueueFamiliesBehaviorallyProven = 9/9
registered units = manifest units = executed units = 32
fictional units = 0   uncovered units = 0   contract-only credits = 0
```

`POINT 5 CLOSURE` in `phase-12-point5-family-proof-gate.test.ts` was `false`
from the day it was written. It is inverted in this pass, by hand, against the
run that produced the artifact — which was the point of writing it that way.

## Step 4 — all 17 DB sweeps

`test/phase-12-point5-sweep-integrity-matrix.test.ts`, 42 cases. The sweep
surface has no queue object and no job name to diff, so the matrix DISCOVERS
launchers from the worker bootstrap and resolves each to its executor through
four real shapes: a local tick wrapper, a directly-invoked import, a lazy
`await import(...)`, and a `withCronLock(...)` wrapper.

**Three sweeps are CROSS-SERVICE** — the worker holds the timer and POSTs an
internal route; the api runs the sweep. Discovery resolves those to the route,
not to the worker-side client, because the client enumerates nothing and writes
nothing.

That produced a registry correction. `DemoFollowUpSweep` named the worker
bootstrap as its processor and `ReviewerReconciliationSweep` named its worker
HTTP client; both now name the api module that performs the work, matching
`OrgInviteDeliverySweep`, which was already correct.

```
DB sweeps discovered = 17     registered = 17     behaviourally covered = 17/17
orphan launchers = 0          orphan executors = 0
duplicate sweep owners = 0    sweeps without claim/lease = 0
sweeps without reconciliation = 0   sweep authority mismatch = 0
```

## Step 5 — legacy adapters, recomputed

15 retained adapters, 14 `adaptable` and 1 `quarantine`
(`GenerateDerivedAsset`). The OCR/Transcript adapters stay removed, and a new
case makes that structural: **every retained adapter must name a LIVE queue**.
An adapter for a deleted queue can never satisfy its own removal condition,
because the drain command names a queue that cannot report zero.

`test/point5/legacy-adapter-matrix.integration.test.ts` delivers legacy
payloads to real processors:

* quarantine is THROWN, not returned; authority fields are reported by NAME and
  their values are unreachable; zero storage calls; zero rows invented; nothing
  claims success;
* an owner replay is a NEW canonical intent whose `assetKind` was chosen by the
  authorized path, not inherited from the quarantined payload;
* a duplicate legacy delivery CONVERGES — one document, same row, same content,
  and the wire's foreign `teamId` produced nothing anywhere.

```
unclassified legacy shapes = 0   legacy authority reads = 0
silent legacy loss = 0           conditionless adapters = 0
```

## Step 6 — independent topology gate

`test/phase-12-point5-topology-gate.test.ts`. It never asks the registry a
question first: it reads the transport and bootstrap modules, resolves the
actual bindings, and only then diffs.

Resolution follows the alias chain — `reportQueueName -> QUEUE_NAMES.REPORT`,
and `redactionDerivativeQueueName -> REDACTION_DERIVATIVE_QUEUE_NAME ->
"redaction-derivative"` — rather than matching strings, because the first
argument to `safeRegisterWorker` is a WorkerKind LABEL and not a queue name
(`"derived-assets"` labels `mi-derived-assets`). A false mismatch is answered
with an allowlist, which is how a real one gets hidden.

```
BullMQ processed queues = 15   registrations = 15   processors = 15
queue-to-registration mapping = 1:1
orphan producers = 0           orphan processors = 0
duplicate workers = 0          duplicate terminal writers = 0
job-name mismatches = 0        job-kind mismatches = 0
missing durable authorities = 0
NOT_YET_CONVERGED = []         RECONCILER_PENDING = []
```

Two parser gaps were found and fixed rather than allowlisted: a wrapped
`export const x =\n QUEUE_NAMES.Y` binding, and a fixed-size window that bled
into the next registration and reported one processor as bound to two queues.

## Step 7 — pgvector readiness FAILS CLOSED

`services/api/scripts/point5-vector-readiness.mjs`
(`pnpm --filter proovra-api db:point5-vector-readiness`). Seven facts verified
against the live database: extension installed; version ≥ 0.5.0; column
present; vector type at dimension 1536; ivfflat index present; index on the
right column; and a representative vector inserted and measured through the
distance operator inside a rolled-back transaction.

| Scenario | Result |
|---|---|
| **A — PostgreSQL 16, no pgvector** (`p5-pg16`) | **exit 20**, `vector_extension_missing`, with the remedy naming whether the server ships the extension at all |
| **B — PostgreSQL 16 + pgvector** (`p5-pgv`, `p5-rehearsal`) | **exit 0**, pgvector 0.8.6, `vector(1536)`, `evidence_semantic_chunks_embedding_ivfflat_idx`, probe green |

The worker no longer retries into a wall either: `processMiEmbedJob` checks
the vector objects once per process and reports
`mi_embed.vector_objects_missing_blocked`, draining rather than throwing. A job
that throws is retried forever, and no amount of retrying installs an
extension.

### Two schema-ownership defects that only pgvector could reveal

Both had been invisible because every previous rehearsal ran without the
extension.

1. **`evidence_search_documents.embedding` was undeclared.** It has existed
   since the Phase-24/31 drift consolidation, and `db:raw-schema-verify`
   hard-failed on it as a *column proposed for removal* — the datamodel must
   own existence. It is now DECLARED in the datamodel, exactly as its sibling
   `EvidenceSemanticChunk.embeddingVector` is. No migration; a declaration.

2. **`raw-schema-verify` could not verify a pgvector database at all.** Its
   extension probe used `prisma db execute`, which exits 0 for any statement
   that RUNS — including one matching no rows — so it could never observe
   absence, and in practice reported "absent" on a database where the extension
   was installed. It now asks PostgreSQL directly. And the comparison honours
   both conditional categories as MIRRORS:

   * `EXTENSION_CONDITIONAL_COLUMN` — a divergence exactly while absent;
   * `EXTENSION_CONDITIONAL_INDEX` (new) — a divergence exactly while present,
     because Prisma cannot express the ivfflat access method.

   Registry: 863 → 866 objects. `raw-schema-verify` is now **OK on both
   database shapes**, which it never was before.

## Step 8 — complete migration rehearsal

Fresh pgvector PostgreSQL 16 (`p5-rehearsal`). The chain was replayed with the
three Point-5 migrations HELD BACK, production-like rows were seeded into
exactly what they touch — including a genuine pre-existing duplicate — and only
then were they applied.

**Exact migration list, in production order:**

1. `20271113000000_point5_report_generation_authority`
2. `20271114000000_point5_media_intelligence_kind_catalog`
3. `20271115000000_point5_atomic_sweep_claims`

| Verification | Result |
|---|---|
| chain replays clean | yes, both with and without the three |
| row preservation | `media_intelligence_runs` 4 → 4, `evidence` 2 → 2 |
| duplicates RESOLVED FORWARD, not deleted | 2 RUNNING governance runs → 2 rows: 1 RUNNING, 1 terminal |
| `ReportGenerationRequest` | 20 columns, 5 indexes |
| media-intelligence kind CHECK | 14 kinds enumerated |
| atomic sweep-claim partial indexes | all 4 present |
| index predicate | `(kind, lock_key) WHERE status = 'RUNNING'` |
| NULL/terminal behaviour | a second RUNNING row is REFUSED; after the first settles, a new one is PERMITTED |
| claim query uses the index | `Index Only Scan using governance_reconciliation_runs_running_lock_uniq` |
| readiness | exit 0 |
| schema-vs-database | `raw-schema-verify` OK, 0 unregistered divergences |
| API boot | `GET /health` → 200 |
| Worker boot | all durable-work modules imported, `report_generation_requests` queried |

Nothing was applied remotely.

## Step 9 — queue-scoped cleanup

Dead runtime only, each with zero-caller proof. `enqueueOcrJob`,
`enqueueTranscriptJob`, `processOcrJob`, `processTranscriptJob`, `ocrQueue`,
`transcriptQueue` and `genericIdempotentEnqueue` survive ONLY inside comments
and stays-removed assertions. No generated JS twin shadows a queue TS file. No
Point-5 temporary script or scratch artifact remains in the tree.

## Step 10 — final certification

| # | Gate | Result |
|---|---|---|
| 1 | frozen dependency check | lockfile up to date |
| 2–4 | prisma format / validate / generate | clean, valid, generated |
| 5 | plain-PG negative readiness | **exit 20** as required |
| 6 | pgvector full migration replay | clean |
| 7 | production-like Point-5 rehearsal | clean, forward-resolved |
| 8 | schema drift | OK on both shapes |
| 9 | shared + shared-runtime build/typecheck | 0 errors |
| 10 | API build / typecheck / lint | clean / 0 / **0 errors, 0 warnings** |
| 11 | Worker build / typecheck / lint | clean / 0 / **0 errors, 0 warnings** |
| 12 | provider-not-configured suite | 10 / 10 |
| 13 | reconciliation 12/12 matrix | 18 / 18 |
| 14 | fresh nine-family proof | 9 / 9, 32 / 32 units |
| 15 | DB-sweep 17/17 matrix | 42 / 42 |
| 16 | legacy adapter / quarantine matrix | 5 / 5 |
| 17 | independent topology gate | 8 / 8 |
| 18 | full API unit suite | **21,607 / 21,607 across 642 files** |
| 19 | full API integration suite | **295 / 295 across 19 files** |
| 20 | full Worker suite | **846 / 846 across 47 files** |
| 21 | all Point-5 / Phase-12 queue gates | **348 / 348 across 9 files** |
| 22 | test-count / skip reconciliation | below; 0 skipped, 0 todo |
| 23 | temporary-artifact sweep | clean |
| 24 | container teardown | done |
| 25 | dirty-tree inventory | below |

### Test-count reconciliation — every delta explained

```
API unit:        21,557 + 42 (sweep integrity matrix, new file)
                        +  8 (independent topology gate, new file)
                 = 21,607 observed across 642 files (640 + 2)

API integration:    262 + 10 (provider-not-configured, new file)
                        + 18 (family-reconciliation, new file)
                        +  5 (legacy-adapter matrix, new file)
                 =    295 observed across 19 files (16 + 3)

Worker:              846 unchanged across 47 files
```

`unexplained test reduction = 0`. `unexpected skips = 0` — the worker census
regenerates at 47 files / 846 tests / 0 skipped / 0 todo.

### Closure metrics

```
QueueFamiliesBehaviorallyProven      = 9/9
executed processing units            = 32/32
BullMQ queues / registrations / procs = 15 / 15 / 15
DB sweeps                            = 17/17
OCR authorities                      = 1      Transcript authorities = 1
CURRENT_RUNTIME no-op processors     = 0
pgvector readiness false-green       = 0
payload tenant/policy/storage/provider truth = 0
orphan producers / processors / sweeps       = 0 / 0 / 0
duplicate workers / terminal writers         = 0 / 0
job-name / job-kind mismatches               = 0 / 0
missing durable authorities                  = 0
stale policy acceptance                      = 0
duplicate/replay side effects                = 0
partial mutation on failure                  = 0
NOT_YET_CONVERGED = []      RECONCILER_PENDING = []
conditionless legacy adapters = 0    silent legacy loss = 0
stale proof acceptance = 0
```

## Owner production prerequisites and commands

**pgvector is now a production prerequisite.** The embedding chain cannot run
without it, and a deployment lacking it is no longer a silently-degraded one —
readiness fails closed and the worker reports a blocked state.

```bash
# 1. Verify the target ships pgvector, then install it.
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 2. Apply the three Point-5 migrations, in this order.
pnpm --filter proovra-api prisma:migrate

# 3. Verify the vector objects. Exit 0 is required.
DATABASE_URL="$DATABASE_URL" pnpm --filter proovra-api db:point5-vector-readiness

# 4. Verify schema ownership on the post-migration database.
DATABASE_URL="$DATABASE_URL" pnpm --filter proovra-api db:raw-schema-verify
```

Forward-fix: all three migrations resolve pre-existing duplicates FORWARD —
the newest row keeps the slot, older rows move to a terminal state with a
bounded reason. Nothing is deleted and no outcome is invented, so a rollback is
never required to protect data; re-running is safe.

## Deferred, recorded, NOT reopened

* `services/worker/src/mfa-recovery-digest.ts` posts to Resend with a raw
  `fetch` rather than the canonical transport — two email transport owners.
* `markRunFailed` does not stamp `completedAtUtc` while `markRunCompleted`
  does, so a FAILED run carries no settle time. No reader depends on it and the
  reconciler selects on `status` and `startedAtUtc`.
* The internal extract route reports `success: true` when every part is skipped
  as oversize or storage-reference-less — a completion claim for work that did
  not run, though bounded and not a Point-5 invariant.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**

---

## Final claim verification — two defects found and corrected

Five claims from the closure report were re-verified independently. Three held.
Two did not, and both were fixed at the cause.

### CLAIM 1 — the closure assertion was NOT fully derived. FIXED.

Four of the six required predicates were already computed: registered units,
manifest units, executed case ids and suite SHA. Two were missing, and the
second was the one that mattered.

The artifact carried **no run identifier**. The SHA proves a suite has not
changed since it was proven; it says nothing about *when*. An artifact written
weeks earlier hash-matches an unedited suite forever, so the gate could report
9/9 without the integration project having run at all — and the mandated
negative test "reuse an old run id" could not even be expressed, because there
was no run id to reuse. That is stale-proof acceptance, and it was live.

Corrected by adding two predicates to the record and to the gate:

* **`runId`** — minted ONCE per integration run in
  `vitest.integration.config.ts`, so every suite in a run records the same
  value. `recordSuiteProof` now REFUSES to write a record without one: a proof
  with no run cannot be told apart from one written by hand.
* **`binding`** — SHA-256 over the registered work names plus every case the
  manifest requires. A run id says the records came from one run; the binding
  says that run was measuring the topology that exists NOW.

The gate discards any record failing SHA, run id or binding, and discards
everything if the surviving records name more than one run — a green artifact
must not be stitched together from several partial runs.

Six negative tests, each run against the corrected gate:

| # | Injected fault | Gate |
|---|---|---|
| 1 | remove one executed unit proof (`exchange.claim.one_winner`) | 3 failed |
| 2 | corrupt one suite SHA | 4 failed |
| 3a | one record carries a different (older) run id | 4 failed |
| 3b | binding points at a previous topology | 4 failed |
| 3c | records carry no run id at all — a pre-correction artifact | 5 failed |
| 4 | fictional manifest unit | 6 failed |
| 5 | family credited from a non-integration (contract) suite | 5 failed |
| — | **restore correct current-run proof** | **17 passed** |

The pre-existing artifact was itself rejected by the corrected gate and had to
be regenerated by a real run, which is the correction demonstrating itself.

`hardcoded closure truth = 0` · `stale proof acceptance = 0` ·
`missing-unit acceptance = 0` · `fictional-unit acceptance = 0`.

### CLAIM 2 — one of the eleven claim-less reconcilers was NOT safe. FIXED.

Twelve reconciliation units; one (`ImmutableStorageReconciliationSweep`) holds
a real lock. The other eleven were classified against the three permitted
grounds and driven by TWO CONCURRENT executions against ONE candidate —
sequential repetition cannot observe two writers interleaving.

| Unit | Class | Why it is safe |
|---|---|---|
| `RebuildSearchDocument` | B | unique `(teamId, documentType, sourceId)` upsert |
| `IndexMediaIntelligence` | C | deterministic search-index command id |
| `ReconcileTeamGraph` | B | graph node/edge upsert by natural key |
| `SyncTeamGraphDomain` | B | same, narrowed to a validated domain |
| `SyncTeamGraphTimeline` | B | same |
| `RefreshGraphSearchProjection` | B | search-document upsert |
| `LifecycleRecoverySweep` | C | durable `ReportGenerationRequest` + idempotency key |
| `OrphanArtifactScan` | A | counts only; mutates nothing |
| `ReviewerReconciliationSweep` | C | api-side writes dedupe on DAY-BUCKETED unique keys — `(teamId, fingerprint)` for escalations, `(teamId, kind, dedupKey)` for reminders |
| `SearchIndexStrandedReconciler` | C | deterministic command id; duplicate ticks collapse |
| `RefreshOrgHealthProjection` | **none** | **see below** |

**`RefreshOrgHealthProjection` duplicated a durable row under concurrency.**
The registry records `upsert_by_natural_key` as its only protection, and
`OrgHealthProjection`'s key is `(team_id, sampled_at_utc)` — with
`sampledAtUtc = new Date()` minted per execution. The key was therefore
different on every run, so the upsert could never collapse anything: it was an
INSERT wearing an upsert's clothes. The declared idempotency was vacuous, in
the same way the derived-asset `READY` guard was earlier in this phase.

Measured, not theorised: the concurrency probe recorded two simultaneous
executions adding a tenth row to nine.

Fixed by bucketing the sample instant to the minute, which makes the existing
primary key do the work it was declared to do. Concurrent and
immediately-retried ticks now collapse onto one row; a genuine time series
survives at any real cadence. No new lock, no parallel framework.

After the fix: `claim-less reconcilers classified = 11/11` ·
`unsafe claim-less reconcilers = 0` · `concurrent duplicate effects = 0` ·
`reconciliation units proven = 12/12`.

### CLAIM 3 — the sweep matrix is behavioural. PASSES.

All 17 sweeps carry EXECUTED case identifiers on all seven axes — success,
tenant reload, cross-tenant denial, concurrent one-winner, active-lease
respect, duplicate no-op and terminal protection — read from the SHA-verified
artifact, not from the registry.

Negative test: deleting `archive.claim.one_winner` from the proof data failed
both `ArchiveAutoTransitionSweep`'s obligations case and
`SweepsBehaviorallyCovered = 17/17`; restoring it returned 42/42.

`structural-only credited sweeps = 0`.

### CLAIM 4 — the `0 skipped` statement is truthful, and now scoped. PASSES.

Measured with the JSON reporter on each canonical command:

| Runner | Command | Files | Passed | Failed | Skipped | Todo |
|---|---|---|---|---|---|---|
| API unit | `npx vitest run` | 642 | 21,609 | 0 | **0** | **0** |
| API integration | `npx vitest run --config vitest.integration.config.ts` | 19 | 298 | 0 | **0** | **0** |
| Worker | `npx vitest run` | 47 | 846 | 0 | **0** | **0** |

**Discovery accounting.** 661 test files exist under `services/api/test`; the
unit project discovers 642 and the integration project 19. 642 + 19 = 661, so
`unexplained discovery loss = 0`. The exclusion is ONE mechanical suffix
(`*.integration.test.ts`) separating projects that need a live database from
those that do not — not a capability, directory or glob-family removed from
coverage. No `.test.tsx` file exists to fall outside the `*.test.ts` include.
No live suite is skipped or dispositioned away; all 19 RUN, against disposable
PostgreSQL 16 with pgvector.

The statement is therefore true at the strongest reading — every canonical
runner, not merely the Point-5 suites — and is stated that way rather than
left to interpretation.

### CLAIM 5 — migration rerun and duplicate resolution. PASSES, wording sharpened.

Directory names read from disk, not assumed.

**5.1 Migration-history idempotency.** A second `prisma migrate deploy`
reported `No pending migrations to apply`; the three `_prisma_migrations` rows
kept their original `finished_at`, and the governance-run state hash was
byte-identical before and after (`19ecfcef…`). Prisma did not re-execute them.

**5.2 Raw SQL rerun — TESTED, not assumed.** All three `migration.sql` files
were executed AGAIN, directly, against the post-migration database:

| | Result |
|---|---|
| all three re-execute | OK |
| row state | unchanged (`19ecfcef…` → `19ecfcef…`) |
| duplicate objects | none — all four partial indexes identical |
| kind CHECK | identical |
| `report_generation_requests` | 20 columns, unchanged |

The forward-resolution UPDATEs are predicated on a duplicate still existing, so
a second pass matches nothing; every DDL is `IF NOT EXISTS`. Both properties
hold, and they are DIFFERENT properties — the earlier report's "re-running is
safe" conflated them. Stated separately now.

**5.3 Duplicate resolution, before and after.**

| | id | status | lock key | started | reason |
|---|---|---|---|---|---|
| before | …601 | RUNNING | RETENTION/global | 20:06:44 | — |
| before | …602 | RUNNING | RETENTION/global | 20:16:44 | — |
| after | …601 | **FAILED** | RETENTION/global | 20:06:44 | `point5_duplicate_running_run_resolved_by_atomic_lock_migration` |
| after | …602 | RUNNING | RETENTION/global | 20:16:44 | — |

Rows 2 → 2: the competing duplicate is **not deleted**, does **not** become
SUCCEEDED, and carries an explicit bounded reason naming the migration that
resolved it. The newest row keeps the slot. All other rows preserved
(evidence 1 → 1, `media_intelligence_runs` 3 → 3, including the historical-only
`compute_duplicates` and `compute_lineage` kinds).

Later valid work: while …602 was RUNNING a third insert was **refused** by the
partial unique index; after settling it to SUCCEEDED the same insert
**succeeded**. The index bounds concurrency without bounding the future.

**5.4 Final schema and readiness.** `report_generation_requests` 20 columns /
5 indexes; media-intelligence kind CHECK enumerates 14; all four partial
indexes present; `vector` extension, `embedding_vector` column and ivfflat
index present. Readiness exit **0** with pgvector and exit **20** on a plain
`postgres:16-alpine` whose chain replayed cleanly — the guarded-out state is
correctly not a ready state.

`destructive duplicate deletion = 0` · `invented success = 0` ·
`unresolved active duplicates = 0` · `Prisma second deploy mutation = 0`.

### Production procedure — unambiguous

```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter proovra-api prisma:migrate      # applies the three, once
DATABASE_URL="$DATABASE_URL" pnpm --filter proovra-api db:point5-vector-readiness
DATABASE_URL="$DATABASE_URL" pnpm --filter proovra-api db:raw-schema-verify
```

`prisma migrate deploy` is safely repeatable because applied migrations are
never re-executed. The migration SQL is additionally safe to rerun raw — that
was verified above — but there is no operational reason to do so, and the
supported procedure is `prisma:migrate` only.

**PRODUCTION MIGRATIONS NOT APPLIED — OWNER EXECUTION REQUIRED.**
