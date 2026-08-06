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
import { ORG_ROLE_LABEL, type OrgRole } from "./_lib/orgRoles";

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
  /**
   * SERVER-projected org-admin surface ids this caller may SEE
   * (`listOrgAdminSurfaces`). Optional on the wire type ONLY so a degraded
   * response is representable — an absent/empty list renders NO tabs
   * (fail closed), never the full set.
   */
  adminSurfaces?: ReadonlyArray<string>;
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
}

// PHASE 12 POINT 4 STEP 1 — the per-tab `roles` allowlist and
// `visibleAdminTabsForRole` were REMOVED from the browser.
//
// Which org role may SEE which administration surface is an authorization
// question, and the client answer failed OPEN: while the org-header request
// was in flight the shell rendered the FULL tab set to every role. The table
// now lives beside `checkOrgAccess` in
// `services/api/src/services/organization/org-access.ts`
// (`ORG_ADMIN_SURFACE_ACCESS` / `listOrgAdminSurfaces`) and arrives on the
// same response that already carried `callerRole`, as `adminSurfaces`.
//
// What stays here is presentation: each tab's label, segment and
// description. A tab renders only when the server named its id.

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
  },
  // ---- Organization (people, roles, structure) ----
  {
    id: "members",
    segment: "members",
    label: "Members",
    description:
      "Members, roles, and pending invites. Backed by /v1/orgs/:id/members.",
  },
  {
    id: "roles",
    segment: "roles",
    label: "Roles & permissions",
    description:
      "Reference for the six built-in org roles and their capabilities. Assignment happens on Members.",
  },
  {
    id: "departments",
    segment: "departments",
    label: "Departments",
    description:
      "Department directory summary. Canonical CRUD lives in Governance Platform.",
  },
  {
    id: "integrations",
    segment: "integrations",
    label: "API & integrations",
    description:
      "Per-workspace API keys + webhook endpoints. Deep-links to the canonical integrations portal.",
  },
  // ---- Billing ----
  {
    id: "billing",
    segment: "billing",
    label: "Billing & seats",
    description:
      "Enterprise plan + seat rollup across workspaces. Requires ORG_BILLING_ADMIN or higher.",
  },
  // ---- Security & identity ----
  {
    id: "security",
    segment: "security",
    label: "Security",
    description:
      "Org security readiness (MFA / SSO / SCIM). Configuration lives in admin/identity.",
  },
  {
    id: "domains",
    segment: "domains",
    label: "Domains",
    description:
      "Verified email domains (DNS TXT). Gate SSO + auto-associate members.",
  },
  // ---- Governance ----
  {
    id: "governance",
    segment: "governance",
    label: "Governance",
    description:
      "Policy posture summary. Canonical policy CRUD lives in Governance Platform.",
  },
  {
    id: "access-reviews",
    segment: "access-reviews",
    label: "Access reviews",
    description:
      "Active access-review campaigns. Canonical campaign runner lives in Governance Platform.",
  },
  {
    id: "retention",
    segment: "retention",
    label: "Retention & Legal hold",
    description:
      "Retention + legal hold posture. Canonical workflows live in Evidence Lifecycle.",
  },
  // ---- Phase 8 — Enterprise Production Readiness ----
  {
    id: "bulk-invite",
    segment: "bulk-invite",
    label: "Bulk invite",
    description:
      "Invite many members at once (paste or CSV) with validation, dry-run preview, and partial-success handling.",
  },
  {
    id: "reports",
    segment: "reports",
    label: "Reports",
    description:
      "Operational report CSV exports — members, seats, audit, governance, external access. Real data only.",
  },
  {
    id: "readiness",
    segment: "readiness",
    label: "Readiness",
    description:
      "Organization operational readiness — status, SSO/integration health, evidence-operations signals.",
  },
  // ---- Audit ----
  {
    id: "audit",
    segment: "audit",
    label: "Audit",
    description:
      "Org governance audit timeline. Federated feed lives in Audit & Transparency.",
  },
  // ---- Trust ----
  {
    id: "trust",
    segment: "trust",
    label: "Trust Center",
    description:
      "Trust Center + subprocessors summary. Canonical pages live in Trust Center.",
  },
];

/**
 * Project the SERVER's `adminSurfaces` list onto the presentation table,
 * preserving the canonical tab order declared above.
 *
 * Exported so the visibility contract test can assert it without a DOM
 * runtime. Fails closed: an absent or empty projection yields NO tabs.
 */
export function visibleAdminTabsForSurfaces(
  surfaces: ReadonlyArray<string> | undefined | null,
): ReadonlyArray<AdminTab> {
  if (!surfaces || surfaces.length === 0) return [];
  const allowed = new Set(surfaces);
  return ADMIN_TABS.filter((tab) => allowed.has(tab.id));
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

  // PHASE 12 POINT 4 STEP 1 — render exactly the surfaces the SERVER named.
  // While the org-header request is in flight or has failed there is no
  // projection,
  // so the tab bar is EMPTY (fail closed) rather than the full set. The
  // backend gates every leaf endpoint either way.
  const visibleTabs =
    state.kind === "ready"
      ? visibleAdminTabsForSurfaces(state.data.adminSurfaces)
      : [];

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
            href="/teams"
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
