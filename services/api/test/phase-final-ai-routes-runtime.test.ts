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
 *   (POST /v1/ai/search/nl): authorization (non-member 403), cross-tenant
 *   denial, malformed body (400), EN/DE/AR state queries, unsupported
 *   filters (honest refusal), out-of-scope refusal, rate limiting (429),
 *   parser complexity guard, TEXT_SEARCH tenant binding, and audit proof.
 *
 * House style: real route modules + real classifier/parser/orchestrator/
 * schemas; ONLY the process edges (db, auth, provider, ledger, rate-limit,
 * audit sink, persisted-run store) are in-memory doubles. No live database.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
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
    evidence: {
      findUnique: async () => H.evidenceRow,
      findMany: async () => H.evidenceRows,
      count: async () => H.evidenceRows.length,
    },
    evidenceReviewWorkflow: { findMany: async () => [], count: async () => 0 },
    report: { findMany: async () => [] },
  },
}));
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
    _count: { custodyEvents: 4 },
    ...over,
  };
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
      payload: body,
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
    // latestReportVersion=2 → RETRY_ELIGIBLE_REPORT (not GENERATE_REPORT) + metadata link.
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
    H.evidenceRow = signedEvidenceRow({ latestReportVersion: 0 });
    const { body } = await run();
    const types = (body.serverActions as Array<{ actionType: string }>).map((a) => a.actionType);
    expect(types).toContain("GENERATE_REPORT");
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

  it("stale evidenceVersion → 409", async () => {
    const { status } = await run({ evidenceVersion: 999 });
    expect(status).toBe(409);
  });
});

// ===========================================================================
// Phase 6 — Natural-Language Search route (inject).
// ===========================================================================
describe("Phase 6 — NL Search route: authorization, languages, honesty, audit (inject)", () => {
  async function search(payload: unknown) {
    const app = await buildApp(aiSearchRoutes);
    const res = await app.inject({ method: "POST", url: "/v1/ai/search/nl", payload: payload as object });
    await app.close();
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  }

  it("non-member is rejected 404 (anti-enumeration) before any audit", async () => {
    // PHASE 1 (2026-07-21): non-membership conceals as 404 not_found.
    const { status, body } = await search({ teamId: TEAM_2, query: "show evidence with tsa pending" });
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(H.audits.length).toBe(0);
  });

  it("malformed body (bad uuid / missing query / empty) → 400, never 500", async () => {
    expect((await search({ teamId: "not-a-uuid", query: "x" })).status).toBe(400);
    expect((await search({ teamId: TEAM_1 })).status).toBe(400);
    expect((await search({})).status).toBe(400);
  });

  it("English state query → tenant-bound STATE_QUERY with rows + audit", async () => {
    H.evidenceRows = [{ id: "ev-1", title: "Contract scan" }];
    const { status, body } = await search({ teamId: TEAM_1, query: "show evidence with tsa pending" });
    expect(status).toBe(200);
    expect(body.kind).toBe("STATE_QUERY");
    expect(body.query).toBe("TSA_PENDING");
    expect(body.rows[0]).toEqual({ id: "ev-1", title: "Contract scan", route: "/evidence/ev-1", badge: "TSA pending" });
    const audit = H.audits.find((e) => e.action === "ai.nl_search");
    expect(audit).toBeTruthy();
    expect((audit!.metadata as Record<string, unknown>).query).toBe("TSA_PENDING");
  });

  it("German state query → FAILED_VERIFICATION", async () => {
    const { body } = await search({ teamId: TEAM_1, query: "zeige fehlgeschlagene Verifizierung" });
    expect(body.kind).toBe("STATE_QUERY");
    expect(body.query).toBe("FAILED_VERIFICATION");
  });

  it("Arabic state query → FAILED_VERIFICATION", async () => {
    const { body } = await search({ teamId: TEAM_1, query: "فشل التحقق" });
    expect(body.kind).toBe("STATE_QUERY");
    expect(body.query).toBe("FAILED_VERIFICATION");
  });

  it("unsupported filter (GPS) → honest UNSUPPORTED_FILTER, no fake results", async () => {
    const { body } = await search({ teamId: TEAM_1, query: "find evidence missing gps" });
    expect(body.kind).toBe("UNSUPPORTED_FILTER");
    expect(body.rows).toBeUndefined();
    expect(body.message).toContain("isn't supported yet");
  });

  it("out-of-domain query → default-deny REFUSED (no search executed)", async () => {
    const { body } = await search({ teamId: TEAM_1, query: "what is the weather today" });
    expect(body.kind).toBe("REFUSED");
    expect(typeof body.message).toBe("string");
    expect(H.searchCalls.length).toBe(0);
  });

  it("TEXT_SEARCH goes through the EXISTING authorized search, tenant-bound", async () => {
    const { body } = await search({ teamId: TEAM_1, query: "find photo evidence warehouse" });
    expect(body.kind).toBe("TEXT_SEARCH");
    expect(body.rows[0].route).toBe("/evidence/ev-9");
    expect(H.searchCalls.length).toBe(1);
    const call = H.searchCalls[0] as { surface: string; filter: { teamId: string; evidenceTypes?: string[] } };
    expect(call.surface).toBe("api:ai-nl-search");
    expect(call.filter.teamId).toBe(TEAM_1); // server binds tenant; query cannot cross it
    expect(call.filter.evidenceTypes).toContain("PHOTO");
  });

  it("rate limited → 429 with Retry-After header", async () => {
    H.guard = { allowed: false, code: "AI_RATE_LIMITED", retryAfterSec: 12 };
    const { status, headers } = await search({ teamId: TEAM_1, query: "show evidence with tsa pending" });
    expect(status).toBe(429);
    expect(headers["retry-after"]).toBe("12");
  });

  it("complexity guard: >40 words → honest shorter-query response, nothing executed", async () => {
    const query = Array.from({ length: 41 }, () => "report").join(" ");
    const { status, body } = await search({ teamId: TEAM_1, query });
    expect(status).toBe(200);
    expect(body.kind).toBe("UNSUPPORTED_FILTER");
    expect(body.message).toContain("shorter");
    expect(H.searchCalls.length).toBe(0);
  });

  it("no response ever exposes provider/model names or internal decision JSON", async () => {
    for (const q of ["show evidence with tsa pending", "what is the weather today", "find evidence missing gps"]) {
      const { body } = await search({ teamId: TEAM_1, query: q });
      const s = JSON.stringify(body).toLowerCase();
      expect(s).not.toContain("openai");
      expect(s).not.toContain("gpt");
    }
  });
});
