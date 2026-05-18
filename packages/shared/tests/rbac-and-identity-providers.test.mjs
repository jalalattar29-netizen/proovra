import test from "node:test";
import assert from "node:assert/strict";

// Phase 26 — Enterprise RBAC + Identity Providers shared contract tests.
//
// Coverage:
//   - RBAC decision catalog completeness
//   - applyInheritanceChain precedence: DENY > ALLOW > STEP_UP > NOT_APPLICABLE
//   - rbacPermissionDomain extraction
//   - TemporaryElevationSchema bounds + .strict
//   - SSO connection status transition matrix
//   - SSO provider protocol classification (OIDC vs SAML vs SCIM)
//   - SsoConnectionCreateInputSchema: OIDC requires issuerUrl + clientId + clientSecret;
//     SAML requires samlMetadataJson; rejects unknown keys
//   - emailMatchesAllowedDomains: empty = any; subdomain accepted
//   - SCIM scope catalog + token prefix
//   - ScimUserSchema: requires SCIM 2.0 schema URI + emails
//   - ScimPatchOpSchema: only replace ops in our supported subset
//   - evaluateJitProvisioning happy + disabled + domain-blocked paths

import {
  RBAC_DECISION_OUTCOMES,
  RBAC_DECISION_SOURCES,
  RBAC_PERMISSION_DOMAINS,
  RBAC_PERMISSION_VERBS,
  RBAC_SOURCE_LABELS,
  SCIM_SCOPES,
  SCIM_TOKEN_PREFIX,
  SCIM_USER_SCHEMA_URI,
  SSO_CONNECTION_STATUSES,
  SSO_PROVIDERS,
  SSO_PROVIDER_LABELS,
  ScimPatchOpSchema,
  ScimUserSchema,
  SsoConnectionCreateInputSchema,
  TemporaryElevationSchema,
  applyInheritanceChain,
  emailMatchesAllowedDomains,
  evaluateJitProvisioning,
  isAllowedSsoConnectionTransition,
  normaliseEmailDomain,
  rbacPermissionDomain,
  rbacSourceLabel,
  scimError,
  ssoProviderLabel,
  ssoProviderProtocol,
} from "../dist/index.js";

const TEAM_ID = "00000000-0000-0000-0000-000000000000";
const USER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// -----------------------------------------------------------------------------
// RBAC catalogs
// -----------------------------------------------------------------------------

test("RBAC_DECISION_OUTCOMES contains the four canonical outcomes", () => {
  assert.deepEqual([...RBAC_DECISION_OUTCOMES].sort(), [
    "ALLOW",
    "DENY",
    "NOT_APPLICABLE",
    "STEP_UP_REQUIRED",
  ]);
});

test("RBAC_DECISION_SOURCES contains the nine canonical sources", () => {
  assert.equal(RBAC_DECISION_SOURCES.length, 9);
  for (const s of [
    "ORG_POLICY",
    "WORKSPACE_POLICY",
    "ROLE_MATRIX",
    "CAPABILITY_GRANT",
    "DELEGATED_SCOPE",
    "TEMPORARY_ELEVATION",
    "SERVICE_ACCOUNT",
    "CONTRIBUTOR",
    "EXPLICIT_DENY",
  ]) {
    assert.equal(RBAC_DECISION_SOURCES.includes(s), true);
    assert.equal(typeof RBAC_SOURCE_LABELS[s], "string");
    assert.equal(typeof rbacSourceLabel(s), "string");
  }
});

test("RBAC_PERMISSION_DOMAINS contains the brief's domain list", () => {
  for (const d of [
    "evidence",
    "review",
    "reviewer_ops",
    "exports",
    "governance",
    "retention",
    "legal_hold",
    "integrations",
    "api",
    "notifications",
    "incidents",
    "workflows",
    "search",
    "access_reviews",
    "org_admin",
    "workspace_admin",
    "billing",
    "trust_center",
    "identity",
  ]) {
    assert.equal(RBAC_PERMISSION_DOMAINS.includes(d), true);
  }
});

test("RBAC_PERMISSION_VERBS includes READ, WRITE, ADMINISTER, etc.", () => {
  assert.equal(RBAC_PERMISSION_VERBS.length, 9);
  for (const v of [
    "READ",
    "WRITE",
    "DELETE",
    "EXPORT",
    "APPROVE",
    "ASSIGN",
    "ESCALATE",
    "GOVERN",
    "ADMINISTER",
  ]) {
    assert.equal(RBAC_PERMISSION_VERBS.includes(v), true);
  }
});

test("rbacPermissionDomain extracts the leading namespace segment", () => {
  assert.equal(rbacPermissionDomain("review.queue.read"), "review");
  assert.equal(rbacPermissionDomain("evidence.generate_package"), "evidence");
  assert.equal(rbacPermissionDomain("identity.member.read"), "identity");
  assert.equal(rbacPermissionDomain("bogus.something"), null);
  assert.equal(rbacPermissionDomain("nodot"), null);
});

// -----------------------------------------------------------------------------
// Inheritance chain precedence
// -----------------------------------------------------------------------------

test("applyInheritanceChain: DENY always wins, even after ALLOW", () => {
  const out = applyInheritanceChain([
    { outcome: "ALLOW", source: "ROLE_MATRIX", reason: "role allow" },
    { outcome: "DENY", source: "WORKSPACE_POLICY", reason: "workspace deny" },
  ]);
  assert.equal(out.outcome, "DENY");
  assert.equal(out.source, "WORKSPACE_POLICY");
});

test("applyInheritanceChain: ALLOW returned when no DENY", () => {
  const out = applyInheritanceChain([
    {
      outcome: "STEP_UP_REQUIRED",
      source: "WORKSPACE_POLICY",
      reason: "step-up",
    },
    { outcome: "ALLOW", source: "CAPABILITY_GRANT", reason: "grant allow" },
  ]);
  assert.equal(out.outcome, "ALLOW");
  assert.equal(out.source, "CAPABILITY_GRANT");
});

test("applyInheritanceChain: STEP_UP returned when neither DENY nor ALLOW", () => {
  const out = applyInheritanceChain([
    {
      outcome: "NOT_APPLICABLE",
      source: "ROLE_MATRIX",
      reason: "no role match",
    },
    {
      outcome: "STEP_UP_REQUIRED",
      source: "WORKSPACE_POLICY",
      reason: "step up",
    },
  ]);
  assert.equal(out.outcome, "STEP_UP_REQUIRED");
});

test("applyInheritanceChain: NOT_APPLICABLE when nothing matches", () => {
  const out = applyInheritanceChain([
    {
      outcome: "NOT_APPLICABLE",
      source: "ROLE_MATRIX",
      reason: "no role match",
    },
  ]);
  assert.equal(out.outcome, "NOT_APPLICABLE");
});

test("applyInheritanceChain: empty chain returns NOT_APPLICABLE", () => {
  const out = applyInheritanceChain([]);
  assert.equal(out.outcome, "NOT_APPLICABLE");
});

// -----------------------------------------------------------------------------
// Temporary elevation
// -----------------------------------------------------------------------------

test("TemporaryElevationSchema accepts a valid input", () => {
  const r = TemporaryElevationSchema.safeParse({
    teamId: TEAM_ID,
    userId: USER_ID,
    permission: "identity.org_policy.manage",
    reason: "Incident response",
    ttlSeconds: 600,
  });
  assert.equal(r.success, true);
});

test("TemporaryElevationSchema rejects ttl > 4 hours", () => {
  const r = TemporaryElevationSchema.safeParse({
    teamId: TEAM_ID,
    userId: USER_ID,
    permission: "identity.org_policy.manage",
    reason: "ok",
    ttlSeconds: 4 * 3600 + 1,
  });
  assert.equal(r.success, false);
});

test("TemporaryElevationSchema requires a reason", () => {
  const r = TemporaryElevationSchema.safeParse({
    teamId: TEAM_ID,
    userId: USER_ID,
    permission: "identity.org_policy.manage",
  });
  assert.equal(r.success, false);
});

test("TemporaryElevationSchema is strict (rejects unknown keys)", () => {
  const r = TemporaryElevationSchema.safeParse({
    teamId: TEAM_ID,
    userId: USER_ID,
    permission: "identity.org_policy.manage",
    reason: "ok",
    extraField: 1,
  });
  assert.equal(r.success, false);
});

// -----------------------------------------------------------------------------
// SSO catalog
// -----------------------------------------------------------------------------

test("SSO_CONNECTION_STATUSES catalog (PENDING, ACTIVE, DISABLED, REVOKED)", () => {
  assert.deepEqual([...SSO_CONNECTION_STATUSES].sort(), [
    "ACTIVE",
    "DISABLED",
    "PENDING",
    "REVOKED",
  ]);
});

test("SSO_PROVIDERS includes the brief's targets", () => {
  for (const p of [
    "GOOGLE_WORKSPACE",
    "OKTA",
    "AZURE_AD",
    "GENERIC_OIDC",
    "GENERIC_SAML",
    "GENERIC_SCIM",
  ]) {
    assert.equal(SSO_PROVIDERS.includes(p), true);
    assert.equal(typeof SSO_PROVIDER_LABELS[p], "string");
    assert.equal(typeof ssoProviderLabel(p), "string");
  }
});

test("ssoProviderProtocol: OIDC for IdPs, SAML/SCIM for generic", () => {
  assert.equal(ssoProviderProtocol("GOOGLE_WORKSPACE"), "OIDC");
  assert.equal(ssoProviderProtocol("OKTA"), "OIDC");
  assert.equal(ssoProviderProtocol("AZURE_AD"), "OIDC");
  assert.equal(ssoProviderProtocol("GENERIC_OIDC"), "OIDC");
  assert.equal(ssoProviderProtocol("GENERIC_SAML"), "SAML");
  assert.equal(ssoProviderProtocol("GENERIC_SCIM"), "SCIM");
});

test("SSO transition matrix: ACTIVE → DISABLED allowed, REVOKED is terminal", () => {
  assert.equal(isAllowedSsoConnectionTransition("PENDING", "ACTIVE"), true);
  assert.equal(isAllowedSsoConnectionTransition("ACTIVE", "DISABLED"), true);
  assert.equal(isAllowedSsoConnectionTransition("DISABLED", "ACTIVE"), true);
  assert.equal(isAllowedSsoConnectionTransition("ACTIVE", "REVOKED"), true);
  assert.equal(isAllowedSsoConnectionTransition("REVOKED", "ACTIVE"), false);
  assert.equal(isAllowedSsoConnectionTransition("REVOKED", "PENDING"), false);
});

// -----------------------------------------------------------------------------
// SSO create input schema
// -----------------------------------------------------------------------------

test("SsoConnectionCreateInputSchema: OIDC requires issuerUrl + clientId + clientSecret", () => {
  const r = SsoConnectionCreateInputSchema.safeParse({
    teamId: TEAM_ID,
    provider: "GOOGLE_WORKSPACE",
    displayName: "Acme G-Suite",
    // missing issuerUrl, clientId, clientSecret
  });
  assert.equal(r.success, false);
});

test("SsoConnectionCreateInputSchema: valid OIDC payload accepted", () => {
  const r = SsoConnectionCreateInputSchema.safeParse({
    teamId: TEAM_ID,
    provider: "GOOGLE_WORKSPACE",
    displayName: "Acme G-Suite",
    issuerUrl:
      "https://accounts.google.com/.well-known/openid-configuration",
    clientId: "abc123.apps.googleusercontent.com",
    clientSecret: "some-secret-value",
    allowedEmailDomains: ["acme.com"],
    jitDefaultRole: "MEMBER",
  });
  assert.equal(r.success, true);
});

test("SsoConnectionCreateInputSchema: SAML requires samlMetadataJson", () => {
  const r = SsoConnectionCreateInputSchema.safeParse({
    teamId: TEAM_ID,
    provider: "GENERIC_SAML",
    displayName: "Acme SAML",
  });
  assert.equal(r.success, false);
});

test("SsoConnectionCreateInputSchema: issuerUrl must be https", () => {
  const r = SsoConnectionCreateInputSchema.safeParse({
    teamId: TEAM_ID,
    provider: "GENERIC_OIDC",
    displayName: "Test",
    issuerUrl: "http://not-https.example.com/.well-known/openid-configuration",
    clientId: "x",
    clientSecret: "secretvalue",
  });
  assert.equal(r.success, false);
});

// -----------------------------------------------------------------------------
// Email-domain matching
// -----------------------------------------------------------------------------

test("emailMatchesAllowedDomains: empty list = any", () => {
  assert.equal(emailMatchesAllowedDomains("a@x.com", []), true);
});

test("emailMatchesAllowedDomains: exact match", () => {
  assert.equal(
    emailMatchesAllowedDomains("alice@acme.com", ["acme.com"]),
    true,
  );
});

test("emailMatchesAllowedDomains: subdomain accepted", () => {
  assert.equal(
    emailMatchesAllowedDomains("alice@ops.acme.com", ["acme.com"]),
    true,
  );
});

test("emailMatchesAllowedDomains: rejects different domain", () => {
  assert.equal(
    emailMatchesAllowedDomains("alice@evil.com", ["acme.com"]),
    false,
  );
});

test("normaliseEmailDomain strips '@' and '*.' prefixes", () => {
  assert.equal(normaliseEmailDomain("@acme.com"), "acme.com");
  assert.equal(normaliseEmailDomain("*.acme.com"), "acme.com");
  assert.equal(normaliseEmailDomain("ACME.COM"), "acme.com");
});

// -----------------------------------------------------------------------------
// JIT provisioning
// -----------------------------------------------------------------------------

test("evaluateJitProvisioning: enabled + allowed domain → ok", () => {
  const r = evaluateJitProvisioning(
    { enabled: true, defaultRole: "MEMBER", allowedEmailDomains: ["acme.com"] },
    "alice@acme.com",
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.role, "MEMBER");
});

test("evaluateJitProvisioning: disabled → JIT_DISABLED", () => {
  const r = evaluateJitProvisioning(
    { enabled: false, defaultRole: "MEMBER", allowedEmailDomains: [] },
    "alice@acme.com",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "JIT_DISABLED");
});

test("evaluateJitProvisioning: domain blocked", () => {
  const r = evaluateJitProvisioning(
    { enabled: true, defaultRole: "MEMBER", allowedEmailDomains: ["acme.com"] },
    "alice@evil.com",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "EMAIL_DOMAIN_NOT_ALLOWED");
});

// -----------------------------------------------------------------------------
// SCIM catalogs
// -----------------------------------------------------------------------------

test("SCIM_SCOPES catalog (users.read/write/deactivate, groups.read)", () => {
  assert.deepEqual([...SCIM_SCOPES].sort(), [
    "groups.read",
    "users.deactivate",
    "users.read",
    "users.write",
  ]);
});

test("SCIM_TOKEN_PREFIX is 'scim_pat_'", () => {
  assert.equal(SCIM_TOKEN_PREFIX, "scim_pat_");
});

test("ScimUserSchema requires SCIM 2.0 schema URI + emails", () => {
  const valid = ScimUserSchema.safeParse({
    schemas: [SCIM_USER_SCHEMA_URI],
    userName: "alice@acme.com",
    emails: [{ value: "alice@acme.com", primary: true }],
  });
  assert.equal(valid.success, true);

  const missingSchema = ScimUserSchema.safeParse({
    schemas: ["bogus:other"],
    userName: "alice@acme.com",
    emails: [{ value: "alice@acme.com" }],
  });
  assert.equal(missingSchema.success, false);

  const noEmails = ScimUserSchema.safeParse({
    schemas: [SCIM_USER_SCHEMA_URI],
    userName: "alice@acme.com",
    emails: [],
  });
  assert.equal(noEmails.success, false);
});

test("ScimPatchOpSchema: only schemas-tagged PatchOp ops accepted", () => {
  const valid = ScimPatchOpSchema.safeParse({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(valid.success, true);

  const missing = ScimPatchOpSchema.safeParse({
    schemas: ["bogus"],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(missing.success, false);
});

test("scimError builds an RFC-7644 error with status string", () => {
  const e = scimError(404, "User not found");
  assert.equal(e.status, "404");
  assert.equal(e.detail, "User not found");
  assert.equal(
    e.schemas[0],
    "urn:ietf:params:scim:api:messages:2.0:Error",
  );
});
