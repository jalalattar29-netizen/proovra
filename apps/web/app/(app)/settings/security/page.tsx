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
import { PersonalSecuritySections } from "../../security-center/components/PersonalSecuritySections";

export default function AccountSecurityPage() {
  return (
    <PageRouteGate routeId="account.security">
      <AccountSecurityPageInner />
    </PageRouteGate>
  );
}

function AccountSecurityPageInner() {
  return (
    <main style={pageStyle} data-testid="account-security-page">
      <header style={headerStyle}>
        <h1 style={titleStyle}>Account security</h1>
        <p style={subtitleStyle}>
          Personal account controls — change your password, review and
          revoke your active sessions, and inspect the bounded timeline
          of identity and auth events tied to your account. Workspace
          identity operations (MFA policy, trusted devices, recovery
          approvals) live in{" "}
          <Link href="/security-center" style={linkStyle}>
            Identity &amp; Security
          </Link>
          .
        </p>
      </header>

      {/* The three user-scoped sections (password, sessions, events). */}
      <PersonalSecuritySections />
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};

const headerStyle: React.CSSProperties = {
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
  lineHeight: 1.55,
  marginTop: 0,
};

const linkStyle: React.CSSProperties = {
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
};
