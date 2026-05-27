# PROOVRA Platform Maturity Runbook (Phase G5)

**Audience:** ops leads, SRE, customer success, sales engineering.

**Purpose:** name what is **production-safe**, **demo-safe**, and **scaffold
only** across PROOVRA's operational subsystems, plus the bounded acceptance
criteria for each. This is the operator-facing source of truth that
discloses real capability — no marketing inflation.

**Companion docs:**

- [honest-mi-decision.md](../architecture/honest-mi-decision.md) — OCR /
  transcript scope
- [design-system.md](../architecture/design-system.md) — visual identity
- [deployment-hardening.md](./deployment-hardening.md) — env + startup
- [observability.md](./observability.md) — metrics + alerts
- [test-strategy.md](./test-strategy.md) — test suite map
- [shared-presence-deployment.md](./shared-presence-deployment.md) — presence
  multi-instance plan

---

## 1. Production-readiness classification

| Subsystem | Readiness | Notes |
| --- | --- | --- |
| Evidence capture + finalize | **Production** | Hash hard-gate (Phase A0) protects integrity. Worker recomputes SHA-256; mismatch → FAILED_HASH_MISMATCH terminal state. |
| Custody chain | **Production** | Hash-chained custody events (Phase A0). Append-only. Source-contract tested. |
| Report PDF generation | **Production** | Backend signing required in production via `PDF_SIGNING_ENABLED=true` config gate. Falls back to opt-out ack flag (`PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true`) — operator must set one or the other or the API fails fast at startup. |
| Verification Package ZIP generation | **Production** | Bounded contents (manifest + Report PDF + custody log + integrity attestation). |
| Public verify (anonymous) | **Production** | DESTROYED/TOMBSTONED 404s preserved. FAILED_HASH_MISMATCH 404s. Hardened against enumeration. |
| Workspace / org tenancy | **Production** | Stage 6 invariant: `Team.organizationId NOT NULL`. Resolver throws on violations. Phase G4.1 read-side projection handles legacy null-teamId rows deterministically. |
| Governance — retention | **Production** | Inheritance resolver (Phase B0.4). Lifecycle gates (Phase 27). Destruction preview + certificate. |
| Governance — legal hold | **Production** | ACTIVE/RELEASED states. Cascades into evidence + report eligibility gates. |
| Reviewer Console + inline actions | **Production** | Step-up gated mutations. Bounded pagination (≤100/200 per tab). Source-contract tested (Phase G3.2). |
| Matter Workspace | **Production** | 11 tabs. Bounded ≤25 rows per section from the aggregator. Filter wiring complete (Phase G3.2). |
| Inbox + topbar mention indicator | **Production** | 60s polling. Bounded payload. |
| Notification preferences | **Production** | 7 types × 2 channels. Per-workspace persistence. `isPreferenceEnabled` consumed by inbox aggregator (Phase G3.1). |
| Step-up infrastructure | **Production** | SMS code flow via Twilio Verify. STEP_UP_REQUIRED 401 + retry-once contract (Phase G3). |
| Audit feed (security events) | **Production** | 320-type catalog, DB-backed. Bounded details JSON (4 KB). |
| Discussion threads | **Production** | Phase 16 backend, Phase C2 UI. Workspace-scoped. |
| Intake workflow | **Production** | Evidence requests, contributor portal, reviewer re-request. Phase C3. |
| Search (evidence index) | **Production for index, demo for OCR-text search** | Search indexes evidence metadata + custody. OCR/transcript indexing is `INDEX_EXISTING_ONLY` — source tables empty (Honest-MI decision). |
| Media-intelligence panel | **Production (bounded signal projection)** | Read-only deterministic heuristics. NEVER claims OCR/transcript extraction (Honest-MI decision). |
| Reports browse page | **Production** | GovernedExportAction wraps both downloads (Phase G3.2). |
| Presence (heartbeat / collision) | **Single-instance production** | In-process Map. Multi-instance requires Redis adapter — documented in shared-presence-deployment.md. |
| Realtime mentions / inbox | **Production via polling** | No WebSocket / SSE infrastructure. Polling intervals: 30s presence, 60s inbox, 5s MI (only when run-in-flight). |
| Identity federation (SSO/SAML/SCIM) | **Production** | Phase R8 — fully wired with audit emission. |
| Identity security (MFA, recovery, trusted device) | **Production** | Phase R8.1.x. |
| Webhook delivery | **Production** | Idempotency keys. Signed deliveries. Phase E3. |
| Async job queue (BullMQ) | **Production for single-Redis** | 8+ queues. Retries + DLQ. Concurrency defaults to 1 per queue. |
| Stripe billing | **Production** | Production keys validated at startup. Webhook idempotency. |
| OCR / transcript extraction | **NOT shipped** | Decision B-prime: bounded scaffold, no vendor wired. See honest-mi-decision.md. |
| Multi-instance API replication | **Documented blocker** | Presence + rate-limit assume single-Redis. See shared-presence-deployment.md. |
| Distributed worker pool (multi-region) | **NOT shipped** | Single-worker assumption today. |

---

## 2. Scale risks + bounded guards

### 2.1 Hot paths and their bounded guards

| Path | Bound | Guard | Risk if removed |
| --- | --- | --- | --- |
| `GET /v1/reviewer-ops/console` | ≤25 rows per section | `SECTION_LIMIT = 25` in console aggregator | Reviewer console paint slows under N>1000 |
| `GET /v1/cases/:id/matter-workspace` | ≤25 rows per section | aggregator caps each section | Matter envelope balloons |
| `GET /v1/me/inbox` | ≤200 rows | inbox aggregator cap | Inbox paint slows |
| `GET /v1/me/presence/heartbeat` | ≤25 viewers | 25-viewer cap in `presence.service.ts` | Topbar / matter chip paint slows |
| `GET /v1/reviewer-ops/queue` | ≤100 rows | route schema `limit` max 100 | Queue paint slows |
| `GET /v1/reviewer-ops/escalations` | ≤200 rows | route schema `limit` max 200 | Escalations paint slows |
| `GET /v1/reviewer-ops/workload` | ≤200 rows | route schema `limit` max 200 | Workload paint slows |
| Discussion threads (per matter) | ≤25 rows (aggregator) + ≤200 search (per request) | route caps | Communications tab slows |
| Custody event list | ≤500 events (paginated) | route limit | Custody page slows |
| Evidence list (per workspace) | cursor pagination (50/page default) | route limit + cursor | Evidence library scroll |

### 2.2 Polling intervals

| Surface | Interval | Bounded payload |
| --- | --- | --- |
| Inbox topbar | 60s | counts only |
| Presence heartbeat | 30s | bounded payload `{userId, displayName, lastSeenAtUtc}` × max 25 |
| Reviewer Console refresh | manual (mutation-triggered reload) | full aggregator (≤25/section) |
| Media-intelligence run (in-flight) | 5s while `pollWhileRunning` | bounded signal list |
| Artifact-readiness (post-finalize) | 3s while finalized | minimal `{report:{available, pending}, package:{...}}` |

### 2.3 Rate limits

Per-route rate limits exist for: capture create, login, MFA challenge,
SSO start, intake submission, AI chat, webhook delivery, governance
sensitive writes. Each has a counter in the metrics catalog
(`*_rate_limited_total`).

### 2.4 Scale risks NOT mitigated today (documented blockers)

| Risk | Status | Bound when | Migration path |
| --- | --- | --- | --- |
| Multi-instance API (replicas > 1) | Documented blocker | `replicas > 1` declared in compose / Kubernetes | Redis-backed presence + rate limit (see shared-presence-deployment.md) |
| Queue backlog under heavy ingestion | Bounded by per-queue worker count + DLQ + retry policy | When queue depth > 10k for >10 min | Increase worker replicas + queue-specific concurrency |
| Per-tenant noisy-neighbor in async jobs | Not explicitly partitioned | When one tenant blocks queue for others | Per-tenant queue or priority lanes |
| Single-region storage (R2/MinIO) | Single bucket assumption | When multi-region failover required | Bucket replication + signed-URL rewrite layer |

---

## 3. Observability posture (summary)

**Full catalog:** [observability.md](./observability.md).

### 3.1 What's shipped

- **442 bounded metric keys** (345 counters + 97 gauges) in
  `packages/shared-runtime/src/ops/metrics.service.ts`. All pre-declared.
  Ad-hoc names rejected.
- **320 security event types** in the catalog. DB-backed via
  `SecurityEvent` table.
- **Worker uses Pino with redaction.** API logger is console-only
  (production suppresses info/warn — only `error` emitted).
- **Three health endpoints**: `/healthz` (liveness), `/readyz` (DB +
  config), `/v1/ops/health` (detailed snapshot — feature flags, queue
  depth, open incidents).
- **Prometheus exposition** built in via `buildPrometheusExposition()`.

### 3.2 Observability gaps (top 5)

1. No SLO metrics — no latency histograms, no error-rate targets.
2. API logger lacks structure (no Pino, no trace IDs, no automatic
   filter).
3. Security events not aggregated to real-time dashboard (DB-only).
4. Worker processor health is dark (no "processing latency P95").
5. Queue-depth forecasting absent.

Each gap has a recommended migration in `observability.md`.

---

## 4. Deployment posture (summary)

**Full catalog:** [deployment-hardening.md](./deployment-hardening.md).

### 4.1 What's shipped

- `runStartupConfigValidation()` fails fast in production for: missing
  `AUTH_JWT_SECRET`, missing `DATABASE_URL`, feature-flagged secrets,
  PDF signing config, SAML/S3 localhost guards, Stripe key shape.
- Health probes: `/healthz` + `/readyz`.
- Pino logger on worker with secret redaction.
- BullMQ retry + DLQ per queue.

### 4.2 Deployment gaps (top 5)

1. No startup DB connectivity probe (config check passes; DB ping
   deferred to first query).
2. No Redis startup probe on worker.
3. Fallback strategy undocumented (when is in-memory rate limit vs
   Redis active?).
4. Health endpoints fragmented — no single "golden signal" surface.
5. No graceful-degradation flags.

Each gap has an explicit migration plan in `deployment-hardening.md`.

---

## 5. Demo-readiness checklist

For a serious enterprise prospect demo:

- [ ] Run `runStartupConfigValidation` in production mode and confirm no
      `ProductionConfigError` is thrown.
- [ ] Confirm `/readyz` returns 200.
- [ ] Run the regression contract suites: `phase-g5-honest-mi`,
      `phase-g5-vocabulary-contracts`, `phase-g4-regression-safety`,
      `phase-g3-2-final-live-operations-closure` (no failing tests).
- [ ] Verify the Honest-MI UI surfaces. The MediaIntelligencePanel must
      render WITHOUT any extraction CTA.
- [ ] Verify `Download Report PDF` and `Download Verification Package
      ZIP` are labelled with the suffix.
- [ ] Verify Matter Workspace tabs render with realistic data.
- [ ] Verify Reviewer Console inline actions (Assign / Escalate /
      Acknowledge / Request info / Open inspector).
- [ ] Verify Presence chip renders + CollisionWarning fires when a peer
      edits.
- [ ] Verify the public verify page 404s for tampered hashes.
- [ ] Verify the sidebar has no "Team" references in nav (allowlist
      carryovers excepted).

---

## 6. Acceptance criteria (Phase G5)

- [x] Production-readiness classification table in this doc.
- [x] Scale risks + bounded guards documented.
- [x] Observability gaps named with migration paths.
- [x] Deployment gaps named with migration paths.
- [x] Honest-MI decision pinned (separate doc).
- [x] Design system pinned (separate doc).
- [x] Vocabulary contracts shipped (test suite).
- [x] Test strategy doc covers the suite map.
- [x] No fake claims — every entry in §1 is honest.

---

## 7. Reference

- Honest-MI: [honest-mi-decision.md](../architecture/honest-mi-decision.md)
- Design system: [design-system.md](../architecture/design-system.md)
- Deployment hardening: [deployment-hardening.md](./deployment-hardening.md)
- Observability: [observability.md](./observability.md)
- Test strategy: [test-strategy.md](./test-strategy.md)
- Shared presence plan: [shared-presence-deployment.md](./shared-presence-deployment.md)
- Phase G4 deep cleanup: [phase-g4-deep-cleanup-runbook.md](./phase-g4-deep-cleanup-runbook.md)
- Phase G3.2 closure: [phase-g3-2-final-closure-runbook.md](./phase-g3-2-final-closure-runbook.md)
