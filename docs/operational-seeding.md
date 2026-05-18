# Operational Seeding (staging / demo only)

Generate realistic reviewer-ops runtime activity in staging or demo
environments by driving the **real** engines (workflow, SLA,
escalation, workload, reconcile, incident) — not by inserting
placeholder rows. Production is protected behind two env gates and a
shared secret. Cleanup removes only the records the seed run created.

## ⚠️ Production safety

Five separate gates must all pass for any seed mutation to fire:

1. `OPERATIONAL_SEEDING_ENABLED=true` — master switch.
2. `OPERATIONAL_SEEDING_SECRET` configured + matches the
   `X-Operational-Seed-Secret` request header.
3. `NODE_ENV !== "production"` **or** `OPERATIONAL_SEEDING_ALLOW_PRODUCTION=true`.
4. Caller is authenticated (session JWT) and has `identity.member.admin`
   on the target team.
5. The team must have unassigned `Evidence` rows that don't yet have a
   review workflow (we never disturb production rows in active review).

Any missing gate returns a typed JSON error with the appropriate HTTP
status (401, 403, 404, 503).

## Required environment variables

| Env | Default | Purpose |
|-----|---------|---------|
| `OPERATIONAL_SEEDING_ENABLED` | `false` | Master switch. Must be set to `true` in staging/demo. |
| `OPERATIONAL_SEEDING_SECRET` | — | Shared secret required on every mutating seed request via `X-Operational-Seed-Secret`. Generate with `openssl rand -hex 32`. |
| `OPERATIONAL_SEEDING_ALLOW_PRODUCTION` | `false` | Explicit opt-in to allow seeding in `NODE_ENV=production`. Keep `false` unless you know exactly what you're doing. |

Plus, the existing reviewer-ops activation envs must already be set:

| Env | Default | Purpose |
|-----|---------|---------|
| `REVIEWER_OPS_RECONCILIATION_ENABLED` | `true` | Worker tick that advances SLA / escalation engines. |
| `REVIEWER_OPS_RECONCILIATION_INTERVAL_MS` | `300000` (5m) | Tick cadence. |
| `REVIEWER_OPS_CRON_SECRET` | — | Worker → api auth for reconcile. |
| `INTERNAL_API_BASE_URL` | — | Worker's URL to the api. |
| `SCHEMA_VALIDATION_FAIL_FAST` | `true` | API refuses to boot when reviewer-ops critical schema is missing. |

## Scenarios

| Scenario | Workflows created | Effect after `runReconcile` |
|----------|-------------------|----------------------------|
| `baseline` | 5 (configurable via `count`) | Queue is populated + a reviewer is assigned. No SLA breaches. Workload snapshot recorded. Dashboards show steady-state activity. |
| `sla_breach` | 5 | Workflows are backdated so SLA flips to `BREACHED` on the next reconcile pass; escalations are created (1 per workflow). |
| `escalation_storm` | 15 (>= the storm threshold) | Same as `sla_breach` but with enough workflows that the engine fires a GOVERNANCE incident via `recordIncident()`. Storm appears on the alerts ribbon. |
| `full_lifecycle` | 1 | Walks one workflow through every transition: ensure → assign → backdate → reconcile → escalate → acknowledge → resolve → audit. Also fires a tagged WARNING governance incident. |

## API endpoints

### POST `/v1/ops/seed/reviewer-ops`
Run a scenario. Returns the seedRunId, list of created resource IDs,
reconcile result, and warnings.

```bash
curl -X POST "$API_BASE/v1/ops/seed/reviewer-ops" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "X-Operational-Seed-Secret: $OPERATIONAL_SEEDING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "00000000-0000-0000-0000-000000000001",
    "scenario": "escalation_storm",
    "count": 15,
    "dryRun": false
  }' | jq .
```

Response shape (truncated):
```json
{
  "seedRunId": "8c2…f0",
  "scenario": "escalation_storm",
  "teamId": "00000000-…",
  "dryRun": false,
  "startedAtUtc": "2026-05-18T18:25:11.000Z",
  "completedAtUtc": "2026-05-18T18:25:12.100Z",
  "evidenceConsidered": 15,
  "reconcileResult": {
    "scanned": 15,
    "flippedBreached": 15,
    "flippedDueSoon": 0,
    "escalationsCreated": 15,
    "workloadReviewersComputed": 3,
    "dueSoonRemindersScheduled": 0,
    "inactivityRemindersScheduled": 0
  },
  "created": {
    "workflowIds": ["...", "..."],
    "escalationIds": ["...", "..."],
    "incidentIds": ["..."],
    "workloadSnapshotsCreated": 3
  },
  "warnings": []
}
```

`dryRun: true` returns the plan with empty `created.*` arrays and writes
an audit row tagged `outcome=dry_run`. Cleanup is not required for
dry runs.

### GET `/v1/ops/seed/reviewer-ops?teamId=<team>`
List recent seed runs for the team (no secret required — read-only).
Use this to find the `seedRunId` for cleanup.

### DELETE `/v1/ops/seed/reviewer-ops/:seedRunId?teamId=<team>`
Cleanup. Reads the seed-run audit row, deletes the listed resources
in reverse-dependency order (escalations → workflow events →
workflows → incidents), and writes a follow-up audit row.

```bash
curl -X DELETE "$API_BASE/v1/ops/seed/reviewer-ops/8c2…f0?teamId=00000000-…" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "X-Operational-Seed-Secret: $OPERATIONAL_SEEDING_SECRET" | jq .
```

Response:
```json
{
  "seedRunId": "8c2…f0",
  "cleanedAtUtc": "2026-05-18T18:30:00.000Z",
  "deleted": {
    "escalations": 15,
    "workflowEvents": 30,
    "workflows": 15,
    "incidents": 1,
    "workloadSnapshots": 3
  },
  "notFound": false
}
```

> `workloadSnapshots` is a count of seeded snapshots, not a delete
> count — workload snapshots are immutable time-series rows. The
> cleanup tells you how many noise rows entered the analytics
> window so you can interpret a dashboard spike.

## What seeded records look like in the UI

| Surface | Marker |
|---------|--------|
| Reviewer Ops queue | Workflow rows look identical to real workflows (this is intentional — we exercise the real path). The audit log shows `action=operational_seed.run` with the seedRunId. |
| Escalations dashboard | `safeSummary` prefixed with `[SEED:<runId>] …`. |
| Incidents dashboard | `title` prefixed with `[SEED:<runId>] Operational seed: <scenario>`. `metadata.seeded=true`. |
| Audit log | Two events per seed run: `operational_seed.run` (start, with `createdResourceIds`) and `operational_seed.cleanup` (after delete). |
| Metrics | `operational_seed_run_total`, `operational_seed_created_reviews_total`, `operational_seed_created_escalations_total`, `operational_seed_created_incidents_total`, `operational_seed_cleanup_total` all bumped. |

## Validation chain

After running `escalation_storm` against a staging team:

```bash
# 1. Reviewer Ops dashboard shows escalations.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/reviewer-ops/escalations?teamId=<team>&status=OPEN" | jq '.escalations | length'
# Expect: ≥ 15.

# 2. Workload snapshots exist.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/reviewer-ops/workload?teamId=<team>" | jq '.workload | length'
# Expect: > 0.

# 3. Storm incident is open.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/ops/incidents?teamId=<team>&status=OPEN&category=GOVERNANCE" | jq '.incidents[] | select(.title | startswith("[SEED"))'

# 4. Operational gauges populated.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "$API_BASE/v1/ops/metrics" \
  | jq '.metrics.counters.operational_seed_run_total,
        .metrics.gauges.reviewer_queue_overdue'
# Expect: counter > 0, gauge ≥ 15.

# 5. Schema validation healthy (no drift introduced).
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/schema-status?teamId=<team>" \
  | jq '.status'
# Expect: "healthy".

# 6. Cleanup removes seeded rows only.
curl -X DELETE "$API_BASE/v1/ops/seed/reviewer-ops/<seedRunId>?teamId=<team>" \
  -H "Authorization: Bearer $OP_TOKEN" \
  -H "X-Operational-Seed-Secret: $OPERATIONAL_SEEDING_SECRET"
# Re-run query (1) and confirm count returned to baseline.
```

## What the seeding service does NOT do

- ❌ Creates new `Evidence` rows (would trip billing + storage gates).
- ❌ Bypasses governance, retention, legal hold, or destruction review.
- ❌ Touches report-v2 / verify / package builders.
- ❌ Touches OTS / TSA / anchor proofs.
- ❌ Inserts fake dashboard counters or hardcoded UI values.
- ❌ Modifies `AdminAuditLog` rows (HMAC chain stays intact).
- ❌ Deletes immutable workload snapshots (time-series stays honest).
- ❌ Stores real PII or secrets in seeded metadata.
- ❌ Runs without operator-admin RBAC + shared secret + env gates.

## Failure modes

| Error code | HTTP | Meaning |
|------------|------|---------|
| `SEEDING_DISABLED` | 503 | `OPERATIONAL_SEEDING_ENABLED` is not `true`. |
| `SEEDING_PROD_GUARDED` | 503 | Running in production without `OPERATIONAL_SEEDING_ALLOW_PRODUCTION=true`. |
| `SEEDING_SECRET_NOT_CONFIGURED` | 503 | `OPERATIONAL_SEEDING_SECRET` env not set. |
| `SEEDING_SECRET_INVALID` | 401 | `X-Operational-Seed-Secret` header missing / wrong. |
| `INSUFFICIENT_EVIDENCE` | 409 | Team has no Evidence rows without a review workflow. Operator must upload evidence first. |
| `NO_TEAM_REVIEWER` | 409 | Team has no members at all. |
| `UNKNOWN_SCENARIO` | 400 | Scenario name not in the catalog. |

## Postmortem checklist

After each seeding session:

- [ ] All `seedRunId`s for the session have a matching `operational_seed.cleanup` audit row.
- [ ] `operational_seed_created_*` counters increased; `operational_seed_cleanup_total` matches.
- [ ] No `[SEED:` prefixed escalations or incidents remain on the dashboards.
- [ ] Reviewer Ops queue counts returned to baseline.
- [ ] Schema validation returns `"healthy"`.
