"use client";

/**
 * Phase P1 / Phase IA-collapse — Identity Operations canonical hub.
 *
 * `/admin/identity` is the single procurement-grade entry point for
 * enterprise identity operations. It surfaces every admin-operable
 * surface the platform actually ships — and nothing it doesn't.
 *
 * Hard rules:
 *   * No fake capability claims. Every card links to a surface backed
 *     by a real endpoint or returns the operator to the documented
 *     blocker (per the P1.0 audit).
 *   * The previous IA at `/security-center/sso` +
 *     `/security-center/mfa-recovery` remains intact. This page is the
 *     canonical aggregator the user expects under `/admin/identity`.
 *   * Step-up gating is the responsibility of each sub-page; this
 *     surface is navigation only.
 *
 * Phase IA-collapse history: this hub previously lived at
 * `/settings/security`. `/settings/security` is now the personal
 * Account Security home (route id `account.security`). Deep links to
 * `/settings/security/{scim,audit}` continue to redirect via
 * `next.config.js`; `/settings/security/saml` is its own sub-page.
 *
 * Operator vocabulary discipline:
 *   * "SAML configuration" / "SCIM operations" / "Identity audit" —
 *     the labels enterprise admins know from compliance + procurement
 *     reviews. No invented brand-speak.
 */

import Link from "next/link";

import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { TOKENS } from "./ui-tokens";

type Surface = {
  href: string;
  title: string;
  description: string;
  /** Used by the contract test to assert each card maps to a real route. */
  canonicalPath: string;
};

const PRIMARY_SURFACES: ReadonlyArray<Surface> = [
  {
    href: "/settings/security/saml",
    canonicalPath: "/settings/security/saml",
    title: "SAML configuration",
    description:
      "Configure identity-provider SSO. Metadata ingestion, certificate rotation, request signing, NameID + attribute mapping, connection health checks, and IdP outage detection.",
  },
  {
    href: "/admin/identity/scim",
    canonicalPath: "/settings/security/scim",
    title: "SCIM operations",
    description:
      "Provisioning token lifecycle, scope-limited bearer tokens, IP allowlist, suspend / reactivate, and revoke. Destructive operations require step-up.",
  },
  {
    href: "/admin/identity/timeline",
    canonicalPath: "/settings/security/audit",
    title: "Identity audit center",
    description:
      "Unified security-event timeline: login activity, step-up elevations, session governance, geo-risk anomalies, and provisioning events. Filters per event kind + severity.",
  },
];

const SECONDARY_SURFACES: ReadonlyArray<Surface> = [
  {
    href: "/admin/identity/sessions",
    canonicalPath: "/admin/identity/sessions",
    title: "Active sessions",
    description:
      "Live session inventory. Revoke individual sessions or revoke-all for a user (step-up gated). Filter by revoked / expired.",
  },
  {
    href: "/admin/identity/runtime",
    canonicalPath: "/admin/identity/runtime",
    title: "Runtime monitor",
    description:
      "Live SOC console: quarantine sessions, release safe sessions, re-score on demand, and emergency org-wide revoke (step-up gated).",
  },
  {
    href: "/admin/identity/access-reviews",
    canonicalPath: "/admin/identity/access-reviews",
    title: "Access reviews",
    description:
      "Periodic + triggered access reviews. Certify, revoke, or suspend each entry. Audited via Phase 17 access-review service.",
  },
  {
    href: "/admin/identity/permission-matrix",
    canonicalPath: "/admin/identity/permission-matrix",
    title: "Permission matrix",
    description:
      "Trace every permission to its source: role default, capability grant, delegated scope, or temporary elevation. Read-only inspector.",
  },
  {
    href: "/security-center",
    canonicalPath: "/security-center",
    title: "MFA + trusted devices",
    description:
      "Per-user MFA enrollment posture, MFA policy editor, trusted device list with revocation, and own-session risk snapshot.",
  },
  {
    href: "/security-center/mfa-recovery",
    canonicalPath: "/security-center/mfa-recovery",
    title: "MFA recovery approvals",
    description:
      "Admin queue for pending recovery requests. Quorum-based approval (step-up gated). Digest notification preferences + snooze controls.",
  },
];

export default function AdminIdentityHubPage() {
  return (
    <PageRouteGate routeId="admin.identity">
      <AdminIdentityHubInner />
    </PageRouteGate>
  );
}

function AdminIdentityHubInner() {
  return (
    <PageShell
      data-testid="admin-identity-hub"
      header={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <AdminConsoleNav />
          <PageHeader
            eyebrow="Identity operations"
            title="Identity operations"
            subtitle="The procurement-grade identity + security operations entry point. Every surface here is backed by an audited backend endpoint and respects the workspace + organization tenancy boundaries. Destructive operations require step-up where flagged by the workspace step-up policy."
          />
        </div>
      }
    >
      <PageSection
        data-section="admin-identity-primary"
        title="Primary admin surfaces"
        description="The canonical SAML / SCIM / Audit surfaces for enterprise procurement reviews."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 12,
          }}
        >
          {PRIMARY_SURFACES.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              data-admin-identity-card={s.canonicalPath}
              style={{
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
              }}
            >
              <Card
                variant="status"
                tone="governance"
                padding="compact"
                title={s.title}
                subtitle={s.description}
              />
            </Link>
          ))}
        </div>
      </PageSection>

      <PageSection
        data-section="admin-identity-secondary"
        title="Operational surfaces"
        description="Live session governance, RBAC inspection, access reviews, MFA posture, and recovery operations."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 12,
          }}
        >
          {SECONDARY_SURFACES.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              data-admin-identity-card={s.canonicalPath}
              style={{
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
              }}
            >
              <Card
                variant="summary"
                padding="compact"
                title={s.title}
                subtitle={s.description}
              />
            </Link>
          ))}
        </div>
      </PageSection>

      <PageSection
        data-section="admin-identity-honest-scope"
        title="Honest scope disclosure"
        description="These capabilities are NOT shipped today and are bounded follow-up work. The platform never surfaces fake controls."
      >
        <ul
          style={{
            fontSize: 12,
            color: TOKENS.inkSubtle,
            margin: 0,
            paddingLeft: 18,
            lineHeight: 1.6,
          }}
          data-admin-identity-bounded-followups
        >
          {/*
            Phase P1.1 closed four bounded follow-ups previously listed
            here. All shipped surfaces are reachable from `/admin/
            identity/*`:
              * SCIM provisioning token lifecycle
                → /admin/identity/scim (Tokens tab)
              * SCIM drift reconciliation
                → /admin/identity/scim (Drift detection tab; consumes
                  /v1/scim/reconciliation/preview + /execute)
              * SCIM sync-failure replay
                → /admin/identity/scim (Sync replay tab; consumes
                  /v1/scim/sync-failures + /:id/replay)
              * SSO connection health monitoring
                → /security-center/sso/health
              * Visual SAML attribute mapping builder
                → /security-center/sso/mapping
              * Bounded session identity timeline (scope-honest
                replacement for "historical session replay" — identity
                events only)
                → /admin/identity/sessions (per-row "View timeline")
            Final Closure Remediation Part G — verified all six shipped
            end-to-end; nothing partially exposed remains here.
          */}
          <li>
            <strong>Step-up exemption rules</strong> — admin-defined
            waivers for specific actions/roles. Today step-up is
            workspace-flag driven (per-action, on or off).
          </li>
        </ul>
      </PageSection>
    </PageShell>
  );
}
