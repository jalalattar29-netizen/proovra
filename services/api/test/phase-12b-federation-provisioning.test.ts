/**
 * PHASE 12B — federation + provisioning behavioral matrix.
 *
 * Drives the REAL canonical services over an in-memory prisma transport
 * (same pattern as phase-12b-review-authority.test.ts). Each case pins a
 * defect that was actually fixed in this wave:
 *
 *   1. SCIM bearer gate            — hashed lookup only; missing / malformed /
 *                                    revoked / expired / wrong-prefix denied.
 *   2. SCIM Group PATCH rollback   — an UNRESOLVED (or cross-Organization)
 *                                    member reference fails EXPLICITLY with
 *                                    zero partial mutation. Previously it was
 *                                    silently skipped and reported 200 OK.
 *   3. Cross-Organization SCIM     — an identity managed by another
 *                                    Organization is rejected, zero mutation.
 *   4. SSO state replay            — a second consume of the same state is
 *                                    denied, AND losing the atomic claim race
 *                                    is treated as a replay (never a success).
 *   5. Provisioning idempotency    — the same idempotencyKey provisions ONE
 *                                    Organization; a different payload on the
 *                                    same key conflicts with zero mutation.
 *   6. Invite delivery de-dup      — two overlapping outbox sweeps send exactly
 *                                    ONE email per due row, and a dead invite
 *                                    is never re-mailed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE any SUT import.
// ---------------------------------------------------------------------------

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: vi.fn(),
  setGauge: vi.fn(),
}));

const securityEvents: Array<Record<string, unknown>> = [];
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: (e: Record<string, unknown>) => {
    securityEvents.push(e);
  },
}));

const tenantAudits: Array<Record<string, unknown>> = [];
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (e: Record<string, unknown>) => {
    tenantAudits.push(e);
    return null;
  },
}));

const orgAudits: Array<Record<string, unknown>> = [];
vi.mock("../src/services/organization/org-audit.service.js", () => ({
  emitOrgAuditEvent: async (_tx: unknown, e: Record<string, unknown>) => {
    orgAudits.push(e);
    return null;
  },
}));

vi.mock("../src/config/index.js", () => ({
  resolveSecret: () => "phase-12b-test-secret",
}));
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: vi.fn(async () => null),
}));

// Membership orchestrator — record intents so we can assert ZERO mutation.
const roleChanges: Array<Record<string, unknown>> = [];
vi.mock("../src/services/identity/membership-provisioning.service.js", () => ({
  applyDirectoryRoleChange: async (
    _c: unknown,
    input: Record<string, unknown>,
  ) => {
    roleChanges.push(input);
    return { changed: true };
  },
  demoteGroupMappedRoleOnArchive: async () => ({ count: 0 }),
  provisionManagedMembership: vi.fn(async () => null),
  provisionMembership: vi.fn(async () => null),
  grantOrganizationMembership: vi.fn(async () => null),
}));

// Managed-ownership authority — scripted per test.
let ownershipBehaviour: "ok" | "cross_org" | "unresolved" = "ok";
const ownershipCalls: string[] = [];
vi.mock("../src/services/access-control/scim-managed-ownership.service.js", async () => {
  class ScimManagedOwnershipError extends Error {
    readonly statusCode = 409;
    constructor(readonly code: string) {
      super(code);
      this.name = "ScimManagedOwnershipError";
    }
  }
  return {
    ScimManagedOwnershipError,
    enforceScimManagedOwnership: async (
      _ctx: unknown,
      input: { userId: string },
    ) => {
      ownershipCalls.push(input.userId);
      if (ownershipBehaviour === "cross_org") {
        throw new ScimManagedOwnershipError("SCIM_MANAGED_CROSS_ORG_CONFLICT");
      }
      if (ownershipBehaviour === "unresolved") {
        throw new ScimManagedOwnershipError("SCIM_MANAGED_UNRESOLVED");
      }
      return "IDEMPOTENT";
    },
  };
});

// Provisioning collaborators.
vi.mock("../src/routes/organizations.routes.js", () => ({
  hashInviteToken: (t: string) => `hash:${t}`,
}));
vi.mock("../src/services/organization/enterprise-contract.service.js", () => ({
  upsertEnterpriseContract: vi.fn(async () => null),
}));
// NOT mocked: the outbox service is itself a SUT below. The provisioning
// matrix injects its `provision` dependency, so it never reaches the outbox.
vi.mock("../src/services/plan-catalog.service.js", () => ({
  getPlanCapabilities: () => ({ includedSeats: 25 }),
}));

// Email transport for the outbox sweeper.
const sentEmails: Array<{ to: string; html: string }> = [];
vi.mock("../src/services/email.service.js", () => ({
  deterministicEmailKey: (templateKey: string, ...parts: string[]) =>
    [templateKey, ...parts].join(":"),
  escapeEmailHtml: (s: string) => s,
  getEmailBrandName: () => "Proovra",
  getEmailFromHeader: () => "no-reply@example.test",
  getEmailWebBaseUrl: () => "https://app.example.test",
  renderEmailShell: (a: { ctaUrl: string }) => `<a href="${a.ctaUrl}">accept</a>`,
  sendCustomEmailViaResend: async (a: { to: string; html: string }) => {
    sentEmails.push({ to: a.to, html: a.html });
    return { ok: true, providerMessageId: `msg-${sentEmails.length}` };
  },
}));

// ---------------------------------------------------------------------------
// SUT imports.
// ---------------------------------------------------------------------------

const { authenticateScimRequest } = await import(
  "../src/services/access-control/scim.service.js"
);
const { scimPatchGroup, ScimGroupMemberError } = await import(
  "../src/services/access-control/scim-groups.service.js"
);
const { consumeCallbackAttempt, persistCallbackAttempt } = await import(
  "../src/services/access-control/sso-hardening.service.js"
);
const { provisionEnterpriseCustomerIdempotent, EnterpriseProvisioningError } =
  await import("../src/services/enterprise-provisioning.service.js");
const { processDueOrgInviteDeliveries } = await import(
  "../src/services/organization/org-invite-delivery.service.js"
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const TEAM_ID = "00000000-0000-0000-0000-0000000000aa";
const GROUP_ID = "00000000-0000-0000-0000-000000000001";
const MEMBER_A = "00000000-0000-0000-0000-00000000000a";
const UNKNOWN_MEMBER = "00000000-0000-0000-0000-0000000000ff";
const ACTOR = "00000000-0000-0000-0000-00000000000e";
const SCIM_PREFIX = "scim_pat_";

beforeEach(() => {
  securityEvents.length = 0;
  tenantAudits.length = 0;
  orgAudits.length = 0;
  roleChanges.length = 0;
  ownershipCalls.length = 0;
  sentEmails.length = 0;
  ownershipBehaviour = "ok";
});

// ===========================================================================
// 1 — SCIM bearer / scope gate.
// ===========================================================================

function makeTokenDb(token?: {
  raw: string;
  status?: string;
  expiresAtUtc?: Date | null;
  ipAllowlist?: string[];
}) {
  const touched: string[] = [];
  const rows = token
    ? [
        {
          id: "tok-1",
          teamId: TEAM_ID,
          // The stored value is the HASH the service derives — the plaintext
          // is never persisted, so a plaintext lookup cannot match.
          tokenHash: null as string | null,
          raw: token.raw,
          status: token.status ?? "ACTIVE",
          expiresAtUtc: token.expiresAtUtc ?? null,
          ipAllowlist: token.ipAllowlist ?? [],
          scopes: ["users.read", "users.write"],
        },
      ]
    : [];
  const prisma = {
    scimProvisioningToken: {
      findUnique: async (args: { where: { tokenHash: string } }) => {
        // Lazily bind the hash the SUT computes for the seeded raw token, so
        // the fake can only ever be matched by a HASH — never by plaintext.
        const row = rows[0];
        if (!row) return null;
        if (args.where.tokenHash === row.raw) {
          throw new Error("plaintext token lookup attempted");
        }
        if (row.tokenHash === null) row.tokenHash = args.where.tokenHash;
        return row.tokenHash === args.where.tokenHash ? { ...row } : null;
      },
      update: async (args: { where: { id: string } }) => {
        touched.push(args.where.id);
        return {};
      },
    },
  };
  return { prisma: prisma as never, touched };
}

describe("SCIM bearer gate", () => {
  it("denies a request with no Authorization header", async () => {
    const { prisma } = makeTokenDb();
    const r = await authenticateScimRequest(
      { authorizationHeader: undefined, remoteIp: null },
      prisma,
    );
    expect(r).toEqual({ ok: false, reason: "missing_token" });
  });

  it("denies a non-Bearer scheme and a non-SCIM-prefixed token", async () => {
    const { prisma } = makeTokenDb();
    await expect(
      authenticateScimRequest(
        { authorizationHeader: "Basic abc", remoteIp: null },
        prisma,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_token" });
    await expect(
      authenticateScimRequest(
        { authorizationHeader: "Bearer eyJhbGciOi.session.jwt", remoteIp: null },
        prisma,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_token" });
  });

  it("authenticates by HASH and never by plaintext, returning the token's own teamId", async () => {
    const raw = `${SCIM_PREFIX}${"a".repeat(64)}`;
    const { prisma } = makeTokenDb({ raw });
    const r = await authenticateScimRequest(
      { authorizationHeader: `Bearer ${raw}`, remoteIp: null },
      prisma,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Organization/workspace scope comes from the TOKEN, never a request body.
    expect(r.token.teamId).toBe(TEAM_ID);
    expect(r.token.scopes).toContain("users.write");
  });

  it("denies a revoked token and an expired token", async () => {
    const raw = `${SCIM_PREFIX}${"b".repeat(64)}`;
    await expect(
      authenticateScimRequest(
        { authorizationHeader: `Bearer ${raw}`, remoteIp: null },
        makeTokenDb({ raw, status: "REVOKED" }).prisma,
      ),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
    await expect(
      authenticateScimRequest(
        { authorizationHeader: `Bearer ${raw}`, remoteIp: null },
        makeTokenDb({ raw, expiresAtUtc: new Date(Date.now() - 1000) }).prisma,
      ),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("denies a token used from an IP outside its allowlist", async () => {
    const raw = `${SCIM_PREFIX}${"c".repeat(64)}`;
    const { prisma } = makeTokenDb({ raw, ipAllowlist: ["203.0.113."] });
    await expect(
      authenticateScimRequest(
        { authorizationHeader: `Bearer ${raw}`, remoteIp: "198.51.100.9" },
        prisma,
      ),
    ).resolves.toEqual({ ok: false, reason: "ip_not_allowed" });
  });
});

// ===========================================================================
// 2 + 3 — SCIM Group PATCH atomicity: rollback, no silent skip, cross-org.
// ===========================================================================

function makeGroupDb(seed: { members: string[] }) {
  const state = {
    group: {
      id: GROUP_ID,
      teamId: TEAM_ID,
      displayName: "Investigators",
      externalId: "grp-ext-1",
      mappedRole: "ADMIN",
      status: "ACTIVE",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    },
    groupUpdates: [] as Array<Record<string, unknown>>,
    committed: null as Record<string, unknown> | null,
    txCalls: 0,
    rolledBack: false,
  };

  const tx = {
    scimGroup: {
      findFirst: async (args: { where: { id: string; teamId: string } }) =>
        args.where.id === state.group.id && args.where.teamId === state.group.teamId
          ? { ...state.group }
          : null,
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === state.group.id ? { ...state.group } : null,
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        state.groupUpdates.push(args.data);
        Object.assign(state.group, args.data);
        return { ...state.group };
      },
    },
    teamMember: {
      findFirst: async (args: { where: { teamId: string; userId: string } }) =>
        args.where.teamId === TEAM_ID && seed.members.includes(args.where.userId)
          ? { id: `tm-${args.where.userId}`, role: "MEMBER", status: "ACTIVE" }
          : null,
      findMany: async () =>
        seed.members.map((u) => ({ userId: u, user: { email: `${u}@x.test` } })),
    },
  };

  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      state.txCalls += 1;
      const snapshot = { ...state.group };
      const updatesBefore = state.groupUpdates.length;
      const rolesBefore = roleChanges.length;
      try {
        return await fn(tx);
      } catch (err) {
        // Emulate a real ROLLBACK: every write inside the aborted transaction
        // is discarded, so the assertions below observe ZERO mutation.
        Object.assign(state.group, snapshot);
        state.groupUpdates.length = updatesBefore;
        roleChanges.length = rolesBefore;
        state.rolledBack = true;
        throw err;
      }
    },
  };
  return { prisma: prisma as never, state };
}

describe("SCIM Group PATCH — atomic, no silent skip", () => {
  it("applies a valid Operation set in ONE transaction", async () => {
    const { prisma, state } = makeGroupDb({ members: [MEMBER_A] });
    const r = await scimPatchGroup(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x/v2/scim" },
      GROUP_ID,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "displayName", value: "Case Reviewers" },
          { op: "add", path: "members", value: [{ value: MEMBER_A }] },
        ],
      } as never,
      prisma,
    );
    expect(r.ok).toBe(true);
    expect(state.txCalls).toBe(1);
    expect(state.group.displayName).toBe("Case Reviewers");
    expect(roleChanges).toHaveLength(1);
  });

  it("UNRESOLVED member reference fails EXPLICITLY with ZERO partial mutation", async () => {
    const { prisma, state } = makeGroupDb({ members: [MEMBER_A] });
    const r = await scimPatchGroup(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x/v2/scim" },
      GROUP_ID,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          // A rename that WOULD have committed under the old code path…
          { op: "replace", path: "displayName", value: "Half Applied" },
          // …followed by a member the workspace cannot resolve. A
          // cross-Organization `value` behaves identically: the member lookup
          // is teamId-scoped, so it simply does not resolve.
          {
            op: "add",
            path: "members",
            value: [{ value: MEMBER_A }, { value: UNKNOWN_MEMBER }],
          },
        ],
      } as never,
      prisma,
    );

    // Explicit SCIM-shaped failure — never a 200 "applied".
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.detail).toBe("group_member_unresolved");

    // ZERO partial mutation: the rename rolled back and the FIRST member's
    // role change (which had already been applied in-transaction) is gone too.
    expect(state.rolledBack).toBe(true);
    expect(state.group.displayName).toBe("Investigators");
    expect(state.groupUpdates).toHaveLength(0);
    expect(roleChanges).toHaveLength(0);
  });

  it("the unresolved-member failure is a typed error, not a swallowed skip", async () => {
    expect(
      new ScimGroupMemberError("SCIM_GROUP_MEMBER_UNRESOLVED", UNKNOWN_MEMBER)
        .statusCode,
    ).toBe(409);
  });

  it("cross-Organization managed identity is REJECTED with zero mutation", async () => {
    ownershipBehaviour = "cross_org";
    const { prisma, state } = makeGroupDb({ members: [MEMBER_A] });
    const r = await scimPatchGroup(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x/v2/scim" },
      GROUP_ID,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "displayName", value: "Should Not Stick" },
          { op: "add", path: "members", value: [{ value: MEMBER_A }] },
        ],
      } as never,
      prisma,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.detail).toBe("managed_cross_org_conflict");
    expect(state.group.displayName).toBe("Investigators");
    expect(roleChanges).toHaveLength(0);
  });

  it("an UNRESOLVED managed identity fails closed (never treated as standard)", async () => {
    ownershipBehaviour = "unresolved";
    const { prisma } = makeGroupDb({ members: [MEMBER_A] });
    const r = await scimPatchGroup(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x/v2/scim" },
      GROUP_ID,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "add", path: "members", value: [{ value: MEMBER_A }] }],
      } as never,
      prisma,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toBe("managed_identity_unresolved");
    expect(roleChanges).toHaveLength(0);
  });

  it("a group in ANOTHER workspace is not found (anti-enumeration)", async () => {
    const { prisma } = makeGroupDb({ members: [MEMBER_A] });
    const r = await scimPatchGroup(
      {
        teamId: "00000000-0000-0000-0000-0000000000bb",
        tokenId: "tok-1",
        baseUrl: "https://x/v2/scim",
      },
      GROUP_ID,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "displayName", value: "Nope" }],
      } as never,
      prisma,
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

// ===========================================================================
// 4 — SSO state replay protection.
// ===========================================================================

function makeSsoDb() {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    /** When true, the atomic claim loses the race (concurrent callback). */
    claimLoses: false,
  };
  let seq = 0;
  const prisma = {
    ssoCallbackAttempt: {
      create: async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `att-${seq}`, ...args.data };
        state.rows.push(row);
        return { ...row };
      },
      count: async () => state.rows.length,
      findUnique: async (args: {
        where: { stateHash?: string; id?: string };
      }) => {
        const row = state.rows.find(
          (r) =>
            (args.where.stateHash !== undefined &&
              r.stateHash === args.where.stateHash) ||
            (args.where.id !== undefined && r.id === args.where.id),
        );
        return row ? { ...row } : null;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error("attempt missing");
        Object.assign(row, args.data);
        return { ...row };
      },
      updateMany: async (args: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (state.claimLoses) return { count: 0 };
        const row = state.rows.find(
          (r) =>
            r.id === args.where.id &&
            (args.where.status === undefined || r.status === args.where.status),
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as never, state };
}

describe("SSO callback state — single-use replay protection", () => {
  it("consumes once and DENIES the replay", async () => {
    const { prisma, state } = makeSsoDb();
    const persisted = await persistCallbackAttempt(
      {
        teamId: TEAM_ID,
        ssoConnectionId: "conn-1",
        stateRaw: "state-abc",
        nonceRaw: "nonce-abc",
        redirectAfter: "/home",
        ipPreview: null,
        uaPreview: null,
      },
      prisma,
    );
    expect(persisted.ok).toBe(true);

    const first = await consumeCallbackAttempt({ stateRaw: "state-abc" }, prisma);
    expect(first.ok).toBe(true);
    expect(state.rows[0]!.status).toBe("CONSUMED");

    const second = await consumeCallbackAttempt({ stateRaw: "state-abc" }, prisma);
    expect(second).toEqual({ ok: false, reason: "REPLAYED" });
    expect(state.rows[0]!.status).toBe("REPLAYED");
    expect(
      securityEvents.some((e) => e.eventType === "sso_callback_replay_detected"),
    ).toBe(true);
  });

  it("losing the ATOMIC claim race is a REPLAY, never a successful consume", async () => {
    const { prisma, state } = makeSsoDb();
    await persistCallbackAttempt(
      {
        teamId: TEAM_ID,
        ssoConnectionId: "conn-1",
        stateRaw: "state-race",
        nonceRaw: "nonce-race",
        redirectAfter: null,
        ipPreview: null,
        uaPreview: null,
      },
      prisma,
    );
    // The row is still PENDING when read, but a concurrent instance wins the
    // state-preconditioned claim. The loser must be denied.
    state.claimLoses = true;
    const r = await consumeCallbackAttempt({ stateRaw: "state-race" }, prisma);
    expect(r).toEqual({ ok: false, reason: "REPLAYED" });
    expect(state.rows[0]!.status).toBe("REPLAYED");
  });

  it("denies an unknown state and an expired state", async () => {
    const { prisma } = makeSsoDb();
    await expect(
      consumeCallbackAttempt({ stateRaw: "never-issued" }, prisma),
    ).resolves.toEqual({ ok: false, reason: "NOT_FOUND" });

    await persistCallbackAttempt(
      {
        teamId: TEAM_ID,
        ssoConnectionId: "conn-1",
        stateRaw: "state-old",
        nonceRaw: "nonce-old",
        redirectAfter: null,
        ipPreview: null,
        uaPreview: null,
        ttlSeconds: -1,
      },
      prisma,
    );
    await expect(
      consumeCallbackAttempt({ stateRaw: "state-old" }, prisma),
    ).resolves.toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("refuses to persist an OPEN-REDIRECT destination (no state issued)", async () => {
    const { prisma, state } = makeSsoDb();
    const r = await persistCallbackAttempt(
      {
        teamId: TEAM_ID,
        ssoConnectionId: "conn-1",
        stateRaw: "state-evil",
        nonceRaw: "nonce-evil",
        redirectAfter: "https://evil.example.com/steal",
        ipPreview: null,
        uaPreview: null,
      },
      prisma,
    );
    expect(r).toEqual({ ok: false, reason: "INVALID_REDIRECT" });
    expect(state.rows).toHaveLength(0);
  });
});

// ===========================================================================
// 5 — Provisioning idempotency.
// ===========================================================================

function makeProvisioningDb() {
  const state = {
    requests: [] as Array<Record<string, unknown>>,
    organizations: [] as Array<Record<string, unknown>>,
  };
  let seq = 0;
  const prisma = {
    enterpriseProvisioningRequest: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (
          state.requests.some(
            (r) => r.idempotencyKey === args.data.idempotencyKey,
          )
        ) {
          const err = new Error("unique violation") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        seq += 1;
        const row = { id: `req-${seq}`, updatedAt: new Date(), ...args.data };
        state.requests.push(row);
        return { id: row.id };
      },
      findUnique: async (args: { where: { idempotencyKey: string } }) => {
        const row = state.requests.find(
          (r) => r.idempotencyKey === args.where.idempotencyKey,
        );
        return row ? { ...row } : null;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.requests.find((r) => r.id === args.where.id);
        if (!row) throw new Error("request missing");
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      },
      updateMany: async () => ({ count: 1 }),
    },
    organization: {
      findMany: async () => [],
    },
    enterpriseContract: undefined,
  };
  // The single-transaction provisioning implementation is injected so this
  // matrix isolates the IDEMPOTENCY contract; each call would create exactly
  // one Organization.
  const provision = vi.fn(async () => {
    seq += 1;
    const organizationId = `org-${state.organizations.length + 1}`;
    state.organizations.push({ id: organizationId });
    return {
      organizationId,
      workspaceId: `ws-${organizationId}`,
      ownerUserId: ACTOR,
      provisioned: true as const,
    };
  });
  return { prisma: prisma as never, state, provision };
}

describe("Enterprise provisioning — idempotency", () => {
  const payload = {
    organizationName: "Acme Corporation",
    ownerEmail: "owner@acme.test",
    seats: 25,
    actorUserId: ACTOR,
    idempotencyKey: "crm-contract-000123",
  };

  it("the SAME key provisions exactly ONE Organization and replays the result", async () => {
    const { prisma, state, provision } = makeProvisioningDb();
    const first = await provisionEnterpriseCustomerIdempotent(payload, prisma, {
      provision: provision as never,
    });
    expect(first.idempotentReplay).toBe(false);

    const second = await provisionEnterpriseCustomerIdempotent(payload, prisma, {
      provision: provision as never,
    });
    expect(second.idempotentReplay).toBe(true);

    // ONE Organization, ONE provisioning run.
    expect(state.organizations).toHaveLength(1);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(
      (second.result as { organizationId?: string }).organizationId,
    ).toBe((first.result as { organizationId?: string }).organizationId);
  });

  it("the same key with a DIFFERENT payload conflicts with ZERO mutation", async () => {
    const { prisma, state, provision } = makeProvisioningDb();
    await provisionEnterpriseCustomerIdempotent(payload, prisma, {
      provision: provision as never,
    });
    await expect(
      provisionEnterpriseCustomerIdempotent(
        { ...payload, organizationName: "Totally Different Co" },
        prisma,
        { provision: provision as never },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(state.organizations).toHaveLength(1);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(EnterpriseProvisioningError).toBeTypeOf("function");
  });

  it("a DIFFERENT key is a new intent and is never merged", async () => {
    const { prisma, state, provision } = makeProvisioningDb();
    await provisionEnterpriseCustomerIdempotent(payload, prisma, {
      provision: provision as never,
    });
    await provisionEnterpriseCustomerIdempotent(
      { ...payload, idempotencyKey: "crm-contract-000999" },
      prisma,
      { provision: provision as never },
    );
    expect(state.organizations).toHaveLength(2);
  });

  it("an in-flight same-key request is rejected rather than double-provisioned", async () => {
    const { prisma, provision } = makeProvisioningDb();
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {
        organizationId: "org-slow",
        workspaceId: "ws-slow",
        ownerUserId: ACTOR,
        provisioned: true as const,
      };
    });
    const inFlight = provisionEnterpriseCustomerIdempotent(payload, prisma, {
      provision: slow as never,
    });
    await expect(
      provisionEnterpriseCustomerIdempotent(payload, prisma, {
        provision: provision as never,
      }),
    ).rejects.toMatchObject({ code: "PROVISIONING_IN_PROGRESS" });
    await inFlight;
    expect(provision).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 6 — Durable invite outbox: duplicate delivery prevention.
// ===========================================================================

function makeOutboxDb(seed: {
  due: number;
  invite?: { acceptedAt?: Date | null; revokedAt?: Date | null; organizationId?: string };
}) {
  const now = Date.now();
  const rows = Array.from({ length: seed.due }, (_, i) => ({
    id: `del-${i + 1}`,
    eventType: "org_invite_delivery",
    channel: "EMAIL",
    status: "PENDING",
    retryCount: 0,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    recipient: "owner@acme.test",
    // Widened deliberately: a rotation commits a SUCCESSOR intent carrying a
    // content version and fingerprint alongside the ids, so the array holds
    // more than the seed shape.
    metadata: { inviteId: "inv-1", organizationId: "org-1" } as Record<
      string,
      unknown
    >,
    nextAttemptAtUtc: new Date(now - 1000),
  }));

  const state = { rows, inviteTokenHashes: [] as string[] };

  const prisma = {
    notificationDelivery: {
      findMany: async () => rows.map((r) => ({ ...r })),
      // PHASE 12 POINT 5 — a rotation SUPERSEDES the intent it read and
      // commits a SUCCESSOR under a new provider idempotency key, so this
      // fake has to model a chain rather than a single row. Without it the
      // sweeper's outcome had nowhere to land and the duplicate-prevention
      // cases below were measuring a row nothing wrote to any more.
      create: async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: String(args.data.id ?? `del-successor-${rows.length + 1}`),
          eventType: "org_invite_delivery",
          channel: "EMAIL",
          status: String(args.data.status ?? "PENDING"),
          retryCount: Number(args.data.retryCount ?? 0),
          errorCode: null as string | null,
          errorMessage: null as string | null,
          recipient: String(args.data.recipient ?? "owner@acme.test"),
          metadata: (args.data.metadata ?? {}) as Record<string, unknown>,
          nextAttemptAtUtc:
            args.data.nextAttemptAtUtc instanceof Date
              ? args.data.nextAttemptAtUtc
              : new Date(now + 60_000),
        };
        rows.push(row);
        return { ...row };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === args.where.id);
        return row ? { ...row } : null;
      },
      updateMany: async (args: {
        where: { id: string; status?: string; nextAttemptAtUtc?: unknown };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) return { count: 0 };
        // The atomic lease claim: only a row still PENDING *and* still due can
        // be claimed. A second overlapping sweeper matches 0 rows.
        if (args.where.status && row.status !== args.where.status) {
          return { count: 0 };
        }
        if (
          args.where.nextAttemptAtUtc &&
          row.nextAttemptAtUtc.getTime() > now
        ) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error("delivery missing");
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    organizationInvite: {
      findUnique: async () => ({
        id: "inv-1",
        organizationId: seed.invite?.organizationId ?? "org-1",
        email: "owner@acme.test",
        role: "ORG_OWNER",
        acceptedAt: seed.invite?.acceptedAt ?? null,
        revokedAt: seed.invite?.revokedAt ?? null,
        invitedByUserId: null,
        // Read by the delivery producer to build the bounded content
        // fingerprint that distinguishes a rotated invitation from an
        // unrotated one.
        tokenHash: "a".repeat(64),
        expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      }),
      update: async (args: { data: { tokenHash?: string } }) => {
        if (args.data.tokenHash) state.inviteTokenHashes.push(args.data.tokenHash);
        return {};
      },
    },
    organization: { findUnique: async () => ({ name: "Acme Corporation" }) },
    user: { findUnique: async () => null },
    $transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> =>
      fn(prisma),
  };
  return { prisma: prisma as never, state };
}

describe("Durable invite outbox — duplicate delivery prevention", () => {
  it("two OVERLAPPING sweeps send exactly ONE email per due row", async () => {
    const { prisma, state } = makeOutboxDb({ due: 1 });
    const [a, b] = await Promise.all([
      processDueOrgInviteDeliveries({}, prisma),
      processDueOrgInviteDeliveries({}, prisma),
    ]);
    // Exactly one sweeper claimed the row.
    expect(a.pickedUp + b.pickedUp).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    // Exactly ONE email — never a duplicate invitation.
    expect(sentEmails).toHaveLength(1);
    // Rotation happened once: the previously emailed link is dead, so the
    // recipient can never hold two working acceptance URLs.
    expect(state.inviteTokenHashes).toHaveLength(1);
    // PHASE 12 POINT 5 — the outcome lands on the SUCCESSOR intent the
    // rotation created, and the intent it replaced is retired so it can never
    // send again. Reading `rows[0]` alone would now assert that a superseded
    // row was delivered, which is the opposite of the guarantee.
    expect(state.rows[0]!.status).toBe("CANCELLED");
    expect(state.rows[0]!.errorCode).toBe("superseded_by_rotation");
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]!.status).toBe("SENT");
  });

  it("a re-run after delivery sends nothing (the row is no longer PENDING)", async () => {
    const { prisma } = makeOutboxDb({ due: 1 });
    await processDueOrgInviteDeliveries({}, prisma);
    expect(sentEmails).toHaveLength(1);
    const again = await processDueOrgInviteDeliveries({}, prisma);
    expect(again.pickedUp).toBe(0);
    expect(sentEmails).toHaveLength(1);
  });

  it("an ACCEPTED invite is never re-mailed (delivery cancelled)", async () => {
    const { prisma, state } = makeOutboxDb({
      due: 1,
      invite: { acceptedAt: new Date() },
    });
    const r = await processDueOrgInviteDeliveries({}, prisma);
    expect(r.cancelled).toBe(1);
    expect(sentEmails).toHaveLength(0);
    expect(state.inviteTokenHashes).toHaveLength(0);
  });

  it("a REVOKED invite is never re-mailed (delivery cancelled)", async () => {
    const { prisma } = makeOutboxDb({
      due: 1,
      invite: { revokedAt: new Date() },
    });
    const r = await processDueOrgInviteDeliveries({}, prisma);
    expect(r.cancelled).toBe(1);
    expect(sentEmails).toHaveLength(0);
  });

  it("a CROSS-ORGANIZATION binding drift is never delivered", async () => {
    const { prisma } = makeOutboxDb({
      due: 1,
      invite: { organizationId: "org-someone-else" },
    });
    await processDueOrgInviteDeliveries({}, prisma);
    expect(sentEmails).toHaveLength(0);
  });
});
