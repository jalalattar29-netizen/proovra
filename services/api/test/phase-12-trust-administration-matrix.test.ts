/**
 * PHASE 12 VERTICAL C — TRUST_ADMINISTRATION production-route matrix.
 *
 * Behavioral tests through the REAL `trustAndGovernanceRoutes` and
 * `productAndLifecycleRoutes` handlers via fastify `inject`. Only the
 * process boundaries are mocked (auth, canonical authorization, step-up,
 * prisma, and the canonical trust/exchange services) — the routes' own
 * composition (authorize → step-up → canonical service → audit) runs for
 * real.
 *
 * Covered product systems:
 *   1. Trust authoring console  — seed / drift / security claims.
 *   2. Status publication        — incidents, incident updates, maintenance.
 *   3. Verification package preview + verification references.
 *   4. Integration delivery history.
 *
 * Per system: happy path, cross-organization denial, inactive membership,
 * missing capability, stale version, no-mutation-on-denial, safe projection
 * (asserted against the RAW response body string), and anti-enumeration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The product-and-lifecycle plugin transitively imports the S3 storage module,
// which validates its credentials at import time. These are inert test values —
// no S3 client is ever exercised by this suite.
vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const H = vi.hoisted(() => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,
  // Canonical authorization seam. `denyStatus` reproduces each denial family:
  //   403 → missing capability
  //   404 → cross-Organization probe / inactive membership (anti-enumeration)
  authAllowed: true,
  denyStatus: 403 as 403 | 404,
  seenPermissions: [] as string[],
  // Step-up seam.
  stepUpSent: false,
  stepUpCalls: [] as Array<{ purpose: string; resourceKind: string | null; resourceId: string | null }>,
  // Every canonical write the routes performed. A denial MUST leave this empty.
  writes: [] as string[],
  // Canonical service outcomes.
  incidentReused: false,
  incidentUpdateResult: { ok: true, state: "MONITORING" } as
    | { ok: true; state: string }
    | { ok: false; denial: "NOT_FOUND" }
    | { ok: false; denial: "STALE_STATE"; currentState: string },
  maintenanceResult: { ok: true, id: "mw-1" } as
    | { ok: true; id: string }
    | { ok: false; denial: "INVALID_WINDOW" },
  seedPublishSeen: undefined as boolean | undefined,
  auditCodes: [] as string[],
  // Delivery-history seam.
  deliveryQuerySeen: null as null | {
    teamId: string;
    packageId?: string;
    limit?: number;
    cursorId?: string | null;
  },
}));

const TEAM = "22222222-2222-4222-8222-222222222222";
const INCIDENT = "33333333-3333-4333-8333-333333333333";

vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.actorUserId }));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));

// Delegated-tier preHandlers are a SEPARATE gate from the canonical
// capability check. They are satisfied here so each test isolates the
// `authorizeOrFail` composition the routes gained in this phase.
vi.mock("../src/middleware/require-delegated-tier.js", () => ({
  requireDelegatedTier: () => async () => {},
  requireDelegatedTierAny: () => async () => {},
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    opts: { permission: string },
  ) => {
    H.seenPermissions.push(opts.permission);
    if (!H.authAllowed) {
      if (H.denyStatus === 404) {
        reply.code(404).send({ error: { code: "not_found" } });
      } else {
        reply.code(403).send({ error: { code: "permission_denied" } });
      }
      return null;
    }
    return { actorUserId: H.actorUserId, teamId: TEAM };
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

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ currentWorkspaceId: H.currentWorkspaceId }),
    },
    team: { findFirst: async () => ({ id: TEAM, organizationId: "org-1" }) },
    department: { findFirst: async () => null },
  },
}));

// ---------------------------------------------------------------------------
// Canonical trust services — assert the routes CALL them, never re-implement.
// ---------------------------------------------------------------------------

vi.mock("../src/services/trust/trust-center.service.js", () => ({
  ensureTrustCenterSeed: async (i: { publish?: boolean }) => {
    H.writes.push("ensureTrustCenterSeed");
    H.seedPublishSeen = i.publish;
    return { created: 3, updated: 1 };
  },
  listTrustArticles: async (i: { kind?: string }) => [
    {
      id: "art-internal-1",
      kind: i.kind ?? "TRUST_CENTER",
      slug: "data-handling",
      title: "How we handle your data",
      version: 4,
      // Deliberately present on the SERVICE row so the safe-projection test
      // proves the ROUTE strips them, not the service.
      body: "INTERNAL_ARTICLE_BODY_SHOULD_NEVER_SHIP",
      implementationReferences: ["services/api/src/secret-path.ts"],
    },
  ],
  getTrustArticleBySlug: async () => null,
  listTrustArticleVersions: async () => [],
  upsertTrustArticle: async () => ({ ok: true, articleId: "a", version: 1, state: "DRAFT" }),
}));

vi.mock("../src/services/trust/subprocessor.service.js", () => ({
  ensureSubprocessorSeed: async () => ({ created: 0, updated: 0 }),
  listSubprocessorVersions: async () => [],
  listSubprocessors: async () => [
    {
      id: "sub-internal-1",
      name: "Object storage",
      slug: "object-storage",
      vendor: "ExampleCloud",
      contractRef: "MSA-INTERNAL-9911",
    },
  ],
  upsertSubprocessor: async () => ({ ok: true, subprocessorId: "s", version: 1 }),
}));

vi.mock("../src/services/trust/status-page.service.js", () => ({
  createIncident: async () => {
    H.writes.push("createIncident");
    return { id: INCIDENT, reused: H.incidentReused };
  },
  appendIncidentUpdate: async () => {
    if (H.incidentUpdateResult.ok) H.writes.push("appendIncidentUpdate");
    return H.incidentUpdateResult;
  },
  createMaintenanceWindow: async () => {
    if (H.maintenanceResult.ok) H.writes.push("createMaintenanceWindow");
    return H.maintenanceResult;
  },
  projectStatusPage: async () => ({ components: [], activeIncidents: [] }),
}));

vi.mock("../src/services/trust/trust-drift.service.js", () => ({
  listStaleTrustArticles: async () => [
    {
      id: "art-1",
      kind: "SECURITY",
      slug: "encryption",
      title: "Encryption",
      missingReferences: ["packages/shared/src/gone.ts"],
      lastReferenceCheckAtUtc: "2026-07-01T00:00:00.000Z",
    },
  ],
  markArticleNeedsReview: async () => ({ ok: true }),
  runTrustArticleDriftScan: async () => {
    H.writes.push("runTrustArticleDriftScan");
    return { scanned: 10, current: 9, stale: 1, missingReferenceCount: 2 };
  },
}));

vi.mock("../src/services/trust/security-claim-check.service.js", () => ({
  listSecurityClaimChecks: async () => [
    {
      controlKey: "ENCRYPTION_AT_REST",
      documented: true,
      implemented: true,
      implementationReferencesOk: true,
      confidence: "HIGH",
      evidencePaths: ["services/api/src/crypto.ts"],
      limitation: null,
      ownerUserId: null,
      lastVerifiedAtUtc: "2026-07-01T00:00:00.000Z",
    },
  ],
  runSecurityClaimChecks: async () => {
    H.writes.push("runSecurityClaimChecks");
    return [{ controlKey: "ENCRYPTION_AT_REST" }];
  },
}));

vi.mock("../src/services/trust/trust-verification-manifest.service.js", () => ({
  VERIFICATION_PACKAGE_PREVIEW_KINDS: [
    "trust",
    "governance",
    "methodology",
    "ai-disclosure",
    "subprocessor",
  ] as const,
  buildVerificationPackagePreview: async (i: { kind: string }) => {
    H.writes.push("buildVerificationPackagePreview");
    return { kind: i.kind, schemaVersion: 1, articles: [], digest: "sha256:abc" };
  },
}));

vi.mock("../src/services/trust/trust-and-governance-audit.service.js", () => ({
  emitTrustEvent: async (i: { code: string }) => {
    H.auditCodes.push(i.code);
    return { ok: true };
  },
  emitTrustArticleEvent: async () => ({ ok: true }),
  emitSubprocessorEvent: async () => ({ ok: true }),
  emitStatusIncidentEvent: async () => ({ ok: true }),
  emitAccessReviewDecisionEvent: async () => ({ ok: true }),
}));

// Everything else the trust plugin imports — satisfied so registration works.
vi.mock("../src/services/packaging/entitlement.service.js", () => ({
  assertFeatureEntitlement: async () => ({ ok: true }),
  assertQuotaEntitlement: async () => ({ ok: true }),
  applyProductLine: async () => ({ ok: true, granted: 0 }),
  listEntitlements: async () => [],
  upsertEntitlementGrant: async () => ({ grantId: "g-1" }),
}));

vi.mock("../src/services/exchange/signed-delivery.service.js", () => ({
  listDeliveryActivity: async (i: {
    teamId: string;
    packageId?: string;
    limit?: number;
    cursorId?: string | null;
  }) => {
    H.deliveryQuerySeen = i;
    return {
      deliveries: [
        {
          id: "del-1",
          packageId: "pkg-1",
          recipientEmail: "counsel@example.org",
          recipientOrgSlug: null,
          channel: "SIGNED_URL",
          deliveredAtUtc: "2026-07-01T00:00:00.000Z",
          downloadedAtUtc: null,
          verifiedAtUtc: null,
          state: "RECORDED",
        },
      ],
      nextCursor: "del-1",
    };
  },
  // PHASE 13 §4 (2026-08-17) — the emitTransferVerificationEvent stub was
  // removed with the function it stubbed. It never asserted anything; it existed
  // only to keep this module mock shape-complete, and the v1 preservation
  // manifest cited it as evidence that the writer was covered by tests.
  verifySignedDeliveryToken: async () => ({ ok: true }),
}));

import { trustAndGovernanceRoutes } from "../src/routes/trust-and-governance.routes.js";
import { productAndLifecycleRoutes } from "../src/routes/product-and-lifecycle.routes.js";

let app: FastifyInstance;
let productApp: FastifyInstance;

beforeEach(async () => {
  H.authAllowed = true;
  H.denyStatus = 403;
  H.currentWorkspaceId = TEAM;
  H.stepUpSent = false;
  H.stepUpCalls.length = 0;
  H.seenPermissions.length = 0;
  H.writes.length = 0;
  H.auditCodes.length = 0;
  H.incidentReused = false;
  H.incidentUpdateResult = { ok: true, state: "MONITORING" };
  H.maintenanceResult = { ok: true, id: "mw-1" };
  H.seedPublishSeen = undefined;
  H.deliveryQuerySeen = null;

  app = Fastify();
  await app.register(trustAndGovernanceRoutes);
  await app.ready();

  productApp = Fastify();
  await productApp.register(productAndLifecycleRoutes);
  await productApp.ready();
});

const json = { "content-type": "application/json" };
const stepUpJson = {
  "content-type": "application/json",
  "x-proovra-step-up-challenge-id": "chal-1",
};

// ---------------------------------------------------------------------------
// 1. Trust authoring console — seed / drift / security claims
// ---------------------------------------------------------------------------

describe("Trust authoring console", () => {
  it("a draft re-seed needs only membership and publishes NOTHING", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/articles/seed",
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.published).toBe(false);
    // The canonical seeder was told NOT to publish.
    expect(H.seedPublishSeen).toBe(false);
    // A draft re-seed is not a publication — no step-up gate fires.
    expect(H.stepUpCalls).toEqual([]);
    expect(H.seenPermissions).toContain("governance.policy.read");
  });

  it("a PUBLISHING re-seed escalates to the manage capability + target-bound step-up", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/articles/seed",
      headers: stepUpJson,
      payload: { publish: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).published).toBe(true);
    expect(H.seedPublishSeen).toBe(true);
    expect(H.seenPermissions).toContain("governance.policy.manage");
    // Bound to (TRUST_ARTICLE_SEED, workspace) — an approval for any other
    // resource cannot be spent here.
    expect(H.stepUpCalls).toEqual([
      { purpose: "TRUST_CONTENT_PUBLISH", resourceKind: "TRUST_ARTICLE_SEED", resourceId: TEAM },
    ]);
    expect(H.auditCodes).toContain("TRUST_ARTICLE_PUBLISHED");
  });

  it("missing step-up on a publishing re-seed → 401 and ZERO seed write", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/articles/seed",
      headers: json,
      payload: { publish: true },
    });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
    expect(H.auditCodes).toEqual([]);
  });

  it("missing capability → 403 and ZERO seed write", async () => {
    H.authAllowed = false;
    H.denyStatus = 403;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/articles/seed",
      headers: stepUpJson,
      payload: { publish: true },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
    // Authorization ran BEFORE step-up — the gate was never even offered.
    expect(H.stepUpCalls).toEqual([]);
  });

  it("cross-organization probe on the drift scan is concealed as 404 with no scan", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/drift/scan",
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect(H.writes).toEqual([]);
  });

  it("drift scan happy path records a governance evaluation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/drift/scan",
      headers: json,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.stale).toBe(1);
    expect(H.writes).toContain("runTrustArticleDriftScan");
    expect(H.auditCodes).toContain("POLICY_EVALUATED");
  });

  it("inactive membership on the stale read is concealed as 404, list never returned", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await app.inject({ method: "GET", url: "/v1/trust/drift/stale" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("missingReferences");
  });

  it("the stale read requires a capability, not just authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/trust/drift/stale" });
    expect(res.statusCode).toBe(200);
    expect(H.seenPermissions).toContain("governance.policy.read");
  });

  it("security-claim scan requires manage; the register read requires only read", async () => {
    const scan = await app.inject({
      method: "POST",
      url: "/v1/trust/security-claims/scan",
      headers: json,
      payload: {},
    });
    expect(scan.statusCode).toBe(200);
    expect(H.seenPermissions).toContain("governance.policy.manage");
    expect(H.writes).toContain("runSecurityClaimChecks");

    H.seenPermissions.length = 0;
    const read = await app.inject({ method: "GET", url: "/v1/trust/security-claims" });
    expect(read.statusCode).toBe(200);
    expect(H.seenPermissions).toEqual(["governance.policy.read"]);
  });

  it("security-claim register denial returns no control data", async () => {
    H.authAllowed = false;
    const res = await app.inject({ method: "GET", url: "/v1/trust/security-claims" });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("ENCRYPTION_AT_REST");
  });
});

// ---------------------------------------------------------------------------
// 2. Status publication
// ---------------------------------------------------------------------------

describe("Status publication", () => {
  const incidentPayload = {
    title: "Elevated capture latency",
    severity: "MINOR",
    componentKeys: ["API"],
  };

  it("publishes an incident behind capability + target-bound step-up", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents",
      headers: stepUpJson,
      payload: incidentPayload,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).incidentId).toBe(INCIDENT);
    expect(H.writes).toContain("createIncident");
    expect(H.seenPermissions).toContain("governance.policy.manage");
    expect(H.stepUpCalls[0]).toEqual({
      purpose: "STATUS_INCIDENT_PUBLISH",
      resourceKind: "STATUS_INCIDENT",
      resourceId: TEAM,
    });
  });

  it("a retried submit is idempotent — 200 reused, never a duplicate publication", async () => {
    H.incidentReused = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents",
      headers: stepUpJson,
      payload: { ...incidentPayload, externalRef: "PAGERDUTY-77" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reused).toBe(true);
  });

  it("missing capability → 403 with ZERO incident write and no step-up prompt", async () => {
    H.authAllowed = false;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents",
      headers: stepUpJson,
      payload: incidentPayload,
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
    expect(H.stepUpCalls).toEqual([]);
  });

  it("missing step-up → 401 with ZERO incident write", async () => {
    H.stepUpSent = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents",
      headers: json,
      payload: incidentPayload,
    });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
  });

  it("an incident update binds step-up to THAT incident, not the workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/trust/status/incidents/${INCIDENT}/updates`,
      headers: stepUpJson,
      payload: { state: "MONITORING", body: "Mitigation applied.", expectedState: "IDENTIFIED" },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toContain("appendIncidentUpdate");
    expect(H.stepUpCalls[0]).toEqual({
      purpose: "STATUS_INCIDENT_PUBLISH",
      resourceKind: "STATUS_INCIDENT",
      resourceId: INCIDENT,
    });
  });

  it("a STALE expected state → 409 with ZERO write and the current state echoed", async () => {
    H.incidentUpdateResult = { ok: false, denial: "STALE_STATE", currentState: "RESOLVED" };
    const res = await app.inject({
      method: "POST",
      url: `/v1/trust/status/incidents/${INCIDENT}/updates`,
      headers: stepUpJson,
      payload: { state: "MONITORING", body: "Still looking.", expectedState: "INVESTIGATING" },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.denial).toBe("STALE_STATE");
    expect(body.currentState).toBe("RESOLVED");
    expect(H.writes).toEqual([]);
  });

  it("a foreign-workspace incident id is concealed as 404 (anti-enumeration)", async () => {
    H.incidentUpdateResult = { ok: false, denial: "NOT_FOUND" };
    const res = await app.inject({
      method: "POST",
      url: `/v1/trust/status/incidents/${INCIDENT}/updates`,
      headers: stepUpJson,
      payload: { state: "RESOLVED", body: "Closing." },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).denial).toBe("NOT_FOUND");
    expect(H.writes).toEqual([]);
  });

  it("maintenance publishes behind step-up and rejects an inverted window with no write", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/trust/status/maintenance",
      headers: stepUpJson,
      payload: {
        title: "Storage migration",
        description: "Capture stays available; exports pause.",
        componentKeys: ["STORAGE"],
        startsAtUtc: "2026-08-01T01:00:00.000Z",
        endsAtUtc: "2026-08-01T03:00:00.000Z",
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(H.stepUpCalls[0]?.resourceKind).toBe("STATUS_MAINTENANCE");

    H.writes.length = 0;
    H.maintenanceResult = { ok: false, denial: "INVALID_WINDOW" };
    const bad = await app.inject({
      method: "POST",
      url: "/v1/trust/status/maintenance",
      headers: stepUpJson,
      payload: {
        title: "Storage migration",
        description: "Inverted.",
        componentKeys: ["STORAGE"],
        startsAtUtc: "2026-08-01T03:00:00.000Z",
        endsAtUtc: "2026-08-01T01:00:00.000Z",
      },
    });
    expect(bad.statusCode).toBe(409);
    expect(JSON.parse(bad.body).denial).toBe("INVALID_WINDOW");
    expect(H.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Verification references + package preview (safe projection)
// ---------------------------------------------------------------------------

describe("Verification references + package preview", () => {
  it("verify-references NEVER ships article bodies, internal ids, or contract refs", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/trust/verify-references" });
    expect(res.statusCode).toBe(200);
    // Assert against the RAW body string — a nested leak would still be caught.
    const raw = res.body;
    expect(raw).not.toContain("INTERNAL_ARTICLE_BODY_SHOULD_NEVER_SHIP");
    expect(raw).not.toContain("services/api/src/secret-path.ts");
    expect(raw).not.toContain("art-internal-1");
    expect(raw).not.toContain("sub-internal-1");
    expect(raw).not.toContain("MSA-INTERNAL-9911");
    // …while still carrying what a verifier legitimately cites.
    const body = JSON.parse(raw);
    expect(body.references.trustCenter[0]).toEqual({
      title: "How we handle your data",
      slug: "data-handling",
      version: 4,
    });
  });

  it("verify-references is capability-gated and leaks nothing on denial", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await app.inject({ method: "GET", url: "/v1/trust/verify-references" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("data-handling");
  });

  it("the package preview goes through the canonical builder and emits NO download event", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/trust/verification-package/preview?kind=trust",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).manifest.digest).toBe("sha256:abc");
    expect(H.writes).toEqual(["buildVerificationPackagePreview"]);
    // Authorizing a preview is NOT a delivery. Nothing recorded a download.
    expect(H.writes).not.toContain("recordPackageDownload");
    expect(H.auditCodes).toEqual([]);
  });

  it("the preview takes no client-declared storage key and rejects an unknown kind", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/trust/verification-package/preview?kind=trust&storageKey=s3://other-tenant/x",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("other-tenant");

    await expect(
      app.inject({
        method: "GET",
        url: "/v1/trust/verification-package/preview?kind=not-a-kind",
      }),
    ).resolves.toMatchObject({ statusCode: 500 });
  });

  it("preview denial performs no build at all", async () => {
    H.authAllowed = false;
    const res = await app.inject({
      method: "GET",
      url: "/v1/trust/verification-package/preview?kind=trust",
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Integration delivery history
// ---------------------------------------------------------------------------

describe("Integration delivery history", () => {
  it("authorizes BEFORE querying and returns a deterministic page", async () => {
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries?limit=50",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nextCursor).toBe("del-1");
    expect(H.seenPermissions).toContain("integration.webhook.manage");
    // Tenancy came from the SERVER-resolved workspace, not the request.
    expect(H.deliveryQuerySeen?.teamId).toBe(TEAM);
    expect(H.deliveryQuerySeen?.limit).toBe(50);
  });

  it("forwards the opaque cursor for the next page", async () => {
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries?cursor=44444444-4444-4444-8444-444444444444",
    });
    expect(res.statusCode).toBe(200);
    expect(H.deliveryQuerySeen?.cursorId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("missing capability → 403 and the query NEVER runs", async () => {
    H.authAllowed = false;
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries",
    });
    expect(res.statusCode).toBe(403);
    expect(H.deliveryQuerySeen).toBeNull();
    expect(res.body).not.toContain("counsel@example.org");
  });

  it("cross-organization probe is concealed as 404 with no existence signal", async () => {
    H.authAllowed = false;
    H.denyStatus = 404;
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries?packageId=55555555-5555-4555-8555-555555555555",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect(H.deliveryQuerySeen).toBeNull();
  });

  it("the projection carries NO secret, signature, token, or signed URL", async () => {
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries",
    });
    const raw = res.body.toLowerCase();
    for (const forbidden of [
      "secret",
      "signature",
      "signingkey",
      "authorization",
      "x-proovra-signature",
      "https://",
      "token",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("delivery authorization and delivery completion stay DIFFERENT states", async () => {
    const res = await productApp.inject({
      method: "GET",
      url: "/v1/integrations/webhooks/deliveries",
    });
    const row = JSON.parse(res.body).deliveries[0];
    // A recorded recipient is not an opened package.
    expect(row.state).toBe("RECORDED");
    expect(row.downloadedAtUtc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Workspace context is never client-declared
// ---------------------------------------------------------------------------

describe("Workspace derivation", () => {
  it("no active workspace → the write is refused before any authorization", async () => {
    H.currentWorkspaceId = null;
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents",
      headers: stepUpJson,
      payload: { title: "x", severity: "MINOR", componentKeys: ["API"] },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).denial).toBe("WORKSPACE_NOT_FOUND");
    expect(H.writes).toEqual([]);
    expect(H.seenPermissions).toEqual([]);
  });

  it("a client-declared teamId cannot redirect the write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust/status/incidents?teamId=99999999-9999-4999-8999-999999999999",
      headers: stepUpJson,
      payload: {
        title: "x",
        severity: "MINOR",
        componentKeys: ["API"],
        teamId: "99999999-9999-4999-8999-999999999999",
      },
    });
    expect(res.statusCode).toBe(201);
    // Step-up bound to the SERVER-resolved workspace, not the declared one.
    expect(H.stepUpCalls[0]?.resourceId).toBe(TEAM);
  });
});
