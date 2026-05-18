/**
 * Phase 17 — Enterprise Identity & Access Platform canonical types.
 *
 * Provider-agnostic, framework-agnostic primitives for:
 *   - TeamMember lifecycle (ACTIVE/SUSPENDED/REVOKED)
 *   - Capability grants (additive per-member permission grants)
 *   - Delegated administration scopes (governance / review /
 *     intelligence / integrations / collaboration / identity / retention)
 *   - Access reviews (periodic and triggered)
 *   - Organization security policy shape
 *   - External identity provider (SSO/SCIM-readiness)
 *   - Permission audit event names (a strict subset of
 *     SecurityEventType that is dedicated to access decisions)
 *
 * Privacy rule: every type here is workspace-internal. Public verify,
 * OTS, anchor, report-v2, and verification package paths NEVER touch
 * these types or any data shaped by them.
 *
 * Hard invariants (enforced by the service layer; this module is the
 * authoritative canonical typing, not the enforcement point):
 *   - Elevated access NEVER bypasses governance.
 *   - Permission failures fail CLOSED.
 *   - A capability grant on a SUSPENDED / REVOKED member has no effect.
 *   - An expired or revoked capability grant has no effect.
 *   - Delegated admin scopes are additive — they NEVER widen access
 *     beyond the underlying canonical role floor + the named scope.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Member lifecycle
// -----------------------------------------------------------------------------

export const TEAM_MEMBER_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;
export const TeamMemberStatusSchema = z.enum(TEAM_MEMBER_STATUSES);
export type TeamMemberStatus = z.infer<typeof TeamMemberStatusSchema>;

const ACTIVE_MEMBER_STATUSES: ReadonlyArray<TeamMemberStatus> = ["ACTIVE"];

/**
 * Returns true iff the membership status allows authenticated access at
 * all. SUSPENDED and REVOKED both deny — the difference is operator
 * intent (suspended = pausable, revoked = permanent).
 */
export function teamMemberStatusGrantsAccess(
  status: TeamMemberStatus | null | undefined,
): boolean {
  if (!status) return false;
  return ACTIVE_MEMBER_STATUSES.includes(status);
}

// Allowed lifecycle transitions. ACTIVE → SUSPENDED → ACTIVE is a
// reversible pause; → REVOKED is terminal (no transition back). The
// service layer must reject anything else.
const TEAM_MEMBER_TRANSITIONS: Readonly<
  Record<TeamMemberStatus, ReadonlyArray<TeamMemberStatus>>
> = {
  ACTIVE: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
};

export function isAllowedTeamMemberStatusTransition(
  from: TeamMemberStatus,
  to: TeamMemberStatus,
): boolean {
  return TEAM_MEMBER_TRANSITIONS[from].includes(to);
}

export function listAllowedTeamMemberStatusTransitions(
  from: TeamMemberStatus,
): ReadonlyArray<TeamMemberStatus> {
  return TEAM_MEMBER_TRANSITIONS[from];
}

// -----------------------------------------------------------------------------
// Delegated admin scopes
// -----------------------------------------------------------------------------

export const DELEGATED_ADMIN_SCOPE_KINDS = [
  "GOVERNANCE_ADMIN",
  "REVIEW_ADMIN",
  "INTELLIGENCE_ADMIN",
  "INTEGRATION_ADMIN",
  "COLLABORATION_ADMIN",
  "IDENTITY_ADMIN",
  "RETENTION_ADMIN",
] as const;
export const DelegatedAdminScopeKindSchema = z.enum(
  DELEGATED_ADMIN_SCOPE_KINDS,
);
export type DelegatedAdminScopeKind = z.infer<
  typeof DelegatedAdminScopeKindSchema
>;

/**
 * Canonical permission families granted by each delegated admin scope.
 * Used by the access policy engine to union scope-granted permissions
 * on top of the role floor. The values are permission STRINGS to keep
 * this module free of Permission type circularity — the access-policy
 * engine narrows them when checking against the canonical catalog.
 */
const DELEGATED_ADMIN_SCOPE_PERMISSIONS: Readonly<
  Record<DelegatedAdminScopeKind, ReadonlyArray<string>>
> = {
  GOVERNANCE_ADMIN: [
    "governance.policy.read",
    "governance.policy.manage",
    "governance.legal_hold.manage",
    "governance.retention.manage",
    "audit.read",
    "audit.export",
    "publication.public_verify.gate",
    "retention.read",
    "retention.configure",
  ],
  REVIEW_ADMIN: [
    "review.queue.read",
    "review.assign",
    "review.decide",
    "review.escalate",
    "review.reopen",
    "review.sla.configure",
  ],
  INTELLIGENCE_ADMIN: [
    "intelligence.read",
    "intelligence.run",
    "intelligence.feedback.write",
    "intelligence.policy.manage",
  ],
  INTEGRATION_ADMIN: [
    "integration.api_key.manage",
    "integration.webhook.manage",
    "integration.evidence.read",
    "integration.evidence.create",
    "integration.intake_link.create",
    "integration.evidence_request.create",
    "integration.evidence_request.read",
    "identity.service_account.manage",
    "identity.service_account.disable",
  ],
  COLLABORATION_ADMIN: [
    "collaboration.thread.read",
    "collaboration.thread.create",
    "collaboration.message.post",
    "collaboration.thread.resolve",
    "collaboration.thread.reopen",
    "collaboration.thread.escalate",
    "collaboration.contributor.access.manage",
  ],
  IDENTITY_ADMIN: [
    "identity.member.read",
    "identity.member.invite",
    "identity.member.role.change",
    "identity.member.suspend",
    "identity.member.revoke",
    "identity.member.restore",
    "identity.capability.grant",
    "identity.capability.revoke",
    "identity.delegated_admin.grant",
    "identity.delegated_admin.revoke",
    "identity.service_account.manage",
    "identity.service_account.disable",
    "identity.contributor_session.revoke",
    "identity.org_policy.read",
    "identity.org_policy.manage",
    "identity.access_review.read",
    "identity.access_review.action",
    "identity.external_mapping.read",
    "identity.external_mapping.manage",
  ],
  RETENTION_ADMIN: [
    "governance.retention.manage",
    "retention.read",
    "retention.configure",
  ],
};

export function listPermissionsForDelegatedAdminScope(
  scope: DelegatedAdminScopeKind,
): ReadonlyArray<string> {
  return DELEGATED_ADMIN_SCOPE_PERMISSIONS[scope];
}

// -----------------------------------------------------------------------------
// Access review
// -----------------------------------------------------------------------------

export const ACCESS_REVIEW_KINDS = [
  "PERIODIC_MEMBER_REVIEW",
  "STALE_ACCESS",
  "UNUSED_SERVICE_ACCOUNT",
  "EXPIRING_TEMPORARY_ACCESS",
  "SUSPICIOUS_ACCESS_PATTERN",
  "EMERGENCY_REVOCATION_FOLLOWUP",
] as const;
export const AccessReviewKindSchema = z.enum(ACCESS_REVIEW_KINDS);
export type AccessReviewKind = z.infer<typeof AccessReviewKindSchema>;

export const ACCESS_REVIEW_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED_KEEP",
  "COMPLETED_REVOKED",
  "COMPLETED_SUSPENDED",
  "COMPLETED_NO_ACTION",
  "CANCELLED",
] as const;
export const AccessReviewStatusSchema = z.enum(ACCESS_REVIEW_STATUSES);
export type AccessReviewStatus = z.infer<typeof AccessReviewStatusSchema>;

const ACCESS_REVIEW_TERMINAL: ReadonlyArray<AccessReviewStatus> = [
  "COMPLETED_KEEP",
  "COMPLETED_REVOKED",
  "COMPLETED_SUSPENDED",
  "COMPLETED_NO_ACTION",
  "CANCELLED",
];

export function isTerminalAccessReviewStatus(
  status: AccessReviewStatus,
): boolean {
  return ACCESS_REVIEW_TERMINAL.includes(status);
}

const ACCESS_REVIEW_TRANSITIONS: Readonly<
  Record<AccessReviewStatus, ReadonlyArray<AccessReviewStatus>>
> = {
  PENDING: [
    "IN_PROGRESS",
    "COMPLETED_KEEP",
    "COMPLETED_REVOKED",
    "COMPLETED_SUSPENDED",
    "COMPLETED_NO_ACTION",
    "CANCELLED",
  ],
  IN_PROGRESS: [
    "COMPLETED_KEEP",
    "COMPLETED_REVOKED",
    "COMPLETED_SUSPENDED",
    "COMPLETED_NO_ACTION",
    "CANCELLED",
  ],
  COMPLETED_KEEP: [],
  COMPLETED_REVOKED: [],
  COMPLETED_SUSPENDED: [],
  COMPLETED_NO_ACTION: [],
  CANCELLED: [],
};

export function isAllowedAccessReviewTransition(
  from: AccessReviewStatus,
  to: AccessReviewStatus,
): boolean {
  return ACCESS_REVIEW_TRANSITIONS[from].includes(to);
}

export const ACCESS_REVIEW_SUBJECT_KINDS = [
  "TEAM_MEMBER",
  "SERVICE_ACCOUNT",
  "CONTRIBUTOR_SESSION",
] as const;
export const AccessReviewSubjectKindSchema = z.enum(
  ACCESS_REVIEW_SUBJECT_KINDS,
);
export type AccessReviewSubjectKind = z.infer<
  typeof AccessReviewSubjectKindSchema
>;

// Default thresholds for queue generation. The access-review service
// uses these to decide what to queue; operators may override per-team
// in a later phase (no override surface in Phase 17).
export const STALE_ACCESS_DAYS_DEFAULT = 90;
export const UNUSED_SERVICE_ACCOUNT_DAYS_DEFAULT = 60;
export const EXPIRING_ACCESS_WINDOW_DAYS_DEFAULT = 14;

// -----------------------------------------------------------------------------
// External identity provider (SSO/SCIM-readiness)
// -----------------------------------------------------------------------------

export const EXTERNAL_IDENTITY_PROVIDERS = [
  "GENERIC_SAML",
  "GENERIC_OIDC",
  "GENERIC_SCIM",
  "OKTA",
  "AZURE_AD",
  "GOOGLE_WORKSPACE",
] as const;
export const ExternalIdentityProviderSchema = z.enum(
  EXTERNAL_IDENTITY_PROVIDERS,
);
export type ExternalIdentityProvider = z.infer<
  typeof ExternalIdentityProviderSchema
>;

// -----------------------------------------------------------------------------
// Organization security policy
// -----------------------------------------------------------------------------

/**
 * Org security policy shape. mfaRequiredFlag / ssoReadyFlag /
 * scimReadyFlag are readiness flags only in Phase 17 — no protocol
 * enforcement. allowedEmailDomains / restrictedIpRanges / session
 * timeouts ARE enforced.
 */
export const OrgSecurityPolicySchema = z.object({
  mfaRequiredFlag: z.boolean().default(false),
  allowedEmailDomains: z.array(z.string().min(1).max(253)).default([]),
  restrictedIpRanges: z.array(z.string().min(1).max(64)).default([]),
  reviewerSessionTimeoutSeconds: z.number().int().positive().max(86_400).nullable().default(null),
  contributorSessionTimeoutSeconds: z.number().int().positive().max(86_400).nullable().default(null),
  ssoReadyFlag: z.boolean().default(false),
  scimReadyFlag: z.boolean().default(false),
  notes: z.string().max(2000).nullable().default(null),
});
export type OrgSecurityPolicy = z.infer<typeof OrgSecurityPolicySchema>;

export const ORG_SECURITY_POLICY_DEFAULTS: OrgSecurityPolicy = {
  mfaRequiredFlag: false,
  allowedEmailDomains: [],
  restrictedIpRanges: [],
  reviewerSessionTimeoutSeconds: null,
  contributorSessionTimeoutSeconds: null,
  ssoReadyFlag: false,
  scimReadyFlag: false,
  notes: null,
};

// Email-domain match — case-insensitive on host, exact match (no
// wildcard yet). An empty allow-list ALWAYS allows.
export function isEmailDomainAllowed(
  email: string,
  allowList: ReadonlyArray<string>,
): boolean {
  if (allowList.length === 0) return true;
  const at = email.indexOf("@");
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase().trim();
  if (host.length === 0) return false;
  return allowList.some((d) => d.toLowerCase().trim() === host);
}

// CIDR-allowlist match — pure helper. CIDR notation is "a.b.c.d/N" for
// IPv4 only in Phase 17 (IPv6 placeholder: matches literal address only
// when the allowlist entry equals the address). An empty allow-list
// ALWAYS allows. Returns false on malformed input (fail-closed).
export function isIpAddressAllowed(
  address: string,
  cidrAllowList: ReadonlyArray<string>,
): boolean {
  if (cidrAllowList.length === 0) return true;
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  for (const cidr of cidrAllowList) {
    if (matchesCidr(trimmed, cidr.trim())) return true;
  }
  return false;
}

function matchesCidr(address: string, cidr: string): boolean {
  if (cidr.length === 0) return false;
  // Exact-match shortcut (covers IPv6 + non-CIDR entries).
  if (cidr === address) return true;
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const network = cidr.slice(0, slash);
  const bitsRaw = cidr.slice(slash + 1);
  const bits = Number.parseInt(bitsRaw, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(address);
  const n = ipv4ToInt(network);
  if (a === null || n === null) return false;
  if (bits === 0) return true;
  // Build the mask using BigInt to avoid the 32-bit signed-int sign-bit
  // trap when bits === 32 (1 << 32 wraps to 0 in JS Number).
  const mask = Number((0xffffffffn << BigInt(32 - bits)) & 0xffffffffn);
  return (a & mask) === (n & mask);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc;
}

// -----------------------------------------------------------------------------
// Permission audit events
//
// A strict subset of SecurityEventType that the RBAC + access-policy
// services emit. Listed here so any module can statically refer to the
// audit-event name without having to import the security catalog.
// -----------------------------------------------------------------------------

export const PERMISSION_AUDIT_EVENT_TYPES = [
  "MEMBER_INVITED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_SUSPENDED",
  "MEMBER_REVOKED",
  "MEMBER_RESTORED",
  "CAPABILITY_GRANTED",
  "CAPABILITY_REVOKED",
  "DELEGATED_ADMIN_GRANTED",
  "DELEGATED_ADMIN_REVOKED",
  "SERVICE_ACCOUNT_DISABLED",
  "SERVICE_ACCOUNT_ROTATED",
  "CONTRIBUTOR_SESSION_REVOKED",
  "ORG_SECURITY_POLICY_UPDATED",
  "ACCESS_REVIEW_INITIATED",
  "ACCESS_REVIEW_COMPLETED",
  "EXTERNAL_IDENTITY_LINKED",
  "EXTERNAL_IDENTITY_UNLINKED",
  "PERMISSION_DENIED",
] as const;
export const PermissionAuditEventTypeSchema = z.enum(
  PERMISSION_AUDIT_EVENT_TYPES,
);
export type PermissionAuditEventType = z.infer<
  typeof PermissionAuditEventTypeSchema
>;
