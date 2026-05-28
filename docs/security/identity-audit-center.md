# Identity Audit Center Guide (Phase P1)

**Audience:** security operations / SOC engineers / compliance reviewers.

**Canonical path:** `/settings/security/audit` (redirects to `/admin/identity/timeline`).

---

## 1. What ships today

The Identity Audit Center is a **unified chronological feed** of every identity / security event the platform emits. It is NOT generic application logs; it is the procurement-grade identity risk operations record.

Sources:

- **Login activity**: `saml_login_started/succeeded/failed`, `sso_login_started/succeeded/failed`, `mfa_verification_failed`, `mfa_enrollment_*`
- **Step-up + privilege elevation**: `step_up_challenge_started/verified/failed`, `rbac_temporary_elevation_granted`
- **Session governance**: `session_revoked_admin`, `all_sessions_revoked_admin`, `privileged_session_blocked`
- **Suspicious session detection**: `suspicious_session_detected`
- **SCIM provisioning**: `scim_token_created/revoked`, `scim_user_created/deactivated`, `scim_group_created/deleted`, `scim_invalid_token`
- **SAML lifecycle**: `saml_metadata_ingested`, `saml_connection_test_started/succeeded/failed`, `saml_certificate_rotated`, `saml_assertion_rejected`
- **MFA recovery**: `mfa_recovery_request_created/approved/rejected`, `mfa_recovery_verify_succeeded/failed`, `mfa_recovery_digest_*`
- **MFA policy**: `org_mfa_policy_enforced`, `org_mfa_policy_updated`
- **Trusted devices**: `trusted_device_trusted/revoked`

## 2. Filters available

- Event kind: All, SSO, SCIM, Sessions, Adaptive auth + RBAC, Access reviews, High severity only
- Severity (client-side): INFO / WARNING / HIGH
- Refresh + window-size: default 250 most recent events

## 3. Event detail

Each row carries:

- Time (UTC)
- Severity badge (INFO grey / WARNING yellow / HIGH red)
- Event type
- Summary (operator-safe; no PII / no secrets)
- Source: workspace (teamId), user (when applicable), IP (hashed, not raw), userAgent, requestId

The `metadataJson` field is bounded to 4 KB; PROOVRA truncates with a marker and logs the truncation. No secrets, no raw tokens, no payload bodies are ever persisted in the audit feed.

## 4. Investigation patterns

### Detecting suspicious login bursts

1. Filter event kind = SSO.
2. Sort by time.
3. Look for repeated `sso_login_failed` from the same hashed IP.
4. Cross-reference with `suspicious_session_detected` events in the same window.

### Investigating a privileged action

1. Filter event kind = "High severity only".
2. Find the `step_up_challenge_started` and matching `step_up_challenge_verified`.
3. Within the next 60 seconds, look for the gated action (approve / reject / cert rotation / session revoke / SCIM revoke).
4. The chain proves the operator re-authed before the sensitive action.

### Investigating a SCIM provisioning regression

1. Filter event kind = SCIM.
2. Look for `scim_invalid_token` (rate limit / bad scope / IP allowlist miss).
3. Look for `scim_user_deactivated` storms (mass deactivation events).
4. Correlate with the IdP-side logs.

## 5. Honest scope disclosure (NOT shipped today)

- **Historical session replay.** Full session lifecycle (created → scored → MFA-gated → trusted device used → quarantined → revoked) as a single timeline view. Today event-level reconstruction is the procurement-grade equivalent.
- **CSV export of audit log.** The audit center timeline is operator-readable but not yet CSV-exportable. Bounded follow-up.
- **Aggregated SSO connection health dashboard.** Per-connection health checks exist; aggregated outage detection across all connections is bounded follow-up.
- **Geo-risk anomaly aggregator UI.** Today `suspicious_session_detected` events surface in the timeline; a dedicated geo-anomaly drill-down UI is bounded follow-up.

## 6. Procurement posture

- 320 distinct security event types in the catalog.
- Events are DB-backed via the `SecurityEvent` table.
- 1,000-byte clip per string field; 4 KB JSON cap per row; truncation is logged.
- No PII: IP is hashed via `COMMUNICATIONS_RECIPIENT_HASH_SECRET` before persist.
- Caller-scoped reads: an admin sees only the workspaces they have membership in.
- Backend service: `services/api/src/services/security/security-event.service.ts`.
- Aggregator endpoint: `GET /v1/admin/identity/timeline?teamId=...&kinds=...&limit=250`.

## 7. Reference

- Surface: [apps/web/app/(app)/admin/identity/timeline/page.tsx](../../apps/web/app/%28app%29/admin/identity/timeline/page.tsx)
- Canonical redirect: [apps/web/app/(app)/settings/security/audit/page.tsx](../../apps/web/app/%28app%29/settings/security/audit/page.tsx)
- Service: [services/api/src/services/security/security-event.service.ts](../../services/api/src/services/security/security-event.service.ts)
- Catalog: `packages/shared/dist/security.d.ts` (`SECURITY_EVENT_TYPES`)
- Companion: [observability.md](../operations/observability.md)
