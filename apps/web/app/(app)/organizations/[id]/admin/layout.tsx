"use client";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

/**
 * Phase 8 — Unified org-admin shell.
 *
 * Renders the organization header + tab navigation around every
 * /organizations/[id]/admin/* leaf page. The header is read-only and
 * derives entirely from GET /v1/orgs/:id; every mutation continues to
 * live inside its respective tab (members, settings, etc.) or on the
 * canonical Phase 4A surface that the tab deep-links to.
 *
 * Constitutional checks satisfied:
 *
 *   - Organization is OPTIONAL: this shell is only reachable from
 *     /organizations/[id]/admin/*. Personal users who never opened an
 *     organization never see it.
 *   - No new workspace kinds, no rename of Team, no Reviewer-as-
 *     workspace. The shell is org-admin only and links OUT to the
 *     canonical Phase 4A governance / audit / trust pages.
 *   - No raw window.confirm — this shell has no mutations.
 *   - No platform-context workspace-fragment reads — the shell reads
 *     only /v1/orgs/:id (the org REST endpoint) via apiFetch.
 *   - Strong TypeScript types throughout.
 *   - PageRouteGate is applied per-leaf-page; this layout is a thin
 *     presentational wrapper that runs inside the (app) shell.
 */

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { apiFetch, ApiError } from "../../../../../lib/api";
import { ALL_ORG_ROLES, ORG_ROLE_LABEL, type OrgRole } from "./_lib/orgRoles";

// ---------------------------------------------------------------------------
// Wire types — mirror /v1/orgs/:id (Phase A.1B / Phase 4A canonical shape).
// The OrgRole set + labels are the canonical model from `_lib/orgRoles.ts`
// (single source of truth for the six built-in org roles).
// ---------------------------------------------------------------------------

const ROLE_LABEL = ORG_ROLE_LABEL;

type OrgHeader = {
  organizationId: string;
  name: string;
  legalName: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  callerRole: OrgRole;
  summary: {
    memberCount: number;
    workspaceCount: number;
    pendingInviteCount: number;
  };
};

type HeaderState =
  | { kind: "loading" }
  | { kind: "ready"; data: OrgHeader }
  | { kind: "error"; message: string; status: number; requestId?: string };

// ---------------------------------------------------------------------------
// Tab registry — declarative so the test surface and the runtime agree.
// Each tab is owned by an org-admin who needs a single landing page.
// Tabs that are read-only inline render data here AND deep-link to the
// canonical Phase 4A surface; tabs marked `external: true` are pure
// deep-links (rendered as outbound row, not a tab button).
// ---------------------------------------------------------------------------

interface AdminTab {
  id: string;
  /** Path segment under /organizations/[id]/admin/. */
  segment: string;
  /** Operator-facing label rendered in the tab bar. */
  label: string;
  /** One-line subtitle, used for the breadcrumb area on the leaf page. */
  description: string;
  /**
   * Org roles that may SEE this tab. This is the VISIBILITY layer only —
   * the backend enforces the real access decision on every endpoint (a
   * hidden tab's data is still protected server-side). Kept as an explicit
   * allowlist rather than a `minRole` rank because ORG_SECURITY_ADMIN and
   * ORG_BILLING_ADMIN are peer specialists (same rank) with DISJOINT
   * surfaces: security-admin sees security/domains but NOT billing;
   * billing-admin sees billing but NOT security/domains.
   */
  roles: ReadonlyArray<OrgRole>;
}

// Role bundles — named so the per-tab allowlists read as intent.
// ORG_OWNER + ORG_ADMIN are the full-breadth admins; the specialists and
// the auditor are additive on top for their own surfaces.
const FULL_ADMINS: ReadonlyArray<OrgRole> = ["ORG_OWNER", "ORG_ADMIN"];
// Every role — used for read-only reference/overview surfaces that any org
// member may see (the data itself stays backend-gated).
const EVERY_ROLE: ReadonlyArray<OrgRole> = ALL_ORG_ROLES;

/**
 * Enterprise-Admin tab set, ordered into a single coherent grouping:
 *
 *   Overview
 *   · Organization: Members · Roles · Departments · Workspaces (Integrations)
 *   · Billing & seats
 *   · Security · Domains
 *   · Governance · Access reviews · Retention
 *   · Audit
 *   · Trust
 *
 * Each tab declares the org roles that may SEE it (visibility layer). The
 * backend remains the authoritative gate on every endpoint.
 */
export const ADMIN_TABS: ReadonlyArray<AdminTab> = [
  {
    id: "overview",
    segment: "overview",
    label: "Overview",
    description: "Posture summary across members, governance, and trust.",
    // Read-only landing — every org role (incl. auditor + member) sees it.
    roles: EVERY_ROLE,
  },
  // ---- Organization (people, roles, structure) ----
  {
    id: "members",
    segment: "members",
    label: "Members",
    description:
      "Members, roles, and pending invites. Backed by /v1/orgs/:id/members.",
    // Mutation is ORG_ADMIN+; specialists + auditor get read-only identity.
    roles: [
      "ORG_OWNER",
      "ORG_ADMIN",
      "ORG_SECURITY_ADMIN",
      "ORG_BILLING_ADMIN",
      "ORG_AUDITOR",
    ],
  },
  {
    id: "roles",
    segment: "roles",
    label: "Roles & permissions",
    description:
      "Reference for the six built-in org roles and their capabilities. Assignment happens on Members.",
    // Read-only reference for every org role.
    roles: EVERY_ROLE,
  },
  {
    id: "departments",
    segment: "departments",
    label: "Departments",
    description:
      "Department directory summary. Canonical CRUD lives in Governance Platform.",
    roles: FULL_ADMINS,
  },
  {
    id: "integrations",
    segment: "integrations",
    label: "API & integrations",
    description:
      "Per-workspace API keys + webhook endpoints. Deep-links to the canonical integrations portal.",
    roles: FULL_ADMINS,
  },
  // ---- Billing ----
  {
    id: "billing",
    segment: "billing",
    label: "Billing & seats",
    description:
      "Enterprise plan + seat rollup across workspaces. Requires ORG_BILLING_ADMIN or higher.",
    // Billing-admin specialist + full admins. Auditor gets read visibility
    // (the rollup endpoint permits ORG_AUDITOR read). NOT security-admin.
    roles: ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR"],
  },
  // ---- Security & identity ----
  {
    id: "security",
    segment: "security",
    label: "Security",
    description:
      "Org security readiness (MFA / SSO / SCIM). Configuration lives in admin/identity.",
    // Security-admin specialist + full admins. Auditor gets read. NOT
    // billing-admin.
    roles: ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"],
  },
  {
    id: "domains",
    segment: "domains",
    label: "Domains",
    description:
      "Verified email domains (DNS TXT). Gate SSO + auto-associate members.",
    roles: ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"],
  },
  // ---- Governance ----
  {
    id: "governance",
    segment: "governance",
    label: "Governance",
    description:
      "Policy posture summary. Canonical policy CRUD lives in Governance Platform.",
    roles: [
      "ORG_OWNER",
      "ORG_ADMIN",
      "ORG_SECURITY_ADMIN",
      "ORG_AUDITOR",
    ],
  },
  {
    id: "access-reviews",
    segment: "access-reviews",
    label: "Access reviews",
    description:
      "Active access-review campaigns. Canonical campaign runner lives in Governance Platform.",
    roles: [
      "ORG_OWNER",
      "ORG_ADMIN",
      "ORG_SECURITY_ADMIN",
      "ORG_AUDITOR",
    ],
  },
  {
    id: "retention",
    segment: "retention",
    label: "Retention & Legal hold",
    description:
      "Retention + legal hold posture. Canonical workflows live in Evidence Lifecycle.",
    roles: [
      "ORG_OWNER",
      "ORG_ADMIN",
      "ORG_SECURITY_ADMIN",
      "ORG_AUDITOR",
    ],
  },
  // ---- Phase 8 — Enterprise Production Readiness ----
  {
    id: "bulk-invite",
    segment: "bulk-invite",
    label: "Bulk invite",
    description:
      "Invite many members at once (paste or CSV) with validation, dry-run preview, and partial-success handling.",
    // Member provisioning — full admins only (ORG_ADMIN+ enforced server-side).
    roles: ["ORG_OWNER", "ORG_ADMIN"],
  },
  {
    id: "reports",
    segment: "reports",
    label: "Reports",
    description:
      "Operational report CSV exports — members, seats, audit, governance, external access. Real data only.",
    // Auditor-tier read; seats export additionally needs billing-admin (gated per-endpoint).
    roles: ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR"],
  },
  {
    id: "readiness",
    segment: "readiness",
    label: "Readiness",
    description:
      "Organization operational readiness — status, SSO/integration health, evidence-operations signals.",
    roles: ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"],
  },
  // ---- Audit ----
  {
    id: "audit",
    segment: "audit",
    label: "Audit",
    description:
      "Org governance audit timeline. Federated feed lives in Audit & Transparency.",
    // Read timeline is any org member; auditor is the specialist here.
    roles: EVERY_ROLE,
  },
  // ---- Trust ----
  {
    id: "trust",
    segment: "trust",
    label: "Trust Center",
    description:
      "Trust Center + subprocessors summary. Canonical pages live in Trust Center.",
    roles: EVERY_ROLE,
  },
];

/**
 * Pure visibility filter — the tabs an org role may SEE. Exported so the
 * per-role visibility contract test can assert it without a DOM runtime.
 * Presentation only; the backend remains the authoritative gate.
 */
export function visibleAdminTabsForRole(
  role: OrgRole,
): ReadonlyArray<AdminTab> {
  return ADMIN_TABS.filter((tab) => tab.roles.includes(role));
}

// ---------------------------------------------------------------------------
// Layout entrypoint.
// ---------------------------------------------------------------------------

export default function OrganizationAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname() ?? "";
  const orgId = params?.id ?? "";

  const [state, setState] = useState<HeaderState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}`)) as OrgHeader;
      setState({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = toSafeUserError(err, { message: "Failed to load." }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeSegment = resolveActiveSegment(pathname, orgId);

  // Role-based tab visibility. Until the caller's role resolves (loading /
  // error), show the full set so the shell never flashes an empty tab bar;
  // once we know the role, filter to what that role may see. The backend
  // still gates every leaf endpoint, so this is presentation only.
  const visibleTabs =
    state.kind === "ready"
      ? visibleAdminTabsForRole(state.data.callerRole)
      : ADMIN_TABS;

  return (
    <main
      className="cc-page"
      data-testid="organization-admin-shell"
      data-org-id={orgId}
      data-active-tab={activeSegment ?? ""}
      style={{ maxWidth: 1100, margin: "0 auto" }}
    >
      {/* Breadcrumb */}
      <div style={{ marginBottom: "0.75rem", fontSize: 13 }}>
        <Link href="/organizations" data-action="breadcrumb-organizations">
          ← All organizations
        </Link>
      </div>

      {/* Header */}
      <header
        className="cc-page-header"
        data-section="org-admin-header"
        data-state={state.kind}
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div className="cc-kicker">Organization administration</div>
          <h1 className="cc-title" data-testid="org-admin-title">
            {state.kind === "ready" ? state.data.name : "Organization"}
          </h1>
          <p className="cc-subtitle">
            {state.kind === "ready" ? (
              <>
                Your role:{" "}
                <strong data-testid="org-admin-caller-role">
                  {ROLE_LABEL[state.data.callerRole]}
                </strong>
                {" · "}
                <span>
                  {state.data.summary.memberCount} member
                  {state.data.summary.memberCount === 1 ? "" : "s"} ·{" "}
                  {state.data.summary.workspaceCount} workspace
                  {state.data.summary.workspaceCount === 1 ? "" : "s"} ·{" "}
                  {state.data.summary.pendingInviteCount} pending invite
                  {state.data.summary.pendingInviteCount === 1 ? "" : "s"}
                </span>
              </>
            ) : state.kind === "loading" ? (
              "Loading organization metadata…"
            ) : state.status === 403 ? (
              "You don't have access to this organization."
            ) : (
              "Couldn't load organization metadata."
            )}
          </p>
          {state.kind === "error" && state.requestId ? (
            <p
              style={{
                color: "#9b826b",
                fontSize: "0.8rem",
                fontFamily: "monospace",
              }}
              data-testid="org-admin-error-request-id"
            >
              Request id: {state.requestId}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Link
            href={`/organizations/${orgId}`}
            data-action="legacy-detail-link"
            className="cases-filter-chip"
          >
            Legacy detail
          </Link>
          <Link
            href={`/teams?org=${orgId}`}
            data-action="workspace-admin-link"
            className="cases-filter-chip"
          >
            Workspace admin
          </Link>
        </div>
      </header>

      {/* Tab bar */}
      <nav
        aria-label="Organization administration sections"
        data-testid="org-admin-tabs"
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          marginBottom: "1.25rem",
          borderBottom: "1px solid rgba(79,112,107,0.18)",
          paddingBottom: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        {visibleTabs.map((tab) => {
          const isActive = activeSegment === tab.segment;
          return (
            <Link
              key={tab.id}
              href={`/organizations/${orgId}/admin/${tab.segment}`}
              data-testid={`org-admin-tab-${tab.id}`}
              data-active={isActive ? "true" : "false"}
              aria-current={isActive ? "page" : undefined}
              title={tab.description}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                border: "1px solid transparent",
                background: isActive
                  ? "linear-gradient(180deg, rgba(62,96,99,0.94) 0%, rgba(24,43,48,0.98) 100%)"
                  : "transparent",
                color: isActive ? "#eef3f1" : "#5d6d71",
                fontSize: "0.92rem",
                fontWeight: 500,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* Leaf page renders here */}
      <div>{children}</div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Maps the current pathname to one of the ADMIN_TABS segments.
 * Returns null when the user is on /organizations/[id]/admin (the
 * index/redirect surface).
 */
function resolveActiveSegment(pathname: string, orgId: string): string | null {
  if (!orgId) return null;
  const prefix = `/organizations/${orgId}/admin/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const segment = rest.split("/")[0] ?? "";
  if (!segment) return null;
  const known = ADMIN_TABS.find((t) => t.segment === segment);
  return known ? known.segment : null;
}
