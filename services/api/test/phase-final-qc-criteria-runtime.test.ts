/**
 * FINAL ENTERPRISE COMPLETION — QC Sampling + Reviewer Criteria lifecycle
 * runtime tests (Fastify inject).
 *
 * Phase 1 — QC sampling routes:
 *   GET  /v1/ai/qc/samples             — membership, strategy validation,
 *                                        panel row shape (deep links, qcState),
 *                                        catalog-unavailable honesty.
 *   POST /v1/ai/qc/samples/:id/decision — QC verdict persisted via the
 *                                        CANONICAL observation-interaction
 *                                        model (observationId "qc") + audit.
 *
 * Phase 2 — Reviewer Criteria lifecycle (full state machine over an
 * in-memory catalog double):
 *   create draft → edit draft → publish → published is IMMUTABLE →
 *   duplicate as v(N+1) → no duplicate while a draft exists → retire.
 *   Plus loadPublishedCriteria: forged / unpublished / cross-tenant rejected.
 *
 * House style: real route modules; only process edges are doubles.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory state.
// ---------------------------------------------------------------------------
type CatalogVersion = {
  id: string; criteriaSetId: string; version: number; title: string;
  instructions: string | null; publishedAt: Date | null; publishedByUserId: string | null;
  retiredAt: Date | null; createdByUserId: string;
  criteria: Array<Record<string, unknown>>;
};
type CatalogSet = {
  id: string; workspaceId: string; name: string; description: string | null;
  status: string; currentVersionId: string | null; createdByUserId: string; updatedAt: Date;
};

const H = vi.hoisted(() => ({
  userId: "user-1",
  role: "ADMIN" as string,
  memberTeams: new Set<string>(),
  audits: [] as Array<Record<string, unknown>>,
  interactions: [] as Array<Record<string, unknown>>,
  qcRuns: [] as Array<Record<string, unknown>>,
  qcRunsThrow: false,
  qcRunsThrowGeneric: false,
  sets: new Map<string, CatalogSet>(),
  versions: new Map<string, CatalogVersion>(),
  seq: 0,
  nextId(prefix: string) {
    this.seq += 1;
    // Deterministic VALID uuids (routes zod-validate uuid params).
    const block = prefix === "s" ? "aaaaaaaa" : "bbbbbbbb";
    return `${block}-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  },
}));

function versionsOfSet(setId: string): CatalogVersion[] {
  return [...H.versions.values()]
    .filter((v) => v.criteriaSetId === setId)
    .sort((a, b) => b.version - a.version);
}

function projectVersions(setId: string, opts: Record<string, unknown> | true | undefined) {
  let vs = versionsOfSet(setId);
  if (opts && opts !== true) {
    const where = (opts as { where?: Record<string, unknown> }).where;
    if (where?.id) vs = vs.filter((v) => v.id === where.id);
    if (where && "publishedAt" in where) vs = vs.filter((v) => v.publishedAt !== null);
    const take = (opts as { take?: number }).take;
    if (typeof take === "number") vs = vs.slice(0, take);
  }
  return vs.map((v) => ({ ...v, criteria: [...v.criteria] }));
}

vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: {
      findUnique: async ({ where }: { where: { teamId_userId: { teamId: string } } }) =>
        H.memberTeams.has(where.teamId_userId.teamId) ? { role: H.role } : null,
    },
    aiCopilotRun: {
      findMany: async ({ where }: { where?: { criteriaVersion?: string } } = {}) => {
        if (H.qcRunsThrow) {
          // Phase F-5 — migration-shaped failure (Prisma P2021: table missing).
          throw Object.assign(new Error("relation ai_copilot_runs does not exist"), { code: "P2021" });
        }
        if (H.qcRunsThrowGeneric) throw new Error("connection reset");
        return where?.criteriaVersion
          ? H.qcRuns.filter((r) => r.criteriaVersion === where.criteriaVersion)
          : H.qcRuns;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = H.qcRuns.find((x) => x.id === where.id);
        return r ? { workspaceId: r.workspaceId } : null;
      },
    },
    reviewerCriteriaSet: {
      findMany: async () => [...H.sets.values()],
      findUnique: async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
        const set = H.sets.get(where.id);
        if (!set) return null;
        return include?.versions
          ? { ...set, versions: projectVersions(set.id, include.versions as Record<string, unknown>) }
          : { ...set };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const setId = H.nextId("s");
        const set: CatalogSet = {
          id: setId, workspaceId: data.workspaceId as string, name: data.name as string,
          description: (data.description as string | null) ?? null, status: data.status as string,
          currentVersionId: null, createdByUserId: data.createdByUserId as string, updatedAt: new Date(),
        };
        H.sets.set(setId, set);
        const vCreate = (data.versions as { create: Record<string, unknown> }).create;
        const vId = H.nextId("v");
        H.versions.set(vId, {
          id: vId, criteriaSetId: setId, version: vCreate.version as number,
          title: vCreate.title as string, instructions: (vCreate.instructions as string | null) ?? null,
          publishedAt: null, publishedByUserId: null, retiredAt: null,
          createdByUserId: vCreate.createdByUserId as string,
          criteria: ((vCreate.criteria as { create: Array<Record<string, unknown>> })?.create ?? []).map((c) => ({ ...c })),
        });
        return { ...set, versions: projectVersions(setId, true) };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const set = H.sets.get(where.id);
        if (!set) throw new Error("not found");
        // Strictly-monotonic updatedAt (mirrors @updatedAt; avoids same-ms flakes).
        const bumped = new Date(Math.max(Date.now(), set.updatedAt.getTime() + 1));
        Object.assign(set, data, { updatedAt: bumped });
        return { ...set };
      },
    },
    reviewerCriteriaVersion: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const v = H.versions.get(where.id);
        if (!v) throw new Error("not found");
        const { criteria, ...rest } = data as { criteria?: { create: Array<Record<string, unknown>> } };
        Object.assign(v, rest);
        if (criteria?.create) v.criteria.push(...criteria.create.map((c) => ({ ...c })));
        return { ...v };
      },
      updateMany: async ({ where, data }: { where: { criteriaSetId: string; publishedAt?: unknown }; data: Record<string, unknown> }) => {
        for (const v of versionsOfSet(where.criteriaSetId)) {
          if (where.publishedAt && !v.publishedAt) continue;
          if (v.retiredAt) continue;
          Object.assign(H.versions.get(v.id)!, data);
        }
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const vId = H.nextId("v");
        const v: CatalogVersion = {
          id: vId, criteriaSetId: data.criteriaSetId as string, version: data.version as number,
          title: data.title as string, instructions: (data.instructions as string | null) ?? null,
          publishedAt: null, publishedByUserId: null, retiredAt: null,
          createdByUserId: data.createdByUserId as string,
          criteria: ((data.criteria as { create: Array<Record<string, unknown>> })?.create ?? []).map((c) => ({ ...c })),
        };
        H.versions.set(vId, v);
        return { ...v };
      },
    },
    reviewerCriterion: {
      deleteMany: async ({ where }: { where: { criteriaVersionId: string } }) => {
        const v = H.versions.get(where.criteriaVersionId);
        if (v) v.criteria = [];
        return { count: 1 };
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  },
}));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.userId }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (entry: Record<string, unknown>) => {
    H.audits.push(entry);
  },
}));
vi.mock("../src/services/ai/ai-copilot-run-store.service.js", () => ({
  persistCopilotRun: async () => ({ id: "run-x" }),
  recordObservationInteraction: async (input: Record<string, unknown>) => {
    H.interactions.push(input);
    return { id: "obs-1", state: input.state };
  },
}));

import { aiReviewerRoutes } from "../src/routes/ai-reviewer.routes.js";
import { reviewerCriteriaRoutes, loadPublishedCriteria } from "../src/routes/reviewer-criteria.routes.js";

async function buildApp(routes: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: "INVALID_INPUT" } });
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  await app.register(routes);
  await app.ready();
  return app;
}

const TEAM_1 = "22222222-2222-4222-8222-222222222222";
const TEAM_2 = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

async function call(
  routes: (app: FastifyInstance) => Promise<void>,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
) {
  const app = await buildApp(routes);
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  await app.close();
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(() => {
  H.userId = "user-1";
  H.role = "ADMIN";
  H.memberTeams = new Set([TEAM_1]);
  H.audits.length = 0;
  H.interactions.length = 0;
  H.qcRunsThrow = false;
  H.qcRunsThrowGeneric = false;
  H.qcRuns = [
    {
      id: RUN_ID, workspaceId: TEAM_1, feature: "REVIEWER_COPILOT", status: "ok",
      generatedAt: new Date("2026-07-10T00:00:00Z"), caseId: null, userId: "user-9",
      reviewId: "55555555-5555-4555-8555-555555555555", criteriaVersion: "Default v1",
      observationReviews: [
        { state: "EDITED", observationId: "obs-a", actorId: "user-1", updatedAt: new Date("2026-07-10T01:00:00Z") },
        { state: "ACCEPTED", observationId: "obs-b", actorId: "user-1", updatedAt: new Date("2026-07-10T01:00:00Z") },
        // Two QC reviewers: user-9's verdict is NEWER, user-1's is the caller's own.
        { state: "ACCEPTED", observationId: "qc", actorId: "user-1", updatedAt: new Date("2026-07-10T02:00:00Z") },
        { state: "EDITED", observationId: "qc", actorId: "user-9", updatedAt: new Date("2026-07-10T03:00:00Z") },
      ],
    },
    {
      id: "66666666-6666-4666-8666-666666666666", workspaceId: TEAM_1, feature: "EVIDENCE_COPILOT",
      status: "blocked_prohibited_claim", generatedAt: new Date("2026-07-09T00:00:00Z"), userId: "user-2",
      caseId: "77777777-7777-4777-8777-777777777777", reviewId: null, criteriaVersion: null,
      observationReviews: [],
    },
  ];
  H.sets.clear();
  H.versions.clear();
  H.seq = 0;
});

// ===========================================================================
// Phase 1 — QC sampling routes.
// ===========================================================================
describe("Phase 1 — QC sampling routes (inject)", () => {
  it("GET samples: membership-gated, returns panel row shape incl. deep-link fields + qcState", async () => {
    const { status, body } = await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_1}&strategy=RISK_BASED`);
    expect(status).toBe(200);
    expect(body.strategy).toBe("RISK_BASED");
    expect(body.samples.length).toBeGreaterThan(0);
    const withQc = body.samples.find((s: { id: string }) => s.id === RUN_ID);
    expect(withQc).toBeTruthy();
    expect(withQc.qcState).toBe("ACCEPTED");
    expect(withQc.reviewId).toBe("55555555-5555-4555-8555-555555555555");
    expect(withQc.criteriaVersion).toBe("Default v1");
    // The "qc" pseudo-observation is EXCLUDED from interaction counts.
    expect(withQc.interactionCount).toBe(2);
    expect(withQc.editedCount).toBe(1);
    // Phase F-5 — DETERMINISTIC QC state: caller's own verdict wins over the
    // newer verdict from another reviewer; both are exposed with the count.
    expect(withQc.myQcState).toBe("ACCEPTED");
    expect(withQc.latestQcState).toBe("EDITED"); // user-9's is newest
    expect(withQc.qcReviewerCount).toBe(2);
    expect(withQc.qcState).toBe("ACCEPTED"); // mine, not arbitrary-first
  });

  it("without an own verdict the LATEST verdict is served (never arbitrary-first)", async () => {
    H.userId = "user-3"; // member with no QC verdict of their own
    const { body } = await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_1}&strategy=RISK_BASED`);
    const row = body.samples.find((s: { id: string }) => s.id === RUN_ID);
    expect(row.myQcState).toBeNull();
    expect(row.qcState).toBe("EDITED"); // latest by updatedAt (user-9)
    expect(row.qcReviewerCount).toBe(2);
  });

  it("GET samples: non-member 403; invalid strategy 400", async () => {
    expect((await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_2}`)).status).toBe(403);
    expect((await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_1}&strategy=DROP_TABLE`)).status).toBe(400);
  });

  it("GET samples: MIGRATION-shaped failure (P2021) → honest catalogAvailable:false", async () => {
    H.qcRunsThrow = true;
    const { status, body } = await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_1}`);
    expect(status).toBe(200);
    expect(body.samples).toEqual([]);
    expect(body.catalogAvailable).toBe(false);
  });

  it("GET samples: NON-migration failure propagates as a structured error (F-5, no catch-all)", async () => {
    H.qcRunsThrowGeneric = true;
    const { status, body } = await call(aiReviewerRoutes, "GET", `/v1/ai/qc/samples?teamId=${TEAM_1}`);
    expect(status).toBe(500);
    expect(body.catalogAvailable).toBeUndefined();
  });

  it("POST decision: QC verdict persisted via canonical observationId 'qc' + audited", async () => {
    for (const [decision, state] of [
      ["QC_ACCEPTED", "ACCEPTED"],
      ["QC_SKIPPED", "REJECTED"],
      ["QC_REVIEWED", "EDITED"],
    ] as const) {
      H.interactions.length = 0;
      const { status, body } = await call(aiReviewerRoutes, "POST", `/v1/ai/qc/samples/${RUN_ID}/decision`, { decision });
      expect(status).toBe(200);
      expect(body.decision).toBe(decision);
      expect(H.interactions[0]).toMatchObject({ copilotRunId: RUN_ID, observationId: "qc", state, actorId: "user-1" });
    }
    expect(H.audits.filter((e) => e.action === "ai.qc_decision").length).toBe(3);
  });

  it("POST decision: unknown run 404; non-member 403; invalid decision 400", async () => {
    expect((await call(aiReviewerRoutes, "POST", `/v1/ai/qc/samples/99999999-9999-4999-8999-999999999999/decision`, { decision: "QC_ACCEPTED" })).status).toBe(404);
    H.memberTeams = new Set();
    expect((await call(aiReviewerRoutes, "POST", `/v1/ai/qc/samples/${RUN_ID}/decision`, { decision: "QC_ACCEPTED" })).status).toBe(403);
    H.memberTeams = new Set([TEAM_1]);
    expect((await call(aiReviewerRoutes, "POST", `/v1/ai/qc/samples/${RUN_ID}/decision`, { decision: "DELETE_RUN" })).status).toBe(400);
  });
});

// ===========================================================================
// Phase 2 — Reviewer Criteria lifecycle.
// ===========================================================================
describe("Phase 2 — Reviewer Criteria lifecycle (inject)", () => {
  const CRITERIA = [{ key: "custody", title: "Custody chain reviewed", required: true, order: 0 }];

  async function createSet() {
    const res = await call(reviewerCriteriaRoutes, "POST", "/v1/reviewer-criteria", {
      teamId: TEAM_1, name: "Default", title: "Default checklist", criteria: CRITERIA,
    });
    expect(res.status).toBe(201);
    return res.body.set.id as string;
  }

  it("full lifecycle: draft → edit → publish → immutable → duplicate v2 → retire (all audited)", async () => {
    const setId = await createSet();
    expect(H.sets.get(setId)!.status).toBe("DRAFT");

    // Edit the draft.
    const edit = await call(reviewerCriteriaRoutes, "PATCH", `/v1/reviewer-criteria/${setId}/draft`, {
      teamId: TEAM_1, title: "Default checklist (rev)",
      criteria: [...CRITERIA, { key: "tsa", title: "Timestamp confirmed", required: false, order: 1 }],
    });
    expect(edit.status).toBe(200);
    expect(versionsOfSet(setId)[0].criteria.length).toBe(2);

    // Publish v1.
    const pub = await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 });
    expect(pub.status).toBe(200);
    expect(H.sets.get(setId)!.status).toBe("PUBLISHED");
    expect(versionsOfSet(setId)[0].publishedAt).not.toBeNull();

    // Published version is IMMUTABLE.
    const editPublished = await call(reviewerCriteriaRoutes, "PATCH", `/v1/reviewer-criteria/${setId}/draft`, {
      teamId: TEAM_1, criteria: CRITERIA,
    });
    expect(editPublished.status).toBe(409);
    expect(editPublished.body.error.code).toBe("published_immutable");
    // Double-publish is rejected too.
    expect((await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 })).status).toBe(409);

    // Duplicate as v2 (copies criteria, set back to DRAFT).
    const dup = await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/duplicate`, { teamId: TEAM_1 });
    expect(dup.status).toBe(201);
    expect(dup.body.version).toBe(2);
    expect(H.sets.get(setId)!.status).toBe("DRAFT");
    expect(versionsOfSet(setId)[0].criteria.length).toBe(2);
    // A second duplicate while the draft exists is rejected.
    const dup2 = await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/duplicate`, { teamId: TEAM_1 });
    expect(dup2.status).toBe(409);
    expect(dup2.body.error.code).toBe("draft_exists");

    // Retire.
    const retire = await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/retire`, { teamId: TEAM_1 });
    expect(retire.status).toBe(200);
    expect(H.sets.get(setId)!.status).toBe("RETIRED");
    expect(versionsOfSet(setId).find((v) => v.version === 1)!.retiredAt).not.toBeNull();

    // Every transition audited.
    const actions = H.audits.map((e) => e.action);
    for (const a of ["reviewer_criteria.created", "reviewer_criteria.draft_updated", "reviewer_criteria.published", "reviewer_criteria.duplicated", "reviewer_criteria.retired"]) {
      expect(actions).toContain(a);
    }
  });

  it("authoring is OWNER/ADMIN-only; membership required; cross-tenant set is 404", async () => {
    const setId = await createSet();
    H.role = "MEMBER";
    for (const [method, url, payload] of [
      ["POST", "/v1/reviewer-criteria", { teamId: TEAM_1, name: "X", title: "X", criteria: CRITERIA }],
      ["PATCH", `/v1/reviewer-criteria/${setId}/draft`, { teamId: TEAM_1, criteria: CRITERIA }],
      ["POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 }],
      ["POST", `/v1/reviewer-criteria/${setId}/duplicate`, { teamId: TEAM_1 }],
      ["POST", `/v1/reviewer-criteria/${setId}/retire`, { teamId: TEAM_1 }],
    ] as const) {
      const res = await call(reviewerCriteriaRoutes, method, url, payload);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("permission_denied");
    }
    // Cross-tenant teamId in the body → anti-enumeration 404 (member of TEAM_2 but the set belongs to TEAM_1).
    H.role = "ADMIN";
    H.memberTeams = new Set([TEAM_2]);
    expect((await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_2 })).status).toBe(404);
  });

  it("detail route returns full version history with criteria (VersionHistory consumer)", async () => {
    const setId = await createSet();
    await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 });
    await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/duplicate`, { teamId: TEAM_1 });
    const { status, body } = await call(reviewerCriteriaRoutes, "GET", `/v1/reviewer-criteria/${setId}?teamId=${TEAM_1}`);
    expect(status).toBe(200);
    expect(body.set.versions.length).toBe(2);
    expect(body.set.versions[0].version).toBe(2);
    expect(body.set.versions[0].publishedAt).toBeNull();
    expect(body.set.versions[1].publishedAt).not.toBeNull();
    expect(body.set.versions[1].criteria[0].key).toBe("custody");
  });

  it("F-4 optimistic concurrency: stale expectedUpdatedAt → 409 draft_conflict; fresh token saves", async () => {
    const setId = await createSet();
    const stale = new Date("2020-01-01T00:00:00Z").toISOString();
    const conflicted = await call(reviewerCriteriaRoutes, "PATCH", `/v1/reviewer-criteria/${setId}/draft`, {
      teamId: TEAM_1, expectedUpdatedAt: stale, criteria: CRITERIA,
    });
    expect(conflicted.status).toBe(409);
    expect(conflicted.body.error.code).toBe("draft_conflict");
    expect(conflicted.body.error.currentUpdatedAt).toBeTruthy();
    // Criteria were NOT overwritten by the conflicting save.
    expect(versionsOfSet(setId)[0].criteria.length).toBe(1);

    // With the CURRENT token the save succeeds, and the token advances.
    const current = new Date(H.sets.get(setId)!.updatedAt).toISOString();
    const saved = await call(reviewerCriteriaRoutes, "PATCH", `/v1/reviewer-criteria/${setId}/draft`, {
      teamId: TEAM_1, expectedUpdatedAt: current,
      criteria: [...CRITERIA, { key: "tsa", title: "Timestamp confirmed", required: false, order: 1 }],
    });
    expect(saved.status).toBe(200);
    expect(versionsOfSet(setId)[0].criteria.length).toBe(2);
    expect(new Date(H.sets.get(setId)!.updatedAt).toISOString()).not.toBe(current);
  });

  it("F-4 usage statistics: per-version run/review/reviewer counts from Copilot runs", async () => {
    const setId = await createSet();
    await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 });
    // Seed two runs against "Default v1" (one shared review, two reviewers)
    // plus an unrelated run.
    H.qcRuns = [
      { id: "r1", workspaceId: TEAM_1, criteriaVersion: "Default v1", reviewId: "rev-1", userId: "user-1", generatedAt: new Date("2026-07-10T00:00:00Z") },
      { id: "r2", workspaceId: TEAM_1, criteriaVersion: "Default v1", reviewId: "rev-1", userId: "user-2", generatedAt: new Date("2026-07-11T00:00:00Z") },
      { id: "r3", workspaceId: TEAM_1, criteriaVersion: "Other v1", reviewId: "rev-2", userId: "user-1", generatedAt: new Date("2026-07-11T00:00:00Z") },
    ];
    const { status, body } = await call(reviewerCriteriaRoutes, "GET", `/v1/reviewer-criteria/${setId}/usage?teamId=${TEAM_1}`);
    expect(status).toBe(200);
    expect(body.usageAvailable).toBe(true);
    const v1 = body.usage.find((u: { version: number }) => u.version === 1);
    expect(v1).toMatchObject({ runCount: 2, reviewCount: 1, reviewerCount: 2 });
    expect(v1.lastUsedAt).toBeTruthy();
    // Non-member → 403; unknown set → 404.
    H.memberTeams = new Set();
    expect((await call(reviewerCriteriaRoutes, "GET", `/v1/reviewer-criteria/${setId}/usage?teamId=${TEAM_1}`)).status).toBe(403);
    H.memberTeams = new Set([TEAM_1]);
    expect((await call(reviewerCriteriaRoutes, "GET", `/v1/reviewer-criteria/99999999-9999-4999-8999-999999999999/usage?teamId=${TEAM_1}`)).status).toBe(404);
  });

  it("loadPublishedCriteria: server-side resolution rejects forged / unpublished / cross-tenant", async () => {
    const setId = await createSet();
    // Unpublished draft → NOT_PUBLISHED.
    expect(await loadPublishedCriteria({ teamId: TEAM_1, criteriaSetId: setId })).toEqual({ ok: false, code: "NOT_PUBLISHED" });
    await call(reviewerCriteriaRoutes, "POST", `/v1/reviewer-criteria/${setId}/publish`, { teamId: TEAM_1 });
    // Published → resolved with version label + criteria.
    const ok = await loadPublishedCriteria({ teamId: TEAM_1, criteriaSetId: setId });
    expect(ok && ok.ok).toBe(true);
    if (ok && ok.ok) {
      expect(ok.versionLabel).toBe("Default v1");
      expect(ok.criteria[0].key).toBe("custody");
    }
    // Cross-tenant → CROSS_TENANT.
    expect(await loadPublishedCriteria({ teamId: TEAM_2, criteriaSetId: setId })).toEqual({ ok: false, code: "CROSS_TENANT" });
    // Forged version id → NOT_PUBLISHED (never silently substituted).
    const forged = await loadPublishedCriteria({ teamId: TEAM_1, criteriaSetId: setId, criteriaVersionId: "88888888-8888-4888-8888-888888888888" });
    expect(forged).toEqual({ ok: false, code: "NOT_PUBLISHED" });
    // Unknown set → NOT_FOUND; no set referenced → null (freeform fallback).
    expect(await loadPublishedCriteria({ teamId: TEAM_1, criteriaSetId: "99999999-9999-4999-8999-999999999999" })).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await loadPublishedCriteria({ teamId: TEAM_1 })).toBeNull();
  });
});
