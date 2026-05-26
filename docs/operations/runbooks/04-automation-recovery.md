# Runbook 04 — Automation runtime recovery

**Scope:** confirm that the Phase E3 / E3.1 automation runtime (rule registry + dispatcher + bounded action handlers) recovers correctly after a process crash, a misconfiguration, or a stuck run.

**Prerequisites:**

- Capability `AUTOMATION_VIEW` on the affected workspace (or platform admin).
- Read access to the API + DB.

**Forbidden:**

- Manually mutating `AutomationRun` row status to "fix" a stuck run. The idempotency model assumes the runtime is the only writer.
- Re-enabling a destination that was auto-disabled (after 10 consecutive failures) without first identifying and fixing the root cause.

---

## What survives an automation runtime crash

| Subsystem | Survives? | Recovery |
|---|---|---|
| `AutomationRule` rows | YES | DB-backed |
| `AutomationRun` row + status | YES | DB-backed; unique index `(teamId, ruleId, idempotencyKey)` prevents duplicate creates |
| In-flight action handler state | NO | Synchronous in-process; a crash mid-handler leaves the run in `RUNNING` state |
| Webhook delivery queued by an action handler | YES (DB hand-off; see runbook 05) | Picked up by `sweepDueRetries()` |

## Steps

1. **Identify the stuck or failed runs.**
   - `GET /v1/automation/runs?teamId=<id>&status=RUNNING` — list runs stuck in `RUNNING`.
   - `GET /v1/automation/runs?teamId=<id>&status=FAILED` — list recent failures.
   - For each stuck `RUNNING` run, capture: rule id, trigger type, target id, idempotencyKey, started timestamp.

2. **Confirm dispatcher is still functioning.**
   - Fire a synthetic trigger via the test harness OR observe that fresh `automation_rule_evaluated` security events are landing in the security event stream.
   - If no fresh events: dispatcher itself is degraded. Investigate worker boot + DB connectivity before proceeding.

3. **Handle stuck `RUNNING` runs.**
   - The runtime does NOT automatically reap stuck runs. By design, the next fresh trigger with the same idempotencyKey would be blocked by the unique index.
   - To recover, operator action is needed:
     - Confirm the run is genuinely stuck (started > 10 min ago, no progress).
     - Use the platform admin runbook to mark the run as FAILED with a documented reason (`stuck_after_crash`). This MUST be an audited operation.
     - Subsequent triggers will then create a fresh run row with a new idempotencyKey context.

4. **Handle auto-disabled destinations (Phase E3.3).**
   - `GET /v1/automation/destinations?teamId=<id>` — destinations with `autoDisabledAt != null`.
   - Inspect the most recent associated `AutomationWebhookDelivery` rows to identify the failure mode (404? SSRF block? non-2xx loop?).
   - Fix the receiving endpoint or the destination URL.
   - Re-enable via the admin destination API. The runtime resets `consecutiveFailureCount` on the next successful delivery.

5. **Confirm recovery.**
   - Trigger a synthetic event that matches the recovered rule.
   - Confirm a fresh `AutomationRun` lands.
   - Confirm any associated `AutomationWebhookDelivery` reaches `SUCCEEDED`.

---

## Failure modes

- **All automation runs stuck in `RUNNING` after crash** → dispatcher is no longer firing. Restart the API process; the dispatcher re-arms on boot.
- **Destination keeps auto-disabling** → the destination's URL or auth shape is wrong. Re-check the receiver; do not loop re-enable.
- **`AutomationRun` row missing for a trigger that should have matched** → the trigger event was emitted before the rule was enabled, OR the condition evaluator returned false. Verify the rule's `enabled=true` and the `conditionJson` matches the trigger payload shape.

---

## Honest gaps

- Stuck-run reaping is operator-driven; the runtime does not currently sweep stale `RUNNING` rows. A future bounded phase could add a watchdog if the operational data warrants it.
