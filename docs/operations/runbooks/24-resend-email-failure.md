# Runbook 24 — Resend (email) provider failure

## Symptoms
- Customers report not receiving emails (password reset, MFA recovery digest, reviewer assignment notifications, etc.).
- `NotificationDelivery` rows accumulate in `RETRY_SCHEDULED` status with no transitions.
- Sustained outage: `OperationalIncident` rows reference `notifications` family.

## Blast radius
All outbound email. Workflows that depend on email (password reset; MFA recovery; external reviewer invitations) become degraded. **In-product workflows are unaffected** (audit chain, custody, evidence integrity, automation — none depend on email).

## Detection
- Resend status: `https://status.resend.com`.
- `NotificationDelivery` query: `status='RETRY_SCHEDULED'` count rising sharply.
- API logs: `sendViaResend` exceptions.
- DEF-019 (POST_LAUNCH) tracks the gap that sustained-outage alerts are not yet automated.

## Logs to inspect
- API logs: `sendViaResend` per call.
- `NotificationDelivery.errorCode` + `NotificationDelivery.errorMessage` for the affected rows.
- Resend dashboard delivery log.

## Rollback procedure
None — email is best-effort. Failed sends accumulate in `NotificationDelivery` for the bounded retry runtime to pick up.

## Safe recovery procedure
1. **Confirm with Resend status page.** If a Resend incident: post customer communication acknowledging delayed emails. The bounded retry runtime continues attempting delivery.
2. **Confirm the platform's `RESEND_API_KEY` is valid.** Check the Resend dashboard for the key.
3. **Confirm `COMMUNICATIONS_ENABLED=true`** in production.
4. **For sustained outage**: consider switching to an operator-controlled alternative sender during the outage. **Do NOT bake in a fallback provider permanently** — that's a feature decision, not an incident response.
5. **For password-reset-specific outages**: communicate the workaround to affected customers (operator-assisted reset via a verified channel).
6. **For MFA recovery digest outage**: the digest is per-day idempotent. Resend's recovery will deliver the digest the same day OR the next day per the per-admin idempotency key.

## Validation steps
- `sendViaResend` returns success on a test email after the provider recovers.
- `NotificationDelivery` rows transition from `RETRY_SCHEDULED` → `SENT` for the affected window.
- A test password-reset request results in an email landing within 5 min.
- A test reviewer invitation results in an email landing within 5 min.

## Escalation conditions
- Sustained outage > 4 hours during business hours → customer-wide notification + incident response.
- A specific high-value customer (named enterprise pilot) reports a security-critical email (MFA reset) missing → incident response + manual fallback delivery.
- DEF-019 closure is being planned → wire the alert that this runbook depends on.

## DO NOT DO THIS
- Do NOT rotate `RESEND_API_KEY` during an outage. The key has nothing to do with the outage.
- Do NOT manually update `NotificationDelivery.status` to `SENT` to "clean up". The status is the audit of what the platform attempted.
- Do NOT bypass the bounded retry runtime. It exists to prevent storm-on-recovery.
- Do NOT add a temporary unlimited retry loop. Use the bounded runtime + the standard backoff.
- Do NOT change `COMMUNICATIONS_ENABLED` to `false` "to stop the noise". Doing so silently SKIPs all sends and customers lose access to important workflows.
