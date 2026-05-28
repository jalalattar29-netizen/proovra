/**
 * Phase P1.3 — Identity Audit Center (canonical path).
 *
 * The procurement-grade identity audit center ships at the existing
 * canonical surface `/admin/identity/timeline` — built across the R8
 * waves with the unified security-event feed sourced from
 * `safeEmitSecurityEvent()` across every identity / governance /
 * session / step-up / SCIM / SAML surface.
 *
 * Phase P1.3 adds the canonical procurement path
 * `/settings/security/audit` so deep links from procurement reviews +
 * the Identity operations hub resolve to the same surface.
 *
 * What the audit center surfaces today (per the security event
 * catalog):
 *
 *   * Login activity (saml_login_*, sso_login_*, mfa_verification_*)
 *   * Step-up + privilege elevation (step_up_*, rbac_temporary_elevation_*)
 *   * Session governance (session_revoked_admin, all_sessions_revoked_admin)
 *   * Suspicious sessions + geo anomalies (suspicious_session_detected,
 *     privileged_session_blocked)
 *   * Provisioning security (scim_*, saml_metadata_ingested,
 *     saml_certificate_rotated)
 *   * MFA recovery + digest events (mfa_recovery_request_*, digest_*)
 *
 * Backed by:
 *   * GET /v1/admin/identity/timeline?teamId=...&kinds=...&limit=250
 *
 * Backend service:
 *   * services/api/src/services/security/security-event.service.ts
 *
 * Honest scope disclosure: the **historical session replay** (full
 * session lifecycle reconstruction: created → scored → MFA-gated →
 * quarantined → revoked) is a documented bounded follow-up. Today
 * the timeline provides event-level reconstruction which is the
 * procurement-grade equivalent.
 */

import { redirect } from "next/navigation";

export default function SettingsSecurityAuditPage() {
  redirect("/admin/identity/timeline");
}
