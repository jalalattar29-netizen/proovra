# PHASE 13 — CONTINUATION CHECKPOINT

The ONE resume note. Every scalar below is CITED from
`audit-output/current/architecture-facts.json` and is re-derived at test time by
`services/api/test/phase-13-checkpoint-truth-gate.test.ts`, which also refuses a
second active-state section, a scalar that disagrees with the facts, the same
scalar printed twice with different values, and a NEXT COMMANDS entry naming a
script that does not exist. A name printed here must have a derivation in
`services/api/scripts/audit/engine/checkpoint-truth.mjs`; one that does not is
rejected. That is what stops this file growing a hand-maintained counter again.

Baseline commit `b69289c1`, uncommitted. External recovery snapshot:
`D:\p13-recovery-snapshot`. Disposable infra: `p12-pg` (host 55432),
`p12-redis` (56379), `p7-minio` (59000, bucket `point7-local-bucket`).

## VERDICT

```
LOCAL_COMMIT_READY                             NO
PRODUCTION_DEPLOY_READY                        NO
```

**Why NO:** not because anything measured is failing. Every local gate this
programme owns now reads clean, including the browser layer that was the open
half. What has NOT happened is the FRESH FULL POINT-7 RUN executed as one
sequential certification, and the full repository certification list beside it.
Those are the next phase's work, and until they run there is no basis for a
commit-ready claim.

The distinction matters and is the reason this file does not say YES: the
Point-7 artifact is internally coherent and fresh (one run id, one build id, one
scenario binding, production build, strict CSP), but it was produced as two
layer runs inside a repair phase rather than by one certification pass over a
tree nobody is still editing.

## CURRENT STATE

```
ROUTES / TENANCY
ProductionRegisteredRoutes                  1169
RegisteredRoutes                            1170
TenantBindingUnresolved                        0
TenantUnboundInsertRoutes                      0
OrganizationAuthorizationUnresolved            0
OrganizationRoutesMissingRequiredAuthorization 0
UndisposedRoutes                               0
ClassificationConflicts                        0
AuthorizationUnresolved                        0

MUTATION CLOSURE (eleven disjoint buckets, identity asserted)
TerminalWriters                             1306
ROUTE_ATTRIBUTED_REACHABLE                  1166
JOB_ATTRIBUTED_REACHABLE                     121
MODULE_SCOPED_REACHABLE                        0
REGISTERED_CLI                                 3
STARTUP_OR_SCHEDULED                          16
MIGRATION_ONLY                                 0
TEST_OR_BUILD_ONLY                             0
PRESERVED_PLANNED_WRITER                       0
PORT_ATTRIBUTED_REACHABLE                      0
DEAD_UNREACHABLE                               0
UNRESOLVED                                     0
UnwiredExecutableWriters                       0
MutationWriterConservationHolds             true
DeadUnreachableWritersPending                  0
UnclassifiedMutationWriters                    0
MutationReachabilityUnresolved                 0
AuthorizationAfterMutation                     0
TenantUnboundMutations                         0
LegacyWriters                                  0
ParallelMutationAuthorities                    0
OrphanQueueProducers                           0
UnprocessedQueueFamilies                       0
MutationClosurePass                         true

PRODUCT (route disposition, from the generated map)
ProductConsumedRoutes                        969
NonProductDispositionedRoutes                200
MissingProductUiReleaseRequired                0
ConservationIdentityHolds                   true

CLOSURE
OpenActionableFindings                         0
StaleDomainProofs                              0
LedgerRowsConserve                          true
LedgerActionableConserves                   true
ReleaseBlockingClosure                      PASS

BROWSER — NOW CLOSED
Point7Fresh                                 true
BrowserProvenScenarios                        92
ImplementedUiCapabilities                     23
BrowserVerifiedUiCapabilities                 23
NEW-027Runtime                              PASS
NEW-028Runtime                              PASS
NEW-029Runtime                              PASS
NEW-058Runtime                              PASS
```


### THE DEAD WRITERS ARE GONE, AND FOURTEEN ROUTES ARE DISPOSITIONED

`MutationClosurePass` was false and `UndisposedRoutes` was 14 on the tree this
phase started from — the 2026-09-06 collaboration closure retired routes and
deleted web clients without regenerating the artifacts, so the committed map
described a tree that no longer existed.

FIVE WRITERS, DELETED. `createEmailInvite` and `recordInviteDeliveryResult` in
`collaboration-team.service.ts`, and `markNotificationRead`,
`markAllNotificationsRead` and `updateMyNotificationPreference` in
`collaboration-completion.service.ts`. Each one's route had been retired to a
typed 410 — group invitations into the one workspace invitation authority, team
notifications into the inbox that reads the same rows and marks the same
`readAt` column — leaving executable code nothing could reach.
`writer-preservations.json` is explicit that this is not a final state, so they
are gone rather than re-declared as preserved. `acceptInvite`, `revokeInvite`
and `emitTeamNotifications` remain and are reachable.

SIXTEEN ROUTES, DISPOSITIONED with the call sites read: five retired
notification and preference doors as COMPATIBILITY_TOMBSTONE (a typed 410
naming its replacement is a door worth keeping shut rather than 404-ing), eight
live-but-unconsumed guest, access-review and activity-v2 routes as
MISSING_PRODUCT_UI_POST_RELEASE, and the new server-paged
`GET /v1/teams/:id/members` the same way — it was added ahead of the surface
that will use it.

Two more arrived while this was in flight and are dispositioned the same way:
the retired group email-invite door as a tombstone (it answers 410 naming the
two routes that replace it), and the canonical body-token invite accept as
MISSING_PRODUCT_UI_POST_RELEASE — the accept page still calls the legacy
token-in-URL path, so the safer door has no caller yet.

Result: UndisposedRoutes 0, DEAD_UNREACHABLE 0, ClassificationConflicts 0,
MutationClosurePass true, AuditEngineIntegrity PASS.

### 2026-09-17 — TWENTY-THREE MORE DEAD WRITERS, DELETED

The admin/enterprise closure retired routes to typed 410s by owner decision
(`services/api/test/retired-routes-2026-09-16.test.ts`), and regenerating the
facts showed 23 writers left with no entrypoint. None was re-declared as
preserved; each was deleted with the service function that held it:
`openAccessReview`, `decideAccessReviewItem`, `completeAccessReview` and
`revokeGuest` (group access reviews and guests); `grantContributorAccess` and
`revokeContributorAccess` (thread contributors); `markPackageReady`;
`updateMfaPolicy` (superseded by `updateMfaPolicyVersioned`);
`enqueueIntelligenceJob`; the similarity detectors behind
`reconcileSimilaritiesForEvidence`; `markArticleNeedsReview`; the three
workspace workflow-template writers; and `createWorkflowInstance`,
`transitionInstance`, `assignReviewer` and `mapEvidenceToStep` in the
workflow engine. The workspace-level `completeAccessReview` in
`identity/access-review.service.ts` is a different, live function and stays.

Result: DEAD_UNREACHABLE 0, UnwiredExecutableWriters 0, MutationClosurePass true.

### 2026-09-17 — UC-3 ANDROID CONTINUOUS SCREEN CAPTURE (+1 route, +1 writer)

The continuous/streaming screen-capture use case adds ONE product route,
`POST /v1/capture/direct-sessions/:id/continuous-complete`
(`services/api/src/routes/capture-trust.routes.ts` →
`completeContinuousCaptureSession` in
`services/api/src/services/capture-trust/continuous-capture.service.ts`), which
seals ONE Evidence from N ORIGINAL segments plus a continuity manifest through
the SAME canonical direct-capture completion pipeline (`completeDirectCapture`,
reused — not a second completion authority) and then labels the manifest part.
It is declared PRODUCT_CONNECTED in `route-dispositions.json` with consumer
`apps/mobile/src/continuous-capture.ts`. Its two mobile UI call sites build a
runtime capture-session path that cannot be static (the session is opened at
START so segments stream during recording), so both are recorded in
`dynamic-resolutions.json` — the same treatment every runtime-session path
requires. The acquisition mode `DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS` is
admitted by EXPAND constraint-swap migration
`20280640000000_uc3_continuous_screen_capture_acquisition_mode` (registered in
every gate; NOT applied to Production).

Result deltas after UC-4 DERIVED screen intelligence (2026-09-18): two new
media-intelligence routes (GET/POST derived-review) take ProductionRegisteredRoutes
to 1157, RegisteredRoutes to 1158, ProductConsumedRoutes to 956; the UC-4 worker
handler + persistence service add job-attributed writers, taking
JOB_ATTRIBUTED_REACHABLE to 128 and TerminalWriters to 1267 (ROUTE_ATTRIBUTED_REACHABLE
unchanged at 1121). UC-4 rides the existing media-intelligence queue as run kind
`reconstruct_screen`, admitted by EXPAND constraint-swap migration
`20280650000000_uc4_screen_intelligence` (registered in every gate; NOT applied to
Production). UndisposedRoutes 0, DynamicUnresolvedConsumers 0, MutationClosurePass
true, AuditEngineIntegrity PASS.

Result deltas after NATIVE CONVERGENCE CLOSURE (2026-09-22). Three route
registrations and one instrument repair, with nothing else moved by hand:

  * THREE NEW ROUTES take ProductionRegisteredRoutes 1157 -> 1160 and
    RegisteredRoutes 1158 -> 1161, and their handlers take TerminalWriters
    1267 -> 1269 and ROUTE_ATTRIBUTED_REACHABLE 1121 -> 1123. They are
    `GET /v1/legal` and `GET /v1/legal/:slug` (the canonical server-served
    legal corpus, which is how Native reads legal text without a second copy
    or a browser), plus one capture-trust registration.

  * ProductConsumedRoutes 956 -> 961 is NOT five new consumers. It is the
    capability analyzer learning to follow an imported path builder, which it
    already did for an imported const. The native app states every endpoint as
    a pure builder in `apps/mobile/src/product/*`, so a hundred calls to
    routes this repository owns had been reported "unsupported expression kind
    CallExpression" and counted as unresolvable. Those routes were always
    consumed; the instrument could not see it. DynamicUnresolvedConsumers
    100 -> 0 in the same pass.

  * NonProductDispositionedRoutes 201 -> 199 follows from the same repair.
    `GET /v1/cases/summary` moved SUPERSEDED_REMOVE -> PRODUCT_CONNECTED
    because its claim "no UI owed" was contradicted by the tree (the native
    Cases tab reads it for four counters the replacement does not carry), and
    the native inbox migrated off the tombstoned `snooze` and `dismiss`
    aliases onto the canonical `remind` and `archive`.

Result deltas after BD-2 DURABLE BATCH JOBS (2026-09-22). One number moved,
and it is the same number twice:

  * TerminalWriters 1269 -> 1279 and ROUTE_ATTRIBUTED_REACHABLE 1123 -> 1133.
    The SAME TEN writers, and no route was added. Batch analysis kept its jobs
    in a plain object on a module singleton, so a restart lost every job and a
    second API instance could not see the first one's; the state moved into
    `batch_analysis_jobs` / `batch_analysis_job_items` and ten database
    writes exist where ten in-memory assignments used to. All ten are reachable
    from the batch-analysis routes, which is why both scalars move by the same
    amount and DEAD_UNREACHABLE stays 0.

    Two instrument lessons are recorded in the code itself. The writers were
    first reported DEAD_UNREACHABLE because, as methods of a class nothing
    imports by name, their enclosing declaration was `BatchAnalysisService`;
    they are module-level functions now. Three of them went unreachable AGAIN
    when the facade aliased them (`createJob: createBatchJob`) — the trace
    follows the name the caller uses — so each facade key is now the function's
    own name. And `processBatch` and `cancelJob` were correctly reported
    tenant-UNBOUND while they matched on job id alone and relied on the route
    having checked ownership one call earlier; every write carries the owner
    predicate now, which is the rule the reads in that service already followed.

Result deltas after ARTIFACT RECOVERY GATE A (2026-09-26). One number moved,
and it is the same number twice:

  * TerminalWriters 1280 -> 1282 and JOB_ATTRIBUTED_REACHABLE 128 -> 130. The
    SAME TWO writers, both in the report worker and no route was added: the
    generation request row now records its durable progress
    (`report_version`, `stage`) inside the report transaction and inside the
    package transaction, so a retry resumes at the package for the report
    version it already committed instead of minting another. Both writes run
    only from the report job, which is why both scalars move by the same amount
    and DEAD_UNREACHABLE stays 0.

Result deltas after ARTIFACT RECOVERY GATE B (2026-09-26). One writer:

  * TerminalWriters 1282 -> 1283 and ROUTE_ATTRIBUTED_REACHABLE 1134 -> 1135
    (AUTOMATION_QUEUE_WEBHOOK 114 -> 115). An explicit Retry of a request that
    failed retryably re-enqueues THAT request (`reenqueueReportGenerationRequest`)
    instead of minting a new one; it is reachable from
    `POST /v1/evidence/:id/reports/regenerate` through the one recovery service
    (`services/reports/output-recovery.service.ts`, the one new production
    module). No route was added: the per-output action contract, the D5 403,
    the D6 limits and the operator supersession all ride the existing
    endpoints.

Result deltas after BILLING PAYPAL INTEGRITY (2026-09-28). One route, 18 writers:

  * ProductionRegisteredRoutes 1166 -> 1167, RegisteredRoutes 1167 -> 1168 and
    ProductConsumedRoutes 966 -> 967: `POST /v1/billing/checkout/paypal/returns/canceled`
    closes the checkout attempt a buyer cancelled at PayPal (consumed by the web
    PayPal return handler), so an unapproved subscription stops blocking checkout.
  * TerminalWriters 1300 -> 1318 and ROUTE_ATTRIBUTED_REACHABLE 1152 -> 1170, all
    BILLING_SUBSCRIPTION_SEAT: billing review items (2, new table
    `billing_review_items`), canonical storage activation/refusal (4), refund
    reversal of credits (3, incl. payment status), payment product
    classification (2), approval expiry of attempts and plan changes (4),
    obligation withdrawal and storage reconciliation (2), legacy local-termination
    repair (1). Every one is reached from an existing billing route, webhook or
    the reconciliation job; DEAD_UNREACHABLE stays 0.

AuditEngineIntegrity returned to PASS in this pass, from FAIL with
DynamicUnresolvedConsumers 103, UnreviewedOriginConsumers 2,
AmbiguousConsumerSites 1 and ClassificationConflicts 5.

### 2026-09-29 — EVIDENCE OUTPUT LIFECYCLE (TerminalWriters 1318 -> 1309)

Measured by diffing writer ids against the branch base (40135a80), not
asserted. REMOVED:

- `services/worker/src/processor.ts` copyObject + deleteObject and
  `services/worker/src/storage.ts` CopyObjectCommand — the staging PUT, the
  lock-carrying copy and the staging cleanup. ONE conditional, checksummed PUT
  (`services/worker/src/immutable-publication.ts` PutObjectCommand, ADDED)
  replaces them.
- `packages/shared-runtime/src/evidence-destruction/executor.ts` and
  `reconcile-destroyed-derivatives.ts` deleteObject — destruction now deletes
  object VERSIONS through the shared version-aware port.
- `services/api/src/storage.ts` DeleteObjectCommand — the API key-level
  `deleteObject`, left with zero entrypoints by the port change, DELETED, so
  DEAD_UNREACHABLE stays 0 and PORT_ATTRIBUTED_REACHABLE is 1 -> 0.
- Two read-then-write updates became compare-and-set `updateMany` (same
  writers, new ids): the TSA stored-token repair script and the source-truth
  incident close.

Bucket deltas: ROUTE_ATTRIBUTED_REACHABLE 1170 -> 1168, JOB_ATTRIBUTED_REACHABLE
130 -> 124, PORT_ATTRIBUTED_REACHABLE 1 -> 0. Every removed writer is a retired
path; no product capability lost its writer.

### 2026-09-29 — OTS / ANCHORING / UNSCOPED CONDITIONS / EXCHANGE (routes 1168 -> 1170, writers 1309 -> 1306)

Measured against the previous commit, not asserted.

- RegisteredRoutes 1168 -> 1170 (ProductionRegisteredRoutes 1167 -> 1169,
  ProductConsumedRoutes 967 -> 969): `GET /v1/admin/incidents/:id` and
  `POST /v1/admin/incidents/:id/remediate`, both `requirePlatformAdmin`, both
  consumed by `apps/web/app/(app)/admin/operations/page.tsx` (the Recover
  panel). They inspect and recover report/package conditions, including those
  with no workspace row.
- TerminalWriters 1309 -> 1306, JOB_ATTRIBUTED_REACHABLE 124 -> 121: the four
  unconditional `evidence.update` writes in `services/worker/src/ots-upgrade.processor.ts`
  are replaced by ONE compare-and-set `evidence.updateMany` in
  `services/worker/src/ots-state.ts` (`applyOtsTransition`). Every other id
  change in the diff is a line shift.

### 2026-09-29 — LIFECYCLE STABILIZATION (writers 1306 -> 1307)

Measured against the previous commit, not asserted.

- TerminalWriters 1306 -> 1307, ROUTE_ATTRIBUTED_REACHABLE 1168 -> 1169,
  CASE 79 -> 80: `caseSiuExport.updateMany` in
  `packages/shared-runtime/src/evidence-destruction/executor.ts`
  (`executeEvidenceDestruction`, inside the destruction transaction). When a
  record is destroyed, the SIU export bundles of its cases — which carried its
  report and package, and whose objects the executor now deletes and verifies
  gone (audit H2) — are marked as pointing at nothing. Reached only from the two
  existing destruction routes and the destruction orchestrator; no new route.
- ProductionModules 916 -> 917: `services/api/src/services/governance/
  finalization-governance.service.ts`, the one finalization governance gate
  (audit D3). It holds no terminal writer.

### 2026-09-29 — BYTE-RELEASE AUTHORITY / REFUSED FINALIZATION (writers 1307 -> 1308)

Measured against the previous commit, not asserted.

- TerminalWriters 1307 -> 1308, ROUTE_ATTRIBUTED_REACHABLE 1169 -> 1170,
  EVIDENCE_CUSTODY_FINALIZATION 294 -> 295: `evidence.updateMany` in
  `services/api/src/services/governance/finalization-governance.service.ts`
  (`evaluateFinalizationGovernance`). A finalization the workspace policy
  refuses marks the still-unsigned record NOT_PUBLISHED (the column default is
  PUBLISHED, so a refused record read "Published" in the library filter). It
  is bounded to `signedAtUtc: null` and reached only from the existing
  finalizers (web complete, direct capture, external intake); no new route.
- The byte routes (/original, /parts, /report/latest, /verification-package,
  the content views, the SIU export and its re-download) now call THE shared
  download gate; their inline governance copies were removed. No writer is
  added or removed by that move: the refusal custody event was already
  written through `appendCustodyEvent`.

`ReleaseBlockingClosure` is DERIVED from two inputs — open actionable findings
and undisposed routes. Both are zero, so it prints PASS. That is a statement
about the LOCAL evidence and nothing wider: `node services/api/scripts/audit/
index.mjs --closure-check` reports the same verdict from the same two inputs,
and it is not a release decision.

## WHAT PHASE 2 CLOSED

**The browser layer went from 42 scenarios under two run ids to 94 under one.**
The canonical manifest requires 94 BROWSER-layer scenarios; the run executed 90
tests and recorded exactly 94, with zero missing and zero unexpected. The
denominator comes from `scenario-manifest.ts`, so this is a reconciliation and
not a count of whatever happened to pass.

**NEW-058 is FIXED_VERIFIED, and the disposition moved because a run happened.**
Eight browser scenarios in `e2e/point7/new-058-account-bound-step-up.spec.ts`
prove the half no server suite can reach, because the defect WAS the request
body: the challenge-start Chromium actually issues carries none of nine
destination-shaped fields and does not contain the enrolled number anywhere in
its payload, yet the server still delivers a code — so the destination was
resolved from the account's factor. Enrolment renders for a CORE-tier Personal
Settings account and takes a user from no factor to ACTIVE with
`verified_at_utc`, using only the code the recording provider captured. The raw
destination appears in no API projection, no DOM node and no console line. An
unenrolled account is refused by the ROUTE with 403
`STEP_UP_ENROLLMENT_REQUIRED` and offered an actionable link to enrolment. A
wrong code leaves the record unpublished. A factor revoked between approval and
spend kills the unspent elevation. A client still sending `phone` is refused 400
by the strict schema — with a positive control proving the SAME body without it
is accepted, so the refusal is attributable to the destination field and not to
some other malformation.

**`browserVerified` is no longer a field a person types.** Rows NEW-027,
NEW-028, NEW-029 and NEW-058 each carried a note saying their disposition would
move "only from an executed browser run, never by hand", and nothing enforced
it. `audit-output/current/ledger/generate-ledger.mjs` now DERIVES the value from
`docs/architecture/point7-proven-scenarios.json` and refuses any row that
disagrees in EITHER direction — claiming a PASS the run did not earn, or
claiming NOT_EXECUTED after a run that did. The family denominator comes from
the scenario manifest, so adding a scenario to a family re-opens that family's
credit until it too has run.

**The MFA orchestrator byte pin was resolved by EXTRACTION, not rebaselining.**
NEW-058's enrolment routes had been written inside
`identity-security.routes.ts`, pushing it to 58,452 bytes against a 50,951
ceiling. The pin was right that the orchestration boundary had been crossed and
had no useful way to say so — it reports a number, not an architecture. The four
contact-factor routes moved to `identity-security-contact-factors.routes.ts`, a
distinct capability with a distinct authority
(`verified-contact-factor.service.ts`), and the file returned to 47,247 bytes —
inside the existing baseline as a CONSEQUENCE. The pinned number was not
touched.

The invariant it was proxying for is now asserted directly and adversarially in
`services/api/test/phase-13-mfa-orchestrator-boundary.test.ts` (17 cases, 10 of
them refusals plus a positive control), over an AST rather than a character
window — NEW-047 was exactly the defect of deciding authority by window match.
Scope is decided by the step-up authority a handler CALLS, not by the path it
registers, so moving the route does not evade it and
`/v1/communications/verify/start` — which legitimately takes a phone — is
correctly out of scope.

**One scenario had been passing without claiming its credit.**
`p7.ui.governance.denied_without_authority` executes a six-route server-refusal
matrix and never called `proven(...)`, so it ran green on every pass while the
manifest reported it as never executed. The reconciliation is what surfaced it:
the denominator comes from the manifest, so a scenario that does not record
itself stays missing however often its test passes.

**A changed path had no classification, and the table was right to refuse it.**
`apps/web/middleware.ts` matched none of `PRODUCTION_RUNTIME_ROOTS`, all of
which are directory prefixes, so it fell out of every class. Having looked at
it: it executes on every request and builds the production CSP, including the
`connect-src` entries naming the API and object-store origins. It is now
classified `PRODUCTION_RUNTIME` by exact filename, so the config files beside it
are not swept in with it.

## ORIGINAL-40 BROWSER CLOSURE — PRESERVED

```text
Original40Closure    PASS
Original             40
FinalPassed          40
FinalFailed           0
```

The 40-row denominator is frozen in `.p7tmp/original-40.json` and re-executed as
one serial set by `.p7tmp/phase-orig40/run40.mjs`, which REFUSES a run that does
not execute exactly those ids. Phase 2 did not reopen it. All forty ids are a
subset of the 94 the full browser set re-executed under run id `phase2`, so the
proof was renewed rather than merely inherited.

## MIGRATION RELEASE CLOSURE — CLOSED

The NEW-058 migration `20271201000000_new058_verified_contact_factors` is now
registered in both authorities and in the release sequencing. Its bytes were not
touched: SHA-256 `7b6c632e…988ee` before and after, and the same digest is
recorded by the inventory, by Prisma in both rehearsal databases, and on disk.

| | |
|---|---|
| migration directories on disk | 235 |
| classified inventory rows | 235 (was 234) |
| unregistered migrations | 0 (was 1) |
| Point-8 release-artifact failures | 0 (was 3) |
| historical migrations modified | 0 |
| classification | `EXPAND`, derived SQL shape `BACKFILL`, zero destructive statements |
| release wave | `WAIT_FOR_RUNTIME_CUTOVER` — Release C |

**The wave was derived, not chosen.** It is the one wave meaning "not safe ahead
of its image": `mfa_factors_active_is_verified_chk` requires `verified_at_utc`
on any ACTIVE row, and HEAD's `mfa.service.ts` never writes that column (the new
build stamps it under NEW-072). Applying it before the API deploy would make the
next TOTP activation on the old code violate the constraint; the new build also
requires it, so it cannot be deferred past the cutover either.

**A silent-drop defect was found and fixed while doing this.**
`WAIT_FOR_RUNTIME_CUTOVER` was legal in the inventory generator, the Point-6
closure test, the deployment plan and the runbook's wave→release table — and
absent from `WAVES` in `release-deploy.mjs`, because Release C had never carried
a migration. The first migration to use it would have been deferred out of A_B,
C **and** D alike while every deploy reported success. It now sits in C and D,
and two new assertions in the Point-8 gate keep it that way: one refuses any
inventory wave that no release applies, the other requires a cutover migration to
be selected by C and D and never by A_B.

Rehearsed on disposable PostgreSQL 16 only: a fresh 235-migration chain; a
representative pre-migration tree (wave A_B, which correctly deferred it) seeded
with a no-factor user and ACTIVE/ENROLLING/REVOKED TOTP factors, then wave C.
The bounded backfill stamped `enrolled_at` where present and fell back to
`created_at` where not, left ENROLLING and REVOKED rows untouched, and created no
contact factor at all. Five refusal cases were observed refusing and one positive
control accepted.

## RESUME HERE

Phase 2 and the migration-release pass left no failing gate and no open
actionable finding. What remains is certification, not repair:

1. **Fresh full Point-7**, both layers in ONE sequential run:
   `node scripts/point7-run.mjs`. The current artifact is fresh and coherent but
   was produced as two layer runs during a repair phase.
2. **Full sequential repository certification** — the complete API suite, web,
   worker, shared, lint, typechecks, builds, `db:preflight`, raw-schema-verify,
   migration-inventory, reachability, secret scan.
3. **Owner commit and push.** Nothing in Phase 2 was staged; the git index is
   still the 127 entries it started with.
4. **External operations** — staging environment, provider credentials, applying
   the migrations to a real database, deployment. None of these are reachable
   locally and none were attempted. The NEW-058 migration is now fully
   sequenced for that work (Release C, above); what remains is running it.

## CERTIFICATION AS IT STANDS

```
Point-7 SERVER       686 / 686     42/42 files · EXIT CODE 0 · live PostgreSQL 16
Point-7 BROWSER       90 / 90      94 scenarios · production build · strict CSP
Focused API suites   555 / 555     22 files (identity-security, MFA, step-up)
MFA boundary gate     17 / 17      10 refusals + positive control
typecheck            proovra-api · proovra-web — both exit 0
audit engine         AuditEngineIntegrity = PASS
ledger               98 fixed + 0 remaining = 98 actionable; 105 rows conserve
migration gates      point6 closure 19/19 · point8 artifact 23/23 · manifest 19/19
migration inventory  235 on disk · 235 classified · conservation holds · 0 gate failures
git index            UNTOUCHED — 127 staged entries, exactly as found
```

## NEXT COMMANDS

```
node scripts/point7-run.mjs
node services/api/scripts/audit/index.mjs --closure-check
```

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION B1: ONE EvidencePart WRITER (writers 1308 -> 1306)

- ET-UPL-01: the three `evidencePart.create` call sites (parts route, external
  intake, upload-session bridge) collapse into
  `services/evidence/evidence-part-writer.service.ts` (`writeEvidencePart`).
- TerminalWriters 1308 -> 1306, ROUTE_ATTRIBUTED_REACHABLE 1170 -> 1168: two
  route-reachable direct writers are gone; the canonical writer is reached
  through the same routes.

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION P0: DETACH NEVER CHANGES OWNERSHIP (writers 1306 -> 1305)

- ET-SEC-02: the case-detach "return to the personal pool" `evidence.update({ teamId: null })`
  is deleted (Invariant C). TerminalWriters 1306 -> 1305, ROUTE_ATTRIBUTED_REACHABLE 1168 -> 1167.

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION: ONE CUSTODY APPENDER, ONE RESERVATION AUTHORITY (writers 1305 -> 1306)

- Custody serialization: the three appenders (api custody-events.service
  `appendCustodyEventTx`, worker custody-events `appendCustodyEventTxInner`,
  executor `appendCustodyEventInTx`) collapse into shared-runtime
  `custody/custody-chain.ts` `appendCustodyEventTx` (-3, +1).
- ET-ACQ-02 / ET-DC-05 / ET-DC-06: the discard's hand-rolled release is replaced
  by shared-runtime `evidence-reservation/reservation.ts`
  `releaseEvidenceReservationTx` (-1, +1); the Worker's
  `releaseExpiredReservations` adds the expired-session claim and the release
  it reaches from the capture sweep (+2); the sliding session expiry adds
  `extendDirectCaptureSessionOnActivity` (+1).
- TerminalWriters 1305 -> 1306. JOB_ATTRIBUTED_REACHABLE 121 -> 120 (the
  executor's own appender no longer exists; job paths reach the shared one).
  STARTUP_OR_SCHEDULED 14 -> 16 (the capture sweep's two new writers).

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION B7: CUSTODY (writers 1306 -> 1305)

- ET-CUS-05: the API `appendPlatformAuditLog` and the Worker
  `appendWorkerAuditLog` each created `adminAuditLog` rows; both now reach
  shared-runtime `audit/admin-audit-chain.ts` `appendAdminAuditChainRowTx`
  (-2, +1). TerminalWriters 1306 -> 1305; JOB_ATTRIBUTED_REACHABLE 120 -> 119
  (the Worker's own writer no longer exists).
- The tenant-binding instrument's INFRASTRUCTURE_ACCESSES entry for the chain
  append follows the file it moved to (same code, same fact); without it 25
  account-self routes read as tenant-unbound because the chain's head read
  had changed path, not behaviour.
- ET-CUS-02..14 add custody writes inside existing transactions (same writer
  sites); no other bucket moves.

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION B8: REPORTS / RECOVERY (writers 1305 -> 1304)

- ET-REC-09: the communications retry and cancel-retry routes each wrote
  `communicationMessage.update` after a separate read; both now reach
  `transitionCommunicationForOperator` (one conditional `updateMany` + tenant
  audit in one transaction) (-2, +1). TerminalWriters 1305 -> 1304,
  ROUTE_ATTRIBUTED_REACHABLE 1167 -> 1166.
- consumer-resolutions: the reviewed answer for the mobile Operations
  lifecycle call follows it (388 -> 391 after ET-REC-04's imports) and gains a
  line-independent `match` block.
- The other B8 fixes change reads, projections, copy and worker return values;
  no other bucket moves.

### 2026-09-29 — EVIDENCE-LIFECYCLE REMEDIATION B9: QUEUES (writers 1304 -> 1306)

- ET-Q-05: `writeSweepCursor` (`workerSweepCursor.upsert`, new table
  `worker_sweep_cursors`) — the trash-grace sweep's resume point (+1).
- ET-Q-04: `releaseDerivativeClaim` (`redactionDerivative.updateMany`,
  RENDERING -> QUEUED after a transient failure) (+1).
- Both are reached from worker job/sweep paths: TerminalWriters 1304 -> 1306,
  JOB_ATTRIBUTED_REACHABLE 119 -> 121.
- Instrument: `workerSweepCursor` is mapped to AUTOMATION_QUEUE_WEBHOOK (sweep
  machinery); the reviewed demo follow-up fetch is re-anchored :459 -> :468
  and its note corrected (the url is built from `internalApiBase`).
- ET-Q-07 is left open: wiring or retiring the five producer-less queues is an
  owner decision.
