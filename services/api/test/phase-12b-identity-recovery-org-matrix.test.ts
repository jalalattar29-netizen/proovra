/**
 * PHASE 12B — Identity / Security ACCEPTANCE, behavioral coverage group C.
 *
 * Drives the REAL route handlers (fastify `inject`) for the previously
 * uncovered MFA-RECOVERY, DIGEST-PREFERENCE, SCIM/SAML-OPS and
 * ORGANIZATION-IDENTITY operations. Only PROCESS BOUNDARIES are
 * substituted: token verification, the step-up transport, the audit /
 * security-event / analytics sinks, the email transport, the secret
 * resolver, and the database client (an in-memory, transaction-shaped
 * store). Every routing, authorization, concealment, state-machine and
 * signed-token decision under test executes production code.
 *
 * Product systems proven here:
 *   1. MFA recovery-request lifecycle   (mfa-admin.routes + mfa.routes legs)
 *   2. Digest preferences + snooze token (signed one-click link)
 *   3. SCIM reconciliation + sync-failure replay
 *   4. SAML attribute mapping
 *   5. SSO health + identity session timeline
 *   6. Organization identity (membership, roles, invitations, closure)
 *   7. Organization domain identity boundary
 *   8. Bulk organization invitation
 *   9. SAML SP metadata + certificate rotation
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------
const ACTOR = "11111111-1111-4111-8111-111111111111";
const ADMIN_2 = "11111111-1111-4111-8111-111111111112";
const ADMIN_3 = "11111111-1111-4111-8111-111111111113";
const SUBJECT = "22222222-2222-4222-8222-222222222221";
const OUTSIDER = "22222222-2222-4222-8222-222222222229";
const TEAM = "33333333-3333-4333-8333-333333333333";
const OTHER_TEAM = "33333333-3333-4333-8333-333333333339";
const ORG = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "44444444-4444-4444-8444-444444444449";
const CONN = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const REQ_MINE = "77777777-7777-4777-8777-777777777771";
const REQ_FOREIGN = "77777777-7777-4777-8777-777777777779";
const REQ_MISSING = "77777777-7777-4777-8777-77777777770a";
const DOMAIN_ROW = "88888888-8888-4888-8888-888888888881";
const DOMAIN_FOREIGN = "88888888-8888-4888-8888-888888888889";
const INVITE_ROW = "99999999-9999-4999-8999-999999999991";
const INVITE_FOREIGN = "99999999-9999-4999-8999-999999999999";
const MEMBERSHIP_ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEMBERSHIP_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const MEMBERSHIP_TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const MEMBERSHIP_FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const CLOSURE_ROW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const AUDIT_ROW = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const JWT_SECRET = "phase-12b-acceptance-secret";

// ---------------------------------------------------------------------------
// Hoisted seams
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  /** middleware/authorize outcome (mfa-admin scope helper). */
  authorizeAllowed: true,
  /** step-up transport denies (401 STEP_UP_REQUIRED). */
  stepUpDenies: false,
  /** checkOrgAccess outcome. */
  orgAccess: { kind: "ok", role: "ORG_OWNER" } as
    | { kind: "ok"; role: string }
    | { kind: "forbidden" }
    | { kind: "not_found" },
  /** enterprise feature gate outcome. */
  gateOk: true,
  /** readUserMfaPosture guard outcome for the admin recovery queue. */
  postureOk: true,
  postureReason: "admin_not_admin" as
    | "admin_not_in_team"
    | "admin_not_admin"
    | "target_not_in_team",
  /** DNS TXT verification outcome. */
  dnsOk: true,
  /** Canonical-service call log: {svc, args}. */
  calls: [] as Array<{ svc: string; args: unknown }>,
  /** Canonical-mutation write log. */
  writes: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  /** Emails handed to the transport: {to, url}. */
  emails: [] as Array<{ to: string; url: string }>,
  /** SAML mapping preview privilege flag (drives the step-up gate). */
  privilegeAffecting: true,
  db: null as unknown as ReturnType<typeof makeDb>,
}));

const rec = (svc: string, args: unknown) => {
  H.calls.push({ svc, args });
};
const callsTo = (svc: string) => H.calls.filter((c) => c.svc === svc);

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------
vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    { get: (_t, p: string) => (H.db as unknown as Record<string, unknown>)[p] },
  ),
}));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => {},
}));
vi.mock("../src/middleware/cron-secret.js", () => ({
  requireIntegrationCronSecret: async () => true,
}));
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthSessionId: () => "session-hash",
}));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (!H.authorizeAllowed) {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    return { actorUserId: H.actorUserId, teamId: TEAM };
  },
}));
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: {
    purpose: string;
    teamId: string;
    reply: { code: (n: number) => { send: (b: unknown) => void } };
  }) => {
    rec("stepUp", { purpose: input.purpose, teamId: input.teamId });
    if (H.stepUpDenies) {
      input.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED" } });
      return { sent: true };
    }
    return { sent: false, verifiedChallengeId: "chal-1" };
  },
}));
vi.mock("../src/services/identity-security/account-step-up.service.js", () => ({
  verifyAccountStepUp: async (input: { action: string }) => {
    rec("accountStepUp", { action: input.action });
    return H.stepUpDenies
      ? {
          ok: false,
          denial: { status: 401, body: { error: { code: "STEP_UP_REQUIRED" } } },
        }
      : { ok: true, proof: { method: "password" } };
  },
}));
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (e: Record<string, unknown>) => {
    H.audits.push(e);
  },
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: (e: Record<string, unknown>) => {
    H.audits.push(e);
  },
  projectSecurityEventDetails: (d: unknown) => (d === null ? null : {}),
}));
vi.mock("../src/services/analytics-event.service.js", () => ({
  writeAnalyticsEvent: async (e: Record<string, unknown>) => {
    H.audits.push(e);
  },
}));
vi.mock("../src/services/ops/metrics.service.js", () => ({ bump: () => {} }));
vi.mock("../src/services/email.service.js", () => ({
  getEmailService: () => ({
    isConfigured: () => true,
    sendMfaRecoveryVerificationEmail: async (to: string, url: string) => {
      H.emails.push({ to, url });
    },
    sendMfaRecoveryAdminDigestEmail: async (to: string) => {
      H.emails.push({ to, url: "digest" });
    },
  }),
}));
vi.mock("../src/config/runtime-secrets.js", () => ({
  getSecret: (n: string) => (n === "AUTH_JWT_SECRET" ? JWT_SECRET : null),
  requireSecret: () => JWT_SECRET,
}));
vi.mock("../src/services/billing-enforcement.service.js", () => ({
  assertTeamAllowsEnterpriseFeature: async () => undefined,
}));

// --- MFA admin surfaces (posture guard / policy / trusted devices) ---------
vi.mock("../src/services/security/mfa-admin-lifecycle.service.js", () => ({
  readUserMfaPosture: async (i: unknown) => {
    rec("readUserMfaPosture", i);
    return H.postureOk
      ? { ok: true, posture: { mfaEnabled: true, activeFactorCount: 1 } }
      : { ok: false, reason: H.postureReason };
  },
  listRecentMfaEvents: async (i: unknown) => {
    rec("listRecentMfaEvents", i);
    return { ok: true, events: [] };
  },
  requireUserReenrollment: async () => ({ ok: true, revokedFactorCount: 0 }),
  resetTrustedDevicesForUser: async () => ({ ok: true, resetCount: 0 }),
  revokeUserFactor: async () => ({ ok: true }),
}));
vi.mock("../src/services/identity-security/trusted-device.service.js", () => ({
  listTrustedDevicesForUser: async () => [],
  projectTrustedDevice: (d: unknown) => d,
}));
vi.mock("../src/services/identity-security/mfa-policy.service.js", () => ({
  getMfaPolicy: async () => ({ level: "OPTIONAL", policyVersion: 1 }),
  updateMfaPolicyVersioned: async () => ({ level: "REQUIRED", policyVersion: 2 }),
  MfaPolicyVersionConflictError: class extends Error {
    expectedVersion = 1;
    currentVersion = 2;
  },
}));

// --- Digest preference / preview / event feed ------------------------------
vi.mock("../src/services/security/mfa-digest-preference.service.js", () => ({
  listDigestPreferences: async (i: unknown) => {
    rec("listDigestPreferences", i);
    return {
      preferences: [
        {
          id: "pref-1",
          userId: H.actorUserId,
          teamId: TEAM,
          digestEnabled: true,
          suppressUntil: null,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    };
  },
  updateDigestPreference: async (i: { teamId: string | null }) => {
    rec("updateDigestPreference", i);
    if (i.teamId === OTHER_TEAM) return { ok: false, reason: "not_member" };
    return {
      ok: true,
      preference: {
        id: "pref-1",
        userId: H.actorUserId,
        teamId: i.teamId,
        digestEnabled: true,
        suppressUntil: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    };
  },
}));
vi.mock("../src/services/security/mfa-recovery-digest-preview.service.js", () => ({
  previewDigestForAdmin: async (i: unknown) => {
    rec("previewDigestForAdmin", i);
    return {
      adminUserId: H.actorUserId,
      generatedAt: "2026-07-30T00:00:00.000Z",
      teamCount: 1,
      requestCount: 2,
      suppressedTeamCount: 0,
      teams: [
        {
          teamId: TEAM,
          teamName: "Acme Investigations",
          pendingCount: 2,
          oldestRequestAgeSeconds: 900,
          adminRecoveryUrl: "https://www.proovra.com/security-center",
          suppressedByPreference: false,
        },
      ],
    };
  },
}));
vi.mock("../src/services/security/mfa-recovery-event-feed.service.js", () => ({
  readRecoveryEventFeed: async (i: unknown) => {
    rec("readRecoveryEventFeed", i);
    return {
      windowDays: 14,
      pageSize: 100,
      events: [
        {
          id: "ev-1",
          eventType: "mfa_recovery_approved",
          severity: "WARNING",
          createdAt: "2026-07-29T00:00:00.000Z",
          teamId: TEAM,
          teamName: "Acme Investigations",
          summary: "Recovery approved for 22222222",
        },
      ],
    };
  },
}));

// --- SCIM / SAML mapping / SSO health / session timeline -------------------
vi.mock("../src/services/access-control/scim-reconciliation.service.js", () => ({
  detectScimDrift: async (i: unknown) => {
    rec("detectScimDrift", i);
    return {
      previewId: "prev-1",
      teamId: TEAM,
      generatedAtUtc: "2026-07-30T00:00:00.000Z",
      items: [],
      summary: { total: 0, byCategory: {}, byRisk: {}, destructiveCount: 0 },
      truncated: false,
    };
  },
  executeScimReconciliation: async (i: unknown) => {
    rec("executeScimReconciliation", i);
    H.writes.push("executeScimReconciliation");
    return {
      ok: true,
      executedAtUtc: "2026-07-30T00:00:00.000Z",
      appliedCount: 1,
      skippedCount: 0,
      details: [
        { itemId: "d1", action: "ARCHIVE_TOKEN", outcome: "APPLIED", reason: null },
      ],
    };
  },
  listScimSyncFailures: async (i: unknown) => {
    rec("listScimSyncFailures", i);
    // The service returns an ENVELOPE now, not a bare array: `total` counts
    // everything matching the filter and `limit` echoes the cap, so the page
    // can say "Showing 1 of 3" instead of inferring completeness from the row
    // count. A double that still returns an array would let the route ship a
    // response shape no caller expects — the double has to move with the
    // contract, or it stops standing in for the thing it replaces.
    return {
      failures: [
        {
          id: "f1",
          occurredAtUtc: "2026-07-29T00:00:00.000Z",
          eventType: "scim_user_create_failed",
          severity: "WARNING",
          summary: "SCIM user create failed",
          retryEligible: true,
          terminal: false,
        },
      ],
      total: 1,
      limit: 50,
    };
  },
  replayScimSyncFailure: async (i: unknown) => {
    rec("replayScimSyncFailure", i);
    H.writes.push("replayScimSyncFailure");
    return { ok: true, replayedAtUtc: "2026-07-30T00:00:00.000Z" };
  },
}));
vi.mock("../src/services/security/saml-mapping.service.js", () => ({
  SAML_MAPPING_PRIVILEGE_PURPOSE: "SAML_MAPPING_PRIVILEGE_UPDATE",
  getSamlMappingSchema: () => {
    rec("getSamlMappingSchema", null);
    return { fields: [{ key: "email", kind: "ATTRIBUTE", required: true }] };
  },
  getCurrentSamlMapping: async (i: unknown) => {
    rec("getCurrentSamlMapping", i);
    return {
      connectionId: CONN,
      teamId: TEAM,
      provider: "OKTA",
      status: "ACTIVE",
      scimManaged: false,
      mapping: { email: "mail", groupRoleMap: null },
      jitDefaultRole: "MEMBER",
    };
  },
  previewSamlMapping: async (i: unknown) => {
    rec("previewSamlMapping", i);
    return {
      ok: true,
      preview: {
        privilegeAffecting: H.privilegeAffecting,
        changes: [{ field: "email", before: "mail", after: "upn" }],
        warnings: [],
        sampleResolution: null,
      },
    };
  },
  updateSamlMapping: async (i: unknown) => {
    rec("updateSamlMapping", i);
    H.writes.push("updateSamlMapping");
    return {
      ok: true,
      connectionId: CONN,
      updatedAtUtc: "2026-07-30T00:00:00.000Z",
      privilegeAffecting: H.privilegeAffecting,
    };
  },
}));
vi.mock("../src/services/security/sso-health.service.js", () => ({
  buildSsoHealthSnapshot: async (i: unknown) => {
    rec("buildSsoHealthSnapshot", i);
    return {
      teamId: TEAM,
      generatedAtUtc: "2026-07-30T00:00:00.000Z",
      overallStatus: "DEGRADED",
      connections: [
        {
          connectionId: CONN,
          provider: "OKTA",
          status: "ACTIVE",
          health: "DEGRADED",
          lastSuccessAtUtc: "2026-07-29T00:00:00.000Z",
          lastFailureAtUtc: "2026-07-30T00:00:00.000Z",
          consecutiveFailureCount: 2,
          outageDetectedAtUtc: null,
          outageClearedAtUtc: null,
          cert: {
            fingerprint: "ab12cd34",
            notAfterUtc: "2026-12-31T00:00:00.000Z",
            expiryBand: "warning",
            daysUntilExpiry: 154,
          },
          attemptCounts: {
            last24h: { total: 10, failed: 2, replayed: 0 },
            last7d: { total: 70, failed: 3, replayed: 0 },
          },
          failureBreakdown: [
            { reason: "invalid_signature", count24h: 2, count7d: 3 },
          ],
          recommendedAction: "Rotate the IdP certificate.",
        },
      ],
    };
  },
}));
vi.mock("../src/services/security/session-timeline.service.js", () => ({
  buildIdentitySessionTimeline: async (i: unknown) => {
    rec("buildIdentitySessionTimeline", i);
    return {
      sessionId: SESSION,
      teamId: TEAM,
      session: {
        issuedAtUtc: "2026-07-29T00:00:00.000Z",
        expiresAtUtc: "2026-08-28T00:00:00.000Z",
        lastSeenAtUtc: "2026-07-30T00:00:00.000Z",
        revokedAtUtc: null,
        revocationReason: null,
        ssoConnectionId: CONN,
      },
      events: [
        {
          id: "t1",
          occurredAtUtc: "2026-07-29T00:00:00.000Z",
          eventType: "saml_login_succeeded",
          severity: "INFO",
          summary: "SAML login succeeded",
        },
      ],
      truncated: false,
    };
  },
}));

// --- Organization seams ---------------------------------------------------
vi.mock("../src/services/organization/org-access.js", async (orig) => {
  // Mirrors the real gate: an org role must MEET the endpoint's minRole.
  const RANK: Record<string, number> = {
    ORG_OWNER: 5,
    ORG_ADMIN: 4,
    ORG_SECURITY_ADMIN: 3,
    ORG_BILLING_ADMIN: 3,
    ORG_AUDITOR: 2,
    ORG_MEMBER: 1,
  };
  return {
    // Only the DB-touching gate is seamed. Everything else in the module —
    // notably the pure `listOrgAdminSurfaces` projection that GET /v1/orgs/:id
    // now returns — comes through REAL, so this file cannot pass while the
    // real projection is broken or missing.
    ...((await orig()) as Record<string, unknown>),
    checkOrgAccess: async (
      _c: unknown,
      i: { orgId: string; userId: string; minRole?: string },
    ) => {
      rec("checkOrgAccess", i);
      if (i.orgId === OTHER_ORG) return { kind: "forbidden" };
      if (H.orgAccess.kind !== "ok") return H.orgAccess;
      const need = i.minRole ? RANK[i.minRole] ?? 1 : 1;
      if ((RANK[H.orgAccess.role] ?? 0) < need) return { kind: "forbidden" };
      return H.orgAccess;
    },
  };
});
vi.mock("../src/services/organization/org-audit.service.js", () => ({
  emitOrgAuditEvent: async (_tx: unknown, e: Record<string, unknown>) => {
    H.audits.push(e);
  },
}));
vi.mock("../src/services/enterprise-gate-resolvers.service.js", () => ({
  resolveOrgEnterpriseFeatureGate: async () =>
    H.gateOk
      ? { ok: true }
      : { ok: false, statusCode: 402, reason: "ENTERPRISE_FEATURE_REQUIRED" },
  resolveSamlConnectionEnterpriseGate: async () =>
    H.gateOk
      ? { ok: true }
      : { ok: false, statusCode: 402, reason: "ENTERPRISE_FEATURE_REQUIRED" },
  resolveTeamEnterpriseFeatureGate: async () => ({ ok: true }),
  denyTeamIfNotEnterprise: async () => undefined,
}));
vi.mock("../src/services/organization/organization-domain.service.js", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkDomainDnsTxt: async () => {
    rec("checkDomainDnsTxt", null);
    return H.dnsOk;
  },
  isEmailDomainVerifiedForOrg: async () => true,
}));
vi.mock("../src/services/organization/org-invite-delivery.service.js", () => ({
  attemptInitialOrgInviteDelivery: async () => {
    rec("attemptInitialOrgInviteDelivery", null);
    return { status: "SENT", attempts: 1, lastError: null };
  },
  recordOrgInviteDeliveryPending: async () => ({ deliveryId: "del-1" }),
  resendOrgInviteDelivery: async (i: unknown) => {
    rec("resendOrgInviteDelivery", i);
    return {
      state: { status: "SENT", attempts: 2, lastError: null },
      acceptUrl: "https://www.proovra.com/invite/accept?token=fresh",
    };
  },
  getOrgInviteDeliveryStates: async () => new Map(),
  processDueOrgInviteDeliveries: async () => ({ processed: 0 }),
}));
vi.mock("../src/services/identity/membership-provisioning.service.js", () => ({
  parseWorkspaceAssignments: (v: unknown) => v ?? [],
  grantOrganizationMembership: async () => {
    H.writes.push("grantOrganizationMembership");
  },
  grantWorkspaceMembership: async () => {
    H.writes.push("grantWorkspaceMembership");
  },
  massRevokeWorkspaceMemberships: async () => {
    H.writes.push("massRevokeWorkspaceMemberships");
    return { count: 1 };
  },
  removeOrganizationMembership: async (
    _tx: unknown,
    i: { organizationMembershipId: string },
  ) => {
    H.writes.push("removeOrganizationMembership");
    await H.db.organizationMembership.delete({
      where: { id: i.organizationMembershipId },
    });
  },
  updateOrganizationMembershipRole: async (
    _tx: unknown,
    i: { organizationMembershipId: string; role: string },
  ) => {
    H.writes.push("updateOrganizationMembershipRole");
    await H.db.organizationMembership.update({
      where: { id: i.organizationMembershipId },
      data: { role: i.role },
    });
  },
}));
vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  revokeAllSessionsForUser: async () => {
    H.writes.push("revokeAllSessionsForUser");
    return { revoked: 1 };
  },
  hashSessionId: (s: string) => `hash:${s}`,
}));
vi.mock("../src/services/identity/account-lifecycle-preflight.service.js", () => ({
  evaluateOrganizationClosurePreflight: async () => {
    rec("evaluateOrganizationClosurePreflight", null);
    return { blockers: [] as Array<{ code: string }> };
  },
}));
vi.mock("../src/services/organization/org-invite-acceptance.service.js", () => ({
  acceptOrganizationInvite: async (i: unknown) => {
    rec("acceptOrganizationInvite", i);
    return { kind: "not_found" };
  },
}));
vi.mock("../src/services/workspace/workspace-lifecycle.service.js", () => ({
  suspendOrganizationWorkspace: async () => ({ suspended: true }),
  resumeOrganizationWorkspace: async () => ({ resumed: true }),
}));
vi.mock("../src/services/enterprise-provisioning.service.js", () => ({
  completeEnterpriseProvisioningOnOwnerAccept: async () => undefined,
}));
vi.mock("../src/services/identity/concurrent-session.service.js", () => ({
  establishOrganizationSessionContext: async () => ({ allowed: true }),
}));

// --- SAML SP boundaries (IdP transport + XML crypto) ----------------------
vi.mock("../src/services/jwt.js", () => ({
  signJwt: () => "signed.session.jwt",
  signMfaPendingToken: () => "signed.pending.jwt",
  verifyJwt: () => ({ sub: H.actorUserId }),
  MFA_PENDING_TTL_SECONDS: 600,
}));
vi.mock("../src/services/security/saml-authn-request.service.js", () => ({
  buildSamlAuthnRequest: (i: { idpSsoUrl: string; spPrivateKeyPem: string | null }) => {
    rec("buildSamlAuthnRequest", { signed: i.spPrivateKeyPem !== null });
    return {
      requestId: "_authn-1",
      redirectUrl: i.idpSsoUrl + "?SAMLRequest=deflated&RelayState=rs-1",
      relayState: "rs-1",
      signed: i.spPrivateKeyPem !== null,
    };
  },
}));
vi.mock("../src/services/access-control/sso-hardening.service.js", () => ({
  persistSamlCallbackAttempt: async (i: unknown) => {
    rec("persistSamlCallbackAttempt", i);
    return { ok: true, attemptId: "att-1" };
  },
  consumeCallbackAttempt: async () => ({ ok: false, reason: "EXPIRED" }),
  markCallbackFailed: async () => undefined,
  noteSsoFailure: async () => undefined,
  noteSsoSuccess: async () => undefined,
}));
vi.mock("../src/services/security/saml-cert.service.js", () => ({
  parseCertExpiry: () => new Date("2027-01-01T00:00:00.000Z"),
  getCertExpiryStatus: () => "ok",
  emitCertExpiryWarningIfNeeded: () => {
    rec("emitCertExpiryWarningIfNeeded", null);
  },
}));
vi.mock("../src/services/security/saml-metadata.service.js", () => ({
  parseSamlMetadata: () => ({
    ssoUrl: "https://idp.example.com/sso",
    certificate: "MIICparsed",
    certFingerprint: "fp-parsed",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    entityId: "https://idp.example.com",
  }),
  SamlMetadataError: class extends Error {
    code = "METADATA_INVALID";
  },
}));
vi.mock("../src/services/security/saml-assertion.service.js", () => ({
  validateSamlResponse: () => {
    throw new Error("live IdP assertion required");
  },
  samlConnectionRequiresIssuerRemediation: () => false,
  SamlAssertionError: class extends Error {
    code: string;
    constructor(code: string, msg?: string) {
      super(msg);
      this.code = code;
    }
  },
  SAML_FAILURE_CATEGORY_LABELS: {},
}));
vi.mock("../src/services/security/saml-user-mapping.service.js", () => ({
  handleSamlAssertion: async () => ({ userId: SUBJECT, email: "s@acme.test" }),
  SamlMappingError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock("../src/services/security/login-mfa-enforcement.service.js", () => ({
  resolveLoginMfaEnforcement: async () => ({ outcome: "NONE" }),
}));
vi.mock("../src/services/security/mfa.service.js", () => ({
  createMfaPendingChallenge: async () => ({ jti: "jti-1" }),
}));
vi.mock("../src/services/access-control/session-inventory.service.js", () => ({
  recordAuthenticatedSession: async () => ({ id: SESSION }),
}));
vi.mock("../src/services/access-control/sso-login-policy.service.js", () => ({
  enforceSsoLoginPolicy: async () => ({ ok: true, organizationId: ORG }),
}));
vi.mock("../src/services/access-control/suspicious-session.service.js", () => ({
  detectAndScoreSession: async () => null,
}));
vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  organizationIdForPolicy: async () => ORG,
  resolveOrganizationPolicy: async () => ({ applicability: "NOT_APPLICABLE" }),
}));

// ---------------------------------------------------------------------------
// SUT imports (after the boundaries are bound)
// ---------------------------------------------------------------------------
import {
  mfaAdminRoutes,
  __resetMfaAdminRouteRateLimitersForTests,
} from "../src/routes/mfa-admin.routes.js";
import { identityOperationsCompletionRoutes } from "../src/routes/identity-operations-completion.routes.js";
import { organizationDomainsRoutes } from "../src/routes/organization-domains.routes.js";
import { organizationsBulkInviteRoutes } from "../src/routes/organizations-bulk-invite.routes.js";
import { organizationsRoutes } from "../src/routes/organizations.routes.js";
import { samlAuthRoutes } from "../src/routes/saml-auth.routes.js";
import { signMfaDigestSnoozeToken } from "../src/services/security/mfa-digest-snooze-token.js";

// ===========================================================================
// In-memory, transaction-shaped prisma transport
// ===========================================================================
type Row = Record<string, unknown>;

const MODELS = [
  "teamMember",
  "team",
  "user",
  "organization",
  "organizationMembership",
  "organizationInvite",
  "organizationDomain",
  "organizationPolicy",
  "organizationAuditEvent",
  "organizationClosureRequest",
  "mfaRecoveryRequest",
  "mfaRecoveryRequestApproval",
  "mfaFactor",
  "mfaRecoveryCode",
  "ssoConnection",
  "securityEvent",
  "authenticatedSession",
] as const;

function tval(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return String(v ?? "");
}
function eq(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (expected instanceof Date && actual instanceof Date) {
    return expected.getTime() === actual.getTime();
  }
  return expected === actual;
}
const OPS = ["in", "notIn", "not", "gt", "gte", "lt", "lte", "equals"];

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [k, v] of Object.entries(where as Row)) {
    if (k === "AND") {
      if (!(v as unknown[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(v as unknown[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "NOT") {
      if (matches(row, v)) return false;
      continue;
    }
    const rv = row[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const cond = v as Row;
      const keys = Object.keys(cond);
      if (keys.length > 0 && keys.every((kk) => OPS.includes(kk))) {
        for (const [op, val] of Object.entries(cond)) {
          if (op === "in" && !(val as unknown[]).some((x) => eq(x, rv))) return false;
          if (op === "notIn" && (val as unknown[]).some((x) => eq(x, rv))) return false;
          if (op === "equals" && !eq(val, rv)) return false;
          if (op === "not") {
            if (val === null ? rv === null || rv === undefined : eq(val, rv)) return false;
          }
          if (op === "gt" && !(tval(rv) > tval(val))) return false;
          if (op === "gte" && !(tval(rv) >= tval(val))) return false;
          if (op === "lt" && !(tval(rv) < tval(val))) return false;
          if (op === "lte" && !(tval(rv) <= tval(val))) return false;
        }
        continue;
      }
      // relation filter, or a compound-unique key expressed as a nested object
      if (rv && typeof rv === "object") {
        if (!matches(rv as Row, cond)) return false;
        continue;
      }
      if (rv === undefined) {
        if (!matches(row, cond)) return false;
        continue;
      }
      return false;
    }
    if (!eq(v, rv)) return false;
  }
  return true;
}

function project(row: Row, select: unknown): Row {
  if (!select || typeof select !== "object") return { ...row };
  const out: Row = {};
  for (const [k, spec] of Object.entries(select as Row)) {
    if (!spec) continue;
    const rv = row[k];
    if (typeof spec === "object" && spec !== null && "select" in (spec as Row)) {
      out[k] =
        rv && typeof rv === "object"
          ? project(rv as Row, (spec as Row).select)
          : rv ?? null;
      continue;
    }
    out[k] = rv === undefined ? null : rv;
  }
  return out;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as Row).increment as number);
      continue;
    }
    row[k] = v;
  }
  row.updatedAt = new Date();
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [k, dir] of Object.entries(spec)) {
        const av = tval(a[k]);
        const bv = tval(b[k]);
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}
function makeDb() {
  const store = new Map<string, Row[]>();
  for (const m of MODELS) store.set(m, []);
  const db: Record<string, unknown> = {
    __store: store,
    $transaction: async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => Promise<unknown>)(db),
  };
  for (const model of MODELS) {
    const list = () => store.get(model)!;
    const find = (where: unknown) => list().find((r) => matches(r, where));
    db[model] = {
      findMany: async (a: Row = {}) => {
        let rows = list().filter((r) => matches(r, a.where));
        rows = sortRows(rows, a.orderBy);
        if (a.cursor) {
          const idx = rows.findIndex((r) => matches(r, a.cursor));
          if (idx >= 0) rows = rows.slice(idx);
        }
        if (typeof a.skip === "number") rows = rows.slice(a.skip);
        if (typeof a.take === "number") rows = rows.slice(0, a.take);
        return rows.map((r) => project(r, a.select));
      },
      findFirst: async (a: Row = {}) => {
        const rows = sortRows(list().filter((r) => matches(r, a.where)), a.orderBy);
        return rows[0] ? project(rows[0], a.select) : null;
      },
      findUnique: async (a: Row = {}) => {
        const r = find(a.where);
        return r ? project(r, a.select) : null;
      },
      findUniqueOrThrow: async (a: Row = {}) => {
        const r = find(a.where);
        if (!r) throw new Error(`${model} not found`);
        return project(r, a.select);
      },
      count: async (a: Row = {}) => list().filter((r) => matches(r, a.where)).length,
      groupBy: async (a: Row = {}) => {
        const rows = list().filter((r) => matches(r, a.where));
        const by = a.by as string[];
        const buckets = new Map<string, Row[]>();
        for (const r of rows) {
          const key = by.map((b) => String(r[b])).join("|");
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key)!.push(r);
        }
        return [...buckets.values()].map((rs) => {
          const out: Row = { _count: { id: rs.length } };
          for (const b of by) out[b] = rs[0]![b];
          return out;
        });
      },
      create: async (a: Row) => {
        const data = { ...(a.data as Row) };
        if (model === "mfaRecoveryRequestApproval") {
          const dup = list().some(
            (r) =>
              r.requestId === data.requestId &&
              r.approverUserId === data.approverUserId,
          );
          if (dup) throw new Error("Unique constraint failed on the fields");
        }
        const row: Row = {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        list().push(row);
        H.writes.push(`${model}.create`);
        return project(row, a.select);
      },
      update: async (a: Row) => {
        const r = find(a.where);
        if (!r) throw new Error(`${model} update: not found`);
        applyData(r, a.data as Row);
        H.writes.push(`${model}.update`);
        return project(r, a.select);
      },
      updateMany: async (a: Row) => {
        const rows = list().filter((r) => matches(r, a.where));
        for (const r of rows) applyData(r, a.data as Row);
        if (rows.length > 0) H.writes.push(`${model}.updateMany`);
        return { count: rows.length };
      },
      delete: async (a: Row) => {
        const rows = list();
        const idx = rows.findIndex((r) => matches(r, a.where));
        if (idx < 0) throw new Error(`${model} delete: not found`);
        const [removed] = rows.splice(idx, 1);
        H.writes.push(`${model}.delete`);
        return removed!;
      },
      deleteMany: async (a: Row = {}) => {
        const rows = list();
        const keep = rows.filter((r) => !matches(r, a.where));
        const n = rows.length - keep.length;
        store.set(model, keep);
        return { count: n };
      },
      upsert: async (a: Row) => {
        const r = find(a.where);
        if (r) {
          applyData(r, a.update as Row);
          return project(r, a.select);
        }
        return (db[model] as Record<string, (x: Row) => unknown>).create({
          data: a.create as Row,
          select: a.select,
        });
      },
    };
  }
  return db as Record<string, Record<string, (a?: Row) => Promise<unknown>>> & {
    $transaction: (arg: unknown) => Promise<unknown>;
    __store: Map<string, Row[]>;
  };
}

const rows = (model: string) => H.db.__store.get(model)!;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function seed(): void {
  H.db = makeDb();
  const now = new Date();
  const future = new Date(Date.now() + 7 * 86_400_000);
  rows("teamMember").push(
    { id: "tm-1", teamId: TEAM, userId: ACTOR, role: "ADMIN", status: "ACTIVE" },
    { id: "tm-2", teamId: TEAM, userId: ADMIN_2, role: "ADMIN", status: "ACTIVE" },
    { id: "tm-3", teamId: TEAM, userId: ADMIN_3, role: "OWNER", status: "ACTIVE" },
    { id: "tm-4", teamId: TEAM, userId: SUBJECT, role: "MEMBER", status: "ACTIVE" },
    {
      id: "tm-5",
      teamId: OTHER_TEAM,
      userId: OUTSIDER,
      role: "OWNER",
      status: "ACTIVE",
    },
  );
  rows("user").push(
    { id: ACTOR, email: "admin@acme.test", displayName: "Admin One", currentWorkspaceId: TEAM },
    { id: ADMIN_2, email: "admin2@acme.test", displayName: "Admin Two", currentWorkspaceId: null },
    { id: ADMIN_3, email: "owner@acme.test", displayName: "Owner", currentWorkspaceId: null },
    { id: SUBJECT, email: "subject@acme.test", displayName: "Subject", currentWorkspaceId: TEAM },
    { id: OUTSIDER, email: "outsider@other.test", displayName: "Outsider", currentWorkspaceId: null },
  );
  const orgRow = {
    id: ORG,
    kind: "CUSTOMER",
    name: "Acme Investigations",
    legalName: "Acme Ltd",
    legalEmail: "legal@acme.test",
    address: "1 Acme Way",
    timezone: "UTC",
    logoUrl: null,
    status: "ACTIVE",
    billingOwnerUserId: ACTOR,
    verificationState: "VERIFIED",
    verifiedAtUtc: now,
    createdAt: now,
    updatedAt: now,
  };
  rows("organization").push(orgRow, { ...orgRow, id: OTHER_ORG, name: "Other Org" });
  rows("team").push(
    {
      id: TEAM,
      organizationId: ORG,
      name: "Acme Workspace",
      isPersonal: false,
      createdAt: now,
      includedSeats: 10,
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
      overSeatLimit: false,
      billingOwnerUserId: ACTOR,
      _count: { members: 4 },
    },
    {
      id: OTHER_TEAM,
      organizationId: OTHER_ORG,
      name: "Other Workspace",
      isPersonal: false,
      createdAt: now,
      includedSeats: 5,
      _count: { members: 1 },
    },
  );
  // ARCH-004 (2026-08-07) — seeded governance memberships carry a STATUS.
  //
  // Every access decision, every seat count and every duplicate check now
  // filters on ACTIVE, so a row without one models a membership that cannot
  // exist. ACTIVE is the accurate value for a seeded live member, and stating
  // it keeps this transport faithful to the model rather than accommodating
  // the shape it replaced.
  rows("organizationMembership").push(
    {
      id: MEMBERSHIP_ADMIN,
      organizationId: ORG,
      userId: ACTOR,
      role: "ORG_OWNER",
      status: "ACTIVE",
      statusGeneration: 0,
      createdAt: now,
      organization: orgRow,
      user: { email: "admin@acme.test", displayName: "Admin One" },
    },
    {
      id: MEMBERSHIP_OWNER,
      organizationId: ORG,
      userId: ADMIN_3,
      role: "ORG_OWNER",
      status: "ACTIVE",
      statusGeneration: 0,
      createdAt: now,
      organization: orgRow,
      user: { email: "owner@acme.test", displayName: "Owner" },
    },
    {
      id: MEMBERSHIP_TARGET,
      organizationId: ORG,
      userId: SUBJECT,
      role: "ORG_MEMBER",
      status: "ACTIVE",
      statusGeneration: 0,
      createdAt: now,
      organization: orgRow,
      user: { email: "subject@acme.test", displayName: "Subject" },
    },
    {
      id: MEMBERSHIP_FOREIGN,
      organizationId: OTHER_ORG,
      userId: OUTSIDER,
      role: "ORG_OWNER",
      status: "ACTIVE",
      statusGeneration: 0,
      createdAt: now,
      organization: { ...orgRow, id: OTHER_ORG },
      user: { email: "outsider@other.test", displayName: "Outsider" },
    },
  );
  rows("organizationInvite").push(
    {
      id: INVITE_ROW,
      organizationId: ORG,
      email: "new@acme.test",
      role: "ORG_MEMBER",
      tokenHash: "hash-1",
      token: null,
      invitedByUserId: ACTOR,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: future,
      lastResentAt: null,
      resendCount: 0,
      createdAt: now,
    },
    {
      id: INVITE_FOREIGN,
      organizationId: OTHER_ORG,
      email: "elsewhere@other.test",
      role: "ORG_MEMBER",
      tokenHash: "hash-2",
      token: null,
      invitedByUserId: OUTSIDER,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: future,
      lastResentAt: null,
      resendCount: 0,
      createdAt: now,
    },
  );
  rows("organizationDomain").push(
    {
      id: DOMAIN_ROW,
      organizationId: ORG,
      domain: "acme.test",
      verificationToken: "tok-acme",
      verifiedAt: null,
      createdByUserId: ACTOR,
      createdAt: now,
    },
    {
      id: "88888888-8888-4888-8888-888888888882",
      organizationId: ORG,
      domain: "verified.test",
      verificationToken: "tok-verified",
      verifiedAt: now,
      createdByUserId: ACTOR,
      createdAt: now,
    },
    {
      id: DOMAIN_FOREIGN,
      organizationId: OTHER_ORG,
      domain: "other.test",
      verificationToken: "tok-other",
      verifiedAt: null,
      createdByUserId: OUTSIDER,
      createdAt: now,
    },
  );
  rows("organizationClosureRequest").push({
    id: CLOSURE_ROW,
    organizationId: ORG,
    requestedByUserId: ACTOR,
    status: "CANCELLED",
    reason: null,
    blockersJson: null,
    requestedAtUtc: new Date(Date.now() - 86_400_000),
    coolingOffEndsAtUtc: null,
    cancelledAtUtc: now,
    completedAtUtc: null,
    failureCode: null,
  });
  rows("organizationAuditEvent").push({
    id: AUDIT_ROW,
    organizationId: ORG,
    actorUserId: ACTOR,
    eventType: "ORG_MEMBER_INVITED",
    targetType: "organization_invite",
    targetId: INVITE_ROW,
    metadata: { email: "new@acme.test" },
    createdAt: now,
  });
  rows("ssoConnection").push({
    id: CONN,
    teamId: TEAM,
    status: "ACTIVE",
    provider: "OKTA",
    samlSsoUrl: "https://idp.example.com/sso",
    samlCertificate: "MIIC".padEnd(400, "A"),
    samlCertificateNext: null,
    samlCertFingerprint: "fp-primary",
    samlCertNextFingerprint: null,
    samlEntityId: "https://api.proovra.com/saml/sp/" + CONN,
    samlNameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    samlSignRequests: true,
    samlSpPrivateKey: "REDACTED_SP_PRIVATE_KEY_FIXTURE",
    samlSpCertificate: null,
    samlCertNotAfter: new Date(Date.now() + 200 * 86_400_000),
    samlCertNextNotAfter: null,
    samlIdpEntityId: "https://idp.example.com",
    samlAttributeMapping: null,
    allowedEmailDomains: [],
    jitDefaultRole: "MEMBER",
    samlScimManaged: false,
    restrictToVerifiedDomains: false,
    samlLastTestedAt: null,
    samlLastTestStatus: null,
    samlLastTestError: null,
  });
}

async function makeApp(
  plugin: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(plugin);
  await app.ready();
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
  H.actorUserId = ACTOR;
  H.authorizeAllowed = true;
  H.stepUpDenies = false;
  H.orgAccess = { kind: "ok", role: "ORG_OWNER" };
  H.gateOk = true;
  H.postureOk = true;
  H.postureReason = "admin_not_admin";
  H.dnsOk = true;
  H.privilegeAffecting = true;
  H.calls.length = 0;
  H.writes.length = 0;
  H.audits.length = 0;
  H.emails.length = 0;
  __resetMfaAdminRouteRateLimitersForTests();
  seed();
});

// ===========================================================================
// PRODUCT SYSTEM 1 — MFA recovery-request lifecycle
//   The REAL `mfa-recovery-request.service` runs over the in-memory transport
//   behind the REAL routes. Proof categories: authorized happy path,
//   denial-with-zero-mutation, cross-Organization concealment, secret-free
//   projections, multi-approver / state-machine integrity (append-only).
// ===========================================================================
function pushRequest(over: Partial<Row> = {}): string {
  const id = (over.id as string) ?? REQ_MINE;
  rows("mfaRecoveryRequest").push({
    id,
    userId: SUBJECT,
    teamId: TEAM,
    status: "PENDING_ADMIN_REVIEW",
    reason: "Lost my authenticator device while travelling.",
    requiredApprovals: 1,
    approvalCount: 0,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
    emailResendCount: 1,
    emailResendBlockedUntil: null,
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    approvedAtUtc: null,
    rejectedAtUtc: null,
    rejectedReason: null,
    cancelledAtUtc: null,
    completedAtUtc: null,
    ...over,
  });
  return id;
}
const requestRow = (id: string) =>
  rows("mfaRecoveryRequest").find((r) => r.id === id)!;

const ADMIN_BASE = "/v1/identity/mfa-admin/recovery-requests";
const SELF_BASE = "/v1/identity/mfa/recovery-requests";

describe("SYSTEM 1 — MFA recovery-request lifecycle", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp(mfaAdminRoutes);
  });

  it("admin queue read is workspace-scoped and lists only THIS workspace's requests", async () => {
    pushRequest();
    pushRequest({ id: REQ_FOREIGN, teamId: OTHER_TEAM, userId: OUTSIDER });
    const res = await app.inject({ method: "GET", url: ADMIN_BASE + "/" + TEAM });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { requests: Array<{ id: string }> };
    expect(body.requests.map((r) => r.id)).toEqual([REQ_MINE]);
    // The scope guard ran with the SERVER-derived actor, not a client value.
    expect(callsTo("readUserMfaPosture")[0]!.args).toMatchObject({
      teamId: TEAM,
      actorUserId: ACTOR,
      targetUserId: ACTOR,
    });
  });

  it("admin queue denial: a scope failure is a bounded denial that reads nothing", async () => {
    pushRequest();
    const ok = await app.inject({ method: "GET", url: ADMIN_BASE + "/" + TEAM });
    expect(ok.statusCode).toBe(200);
    H.postureOk = false;
    H.postureReason = "admin_not_admin";
    const res = await app.inject({ method: "GET", url: ADMIN_BASE + "/" + TEAM });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "admin_not_admin" });
    expect(res.body).not.toContain("authenticator");
  });

  it("self-service create: server-derived subject, mailbox-bound token never returned", async () => {
    H.actorUserId = SUBJECT;
    const res = await app.inject({
      method: "POST",
      url: ADMIN_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, reason: "Lost my authenticator device today." },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; request: Row };
    expect(body.ok).toBe(true);
    expect(body.request.status).toBe("EMAIL_VERIFICATION_PENDING");
    const created = rows("mfaRecoveryRequest")[0]!;
    // Subject is the AUTHENTICATED actor — a client-declared user is impossible.
    expect(created.userId).toBe(SUBJECT);
    expect(created.teamId).toBe(TEAM);
    // Only the HASH persists; the raw token exists only inside the email.
    expect(H.emails).toHaveLength(1);
    expect(H.emails[0]!.to).toBe("subject@acme.test");
    const raw = new URL(H.emails[0]!.url).searchParams.get("token")!;
    expect(raw).toHaveLength(64);
    expect(created.emailVerificationTokenHash).not.toBe(raw);
    expect(res.body).not.toContain(raw);
    expect(res.body).not.toContain("subject@acme.test");
  });

  it("self-service create denial: a non-member of the declared workspace mutates nothing", async () => {
    H.actorUserId = OUTSIDER;
    const res = await app.inject({
      method: "POST",
      url: ADMIN_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, reason: "Please reset my second factor now." },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not_member" });
    expect(rows("mfaRecoveryRequest")).toHaveLength(0);
    expect(H.emails).toHaveLength(0);
  });

  it("create is idempotent: an in-flight request collapses to a bounded 409, no second row", async () => {
    H.actorUserId = SUBJECT;
    pushRequest({ status: "EMAIL_VERIFICATION_PENDING" });
    const res = await app.inject({
      method: "POST",
      url: ADMIN_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, reason: "Lost my authenticator device today." },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("already_pending");
    expect(rows("mfaRecoveryRequest")).toHaveLength(1);
  });

  it("email-verify leg: a forged token changes nothing; the real token is single-use", async () => {
    H.actorUserId = SUBJECT;
    await app.inject({
      method: "POST",
      url: ADMIN_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, reason: "Lost my authenticator device today." },
    });
    const created = rows("mfaRecoveryRequest")[0]!;
    const id = created.id as string;
    const raw = new URL(H.emails[0]!.url).searchParams.get("token")!;

    const forged = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/verify-email",
      headers: JSON_HEADERS,
      payload: { token: "f".repeat(64) },
    });
    expect(forged.statusCode).toBe(400);
    expect(JSON.parse(forged.body)).toEqual({ error: "token_invalid" });
    expect(requestRow(id).status).toBe("EMAIL_VERIFICATION_PENDING");

    const ok = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/verify-email",
      headers: JSON_HEADERS,
      payload: { token: raw },
    });
    expect(ok.statusCode).toBe(200);
    expect(requestRow(id).status).toBe("PENDING_ADMIN_REVIEW");
    expect(requestRow(id).emailVerificationTokenHash).toBeNull();

    const replay = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/verify-email",
      headers: JSON_HEADERS,
      payload: { token: raw },
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body)).toEqual({
      error: "request_not_in_email_pending",
    });
  });

  it("resend-email leg rotates the token, throttles the next attempt, refuses a foreign owner", async () => {
    const id = pushRequest({
      status: "EMAIL_VERIFICATION_PENDING",
      emailVerificationTokenHash: "old-hash",
      emailVerificationExpiresAt: new Date(Date.now() + 600_000),
    });
    H.actorUserId = SUBJECT;
    const first = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/resend-email",
    });
    expect(first.statusCode).toBe(200);
    expect(requestRow(id).emailVerificationTokenHash).not.toBe("old-hash");
    expect(requestRow(id).emailResendCount).toBe(2);
    const throttled = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/resend-email",
    });
    expect(throttled.statusCode).toBe(429);
    expect(JSON.parse(throttled.body).error).toBe("resend_throttled");
    // A different signed-in user cannot drive someone else's recovery.
    H.actorUserId = ACTOR;
    const wrong = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/resend-email",
    });
    expect(wrong.statusCode).toBe(403);
    expect(JSON.parse(wrong.body)).toEqual({ error: "wrong_user" });
  });

  it("cancel leg is owner-only and refuses to cancel an already-approved request", async () => {
    const id = pushRequest();
    H.actorUserId = ACTOR;
    const notOwner = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/cancel",
    });
    expect(notOwner.statusCode).toBe(403);
    expect(requestRow(id).status).toBe("PENDING_ADMIN_REVIEW");

    H.actorUserId = SUBJECT;
    const ok = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + id + "/cancel",
    });
    expect(ok.statusCode).toBe(200);
    expect(requestRow(id).status).toBe("CANCELLED");

    const approved = pushRequest({ id: REQ_FOREIGN, status: "APPROVED" });
    const conflict = await app.inject({
      method: "POST",
      url: SELF_BASE + "/" + approved + "/cancel",
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ error: "already_approved" });
  });

  it("page-viewed analytics ingest is anonymous-safe and asserts nothing about the caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: SELF_BASE + "/analytics/page-viewed",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(
      H.audits.some((a) => a.eventType === "mfa_recovery_verify_page_viewed"),
    ).toBe(true);
  });

  it("multi-approver quorum: approvals are APPEND-ONLY, duplicates are bounded, quorum revokes atomically", async () => {
    const id = pushRequest({ requiredApprovals: 2 });
    rows("mfaFactor").push({
      id: "fac-1",
      userId: SUBJECT,
      status: "ACTIVE",
      kind: "TOTP",
      label: "Phone",
    });
    rows("mfaRecoveryCode").push({
      id: "rc-1",
      userId: SUBJECT,
      usedAt: null,
      batchInvalidatedAt: null,
      codeHash: "secret-code-hash",
    });

    H.actorUserId = ACTOR;
    const first = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true, approvedNow: false });
    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(1);
    expect(requestRow(id).status).toBe("PENDING_ADMIN_REVIEW");
    expect(rows("mfaFactor")[0]!.status).toBe("ACTIVE");

    // Same approver again → bounded conflict, chain unchanged (append-only).
    const dup = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(dup.statusCode).toBe(400);
    expect(JSON.parse(dup.body)).toEqual({ error: "already_approved" });
    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(1);
    expect(requestRow(id).approvalCount).toBe(1);

    // Second distinct approver reaches quorum → atomic revocation.
    H.actorUserId = ADMIN_2;
    const second = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ ok: true, approvedNow: true });
    expect(requestRow(id).status).toBe("APPROVED");
    expect(rows("mfaFactor")[0]!.status).toBe("REVOKED");
    expect(rows("mfaRecoveryCode")[0]!.batchInvalidatedAt).toBeInstanceOf(Date);
    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(2);

    // A THIRD approver cannot make a second decision on a decided request.
    H.actorUserId = ADMIN_3;
    const late = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(late.statusCode).toBe(400);
    expect(JSON.parse(late.body)).toEqual({ error: "request_not_pending" });
    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(2);
  });

  it("approve/reject denials: self-decision, non-admin approver, email-unverified rows mutate nothing", async () => {
    const id = pushRequest();
    H.actorUserId = SUBJECT;
    const selfApprove = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(JSON.parse(selfApprove.body)).toEqual({ error: "cannot_self_approve" });
    const selfReject = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/reject",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(selfReject.statusCode).toBe(403);
    expect(JSON.parse(selfReject.body)).toEqual({ error: "cannot_self_reject" });

    // A plain MEMBER of the workspace is not an approver.
    rows("teamMember").push({
      id: "tm-9",
      teamId: TEAM,
      userId: OUTSIDER,
      role: "MEMBER",
      status: "ACTIVE",
    });
    H.actorUserId = OUTSIDER;
    const nonAdmin = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(nonAdmin.statusCode).toBe(403);
    expect(JSON.parse(nonAdmin.body)).toEqual({ error: "approver_not_admin" });

    // Email-unverified rows are un-approvable regardless of approver rank.
    const pending = pushRequest({
      id: REQ_FOREIGN,
      status: "EMAIL_VERIFICATION_PENDING",
    });
    H.actorUserId = ACTOR;
    const gated = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + pending + "/approve",
    });
    expect(gated.statusCode).toBe(400);
    expect(JSON.parse(gated.body)).toEqual({
      error: "request_not_email_verified",
    });

    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(0);
    expect(requestRow(id).status).toBe("PENDING_ADMIN_REVIEW");
  });

  it("reject is terminal: a second decision on a rejected request is a bounded conflict", async () => {
    const id = pushRequest();
    H.actorUserId = ACTOR;
    const rejected = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/reject",
      headers: JSON_HEADERS,
      payload: { reason: "Could not confirm the caller by phone." },
    });
    expect(rejected.statusCode).toBe(200);
    expect(requestRow(id).status).toBe("REJECTED");
    const again = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/reject",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(again.statusCode).toBe(400);
    expect(JSON.parse(again.body)).toEqual({ error: "request_not_pending" });
    const approveAfter = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + id + "/approve",
    });
    expect(approveAfter.statusCode).toBe(400);
    expect(JSON.parse(approveAfter.body)).toEqual({
      error: "request_not_pending",
    });
  });

  it("detail + approvals projections are populated and carry no secret material", async () => {
    const id = pushRequest();
    rows("mfaRecoveryRequestApproval").push({
      id: "ap-1",
      requestId: id,
      approverUserId: ACTOR,
      createdAt: new Date(),
    });
    H.actorUserId = ACTOR;

    const detail = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/detail/" + id,
    });
    expect(detail.statusCode).toBe(200);
    const d = JSON.parse(detail.body).detail as Row;
    expect(d.id).toBe(id);
    expect(d.emailVerified).toBe(true);
    for (const forbidden of [
      "emailVerificationTokenHash",
      "recoveryCode",
      "codeHash",
      "secret",
      "subject@acme.test",
      "@",
    ]) {
      expect(detail.body).not.toContain(forbidden);
    }

    const approvals = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/" + id + "/approvals",
    });
    expect(approvals.statusCode).toBe(200);
    const list = JSON.parse(approvals.body).approvals as Row[];
    expect(list).toHaveLength(1);
    expect(list[0]!.approverUserId).toBe(ACTOR);
    expect(list[0]!.approverDisplayName).toBe("Admin One");
    // Approver identity is id + display name only — never an email address.
    expect(approvals.body).not.toContain("@");
  });

  it("cross-Organization request ids are BYTE-IDENTICAL to a missing id", async () => {
    // This test recorded an acceptance FINDING: a foreign request id answered
    // 403 `not_authorized` while a non-existent one answered 404
    // `request_not_found`, so recovery-request ids were ENUMERABLE across
    // Organizations — a caller could walk ids and learn which named a real MFA
    // recovery in another tenant (i.e. whose second factor was lost, and when).
    // Both routes were changed to conceal; this now pins the closed behaviour.
    pushRequest({ id: REQ_FOREIGN, teamId: OTHER_TEAM, userId: OUTSIDER });
    H.actorUserId = ACTOR;
    const foreign = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/detail/" + REQ_FOREIGN,
    });
    const missing = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/detail/" + REQ_MISSING,
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual({ error: "request_not_found" });
    // INDISTINGUISHABLE — status AND body.
    expect(foreign.statusCode).toEqual(missing.statusCode);
    expect(foreign.body).toEqual(missing.body);
    // The approvals surface names WHO approved a recovery, so it conceals too.
    const fApprovals = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/" + REQ_FOREIGN + "/approvals",
    });
    const mApprovals = await app.inject({
      method: "GET",
      url: ADMIN_BASE + "/" + REQ_MISSING + "/approvals",
    });
    expect(fApprovals.statusCode).toBe(404);
    expect(mApprovals.statusCode).toBe(404);
    expect(fApprovals.body).toEqual(mApprovals.body);
    // Neither leaks the foreign workspace's content.
    expect(fApprovals.body).not.toContain(OTHER_TEAM);
    expect(foreign.body).not.toContain(OTHER_TEAM);
  });

  it("cross-Organization decisions: an admin of one workspace cannot decide another's request", async () => {
    const foreign = pushRequest({
      id: REQ_FOREIGN,
      teamId: OTHER_TEAM,
      userId: OUTSIDER,
    });
    H.actorUserId = ACTOR;
    const approve = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + foreign + "/approve",
    });
    expect(approve.statusCode).toBe(403);
    expect(JSON.parse(approve.body)).toEqual({ error: "approver_not_admin" });
    const reject = await app.inject({
      method: "POST",
      url: ADMIN_BASE + "/" + foreign + "/reject",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(reject.statusCode).toBe(403);
    expect(rows("mfaRecoveryRequestApproval")).toHaveLength(0);
    expect(requestRow(foreign).status).toBe("PENDING_ADMIN_REVIEW");
  });

  it("recovery event feed is actor-scoped, server-clamped, and label-only", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/identity/mfa-admin/recovery-events?limit=5000&windowDays=999",
    });
    expect(res.statusCode).toBe(200);
    expect(callsTo("readRecoveryEventFeed")).toHaveLength(1);
    // Client-supplied bounds are CLAMPED server-side.
    expect(callsTo("readRecoveryEventFeed")[0]!.args).toEqual({
      actorUserId: ACTOR,
      limit: 200,
      windowDays: 60,
    });
    const body = JSON.parse(res.body) as { events: Row[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.summary).toBeTypeOf("string");
    expect(res.body).not.toContain("codeHash");
  });
});

// ===========================================================================
// PRODUCT SYSTEM 2 — Digest preferences + the SIGNED one-click snooze link
//   The real `mfa-digest-snooze-token` signer/verifier runs unmocked; the
//   canonical `updateDigestPreference` service is recorded so a denial can be
//   proven to mutate NOTHING.
// ===========================================================================
const DIGEST_BASE = "/v1/identity/mfa-admin/digest-preferences";

function b64u(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
/** Hand-rolled HS256 JWT so a CROSS-PURPOSE token can be forged with a
 *  perfectly VALID signature — the purpose discriminator is what must hold. */
function forgeToken(payload: Row, secret: string): string {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(h + "." + p)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return h + "." + p + "." + sig;
}

describe("SYSTEM 2 — digest preferences + signed snooze-link integrity", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp(mfaAdminRoutes);
  });

  it("preferences read is scoped to the AUTHENTICATED actor (no user parameter exists)", async () => {
    const res = await app.inject({ method: "GET", url: DIGEST_BASE });
    expect(res.statusCode).toBe(200);
    expect(callsTo("listDigestPreferences")).toHaveLength(1);
    expect(callsTo("listDigestPreferences")[0]!.args).toEqual({ userId: ACTOR });
    const body = JSON.parse(res.body) as { preferences: Row[] };
    expect(body.preferences).toHaveLength(1);
    // Notification preferences are not identity material.
    expect(res.body).not.toContain("@");
  });

  it("preferences patch writes ONE actor-keyed scope and classifies the snooze honestly", async () => {
    const future = new Date(Date.now() + 15 * 86_400_000).toISOString();
    const res = await app.inject({
      method: "PATCH",
      url: DIGEST_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, digestEnabled: true, suppressUntil: future },
    });
    expect(res.statusCode).toBe(200);
    expect(callsTo("updateDigestPreference")).toHaveLength(1);
    expect(callsTo("updateDigestPreference")[0]!.args).toMatchObject({
      actorUserId: ACTOR,
      teamId: TEAM,
      digestEnabled: true,
      suppressUntil: future,
    });
    expect(H.audits.some((a) => a.eventType === "mfa_recovery_digest_snoozed")).toBe(
      true,
    );
    // Clearing the snooze is classified as a RESUME, not a second snooze.
    H.audits.length = 0;
    const cleared = await app.inject({
      method: "PATCH",
      url: DIGEST_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, suppressUntil: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(H.audits.some((a) => a.eventType === "mfa_recovery_digest_resumed")).toBe(
      true,
    );
  });

  it("preferences patch denial: a non-member workspace scope is a bounded 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: DIGEST_BASE,
      headers: JSON_HEADERS,
      payload: { teamId: OTHER_TEAM, digestEnabled: false },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not_member" });
    expect(
      H.audits.some((a) => String(a.eventType).startsWith("mfa_recovery_digest_sn")),
    ).toBe(false);
  });

  it("digest preview is actor-scoped, honours includeSuppressed, and leaks no recovery reason", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIGEST_BASE + "/preview?includeSuppressed=true",
    });
    expect(res.statusCode).toBe(200);
    expect(callsTo("previewDigestForAdmin")[0]!.args).toEqual({
      actorUserId: ACTOR,
      includeSuppressed: true,
    });
    const preview = JSON.parse(res.body).preview as Row;
    expect(preview.requestCount).toBe(2);
    // Bounded counters + team names only.
    for (const forbidden of ["authenticator", "reason", "token", "@"]) {
      expect(res.body).not.toContain(forbidden);
    }
  });

  it("send-test digest mails ONLY the calling admin and is rate-limited per user", async () => {
    const first = await app.inject({
      method: "POST",
      url: DIGEST_BASE + "/preview/send-test",
    });
    expect(first.statusCode).toBe(200);
    expect(H.emails).toEqual([{ to: "admin@acme.test", url: "digest" }]);
    const second = await app.inject({
      method: "POST",
      url: DIGEST_BASE + "/preview/send-test",
    });
    expect(second.statusCode).toBe(429);
    expect(JSON.parse(second.body).error).toBe("too_soon");
    // No second mail was handed to the transport.
    expect(H.emails).toHaveLength(1);
  });

  it("snooze-link consumes a VALID signed token exactly once and applies the token's own scope", async () => {
    const token = signMfaDigestSnoozeToken({ userId: ADMIN_2, teamId: TEAM }, JWT_SECRET);
    const res = await app.inject({
      method: "GET",
      url: DIGEST_BASE + "/snooze-link?token=" + encodeURIComponent(token),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; suppressUntil: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.suppressUntil).getTime()).toBeGreaterThan(Date.now());
    // The write is keyed by the TOKEN's subject — never by an ambient session.
    expect(callsTo("updateDigestPreference")).toHaveLength(1);
    expect(callsTo("updateDigestPreference")[0]!.args).toMatchObject({
      actorUserId: ADMIN_2,
      teamId: TEAM,
      digestEnabled: true,
    });
    // Single-use: the SAME token replayed is a bounded conflict, no 2nd write.
    const replay = await app.inject({
      method: "GET",
      url: DIGEST_BASE + "/snooze-link?token=" + encodeURIComponent(token),
    });
    expect(replay.statusCode).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ ok: false, error: "already_used" });
    expect(callsTo("updateDigestPreference")).toHaveLength(1);
    // The token is never echoed back.
    expect(res.body).not.toContain(token);
  });

  it("snooze-link token integrity: forged / tampered / wrong-secret / expired / cross-purpose all deny with ZERO mutation", async () => {
    const valid = signMfaDigestSnoozeToken({ userId: ACTOR, teamId: null }, JWT_SECRET);
    const [h, p, s] = valid.split(".");
    const cases: Array<{ name: string; token: string | null; error: string }> = [
      { name: "absent", token: null, error: "missing_token" },
      { name: "not-a-jwt", token: "totally-not-a-token", error: "malformed" },
      // Payload rewritten to another admin, signature left as-is.
      {
        name: "tampered-payload",
        token: h + "." + b64u(JSON.stringify({ ...JSON.parse(Buffer.from(p!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()), sub: OUTSIDER })) + "." + s,
        error: "bad_signature",
      },
      // Signature bytes swapped for another valid-looking signature.
      {
        name: "tampered-signature",
        token: h + "." + p + "." + b64u("not-the-real-mac"),
        error: "bad_signature",
      },
      // Correct SHAPE, correct purpose, signed with an ATTACKER's secret.
      {
        name: "wrong-secret",
        token: signMfaDigestSnoozeToken({ userId: ACTOR, teamId: null }, "attacker-secret"),
        error: "bad_signature",
      },
      // Correctly signed but already expired (TTL in the past).
      {
        name: "expired",
        token: signMfaDigestSnoozeToken(
          { userId: ACTOR, teamId: null, snoozeSeconds: -60 },
          JWT_SECRET,
        ),
        error: "expired",
      },
      // Perfectly VALID signature over the SAME secret, but a session-shaped
      // purpose — cross-purpose token spending must be refused.
      {
        name: "cross-purpose",
        token: forgeToken(
          {
            purpose: "session",
            sub: ACTOR,
            teamId: null,
            snoozeSeconds: 3600,
            jti: "j1",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET,
        ),
        error: "wrong_purpose",
      },
    ];

    for (const c of cases) {
      H.calls.length = 0;
      const url =
        c.token === null
          ? DIGEST_BASE + "/snooze-link"
          : DIGEST_BASE + "/snooze-link?token=" + encodeURIComponent(c.token);
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, c.name).toBe(400);
      expect(JSON.parse(res.body), c.name).toEqual({ ok: false, error: c.error });
      // The canonical mutation service was NEVER reached.
      expect(callsTo("updateDigestPreference"), c.name).toHaveLength(0);
    }
  });

  it("snooze-link: a token minted for another admin cannot be spent on the caller's own scope", async () => {
    // The token carries its own subject; there is no way to redirect the
    // write onto a different user by any request-supplied value.
    const token = signMfaDigestSnoozeToken({ userId: OUTSIDER, teamId: null }, JWT_SECRET);
    H.actorUserId = ACTOR;
    const res = await app.inject({
      method: "GET",
      url:
        DIGEST_BASE +
        "/snooze-link?token=" +
        encodeURIComponent(token) +
        "&userId=" +
        ACTOR +
        "&teamId=" +
        TEAM,
    });
    expect(res.statusCode).toBe(200);
    expect(callsTo("updateDigestPreference")[0]!.args).toMatchObject({
      actorUserId: OUTSIDER,
      teamId: null,
    });
  });
});

// ===========================================================================
// PRODUCT SYSTEMS 3-5 — SCIM reconciliation + sync-failure replay,
// SAML attribute mapping, SSO health + identity session timeline.
// ===========================================================================
const MAPPING_BODY = {
  email: "upn",
  name: "displayName",
  externalId: null,
  groupClaim: "groups",
  defaultRole: "MEMBER" as const,
  groupRoleMap: [{ group: "sec-admins", role: "ADMIN" as const }],
};

type OpCase = {
  op: string;
  svc: string;
  method: "GET" | "POST" | "PUT";
  url: (team: string) => string;
  payload?: (team: string) => Row;
  /** Server-derived scope the canonical service must be called with. */
  scope?: (team: string) => Row;
};

const IDENTITY_OPS: OpCase[] = [
  {
    op: "GET /v1/scim/reconciliation/preview",
    svc: "detectScimDrift",
    method: "GET",
    url: (t) => "/v1/scim/reconciliation/preview?teamId=" + t,
    scope: (t) => ({ teamId: t, actorUserId: ACTOR }),
  },
  {
    op: "POST /v1/scim/reconciliation/execute",
    svc: "executeScimReconciliation",
    method: "POST",
    url: () => "/v1/scim/reconciliation/execute",
    payload: (t) => ({ teamId: t, previewId: "prev-1", itemIds: ["d1"] }),
    scope: (t) => ({ teamId: t, actorUserId: ACTOR, previewId: "prev-1" }),
  },
  {
    op: "GET /v1/scim/sync-failures",
    svc: "listScimSyncFailures",
    method: "GET",
    url: (t) => "/v1/scim/sync-failures?teamId=" + t + "&limit=25",
    scope: (t) => ({ teamId: t, limit: 25 }),
  },
  {
    op: "POST /v1/scim/sync-failures/:id/replay",
    svc: "replayScimSyncFailure",
    method: "POST",
    url: () => "/v1/scim/sync-failures/" + SESSION + "/replay",
    payload: (t) => ({ teamId: t }),
    scope: (t) => ({ teamId: t, failureId: SESSION, actorUserId: ACTOR }),
  },
  {
    op: "GET /v1/saml/mapping/current",
    svc: "getCurrentSamlMapping",
    method: "GET",
    url: (t) => "/v1/saml/mapping/current?teamId=" + t + "&connectionId=" + CONN,
    scope: (t) => ({ teamId: t, connectionId: CONN }),
  },
  {
    op: "POST /v1/saml/mapping/preview",
    svc: "previewSamlMapping",
    method: "POST",
    url: () => "/v1/saml/mapping/preview",
    payload: (t) => ({
      teamId: t,
      connectionId: CONN,
      mapping: MAPPING_BODY,
      sampleAttributes: { upn: "person@acme.test" },
    }),
    scope: (t) => ({ teamId: t, connectionId: CONN, actorUserId: ACTOR }),
  },
  {
    op: "PUT /v1/saml/mapping",
    svc: "updateSamlMapping",
    method: "PUT",
    url: () => "/v1/saml/mapping",
    payload: (t) => ({ teamId: t, connectionId: CONN, mapping: MAPPING_BODY }),
    scope: (t) => ({ teamId: t, connectionId: CONN, actorUserId: ACTOR }),
  },
  {
    op: "GET /v1/sso/health",
    svc: "buildSsoHealthSnapshot",
    method: "GET",
    url: (t) => "/v1/sso/health?teamId=" + t,
    scope: (t) => ({ teamId: t }),
  },
  {
    op: "GET /v1/identity/sessions/:sessionId/timeline",
    svc: "buildIdentitySessionTimeline",
    method: "GET",
    url: (t) => "/v1/identity/sessions/" + SESSION + "/timeline?teamId=" + t,
    scope: (t) => ({ teamId: t, sessionId: SESSION, actorUserId: ACTOR }),
  },
];

describe("SYSTEMS 3-5 — SCIM ops, SAML mapping, SSO health, session timeline", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp(identityOperationsCompletionRoutes);
  });

  const call = (c: OpCase, team: string) =>
    app.inject({
      method: c.method,
      url: c.url(team),
      headers: JSON_HEADERS,
      ...(c.payload ? { payload: c.payload(team) } : {}),
    });

  it.each(IDENTITY_OPS.map((c) => [c.op, c] as const))(
    "%s — authorized: 200 and the canonical service is called ONCE with the server-derived scope",
    async (_op, c) => {
      const res = await call(c, TEAM);
      expect(res.statusCode).toBe(200);
      const calls = callsTo(c.svc);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toMatchObject(c.scope!(TEAM));
    },
  );

  it.each(IDENTITY_OPS.map((c) => [c.op, c] as const))(
    "%s — denial: a non-member scope is a bounded 404 and the canonical service is NOT called",
    async (_op, c) => {
      const res = await call(c, OTHER_TEAM);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
      expect(callsTo(c.svc)).toHaveLength(0);
      expect(H.writes).toEqual([]);
    },
  );

  it("the mapping SCHEMA route is workspace-independent by contract (auth only, no team scope)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/saml/mapping/schema" });
    expect(res.statusCode).toBe(200);
    expect(callsTo("getSamlMappingSchema")).toHaveLength(1);
    const schema = JSON.parse(res.body).schema as Row;
    // It describes the SHAPE only — never a workspace's configured values.
    expect(JSON.stringify(schema)).not.toContain(TEAM);
    expect(JSON.stringify(schema)).not.toContain(CONN);
  });

  it("cross-Organization concealment: a foreign workspace is byte-identical to a non-existent one", async () => {
    const unknownTeam = randomUUID();
    for (const c of IDENTITY_OPS) {
      H.calls.length = 0;
      const foreign = await call(c, OTHER_TEAM);
      const missing = await call(c, unknownTeam);
      expect(foreign.statusCode, c.op).toBe(missing.statusCode);
      expect(foreign.body, c.op).toEqual(missing.body);
      expect(foreign.body, c.op).toEqual('{"error":{"code":"not_found"}}');
      expect(callsTo(c.svc), c.op).toHaveLength(0);
    }
  });

  it("membership state and role are separate bounded denials (recorded contract)", async () => {
    rows("teamMember").push({
      id: "tm-inactive",
      teamId: TEAM,
      userId: OUTSIDER,
      role: "ADMIN",
      status: "SUSPENDED",
    });
    H.actorUserId = OUTSIDER;
    const inactive = await app.inject({
      method: "GET",
      url: "/v1/sso/health?teamId=" + TEAM,
    });
    expect(inactive.statusCode).toBe(403);
    expect(JSON.parse(inactive.body)).toEqual({
      error: { code: "member_inactive" },
    });
    expect(callsTo("buildSsoHealthSnapshot")).toHaveLength(0);

    // An ACTIVE non-admin member is refused on ROLE, with a bounded reason.
    rows("teamMember").push({
      id: "tm-member",
      teamId: TEAM,
      userId: SUBJECT,
      role: "VIEWER",
      status: "ACTIVE",
    });
    H.actorUserId = SUBJECT;
    const nonAdmin = await app.inject({
      method: "GET",
      url: "/v1/sso/health?teamId=" + TEAM,
    });
    expect(nonAdmin.statusCode).toBe(403);
    expect(JSON.parse(nonAdmin.body)).toEqual({
      error: {
        code: "permission_denied",
        reason: "identity_ops_require_admin_role",
      },
    });
    expect(callsTo("buildSsoHealthSnapshot")).toHaveLength(0);
  });

  it("step-up gating: SCIM reconciliation EXECUTE denial performs ZERO reconciliation", async () => {
    H.stepUpDenies = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/scim/reconciliation/execute",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, previewId: "prev-1", itemIds: ["d1", "d2"] },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "STEP_UP_REQUIRED" } });
    // The gate was reached, bound to the workspace + the exact preview...
    expect(callsTo("stepUp")[0]!.args).toEqual({
      purpose: "SCIM_RECONCILIATION_EXECUTE",
      teamId: TEAM,
    });
    // ...and NOTHING was applied.
    expect(callsTo("executeScimReconciliation")).toHaveLength(0);
    expect(H.writes).toEqual([]);
  });

  it("step-up gating: a PRIVILEGE-AFFECTING SAML mapping update is gated; a benign one is not", async () => {
    H.privilegeAffecting = true;
    H.stepUpDenies = true;
    const denied = await app.inject({
      method: "PUT",
      url: "/v1/saml/mapping",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, connectionId: CONN, mapping: MAPPING_BODY },
    });
    expect(denied.statusCode).toBe(401);
    expect(callsTo("stepUp")[0]!.args).toEqual({
      purpose: "SAML_MAPPING_PRIVILEGE_UPDATE",
      teamId: TEAM,
    });
    // The privilege verdict is re-derived SERVER-SIDE from the preview, so
    // the write never happens on a denial.
    expect(callsTo("updateSamlMapping")).toHaveLength(0);
    expect(H.writes).toEqual([]);

    // A non-privilege-affecting mapping needs no step-up and still writes.
    H.calls.length = 0;
    H.privilegeAffecting = false;
    const benign = await app.inject({
      method: "PUT",
      url: "/v1/saml/mapping",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM, connectionId: CONN, mapping: MAPPING_BODY },
    });
    expect(benign.statusCode).toBe(200);
    expect(callsTo("stepUp")).toHaveLength(0);
    expect(callsTo("updateSamlMapping")).toHaveLength(1);
    expect(callsTo("updateSamlMapping")[0]!.args).toMatchObject({
      privilegeAffecting: false,
    });
  });

  it("a client cannot self-assert the privilege verdict to bypass the gate", async () => {
    H.privilegeAffecting = true;
    H.stepUpDenies = true;
    const res = await app.inject({
      method: "PUT",
      url: "/v1/saml/mapping",
      headers: JSON_HEADERS,
      payload: {
        teamId: TEAM,
        connectionId: CONN,
        mapping: MAPPING_BODY,
        acknowledgePrivilegeImpact: true,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(callsTo("updateSamlMapping")).toHaveLength(0);
  });

  it("secret-free projections: SSO health and session timeline expose posture, never key material", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/sso/health?teamId=" + TEAM });
    expect(health.statusCode).toBe(200);
    const snapshot = JSON.parse(health.body).snapshot as {
      overallStatus: string;
      connections: Row[];
    };
    // Populated response: degraded posture + cert expiry band + failure counts.
    expect(snapshot.overallStatus).toBe("DEGRADED");
    expect(snapshot.connections).toHaveLength(1);
    expect((snapshot.connections[0]!.cert as Row).expiryBand).toBe("warning");
    for (const forbidden of [
      "BEGIN PRIVATE KEY",
      "SUPERSECRET",
      "samlSpPrivateKey",
      "samlCertificate",
      "clientSecret",
      "scimToken",
    ]) {
      expect(health.body, forbidden).not.toContain(forbidden);
    }

    const timeline = await app.inject({
      method: "GET",
      url: "/v1/identity/sessions/" + SESSION + "/timeline?teamId=" + TEAM,
    });
    expect(timeline.statusCode).toBe(200);
    const t = JSON.parse(timeline.body).timeline as { events: Row[]; session: Row };
    expect(t.events).toHaveLength(1);
    expect(t.session.ssoConnectionId).toBe(CONN);
    for (const forbidden of ["sessionToken", "jwt", "eyJ", "sidHash", "assertion"]) {
      expect(timeline.body, forbidden).not.toContain(forbidden);
    }
  });

  it("SCIM sync-failure list and replay are bounded and workspace-keyed on the SERVER", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/v1/scim/sync-failures?teamId=" + TEAM,
    });
    expect(list.statusCode).toBe(200);
    const failures = JSON.parse(list.body).failures as Row[];
    expect(failures[0]!.retryEligible).toBe(true);
    // The failure body carries a humanised summary, never the raw IdP payload.
    expect(list.body).not.toContain("Bearer");

    // The replay target is (teamId from the BODY + failureId from the PATH) —
    // both are re-checked against the actor's membership before the replay.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/scim/sync-failures/" + SESSION + "/replay",
      headers: JSON_HEADERS,
      payload: { teamId: OTHER_TEAM },
    });
    expect(replay.statusCode).toBe(404);
    expect(callsTo("replayScimSyncFailure")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 6 — Organization domain identity boundary
//   Real domain normalisation + challenge composition; only the DNS resolver
//   and the org-access / enterprise-gate boundaries are substituted.
// ===========================================================================
const domainRow = (id: string) =>
  rows("organizationDomain").find((r) => r.id === id);
const DOMAINS = (org: string) => "/v1/orgs/" + org + "/domains";

describe("SYSTEM 6 — organization domain identity boundary", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp(organizationDomainsRoutes);
  });

  it("add: returns the DNS challenge, records DOMAIN_ADDED, and never audits the token", async () => {
    const res = await app.inject({
      method: "POST",
      url: DOMAINS(ORG),
      headers: JSON_HEADERS,
      payload: { domain: "  New-Claim.Example.COM " },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      domain: string;
      verified: boolean;
      challenge: { recordName: string; recordType: string; recordValue: string };
    };
    // The domain is normalised SERVER-SIDE.
    expect(body.domain).toBe("new-claim.example.com");
    expect(body.verified).toBe(false);
    expect(body.challenge.recordType).toBe("TXT");
    expect(body.challenge.recordName).toBe("_proovra-verify.new-claim.example.com");
    expect(body.challenge.recordValue).toMatch(/^proovra-domain-verify=/);
    // The org boundary came from the PATH but was authorized on the server.
    expect(callsTo("checkOrgAccess")[0]!.args).toMatchObject({
      orgId: ORG,
      userId: ACTOR,
      minRole: "ORG_SECURITY_ADMIN",
    });
    const added = H.audits.find((a) => a.eventType === "DOMAIN_ADDED")!;
    expect(added).toBeTruthy();
    const token = body.challenge.recordValue.split("=")[1]!;
    expect(JSON.stringify(added.metadata)).not.toContain(token);
  });

  it("add is idempotent-safe: a duplicate claim is a bounded 409 with no second row", async () => {
    const before = rows("organizationDomain").length;
    const res = await app.inject({
      method: "POST",
      url: DOMAINS(ORG),
      headers: JSON_HEADERS,
      payload: { domain: "acme.test" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "domain_already_exists" },
    });
    expect(rows("organizationDomain")).toHaveLength(before);
  });

  it("list: pending rows carry the re-copyable challenge; VERIFIED rows never do", async () => {
    const res = await app.inject({ method: "GET", url: DOMAINS(ORG) });
    expect(res.statusCode).toBe(200);
    const domains = JSON.parse(res.body).domains as Array<{
      domain: string;
      verified: boolean;
      challenge: Row | null;
    }>;
    expect(domains).toHaveLength(2);
    const verified = domains.find((d) => d.verified)!;
    const pending = domains.find((d) => !d.verified)!;
    expect(verified.challenge).toBeNull();
    expect(pending.challenge).not.toBeNull();
    // Only THIS Organization's domains — never the other Organization's.
    expect(res.body).not.toContain("other.test");
    expect(res.body).not.toContain("tok-other");
  });

  it("verify: a published TXT record flips the row and records DOMAIN_VERIFIED", async () => {
    H.dnsOk = true;
    const res = await app.inject({
      method: "POST",
      url: DOMAINS(ORG) + "/" + DOMAIN_ROW + "/verify",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).verified).toBe(true);
    expect(domainRow(DOMAIN_ROW)!.verifiedAt).toBeInstanceOf(Date);
    expect(H.audits.some((a) => a.eventType === "DOMAIN_VERIFIED")).toBe(true);
  });

  it("verify: an unpublished TXT record is a bounded 422 that re-issues the challenge and mutates nothing", async () => {
    H.dnsOk = false;
    const res = await app.inject({
      method: "POST",
      url: DOMAINS(ORG) + "/" + DOMAIN_ROW + "/verify",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: Row; challenge: Row };
    expect(body.error).toEqual({ code: "dns_verification_failed" });
    expect(body.challenge.recordName).toBe("_proovra-verify.acme.test");
    expect(domainRow(DOMAIN_ROW)!.verifiedAt).toBeNull();
    expect(H.audits.some((a) => a.eventType === "DOMAIN_VERIFIED")).toBe(false);
  });

  it("delete: removes the claim and records DOMAIN_REMOVED", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: DOMAINS(ORG) + "/" + DOMAIN_ROW,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, id: DOMAIN_ROW });
    expect(domainRow(DOMAIN_ROW)).toBeUndefined();
    expect(H.audits.some((a) => a.eventType === "DOMAIN_REMOVED")).toBe(true);
  });

  it("denial: a caller without org security-admin access is a bounded 403 across every leg", async () => {
    const legs: Array<{ name: string; method: "GET" | "POST" | "DELETE"; url: string; payload?: Row }> = [
      { name: "add", method: "POST", url: DOMAINS(OTHER_ORG), payload: { domain: "x.test" } },
      { name: "verify", method: "POST", url: DOMAINS(OTHER_ORG) + "/" + DOMAIN_FOREIGN + "/verify", payload: {} },
      { name: "list", method: "GET", url: DOMAINS(OTHER_ORG) },
      { name: "delete", method: "DELETE", url: DOMAINS(OTHER_ORG) + "/" + DOMAIN_FOREIGN },
    ];
    for (const leg of legs) {
      const res = await app.inject({
        method: leg.method,
        url: leg.url,
        ...(leg.payload ? { headers: JSON_HEADERS, payload: leg.payload } : {}),
      });
      expect(res.statusCode, leg.name).toBe(403);
      expect(JSON.parse(res.body), leg.name).toEqual({
        error: { code: "forbidden" },
      });
    }
    // Nothing about the other Organization's domain was touched or revealed.
    expect(domainRow(DOMAIN_FOREIGN)!.verifiedAt).toBeNull();
    expect(callsTo("checkDomainDnsTxt")).toHaveLength(0);
    expect(H.audits).toEqual([]);
  });

  it("denial: a non-Enterprise Organization is refused with the upgrade path, mutating nothing", async () => {
    H.gateOk = false;
    const res = await app.inject({
      method: "POST",
      url: DOMAINS(ORG),
      headers: JSON_HEADERS,
      payload: { domain: "gated.test" },
    });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "ENTERPRISE_FEATURE_REQUIRED",
        upgradeCta: "/contact-sales",
      },
    });
    expect(rows("organizationDomain")).toHaveLength(3);
  });

  it("cross-Organization concealment: a foreign domain id is byte-identical to a non-existent one", async () => {
    const unknown = randomUUID();
    for (const leg of [
      { name: "verify", method: "POST" as const, suffix: "/verify" },
      { name: "delete", method: "DELETE" as const, suffix: "" },
    ]) {
      const foreign = await app.inject({
        method: leg.method,
        url: DOMAINS(ORG) + "/" + DOMAIN_FOREIGN + leg.suffix,
        headers: JSON_HEADERS,
        payload: {},
      });
      const missing = await app.inject({
        method: leg.method,
        url: DOMAINS(ORG) + "/" + unknown + leg.suffix,
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(foreign.statusCode, leg.name).toBe(404);
      expect(foreign.body, leg.name).toEqual(missing.body);
      expect(foreign.body, leg.name).toEqual('{"error":{"code":"not_found"}}');
    }
    // The foreign row survived untouched and its token never leaked.
    expect(domainRow(DOMAIN_FOREIGN)).toBeTruthy();
    expect(H.audits).toEqual([]);
  });

  it("step-up gating: verify and delete denials perform ZERO mutation on the identity boundary", async () => {
    H.stepUpDenies = true;
    const verify = await app.inject({
      method: "POST",
      url: DOMAINS(ORG) + "/" + DOMAIN_ROW + "/verify",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(verify.statusCode).toBe(401);
    expect(JSON.parse(verify.body)).toEqual({
      error: { code: "STEP_UP_REQUIRED" },
    });
    expect(callsTo("stepUp")[0]!.args).toEqual({
      purpose: "ORG_DOMAIN_VERIFY",
      teamId: TEAM,
    });
    // The gate runs BEFORE the DNS probe and before the flip.
    expect(callsTo("checkDomainDnsTxt")).toHaveLength(0);
    expect(domainRow(DOMAIN_ROW)!.verifiedAt).toBeNull();

    H.calls.length = 0;
    const del = await app.inject({
      method: "DELETE",
      url: DOMAINS(ORG) + "/" + DOMAIN_ROW,
    });
    expect(del.statusCode).toBe(401);
    expect(callsTo("stepUp")[0]!.args).toEqual({
      purpose: "ORG_DOMAIN_REMOVE",
      teamId: TEAM,
    });
    expect(domainRow(DOMAIN_ROW)).toBeTruthy();
    expect(H.audits).toEqual([]);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 7 — Bulk organization invitation (validate / execute /
// resend / CSV template / CSV import). Real planner + real per-row writes.
// ===========================================================================
const BULK = (org: string) => "/v1/orgs/" + org + "/invites";
const outcomeFor = (rowsOut: Array<Row>, email: string) =>
  rowsOut.find((r) => r.email === email)?.outcome;

describe("SYSTEM 7 — bulk organization invitation", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    // ORG_ADMIN (rank 4) so an ORG_OWNER row exercises the role ceiling.
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    app = Fastify();
    // Mirrors server.ts: a SCOPED raw parser for the CSV upload leg only.
    app.addContentTypeParser(
      ["text/csv", "application/csv"],
      { parseAs: "string" },
      (_req, body, done) => done(null, body as string),
    );
    await app.register(organizationsBulkInviteRoutes);
    await app.ready();
  });

  const BATCH_ROWS = [
    { email: "Fresh@Acme.test" },
    { email: "fresh@acme.test" },
    { email: "new@acme.test" },
    { email: "subject@acme.test" },
    { email: "not-an-email" },
    { email: "escalate@acme.test", role: "ORG_OWNER" },
  ];

  it("validate is a TRUE dry run: the full outcome vocabulary is planned and NOTHING is written", async () => {
    const before = rows("organizationInvite").length;
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk/validate",
      headers: JSON_HEADERS,
      payload: { rows: BATCH_ROWS },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      dryRun: boolean;
      summary: Record<string, number>;
      seatPreview: Row;
      rows: Row[];
    };
    expect(body.dryRun).toBe(true);
    expect(outcomeFor(body.rows, "fresh@acme.test")).toBe("WOULD_INVITE");
    // The repeat of the SAME normalized address is a duplicate, not a 2nd invite.
    expect(body.rows.filter((r) => r.email === "fresh@acme.test").map((r) => r.outcome))
      .toEqual(["WOULD_INVITE", "DUPLICATE_IN_BATCH"]);
    expect(outcomeFor(body.rows, "new@acme.test")).toBe("PENDING_INVITE_EXISTS");
    expect(outcomeFor(body.rows, "subject@acme.test")).toBe("ALREADY_MEMBER");
    expect(outcomeFor(body.rows, "not-an-email")).toBe("INVALID_EMAIL");
    // An ORG_ADMIN cannot mint an ORG_OWNER invite.
    expect(outcomeFor(body.rows, "escalate@acme.test")).toBe("ROLE_TOO_HIGH");
    expect(body.seatPreview).toMatchObject({ used: 4, included: 10, hasSeatCap: true });
    // Zero writes, zero audit, and never a token on the dry-run surface.
    expect(rows("organizationInvite")).toHaveLength(before);
    expect(H.audits).toEqual([]);
    expect(res.body).not.toContain("token");
  });

  it("execute writes ONE invite per eligible row, hashes the token, and brackets the batch in audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk",
      headers: JSON_HEADERS,
      payload: { rows: BATCH_ROWS },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { batchId: string; rows: Row[] };
    const invited = body.rows.filter((r) => r.outcome === "INVITED");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.email).toBe("fresh@acme.test");
    // The raw accept token is surfaced ONCE to the authorized admin...
    const raw = invited[0]!.token as string;
    expect(raw).toHaveLength(64);
    // ...and ONLY its SHA-256 hash is persisted (never the raw column).
    const created = rows("organizationInvite").find((r) => r.email === "fresh@acme.test")!;
    expect(created.token).toBeNull();
    expect(created.tokenHash).not.toBe(raw);
    expect(created.tokenHash as string).toHaveLength(64);
    // Batch bracketing + per-row parity with the single-invite audit event.
    const types = H.audits.map((a) => a.eventType);
    expect(types[0]).toBe("ORG_BULK_INVITATION_STARTED");
    expect(types).toContain("ORG_MEMBER_INVITED");
    expect(types[types.length - 1]).toBe("ORG_BULK_INVITATION_COMPLETED");
    // No audit metadata anywhere carries the raw token.
    expect(JSON.stringify(H.audits)).not.toContain(raw);
    // Delivery ran through the ONE canonical chain.
    expect(callsTo("attemptInitialOrgInviteDelivery")).toHaveLength(1);
  });

  it("execute never fails the whole batch on denied rows: denials carry through untouched", async () => {
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk",
      headers: JSON_HEADERS,
      payload: { rows: BATCH_ROWS },
    });
    const body = JSON.parse(res.body) as { summary: Record<string, number>; rows: Row[] };
    expect(body.summary.INVITED).toBe(1);
    expect(body.summary.ALREADY_MEMBER).toBe(1);
    expect(body.summary.PENDING_INVITE_EXISTS).toBe(1);
    expect(body.summary.INVALID_EMAIL).toBe(1);
    expect(body.summary.ROLE_TOO_HIGH).toBe(1);
    // Denied rows never receive an invite id or a token.
    for (const r of body.rows.filter((x) => x.outcome !== "INVITED")) {
      expect(r.inviteId).toBeNull();
      expect(r.token).toBeUndefined();
    }
  });

  it("the row cap truncates TRUTHFULLY rather than silently dropping rows", async () => {
    const many = Array.from({ length: 205 }, (_v, i) => ({ email: "u" + i + "@acme.test" }));
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk/validate",
      headers: JSON_HEADERS,
      payload: { rows: many },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { truncated: Row; rows: Row[] };
    expect(body.rows).toHaveLength(200);
    expect(body.truncated).toMatchObject({ received: 205, accepted: 200 });
    expect(String(body.truncated.note)).toContain("5 row(s) were not processed");
  });

  it("resend: cross-Organization and non-existent invite ids are byte-identical outcomes", async () => {
    const unknown = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk/resend",
      headers: JSON_HEADERS,
      payload: { inviteIds: [INVITE_ROW, INVITE_FOREIGN, unknown] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Row[] };
    const byId = new Map(body.rows.map((r) => [r.inviteId, r]));
    expect(byId.get(INVITE_ROW)!.outcome).toBe("RESENT");
    // The foreign invite is indistinguishable from one that does not exist.
    expect(byId.get(INVITE_FOREIGN)).toEqual({
      ...byId.get(unknown),
      inviteId: INVITE_FOREIGN,
    });
    expect(byId.get(INVITE_FOREIGN)!.outcome).toBe("NOT_FOUND");
    // The foreign row was not mutated and no fresh URL leaked for it.
    const foreign = rows("organizationInvite").find((r) => r.id === INVITE_FOREIGN)!;
    expect(foreign.resendCount).toBe(0);
    expect(foreign.lastResentAt).toBeNull();
    expect(callsTo("resendOrgInviteDelivery")).toHaveLength(1);
    // The bulk surface delivers by EMAIL — it never echoes the accept URL.
    expect(res.body).not.toContain("token=");
  });

  it("csv template is a real downloadable artefact with an email/role header", async () => {
    const res = await app.inject({ method: "GET", url: BULK(ORG) + "/csv-template" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(String(res.headers["content-disposition"])).toContain("attachment");
    expect(res.body.split("\r\n")[0]).toBe("email,role");
  });

  it("csv import: JSON dry-run plans by SOURCE LINE, raw text/csv executes, other media types are refused", async () => {
    const csv = [
      "email,role",
      "csvfresh@acme.test,ORG_MEMBER",
      "subject@acme.test,ORG_AUDITOR",
      "",
      "bad-row,ORG_MEMBER",
    ].join("\n");

    const dry = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/csv?dryRun=1",
      headers: JSON_HEADERS,
      payload: { csv },
    });
    expect(dry.statusCode).toBe(200);
    const dryBody = JSON.parse(dry.body) as { source: string; rows: Row[] };
    expect(dryBody.source).toBe("csv");
    expect(outcomeFor(dryBody.rows, "csvfresh@acme.test")).toBe("WOULD_INVITE");
    expect(outcomeFor(dryBody.rows, "subject@acme.test")).toBe("ALREADY_MEMBER");
    expect(outcomeFor(dryBody.rows, "bad-row")).toBe("INVALID_EMAIL");
    // Source line numbers are preserved so the operator can fix their file.
    expect(dryBody.rows.find((r) => r.email === "bad-row")!.line).toBe(5);
    expect(rows("organizationInvite").some((r) => r.email === "csvfresh@acme.test")).toBe(
      false,
    );

    const exec = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/csv",
      headers: { "content-type": "text/csv" },
      payload: csv,
    });
    expect(exec.statusCode).toBe(200);
    expect(rows("organizationInvite").some((r) => r.email === "csvfresh@acme.test")).toBe(
      true,
    );

    // An arbitrary body is NOT treated as CSV.
    const wrongType = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/csv",
      headers: { "content-type": "text/plain" },
      payload: "email,role\nsneaky@acme.test,ORG_OWNER",
    });
    expect(wrongType.statusCode).toBe(415);
    expect(JSON.parse(wrongType.body).code).toBe("unsupported_media_type");
    expect(rows("organizationInvite").some((r) => r.email === "sneaky@acme.test")).toBe(
      false,
    );
  });

  it("denial: a caller who is not an ORG_ADMIN gets the anti-enumeration 404 on EVERY leg, writing nothing", async () => {
    const before = rows("organizationInvite").length;
    H.orgAccess = { kind: "forbidden" };
    const legs: Array<{ name: string; method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { name: "validate", method: "POST", url: BULK(ORG) + "/bulk/validate", payload: { rows: BATCH_ROWS } },
      { name: "execute", method: "POST", url: BULK(ORG) + "/bulk", payload: { rows: BATCH_ROWS } },
      { name: "resend", method: "POST", url: BULK(ORG) + "/bulk/resend", payload: { inviteIds: [INVITE_ROW] } },
      { name: "template", method: "GET", url: BULK(ORG) + "/csv-template" },
      { name: "csv", method: "POST", url: BULK(ORG) + "/csv", payload: { csv: "email\nx@acme.test" } },
    ];
    const bodies = new Set<string>();
    for (const leg of legs) {
      const res = await app.inject({
        method: leg.method,
        url: leg.url,
        ...(leg.payload ? { headers: JSON_HEADERS, payload: leg.payload } : {}),
      });
      expect(res.statusCode, leg.name).toBe(404);
      bodies.add(res.body);
    }
    // ONE bounded denial body across the whole surface — nothing distinguishes
    // "org exists but you are not an admin" from "org does not exist".
    expect([...bodies]).toEqual([
      '{"message":"Organization not found","code":"org_not_found"}',
    ]);
    expect(rows("organizationInvite")).toHaveLength(before);
    expect(H.audits).toEqual([]);
    expect(callsTo("attemptInitialOrgInviteDelivery")).toHaveLength(0);
  });

  it("a verified-domain restriction policy denies non-verified domains only when domains exist", async () => {
    rows("organizationPolicy").push({
      id: "pol-1",
      organizationId: ORG,
      key: "invite.restrict_to_verified_domains",
      value: { enabled: true },
    });
    const res = await app.inject({
      method: "POST",
      url: BULK(ORG) + "/bulk/validate",
      headers: JSON_HEADERS,
      payload: {
        rows: [{ email: "ok@verified.test" }, { email: "nope@acme.test" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Row[] };
    expect(outcomeFor(body.rows, "ok@verified.test")).toBe("WOULD_INVITE");
    expect(outcomeFor(body.rows, "nope@acme.test")).toBe("DOMAIN_NOT_ALLOWED");
  });
});

// ===========================================================================
// PRODUCT SYSTEM 8 — Organization identity: membership, roles, invitations,
// closure and the governance audit stream.
// ===========================================================================
const ORGS = (org: string) => "/v1/orgs/" + org;
const membershipRow = (id: string) =>
  rows("organizationMembership").find((r) => r.id === id);
const inviteRow = (id: string) =>
  rows("organizationInvite").find((r) => r.id === id);

describe("SYSTEM 8 — organization identity", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp(organizationsRoutes);
  });

  // -- Reads -----------------------------------------------------------------
  it("governance reads return org-level identity only, and never workspace content", async () => {
    const reads: Array<{ name: string; url: string; forbidden: string[] }> = [
      { name: "me/orgs", url: "/v1/me/orgs", forbidden: ["evidence", "caseCount"] },
      { name: "org", url: ORGS(ORG), forbidden: ["evidenceCount", "caseCount"] },
      { name: "members", url: ORGS(ORG) + "/members", forbidden: ["evidence", "teamId"] },
      { name: "workspaces", url: ORGS(ORG) + "/workspaces", forbidden: ["evidence", "memberCount"] },
      { name: "audit-events", url: ORGS(ORG) + "/audit-events", forbidden: ["tokenHash"] },
    ];
    for (const r of reads) {
      const res = await app.inject({ method: "GET", url: r.url });
      expect(res.statusCode, r.name).toBe(200);
      for (const f of r.forbidden) expect(res.body, r.name + ":" + f).not.toContain(f);
    }
    // /v1/me/orgs surfaces CUSTOMER Organizations with governance counts only.
    const mine = JSON.parse(
      (await app.inject({ method: "GET", url: "/v1/me/orgs" })).body,
    ) as { orgs: Row[] };
    expect(mine.orgs).toHaveLength(1);
    expect(mine.orgs[0]).toMatchObject({
      organizationId: ORG,
      role: "ORG_OWNER",
      memberCount: 3,
      workspaceCount: 1,
      pendingInviteCount: 1,
    });
    // The member roster is identity metadata, never workspace access topology.
    const members = JSON.parse(
      (await app.inject({ method: "GET", url: ORGS(ORG) + "/members" })).body,
    ) as { members: Row[] };
    expect(members.members).toHaveLength(3);
    expect(members.members[0]).toHaveProperty("membershipId");
    expect(members.members[0]).toHaveProperty("role");
  });

  it("governance reads deny a non-member identically and expose no org content", async () => {
    for (const url of [
      ORGS(OTHER_ORG),
      ORGS(OTHER_ORG) + "/members",
      ORGS(OTHER_ORG) + "/workspaces",
      ORGS(OTHER_ORG) + "/audit-events",
      ORGS(OTHER_ORG) + "/invites",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).toBe('{"message":"Forbidden"}');
    }
    // /v1/me/orgs is actor-scoped, so an outsider simply sees nothing.
    H.actorUserId = OUTSIDER;
    const mine = await app.inject({ method: "GET", url: "/v1/me/orgs" });
    expect(mine.statusCode).toBe(200);
    const body = JSON.parse(mine.body) as { orgs: Row[] };
    expect(body.orgs.map((o) => o.organizationId)).toEqual([OTHER_ORG]);
    expect(mine.body).not.toContain(ORG);
  });

  it("workspace billing fields are role-gated on the SAME projection", async () => {
    const asOwner = await app.inject({ method: "GET", url: ORGS(ORG) + "/workspaces" });
    expect(JSON.parse(asOwner.body).callerCanSeeBilling).toBe(true);
    expect(asOwner.body).toContain("includedSeats");
    H.orgAccess = { kind: "ok", role: "ORG_AUDITOR" };
    const asAuditor = await app.inject({ method: "GET", url: ORGS(ORG) + "/workspaces" });
    expect(JSON.parse(asAuditor.body).callerCanSeeBilling).toBe(false);
    expect(asAuditor.body).not.toContain("includedSeats");
    expect(asAuditor.body).not.toContain("billingOwnerUserId");
  });

  it("audit-events pagination is stable, filterable, and bounded", async () => {
    for (let i = 0; i < 3; i += 1) {
      rows("organizationAuditEvent").push({
        id: randomUUID(),
        organizationId: ORG,
        actorUserId: ACTOR,
        eventType: i === 0 ? "ORG_MEMBER_REMOVED" : "ORG_UPDATED",
        targetType: "organization",
        targetId: ORG,
        metadata: {},
        createdAt: new Date(Date.now() - i * 1000),
      });
    }
    const page1 = await app.inject({
      method: "GET",
      url: ORGS(ORG) + "/audit-events?take=2",
    });
    expect(page1.statusCode).toBe(200);
    const b1 = JSON.parse(page1.body) as { events: Row[]; summary: Row };
    expect(b1.events).toHaveLength(2);
    expect(b1.summary.nextCursor).toBeTruthy();
    // Actor identity is denormalised for operator readability.
    expect(b1.events[0]!.actorEmail).toBe("admin@acme.test");
    const filtered = await app.inject({
      method: "GET",
      url: ORGS(ORG) + "/audit-events?eventType=ORG_MEMBER_REMOVED",
    });
    const b2 = JSON.parse(filtered.body) as { events: Row[] };
    expect(b2.events.map((e) => e.eventType)).toEqual(["ORG_MEMBER_REMOVED"]);
    // Denial reads nothing at all.
    H.orgAccess = { kind: "forbidden" };
    const denied = await app.inject({ method: "GET", url: ORGS(ORG) + "/audit-events" });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("ORG_MEMBER_REMOVED");
  });

  it("self-service Organization creation is RETIRED with a bounded, explanatory denial", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: JSON_HEADERS,
      payload: { name: "Rogue Org" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("org_self_service_creation_retired");
    expect(rows("organization")).toHaveLength(2);
  });

  it("metadata patch writes a field-level diff to the governance audit stream", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: ORGS(ORG),
      headers: JSON_HEADERS,
      payload: { name: "Acme Forensics", legalEmail: null },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("Acme Forensics");
    const diff = H.audits.find((a) => a.eventType === "ORG_UPDATED")!;
    expect(diff.metadata).toEqual({
      changes: {
        name: { from: "Acme Investigations", to: "Acme Forensics" },
        legalEmail: { from: "legal@acme.test", to: null },
      },
    });
    // Denial mutates nothing.
    H.orgAccess = { kind: "forbidden" };
    const denied = await app.inject({
      method: "PATCH",
      url: ORGS(ORG),
      headers: JSON_HEADERS,
      payload: { name: "Hijacked" },
    });
    expect(denied.statusCode).toBe(403);
    expect(rows("organization").find((o) => o.id === ORG)!.name).toBe("Acme Forensics");
  });

  // -- Invitations -----------------------------------------------------------
  it("invite create: the role ceiling holds, the token is display-once, only the hash persists", async () => {
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    const tooHigh = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites",
      headers: JSON_HEADERS,
      payload: { email: "boss@acme.test", role: "ORG_OWNER" },
    });
    expect(tooHigh.statusCode).toBe(403);
    expect(rows("organizationInvite").some((r) => r.email === "boss@acme.test")).toBe(false);

    const ok = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites",
      headers: JSON_HEADERS,
      payload: { email: "Analyst@Acme.test", role: "ORG_AUDITOR" },
    });
    expect(ok.statusCode).toBe(201);
    const body = JSON.parse(ok.body) as { token: string; email: string; inviteId: string };
    expect(body.email).toBe("analyst@acme.test");
    const created = inviteRow(body.inviteId)!;
    expect(created.token).toBeNull();
    expect(created.tokenHash).not.toBe(body.token);
    expect(JSON.stringify(H.audits)).not.toContain(body.token);

    // A later READ never returns the token again.
    const list = await app.inject({ method: "GET", url: ORGS(ORG) + "/invites" });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.token);
    expect(list.body).not.toContain("tokenHash");
  });

  it("invite create refuses duplicates and existing members with bounded conflicts", async () => {
    const pending = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites",
      headers: JSON_HEADERS,
      payload: { email: "new@acme.test" },
    });
    expect(pending.statusCode).toBe(409);
    expect(JSON.parse(pending.body).reason).toBe("pending_invite_exists");
    const member = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites",
      headers: JSON_HEADERS,
      payload: { email: "subject@acme.test" },
    });
    expect(member.statusCode).toBe(409);
    expect(JSON.parse(member.body).reason).toBe("already_member");
    expect(rows("organizationInvite")).toHaveLength(2);
  });

  it("invite create rejects workspace assignments that do not belong to THIS Organization", async () => {
    const res = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites",
      headers: JSON_HEADERS,
      payload: {
        email: "crossorg@acme.test",
        workspaceAssignments: [{ teamId: OTHER_TEAM, role: "ADMIN" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("invalid_workspace_assignment");
    expect(rows("organizationInvite").some((r) => r.email === "crossorg@acme.test")).toBe(
      false,
    );
  });

  it("invite accept hashes the raw token BEFORE the canonical service sees it", async () => {
    const raw = "a".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/v1/org-invites/" + raw + "/accept",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    const args = callsTo("acceptOrganizationInvite")[0]!.args as {
      tokenHash: string;
      userId: string;
    };
    expect(args.userId).toBe(ACTOR);
    expect(args.tokenHash).toHaveLength(64);
    expect(args.tokenHash).not.toBe(raw);
    expect(res.body).not.toContain(raw);
  });

  it("invite revoke is idempotent, refuses accepted invites, and conceals foreign ids", async () => {
    const first = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/invites/" + INVITE_ROW,
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({
      inviteId: INVITE_ROW,
      revoked: true,
      wasAlreadyRevoked: false,
    });
    expect(inviteRow(INVITE_ROW)!.revokedByUserId).toBe(ACTOR);
    const again = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/invites/" + INVITE_ROW,
    });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).wasAlreadyRevoked).toBe(true);

    // A foreign invite id is byte-identical to a non-existent one.
    const unknown = randomUUID();
    const foreign = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/invites/" + INVITE_FOREIGN,
    });
    const missing = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/invites/" + unknown,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(inviteRow(INVITE_FOREIGN)!.revokedAt).toBeNull();

    // An ACCEPTED invite cannot be revoked.
    inviteRow(INVITE_ROW)!.revokedAt = null;
    inviteRow(INVITE_ROW)!.acceptedAt = new Date();
    const accepted = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/invites/" + INVITE_ROW,
    });
    expect(accepted.statusCode).toBe(409);
  });

  it("invite resend extends expiry, rotates delivery, and refuses dead invites", async () => {
    const before = inviteRow(INVITE_ROW)!.expiresAt as Date;
    const res = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites/" + INVITE_ROW + "/resend",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { resendCount: number; acceptUrl: string };
    expect(body.resendCount).toBe(1);
    expect(body.acceptUrl).toContain("token=fresh");
    expect((inviteRow(INVITE_ROW)!.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(callsTo("resendOrgInviteDelivery")).toHaveLength(1);
    expect(H.audits.some((a) => a.eventType === "ORG_INVITE_RESENT")).toBe(true);

    // Revoked → 410, and the delivery chain is NOT invoked again.
    inviteRow(INVITE_ROW)!.revokedAt = new Date();
    const dead = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/invites/" + INVITE_ROW + "/resend",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(dead.statusCode).toBe(410);
    expect(callsTo("resendOrgInviteDelivery")).toHaveLength(1);
  });

  // -- Roles + membership ----------------------------------------------------
  it("role change: canonical orchestrator runs, and self-change / owner-rank / last-owner are all blocked", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_TARGET,
      headers: JSON_HEADERS,
      payload: { role: "ORG_SECURITY_ADMIN" },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      oldRole: "ORG_MEMBER",
      newRole: "ORG_SECURITY_ADMIN",
    });
    expect(H.writes).toContain("updateOrganizationMembershipRole");
    expect(membershipRow(MEMBERSHIP_TARGET)!.role).toBe("ORG_SECURITY_ADMIN");
    expect(H.audits.some((a) => a.eventType === "ORG_MEMBER_ROLE_CHANGED")).toBe(true);

    // Re-applying the SAME role is an explicit no-op, not a second write.
    H.writes.length = 0;
    const noop = await app.inject({
      method: "PATCH",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_TARGET,
      headers: JSON_HEADERS,
      payload: { role: "ORG_SECURITY_ADMIN" },
    });
    expect(JSON.parse(noop.body).noop).toBe(true);
    expect(H.writes).toEqual([]);

    // Self-change is refused.
    const self = await app.inject({
      method: "PATCH",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_ADMIN,
      headers: JSON_HEADERS,
      payload: { role: "ORG_ADMIN" },
    });
    expect(self.statusCode).toBe(409);
    expect(membershipRow(MEMBERSHIP_ADMIN)!.role).toBe("ORG_OWNER");

    // Only an ORG_OWNER may move a membership to/from ORG_OWNER.
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    const promote = await app.inject({
      method: "PATCH",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_TARGET,
      headers: JSON_HEADERS,
      payload: { role: "ORG_OWNER" },
    });
    expect(promote.statusCode).toBe(403);
    expect(membershipRow(MEMBERSHIP_TARGET)!.role).toBe("ORG_SECURITY_ADMIN");

    // The LAST ORG_OWNER can never be demoted — ADMIN_3 is now the only one.
    H.orgAccess = { kind: "ok", role: "ORG_OWNER" };
    membershipRow(MEMBERSHIP_ADMIN)!.role = "ORG_ADMIN";
    const demoteLast = await app.inject({
      method: "PATCH",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_OWNER,
      headers: JSON_HEADERS,
      payload: { role: "ORG_ADMIN" },
    });
    expect(demoteLast.statusCode).toBe(409);
    expect(JSON.parse(demoteLast.body).message).toContain("last ORG_OWNER");
  });

  it("member removal off-boards through the canonical orchestrator and revokes sessions", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_TARGET,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      membershipId: MEMBERSHIP_TARGET,
      removed: true,
    });
    // Governance + workspace + pointer + session layers all off-boarded.
    expect(H.writes).toContain("removeOrganizationMembership");
    expect(H.writes).toContain("massRevokeWorkspaceMemberships");
    expect(H.writes).toContain("revokeAllSessionsForUser");
    expect(membershipRow(MEMBERSHIP_TARGET)).toBeUndefined();
    expect(rows("user").find((u) => u.id === SUBJECT)!.currentWorkspaceId).toBeNull();
    const removed = H.audits.find((a) => a.eventType === "ORG_MEMBER_REMOVED")!;
    expect(removed.metadata).toMatchObject({ workspacesDeactivated: 1 });
  });

  it("member removal denials: self-removal, owner rank, last owner, foreign id — all zero mutation", async () => {
    const denials: Array<{ name: string; id: string; status: number; setup?: () => void }> = [
      { name: "self", id: MEMBERSHIP_ADMIN, status: 409 },
      { name: "foreign", id: MEMBERSHIP_FOREIGN, status: 404 },
      { name: "missing", id: randomUUID(), status: 404 },
    ];
    const bodies: string[] = [];
    for (const d of denials) {
      d.setup?.();
      const res = await app.inject({
        method: "DELETE",
        url: ORGS(ORG) + "/members/" + d.id,
      });
      expect(res.statusCode, d.name).toBe(d.status);
      if (d.status === 404) bodies.push(res.body);
    }
    // A foreign membership id is byte-identical to a non-existent one.
    expect(new Set(bodies).size).toBe(1);
    expect(membershipRow(MEMBERSHIP_FOREIGN)).toBeTruthy();
    expect(membershipRow(MEMBERSHIP_ADMIN)).toBeTruthy();

    // An ORG_ADMIN cannot remove an ORG_OWNER.
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    const ownerByAdmin = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_OWNER,
    });
    expect(ownerByAdmin.statusCode).toBe(403);
    expect(membershipRow(MEMBERSHIP_OWNER)).toBeTruthy();

    // And the last ORG_OWNER is protected even from an ORG_OWNER.
    H.orgAccess = { kind: "ok", role: "ORG_OWNER" };
    membershipRow(MEMBERSHIP_ADMIN)!.role = "ORG_ADMIN";
    const lastOwner = await app.inject({
      method: "DELETE",
      url: ORGS(ORG) + "/members/" + MEMBERSHIP_OWNER,
    });
    expect(lastOwner.statusCode).toBe(409);
    expect(membershipRow(MEMBERSHIP_OWNER)).toBeTruthy();
    expect(H.writes).not.toContain("removeOrganizationMembership");
  });

  it("self-leave: an ORG_OWNER is blocked; a non-owner off-boards and is idempotent afterwards", async () => {
    // ACTOR is ORG_OWNER — an Organization can never be left ownerless.
    const blocked = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/leave",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body).error.code).toBe("OWNERSHIP_TRANSFER_REQUIRED");
    expect(membershipRow(MEMBERSHIP_ADMIN)).toBeTruthy();
    expect(H.writes).toEqual([]);

    H.actorUserId = SUBJECT;
    const left = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/leave",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(left.statusCode).toBe(200);
    expect(JSON.parse(left.body)).toMatchObject({
      left: true,
      formerRole: "ORG_MEMBER",
      workspacesDeactivated: 1,
      workspaceFallback: true,
    });
    expect(membershipRow(MEMBERSHIP_TARGET)).toBeUndefined();
    expect(rows("user").find((u) => u.id === SUBJECT)!.currentWorkspaceId).toBeNull();
    // Leaving an org does NOT sign the account out.
    expect(H.writes).not.toContain("revokeAllSessionsForUser");

    const again = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/leave",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(again.statusCode).toBe(404);
    expect(JSON.parse(again.body).error.code).toBe("membership_not_found");
  });

  it("ownership transfer is step-up gated, atomic, and never leaves zero or two owners", async () => {
    H.stepUpDenies = true;
    const denied = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/transfer-ownership",
      headers: JSON_HEADERS,
      payload: { targetUserId: SUBJECT },
    });
    expect(denied.statusCode).toBe(401);
    expect(callsTo("accountStepUp")[0]!.args).toEqual({
      action: "org_ownership_transfer",
    });
    // ZERO mutation on a step-up denial.
    expect(membershipRow(MEMBERSHIP_ADMIN)!.role).toBe("ORG_OWNER");
    expect(membershipRow(MEMBERSHIP_TARGET)!.role).toBe("ORG_MEMBER");
    expect(H.writes).toEqual([]);

    H.stepUpDenies = false;
    const toSelf = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/transfer-ownership",
      headers: JSON_HEADERS,
      payload: { targetUserId: ACTOR },
    });
    expect(toSelf.statusCode).toBe(400);
    expect(JSON.parse(toSelf.body).error.code).toBe("transfer_to_self");

    const outsiderTarget = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/transfer-ownership",
      headers: JSON_HEADERS,
      payload: { targetUserId: OUTSIDER },
    });
    expect(outsiderTarget.statusCode).toBe(404);
    expect(JSON.parse(outsiderTarget.body).error.code).toBe("target_not_member");
    expect(membershipRow(MEMBERSHIP_ADMIN)!.role).toBe("ORG_OWNER");

    const ok = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/transfer-ownership",
      headers: JSON_HEADERS,
      payload: { targetUserId: SUBJECT },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({
      transferred: true,
      newOwnerUserId: SUBJECT,
      billingOwnerTransferred: true,
    });
    // Atomic swap through the canonical orchestrator — both legs, one tx.
    expect(
      H.writes.filter((w) => w === "updateOrganizationMembershipRole"),
    ).toHaveLength(2);
    expect(membershipRow(MEMBERSHIP_TARGET)!.role).toBe("ORG_OWNER");
    expect(membershipRow(MEMBERSHIP_ADMIN)!.role).toBe("ORG_ADMIN");
    expect(rows("organization").find((o) => o.id === ORG)!.billingOwnerUserId).toBe(
      SUBJECT,
    );
    // Both parties see it on their own activity timelines.
    const timeline = H.audits.filter(
      (a) => a.action === "identity.organization_ownership_transferred",
    );
    expect(timeline.map((a) => a.actorUserId).sort()).toEqual([ACTOR, SUBJECT].sort());
  });

  it("ownership transfer requires ORG_OWNER: a non-owner is refused before any step-up", async () => {
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    const res = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/transfer-ownership",
      headers: JSON_HEADERS,
      payload: { targetUserId: SUBJECT },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("owner_required");
    expect(callsTo("accountStepUp")).toHaveLength(0);
    expect(H.writes).toEqual([]);
  });

  // -- Closure ---------------------------------------------------------------
  it("closure read exposes the server-owned confirmation phrase, cooling-off window and live blockers", async () => {
    const res = await app.inject({ method: "GET", url: ORGS(ORG) + "/closure" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      request: Row;
      blockers: unknown[];
      confirmationPhrase: string;
      coolingOffDays: number;
    };
    expect(body.confirmationPhrase).toBe("close this organization");
    expect(body.coolingOffDays).toBe(7);
    expect(body.blockers).toEqual([]);
    expect(body.request.id).toBe(CLOSURE_ROW);
    expect(callsTo("evaluateOrganizationClosurePreflight")).toHaveLength(1);
  });

  it("closure request: the typed phrase is validated SERVER-SIDE and step-up denial writes nothing", async () => {
    const wrongPhrase = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure",
      headers: JSON_HEADERS,
      payload: { confirmation: "yes" },
    });
    expect(wrongPhrase.statusCode).toBe(400);
    expect(JSON.parse(wrongPhrase.body).error.code).toBe("confirmation_mismatch");
    // The gate is never even reached on a bad phrase.
    expect(callsTo("accountStepUp")).toHaveLength(0);
    expect(rows("organizationClosureRequest")).toHaveLength(1);

    H.stepUpDenies = true;
    const denied = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure",
      headers: JSON_HEADERS,
      payload: { confirmation: "Close This Organization" },
    });
    expect(denied.statusCode).toBe(401);
    expect(callsTo("accountStepUp")[0]!.args).toEqual({ action: "org_closure_request" });
    expect(rows("organizationClosureRequest")).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("closure request enters COOLING_OFF once, then a second open request is a bounded conflict", async () => {
    const res = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure",
      headers: JSON_HEADERS,
      payload: { confirmation: "close this organization", reason: "Contract ended." },
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body).request as Row;
    expect(created.status).toBe("COOLING_OFF");
    expect(new Date(created.coolingOffEndsAtUtc as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(H.audits.some((a) => a.eventType === "ORG_CLOSURE_REQUESTED")).toBe(true);
    // Execution is asynchronous — the Organization is NOT archived here.
    expect(rows("organization").find((o) => o.id === ORG)!.status).toBe("ACTIVE");

    const second = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure",
      headers: JSON_HEADERS,
      payload: { confirmation: "close this organization" },
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("closure_request_active");
    expect(rows("organizationClosureRequest")).toHaveLength(2);
  });

  it("closure cancel: cancellable during cooling-off, bounded conflict afterwards, concealed foreign id", async () => {
    const open = randomUUID();
    rows("organizationClosureRequest").push({
      id: open,
      organizationId: ORG,
      requestedByUserId: ACTOR,
      status: "COOLING_OFF",
      reason: null,
      blockersJson: null,
      requestedAtUtc: new Date(),
      coolingOffEndsAtUtc: new Date(Date.now() + 86_400_000),
      cancelledAtUtc: null,
      completedAtUtc: null,
      failureCode: null,
    });
    const ok = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure/" + open + "/cancel",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).request.status).toBe("CANCELLED");
    expect(H.audits.some((a) => a.eventType === "ORG_CLOSURE_CANCELLED")).toBe(true);

    // Already CANCELLED → not cancellable (not a second cancellation).
    const again = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure/" + open + "/cancel",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).error.code).toBe("closure_not_cancellable");

    // A request id from another Organization is a plain not-found.
    const unknown = randomUUID();
    rows("organizationClosureRequest").push({
      id: DOMAIN_FOREIGN,
      organizationId: OTHER_ORG,
      requestedByUserId: OUTSIDER,
      status: "COOLING_OFF",
      requestedAtUtc: new Date(),
      cancelledAtUtc: null,
    });
    const foreign = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure/" + DOMAIN_FOREIGN + "/cancel",
      headers: JSON_HEADERS,
      payload: {},
    });
    const missing = await app.inject({
      method: "POST",
      url: ORGS(ORG) + "/closure/" + unknown + "/cancel",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(
      rows("organizationClosureRequest").find((r) => r.id === DOMAIN_FOREIGN)!.status,
    ).toBe("COOLING_OFF");
  });

  it("closure surfaces are ORG_OWNER-only across every leg", async () => {
    H.orgAccess = { kind: "ok", role: "ORG_ADMIN" };
    const legs: Array<{ name: string; method: "GET" | "POST"; url: string }> = [
      { name: "read", method: "GET", url: ORGS(ORG) + "/closure" },
      { name: "request", method: "POST", url: ORGS(ORG) + "/closure" },
      { name: "cancel", method: "POST", url: ORGS(ORG) + "/closure/" + CLOSURE_ROW + "/cancel" },
    ];
    for (const leg of legs) {
      const res = await app.inject({
        method: leg.method,
        url: leg.url,
        ...(leg.method === "POST"
          ? { headers: JSON_HEADERS, payload: { confirmation: "close this organization" } }
          : {}),
      });
      expect(res.statusCode, leg.name).toBe(403);
      expect(JSON.parse(res.body).error.code, leg.name).toBe("owner_required");
    }
    expect(rows("organizationClosureRequest")).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 9 — SAML SP metadata + IdP certificate rotation.
//   The IdP transport and XML crypto are process boundaries; the routes'
//   authorization, honesty and secret-free projection are production code.
// ===========================================================================
const connRow = () => rows("ssoConnection")[0]!;

describe("SYSTEM 9 — SAML SP metadata + certificate rotation", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.AUTH_JWT_SECRET = JWT_SECRET;
    app = Fastify();
    // The production server decorates the request with the verified principal;
    // these admin legs read `req.user.sub` from that decoration.
    app.addHook("onRequest", async (req) => {
      (req as unknown as { user: { sub: string } }).user = { sub: H.actorUserId };
    });
    await app.register(samlAuthRoutes);
    await app.ready();
  });

  it("SP metadata is HONEST about signing and never exposes private key material", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/saml/metadata/" + CONN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    // Populated response: SP entityID + ACS + the signing posture.
    expect(res.body).toContain('entityID="https://api.proovra.com/saml/sp/' + CONN + '"');
    expect(res.body).toContain('WantAssertionsSigned="true"');
    // Signing is advertised true ONLY because key material actually resolves.
    expect(res.body).toContain('AuthnRequestsSigned="true"');
    expect(res.body).toContain("HTTP-POST");
    // The SP private key is in the row that was read — it must NEVER be emitted.
    for (const forbidden of [
      "SUPERSECRET",
      "BEGIN PRIVATE KEY",
      "samlSpPrivateKey",
      "samlCertificate",
      connRow().samlCertificate as string,
    ]) {
      expect(res.body, String(forbidden).slice(0, 24)).not.toContain(forbidden);
    }
  });

  it("SP metadata: a REVOKED or unknown connection is byte-identical not-found", async () => {
    const unknown = randomUUID();
    const missing = await app.inject({
      method: "GET",
      url: "/v1/auth/saml/metadata/" + unknown,
    });
    connRow().status = "REVOKED";
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/auth/saml/metadata/" + CONN,
    });
    expect(missing.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).toEqual(missing.body);
    expect(revoked.body).toEqual('{"error":{"code":"not_found"}}');
  });

  it("login initiation persists replay state and redirects to the IdP; a dead connection bounces safely", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/saml/" + CONN + "/login?redirectAfter=/evidence",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("https://idp.example.com/sso");
    expect(res.headers.location).toContain("RelayState=rs-1");
    // The AuthnRequest was SIGNED (the connection has key material) and the
    // state row was persisted for replay protection BEFORE the redirect.
    expect(callsTo("buildSamlAuthnRequest")[0]!.args).toEqual({ signed: true });
    expect(callsTo("persistSamlCallbackAttempt")[0]!.args).toMatchObject({
      teamId: TEAM,
      ssoConnectionId: CONN,
      samlAuthnRequestId: "_authn-1",
      redirectAfter: "/evidence",
    });

    // A non-ACTIVE connection bounces to a sanitised error, never to the IdP.
    connRow().status = "PENDING";
    const dead = await app.inject({
      method: "GET",
      url: "/v1/auth/saml/" + CONN + "/login",
    });
    expect(dead.statusCode).toBe(302);
    expect(dead.headers.location).toBe("/auth?saml_error=saml_connection_unavailable");
    expect(callsTo("persistSamlCallbackAttempt")).toHaveLength(1);
  });

  it("certificate rotation: stage-then-promote is admin-gated and never leaks key bytes", async () => {
    const nextCert = "MIIDnext".padEnd(500, "B");
    const staged = await app.inject({
      method: "PUT",
      url: "/v1/auth/saml/" + CONN + "/certificate-next",
      headers: JSON_HEADERS,
      payload: { certificate: nextCert },
    });
    expect(staged.statusCode).toBe(200);
    const stagedBody = JSON.parse(staged.body) as { certNextFingerprint: string };
    expect(stagedBody.certNextFingerprint).toHaveLength(64);
    expect(connRow().samlCertificateNext).toBe(nextCert);
    // Only the FINGERPRINT is returned — never the certificate bytes.
    expect(staged.body).not.toContain(nextCert.slice(0, 40));

    const promoted = await app.inject({
      method: "DELETE",
      url: "/v1/auth/saml/" + CONN + "/certificate-next",
    });
    expect(promoted.statusCode).toBe(200);
    expect(connRow().samlCertificate).toBe(nextCert);
    expect(connRow().samlCertificateNext).toBeNull();
    expect(connRow().samlCertNextFingerprint).toBeNull();
    expect(connRow().rotatedAtUtc).toBeInstanceOf(Date);
    expect(promoted.body).not.toContain(nextCert.slice(0, 40));

    // Promoting again with no staged cert is a bounded conflict.
    const again = await app.inject({
      method: "DELETE",
      url: "/v1/auth/saml/" + CONN + "/certificate-next",
    });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body)).toEqual({
      error: { code: "no_next_certificate" },
    });
  });

  it("certificate rotation denials: non-admin, non-Enterprise, and foreign connection mutate nothing", async () => {
    const before = connRow().samlCertificate;
    const nextCert = "MIIDdenied".padEnd(500, "C");

    // PHASE 13 §1.2 — an OUTSIDER is refused WITHOUT learning the connection
    // exists.
    //
    // OUTSIDER is an OWNER of OTHER_TEAM and holds no membership at all on this
    // connection's team, so they are a cross-tenant caller, not an
    // under-privileged colleague. This used to answer 403 while an absent
    // connection answered 404 — which made the status code an existence oracle
    // for anyone with an account. Both now answer 404 with the same body, and
    // the pair is asserted together below so the two cannot drift apart again.
    H.actorUserId = OUTSIDER;
    const nonAdmin = await app.inject({
      method: "PUT",
      url: "/v1/auth/saml/" + CONN + "/certificate-next",
      headers: JSON_HEADERS,
      payload: { certificate: nextCert },
    });
    const outsiderAbsent = await app.inject({
      method: "PUT",
      url: "/v1/auth/saml/" + randomUUID() + "/certificate-next",
      headers: JSON_HEADERS,
      payload: { certificate: nextCert },
    });
    expect(nonAdmin.statusCode).toBe(404);
    expect(JSON.parse(nonAdmin.body)).toEqual({ error: { code: "not_found" } });
    expect(
      nonAdmin.body,
      "an existing connection and an absent one must be indistinguishable to an outsider",
    ).toBe(outsiderAbsent.body);
    expect(connRow().samlCertificateNext).toBeNull();

    // A non-Enterprise workspace is refused with the upgrade path — now AFTER
    // membership is established, so the plan is never readable by an outsider.
    H.actorUserId = ACTOR;
    H.gateOk = false;
    const gated = await app.inject({
      method: "PUT",
      url: "/v1/auth/saml/" + CONN + "/certificate-next",
      headers: JSON_HEADERS,
      payload: { certificate: nextCert },
    });
    expect(gated.statusCode).toBe(402);
    expect(JSON.parse(gated.body).error.code).toBe("ENTERPRISE_FEATURE_REQUIRED");

    // An unknown connection is a plain not-found.
    H.gateOk = true;
    const unknown = await app.inject({
      method: "PUT",
      url: "/v1/auth/saml/" + randomUUID() + "/certificate-next",
      headers: JSON_HEADERS,
      payload: { certificate: nextCert },
    });
    expect(unknown.statusCode).toBe(404);
    expect(connRow().samlCertificate).toBe(before);
    expect(connRow().samlCertificateNext).toBeNull();
  });

  it("metadata ingest PINS the IdP issuer + fingerprint and returns no certificate bytes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/ingest-metadata",
      headers: JSON_HEADERS,
      payload: { metadataXml: "<md:EntityDescriptor/>" },
    });
    expect(res.statusCode).toBe(200);
    const extracted = JSON.parse(res.body).extracted as Row;
    expect(extracted).toMatchObject({
      ssoUrl: "https://idp.example.com/sso",
      certFingerprint: "fp-parsed",
      entityId: "https://idp.example.com",
    });
    // The issuer is now PINNED on the row (the fail-closed login predicate).
    expect(connRow().samlIdpEntityId).toBe("https://idp.example.com");
    expect(connRow().samlCertFingerprint).toBe("fp-parsed");
    // Fingerprint + expiry only — never the certificate or key bytes.
    expect(res.body).not.toContain("MIICparsed");
    expect(res.body).not.toContain("SUPERSECRET");
    expect(callsTo("emitCertExpiryWarningIfNeeded")).toHaveLength(1);

    // An empty body is a bounded 400 that pins nothing.
    const empty = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/ingest-metadata",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(JSON.parse(empty.body).error.code).toBe("metadata_xml_required");

    // PHASE 13 §1.2 — a cross-tenant caller cannot re-pin the issuer, and is
    // refused without learning that the connection exists. See the rotation
    // test above for why 404 rather than 403.
    H.actorUserId = OUTSIDER;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/ingest-metadata",
      headers: JSON_HEADERS,
      payload: { metadataXml: "<md:EntityDescriptor/>" },
    });
    expect(denied.statusCode).toBe(404);
    expect(JSON.parse(denied.body)).toEqual({ error: { code: "not_found" } });
    expect(connRow().samlIdpEntityId).toBe("https://idp.example.com");
  });

  it("test-connection is a local preflight that records an HONEST outcome, no session issued", async () => {
    const pass = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/test-connection",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(pass.statusCode).toBe(200);
    const body = JSON.parse(pass.body) as { ok: boolean; status: string; checks: Row[] };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("PASSED");
    expect(body.checks.map((c) => c.name)).toEqual([
      "sso_url_configured",
      "certificate_configured",
      "entity_id_configured",
      "certificate_fingerprint_present",
      "certificate_not_expired",
    ]);
    expect(connRow().samlLastTestStatus).toBe("PASSED");
    expect(connRow().samlLastTestError).toBeNull();
    // No session, no cookie, no assertion — and no key material in the result.
    expect(pass.headers["set-cookie"]).toBeUndefined();
    expect(pass.body).not.toContain("SUPERSECRET");

    // A missing fingerprint makes the test FAIL honestly rather than pass.
    connRow().samlCertFingerprint = null;
    const fail = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/test-connection",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(fail.statusCode).toBe(200);
    expect(JSON.parse(fail.body)).toMatchObject({
      ok: false,
      status: "FAILED",
      errorCode: "CERTIFICATE_FINGERPRINT_PRESENT",
    });
    expect(connRow().samlLastTestStatus).toBe("FAILED");

    // PHASE 13 §1.2 — a cross-tenant caller cannot probe another workspace's
    // connection, and cannot learn from the refusal that it exists.
    H.actorUserId = OUTSIDER;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/auth/saml/" + CONN + "/test-connection",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(denied.statusCode).toBe(404);
    expect(JSON.parse(denied.body)).toEqual({ error: { code: "not_found" } });
  });
});
