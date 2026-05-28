"use client";

/**
 * Phase P1 — Identity Operations canonical hub.
 *
 * `/settings/security` is the single procurement-grade entry point for
 * enterprise identity operations. It surfaces every admin-operable
 * surface the platform actually ships — and nothing it doesn't.
 *
 * Hard rules:
 *   * No fake capability claims. Every card links to a surface backed
 *     by a real endpoint or returns the operator to the documented
 *     blocker (per the P1.0 audit).
 *   * The previous IA at `/admin/identity` + `/security-center/sso` +
 *     `/security-center/mfa-recovery` remains intact. This page is the
 *     canonical aggregator the user expects under
 *     `/settings/security`.
 *   * Step-up gating is the responsibility of each sub-page; this
 *     surface is navigation only.
 *
 * Operator vocabulary discipline:
 *   * "SAML configuration" / "SCIM operations" / "Identity audit" —
 *     the labels enterprise admins know from compliance + procurement
 *     reviews. No invented brand-speak.
 */

import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  cardStyle,
  headerRowStyle,
  pageStyle,
  sectionTitleStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "../../admin/identity/ui-tokens";

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
    href: "/settings/security/scim",
    canonicalPath: "/settings/security/scim",
    title: "SCIM operations",
    description:
      "Provisioning token lifecycle, scope-limited bearer tokens, IP allowlist, suspend / reactivate, and revoke. Destructive operations require step-up.",
  },
  {
    href: "/settings/security/audit",
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

export default function SettingsSecurityHubPage() {
  return (
    <PageRouteGate routeId="admin.identity">
      <SettingsSecurityHubInner />
    </PageRouteGate>
  );
}

function SettingsSecurityHubInner() {
  return (
    <main style={pageStyle} data-testid="settings-security-hub">
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Identity operations</h1>
          <p style={subtitleStyle}>
            The procurement-grade identity + security operations entry
            point. Every surface here is backed by an audited backend
            endpoint and respects the workspace + organization tenancy
            boundaries. Destructive operations require step-up where
            flagged by the workspace step-up policy.
          </p>
        </div>
      </header>

      <section style={{ marginTop: 20 }} data-section="settings-security-primary">
        <h3 style={sectionTitleStyle}>Primary admin surfaces</h3>
        <p
          style={{
            ...subtitleStyle,
            marginTop: 4,
            marginBottom: 10,
            fontSize: 12,
          }}
        >
          The canonical SAML / SCIM / Audit surfaces for enterprise
          procurement reviews.
        </p>
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
              data-settings-security-card={s.canonicalPath}
              style={{
                ...cardStyle,
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
                borderLeft: `3px solid ${TOKENS.accent}`,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{s.title}</div>
              <div
                style={{ fontSize: 12, color: TOKENS.inkMuted, marginTop: 4 }}
              >
                {s.description}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section
        style={{ marginTop: 24 }}
        data-section="settings-security-secondary"
      >
        <h3 style={sectionTitleStyle}>Operational surfaces</h3>
        <p
          style={{
            ...subtitleStyle,
            marginTop: 4,
            marginBottom: 10,
            fontSize: 12,
          }}
        >
          Live session governance, RBAC inspection, access reviews, MFA
          posture, and recovery operations.
        </p>
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
              data-settings-security-card={s.canonicalPath}
              style={{
                ...cardStyle,
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{s.title}</div>
              <div
                style={{ fontSize: 12, color: TOKENS.inkMuted, marginTop: 4 }}
              >
                {s.description}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section
        style={{ marginTop: 24 }}
        data-section="settings-security-honest-scope"
      >
        <h3 style={sectionTitleStyle}>Honest scope disclosure</h3>
        <p
          style={{
            ...subtitleStyle,
            marginTop: 4,
            marginBottom: 10,
            fontSize: 12,
          }}
        >
          These capabilities are NOT shipped today and are bounded
          follow-up work. The platform never surfaces fake controls.
        </p>
        <ul
          style={{
            ...subtitleStyle,
            marginTop: 6,
            paddingLeft: 18,
            fontSize: 12,
            lineHeight: 1.6,
          }}
          data-settings-security-bounded-followups
        >
          {/*
            Phase P1.1 closed four bounded follow-ups previously listed
            here. The shipped surfaces are:
              * SCIM drift reconciliation engine
                → /admin/identity/scim (Drift detection tab + Sync replay tab)
              * SSO connection health monitoring dashboard
                → /security-center/sso/health
              * Visual SAML attribute mapping builder
                → /security-center/sso/mapping
              * Bounded session identity timeline (replaces "Historical
                session replay" in scope-honest form: identity events
                only, not full surveillance)
                → /admin/identity/sessions (per-row "View timeline")
          */}
          <li>
            <strong>Step-up exemption rules</strong> — admin-defined
            waivers for specific actions/roles. Today step-up is
            workspace-flag driven (per-action, on or off).
          </li>
        </ul>
      </section>
    </main>
  );
}
