# PHASE 12 — POINT 7: corrective closure

**Date:** 2026-08-05 · **Run id:** `4086fdcf-6891-41f4-a602-e5dc3c11a31e`

This pass did not rebuild Point 7. It contained a production-isolation
failure, closed twelve outstanding test failures at their traced causes,
corrected a finding that turned out to be wrong, and regenerated both proofs
from a single run.

---

## 1. The isolation failure, and what actually caused the six API failures

The containment work (canonical `--import` preload, outbound guard, scrubbed
environment) was already in place and passing 12/12. The six remaining
integration failures were **caused by that containment**, not by production:

`test/setup/safe-environment.ts` re-ran its full credential scrub in a
`beforeEach`. `provider-not-configured.integration.test.ts` sets
`INTERNAL_SERVICE_TOKEN` to a test literal in `beforeAll`; the key contains
`"TOKEN"`, so the re-scrub deleted it before every test. The internal route
answered `401 Internal service token not configured`, and
`internal-api-client.ts` mapped a `success:false` body carrying no `error`
field to its fallback — the generic `extraction_failed` the suite reported. The
harness was manufacturing the failure it then attributed to production. The
reviewer-workflow `401` was the same key.

**Fix — the re-assert is now value-aware.** The preload fingerprints
(SHA-256) the inherited environment and the `.env` files on disk and publishes
only the question `isMachineSuppliedValue(key, value)`. The first pass still
scrubs everything credential-shaped; every later pass removes a dangerous key
only when its value is one the machine supplies. A value the run chose
survives. No secret is copied into a variable, written to a file, or logged.

## 2. Production defects found and fixed

| # | Defect | Traced cause |
|---|---|---|
| P1 | `issueIntakeToken()` / `hmacForIntake()` minted live values with the intake feature **disabled** | Both gated on the secret only, never on `WORKFLOW_INTAKE_LINKS_ENABLED`. The tests named "returns null when feature is disabled" passed only because a machine with the flag off also had no secret. Flag off + secret still bound — what a rollback looks like — kept issuing. Both now consult `isWorkflowIntakeFeatureEnabled()`. |
| P2 | A background worker failure was filed under the transaction `GET /health` | `captureException` ran on whatever span was ambient. Now `Sentry.startNewTrace` + `withIsolationScope` + an explicit `queue.<name>` transaction. |
| P3 | `runJobWithTelemetryContext` existed and **nothing used it** | Now installed in `wrapJobHandlerWithOtelContext`, the one seam every BullMQ handler passes through. Tags go on the **isolation** scope, so an exception raised deep in a handler still carries the job's identity. |

## 3. A finding that was wrong, and is corrected in the record

An earlier revision of `docs/operations/point7-queue-incident-runbook.md`
argued that `job_kind=graph-reconcile` on a `processPurgeDeletedEvidence` stack
was scope bleed from `setSentryCorrelationContext`. Tracing the actual capture
path shows the opposite:

* `setSentryCorrelationContext` is called **nowhere** in the worker's job path.
  It cannot have caused anything observed.
* `job_kind` comes from `captureException(err, { jobKind })` in the `failed`
  handler, where `jobKind` is the closure naming the queue that worker instance
  serves, captured inside `withScope`. **The tag is trustworthy.**
* Only the transaction was bleed.

So the pairing is real, and this tree cannot produce it: `graphReconcileWorker`
is constructed with `processGraphReconcileJob`, which reaches
`reconcileTeamGraph` and the graph-search-projection enqueue and nothing else.
The version-skew question is **sharper**, not closed. The runbook now says so,
marked as a correction, and question 4 asks what the deployed build actually
wires.

## 4. Harness defects that were hiding real coverage

* **`postgres:16-alpine` cannot host the schema.**
  `family-intelligence-operations.integration.test.ts` refuses to run without
  pgvector — correctly, since `EmbedSemanticChunks` cannot be driven without
  `evidence_semantic_chunks.embedding_vector`. The image has no `vector`
  extension, so the migration could never create the column and the family was
  unprovable in testcontainers mode, reported as "1 suite failed". Now
  `pgvector/pgvector:pg16` — the same image the disposable rehearsal database
  uses. That suite runs for real: 9/9.
* **`EMAIL_IDEMPOTENCY_SECRET`.** The harness bound a fake `RESEND_API_KEY` and
  then scrubbed the secret that a configured transport requires, so
  `collectStartupViolations T03` flagged a violation the harness had created.
  Fixed with the value, not a softer check.
* **The ledger called loopback `unknown-external`.** 498 disposable-container
  connections read as unclassified external traffic. Loopback now has its own
  `loopback-disposable` category — keyed off `LOOPBACK`, not `isLocal`, so an
  explicitly allowlisted *remote* host keeps its own category in the record.

## 5. New coverage

`services/worker/test/phase-12-point7-queue-skew-topology.test.ts` — 22 cases:

* **14 version-skew** — every payload shape a different build could produce is
  refused before a handler runs, and no rejection path can hand `undefined` to
  a caller (the incident's literal failure was `where: { id: undefined }`).
* **5 topology** — parsed from the worker entrypoint: no queue served by two
  processors, no wrapper told a queue name other than the one its Worker
  listens on, and **graph-reconcile is not bound to the purge processor**.
* **3 telemetry-concurrency** — three jobs running at once each see only their
  own tags; a job's tags do not survive it; the wrapper installs the context.

Two of my own expectations in that suite were wrong and the **test** was
corrected, not production: an unversioned payload is refused by the registered
legacy adapter as `legacy_job_quarantined`, and `evidenceId` is correctly *not*
in `FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS` — it is the subject reference the
legacy adapters legitimately read to find the durable row that IS the
authority. Listing it would make every draining job report itself as a
violation. Tenant and policy fields are covered separately (V10b).

## 6. Evidence

**Closure verdict** — `evaluatePoint7Closure()`:

```json
{ "ok": true, "failures": [], "missing": [],
  "metrics": { "canonicalPlans": 5, "plansInScenarioManifest": 5,
    "plansExecutedInCurrentRun": 5, "requiredScenarioIds": 95,
    "executedScenarioIds": 95, "browserSuitesHashValid": true,
    "oneRunId": true, "oneBuildId": true, "staleArtifacts": 0,
    "skippedRequiredScenarios": 0, "unknownScenarios": 0 } }
```

| Suite | Result |
|---|---|
| API unit | 645 files · **21,660 / 21,660** |
| API integration (proof run) | 23 files · **363 / 363** |
| Worker | 48 files · **868 / 868** |
| Playwright `point7` | **31 / 31** |
| Web | 1,852 (1,850 pass · 2 todo · **0 fail**) |
| `@proovra/shared` | **803 / 803** |
| Mobile | **8 / 8** |
| Isolation canary | **12 / 12** |
| Typecheck / lint | **0 / 0** across every project |

**Proof artifacts, one run each:**

* `point7-proven-scenarios.json` — 7 suites (4 server + 3 browser), 95
  scenarios, single `runId`.
* `point5-family-proven-cases.json` — 12 suites, 282 cases, single `runId`
  minted by the same vitest run.

**Outbound ledger for the browser run** (records carry only process, scenario,
host, category, outcome, timestamp — never a credential, query string, header,
token, email or payload):

| Process | Outcome | Host | Count |
|---|---|---|---|
| api | ALLOWED | 127.0.0.1 (disposable PG / Redis / MinIO) | 498 |
| api | BLOCKED | api.resend.com | 18 |
| web | BLOCKED | fonts.googleapis.com | 12 |
| web | BLOCKED | registry.npmjs.org | 1 |

Both long-running servers ran under the same `--import` preload the canary
certifies, so neither could read the machine `.env`. No production destination
was attempted by any process in this pass.

## 7. What remains open

**The production queue incident is NOT resolved.** It stays
`OWNER_PRODUCTION_QUEUE_INCIDENT_AUDIT_PENDING`. The collector refuses to start
without an owner-issued `P7_PRODUCTION_QUEUE_READONLY_URL` and will not fall
back to `REDIS_URL` or anything in `.env`. Questions 1–7 in the runbook are
unanswered, and question 6 — *did any contaminated job complete successfully* —
is the one that matters. Nothing here claims otherwise.

**Staging was not exercised.** No staging credentials exist in this
environment, so Layer D's staging leg is untested rather than passing.

Nothing in this pass was committed, pushed, deployed, or applied as a
migration. The dirty worktree is preserved.
