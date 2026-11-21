# Identity Operations Runbook (Phase P1)

**Audience:** workspace admins, IT operations, incident-response on-call.

**Canonical hub:** `/settings/security`

---

## 1. Daily / weekly procedures

### Each business day
- Open `/settings/security/audit`. Filter event kind = "High severity only". Investigate any new entries.
- Open `/settings/security/saml`. Confirm cert-expiry warnings show >30 days for every ACTIVE connection.

### Each week
- Open `/security-center/identity/sessions` filtered to "include expired". Sanity-check expected session count.
- Open `/security-center/identity/access-reviews` filtered to PENDING. Triage anything > 7 days old.
- Open `/security-center/mfa-recovery`. Resolve pending recovery requests (most expire 72 hours after creation).

---

## 2. Incident playbooks

### Suspected account compromise

1. Open `/security-center/identity/sessions?teamId=…`.
2. Find the user's sessions; click **Revoke** on each suspicious entry.
3. If the suspicious surface is broad, use **Revoke-all** for that user (step-up gated).
4. If the suspicious surface is org-wide, open `/security-center/identity/runtime` and use the **emergency revoke** (step-up gated).
5. Open `/settings/security/audit`. Filter event kind = "Sessions". Confirm the revocation audit emitted.
6. Open `/security-center/mfa-recovery`. If the operator needs to recover, follow the admin-approved recovery flow (one workspace admin approves; see below).

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

1. Open `/security-center/identity/scim` or `/settings/security/scim`.
2. Find the compromised token.
3. Click **Revoke** (step-up gated).
4. Issue a new token with the same scopes (step-up gated).
5. Update the IdP with the new token.
6. Audit timeline shows `scim_token_revoked` + `scim_token_created` for the rotation pair.

### MFA recovery request

1. Open `/security-center/mfa-recovery`.
2. Inspect each pending request: reason, email-verification status, approvals so far.
3. If the request is legitimate, approve. One approval from a workspace admin completes the request: every product path creates requests with a requirement of one approval, and there is no workspace or organization setting that raises it. A second admin's approval is not required and is refused once the request is no longer pending. (The service can count up to three approvals, but nothing configures more than one; do not describe this recovery as multi-admin sign-off.) Approval revokes the member's factors and ends their sessions; it forces re-enrollment and does not grant a session.
   **Who may decide** (approve or reject): someone who outranks the requester in that workspace (OWNER > ADMIN > MEMBER > VIEWER), so an ADMIN decides MEMBER and VIEWER requests and the OWNER decides ADMIN requests. The workspace OWNER's own request may be decided by **another live ORG_OWNER** of the workspace's customer Organization who is an OWNER or ADMIN of that workspace (AUD-0038, decision b). An ORG_ADMIN or ORG_SECURITY_ADMIN may not decide it. In a personal, Pro or Team workspace there is no second owner, so its OWNER recovers with their recovery codes. A platform administrator's factors are never recovered here; they use the platform recovery procedure.
4. If suspicious, reject with reason. The audit emits `mfa_recovery_request_rejected`.

### Suspicious session detected

1. Open `/settings/security/audit`. Filter event kind = "High severity only" or "Sessions".
2. Open `suspicious_session_detected` event detail.
3. Open `/security-center/identity/runtime`. Find the session; click **Quarantine** (with reason + release hours).
4. Investigate; if confirmed legitimate, click **Release**. If confirmed compromised, click **Revoke**.
5. For per-session forensics, open `/security-center/identity/sessions`, find the session row, click **View timeline** for the bounded identity-event reconstruction (see `docs/security/session-reconstruction.md`).

### SCIM drift detected

1. Open `/security-center/identity/scim` → **Drift detection** tab. The scan runs automatically.
2. Review the risk-banded summary. High-risk items (e.g. `DUPLICATE_EXTERNAL_SUBJECT`) take priority.
3. For each row you intend to act on, confirm the proposed action and tick the checkbox. `REVIEW_ONLY` rows are not selectable — they require human decision.
4. Click **Reconcile selected**. Step-up gates on purpose `SCIM_RECONCILIATION_EXECUTE`.
5. After the result panel reports, the drift cache is invalidated and a fresh scan runs.
6. Full procedure: `docs/security/scim-reconciliation.md`.

### SCIM sync failure backlog

1. Open `/security-center/identity/scim` → **Sync replay** tab.
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

- ✅ SCIM drift reconciliation engine (`/security-center/identity/scim` → Drift detection + Sync replay tabs)
- ✅ SSO connection health monitoring dashboard (`/security-center/sso/health`)
- ✅ Visual SAML attribute mapping builder (`/security-center/sso/mapping`)
- ✅ Bounded session identity timeline (`/security-center/identity/sessions` → per-row "View timeline"); this is the privacy-safe, scope-honest replacement for "Historical session replay" — identity events only, NOT a surveillance system.

Operators should NOT assume the remaining item is coming on a fixed schedule; raise procurement requests if needed.

## 4b. Scheduled identity runtime enforcement (PRO-W2C2-02), dormant

**Status: shipped switched off. Nothing in this section has run in Production.** Turning it on is a Production configuration change that needs its own owner approval. Deploying a release does not approve it.

### What runs today, with no switch

The worker's `identity-runtime-reconcile` sweep (`services/worker/src/api-delivery-sweeps.ts`) runs every 5 minutes under the cron lock `api-delivery-identity-runtime-reconcile`. It calls `POST /v1/admin/identity/runtime/reconcile` with the identity reconcile secret and no `teamId`, and the API runs `runScheduledIdentityRuntimeSweep` across every workspace that has live sessions or active trusted devices. These legs remove no access:

- quarantine auto-release, at the release time already recorded;
- risk recompute, which writes scores and emits events but does not quarantine;
- stale-session detection, which feeds the gauge and revokes nothing;
- geo-cache expiry and stale SSO callback attempts.

The sweep needs `API_DELIVERY_SWEEPS_ENABLED` (default on) on the worker, the same secret on both services (`IDENTITY_RECONCILE_CRON_SECRET`, or `INTEGRATION_CRON_SECRET` as the fallback), and the internal API base URL. If any of these is missing, the worker logs `api_delivery_sweep.not_configured` on every tick.

### What `IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT=true` adds (API service)

| Leg | Effect | Scope |
|---|---|---|
| Auto-quarantine | A session the scorer rates HIGH or CRITICAL (score 60 or more) that has no device binding and is not already quarantined is quarantined with `SUSPICIOUS_SESSION_AUTO` | Only sessions of identities the workspace governs (DEC-08, `sessionsOfWorkspaceWhere`) |
| Trusted-device decay | Each run adds `2 × (days unseen − 14)` to the device's decay. At 70 or more the device is quarantined; at 100 it is revoked (`TRUST_DECAY_AUTO_INVALIDATED`) | The workspace's own trusted devices |
| Idle revocation | A session idle past the organization's configured `idleTimeoutSeconds` is revoked (`RECONCILIATION_SWEEP`). The 30-minute operator default is never used on the schedule | Only organization workspaces whose policy sets a timeout, and only sessions of identities the workspace governs. An independent member's session is never revoked, because it is account-global (DEC-08) |

**Decay compounds.** Before this switch, decay ran only when an operator pressed "reconcile". On the schedule it runs 288 times a day, so any active trusted device unseen for more than 15 days reaches 100 and is revoked within about 4 hours of activation. The preview reports this per device as `sweepsUntilRevoked` and `minutesUntilRevoked`, and in total as `devicesRevokedWithin24h`.

**Still not switch-gated:** a machine call that names a `teamId` runs that workspace's risk recompute (with auto-quarantine) and decay whatever the switch says. That is the pre-existing per-workspace integration path. The worker never sends a `teamId`.

### Preview (read-only)

Run this as a one-off container of the deployed API image, with the switch still off:

```bash
node dist/scripts/identity-runtime-enforcement-preview.js
```

- It decides with the sweep's own rules: the scorer's signal collector (`collectSessionRiskSignals`), `computeTrustDecay`, `isSessionStale`, the configured idle timeout and the governed-identity set. It writes nothing: no score, cursor, event or metric. Postgres holds its connection read-only, and the script refuses to run otherwise. `free-audit-g2-identity.integration.test.ts` runs the preview inside a `READ ONLY` transaction and checks that no row changed.
- Output: one JSON line per affected session or device. Each line has workspace, session or device ids, scores and decay values. It never includes a name, email, user id, IP or device hash. A summary line gives the totals.
- Exit 0: complete. Exit 3: the scan hit its bounds (`truncated`), so the totals are a lower bound. Exit 2: the run failed; do not rely on it.

### Evidence required before activation

1. **The scheduler is live in Production.** Worker logs show `api_delivery_sweep.scheduler.started` with `identity-runtime-reconcile` in its list. There are no `api_delivery_sweep.not_configured` or `api_delivery_sweep.failed` lines for that sweep over at least 24 hours, and API responses report `scope: "all_workspaces"`, `enforcement: false` and `failedTeams: 0`. The API logs show no `identity.runtime.scheduled_sweep.incomplete` lines, or every one is explained.
2. **A preview from the deployed image,** taken within 24 hours of the change, exit 0, attached to the approval along with its totals.
3. **Owner sign-off on each total.** This covers `sessionsToQuarantine`, `devicesRevokedWithin24h` (the decay compounding above), and `idleSessionsToRevoke` by workspace. If `devicesRevokedWithin24h` is not acceptable, activation waits for a separate decision on decay cadence. That is not a reason to switch on anyway.
4. **The affected organizations have been told.** Each organization with a configured idle timeout, or with stale trusted devices that would be revoked, has been notified.
5. **A rollback plan:** unset the variable and restart the API. Quarantines already applied are released through the existing release flow (or at their release time). Revoked sessions and devices are not restored; those people sign in again or re-trust the device.
6. **Watch after the switch.** For the first 24 hours, track `escalatedToQuarantine`, `devicesAutoInvalidated` and `staleSessionsRevoked` in the sweep responses, along with `runtime_risk_recompute_failed_total` and support contacts about unexpected sign-outs. Compare the first day's counts with the preview totals.

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
