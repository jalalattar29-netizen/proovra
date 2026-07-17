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
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Badge / Button). This tab renders INSIDE the org admin
 * layout shell (which owns the org title + tab bar), so it uses Card
 * headings — not a second PageHeader. All deep-links, testids,
 * data-configured / data-state markers, and honest "not configured"
 * defaults are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";

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
    configureHref: "/settings#security",
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
    <section
      data-testid="org-admin-security"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      {/* Phase 3 (Enterprise Identity) — deep-link to the org-scoped Domains
          verification tab (sibling admin tab). Consolidated here rather than
          duplicating domain management on this readiness page. */}
      <Card
        variant="summary"
        data-section="security-domains"
        style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div style={{ fontWeight: 600 }}>Verified domains</div>
          <div style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
            Claim + verify email domains (DNS TXT) that gate SSO and
            auto-associate members.
          </div>
        </div>
        <Link
          href={`/organizations/${orgId}/admin/domains`}
          data-testid="sec-deep-link-domains"
          style={{ textDecoration: "none", flexShrink: 0 }}
        >
          <Button variant="secondary" size="sm">
            Manage domains →
          </Button>
        </Link>
      </Card>

      <Card
        variant="admin"
        data-section="security-readiness"
        title="Security readiness"
        subtitle={
          <>
            Organization-level security posture. Configuration of each control
            lives on the canonical identity / settings surface. Until then,
            each row reports honestly as <strong>not configured</strong>.
          </>
        }
      >
        <ul
          data-testid="security-readiness-list"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {READINESS_ROWS.map((row) => (
            <li
              key={row.testId}
              data-testid={row.testId}
              data-configured={row.configured ? "true" : "false"}
              style={{
                padding: "12px 0",
                borderBottom:
                  "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ fontWeight: 600 }}>{row.label}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-secondary, #475569)",
                  }}
                >
                  {row.description}
                </div>
                <span
                  data-state="not-configured"
                  style={{ display: "inline-block", marginTop: 6 }}
                >
                  <Badge tone="pending" subtle>
                    Not configured
                  </Badge>
                </span>
              </div>
              <Link
                href={row.configureHref}
                data-testid={`${row.testId}-configure`}
                style={{ textDecoration: "none", flexShrink: 0 }}
              >
                <Button variant="secondary" size="sm">
                  Configure →
                </Button>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        variant="admin"
        data-section="security-deep-links"
        title="Identity & security surfaces"
      >
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
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
            href="/settings#security"
          />
          <DeepLink
            testId="sec-deep-link-security-center"
            label="Security Center"
            description="Active alerts, anomaly detection, posture findings."
            href="/security-center"
          />
        </ul>
      </Card>
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
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
          {description}
        </div>
      </div>
      <Link href={href} data-testid={testId} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Button variant="secondary" size="sm">
          Open →
        </Button>
      </Link>
    </li>
  );
}
