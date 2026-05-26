# Runbook 07 — Degraded-mode startup

**Scope:** boot the platform when one or more optional subsystems are unavailable (TSA / OTS provider down, search indexer behind, MFA challenge GC paused, etc.), without faking success.

**Prerequisites:**

- Read access to `/admin/runtime/readiness`.
- Operator knowledge of which env vars feature-gate each subsystem.

**Forbidden:**

- Setting `OBJECT_LOCK_VERIFICATION_BYPASS=true` in production. Object Lock misconfiguration is fail-fast in prod by design.
- Removing critical env vars (`DATABASE_URL`, `AUTH_JWT_SECRET`, `SIGNER_PROVIDER`-required vars) to "make the app boot". `runStartupConfigValidation()` is a safety net.
- Faking a `HEALTHY` rollup by silencing the readiness check.

---

## Subsystem feature flags

| Subsystem | Feature-gated by | If disabled |
|---|---|---|
| TSA timestamping | `TSA_ENABLED=true` + `TSA_URL` set | Per-evidence `tsaStatus: UNAVAILABLE` |
| OpenTimestamps | (always attempted if `opentimestamps-client` present in worker) | Per-evidence `otsStatus: PENDING` |
| S3 Object Lock | `S3_OBJECT_LOCK_ENABLED=true` + bucket-side config | Falls back to non-immutable storage in dev only; fail-fast in prod |
| Metrics scraping | `METRICS_SCRAPE_TOKEN` set | Endpoint open OR disabled, depending on config |
| Sentry | `SENTRY_DSN` set | Exception capture is no-op |
| MFA challenge GC | `MFA_CHALLENGE_GC_INTERVAL_MIN` set | Worker schedule paused; stale rows accumulate |
| Recovery digest | `MFA_RECOVERY_DIGEST_*` env vars set | Digest emails not sent |
| Search indexing | (always on if worker running) | Lag rises; fallback to ILIKE |
| Webhook delivery | (always on if worker + Redis up) | New deliveries enqueued but not processed if worker down |

---

## Steps

Bounded degraded-mode boot procedure:

1. **Identify the degraded subsystems.**
   - Hit `GET /admin/runtime/readiness`.
   - For each subsystem with status `DEGRADED` or `CRITICAL`, capture: subsystem name, reason code, remediation hint.

2. **Confirm `CRITICAL` rollup is acceptable to operate.**
   - `schema CRITICAL` means a Prisma migration is unapplied OR rolled back. Do NOT continue; apply runbook 01.
   - `database CRITICAL` means DB unreachable. Do NOT continue; apply runbook 01.
   - All other subsystems can tolerate `DEGRADED` for bounded periods.

3. **Confirm degraded subsystems will not silently fake success.**
   - TSA degraded: per-evidence `tsaStatus` will be `FAILED` or `UNAVAILABLE`. Verify page will report honestly. OK to operate.
   - OTS degraded: per-evidence `otsStatus` will be `PENDING` or `UPGRADE_FAILED`. Verify page will report honestly. OK to operate.
   - Webhook delivery degraded: deliveries will queue with `RETRY_SCHEDULED` status. After Phase E3.3 retries are exhausted, status becomes `RETRY_EXHAUSTED` — auditable. OK to operate.
   - Analytics degraded: per-metric `value: null` + amber badge on `/ops/analytics`. OK to operate.

4. **Document the degraded boot in the Ops log.**
   - Date, environment, list of degraded subsystems, expected restoration window.

5. **Monitor for restoration.**
   - Re-hit `/admin/runtime/readiness` periodically.
   - When the subsystem returns to `HEALTHY`, the runtime resumes normal behaviour automatically — no manual restart required for any subsystem in the table above.

---

## What "degraded" must guarantee

- **Observable** — readiness rollup surfaces it.
- **Bounded** — degradation is per-subsystem; one subsystem down does NOT propagate failure to unrelated subsystems.
- **Auditable** — every per-evidence record carries an explicit status field (`tsaStatus`, `otsStatus`, etc.). No subsystem silently substitutes a fabricated success value.
- **Reversible** — once the subsystem recovers, the runtime resumes without operator intervention.

A degraded mode that violates any of these properties is a bug, not a feature.

---

## Honest gaps

- The platform does not provide a "soft pause" mode for the automation queue. If a destination is misconfigured during a degraded period, deliveries continue to be attempted (and exhaust their retries).
- There is no automatic "recover and re-stamp" pipeline for evidence whose TSA was unavailable at finalize time. A future bounded phase can scope re-stamping if operationally needed.
