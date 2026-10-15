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
    id: "team",
    label: "Team governance",
    capabilities: [
      {
        id: "team.invite",
        label: "Invite members",
        permission: "identity.member.invite",
        description: "Send team invites. Subject to the workspace seat limit.",
      },
      {
        id: "team.role_change",
        label: "Change member role",
        permission: "identity.member.role.change",
        description: "Promote or demote between ADMIN / MEMBER / VIEWER.",
      },
      {
        id: "team.remove",
        label: "Remove members (with ownership transfer)",
        permission: "identity.member.revoke",
        description: "Offboard a member. Owned evidence / cases must be transferred first.",
      },
      {
        id: "team.external_revoke",
        label: "Revoke external access grants",
        permission: "identity.contributor_session.revoke",
        description:
          "Revoke non-team-member access grants on the workspace's cases (Phase 2.6D).",
      },
      {
        id: "team.delete",
        label: "Delete the team workspace",
        permission: null,
        authority: "workspace owner of record (Team.ownerUserId), with step-up",
        roles: ["OWNER"],
        description: "Destructive. Only the OWNER can delete the team.",
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
          "See member invitations, role changes, ownership transfers, policy changes recorded in `team_activities`.",
      },
      {
        id: "audit.platform",
        label: "View platform audit log",
        permission: null,
        authority: "platform administrator (User.platformRole) — never a workspace role",
        roles: [],
        description: "PLATFORM_ADMIN only — not granted by team role.",
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
