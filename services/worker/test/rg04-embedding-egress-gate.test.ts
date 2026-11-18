/**
 * RG-04 — semantic egress in the worker (PRO-AI1C-01 and its aliases
 * PRO-AI1-01, PRO-W2-01, PRO-W2-02, PRO-W2-03).
 *
 * Drives the REAL mi-embed processor, the search-index safety net and the
 * reconciler's enqueue loop against a stubbed database. Only the provider
 * transport (the `openai` SDK) and the queue are mocked; the policy, plan,
 * lifecycle and budget decisions under test run for real.
 *
 * At the base SHA:
 *   - a policy-read error was swallowed and the job embedded (PRO-W2-02);
 *   - a usage-read error lifted the caps (PRO-W2-02);
 *   - a FREE / lapsed workspace with a saved policy embedded (PRO-W2-03);
 *   - the search-index job sent chunk text to the vendor itself (PRO-W2-01).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const CHUNK = "33333333-3333-4333-8333-333333333333";
const EVIDENCE = "44444444-4444-4444-8444-444444444444";

type Policy = {
  aiEnabled: boolean;
  semanticSearchEnabled: boolean;
  embeddingsAllowed: boolean;
  contentIntelligenceEnabled: boolean;
} | null;

const state = {
  policy: null as Policy,
  policyThrows: false,
  usageThrows: false,
  billingPlan: "PRO",
  ownerPlan: "PRO",
  subscriptions: [] as Array<Record<string, unknown>>,
  owedRows: [] as Array<Record<string, unknown>>,
  embedCalls: 0,
  enqueued: [] as string[],
};

const ALLOW: Policy = {
  aiEnabled: true,
  semanticSearchEnabled: true,
  embeddingsAllowed: true,
  contentIntelligenceEnabled: true,
};

vi.mock("openai", () => {
  class OpenAI {
    embeddings = {
      create: vi.fn(async (req: { input: string[] }) => {
        state.embedCalls += 1;
        return { data: req.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) };
      }),
    };
  }
  return { default: OpenAI, OpenAI };
});

vi.mock("../src/queue.js", () => ({
  enqueueMiEmbedJob: vi.fn(async (id: string) => {
    state.enqueued.push(id);
    return { enqueued: true };
  }),
  redisConnection: {},
}));

vi.mock("../src/cron-lock.js", () => ({
  withCronLock: vi.fn(async (_k: string, fn: () => Promise<void>) => {
    await fn();
    return { ran: true };
  }),
}));

vi.mock("../src/canonical-job.js", () => ({
  decodeCanonicalJob: vi.fn(() => ({ commandId: CHUNK, traceId: "t" })),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceSemanticChunk: {
      findUnique: vi.fn(async () => ({ id: CHUNK, teamId: TEAM })),
    },
    workspaceAiPolicy: {
      findUnique: vi.fn(async () => {
        if (state.policyThrows) throw new Error("policy read failed");
        return state.policy;
      }),
    },
    semanticUsageDaily: {
      findUnique: vi.fn(async () => {
        if (state.usageThrows) throw new Error("usage read failed");
        return null;
      }),
      findMany: vi.fn(async () => {
        if (state.usageThrows) throw new Error("usage read failed");
        return [];
      }),
      upsert: vi.fn(async () => ({})),
    },
    team: {
      findUnique: vi.fn(async () => ({
        id: TEAM,
        ownerUserId: OWNER,
        organizationId: null,
        billingPlan: state.billingPlan,
        billingStatus: "ACTIVE",
        includedSeats: 1,
        storageBytesOverride: null,
        // A Pro person's Personal Space: the owner's plan governs it.
        workspaceKind: "PERSONAL",
        isPersonal: true,
      })),
      findFirst: vi.fn(async () => null),
    },
    entitlement: { findFirst: vi.fn(async () => ({ plan: state.ownerPlan })) },
    planGrant: { findFirst: vi.fn(async () => null) },
    workspaceStorageAddon: {
      aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })),
    },
    enterpriseContract: { findUnique: vi.fn(async () => null) },
    subscription: {
      findMany: vi.fn(async (args: { where: { status?: { in?: string[] } } }) =>
        state.subscriptions.filter((r) => args.where.status?.in?.includes(String(r.status)) ?? true),
      ),
      findFirst: vi.fn(async (args: { where: { status?: string } }) =>
        state.subscriptions.find((r) => !args.where.status || r.status === args.where.status) ?? null,
      ),
    },
    $queryRawUnsafe: vi.fn(async () => [{ present: true }]),
    $queryRaw: vi.fn(async () => state.owedRows),
    $executeRaw: vi.fn(async () => 1),
  },
}));

const { processMiEmbedJob } = await import("../src/mi-embed.processor.js");
const { backfillSemanticEmbeddings } = await import("../src/search-indexing.processor.js");
const { decideSemanticEgressPolicy, workspaceSemanticEgressAllowed, canEmbedMore } = await import(
  "../src/embedding-egress-gate.js"
);

const job = { id: "j1", name: "embed-semantic-chunks", data: {} } as never;

beforeEach(() => {
  process.env.SEMANTIC_SEARCH_ENABLED = "true";
  process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "openai";
  process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND = "true";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  state.policy = ALLOW;
  state.policyThrows = false;
  state.usageThrows = false;
  state.billingPlan = "PRO";
  state.ownerPlan = "PRO";
  state.subscriptions = [];
  state.owedRows = [{ id: CHUNK, chunk_text: "jane doe statement" }];
  state.embedCalls = 0;
  state.enqueued = [];
});

describe("RG-04 worker semantic-egress gate", () => {
  it("positive: entitled Pro workspace with the policy on embeds through mi-embed", async () => {
    await processMiEmbedJob(job);
    expect(state.embedCalls).toBe(1);
  });

  it("PRO-W2-02: a policy-read failure throws (retry) and makes zero provider calls", async () => {
    state.policyThrows = true;
    await expect(processMiEmbedJob(job)).rejects.toThrow(/policy read failed/);
    expect(state.embedCalls).toBe(0);
  });

  it("PRO-W2-02: an unreadable usage row refuses instead of lifting the caps", async () => {
    state.usageThrows = true;
    await processMiEmbedJob(job);
    expect(state.embedCalls).toBe(0);
    await expect(canEmbedMore(TEAM, 1)).resolves.toEqual({ allowed: false, reason: "USAGE_UNREADABLE" });
  });

  it("PRO-W2-03: a FREE workspace whose saved policy still says on is not embedded", async () => {
    state.billingPlan = "FREE";
    state.ownerPlan = "FREE";
    await processMiEmbedJob(job);
    expect(state.embedCalls).toBe(0);
    await expect(workspaceSemanticEgressAllowed(TEAM)).resolves.toEqual({
      allowed: false,
      denial: "PLAN_NOT_ENTITLED",
    });
  });

  it("PRO-W2-03: a lapsed paid workspace (past due beyond grace) is not embedded", async () => {
    state.subscriptions = [
      {
        status: "PAST_DUE",
        currentPeriodEnd: new Date(Date.now() - 30 * 24 * 3600_000),
        plan: "PRO",
        userId: OWNER,
      },
    ];
    const verdict = await workspaceSemanticEgressAllowed(TEAM);
    expect(verdict.allowed).toBe(false);
    await processMiEmbedJob(job);
    expect(state.embedCalls).toBe(0);
  });

  it("refusal: embeddingsAllowed=false, aiEnabled=false or no derived content -> zero provider calls", async () => {
    for (const policy of [
      { ...ALLOW!, embeddingsAllowed: false },
      { ...ALLOW!, aiEnabled: false },
      { ...ALLOW!, contentIntelligenceEnabled: false },
      null,
    ]) {
      state.policy = policy;
      await processMiEmbedJob(job);
    }
    expect(state.embedCalls).toBe(0);
  });

  it("PRO-W2-01: the search-index safety net never calls the provider; it hands an owed chunk to mi-embed", async () => {
    state.owedRows = [{ id: CHUNK }];
    await expect(backfillSemanticEmbeddings(TEAM, EVIDENCE)).resolves.toBe(1);
    expect(state.enqueued).toEqual([CHUNK]);
    expect(state.embedCalls).toBe(0);
  });

  it("PRO-W2-01: policy off -> the safety net enqueues nothing", async () => {
    state.policy = { ...ALLOW!, semanticSearchEnabled: false };
    await expect(backfillSemanticEmbeddings(TEAM, EVIDENCE)).resolves.toBe(0);
    expect(state.enqueued).toEqual([]);
    expect(state.embedCalls).toBe(0);
  });

  it("the pure policy half mirrors the API evaluator's order", () => {
    expect(decideSemanticEgressPolicy({ globalEnabled: false, policy: ALLOW }).denial).toBe("GLOBAL_DISABLED");
    expect(decideSemanticEgressPolicy({ globalEnabled: true, policy: null }).denial).toBe("FEATURE_DISABLED");
    expect(decideSemanticEgressPolicy({ globalEnabled: true, policy: ALLOW }).allowed).toBe(true);
  });
});
