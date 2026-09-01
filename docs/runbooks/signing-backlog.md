# Runbook — Evidence awaiting signing

**Incident slug**: `signing-pipeline` · **Category**: `GOVERNANCE` · **Default severity**: `WARNING`, escalating to `HIGH`

## What it means

Evidence records in this workspace are `status = UPLOADED`, unsigned, and older
than the aged-record cutoff. The upload finished; the signing step did not.

The exact source is `Evidence(status = UPLOADED, createdAt < cutoff)` — a count,
not a sample. WARNING at the configured threshold, HIGH at three times it.

## Why this one matters more than a backlog usually does

An unsigned record is a record whose integrity has not yet been sealed. It is
not corrupt and it is not lost — the bytes are in storage and the custody trail
exists — but until it is signed, the strongest claim the platform can make about
it is weaker than the claim it will make afterwards.

So the cost of this backlog is not latency. It is that a growing number of
records are sitting in a state the product is designed to move them out of
quickly, and the longer one sits the more likely it is that whatever stopped it
is systemic rather than incidental.

**But do not overstate it either.** An unsigned record is not evidence of
tampering and must never be described that way to a customer. It is evidence
that a pipeline step has not run.

## Symptoms

- Operations shows "Uploaded evidence awaiting signing", with a count.
- Users report that a record stays in an in-progress state after upload
  completes.
- The count grows across successive observations rather than draining.

## Triage

1. **Is the count growing, flat, or draining?**
   Growing means signing throughput is below ingest. Flat means signing has
   stopped. Draining means you are looking at the tail of an event that has
   already passed, and the condition will close itself.

2. **Is it one workspace or all of them?**
   The condition is per-workspace. A single workspace with a backlog while
   others sign normally points at that workspace's records — an unusual media
   type, an oversized file, a policy that is blocking. All workspaces at once
   points at the signer or the worker.

3. **Are the platform's signing identities healthy?**
   `/admin/platform/signers` reports the active signer registry and per-signer
   health. A retired, revoked or unreachable signer stops signing everywhere at
   once, and that is the shape that produces a platform-wide backlog within
   minutes.

## Investigate

- **The signer.** Provider reachability, credential or certificate expiry, KMS
  key state. A key that has been rotated but not activated is the classic
  silent stop.
- **The worker.** If the signing worker is not running, see
  [`worker-wedged`](./worker-wedged.md); this condition is then a symptom, not
  the cause.
- **The records themselves.** If only specific records are stuck, the failure is
  per-record: read those records' own state rather than the aggregate.

## What to do

**Fix the cause; let the backlog drain.**

Once signing works again, the queued records sign and the condition closes on
its own. There is no bulk "sign everything" control and this runbook does not
ask you to build one — a control that signs in bulk without the per-record
checks the pipeline performs is a control that produces signatures nobody should
rely on.

**Do not** mark records as signed by any direct means. A signature that did not
come from the signing pipeline is a signature the verifier cannot reproduce, and
producing one would be worse than the backlog by a wide margin.

**Do not** delete stuck records to clear the count. They are the customer's
evidence.

**Do** tell an asking customer the truth: the upload succeeded, the record is
safe, the signing step is delayed, and it will complete without any action from
them.

## Verification

- The count falls across successive observations and the condition closes
  itself. Do not resolve it by hand — the lifecycle declines to close a
  condition whose own source still reports it live, so a hand-resolve either
  fails or hides a real backlog.
- Spot-check that newly uploaded records now reach signed state within the
  normal window, rather than only that the old ones drained.

## Related

- [`worker-wedged`](./worker-wedged.md) — when nothing is running.
- [`failed-report-generation`](./failed-report-generation.md) — the next step in
  the pipeline, which cannot start until signing completes.
- [`tsa-timestamp-failure`](./tsa-timestamp-failure.md) — a record that signed
  but could not be timestamped. Different condition, and unlike this one it has
  no remedy after the fact.
