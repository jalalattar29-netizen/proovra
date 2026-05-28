/**
 * Phase P1.1 — SAML Admin Console (canonical path).
 *
 * The procurement-grade SAML admin console ships at the existing
 * canonical surface `/security-center/sso` — built across phases
 * R8.2.0 (connection management), R8.2.1 (metadata ingestion +
 * health checks), and R8.2.2 (certificate rotation, expiry warnings,
 * IdP outage detection).
 *
 * Phase P1.1 adds the canonical procurement path `/settings/security/saml`.
 * It server-redirects to the existing surface so:
 *
 *   * deep links from procurement reviews ("/settings/security/saml")
 *     resolve correctly,
 *   * the existing R8.2 implementation is not duplicated,
 *   * the Identity operations hub (`/settings/security`) presents one
 *     coherent IA without forking the active codebase.
 *
 * Backed by:
 *   * GET  /v1/admin/identity/sso/providers?teamId=...   (list SAML connections)
 *   * POST /v1/auth/saml/:connectionId/test-connection   (health check)
 *   * PUT  /v1/auth/saml/:connectionId/certificate-next  (rotation cert)
 *   * DEL  /v1/auth/saml/:connectionId/certificate-next  (promote)
 *   * POST /v1/auth/saml/:connectionId/ingest-metadata   (IdP metadata)
 *   * GET  /v1/auth/saml/metadata/:connectionId          (SP metadata)
 *
 * Backend service implementations:
 *   * services/api/src/services/security/saml-metadata.service.ts
 *   * services/api/src/services/security/saml-assertion.service.ts
 *   * services/api/src/services/security/saml-cert.service.ts
 *   * services/api/src/services/security/saml-user-mapping.service.ts
 *   * services/api/src/services/security/sso-hardening.service.ts
 */

import { redirect } from "next/navigation";

export default function SettingsSecuritySamlPage() {
  redirect("/security-center/sso");
}
