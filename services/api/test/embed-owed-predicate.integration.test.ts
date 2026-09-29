/**
 * ET-Q-10 — the intelligence-run reconciler's "owes an embedding" population
 * is chunks with no `embedding_vector`, in a workspace whose AI policy allows
 * embeddings. Live PostgreSQL 16 (pgvector), the real worker predicate.
 *
 * On a40ca76f it selected `embedding IS NULL` — a legacy column nothing writes
 * — so every chunk aged 30 min – 30 days was owed forever, including chunks
 * already embedded and chunks in workspaces whose policy forbids embedding.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("embed-owed predicate (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function evidence(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `emb ${randomUUID().slice(0, 6)}`, type: "DOCUMENT", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  async function chunk(teamId: string, evidenceId: string, ageMs: number, embedded: boolean) {
    const { id } = await prisma.evidenceSemanticChunk.create({
      data: { teamId, evidenceId, chunkIndex: Math.floor(Math.random() * 1e6), chunkText: "text", createdAt: new Date(Date.now() - ageMs) } as never,
      select: { id: true },
    });
    if (embedded) {
      const vec = `[${Array.from({ length: 1536 }, () => "0.001").join(",")}]`;
      await prisma.$executeRawUnsafe(`UPDATE evidence_semantic_chunks SET embedding_vector = '${vec}'::vector WHERE id = '${id}'::uuid`);
    }
    return id;
  }

  it("owed = no embedding_vector, inside the window, in a workspace that allows embeddings", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: A.teamId },
      create: { teamId: A.teamId, aiEnabled: true, semanticSearchEnabled: true, embeddingsAllowed: true } as never,
      update: { aiEnabled: true, semanticSearchEnabled: true, embeddingsAllowed: true },
    });
    await prisma.workspaceAiPolicy.deleteMany({ where: { teamId: B.teamId } });
    const evA = await evidence(A.teamId, A.ownerUserId);
    const evB = await evidence(B.teamId, B.ownerUserId);
    const HOUR = 3600_000;
    const owed = await chunk(A.teamId, evA, HOUR, false);
    const embedded = await chunk(A.teamId, evA, HOUR, true);
    const tooFresh = await chunk(A.teamId, evA, 60_000, false);
    const disallowed = await chunk(B.teamId, evB, HOUR, false);

    const { selectChunksOwingEmbedding } = await import("../../worker/src/intelligence-run-reconciler.js");
    const got = (
      await selectChunksOwingEmbedding({
        floor: new Date(Date.now() - 30 * 60_000),
        ceiling: new Date(Date.now() - 30 * 24 * HOUR),
        limit: 500,
      })
    ).map((r) => r.id);
    expect(got).toContain(owed);
    expect(got).not.toContain(embedded);
    expect(got).not.toContain(tooFresh);
    expect(got).not.toContain(disallowed);
  });

  it("the reconciler reads the predicate, not the legacy column", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../worker/src/intelligence-run-reconciler.ts", import.meta.url), "utf8");
    expect(src).toContain("const owed = await selectChunksOwingEmbedding({");
    expect(src).not.toMatch(/embedding:\s*null/);
  });
});
