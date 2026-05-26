# Runbook 14 — External intake / external review failure

**Scope:** customer reports that an external intake link is not working, a reviewer grant cannot be redeemed, or an external participant is reporting an error.

**Prerequisites:**

- Operator account with the relevant capability (`workflow.intake.manage` / `governance.legal_hold.manage` for reviewer grants).
- Read access to `WorkflowIntakeLink` / `WorkflowIntakeSession` / `ExternalReviewerGrant` rows.

**Forbidden:**

- Lowering rate limits on the external intake routes.
- Disabling the feature flag in production without an incident-response decision.
- Sharing raw token values in the support ticket.

---

## External intake link not working

1. **Identify the link.** Capture the link id from the operator panel (NOT the raw token from the URL — tokens are write-only after creation).
2. **Read the link state:** `WorkflowIntakeLink.status` (ACTIVE / REVOKED / EXPIRED), `expiresAtUtc`, `usedCount` / `maxUses`.
3. **Map status to action:**
   - `EXPIRED` — issue a new link via the operator panel.
   - `REVOKED` — confirm with the operator who revoked it (audit event: `workflow_intake_link.revoked`). If revocation was unintended, issue a new link.
   - `ACTIVE` but `usedCount >= maxUses` — link reached its use cap. Issue a new link OR raise `maxUses` for the existing link if the operator intent allows.
   - `ACTIVE` with availability headroom — check the customer's symptom against the next sections.
4. **Common customer-facing errors:**
   - "Page not found" → wrong base URL (the customer copy-pasted the localhost dev URL by mistake). Reconfirm the production link domain.
   - "Link no longer accepting submissions" → status is REVOKED or EXPIRED (handled above).
   - "Upload didn't go through" → runbook 12 (failed upload) — the link itself worked; the upload step failed.
   - "Feature unavailable" 503 — `WORKFLOW_INTAKE_LINKS_ENABLED=false` OR `WORKFLOW_INTAKE_TOKEN_SECRET` unset on the production server. Escalate (runbook 11).

## External reviewer grant not redeemable

1. **Identify the grant.** `ExternalReviewerGrant` row + status (`INVITED` / `ACTIVE` / `REVOKED` / `EXPIRED`).
2. **Anti-enumeration deny code (E8 contract):** unknown / revoked / expired tokens all return `grant_not_active`. The operator panel's view will tell you which terminal state was reached.
3. **Legal hold blocked redemption:** denial code `grant_blocked_by_legal_hold`. The hold on the underlying evidence is correct platform behavior — outside reviewers are NOT a hold exception. Resolution: release the hold (if operator-driven), then re-issue the grant; OR communicate to the external reviewer that they need to wait until the hold clears.
4. **Token-expired:** issue a new grant via the operator panel. The old grant row stays in the DB (retention policy gap — DEF-032, POST_LAUNCH).
5. **Reviewer reports "I never got the email":** confirm the recipient address; re-issue the grant. **Note:** the platform does not auto-resend reviewer-grant emails — that's an operator action.

## DEF-aware caveats

- **DEF-028 (BLOCKS_LAUNCH-decision pending):** external reviewer redemption routes (`GET /v1/external-review/access/:token/context`) have no per-IP / per-token rate limit. If a brute-force pattern is suspected, escalate to incident response (runbook 11).
- **DEF-029 (POST_LAUNCH):** external review surface has no feature flag kill switch. Cannot 503-short-circuit the surface in an incident response without a code change; the only operational response is to revoke individual grants in bulk.
- **DEF-030 (POST_LAUNCH):** evidence request external responder submission emits no `SecurityEvent`. Diagnose external submissions from `EvidenceRequestEvent` + `WorkflowIntakeSession` rows instead.

---

## Honest gaps

- The platform does not provide a self-service "resend my link" UI to external participants. All re-issuance is operator-driven.
- Retention of revoked / expired intake links is open-ended (DEF-031, POST_LAUNCH). Operators can manually delete rows but the platform does not schedule cleanup.
