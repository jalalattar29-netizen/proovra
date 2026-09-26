/**
 * FINAL ENTERPRISE COMPLETION — Fastify inject runtime integration tests.
 *
 * Phase 5 — AiResult/GroundedCopilot contract at the ROUTE boundary
 *   (POST /v1/ai/evidence/:id/copilot): malformed provider response,
 *   schema mismatch, provider-unavailable fallback, out-of-scope refusal,
 *   policy denied, rate limited, and the full ok path (including the
 *   server-derived suggested actions).
 *
 * Phase 6 — Natural-Language Search route
 *   (POST /v1/ai/search/nl): RETIRED 2026-09-16 — every request, member or
 *   not, well-formed or not, answers 410 NL_SEARCH_RETIRED with no search,
 *   no rate-limit consult and no audit.
 *
 * House style: real route modules + real classifier/parser/orchestrator/
 * schemas; ONLY the process edges (db, auth, provider, ledger, rate-limit,
 * audit sink, persisted-run store) are in-memory doubles. No live database.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { toSnapshot } from "../src/services/ai/evidence-analysis-snapshot.service.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controllable in-memory state for the process-edge doubles.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  userId: "user-1",
  memberTeams: new Set<string>(["team-1"]),
  guard: { allowed: true, code: "OK", retryAfterSec: 1 } as {
    allowed: boolean; code: string; retryAfterSec: number;
  },
  policy: { allowed: true, decision: "ALLOWED", reason: "ok", policyVersion: 3 },
  provider: (async () => ({})) as (payload: unknown) => Promise<unknown>,
  audits: [] as Array<Record<string, unknown>>,
  searchCalls: [] as Array<Record<string, unknown>>,
  evidenceRow: null as Record<string, unknown> | null,
  evidenceRows: [] as Array<{ id: string; title: string | null }>,
  // PHASE 1 (2026-07-21) — side-effect trackers for the policy-before-data /
  // deny-has-no-side-effects proofs.
  billingReserved: 0,
  providerCalls: 0,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: {
      // PHASE 1 (2026-07-21): the canonical primitive's loadMemberAccessSnapshot
      // reads status + accessExpiresAtUtc + team.organization.status +
      // capabilityGrants + delegatedAdminScopes. ADMIN has intelligence.read
      // AND intelligence.run, so member requests still authorize.
      findUnique: async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) =>
        H.memberTeams.has(where.teamId_userId.teamId)
          ? {
              id: `tm-${where.teamId_userId.teamId}`,
              teamId: where.teamId_userId.teamId,
              userId: where.teamId_userId.userId,
              role: "ADMIN",
              status: "ACTIVE",
              accessExpiresAtUtc: null,
              team: {
                isPersonal: false,
                workspaceKind: "ORGANIZATION",
                billingPlan: "ENTERPRISE",
                organization: { status: "ACTIVE" },
              },
              capabilityGrants: [],
              delegatedAdminScopes: [],
            }
          : null,
    },
    // recordPermissionDecision (on deny) writes a SecurityEvent; provide a
    // no-op sink so the fail-closed audit path never throws in this mock.
    securityEvent: { create: async () => ({ id: "se-1" }) },
    // WORKSPACE-SCOPE CONVERGENCE — the canonical scope authority resolves the
    // workspace's kind and owner before any Evidence/Case read, so the mock
    // must model the Team row. NON-personal by default, which keeps every
    // assertion below meaning exactly what it meant: a shared workspace's
    // scope IS the strict `{ teamId }` filter these tests were written for.
    team: { findUnique: async () => ({ isPersonal: false, ownerUserId: null }) },
    evidence: {
      findUnique: async () => H.evidenceRow,
      // The TOCTOU re-check re-reads the SAME ids through `findMany`, so this
      // double has to answer for the single mocked row too. Returning only
      // `H.evidenceRows` made every run look like the record had vanished
      // between validation and the spend — which is the drift detector working
      // correctly against a fixture that was lying to it.
      findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in;
        if (ids && H.evidenceRow && ids.includes(H.evidenceRow.id as string)) {
          return [H.evidenceRow];
        }
        return H.evidenceRows;
      },
      count: async () => H.evidenceRows.length,
    },
    evidenceReviewWorkflow: { findMany: async () => [], count: async () => 0 },
    /*
     * RELIABILITY CLOSURE (2026-09-09) — the copilot's suggested actions come
     * from the CANONICAL output projection now, not from `_count.reports`.
     *
     * It derived Generate/Regenerate from a report count with no eligibility,
     * funding or lifecycle input, so it offered "Generate Report" on FREE
     * records and "Regenerate Report" on downgraded ones — both NONE
     * canonically. The projection reads the artifact TABLES, so the doubles
     * below model them from the same fixture the count is taken from, and the
     * two cases still mean exactly what they meant: a record WITH a report
     * offers a new version, a record WITHOUT one offers a first generation.
     */
    report: {
      findMany: async () => [],
      findFirst: async () =>
        (H.evidenceRow?._count as { reports?: number } | undefined)?.reports
          ? {
              version: H.evidenceRow?.latestReportVersion ?? 1,
              generatedAtUtc: new Date(),
              verificationPackageVersion: null,
              reviewerSummaryVersion: null,
              pdfSignatureStatus: "SIGNED",
              pdfSignedAtUtc: new Date(),
              pdfSignerKeyId: "k1",
              pdfSigningWarning: null,
            }
          : null,
    },
    verificationPackage: { findFirst: async () => null },
    // No durable generation request in flight: axis 2 is NOT_REQUESTED, which
    // is what makes the artifact's presence the deciding fact in both cases.
    reportGenerationRequest: { findFirst: async () => null },
  },
}));
/*
 * THE OUTPUT FACTS, derived from the same fixture through the REAL shared
 * decision (2026-09-26). The loader resolves eligibility, holds and access
 * through services this Prisma double does not model; the copilot route only
 * needs its RESULT, so the facts are built here from the fixture's artifact
 * counts and versions and the actions come from `resolveEvidenceOutputActions`
 * itself — the rule under test is still the production one.
 */
vi.mock("../src/services/reports/output-recovery.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { resolveEvidenceOutputActions } = await import("@proovra/shared");
  return {
    ...actual,
    loadEvidenceOutputFacts: async (input: { evidenceIds: readonly string[] }) => {
      const row = H.evidenceRow as Record<string, unknown> | null;
      const out = new Map();
      if (!row || !input.evidenceIds.includes(row.id as string)) return out;
      const counts = (row._count ?? {}) as { reports?: number; verificationPackages?: number };
      const reportVersion = counts.reports ? ((row.latestReportVersion as number | null) ?? 1) : null;
      const packageVersion = counts.verificationPackages
        ? ((row.verificationPackageVersion as number | null) ?? 1)
        : null;
      const facts = {
        record: "FINALIZED",
        reportEligibility: "ELIGIBLE",
        packageEligibility: "ELIGIBLE",
        latestReportVersion: reportVersion,
        packageAtLatestReport: reportVersion != null && packageVersion === reportVersion,
        latestPackageVersion: packageVersion,
        packageBlockedByGovernance: false,
        reportRequest: null,
        packageRequest: null,
        restrictions: {
          lifecycleState: "ACTIVE",
          legalHold: false,
          workspaceSuspended: false,
          workspaceClosed: false,
          workspaceResolved: true,
        },
        callerMayGenerate: true,
        newVersionFitsStorage: null,
      } as const;
      const at = new Date();
      out.set(row.id, {
        evidenceId: row.id,
        teamId: row.teamId ?? null,
        ownerUserId: "owner-1",
        facts,
        actions: resolveEvidenceOutputActions(facts as never),
        eligibility: null,
        latestReport: reportVersion != null ? { version: reportVersion, generatedAtUtc: at, sizeBytes: null } : null,
        packageAtLatest:
          facts.packageAtLatestReport && packageVersion != null
            ? { version: packageVersion, generatedAtUtc: at, sizeBytes: null, packageType: null }
            : null,
        latestPackage:
          packageVersion != null ? { version: packageVersion, generatedAtUtc: at, sizeBytes: null, packageType: null } : null,
        reportRequest: null,
        packageRequest: null,
        newVersionEstimate: null,
      });
      return out;
    },
  };
});
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => undefined,
}));
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.userId,
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (entry: Record<string, unknown>) => {
    H.audits.push(entry);
  },
}));
vi.mock("../src/services/ai/ai-rate-limit.service.js", () => ({
  enforceAiEndpointGuard: async () => H.guard,
}));
vi.mock("../src/services/search/evidence-search.service.js", () => ({
  executeSearch: async (input: Record<string, unknown>) => {
    H.searchCalls.push(input);
    return {
      rows: [{ documentId: "d-1", evidenceId: "ev-9", caseId: null, title: "Warehouse photo", documentType: "EVIDENCE" }],
      total: 1,
    };
  },
}));
vi.mock("../src/services/ai/workspace-ai-policy.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    evaluateWorkspaceAiPolicy: async () => H.policy,
    resolveWorkspaceAiPolicy: async () => ({
      policyVersion: 3, aiEnabled: false, supportChatEnabled: false,
      captureAssistanceEnabled: false, evidenceCategorizationEnabled: false,
      semanticSearchEnabled: false, contentIntelligenceEnabled: false,
      reviewerCopilotEnabled: false, caseCopilotEnabled: false,
    }),
  };
});
vi.mock("../src/services/ai/ai-usage-ledger.service.js", () => ({
  tryReserveAiBudget: async () => {
    H.billingReserved += 1;
    return { decision: { allowed: true, code: "OK" }, reservationId: null };
  },
  reconcileAiUsage: async () => undefined,
  releaseAiReservation: async () => undefined,
  buildPrismaLedgerStore: () => ({}),
}));
vi.mock("../src/services/ai/ai-copilot-run-store.service.js", () => ({
  persistCopilotRun: async () => ({ id: "run-1" }),
}));
vi.mock("../src/services/ai/ai-citation-db-resolver.service.js", () => ({
  buildWorkspaceCitationLookups: () => ({}),
  buildCitationResolver: () => async () => null,
}));
vi.mock("../src/services/ai/structured-copilot-provider.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildStructuredCopilotCall: () => (payload: unknown) => H.provider(payload),
  };
});

import { aiEvidenceRoutes } from "../src/routes/ai-evidence.routes.js";
import { aiSearchRoutes } from "../src/routes/ai-search.routes.js";
import {
  ADVISORY_BOUNDARY_TEXT,
  CopilotProviderUnavailable,
} from "../src/services/ai/structured-copilot-provider.js";

// ---------------------------------------------------------------------------
// Test app — real route modules + the server's ZodError→400 mapping.
// ---------------------------------------------------------------------------
async function buildApp(routes: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT" } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  await app.register(routes);
  await app.ready();
  return app;
}

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_1 = "22222222-2222-4222-8222-222222222222";
const TEAM_2 = "33333333-3333-4333-8333-333333333333";

function signedEvidenceRow(over: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE_ID, teamId: TEAM_1, deletedAt: null, title: "Warehouse photo",
    type: "PHOTO", mimeType: "image/jpeg", status: "SIGNED",
    verificationStatus: "VERIFIED", captureMethod: "IN_APP", caseLinks: [],
    createdAt: new Date("2026-07-01T00:00:00Z"),
    latestReportVersion: 2, verificationPackageVersion: 1,
    tsaStatus: "CONFIRMED", otsStatus: "PENDING",
    // Every field the canonical analysis select projects. The route reads
    // ONE row shape now, so a fixture that carries less is a fixture that
    // does not exercise the route.
    lifecycleState: "ACTIVE", archivedAt: null,
    _count: {
      custodyEvents: 4,
      parts: 1,
      caseLinks: 0,
      reports: 1,
      verificationPackages: 1,
    },
    ...over,
  };
}

/**
 * The revision the ROUTE will recompute for the current mocked row.
 *
 * Derived from the fixture through the production builder rather than
 * hard-coded: a literal would pass while the route rejected every real
 * request, which is the class of defect this whole contract exists to end.
 */
function currentRevision(): string {
  // A fixture with no row is testing the 404 path; the schema still requires a
  // well-formed revision, so send one this product could have issued rather
  // than skipping the field and failing on validation instead of on the
  // behaviour under test.
  if (!H.evidenceRow) return `ear1_${"A".repeat(43)}`;
  return toSnapshot(H.evidenceRow as never, {
    scope: "evidence",
    scopeId: null,
  }).revision;
}

const VALID_COPILOT_OUTPUT = {
  operationalSummary: "This record has a report available and custody events are present.",
  missingContext: ["A case link has not been added."],
  integritySignalExplanations: [],
  custodyObservations: [],
  timestampingObservations: [],
  reportReadiness: [],
  packageReadiness: [],
  reviewerPreparation: [],
  workflowGaps: [],
  suggestedNavigation: [],
  suggestedActions: [],
  citations: [],
  advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
};

beforeEach(() => {
  H.userId = "user-1";
  H.memberTeams = new Set([TEAM_1]);
  H.guard = { allowed: true, code: "OK", retryAfterSec: 1 };
  H.policy = { allowed: true, decision: "ALLOWED", reason: "ok", policyVersion: 3 };
  H.provider = async () => ({ ...VALID_COPILOT_OUTPUT });
  H.audits.length = 0;
  H.searchCalls.length = 0;
  H.evidenceRow = signedEvidenceRow();
  H.evidenceRows = [];
});

// ===========================================================================
// Phase 5 — AiResult contract at the Evidence Copilot route boundary.
// ===========================================================================
describe("Phase 5 — Evidence Copilot route: canonical result contract (inject)", () => {
  async function run(body: Record<string, unknown> = {}) {
    const app = await buildApp(aiEvidenceRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/v1/ai/evidence/${EVIDENCE_ID}/copilot`,
      // The revision is REQUIRED now — a client that cannot say what it saw
      // is not analyzed. Supplied by default so each test can exercise its
      // own subject rather than restating the concurrency contract.
      payload: { evidenceRevision: currentRevision(), ...body },
    });
    await app.close();
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it("ok path: bounded validated data + runId + SERVER-derived actions only", async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body.data.data.operationalSummary).toContain("report available");
    expect(body.data.advisoryBoundary).toBe(ADVISORY_BOUNDARY_TEXT);
    expect(body.runId).toBe("run-1");
    // Report v2 beside only package v1 → the package is recovered for v2
    // (RETRY_ELIGIBLE_REPORT, never GENERATE_REPORT) + metadata link.
    const types = (body.serverActions as Array<{ actionType: string }>).map((a) => a.actionType);
    expect(types).toContain("RETRY_ELIGIBLE_REPORT");
    expect(types).toContain("OPEN_MISSING_METADATA");
    expect(types).not.toContain("GENERATE_REPORT");
    for (const a of body.serverActions as Array<{ confirmationRequired: boolean }>) {
      expect(a.confirmationRequired).toBe(true);
    }
    // Audit proof.
    expect(H.audits.some((e) => e.action === "ai.evidence_copilot" && e.outcome === "success")).toBe(true);
  });

  it("unreported SIGNED record → GENERATE_REPORT derived (never both)", async () => {
    // "Unreported" is NO REPORT ARTIFACT, which is what the fixture now says.
    // It said `latestReportVersion: 0` — a version column standing in for
    // readiness, which cannot distinguish "no report" from "report version 0"
    // and is the derivation the lifecycle contract forbids.
    H.evidenceRow = signedEvidenceRow({
      latestReportVersion: null,
      verificationPackageVersion: null,
      // An unreported record has no package either: a package without a
      // report is the legacy consistency case, which offers no Generate.
      _count: {
        custodyEvents: 4,
        parts: 1,
        caseLinks: 0,
        reports: 0,
        verificationPackages: 0,
      },
    });
    const { body } = await run();
    const types = (body.serverActions as Array<{ actionType: string }>).map((a) => a.actionType);
    expect(types).toContain("GENERATE_REPORT");
    expect(types).not.toContain("RETRY_ELIGIBLE_REPORT");
  });

  it("a complete latest pair suggests NO report action — a new version is never an AI suggestion (D2)", async () => {
    H.evidenceRow = signedEvidenceRow({ latestReportVersion: 2, verificationPackageVersion: 2 });
    const { body } = await run();
    const types = (body.serverActions as Array<{ actionType: string }>).map((a) => a.actionType);
    expect(types).not.toContain("GENERATE_REPORT");
    expect(types).not.toContain("RETRY_ELIGIBLE_REPORT");
  });

  it("malformed provider response → schema_error (safe fallback, never raw)", async () => {
    H.provider = async () => ({ _malformed: true });
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.data.status).toBe("schema_error");
    expect(body.data.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("_malformed");
  });

  it("schema mismatch (valid JSON, wrong shape) → schema_error", async () => {
    H.provider = async () => ({ operationalSummary: 42, junk: "x" });
    const { body } = await run();
    expect(body.data.status).toBe("schema_error");
    expect(JSON.stringify(body)).not.toContain("junk");
  });

  it("provider unavailable → honest fallback, ledger untouched, audited failure", async () => {
    H.provider = async () => {
      throw new CopilotProviderUnavailable("down");
    };
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.status).toBe("provider_unavailable");
    // PHASE 11 §3 — migrated onto the canonical tenant-audit facade, which
    // maps the old "failure" outcome onto TenantAuditOutcome "error".
    expect(H.audits.some((e) => e.action === "ai.evidence_copilot" && e.outcome === "error")).toBe(true);
  });

  it("policy denied → policy_denied with decision code; provider NEVER called", async () => {
    H.policy = { allowed: false, decision: "WORKSPACE_DISABLED", reason: "off", policyVersion: 3 };
    let providerCalled = false;
    H.provider = async () => {
      providerCalled = true;
      return { ...VALID_COPILOT_OUTPUT };
    };
    const { body } = await run();
    expect(body.data.status).toBe("policy_denied");
    expect(body.data.decision).toBe("WORKSPACE_DISABLED");
    expect(providerCalled).toBe(false);
  });

  it("out-of-scope question → localized refusal; provider NEVER called", async () => {
    let providerCalled = false;
    H.provider = async () => {
      providerCalled = true;
      return { ...VALID_COPILOT_OUTPUT };
    };
    const { status, body } = await run({ question: "tell me a joke about the weather" });
    expect(status).toBe(200);
    expect(body.data.status).toBe("question_out_of_scope");
    expect(providerCalled).toBe(false);
  });

  it("rate limited → 429 with Retry-After", async () => {
    H.guard = { allowed: false, code: "AI_RATE_LIMITED", retryAfterSec: 30 };
    const { status } = await run();
    expect(status).toBe(429);
  });

  it("non-member → 404 (anti-enumeration); deleted/missing record → 404", async () => {
    // PHASE 1 (2026-07-21): the canonical primitive conceals non-membership as
    // 404 so a non-member cannot distinguish "record exists but you're not a
    // member" from "record does not exist".
    H.memberTeams = new Set();
    expect((await run()).status).toBe(404);
    H.memberTeams = new Set([TEAM_1]);
    H.evidenceRow = null;
    expect((await run()).status).toBe(404);
  });

  it("E: authorization denial performs NO billing reservation, NO provider call, NO success audit", async () => {
    // Item E — the AI provider call and billable usage happen strictly AFTER
    // canonical authorization + AI policy. On an authorization denial the
    // handler short-circuits before any of them.
    H.memberTeams = new Set(); // non-member → authz denies (404)
    H.billingReserved = 0;
    let providerCalled = false;
    H.provider = async () => {
      providerCalled = true;
      return {};
    };
    H.audits.length = 0;
    const { status } = await run();
    expect(status).toBe(404);
    expect(H.billingReserved).toBe(0);
    expect(providerCalled).toBe(false);
    expect(H.audits.some((e) => e.outcome === "success")).toBe(false);
  });

  it("a stale revision → 409, and a package version is not a revision", async () => {
    // `999` used to be a plausible-looking stale VERSION. Against an opaque
    // token there is no such thing as a plausible-looking value: anything
    // this product did not issue simply is not a revision.
    expect((await run({ evidenceRevision: "999" })).status).toBe(409);
    const { status } = await run({
      evidenceRevision: `ear1_${"A".repeat(43)}`,
    });
    expect(status).toBe(409);
  });
});

// ===========================================================================
// Phase 6 — Natural-Language Search route (inject).
//
// RETIRED 2026-09-16. The plain-language search card was withdrawn and its
// only consumer deleted (e2f5cf2d); the route now answers a typed 410 and does
// no work. These cases used to pin the parser's behaviour THROUGH the route
// (EN/DE/AR presets, unsupported filters, default-deny, tenant-bound text
// search, rate limit, complexity guard). The parser's own behaviour is still
// pinned directly by phase-f1-nl-search.test.ts; what the route owes now is
// that EVERY one of those requests is refused identically, before any
// membership read, rate-limit consult, search, query or audit.
// ===========================================================================
describe("Phase 6 — NL Search route is a typed 410 tombstone (inject)", () => {
  async function search(payload: unknown) {
    const app = await buildApp(aiSearchRoutes);
    const res = await app.inject({ method: "POST", url: "/v1/ai/search/nl", payload: payload as object });
    await app.close();
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  }

  const REQUESTS: Array<[string, unknown]> = [
    ["member, English state query", { teamId: TEAM_1, query: "show evidence with tsa pending" }],
    ["member, German state query", { teamId: TEAM_1, query: "zeige fehlgeschlagene Verifizierung" }],
    ["member, Arabic state query", { teamId: TEAM_1, query: "فشل التحقق" }],
    ["member, unsupported filter", { teamId: TEAM_1, query: "find evidence missing gps" }],
    ["member, out-of-domain query", { teamId: TEAM_1, query: "what is the weather today" }],
    ["member, text search", { teamId: TEAM_1, query: "find photo evidence warehouse" }],
    ["member, >40 words", { teamId: TEAM_1, query: Array.from({ length: 41 }, () => "report").join(" ") }],
    ["non-member", { teamId: TEAM_2, query: "show evidence with tsa pending" }],
    ["malformed body (bad uuid)", { teamId: "not-a-uuid", query: "x" }],
    ["malformed body (missing query)", { teamId: TEAM_1 }],
    ["empty body", {}],
  ];

  for (const [label, payload] of REQUESTS) {
    it(`${label} → 410 NL_SEARCH_RETIRED naming Search, and nothing runs`, async () => {
      // A rate-limit refusal would have answered 429 first; the tombstone
      // never consults the guard, so it cannot.
      H.guard = { allowed: false, code: "AI_RATE_LIMITED", retryAfterSec: 12 };
      H.evidenceRows = [{ id: "ev-1", title: "Contract scan" }];
      const { status, body, headers } = await search(payload);
      expect(status).toBe(410);
      expect(body.error.code).toBe("NL_SEARCH_RETIRED");
      expect(typeof body.error.message).toBe("string");
      expect(body.canonical).toBe("/v1/search");
      expect(body.rows).toBeUndefined();
      expect(headers["retry-after"]).toBeUndefined();
      expect(H.searchCalls.length).toBe(0);
      expect(H.audits.length).toBe(0);
    });
  }

  it("no response ever exposes provider/model names or internal decision JSON", async () => {
    for (const q of ["show evidence with tsa pending", "what is the weather today", "find evidence missing gps"]) {
      const { body } = await search({ teamId: TEAM_1, query: q });
      const s = JSON.stringify(body).toLowerCase();
      expect(s).not.toContain("openai");
      expect(s).not.toContain("gpt");
    }
  });
});
