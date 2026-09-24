# PROOVRA — the monitoring stack

## What was actually wrong

The repository carried 32 alert rules and 13 dashboards, and the previous
release matrix recorded monitoring as **FAIL (not wired)** on the grounds that
nothing evaluated them. Exercising it on 2026-09-24 found that description too
generous in one direction and wrong in another.

**The rules could not be loaded by any Grafana at all.** Provisioning aborts on
the first one:

```
Failed to provision alerting
error="alert rules: invalid alert query api_down:
[alerting.alert-rule.invalidRelativeTime]
Invalid alert rule query api_down: invalid relative time range [From: 0s, To: 0s]"
```

Every query was missing `relativeTimeRange`. A file that cannot be provisioned
is not a set of alert rules; it is a document that resembles one.

**The comparisons filtered instead of returning a boolean.**
`avg_over_time(up{job="proovra-api"}[2m]) < 0.5` returns the value of `up` —
which is **0** when the API is down — and Grafana reads 0 as "not firing". The
single most important rule in the file was written so that it stayed silent
during exactly the outage it exists to report. Now `< bool 0.5`, which returns
1.

**`or` chains dropped every arm but the first.** With label-less 1/0 arms,
`a or b` returns `a` alone, so six multi-condition rules were quietly
single-condition rules. They now sum their arms: any true arm makes the total
non-zero.

**Every rule paged on an empty database.** Grafana's default `noDataState`
turns NoData into a firing alert, and most of these rules query counters that
have no series until their first increment. Measured: a cold start with nothing
scraped yet delivered **21 alerts**. After setting `noDataState: OK` on the 30
counter-based rules, the same cold start delivers **0**. The two `up{...}`
rules keep `noDataState: Alerting`, because there NoData means the scraper lost
the target, which is the outage.

## What now exists

| file | role |
|---|---|
| `infra/prometheus/prometheus.yml` | scrape config; the job names are load-bearing because the rules name them |
| `infra/grafana/provisioning/datasources/prometheus.yml` | data source pinned to `uid: prometheus`, which every rule references |
| `infra/grafana/provisioning/dashboards/proovra.yml` | loads the 13 dashboards that nothing loaded |
| `infra/grafana/provisioning/alerting/contact-points.yaml` | the destination, from `PROOVRA_ALERT_WEBHOOK_URL` |
| `infra/grafana/provisioning/alerting/notification-policies.yaml` | grouping, repeat, and a faster path for `severity=critical` |
| `infra/docker/docker-compose.monitoring.yml` | Prometheus + Grafana + redis-exporter, loopback-bound |

Deploy alongside the production stack:

```
docker compose -f infra/docker/docker-compose.prod.yml \
               -f infra/docker/docker-compose.monitoring.yml up -d
```

## Proof of delivery

Exercised against a disposable stack with a synthetic target standing in for
the API — deliberately NOT the real API, because `services/api/.env` holds
production credentials and booting it locally would reach production.

1. Prometheus scraped the synthetic target: `up{job="proovra-api"} = 1`.
2. All 32 rules provisioned and evaluated: 32 `inactive`.
3. The target was killed. `up` went to 0, the rule moved to `pending`, then
   `firing`, and the webhook receiver recorded:

```
2026-09-24T02:24:38.025Z  status=firing  alerts=1  receiver=proovra-oncall
   - API down | critical | PROOVRA API is not responding to scrapes.
```

4. `Redis unavailable` delivered separately, via the NoData→Alerting policy,
   because no redis-exporter runs in the disposable stack.
5. The target was restored and the **recovery** notification arrived:
   `API down -> resolved` at 02:26:38.
6. `Redis unavailable` then repeated at roughly five-minute intervals, which
   is `repeat_interval` doing its job rather than a duplicate-delivery bug.

The ten deliveries are recorded verbatim in
`docs/operations/monitoring-exercise-2026-09-24.jsonl` — the receiver's own
log, not a transcription.

### The cold-start measurement

| | deliveries on a start with nothing scraped yet |
|---|---|
| before the `noDataState` policy | **21** |
| after | **0** |

## What this does NOT prove

* **No production destination is configured.** `PROOVRA_ALERT_WEBHOOK_URL` is
  deliberately without a default and the compose file refuses to start Grafana
  without it — a placeholder would provision cleanly and swallow every alert.
  The owner supplies the real destination.
* **The `traces_spanmetrics_*` rules cannot evaluate in this stack.** Four
  rules query metrics produced by an OpenTelemetry collector's spanmetrics
  connector, and nothing deploys one. They are `noDataState: OK`, so they are
  silent rather than noisy — silent is the honest state for a rule whose data
  source does not exist, but it is not coverage.
* **It has never run against the real API.** The exposition format and the
  `/metrics` bearer-token gate were read from source, not exercised.
