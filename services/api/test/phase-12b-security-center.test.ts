/**
 * PHASE 12B — Security Center / MFA-admin authority tests.
 *
 * PRODUCTION-PATH behaviour over an in-memory prisma transport. The REAL
 * `authorizeOrFail` middleware, the REAL `mfaAdminRoutes` handlers and the
 * REAL `updateMfaPolicyVersioned` writer all run; only the database, the auth
 * transport, the access-policy decision, the step-up gate and the audit /
 * event emitters are substituted.
 *
 * Matrix:
 *   1. A `:teamId` path param belonging to ANOTHER Organization is
 *      CONCEALED-denied (404 not_found, identical body to a non-existent
 *      workspace) on every mfa-admin route, and mutates nothing. This is the
 *      client-declared-tenant defect the phase closes.
 *   2. OWNER/ADMIN narrowing and target-membership are concealed the same way
 *      — a MEMBER actor and a non-member target are indistinguishable from a
 *      missing workspace.
 *   3. The MFA policy patch is atomic on `expectedPolicyVersion`: with two
 *      concurrent writers exactly ONE succeeds, and the loser mutates NOTHING
 *      and reports a bounded 409 conflict.
 *   4. Safe projections: the posture response carries no factor secret
 *      material (ciphertext / IV / auth tag / KEK id) and no device or IP
 *      hash.
 *   5. Step-up denial is a ZERO-MUTATION outcome on every gated mfa-admin
 *      mutation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const MISSING_TEAM = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const TARGET = "55555555-5555-4555-8555-555555555555";
const OUTSIDER = "66666666-6666-4666-8666-666666666666";
const FACTOR_ID = "77777777-7777-4777-8777-777777777777";

// ---------------------------------------------------------------------------
// Hoisted test control surface + in-memory state.
// ---------------------------------------------------------------------------

type PolicyRow = {
  organizationId: string;
  teamId: string | null;
  mfaPolicyLevel: string;
  mfaRequiredFlag: boolean;
  ssoReadyFlag: boolean;
  scimReadyFlag: boolean;
  stepUpTtlSeconds: number | null;
  trustedDeviceTtlDays: number | null;
  mfaEnforcementFailMode: string | null;
  policyVersion: number;
  updatedByUserId: string | null;
};

const H = vi.hoisted(() => ({
  /** Which workspaces the ACTOR's access-policy decision allows. */
  allowedTeamIds: [] as string[],
  /** Membership rows: (teamId, userId) → role/status. */
  members: [] as Array<{
    teamId: string;
    userId: string;
    role: string;
    status: string;
  }>,
  /** Organization security policy rows keyed by organizationId. */
  policies: [] as Array<Record<string, unknown>>,
  /** Full MFA factor rows INCLUDING secret material, so the route's column
   *  selection is what decides whether secrets can escape. */
  factors: [] as Array<Record<string, unknown>>,
  /** Full trusted-device rows INCLUDING deviceIdHash / ipHash. */
  devices: [] as Array<Record<string, unknown>>,
  /** Every write the fake transport observed, as `model.method`. */
  writes: [] as string[],
  /** Toggle the step-up gate. */
  stepUpAllowed: true,
  /** Calls into the lifecycle mutation service. */
  lifecycleCalls: [] as string[],
}));

// --- auth transport -------------------------------------------------------
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = {
      sub: ACTOR,
      sessionIdHash: "session-hash",
      iat: Math.floor(Date.now() / 1000),
    };
  },
}));

// --- access-policy decision (the authorize() input) -----------------------
vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async (input: { teamId: string }) =>
    H.allowedTeamIds.includes(input.teamId)
      ? { allowed: true }
      : { allowed: false, reason: "member_not_active" },
}));

// --- in-memory prisma transport ------------------------------------------
function project(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}

vi.mock("../src/db.js", () => {
  const teamMember = {
    findFirst: async (args: {
      where: { teamId?: string; userId?: string; status?: string };
      select?: Record<string, boolean>;
    }) => {
      const w = args.where ?? {};
      const hit = H.members.find(
        (m) =>
          (w.teamId === undefined || m.teamId === w.teamId) &&
          (w.userId === undefined || m.userId === w.userId) &&
          (w.status === undefined || m.status === w.status),
      );
      return hit ? project(hit as never, args.select) : null;
    },
  };

  const mfaFactor = {
    findMany: async (args: {
      where: { userId?: string };
      select?: Record<string, boolean>;
    }) =>
      H.factors
        .filter((f) => f.userId === args.where?.userId)
        // The fake HONOURS `select`, so a route that forgets to narrow its
        // columns really does leak the secret material in this test.
        .map((f) => project(f, args.select)),
  };

  const trustedDevice = {
    findMany: async (args: { where: { teamId?: string; userId?: string } }) =>
      H.devices.filter(
        (d) =>
          (args.where?.teamId === undefined || d.teamId === args.where.teamId) &&
          (args.where?.userId === undefined || d.userId === args.where.userId),
      ),
  };

  const organizationSecurityPolicy = {
    findUnique: async (args: {
      where: { organizationId: string };
      select?: Record<string, boolean>;
    }) => {
      const hit = H.policies.find(
        (p) => p.organizationId === args.where.organizationId,
      );
      return hit ? project(hit, args.select) : null;
    },
    findUniqueOrThrow: async (args: {
      where: { organizationId: string };
      select?: Record<string, boolean>;
    }) => {
      const hit = H.policies.find(
        (p) => p.organizationId === args.where.organizationId,
      );
      if (!hit) throw new Error("policy missing");
      return project(hit, args.select);
    },
    create: async (args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => {
      H.writes.push("organizationSecurityPolicy.create");
      if (
        H.policies.some((p) => p.organizationId === args.data.organizationId)
      ) {
        const err = new Error("unique violation") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      const row = { ...args.data } as Record<string, unknown>;
      H.policies.push(row);
      return project(row, args.select);
    },
    updateMany: async (args: {
      where: { organizationId: string; policyVersion?: number };
      data: Record<string, unknown>;
    }) => {
      const matches = H.policies.filter(
        (p) =>
          p.organizationId === args.where.organizationId &&
          (args.where.policyVersion === undefined ||
            p.policyVersion === args.where.policyVersion),
      );
      if (matches.length === 0) return { count: 0 };
      H.writes.push("organizationSecurityPolicy.updateMany");
      for (const row of matches) {
        for (const [key, value] of Object.entries(args.data)) {
          if (
            value !== null &&
            typeof value === "object" &&
            "increment" in (value as Record<string, unknown>)
          ) {
            row[key] =
              ((row[key] as number) ?? 0) +
              ((value as { increment: number }).increment ?? 0);
          } else {
            row[key] = value;
          }
        }
      }
      return { count: matches.length };
    },
  };

  const prisma = {
    teamMember,
    mfaFactor,
    trustedDevice,
    organizationSecurityPolicy,
    user: { findUnique: async () => ({ email: "admin@example.test" }) },
    securityEvent: {
      create: async () => {
        H.writes.push("securityEvent.create");
        return {};
      },
      findMany: async () => [],
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(prisma),
  };
  return { prisma };
});

// --- emitters / audit -----------------------------------------------------
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: vi.fn(async () => undefined),
  emitPlatformAudit: vi.fn(async () => undefined),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: vi.fn(() => undefined),
  projectSecurityEventDetails: (details: unknown) =>
    details && typeof details === "object" ? { redacted: true } : { redacted: false },
}));
vi.mock("../src/services/identity-security/risk.service.js", () => ({
  hashDeviceCookieValue: () => "device-hash",
  hashIpAddress: () => "ip-hash",
  getRiskSnapshotForUser: async () => ({ level: "LOW", score: 0, signals: [] }),
}));

// --- the org → policy key adapter ----------------------------------------
vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  organizationIdForPolicy: async (teamId: string) =>
    teamId === TEAM_A ? ORG_A : teamId === TEAM_B ? ORG_B : null,
}));

// --- step-up gate ---------------------------------------------------------
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: {
    reply: { code: (n: number) => { send: (b: unknown) => void } };
  }) => {
    if (H.stepUpAllowed) return { sent: false, verifiedChallengeId: "challenge-1" };
    input.reply.code(401).send({
      error: { code: "STEP_UP_REQUIRED", message: "Step-up verification required." },
    });
    return { sent: true };
  },
}));

// --- MFA lifecycle mutations (spied, so "zero mutation" is observable) ----
vi.mock("../src/services/security/mfa-admin-lifecycle.service.js", () => ({
  readUserMfaPosture: async (input: { targetUserId: string }) => ({
    ok: true,
    posture: {
      userId: input.targetUserId,
      activeFactorCount: 1,
      recoveryCodesRemaining: 3,
      lastUsedAt: null,
      enrollmentRequired: false,
      pendingRecoveryRequestId: null,
    },
  }),
  revokeUserFactor: async () => {
    H.lifecycleCalls.push("revokeUserFactor");
    return { ok: true };
  },
  requireUserReenrollment: async () => {
    H.lifecycleCalls.push("requireUserReenrollment");
    return { ok: true, revokedFactorCount: 1 };
  },
  resetTrustedDevicesForUser: async () => {
    H.lifecycleCalls.push("resetTrustedDevicesForUser");
    return { ok: true, resetCount: 2 };
  },
  listRecentMfaEvents: async () => ({
    ok: true,
    events: [
      {
        id: "evt-1",
        eventType: "mfa_admin_factor_revoked",
        severity: "INFO",
        createdAt: new Date().toISOString(),
        details: { deviceIdHash: "should-never-escape" },
      },
    ],
  }),
}));

// --- remaining route dependencies (not under test) ------------------------
vi.mock("../src/services/billing-enforcement.service.js", () => ({
  assertTeamAllowsEnterpriseFeature: async () => undefined,
}));
vi.mock("../src/services/security/mfa-recovery-request.service.js", () => ({
  approveRecoveryRequest: async () => ({ ok: true }),
  cancelRecoveryRequest: async () => ({ ok: true }),
  createRecoveryRequest: async () => ({ ok: true, request: null }),
  listPendingRecoveryRequests: async () => [],
  listRecoveryRequestApprovals: async () => ({ ok: true, approvals: [] }),
  readRecoveryRequestDetail: async () => ({ ok: true, detail: null }),
  rejectRecoveryRequest: async () => ({ ok: true }),
  resendRecoveryRequestEmail: async () => ({ ok: true, nextResendAfter: null }),
  verifyRecoveryRequestEmail: async () => ({ ok: true }),
}));
vi.mock("../src/services/security/mfa-digest-preference.service.js", () => ({
  listDigestPreferences: async () => ({ preferences: [] }),
  updateDigestPreference: async () => ({ ok: true, preference: null }),
}));
vi.mock("../src/services/security/mfa-recovery-digest-preview.service.js", () => ({
  previewDigestForAdmin: async () => ({
    adminUserId: ACTOR,
    teamCount: 0,
    requestCount: 0,
    suppressedTeamCount: 0,
  }),
}));
vi.mock("../src/services/security/mfa-recovery-event-feed.service.js", () => ({
  readRecoveryEventFeed: async () => ({ events: [], windowDays: 14, pageSize: 100 }),
}));
vi.mock("../src/services/security/mfa-digest-snooze-token.js", () => ({
  signMfaDigestSnoozeToken: () => "token",
  verifyMfaDigestSnoozeToken: () => ({ ok: false, reason: "invalid" }),
  MFA_DIGEST_SNOOZE_TTL_SECONDS: 900,
}));
vi.mock("../src/services/analytics-event.service.js", () => ({
  writeAnalyticsEvent: async () => undefined,
}));
vi.mock("../src/services/jwt.js", () => ({ verifyJwt: () => ({ sub: ACTOR }) }));
vi.mock("../src/services/email.service.js", () => ({
  getEmailService: () => ({
    isConfigured: () => false,
    sendMfaRecoveryAdminDigestEmail: async () => undefined,
  }),
}));
vi.mock("../src/config/runtime-secrets.js", () => ({ getSecret: () => null }));

const { mfaAdminRoutes } = await import("../src/routes/mfa-admin.routes.js");
const { updateMfaPolicyVersioned, MfaPolicyVersionConflictError } = await import(
  "../src/services/identity-security/mfa-policy.service.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedPolicy(overrides: Partial<PolicyRow> = {}): void {
  H.policies.push({
    organizationId: ORG_A,
    teamId: null,
    mfaPolicyLevel: "OFF",
    mfaRequiredFlag: false,
    ssoReadyFlag: false,
    scimReadyFlag: false,
    stepUpTtlSeconds: null,
    trustedDeviceTtlDays: null,
    mfaEnforcementFailMode: null,
    policyVersion: 1,
    updatedByUserId: null,
    ...overrides,
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  H.allowedTeamIds = [TEAM_A];
  H.members = [
    { teamId: TEAM_A, userId: ACTOR, role: "OWNER", status: "ACTIVE" },
    { teamId: TEAM_A, userId: TARGET, role: "MEMBER", status: "ACTIVE" },
    // The outsider is an OWNER of a DIFFERENT Organization's workspace.
    { teamId: TEAM_B, userId: OUTSIDER, role: "OWNER", status: "ACTIVE" },
  ];
  H.policies = [];
  H.factors = [
    {
      id: FACTOR_ID,
      userId: TARGET,
      kind: "TOTP",
      status: "ACTIVE",
      label: "iPhone",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      lastUsedAt: null,
      // Secret material the route must never select.
      secretCiphertext: Buffer.from("ciphertext"),
      secretIv: Buffer.from("iv"),
      secretAuthTag: Buffer.from("tag"),
      secretKekId: "kek-1",
    },
  ];
  H.devices = [
    {
      id: "device-1",
      teamId: TEAM_A,
      userId: TARGET,
      uaPreview: "Chrome on macOS",
      ipPreview: "203.0.113.x",
      status: "ACTIVE",
      trustedUntilUtc: new Date("2026-08-01T00:00:00Z"),
      firstSeenAtUtc: new Date("2026-07-01T00:00:00Z"),
      lastSeenAtUtc: new Date("2026-07-20T00:00:00Z"),
      revokedAtUtc: null,
      // Correlation material the projection must never return.
      deviceIdHash: "d".repeat(64),
      ipHash: "e".repeat(64),
    },
  ];
  H.writes = [];
  H.lifecycleCalls = [];
  H.stepUpAllowed = true;

  app = Fastify();
  await app.register(mfaAdminRoutes);
  await app.ready();
});

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
const patch = (url: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

// ---------------------------------------------------------------------------
// 1 + 2 — the client-declared tenant defect: concealed denial
// ---------------------------------------------------------------------------

describe("mfa-admin :teamId path param is AUTHORIZED, not trusted", () => {
  const routes: ReadonlyArray<{
    name: string;
    call: (teamId: string) => Promise<{ statusCode: number; body: string }>;
  }> = [
    { name: "posture", call: (t) => get(`/v1/identity/mfa-admin/posture/${t}/${TARGET}`) },
    {
      name: "factor revoke",
      call: (t) =>
        post(
          `/v1/identity/mfa-admin/factors/${t}/${TARGET}/${FACTOR_ID}/revoke`,
          { reason: "compromised device" },
        ),
    },
    {
      name: "require re-enrollment",
      call: (t) =>
        post(`/v1/identity/mfa-admin/factors/${t}/${TARGET}/require-reenrollment`, {
          reason: "lost authenticator",
        }),
    },
    {
      name: "trusted-device reset",
      call: (t) =>
        post(`/v1/identity/mfa-admin/trusted-devices/${t}/${TARGET}/reset`, {
          reason: "suspicious activity",
        }),
    },
    { name: "events", call: (t) => get(`/v1/identity/mfa-admin/events/${t}`) },
    { name: "policy read", call: (t) => get(`/v1/identity/mfa-admin/policy/${t}`) },
    {
      name: "policy patch",
      call: (t) =>
        patch(`/v1/identity/mfa-admin/policy/${t}`, {
          expectedPolicyVersion: 1,
          level: "ALL_MEMBERS",
        }),
    },
  ];

  for (const route of routes) {
    it(`${route.name}: a cross-Organization teamId returns a concealed 404 with ZERO mutation`, async () => {
      const cross = await route.call(TEAM_B);
      expect(cross.statusCode).toBe(404);
      expect(JSON.parse(cross.body)).toEqual({ error: { code: "not_found" } });
      expect(H.lifecycleCalls).toEqual([]);
      expect(H.writes).toEqual([]);
    });

    it(`${route.name}: a cross-Organization teamId is INDISTINGUISHABLE from a workspace that does not exist`, async () => {
      const cross = await route.call(TEAM_B);
      const missing = await route.call(MISSING_TEAM);
      expect(cross.statusCode).toBe(missing.statusCode);
      expect(cross.body).toBe(missing.body);
    });
  }

  it("an authorized but NON-ADMIN actor is concealed identically (no role enumeration)", async () => {
    H.members = [
      { teamId: TEAM_A, userId: ACTOR, role: "MEMBER", status: "ACTIVE" },
      { teamId: TEAM_A, userId: TARGET, role: "MEMBER", status: "ACTIVE" },
    ];
    const res = await get(`/v1/identity/mfa-admin/posture/${TEAM_A}/${TARGET}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
  });

  it("a target who is NOT a member of the authorized workspace is concealed (no membership probe)", async () => {
    const res = await get(`/v1/identity/mfa-admin/posture/${TEAM_A}/${OUTSIDER}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
    expect(H.lifecycleCalls).toEqual([]);
  });

  it("a SUSPENDED membership cannot act even on its own workspace", async () => {
    H.members = [
      { teamId: TEAM_A, userId: ACTOR, role: "OWNER", status: "SUSPENDED" },
      { teamId: TEAM_A, userId: TARGET, role: "MEMBER", status: "ACTIVE" },
    ];
    const res = await post(
      `/v1/identity/mfa-admin/factors/${TEAM_A}/${TARGET}/${FACTOR_ID}/revoke`,
      { reason: "compromised device" },
    );
    expect(res.statusCode).toBe(404);
    expect(H.lifecycleCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 — atomic expectedVersion
// ---------------------------------------------------------------------------

describe("MFA policy patch — atomic expectedPolicyVersion predicate", () => {
  it("two concurrent writers on the SAME read version: exactly ONE wins, the loser mutates nothing", async () => {
    seedPolicy({ policyVersion: 7, mfaPolicyLevel: "OFF" });

    const attempt = (level: string) =>
      updateMfaPolicyVersioned({
        teamId: TEAM_A,
        actorUserId: ACTOR,
        expectedPolicyVersion: 7,
        level: level as never,
      }).then(
        (policy) => ({ ok: true as const, policy }),
        (err) => ({ ok: false as const, err }),
      );

    // Sequential invocation is the honest simulation of the race: the second
    // writer read version 7 BEFORE the first one landed.
    const first = await attempt("ALL_MEMBERS");
    const second = await attempt("ADMINS_ONLY");

    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The winner bumped the version exactly once.
    const row = H.policies.find((p) => p.organizationId === ORG_A);
    expect(row?.policyVersion).toBe(8);
    // The loser wrote NOTHING: the persisted level is the winner's.
    expect(row?.mfaPolicyLevel).toBe("ALL_MEMBERS");
    // And only ONE successful policy write reached the transport.
    expect(
      H.writes.filter((w) => w === "organizationSecurityPolicy.updateMany"),
    ).toHaveLength(1);

    const loser = losers[0] as { ok: false; err: unknown };
    expect(loser.err).toBeInstanceOf(MfaPolicyVersionConflictError);
    expect(loser.err).toMatchObject({
      code: "MFA_POLICY_VERSION_CONFLICT",
      statusCode: 409,
      expectedVersion: 7,
      currentVersion: 8,
    });
  });

  it("the route surfaces a stale version as a bounded 409 with ZERO mutation", async () => {
    seedPolicy({ policyVersion: 4, mfaPolicyLevel: "OFF" });
    const res = await patch(`/v1/identity/mfa-admin/policy/${TEAM_A}`, {
      expectedPolicyVersion: 3,
      level: "ALL_MEMBERS",
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("MFA_POLICY_VERSION_CONFLICT");
    expect(body.error.details).toEqual({ expectedVersion: 3, currentVersion: 4 });
    const row = H.policies.find((p) => p.organizationId === ORG_A);
    expect(row?.policyVersion).toBe(4);
    expect(row?.mfaPolicyLevel).toBe("OFF");
    expect(
      H.writes.filter((w) => w.startsWith("organizationSecurityPolicy.")),
    ).toEqual([]);
  });

  it("a fresh version wins through the route and bumps the version exactly once", async () => {
    seedPolicy({ policyVersion: 4, mfaPolicyLevel: "OFF" });
    const res = await patch(`/v1/identity/mfa-admin/policy/${TEAM_A}`, {
      expectedPolicyVersion: 4,
      level: "ADMINS_ONLY",
      stepUpTtlSeconds: 600,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy.level).toBe("ADMINS_ONLY");
    expect(body.policy.policyVersion).toBe(5);
    expect(
      H.writes.filter((w) => w === "organizationSecurityPolicy.updateMany"),
    ).toHaveLength(1);
  });

  it("provisioning the first row requires expectedPolicyVersion 0; any other value conflicts with zero mutation", async () => {
    await expect(
      updateMfaPolicyVersioned({
        teamId: TEAM_A,
        actorUserId: ACTOR,
        expectedPolicyVersion: 1,
        level: "ALL_MEMBERS" as never,
      }),
    ).rejects.toBeInstanceOf(MfaPolicyVersionConflictError);
    expect(H.policies).toHaveLength(0);
    expect(H.writes).toEqual([]);

    const created = await updateMfaPolicyVersioned({
      teamId: TEAM_A,
      actorUserId: ACTOR,
      expectedPolicyVersion: 0,
      level: "ALL_MEMBERS" as never,
    });
    expect(created.policyVersion).toBe(1);
    expect(H.policies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4 — safe projections
// ---------------------------------------------------------------------------

describe("safe projections — no secret or hash material leaves the API", () => {
  /**
   * Field names that must never appear on a projected row. `recoveryCode`
   * is deliberately NOT in the whole-body scan: the posture legitimately
   * carries the COUNT `recoveryCodesRemaining`, which is a bounded integer
   * and not code material.
   */
  const FORBIDDEN = [
    "secretCiphertext",
    "secretIv",
    "secretAuthTag",
    "secretKekId",
    "deviceIdHash",
    "ipHash",
    "sessionIdHash",
    "recoveryCodes",
    "recoveryCode",
    "otpauth",
    "token",
  ];
  /** Substrings that must not appear ANYWHERE in the serialised response. */
  const FORBIDDEN_IN_BODY = [
    "secretCiphertext",
    "secretIv",
    "secretAuthTag",
    "secretKekId",
    "deviceIdHash",
    "ipHash",
    "sessionIdHash",
    "otpauth",
  ];

  it("the posture response contains no factor secret material and no device or IP hash", async () => {
    const res = await get(`/v1/identity/mfa-admin/posture/${TEAM_A}/${TARGET}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The projection is genuinely populated — this is not an empty-response
    // pass.
    expect(body.factors).toHaveLength(1);
    expect(body.factors[0]).toMatchObject({ id: FACTOR_ID, kind: "TOTP", label: "iPhone" });
    expect(body.trustedDevices).toHaveLength(1);
    expect(body.trustedDevices[0]).toMatchObject({ id: "device-1", status: "ACTIVE" });

    for (const key of FORBIDDEN) {
      expect(Object.keys(body.factors[0])).not.toContain(key);
      expect(Object.keys(body.trustedDevices[0])).not.toContain(key);
    }
    for (const needle of FORBIDDEN_IN_BODY) {
      expect(res.body).not.toContain(needle);
    }
    // And no ciphertext / hash VALUE appears anywhere in the payload.
    expect(res.body).not.toContain("kek-1");
    expect(res.body).not.toContain("d".repeat(64));
    expect(res.body).not.toContain("e".repeat(64));
  });

  it("the MFA event feed never returns the raw details blob", async () => {
    const res = await get(`/v1/identity/mfa-admin/events/${TEAM_A}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
    // The service hands the route a details blob carrying a device hash; the
    // route must pass it through the allow-list projector.
    expect(res.body).not.toContain("should-never-escape");
    expect(res.body).not.toContain("deviceIdHash");
  });
});

// ---------------------------------------------------------------------------
// 5 — step-up denial is zero-mutation
// ---------------------------------------------------------------------------

describe("step-up denial is a ZERO-MUTATION outcome", () => {
  beforeEach(() => {
    H.stepUpAllowed = false;
  });

  it("factor revoke denied at the step-up gate never reaches the mutation", async () => {
    const res = await post(
      `/v1/identity/mfa-admin/factors/${TEAM_A}/${TARGET}/${FACTOR_ID}/revoke`,
      { reason: "compromised device" },
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("STEP_UP_REQUIRED");
    expect(H.lifecycleCalls).toEqual([]);
  });

  it("require re-enrollment denied at the step-up gate never reaches the mutation", async () => {
    const res = await post(
      `/v1/identity/mfa-admin/factors/${TEAM_A}/${TARGET}/require-reenrollment`,
      { reason: "lost authenticator" },
    );
    expect(res.statusCode).toBe(401);
    expect(H.lifecycleCalls).toEqual([]);
  });

  it("trusted-device reset denied at the step-up gate never reaches the mutation", async () => {
    const res = await post(
      `/v1/identity/mfa-admin/trusted-devices/${TEAM_A}/${TARGET}/reset`,
      { reason: "suspicious activity" },
    );
    expect(res.statusCode).toBe(401);
    expect(H.lifecycleCalls).toEqual([]);
  });

  it("the MFA policy patch denied at the step-up gate leaves the policy row untouched", async () => {
    seedPolicy({ policyVersion: 2, mfaPolicyLevel: "OFF" });
    const res = await patch(`/v1/identity/mfa-admin/policy/${TEAM_A}`, {
      expectedPolicyVersion: 2,
      level: "ALL_MEMBERS",
    });
    expect(res.statusCode).toBe(401);
    const row = H.policies.find((p) => p.organizationId === ORG_A);
    expect(row?.policyVersion).toBe(2);
    expect(row?.mfaPolicyLevel).toBe("OFF");
    expect(
      H.writes.filter((w) => w.startsWith("organizationSecurityPolicy.")),
    ).toEqual([]);
  });

  it("READ routes are not step-up gated — posture and policy still resolve", async () => {
    seedPolicy({ policyVersion: 2 });
    expect((await get(`/v1/identity/mfa-admin/posture/${TEAM_A}/${TARGET}`)).statusCode).toBe(200);
    expect((await get(`/v1/identity/mfa-admin/policy/${TEAM_A}`)).statusCode).toBe(200);
  });
});
