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
ProductionRegisteredRoutes                  1116
RegisteredRoutes                            1117
TenantBindingUnresolved                        0
TenantUnboundInsertRoutes                      0
OrganizationAuthorizationUnresolved            0
OrganizationRoutesMissingRequiredAuthorization 0
UndisposedRoutes                               0
ClassificationConflicts                        0
AuthorizationUnresolved                        0

MUTATION CLOSURE (eleven disjoint buckets, identity asserted)
TerminalWriters                             1250
ROUTE_ATTRIBUTED_REACHABLE                  1130
JOB_ATTRIBUTED_REACHABLE                     106
MODULE_SCOPED_REACHABLE                        0
REGISTERED_CLI                                 3
STARTUP_OR_SCHEDULED                           9
MIGRATION_ONLY                                 0
TEST_OR_BUILD_ONLY                             0
PRESERVED_PLANNED_WRITER                       0
PORT_ATTRIBUTED_REACHABLE                      2
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
ProductConsumedRoutes                        889
NonProductDispositionedRoutes                227
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
BrowserProvenScenarios                        94
ImplementedUiCapabilities                     24
BrowserVerifiedUiCapabilities                 24
NEW-027Runtime                              PASS
NEW-028Runtime                              PASS
NEW-029Runtime                              PASS
NEW-058Runtime                              PASS
```

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
