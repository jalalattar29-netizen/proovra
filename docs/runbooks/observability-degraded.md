# Runbook — Observability degraded

**Failure modes:** FM-OBS-001 (sink throws).

## What this means

`/v1/ops/metrics` is silent, Sentry isn't receiving captures, or the
worker heartbeat gauge is flat. The platform's invariant is that
observability NEVER crashes business logic; if the metrics surface
itself goes silent, business logic should continue normally.

## First action (under 60s)

```bash
# /metrics should always return non-empty Prometheus exposition.
curl -fsS -H "X-Metrics-Scrape-Token: $METRICS_SCRAPE_TOKEN" \
  "$API_BASE/v1/ops/metrics" | head -50

# Worker heartbeat should be in the exposition.
curl -fsS -H "X-Metrics-Scrape-Token: $METRICS_SCRAPE_TOKEN" \
  "$API_BASE/v1/ops/metrics" | grep -E "worker_heartbeat|queue_backlog"
```

If `/metrics` returns 401, the scrape token in the env doesn't match.
If it returns 200 with very few series, the metric registry is reset.
If it returns 200 with full series but `worker_heartbeat` is missing,
the worker isn't writing heartbeats.

## Triage

The platform's observability surface is:
- `/v1/ops/metrics` — Prometheus exposition, token-gated.
- `/v1/ops/alerts` — alert evaluation (uses `evaluateAlerts`).
- Sentry capture — `captureException` in worker + api routes.
- Worker heartbeat — `startObservabilityHeartbeat` (interval-based).
- Queue health sampler — `startQueueHealthSampler` (interval-based).

The api and worker both emit metrics, but the api hosts the exposition
endpoint. A worker metric gap usually means the worker process died
or the heartbeat loop was disabled.

## Containment

Observability failures do NOT impact business logic by design — see
the source contract in `withSpan` and `safeSinkCall`. There is no
containment action other than restoring the surface.

## Root cause

- **`/metrics` returns 401:** token mismatch. The `METRICS_SCRAPE_TOKEN`
  env var differs between scraper and api. Fix the env, restart api.
- **`/metrics` returns 200 but empty / few series:** the api process
  was just restarted; counters are accumulating from zero. Wait 5
  minutes and re-check.
- **Worker heartbeat flat:** the worker process is dead. Cross-check
  with [worker-wedged](./worker-wedged.md).
- **Sentry silent:** check `SENTRY_DSN` env var on the failing
  service. When unset, Sentry is intentionally a no-op (the platform
  must work without an external observability service).

## Recovery

- For env mismatches, update `/opt/proovra/app/.env` and `docker
  compose up -d` the affected service.
- For dead worker, follow [worker-wedged](./worker-wedged.md).
- For Sentry no-op, verify the DSN is intentional. If Sentry was
  meant to be on, configure DSN; the wire-up reads the env at process
  start.

## Postmortem checklist

- [ ] Confirm no business operation failed due to observability gap
      (search api logs for `withSpan` callers — none should have
      thrown).
- [ ] If the metrics endpoint was down for an extended period, decide
      whether to backfill any high-signal counters from audit log
      (rare).
- [ ] Confirm safe label set was applied — no privileged keys leaked
      into the exposition during recovery. See
      [privacy-leak](./privacy-leak.md).
