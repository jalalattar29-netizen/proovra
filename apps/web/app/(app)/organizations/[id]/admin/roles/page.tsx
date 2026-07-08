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
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
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

  return (
    <section data-testid="org-admin-roles" data-org-id={orgId}>
      <section
        data-section="roles-intro"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Roles &amp; permissions</h2>
        <p style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
          Organizations have six built-in roles. Roles are fixed — there are no
          custom roles. Each role grants a set of org-scope capabilities;
          evidence and reports stay workspace-scoped and are never granted by an
          org role.
        </p>
        {caller.kind === "ready" ? (
          <p
            data-testid="roles-caller-role"
            data-caller-role={caller.callerRole}
            style={{ fontSize: 13, marginTop: 6 }}
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
              <span style={{ opacity: 0.7 }}>
                {" "}
                · Role assignment requires an organization admin.
              </span>
            )}
          </p>
        ) : caller.kind === "error" ? (
          <p data-state="error" role="alert" style={{ fontSize: 13 }}>
            {caller.status === 403
              ? "You don't have access to this organization."
              : caller.message}
          </p>
        ) : null}
      </section>

      {/* ------------------- ROLE SUMMARIES ------------------- */}
      <section
        data-section="role-summaries"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15 }}>What each role is for</h3>
        <ul
          data-testid="role-summary-list"
          style={{ listStyle: "none", padding: 0, margin: "0.6rem 0 0" }}
        >
          {ALL_ORG_ROLES.map((role) => (
            <li
              key={role}
              data-role={role}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid rgba(127,127,127,0.18)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  minWidth: 130,
                }}
              >
                {ORG_ROLE_LABEL[role]}
              </span>
              <span style={{ fontSize: 13, opacity: 0.85, flex: "1 1 240px" }}>
                {ORG_ROLE_SUMMARY[role]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------- CAPABILITY MATRIX ------------------- */}
      <section
        data-section="role-capability-matrix"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15 }}>Capability matrix</h3>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          Manage = can change it · Read = can view only · — = no org-scope
          access. Reflects the permission gates the backend enforces.
        </p>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table
            data-testid="role-capability-matrix"
            style={{
              borderCollapse: "collapse",
              width: "100%",
              fontSize: 12,
            }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: "left",
                    padding: "6px 8px",
                    borderBottom: "1px solid rgba(127,127,127,0.3)",
                    whiteSpace: "nowrap",
                  }}
                >
                  Capability
                </th>
                {ALL_ORG_ROLES.map((role) => (
                  <th
                    key={role}
                    data-role-col={role}
                    style={{
                      textAlign: "center",
                      padding: "6px 8px",
                      borderBottom: "1px solid rgba(127,127,127,0.3)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ORG_ROLE_LABEL[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_DEFS.map((cap) => (
                <tr key={cap.key} data-capability={cap.key}>
                  <td
                    style={{
                      padding: "6px 8px",
                      borderBottom: "1px solid rgba(127,127,127,0.14)",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{cap.label}</div>
                    <div style={{ opacity: 0.65, fontSize: 11 }}>
                      {cap.description}
                    </div>
                  </td>
                  {ALL_ORG_ROLES.map((role) => {
                    const level = ROLE_CAPABILITIES[role][cap.key];
                    return (
                      <td
                        key={role}
                        data-cell-role={role}
                        data-cell-capability={cap.key}
                        data-access-level={level}
                        style={{
                          textAlign: "center",
                          padding: "6px 8px",
                          borderBottom: "1px solid rgba(127,127,127,0.14)",
                        }}
                      >
                        <AccessBadge level={level} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function AccessBadge({ level }: { level: AccessLevel }) {
  if (level === "NONE") {
    return (
      <span aria-label="No access" style={{ opacity: 0.4 }}>
        —
      </span>
    );
  }
  const isManage = level === "MANAGE";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        border: `1px solid ${isManage ? "#3e6063" : "rgba(127,127,127,0.5)"}`,
        color: isManage ? "#2f4f52" : "inherit",
        background: isManage ? "rgba(62,96,99,0.1)" : "transparent",
      }}
    >
      {isManage ? "Manage" : "Read"}
    </span>
  );
}
