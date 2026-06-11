/**
 * Phase IA-self-serve-completion — `/teams` landing page.
 *
 * Before this phase there was no top-level page.tsx under
 * apps/web/app/(app)/teams/. Only the `/teams/[id]` detail page
 * existed, so a PRO / TEAM user who bookmarked or pasted `/teams` had
 * nowhere to land. The tier rule (apps/web/lib/surface/tiers.ts) marks
 * `/teams` as PROFESSIONAL with a `redirect` policy — that redirect
 * was never followed by a real list landing, which created the
 * discoverability gap called out by the self-serve audit.
 *
 * Hard rules:
 *
 *   1. NO new API calls. The list is rendered from
 *      `envelope.organizations` via `useOrganizations()` — the same
 *      data the workspace switcher consumes.
 *
 *   2. PROFESSIONAL-tier gating is handled by the existing surface
 *      rule + the PageRouteGate. Non-eligible users are redirected
 *      to `/home` by the access pipeline; this file does NOT add a
 *      second gate.
 *
 *   3. Self-serve copy only — no "operations", no "governance", no
 *      "access review". One team per row, click to open. Owner /
 *      Admin / Member badge taken straight from the role on the
 *      envelope.
 *
 *   4. Empty state explains the path forward (Billing → upgrade) in
 *      plain language, with a single bounded CTA per condition.
 */
"use client";

import Link from "next/link";

// Phase IA-self-serve-regression-fix — the original page wrapped
// content in `<PageRouteGate routeId="admin.teams">`. That routeId
// belongs to the historic `/workspaces` admin index (route.href =
// "/workspaces", requiredCapabilities = ["TEAM_VIEW"]). A PRO user
// with no team yet has no TEAM_VIEW capability — so the gate denied
// access and rendered the resolver's denial panel instead of the
// teams landing. From the user's perspective, clicking "Invite
// teammate" on Home appeared to open a blank/wrong page.
//
// Access to `/teams` is already enforced by the surface-tier middleware
// (tiers.ts → PROFESSIONAL with redirect). FREE/PAYG users never reach
// this page at all (middleware redirects them per the tier rule), so
// no PageRouteGate is needed here. PRO/TEAM users always see the real
// content below: a populated list if they have teams, or a clear
// "No teams yet" empty state with a path to Billing if they don't.
import { useOrganizations } from "../../../lib/platform-context";

export default function TeamsLandingPage() {
  return <TeamsLandingPageInner />;
}

function TeamsLandingPageInner() {
  const organizations = useOrganizations();

  return (
    <main style={pageStyle} data-testid="teams-landing-page" data-teams-landing>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Your teams</h1>
        <p style={subtitleStyle}>
          Each team is a shared workspace for cases and evidence. Open a team
          to manage members, invite teammates, or change its billing plan.
        </p>
      </header>

      {organizations.length === 0 ? (
        <div style={emptyStateStyle} data-teams-landing-empty>
          <strong style={emptyStateTitleStyle}>No teams yet</strong>
          <p style={emptyStateBodyStyle}>
            Invite members from a team page. Create your first team from
            Billing — PRO lets you own up to 2 teams; TEAM raises that to 5.
          </p>
          <Link href="/billing" style={primaryLinkButtonStyle}>
            Go to Billing
          </Link>
        </div>
      ) : (
        <ul style={listStyle}>
          {organizations.map((org) => (
            <li key={org.id} style={rowStyle}>
              <Link
                href={`/teams/${org.id}`}
                style={rowLinkStyle}
                data-team-row-href={`/teams/${org.id}`}
              >
                <div style={rowMainStyle}>
                  <span style={rowNameStyle}>
                    {org.displayName ?? org.name ?? "Team"}
                  </span>
                  <span style={rowMetaStyle}>
                    {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                    {org.plan ? ` · ${org.plan} plan` : ""}
                  </span>
                </div>
                {org.role ? (
                  <span style={roleBadgeStyle(org.role)}>{org.role}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const headerStyle: React.CSSProperties = {
  marginBottom: 24,
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
  marginBottom: 6,
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.55,
  color: "#5d6d71",
  maxWidth: 720,
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: 10,
};

const rowStyle: React.CSSProperties = {
  margin: 0,
};

const rowLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px",
  borderRadius: 12,
  border: "1px solid rgba(15, 23, 42, 0.08)",
  background: "rgba(15, 23, 42, 0.02)",
  textDecoration: "none",
  color: "inherit",
};

const rowMainStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const rowNameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#0f172a",
};

const rowMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#5d6d71",
};

function roleBadgeStyle(role: string): React.CSSProperties {
  const fillByRole: Record<string, string> = {
    OWNER: "#1e3a8a",
    ADMIN: "#0e7490",
    MEMBER: "#475569",
    VIEWER: "#94a3b8",
  };
  return {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    padding: "4px 8px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.7)",
    color: fillByRole[role] ?? "#475569",
    border: "1px solid currentColor",
  };
}

const emptyStateStyle: React.CSSProperties = {
  padding: "22px 24px",
  borderRadius: 14,
  background: "rgba(15, 23, 42, 0.03)",
  border: "1px dashed rgba(15, 23, 42, 0.16)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 10,
};

const emptyStateTitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "#0f172a",
};

const emptyStateBodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "#5d6d71",
};

const primaryLinkButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 14px",
  borderRadius: 10,
  background: "#1e293b",
  color: "#fff",
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 600,
};
