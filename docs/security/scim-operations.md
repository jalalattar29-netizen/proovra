# SCIM Operations Guide (Phase P1)

**Audience:** enterprise IT admins responsible for IdP-driven user provisioning.

**Canonical path:** `/settings/security/scim` (redirects to `/admin/identity/scim`).

---

## 1. What ships today

PROOVRA implements SCIM 2.0 for IdP-driven user + group lifecycle. Operationally:

- **Token lifecycle**: issue, masked-preview reads, revoke. Tokens are bearer-style, prefix-only visible after creation (`*…suffix`); the raw token is shown ONCE on create.
- **Scopes**: `users.read`, `users.write`, `users.deactivate`, `groups.read`.
- **IP allowlist**: per-token allowlist enforced by `authenticateScimRequest`.
- **User CRUD**: `POST /v2/scim/Users` (idempotent on externalId), `GET`, `PATCH` (active replace), `DELETE` (soft / deactivate).
- **Group CRUD**: `POST /v2/scim/Groups` (idempotent), `GET`, `PATCH` (member add/remove), `DELETE`.
- **Audit emission**: every mutation emits a `safeEmitSecurityEvent` call. The audit center timeline consumes:
  - `scim_token_created`, `scim_token_revoked`, `scim_invalid_token`
  - `scim_user_created`, `scim_user_deactivated`
  - `scim_group_created`, `scim_group_deleted`

## 2. Step-up gating

P1.4 wires step-up around two destructive SCIM admin operations:

- **SCIM token creation** (frontend `/admin/identity/scim` `submitCreate`). If the workspace step-up policy is set, the backend returns 401 STEP_UP_REQUIRED; the modal collects the OTP; the operation proceeds.
- **SCIM token revocation** (frontend `revoke` handler). Same gate.

The backend audit fires regardless of step-up; step-up is operator-side confirmation, not the authoritative gate.

## 3. Token lifecycle procedure

### Issue a token

1. Navigate to `/settings/security/scim`.
2. Click **New token**.
3. Name it operationally (e.g. `okta-prod-provisioning`).
4. Select scopes (least privilege).
5. Submit. The raw token is shown ONCE — copy to your IdP secrets manager immediately.
6. Audit emission: `scim_token_created`.

### Rotate a token

PROOVRA does not auto-rotate. To rotate:

1. Issue a new token with the same scopes.
2. Configure the IdP to use the new token.
3. Wait for confirmation that the IdP is using the new token (check the previous token's `lastUsedAtUtc`).
4. Revoke the old token (step-up gated).

### Revoke a token

1. Click **Revoke** on the token row.
2. Confirm the irreversible action.
3. Step-up may prompt depending on workspace policy.
4. Audit emission: `scim_token_revoked`.

## 4. Honest scope disclosure (NOT shipped today)

- **Admin-facing user listing.** Today the IdP queries `/v2/scim/Users`; the admin UI doesn't yet surface a workspace-wide SCIM user table. Failed-sync events are visible in the audit center.
- **Failed-sync diagnostics / replay endpoint.** Today operators triage failed syncs from the audit center timeline (filter event kind = SCIM). Automated replay of failed operations is bounded follow-up.
- **Drift detection / reconciliation engine.** No periodic sync that compares IdP state vs PROOVRA state and emits corrective actions. Bounded follow-up.
- **Destructive bulk preview.** No "show me the diff before I run a bulk PATCH" surface. The IdP-side dry-run is the operator's current control.

These are listed verbatim on the `/settings/security` hub honest-scope card so admins see the boundary before they begin.

## 5. Procurement posture

- Tokens: stored hashed; raw value visible only on create response.
- Scopes: least-privilege; scope check enforced on each SCIM request.
- IP allowlist: per-token; rejected requests count `scim_invalid_token_total`.
- Audit: every mutation + token life-cycle event emitted.
- Backend authority: `services/api/src/services/access-control/scim.service.ts` is the canonical mutation site.

## 6. Reference

- Surface: [apps/web/app/(app)/admin/identity/scim/page.tsx](../../apps/web/app/%28app%29/admin/identity/scim/page.tsx)
- Canonical redirect: [apps/web/app/(app)/settings/security/scim/page.tsx](../../apps/web/app/%28app%29/settings/security/scim/page.tsx)
- Routes: [services/api/src/routes/scim.routes.ts](../../services/api/src/routes/scim.routes.ts), [services/api/src/routes/admin-identity.routes.ts](../../services/api/src/routes/admin-identity.routes.ts)
- Service: [services/api/src/services/access-control/scim.service.ts](../../services/api/src/services/access-control/scim.service.ts)
- Audit center: [identity-audit-center.md](./identity-audit-center.md)
