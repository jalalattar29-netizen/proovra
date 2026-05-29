"use client";

/**
 * Phase 26 — Admin Identity Console (landing).
 *
 * Lightweight workspace identity overview + entry points to:
 *   - Identity Providers (SSO)
 *   - Permission Matrix
 *   - SCIM tokens
 *   - Active Sessions
 *   - Access Reviews
 *
 * Wording invariant: operator-safe phrases only.
 */

import Link from "next/link";

import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";

import {
  cardStyle,
  headerRowStyle,
  pageStyle,
  sectionTitleStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "./ui-tokens";

const PAGES = [
  {
    href: "/admin/identity/providers",
    title: "Identity Providers",
    description:
      "Configure SSO connections (Google Workspace, Okta, Azure AD, generic OIDC). Manage allowed email domains + JIT provisioning.",
  },
  {
    href: "/admin/identity/permission-matrix",
    title: "Permission Matrix",
    description:
      "Inspect what a member can do here. Trace every permission to its source: role default, capability grant, delegated scope, or temporary elevation.",
  },
  {
    href: "/admin/identity/scim",
    title: "SCIM Management",
    description:
      "Provisioning bearer tokens for IdP-driven lifecycle. Token previews + scoped permissions; raw tokens never leave the create response.",
  },
  {
    href: "/admin/identity/sessions",
    title: "Active Sessions",
    description:
      "Live session inventory with last-seen + device previews. Revoke individual sessions or revoke-all for a user.",
  },
  {
    href: "/admin/identity/access-reviews",
    title: "Access Reviews",
    description:
      "Periodic + triggered access reviews queued by the Phase 17 access-review service. Certify, revoke, or suspend.",
  },
  {
    href: "/admin/identity/timeline",
    title: "Event Timeline",
    description:
      "Workspace-wide identity event feed: SSO logins, SCIM syncs, suspicious sessions, temporary elevations, and adaptive auth decisions in one chronological view.",
  },
  {
    href: "/admin/identity/runtime",
    title: "Runtime Monitor",
    description:
      "Live SOC console: quarantine sessions, release safe sessions, re-score on demand, and emergency org-wide revoke. Adaptive auth + quarantine + risk in one place.",
  },
];

export default function AdminIdentityConsole() {
  return (
    <main style={pageStyle}>
      <AdminConsoleNav />
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Identity Governance</h1>
          <p style={subtitleStyle}>
            Enterprise RBAC, SSO, SCIM, session, and access-review controls
            for the workspace. Every mutation is audited and respects org +
            workspace policy inheritance.
          </p>
        </div>
      </header>

      <section style={{ marginTop: 20 }}>
        <h3 style={sectionTitleStyle}>Console</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 12,
            marginTop: 6,
          }}
        >
          {PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              style={{
                ...cardStyle,
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{p.title}</div>
              <div style={{ fontSize: 12, color: TOKENS.inkMuted, marginTop: 4 }}>
                {p.description}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
