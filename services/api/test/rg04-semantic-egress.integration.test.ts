/**
 * RG-04 — semantic egress through the API (PRO-AI1C-01 path E = PRO-E1-01,
 * path A live indexing = PRO-AI1-01 chunk creation, path F backfill CLI).
 *
 * Live PostgreSQL 16 through the real `buildServer()` route stack. Only the
 * embedding provider's TRANSPORT (the `openai` SDK) is replaced, so every
 * embeddings.create call is counted and nothing leaves the machine.
 *
 * At the base SHA the hybrid search embedded the query for a workspace whose
 * AI policy was off or whose plan excludes semantic search, and
 * indexEvidenceText wrote chunk text before asking the policy.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

const transport = vi.hoisted(() => ({ calls: 0 }));

vi.mock("openai", () => {
  class OpenAI {
    embeddings = {
      create: async (req: { input: string[]; dimensions?: number }) => {
        transport.calls += 1;
        const dim = req.dimensions ?? 1536;
        return {
          data: req.input.map(() => ({ embedding: Array.from({ length: dim }, () => 0.001) })),
        };
      },
    };
  }
  return { default: OpenAI, OpenAI };
});

describe("RG-04 semantic egress (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let indexEvidence: (typeof import("../src/services/search/evidence-indexing.service.js"))["indexEvidence"];
  let indexEvidenceText: (typeof import("../src/services/intelligence/semantic.service.js"))["indexEvidenceText"];
  let runSemanticBackfill: (typeof import("../src/services/search/semantic-backfill.service.js"))["runSemanticBackfill"];
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let resetProvider: () => void;
  let deps: FixtureDeps;
  let user: SeededUser;
  let teamId: string;
  let orgId: string;
  let evidenceId: string;

  const ALLOW = {
    aiEnabled: true,
    semanticSearchEnabled: true,
    embeddingsAllowed: true,
    contentIntelligenceEnabled: true,
  };

  function mint(userId: string, email: string): string {
    return signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
  }

  async function setPolicy(patch: Partial<typeof ALLOW>) {
    const data = { ...ALLOW, ...patch };
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId },
      create: { teamId, ...data } as never,
      update: data,
    });
  }

  async function hybrid(): Promise<Record<string, unknown>> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?${new URLSearchParams({ teamId, q: "harbour crane", mode: "hybrid" })}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    // Set AFTER the harness boot (the bootstrap declares OPENAI_API_KEY
    // unconfigured); the transport above is a stub, so the key is never used.
    process.env.SEMANTIC_SEARCH_ENABLED = "true";
    process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "openai";
    process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    ({ _resetEmbeddingProviderForTests: resetProvider } = await import(
      "../src/services/search/embedding-provider.js"
    ));
    resetProvider();
    ({ prisma } = await import("../src/db.js"));
    ({ indexEvidence } = await import("../src/services/search/evidence-indexing.service.js"));
    ({ indexEvidenceText } = await import("../src/services/intelligence/semantic.service.js"));
    ({ runSemanticBackfill } = await import("../src/services/search/semantic-backfill.service.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = { prisma: prisma as never, mintToken: mint, tag: `rg04-${randomUUID().slice(0, 8)}` };
    user = await seedUser(deps, "rg04-owner");
    const ps = await bootstrapPersonalSpace(deps, user.userId);
    teamId = ps.teamId;
    orgId = ps.organizationId;
    evidenceId = randomUUID();
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        teamId,
        organization: { connect: { id: orgId } },
        type: "PHOTO",
        ownerUserId: user.userId,
        uploadedByUserId: user.userId,
        status: "SIGNED",
        title: "Harbour crane inspection",
      },
    });
    const indexed = await indexEvidence({ teamId, evidenceId });
    expect(indexed.ok).toBe(true);
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 120_000);

  beforeEach(async () => {
    transport.calls = 0;
    // Re-asserted per test: the route stack's runtime-secret refresh can
    // re-apply the bootstrap's "OpenAI unconfigured" state.
    process.env.SEMANTIC_SEARCH_ENABLED = "true";
    process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "openai";
    process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    resetProvider();
  });

  it("refusal (Free plan, policy fully on): hybrid search sends nothing and reports keyword", async () => {
    await setAccountPlan(deps, user.userId, "FREE");
    await setPolicy({});
    const body = await hybrid();
    expect(transport.calls).toBe(0);
    expect(body.modeUsed).toBe("KEYWORD");
    expect(body.fallbackReason).toBe("SEMANTIC_FEATURE_DISABLED");
  });

  it("refusal (Pro plan, aiEnabled=false or embeddingsAllowed=false): nothing sent", async () => {
    await setAccountPlan(deps, user.userId, "PRO");
    for (const patch of [{ aiEnabled: false }, { embeddingsAllowed: false }, { semanticSearchEnabled: false }]) {
      await setPolicy(patch);
      const body = await hybrid();
      expect(body.modeUsed).toBe("KEYWORD");
    }
    expect(transport.calls).toBe(0);
  });

  it("positive (Pro plan, policy on): the query is embedded once and the usage is recorded", async () => {
    await setAccountPlan(deps, user.userId, "PRO");
    await setPolicy({});
    const before = await prisma.semanticUsageDaily.aggregate({
      where: { workspaceId: teamId },
      _sum: { chunksEmbedded: true },
    });
    const body = await hybrid();
    expect(transport.calls).toBe(1);
    expect(body.modeUsed).not.toBe("KEYWORD");
    const after = await prisma.semanticUsageDaily.aggregate({
      where: { workspaceId: teamId },
      _sum: { chunksEmbedded: true },
    });
    expect((after._sum.chunksEmbedded ?? 0) - (before._sum.chunksEmbedded ?? 0)).toBe(1);
  });

  it("PRO-AI1-01: indexEvidenceText writes no chunk text for a workspace that may not embed", async () => {
    await setAccountPlan(deps, user.userId, "PRO");
    await setPolicy({ embeddingsAllowed: false });
    const out = await indexEvidenceText({ evidenceId, teamId, text: "Jane Doe said the crane was unsafe." });
    expect(out.chunks).toBe(0);
    expect(await prisma.evidenceSemanticChunk.count({ where: { evidenceId } })).toBe(0);
  });

  it("PRO-AI1-01: a later policy-off re-index removes chunk text left by an earlier allowed index", async () => {
    await setAccountPlan(deps, user.userId, "PRO");
    await setPolicy({});
    const first = await indexEvidenceText({ evidenceId, teamId, text: "Jane Doe said the crane was unsafe." });
    expect(first.chunks).toBeGreaterThan(0);
    await setPolicy({ aiEnabled: false });
    await indexEvidenceText({ evidenceId, teamId, text: "Jane Doe said the crane was unsafe." });
    expect(await prisma.evidenceSemanticChunk.count({ where: { evidenceId } })).toBe(0);
    expect(transport.calls).toBe(0);
  });

  it("path F: the backfill service (and so the CLI) refuses a denied workspace before any provider call", async () => {
    await setAccountPlan(deps, user.userId, "FREE");
    await setPolicy({});
    await prisma.evidenceSemanticChunk.create({
      data: { evidenceId, teamId, chunkIndex: 900, chunkText: "legacy chunk row" },
    });
    const result = await runSemanticBackfill({ workspaceId: teamId, batchSize: 5, maxBatches: 1 });
    expect(result.skippedReason).toBe("WORKSPACE_POLICY_DENIED");
    expect(transport.calls).toBe(0);
  });
});
