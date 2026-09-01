# Runbook — Search index reconciliation failing

**Incident slug**: `search-index` · **Category**: `RECONCILIATION` · **Default severity**: `WARNING`

## Read this first

**Nothing evidential is affected.** Evidence records, their hashes, their
signatures, their timestamps, their reports and their verification packages are
all unaffected by this condition. What is degraded is *finding* them.

That is why the severity is WARNING rather than HIGH, and it is a deliberate
ranking choice recorded in the condition itself: putting a search problem beside
an unprovable record would make the genuinely worst rows in the operations queue
harder to see.

Say this plainly to anyone who asks. A customer told "your search index is
failing" hears something much worse than what is true.

## What it means

The workspace's search index is out of step with its records, **and nothing is
currently working to close the gap**. The second half is the condition — an
index that is behind but actively reconciling is not this.

The condition **closes on its own** once the index is proven complete. There is
no acknowledge-and-forget step; if it stays open, the gap is still there.

## Symptoms

- Operations shows "Search index reconciliation failing" for a workspace.
- Search returns fewer results than the record count implies, or misses records
  a user knows exist.
- Recently added evidence does not appear in search while appearing everywhere
  else.

## Establish which state it is in

The condition's metadata carries the derived readiness state. It is the derived
state, not a job's exit code, and the distinction matters:

| State | What it means | What to do |
| --- | --- | --- |
| `STALLED` | Work is outstanding and nothing is progressing it | Look for a stopped worker or an exhausted retry budget |
| `UNREADABLE` | The readiness facts could not be read at all | **Not** a healthy index — see below |
| `FAILING` | Reconciliation is running and not converging | Look at what it is failing on |

`UNREADABLE` is reported as unknown rather than as a failure, and the condition
is neither opened nor closed on it. An unreadable index is not a healthy one; it
is one nobody measured. If you see it, the readiness read itself is broken and
that is the thing to fix first.

## Investigate

1. **Is the indexing worker running at all?** A stalled index with a stopped
   worker is a worker problem wearing a search label — see
   [`worker-wedged`](./worker-wedged.md).

2. **Is the index backlog growing or flat?** Growing means throughput is below
   ingest. Flat means nothing is running.

3. **Are the required schema objects present?** The platform diagnostic reports
   them directly: the free-text (trigram) index is the one search actually
   uses. A missing trigram index degrades search to a sequential scan, which
   presents as slowness rather than absence.

   Note that `tsv` column and `tsv_gin` index are reported as ABSENT by design —
   the tsvector path was retired and no consumer reads it. Their absence is not
   this condition and must not be "fixed".

4. **Is it one workspace or all of them?** The condition is per-workspace. One
   workspace failing while others are current points at that workspace's data;
   all of them failing points at the indexer.

## What to do

**There is no destructive step in this runbook, and there should not be.** A
search index is derived state: it can be rebuilt from the records, and the
records are never the thing at risk.

- If the worker is stopped, restart it and let the condition close itself.
- If reconciliation is failing on specific records, the failure detail names
  them; those records are still valid evidence and still fully retrievable by
  id, case, and every other listing surface.
- If the backlog is simply large after a bulk import, it will drain. The
  condition closing is the confirmation.

**Do not** delete and recreate the index as a first move. It converts a partial
index into no index while the rebuild runs, which is a strictly worse state for
the user, and it discards the evidence of what was failing.

**Do not** tell a customer their evidence is unverifiable, missing, or at risk.
None of those is true.

## Verification

The condition closes on its own once the index is proven complete. That is the
verification — do not resolve it by hand. A hand-resolved condition whose source
still reports the gap will simply reopen, and the platform's lifecycle declines
to close a condition whose own source still says it is live.

## Related

- [`worker-wedged`](./worker-wedged.md) — when the indexer is not running at all.
- [`observability-degraded`](./observability-degraded.md) — when you cannot tell
  whether it is running.
