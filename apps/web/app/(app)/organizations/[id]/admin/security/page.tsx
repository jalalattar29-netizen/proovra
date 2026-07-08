"use client";

/**
 * Phase 8 — Org admin / Security tab.
 *
 * Honest security readiness snapshot. MFA / SSO / SCIM configuration
 * lives under /settings/security (admin/identity); from an org-admin
 * context (no required active workspace) we render explicit
 * "not configured" empty states and deep-link to the canonical config
 * surfaces rather than fabricating org-scoped readiness signals.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - SSO/SCIM internals are NOT implemented here (only links).
 *   - No raw window.confirm (read-only).
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 *   - Empty states say "Not configured" — never fake-positive.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";

export default function OrganizationAdminSecurityPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <SecurityTab />
    </PageRouteGate>
  );
}

interface ReadinessRow {
  testId: string;
  label: string;
  description: string;
  /**
   * Without a canonical org-scoped readiness endpoint, every row defaults
   * to "not configured" with a clear explanation + deep-link. This is a
   * deliberate honest default per the Phase 8 success criterion #8.
   */
  configured: false;
  configureHref: string;
}

const READINESS_ROWS: ReadonlyArray<ReadinessRow> = [
  {
    testId: "security-row-mfa",
    label: "Multi-factor authentication policy",
    description:
      "Org-wide MFA enforcement (TOTP / WebAuthn / passkey requirement).",
    configured: false,
    configureHref: "/settings/security",
  },
  {
    testId: "security-row-sso",
    label: "SSO (SAML / OIDC)",
    description:
      "Federated identity. Configure SAML or OIDC providers and bind to org roles.",
    configured: false,
    configureHref: "/admin/identity",
  },
  {
    testId: "security-row-scim",
    label: "SCIM provisioning",
    description:
      "Automated user provisioning and de-provisioning via SCIM 2.0.",
    configured: false,
    configureHref: "/admin/identity/scim",
  },
  {
    testId: "security-row-sessions",
    label: "Session policy",
    description:
      "Session timeouts, idle expiration, and concurrent session limits.",
    configured: false,
    configureHref: "/admin/identity/sessions",
  },
];

function SecurityTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section data-testid="org-admin-security" data-org-id={orgId}>
      {/* Phase 3 (Enterprise Identity) — deep-link to the org-scoped Domains
          verification tab (sibling admin tab). Consolidated here rather than
          duplicating domain management on this readiness page. */}
      <section
        data-section="security-domains"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div style={{ fontWeight: 600 }}>Verified domains</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Claim + verify email domains (DNS TXT) that gate SSO and
            auto-associate members.
          </div>
        </div>
        <Link
          href={`/organizations/${orgId}/admin/domains`}
          data-testid="sec-deep-link-domains"
          className="cases-filter-chip"
        >
          Manage domains →
        </Link>
      </section>

      <section
        data-section="security-readiness"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Security readiness</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Organization-level security posture. Configuration of each control
          lives on the canonical identity / settings surface. Until then,
          each row reports honestly as <strong>not configured</strong>.
        </p>
        <ul
          data-testid="security-readiness-list"
          style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0" }}
        >
          {READINESS_ROWS.map((row) => (
            <li
              key={row.testId}
              data-testid={row.testId}
              data-configured={row.configured ? "true" : "false"}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid rgba(127,127,127,0.18)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ fontWeight: 500 }}>{row.label}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {row.description}
                </div>
                <div
                  data-state="not-configured"
                  style={{
                    fontSize: 11,
                    marginTop: 4,
                    padding: "1px 8px",
                    borderRadius: 999,
                    background: "rgba(245, 158, 11, 0.18)",
                    display: "inline-block",
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                  }}
                >
                  Not configured
                </div>
              </div>
              <Link
                href={row.configureHref}
                data-testid={`${row.testId}-configure`}
                className="cases-filter-chip"
              >
                Configure →
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section
        data-section="security-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Identity &amp; security surfaces</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="sec-deep-link-identity"
            label="Admin · Identity"
            description="SSO providers, SCIM endpoints, session policies."
            href="/admin/identity"
          />
          <DeepLink
            testId="sec-deep-link-settings"
            label="Settings · Security"
            description="Per-user MFA, recovery, security keys."
            href="/settings/security"
          />
          <DeepLink
            testId="sec-deep-link-security-center"
            label="Security Center"
            description="Active alerts, anomaly detection, posture findings."
            href="/security-center"
          />
        </ul>
      </section>
    </section>
  );
}

function DeepLink({
  testId,
  label,
  description,
  href,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <li
      style={{
        padding: "0.5rem 0",
        borderBottom: "1px solid rgba(127,127,127,0.18)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{description}</div>
      </div>
      <Link
        href={href}
        data-testid={testId}
        className="cases-filter-chip"
      >
        Open →
      </Link>
    </li>
  );
}
