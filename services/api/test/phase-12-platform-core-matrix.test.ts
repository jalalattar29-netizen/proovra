/**
 * PHASE 12 — VERTICAL A (PLATFORM_CORE) production-route matrix.
 *
 * Behavioral tests driven through the REAL route handlers with fastify
 * `inject`. Only process boundaries (auth, db, provider services, the
 * canonical authorization/legal middlewares) are mocked — every gate,
 * projection and denial branch under test is the shipped handler code.
 *
 * Systems covered (one file, grouped by PRODUCT SYSTEM — not one file or
 * one describe per route):
 *
 *   1. Billing entitlement + payment ledger  (billing.routes.ts)
 *   2. Legal acceptance status               (users.routes.ts)
 *   3. Workspace communications              (communications.routes.ts)
 *   4. Presence                              (presence.routes.ts)
 *   5. Platform catalogs (rbac + collab)     (teams.routes.ts, collaboration.routes.ts)
 *   6. Platform audit export                 (admin-audit.routes.ts)
 *
 * NOTE ON `expectedVersion`: no operation in this vertical mutates versioned
 * state (there is no optimistic-concurrency field on Payment, Entitlement,
 * CommunicationPreference or VerificationAttempt), so there is no stale-version
 * branch to drive. The equivalent safety property that DOES apply here —
 * "a retry converges instead of duplicating" — is asserted explicitly as the
 * idempotent-retry case in system 1.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const IDS = vi.hoisted(() => ({
  TEAM_A: "11111111-1111-4111-8111-111111111111",
  TEAM_B: "22222222-2222-4222-8222-222222222222",
  TEAM_UNKNOWN: "33333333-3333-4333-8333-333333333333",
  OTHER_USER: "99999999-9999-4999-8999-999999999999",
  MEMBER_USER: "88888888-8888-4888-8888-888888888888",
}));

const { TEAM_A, TEAM_B, TEAM_UNKNOWN, OTHER_USER, MEMBER_USER } = IDS;

const H = vi.hoisted(() => ({
  /** Session subject. Every handler must derive its subject from THIS. */
  actorUserId: "user-1",
  authenticated: true,
  legalOk: true,
  platformAdmin: true,
  devAuth: true,

  /** Canonical authorize verdict (drives presence + communications). */
  authorize: {
    allowed: true,
    reason: "permission_not_granted" as string,
    httpStatus: 403 as 401 | 403 | 404 | 503,
    /** Records every (teamId, permission) the canonical gate was asked. */
    seen: [] as Array<{ teamId: string | null | undefined; permission: string }>,
  },

  /** Membership rows (communications 404-on-non-member pre-check). */
  members: new Set<string>([
    `${IDS.TEAM_A}:user-1`,
    `${IDS.TEAM_A}:${IDS.MEMBER_USER}`,
  ]),

  /** Owned-workspace ownership. */
  teamOwner: new Map<string, string>([
    [IDS.TEAM_A, "user-1"],
    [IDS.TEAM_B, IDS.OTHER_USER],
  ]),

  /** Commercial state the server reports for the session subject. */
  plan: "FREE" as "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE",
  credits: 0,
  ownedTeamIds: [] as string[],

  /** Personal-space allowance (managed enterprise identity == false). */
  personalSpaceAllowed: true,

  /** Approved verification ledger for (teamId, phone). */
  approvedVerifications: new Set<string>(),

  /** Payment ledger rows returned by the db stub. */
  payments: [] as Array<Record<string, unknown>>,
  /** Captured `where` of the last payment query — proves subject derivation. */
  paymentWhere: null as Record<string, unknown> | null,

  /** Rate-limit verdict for the audit export. */
  rateLimitAllowed: true,

  /** Admin audit rows. */
  auditRows: [] as Array<Record<string, unknown>>,

  /** Every state-changing service call, in order. */
  writes: [] as string[],
  /** Every read that must NOT happen on a denied request. */
  reads: [] as string[],
  /** Emitted audit actions. */
  audits: [] as string[],
}));

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: (req: { user?: { sub?: string } }) => {
    if (!H.authenticated) throw new Error("unauthenticated");
    return req.user?.sub ?? H.actorUserId;
  },
  getAuthSessionId: () => "session-hash-1",
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (
    req: { user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (!H.authenticated) {
      // Fastify short-circuits the preHandler chain once a reply is sent;
      // `reply.sent` flips on its own (it is read-only).
      reply.code(401).send({ error: { code: "unauthenticated" } });
      return;
    }
    req.user = { sub: H.actorUserId, platformRole: H.platformAdmin ? "admin" : null };
  },
}));

vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (H.legalOk) return;
    reply.code(428).send({ error: { code: "LEGAL_REACCEPT_REQUIRED" } });
  },
}));

vi.mock("../src/services/platform-admin.service.js", () => ({
  isPlatformAdmin: async () => H.platformAdmin,
}));

// THE canonical authorization primitive. Presence and communications must
// route their permission decision through it (never a private evaluator).
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    options: { teamId?: string | null; permission: string; antiEnumeration?: boolean },
  ) => {
    H.authorize.seen.push({ teamId: options.teamId, permission: options.permission });
    if (H.authorize.allowed) {
      return { actorUserId: H.actorUserId, teamId: options.teamId as string };
    }
    const status = H.authorize.httpStatus;
    if (status === 404) {
      reply.code(404).send({ error: { code: "not_found" } });
    } else if (status === 401) {
      reply.code(401).send({ error: { code: "unauthenticated" } });
    } else if (status === 503) {
      reply.code(503).send({ error: { code: "authorization_unavailable" } });
    } else {
      reply
        .code(403)
        .send({ error: { code: "permission_denied", reason: H.authorize.reason } });
    }
    return null;
  },
  requireAuthorize: () => async () => {},
  evaluateAuthorize: async () => ({ allowed: true }),
  AUTHORIZATION_DENIAL_CODES: [],
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    payment: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        H.reads.push("payment.findMany");
        H.paymentWhere = args.where;
        return H.payments;
      },
    },
    team: {
      findUnique: async (args: { where: { id: string } }) => {
        const owner = H.teamOwner.get(args.where.id);
        if (!owner) return null;
        return { id: args.where.id, ownerUserId: owner, name: "Workspace" };
      },
      findMany: async () => [],
    },
    teamMember: {
      findUnique: async (args: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
        const { teamId, userId } = args.where.teamId_userId;
        return H.members.has(`${teamId}:${userId}`) ? { id: "tm-1" } : null;
      },
    },
    verificationAttempt: {
      findFirst: async (args: { where: { teamId: string } }) => {
        H.reads.push("verificationAttempt.findFirst");
        return H.approvedVerifications.has(args.where.teamId)
          ? { id: "va-1", approvedAtUtc: new Date() }
          : null;
      },
    },
    subscription: { findFirst: async () => null, findMany: async () => [], update: async () => ({}) },
    workspaceStorageAddon: {
      findMany: async () => [],
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    user: {
      findUnique: async () => ({
        id: H.actorUserId,
        displayName: "Ada",
        email: "ada@example.com",
      }),
      update: async () => ({ id: H.actorUserId }),
    },
    userLegalAcceptance: { findMany: async () => [] },
    cookieConsentRecord: { findFirst: async () => null, create: async () => ({}) },
    communicationMessage: { findMany: async () => [], findFirst: async () => null, update: async () => ({}) },
  },
}));

// ---------------------------------------------------------------------------
// Billing seams
// ---------------------------------------------------------------------------

vi.mock("../src/dev/dev-login.js", () => ({ devAuthEnabled: () => H.devAuth }));

function overview() {
  return {
    entitlement: { plan: H.plan, credits: H.credits, teamSeats: 1 },
    summary: { personalPlan: H.plan },
    workspaces: {
      personal: { workspaceType: "PERSONAL", plan: H.plan },
      teams: H.ownedTeamIds.map((id) => ({ id, name: "Workspace", plan: "TEAM" })),
    },
    payments: [],
    paymentMethods: {},
    storageAddons: { all: [], active: [] },
  };
}

vi.mock("../src/services/billing-overview.service.js", () => ({
  readBillingOverview: async (userId: string) => {
    H.reads.push(`readBillingOverview:${userId}`);
    return overview();
  },
}));

vi.mock("../src/services/billing.service.js", () => ({
  setPersonalPlan: async (userId: string, plan: string) => {
    H.writes.push(`setPersonalPlan:${userId}:${plan}`);
    H.plan = plan as typeof H.plan;
  },
  activateTeamPlan: async (i: { teamId: string; ownerUserId: string; plan: string }) => {
    // The OWNED workspace persists its OWN commercial state — the write is
    // keyed by teamId and carries the workspace's plan, never the owner's.
    H.writes.push(`activateTeamPlan:${i.teamId}:${i.plan}`);
    if (!H.ownedTeamIds.includes(i.teamId)) H.ownedTeamIds.push(i.teamId);
  },
  cancelTeamPlan: async (i: { teamId: string }) => {
    H.writes.push(`cancelTeamPlan:${i.teamId}`);
  },
  cancelWorkspaceStorageAddon: async () => ({ id: "a-1" }),
  getStorageAddonDefinition: () => ({
    workspaceType: "PERSONAL",
    priceCents: 100,
    currency: "USD",
  }),
}));

vi.mock("../src/services/billing/commercial-context.service.js", () => ({
  resolveCommercialContext: async () => ({ scope: { plan: H.plan } }),
}));

vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  assertPersonalSpaceAllowed: async () => {
    if (H.personalSpaceAllowed) return;
    const e = new Error("no personal space") as Error & { statusCode: number; code: string };
    e.statusCode = 403;
    e.code = "MANAGED_IDENTITY_NO_PERSONAL_SPACE";
    throw e;
  },
}));

vi.mock("../src/services/paypal.service.js", () => ({ cancelPayPalSubscription: async () => {} }));
vi.mock("../src/services/stripe.service.js", () => ({ stripeRequestRaw: async () => ({}) }));
vi.mock("../src/services/billing-checkout.service.js", () => ({
  createStripeCheckoutSession: async () => ({ session: { id: "cs_1" }, mode: "subscription", amountCents: 0, currency: "USD" }),
  createPayPalCheckout: async () => ({ order: { id: "o_1" }, mode: "order", amountCents: 0, currency: "USD" }),
  createStripeStorageAddonCheckoutSession: async () => ({ session: { id: "cs_2" }, mode: "payment", amountCents: 0, currency: "USD" }),
  createPayPalStorageAddonCheckout: async () => ({ order: { id: "o_2" }, mode: "order", amountCents: 0, currency: "USD" }),
}));
vi.mock("../src/services/billing-pricing.service.js", () => ({
  buildPricingCatalogResponse: () => ({ storageAddons: [] }),
  resolveCheckoutCurrency: () => "USD",
}));
vi.mock("../src/services/plan-catalog.service.js", () => ({
  getPlanCapabilities: () => ({ allowsTeamWorkspace: true, includedStorageBytes: 0n }),
}));

// ---------------------------------------------------------------------------
// Audit / analytics seams (assert emission, never re-implement)
// ---------------------------------------------------------------------------

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (e: { action: string }) => {
    H.audits.push(e.action);
  },
  emitPlatformAudit: async (e: { action: string }) => {
    H.audits.push(e.action);
  },
  emitAdminManualAudit: async () => {},
}));
vi.mock("../src/services/analytics-event.service.js", () => ({ writeAnalyticsEvent: async () => {} }));
vi.mock("../src/services/security/security-event.service.js", () => ({ safeEmitSecurityEvent: () => {} }));

// ---------------------------------------------------------------------------
// Legal acceptance seam
// ---------------------------------------------------------------------------

vi.mock("../src/services/legal-acceptance.service.js", () => ({
  getUserLegalAcceptanceStatus: async ({ userId }: { userId: string }) => {
    H.reads.push(`legalStatus:${userId}`);
    const missing = H.legalOk ? [] : ["terms"];
    return {
      ok: missing.length === 0,
      requiresReacceptance: missing.length > 0,
      missingPolicies: missing,
      acceptedVersions: H.legalOk ? { terms: "2026-04-06" } : { terms: "2025-01-01" },
      requiredVersions: { terms: "2026-04-06", privacy: "2026-04-06", cookies: "2026-04-06" },
    };
  },
  recordLegalAcceptances: async () => {
    H.writes.push("recordLegalAcceptances");
  },
  assertUserHasRequiredLegalAcceptances: async () => ({ ok: true }),
}));

// ---------------------------------------------------------------------------
// Communications seams
// ---------------------------------------------------------------------------

vi.mock("../src/services/communications/verification.service.js", () => {
  class VerificationError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    VerificationError,
    startVerification: async (i: { teamId: string }) => {
      H.writes.push(`startVerification:${i.teamId}`);
      return {
        status: "started",
        attempt: { id: "va-1", channel: "SMS", status: "PENDING", recipientPreview: "•••0000", checkAttemptCount: 0, createdAt: new Date(), approvedAtUtc: null, expiresAtUtc: new Date() },
      };
    },
    checkVerification: async (i: { teamId: string; code: string }) => {
      H.writes.push(`checkVerification:${i.teamId}`);
      return i.code === "000000"
        ? { status: "approved", attempt: { id: "va-1" } }
        : { status: "denied", attempt: null };
    },
    projectVerificationAttempt: (a: Record<string, unknown>) => ({ id: a.id, recipientPreview: a.recipientPreview }),
  };
});

vi.mock("../src/services/communications/communication-preference.service.js", () => ({
  upsertUserPreference: async (i: { teamId: string }) => {
    H.writes.push(`upsertUserPreference:${i.teamId}`);
    return prefRow(i.teamId, null);
  },
  upsertContactPreference: async (i: { teamId: string }) => {
    H.writes.push(`upsertContactPreference:${i.teamId}`);
    return prefRow(i.teamId, "hash-should-never-be-projected");
  },
  applyInboundOptIn: async () => {},
  applyInboundOptOut: async () => {},
}));

function prefRow(teamId: string, externalContactHash: string | null) {
  return {
    id: "pref-1",
    teamId,
    userId: externalContactHash ? null : MEMBER_USER,
    externalContactHash,
    smsOptOut: false,
    whatsappOptOut: true,
    preferredChannel: "SMS",
    optOutReason: null,
    optOutAtUtc: null,
    updatedAt: new Date(),
  };
}

vi.mock("../src/services/communications/communication.service.js", () => ({
  dispatchPendingMessage: async () => ({ status: "sent" }),
  hashRecipientPhone: (p: string) => `hash:${p}`,
  projectCommunicationMessage: (m: Record<string, unknown>) => ({ id: m.id }),
}));

vi.mock("../src/services/communications/provider-registry.js", () => ({
  buildProviderHealthSnapshot: () => ({ configured: false }),
  getMessagingProvider: () => ({ isConfigured: () => false, verifyWebhookSignature: () => false, parseDeliveryWebhook: () => ({ kind: "ignored" }) }),
}));
vi.mock("../src/middleware/cron-secret.js", () => ({ requireIntegrationCronSecret: async () => false }));

// ---------------------------------------------------------------------------
// Presence seam
// ---------------------------------------------------------------------------

vi.mock("../src/services/presence/presence-selector.js", () => ({
  recordHeartbeatViaSelector: () => {},
  listViewersAsyncViaSelector: async (i: { excludeUserId: string }) => {
    H.reads.push(`listViewers:exclude=${i.excludeUserId}`);
    return [{ userId: MEMBER_USER, displayName: "Grace", lastSeenAtUtc: new Date().toISOString() }];
  },
}));

// ---------------------------------------------------------------------------
// Admin-audit seams
// ---------------------------------------------------------------------------

vi.mock("../src/services/rate-limit.js", () => ({
  enforceRateLimit: async () => ({ allowed: H.rateLimitAllowed }),
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  listAdminAuditLogs: async () => {
    H.reads.push("listAdminAuditLogs");
    return { items: H.auditRows };
  },
  verifyAdminAuditChain: async () => ({ valid: true }),
}));

// ---------------------------------------------------------------------------
// Route modules under test
// ---------------------------------------------------------------------------

import { billingRoutes } from "../src/routes/billing.routes.js";
import { usersRoutes } from "../src/routes/users.routes.js";
import { communicationsRoutes } from "../src/routes/communications.routes.js";
import { presenceRoutes } from "../src/routes/presence.routes.js";
import { collaborationRoutes } from "../src/routes/collaboration.routes.js";
import { adminAuditRoutes } from "../src/routes/admin-audit.routes.js";

const JSON_HEADERS = { "content-type": "application/json" };

function resetState() {
  H.actorUserId = "user-1";
  H.authenticated = true;
  H.legalOk = true;
  H.platformAdmin = true;
  H.devAuth = true;
  H.authorize.allowed = true;
  H.authorize.reason = "permission_not_granted";
  H.authorize.httpStatus = 403;
  H.authorize.seen.length = 0;
  H.members = new Set([`${TEAM_A}:user-1`, `${TEAM_A}:${MEMBER_USER}`]);
  H.plan = "FREE";
  H.credits = 0;
  H.ownedTeamIds = [];
  H.personalSpaceAllowed = true;
  H.approvedVerifications = new Set();
  H.payments = [];
  H.paymentWhere = null;
  H.rateLimitAllowed = true;
  H.auditRows = [];
  H.writes.length = 0;
  H.reads.length = 0;
  H.audits.length = 0;
}

async function buildApp(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await register(app);
  await app.ready();
  return app;
}

// ===========================================================================
// SYSTEM 1 — Billing entitlement + payment ledger
// ===========================================================================

describe("PLATFORM_CORE §1 — billing entitlement + payment ledger", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(billingRoutes);
    });
  });

  const PAYMENT_ROW = {
    id: "pay-1",
    userId: "user-1",
    provider: "STRIPE",
    providerPaymentId: "pi_1",
    amountCents: 1900,
    currency: "USD",
    status: "SUCCEEDED",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    teamId: null,
  };

  it("happy path — GET /v1/billing/payments returns the caller's ledger + audits the read", async () => {
    H.payments = [PAYMENT_ROW];
    const res = await app.inject({ method: "GET", url: "/v1/billing/payments" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.limit).toBe(20);
    expect(H.audits).toContain("billing.payments_list");
  });

  it("safe projection — the ledger NEVER echoes the raw row (no userId, no unknown columns)", async () => {
    H.payments = [{ ...PAYMENT_ROW, secretInternalColumn: "leak" }];
    const res = await app.inject({ method: "GET", url: "/v1/billing/payments" });
    const item = JSON.parse(res.body).items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "amountCents",
        "createdAt",
        "currency",
        "id",
        "provider",
        "providerPaymentId",
        "status",
        "teamId",
      ].sort(),
    );
    expect(item).not.toHaveProperty("userId");
    expect(item).not.toHaveProperty("secretInternalColumn");
  });

  it("SERVER-derived subject — a client-declared userId/teamId cannot widen the query", async () => {
    H.payments = [PAYMENT_ROW];
    const res = await app.inject({
      method: "GET",
      url: `/v1/billing/payments?userId=${OTHER_USER}&teamId=${TEAM_B}`,
    });
    expect(res.statusCode).toBe(200);
    // The query is scoped by the SESSION subject alone.
    expect(H.paymentWhere).toEqual({ userId: "user-1" });
  });

  it("bounded input — an out-of-range limit is rejected, never silently clamped into a wide read", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/billing/payments?limit=5000" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("invalid_query");
    expect(H.reads).not.toContain("payment.findMany");
  });

  it("legal gate — 428 short-circuits the ledger; ZERO reads, ZERO audit", async () => {
    H.legalOk = false;
    const res = await app.inject({ method: "GET", url: "/v1/billing/payments" });
    expect(res.statusCode).toBe(428);
    expect(H.reads).toEqual([]);
    expect(H.audits).toEqual([]);
  });

  it("happy path — POST /v1/billing/restore returns the SERVER's bounded restore verdict", async () => {
    H.plan = "PRO";
    H.credits = 12;
    H.ownedTeamIds = [TEAM_A];
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/restore",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.restore.plan).toBe("PRO");
    expect(body.restore.credits).toBe(12);
    expect(body.restore.ownedWorkspaceCount).toBe(1);
    expect(typeof body.restore.restoredAtUtc).toBe("string");
    expect(H.audits).toContain("billing.restore_entitlement");
  });

  it("idempotent retry — restoring twice converges on the same server truth (no duplicated grant)", async () => {
    H.plan = "PAYG";
    H.credits = 3;
    const first = await app.inject({ method: "POST", url: "/v1/billing/restore", headers: JSON_HEADERS, payload: {} });
    const second = await app.inject({ method: "POST", url: "/v1/billing/restore", headers: JSON_HEADERS, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(first.body).restore.plan).toBe(JSON.parse(second.body).restore.plan);
    expect(JSON.parse(first.body).restore.credits).toBe(JSON.parse(second.body).restore.credits);
    // A restore is a re-read + ensure, never a plan/credit mutation.
    expect(H.writes).toEqual([]);
  });

  it("client-declared plan is ignored — restore reflects only the persisted commercial state", async () => {
    H.plan = "FREE";
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/restore",
      headers: JSON_HEADERS,
      payload: { plan: "ENTERPRISE", credits: 9999, teamId: TEAM_B },
    });
    expect(JSON.parse(res.body).restore.plan).toBe("FREE");
    expect(JSON.parse(res.body).restore.credits).toBe(0);
  });

  it("no-mutation-on-denial — a legal-gated restore never touches entitlement state", async () => {
    H.legalOk = false;
    const res = await app.inject({ method: "POST", url: "/v1/billing/restore", headers: JSON_HEADERS, payload: {} });
    expect(res.statusCode).toBe(428);
    expect(H.writes).toEqual([]);
    expect(H.reads).toEqual([]);
  });
});

// ===========================================================================
// SYSTEM 1b — commercial subject matrix (POST /v1/billing/plan, dev-gated)
// ===========================================================================

describe("PLATFORM_CORE §1b — commercial subject matrix (direct plan mutation)", () => {
  let app: FastifyInstance;

  async function devApp() {
    H.devAuth = true;
    return buildApp(async (a) => {
      await a.register(billingRoutes);
    });
  }

  beforeEach(() => {
    resetState();
  });

  it("PRODUCTION REGISTRATION = 0 — the direct plan mutation does not exist outside the dev boundary", async () => {
    H.devAuth = false;
    const prodApp = await buildApp(async (a) => {
      await a.register(billingRoutes);
    });
    const res = await prodApp.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "PRO" },
    });
    // Not a permanent-403 product surface — the route is simply absent.
    expect(res.statusCode).toBe(404);
    expect(H.writes).toEqual([]);
  });

  it.each(["FREE", "PAYG", "PRO", "ENTERPRISE"] as const)(
    "%s is a PERSONAL/account subject — it can never be pinned to an owned workspace",
    async (plan) => {
      app = await devApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/plan",
        headers: JSON_HEADERS,
        payload: { plan, teamId: TEAM_A },
      });
      expect(res.statusCode).toBe(400);
      expect(H.writes).toEqual([]);
    },
  );

  it.each(["PAYG", "PRO", "ENTERPRISE"] as const)(
    "%s applies to the SESSION's personal account only",
    async (plan) => {
      app = await devApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/plan",
        headers: JSON_HEADERS,
        payload: { plan },
      });
      expect(res.statusCode).toBe(200);
      expect(H.writes).toEqual([`setPersonalPlan:user-1:${plan}`]);
    },
  );

  it("TEAM is a WORKSPACE subject — it is refused without a target workspace", async () => {
    app = await devApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(res.statusCode).toBe(400);
    expect(H.writes).toEqual([]);
  });

  it("cross-account denial — a workspace owned by someone else is refused, ZERO write", async () => {
    app = await devApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM", teamId: TEAM_B },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("unknown workspace — 404 (never a silent personal fallback), ZERO write", async () => {
    app = await devApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM", teamId: TEAM_UNKNOWN },
    });
    expect(res.statusCode).toBe(404);
    expect(H.writes).toEqual([]);
  });

  it("OWNED workspace persists its OWN commercial state — keyed by teamId, never the owner's plan", async () => {
    app = await devApp();
    H.plan = "PRO"; // owner's personal entitlement
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM", teamId: TEAM_A },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toEqual([`activateTeamPlan:${TEAM_A}:TEAM`]);
    // No owner-plan fallback write leaked onto the workspace.
    expect(H.writes.some((w) => w.startsWith("setPersonalPlan"))).toBe(false);
  });

  it("managed identity has NO personal space — a personal plan change fails closed, ZERO write", async () => {
    app = await devApp();
    H.personalSpaceAllowed = false;
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "PRO" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("legal gate — a plan change is refused before any commercial evaluation", async () => {
    app = await devApp();
    H.legalOk = false;
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/plan",
      headers: JSON_HEADERS,
      payload: { plan: "PRO" },
    });
    expect(res.statusCode).toBe(428);
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// SYSTEM 2 — Legal acceptance status
// ===========================================================================

describe("PLATFORM_CORE §2 — legal acceptance status", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(usersRoutes);
    });
  });

  it("happy path — up-to-date account reports ok with no outstanding policies", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/users/legal-status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.requiresReacceptance).toBe(false);
    expect(body.missingPolicies).toEqual([]);
    expect(body.requiredVersions.terms).toBe("2026-04-06");
  });

  it("behind a policy version — the SERVER names what is outstanding and at which version", async () => {
    H.legalOk = false;
    const res = await app.inject({ method: "GET", url: "/v1/users/legal-status" });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.requiresReacceptance).toBe(true);
    expect(body.missingPolicies).toEqual(["terms"]);
    // The accepted-vs-required delta is server-computed, not client-derived.
    expect(body.acceptedVersions.terms).toBe("2025-01-01");
    expect(body.requiredVersions.terms).toBe("2026-04-06");
  });

  it("SERVER-derived subject — a client-declared userId is ignored", async () => {
    await app.inject({ method: "GET", url: `/v1/users/legal-status?userId=${OTHER_USER}` });
    expect(H.reads).toContain("legalStatus:user-1");
    expect(H.reads).not.toContain(`legalStatus:${OTHER_USER}`);
  });

  it("unauthenticated — 401, and the acceptance ledger is never read", async () => {
    H.authenticated = false;
    const res = await app.inject({ method: "GET", url: "/v1/users/legal-status" });
    expect(res.statusCode).toBe(401);
    expect(H.reads).toEqual([]);
  });

  it("acceptance write is recorded through the canonical service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/users/legal-acceptance",
      headers: JSON_HEADERS,
      payload: { source: "settings", acceptances: [{ policyKey: "terms", policyVersion: "2026-04-06" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toContain("recordLegalAcceptances");
  });
});

// ===========================================================================
// SYSTEM 3 — Workspace communications
// ===========================================================================

describe("PLATFORM_CORE §3 — workspace communications", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(communicationsRoutes);
    });
  });

  it("happy path — verify/start issues a code and returns only the SAFE attempt projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/start",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, channel: "SMS", phone: "+447700900000" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("started");
    expect(body.attempt.recipientPreview).toBe("•••0000");
    // The raw phone / OTP never round-trips.
    expect(res.body).not.toContain("+447700900000");
    expect(H.writes).toEqual([`startVerification:${TEAM_A}`]);
  });

  it("cross-workspace denial — a workspace the caller is not in returns 404, ZERO write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/start",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_B, channel: "SMS", phone: "+447700900000" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect(H.writes).toEqual([]);
    // Anti-enumeration happens BEFORE the canonical gate is consulted, so no
    // workspace existence signal leaks through the authorize path either.
    expect(H.authorize.seen).toEqual([]);
  });

  it("every operation defers its permission decision to the CANONICAL authorize primitive", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/communications/verify/start",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, channel: "SMS", phone: "+447700900000" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, target: { kind: "user", userId: MEMBER_USER }, smsOptOut: true },
    });
    expect(H.authorize.seen).toEqual([
      { teamId: TEAM_A, permission: "identity.member.read" },
      { teamId: TEAM_A, permission: "identity.org_policy.manage" },
    ]);
  });

  it("missing capability — an authenticated member without the permission is denied 403, ZERO write", async () => {
    H.authorize.allowed = false;
    H.authorize.httpStatus = 403;
    H.authorize.reason = "permission_not_granted";
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, target: { kind: "user", userId: MEMBER_USER }, smsOptOut: true },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("permission_not_granted");
    expect(H.writes).toEqual([]);
  });

  it("inactive membership — a suspended member is denied by the canonical gate, ZERO write", async () => {
    H.authorize.allowed = false;
    H.authorize.httpStatus = 403;
    H.authorize.reason = "member_not_active";
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/check",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, phone: "+447700900000", code: "000000" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("member_not_active");
    expect(H.writes).toEqual([]);
  });

  it("policy unevaluable — the gate fails CLOSED with 503, never a silent allow", async () => {
    H.authorize.allowed = false;
    H.authorize.httpStatus = 503;
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/start",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, channel: "SMS", phone: "+447700900000" },
    });
    expect(res.statusCode).toBe(503);
    expect(H.writes).toEqual([]);
  });

  it("verify/check — a wrong code is bucketed into ONE bounded denial (no branch disclosure)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/check",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, phone: "+447700900000", code: "111111" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ status: "denied" });
  });

  it("verify/check — an approved code returns only the verification id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/verify/check",
      headers: JSON_HEADERS,
      payload: { teamId: TEAM_A, phone: "+447700900000", code: "000000" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "approved", verificationId: "va-1" });
  });

  it("opt-IN is SERVER-gated — an unverified contact is refused 409, ZERO preference write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: {
        teamId: TEAM_A,
        target: { kind: "contact", phone: "+447700900000" },
        smsOptOut: false,
        preferredChannel: "SMS",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("contact_not_verified");
    expect(H.writes).toEqual([]);
  });

  it("opt-IN succeeds once the SERVER holds an approved verification for that recipient", async () => {
    H.approvedVerifications.add(TEAM_A);
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: {
        teamId: TEAM_A,
        target: { kind: "contact", phone: "+447700900000" },
        smsOptOut: false,
        preferredChannel: "SMS",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toEqual([`upsertContactPreference:${TEAM_A}`]);
  });

  it("opt-OUT is NEVER gated — suppression works without any verification", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: {
        teamId: TEAM_A,
        target: { kind: "contact", phone: "+447700900000" },
        smsOptOut: true,
        optOutReason: "operator_preference",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toEqual([`upsertContactPreference:${TEAM_A}`]);
    // The verification ledger is not even consulted for a suppression.
    expect(H.reads).not.toContain("verificationAttempt.findFirst");
  });

  it("safe projection — the preference response never carries the recipient hash", async () => {
    H.approvedVerifications.add(TEAM_A);
    const res = await app.inject({
      method: "POST",
      url: "/v1/communications/preferences",
      headers: JSON_HEADERS,
      payload: {
        teamId: TEAM_A,
        target: { kind: "contact", phone: "+447700900000" },
        smsOptOut: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("hash-should-never-be-projected");
    const pref = JSON.parse(res.body).preference;
    expect(pref).not.toHaveProperty("externalContactHash");
    expect(pref.isExternalContact).toBe(true);
  });
});

// ===========================================================================
// SYSTEM 4 — Presence
// ===========================================================================

describe("PLATFORM_CORE §4 — presence", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(presenceRoutes);
    });
  });

  const HERE = `/v1/me/presence/here?teamId=${TEAM_A}&resourceKind=evidence&resourceId=ev-1`;

  it("happy path — the read-only viewer list is workspace-gated and excludes the caller", async () => {
    const res = await app.inject({ method: "GET", url: HERE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).viewers).toHaveLength(1);
    expect(H.reads).toContain("listViewers:exclude=user-1");
    expect(H.authorize.seen).toEqual([
      { teamId: TEAM_A, permission: "collaboration.thread.read" },
    ]);
  });

  it("cross-workspace denial — anti-enumeration 404, and NO viewer data is read", async () => {
    H.authorize.allowed = false;
    H.authorize.httpStatus = 404;
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/presence/here?teamId=${TEAM_B}&resourceKind=evidence&resourceId=ev-1`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect(H.reads).toEqual([]);
  });

  it("bounded resource vocabulary — an arbitrary resourceKind cannot turn presence into an activity stream", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/presence/here?teamId=${TEAM_A}&resourceKind=billing_secrets&resourceId=x`,
    });
    // Rejected by the bounded zod vocabulary before any presence read. The
    // exact status is decided by the app-level error handler in production;
    // what this pins is that it is NOT a success and NOTHING was read.
    expect(res.statusCode).not.toBe(200);
    expect(H.reads).toEqual([]);
  });
});

// ===========================================================================
// SYSTEM 5 — Platform catalogs
// ===========================================================================

describe("PLATFORM_CORE §5 — collaboration vocabulary catalog", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(collaborationRoutes);
    });
  });

  it("serves the SERVER's collaboration vocabulary so no client hard-codes it", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/collaboration/catalogs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const key of ["threadKinds", "threadStatuses", "threadVisibilities", "participantRoles"]) {
      expect(Array.isArray(body[key])).toBe(true);
      expect(body[key].length).toBeGreaterThan(0);
    }
  });

  it("the catalog is pure vocabulary — it carries no workspace-scoped data", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/collaboration/catalogs" });
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(
      ["participantRoles", "threadKinds", "threadStatuses", "threadVisibilities"].sort(),
    );
  });
});

// ===========================================================================
// SYSTEM 6 — Platform audit export
// ===========================================================================

describe("PLATFORM_CORE §6 — platform audit export", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetState();
    app = await buildApp(async (a) => {
      await a.register(adminAuditRoutes);
    });
  });

  const ROW = {
    createdAt: "2026-07-01T00:00:00.000Z",
    action: "identity.profile_updated",
    category: "identity",
    severity: "info",
    source: "api",
    outcome: "success",
    userId: "user-1",
    resourceType: "user",
    resourceId: "user-1",
    requestId: "req-1",
    ipAddress: "203.0.113.4",
  };

  it("happy path — platform admin receives a CSV attachment with a stable header row", async () => {
    H.auditRows = [ROW];
    const res = await app.inject({ method: "GET", url: "/v1/admin/audit-log/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("admin-audit-export.csv");
    const [header, first] = res.body.split("\r\n");
    expect(header.split(",")[0]).toBe("createdAt");
    expect(first).toContain("identity.profile_updated");
    expect(H.audits).toContain("admin.audit_log_export");
  });

  it("missing capability — a non-platform-admin is denied and NO audit rows are read", async () => {
    H.platformAdmin = false;
    const res = await app.inject({ method: "GET", url: "/v1/admin/audit-log/export" });
    expect(res.statusCode).toBe(403);
    expect(H.reads).not.toContain("listAdminAuditLogs");
  });

  it("unauthenticated — 401 before the platform-role check, ZERO reads", async () => {
    H.authenticated = false;
    const res = await app.inject({ method: "GET", url: "/v1/admin/audit-log/export" });
    expect(res.statusCode).toBe(401);
    expect(H.reads).toEqual([]);
  });

  it("rate limited — the export is refused with 429 and NOTHING is serialized", async () => {
    H.rateLimitAllowed = false;
    H.auditRows = [ROW];
    const res = await app.inject({ method: "GET", url: "/v1/admin/audit-log/export" });
    expect(res.statusCode).toBe(429);
    expect(H.reads).not.toContain("listAdminAuditLogs");
    expect(H.audits).toContain("admin.audit_log_export");
  });

  it("CSV field escaping — separators and quotes in a value cannot break out of their cell", async () => {
    H.auditRows = [{ ...ROW, action: 'evil,"action"\nnewline' }];
    const res = await app.inject({ method: "GET", url: "/v1/admin/audit-log/export" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"evil,""action""\nnewline"');
  });
});
