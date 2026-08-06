/**
 * PHASE 12B — GROUP B ACCEPTANCE: self-service identity, sessions, devices,
 * MFA enrolment, identity links.
 *
 * PRODUCTION-PATH behaviour. The REAL route handlers of
 *   - src/routes/identity-security.routes.ts   (19 operations)
 *   - src/routes/mfa.routes.ts                 (6 operations)
 *   - src/routes/identity-links.routes.ts      (5 operations)
 *   - src/routes/identity.routes.ts            (3 session/link operations)
 * run under fastify `inject`. Only PROCESS BOUNDARIES are substituted: the
 * database transport, the auth/authorize decision, the OTP provider, the audit
 * sinks and the mutating service functions (recorded, so the route→service
 * chain is PROVEN rather than reimplemented).
 *
 * Deliberately kept REAL so the assertions mean something:
 *   - `projectStepUpChallenge` / `projectRevokedSession` / `projectTrustedDevice`
 *     and `readMfaStatus` (the safe read projections)
 *   - `startStepUpChallenge` / `checkStepUpChallenge` (the challenge lifecycle,
 *     including the PHASE 12B session+Organization binding)
 *   - `listRevocationsForTeam` / `listTrustedDevicesForTeam`
 *   - `isPasswordPolicyCompliant` / `hashPassword`
 *
 * Proof categories per product system:
 *   1. authorized happy path (canonical service called once, SERVER-derived subject)
 *   2. bounded denial with ZERO service call
 *   3. self-only subject enforcement (a client-declared `userId` never wins)
 *   4. current-session protection (bounded 409 / preserved row)
 *   5. secret-free projections asserted against the RAW response body
 *   6. step-up gating with zero mutation on denial
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";

// ---------------------------------------------------------------------------
// Hoisted control surface + in-memory prisma transport.
//
// Everything the vi.mock factories touch lives here: the factories execute
// during the SUT import, before any top-level const is initialised.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const ids = {
    ACTOR: "11111111-1111-4111-8111-111111111111",
    OTHER: "22222222-2222-4222-8222-222222222222",
    OUTSIDER: "99999999-9999-4999-8999-999999999999",
    TEAM: "33333333-3333-4333-8333-333333333333",
    OTHER_TEAM: "3333cccc-3333-4333-8333-333333333333",
    ORG: "44444444-4444-4444-8444-444444444444",
    CUR_SESSION: "55555555-5555-4555-8555-555555555551",
    OTHER_SESSION: "55555555-5555-4555-8555-555555555552",
    FOREIGN_SESSION: "55555555-5555-4555-8555-555555555553",
    DEVICE: "66666666-6666-4666-8666-666666666661",
    UNKNOWN_DEVICE: "66666666-6666-4666-8666-66666666666f",
    CHALLENGE: "77777777-7777-4777-8777-777777777771",
    FOREIGN_CHALLENGE: "77777777-7777-4777-8777-777777777772",
    EXPIRED_CHALLENGE: "77777777-7777-4777-8777-777777777773",
    LINK_A: "88888888-8888-4888-8888-888888888881",
    FOREIGN_LINK: "88888888-8888-4888-8888-888888888882",
    FACTOR_ACTIVE: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    FACTOR_ENROLLING: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    FOREIGN_FACTOR: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
    INTAKE_SESSION: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    MAPPING: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    CURRENT_HASH: "c".repeat(64),
    OTHER_HASH: "d".repeat(64),
    FOREIGN_HASH: "e".repeat(64),
  };

  // -- prisma stub -----------------------------------------------------------
  const OPS = ["in", "notIn", "gt", "gte", "lt", "lte", "not", "startsWith", "contains", "equals"];
  const num = (v: unknown): number =>
    v instanceof Date ? v.getTime() : typeof v === "number" ? v : Number(v);

  function matchWhere(row: Row, where: unknown): boolean {
    if (!where || typeof where !== "object") return true;
    for (const [k, v] of Object.entries(where as Row)) {
      if (v === undefined) continue;
      if (k === "NOT") {
        if (matchWhere(row, v)) return false;
        continue;
      }
      if (k === "OR") {
        if (!(v as unknown[]).some((w) => matchWhere(row, w))) return false;
        continue;
      }
      if (k === "AND") {
        if (!(v as unknown[]).every((w) => matchWhere(row, w))) return false;
        continue;
      }
      const actual = row[k];
      if (v === null) {
        if (actual !== null && actual !== undefined) return false;
        continue;
      }
      if (typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const cond = v as Row;
        if (!Object.keys(cond).some((c) => OPS.includes(c))) {
          // Compound unique selector (teamId_userId, provider_providerUserId, …)
          // or a nested relation filter — recurse against the same row.
          if (!matchWhere(row, cond)) return false;
          continue;
        }
        if ("equals" in cond && actual !== cond.equals) return false;
        if ("in" in cond && !(cond.in as unknown[]).includes(actual)) return false;
        if ("notIn" in cond && (cond.notIn as unknown[]).includes(actual)) return false;
        if ("not" in cond && actual === cond.not) return false;
        if ("gt" in cond && !(num(actual) > num(cond.gt))) return false;
        if ("gte" in cond && !(num(actual) >= num(cond.gte))) return false;
        if ("lt" in cond && !(num(actual) < num(cond.lt))) return false;
        if ("lte" in cond && !(num(actual) <= num(cond.lte))) return false;
        if ("startsWith" in cond && !String(actual).startsWith(String(cond.startsWith))) return false;
        if ("contains" in cond && !String(actual).includes(String(cond.contains))) return false;
        continue;
      }
      if (actual !== v) return false;
    }
    return true;
  }

  /** Prisma `select` is the production secret boundary — honour it faithfully. */
  function pick(row: Row | null | undefined, select: unknown): Row | null {
    if (!row) return null;
    if (!select || typeof select !== "object") return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select as Row)) {
      if (!v) continue;
      if (typeof v === "object" && v !== null && "select" in (v as Row)) {
        out[k] = pick(row[k] as Row | null, (v as Row).select);
      } else {
        out[k] = row[k];
      }
    }
    return out;
  }

  const state = {
    ...ids,
    actorUserId: ids.ACTOR,
    sessionIdHash: ids.CURRENT_HASH as string | null,
    /** `evaluateMemberAccess` verdict (requireSecurityActor's permission gate). */
    accessAllowed: true,
    /** canonical `authorizeOrFail` verdict (anti-enumeration → 404). */
    authorizeAllowed: true,
    /** Enterprise plan gate for session governance. */
    enterpriseOk: true,
    /** target-bound step-up middleware denies. */
    stepUpSent: false,
    /** canonical account step-up (password / MFA / recent OAuth) denies. */
    accountStepUpOk: true,
    rateLimitAllowed: true,
    cronSecretOk: true,
    managedIdentityState: "STANDARD",
    verifyStart: "started" as "started" | "rate_limited" | "invalid_phone",
    verifyCheck: "approved" as "approved" | "denied",
    idTokenValid: true,
    enrollVerifyOk: true,
    totpOk: true,
    recoveryOk: true,
    passwordChange: { ok: true } as Record<string, unknown>,
    calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
    tables: {} as Record<string, Row[]>,
    seq: 0,
  };

  const rec = (name: string, input: unknown): void => {
    state.calls.push({ name, input: (input ?? {}) as Record<string, unknown> });
  };
  const table = (name: string): Row[] => {
    const existing = state.tables[name];
    if (existing) return existing;
    const fresh: Row[] = [];
    state.tables[name] = fresh;
    return fresh;
  };

  const delegate = (name: string) => ({
    findMany: async (a: Row = {}) => {
      rec(`db.${name}.findMany`, a);
      let rows = table(name).filter((x) => matchWhere(x, a.where));
      if (typeof a.take === "number") rows = rows.slice(0, a.take);
      return rows.map((x) => pick(x, a.select));
    },
    findFirst: async (a: Row = {}) => {
      rec(`db.${name}.findFirst`, a);
      return pick(table(name).find((x) => matchWhere(x, a.where)), a.select);
    },
    findUnique: async (a: Row = {}) => {
      rec(`db.${name}.findUnique`, a);
      return pick(table(name).find((x) => matchWhere(x, a.where)), a.select);
    },
    count: async (a: Row = {}) => {
      rec(`db.${name}.count`, a);
      return table(name).filter((x) => matchWhere(x, a.where)).length;
    },
    create: async (a: Row = {}) => {
      rec(`db.${name}.create`, a);
      const row: Row = {
        id: `${name}-${++state.seq}`,
        createdAt: new Date(),
        ...(a.data as Row),
      };
      table(name).push(row);
      return pick(row, a.select);
    },
    update: async (a: Row = {}) => {
      rec(`db.${name}.update`, a);
      const row = table(name).find((x) => matchWhere(x, a.where));
      if (!row) throw new Error(`${name}: row not found`);
      Object.assign(row, a.data as Row);
      return pick(row, a.select);
    },
    updateMany: async (a: Row = {}) => {
      rec(`db.${name}.updateMany`, a);
      const hits = table(name).filter((x) => matchWhere(x, a.where));
      for (const h of hits) Object.assign(h, a.data as Row);
      return { count: hits.length };
    },
    upsert: async (a: Row = {}) => {
      rec(`db.${name}.upsert`, a);
      const row = table(name).find((x) => matchWhere(x, a.where));
      if (row) {
        Object.assign(row, a.update as Row);
        return pick(row, a.select);
      }
      const created: Row = {
        id: `${name}-${++state.seq}`,
        createdAt: new Date(),
        linkedAtUtc: new Date(),
        ...(a.create as Row),
      };
      table(name).push(created);
      return pick(created, a.select);
    },
    groupBy: async (a: Row = {}) => {
      rec(`db.${name}.groupBy`, a);
      const key = (a.by as string[])[0] as string;
      const counts = new Map<unknown, number>();
      for (const r of table(name).filter((x) => matchWhere(x, a.where))) {
        counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
      }
      return [...counts].map(([k, c]) => ({ [key]: k, _count: { _all: c } }));
    },
  });

  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === "$transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(client);
        }
        if (typeof prop !== "string") return undefined;
        return delegate(prop);
      },
    },
  );

  return Object.assign(state, { rec, table, client });
});

const {
  ACTOR, OTHER, OUTSIDER, TEAM, OTHER_TEAM, ORG,
  CUR_SESSION, OTHER_SESSION, FOREIGN_SESSION,
  DEVICE, UNKNOWN_DEVICE,
  CHALLENGE, FOREIGN_CHALLENGE, EXPIRED_CHALLENGE,
  LINK_A, FOREIGN_LINK,
  FACTOR_ACTIVE, FACTOR_ENROLLING, FOREIGN_FACTOR,
  INTAKE_SESSION, MAPPING,
  CURRENT_HASH, OTHER_HASH, FOREIGN_HASH,
} = H;

// ---------------------------------------------------------------------------
// Process boundaries.
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthSessionId: () => "session-1",
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: FastifyRequest) => {
    req.user = {
      sub: H.actorUserId,
      provider: "EMAIL",
      sessionIdHash: H.sessionIdHash,
    };
    (req as unknown as { sessionIdHash: string | null }).sessionIdHash = H.sessionIdHash;
  },
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: FastifyReply,
    opts: { teamId: string; permission: string },
  ) => {
    H.rec("authorizeOrFail", { teamId: opts.teamId, permission: opts.permission });
    if (!H.authorizeAllowed) {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    return { actorUserId: H.actorUserId, teamId: opts.teamId };
  },
}));

vi.mock("../src/services/identity/access-policy.service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  evaluateMemberAccess: async (i: Record<string, unknown>) => {
    H.rec("evaluateMemberAccess", i);
    return H.accessAllowed
      ? { allowed: true }
      : { allowed: false, reason: "permission_denied_capability", detail: null };
  },
}));

vi.mock("../src/services/enterprise-gate-resolvers.service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  denyTeamIfNotEnterprise: async (reply: FastifyReply) => {
    if (H.enterpriseOk) return false;
    reply.code(402).send({ error: { code: "enterprise_plan_required" } });
    return true;
  },
}));

vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (i: {
    teamId: string;
    userId: string;
    purpose: string;
    resourceKind?: string | null;
    resourceId?: string | null;
    reply: FastifyReply;
  }) => {
    H.rec("requireStepUpForSensitiveAction", {
      teamId: i.teamId,
      userId: i.userId,
      purpose: i.purpose,
      resourceKind: i.resourceKind ?? null,
      resourceId: i.resourceId ?? null,
    });
    if (H.stepUpSent) {
      i.reply.code(401).send({
        error: { code: "STEP_UP_REQUIRED", message: "Step-up verification required." },
      });
      return { sent: true };
    }
    return { sent: false, verifiedChallengeId: "verified-chal-1" };
  },
}));

vi.mock("../src/services/identity-security/account-step-up.service.js", () => ({
  RECENT_AUTH_WINDOW_MS: 600_000,
  verifyAccountStepUp: async (i: { userId: string; action: string }) => {
    H.rec("verifyAccountStepUp", { userId: i.userId, action: i.action });
    if (H.accountStepUpOk) return { ok: true };
    return {
      ok: false,
      denial: {
        status: 401,
        body: {
          error: {
            code: "STEP_UP_REQUIRED",
            methods: ["password"],
            message: "Confirm it's you to continue.",
          },
        },
      },
    };
  },
}));

vi.mock("../src/services/rate-limit.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enforceRateLimit: async (p: { key: string; max: number; windowSec: number }) => {
    H.rec("enforceRateLimit", p);
    return {
      allowed: H.rateLimitAllowed,
      remaining: H.rateLimitAllowed ? 4 : 0,
      resetAtMs: Date.now() + 60_000,
    };
  },
}));

vi.mock("../src/services/communications/verification.service.js", () => {
  class VerificationError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    VerificationError,
    startVerification: async (i: Record<string, unknown>) => {
      H.rec("startVerification", i);
      if (H.verifyStart === "invalid_phone") throw new VerificationError("invalid_phone");
      return { status: H.verifyStart === "rate_limited" ? "rate_limited" : "started", attempt: { id: "va-1" } };
    },
    checkVerification: async (i: Record<string, unknown>) => {
      H.rec("checkVerification", i);
      if (H.verifyCheck === "denied") return { status: "denied", attempt: null };
      return { status: "approved", attempt: { id: "va-1" } };
    },
  };
});

vi.mock("../src/services/identity-security/risk.service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getRiskSnapshotForUser: async (i: Record<string, unknown>) => {
    H.rec("getRiskSnapshotForUser", i);
    return {
      level: "MEDIUM",
      score: 35,
      signals: [
        {
          kind: "NEW_DEVICE",
          reason: "First sign-in from this device.",
          observedAtUtc: new Date("2026-07-29T10:00:00.000Z"),
          expiresAtUtc: null,
        },
      ],
    };
  },
}));

vi.mock("../src/services/identity-security/session-revocation.service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  revokeSession: async (i: Record<string, unknown>) => {
    H.rec("revokeSession", i);
    return {
      id: "rs-new", teamId: i.teamId, userId: i.userId, scope: "SINGLE_SESSION",
      reason: i.reason, revokedAtUtc: new Date(), revokedByUserId: i.actorUserId,
      sessionIdHash: "REVOKED-HASH-SEED",
    };
  },
  revokeAllSessionsForUser: async (i: Record<string, unknown>) => {
    H.rec("revokeAllSessionsForUser", i);
    return {
      id: "rs-all", teamId: i.teamId, userId: i.userId, scope: "ALL_FOR_USER",
      reason: i.reason, revokedAtUtc: new Date(), revokedByUserId: i.actorUserId,
      sessionIdHash: "REVOKED-HASH-SEED",
    };
  },
}));

vi.mock("../src/services/identity-security/trusted-device.service.js", async (orig) => {
  const deviceRow = (status: string) => ({
    id: H.DEVICE, teamId: H.TEAM, userId: H.ACTOR,
    uaPreview: "Chrome on macOS", ipPreview: "203.0.113.x", status,
    trustedUntilUtc: new Date("2026-08-29T00:00:00.000Z"),
    firstSeenAtUtc: new Date("2026-07-01T00:00:00.000Z"),
    lastSeenAtUtc: new Date("2026-07-29T00:00:00.000Z"),
    revokedAtUtc: status === "REVOKED" ? new Date() : null,
    deviceIdHash: "DEVICE-HASH-SEED", ipHash: "IP-HASH-SEED",
  });
  return {
    ...(await orig<Record<string, unknown>>()),
    markDeviceTrusted: async (i: Record<string, unknown>) => {
      H.rec("markDeviceTrusted", i);
      return deviceRow("ACTIVE");
    },
    revokeTrustedDevice: async (i: Record<string, unknown>) => {
      H.rec("revokeTrustedDevice", i);
      return i.deviceId === H.DEVICE ? deviceRow("REVOKED") : null;
    },
  };
});

vi.mock("../src/services/identity-security/mfa-policy.service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMfaPolicy: async (teamId: string) => {
    H.rec("getMfaPolicy", { teamId });
    return { teamId, level: "ADMINS_ONLY", stepUpTtlSeconds: 900, trustedDeviceTtlDays: 30 };
  },
  evaluateMfaRequirement: async (i: Record<string, unknown>) => {
    H.rec("evaluateMfaRequirement", i);
    return { required: true, reason: "role_in_policy_scope" };
  },
  updateMfaPolicy: async (i: Record<string, unknown>) => {
    H.rec("updateMfaPolicy", i);
    return {
      teamId: i.teamId, level: i.level,
      stepUpTtlSeconds: i.stepUpTtlSeconds ?? null,
      trustedDeviceTtlDays: i.trustedDeviceTtlDays ?? null,
      policyVersion: 2,
    };
  },
}));

vi.mock("../src/services/security/mfa.service.js", async (orig) => ({
  // `readMfaStatus` stays REAL — it is the safe read projection under test.
  ...(await orig<Record<string, unknown>>()),
  beginTotpEnrollment: async (i: Record<string, unknown>) => {
    H.rec("beginTotpEnrollment", i);
    return {
      factorId: "factor-new",
      otpauthUri: "otpauth://totp/PROOVRA:actor@example.com?secret=ENROLMENTSEEDONCE",
      secretBase32: "ENROLMENTSEEDONCE",
    };
  },
  verifyAndActivateEnrollment: async (i: Record<string, unknown>) => {
    H.rec("verifyAndActivateEnrollment", i);
    return H.enrollVerifyOk
      ? { ok: true, factorId: i.factorId, recoveryCodes: ["AAAA-1111-BBBB"] }
      : { ok: false, reason: "code_invalid" };
  },
  revokeFactor: async (i: Record<string, unknown>) => {
    H.rec("revokeFactor", i);
    return { ok: true };
  },
  regenerateRecoveryBatch: async (i: Record<string, unknown>) => {
    H.rec("regenerateRecoveryBatch", i);
    return { recoveryCodes: ["CCCC-2222-DDDD"] };
  },
  verifyActiveTotp: async (i: Record<string, unknown>) => {
    H.rec("verifyActiveTotp", i);
    return H.totpOk ? { ok: true, factorId: H.FACTOR_ACTIVE } : { ok: false, factorId: null };
  },
  consumeRecoveryCode: async (i: Record<string, unknown>) => {
    H.rec("consumeRecoveryCode", i);
    return H.recoveryOk ? { ok: true } : { ok: false, reason: "recovery_code_invalid" };
  },
}));

vi.mock("../src/services/email-password-auth.service.js", async (orig) => ({
  // `isPasswordPolicyCompliant` + `hashPassword` stay REAL.
  ...(await orig<Record<string, unknown>>()),
  changePasswordForUser: async (i: Record<string, unknown>) => {
    H.rec("changePasswordForUser", i);
    return H.passwordChange;
  },
}));

vi.mock("../src/services/auth.service.js", async (orig) => {
  const verifier = (provider: "GOOGLE" | "APPLE", subject: string) =>
    async (idToken: string) => {
      H.rec(`verify${provider}IdToken`, { idToken });
      if (!H.idTokenValid) throw new Error("token_rejected");
      return { provider, providerUserId: subject, email: "actor@example.com" };
    };
  return {
    ...(await orig<Record<string, unknown>>()),
    verifyGoogleIdToken: verifier("GOOGLE", "GOOGLE-SUBJECT-SEED"),
    verifyAppleIdToken: verifier("APPLE", "APPLE-SUBJECT-SEED"),
  };
});

vi.mock("../src/middleware/cron-secret.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireIntegrationCronSecret: async (_req: unknown, reply: FastifyReply) => {
    if (H.cronSecretOk) return true;
    reply.code(401).send({ error: { code: "unauthorized" } });
    return false;
  },
}));

vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  resolveManagedIdentity: async (userId: string) => {
    H.rec("resolveManagedIdentity", { userId });
    return { state: H.managedIdentityState };
  },
}));

vi.mock("../src/services/identity/contributor-governance.service.js", () => {
  class ContributorGovernanceError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    ContributorGovernanceError,
    revokeContributorSession: async (i: Record<string, unknown>) => {
      H.rec("revokeContributorSession", i);
      return { id: i.intakeSessionId, revokedAtUtc: new Date().toISOString() };
    },
  };
});

vi.mock("../src/services/identity/external-identity.service.js", () => {
  class ExternalIdentityError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    ExternalIdentityError,
    listExternalIdentityMappings: async () => [],
    linkExternalIdentity: async (i: Record<string, unknown>) => {
      H.rec("linkExternalIdentity", i);
      return { id: H.MAPPING, teamId: i.teamId, userId: i.userId, provider: i.provider };
    },
    unlinkExternalIdentity: async (i: Record<string, unknown>) => {
      H.rec("unlinkExternalIdentity", i);
      return { id: i.mappingId, status: "REVOKED" };
    },
  };
});

// identity.routes.ts imports these at module load; they are not exercised here.
vi.mock("../src/services/identity/membership-provisioning.service.js", () => {
  class RbacError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const noop = async () => ({});
  return {
    RbacError,
    changeMemberRole: noop, grantCapability: noop, grantDelegatedAdminScope: noop,
    listTeamMembersWithAccess: async () => [], restoreMember: noop,
    revokeCapability: noop, revokeDelegatedAdminScope: noop, revokeMember: noop,
    suspendMember: noop,
  };
});

vi.mock("../src/services/integrations/api-keys.service.js", () => {
  class ApiCredentialError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const noop = async () => ({});
  return {
    ApiCredentialError,
    disableApiCredential: noop, enableApiCredential: noop,
    listApiCredentials: async () => [],
    projectApiCredential: (r: unknown) => r,
    updateApiCredentialHardening: noop,
  };
});

vi.mock("../src/services/identity/access-review.service.js", () => {
  class AccessReviewError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const noop = async () => ({});
  return {
    AccessReviewError,
    completeAccessReview: noop,
    listAccessReviews: async () => [],
    regenerateAccessReviewQueue: async () => ({ created: 0 }),
  };
});

vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: () => undefined,
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitPlatformAudit: async (e: Record<string, unknown>) => {
    H.rec("emitPlatformAudit", e);
  },
  emitTenantAudit: async (e: Record<string, unknown>) => {
    H.rec("emitTenantAudit", e);
  },
}));

vi.mock("../src/db.js", () => ({ prisma: H.client }));

import { identitySecurityRoutes } from "../src/routes/identity-security.routes.js";
import { mfaRoutes } from "../src/routes/mfa.routes.js";
import { identityLinksRoutes } from "../src/routes/identity-links.routes.js";
import { identityRoutes } from "../src/routes/identity.routes.js";

// ---------------------------------------------------------------------------
// Seed. Rows carry LEAK CANARIES ("…-SEED") in every column a projection must
// drop, so a widened projection is observable in the raw response body.
// ---------------------------------------------------------------------------

const past = (ms: number) => new Date(Date.now() - ms);
const future = (ms: number) => new Date(Date.now() + ms);
const DAY = 86_400_000;

function seed(): void {
  for (const k of Object.keys(H.tables)) delete H.tables[k];
  H.tables.user = [
    {
      id: ACTOR, email: "actor@example.com", displayName: "Actor",
      passwordHash: "PASSWORD-HASH-SEED", provider: "EMAIL", providerUserId: null,
      currentWorkspaceId: TEAM,
    },
    {
      id: OTHER, email: "other@example.com", displayName: "Other",
      passwordHash: "OTHER-PASSWORD-HASH-SEED", provider: "GOOGLE",
      providerUserId: "other-google-sub", currentWorkspaceId: TEAM,
    },
  ];
  H.tables.team = [{ id: TEAM, organizationId: ORG }, { id: OTHER_TEAM, organizationId: ORG }];
  H.tables.teamMember = [
    { id: "tm-actor", teamId: TEAM, userId: ACTOR, role: "ADMIN", status: "ACTIVE" },
    { id: "tm-other", teamId: TEAM, userId: OTHER, role: "MEMBER", status: "ACTIVE" },
    // Second workspace membership — lets the expiry/scoping cases address
    // OTHER_TEAM without tripping the anti-enumeration membership probe.
    { id: "tm-actor-2", teamId: OTHER_TEAM, userId: ACTOR, role: "ADMIN", status: "ACTIVE" },
  ];
  H.tables.organizationSecurityPolicy = [
    {
      organizationId: ORG, concurrentSessionLimit: 1, maxSessionAgeSeconds: 28_800,
      idleTimeoutSeconds: 900, stepUpIntervalSeconds: 300, policyVersion: 7,
    },
  ];
  const session = (id: string, userId: string, hash: string, ip: string, ua: string) => ({
    id, userId, teamId: TEAM, sessionIdHash: hash,
    issuedAtUtc: past(DAY), expiresAtUtc: future(DAY), lastSeenAtUtc: past(60_000),
    ipPreview: ip, uaPreview: ua, ssoConnectionId: null, countryCode: "GB",
    quarantinedAtUtc: null, revokedAtUtc: null, sessionToken: "SESSION-TOKEN-SEED",
  });
  H.tables.authenticatedSession = [
    session(CUR_SESSION, ACTOR, CURRENT_HASH, "203.0.113.x", "Chrome on macOS"),
    session(OTHER_SESSION, ACTOR, OTHER_HASH, "198.51.100.x", "Safari on iOS"),
    session(FOREIGN_SESSION, OTHER, FOREIGN_HASH, "192.0.2.x", "Firefox on Windows"),
  ];
  H.tables.revokedSession = [
    {
      id: "rs-1", teamId: TEAM, userId: OTHER, scope: "SINGLE_SESSION",
      reason: "OPERATOR_REVOKED", revokedAtUtc: past(DAY), revokedByUserId: ACTOR,
      sessionIdHash: "REVOKED-HASH-SEED", revokedBeforeIat: null,
    },
  ];
  const device = (id: string, trustedUntilUtc: Date) => ({
    id, teamId: TEAM, userId: ACTOR, uaPreview: "Chrome on macOS", ipPreview: "203.0.113.x",
    status: "ACTIVE", trustedUntilUtc, firstSeenAtUtc: past(30 * DAY),
    lastSeenAtUtc: past(60_000), revokedAtUtc: null,
    deviceIdHash: "DEVICE-HASH-SEED", ipHash: "IP-HASH-SEED",
  });
  // One live device + one past its TTL (the reconcile sweep target).
  H.tables.trustedDevice = [device(DEVICE, future(30 * DAY)), device("td-expired", past(DAY))];
  const auditRow = (id: string, userId: string, action: string) => ({
    id, userId, action, severity: "INFO", outcome: "success", createdAt: past(3_600_000),
    resourceType: "user", resourceId: userId, metadata: {},
    ipAddress: "203.0.113.42", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
  H.tables.adminAuditLog = [
    auditRow("al-1", ACTOR, "identity_security.password_change"),
    auditRow("al-2", ACTOR, "evidence.downloaded"), // out of security category
    auditRow("al-3", OTHER, "auth.login"), // another account
  ];
  const link = (id: string, userId: string, provider: string, subject: string, email: string) => ({
    id, userId, provider, providerSubjectId: subject, normalizedEmail: email,
    linkedAtUtc: past(30 * DAY), lastUsedAtUtc: null, status: "ACTIVE",
    providerEmailVerified: true, revokedAtUtc: null,
  });
  H.tables.userIdentityLink = [
    link(LINK_A, ACTOR, "GOOGLE", "GOOGLE-SUBJECT-SEED", "actor@example.com"),
    link(FOREIGN_LINK, OTHER, "APPLE", "APPLE-OTHER-SEED", "other@example.com"),
  ];
  const factor = (id: string, userId: string, status: string, label: string) => ({
    id, userId, kind: "TOTP", label, status,
    enrolledAt: status === "ACTIVE" ? past(30 * DAY) : null,
    lastUsedAt: null, createdAt: past(30 * DAY),
    // Sealed secret material — must never reach any projection.
    secretCiphertext: "TOTP-CIPHERTEXT-SEED", secretIv: "TOTP-IV-SEED",
    secretAuthTag: "TOTP-AUTHTAG-SEED", secretKekId: "dev-fallback-v1",
  });
  H.tables.mfaFactor = [
    factor(FACTOR_ACTIVE, ACTOR, "ACTIVE", "Authenticator app"),
    factor(FACTOR_ENROLLING, ACTOR, "ENROLLING", "New phone"),
    factor(FOREIGN_FACTOR, OTHER, "ACTIVE", "Another account's app"),
  ];
  H.tables.mfaRecoveryCode = [
    { id: "rc-1", userId: ACTOR, codeHash: "RECOVERY-CODE-SEED", usedAt: null, batchInvalidatedAt: null },
    { id: "rc-2", userId: ACTOR, codeHash: "RECOVERY-CODE-SEED", usedAt: null, batchInvalidatedAt: null },
  ];
  // PHASE 12B: challenges are bound to (team, user, purpose, resource) AND to
  // the starting session + the Organization.
  const challenge = (id: string, teamId: string, userId: string, hash: string, expiresAtUtc: Date) => ({
    id, teamId, organizationId: ORG, initiatedByUserId: userId,
    purpose: "SESSION_SANITY_CHECK", resourceKind: null, resourceId: null,
    status: "PENDING", verificationAttemptId: "va-0", expiresAtUtc,
    approvedAtUtc: null, createdAt: past(60_000), reason: null, sessionIdHash: hash,
  });
  H.tables.stepUpChallenge = [
    challenge(CHALLENGE, TEAM, ACTOR, CURRENT_HASH, future(900_000)),
    challenge(FOREIGN_CHALLENGE, TEAM, OTHER, FOREIGN_HASH, future(900_000)),
    challenge(EXPIRED_CHALLENGE, OTHER_TEAM, ACTOR, CURRENT_HASH, past(60_000)),
  ];
  H.tables.verificationAttempt = [];
  H.tables.riskSignal = [];
  H.tables.workflowIntakeSession = [
    { id: INTAKE_SESSION, revokedAtUtc: null, intakeLink: { teamId: TEAM } },
  ];
  H.tables.externalIdentityMapping = [{ id: MAPPING, teamId: TEAM, userId: OTHER }];
}

let app: FastifyInstance;

beforeEach(async () => {
  H.actorUserId = ACTOR;
  H.sessionIdHash = CURRENT_HASH;
  H.accessAllowed = true;
  H.authorizeAllowed = true;
  H.enterpriseOk = true;
  H.stepUpSent = false;
  H.accountStepUpOk = true;
  H.rateLimitAllowed = true;
  H.cronSecretOk = true;
  H.managedIdentityState = "STANDARD";
  H.verifyStart = "started";
  H.verifyCheck = "approved";
  H.idTokenValid = true;
  H.enrollVerifyOk = true;
  H.totpOk = true;
  H.recoveryOk = true;
  H.passwordChange = { ok: true };
  H.calls.length = 0;
  H.seq = 0;
  seed();

  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(identitySecurityRoutes);
  await app.register(mfaRoutes);
  await app.register(identityLinksRoutes);
  await app.register(identityRoutes);
  await app.ready();
});

// -- helpers ----------------------------------------------------------------

const called = (name: string) => H.calls.filter((c) => c.name === name);
const callInput = (name: string) => called(name)[0]?.input ?? {};
const STEP_UP = { "x-proovra-step-up-challenge-id": "chal-1" };
const sessionRow = (id: string) =>
  H.table("authenticatedSession").find((r) => r.id === id) as Record<string, unknown>;
const linkRow = (id: string) =>
  H.table("userIdentityLink").find((r) => r.id === id) as Record<string, unknown>;

// ===========================================================================
// PRODUCT SYSTEM 1 — Step-up challenge lifecycle (start / check).
// The REAL step-up service runs; only the OTP provider is substituted.
// ===========================================================================

describe("step-up challenge lifecycle", () => {
  const startBody = {
    teamId: TEAM,
    purpose: "SESSION_SANITY_CHECK",
    phone: "+447700900123",
    channel: "SMS",
    reason: "confirm operator session",
  };

  it("authorized start mints a PENDING challenge bound to the SERVER-derived actor, session and Organization", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/start",
      payload: { ...startBody, userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.challenge.status).toBe("PENDING");
    expect(body.challenge.purpose).toBe("SESSION_SANITY_CHECK");

    // The row the REAL service persisted: subject/session/org are derived.
    const created = callInput("db.stepUpChallenge.create").data as Record<string, unknown>;
    expect(created.initiatedByUserId).toBe(ACTOR); // NOT the declared OTHER
    expect(created.sessionIdHash).toBe(CURRENT_HASH);
    expect(created.organizationId).toBe(ORG);
    expect(created.status).toBe("PENDING");
    // The OTP code is never persisted on the challenge row.
    expect(Object.keys(created)).not.toContain("code");
    // The projected challenge never echoes the phone the caller submitted.
    expect(res.body).not.toContain("+447700900123");
  });

  it("permission denial → 403, and NO challenge is minted", async () => {
    H.accessAllowed = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/start", payload: startBody,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("permission_denied");
    expect(called("db.stepUpChallenge.create")).toHaveLength(0);
    expect(called("startVerification")).toHaveLength(0);
  });

  it("non-member → 404 (anti-enumeration), NO challenge minted", async () => {
    H.actorUserId = OUTSIDER;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/start", payload: startBody,
    });
    expect(res.statusCode).toBe(404);
    expect(called("db.stepUpChallenge.create")).toHaveLength(0);
  });

  it("provider rate limit / invalid phone map to bounded codes with no challenge row", async () => {
    H.verifyStart = "rate_limited";
    const limited = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/start", payload: startBody,
    });
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.body).error.code).toBe("rate_limited");

    H.verifyStart = "invalid_phone";
    const bad = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/start", payload: startBody,
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe("invalid_phone");
    expect(called("db.stepUpChallenge.create")).toHaveLength(0);
  });

  const checkBody = (challengeId: string, teamId = TEAM) => ({
    teamId, challengeId, phone: "+447700900123", code: "123456",
  });

  it("check from the SAME session approves and returns a secret-free projection", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check", payload: checkBody(CHALLENGE),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("approved");
    expect(body.challenge.status).toBe("APPROVED");
    expect(body.challenge.approvedAtUtc).not.toBeNull();
    // The submitted OTP + phone are never echoed anywhere in the response.
    expect(res.body).not.toContain("123456");
    expect(res.body).not.toContain("+447700900123");
    expect(res.body).not.toContain(CURRENT_HASH);
  });

  it("SELF-ONLY: a challenge started by ANOTHER user is a generic denial, and stays PENDING", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check",
      payload: checkBody(FOREIGN_CHALLENGE),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ status: "denied" });
    // Not approved, not even marked DENIED — the foreign row is untouched.
    const row = H.table("stepUpChallenge").find((r) => r.id === FOREIGN_CHALLENGE);
    expect(row?.status).toBe("PENDING");
    expect(called("checkVerification")).toHaveLength(0);
  });

  it("SESSION BINDING: the same actor in a DIFFERENT session cannot approve its own challenge", async () => {
    H.sessionIdHash = OTHER_HASH;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check", payload: checkBody(CHALLENGE),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ status: "denied" });
    expect(H.table("stepUpChallenge").find((r) => r.id === CHALLENGE)?.status).toBe("PENDING");
    expect(called("checkVerification")).toHaveLength(0);
  });

  it("a wrong OTP is bucketed into the SAME generic denial and flips the row to DENIED", async () => {
    H.verifyCheck = "denied";
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check", payload: checkBody(CHALLENGE),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ status: "denied" });
    expect(H.table("stepUpChallenge").find((r) => r.id === CHALLENGE)?.status).toBe("DENIED");
  });

  it("an expired challenge is bucketed identically and marked EXPIRED", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check",
      payload: checkBody(EXPIRED_CHALLENGE, OTHER_TEAM),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ status: "denied" });
    expect(H.table("stepUpChallenge").find((r) => r.id === EXPIRED_CHALLENGE)?.status).toBe("EXPIRED");
  });

  it("check denial on permission → 403 and the provider is never consulted", async () => {
    H.accessAllowed = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/step-up/check", payload: checkBody(CHALLENGE),
    });
    expect(res.statusCode).toBe(403);
    expect(called("checkVerification")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 2 — Workspace session governance (operator surfaces).
// ===========================================================================

describe("workspace session governance", () => {
  it("revoke ONE session calls the canonical revoker once with the SERVER-derived actor", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/sessions/revoke",
      payload: { teamId: TEAM, userId: OTHER, sessionIdHash: FOREIGN_HASH, reason: "OPERATOR_REVOKED" },
    });
    expect(res.statusCode).toBe(200);
    expect(called("revokeSession")).toHaveLength(1);
    const input = callInput("revokeSession");
    expect(input.teamId).toBe(TEAM);
    expect(input.userId).toBe(OTHER);
    expect(input.actorUserId).toBe(ACTOR);
    // Real projection: the revocation surface never returns the session hash.
    expect(res.body).not.toContain("REVOKED-HASH-SEED");
    expect(res.body).not.toContain("sessionIdHash");
  });

  it("revoke ALL for a user calls the canonical bulk revoker once", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/sessions/revoke-all",
      payload: { teamId: TEAM, userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(called("revokeAllSessionsForUser")).toHaveLength(1);
    expect(callInput("revokeAllSessionsForUser").actorUserId).toBe(ACTOR);
    expect(JSON.parse(res.body).revoked.scope).toBe("ALL_FOR_USER");
  });

  it("GET sessions lists the workspace revocation window through the REAL projection", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/sessions?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).revoked;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: OTHER, scope: "SINGLE_SESSION" });
    expect(res.body).not.toContain("REVOKED-HASH-SEED");
  });

  it("session-policy-impact computes the over-limit verdict SERVER-side", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/session-policy-impact?teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy).toMatchObject({ policyProvisioned: true, concurrentSessionLimit: 1, policyVersion: 7 });
    // ACTOR holds 2 live sessions against a limit of 1 → over limit by 1.
    const actorRow = body.impact.find((r: { userId: string }) => r.userId === ACTOR);
    expect(actorRow).toMatchObject({ activeSessionCount: 2, overLimit: true, excessSessionCount: 1 });
    const otherRow = body.impact.find((r: { userId: string }) => r.userId === OTHER);
    expect(otherRow).toMatchObject({ activeSessionCount: 1, overLimit: false });
    expect(body.membersOverLimit).toBe(1);
  });

  const GOVERNANCE_MUTATIONS = [
    {
      name: "sessions/revoke", url: "/v1/identity-security/sessions/revoke",
      payload: { teamId: TEAM, userId: OTHER, sessionIdHash: FOREIGN_HASH }, service: "revokeSession",
    },
    {
      name: "sessions/revoke-all", url: "/v1/identity-security/sessions/revoke-all",
      payload: { teamId: TEAM, userId: OTHER }, service: "revokeAllSessionsForUser",
    },
  ] as const;

  for (const op of GOVERNANCE_MUTATIONS) {
    it(`${op.name}: permission denial → 403 with ZERO revocation`, async () => {
      H.accessAllowed = false;
      const res = await app.inject({ method: "POST", url: op.url, payload: op.payload });
      expect(res.statusCode).toBe(403);
      expect(called(op.service)).toHaveLength(0);
    });

    it(`${op.name}: non-member → 404 with ZERO revocation`, async () => {
      H.actorUserId = OUTSIDER;
      const res = await app.inject({ method: "POST", url: op.url, payload: op.payload });
      expect(res.statusCode).toBe(404);
      expect(called(op.service)).toHaveLength(0);
    });

    it(`${op.name}: non-Enterprise plan → bounded gate denial with ZERO revocation`, async () => {
      H.enterpriseOk = false;
      const res = await app.inject({ method: "POST", url: op.url, payload: op.payload });
      expect(res.statusCode).not.toBe(200);
      expect(called(op.service)).toHaveLength(0);
    });
  }

  it("GET sessions on a non-Enterprise workspace is gated and reads nothing", async () => {
    H.enterpriseOk = false;
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/sessions?teamId=${TEAM}` });
    expect(res.statusCode).not.toBe(200);
    expect(called("db.revokedSession.findMany")).toHaveLength(0);
  });

  it("session-policy-impact concealed 404 for an unauthorized caller, reading no inventory", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/session-policy-impact?teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(404);
    expect(called("db.authenticatedSession.groupBy")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 3 — Identity runtime reconcile (cron OR operator).
// ===========================================================================

describe("identity runtime reconcile", () => {
  it("operator sweep is SCOPED to the authorized workspace and audited", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/reconcile",
      headers: STEP_UP, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scope).toBe("workspace");
    // The expired challenge in OTHER_TEAM is NOT swept by a TEAM operator.
    expect(body.expiredStepUps).toBe(0);
    expect(body.expiredDevices).toBe(1);
    expect(H.table("stepUpChallenge").find((r) => r.id === EXPIRED_CHALLENGE)?.status).toBe("PENDING");
    expect(H.table("trustedDevice").find((r) => r.id === "td-expired")?.status).toBe("REVOKED");
    expect(called("emitTenantAudit")).toHaveLength(1);
  });

  it("cron sweep is platform-wide and not attributed to an operator", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/reconcile",
      headers: { "x-proovra-integration-cron-secret": "s3cret" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scope).toBe("platform_cron");
    expect(body.expiredStepUps).toBe(1);
    expect(called("emitTenantAudit")).toHaveLength(0);
  });

  it("operator step-up denial → 401 with ZERO reconciliation", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/reconcile", payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(401);
    expect(called("db.stepUpChallenge.updateMany")).toHaveLength(0);
    expect(called("db.trustedDevice.updateMany")).toHaveLength(0);
    expect(H.table("trustedDevice").find((r) => r.id === "td-expired")?.status).toBe("ACTIVE");
  });

  it("unauthorized operator → concealed 404 with ZERO reconciliation", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/reconcile",
      headers: STEP_UP, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(called("db.trustedDevice.updateMany")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 4 — Self-service "my sessions" (the account-tier surface).
// ===========================================================================

describe("self-service my-sessions", () => {
  it("lists ONLY the caller's live sessions and flags the current one", async () => {
    const res = await app.inject({
      // A declared subject is ignored: this surface has no subject parameter.
      method: "GET", url: `/v1/identity-security/my-sessions?userId=${OTHER}`,
    });
    expect(res.statusCode).toBe(200);
    const sessions = JSON.parse(res.body).sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.id).sort()).toEqual([CUR_SESSION, OTHER_SESSION].sort());
    expect(sessions.find((s) => s.id === CUR_SESSION)?.isCurrent).toBe(true);
    expect(sessions.find((s) => s.id === OTHER_SESSION)?.isCurrent).toBe(false);
    // SELF-ONLY: the query is keyed on the session subject, never a parameter.
    expect((callInput("db.authenticatedSession.findMany").where as Record<string, unknown>).userId).toBe(ACTOR);
  });

  it("another account's live sessions are simply not readable (empty inventory)", async () => {
    H.actorUserId = OUTSIDER;
    H.sessionIdHash = null;
    const res = await app.inject({ method: "GET", url: "/v1/identity-security/my-sessions" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sessions).toEqual([]);
  });

  it("revoke-others terminates every OTHER session and PRESERVES the current one", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/my-sessions/revoke-others",
      payload: { stepUp: { method: "password", currentPassword: "pw" }, userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revoked).toBe(1);
    // Current session preserved; the caller is not logged out of this page.
    expect(sessionRow(CUR_SESSION).revokedAtUtc).toBeNull();
    expect(sessionRow(OTHER_SESSION).revokedAtUtc).not.toBeNull();
    expect(sessionRow(OTHER_SESSION).revokedReason).toBe("SELF_REVOKE_OTHERS");
    // SELF-ONLY: the declared userId never reaches the mutation.
    const where = callInput("db.authenticatedSession.updateMany").where as Record<string, unknown>;
    expect(where.userId).toBe(ACTOR);
    expect(where.NOT).toEqual({ sessionIdHash: CURRENT_HASH });
    // Another account's session is untouched.
    expect(sessionRow(FOREIGN_SESSION).revokedAtUtc).toBeNull();
    expect(callInput("verifyAccountStepUp")).toMatchObject({ userId: ACTOR, action: "sessions_revoke_others" });
  });

  it("revoke-others step-up denial → 401 with ZERO revocation", async () => {
    H.accountStepUpOk = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/my-sessions/revoke-others", payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("STEP_UP_REQUIRED");
    expect(called("db.authenticatedSession.updateMany")).toHaveLength(0);
    expect(sessionRow(OTHER_SESSION).revokedAtUtc).toBeNull();
  });

  it("revoking ONE of my other sessions works and leaves the current session alive", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/my-sessions/${OTHER_SESSION}/revoke`,
      payload: { stepUp: { method: "password", currentPassword: "pw" } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revoked).toBe(1);
    expect(sessionRow(OTHER_SESSION).revokedReason).toBe("SELF_REVOKE_SINGLE");
    expect(sessionRow(CUR_SESSION).revokedAtUtc).toBeNull();
  });

  it("CURRENT-SESSION PROTECTION: revoking my own current session is a bounded 409, never a silent sign-out", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/my-sessions/${CUR_SESSION}/revoke`,
      payload: { stepUp: { method: "password", currentPassword: "pw" } },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("current_session_not_revocable");
    expect(sessionRow(CUR_SESSION).revokedAtUtc).toBeNull();
    expect(called("db.authenticatedSession.update")).toHaveLength(0);
  });

  it("SELF-ONLY: another account's session id is a 404, not an authorization oracle", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/my-sessions/${FOREIGN_SESSION}/revoke`,
      payload: { stepUp: { method: "password", currentPassword: "pw" } },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("session_not_found");
    expect(sessionRow(FOREIGN_SESSION).revokedAtUtc).toBeNull();
    expect(called("db.authenticatedSession.update")).toHaveLength(0);
  });

  it("single-session revoke step-up denial → 401 with ZERO revocation", async () => {
    H.accountStepUpOk = false;
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/my-sessions/${OTHER_SESSION}/revoke`, payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(called("db.authenticatedSession.update")).toHaveLength(0);
    expect(sessionRow(OTHER_SESSION).revokedAtUtc).toBeNull();
  });
});

// ===========================================================================
// PRODUCT SYSTEM 5 — Trusted devices.
// ===========================================================================

describe("trusted devices", () => {
  it("GET devices lists the workspace inventory through the REAL projection", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/devices?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const devices = JSON.parse(res.body).devices as Array<Record<string, unknown>>;
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ userId: ACTOR, status: "ACTIVE" });
    expect(res.body).not.toContain("DEVICE-HASH-SEED");
    expect(res.body).not.toContain("IP-HASH-SEED");
  });

  it("GET devices permission denial → 403 with no inventory read", async () => {
    H.accessAllowed = false;
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/devices?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
    expect(called("db.trustedDevice.findMany")).toHaveLength(0);
  });

  it("trust mints a SERVER-derived correlation value; a client-supplied one never wins", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/devices/trust", headers: STEP_UP,
      payload: { teamId: TEAM, deviceCookieValue: "attacker-minted-device-value", ttlDays: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(called("markDeviceTrusted")).toHaveLength(1);
    const input = callInput("markDeviceTrusted");
    expect(input.userId).toBe(ACTOR);
    expect(input.deviceCookieValue).not.toBe("attacker-minted-device-value");
    expect(String(input.deviceCookieValue).length).toBeGreaterThanOrEqual(16);
    // The minted value is set as an HTTP-only cookie and never returned.
    const cookie = res.cookies.find((c) => c.name === "proovra_device_id");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.value).toBe(input.deviceCookieValue);
    expect(res.body).not.toContain(String(input.deviceCookieValue));
    expect(res.body).not.toContain("DEVICE-HASH-SEED");
  });

  it("trust reuses the correlation value already carried by the browser and mints nothing new", async () => {
    const existing = "existing-device-correlation-value";
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/devices/trust",
      headers: { ...STEP_UP, cookie: `proovra_device_id=${existing}` },
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    expect(callInput("markDeviceTrusted").deviceCookieValue).toBe(existing);
    expect(res.cookies.find((c) => c.name === "proovra_device_id")).toBeUndefined();
  });

  it("SELF-ONLY: naming a different subject is concealed as 404 and trusts nothing", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/devices/trust", headers: STEP_UP,
      payload: { teamId: TEAM, userId: OTHER },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect(called("markDeviceTrusted")).toHaveLength(0);
    expect(called("requireStepUpForSensitiveAction")).toHaveLength(0);
  });

  it("trust step-up denial → 401, target-bound purpose, ZERO trust granted", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/devices/trust", payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(401);
    expect(called("markDeviceTrusted")).toHaveLength(0);
    expect(callInput("requireStepUpForSensitiveAction")).toMatchObject({
      purpose: "TRUSTED_DEVICE_TRUST", resourceKind: "trusted_device_subject", resourceId: ACTOR,
    });
  });

  it("trust unauthorized → concealed 404, ZERO trust granted", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/devices/trust", headers: STEP_UP,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(called("markDeviceTrusted")).toHaveLength(0);
  });

  it("device revoke calls the canonical revoker with the SERVER-derived actor", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/devices/${DEVICE}/revoke`,
      payload: { teamId: TEAM, reason: "lost laptop" },
    });
    expect(res.statusCode).toBe(200);
    expect(called("revokeTrustedDevice")).toHaveLength(1);
    expect(callInput("revokeTrustedDevice")).toMatchObject({
      teamId: TEAM, deviceId: DEVICE, actorUserId: ACTOR,
    });
    expect(JSON.parse(res.body).device.status).toBe("REVOKED");
    expect(res.body).not.toContain("DEVICE-HASH-SEED");
  });

  it("device revoke for an unknown device is a bounded 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/devices/${UNKNOWN_DEVICE}/revoke`,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  });

  it("device revoke permission denial → 403 with ZERO revocation", async () => {
    H.accessAllowed = false;
    const res = await app.inject({
      method: "POST", url: `/v1/identity-security/devices/${DEVICE}/revoke`, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(403);
    expect(called("revokeTrustedDevice")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 6 — Workspace MFA policy.
// ===========================================================================

describe("workspace MFA policy", () => {
  it("GET policy returns the policy plus the CALLER's own requirement", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/mfa-policy?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy.level).toBe("ADMINS_ONLY");
    expect(body.currentUserRequirement.required).toBe(true);
    // The requirement is evaluated against the actor's PERSISTED role.
    expect(callInput("evaluateMfaRequirement")).toMatchObject({ teamId: TEAM, role: "ADMIN" });
  });

  it("GET policy permission denial → 403 without reading the policy", async () => {
    H.accessAllowed = false;
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/mfa-policy?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
    expect(called("getMfaPolicy")).toHaveLength(0);
  });

  it("PUT policy calls the canonical writer once with the SERVER-derived actor", async () => {
    const res = await app.inject({
      method: "PUT", url: "/v1/identity-security/mfa-policy", headers: STEP_UP,
      payload: { teamId: TEAM, level: "ALL_MEMBERS", stepUpTtlSeconds: 600, trustedDeviceTtlDays: 14 },
    });
    expect(res.statusCode).toBe(200);
    expect(called("updateMfaPolicy")).toHaveLength(1);
    expect(callInput("updateMfaPolicy")).toMatchObject({
      teamId: TEAM, level: "ALL_MEMBERS", actorUserId: ACTOR,
    });
    expect(JSON.parse(res.body).policy.level).toBe("ALL_MEMBERS");
  });

  it("PUT policy step-up denial → 401 with ZERO policy write", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "PUT", url: "/v1/identity-security/mfa-policy",
      payload: { teamId: TEAM, level: "ALL_MEMBERS" },
    });
    expect(res.statusCode).toBe(401);
    expect(called("updateMfaPolicy")).toHaveLength(0);
    expect(callInput("requireStepUpForSensitiveAction")).toMatchObject({
      purpose: "MFA_POLICY_UPDATE", resourceKind: "organization_security_policy", resourceId: TEAM,
    });
  });

  it("PUT policy permission denial → 403 with ZERO policy write and no step-up spent", async () => {
    H.accessAllowed = false;
    const res = await app.inject({
      method: "PUT", url: "/v1/identity-security/mfa-policy", headers: STEP_UP,
      payload: { teamId: TEAM, level: "ALL_MEMBERS" },
    });
    expect(res.statusCode).toBe(403);
    expect(called("updateMfaPolicy")).toHaveLength(0);
    expect(called("requireStepUpForSensitiveAction")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 7 — Risk posture (self view vs operator view).
// ===========================================================================

describe("risk posture", () => {
  it("risk/me is SELF-ONLY and conceals which signals fired", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/risk/me?teamId=${TEAM}&userId=${OTHER}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ level: "MEDIUM", score: 35, signalCount: 1 });
    // The snapshot was computed for the SESSION subject, not the declared one.
    expect(callInput("getRiskSnapshotForUser")).toMatchObject({ teamId: TEAM, userId: ACTOR });
    // Signal kinds/reasons are withheld from the self surface.
    expect(res.body).not.toContain("NEW_DEVICE");
    expect(res.body).not.toContain("First sign-in");
  });

  it("risk/me permission denial → 403 with no snapshot computed", async () => {
    H.accessAllowed = false;
    const res = await app.inject({ method: "GET", url: `/v1/identity-security/risk/me?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
    expect(called("getRiskSnapshotForUser")).toHaveLength(0);
  });

  it("risk/user/:id is operator-visible for an ACTIVE member of the SAME workspace", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/risk/user/${OTHER}?teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    const snapshot = JSON.parse(res.body).snapshot;
    expect(snapshot).toMatchObject({ userId: OTHER, level: "MEDIUM", score: 35 });
    expect(snapshot.signals[0].kind).toBe("NEW_DEVICE");
    expect(callInput("getRiskSnapshotForUser")).toMatchObject({ userId: OTHER });
  });

  it("risk/user/:id for a non-member is concealed as 404 with no snapshot computed", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/risk/user/${OUTSIDER}?teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(404);
    expect(called("getRiskSnapshotForUser")).toHaveLength(0);
  });

  it("risk/user/:id unauthorized → concealed 404 with no snapshot computed", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/risk/user/${OTHER}?teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(404);
    expect(called("getRiskSnapshotForUser")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 8 — Password change (account tier, rate-limited, self-only).
// ===========================================================================

describe("self-service password change", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    currentPassword: "Old-Password-1", newPassword: "Brand-New-Password-9", ...extra,
  });

  it("SELF-ONLY: the change is applied to the session subject, never a declared one", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/password", payload: body({ userId: OTHER }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, revokedOtherSessions: 0 });
    expect(called("changePasswordForUser")).toHaveLength(1);
    expect(callInput("changePasswordForUser").userId).toBe(ACTOR);
    // Both rate-limit buckets are keyed on the derived subject.
    expect(String(called("enforceRateLimit")[0]?.input.key)).toContain(ACTOR);
  });

  it("optional fan-out revokes every OTHER session and PRESERVES the current one", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/password",
      payload: body({ revokeOtherSessions: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revokedOtherSessions).toBe(1);
    expect(sessionRow(CUR_SESSION).revokedAtUtc).toBeNull();
    expect(sessionRow(OTHER_SESSION).revokedReason).toBe("PASSWORD_CHANGED");
    expect(sessionRow(FOREIGN_SESSION).revokedAtUtc).toBeNull();
  });

  it("rate limit → 429 and the password service is NEVER reached", async () => {
    H.rateLimitAllowed = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/password", payload: body(),
    });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error.code).toBe("rate_limited");
    expect(called("changePasswordForUser")).toHaveLength(0);
  });

  it("a policy-non-compliant new password is refused BEFORE the scrypt round-trip", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/password",
      payload: body({ newPassword: "alllowercaseonly" }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("weak_new_password");
    expect(called("changePasswordForUser")).toHaveLength(0);
  });

  it("wrong current password and unknown user return the SAME body (no oracle)", async () => {
    H.passwordChange = { ok: false, reason: "current_password_mismatch" };
    const mismatch = await app.inject({
      method: "POST", url: "/v1/identity-security/password", payload: body(),
    });
    H.passwordChange = { ok: false, reason: "user_not_found" };
    const missing = await app.inject({
      method: "POST", url: "/v1/identity-security/password", payload: body(),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(missing.statusCode).toBe(mismatch.statusCode);
    expect(missing.body).toBe(mismatch.body);
    expect(JSON.parse(mismatch.body).error.code).toBe("current_password_invalid");
  });

  it("an SSO-only account gets the bounded unsupported code, and no session fan-out runs", async () => {
    H.passwordChange = { ok: false, reason: "not_email_user" };
    const res = await app.inject({
      method: "POST", url: "/v1/identity-security/password",
      payload: body({ revokeOtherSessions: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("sso_user_password_unsupported");
    expect(called("db.authenticatedSession.updateMany")).toHaveLength(0);
    expect(sessionRow(OTHER_SESSION).revokedAtUtc).toBeNull();
  });
});

// ===========================================================================
// PRODUCT SYSTEM 9 — Security-events feed (bounded, self-only window).
// ===========================================================================

describe("self-service security events", () => {
  it("SELF-ONLY: returns the caller's security-category events with truncated previews", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/identity-security/security-events?userId=${OTHER}`,
    });
    expect(res.statusCode).toBe(200);
    const events = JSON.parse(res.body).events as Array<Record<string, unknown>>;
    // al-2 (evidence.*) is out of category; al-3 belongs to another account.
    expect(events.map((e) => e.id)).toEqual(["al-1"]);
    expect(events[0]).toMatchObject({ action: "identity_security.password_change" });
    expect(String(events[0]?.ipPreview).length).toBeLessThanOrEqual(16);
    expect(String(events[0]?.uaPreview).length).toBeLessThanOrEqual(80);
    expect((callInput("db.adminAuditLog.findMany").where as Record<string, unknown>).userId).toBe(ACTOR);
  });

  it("the window is bounded by an explicit limit", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/identity-security/security-events?limit=1" });
    expect(res.statusCode).toBe(200);
    expect(callInput("db.adminAuditLog.findMany").take).toBe(1);
  });

  it("another account reads an empty feed rather than someone else's timeline", async () => {
    H.actorUserId = OUTSIDER;
    const res = await app.inject({ method: "GET", url: "/v1/identity-security/security-events" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).events).toEqual([]);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 10 — MFA enrolment + factor lifecycle (mfa.routes.ts).
// ===========================================================================

describe("MFA enrolment and factor lifecycle", () => {
  it("GET factors projects the REAL status with no secret material", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/identity/mfa/factors" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasMfa).toBe(true);
    expect(body.factors.map((f: { id: string }) => f.id).sort())
      .toEqual([FACTOR_ACTIVE, FACTOR_ENROLLING].sort());
    expect(body.recoveryCodesRemaining).toBe(2);
    for (const seedValue of ["TOTP-CIPHERTEXT-SEED", "TOTP-IV-SEED", "TOTP-AUTHTAG-SEED", "RECOVERY-CODE-SEED"]) {
      expect(res.body).not.toContain(seedValue);
    }
  });

  it("SELF-ONLY: GET factors is keyed on the session subject", async () => {
    H.actorUserId = OUTSIDER;
    const res = await app.inject({ method: "GET", url: "/v1/identity/mfa/factors" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ hasMfa: false, factors: [], recoveryCodesRemaining: 0 });
  });

  it("enroll/start begins enrolment for the SESSION subject, not a declared one", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/enroll/start",
      payload: { label: "Work phone", userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(called("beginTotpEnrollment")).toHaveLength(1);
    expect(callInput("beginTotpEnrollment")).toMatchObject({ userId: ACTOR, label: "Work phone" });
    // The account name is resolved server-side from the caller's own record.
    expect(callInput("beginTotpEnrollment").accountName).toBe("actor@example.com");
  });

  it("enroll/verify activates the factor and returns recovery codes exactly once", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/enroll/verify",
      payload: { factorId: FACTOR_ENROLLING, code: "123456", userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).recoveryCodes).toEqual(["AAAA-1111-BBBB"]);
    expect(callInput("verifyAndActivateEnrollment")).toMatchObject({
      userId: ACTOR, factorId: FACTOR_ENROLLING, code: "123456",
    });
  });

  it("enroll/verify with a bad code is a bounded 400 and activates nothing", async () => {
    H.enrollVerifyOk = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/enroll/verify",
      payload: { factorId: FACTOR_ENROLLING, code: "000000" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "code_invalid" });
  });

  it("enroll/verify is brute-force bounded per account (429 after the window budget)", async () => {
    H.actorUserId = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"; // fresh limiter bucket
    H.enrollVerifyOk = false;
    let last = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await app.inject({
        method: "POST", url: "/v1/identity/mfa/enroll/verify",
        payload: { factorId: FACTOR_ENROLLING, code: "000000" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it("cancelling my own ENROLLING factor needs no step-up and revokes it", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/mfa/factors/${FACTOR_ENROLLING}`,
      headers: { "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(called("verifyAccountStepUp")).toHaveLength(0);
    expect(callInput("revokeFactor")).toMatchObject({ userId: ACTOR, factorId: FACTOR_ENROLLING });
  });

  it("removing an ACTIVE factor is step-up gated → 401 with ZERO revocation", async () => {
    H.accountStepUpOk = false;
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/mfa/factors/${FACTOR_ACTIVE}`,
      headers: { "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(called("revokeFactor")).toHaveLength(0);
    expect(callInput("verifyAccountStepUp")).toMatchObject({ userId: ACTOR, action: "mfa_factor_remove" });
  });

  it("SELF-ONLY: another account's factor id is a 404 and is never revoked", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/mfa/factors/${FOREIGN_FACTOR}`,
      headers: { "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "factor_not_found" });
    expect(called("revokeFactor")).toHaveLength(0);
    expect(called("verifyAccountStepUp")).toHaveLength(0);
  });

  it("recovery-code regeneration is step-up gated → 401 with ZERO regeneration", async () => {
    H.accountStepUpOk = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/recovery-codes/regenerate", payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(called("regenerateRecoveryBatch")).toHaveLength(0);
  });

  it("recovery-code regeneration returns a fresh batch for the SESSION subject", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/recovery-codes/regenerate", payload: { userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).recoveryCodes).toEqual(["CCCC-2222-DDDD"]);
    expect(callInput("regenerateRecoveryBatch").userId).toBe(ACTOR);
  });

  it("challenge/verify accepts a TOTP code for the SESSION subject", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/challenge/verify",
      payload: { code: "123456", userId: OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, used: "totp", factorId: FACTOR_ACTIVE });
    expect(callInput("verifyActiveTotp").userId).toBe(ACTOR);
  });

  it("challenge/verify accepts a recovery code and never echoes it back", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/challenge/verify",
      payload: { recoveryCode: "AAAA-1111-BBBB" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, used: "recovery_code" });
    expect(res.body).not.toContain("AAAA-1111-BBBB");
    expect(callInput("consumeRecoveryCode").userId).toBe(ACTOR);
  });

  it("challenge/verify failures are bounded and reveal no factor detail", async () => {
    H.totpOk = false;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/mfa/challenge/verify", payload: { code: "000000" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "code_invalid" });
    expect(res.body).not.toContain(FACTOR_ACTIVE);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 11 — Personal identity links (login methods).
// ===========================================================================

describe("personal identity links", () => {
  const stepUpProof = { stepUp: { method: "password", currentPassword: "Old-Password-1" } };

  it("SELF-ONLY: the login-method list is keyed on the session subject", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/identity/links?userId=${OTHER}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.links.map((l: { id: string }) => l.id)).toEqual([LINK_A]);
    expect(body.passwordConfigured).toBe(true);
    expect(body.usableMethods).toBe(2);
    expect((callInput("db.userIdentityLink.findMany").where as Record<string, unknown>).userId).toBe(ACTOR);
    // Neither the provider subject nor the password hash reaches the client.
    expect(res.body).not.toContain("GOOGLE-SUBJECT-SEED");
    expect(res.body).not.toContain("PASSWORD-HASH-SEED");
  });

  const LINK_PROVIDERS = [
    { name: "google", url: "/v1/identity/links/google", verifier: "verifyGOOGLEIdToken", subject: "GOOGLE-SUBJECT-SEED" },
    { name: "apple", url: "/v1/identity/links/apple", verifier: "verifyAPPLEIdToken", subject: "APPLE-SUBJECT-SEED" },
  ] as const;

  for (const p of LINK_PROVIDERS) {
    it(`link ${p.name}: the PROVIDER TOKEN is verified server-side and bound to the session subject`, async () => {
      const res = await app.inject({
        method: "POST", url: p.url,
        payload: { idToken: "provider-id-token-value", userId: OTHER, ...stepUpProof },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).linked).toBe(true);
      expect(called(p.verifier)).toHaveLength(1);
      expect(callInput(p.verifier).idToken).toBe("provider-id-token-value");
      const upsert = callInput("db.userIdentityLink.upsert");
      expect((upsert.create as Record<string, unknown> | undefined)?.userId ?? ACTOR).toBe(ACTOR);
      // The projection returns the link handle only — never the subject id.
      expect(res.body).not.toContain(p.subject);
    });

    it(`link ${p.name}: step-up denial → 401 with ZERO link write and no token verification`, async () => {
      H.accountStepUpOk = false;
      const res = await app.inject({
        method: "POST", url: p.url, payload: { idToken: "provider-id-token-value" },
      });
      expect(res.statusCode).toBe(401);
      expect(called("db.userIdentityLink.upsert")).toHaveLength(0);
      expect(called(p.verifier)).toHaveLength(0);
    });

    it(`link ${p.name}: an unverifiable provider token → 400 with ZERO link write`, async () => {
      H.idTokenValid = false;
      const res = await app.inject({
        method: "POST", url: p.url, payload: { idToken: "forged-id-token-value", ...stepUpProof },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("invalid_id_token");
      expect(called("db.userIdentityLink.upsert")).toHaveLength(0);
    });
  }

  it("ANTI-TAKEOVER: an identity already owned elsewhere → 409, no merge, no write", async () => {
    // Re-point the foreign ACTIVE link at the subject the verifier returns.
    linkRow(FOREIGN_LINK).providerSubjectId = "APPLE-SUBJECT-SEED";
    const res = await app.inject({
      method: "POST", url: "/v1/identity/links/apple",
      payload: { idToken: "provider-id-token-value", ...stepUpProof },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("identity_already_linked");
    expect(called("db.userIdentityLink.upsert")).toHaveLength(0);
    expect(linkRow(FOREIGN_LINK).userId).toBe(OTHER);
  });

  it("adding a password to an OAuth-only account stores a HASH, never the plaintext", async () => {
    H.table("user")[0].passwordHash = null;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/password",
      payload: { newPassword: "Fresh-Password-42", userId: OTHER, ...stepUpProof },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ passwordConfigured: true });
    const update = callInput("db.user.update");
    expect((update.where as Record<string, unknown>).id).toBe(ACTOR); // SELF-ONLY
    const stored = String((update.data as Record<string, unknown>).passwordHash);
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain("Fresh-Password-42");
    expect(res.body).not.toContain("Fresh-Password-42");
  });

  it("password add is refused when one already exists (change is the other route)", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/password",
      payload: { newPassword: "Fresh-Password-42", ...stepUpProof },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("password_already_set");
    expect(called("db.user.update")).toHaveLength(0);
  });

  it("password add refuses a non-compliant password with ZERO write", async () => {
    H.table("user")[0].passwordHash = null;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/password",
      payload: { newPassword: "tooweak", ...stepUpProof },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("weak_new_password");
    expect(called("db.user.update")).toHaveLength(0);
  });

  it("password add step-up denial → 401 with ZERO write", async () => {
    H.accountStepUpOk = false;
    H.table("user")[0].passwordHash = null;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/password", payload: { newPassword: "Fresh-Password-42" },
    });
    expect(res.statusCode).toBe(401);
    expect(called("db.user.update")).toHaveLength(0);
  });

  it("unlink REVOKES my own link (rows are never erased)", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/links/${LINK_A}`,
      headers: { "content-type": "application/json" }, payload: stepUpProof,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ unlinked: true });
    expect(linkRow(LINK_A).status).toBe("REVOKED");
    expect(linkRow(LINK_A).revokedAtUtc).not.toBeNull();
  });

  it("LAST-METHOD PROTECTION: the only usable login method cannot be unlinked", async () => {
    H.table("user")[0].passwordHash = null;
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/links/${LINK_A}`,
      headers: { "content-type": "application/json" }, payload: stepUpProof,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("last_login_method_protected");
    expect(linkRow(LINK_A).status).toBe("ACTIVE");
  });

  it("SELF-ONLY: another account's link id is a 404 and stays ACTIVE", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/links/${FOREIGN_LINK}`,
      headers: { "content-type": "application/json" }, payload: stepUpProof,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("link_not_found");
    expect(linkRow(FOREIGN_LINK).status).toBe("ACTIVE");
  });

  it("unlink step-up denial → 401 with ZERO revocation", async () => {
    H.accountStepUpOk = false;
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/links/${LINK_A}`,
      headers: { "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(linkRow(LINK_A).status).toBe("ACTIVE");
    expect(called("db.userIdentityLink.update")).toHaveLength(0);
  });
});

// ===========================================================================
// PRODUCT SYSTEM 12 — Contributor sessions + external identity mappings
// (identity.routes.ts: the workspace-scoped session / link authorities).
// ===========================================================================

describe("contributor session and external identity authorities", () => {
  it("contributor-session revoke derives the workspace from the TARGET row", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity/contributor-sessions/${INTAKE_SESSION}/revoke`,
      headers: STEP_UP, payload: { teamId: TEAM, reason: "contributor left" },
    });
    expect(res.statusCode).toBe(200);
    expect(called("revokeContributorSession")).toHaveLength(1);
    expect(callInput("revokeContributorSession")).toMatchObject({
      teamId: TEAM, intakeSessionId: INTAKE_SESSION, actorUserId: ACTOR,
    });
    expect(callInput("requireStepUpForSensitiveAction")).toMatchObject({
      purpose: "CONTRIBUTOR_SESSION_REVOKE", resourceId: INTAKE_SESSION,
    });
  });

  it("a declared workspace that disagrees with the target row → concealed 404, ZERO revocation", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/identity/contributor-sessions/${INTAKE_SESSION}/revoke`,
      headers: STEP_UP, payload: { teamId: OTHER_TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(called("revokeContributorSession")).toHaveLength(0);
  });

  it("an already-revoked contributor session is a bounded 409 and spends no step-up", async () => {
    (H.table("workflowIntakeSession")[0] as Record<string, unknown>).revokedAtUtc = new Date();
    const res = await app.inject({
      method: "POST", url: `/v1/identity/contributor-sessions/${INTAKE_SESSION}/revoke`,
      headers: STEP_UP, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("session_already_revoked");
    expect(called("requireStepUpForSensitiveAction")).toHaveLength(0);
    expect(called("revokeContributorSession")).toHaveLength(0);
  });

  it("contributor-session revoke step-up denial → 401 with ZERO revocation", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST", url: `/v1/identity/contributor-sessions/${INTAKE_SESSION}/revoke`,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(401);
    expect(called("revokeContributorSession")).toHaveLength(0);
  });

  it("contributor-session revoke unauthorized → concealed 404 with ZERO revocation", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "POST", url: `/v1/identity/contributor-sessions/${INTAKE_SESSION}/revoke`,
      headers: STEP_UP, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(called("revokeContributorSession")).toHaveLength(0);
  });

  it("external-mapping link runs on the SERVER-derived workspace rail", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/identity/external-mappings", headers: STEP_UP,
      payload: { userId: OTHER, provider: "GENERIC_SAML", externalSubjectId: "saml-subject-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(called("linkExternalIdentity")).toHaveLength(1);
    // TEAM comes from User.currentWorkspaceId, not from the request body.
    expect(callInput("linkExternalIdentity")).toMatchObject({
      teamId: TEAM, userId: OTHER, actorUserId: ACTOR,
    });
  });

  it("external-mapping link refuses a SCIM/SSO-managed identity with ZERO write", async () => {
    H.managedIdentityState = "MANAGED";
    const res = await app.inject({
      method: "POST", url: "/v1/identity/external-mappings", headers: STEP_UP,
      payload: { userId: OTHER, provider: "GENERIC_SAML", externalSubjectId: "saml-subject-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("managed_identity_readonly");
    expect(called("linkExternalIdentity")).toHaveLength(0);
  });

  it("external-mapping link step-up denial → 401 with ZERO write", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST", url: "/v1/identity/external-mappings",
      payload: { userId: OTHER, provider: "GENERIC_SAML", externalSubjectId: "saml-subject-1" },
    });
    expect(res.statusCode).toBe(401);
    expect(called("linkExternalIdentity")).toHaveLength(0);
  });

  it("external-mapping unlink derives the workspace from the TARGET mapping row", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/external-mappings/${MAPPING}`,
      headers: { ...STEP_UP, "content-type": "application/json" }, payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    expect(callInput("unlinkExternalIdentity")).toMatchObject({
      teamId: TEAM, mappingId: MAPPING, actorUserId: ACTOR,
    });
  });

  it("external-mapping unlink with a mismatched declared workspace → concealed 404, ZERO write", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/external-mappings/${MAPPING}`,
      headers: { ...STEP_UP, "content-type": "application/json" }, payload: { teamId: OTHER_TEAM },
    });
    expect(res.statusCode).toBe(404);
    expect(called("unlinkExternalIdentity")).toHaveLength(0);
  });

  it("external-mapping unlink unauthorized → concealed 404 with ZERO write", async () => {
    H.authorizeAllowed = false;
    const res = await app.inject({
      method: "DELETE", url: `/v1/identity/external-mappings/${MAPPING}`,
      headers: { ...STEP_UP, "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(called("unlinkExternalIdentity")).toHaveLength(0);
  });
});

// ===========================================================================
// CROSS-CUTTING — secret-free projections on POPULATED responses.
//
// Every seeded row carries a canary in each column a projection must drop.
// The assertion runs against the RAW body string, so a widened `select`, a
// spread row, or a re-added hash field fails here.
// ===========================================================================

describe("secret-free projections (raw body sweep)", () => {
  const CANARIES = [
    "SESSION-TOKEN-SEED", "REVOKED-HASH-SEED", "DEVICE-HASH-SEED", "IP-HASH-SEED",
    "GOOGLE-SUBJECT-SEED", "APPLE-OTHER-SEED", "PASSWORD-HASH-SEED",
    "OTHER-PASSWORD-HASH-SEED", "RECOVERY-CODE-SEED",
    "TOTP-CIPHERTEXT-SEED", "TOTP-IV-SEED", "TOTP-AUTHTAG-SEED",
  ];
  const FORBIDDEN_KEYS = [
    "sessionIdHash", "sessionToken", "secretCiphertext", "secretIv", "secretAuthTag",
    "secretKekId", "deviceIdHash", "ipHash", "passwordHash", "providerSubjectId",
    "codeHash", `"recoveryCodes"`,
  ];

  const POPULATED_READS = [
    { name: "my sessions", url: "/v1/identity-security/my-sessions", collection: "sessions" },
    { name: "workspace revocations", url: `/v1/identity-security/sessions?teamId=${TEAM}`, collection: "revoked" },
    { name: "trusted devices", url: `/v1/identity-security/devices?teamId=${TEAM}`, collection: "devices" },
    { name: "security events", url: "/v1/identity-security/security-events", collection: "events" },
    { name: "mfa factors", url: "/v1/identity/mfa/factors", collection: "factors" },
    { name: "login methods", url: "/v1/identity/links", collection: "links" },
  ] as const;

  for (const read of POPULATED_READS) {
    it(`${read.name}: populated response carries no secret material`, async () => {
      const res = await app.inject({ method: "GET", url: read.url });
      expect(res.statusCode).toBe(200);
      // The projection is genuinely populated — an empty list proves nothing.
      const rows = JSON.parse(res.body)[read.collection] as unknown[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const canary of CANARIES) expect(res.body).not.toContain(canary);
      for (const key of FORBIDDEN_KEYS) expect(res.body).not.toContain(key);
      expect(res.body).not.toContain(CURRENT_HASH);
      expect(res.body).not.toContain(OTHER_HASH);
      expect(res.body).not.toContain(FOREIGN_HASH);
    });
  }
});
