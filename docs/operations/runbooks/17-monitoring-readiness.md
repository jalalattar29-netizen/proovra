# Runbook 17 — Monitoring / observability readiness

**Scope:** the bounded set of operational signals an Ops team should monitor in production. The platform exposes these via existing surfaces; this runbook tells you which surface answers which question.

**Prerequisites:**

- Read access to `/admin/runtime/readiness`, `/admin/runtime/queues`, `/admin/runtime/workers`, `/admin/runtime/migrations`.
- Read access to `/ops/analytics` (per-team).
- Read access to the admin audit log + security event stream.

**Forbidden:**

- Polling the readiness rollup at >1 Hz (the per-subsystem checks have bounded budgets).
- Treating analytics counters as legal evidence — they are operational signal only (E4 contract).
- Inventing a synthetic uptime score — the platform deliberately does not produce one (E5 + E6 contract).

---

## Signal → surface mapping

| Question | Surface |
|---|---|
| Is the application healthy? | `GET /health` (liveness, DB ping) |
| Is the application ready to serve traffic? | `GET /readyz` (readiness + DB ping) |
| What is each subsystem reporting? | `GET /admin/runtime/readiness` — 14-subsystem rollup |
| Are background queues backed up? | `GET /admin/runtime/queues` — per-queue depth |
| Is the worker heartbeat fresh? | `GET /admin/runtime/workers` |
| Are migrations in sync? | `GET /admin/runtime/migrations` |
| How many webhook deliveries succeeded / failed today? | `/ops/analytics` automation envelope (per-team) |
| How many auto-disabled webhook destinations are there? | `/ops/analytics` automation envelope |
| What are reviewer queue counts? | `/ops/analytics` reviewer envelope |
| What is the legal-hold posture? | `/ops/analytics` governance envelope |
| How many reports + verification packages were generated? | `/ops/analytics` artifacts envelope |
| What evidence + cases + escalations are open? | `/ops/analytics` operations envelope |
| Any security events in the last 24 h? | Admin audit log (filterable by event family) |
| Any auth failures in the last 24 h? | Admin audit log, filter `auth.*` |
| Any external intake / review token-redemption failures? | Admin audit log, filter `external_intake.*` / `external_review.*` |

---

## What the platform does NOT publish

- A synthetic SLA / uptime percentage. Reliability is bounded by external dependencies (Postgres host, S3/R2, KMS, TSA, OTS); see Phase E6 Trust Center continuity section.
- A "trust score" / "authenticity score" / "admissibility score" for any evidence record. Phase E5 Trust Center pins this.
- A per-AI-call success rate counter. DEF-035 (POST_LAUNCH) gap — currently console.error only.

---

## Recommended Ops cadence

| Cadence | What to check |
|---|---|
| Continuous (Ops alert rules) | `GET /readyz` returns 200; `/admin/runtime/readiness` rollup is HEALTHY |
| Hourly (Ops dashboard) | Worker heartbeat freshness; queue depths; auto-disabled destinations |
| Daily (Ops review) | `/ops/analytics` per high-volume team; security event stream for any unexpected family |
| Weekly (Ops review) | Migration drift; analytics window comparison; webhook retry exhaustion rate; AI error rate (worker logs) |
| Quarterly (operator-driven) | Restore rehearsal (runbook 00); pilot rehearsal for any pending IdP onboarding |

---

## Alert thresholds (recommended starting points)

These are starting points; tune per workload. The platform exposes the inputs but does not enforce thresholds — that's an Ops dashboard concern.

| Signal | Suggested alert |
|---|---|
| `/readyz` returns 4xx / 5xx | Page on-call immediately |
| `database` subsystem CRITICAL | Page on-call immediately |
| `redis` subsystem CRITICAL | Page on-call immediately |
| Worker heartbeat stale > 2× reconcile interval | Page on-call |
| Queue depth > 2× steady-state baseline for > 10 min | Investigate (worker pause or handler exception) |
| Auto-disabled destinations count > 0 in last 24 h | Investigate within 1 business day |
| AI provider error rate > 5% over 1 hour (worker logs) | Investigate (DEF-035 means this is log-based today) |
| Stripe webhook delivery failure rate > 0 | Investigate (Stripe dashboard is authoritative) |

---

## Honest gaps

- DEF-024 (POST_LAUNCH): SecurityEvent table grows monotonically — no retention. Plan for storage cost growth.
- DEF-031 / 032 (POST_LAUNCH): expired intake links + expired reviewer grants accumulate similarly.
- DEF-035 (POST_LAUNCH): AI failure-rate monitoring is currently log-based; ingest worker logs into the Ops dashboard for visibility.
- No built-in synthetic monitoring. Customer-reported issues + the runbooks above are the primary detection path; Ops may add external synthetic checks (e.g., uptime monitor on `/healthz`).
