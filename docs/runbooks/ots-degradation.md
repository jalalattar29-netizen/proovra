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
| Anchored | the stored proof executes to a well-formed Bitcoin block-header attestation — **recorded, not yet independently checked** |
| Failed | a bounded defect: `PROOF_HASH_MISMATCH`, `MALFORMED_PROOF`, `UNSUPPORTED_PROOF_OPERATION`, `INVALID_ATTESTATION`, `OTS_GLOBAL_BUDGET_EXHAUSTED` |
| Unavailable | the proof material cannot be read (`PROOF_MATERIAL_MISSING`, `FINGERPRINT_MISSING`) |

A status column, a txid, a block height or a time never makes a record
anchored.

### Independent Bitcoin verification

ANCHORED means the attestation is **recorded**. Only the independent check
against the Bitcoin main chain may say **verified**. The worker performs it in
the same `ots-upgrade` lifecycle against PROOVRA's dedicated, pruned Bitcoin
Core node (header RPC only: `getblockhash`, `getblockheader`). The proof's
Merkle root must equal the root in the 80-byte header of the block it names,
in the active main chain, with at least `OTS_BITCOIN_MIN_CONFIRMATIONS`
confirmations.

| Verification | Meaning |
|---|---|
| Bitcoin attestation recorded | ANCHORED; not checked (verification disabled, or not yet run) |
| Bitcoin verification pending | the proof matches the block; confirmations below the minimum |
| Independently verified against the Bitcoin main chain | the only state that shows green / PASSED |
| Bitcoin verification temporarily unavailable | the node could not be used (`BTC_RPC_*`, `INITIAL_BLOCK_DOWNLOAD`, `NODE_STALE`, `HEADER_LAG`, `WRONG_CHAIN`, …); retried automatically |
| Bitcoin verification failed | `ROOT_MISMATCH`, `NOT_IN_ACTIVE_CHAIN`, `REORGED`, `INVALID_HEADER`, `INVALID_ATTESTATION` |

A verifier outage never changes proof-integrity truth: the record stays
ANCHORED (attestation recorded). Live verification is controlled by
`OTS_BITCOIN_VERIFY_ENABLED` (default `false`); the RPC password is a
worker-only secret. The verification package still tells a reviewer how to
check the proof against a node of their own.

### Production wiring (worker only)

| What | Where |
|---|---|
| Non-secret settings (`OTS_BITCOIN_VERIFY_ENABLED`, `_RPC_URL`, `_RPC_USERNAME`, `_EXPECTED_CHAIN`, `_RPC_TIMEOUT_MS`, `_MIN_CONFIRMATIONS`, `_MAX_TIP_AGE_SECONDS`, `_MAX_HEADER_LAG`, `_MIN_NODE_VERSION`) | `/opt/proovra/app/secrets/bitcoin-rpc/verifier.env` — the worker's own `env_file` (template `infra/docker/bitcoin-verifier.env.example`) |
| RPC password | `/opt/proovra/app/secrets/bitcoin-rpc/password`, mounted read-only at `/run/proovra/bitcoin-rpc/password`; owned by the worker image's `app` user (`docker run --rm --entrypoint id <worker-image>`), mode `0400` |

Never put any `OTS_BITCOIN_*` in the shared `/opt/proovra/app/.env`: both
services load it, so the API would receive it. `scripts/deploy-prod-pull.sh`
refuses such a file before pulling anything, and a production API refuses to
start with `worker_only_bitcoin_verifier_config`. In production the worker
refuses a password from the environment (`BTC_RPC_MISCONFIGURED`). A password
file the `app` user cannot read is also `BTC_RPC_MISCONFIGURED` — never
verified. Readiness from inside the running worker:

```
docker compose -f infra/docker/docker-compose.prod.yml exec proovra-worker \
  wget -qO- http://localhost:8090/health
```

reports `bitcoinVerifier` (`enabled`, `ready`, `code`, `chain`, `tipHeight`).

### `platform.bitcoin_verifier_unavailable`

While live verification is enabled the worker publishes the verifier's
readiness (at most every 5 minutes). Operations opens **one** platform
condition when the newest readiness says not ready and resolves it
automatically when the verifier reports ready again. Triage by the bounded
readiness code:

- `BTC_RPC_UNAUTHORIZED` / `BTC_RPC_FORBIDDEN` — the RPC user, password or
  `rpcallowip` / `rpcwhitelist` on the node.
- `BTC_RPC_TIMEOUT` / `BTC_RPC_UNAVAILABLE` — the node process or the private
  network path between the worker and the node.
- `INITIAL_BLOCK_DOWNLOAD` / `HEADER_LAG` / `NODE_STALE` — the node is not
  synchronized; wait for it.
- `WRONG_CHAIN` / `UNSUPPORTED_NODE_VERSION` / `NODE_WARNINGS` — node
  configuration; fix the node, never the policy.

## First action (under 60s)

Read the worker metrics:

- `ots_anchored_total`, `ots_upgrade_pending_total`
- `ots_calendar_failure_total` — `ots upgrade` could not reach a calendar
- `ots_proof_integrity_failed_total` — a proof defect (terminal)
- `ots_budget_exhausted_total` — a proof that never anchored within the budget
- `ots_chain_verified_total`, `ots_chain_confirmations_pending_total`,
  `ots_chain_verification_unavailable_total`, `ots_chain_verification_failed_total`,
  `ots_chain_reorged_total` — the independent Bitcoin check
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
node dist/scripts/reconcile-ots-state.js --chain --evidence-id <uuid>
```

`--chain` also checks ANCHORED proofs against the Bitcoin node (read-only RPC
in a dry run). `--chain --apply` refuses to start unless the verifier is
enabled and ready now; it pages by keyset in batches of at most 100
(`--batch-size`, `--max-rows`, resumable with `--after`).

## Containment

Bounded by design: during a calendar outage records stay **Pending**; nothing
reads as anchored without an anchored proof. During a Bitcoin-node outage
anchored records stay **Bitcoin attestation recorded**; nothing reads as
verified without a successful chain check. No platform containment is needed;
setting `OTS_BITCOIN_VERIFY_ENABLED=false` stops checking without changing
any record.

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
- [ ] No record read **Independently verified** while the verifier was
      unavailable (`ots_chain_verification_status` is VERIFIED only with a
      matching `ots_chain_block_hash` and verifier string).
