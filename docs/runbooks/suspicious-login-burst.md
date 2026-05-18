# Runbook — Suspicious login burst

**Incident slug**: `suspicious-login-burst` · **Category**: `IDENTITY_SECURITY` · **Default severity**: `HIGH`

## Symptoms
- Phase 19 SecurityEvents: `suspicious_login_detected`, `impossible_travel_signal`, `service_account_risk_detected`, `contributor_risk_detected`, `high_risk_action_blocked`, `step_up_denied` rising.
- `risk_signals` table shows recent rows for the affected subject (`subjectUserId` / `subjectApiCredentialId` / `subjectIntakeSessionId`).
- /security-center UI shows elevated risk score for the actor.

## Dashboards / metrics
- `/v1/ops/metrics` → `step_up_denied`, `high_risk_action_blocked`, `verification_check_failed`.
- /security-center → risk snapshot for the actor.

## Safe commands / routes
1. List operator risk snapshot: `GET /v1/identity-security/risk/user/:id?teamId=...` (requires `identity.access_review.action`).
2. Revoke a single suspicious session: `POST /v1/identity-security/sessions/revoke`.
3. Revoke all sessions for the actor: `POST /v1/identity-security/sessions/revoke-all`.
4. Tighten MFA policy: `PUT /v1/identity-security/mfa-policy` (sensitive — requires step-up).
5. Revoke a trusted device: `POST /v1/identity-security/devices/:id/revoke`.

## What NOT to do
- **Do not** delete the actor's `User` row. Suspend or revoke the membership instead (Phase 17 + 19); deletion drops audit chain.
- **Do not** disable `IDENTITY_SECURITY_ENABLED` in prod — that turns step-up + risk evaluation off.
- **Do not** mass-clear `risk_signals`. They auto-expire by TTL; manual clearing hides operator history.

## Rollback / retry guidance
- If the burst is a known operator IP change (relocation / VPN), mark the new device trusted (Phase 19 `POST /v1/identity-security/devices/trust`) and the noise subsides.
- If it's a compromise (Phase 19 wording: "suspected unauthorised access"), revoke all sessions + change the affected user's password out-of-band.

## Escalation
- Multiple actors triggering at the same time → page on-call. Could indicate a credential-stuffing attempt.
