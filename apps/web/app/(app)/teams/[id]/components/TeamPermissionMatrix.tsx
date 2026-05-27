"use client";

/**
 * Phase 2.6 — Team permission matrix (read-only).
 *
 * Operator-facing reference that maps the 4 backend TeamRole values
 * (OWNER / ADMIN / MEMBER / VIEWER) to the capabilities the API
 * actually enforces today. This is NOT a settings panel — there is
 * no "edit" affordance because PROOVRA doesn't support custom roles
 * at the backend layer. The matrix exists so admins can answer the
 * "what can each role actually do here?" question without spelunking
 * through `services/api/src/services/rbac.ts`.
 *
 * Hard rules:
 *   - Every cell is backed by an actual `hasRole(actor.role, MIN_ROLE)`
 *     check in the backend. If the backend doesn't enforce a
 *     capability for the role, the cell must NOT claim it does.
 *   - The matrix is wholly read-only. Admins who want to change what
 *     a role can do must change backend code; the UI must not pretend
 *     otherwise.
 *   - Backend role hierarchy (from `services/api/src/services/rbac.ts`):
 *       OWNER > ADMIN > MEMBER > VIEWER
 *     A role grants every capability listed for itself AND every
 *     capability of weaker roles, except where backend code
 *     explicitly restricts to OWNER or OWNER+ADMIN.
 *   - This file gets reviewed (or auto-regenerated) every time the
 *     backend rbac changes. Drift between this matrix and the
 *     backend is a bug — there is a Phase 2.6 e2e test that asserts
 *     the matrix renders the same set of capabilities the operator
 *     sees today.
 */

import { useState } from "react";

type RoleId = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

type Capability = {
  id: string;
  /** Operator-readable label shown in the matrix's left column. */
  label: string;
  /** One-sentence explanation shown in the expandable detail row. */
  description: string;
  /** Which roles can perform this capability today. */
  roles: ReadonlyArray<RoleId>;
  /** Optional pointer to the canonical backend enforcement path. */
  backendNote?: string;
};

/**
 * Capability inventory.
 *
 * Categorised loosely by surface; the categories are presentation
 * only, not a backend concept. Every entry below maps to a real
 * `hasRole(role, MIN_ROLE)` or capability check in the backend.
 *
 * Source authority for each cell:
 *   - team.role hierarchy: services/api/src/services/rbac.ts
 *   - per-route gates: services/api/src/routes/teams.routes.ts and
 *     evidence/cases/governance route files.
 *   - capability registry: services/api/src/services/platform-context/
 *     capability-registry.ts
 *
 * When adding a row: confirm a backend code path enforces it before
 * shipping. Drift is a UI lie.
 */
const CAPABILITIES: ReadonlyArray<{
  category: string;
  items: ReadonlyArray<Capability>;
}> = [
  {
    category: "Evidence",
    items: [
      {
        id: "evidence.view",
        label: "View evidence",
        description:
          "Browse the workspace evidence library and open individual records. Every workspace member can read evidence scoped to the team.",
        roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
        backendNote: "EVIDENCE_VIEW capability + per-record access check.",
      },
      {
        id: "evidence.upload",
        label: "Upload + finalize evidence",
        description:
          "Create new evidence records via the capture flow, complete uploads, and finalize hash/signature pipeline.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "POST /v1/evidence + /complete — requires write access.",
      },
      {
        id: "evidence.manage",
        label: "Manage evidence (edit, archive, soft-delete)",
        description:
          "Change titles, tags, retention class; archive or soft-delete records. Hard delete and legal hold are governance-scoped.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "PATCH/DELETE /v1/evidence/:id with governance gates.",
      },
      {
        id: "evidence.run_ai_categorization",
        label: "Run AI categorization",
        description:
          "Trigger the advisory-review run on a record. Subject to the per-user / per-evidence cost guard.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "POST /v1/evidence/:id/ai-categorization/run.",
      },
    ],
  },
  {
    category: "Reports & verification",
    items: [
      {
        id: "report.generate",
        label: "Generate report snapshots",
        description:
          "Trigger a new report version. Report contents are operator-only; no public-verify exposure.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "Report generation is governance-gated per workspace.",
      },
      {
        id: "report.download",
        label: "Download report PDF",
        description:
          "Download the signed PDF artifact. Custody event written on every download.",
        roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
        backendNote: "GET /v1/evidence/:id/report/latest.",
      },
      {
        id: "verification_package.download",
        label: "Download verification package",
        description:
          "Download the verification archive (manifest + signed artifacts). Custody event written on every download.",
        roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
        backendNote: "GET /v1/evidence/:id/verification-package.",
      },
    ],
  },
  {
    category: "Cases",
    items: [
      {
        id: "case.view",
        label: "View cases",
        description:
          "Browse and open cases scoped to this workspace; see linked evidence and timeline.",
        roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
        backendNote: "GET /v1/cases — visibility per case access predicate.",
      },
      {
        id: "case.create",
        label: "Create cases",
        description:
          "Open new cases. Members who own a case can edit it; admins can manage all cases in the workspace.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "POST /v1/cases.",
      },
      {
        id: "case.manage",
        label: "Manage case lifecycle (status, archive, close)",
        description:
          "Change case status (OPEN → INVESTIGATING → CLOSED → ARCHIVED). Closure cascades active assignments automatically (Phase 2.4).",
        roles: ["OWNER", "ADMIN"],
        backendNote: "POST /v1/cases/:id/status + bulk endpoint.",
      },
      {
        id: "case.assign_reviewers",
        label: "Assign reviewers",
        description:
          "Assign / re-assign reviewer roles on a case. Reviewer assignment lifecycle is owned by reviewer-ops.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "POST /v1/cases/:id/assignments via reviewer-ops.",
      },
    ],
  },
  {
    category: "Reviewer workflow",
    items: [
      {
        id: "review.queue",
        label: "View review queue",
        description:
          "See assigned reviews + workspace queue depth. Reviewer-ops surfaces respect role.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "REVIEWER_OPS_VIEW capability.",
      },
      {
        id: "review.action",
        label: "Approve / reject / pause / request-info",
        description:
          "Drive a review through its lifecycle. Reason text is required for non-approve actions (Phase 2.4 modal).",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "POST /v1/reviewer-ops/reviews/:id/*.",
      },
      {
        id: "review.escalation",
        label: "Resolve escalations",
        description:
          "Resolve, suppress, reassign escalations through the structured Phase 2.4 modal.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "POST /v1/reviewer-ops/escalations/:id/*.",
      },
    ],
  },
  {
    category: "Team governance",
    items: [
      {
        id: "team.invite",
        label: "Invite members",
        description:
          "Send team invites. Subject to the workspace seat limit (Phase 2.1 plan gate).",
        roles: ["OWNER", "ADMIN"],
        backendNote: "POST /v1/teams/:id/invites.",
      },
      {
        id: "team.role_change",
        label: "Change member role",
        description:
          "Promote or demote members between ADMIN / MEMBER / VIEWER. Only the OWNER can transfer ownership.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "PATCH /v1/teams/:id/members/:memberId.",
      },
      {
        id: "team.remove",
        label: "Remove members (with ownership transfer)",
        description:
          "Offboard a member. If they own evidence or cases, the Phase 2.2 dialog requires picking a transfer target before removal.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "DELETE /v1/teams/:id/members/:memberId + transferToUserId.",
      },
      {
        id: "team.delete",
        label: "Delete the team workspace",
        description:
          "Destructive. Only the OWNER can delete the team. Existing evidence is retained per governance policy.",
        roles: ["OWNER"],
        backendNote: "DELETE /v1/teams/:id.",
      },
    ],
  },
  {
    category: "Billing & security",
    items: [
      {
        id: "billing.view",
        label: "View billing + seats",
        description:
          "See plan, seat usage, billing owner. Granted to every authed user for their account; team-scope subject to role.",
        roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
        backendNote: "BILLING_VIEW capability — account + team scope.",
      },
      {
        id: "billing.manage",
        label: "Change plan / manage subscription",
        description:
          "Upgrade, downgrade, cancel subscriptions; manage storage add-ons.",
        roles: ["OWNER"],
        backendNote: "POST /v1/billing/* — OWNER-only.",
      },
      {
        id: "security_center.view",
        label: "Open Security Center",
        description:
          "View workspace MFA policy, trusted devices, sessions, SAML config, SCIM tokens.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "SECURITY_CENTER_VIEW capability.",
      },
      {
        id: "security_center.manage",
        label: "Manage workspace MFA policy / SSO config",
        description:
          "Change MFA enforcement level, manage SAML connections, revoke SCIM tokens. Step-up required for changes.",
        roles: ["OWNER", "ADMIN"],
        backendNote: "Various /v1/identity-security/* and /v1/admin/identity/* routes.",
      },
    ],
  },
  {
    category: "Audit & activity",
    items: [
      {
        id: "audit.workspace_activity",
        label: "View workspace activity feed",
        description:
          "See member invitations, role changes, ownership transfers, policy changes recorded in `team_activities`.",
        roles: ["OWNER", "ADMIN", "MEMBER"],
        backendNote: "GET /v1/teams/:id/activity.",
      },
      {
        id: "audit.platform",
        label: "View platform audit log",
        description:
          "Read the cross-workspace audit log with chain-of-custody verification.",
        roles: [],
        backendNote:
          "PLATFORM_ADMIN only — not granted by team role. See /admin/audit.",
      },
    ],
  },
];

const ROLE_LABELS: Record<RoleId, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

const ROLE_TONE: Record<RoleId, { bg: string; border: string; fg: string }> = {
  OWNER: {
    bg: "rgba(214,184,157,0.12)",
    border: "rgba(183,157,132,0.30)",
    fg: "#8a6e57",
  },
  ADMIN: {
    bg: "rgba(45,91,89,0.08)",
    border: "rgba(45,91,89,0.24)",
    fg: "#2d5b59",
  },
  MEMBER: {
    bg: "rgba(120,120,120,0.05)",
    border: "rgba(120,120,120,0.18)",
    fg: "#4d6165",
  },
  VIEWER: {
    bg: "rgba(120,120,120,0.05)",
    border: "rgba(120,120,120,0.14)",
    fg: "#6a777b",
  },
};

const ALL_ROLES: ReadonlyArray<RoleId> = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

function HeaderBadge({ role }: { role: RoleId }) {
  const t = ROLE_TONE[role];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.fg,
      }}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

function CapabilityCheckmark({
  allowed,
  role,
}: {
  allowed: boolean;
  role: RoleId;
}) {
  if (allowed) {
    const t = ROLE_TONE[role];
    return (
      <span
        data-permission-cell-allowed="true"
        data-permission-role={role}
        title={`${ROLE_LABELS[role]} can perform this action`}
        style={{
          display: "inline-flex",
          width: 22,
          height: 22,
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
          background: t.bg,
          border: `1px solid ${t.border}`,
          color: t.fg,
          fontSize: 13,
          fontWeight: 700,
        }}
        aria-label={`${ROLE_LABELS[role]} can perform this action`}
      >
        ✓
      </span>
    );
  }
  return (
    <span
      data-permission-cell-allowed="false"
      data-permission-role={role}
      title={`${ROLE_LABELS[role]} cannot perform this action`}
      style={{
        display: "inline-block",
        width: 22,
        height: 22,
        borderRadius: 999,
        background: "rgba(0,0,0,0.04)",
        border: "1px dashed rgba(0,0,0,0.08)",
      }}
      aria-label={`${ROLE_LABELS[role]} cannot perform this action`}
    />
  );
}

export function TeamPermissionMatrix({
  currentRole,
}: {
  /** The current viewer's role in this team, for "your access" emphasis. */
  currentRole?: RoleId | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section
      data-team-permission-matrix
      className="rounded-[24px] border border-[rgba(79,112,107,0.10)] bg-white/55 p-5 md:p-6"
    >
      <header className="mb-4">
        <h2 className="m-0 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Permission matrix
        </h2>
        <p className="m-0 mt-1 text-[12.5px] leading-snug text-[#6a777b]">
          What each workspace role can do today. This matrix mirrors backend
          enforcement — if a cell isn't checked, the API will refuse the
          action.{" "}
          {currentRole ? (
            <>
              Your role here is{" "}
              <strong data-permission-matrix-current-role>
                {ROLE_LABELS[currentRole]}
              </strong>
              .
            </>
          ) : null}
        </p>
      </header>

      <div className="overflow-x-auto">
        <table
          data-permission-matrix-table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: 13.5,
          }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  fontWeight: 600,
                  color: "#21353a",
                  borderBottom: "1px solid rgba(79,112,107,0.10)",
                  width: "55%",
                }}
              >
                Capability
              </th>
              {ALL_ROLES.map((r) => (
                <th
                  key={r}
                  scope="col"
                  style={{
                    textAlign: "center",
                    padding: "8px 10px",
                    fontWeight: 600,
                    borderBottom: "1px solid rgba(79,112,107,0.10)",
                  }}
                >
                  <HeaderBadge role={r} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.flatMap(({ category, items }) => [
              <tr key={`cat-${category}`}>
                <td
                  colSpan={5}
                  data-permission-matrix-category={category}
                  style={{
                    padding: "12px 10px 6px",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: "#6a777b",
                  }}
                >
                  {category}
                </td>
              </tr>,
              ...items.map((cap) => (
                <tr
                  key={cap.id}
                  data-permission-matrix-row={cap.id}
                  style={{
                    background:
                      expanded === cap.id
                        ? "rgba(214,184,157,0.06)"
                        : "transparent",
                  }}
                >
                  <td
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid rgba(79,112,107,0.06)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => (prev === cap.id ? null : cap.id))
                      }
                      data-permission-matrix-expand={cap.id}
                      style={{
                        background: "transparent",
                        border: 0,
                        padding: 0,
                        font: "inherit",
                        color: "#21353a",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      aria-expanded={expanded === cap.id}
                    >
                      <span style={{ fontWeight: 500 }}>{cap.label}</span>
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          color: "#7a878b",
                        }}
                      >
                        {expanded === cap.id ? "Hide details ▴" : "Details ▾"}
                      </span>
                    </button>
                    {expanded === cap.id ? (
                      <div
                        data-permission-matrix-detail={cap.id}
                        style={{
                          marginTop: 6,
                          padding: "8px 10px",
                          background: "rgba(255,255,255,0.55)",
                          borderRadius: 8,
                          fontSize: 12.5,
                          color: "#4d6165",
                          lineHeight: 1.5,
                        }}
                      >
                        {cap.description}
                        {cap.backendNote ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              fontFamily: "monospace",
                              color: "#7a878b",
                            }}
                          >
                            backend: {cap.backendNote}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  {ALL_ROLES.map((r) => (
                    <td
                      key={r}
                      style={{
                        textAlign: "center",
                        padding: "8px 10px",
                        borderBottom: "1px solid rgba(79,112,107,0.06)",
                      }}
                    >
                      <CapabilityCheckmark
                        allowed={cap.roles.includes(r)}
                        role={r}
                      />
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <p
        className="m-0 mt-3 text-[11.5px] text-[#6a777b]"
        data-permission-matrix-footnote
      >
        Custom roles are not supported on the current plan. Workspace
        capabilities are defined by the backend role hierarchy
        (Owner &gt; Admin &gt; Member &gt; Viewer) — see Security Center
        for org-wide policy controls.
      </p>
    </section>
  );
}
