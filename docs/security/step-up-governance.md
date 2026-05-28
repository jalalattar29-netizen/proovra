# Step-Up Governance Guide (Phase P1)

**Audience:** workspace admins + governance reviewers who decide which actions require operator re-authentication.

---

## 1. Model

PROOVRA's step-up is **workspace-flag-driven**. The backend middleware `enforceStepUpIfFlagged` checks the workspace's step-up policy on each sensitive action and returns 401 STEP_UP_REQUIRED when the flag is set. The frontend wraps the mutation in `useStepUpAction({teamId}).runStepUpAction()` which:

1. Calls the action.
2. If the response is 401 STEP_UP_REQUIRED, surfaces the modal (`StepUpModal`).
3. Collects an OTP via SMS/WhatsApp (Twilio Verify, `POST /v1/identity-security/step-up/start`).
4. Verifies the OTP (`POST /v1/identity-security/step-up/check`).
5. Retries the original action exactly once with the `x-proovra-step-up-challenge-id` header set.
6. The retry happens with the challenge header; the backend middleware consumes it atomically and proceeds.

No bypass path. Single retry. Cancel returns `STEP_UP_CANCEL` to the caller (never silent).

## 2. Actions step-up applies to

The complete set of step-up-flagged actions (per `enforceStepUpIfFlagged` middleware call sites):

| Action | Backend route | Frontend surface |
| --- | --- | --- |
| Reviewer approve | `POST /v1/reviewer-ops/reviews/:workflowId/approve` | Reviewer Console / inspector |
| Reviewer reject | `POST /v1/reviewer-ops/reviews/:workflowId/reject` | Reviewer Console / inspector |
| Escalation resolve | `POST /v1/reviewer-ops/escalations/:id/resolve` | Reviewer Console |
| Reviewer bulk action | `POST /v1/reviewer-ops/reviews/bulk` | Reviewer Console |
| Escalation suppress | `POST /v1/reviewer-ops/escalations/:id/suppress` | Reviewer Console |
| Evidence destruction approve | governance routes | Governance UX |
| Evidence destruction execute | governance routes | Governance UX |
| **SAML certificate promotion** | `DELETE /v1/auth/saml/:connectionId/certificate-next` | `/security-center/sso` (P1.4 wiring) |
| **SCIM token create** | `POST /v1/admin/identity/scim/tokens` | `/admin/identity/scim` (P1.4 wiring) |
| **SCIM token revoke** | `POST /v1/admin/identity/scim/tokens/:id/revoke` | `/admin/identity/scim` (P1.4 wiring) |
| Org-wide session emergency revoke | `POST /v1/admin/identity/emergency-revoke` | `/admin/identity/runtime` |
| All-sessions revoke for user | `POST /v1/admin/identity/sessions/user/:userId/revoke-all` | `/admin/identity/sessions` |
| MFA policy update | `PUT /v1/identity-security/mfa-policy` | `/security-center` |

## 3. Workspace policy

The workspace step-up policy lives in the workspace reviewer-ops flags + governance flags tables. Toggling a flag on a workspace enables step-up for the named action across the workspace.

The policy edit is itself a sensitive action — changing the MFA policy or step-up policy requires step-up.

## 4. Honest scope disclosure (NOT shipped today)

- **Per-role / per-user step-up exemptions.** Today step-up is workspace-flag-driven (on/off). A waiver system that lets specific roles or specific users bypass step-up for specific actions is bounded follow-up. The principle "no bypass path" today means no exemption is possible.

## 5. Observability

Metrics:

- `step_up_challenge_started_total`
- `step_up_challenge_verified_total`
- `step_up_challenge_failed_total`

Audit events:

- `step_up_challenge_started` (severity INFO)
- `step_up_challenge_verified` (severity INFO; tagged with action purpose)
- `step_up_challenge_failed` (severity WARNING; rate-limited rejection emits a separate `mfa_verification_failed` with `reason: "rate_limited"`)

## 6. Reference

- Middleware: `services/api/src/middleware/require-step-up.ts` (or equivalent)
- Service: `services/api/src/services/identity-security/step-up.service.ts`
- Frontend hook + modal: [apps/web/components/identity-security/StepUpModal.tsx](../../apps/web/components/identity-security/StepUpModal.tsx)
- G3 step-up runbook: [stepup-presence-realtime-runbook.md](../operations/stepup-presence-realtime-runbook.md)
