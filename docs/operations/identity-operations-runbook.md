# Identity Operations Runbook (Phase P1)

**Audience:** workspace admins, IT operations, incident-response on-call.

**Canonical hub:** `/settings/security`

---

## 1. Daily / weekly procedures

### Each business day
- Open `/settings/security/audit`. Filter event kind = "High severity only". Investigate any new entries.
- Open `/settings/security/saml`. Confirm cert-expiry warnings show >30 days for every ACTIVE connection.

### Each week
- Open `/admin/identity/sessions` filtered to "include expired". Sanity-check expected session count.
- Open `/admin/identity/access-reviews` filtered to PENDING. Triage anything > 7 days old.
- Open `/security-center/mfa-recovery`. Resolve pending recovery requests (most expire 72 hours after creation).

---

## 2. Incident playbooks

### Suspected account compromise

1. Open `/admin/identity/sessions?teamId=…`.
2. Find the user's sessions; click **Revoke** on each suspicious entry.
3. If the suspicious surface is broad, use **Revoke-all** for that user (step-up gated).
4. If the suspicious surface is org-wide, open `/admin/identity/runtime` and use the **emergency revoke** (step-up gated).
5. Open `/settings/security/audit`. Filter event kind = "Sessions". Confirm the revocation audit emitted.
6. Open `/security-center/mfa-recovery`. If the operator needs to recover, follow the quorum-based recovery flow.

### SAML outage detected

1. Open `/settings/security/saml`.
2. Click **Run health check** on the affected connection.
3. Inspect the structured failure (cert / SSO URL / ACS / NameID).
4. Coordinate with the IdP team.
5. Once resolved, re-run the health check. Confirm pass.

### SAML cert about to expire

1. Open `/settings/security/saml`. The expiry warning banner shows at 90/60/30 days.
2. Coordinate with IdP team for cert rotation.
3. Follow the cert rotation procedure in `saml-admin-guide.md` §3.
4. Step-up will gate the promotion (workspace policy permitting).

### SCIM token compromised / leaked

1. Open `/admin/identity/scim` or `/settings/security/scim`.
2. Find the compromised token.
3. Click **Revoke** (step-up gated).
4. Issue a new token with the same scopes (step-up gated).
5. Update the IdP with the new token.
6. Audit timeline shows `scim_token_revoked` + `scim_token_created` for the rotation pair.

### MFA recovery request

1. Open `/security-center/mfa-recovery`.
2. Inspect each pending request: reason, email-verification status, quorum progress.
3. If the request is legitimate, approve. Quorum requirements apply (multi-admin sign-off).
4. If suspicious, reject with reason. The audit emits `mfa_recovery_request_rejected`.

### Suspicious session detected

1. Open `/settings/security/audit`. Filter event kind = "High severity only" or "Sessions".
2. Open `suspicious_session_detected` event detail.
3. Open `/admin/identity/runtime`. Find the session; click **Quarantine** (with reason + release hours).
4. Investigate; if confirmed legitimate, click **Release**. If confirmed compromised, click **Revoke**.
5. For per-session forensics, open `/admin/identity/sessions`, find the session row, click **View timeline** for the bounded identity-event reconstruction (see `docs/security/session-reconstruction.md`).

### SCIM drift detected

1. Open `/admin/identity/scim` → **Drift detection** tab. The scan runs automatically.
2. Review the risk-banded summary. High-risk items (e.g. `DUPLICATE_EXTERNAL_SUBJECT`) take priority.
3. For each row you intend to act on, confirm the proposed action and tick the checkbox. `REVIEW_ONLY` rows are not selectable — they require human decision.
4. Click **Reconcile selected**. Step-up gates on purpose `SCIM_RECONCILIATION_EXECUTE`.
5. After the result panel reports, the drift cache is invalidated and a fresh scan runs.
6. Full procedure: `docs/security/scim-reconciliation.md`.

### SCIM sync failure backlog

1. Open `/admin/identity/scim` → **Sync replay** tab.
2. Transient failures (e.g. `scim_user_create_failed`) carry a **Replay** button. Terminal failures (`scim_invalid_token`) require issuing a new token in the Tokens tab.
3. Replay emits `scim_sync_replayed` to the audit chain.

### SSO connection health degraded

1. Open `/security-center/sso/health`.
2. Inspect the per-connection card. The recommended-action panel points to the next remediation step.
3. For cert expiry, follow the rotation procedure in `saml-admin-guide.md` §3.
4. For high failure breakdown counts, drill into the audit center filtered to the connection.
5. Full procedure: `docs/security/sso-health-dashboard.md`.

### SAML attribute mapping change

1. Open `/security-center/sso/mapping`.
2. Select the SAML connection.
3. Edit attributes / group → role mappings.
4. **Always run preview before save.** Privilege-affecting changes are gated on step-up purpose `SAML_MAPPING_PRIVILEGE_UPDATE`.
5. Full procedure: `docs/security/saml-mapping-builder.md`.

---

## 3. Procurement / audit prep

- All identity events are queryable through `/settings/security/audit`.
- The DB-backed `SecurityEvent` table is the authoritative record; PROOVRA never logs raw IPs / tokens / payloads.
- 320 event types in the catalog (`packages/shared/dist/security.d.ts`).
- Per-event 4 KB JSON cap; truncation is itself logged.
- Step-up gating is on-or-off per workspace per action; not per-user / per-role today.

## 4. Bounded follow-ups documented operator-side

Phase P1.1 closed four of the five P1 bounded follow-ups. The canonical hub now lists only what truly is NOT yet shipped:

- **Step-up exemption rules** (per-role / per-user waivers). Today step-up is workspace-flag driven (per-action, on or off).

Closed in P1.1 (shipped surfaces in parentheses):

- ✅ SCIM drift reconciliation engine (`/admin/identity/scim` → Drift detection + Sync replay tabs)
- ✅ SSO connection health monitoring dashboard (`/security-center/sso/health`)
- ✅ Visual SAML attribute mapping builder (`/security-center/sso/mapping`)
- ✅ Bounded session identity timeline (`/admin/identity/sessions` → per-row "View timeline"); this is the privacy-safe, scope-honest replacement for "Historical session replay" — identity events only, NOT a surveillance system.

Operators should NOT assume the remaining item is coming on a fixed schedule; raise procurement requests if needed.

## 5. Cross-doc reference

- [SAML Admin Guide](../security/saml-admin-guide.md)
- [SCIM Operations](../security/scim-operations.md)
- [SCIM Drift Reconciliation](../security/scim-reconciliation.md) (P1.1)
- [SAML Mapping Builder](../security/saml-mapping-builder.md) (P1.1)
- [SSO Health Dashboard](../security/sso-health-dashboard.md) (P1.1)
- [Session Reconstruction](../security/session-reconstruction.md) (P1.1)
- [Identity Audit Center](../security/identity-audit-center.md)
- [Step-Up Governance](../security/step-up-governance.md)
- [Deployment hardening](./deployment-hardening.md)
- [Observability catalog](./observability.md)
