/**
 * The workspace role → capability matrix served by `GET /v1/platform/rbac/matrix`
 * (Settings → Roles, the team permission matrix).
 *
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * The route carried a hand-written `roles` list per row, and it drifted from the
 * enforcement authority: the page told a VIEWER they could "View billing +
 * seats" while `packages/shared/src/permissions.ts` gives VIEWER no
 * `billing.read`, so every billing read refused them. A matrix that says one
 * thing while the API does another is worse than no matrix.
 *
 * Every row now names the CANONICAL permission it describes, and its roles are
 * COMPUTED with `roleHasPermission` — the same predicate the routes enforce.
 * There is no per-row role list to drift. The only rows without a permission
 * are the ones whose authority is not a workspace-role permission at all; each
 * names that authority, and the test pins the exception list.
 */
import { roleHasPermission, type DbTeamRole, type Permission } from "@proovra/shared";

export const RBAC_MATRIX_ROLES: ReadonlyArray<{ id: DbTeamRole; label: string; rank: number }> = [
  { id: "OWNER", label: "Owner", rank: 3 },
  { id: "ADMIN", label: "Admin", rank: 2 },
  { id: "MEMBER", label: "Member", rank: 1 },
  { id: "VIEWER", label: "Viewer", rank: 0 },
];

type RowDefinition = {
  id: string;
  label: string;
  description: string;
} & (
  | { permission: Permission }
  | {
      permission: null;
      /** The authority that decides this row when it is not a role permission. */
      authority: string;
      roles: ReadonlyArray<DbTeamRole>;
    }
);

export type RbacMatrixCapability = {
  id: string;
  label: string;
  description: string;
  roles: DbTeamRole[];
  /** The canonical permission the roles were computed from (null: see `authority`). */
  permission: Permission | null;
  authority?: string;
};

const CATEGORIES: ReadonlyArray<{ id: string; label: string; capabilities: ReadonlyArray<RowDefinition> }> = [
  {
    id: "evidence",
    label: "Evidence",
    capabilities: [
      {
        id: "evidence.view",
        label: "View evidence",
        permission: "evidence.read",
        description: "Browse the workspace evidence library and open individual records.",
      },
      {
        id: "evidence.upload",
        label: "Upload + finalize evidence",
        permission: "evidence.create",
        description:
          "Create new evidence records via the capture flow, complete uploads, and finalize hash/signature pipeline.",
      },
      {
        id: "evidence.manage",
        label: "Manage evidence",
        permission: "evidence.update_metadata",
        description: "Edit titles, tags and descriptive metadata on records.",
      },
    ],
  },
  {
    id: "reports",
    label: "Reports & verification",
    capabilities: [
      {
        id: "report.generate",
        label: "Generate report snapshots",
        permission: "evidence.generate_report",
        description: "Trigger a new report version. Report contents are operator-only.",
      },
      {
        id: "report.download",
        label: "Download report / verification package",
        permission: "evidence.download_report",
        description:
          "Download the signed PDF / verification archive. Custody event written on every download.",
      },
    ],
  },
  {
    id: "cases",
    label: "Cases",
    capabilities: [
      {
        id: "case.view",
        label: "View cases",
        permission: "evidence.read",
        description:
          "Browse and open cases scoped to this workspace; see linked evidence and timeline.",
      },
      {
        id: "case.create",
        label: "Create cases",
        permission: "evidence.create",
        description: "Open new cases.",
      },
      {
        id: "case.manage",
        label: "Archive cases",
        permission: "evidence.archive",
        description: "Archive and restore cases and their records.",
      },
      {
        id: "case.assign_reviewers",
        label: "Assign reviewers",
        permission: "review.assign",
        description: "Assign / re-assign reviewers on a case.",
      },
    ],
  },
  {
    id: "reviewer",
    label: "Reviewer workflow",
    capabilities: [
      {
        id: "review.queue",
        label: "View review queue",
        permission: "review.queue.read",
        description: "See assigned reviews + workspace queue depth.",
      },
      {
        id: "review.action",
        label: "Approve / reject / pause / request-info",
        permission: "review.decide",
        description:
          "Drive a review through its lifecycle. Reason text required for non-approve actions.",
      },
      {
        id: "review.escalation",
        label: "Escalate reviews",
        permission: "review.escalate",
        description: "Raise a review to escalation.",
      },
    ],
  },
  {
    // Re-audit defect 17 (2026-10-25) — this category is about the WORKSPACE's
    // members. Its rows used to say "team" meaning workspace, cited a
    // workspace seat limit that no longer exists, and printed raw role enums
    // with a role-change rule the rank authority refuses. The copy below states
    // the rules rbac.service.ts (assertActorOutranks, the last-administrator
    // guard) and the invite route's role ceiling actually enforce. The row ids
    // stay as they are: they are identifiers, not copy.
    id: "team",
    label: "Members & access",
    capabilities: [
      {
        id: "team.invite",
        label: "Invite members",
        permission: "identity.member.invite",
        description:
          "Invite people to this workspace as an Admin, Member or Viewer, never above your own role and never as Owner. Your plan sets how many invitations can wait at once; capacity is counted per Collaboration Team, not as a workspace seat limit.",
      },
      {
        id: "team.role_change",
        label: "Change member role",
        permission: "identity.member.role.change",
        description:
          "The Owner can make any other member an Admin, Member or Viewer. An Admin can move only Members and Viewers between Member and Viewer, and cannot change another Admin or the Owner. Nobody changes their own role, the last administrator cannot be demoted, and ownership moves only by transfer. Step-up required.",
      },
      {
        id: "team.remove",
        label: "Remove members (with ownership transfer)",
        permission: "identity.member.revoke",
        description:
          "Remove someone from this workspace. The Owner cannot be removed, and an Admin can remove only Members and Viewers, not another Admin. Evidence and cases the person owns must be transferred to another active member first.",
      },
      {
        id: "team.external_revoke",
        label: "Revoke external access grants",
        permission: "identity.contributor_session.revoke",
        description:
          "Revoke case access granted to people outside this workspace, such as external contributors.",
      },
      {
        id: "team.delete",
        label: "End the workspace",
        permission: null,
        authority: "no self-service delete for any workspace kind; owned workspaces close through the step-up-protected closure request by the owner of record",
        roles: ["OWNER"],
        description: "A Personal Workspace ends with its account and an Organization Workspace through offboarding; nothing deletes a workspace from the product.",
      },
    ],
  },
  {
    id: "billing_security",
    label: "Billing & security",
    capabilities: [
      {
        id: "billing.view",
        label: "View billing + seats",
        permission: "billing.read",
        description: "See plan, seat usage, billing owner.",
      },
      {
        id: "billing.manage",
        label: "Change plan / manage subscription",
        permission: "billing.manage",
        description: "Upgrade, downgrade, cancel subscriptions; manage storage add-ons.",
      },
      {
        id: "security_center.view",
        label: "Open Security Center",
        permission: null,
        authority: "SECURITY_CENTER_VIEW capability (workspace OWNER / ADMIN)",
        roles: ["OWNER", "ADMIN"],
        description:
          "View workspace MFA policy, trusted devices, sessions, SAML config, SCIM tokens.",
      },
      {
        id: "security_center.manage",
        label: "Manage workspace MFA policy / SSO config",
        permission: "identity.org_policy.manage",
        description:
          "Change MFA enforcement level, manage SAML connections, revoke SCIM tokens. Step-up required.",
      },
    ],
  },
  {
    id: "audit",
    label: "Audit & activity",
    capabilities: [
      {
        id: "audit.workspace_activity",
        label: "View workspace activity feed",
        permission: "audit.read",
        description:
          "See member invitations, role changes, ownership transfers and policy changes recorded in the workspace activity log.",
      },
      {
        id: "audit.platform",
        label: "View platform audit log",
        permission: null,
        authority: "platform administrator (User.platformRole) — never a workspace role",
        roles: [],
        description: "Platform administrators only. No workspace role grants it.",
      },
    ],
  },
];

/** The served matrix. Roles of permission-backed rows are computed, never listed. */
export function buildRbacMatrix(): {
  roles: typeof RBAC_MATRIX_ROLES;
  categories: Array<{ id: string; label: string; capabilities: RbacMatrixCapability[] }>;
} {
  return {
    roles: RBAC_MATRIX_ROLES,
    categories: CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      capabilities: category.capabilities.map((row): RbacMatrixCapability => {
        if (row.permission === null) {
          return {
            id: row.id,
            label: row.label,
            description: row.description,
            permission: null,
            authority: row.authority,
            roles: [...row.roles],
          };
        }
        const permission = row.permission;
        return {
          id: row.id,
          label: row.label,
          description: row.description,
          permission,
          roles: RBAC_MATRIX_ROLES.map((r) => r.id).filter((role) =>
            roleHasPermission(role, permission),
          ),
        };
      }),
    })),
  };
}
