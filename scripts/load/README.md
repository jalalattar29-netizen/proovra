# Enterprise Load-Test Baseline

A small, dependency-free load runner that establishes a **latency / throughput
baseline** against the PROOVRA API's bounded read + dry-run surfaces. It is a
diagnostic tool for capacity planning — **not** a stress or destructive test.

- Plain Node ESM (`node:http`/`https`, `node:perf_hooks`) — **zero dependencies**.
- **Read-only + dry-run only.** Nothing here creates, deletes, or mutates data.
- **Refuses production by default** (see the safety guard below).
- **Never logs secrets or response bodies.** The bearer token is redacted.

---

## Safety contract (read this first)

| Guarantee | How it's enforced |
|-----------|-------------------|
| No production runs by default | `evaluateProdGuard()` blocks any non-local/non-staging host, and any `NODE_ENV=production`, unless `LOAD_TEST_ALLOW_PROD=true` is set explicitly. The guard runs **before any traffic is sent**. |
| No real data | Bulk-invite scenarios use synthetic `loadtest+{i}@example.com` addresses only. |
| No mutations | Every scenario is a `GET`, or a bulk-invite **validate / `?dryRun=1`** endpoint that the API documents as "creates nothing". A unit test asserts every `POST` scenario is a dry-run. |
| No uploads | Evidence-upload scenarios are **deliberately omitted** — a safe upload needs a non-prod fixture, the finalize gate, and storage writes, none of which are read-only/dry-run. Add one only behind a dedicated fixture-only, non-prod flag. |
| No leaked secrets | The token is redacted in all console output (`redactToken()`), request/response bodies are never logged, and the JSON report never embeds the token. |

If the target host is not `localhost`/`127.0.0.1`/`*.local` and doesn't match a
staging pattern (`staging`, `stg`, `dev`, `test`, `qa`, `sandbox`, `preview`,
`preprod`), it is treated as production and the run is refused.

---

## Configuration

Config comes from environment variables, optionally overridden by a JSON file
passed with `--config`.

| Env var | File key | Default | Meaning |
|---------|----------|---------|---------|
| `LOAD_TEST_BASE_URL` | `baseUrl` | `http://localhost:3001` | API base URL. |
| `LOAD_TEST_TOKEN` | `token` | — | Bearer token. **Required** for authed scenarios. Redacted in output. |
| `LOAD_TEST_ORG_ID` | `orgId` | — | Required for org-scoped scenarios (audit log, bulk invite). |
| `LOAD_TEST_TEAM_ID` | `teamId` | — | Required for team-scoped scenarios (reviewer ops). |
| `LOAD_TEST_CONCURRENCY` | `concurrency` | `5` | Concurrent in-flight requests per endpoint. |
| `LOAD_TEST_ITERATIONS` | `iterations` | `50` | Requests per endpoint (ignored if a duration is set). |
| `LOAD_TEST_DURATION_MS` | `durationMs` | — | Run each endpoint for this many ms instead of a fixed count. |
| `LOAD_TEST_BULK_ROWS` | `bulkInviteRows` | `5` | Synthetic rows per bulk-invite dry-run (capped at 25). |
| `LOAD_TEST_ALLOW_PROD` | `allowProd` | `false` | Set `true` to permit a production-looking target. Use with extreme care. |
| — | `endpointOverrides` | `{}` | Map of `scenarioName -> pathTemplate` to override uncertain routes. |

`NODE_ENV=production` also triggers the guard regardless of URL.

---

## Running

```bash
# Show help — no traffic sent.
node scripts/load/runner.mjs --help

# Validate config + prod guard only — no traffic sent.
LOAD_TEST_TOKEN=... LOAD_TEST_ORG_ID=... LOAD_TEST_TEAM_ID=... \
  node scripts/load/runner.mjs --validate-config

# Run the baseline against a local API and write a JSON report.
LOAD_TEST_TOKEN=... LOAD_TEST_ORG_ID=... LOAD_TEST_TEAM_ID=... \
  node scripts/load/runner.mjs --out baseline.json

# With a JSON config file (overrides env).
node scripts/load/runner.mjs --config ./scripts/load/example.config.json
```

Only run against **local or staging**. To run against a real staging URL that
does not match the staging pattern, or against production (do not), you must set
`LOAD_TEST_ALLOW_PROD=true` explicitly and knowingly.

---

## Scenarios

All scenarios live in `scenarios.mjs`. Public probes need no token.

| Scenario | Method | Path | Auth | Notes |
|----------|--------|------|------|-------|
| `healthz` | GET | `/healthz` | no | Liveness probe. |
| `readyz` | GET | `/readyz` | no | Readiness (DB reachable). |
| `ops_health` | GET | `/v1/ops/health` | yes | Detailed operator health. |
| `operations_readiness` | GET | `/v1/operations/readiness` | yes | Readiness posture (PLATFORM-ADMIN). |
| `evidence_list` | GET | `/v1/evidence?limit=25` | yes | Evidence list (cursor pagination). |
| `cases_list` | GET | `/v1/cases?limit=25` | yes | Case list. |
| `search_evidence` | GET | `/v1/search?q=loadtest&teamId=:teamId` | yes | Unified search (query + workspace scope). |
| `audit_events` | GET | `/v1/orgs/:orgId/audit-events?limit=25` | yes | Org audit log. |
| `reviewer_ops_queue` | GET | `/v1/reviewer-ops/queue?teamId=:teamId&limit=25` | yes | Reviewer queue. |
| `reviewer_ops_dashboard` | GET | `/v1/reviewer-ops/dashboard?teamId=:teamId` | yes | Reviewer dashboard. |
| `bulk_invite_validate` | POST | `/v1/orgs/:orgId/invites/bulk/validate` | yes | **DRY RUN** — validates synthetic invites, creates nothing. |
| `bulk_invite_csv_dryrun` | POST | `/v1/orgs/:orgId/invites/csv?dryRun=1` | yes | **DRY RUN** — parses synthetic CSV, creates nothing. |
| `report_status_poll` | GET | `/v1/reports?limit=10` | yes | **Route uncertain** — see below. |

### Configurable / uncertain routes

`report_status_poll` uses a best-guess path (`/v1/reports?limit=10`). The exact
report/package **status-polling** route was not pinned down during discovery, so
it is marked `configurable`. Override it without editing code:

```json
{ "endpointOverrides": { "report_status_poll": "/v1/reports/:id/status" } }
```

Any scenario marked `configurable` in `scenarios.mjs` can be overridden the same
way.

---

## Reading the report

The runner prints a human summary and a JSON `baseline` document (also written
to `--out` if given). Key fields:

```jsonc
{
  "kind": "enterprise-load-test-baseline",
  "target": "http://localhost:3001",   // never contains the token
  "totals":    { "requests", "errors", "errorRate", "throughput" },
  "aggregate": { "p50", "p95", "p99", "errorRate", "throughput" },
  "perEndpoint": [
    {
      "endpoint": "evidence_list",
      "requests", "successful", "errors",
      "errorRate",                         // 0..1 (fraction of requests that failed)
      "throughput",                        // requests/second
      "latencyMs": { "min", "p50", "p95", "p99", "max" }
    }
  ]
}
```

- **p50 / p95 / p99** — latency percentiles in milliseconds (nearest-rank).
  p95/p99 are the tail-latency numbers you baseline against.
- **errorRate** — fraction (0–1) of requests that failed. A response with
  status `>= 500` or a transport error counts as an error; `4xx` (e.g. auth or
  validation) counts as a successful, timed request (the server responded).
- **throughput** — sustained requests/second at the configured concurrency.

Capture a baseline JSON on a known-good build and diff future runs against it to
catch regressions in tail latency or throughput.

---

## Tests

```bash
node --test scripts/load/runner.test.mjs
```

The tests exercise the pure helpers only (prod guard, config validation,
percentile math, report shape, token redaction, synthetic-data check) and
**never hit a live server**.
