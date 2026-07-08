/**
 * Phase 4 (Enterprise Administration) — canonical ORG-role reference model.
 *
 * SINGLE SOURCE OF TRUTH (web side) for the six organization roles and what
 * each one can do. This is a *reference*, not a policy engine: the backend
 * (`services/api/src/routes/organizations.routes.ts` + `checkOrgAccess`) is
 * the enforcement point. Every capability statement here is sourced from real
 * backend behaviour, cited inline, so the reference never drifts into fiction:
 *
 *   - The role set + precedence ranks mirror `enum OrganizationRole`
 *     (services/api/prisma/schema.prisma) and the route-layer precedence
 *     block (organizations.routes.ts "Role precedence:" comment).
 *   - The capability rows mirror the `minRole` gates the org endpoints
 *     actually enforce (members mutate = ORG_ADMIN+, billing/seat visibility
 *     = ORG_OWNER/ADMIN/BILLING_ADMIN via GET /v1/orgs/:id/workspaces, audit
 *     read = any member, etc.).
 *
 * NO CUSTOM ROLES. The org model does not support them; this reference must
 * only ever describe the six built-in roles.
 */

export type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

/** Display order — highest authority first. */
export const ALL_ORG_ROLES: ReadonlyArray<OrgRole> = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
];

/**
 * Precedence ranks — mirror the route-layer precedence block in
 * organizations.routes.ts. ORG_SECURITY_ADMIN and ORG_BILLING_ADMIN
 * deliberately share rank 3 (peer specialists below full admin).
 */
export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

/** One-line role summary, sourced from the `enum OrganizationRole` doc-comments. */
export const ORG_ROLE_SUMMARY: Record<OrgRole, string> = {
  ORG_OWNER:
    "Single owner per org. Can transfer ownership. Highest authority.",
  ORG_ADMIN:
    "Full admin below ownership. Manages memberships, policies, workspace attachment, and billing.",
  ORG_SECURITY_ADMIN:
    "Manages SAML / SCIM / MFA policy at the org level. Does not manage workspaces or billing.",
  ORG_BILLING_ADMIN:
    "Manages the billing relationship and seat caps. Does not manage workspaces or security.",
  ORG_AUDITOR:
    "Read-only auditor. Sees access reviews, audit log, and the workspace directory. Cannot mutate anything.",
  ORG_MEMBER:
    "Default membership. Belongs to the org with no special org privilege. Workspace privileges are managed separately.",
};

/**
 * The capability domains an org role can touch. Each row maps a domain to the
 * access level a given role has AT ORG SCOPE. Values are grounded in the
 * `minRole` gates enforced by the canonical org endpoints — see the `evidence`
 * field for the backing route/enforcement.
 */
export type Capability =
  | "members" // manage org memberships + invites
  | "roles" // assign / change org roles
  | "identity" // SAML / SCIM / MFA / domain policy
  | "billing" // seats + billing relationship
  | "workspaces" // attach / detach workspaces to the org
  | "governance" // org policy posture, retention, access reviews
  | "audit" // org audit timeline + transparency
  | "evidence"; // workspace-scoped evidence (org roles never grant this)

export type AccessLevel = "MANAGE" | "READ" | "NONE";

export interface CapabilityDef {
  key: Capability;
  label: string;
  /** What "MANAGE" vs "READ" concretely means for this domain. */
  description: string;
  /** Which real backend surface backs this row (citation, not a URL). */
  evidence: string;
}

export const CAPABILITY_DEFS: ReadonlyArray<CapabilityDef> = [
  {
    key: "members",
    label: "Members & invites",
    description:
      "Invite, resend, revoke, remove members and change their org role.",
    evidence:
      "PATCH/DELETE /v1/orgs/:id/members + POST /v1/orgs/:id/invites (minRole: ORG_ADMIN).",
  },
  {
    key: "roles",
    label: "Role assignment",
    description:
      "Change a member's org role, respecting owner-only and last-owner rules.",
    evidence:
      "PATCH /v1/orgs/:id/members/:memberId (minRole: ORG_ADMIN; owner changes require ORG_OWNER).",
  },
  {
    key: "identity",
    label: "Identity & SSO",
    description: "SAML / SCIM / MFA policy and verified email domains.",
    evidence:
      "organization-domains.routes.ts + admin/identity (ORG_SECURITY_ADMIN / ORG_ADMIN).",
  },
  {
    key: "billing",
    label: "Billing & seats",
    description: "Seat caps, billing plan and status, billing owner.",
    evidence:
      "GET /v1/orgs/:id/workspaces billing fields (ORG_OWNER / ORG_ADMIN / ORG_BILLING_ADMIN).",
  },
  {
    key: "workspaces",
    label: "Workspaces",
    description: "Attach and detach workspaces (teams) to the organization.",
    evidence: "Org workspace-attachment surface (ORG_ADMIN+).",
  },
  {
    key: "governance",
    label: "Governance & reviews",
    description:
      "Policy posture, retention / legal hold, and access-review campaigns.",
    evidence:
      "Org governance / access-review tabs (mutation ORG_ADMIN+; read for auditors).",
  },
  {
    key: "audit",
    label: "Audit timeline",
    description: "Read the org governance audit log.",
    evidence: "GET /v1/orgs/:id/audit-events (any org member).",
  },
  {
    key: "evidence",
    label: "Evidence & reports",
    description:
      "Evidence and reports are WORKSPACE-scoped. Org roles never grant evidence access.",
    evidence:
      "Org endpoints deliberately omit evidence/case aggregates (organizations.routes.ts hard rule).",
  },
];

/**
 * Role → capability matrix. Grounded in the enforced `minRole` gates:
 *   - MANAGE: the role can mutate this domain at org scope.
 *   - READ:   the role can view but not mutate.
 *   - NONE:   the role has no org-scope access to this domain.
 *
 * Note `evidence` is NONE for every org role by design — evidence access is
 * granted only by workspace (Team) membership, never by an org role.
 */
export const ROLE_CAPABILITIES: Record<
  OrgRole,
  Record<Capability, AccessLevel>
> = {
  ORG_OWNER: {
    members: "MANAGE",
    roles: "MANAGE",
    identity: "MANAGE",
    billing: "MANAGE",
    workspaces: "MANAGE",
    governance: "MANAGE",
    audit: "READ",
    evidence: "NONE",
  },
  ORG_ADMIN: {
    members: "MANAGE",
    roles: "MANAGE",
    identity: "MANAGE",
    billing: "MANAGE",
    workspaces: "MANAGE",
    governance: "MANAGE",
    audit: "READ",
    evidence: "NONE",
  },
  ORG_SECURITY_ADMIN: {
    members: "READ",
    roles: "NONE",
    identity: "MANAGE",
    billing: "NONE",
    workspaces: "READ",
    governance: "READ",
    audit: "READ",
    evidence: "NONE",
  },
  ORG_BILLING_ADMIN: {
    members: "READ",
    roles: "NONE",
    identity: "NONE",
    billing: "MANAGE",
    workspaces: "READ",
    governance: "READ",
    audit: "READ",
    evidence: "NONE",
  },
  ORG_AUDITOR: {
    members: "READ",
    roles: "NONE",
    identity: "READ",
    billing: "READ",
    workspaces: "READ",
    governance: "READ",
    audit: "READ",
    evidence: "NONE",
  },
  ORG_MEMBER: {
    members: "NONE",
    roles: "NONE",
    identity: "NONE",
    billing: "NONE",
    workspaces: "READ",
    governance: "NONE",
    audit: "READ",
    evidence: "NONE",
  },
};

/** True when `role` outranks or equals `minRole` in the precedence ladder. */
export function roleMeetsMin(role: OrgRole, minRole: OrgRole): boolean {
  return ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[minRole];
}

/** Roles that can mutate org memberships (invite / role-change / remove). */
export function canManageMembers(role: OrgRole): boolean {
  return roleMeetsMin(role, "ORG_ADMIN");
}
