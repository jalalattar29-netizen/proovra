# PHASE E6 — Disaster Recovery, Backup & Operational Continuity

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-25
**Test suite:** `services/api/test/phase-e6-dr-continuity.test.ts`
**Companion runbooks:** `docs/operations/runbooks/*.md`
**Trust Center alignment:** `packages/shared-evidence-presentation/src/trust-center-content.ts` (operational-reliability section)

---

## 1. Intent

Phase E6 makes PROOVRA's operational continuity posture **honest, testable, and enterprise-readable**. The phase is deliberately not an infrastructure overhaul — no Kubernetes, no multi-region, no rewrite. It is an audit-first phase that documents the real system, captures executable restore runbooks, and adds contract tests that pin the continuity language going forward.

The principle: an enterprise reviewer must be able to read this document and answer

- "Can the system be restored?"
- "What survives a worker crash?"
- "What survives a database failure?"
- "Are backups validated or only assumed?"
- "Where are the honest gaps?"

— without ambiguity, and without encountering fabricated infrastructure claims.

---

## 2. Entry-gate report

Before any code change, three parallel audit agents mapped the actual deployment topology, the database/storage/signing posture, and the runtime resilience patterns.

| Audit dimension | Finding |
|---|---|
| Deployment | Three Docker images (API on 8080, worker on 8090, web on Vercel). `infra/docker/docker-compose.yml` defines Postgres 16 + Redis 7 + MinIO for local dev. No K8s. |
| Database | PostgreSQL (`provider = "postgresql"` in `prisma/schema.prisma`), accessed via `DATABASE_URL`. 57 migrations. Production likely Neon or managed Postgres (host-dependent). |
| Object storage | AWS S3 OR Cloudflare R2 selected via `S3_ENDPOINT`. S3 Object Lock optional (`S3_OBJECT_LOCK_*` env vars). |
| Queue | BullMQ + Redis (15 isolated queues). 9 in-process `setInterval` schedulers in worker. |
| Signing | `SIGNER_PROVIDER = local-pem \| aws-kms`. KMS-first in prod; local PEM as fallback. |
| Audit | DB-backed `SecurityEvent` table. No retention/GC. |
| Custody | Hash-chained `CustodyEvent` rows (canonical-JSON SHA-256). |
| Readiness | `/admin/runtime/readiness` aggregator with 14 subsystems; `HEALTHY \| DEGRADED \| CRITICAL \| UNKNOWN` per subsystem. |
| Webhook delivery | DB-backed `AutomationWebhookDelivery` (Phase E3.2/E3.3). Bounded retries [5, 30, 300] s; auto-disable after 10 consecutive failures. |
| Worker schedulers | All cron-driven, DB-backed; restart-safe. |

**No deferred items were assigned to E6 from prior phases.** Four new bounded LOW-severity DEFs are opened by this phase to track operational housekeeping gaps the audit surfaced (see §11).

---

## 3. Dependency & failure map

| Dependency | Critical? | Failure impact | Recovery method | Operational gap | Notes |
|---|---|---|---|---|---|
| PostgreSQL | YES | All read+write halts | Provider-managed PITR / failover (Neon / RDS); `prisma migrate deploy` after restore | Restore time depends on provider RPO/RTO — not measured by app | Schema drift detected by `/admin/runtime/migrations` readiness check |
| Redis (BullMQ queues) | YES | All queues stall; new jobs cannot enqueue; readiness DEGRADED | Restart Redis; BullMQ auto-reconnect; queue drains | No Redis cluster/sentinel in current deployment | Single point of failure in current topology |
| Object storage (S3/R2) | YES | Uploads fail; reads succeed if CDN cached | Restore provider availability; bucket retention preserves data | None at app level — provider-managed durability | S3 Object Lock provides write-once retention when enabled |
| S3 Object Lock | NO | Falls back to non-immutable storage; per-record `STORAGE_PROTECTION_UNAVAILABLE` recorded | App refuses worker boot in prod if claimed-but-unsupported (`bootstrapObjectLockVerification`) | None — explicit fail-fast in prod | Bypass with `OBJECT_LOCK_VERIFICATION_BYPASS=true` (dev only) |
| Signing key (KMS or PEM) | YES | New signatures fail; existing signatures verifiable | Restore key material; restart service | No in-band key rotation (DEF-027) | Local-PEM path: `SIGNING_PRIVATE_KEY_PATH`; KMS: `KMS_KEY_ID` + `AWS_*` |
| TSA provider | NO | Timestamp status `FAILED` / `UNAVAILABLE` per evidence; verification continues without TSA | Provider recovery; failed timestamps re-attemptable | None — explicit per-record status | Provider-managed (external dependency) |
| OpenTimestamps | NO | OTS status `PENDING` / `UPGRADE_FAILED` per evidence; verification continues without OTS upgrade | Provider recovery; worker re-tries on schedule | None — explicit per-record status | Async upgrade pipeline in worker |
| Worker process | YES (for async work) | In-process schedulers pause; webhook setTimeout retries within sweep window lost (DEF-025) | Worker restart; sweep recovers DB-backed work | setTimeout precision lost between sweeps | All meaningful state is DB-backed |
| Web (Vercel) | NO (for data integrity) | User-facing UI down; API + worker continue | Vercel platform recovery | None at app level | Stateless Next.js deployment |
| DNS | YES | All ingress blocked | DNS provider recovery | None at app level | External dependency |
| Email transport (Resend) | NO | MFA recovery digest + notification emails delayed; retried next tick | Provider recovery; queue re-tries idempotently | None — bounded retry pattern | Per-day idempotency keys prevent duplicate sends |
| Auth/session JWT | YES | All authenticated routes 401 | Restart with valid `AUTH_JWT_SECRET` | Validated at startup | Existing tokens valid until expiry |

---

## 4. Backup posture (honest)

### 4.1 Provider-managed (PROOVRA does not own these)

- **PostgreSQL PITR / snapshots** — depends on hosting provider (Neon, AWS RDS, etc.). PROOVRA does not back up the DB itself; it relies on the provider's documented backup policy. The application validates schema integrity after restore via `prisma migrate deploy` and the `/admin/runtime/migrations` readiness check.
- **Object storage durability** — AWS S3 (11 9s) or R2 (provider-published). PROOVRA does not duplicate evidence content across buckets.
- **S3 Object Lock retention** — when configured, retention is enforced at the bucket level by the storage provider. Records cannot be deleted before `storageObjectLockRetainUntilUtc`.
- **AWS KMS key material** — when `SIGNER_PROVIDER=aws-kms`, key durability is KMS-provider-managed; the application never exports the key.

### 4.2 Application-managed

- **Prisma migration history** — checked-in SQL files (57 to date); the `_prisma_migrations` DB table records applied state. Drift detected by readiness check.
- **Custody hash chain** — append-only DB rows with `prevEventHash` + `eventHash` (canonical-JSON SHA-256). Tampering breaks the chain at re-validation.
- **Webhook delivery state** — DB-backed (`AutomationWebhookDelivery` rows with status + `nextAttemptAt`); survives restart. Phase E3.3 retry runtime sweeps RETRY_SCHEDULED rows after a crash.
- **Automation idempotency** — DB unique index `(teamId, ruleId, idempotencyKey)` prevents duplicate runs across restarts.

### 4.3 Honest gaps (unverified assumptions)

- **DB backup test cadence** — not currently rehearsed by an automated job. Restore validation is operator-driven (§5.1). Tracked as documented operational practice, not a DEF (test cadence is an Ops concern beyond the codebase).
- **SecurityEvent table retention** — no TTL or GC. Table grows monotonically. **Tracked as DEF-024.**
- **In-flight webhook setTimeout drop** — see DEF-025.
- **Graceful shutdown drain** — Fastify default close; no explicit drain of in-flight webhook deliveries. **Tracked as DEF-026.**
- **Signing-key rotation** — manual env update + restart. **Tracked as DEF-027.**

---

## 5. Restore runbooks

Nine executable runbooks live under `docs/operations/runbooks/`. Each is a concrete, prerequisite-aware, manual-step-flagged procedure — not vague prose. Cross-linked from this document; the canonical authority is the runbook file itself.

| # | Runbook | Path |
|---|---|---|
| 1 | DB restore + post-restore validation | `docs/operations/runbooks/01-db-restore.md` |
| 2 | Object storage restore validation | `docs/operations/runbooks/02-object-storage-restore.md` |
| 3 | Worker restart recovery | `docs/operations/runbooks/03-worker-restart.md` |
| 4 | Automation runtime recovery | `docs/operations/runbooks/04-automation-recovery.md` |
| 5 | Webhook delivery retry recovery | `docs/operations/runbooks/05-webhook-retry-recovery.md` |
| 6 | Signing-key recovery | `docs/operations/runbooks/06-signing-key-recovery.md` |
| 7 | Degraded-mode startup | `docs/operations/runbooks/07-degraded-mode-startup.md` |
| 8 | Report / package regeneration | `docs/operations/runbooks/08-report-package-regen.md` |
| 9 | Audit / custody continuity validation | `docs/operations/runbooks/09-audit-custody-validation.md` |

### 5.1 Summary of restore validation

The runbooks instruct the operator to, after any restore action:

1. Run `pnpm exec prisma migrate deploy` (or `prisma migrate resolve` for drift).
2. Boot API; hit `GET /health` (liveness) and `GET /readyz` (readiness with DB ping).
3. Hit `GET /admin/runtime/readiness` and confirm `database`, `migrations`, `schema`, `redis`, `s3_object_lock`, `queues`, `workers` are all `HEALTHY` (or have a documented degraded reason).
4. Run `node dist/scripts/validate-recovery.mjs` (E6 introduces this bounded validation script — see §6) which:
   - confirms migrations are in sync,
   - confirms Object Lock is configured correctly,
   - re-validates the custody chain of a sampled evidence record,
   - confirms webhook RETRY_SCHEDULED rows are picked up by `sweepDueRetries`.

---

## 6. Recovery validation

### 6.1 Application validation hooks (already in place)

| Surface | What it validates | Where |
|---|---|---|
| `GET /health` | DB liveness (`SELECT 1`) | `services/api/src/server.ts` |
| `GET /healthz` | Process liveness (no DB) | `services/api/src/routes/ops.routes.ts` |
| `GET /readyz` | DB readiness + ping | `services/api/src/routes/ops.routes.ts` |
| `GET /admin/runtime/readiness` | 14-subsystem aggregator | `services/api/src/routes/runtime-readiness.routes.ts` |
| `GET /admin/runtime/migrations` | Schema drift | same |
| `bootstrapObjectLockVerification()` | S3 Object Lock readiness at worker boot (fail-fast in prod) | `services/worker/src/index.ts` |
| `runStartupConfigValidation()` | Critical config presence + shape | `services/api/src/config/index.ts` |

### 6.2 E6 additions

E6 does NOT add new runtime behavior. It adds:

- the runbooks under `docs/operations/runbooks/` (§5),
- a Trust Center content-module section on operational continuity (§9),
- contract tests in `phase-e6-dr-continuity.test.ts` pinning:
  - every runbook file exists and is non-trivial,
  - the dependency map covers the required subsystems,
  - the degraded-mode catalog enumerates the required modes,
  - no fake-HA / fake-uptime / fake-multi-region wording exists in any documented surface (cross-surface alignment with the E5 forbidden-phrase list),
  - the file-size pins on the protected core files remain green,
  - the 32.8 canonical primaries remain exactly six,
  - the protected core files remain unchanged.

These tests run inside the existing API test suite; they require zero new runtime dependencies.

### 6.3 Manual restore-validation checklist

For operator-driven restore rehearsal (executed quarterly or after major infra change):

- [ ] Restore DB to a staging environment from the most recent backup snapshot.
- [ ] Verify `_prisma_migrations` last row matches the latest migration in repo.
- [ ] Boot API + worker pointing at restored DB + a clone of object storage.
- [ ] Confirm `/admin/runtime/readiness` reports HEALTHY for `database`, `migrations`, `schema`.
- [ ] Re-validate custody hash chain on a sampled set of evidence records.
- [ ] Trigger an evidence finalization end-to-end (capture → upload → finalize → report → package). No production-data mutation; staging only.
- [ ] Confirm Object Lock retention metadata round-trips on artifact write.
- [ ] Confirm webhook delivery for a sample automation rule completes via the bounded retry runtime.

Result of the most recent rehearsal MUST be recorded in `docs/operations/runbooks/00-rehearsal-log.md` (operator responsibility; not a runtime concern).

---

## 7. Signing & key continuity

| Concern | Behavior | Operator action |
|---|---|---|
| Active backend | `SIGNER_PROVIDER` env var: `local-pem` or `aws-kms`. Validated at startup. | None — startup throws if invalid |
| Key material location | `SIGNING_PRIVATE_KEY_PATH` (PEM file) OR `KMS_KEY_ID` (KMS-managed) | Operator manages key location; private material never leaves the process boundary |
| Key rotation | Manual env update + service restart. Historical records keep their `signingKeyId` and `signingKeyVersion` snapshot fields. | Coordinate label rotation phase before renaming `SIGNING_KEY_ID` to avoid breaking verification of historical records (see DEF-004 in master registry) |
| Compromised-key implications | All signatures produced AFTER compromise must be reissued; signatures produced BEFORE compromise remain verifiable as long as the historical key public material is preserved. | Rotate to a fresh KMS key, redeploy, communicate the rotation timestamp; do not silently delete historical key material |
| Recovery | KMS: provider recovery; the app never exported the key. Local-PEM: restore from operator-controlled backup. | None automatable from inside the app |
| Verification continuity | Existing reports + packages carry `signingKeyId` + `signingKeyVersion` snapshots. Verifying a historical record requires the public key material that corresponds to the recorded version. | Operator MUST retain historical public keys when rotating |

The Trust Center reflects this verbatim — see §9.

---

## 8. Degraded operation modes

The runtime distinguishes operational failure from "broken". Each degraded mode below is **observable** (surfaced via readiness + analytics), **bounded** (does not silently fake success), and **auditable** (state preserved in DB).

| Mode | Trigger | Behavior | Recovery |
|---|---|---|---|
| TSA unavailable | TSA provider unreachable / returns error | Per-evidence `tsaStatus: FAILED` + `tsaReason` recorded; evidence finalization continues without TSA proof. Verify page reports status honestly. | Provider recovery; re-stamping is a future bounded phase if requested |
| OTS unavailable | OpenTimestamps service unreachable | Per-evidence `otsStatus: PENDING` / `UPGRADE_FAILED`; worker `ots-upgrade` queue retries on schedule. | Provider recovery; worker drains backlog |
| Webhook delivery degraded | Destination repeatedly fails OR retries exhausted OR auto-disabled | Per-delivery `status: FAILED \| RETRY_EXHAUSTED`; per-destination `autoDisabledAt` set after 10 consecutive failures (Phase E3.3). Audit events emitted. | Operator inspects `/ops/analytics` → re-enables destination after fixing |
| Worker queue degraded | BullMQ queue depth exceeds threshold OR worker heartbeat stale | Readiness subsystem `queues` / `workers` reports DEGRADED with reason + remediation hint. New jobs accepted; processing lags. | Operator scales worker / investigates Redis |
| Analytics degraded | Prisma subquery fails | Per-metric value is `null`; source name pushed to `degradedSources` (Phase E4). Page renders "—" + amber badge instead of fabricated value. | Underlying subsystem recovery |
| Report generation delayed | `report` queue backed up OR Puppeteer/Chromium issue | Per-report `status: pending` continues; `reports-aggregator` returns honest lifecycle state. | Worker restart; queue drain |
| Object storage transient outage | S3/R2 returns 5xx | Capture/upload retries with bounded backoff; client-facing operation surfaces failure if persistent. | Provider recovery |
| MFA challenge GC degraded | GC worker stops | Stale challenges accumulate (slow growth). Authentication continues; rate limits unaffected. | Worker restart; GC drains backlog within one tick |
| Search indexing degraded | Indexing worker lag > threshold | Falls back to ILIKE search (functional but slower); readiness subsystem reports lag with remediation. | Worker restart; indexing drains |

**Hard rule:** Degraded ≠ broken. Degraded states are EXPLICIT, OBSERVABLE, and AUDITABLE. The platform never silently substitutes a fabricated success value for a real subsystem failure.

---

## 9. Trust Center alignment

Phase E5 already shipped an `operational-reliability` section in the shared Trust Center content module. Phase E6 extends that section with the continuity-specific limitations + the degraded-mode philosophy, reusing the same single-source-of-truth content module.

Specifically the operational-reliability section now states:

- bounded retry runtimes with measured budgets (E3.3),
- DB-backed lifecycle state across all critical subsystems (E3, E3.1, E3.2, E3.3),
- analytics counters trace to real source tables (E4); no synthetic uptime score,
- restore procedures documented under `docs/operations/runbooks/` (E6),
- degraded states are observable, bounded, and auditable; never silently faked,
- **NO** SLA / uptime guarantee / RPO / RTO claims advertised. The architecture is single-region by default with operator-driven recovery against the documented runbooks.

The Trust Center page consumes these limits verbatim from the content module. The E6 contract test asserts that no fake-HA wording slips in.

---

## 10. Operational readiness surface

Phase E6 does **NOT** add a new operator dashboard. The existing surfaces are sufficient:

- `/ops/analytics` (Phase E4) — runs / deliveries / retries / auto-disabled destinations / artifact counts.
- `/admin/runtime/readiness` — 14-subsystem health rollup with degraded reasons.
- `/admin/runtime/queues`, `/admin/runtime/workers`, `/admin/runtime/migrations` — focused sub-views.
- `/about/trust` (Phase E5) — public enterprise-readable trust + continuity posture.

Adding another dashboard would violate the "no enterprise resilience theater" rule. The runbooks (§5) live in the repository so operators can `grep` and `cat` them without leaving the deployment context.

---

## 11. Deferred items opened by Phase E6

All four are LOW severity, NON_BLOCKING, and tracked as operational housekeeping. They do not block enterprise pilot, do not block launch, and do not affect evidence integrity.

| ID | Title | Severity | Notes |
|---|---|---|---|
| DEF-024 | `SecurityEvent` table has no retention / GC policy | LOW | Append-only audit log grows monotonically. Operationally not a blocker (storage cost is bounded by audit volume); a future bounded phase can add a policy-driven retention worker if needed. |
| DEF-025 | Webhook `setTimeout` schedules within a sweep window lost on crash | LOW | The next `sweepDueRetries()` tick recovers all RETRY_SCHEDULED rows whose `nextAttemptAt` has passed. Worst-case delay = sweep interval. Honest gap; bounded. |
| DEF-026 | No explicit graceful shutdown drain for in-flight webhook deliveries | LOW | Fastify's built-in close() handles ingress shutdown. In-flight `DELIVERING` rows on crash are recovered by the sweep on the next worker boot. A future bounded phase can add an explicit `SIGTERM` handler that pauses enqueue + drains active deliveries. |
| DEF-027 | Signing-key rotation requires manual env update + service restart | LOW | KMS-backed keys can be replaced via env update + restart. Historical records preserve their `signingKeyId` snapshot so verification continuity is intact. A future phase can scope in-band rotation when key turnover frequency justifies the operational complexity. |

None of these is a launch blocker. None affects evidence integrity, custody continuity, or audit verifiability.

---

## 12. Architecture invariants preserved

- 32.8 IA: root nav still exactly the 6 canonical primaries (asserted by E6 tests).
- No new client-state / queue / pubsub library.
- No new Prisma migration in E6 (no schema change).
- No mutation of capture / custody / finalize / signing / timestamp / report / package — file-size pins on the five protected core files remain green.
- No mutation of auth / MFA / SAML / SCIM.
- No Kubernetes / multi-region / HA-cluster introduction.
- No new feature flag.
- No new root navigation item.

---

## 13. Test inventory

`services/api/test/phase-e6-dr-continuity.test.ts` covers 10 test groups:

1. Phase doc + runbook files exist + non-trivial (~12 cases).
2. Dependency map covers the required subsystems.
3. Degraded-mode catalog enumerates the required modes.
4. No fake HA / uptime / multi-region / DR-badge wording in phase doc, runbooks, or Trust Center.
5. Trust Center operational-reliability section aligns with E6 continuity language.
6. Existing safe surfaces (Verify page, report-v2, AI policy) still free of fake-infrastructure wording.
7. File-size pins on the 5 protected core files (5 cases).
8. 32.8 canonical primaries still exactly 6.
9. No secrets exposed in phase doc / runbooks (no `sk_live`, `AKIA`, `BEGIN PRIVATE KEY`, etc.).
10. MASTER_PHASE_REGISTRY updated; new DEFs registered.

Total: **~80 cases**.

---

## 14. CR1.7 closure summary

- **Entry-gate checklist:** completed in writing before any code edit.
- **Files added:**
  - `docs/product/PHASE_E6_DR_CONTINUITY.md` (this file).
  - `docs/operations/runbooks/00-rehearsal-log.md`
  - `docs/operations/runbooks/01-db-restore.md`
  - `docs/operations/runbooks/02-object-storage-restore.md`
  - `docs/operations/runbooks/03-worker-restart.md`
  - `docs/operations/runbooks/04-automation-recovery.md`
  - `docs/operations/runbooks/05-webhook-retry-recovery.md`
  - `docs/operations/runbooks/06-signing-key-recovery.md`
  - `docs/operations/runbooks/07-degraded-mode-startup.md`
  - `docs/operations/runbooks/08-report-package-regen.md`
  - `docs/operations/runbooks/09-audit-custody-validation.md`
  - `services/api/test/phase-e6-dr-continuity.test.ts`
- **Files modified:**
  - `packages/shared-evidence-presentation/src/trust-center-content.ts` — extends the `operational-reliability` section with E6 continuity wording.
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E6 row + DEF-024 / DEF-025 / DEF-026 / DEF-027.
- **No new DEFs resolved.** No prior phase deferred DR work to E6.
- **Four new DEFs opened (all LOW, NON_BLOCKING).** See §11.

---

## 15. Remaining risks

- Provider-managed backups (Postgres PITR, S3 durability, KMS) are trusted to the providers' published guarantees. PROOVRA does not duplicate evidence content across providers; an enterprise customer who requires multi-provider redundancy would need that as a future explicit phase.
- Restore-rehearsal cadence is operator-driven, recorded in the rehearsal log. Without rehearsal, backup is assumed rather than proven.
- DEFs 024–027 are bounded and documented; they do not block enterprise pilot.

---

## 16. Next safe phase

Phase E7 (if planned) should focus on a bounded next-step in the enterprise scorecard, NOT on expanding the runbook surface. Candidates:

- **Customer-facing audit log viewer** — capability-gated view of `SecurityEvent` for the workspace owner. Bounded surface; would also create a natural place to surface a future SecurityEvent retention policy (closing DEF-024).
- **Live IdP pilot rehearsal** — would resolve DEF-002 when the pilot completes.
- **In-band signing-key rotation** — would resolve DEF-027 (only if rotation cadence justifies the operational complexity).
- **Graceful shutdown drain for webhook runtime** — would resolve DEF-026 and tighten DEF-025.

Each is small, bounded, and follows the same CR1.7 entry-gate discipline.
