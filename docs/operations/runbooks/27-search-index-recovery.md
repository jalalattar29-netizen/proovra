# Runbook 27 — Search index recovery

## Symptoms
- Users report search results missing evidence they recently uploaded.
- `/admin/runtime/readiness` `search_indexing` subsystem reports DEGRADED (lag > threshold) or CRITICAL (lag > 24 h).
- OCR / transcript indexing lag pointers (`indexed_at_utc`) consistently stale.

## Blast radius
Per-team search results. Affects user-visible evidence search; does NOT affect evidence read, evidence integrity, custody chain, or reports.

## Detection
- `/admin/runtime/readiness` `search_indexing` subsystem.
- Operator query for the oldest unindexed OCR / transcript row.
- Customer-support tickets reporting "I can't find evidence I just uploaded".

## Logs to inspect
- Worker logs filtered to `search-indexing.processor`.
- BullMQ `search-indexing` queue depth (`/admin/runtime/queues`).

## Rollback procedure
None — indexing is forward-only. The fallback (when FTS lag is high) is ILIKE search at the API layer.

## Safe recovery procedure
1. **Confirm the worker is up.** `/admin/runtime/workers` heartbeat fresh. If stale, runbook 03 (worker restart).
2. **Confirm Redis is up.** Queue jobs cannot be processed if BullMQ can't reach Redis (runbook 26).
3. **Confirm the indexing handler is succeeding** — worker logs should show `processSearchIndexingJob` completing within seconds per job.
4. **For a large backlog** (e.g., post-outage): the queue drains at the worker's normal concurrency. Lag is bounded by backlog ÷ throughput.
5. **For a handler-level exception**: read the worker logs for the specific error. Common causes:
   - DB connection saturation: scale DB connection pool.
   - Specific evidence row has malformed OCR / transcript JSON: identify the row, isolate or skip it, file a follow-up ticket.
6. **For chronic lag** (sustained > threshold): DEF-048 (POST_LAUNCH) tracks the lack of a configurable SLA + alert. For now, escalate when the operator-observed lag exceeds the customer's expectation.

## Validation steps
- A test evidence upload appears in search within 60 s of finalize.
- `/admin/runtime/readiness` `search_indexing: HEALTHY`.
- Worker logs show steady `processSearchIndexingJob` completions.
- No `search-indexing` queue depth elevation persisting > 1 hour.

## Escalation conditions
- Lag persists > 24 h after worker recovery → DEF-048 closure becomes urgent; consider raising worker concurrency.
- A customer's evidence is search-invisible for > 4 hours during business hours → customer-direct notification.
- Handler exception rate > 5% over an hour → halt the worker (runbook 03 graceful) + investigate the root cause.

## DO NOT DO THIS
- Do NOT manually mutate `indexed_at_utc` columns to "mark things indexed". The column is the audit of what the handler actually processed.
- Do NOT bypass the FTS layer to "directly insert into the index". FTS is owned by Postgres + the indexer; manual writes drift from canonical state.
- Do NOT disable the worker because "the queue is too big". Disabling stops drainage; the backlog grows worse.
- Do NOT lower the indexing concurrency to "reduce load" without measuring — it just extends lag without solving the underlying handler issue.
