# Runbook 05 — Webhook delivery retry recovery

**Scope:** confirm that the Phase E3.2 / E3.3 webhook delivery runtime recovers correctly after a process crash, including in-flight `setTimeout` schedules that were lost.

**Prerequisites:**

- Capability `AUTOMATION_VIEW`.
- Read access to `AutomationWebhookDelivery` table via the admin API.

**Forbidden:**

- Disabling SSRF protection.
- Increasing the retry cap above `WEBHOOK_MAX_TOTAL_ATTEMPTS = 4` or extending the backoff schedule beyond `[5, 30, 300] s`. These bounds are pinned by the Phase E3.3 contract tests.
- Manually re-sending a delivery that the runtime has already marked `RETRY_EXHAUSTED`. Re-sending requires creating a fresh `AutomationRun` via the standard trigger path.

---

## What survives a crash

| State | Survives? | Recovery |
|---|---|---|
| `AutomationWebhookDelivery` rows | YES | DB-backed |
| Delivery status enum + `nextAttemptAt` column | YES | DB-backed |
| `consecutiveFailureCount` on destination | YES | DB-backed |
| In-flight `DELIVERING` rows mid-HTTP-call | NO | Recovered as `FAILED` reason `crash_during_delivery` by the next sweep tick; counted as a regular failure |
| `setTimeout` retry schedules within a sweep window | NO (DEF-025) | Next `sweepDueRetries()` tick picks up RETRY_SCHEDULED rows whose `nextAttemptAt` has passed |

## Steps

1. **Confirm sweep is running.**
   - `GET /admin/runtime/workers` — confirm worker heartbeat is fresh.
   - The sweep tick fires on a cron interval (`WEBHOOK_SWEEP_INTERVAL_MS`, default ~30 s). In the DB, observe that `AutomationWebhookDelivery` rows with `status=RETRY_SCHEDULED AND nextAttemptAt < now()` are being claimed by `updateMany()` atomic claim.

2. **Identify rows stuck in `DELIVERING`.**
   - These represent crashed in-flight deliveries. The runtime does NOT auto-reap; operator action OR the next code-side change can transition them.
   - For each stuck row, document the destination + run context. Decide:
     - If safe to retry: transition to `RETRY_SCHEDULED` with a fresh `nextAttemptAt` (operator action; must be audited).
     - If not safe: transition to `FAILED` with reason `manual_intervention_after_crash`.

3. **Inspect auto-disabled destinations.**
   - `GET /v1/automation/destinations?teamId=<id>` — find rows with `autoDisabledAt != null`.
   - Read the `disabledReason`. Common values:
     - `consecutive_failures_threshold` — destination repeatedly returned non-2xx or timed out.
     - `dns_revalidation_failed` — DNS rebinding suspected at delivery time.
     - `payload_too_large` — receiver enforces a smaller payload than the 32 KiB cap.

4. **Re-enable destination AFTER root cause fixed.**
   - Re-enable via admin destination API.
   - Trigger a synthetic delivery; confirm it reaches `SUCCEEDED`.
   - The runtime resets `consecutiveFailureCount` on the first success.

5. **Confirm retry cadence is bounded.**
   - For a fresh failing delivery, confirm the runtime schedules retries at `+5 s`, `+30 s`, `+300 s` (Phase E3.3 contract).
   - After attempt 4 fails, the row transitions to `RETRY_EXHAUSTED`. No further automatic retries.
   - Total wall-clock from first attempt to exhaustion ≤ 335 s.

---

## Failure modes

- **All deliveries staying in `RETRY_SCHEDULED` forever** → sweep is not running. Check worker heartbeat + queue health.
- **Destination immediately auto-disables on first failure** → the runtime's `consecutiveFailureCount` accounting is wrong; this would be a bug. Audit `automation-delivery-runtime.service.ts` and the per-delivery audit events.
- **`DELIVERING` rows accumulating** → the runtime claim is not transitioning. Check Redis connectivity (BullMQ queue health) + DB write capacity.

---

## Honest gaps

- DEF-025: setTimeout retries within a sweep window are lost on crash. Worst case the row sits as `RETRY_SCHEDULED` and is picked up by the next sweep — delay ≤ sweep interval (~30 s).
- DEF-026: no application-level graceful drain. Active `DELIVERING` rows at SIGTERM time become stuck (recovered per step 2 above).
