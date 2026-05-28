# PROOVRA Internal SLO Model (Phase O1.2)

**Audience:** PROOVRA engineering leadership; SRE.

**Important:** the SLOs below are **internal targets**, not contractual SLAs. PROOVRA does not promise an external customer SLA without business + legal sign-off.

---

## 1. SLO catalog

| # | SLO | Target | Window | Source metric / signal |
| --- | --- | --- | --- | --- |
| 1 | API availability | **99.5%** | rolling 30d | `up{job="proovra-api"}` + 2xx-rate from `http_server_requests_total` |
| 2 | Verification Package generation success | **99%** | rolling 30d | `1 - rate(package_generation_failed_total) / rate(package_generation_total)` |
| 3 | Report generation success | **99%** | rolling 30d | derived from the Phase A2 PDF signing metrics + worker exception rate |
| 4 | Queue recovery safety (forbidden replay blocked) | **100%** | rolling 7d | `queue_replay_forbidden_total` must equal the count of forbidden replay attempts recorded in security events |
| 5 | Export reproducibility | **99%** | rolling 30d | `1 - rate(export_reproducibility_failure_total) / rate(export_reproducibility_verify_total)` |
| 6 | Worker health | **99%** | rolling 7d | absence of `worker_heartbeat_missing_total` / `worker_stalled_total` increases |

## 2. Bounded copy for dashboards

Dashboards may display each SLO as "internal target X% over Y window". They MUST NOT label these values as "guaranteed", "SLA", or "uptime promise". The bounded label in operator UIs is:

> Internal target — not a customer SLA.

## 3. SLI definitions

Each SLO above uses one of the bounded metrics emitted by services/api or services/worker. The metric catalog lives in `packages/shared-runtime/src/ops/metrics.service.ts` (the `COUNTER_NAMES` and `GAUGE_NAMES` arrays). Source-contract tests assert every dashboard metric appears in that catalog.

## 4. Burn-rate alerting

Phase O1.2 does **not** ship multi-window multi-burn-rate (MWMBR) alerts. Existing alerts in `infra/grafana/alerts/proovra-operations-alerts.yaml` cover the symptomatic fast-burn cases (per-rate thresholds). MWMBR is a documented follow-up — see deferred section §7.

## 5. Honest non-claims

PROOVRA's internal SLOs are operational signals only. They do not:

- promise a percentage uptime to customers,
- imply legal admissibility of any artifact,
- imply that missing the target triggers contractual remediation.

External-facing availability claims require business + legal sign-off and a separate review.

## 6. Reviewer + sign-off

Engineering leadership owns the SLO targets. Changes to the targets require:

1. Engineering lead review.
2. SRE on-call lead concurrence.
3. Updates to this doc + the related Grafana dashboard.

## 7. Deferred follow-ups

- Multi-window multi-burn-rate alerts for each SLO.
- Per-tenant SLO segmentation for enterprise workspaces that have a contracted operational expectation.
- Public SLO dashboard once external SLA discussions reach a binding stage.
- Promotion of report generation SLO from "derived" to "explicit metric pair".

## 8. Related documents

- `observability.md` — full observability catalog.
- `observability-runbooks.md` — alert response runbooks.
- `otel-runtime-wiring.md` — engineering OTEL setup.
- `phase-o1-2-observability-coverage-closure.md` — closure report.
