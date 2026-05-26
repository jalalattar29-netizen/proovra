# Runbook 31 — OTS anchor delay

## Symptoms
- Evidence records show `otsStatus: PENDING` for longer than expected (typically > 6 h).
- Worker `ots-upgrade` queue backlog elevated.
- Customer asks "when will my evidence be Bitcoin-anchored?"

## Blast radius
Per-evidence record awaiting OTS anchor upgrade. **Evidence integrity is preserved** — the OTS submission has already been made; the wait is for Bitcoin block confirmation. The status field honestly reflects PENDING.

## Detection
- API query for `Evidence` rows with `otsStatus: PENDING` and `otsSubmittedAtUtc < now() - INTERVAL '6 hours'`.
- BullMQ `ots-upgrade` queue depth.
- OpenTimestamps server status.

## Logs to inspect
- Worker logs filtered to `ots-upgrade.processor`.
- OpenTimestamps server delivery log (provider-side).
- Bitcoin block-confirmation rate.

## Rollback procedure
None — OTS anchoring is forward-only.

## Safe recovery procedure
1. **Confirm the OTS provider is healthy** (OpenTimestamps server status).
2. **Confirm Bitcoin block confirmation rate is normal.** OTS upgrades wait for Bitcoin blocks; if Bitcoin is congested, the upgrade rate slows. This is normal and bounded by the underlying chain.
3. **Confirm the worker is processing**. The `ots-upgrade` queue uses 1 h retry delay (configurable); long delays mean either the upgrade isn't ready yet (Bitcoin block lag) or the worker is stuck.
4. **For a stuck worker**: runbook 03 (worker restart). The processor resumes from where it left off.
5. **For a customer asking "when will it anchor?"**: explain that OTS submissions are made immediately at evidence finalize, but Bitcoin confirmation takes ~1-6 hours typically. The OTS upgrade pipeline polls every 1 h and upgrades the `otsStatus` to `ANCHORED` once the block confirms.

## Validation steps
- A recently-anchored evidence record has `otsStatus: ANCHORED` + `otsTxId` populated.
- The worker's `ots-upgrade` queue depth is bounded relative to recent finalize volume.
- A test OTS verify (operator-driven; `ots verify` CLI against the recorded proof) succeeds.

## Escalation conditions
- An evidence record has `otsStatus: PENDING` for > 48 h with no progress → investigate OpenTimestamps server health + Bitcoin chain congestion.
- The OpenTimestamps server is down for > 24 h → customer-wide notification if the customer's posture depends on OTS for new records.
- A customer asks for guaranteed time-to-anchor → there is no such guarantee. Bitcoin confirmation time is intrinsically variable.

## DO NOT DO THIS
- Do NOT manually set `otsStatus: ANCHORED` without an actual block confirmation. The status is the audit of what the platform observed.
- Do NOT mutate `otsTxId` columns to fabricate an anchor.
- Do NOT bypass the OTS retry pipeline. The 1 h cadence is bounded; raising it adds load on OpenTimestamps with no recovery benefit.
- Do NOT promise customers a guaranteed time-to-anchor SLA. Bitcoin block time is not platform-controlled.
- Do NOT spin up a private Bitcoin node "for faster anchoring". OTS public-server anchoring is the integrity contract; private nodes break verifier trust.
