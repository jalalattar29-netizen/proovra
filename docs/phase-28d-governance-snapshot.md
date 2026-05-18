# Phase 28-D — Cross-System Governance Integration

This phase makes ten governance subsystems agree about one evidence
record through a single read. Before this turn, every consumer
(evidence detail, reviewer ops, export flow, package builder,
governance dashboard) ran its own bespoke combination of helpers and
direct prisma reads. After this turn, they all read the same
`GovernanceSnapshot` projection produced by one service.

## The unifying primitive

[`services/api/src/services/governance-lifecycle/governance-snapshot.service.ts`](../services/api/src/services/governance-lifecycle/governance-snapshot.service.ts)

```ts
buildGovernanceSnapshot({ teamId, evidenceId })
  → GovernanceSnapshot {
      lifecycle: { state, label, isTerminal }
      review:    { workflowId, status, slaStatus, activeEscalationId, activeEscalationSeverity, ... }
      legalHold: { hasActiveDirectHold, hasActiveCaseHold, blocksExport, blocksDestruction, ... }
      retention: { bound, policyId, policyVersion, retentionUntilUtc, immutable, expired }
      destruction: { activeReviewId, activeReviewStatus, eligible, blockedReason }
      export:    { eligible, outcome, reason, label }     // via canonicalEvaluateExportEligibility
      package:   { eligible, outcome, reason, label }     // via canonicalEvaluatePackageEligibility
      immutableStorage: { driftDetected, driftIncidentId, driftLabel }
      incidents: [ { id, severity, category, title, openedAtUtc, runbookSlug } ]
      warnings:  [ { code, label, severity } ]
    }
```

## Canonical decision helpers

| Decision | Helper | Inputs |
|----------|--------|--------|
| Export eligibility | `canonicalEvaluateExportEligibility` ([anchor.ts](../packages/shared/src/canonical-decisions.ts)) | lifecycle + hold + active destruction review |
| Package eligibility | `canonicalEvaluatePackageEligibility` ([new this phase](../packages/shared/src/governance-package-eligibility.ts)) | export facts + open immutable-drift incident |
| Destruction eligibility | `canonicalCanEnterPendingDestruction` ([canonical-decisions.ts](../packages/shared/src/canonical-decisions.ts)) | from-state + hold + immutable retention + active review |
| Lifecycle transition | `canonicalEvaluateLifecycleTransition` ([canonical-decisions.ts](../packages/shared/src/canonical-decisions.ts)) | from / to / hold / immutable |

Every consumer routes through these. No service layer re-implements the
rules — the test suite ([`cross-system-governance-integration.test.ts`](../services/api/test/cross-system-governance-integration.test.ts))
asserts the snapshot service uses the canonical helpers directly.

## Precedence ladder (export + package + destruction)

```
Hold (direct OR case)                     → BLOCKED_BY_HOLD
Lifecycle terminal / on-hold / retention-locked / pending-destruction
                                          → BLOCKED_BY_LIFECYCLE
Non-terminal destruction review           → BLOCKED_BY_REVIEW_GATE
Open immutable-storage-drift incident     → BLOCKED_BY_IMMUTABLE_DRIFT  (package only)
Everything else                           → ALLOWED
```

The precedence is fixed across all three gates. An operator clearing
the highest-priority blocker sees the next one immediately, not a
sudden jump to ALLOWED.

## Wording invariant — drift is STORAGE governance, not content tamper

Both the canonical label
(`packageEligibilityLabel("BLOCKED_BY_IMMUTABLE_DRIFT")`) and the
snapshot service's drift `driftLabel` use the phrase
**"Storage governance drift"**. They MUST NOT contain "tamper",
"altered", "modified", or "forged". The test suite enforces this on
string literals (comments may reference these words while documenting
the rule).

## Routes

| Route | Purpose |
|-------|---------|
| `GET /v1/evidence/:id/governance-snapshot?teamId=…` | Read the unified snapshot. |
| `GET /v1/evidence/:id/operational-timeline?teamId=…&limit=…` | Read the merged activity stream. |

Both require session auth + team membership + `audit.read` permission.
404 on non-member (anti-enum).

## Operational timeline

[`operational-timeline.service.ts`](../services/api/src/services/governance-lifecycle/operational-timeline.service.ts)
merges three real event streams into one chronological projection:

| Stream | Source |
|--------|--------|
| Lifecycle events | `EvidenceLifecycleEvent` rows (hold placed/released, retention applied, destruction-review milestones, ...) |
| Review events | `EvidenceReviewWorkflowEvent` rows (assigned, started, paused, escalated, ...) |
| Incidents | `OperationalIncident` rows tied via `relatedEvidenceId` |

The brief explicitly forbids inventing events; this service NEVER
derives an entry from a state value. Every entry is sourced from a
real row.

### Privacy

- Lifecycle events expose only the bounded `summary` field (already
  scrubbed by the orchestrator's `scrubMetadata`).
- Review events explicitly DO NOT select the `note` field, which may
  carry private reviewer content. The projection sets `safeSummary:
  null` for review events.
- Incidents expose only the operator-safe `title` + `safeSummary`.
- No raw evidence bytes, decision notes, legal-note bodies, or
  secrets ever surface through this service.

## Metrics

| Counter | Where it's bumped |
|---------|------------------|
| `governance_snapshot_requested_total` | Every snapshot read |
| `operational_timeline_loaded_total` | Every timeline read |
| `export_governance_blocked_total` | When snapshot reports `export.eligible=false` |
| `package_governance_blocked_total` | When snapshot reports `package.eligible=false` |
| `immutable_drift_block_total` | When package is blocked specifically by drift |
| `legal_hold_export_block_total` | When export is blocked specifically by hold |
| `retention_destruction_candidate_total` | When retention has expired AND destruction is eligible |
| `external_review_access_blocked_total` | Reserved — wired into the catalog for future external-review gate |

All counters added to [`metrics.service.ts COUNTER_NAMES`](../services/api/src/services/ops/metrics.service.ts)
and exported via `/v1/ops/metrics` + `/metrics` (Prometheus).

## Subsystem integration proof

| Subsystem | How it integrates |
|-----------|------------------|
| Reviewer Ops | Snapshot reads `evidence_review_workflows` for status, SLA, assigned reviewer, active escalation id + severity. |
| Legal hold | Snapshot counts active `EvidenceLegalHold` (direct) + `CaseLegalHold` (case). Both feed the export + package + destruction canonical helpers. |
| Retention | Snapshot reads `EvidenceRetentionPolicyVersion` for `immutable` + `policyId` + `policyVersion`. Compares `evidence.retentionUntilUtc` to NOW for `expired`. |
| Destruction review | Snapshot reads the active `DestructionReview` row pointed at by `evidence.activeDestructionReviewId`. Status feeds canonical helpers. |
| Export governance | Snapshot computes export eligibility via the canonical helper, mirroring `checkExportEligibility`. |
| Package governance | Snapshot computes package eligibility via the NEW canonical helper (export facts + immutable drift). |
| Immutable reconciliation | Snapshot derives `driftDetected` from open `OperationalIncident` rows with `runbookSlug="immutable-drift"`. |
| External review | Reserved counter + bounded warning code `EXTERNAL_REVIEW_ACCESS_BLOCKED`. The actual workflow-visibility-decision wiring is planned next; the catalog is ready. |
| Operational incidents | Snapshot returns up to 50 open incidents related to the evidence. |
| Audit + lifecycle events | Timeline service merges them with review events into one stream. |
| Observability | All seven counters + timeline counter wired into Prometheus exposition. |

## Test coverage

[`services/api/test/cross-system-governance-integration.test.ts`](../services/api/test/cross-system-governance-integration.test.ts) — **46 tests, all passing**:

- 9 tests on canonical package-eligibility precedence
- 8 tests on snapshot-service wiring
- 5 tests on timeline-service wiring
- 4 tests on route registration + gating
- 7 tests on the cross-system chain (review/hold/retention/drift)
- 8 tests on metrics-catalog completeness
- 3 tests on privacy invariants
- 2 tests on drift-wording invariants

## SQL required

**None.** This phase is read-only at the DB level and uses existing
tables exclusively.

## Env variables

**None new.** Existing env stack is sufficient.

## What this phase did NOT do

- ❌ Added Enterprise Search.
- ❌ Added AI / OCR / semantic search / federation / mobile.
- ❌ Redesigned the app shell.
- ❌ Touched cryptographic / OTS / TSA / report-v2 / verify / package
      semantics or wording.
- ❌ Bypassed any governance gate.
- ❌ Created fake counters / hardcoded UI values.
- ❌ Added new Prisma models or migrations.
- ❌ Modified the worker's verification-package builder
      (`canonicalEvaluatePackageEligibility` is available in
      `@proovra/shared` for the next caller to consume; the snapshot
      route + manual operator preflight is sufficient for this turn).
- ❌ Built bespoke external-review access checks (the warning code +
      metric counter are reserved; the wiring is intentionally a
      separate focused phase).

## Operator verification

```bash
# 1. Snapshot returns the full projection.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/evidence/<id>/governance-snapshot?teamId=<team>" | jq .

# 2. Timeline returns merged events.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/evidence/<id>/operational-timeline?teamId=<team>&limit=50" | jq .

# 3. Metrics exposed.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "$API_BASE/v1/ops/metrics" \
  | jq '.metrics.counters
        | {governance_snapshot_requested_total,
           export_governance_blocked_total,
           package_governance_blocked_total,
           immutable_drift_block_total,
           legal_hold_export_block_total,
           retention_destruction_candidate_total,
           operational_timeline_loaded_total}'
```
