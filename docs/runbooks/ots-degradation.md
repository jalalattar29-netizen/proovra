# Runbook — OTS / Bitcoin anchor degradation

**Failure modes:** FM-OTS-001 (ANCHORED without proof), FM-OTS-002 (empty proof bytes).
**Alert:** `ots_failure_rate`.

## What this means

The platform commits to honest anchor semantics: a record may only
display "Bitcoin anchored" or attach a `.ots` proof file when the
underlying evidence actually exists. If the OTS failure rate is
rising, or operators report missing anchor evidence, the OTS upgrade
worker is failing to produce proof bytes.

Critically — and this is the platform's strongest contract — even if
the worker fails forever, the trust badge will NEVER FABRICATE an
anchored state. The degrade rule is:
- Status `ANCHORED` + no Bitcoin txid + no `anchoredAtUtc` → display
  as `PENDING`.
- Proof bytes empty / malformed → no `.ots` file in package; companion
  JSON sets `proofPresent=false`.

## First action (under 60s)

```bash
curl -s "$API_BASE/v1/ops/metrics" | grep ots_upgrade
```

Expected metrics:
- `ots_upgrade_succeeded_total`
- `ots_upgrade_failed_total`
- `ots_upgrade_pending_count`

If `failed_total` is rising and `succeeded_total` is flat, the calendar
endpoint (`https://a.pool.opentimestamps.org`) is unreachable or
returning errors.

## Triage

```bash
# Test the calendar endpoint directly from the worker host.
curl -fsS https://a.pool.opentimestamps.org/ -o /dev/null && echo "ok"

# Check Evidence rows with otsStatus=ANCHORED but missing proof.
psql -c "SELECT count(*) FROM \"Evidence\"
         WHERE \"otsStatus\" = 'ANCHORED'
           AND \"otsProofBase64\" IS NULL
           AND \"otsBitcoinTxid\" IS NULL
           AND \"otsAnchoredAtUtc\" IS NULL"
```

The last query returns rows that would be degraded to PENDING by
`resolveEffectiveOtsStatus` — that's the platform doing the right
thing. They are not broken; they are honestly-incomplete.

## Containment

This failure mode is bounded. The platform refuses to lie about
anchoring, so an OTS outage shows up to end-users as "OpenTimestamps
unavailable" or "pending anchoring" — not a false trust badge.

No containment action is needed at the platform level. If the OTS
calendar is down for an extended period, an operator may choose to
add a note on the trust report ("calendar outage [date range]") but
the report itself stays honest.

## Root cause

Three paths produce / consume OTS state:
1. **ots-upgrade worker** — submits hashes to the calendar, then later
   upgrades to full proofs after Bitcoin block inclusion.
2. **resolveEffectiveOtsStatus** — pure helper that degrades
   ANCHORED → PENDING when no txid AND no anchoredAtUtc.
3. **decideOtsPackageArtifact** — pure helper in the verification
   package builder that mirrors the degrade rule and only emits proof
   bytes when `Buffer.from(base64).length > 0`.

The most common driver of `ots_failure_rate`:
- Calendar outage (transient — usually resolves itself).
- Stuck Bitcoin block tracking (the calendar can't upgrade yet).
- Worker DNS / TLS issue.

## Recovery

- If the calendar is up: trigger an upgrade replay for the pending
  set. The ots-upgrade worker is idempotent — it re-attempts submitted
  hashes and skips ones already complete.
- If the calendar is down: wait. Pending records stay PENDING; the
  trust badge stays honest.
- If individual records are stuck despite calendar health, inspect
  `otsFailureReason` on the Evidence row — the worker records the
  reason there.

## Postmortem checklist

- [ ] Calendar outage duration documented.
- [ ] Confirm no record had a misleading trust badge during the
      outage (sample 10 records; verify `deriveAnchorSemantics`
      returned `pending` not `verified`).
- [ ] Confirm no package emitted a fabricated `.ots` file
      (`decideOtsPackageArtifact` test coverage exercises this).
