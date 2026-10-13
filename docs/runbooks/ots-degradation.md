# Runbook — OTS / Bitcoin anchor degradation

**Failure modes:** FM-OTS-001 (ANCHORED claimed without an anchored proof), FM-OTS-002 (empty or malformed proof bytes).
**Alert:** `ots_failure_rate`.

## What this means

OpenTimestamps is an additional public Bitcoin anchoring layer. Its state is
decided in one place — `resolveOtsAnchoring` (`packages/shared/src/ots-anchoring.ts`)
— from the stored proof bytes, executed against the record's evidence digest:

| State | Meaning |
|---|---|
| Not requested | anchoring was not requested for the record |
| Pending | the digest is at the calendars; the proof has no Bitcoin attestation yet |
| Anchored | the stored proof executes to a valid Bitcoin block-header attestation |
| Failed | a bounded defect: `PROOF_HASH_MISMATCH`, `MALFORMED_PROOF`, `UNSUPPORTED_PROOF_OPERATION`, `INVALID_ATTESTATION`, `OTS_GLOBAL_BUDGET_EXHAUSTED` |
| Unavailable | the proof material cannot be read (`PROOF_MATERIAL_MISSING`, `FINGERPRINT_MISSING`) |

A status column, a txid, a block height or a time never makes a record
anchored. PROOVRA does not operate a Bitcoin node; the verification package
tells a reviewer how to check the proof against a node of their own.

## First action (under 60s)

Read the worker metrics:

- `ots_anchored_total`, `ots_upgrade_pending_total`
- `ots_calendar_failure_total` — `ots upgrade` could not reach a calendar
- `ots_proof_integrity_failed_total` — a proof defect (terminal)
- `ots_budget_exhausted_total` — a proof that never anchored within the budget
- gauges `ots_upgrade_backlog` (PENDING records) and `ots_pending_beyond_sla`

If `ots_calendar_failure_total` is rising while `ots_anchored_total` is flat,
the calendars are unreachable from the worker (DNS, TLS, outage). The attempt
errors are recorded in custody as `OTS_ATTEMPT_ERROR` with a bounded category
(`dns_failure`, `timeout`, `calendar_http_5xx`, `tls_failure`,
`connection_failure`, `binary_missing`).

## Triage

Operations opens an `evidence_integrity` condition only for a real defect:
a proof pending beyond the aging window, a proof-integrity failure, a missing
proof, or an exhausted budget. A PENDING proof inside the window is normal and
opens nothing. A condition resolves itself when the record's proof resolves to
ANCHORED.

To see what a stored row resolves to, run the reconciliation script in dry-run
mode (it reads only; it prints states and bounded codes, never proof bytes):

```bash
node dist/scripts/reconcile-ots-state.js --evidence-id <uuid>
```

## Containment

Bounded by design: during a calendar outage records stay **Pending**; nothing
reads as anchored without an anchored proof. No platform containment is needed.

## Recovery

- Calendar back: the hourly follow-up job (`ots-upgrade-<evidenceId>`) picks the
  pending set up again; the initialization reconciler re-schedules any pending
  proof whose ladder was lost.
- A legacy row whose stored status disagrees with its stored proof: run
  `reconcile-ots-state.js` with `--evidence-id` (dry run), review, then `--apply`.
  It is compare-and-set, idempotent, writes one custody event per actual change
  and deletes nothing.
- A proof-integrity failure is terminal; investigate how the proof bytes came to
  commit to another digest before re-stamping anything.

## Postmortem checklist

- [ ] Calendar outage duration documented.
- [ ] Sample 10 affected records: each reads **Pending**, never **Anchored**,
      during the outage (`resolveOtsAnchoring` on the stored proof).
- [ ] No package emitted a proof that does not commit to its `fingerprint.json`
      digest (`decideOtsPackageArtifact` refuses it).
