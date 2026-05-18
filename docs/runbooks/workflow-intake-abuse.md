# Runbook — Workflow intake abuse burst

**Incident slug**: `workflow-intake-abuse` · **Category**: `WORKER` (operational) · **Default severity**: `HIGH`

## Symptoms
- `/v1/ops/metrics` → `workflow_intake_abuse_total` counter rising.
- Phase 22 SecurityEvent `workflow_intake_abuse_detected` rows visible in the /security UI.
- Phase 18 SecurityEvent `communication_webhook_invalid_signature` rising (if abuse is hitting the intake endpoint via spoofed callbacks).
- Phase 19 risk signal `CONTRIBUTOR_TOKEN_FAILURE_BURST` on contributor sessions.

## Dashboards / metrics
- `/v1/ops/incidents?status=OPEN&category=WORKER` (or `WEBHOOK`).
- `/v1/ops/metrics` → counters `workflow_intake_abuse_total`, `contributor_risk_detected`.
- `/v1/identity-security/risk/user/:id?teamId=...` for any actor with elevated risk.

## Safe commands / routes
1. Revoke the abused intake link: `POST /v1/workflow/intake-links/:id/revoke` (Phase 4 — operator action).
2. Revoke the affected contributor session if it's already opened: `POST /v1/identity/contributor-sessions/:id/revoke` (Phase 17).
3. If the abuse originates from a particular API key, disable it: `POST /v1/identity/service-accounts/:id/disable` (Phase 17, step-up gated).
4. Tighten the intake link allowlist (ipAllowlistCidrs) via the existing Phase 4 intake-link admin endpoints.

## What NOT to do
- **Do not** lower the Twilio webhook signature gate to "make it stop". Phase 18 + Phase 21 both depend on signature validation being fail-closed.
- **Do not** mass-revoke ALL intake links in a team because of a single abused link. Use the per-link revoke route.
- **Do not** rewrite intake-link tokens in the database. Re-issue a new link via the operator UI.
- **Do not** publish the contributor's IP or contact details outside the operator audit. Wording invariant: incidents describe behaviour, not identity.

## Rollback / retry guidance
- A legitimate contributor whose link was revoked due to a false positive should receive a NEW link via the operator UI (Phase 18 SMS / WhatsApp delivery is fine).
- If the abuse correlates with a credential-stuffing attempt, tighten the org MFA policy (Phase 19) and rotate any affected API keys.

## Escalation
- > 100 abuse signals / hour on a single intake link → page on-call. Likely cause: link leaked to a public surface; revoke and issue a new one to the legitimate recipient.
- Sustained workspace-wide abuse + governance violations → escalate to the workspace owner. Consider temporarily disabling new intake-link creation while triaging.
