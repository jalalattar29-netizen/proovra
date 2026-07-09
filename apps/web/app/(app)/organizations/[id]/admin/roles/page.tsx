"use client";

/**
 * Phase 4 (Enterprise Administration) — Org admin / Roles & Permissions tab.
 *
 * READ-ONLY reference: the six built-in ORG roles and what each one can do at
 * org scope. There are NO custom roles — the org model does not support them —
 * so this tab is a reference + assignment pointer, never a role editor.
 *
 * Data source is the canonical capability model in
 * `../_lib/orgRoles.ts`, which is grounded in the real backend:
 *   - `enum OrganizationRole` doc-comments (schema.prisma) for the summaries.
 *   - the `minRole` gates the org endpoints enforce
 *     (organizations.routes.ts) for the role → capability matrix.
 *
 * Assignment happens on the Members tab (PATCH /v1/orgs/:id/members). This tab
 * links there rather than duplicating the mutation surface.
 *
 * Gating: reuses the same <PageRouteGate routeId="account.organization-detail">
 * the sibling admin tabs use. The whole `/organizations` prefix is
 * ENTERPRISE-tier (lib/surface/tiers.ts), so this is enterprise-only by
 * construction. The caller's own role is surfaced (READ for any org member;
 * ORG_ADMIN+ additionally see the "assign on Members tab" affordance).
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design system
 * (PageSection + Card + DataTable + Badge + Button + EmptyState). This tab
 * renders INSIDE the org admin layout shell (which already owns the org title +
 * tab bar), so it uses PageSection headings — not a second PageHeader — to
 * avoid a duplicate <h1>. All data reads, gating, testids, data-section markers
 * and the honest error/empty behaviour are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import {
  ALL_ORG_ROLES,
  CAPABILITY_DEFS,
  ORG_ROLE_LABEL,
  ORG_ROLE_SUMMARY,
  ROLE_CAPABILITIES,
  canManageMembers,
  type AccessLevel,
  type OrgRole,
} from "../_lib/orgRoles";

interface OrgResponse {
  organizationId: string;
  name: string;
  callerRole: OrgRole;
}

type CallerState =
  | { kind: "loading" }
  | { kind: "ready"; callerRole: OrgRole }
  | { kind: "error"; message: string; status: number };

export default function OrganizationAdminRolesPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <RolesTab />
    </PageRouteGate>
  );
}

// A row of the capability matrix — one capability, plus every role's level.
type CapabilityRow = (typeof CAPABILITY_DEFS)[number];

function RolesTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  const [caller, setCaller] = useState<CallerState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!orgId) return;
    setCaller({ kind: "loading" });
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}`)) as OrgResponse;
      setCaller({ kind: "ready", callerRole: data.callerRole });
    } catch (err) {
      if (err instanceof ApiError) {
        setCaller({
          kind: "error",
          message: toSafeUserError(err, { message: "Failed to load." }).message,
          status: err.statusCode ?? 0,
        });
      } else {
        setCaller({
          kind: "error",
          message: toSafeUserError(err, { message: "Failed to load." }).message,
          status: 0,
        });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const callerRole = caller.kind === "ready" ? caller.callerRole : null;
  const callerCanAssign = callerRole !== null && canManageMembers(callerRole);

  // Capability matrix columns: leading capability description + one column per
  // built-in org role. Data + testids are unchanged; only the rendering moves
  // to the shared DataTable primitive.
  const matrixColumns: DataTableColumn<CapabilityRow>[] = [
    {
      key: "capability",
      header: "Capability",
      render: (cap) => (
        <div data-capability={cap.key}>
          <div style={{ fontWeight: 600 }}>{cap.label}</div>
          <div
            style={{ fontSize: 11.5, color: "var(--ink-muted, #94a3b8)", marginTop: 2 }}
          >
            {cap.description}
          </div>
        </div>
      ),
    },
    ...ALL_ORG_ROLES.map<DataTableColumn<CapabilityRow>>((role) => ({
      key: role,
      header: (
        <span data-role-col={role}>{ORG_ROLE_LABEL[role]}</span>
      ),
      align: "center",
      nowrap: true,
      render: (cap) => {
        const level = ROLE_CAPABILITIES[role][cap.key];
        return (
          <span
            data-cell-role={role}
            data-cell-capability={cap.key}
            data-access-level={level}
          >
            <AccessBadge level={level} />
          </span>
        );
      },
    })),
  ];

  return (
    <section
      data-testid="org-admin-roles"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      {/* ------------------- INTRO ------------------- */}
      <Card
        variant="admin"
        data-section="roles-intro"
        title="Roles & permissions"
      >
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          Organizations have six built-in roles. Roles are fixed — there are no
          custom roles. Each role grants a set of org-scope capabilities;
          evidence and reports stay workspace-scoped and are never granted by an
          org role.
        </p>
        {caller.kind === "ready" ? (
          <p
            data-testid="roles-caller-role"
            data-caller-role={caller.callerRole}
            style={{ fontSize: 13.5, marginTop: 10, color: "var(--ink-primary, #0f172a)" }}
          >
            Your role:{" "}
            <strong>{ORG_ROLE_LABEL[caller.callerRole]}</strong>
            {callerCanAssign ? (
              <>
                {" · "}
                <Link
                  href={`/organizations/${orgId}/admin/members`}
                  data-testid="roles-assign-link"
                >
                  Assign roles on the Members tab →
                </Link>
              </>
            ) : (
              <span style={{ color: "var(--ink-muted, #94a3b8)" }}>
                {" "}
                · Role assignment requires an organization admin.
              </span>
            )}
          </p>
        ) : caller.kind === "error" ? (
          <p
            data-state="error"
            role="alert"
            style={{ fontSize: 13.5, marginTop: 10, color: "var(--status-risk-fg, #991b1b)" }}
          >
            {caller.status === 403
              ? "You don't have access to this organization."
              : caller.message}
          </p>
        ) : null}
      </Card>

      {/* ------------------- ROLE SUMMARIES ------------------- */}
      <PageSection
        data-section="role-summaries"
        title="What each role is for"
      >
        <Card variant="summary" padding="none">
          <ul
            data-testid="role-summary-list"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {ALL_ORG_ROLES.map((role) => (
              <li
                key={role}
                data-role={role}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 13.5,
                    minWidth: 150,
                    color: "var(--ink-primary, #0f172a)",
                  }}
                >
                  {ORG_ROLE_LABEL[role]}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink-secondary, #475569)",
                    flex: "1 1 240px",
                  }}
                >
                  {ORG_ROLE_SUMMARY[role]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </PageSection>

      {/* ------------------- CAPABILITY MATRIX ------------------- */}
      <PageSection
        data-section="role-capability-matrix"
        title="Capability matrix"
        description="Manage = can change it · Read = can view only · — = no org-scope access. Reflects the permission gates the backend enforces."
      >
        <div data-testid="role-capability-matrix">
          <DataTable<CapabilityRow>
            columns={matrixColumns}
            rows={CAPABILITY_DEFS as unknown as CapabilityRow[]}
            getRowId={(cap) => cap.key}
            density="compact"
            ariaLabel="Role capability matrix"
          />
        </div>
      </PageSection>
    </section>
  );
}

function AccessBadge({ level }: { level: AccessLevel }) {
  if (level === "NONE") {
    return (
      <span aria-label="No access" style={{ color: "var(--ink-muted, #94a3b8)" }}>
        —
      </span>
    );
  }
  const isManage = level === "MANAGE";
  return (
    <Badge tone={isManage ? "governance" : "neutral"} subtle>
      {isManage ? "Manage" : "Read"}
    </Badge>
  );
}
