/**
 * PHASE 12 VERTICAL C RESIDUE (TRUST_ADMINISTRATION) production-operation matrix.
 *
 * `phase-12-trust-administration-matrix.test.ts` proves eleven of this
 * vertical's twenty-four Phase-12 operations (trust authoring, status
 * publication, verification preview + references, delivery history). This
 * suite proves the remaining THIRTEEN, through the REAL handlers with fastify
 * `inject`. Only process boundaries are mocked (auth, canonical authorization,
 * delegated tier, step-up, prisma, canonical services); every gate, projection
 * and denial branch under test is the shipped handler code.
 *
 * Systems covered:
 *
 *   1. Workspace governance policy         — governance.routes.ts     (2 ops)
 *   2. Legal-Hold compatibility adapters   — governance.routes.ts     (6 ops)
 *   3. Lifecycle policy violations         — product-and-lifecycle    (2 ops)
 *   4. Lifecycle verification preview      — product-and-lifecycle    (1 op )
 *   5. Packaging entitlement grant         — product-and-lifecycle    (1 op )
 *   6. Exchange delivery download          — product-and-lifecycle    (1 op )
 *
 *   2 + 6 + 2 + 1 + 1 + 1 = 13.
 *
 * The Legal-Hold system is the C2 disposition under behavioral test: those six
 * operations are RETAINED as thin COMPATIBILITY_TEMPORARY adapters, and what
 * is asserted here is exactly that — they answer, they gate, and they mutate
 * ONLY through the canonical authority.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The product-and-lifecycle plugin transitively imports the S3 storage module,
// which validates its credentials at import time. Inert test values — no S3
// client is ever exercised by this suite.
vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const IDS = vi.hoisted(() => ({
  ACTOR: "11111111-1111-4111-8111-111111111111",
  TEAM: "22222222-2222-4222-8222-222222222222",
  OTHER_TEAM: "33333333-3333-4333-8333-333333333333",
  EVIDENCE: "44444444-4444-4444-8444-444444444444",
  CASE: "55555555-5555-4555-8555-555555555555",
  HOLD: "66666666-6666-4666-8666-666666666666",
  DELIVERY: "77777777-7777-4777-8777-777777777777",
}));

const { ACTOR, TEAM, OTHER_TEAM, EVIDENCE, CASE, HOLD, DELIVERY } = IDS;

const H = vi.hoisted(() => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,

  /** Canonical authorization seam. */
  authAllowed: true,
  denyStatus: 403 as 403 | 404,
  seenPermissions: [] as string[],

  /** Delegated-tier preHandler seam (a SEPARATE gate from the capability). */
  tierAllowed: true,

  /** Step-up seam. */
  stepUpSent: false,
  stepUpCalls: [] as Array<{ purpose: string; resourceKind: string | null; resourceId: string | null }>,

  /** EVERY canonical write. A denial MUST leave this empty. */
  writes: [] as string[],

  /** Governance policy state. */
  policyVersion: 4,
  policyVersionConflict: false,
  requireLegalHoldReleaseApproval: false,

  /** Canonical Legal-Hold authority outcomes. */
  holdPlaceError: null as string | null,
  holdReleaseError: null as string | null,
  holdExists: true,

  /** Exchange side-effect ledgers — a denial must leave ALL of these empty. */
  signedUrlsMinted: [] as string[],
  deliveriesCreated: [] as string[],
  webhooks: [] as string[],

  /** Lifecycle + exchange outcomes. */
  deliveryFound: true,
}));

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.actorUserId }));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => {},
  requireAuthAndLegal: async () => {},
}));
vi.mock("../src/middleware/cron-secret.js", () => ({
  requireIntegrationCronSecret: async () => {},
}));

vi.mock("../src/middleware/require-delegated-tier.js", () => ({
  requireDelegatedTier: () => async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (!H.tierAllowed) {
      reply.code(403).send({ denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "ORG_ADMIN" });
    }
  },
  requireDelegatedTierAny: () => async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (!H.tierAllowed) {
      reply.code(403).send({ denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "ORG_ADMIN" });
    }
  },
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    opts: { permission: string; teamId?: string },
  ) => {
    H.seenPermissions.push(opts.permission);
    if (!H.authAllowed) {
      if (H.denyStatus === 404) reply.code(404).send({ error: { code: "not_found" } });
      else reply.code(403).send({ error: { code: "permission_denied" } });
      return null;
    }
    return { actorUserId: H.actorUserId, teamId: opts.teamId ?? TEAM };
  },
  requireAuthorize: () => async () => {},
}));

vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: {
    purpose: string;
    resourceKind?: string | null;
    resourceId?: string | null;
    reply: { code: (n: number) => { send: (b: unknown) => void } };
  }) => {
    H.stepUpCalls.push({
      purpose: input.purpose,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
    });
    if (H.stepUpSent) {
      input.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED" } });
      return { sent: true };
    }
    return { sent: false, verifiedChallengeId: "chal-verified" };
  },
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => ({ ok: true }),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: { findUnique: async () => ({ currentWorkspaceId: H.currentWorkspaceId }) },
    team: { findUnique: async () => ({ id: TEAM, organizationId: "org-1" }) },
    evidence: { findUnique: async () => ({ id: EVIDENCE, teamId: TEAM }) },
    case: { findUnique: async () => ({ id: CASE, teamId: TEAM }) },
  },
}));

// ---------------------------------------------------------------------------
// Canonical services — assert the routes CALL them, never re-implement.
// ---------------------------------------------------------------------------

vi.mock("../src/services/governance.service.js", () => {
  // Declared INSIDE the factory: vi.mock is hoisted above module scope, so a
  // top-level class would not exist yet when the factory runs.
  class FakeVersionConflict extends Error {
    constructor() {
      super("stale governance policy version");
      this.name = "GovernancePolicyVersionConflictError";
    }
  }
  return {
  GovernancePolicyVersionConflictError: FakeVersionConflict,
  loadWorkspaceGovernancePolicy: async () => ({
    teamId: TEAM,
    deletionMode: "SOFT_DELETE",
    requireLegalHoldReleaseApproval: H.requireLegalHoldReleaseApproval,
    // Present on the SERVICE row so the safe-projection test proves the
    // PROJECTION strips it, not the service.
    internalPolicyNotes: "INTERNAL_POLICY_NOTES_SHOULD_NEVER_SHIP",
  }),
  loadWorkspaceGovernancePolicyVersion: async () => H.policyVersion,
  projectEffectivePolicy: (p: { deletionMode: string; requireLegalHoldReleaseApproval: boolean }) => ({
    deletionMode: p.deletionMode,
    requireLegalHoldReleaseApproval: p.requireLegalHoldReleaseApproval,
  }),
  updateWorkspaceGovernancePolicyWithVersion: async () => {
    if (H.policyVersionConflict) throw new FakeVersionConflict();
    H.writes.push("updateWorkspaceGovernancePolicy");
    return { newVersion: H.policyVersion + 1, row: { id: "pol-1" } };
  },
  listLegalHoldsForEvidence: async () => [],
  projectLegalHold: (h: Record<string, unknown>) => h,
  };
});

vi.mock("../src/services/governance/legal-hold.service.js", () => {
  // Declared INSIDE the factory (see the note on the governance mock above).
  class FakeLegalHoldError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, statusCode = 400) {
      super(code);
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return {
  LegalHoldError: FakeLegalHoldError,
  placeCanonicalLegalHold: async (i: { scope: string; evidenceId?: string | null; caseId?: string | null }) => {
    if (H.holdPlaceError) throw new FakeLegalHoldError(H.holdPlaceError, 404);
    H.writes.push(`placeCanonicalLegalHold:${i.scope}`);
    return {
      id: HOLD,
      teamId: TEAM,
      scope: i.scope,
      evidenceId: i.evidenceId ?? null,
      caseId: i.caseId ?? null,
      title: "Preservation",
      reason: null,
      status: "ACTIVE",
      placedByUserId: ACTOR,
      placedAtUtc: new Date("2026-07-30T10:00:00.000Z"),
      releasedByUserId: null,
      releasedAtUtc: null,
      releaseNote: null,
    };
  },
  releaseLegalHoldAnyStore: async () => {
    if (H.holdReleaseError) throw new FakeLegalHoldError(H.holdReleaseError, 409);
    H.writes.push("releaseLegalHoldAnyStore");
    return { store: "CANONICAL" as const };
  },
  listEvidenceScopedLegalHoldsLegacyShape: async () =>
    H.holdExists
      ? [
          {
            id: HOLD,
            teamId: TEAM,
            evidenceId: EVIDENCE,
            caseId: null,
            title: "Preservation",
            reason: null,
            status: "RELEASED",
            placedByUserId: ACTOR,
            placedAtUtc: "2026-07-30T10:00:00.000Z",
            releasedByUserId: ACTOR,
            releasedAtUtc: "2026-07-30T11:00:00.000Z",
            releaseNote: "Matter closed",
          },
        ]
      : [],
  listCaseScopedLegalHoldsLegacyShape: async () =>
    H.holdExists
      ? [
          {
            id: HOLD,
            teamId: TEAM,
            caseId: CASE,
            title: "Preservation",
            status: "RELEASED",
            placedByUserId: ACTOR,
            placedAtUtc: "2026-07-30T10:00:00.000Z",
            releasedByUserId: ACTOR,
            releasedAtUtc: "2026-07-30T11:00:00.000Z",
          },
        ]
      : [],
  listLifecycleLegalHoldsLegacyShape: async () => [],
  };
});

vi.mock("../src/services/governance/case-legal-hold.service.js", () => ({
  CaseLegalHoldError: class CaseLegalHoldError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  isEvidenceUnderAnyLegalHold: async () => false,
}));

vi.mock("../src/services/governance/publication.service.js", () => ({
  PublicationError: class PublicationError extends Error {},
  projectPublicationState: () => ({ state: "UNPUBLISHED" }),
  publishPublicVerify: async () => ({ ok: true }),
  restorePublicVerify: async () => ({ ok: true }),
  suspendPublicVerify: async () => ({ ok: true }),
  unpublishPublicVerify: async () => ({ ok: true }),
}));

vi.mock("../src/services/governance/retention-sweeper.service.js", () => ({
  listRetentionCandidates: async () => [],
  reconcileRetention: async () => ({ scanned: 0 }),
}));

vi.mock("../src/services/lifecycle/policy-violation.service.js", () => ({
  POLICY_VIOLATION_CODES: ["RETENTION_OVERDUE", "HOLD_CONFLICT"] as const,
  listPolicyViolations: async (i: { teamId: string; kind?: string; limit?: number }) => [
    {
      id: "viol-1",
      teamId: i.teamId,
      code: i.kind ?? "RETENTION_OVERDUE",
      evidenceId: EVIDENCE,
      detectedAtUtc: "2026-07-30T09:00:00.000Z",
      summary: "A record is past its retention horizon.",
    },
  ],
  countPolicyViolations: async () => ({ RETENTION_OVERDUE: 1, HOLD_CONFLICT: 0 }),
}));

vi.mock("../src/services/lifecycle/lifecycle-manifest.service.js", () => ({
  VERIFICATION_PACKAGE_LIFECYCLE_PREVIEW_KINDS: ["retention", "legal-hold", "destruction"] as const,
  buildLifecyclePackagePreview: async (i: { kind: string }) => {
    H.writes.push("buildLifecyclePackagePreview");
    return { kind: i.kind, schemaVersion: 1, sections: [], digest: "sha256:abc" };
  },
}));

vi.mock("../src/services/packaging/entitlement.service.js", () => ({
  assertFeatureEntitlement: async () => ({ ok: true }),
  assertQuotaEntitlement: async () => ({ ok: true }),
  applyProductLine: async () => ({ ok: true, granted: 3 }),
  listEntitlements: async () => [],
  upsertEntitlementGrant: async (i: { key: string; value: unknown; kind: string }) => {
    H.writes.push(`upsertEntitlementGrant:${i.kind}:${i.key}:${String(i.value)}`);
    return { grantId: "grant-1" };
  },
}));

vi.mock("../src/services/exchange/evidence-exchange.service.js", () => ({
  createExchangePackage: async () => ({ ok: true }),
  generateSignedUrl: async () => {
    // Every side effect of minting is recorded so a denial can be proven to
    // produce NONE of them: no signed URL, no webhook, no persistence.
    H.writes.push("generateSignedUrl");
    H.signedUrlsMinted.push("https://example.invalid/x");
    H.webhooks.push("PACKAGE_CREATED");
    return { ok: true as const, signedUrl: "https://example.invalid/x", expiresAtUtc: "2026-08-02T00:00:00.000Z" };
  },
  listPackages: async () => [],
  listPackageDeliveries: async () => [],
  recordPackageDelivery: async () => {
    H.writes.push("recordPackageDelivery");
    H.deliveriesCreated.push("delivery-1");
    return { ok: true as const, deliveryId: "delivery-1" };
  },
  recordPackageDownload: async () => {
    if (!H.deliveryFound) return { ok: false as const };
    H.writes.push("recordPackageDownload");
    return { ok: true as const };
  },
  revokePackage: async () => ({ ok: true }),
}));

vi.mock("../src/services/exchange/signed-delivery.service.js", () => ({
  listDeliveryActivity: async () => ({ deliveries: [], nextCursor: null }),
  emitTransferVerificationEvent: async () => ({ ok: true }),
  verifySignedDeliveryToken: async () => ({ ok: true }),
}));

import { governanceRoutes } from "../src/routes/governance.routes.js";
import { productAndLifecycleRoutes } from "../src/routes/product-and-lifecycle.routes.js";

let gov: FastifyInstance;
let lifecycle: FastifyInstance;

const json = { "content-type": "application/json" };

beforeEach(async () => {
  H.actorUserId = ACTOR;
  H.currentWorkspaceId = TEAM;
  H.authAllowed = true;
  H.denyStatus = 403;
  H.seenPermissions.length = 0;
  H.tierAllowed = true;
  H.stepUpSent = false;
  H.stepUpCalls.length = 0;
  H.writes.length = 0;
  H.policyVersion = 4;
  H.policyVersionConflict = false;
  H.requireLegalHoldReleaseApproval = false;
  H.holdPlaceError = null;
  H.holdReleaseError = null;
  H.holdExists = true;
  H.deliveryFound = true;
  H.signedUrlsMinted.length = 0;
  H.deliveriesCreated.length = 0;
  H.webhooks.length = 0;

  gov = Fastify();
  await gov.register(governanceRoutes);
  await gov.ready();

  lifecycle = Fastify();
  await lifecycle.register(productAndLifecycleRoutes);
  await lifecycle.ready();
});

// ===========================================================================
// 1. Workspace governance policy
// ===========================================================================

describe("Trust residue — workspace governance policy", () => {
  it("the READ resolves its workspace SERVER-side and returns the version as a sibling", async () => {
    const res = await gov.inject({ method: "GET", url: "/v1/governance/policy" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe(4);
    expect(body.policy.deletionMode).toBe("SOFT_DELETE");
    // The concurrency token is a SIBLING of policy, never a member of it.
    expect(body.policy).not.toHaveProperty("version");
    // Internal policy fields never ship.
    expect(res.body).not.toContain("INTERNAL_POLICY_NOTES_SHOULD_NEVER_SHIP");
    expect(H.seenPermissions).toContain("governance.policy.read");
  });

  it("a client-named workspace that is not the server's is a 404, not an answer", async () => {
    const res = await gov.inject({ method: "GET", url: `/v1/governance/policy?teamId=${OTHER_TEAM}` });
    expect(res.statusCode).toBe(404);
  });

  it("an operator with no active workspace is 404ed rather than defaulted", async () => {
    H.currentWorkspaceId = null;
    const res = await gov.inject({ method: "GET", url: "/v1/governance/policy" });
    expect(res.statusCode).toBe(404);
  });

  it("the WRITE needs the manage capability and returns the NEW version", async () => {
    const res = await gov.inject({
      method: "PUT",
      url: "/v1/governance/policy",
      headers: json,
      payload: { requireLegalHoldReleaseApproval: true, expectedVersion: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).version).toBe(5);
    expect(H.writes).toContain("updateWorkspaceGovernancePolicy");
    expect(H.seenPermissions).toContain("governance.policy.manage");
  });

  it("a stale expectedVersion is refused with ZERO write", async () => {
    H.policyVersionConflict = true;
    const res = await gov.inject({
      method: "PUT",
      url: "/v1/governance/policy",
      headers: json,
      payload: { requireLegalHoldReleaseApproval: true, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(H.writes).toEqual([]);
  });

  it("missing capability on the WRITE → denial with ZERO write", async () => {
    H.authAllowed = false;
    const res = await gov.inject({
      method: "PUT",
      url: "/v1/governance/policy",
      headers: json,
      payload: { requireLegalHoldReleaseApproval: true, expectedVersion: 4 },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 2. Legal-Hold COMPATIBILITY_TEMPORARY adapters (C2 disposition)
// ===========================================================================

describe("Trust residue — Legal-Hold compatibility adapters", () => {
  it("the evidence-hold list answers from the CANONICAL store in the legacy shape", async () => {
    const res = await gov.inject({ method: "GET", url: `/v1/governance/legal-holds?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.legalHolds).toHaveLength(1);
    expect(body.legalHolds[0].evidenceId).toBe(EVIDENCE);
    // Reading a hold's EXISTENCE is a member-level fact, not a manage action.
    expect(H.seenPermissions).toContain("governance.policy.read");
    expect(H.seenPermissions).not.toContain("governance.legal_hold.manage");
  });

  it("placing an evidence hold goes through the ONE canonical placement command", async () => {
    const res = await gov.inject({
      method: "POST",
      url: "/v1/governance/legal-holds",
      headers: json,
      payload: { teamId: TEAM, evidenceId: EVIDENCE, title: "Preservation" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).legalHold.evidenceId).toBe(EVIDENCE);
    expect(H.writes).toEqual(["placeCanonicalLegalHold:EVIDENCE"]);
    expect(H.seenPermissions).toContain("governance.legal_hold.manage");
  });

  it("placing an evidence hold is target-bound step-up gated", async () => {
    await gov.inject({
      method: "POST",
      url: "/v1/governance/legal-holds",
      headers: json,
      payload: { teamId: TEAM, evidenceId: EVIDENCE, title: "Preservation" },
    });
    expect(H.stepUpCalls).toEqual([
      { purpose: "LEGAL_HOLD_PLACE", resourceKind: "evidence_legal_hold", resourceId: EVIDENCE },
    ]);

    H.stepUpSent = true;
    H.writes.length = 0;
    const denied = await gov.inject({
      method: "POST",
      url: "/v1/governance/legal-holds",
      headers: json,
      payload: { teamId: TEAM, evidenceId: EVIDENCE, title: "Preservation" },
    });
    expect(denied.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
  });

  it("a cross-workspace evidence target is refused by the canonical authority, not the adapter", async () => {
    H.holdPlaceError = "target_not_in_workspace";
    const res = await gov.inject({
      method: "POST",
      url: "/v1/governance/legal-holds",
      headers: json,
      payload: { teamId: TEAM, evidenceId: EVIDENCE, title: "Preservation" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("evidence_not_found");
    expect(H.writes).toEqual([]);
  });

  it("releasing an evidence hold delegates to the ONE release command and re-reads the row", async () => {
    const res = await gov.inject({
      method: "POST",
      url: `/v1/governance/legal-holds/${HOLD}/release`,
      headers: json,
      payload: { teamId: TEAM, releaseNote: "Matter closed", approvalAcknowledged: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.legalHold.status).toBe("RELEASED");
    expect(H.writes).toEqual(["releaseLegalHoldAnyStore"]);
    expect(H.stepUpCalls).toEqual([
      { purpose: "LEGAL_HOLD_RELEASE", resourceKind: "evidence_legal_hold", resourceId: HOLD },
    ]);
  });

  it("a released hold that cannot be re-read is a 404, never a fabricated success", async () => {
    H.holdExists = false;
    const res = await gov.inject({
      method: "POST",
      url: `/v1/governance/legal-holds/${HOLD}/release`,
      headers: json,
      payload: { teamId: TEAM, releaseNote: "Matter closed" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("hold_not_found");
  });

  it("a canonical release refusal surfaces its bounded code with no invented status", async () => {
    H.holdReleaseError = "release_approval_required";
    const res = await gov.inject({
      method: "POST",
      url: `/v1/governance/legal-holds/${HOLD}/release`,
      headers: json,
      payload: { teamId: TEAM, releaseNote: "Matter closed" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("release_approval_required");
  });

  it("the case-hold list answers in the legacy shape from the canonical store", async () => {
    const res = await gov.inject({ method: "GET", url: `/v1/governance/case-legal-holds?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).caseLegalHolds).toHaveLength(1);
  });

  it("placing a case hold uses the SAME canonical command with CASE scope + step-up", async () => {
    const res = await gov.inject({
      method: "POST",
      url: "/v1/governance/case-legal-holds",
      headers: json,
      payload: { teamId: TEAM, caseId: CASE, title: "Preservation" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).caseLegalHold.caseId).toBe(CASE);
    expect(H.writes).toEqual(["placeCanonicalLegalHold:CASE"]);
    // Placing a CASE hold is exactly as custody-relevant as an evidence hold.
    expect(H.stepUpCalls).toEqual([
      { purpose: "LEGAL_HOLD_PLACE", resourceKind: "evidence_legal_hold", resourceId: CASE },
    ]);
  });

  it("releasing a case hold enforces the workspace approval gate BEFORE any release", async () => {
    H.requireLegalHoldReleaseApproval = true;
    const blocked = await gov.inject({
      method: "POST",
      url: `/v1/governance/case-legal-holds/${HOLD}/release`,
      headers: json,
      payload: { teamId: TEAM, releaseNote: "Matter closed" },
    });
    expect(blocked.statusCode).toBe(412);
    expect(JSON.parse(blocked.body).error.code).toBe("release_approval_required");
    expect(H.writes).toEqual([]);
    // The gate ran before step-up was even offered.
    expect(H.stepUpCalls).toEqual([]);

    const ok = await gov.inject({
      method: "POST",
      url: `/v1/governance/case-legal-holds/${HOLD}/release`,
      headers: json,
      payload: { teamId: TEAM, releaseNote: "Matter closed", approvalAcknowledged: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(H.writes).toEqual(["releaseLegalHoldAnyStore"]);
  });

  it("every mutating adapter refuses without the manage capability and writes NOTHING", async () => {
    H.authAllowed = false;
    const calls = [
      { url: "/v1/governance/legal-holds", payload: { teamId: TEAM, evidenceId: EVIDENCE, title: "T" } },
      { url: `/v1/governance/legal-holds/${HOLD}/release`, payload: { teamId: TEAM, releaseNote: "n" } },
      { url: "/v1/governance/case-legal-holds", payload: { teamId: TEAM, caseId: CASE, title: "T" } },
      { url: `/v1/governance/case-legal-holds/${HOLD}/release`, payload: { teamId: TEAM, releaseNote: "n" } },
    ];
    for (const c of calls) {
      const res = await gov.inject({ method: "POST", url: c.url, headers: json, payload: c.payload });
      expect(res.statusCode, c.url).toBe(403);
    }
    expect(H.writes).toEqual([]);
    expect(H.stepUpCalls).toEqual([]);
  });

  it("a cross-organization probe on either list is concealed as 404", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    for (const url of [
      `/v1/governance/legal-holds?teamId=${TEAM}`,
      `/v1/governance/case-legal-holds?teamId=${TEAM}`,
    ]) {
      const res = await gov.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

// ===========================================================================
// 3. Lifecycle policy violations
// ===========================================================================

describe("Trust residue — lifecycle policy violations", () => {
  it("the violations list is workspace-scoped and filterable by bounded code", async () => {
    const res = await lifecycle.inject({
      method: "GET",
      url: "/v1/lifecycle/violations?kind=RETENTION_OVERDUE&limit=50",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].code).toBe("RETENTION_OVERDUE");
  });

  it("an unbounded violation code is refused rather than silently ignored", async () => {
    const res = await lifecycle.inject({
      method: "GET",
      url: "/v1/lifecycle/violations?kind=NOT_A_REAL_CODE",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("an operator with no active workspace gets a bounded denial, not another tenant's rows", async () => {
    H.currentWorkspaceId = null;
    const res = await lifecycle.inject({ method: "GET", url: "/v1/lifecycle/violations" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).denial).toBe("WORKSPACE_NOT_FOUND");
  });

  it("the counts projection answers per bounded code", async () => {
    const res = await lifecycle.inject({ method: "GET", url: "/v1/lifecycle/violations/counts" });
    expect(res.statusCode).toBe(200);
    const counts = JSON.parse(res.body).counts;
    expect(counts.RETENTION_OVERDUE).toBe(1);
    expect(counts.HOLD_CONFLICT).toBe(0);
  });

  it("the counts projection is workspace-scoped too", async () => {
    H.currentWorkspaceId = null;
    const res = await lifecycle.inject({ method: "GET", url: "/v1/lifecycle/violations/counts" });
    expect(res.statusCode).toBe(403);
  });
});

// ===========================================================================
// 4. Lifecycle verification-package preview
// ===========================================================================

describe("Trust residue — lifecycle verification-package preview", () => {
  it("builds a bounded preview for a known kind", async () => {
    const res = await lifecycle.inject({
      method: "GET",
      url: "/v1/lifecycle/verification-package/preview?kind=retention",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kind).toBe("retention");
    expect(body.manifest.digest).toBe("sha256:abc");
    expect(H.writes).toContain("buildLifecyclePackagePreview");
  });

  it("an unknown preview kind is refused with ZERO build", async () => {
    const res = await lifecycle.inject({
      method: "GET",
      url: "/v1/lifecycle/verification-package/preview?kind=not-a-kind",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(H.writes).toEqual([]);
  });

  it("the delegated-tier gate runs BEFORE the workspace is even resolved", async () => {
    H.tierAllowed = false;
    const res = await lifecycle.inject({
      method: "GET",
      url: "/v1/lifecycle/verification-package/preview?kind=retention",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).denial).toBe("DELEGATED_ADMIN_REQUIRED");
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 5. Packaging entitlement grant
// ===========================================================================

describe("Trust residue — packaging entitlement grant", () => {
  it("grants ONE entitlement through the canonical upsert", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: json,
      payload: { key: "FEATURE_REDACTION", kind: "FEATURE", value: true, source: "CUSTOM" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).grantId).toBe("grant-1");
    expect(H.writes).toEqual(["upsertEntitlementGrant:FEATURE:FEATURE_REDACTION:true"]);
  });

  it("a QUOTA grant carries its numeric value through unchanged", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: json,
      payload: { key: "QUOTA_USERS", kind: "QUOTA", value: 25, productLine: "ENTERPRISE" },
    });
    expect(res.statusCode).toBe(201);
    expect(H.writes).toEqual(["upsertEntitlementGrant:QUOTA:QUOTA_USERS:25"]);
  });

  it("ORG_ADMIN is required — a lesser tier grants NOTHING", async () => {
    H.tierAllowed = false;
    const res = await lifecycle.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: json,
      payload: { key: "FEATURE_REDACTION", kind: "FEATURE", value: true },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).denial).toBe("DELEGATED_ADMIN_REQUIRED");
    expect(H.writes).toEqual([]);
  });

  it("an unbounded kind is refused before the canonical service is reached", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: json,
      payload: { key: "FEATURE_REDACTION", kind: "SUPERPOWER", value: true },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(H.writes).toEqual([]);
  });

  it("no active workspace → bounded denial, never a grant against a guessed tenant", async () => {
    H.currentWorkspaceId = null;
    const res = await lifecycle.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: json,
      payload: { key: "FEATURE_REDACTION", kind: "FEATURE", value: true },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 6. Exchange delivery download
// ===========================================================================

describe("Trust residue — exchange delivery download", () => {
  it("records the download against the caller's OWN workspace", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/deliveries/${DELIVERY}/download`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(H.writes).toEqual(["recordPackageDownload"]);
  });

  it("a delivery that is not this workspace's is a bounded NOT_FOUND", async () => {
    H.deliveryFound = false;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/deliveries/${DELIVERY}/download`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).denial).toBe("NOT_FOUND");
  });

  it("no active workspace records NOTHING", async () => {
    H.currentWorkspaceId = null;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/deliveries/${DELIVERY}/download`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// PHASE 12 POINT 4 — Exchange export security matrix.
//
// These drive the REAL product-and-lifecycle handlers. Only process boundaries
// are mocked (auth, canonical authorization, step-up, prisma, exchange
// services); every gate under test is shipped handler code.
//
// The defect these lock down: `resolveWorkspace` derives the workspace but
// authorizes NOTHING, so minting a signed URL and sending a delivery — both of
// which hand out evidence — were reachable by any authenticated member,
// including a VIEWER, with no capability and no step-up.
// ===========================================================================

const PKG = "88888888-8888-4888-8888-888888888888";

describe("Trust residue — Exchange export: capability", () => {
  it("a caller WITH evidence.generate_package mints the URL", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(H.seenPermissions).toContain("evidence.generate_package");
    expect(H.signedUrlsMinted).toHaveLength(1);
  });

  it("a caller WITHOUT the capability is denied and mints NOTHING", async () => {
    H.authAllowed = false;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    // The whole point: no URL, no webhook, no persistence, no step-up offered.
    expect(H.signedUrlsMinted).toEqual([]);
    expect(H.webhooks).toEqual([]);
    expect(H.writes).toEqual([]);
    expect(H.stepUpCalls).toEqual([]);
  });

  it("a foreign workspace is CONCEALED as 404, not described", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(H.signedUrlsMinted).toEqual([]);
  });

  it("delivery creation carries the SAME export capability", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/deliveries`,
      headers: json,
      payload: { recipientEmail: "recipient@example.invalid" },
    });
    expect(res.statusCode).toBe(201);
    expect(H.seenPermissions).toContain("evidence.generate_package");
    expect(H.deliveriesCreated).toHaveLength(1);
  });

  it("recording a DOWNLOAD uses the weaker capability, not the export one", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/deliveries/${DELIVERY}/download`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(H.seenPermissions).toContain("evidence.download_package");
  });
});

describe("Trust residue — Exchange export: step-up", () => {
  it("minting is TARGET-BOUND step-up gated on the export purpose", async () => {
    await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(H.stepUpCalls).toEqual([
      {
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: PKG,
      },
    ]);
  });

  it("an unsatisfied challenge denies and mints NOTHING", async () => {
    H.stepUpSent = true;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("STEP_UP_REQUIRED");
    expect(H.signedUrlsMinted).toEqual([]);
    expect(H.webhooks).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it("delivery creation is step-up gated on the same purpose and target", async () => {
    await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/deliveries`,
      headers: json,
      payload: { recipientEmail: "recipient@example.invalid" },
    });
    expect(H.stepUpCalls).toEqual([
      {
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: PKG,
      },
    ]);
  });

  it("an unsatisfied challenge sends NO delivery to the external recipient", async () => {
    H.stepUpSent = true;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/deliveries`,
      headers: json,
      payload: { recipientEmail: "recipient@example.invalid" },
    });
    expect(res.statusCode).toBe(401);
    expect(H.deliveriesCreated).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it("capability denial precedes step-up — a denied caller is never even challenged", async () => {
    H.authAllowed = false;
    await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(H.stepUpCalls).toEqual([]);
  });

  it("recording a download is NOT step-up gated — it mints and exposes nothing new", async () => {
    await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/deliveries/${DELIVERY}/download`,
      headers: json,
      payload: {},
    });
    expect(H.stepUpCalls).toEqual([]);
  });

  it("a satisfied challenge performs EXACTLY ONE canonical mutation", async () => {
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toEqual(["generateSignedUrl"]);
    expect(H.signedUrlsMinted).toHaveLength(1);
  });

  it("no active workspace denies before any gate, capability or challenge", async () => {
    H.currentWorkspaceId = null;
    const res = await lifecycle.inject({
      method: "POST",
      url: `/v1/exchange/packages/${PKG}/sign-url`,
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(H.seenPermissions).toEqual([]);
    expect(H.stepUpCalls).toEqual([]);
    expect(H.signedUrlsMinted).toEqual([]);
  });
});
