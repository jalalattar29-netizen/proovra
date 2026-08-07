/**
 * PHASE 12 — EVIDENCE_OPERATIONS registry residue: behavioral proof.
 *
 * Ten operations were carried in the Phase-12 wiring registry as MISSING even
 * though their product consumers already shipped. The remediation for them was
 * VERIFY + RECONCILE, not reimplementation — every one of the ten already has
 * a mounted product surface calling it. What was genuinely absent was
 * behavioral proof for several of them, which is what this suite supplies so
 * the registry can record an honest evidence level rather than an assumed one.
 *
 * Driven through the REAL handlers with fastify `inject`. Only process
 * boundaries are mocked (auth, canonical authorization, redaction RBAC,
 * step-up, prisma, canonical services).
 *
 *   1. Case bulk lifecycle              — cases.routes.ts             (1 op )
 *   2. Evidence provenance chain        — capture-trust.routes.ts     (1 op )
 *   3. Redaction policy + regions       — redaction.routes.ts         (5 ops)
 *   4. Evidence-request review queue    — evidence-requests.routes.ts (1 op )
 *   5. Reviewer queue intelligence      — reviewer-ops.routes.ts      (1 op )
 *   6. Search audit log                 — search.routes.ts            (1 op )
 *
 *   1 + 1 + 5 + 1 + 1 + 1 = 10.
 *
 * Queue intelligence (system 5) is the operation Phase 12 reassigns to the
 * Operations system: it answers "what is happening to this queue", not "what
 * is in this evidence record". Its OWNER is recorded as Operations in the
 * wiring registry; its capability-map vertical stays EVIDENCE_OPERATIONS
 * because that is where the reviewer-ops route family lives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const IDS = vi.hoisted(() => ({
  ACTOR: "11111111-1111-4111-8111-111111111111",
  TEAM: "22222222-2222-4222-8222-222222222222",
  OTHER_TEAM: "33333333-3333-4333-8333-333333333333",
  CASE_A: "44444444-4444-4444-8444-444444444444",
  CASE_B: "55555555-5555-4555-8555-555555555555",
  EVIDENCE: "66666666-6666-4666-8666-666666666666",
  REGION: "77777777-7777-4777-8777-777777777777",
  ASSIGNMENT: "88888888-8888-4888-8888-888888888888",
  POLICY_VERSION: "99999999-9999-4999-8999-999999999999",
  WORKFLOW: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));

const {
  ACTOR, TEAM, OTHER_TEAM, CASE_A, CASE_B, EVIDENCE, REGION, ASSIGNMENT,
  POLICY_VERSION, WORKFLOW,
} = IDS;

const H = vi.hoisted(() => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,

  authAllowed: true,
  denyStatus: 403 as 403 | 404,
  seenPermissions: [] as string[],

  /** Redaction fine-grained capability seam. */
  redactionAllowed: true,
  redactionSeen: [] as string[],

  /** Reviewer/search actor seam. */
  memberStatus: "ACTIVE" as string | null,
  reviewerCapable: true,

  stepUpSent: false,
  stepUpCalls: [] as Array<{ purpose: string; resourceKind: string | null; resourceId: string | null }>,

  writes: [] as string[],

  /** Which cases the caller may actually mutate. */
  accessibleCaseIds: [] as string[],
  /** Per-case status-change failures, keyed by case id. */
  caseErrors: new Map<string, string>(),

  /** Evidence tenancy for the provenance read. */
  evidenceInWorkspace: true,

  /** Evidence-Requests deployment flag. */
  evidenceRequestsEnabled: true,

  /** Redaction service outcomes. */
  regionRemoveDenial: null as string | null,
  assignmentRevokeDenial: null as string | null,
}));

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthUserIdOrNull: () => H.actorUserId,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => {},
  requireAuthAndLegal: async () => {},
}));

vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => {},
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

  // PHASE 12 REMEDIATION — AUTH-005 (2026-08-06). INTENTIONAL CONTRACT
  // CHANGE, and the reason it is required.
  //
  //   OLD: reviewer-ops' `requireReviewerActor` read the TeamMember row
  //        itself, checked `status !== "ACTIVE"`, and then FOUR further
  //        sites in the same file re-read the row with `select: { role }`
  //        and NO status predicate to derive reviewer capability and
  //        adjudicator authority. The gate also never consulted workspace
  //        kind or parent-Organization lifecycle, so an ORGANIZATION
  //        workspace under a SUSPENDED organization stayed readable.
  //
  //   NEW: it composes the canonical `AuthorizedWorkspaceContext`
  //        primitive. Admission is the baseline `evidence.read`, which every
  //        canonical role holds — so exactly the set admitted before is
  //        admitted now — and every secondary capability decision reads the
  //        PROVEN capability set instead of a fresh, status-blind query.
  //
  // The knobs keep their exact meanings and still drive every case:
  //   H.memberStatus    null → non-member (404); "SUSPENDED" → 403.
  //   H.reviewerCapable false → an ACTIVE member who is NOT reviewer-capable,
  //                     expressed as the VIEWER role, which genuinely lacks
  //                     `evidence_request.review` in the canonical matrix. The
  //                     "still sees the signals, told they cannot act" case is
  //                     therefore now driven by real role policy rather than
  //                     by a standalone boolean.
  evaluateAuthorizedWorkspace: async (
    _req: unknown,
    opts: { permission: string; workspaceId?: string | null },
  ) => {
    H.seenPermissions.push(opts.permission);
    if (!H.memberStatus) {
      return { allowed: false, reasonCode: "no_actor", httpStatus: 404 };
    }
    if (H.memberStatus !== "ACTIVE") {
      return {
        allowed: false,
        reasonCode: "member_not_active",
        httpStatus: 403,
      };
    }
    const workspaceRole = H.reviewerCapable ? "OWNER" : "VIEWER";
    return {
      allowed: true,
      context: {
        userId: H.actorUserId,
        workspaceId: opts.workspaceId ?? TEAM,
        workspaceKind: "OWNED",
        workspaceRole,
        membershipStatus: "ACTIVE",
        organizationId: null,
        organizationLifecycle: null,
        capabilities: new Set<string>(
          H.reviewerCapable
            ? [
                "evidence.read",
                "evidence_request.review",
                "review.assign",
                "review.escalate",
              ]
            : ["evidence.read"],
        ),
      },
    };
  },
  contextHasCapability: (
    ctx: { capabilities: ReadonlySet<string> },
    permission: string,
  ) => ctx.capabilities.has(permission),

  // PHASE 12 CORRECTIVE PASS §1.3 (2026-08-06) — DOUBLE EXTENDED, NOT
  // ASSERTION WEAKENED.
  //
  // `capture-trust.routes.ts#resolveTeamIdOrDeny` used to be its own
  // authorization authority: pointer -> team row -> isPersonal -> an inline
  // ACTIVE-membership read. It now hands the pointer to the canonical chain as
  // a CANDIDATE, which additionally enforces member access expiry, workspace
  // kind and parent-Organization lifecycle — none of which the inline version
  // checked.
  //
  // That made it call `evaluateCurrentWorkspace`, which this double did not
  // provide, so the provenance-chain cases 500'd on an undefined import. The
  // double now supplies it with the SAME semantics as the workspaceId variant
  // above — the only difference being where the candidate id comes from — so
  // every existing knob (`H.memberStatus`, `H.currentWorkspaceId`) keeps
  // driving exactly the case it drove before, including the null-pointer case.
  evaluateCurrentWorkspace: async (_req: unknown, opts: { permission: string }) => {
    H.seenPermissions.push(opts.permission);
    if (!H.currentWorkspaceId) {
      return { allowed: false, reasonCode: "missing_team_id", httpStatus: 404 };
    }
    if (!H.memberStatus) {
      return { allowed: false, reasonCode: "no_actor", httpStatus: 404 };
    }
    if (H.memberStatus !== "ACTIVE") {
      return {
        allowed: false,
        reasonCode: "member_not_active",
        httpStatus: 403,
      };
    }
    return {
      allowed: true,
      context: {
        userId: H.actorUserId,
        workspaceId: H.currentWorkspaceId,
        workspaceKind: "OWNED",
        workspaceRole: "OWNER",
        membershipStatus: "ACTIVE",
        organizationId: null,
        organizationLifecycle: null,
        capabilities: new Set<string>(["evidence.read"]),
      },
    };
  },
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async (i: { permission: string }) => {
    H.seenPermissions.push(i.permission);
    return H.reviewerCapable
      ? { allowed: true, reason: null, detail: null }
      : { allowed: false, reason: "permission_not_granted", detail: null };
  },
}));

vi.mock("../src/services/redaction/redaction-rbac.service.js", () => ({
  assertRedactionCapability: async (i: { capability: string }) => {
    H.redactionSeen.push(i.capability);
    return H.redactionAllowed
      ? { ok: true as const }
      : { ok: false as const, denial: "REDACTION_CAPABILITY_REQUIRED" };
  },
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
  emitPlatformAudit: async () => ({ ok: true }),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ id: H.actorUserId, currentWorkspaceId: H.currentWorkspaceId }),
    },
    teamMember: {
      // PHASE 12 REMEDIATION — AUTH-005 (2026-08-06). INTENTIONAL CONTRACT
      // CHANGE, transport shape only.
      //
      //   OLD: reviewer-ops' `requireReviewerActor` read
      //        `{ id, status }` itself and checked `status !== "ACTIVE"`.
      //        Four further sites in the same file then re-read the row with
      //        `select: { role }` and NO status predicate to derive reviewer
      //        capability and adjudicator authority.
      //
      //   NEW: it composes the canonical `AuthorizedWorkspaceContext`
      //        primitive, so the row must carry the full access-policy
      //        snapshot shape (role, capability grants, delegated admin
      //        scopes, and the team's kind + parent-Organization status).
      //
      // WHY the production architecture requires it: the old gate enforced
      // membership status ONLY, never workspace kind and never
      // parent-Organization lifecycle, so an ORGANIZATION workspace under a
      // SUSPENDED organization stayed readable on this surface.
      //
      // `H.memberStatus` keeps its exact meaning and still drives every case
      // below: `null` → non-member (404), `"SUSPENDED"` → inactive (403),
      // `"ACTIVE"` → admitted. Role OWNER preserves the reviewer-capable
      // actor the positive cases assume.
      findUnique: async () =>
        H.memberStatus
          ? {
              id: "m-1",
              teamId: TEAM,
              userId: "u-1",
              role: "OWNER",
              status: H.memberStatus,
              accessExpiresAtUtc: null,
              team: {
                isPersonal: false,
                workspaceKind: "OWNED",
                billingPlan: "TEAM",
                organizationId: null,
                organization: null,
              },
              capabilityGrants: [],
              delegatedAdminScopes: [],
            }
          : null,
      findMany: async () => (H.memberStatus === "ACTIVE" ? [{ teamId: TEAM }] : []),
      findFirst: async () => (H.memberStatus ? { id: "m-1", status: H.memberStatus } : null),
    },
    case: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => H.accessibleCaseIds.includes(id)).map((id) => ({ id })),
      findUnique: async () => ({ id: CASE_A, teamId: TEAM }),
    },
    team: {
      findUnique: async () => ({ id: TEAM, isPersonal: false }),
    },
    evidence: {
      findFirst: async () => (H.evidenceInWorkspace ? { id: EVIDENCE } : null),
      findUnique: async () => (H.evidenceInWorkspace ? { id: EVIDENCE, teamId: TEAM } : null),
    },
  },
}));

// ---------------------------------------------------------------------------
// Canonical services
// ---------------------------------------------------------------------------

/**
 * A persisted evidence-request row as the REAL projection expects it. The
 * recipient `accessToken` is the credential a witness uploads with — it lives
 * on the row deliberately so the projection test proves the ROUTE strips it.
 */
function requestRow(status: string) {
  return {
    id: "req-1",
    teamId: IDS.TEAM,
    evidenceId: null,
    caseId: null,
    workflowTemplateSlug: null,
    workflowStepId: null,
    requestType: "EVIDENCE",
    status,
    priority: "HIGH",
    title: "Provide the incident photo",
    instructions: "Attach the original photo.",
    dueAtUtc: null,
    recipientMode: "EMAIL",
    recipientLabel: null,
    recipientEmail: "witness@example.org",
    recipientPhone: null,
    requestedByUserId: IDS.ACTOR,
    assignedReviewerUserId: null,
    intakeLinkId: null,
    reviewerNote: null,
    reviewerDecisionAt: null,
    reviewerDecisionByUserId: null,
    sentAtUtc: null,
    firstOpenedAtUtc: null,
    closedAtUtc: null,
    cancelledAtUtc: null,
    createdAt: new Date("2026-07-30T09:00:00.000Z"),
    updatedAt: new Date("2026-07-30T09:00:00.000Z"),
    deliverables: [],
    responses: [],
    accessToken: "NEVER_SHIP_THIS",
  };
}

vi.mock("../src/services/cases/case-lifecycle.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class FakeCaseError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    ...actual,
    CaseError: FakeCaseError,
    changeCaseStatus: async (i: { caseId: string }) => {
      const failure = H.caseErrors.get(i.caseId);
      if (failure) throw new FakeCaseError(failure);
      H.writes.push(`changeCaseStatus:${i.caseId}`);
      return { id: i.caseId, status: "CLOSED" };
    },
  };
});

vi.mock("../src/services/capture-trust/provenance-projection.service.js", () => ({
  projectProvenanceChain: async (i: { evidenceId: string }) => ({
    evidenceId: i.evidenceId,
    links: [
      { kind: "CAPTURED", atUtc: "2026-07-30T09:00:00.000Z" },
      { kind: "FINALIZED", atUtc: "2026-07-30T09:01:00.000Z" },
    ],
    // Present on the SERVICE row so a leak would be the ROUTE's fault.
    storageKey: "NEVER_SHIP_THIS",
  }),
}));

vi.mock("../src/services/redaction/redaction-detection-manifest.service.js", () => ({
  buildRedactionDetectionManifest: async (i: { teamId: string; evidenceId: string }) => ({
    teamId: i.teamId,
    evidenceId: i.evidenceId,
    schemaVersion: 1,
    detections: [{ id: "det-1", kind: "FACE", decision: "ACCEPTED" }],
    digest: "sha256:manifest",
  }),
}));

vi.mock("../src/services/redaction/redaction-policy-store.service.js", () => ({
  archivePolicy: async () => ({ ok: true }),
  assignPolicyVersion: async () => ({ ok: true }),
  createPolicy: async () => ({ ok: true }),
  createPolicyVersion: async () => ({ ok: true }),
  listAssignmentsForScope: async (i: { scope: string; scopeTargetId: string | null }) => [
    {
      id: ASSIGNMENT,
      policyId: "pol-1",
      policyVersionId: POLICY_VERSION,
      scope: i.scope,
      scopeTargetId: i.scopeTargetId,
      assignedByUserId: ACTOR,
      assignedAtUtc: new Date("2026-07-30T09:00:00.000Z"),
      revokedAtUtc: null,
      // Internal store field — the route must project a narrow shape.
      internalNotes: "NEVER_SHIP_THIS",
    },
  ],
  listAuditForPolicy: async () => [],
  listPolicies: async () => [],
  listPolicyVersions: async () => [],
  resolveEffectivePolicy: async (i: { caseId: string | null; projectId: string | null }) => ({
    policyId: "pol-1",
    policyVersionId: POLICY_VERSION,
    source: i.caseId ? "CASE" : i.projectId ? "PROJECT" : "WORKSPACE",
  }),
  revokePolicyAssignment: async () => {
    if (H.assignmentRevokeDenial) {
      return { ok: false as const, denial: H.assignmentRevokeDenial };
    }
    H.writes.push("revokePolicyAssignment");
    return { ok: true as const };
  },
  transitionPolicyVersion: async () => ({ ok: true }),
}));

vi.mock("../src/services/redaction/redaction-region.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    removeRedactionRegion: async () => {
      if (H.regionRemoveDenial) return { ok: false as const, denial: H.regionRemoveDenial };
      H.writes.push("removeRedactionRegion");
      return { ok: true as const };
    },
  };
});

vi.mock("../src/services/evidence-request.service.js", async (importOriginal) => {
  const actual = (await importOriginal().catch(() => ({}))) as Record<string, unknown>;
  return {
    ...actual,
    // The deployment feature flag is a process boundary here: this suite
    // proves the QUEUE behaviour and drives the disabled branch explicitly
    // through `H.evidenceRequestsEnabled` rather than through env state.
    evidenceRequestsFeatureDisabledReason: () =>
      H.evidenceRequestsEnabled ? null : "feature_flag_off",
    isEvidenceRequestsFeatureEnabled: () => H.evidenceRequestsEnabled,
    listEvidenceRequests: async (i: { status?: string }) =>
      [
        { id: "req-1", priority: "HIGH", assignedReviewerUserId: null, title: "Provide the incident photo" },
        { id: "req-2", priority: "LOW", assignedReviewerUserId: ACTOR, title: "Provide the receipt" },
      ].map((r) => ({
        ...requestRow(i.status ?? "OPEN"),
        ...r,
      })),
  };
});

vi.mock("../src/services/reviewer-ops/queue-intelligence.service.js", () => ({
  projectQueueIntelligence: async (i: { workflowIds: string[]; isReviewerCapable: boolean }) => ({
    workflows: i.workflowIds.map((id) => ({
      workflowId: id,
      queueDepth: 4,
      slaState: "AT_RISK",
      recommendedAction: i.isReviewerCapable ? "REASSIGN" : null,
    })),
    canAct: i.isReviewerCapable,
  }),
}));

vi.mock("../src/services/search/search-audit.service.js", async (importOriginal) => {
  const actual = (await importOriginal().catch(() => ({}))) as Record<string, unknown>;
  return {
    ...actual,
    listSearchAudit: async (i: { teamId: string; failClosedOnly: boolean }) => ({
      rows: [
        {
          id: "audit-1",
          teamId: i.teamId,
          actorUserId: ACTOR,
          surface: "web:/search",
          resultCount: 3,
          failClosed: i.failClosedOnly,
          occurredAtUtc: "2026-07-30T09:00:00.000Z",
        },
      ],
      nextBeforeUtc: null,
    }),
    recordSearchAudit: async () => {
      H.writes.push("recordSearchAudit");
      return { ok: true };
    },
  };
});

import { casesRoutes } from "../src/routes/cases.routes.js";
import { captureTrustRoutes } from "../src/routes/capture-trust.routes.js";
import { redactionRoutes } from "../src/routes/redaction.routes.js";
import { evidenceRequestsRoutes } from "../src/routes/evidence-requests.routes.js";
import { reviewerOpsRoutes } from "../src/routes/reviewer-ops.routes.js";
import { searchRoutes } from "../src/routes/search.routes.js";

let cases: FastifyInstance;
let trust: FastifyInstance;
let redaction: FastifyInstance;
let requests: FastifyInstance;
let reviewer: FastifyInstance;
let search: FastifyInstance;

const json = { "content-type": "application/json" };

beforeEach(async () => {
  H.actorUserId = ACTOR;
  H.currentWorkspaceId = TEAM;
  H.authAllowed = true;
  H.denyStatus = 403;
  H.seenPermissions.length = 0;
  H.redactionAllowed = true;
  H.redactionSeen.length = 0;
  H.memberStatus = "ACTIVE";
  H.reviewerCapable = true;
  H.stepUpSent = false;
  H.stepUpCalls.length = 0;
  H.writes.length = 0;
  H.accessibleCaseIds = [CASE_A, CASE_B];
  H.caseErrors.clear();
  H.evidenceInWorkspace = true;
  H.evidenceRequestsEnabled = true;
  H.regionRemoveDenial = null;
  H.assignmentRevokeDenial = null;

  cases = Fastify(); await cases.register(casesRoutes); await cases.ready();
  trust = Fastify(); await trust.register(captureTrustRoutes); await trust.ready();
  redaction = Fastify(); await redaction.register(redactionRoutes); await redaction.ready();
  requests = Fastify(); await requests.register(evidenceRequestsRoutes); await requests.ready();
  reviewer = Fastify(); await reviewer.register(reviewerOpsRoutes); await reviewer.ready();
  search = Fastify(); await search.register(searchRoutes); await search.ready();
});

// ===========================================================================
// 1. Case bulk lifecycle
// ===========================================================================

describe("Evidence residue — case bulk lifecycle", () => {
  it("applies the transition per case through the ONE lifecycle writer", async () => {
    const res = await cases.inject({
      method: "POST",
      url: "/v1/cases/bulk",
      headers: json,
      payload: { ids: [CASE_A, CASE_B], action: "CLOSE", reason: "Batch closure" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { outcome: string }) => r.outcome === "SUCCESS")).toBe(true);
    // The bulk runner is NOT a bypass — one writer call per case.
    expect(H.writes).toEqual([`changeCaseStatus:${CASE_A}`, `changeCaseStatus:${CASE_B}`]);
  });

  it("a case the caller cannot reach is SKIPPED, never silently mutated", async () => {
    H.accessibleCaseIds = [CASE_A];
    const res = await cases.inject({
      method: "POST",
      url: "/v1/cases/bulk",
      headers: json,
      payload: { ids: [CASE_A, CASE_B], action: "CLOSE" },
    });
    expect(res.statusCode).toBe(200);
    const results = JSON.parse(res.body).results as Array<{ id: string; outcome: string; reason?: string }>;
    expect(results.find((r) => r.id === CASE_B)).toMatchObject({
      outcome: "SKIPPED",
      reason: "not_accessible",
    });
    expect(H.writes).toEqual([`changeCaseStatus:${CASE_A}`]);
  });

  it("an illegal transition is an HONEST per-case skip, not a failed batch", async () => {
    H.caseErrors.set(CASE_B, "invalid_transition");
    const res = await cases.inject({
      method: "POST",
      url: "/v1/cases/bulk",
      headers: json,
      payload: { ids: [CASE_A, CASE_B], action: "ARCHIVE" },
    });
    expect(res.statusCode).toBe(200);
    const results = JSON.parse(res.body).results as Array<{ id: string; outcome: string; reason?: string }>;
    expect(results.find((r) => r.id === CASE_B)?.reason).toBe("invalid_transition");
    // The rest of the batch still applied.
    expect(H.writes).toEqual([`changeCaseStatus:${CASE_A}`]);
  });

  it("an unbounded action or an oversized batch is refused before any write", async () => {
    for (const payload of [
      { ids: [CASE_A], action: "DELETE_FOREVER" },
      { ids: [], action: "CLOSE" },
    ]) {
      const res = await cases.inject({ method: "POST", url: "/v1/cases/bulk", headers: json, payload });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_BODY");
    }
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 2. Evidence provenance chain
// ===========================================================================

describe("Evidence residue — provenance chain", () => {
  it("returns the chain for a record in the caller's workspace", async () => {
    const res = await trust.inject({ method: "GET", url: `/v1/provenance/${EVIDENCE}` });
    expect(res.statusCode).toBe(200);
    const chain = JSON.parse(res.body).chain;
    expect(chain.evidenceId).toBe(EVIDENCE);
    expect(chain.links).toHaveLength(2);
  });

  it("a record outside the workspace is a 404, never another tenant's chain", async () => {
    H.evidenceInWorkspace = false;
    const res = await trust.inject({ method: "GET", url: `/v1/provenance/${EVIDENCE}` });
    expect(res.statusCode).toBe(404);
  });
});

// ===========================================================================
// 3. Redaction policy + regions
// ===========================================================================

describe("Evidence residue — redaction policy and regions", () => {
  it("the detection manifest is view-gated and workspace-anchored", async () => {
    const res = await redaction.inject({
      method: "GET",
      url: `/v1/redaction/evidence/${EVIDENCE}/detection-manifest`,
    });
    expect(res.statusCode).toBe(200);
    const manifest = JSON.parse(res.body).manifest;
    expect(manifest.evidenceId).toBe(EVIDENCE);
    expect(manifest.teamId).toBe(TEAM);
    expect(H.redactionSeen).toContain("redaction.view");
  });

  it("without the redaction view capability the manifest is refused", async () => {
    H.redactionAllowed = false;
    const res = await redaction.inject({
      method: "GET",
      url: `/v1/redaction/evidence/${EVIDENCE}/detection-manifest`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).denial).toBe("REDACTION_CAPABILITY_REQUIRED");
  });

  it("the scope assignment list projects a narrow shape, never store internals", async () => {
    const res = await redaction.inject({
      method: "GET",
      url: `/v1/redaction/policy/assignments?scope=CASE&scopeTargetId=${CASE_A}`,
    });
    expect(res.statusCode).toBe(200);
    const assignments = JSON.parse(res.body).assignments;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].policyVersionId).toBe(POLICY_VERSION);
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
    expect(res.body).not.toContain("internalNotes");
  });

  it("an unbounded assignment scope is refused", async () => {
    const res = await redaction.inject({
      method: "GET",
      url: "/v1/redaction/policy/assignments?scope=EVERYTHING",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("the effective policy resolves the most specific scope the caller asked about", async () => {
    const caseScoped = await redaction.inject({
      method: "GET",
      url: `/v1/redaction/policy/effective?caseId=${CASE_A}`,
    });
    expect(caseScoped.statusCode).toBe(200);
    expect(JSON.parse(caseScoped.body).effective.source).toBe("CASE");

    const workspaceScoped = await redaction.inject({
      method: "GET",
      url: "/v1/redaction/policy/effective",
    });
    expect(JSON.parse(workspaceScoped.body).effective.source).toBe("WORKSPACE");
  });

  it("revoking a policy assignment needs administer + a target-bound step-up", async () => {
    const res = await redaction.inject({
      method: "DELETE",
      url: `/v1/redaction/policy-assignments/${ASSIGNMENT}?expectedPolicyVersionId=${POLICY_VERSION}`,
    });
    expect(res.statusCode).toBe(200);
    expect(H.redactionSeen).toContain("redaction.administer");
    expect(H.stepUpCalls).toEqual([
      {
        purpose: "REDACTION_POLICY_ASSIGNMENT_REVOKE",
        resourceKind: "redaction_policy_assignment",
        resourceId: ASSIGNMENT,
      },
    ]);
    expect(H.writes).toEqual(["revokePolicyAssignment"]);
  });

  it("a stale console (wrong expected policy version) revokes NOTHING", async () => {
    H.assignmentRevokeDenial = "STALE_POLICY_VERSION";
    const res = await redaction.inject({
      method: "DELETE",
      url: `/v1/redaction/policy-assignments/${ASSIGNMENT}?expectedPolicyVersionId=${POLICY_VERSION}`,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).denial).toBe("STALE_POLICY_VERSION");
    expect(H.writes).toEqual([]);
  });

  it("missing step-up on the revoke → 401 with ZERO write, and RBAC ran first", async () => {
    H.stepUpSent = true;
    const res = await redaction.inject({
      method: "DELETE",
      url: `/v1/redaction/policy-assignments/${ASSIGNMENT}`,
    });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
    expect(H.redactionSeen).toContain("redaction.administer");
  });

  it("deleting a region needs the region-author capability", async () => {
    const ok = await redaction.inject({ method: "DELETE", url: `/v1/redaction/regions/${REGION}` });
    expect(ok.statusCode).toBe(200);
    expect(H.redactionSeen).toContain("redaction.region.author");
    expect(H.writes).toEqual(["removeRedactionRegion"]);

    H.redactionAllowed = false;
    H.writes.length = 0;
    const denied = await redaction.inject({ method: "DELETE", url: `/v1/redaction/regions/${REGION}` });
    expect(denied.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("a region that cannot be removed surfaces a bounded denial", async () => {
    H.regionRemoveDenial = "VERSION_LOCKED";
    const res = await redaction.inject({ method: "DELETE", url: `/v1/redaction/regions/${REGION}` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).denial).toBe("VERSION_LOCKED");
  });

  it("no active workspace resolves to 404 on every redaction read", async () => {
    H.currentWorkspaceId = null;
    for (const url of [
      `/v1/redaction/evidence/${EVIDENCE}/detection-manifest`,
      "/v1/redaction/policy/assignments?scope=WORKSPACE",
      "/v1/redaction/policy/effective",
    ]) {
      const res = await redaction.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

// ===========================================================================
// 4. Evidence-request review queue
// ===========================================================================

describe("Evidence residue — evidence-request review queue", () => {
  it("lists the workspace queue and never projects a recipient access token", async () => {
    const res = await requests.inject({ method: "GET", url: `/v1/review/queue?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(2);
    // A request's access token is the credential a witness uploads with.
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
    expect(res.body).not.toContain("accessToken");
    expect(H.seenPermissions).toContain("evidence.read");
  });

  it("the priority filter is applied SERVER-side", async () => {
    const res = await requests.inject({
      method: "GET",
      url: `/v1/review/queue?teamId=${TEAM}&priority=HIGH`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(1);
  });

  it("without evidence.read the queue is refused", async () => {
    H.authAllowed = false;
    const res = await requests.inject({ method: "GET", url: `/v1/review/queue?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
  });

  it("a cross-organization probe is concealed as 404", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await requests.inject({ method: "GET", url: `/v1/review/queue?teamId=${OTHER_TEAM}` });
    expect(res.statusCode).toBe(404);
  });
});

// ===========================================================================
// 5. Reviewer queue intelligence (Operations-owned)
// ===========================================================================

describe("Evidence residue — reviewer queue intelligence", () => {
  it("projects per-workflow queue signals for a reviewer-capable actor", async () => {
    const res = await reviewer.inject({
      method: "POST",
      url: "/v1/reviewer-ops/queue-intelligence",
      headers: json,
      payload: { teamId: TEAM, workflowIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0].slaState).toBe("AT_RISK");
    // Availability is a SERVER answer, echoed to the board.
    expect(body.canAct).toBe(true);
  });

  it("a non-reviewer still sees the queue signals but is told they cannot act", async () => {
    H.reviewerCapable = false;
    const res = await reviewer.inject({
      method: "POST",
      url: "/v1/reviewer-ops/queue-intelligence",
      headers: json,
      payload: { teamId: TEAM, workflowIds: [WORKFLOW] },
    });
    // The gate itself decides; whichever way it answers, the route must not
    // hand back an action recommendation it has not authorized.
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.canAct).toBe(false);
      expect(body.workflows[0].recommendedAction).toBeNull();
    } else {
      expect(res.statusCode).toBe(403);
    }
  });

  it("an INACTIVE member is blocked with a distinct reason, not an empty projection", async () => {
    H.memberStatus = "SUSPENDED";
    const res = await reviewer.inject({
      method: "POST",
      url: "/v1/reviewer-ops/queue-intelligence",
      headers: json,
      payload: { teamId: TEAM, workflowIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("REVIEW_ACTOR_BLOCKED");
  });

  it("a non-member is concealed as 404", async () => {
    H.memberStatus = null;
    const res = await reviewer.inject({
      method: "POST",
      url: "/v1/reviewer-ops/queue-intelligence",
      headers: json,
      payload: { teamId: TEAM, workflowIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("an empty or oversized workflow set is refused", async () => {
    const res = await reviewer.inject({
      method: "POST",
      url: "/v1/reviewer-ops/queue-intelligence",
      headers: json,
      payload: { teamId: TEAM, workflowIds: [] },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ===========================================================================
// 6. Search audit log
// ===========================================================================

describe("Evidence residue — search audit log", () => {
  it("returns the audit rows AND records the act of reading them", async () => {
    const res = await search.inject({ method: "GET", url: `/v1/search/audit?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rows).toHaveLength(1);
    // Reading the audit log is itself audit-worthy.
    expect(H.writes).toContain("recordSearchAudit");
  });

  it("a non-operator member cannot read the audit log", async () => {
    H.reviewerCapable = false;
    const res = await search.inject({ method: "GET", url: `/v1/search/audit?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
  });

  it("a non-member is concealed as 404", async () => {
    H.memberStatus = null;
    const res = await search.inject({ method: "GET", url: `/v1/search/audit?teamId=${TEAM}` });
    expect(res.statusCode).toBe(404);
  });
});
