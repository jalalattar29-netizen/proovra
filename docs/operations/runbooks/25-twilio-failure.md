# Runbook 25 — Twilio (SMS) provider failure

## Symptoms
- Customers report not receiving SMS verification codes.
- `verification.service.ts` returns `provider_unavailable` for SMS factor flows.
- Twilio status page declares an incident.

## Blast radius
SMS-only. Affects:
- Phone-number verification during onboarding.
- SMS-based MFA (if configured by the customer's org).
- Operator-driven SMS notifications.

**TOTP MFA, password-based auth, SAML SSO are all unaffected.**

## Detection
- Twilio status page: `https://status.twilio.com`.
- API logs: `sendViaTwilio` exceptions.
- Customer-support tickets reporting SMS verification timeouts.

## Logs to inspect
- API logs: `services/api/src/services/communications/twilio-provider.ts` per send attempt.
- Twilio dashboard message log.

## Rollback procedure
None — SMS is synchronous; there is no queue layer to roll back.

## Safe recovery procedure
1. **Confirm with Twilio status page.** If a Twilio incident: post customer communication.
2. **Confirm the platform's `TWILIO_*` env vars are valid** (no expiry).
3. **For phone verification during onboarding**: customers can complete onboarding without SMS verification if their workspace permits TOTP-only MFA. Communicate this fallback.
4. **For SMS-based MFA**: customers who have ONLY SMS as their MFA factor are temporarily blocked. Their org admin can use the MFA recovery flow (runbook on the platform's existing recovery surface) to issue recovery codes.
5. **For operator-driven SMS notifications**: log them in the operator log and skip; do NOT spam-retry into a known-down provider.

## Validation steps
- `sendViaTwilio` returns success on a test SMS after Twilio recovers.
- A test phone verification flow completes end-to-end.
- A test SMS-based MFA challenge completes end-to-end.

## Escalation conditions
- Sustained outage > 4 hours → customer-wide notification.
- A named pilot customer has SMS-only MFA users → coordinate manual recovery flow.
- A customer has lost all factors including SMS → DEF-046 (POST_LAUNCH) tracks the lack of a documented OWNER break-glass; for now, escalate to incident response.

## DO NOT DO THIS
- Do NOT add a synchronous retry loop on `sendViaTwilio`. Twilio's own retries are sufficient; loop retries amplify cost without changing the outcome.
- Do NOT enable a "fallback to email" path silently. Customers expect SMS where they configured SMS; switching providers without their consent is a contract violation.
- Do NOT mute the audit emission. Failed sends are first-class audit events.
- Do NOT rotate the Twilio auth token during an outage. The token has nothing to do with the outage.
