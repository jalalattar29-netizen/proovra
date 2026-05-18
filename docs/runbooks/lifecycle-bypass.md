# Runbook — Suspected lifecycle bypass

**Failure modes:** FM-LIFE-001 (direct ACTIVE → DESTROYED), FM-LIFE-002 (re-transition out of DESTROYED).

## What this means

The platform's lifecycle orchestrator is the only authoritative writer
for `Evidence.lifecycleState`. If a row appears in DESTROYED without a
matching `EvidenceLifecycleEvent` ledger trail, or a row outside
{PENDING_DESTRUCTION, ARCHIVED} reached DESTROYED, the orchestrator
contract has been bypassed.

## First action (under 60s)

Spot-check a sample of recently-destroyed records:

```sql
SELECT e.id, e."lifecycleState", e."updatedAt"
FROM "Evidence" e
WHERE e."lifecycleState" = 'DESTROYED'
  AND e."updatedAt" > NOW() - INTERVAL '24 hours'
ORDER BY e."updatedAt" DESC
LIMIT 20;
```

For each row, confirm there's a matching ledger event:

```sql
SELECT id, "eventType", "fromState", "toState", "occurredAtUtc"
FROM "EvidenceLifecycleEvent"
WHERE "evidenceId" = '<evidence id>'
ORDER BY "occurredAtUtc";
```

## Triage

A clean destruction chain has, at minimum:
- One event with `toState = 'PENDING_DESTRUCTION'`.
- One event with `eventType = 'destruction_executed'` carrying the
  certificate hash in metadata.
- The `DestructionReview` row in status `EXECUTED` with a non-null
  `certificateHash`.

If any of those are missing, the lifecycle write was not made by the
orchestrator.

## Containment

1. **Pause destruction worker:** scale the destruction-orchestrator
   replica to 0 in the deploy. Retention reconciliation will continue
   identifying expired records but will not execute.
2. **Block compliance exports** for any case touched by the suspect
   record until investigation completes.
3. **Notify security** — open a CRITICAL `OperationalIncident` with the
   suspect evidence ids.

## Root cause

The platform refuses these transitions in two layers:

1. `canonicalEvaluateLifecycleTransition` (the pure formula in
   `@proovra/shared`) rejects any transition not in
   `EVIDENCE_LIFECYCLE_TRANSITIONS`. DESTROYED is terminal there.
2. `lifecycle-orchestrator.service.ts` validates BEFORE every DB write
   and emits `lifecycle_transition_blocked` security events.

If both layers were intact, the only way DESTROYED gets written is
through the orchestrator. Likely sources of bypass:
- A new service that writes `Evidence.lifecycleState` directly (check
  `git log --all -p -- 'Evidence.lifecycleState' '*.ts'`).
- A migration that mutated rows in place.
- A manual SQL UPDATE.

## Recovery

DESTROYED is terminal at the state machine level — the platform does
NOT support resurrecting a DESTROYED row. If the bypass was a false
positive (the orchestrator did fire but the ledger event failed to
write), reconstruct the ledger row from `AdminAuditLog` (which carries
the canonical action). DO NOT create a synthetic event with a forged
hash.

If actual evidence was destroyed without authorization, the certificate
must be re-issued under operator review with a `note` field marking the
incident id.

## Postmortem checklist

- [ ] Identify the writer (commit, migration, manual SQL).
- [ ] Confirm the lifecycle ledger gap (`EvidenceLifecycleEvent` count
      vs. `Evidence` count for the team).
- [ ] Add a regression test in `phase-z-hardening.test.ts` that would
      have caught this.
- [ ] Confirm `RUNTIME_OWNERSHIP_MAP` still names the orchestrator as
      the sole writer.
