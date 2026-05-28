/**
 * Phase P1.2 — SCIM Operations Center (canonical path).
 *
 * The procurement-grade SCIM admin console ships at the existing
 * canonical surface `/admin/identity/scim` — built across the R8 SCIM
 * waves with full token lifecycle (issue / rotate / revoke), masked
 * preview, scope-limited bearer tokens, IP allowlist, and
 * provisioning-event audit emission.
 *
 * Phase P1.2 adds the canonical procurement path
 * `/settings/security/scim` so deep links from procurement reviews +
 * the Identity operations hub resolve to the same surface without
 * duplicating the implementation.
 *
 * Backed by:
 *   * GET  /v1/admin/identity/scim/tokens?teamId=...    (list)
 *   * POST /v1/admin/identity/scim/tokens               (issue, returns token once)
 *   * POST /v1/admin/identity/scim/tokens/:id/revoke    (revoke, step-up gated)
 *   * GET/POST/PATCH/DELETE /v2/scim/Users              (IdP-facing CRUD)
 *   * GET/POST/PATCH/DELETE /v2/scim/Groups             (IdP-facing CRUD)
 *
 * Backend service implementations:
 *   * services/api/src/routes/scim.routes.ts             (352 lines)
 *   * services/api/src/services/access-control/scim.service.ts
 *   * services/api/src/services/access-control/scim-groups.service.ts
 *
 * Honest scope disclosure: the SCIM **reconciliation engine** + **drift
 * detection** + admin-facing user listing are documented bounded
 * follow-ups in the P1.0 audit. The audit center
 * (`/settings/security/audit`) surfaces SCIM provisioning events from
 * the security event catalog (scim_user_created /
 * scim_user_deactivated / scim_group_created / scim_token_revoked /
 * scim_invalid_token), so failed-sync diagnostics live there today.
 */

import { redirect } from "next/navigation";

export default function SettingsSecurityScimPage() {
  redirect("/admin/identity/scim");
}
