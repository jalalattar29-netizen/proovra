# Phase 28-E — Fail-Closed Governance Enforcement

This phase closes the worker-layer enforcement gap and ships the
architectural primitives for two future surfaces (external reviewer
access + enterprise discovery) — without building either feature yet.

## Worker fail-closed package gate

**Module:** [`services/worker/src/governance/package-eligibility-gate.ts`](../services/worker/src/governance/package-eligibility-gate.ts)

The verification-package builder ([`createVerificationPackage`](../services/worker/src/verification-package.ts))
now invokes `assertPackageEligibleOrDeny()` as the very first
statement of its body, BEFORE `archiver("zip")` is ever called. On any
non-ALLOWED outcome, it throws `PackageGateDeniedError` and emits no
artifact, no archive bytes, no download-ready event.

### Fail-closed contract

| Condition | Outcome |
|-----------|---------|
| `teamId` or `evidenceId` missing in input | `GOVERNANCE_STATE_UNAVAILABLE` |
| Evidence row not found | `GOVERNANCE_STATE_UNAVAILABLE` |
| Any prisma error during fact-gathering | `GOVERNANCE_STATE_UNAVAILABLE` |
| Canonical helper returns BLOCKED_BY_HOLD | `BLOCKED_BY_HOLD` |
| Canonical helper returns BLOCKED_BY_LIFECYCLE | `BLOCKED_BY_LIFECYCLE` |
| Canonical helper returns BLOCKED_BY_REVIEW_GATE | `BLOCKED_BY_REVIEW_GATE` |
| Open `OperationalIncident` with `runbookSlug="immutable-drift"` | `BLOCKED_BY_IMMUTABLE_DRIFT` |
| Canonical helper returns ALLOWED | `ALLOWED` — proceed |

Additional outcomes (`BLOCKED_BY_REVIEW_POLICY`, `BLOCKED_BY_REVIEW_STATE`,
`BLOCKED_BY_RETENTION`, `BLOCKED_BY_GOVERNANCE`,
`BLOCKED_BY_EXTERNAL_ACCESS_POLICY`) are typed and routed through the
same emission path; the canonical helper does not currently surface
these directly, but the gate's `WorkerPackageGateOutcome` type
includes them for use by future policy hooks.

### Denial emission

Every denial produces, in order:
1. Structured `package_generation.denied` log line with full context.
2. Sentry capture (only when an error caused the denial).
3. Worker-side metric line: `metric: "package_generation_blocked_total"`.
4. GOVERNANCE `OperationalIncident` via `recordWorkerIncident` — deduped per
   `(teamId, evidenceId, outcome)` fingerprint. Incident-recording
   failure NEVER flips the gate back to allow.

### Source-contract proof

[`services/api/test/fail-closed-governance-enforcement.test.ts`](../services/api/test/fail-closed-governance-enforcement.test.ts) (56 tests) asserts:
- The gate calls the canonical helper (no inline duplication).
- All four fail-closed branches exist.
- All eight required denial outcomes are typed.
- `createVerificationPackage` calls the gate BEFORE `archiver("zip")` is
  invoked (string-position ordering check).
- `processor.ts` now passes `teamId` to `createVerificationPackage`.

## Export parity

Every governance-sensitive read path is now backed by the canonical
helpers in `@proovra/shared`:

| Surface | Helper |
|---------|--------|
| Export eligibility (snapshot, route, audit) | `canonicalEvaluateExportEligibility` |
| Package eligibility (snapshot, worker gate) | `canonicalEvaluatePackageEligibility` |
| Destruction eligibility | `canonicalCanEnterPendingDestruction` |
| Lifecycle transition | `canonicalEvaluateLifecycleTransition` |
| External review access | `evaluateExternalReviewAccess` (NEW) |

No path may inline rule logic. The test suite asserts each consumer
imports + calls the canonical helper.

## External review access lifecycle

**Module:** [`packages/shared/src/external-review.ts`](../packages/shared/src/external-review.ts)

### State machine

```
INVITED ─┬─► ACTIVE ─┬─► REVOKED      (terminal)
         │           ├─► EXPIRED      (terminal)
         │           └─► BLOCKED_BY_POLICY ─► ACTIVE / REVOKED / EXPIRED
         ├─► REVOKED
         ├─► EXPIRED
         └─► BLOCKED_BY_POLICY
```

`isAllowedExternalReviewTransition` enforces the matrix; any consumer
calling it cannot create an out-of-band state.

### Access evaluation precedence

`evaluateExternalReviewAccess(facts)` returns `{allowed, reason}`. The
order of checks (most-restrictive first):

1. State === `REVOKED` → `revoked`.
2. State === `EXPIRED` → `expired`.
3. State === `BLOCKED_BY_POLICY` → `blocked_by_policy`.
4. `expiresAtUtc` ≤ now → `expired` (time-based override).
5. `governanceBlocked` (snapshot drift / hold / review gate) → `blocked_by_governance`.
6. `hasActiveLegalHold` + workspace policy revokes-on-hold → `invalidated_by_hold`.
7. State !== `ACTIVE` → `not_active`.
8. Otherwise → `allowed: true, reason: "active"`.

### Privacy filter

`projectEvidenceForExternalReview(raw)` is a STRIPPING projection. The
returned type explicitly enumerates 13 safe fields; any other property
on `raw` (including `internalNotes`, `submittedByEmail`,
`signatureBase64`, `tsaTokenBase64`, `otsProofBase64`, `storageKey`,
`activeDestructionReviewId`, etc.) is dropped. Asserted by tests on
both axes (safe fields present, forbidden fields absent).

The full token issuance / DB schema is intentionally deferred — the
canonical decision + projection surface is sufficient for the api +
worker to never agree to leak something they shouldn't. Issuance is
the next focused phase.

## Discovery foundation

**Module:** [`packages/shared/src/discovery-foundation.ts`](../packages/shared/src/discovery-foundation.ts)

Architecture primitives ONLY. No engine, no API endpoints, no schema.
Phase 29 picks this up.

### What ships

- **8 searchable entity kinds** (`evidence`, `case`, `review_task`,
  `escalation`, `incident`, `external_review_share`,
  `verification_package`, `operational_event`).
- **Per-kind safe-document shapes** with explicit type unions
  (`SafeSearchableDocument`) — extending a shape requires a code change
  because the property keys are enumerated.
- **`applyDiscoveryFilter(facts)`** — the canonical visibility filter:
  - Tenant isolation first.
  - External reviewers blocked from `operator_only` /
    `workspace_internal` documents.
  - Hold / governance / lifecycle blockers consistent with the
    canonical helpers.
- **`emitIndexingEvent(event)` + `registerIndexingEventSink(sink)`** —
  a pluggable event-bus contract that a future indexer can register
  into without modifying the producer.
- **`DISCOVERY_FORBIDDEN_FIELDS`** catalog — 21 fields the safe-document
  shapes must never declare. Tests assert.

### What does NOT ship

- No `prisma.searchableEntity` model.
- No `/v1/search` route.
- No ranker, no relevance scoring, no analytics surface.
- No production sink registration — the default sink is a no-op.

## Metrics

8 new counters added to [`metrics.service.ts COUNTER_NAMES`](../services/api/src/services/ops/metrics.service.ts):

| Counter | Bumped when |
|---------|-------------|
| `package_generation_blocked_total` | Worker gate denies package generation |
| `export_generation_blocked_total` | Export path denies (reserved; bumps in snapshot route) |
| `external_review_access_granted_total` | External-review token issued (future) |
| `external_review_access_revoked_total` | External-review token revoked (future) |
| `external_review_access_denied_total` | External reviewer access rejected by `evaluateExternalReviewAccess` |
| `governance_ui_snapshot_loaded_total` | Governance UI page loads the snapshot |
| `operational_timeline_rendered_total` | Operational timeline UI renders |
| `discovery_index_event_total` | `emitIndexingEvent` fires |

## Files changed

| File | Type |
|------|------|
| `services/worker/src/governance/package-eligibility-gate.ts` | **NEW** |
| `services/worker/src/verification-package.ts` | modified — gate wired into `createVerificationPackage`; `PackageGateDeniedError` exported |
| `services/worker/src/processor.ts` | modified — passes `teamId` to `createVerificationPackage` |
| `packages/shared/src/external-review.ts` | **NEW** |
| `packages/shared/src/discovery-foundation.ts` | **NEW** |
| `packages/shared/src/index.ts` | modified — re-exports |
| `services/api/src/services/ops/metrics.service.ts` | modified — 8 new counters |
| `services/api/test/fail-closed-governance-enforcement.test.ts` | **NEW** (56 tests) |
| `docs/phase-28e-fail-closed-governance.md` | **NEW** |

## SQL required

**None.** No schema changes.

## Env variables

**None new.**

## Operator verification

```bash
# Worker package gate denies an evidence under hold.
# (Run after seeding a held record via the seeding flow.)
# Logs:
docker compose logs proovra-worker --since 5m | grep package_generation.denied

# Metric:
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "$API_BASE/v1/ops/metrics" \
  | jq '.metrics.counters.package_generation_blocked_total'
# Expect: positive integer that increments per denial.

# Incident:
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/ops/incidents?teamId=<team>&category=GOVERNANCE&status=OPEN" \
  | jq '.incidents[] | select(.title | startswith("Package generation denied"))'
```

## What this phase did NOT do

- ❌ Built an external-review token / share DB schema. (Phase 29.)
- ❌ Built a search engine, ranker, or analytics surface. (Phase 29+.)
- ❌ Redesigned the UI. (Brief forbids — and the snapshot service +
  timeline service provide the data primitive for incremental UI
  consumption.)
- ❌ Modified report-v2 / verify / OTS / TSA semantics.
- ❌ Added new Prisma migrations.

## Production readiness

**Worker package generation is now fail-closed.** The brief's full
denial-outcome catalog is supported. Privacy boundaries for the
future external-review surface are formally typed. The discovery
foundation lets Phase 29 pick up search without re-deriving privacy
gates.
