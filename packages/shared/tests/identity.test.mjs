import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_REVIEW_KINDS,
  ACCESS_REVIEW_STATUSES,
  ACCESS_REVIEW_SUBJECT_KINDS,
  DELEGATED_ADMIN_SCOPE_KINDS,
  EXTERNAL_IDENTITY_PROVIDERS,
  ORG_SECURITY_POLICY_DEFAULTS,
  OrgSecurityPolicySchema,
  PERMISSION_AUDIT_EVENT_TYPES,
  PERMISSIONS,
  TEAM_MEMBER_STATUSES,
  isAllowedAccessReviewTransition,
  isAllowedTeamMemberStatusTransition,
  isEmailDomainAllowed,
  isIpAddressAllowed,
  isTerminalAccessReviewStatus,
  listAllowedTeamMemberStatusTransitions,
  listPermissionsForDelegatedAdminScope,
  roleHasPermission,
  teamMemberStatusGrantsAccess,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Surface — catalogs cover the documented set.
// -----------------------------------------------------------------------------

test("team member statuses cover lifecycle", () => {
  assert.deepEqual([...TEAM_MEMBER_STATUSES].sort(), [
    "ACTIVE",
    "REVOKED",
    "SUSPENDED",
  ]);
});

test("delegated admin scope kinds cover Phase 17 surfaces", () => {
  for (const kind of [
    "GOVERNANCE_ADMIN",
    "REVIEW_ADMIN",
    "INTELLIGENCE_ADMIN",
    "INTEGRATION_ADMIN",
    "COLLABORATION_ADMIN",
    "IDENTITY_ADMIN",
    "RETENTION_ADMIN",
  ]) {
    assert.ok(DELEGATED_ADMIN_SCOPE_KINDS.includes(kind), kind);
  }
});

test("access review kinds cover Phase 17 generator passes", () => {
  for (const kind of [
    "PERIODIC_MEMBER_REVIEW",
    "STALE_ACCESS",
    "UNUSED_SERVICE_ACCOUNT",
    "EXPIRING_TEMPORARY_ACCESS",
    "SUSPICIOUS_ACCESS_PATTERN",
    "EMERGENCY_REVOCATION_FOLLOWUP",
  ]) {
    assert.ok(ACCESS_REVIEW_KINDS.includes(kind), kind);
  }
});

test("access review statuses cover the state machine", () => {
  for (const s of [
    "PENDING",
    "IN_PROGRESS",
    "COMPLETED_KEEP",
    "COMPLETED_REVOKED",
    "COMPLETED_SUSPENDED",
    "COMPLETED_NO_ACTION",
    "CANCELLED",
  ]) {
    assert.ok(ACCESS_REVIEW_STATUSES.includes(s), s);
  }
});

test("access review subject kinds cover member/service/contributor", () => {
  assert.deepEqual([...ACCESS_REVIEW_SUBJECT_KINDS].sort(), [
    "CONTRIBUTOR_SESSION",
    "SERVICE_ACCOUNT",
    "TEAM_MEMBER",
  ]);
});

test("external identity providers list", () => {
  for (const p of [
    "GENERIC_SAML",
    "GENERIC_OIDC",
    "GENERIC_SCIM",
    "OKTA",
    "AZURE_AD",
    "GOOGLE_WORKSPACE",
  ]) {
    assert.ok(EXTERNAL_IDENTITY_PROVIDERS.includes(p), p);
  }
});

test("permission audit event names cover Phase 17 audit emissions", () => {
  for (const t of [
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
  ]) {
    assert.ok(PERMISSION_AUDIT_EVENT_TYPES.includes(t), t);
  }
});

// -----------------------------------------------------------------------------
// Member lifecycle helpers
// -----------------------------------------------------------------------------

test("teamMemberStatusGrantsAccess grants only when ACTIVE", () => {
  assert.equal(teamMemberStatusGrantsAccess("ACTIVE"), true);
  assert.equal(teamMemberStatusGrantsAccess("SUSPENDED"), false);
  assert.equal(teamMemberStatusGrantsAccess("REVOKED"), false);
  assert.equal(teamMemberStatusGrantsAccess(null), false);
  assert.equal(teamMemberStatusGrantsAccess(undefined), false);
});

test("isAllowedTeamMemberStatusTransition allows pause/restore/revoke only", () => {
  assert.equal(isAllowedTeamMemberStatusTransition("ACTIVE", "SUSPENDED"), true);
  assert.equal(isAllowedTeamMemberStatusTransition("ACTIVE", "REVOKED"), true);
  assert.equal(isAllowedTeamMemberStatusTransition("SUSPENDED", "ACTIVE"), true);
  assert.equal(isAllowedTeamMemberStatusTransition("SUSPENDED", "REVOKED"), true);
  // REVOKED is terminal.
  assert.equal(isAllowedTeamMemberStatusTransition("REVOKED", "ACTIVE"), false);
  assert.equal(isAllowedTeamMemberStatusTransition("REVOKED", "SUSPENDED"), false);
  // No self-transitions.
  assert.equal(isAllowedTeamMemberStatusTransition("ACTIVE", "ACTIVE"), false);
  assert.equal(isAllowedTeamMemberStatusTransition("SUSPENDED", "SUSPENDED"), false);
});

test("listAllowedTeamMemberStatusTransitions mirrors the allow-list", () => {
  assert.deepEqual([...listAllowedTeamMemberStatusTransitions("REVOKED")], []);
  assert.deepEqual([...listAllowedTeamMemberStatusTransitions("ACTIVE")].sort(), [
    "REVOKED",
    "SUSPENDED",
  ]);
});

// -----------------------------------------------------------------------------
// Access review transitions
// -----------------------------------------------------------------------------

test("access review terminal statuses are all the COMPLETED_* + CANCELLED", () => {
  for (const s of [
    "COMPLETED_KEEP",
    "COMPLETED_REVOKED",
    "COMPLETED_SUSPENDED",
    "COMPLETED_NO_ACTION",
    "CANCELLED",
  ]) {
    assert.equal(isTerminalAccessReviewStatus(s), true, s);
  }
  assert.equal(isTerminalAccessReviewStatus("PENDING"), false);
  assert.equal(isTerminalAccessReviewStatus("IN_PROGRESS"), false);
});

test("access review transitions: terminal states cannot move", () => {
  for (const terminal of [
    "COMPLETED_KEEP",
    "COMPLETED_REVOKED",
    "COMPLETED_SUSPENDED",
    "COMPLETED_NO_ACTION",
    "CANCELLED",
  ]) {
    for (const target of ACCESS_REVIEW_STATUSES) {
      assert.equal(
        isAllowedAccessReviewTransition(terminal, target),
        false,
        `${terminal} -> ${target}`,
      );
    }
  }
});

test("access review pending -> in_progress + any terminal", () => {
  assert.equal(isAllowedAccessReviewTransition("PENDING", "IN_PROGRESS"), true);
  assert.equal(
    isAllowedAccessReviewTransition("PENDING", "COMPLETED_KEEP"),
    true,
  );
  assert.equal(isAllowedAccessReviewTransition("PENDING", "CANCELLED"), true);
});

// -----------------------------------------------------------------------------
// Delegated admin scope permission expansion
// -----------------------------------------------------------------------------

test("each delegated admin scope expands to a non-empty permission set", () => {
  for (const scope of DELEGATED_ADMIN_SCOPE_KINDS) {
    const perms = listPermissionsForDelegatedAdminScope(scope);
    assert.ok(perms.length > 0, scope);
    for (const p of perms) {
      assert.ok(
        PERMISSIONS.includes(p),
        `scope ${scope} references unknown permission ${p}`,
      );
    }
  }
});

test("GOVERNANCE_ADMIN scope contains the governance.* family", () => {
  const perms = listPermissionsForDelegatedAdminScope("GOVERNANCE_ADMIN");
  assert.ok(perms.includes("governance.policy.manage"));
  assert.ok(perms.includes("governance.legal_hold.manage"));
  assert.ok(perms.includes("governance.retention.manage"));
});

test("IDENTITY_ADMIN scope contains the identity.* mutation family", () => {
  const perms = listPermissionsForDelegatedAdminScope("IDENTITY_ADMIN");
  for (const p of [
    "identity.member.suspend",
    "identity.member.revoke",
    "identity.capability.grant",
    "identity.delegated_admin.grant",
    "identity.org_policy.manage",
  ]) {
    assert.ok(perms.includes(p), `IDENTITY_ADMIN must grant ${p}`);
  }
});

test("REVIEW_ADMIN scope is review.* only — never widens to identity", () => {
  const perms = listPermissionsForDelegatedAdminScope("REVIEW_ADMIN");
  for (const p of perms) {
    assert.ok(
      p.startsWith("review."),
      `REVIEW_ADMIN must NOT include ${p}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Org security policy
// -----------------------------------------------------------------------------

test("org security policy defaults are inert (no enforcement)", () => {
  assert.equal(ORG_SECURITY_POLICY_DEFAULTS.mfaRequiredFlag, false);
  assert.deepEqual(ORG_SECURITY_POLICY_DEFAULTS.allowedEmailDomains, []);
  assert.deepEqual(ORG_SECURITY_POLICY_DEFAULTS.restrictedIpRanges, []);
  assert.equal(ORG_SECURITY_POLICY_DEFAULTS.ssoReadyFlag, false);
  assert.equal(ORG_SECURITY_POLICY_DEFAULTS.scimReadyFlag, false);
});

test("OrgSecurityPolicySchema rejects negative timeouts", () => {
  const r = OrgSecurityPolicySchema.safeParse({
    mfaRequiredFlag: false,
    allowedEmailDomains: [],
    restrictedIpRanges: [],
    reviewerSessionTimeoutSeconds: -1,
    contributorSessionTimeoutSeconds: null,
    ssoReadyFlag: false,
    scimReadyFlag: false,
    notes: null,
  });
  assert.equal(r.success, false);
});

test("OrgSecurityPolicySchema accepts an empty policy", () => {
  const r = OrgSecurityPolicySchema.safeParse({});
  assert.equal(r.success, true);
});

// -----------------------------------------------------------------------------
// Domain + IP allowlists
// -----------------------------------------------------------------------------

test("isEmailDomainAllowed: empty list permits all", () => {
  assert.equal(isEmailDomainAllowed("alice@example.com", []), true);
});

test("isEmailDomainAllowed: case-insensitive match on host", () => {
  assert.equal(
    isEmailDomainAllowed("Alice@Example.Com", ["example.com"]),
    true,
  );
  assert.equal(
    isEmailDomainAllowed("alice@otherdomain.com", ["example.com"]),
    false,
  );
});

test("isEmailDomainAllowed: malformed input fails closed", () => {
  assert.equal(isEmailDomainAllowed("no-at-sign", ["example.com"]), false);
  assert.equal(isEmailDomainAllowed("alice@", ["example.com"]), false);
});

test("isIpAddressAllowed: empty list permits all", () => {
  assert.equal(isIpAddressAllowed("1.2.3.4", []), true);
});

test("isIpAddressAllowed: exact match on a /32 CIDR", () => {
  assert.equal(isIpAddressAllowed("1.2.3.4", ["1.2.3.4/32"]), true);
  assert.equal(isIpAddressAllowed("1.2.3.5", ["1.2.3.4/32"]), false);
});

test("isIpAddressAllowed: /24 covers the third octet", () => {
  assert.equal(isIpAddressAllowed("10.0.0.99", ["10.0.0.0/24"]), true);
  assert.equal(isIpAddressAllowed("10.0.1.99", ["10.0.0.0/24"]), false);
});

test("isIpAddressAllowed: /0 covers everything", () => {
  assert.equal(isIpAddressAllowed("8.8.8.8", ["0.0.0.0/0"]), true);
});

test("isIpAddressAllowed: malformed address or CIDR fails closed", () => {
  assert.equal(isIpAddressAllowed("not-an-ip", ["10.0.0.0/24"]), false);
  assert.equal(isIpAddressAllowed("10.0.0.1", ["bad-cidr"]), false);
  assert.equal(isIpAddressAllowed("10.0.0.1", ["10.0.0.0/99"]), false);
});

test("isIpAddressAllowed: empty address fails closed when list is non-empty", () => {
  assert.equal(isIpAddressAllowed("", ["10.0.0.0/24"]), false);
});

// -----------------------------------------------------------------------------
// Phase 17 — Permission catalog additions
// -----------------------------------------------------------------------------

test("permission catalog includes the identity.* family", () => {
  for (const p of [
    "identity.member.read",
    "identity.member.invite",
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
  ]) {
    assert.ok(PERMISSIONS.includes(p), p);
  }
});

test("permission catalog includes billing.read / billing.manage stubs", () => {
  assert.ok(PERMISSIONS.includes("billing.read"));
  assert.ok(PERMISSIONS.includes("billing.manage"));
});

test("OWNER holds identity.* + billing.manage", () => {
  for (const p of [
    "identity.member.suspend",
    "identity.member.revoke",
    "identity.org_policy.manage",
    "identity.access_review.action",
    "billing.manage",
  ]) {
    assert.equal(roleHasPermission("OWNER", p), true, p);
  }
});

test("ADMIN can manage identity but cannot billing.manage", () => {
  assert.equal(roleHasPermission("ADMIN", "identity.member.suspend"), true);
  assert.equal(roleHasPermission("ADMIN", "identity.org_policy.manage"), true);
  assert.equal(roleHasPermission("ADMIN", "identity.access_review.action"), true);
  assert.equal(roleHasPermission("ADMIN", "billing.read"), true);
  assert.equal(roleHasPermission("ADMIN", "billing.manage"), false);
});

test("REVIEWER (DB MEMBER) cannot mutate identity but can read", () => {
  assert.equal(roleHasPermission("MEMBER", "identity.member.read"), true);
  assert.equal(roleHasPermission("MEMBER", "identity.org_policy.read"), true);
  assert.equal(roleHasPermission("MEMBER", "identity.access_review.read"), true);
  // Mutations are denied.
  assert.equal(roleHasPermission("MEMBER", "identity.member.suspend"), false);
  assert.equal(roleHasPermission("MEMBER", "identity.member.revoke"), false);
  assert.equal(roleHasPermission("MEMBER", "identity.org_policy.manage"), false);
  assert.equal(roleHasPermission("MEMBER", "identity.capability.grant"), false);
  assert.equal(
    roleHasPermission("MEMBER", "identity.delegated_admin.grant"),
    false,
  );
});

test("CONTRIBUTOR + EXTERNAL_CONTRIBUTOR + PUBLIC_VERIFIER never get identity.* mutations", () => {
  for (const role of [
    "CONTRIBUTOR",
    "EXTERNAL_CONTRIBUTOR",
    "PUBLIC_VERIFIER",
  ]) {
    for (const p of [
      "identity.member.suspend",
      "identity.member.revoke",
      "identity.org_policy.manage",
      "identity.access_review.action",
      "identity.capability.grant",
      "identity.delegated_admin.grant",
      "identity.service_account.manage",
      "billing.manage",
    ]) {
      assert.equal(roleHasPermission(role, p), false, `${role}/${p}`);
    }
  }
});
