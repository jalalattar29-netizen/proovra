"use client";

/**
 * Phase IA-collapse — Account Security (personal).
 *
 * `/settings/security` is the canonical personal account security home.
 * It mounts the user-scoped surfaces that previously rendered at the
 * top of `/security-center` via `PersonalSecuritySections`:
 *
 *   - Change password (POST /v1/identity-security/password)
 *   - Active sessions (GET /v1/identity-security/my-sessions +
 *     POST /v1/identity-security/my-sessions/revoke-others)
 *   - Recent security events (GET /v1/identity-security/security-events)
 *
 * Hard rules:
 *   * ACCOUNT-tier surface (route id `account.security`,
 *     requiredActiveSpace="NONE") — loads for every authenticated user,
 *     never hides on workspace issues.
 *   * No workspace operations on this page. Workspace identity
 *     operations (MFA policy, trusted devices, session revocations,
 *     MFA recovery approvals) live at `/security-center`
 *     (route id `workspace.security_center`, label "Identity &
 *     Security"). Enterprise identity-operations procurement hub
 *     (SAML, SCIM, audit, sessions, runtime, access reviews, RBAC,
 *     MFA recovery approvals) lives at `/admin/identity` (route id
 *     `admin.identity`).
 *   * Wording is operational only — "step-up required", "session
 *     restricted", "device revoked". Never makes safety guarantees.
 *
 * Phase IA-collapse history: this page previously hosted the enterprise
 * identity-operations hub (SAML / SCIM / Audit + secondary surfaces).
 * That hub moved to `/admin/identity` to free `/settings/security` for
 * personal account security — matching enterprise-tool norms where
 * "Account security" lives under Settings and admin identity operations
 * live under Admin / Operations.
 *
 * Legacy deep links to `/settings/security/scim` and
 * `/settings/security/audit` continue to redirect to their canonical
 * destinations via `next.config.js`; `/settings/security/saml` remains
 * its own sub-page.
 */

import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { PersonalSecuritySections } from "../../security-center/components/PersonalSecuritySections";
// Phase IA-self-serve-simplification — gate the inline "Identity &
// Security" deep link in the page header on /security-center
// eligibility. Self-serve users don't see the deep link because
// the workspace surface is ENTERPRISE_ONLY.
import { canAccessSurface } from "../../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../../lib/surface/useSurfaceUserContext";

export default function AccountSecurityPage() {
  return (
    <PageRouteGate routeId="account.security">
      <AccountSecurityPageInner />
    </PageRouteGate>
  );
}

function AccountSecurityPageInner() {
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeWorkspaceSecurity = canAccessSurface(
    surfaceUserCtx,
    "/security-center",
  );
  return (
    <div data-testid="account-security-page">
      <PageShell
        header={
          <PageHeader
            eyebrow="Personal"
            title="Account security"
            subtitle={
              <>
                Personal account controls — change your password, review and
                revoke your active sessions, and inspect the bounded timeline
                of identity and auth events tied to your account.
                {canSeeWorkspaceSecurity ? (
                  <>
                    {" "}
                    Workspace identity operations (MFA policy, trusted devices,
                    recovery approvals) live in{" "}
                    <Link href="/security-center" style={linkStyle}>
                      Identity &amp; Security
                    </Link>
                    .
                  </>
                ) : null}
              </>
            }
          />
        }
      >
        {/* The three user-scoped sections (password, sessions, events). */}
        <PersonalSecuritySections />
      </PageShell>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  color: "var(--ink-primary, #0f172a)",
  textDecoration: "underline",
  fontWeight: 600,
};
