/**
 * PHASE 12 — POINT 5, FAMILY 9: intelligence and operations.
 *
 * FOUR UNITS, FOUR DIFFERENT DURABLE AUTHORITIES
 * ---------------------------------------------------------------------------
 *   RunMediaIntelligence   MediaIntelligenceRun      claim + fence + terminal
 *   ExtractExif            EvidencePart              upsert by natural key
 *   GenerateDerivedAsset   EvidencePartDerivedAsset  claim + terminal
 *   EmbedSemanticChunks    EvidenceSemanticChunk     upsert by natural key
 *
 * (`ExtractOcr` and `ExtractTranscript` are NOT in this list because they are
 * no longer in the registry: they were no-op processors shadowing capabilities
 * `RunMediaIntelligence` already owns. See
 * `test/phase-12-point5-ocr-transcript-authority.test.ts`.)
 *
 * The four are driven through the SHARED conformance harness rather than four
 * hand-written suites, so the seven non-waivable invariants are asserted by one
 * body of code and a copy-paste slip cannot quietly weaken one unit's tenancy
 * case. Family-specific properties are stated separately, below.
 *
 * EXTERNAL BOUNDARIES
 * ---------------------------------------------------------------------------
 * Two, both RECORDING fakes: the media-intelligence analyzer (an AI provider
 * call) and object storage. Everything else — the claim, the fence, the policy
 * reload, the tenancy derivation, every terminal write — is the real
 * production path against live PostgreSQL 16.
 *
 * This suite requires a database with `pgvector`: `EmbedSemanticChunks`
 * selects on `embedding_vector IS NULL`, so a Postgres without the extension
 * cannot run it at all. That is stated as a hard failure rather than a skip —
 * a unit that silently does not run is exactly the fiction the proof gate
 * exists to prevent.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import {
  proveCommonConformance,
  type ConformanceContext,
  type UnitDriver,
  type WorkspaceFixture,
} from "./family-harness.js";

// ===========================================================================
// External boundaries
// ===========================================================================

/** The AI analyzer. Recorded per evidence so "charged once" is measurable. */
const analyzer = vi.hoisted(() => ({
  calls: [] as string[],
  outcome: "ok" as "ok" | "refuse",
  reset() {
    this.calls.length = 0;
    this.outcome = "ok";
  },
}));

vi.mock("@proovra/shared-runtime/media-intelligence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // ONLY the analyzer is replaced. `markRunProcessing`, `markRunCompleted`
    // and `markRunFailed` stay real — they ARE the claim and the terminal
    // writer, which is what this suite is about.
    runMediaIntelligenceAnalysis: async (input: {
      teamId: string;
      evidenceId: string;
    }) => {
      analyzer.calls.push(input.evidenceId);
      return analyzer.outcome === "ok"
        ? { ok: true as const, signalsEmitted: 0 }
        : { ok: false as const, reason: "service_unavailable" };
    },
  };
});

/** Object storage. Recorded, and switchable to a hard fetch failure. */
const storage = vi.hoisted(() => ({
  calls: [] as string[],
  mode: "ok" as "ok" | "fail",
  reset() {
    this.calls.length = 0;
    this.mode = "ok";
  },
}));

vi.mock("../../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getObjectRange: async (input: { key: string }) => {
      storage.calls.push(input.key);
      if (storage.mode === "fail") throw new Error("storage_unavailable");
      // A tiny non-image buffer: the EXIF extractor refuses it safely, which
      // is a real outcome and needs no image fixture on disk.
      return Buffer.from("not-an-image");
    },
    getObjectBuffer: async (input: { key: string }) => {
      storage.calls.push(input.key);
      if (storage.mode === "fail") throw new Error("storage_unavailable");
      return Buffer.from("not-an-image");
    },
  };
});

const RUN_ENTRY = getWorkEntryOrThrow(JOB_NAMES.RUN_MEDIA_INTELLIGENCE);
const EXIF_ENTRY = getWorkEntryOrThrow(JOB_NAMES.EXTRACT_EXIF);
const DERIVED_ENTRY = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
const EMBED_ENTRY = getWorkEntryOrThrow(JOB_NAMES.EMBED_SEMANTIC_CHUNKS);

describe("POINT 5 FAMILY — intelligence & operations (live PostgreSQL 16 + pgvector)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let miProcessor: typeof import("../../../worker/src/media-intelligence.processor.js");
  let derivedProcessor: typeof import("../../../worker/src/derived-assets.processor.js");
  let embedProcessor: typeof import("../../../worker/src/mi-embed.processor.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    // The embedding provider: LOCAL and deterministic, so no vendor is
    // contacted and the vector is reproducible. 1536 matches the column.
    process.env.SEMANTIC_SEARCH_ENABLED = "true";
    process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "local";
    process.env.SEMANTIC_EMBEDDING_DIMENSIONS = "1536";

    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);

    const [vec] = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'evidence_semantic_chunks'
            AND column_name = 'embedding_vector'
       ) AS ok`,
    );
    if (!vec?.ok) {
      throw new Error(
        "this suite requires a pgvector-enabled PostgreSQL 16: " +
          "evidence_semantic_chunks.embedding_vector is absent, so " +
          "EmbedSemanticChunks cannot be driven and its proof would be a fiction.",
      );
    }

    miProcessor = await import(
      "../../../worker/src/media-intelligence.processor.js"
    );
    derivedProcessor = await import(
      "../../../worker/src/derived-assets.processor.js"
    );
    embedProcessor = await import("../../../worker/src/mi-embed.processor.js");

    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Shared fixtures
  // =========================================================================

  /** A fresh evidence record, so each unit's rows never share a subject. */
  async function newEvidence(fixture: WorkspaceFixture): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `point5-mi-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function newPart(evidenceId: string, mime = "image/jpeg") {
    return prisma.evidencePart.create({
      data: {
        evidenceId,
        partIndex: 0,
        storageBucket: "point5-bucket",
        storageKey: `point5/${randomUUID()}`,
        mimeType: mime,
        sizeBytes: BigInt(1024),
        sha256: randomUUID().replace(/-/g, "").repeat(2).slice(0, 64),
      },
      select: { id: true },
    });
  }

  function job(entry: { workName: string; schemaVersion: number }, commandId: string) {
    return {
      id: `point5-${commandId}`,
      name: entry.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        commandId,
        traceId: "point5-intelligence",
        schemaVersion: entry.schemaVersion,
      },
    } as never;
  }

  // =========================================================================
  // Unit drivers
  // =========================================================================

  /** RunMediaIntelligence — the run row is the authority. */
  function runDriver(): UnitDriver {
    return {
      slug: "mirun",
      workName: RUN_ENTRY.workName,
      async seed({ fixture }) {
        const evidenceId = await newEvidence(fixture);
        const row = await prisma.mediaIntelligenceRun.create({
          data: {
            teamId: fixture.teamId,
            evidenceId,
            kind: "analyze_metadata",
            status: "PENDING",
          },
          select: { id: true },
        });
        return row.id;
      },
      async execute(rowId) {
        await miProcessor.processMediaIntelligenceJob(job(RUN_ENTRY, rowId));
      },
      async readState(rowId) {
        const row = await prisma.mediaIntelligenceRun.findUnique({
          where: { id: rowId },
          select: { status: true },
        });
        return row?.status ?? null;
      },
      async makeTerminal(rowId) {
        await prisma.mediaIntelligenceRun.update({
          where: { id: rowId },
          data: { status: "COMPLETED", completedAtUtc: new Date() },
        });
      },
      terminalStates: ["COMPLETED", "FAILED"],
      async externalCallCount(rowId) {
        const row = await prisma.mediaIntelligenceRun.findUnique({
          where: { id: rowId },
          select: { evidenceId: true },
        });
        if (!row) return 0;
        return analyzer.calls.filter((e) => e === row.evidenceId).length;
      },
      async countInWorkspace(teamId) {
        return prisma.mediaIntelligenceRun.count({ where: { teamId } });
      },
    };
  }

  /** ExtractExif — the evidence PART is the authority. */
  function exifDriver(): UnitDriver {
    return {
      slug: "miexif",
      workName: EXIF_ENTRY.workName,
      async seed({ fixture }) {
        const evidenceId = await newEvidence(fixture);
        const part = await newPart(evidenceId);
        return part.id;
      },
      async execute(rowId) {
        await miProcessor.processExifQueueJob(job(EXIF_ENTRY, rowId));
      },
      async readState(rowId) {
        // The DURABLE SUBJECT is the part; the summary is what execution
        // writes about it. So a part with no summary yet is `NO_SUMMARY`, and
        // `null` means the part itself does not exist — which is the
        // distinction the "executing an unknown id creates no state" case
        // depends on.
        const part = await prisma.evidencePart.findUnique({
          where: { id: rowId },
          select: { id: true },
        });
        if (!part) return null;
        const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
          `SELECT "status" FROM "evidence_part_exif_summaries"
            WHERE "evidence_part_id" = $1::uuid LIMIT 1`,
          rowId,
        );
        return rows[0]?.status ?? "NO_SUMMARY";
      },
      /**
       * Settle the projection by RUNNING it, not by writing a status by hand.
       *
       * EXIF is the one unit here with no terminal state to freeze: the
       * summary is a projection over the part's immutable bytes, re-derivable
       * at any time, and the registry records its idempotency as
       * `upsert_by_natural_key` with no claim. The guarantee is therefore
       * CONVERGENCE — a second execution over the same bytes reaches the same
       * summary — and the harness's stale-overwrite case measures exactly
       * that once the settled state is the one the real pipeline produced.
       *
       * Writing `OK` by hand instead would have asserted that a status the
       * pipeline could never derive from these bytes must survive re-running
       * the pipeline. That is not a guarantee this unit makes, or should.
       */
      async makeTerminal(rowId) {
        await miProcessor.processExifQueueJob(job(EXIF_ENTRY, rowId));
      },
      terminalStates: ["OK", "PARSE_FAILED", "FETCH_FAILED", "NO_SUMMARY"],
      async countInWorkspace(teamId) {
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM "evidence_part_exif_summaries"
            WHERE "team_id" = $1::uuid`,
          teamId,
        );
        return Number(rows[0]?.n ?? 0);
      },
    };
  }

  /** GenerateDerivedAsset — the derived-asset ROW is the authority. */
  function derivedDriver(): UnitDriver {
    return {
      slug: "miderived",
      workName: DERIVED_ENTRY.workName,
      async seed({ fixture }) {
        const evidenceId = await newEvidence(fixture);
        const part = await newPart(evidenceId);
        const row = await prisma.evidencePartDerivedAsset.create({
          data: {
            teamId: fixture.teamId,
            evidenceId,
            evidencePartId: part.id,
            // A kind the processor settles WITHOUT touching storage or a
            // pipeline, so the seven common invariants are measured on the
            // claim and the terminal write rather than on an image codec.
            // The bytes path is exercised separately, below.
            // A kind the DB permits and the processor settles as UNSUPPORTED
            // without touching storage or a codec.
            assetKind: "compact_review_preview",
            status: "PENDING",
          },
          select: { id: true },
        });
        return row.id;
      },
      async execute(rowId) {
        await derivedProcessor.processDerivedAssetJob(job(DERIVED_ENTRY, rowId));
      },
      async readState(rowId) {
        const row = await prisma.evidencePartDerivedAsset.findUnique({
          where: { id: rowId },
          select: { status: true },
        });
        return row?.status ?? null;
      },
      async makeTerminal(rowId) {
        await prisma.evidencePartDerivedAsset.update({
          where: { id: rowId },
          data: { status: "COMPLETED", generatedAtUtc: new Date() },
        });
      },
      // The statuses the DB CHECK actually permits as an end state. The
      // processor's replay guard tested `READY`, which this table can never
      // hold — see the note in `derived-assets.processor.ts`.
      terminalStates: ["COMPLETED", "UNSUPPORTED"],
      async countInWorkspace(teamId) {
        return prisma.evidencePartDerivedAsset.count({ where: { teamId } });
      },
    };
  }

  /** EmbedSemanticChunks — the anchor CHUNK is the authority. */
  function embedDriver(): UnitDriver {
    return {
      slug: "miembed",
      workName: EMBED_ENTRY.workName,
      async seed({ fixture }) {
        const evidenceId = await newEvidence(fixture);
        // The workspace must actually permit embeddings: the processor
        // reloads this policy and refuses without it.
        await prisma.workspaceAiPolicy.upsert({
          where: { teamId: fixture.teamId },
          create: {
            teamId: fixture.teamId,
            aiEnabled: true,
            semanticSearchEnabled: true,
            embeddingsAllowed: true,
          },
          update: {
            aiEnabled: true,
            semanticSearchEnabled: true,
            embeddingsAllowed: true,
          },
        });
        const chunk = await prisma.evidenceSemanticChunk.create({
          data: {
            evidenceId,
            teamId: fixture.teamId,
            chunkIndex: 0,
            chunkText: `point5 chunk ${randomUUID()}`,
          },
          select: { id: true },
        });
        return chunk.id;
      },
      async execute(rowId) {
        await embedProcessor.processMiEmbedJob(job(EMBED_ENTRY, rowId));
      },
      async readState(rowId) {
        const rows = await prisma.$queryRawUnsafe<Array<{ embedded: boolean }>>(
          `SELECT ("embedding_vector" IS NOT NULL) AS embedded
             FROM "evidence_semantic_chunks" WHERE "id" = $1::uuid`,
          rowId,
        );
        if (rows.length === 0) return null;
        return rows[0]!.embedded ? "EMBEDDED" : "PENDING";
      },
      async makeTerminal(rowId) {
        const vec = `[${new Array(1536).fill("0.000001").join(",")}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE "evidence_semantic_chunks"
              SET "embedding_vector" = $2::vector,
                  "embedding_provider" = 'point5',
                  "embedding_model" = 'point5',
                  "embedding_dimensions" = 1536
            WHERE "id" = $1::uuid`,
          rowId,
          vec,
        );
      },
      terminalStates: ["EMBEDDED"],
      async countInWorkspace(teamId) {
        return prisma.evidenceSemanticChunk.count({ where: { teamId } });
      },
    };
  }

  // =========================================================================
  // The shared conformance suite, per unit
  // =========================================================================

  function ctxFor(readWorkspace: ConformanceContext["readWorkspace"]): ConformanceContext {
    return { own, foreign, readWorkspace };
  }

  it("RunMediaIntelligence satisfies the seven non-waivable invariants", async () => {
    analyzer.reset();
    storage.reset();
    await proveCommonConformance(
      runDriver(),
      ctxFor(async (rowId) => {
        const row = await prisma.mediaIntelligenceRun.findUnique({
          where: { id: rowId },
          select: { teamId: true },
        });
        return row?.teamId ?? null;
      }),
    );
  });

  it("ExtractExif satisfies the seven non-waivable invariants", async () => {
    analyzer.reset();
    storage.reset();
    await proveCommonConformance(
      exifDriver(),
      ctxFor(async (rowId) => {
        const part = await prisma.evidencePart.findUnique({
          where: { id: rowId },
          select: { evidence: { select: { teamId: true } } },
        });
        return part?.evidence?.teamId ?? null;
      }),
    );
  });

  it("GenerateDerivedAsset satisfies the seven non-waivable invariants", async () => {
    analyzer.reset();
    storage.reset();
    await proveCommonConformance(
      derivedDriver(),
      ctxFor(async (rowId) => {
        const row = await prisma.evidencePartDerivedAsset.findUnique({
          where: { id: rowId },
          select: { teamId: true },
        });
        return row?.teamId ?? null;
      }),
    );
  });

  it("EmbedSemanticChunks satisfies the seven non-waivable invariants", async () => {
    analyzer.reset();
    storage.reset();
    await proveCommonConformance(
      embedDriver(),
      ctxFor(async (rowId) => {
        const row = await prisma.evidenceSemanticChunk.findUnique({
          where: { id: rowId },
          select: { teamId: true },
        });
        return row?.teamId ?? null;
      }),
    );
  });

  // =========================================================================
  // Family-specific properties
  // =========================================================================

  it("a provider refusal marks the run FAILED and never COMPLETED", async () => {
    analyzer.reset();
    analyzer.outcome = "refuse";
    const driver = runDriver();
    const runId = await driver.seed({ teamId: own.teamId, fixture: own });
    await driver.execute(runId, own.teamId);
    analyzer.outcome = "ok";

    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, lastError: true, completedAtUtc: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("analyzer_");
    expect(row.completedAtUtc).toBeNull();
    provenCase("mirun.provider.failure_cannot_complete");
  });

  it("a stale worker cannot overwrite the terminal state its replacement wrote", async () => {
    analyzer.reset();
    const driver = runDriver();
    const runId = await driver.seed({ teamId: own.teamId, fixture: own });

    const tracker = await import("@proovra/shared-runtime/media-intelligence");
    // Worker 1 claims and gets a fence.
    const first = await tracker.markRunProcessing(runId, own.teamId, prisma as never);
    expect(first.ok).toBe(true);
    const staleFence = first.ok ? first.fence : undefined;

    // Its lease expires; worker 2 takes the run and COMPLETES it.
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: { startedAtUtc: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const second = await tracker.markRunProcessing(runId, own.teamId, prisma as never);
    expect(second.ok).toBe(true);
    await tracker.markRunCompleted(
      runId,
      own.teamId,
      prisma as never,
      second.ok ? second.fence : undefined,
    );

    // Worker 1 finally returns and tries to write its own late outcome.
    await tracker.markRunFailed(
      runId,
      own.teamId,
      "late_failure",
      prisma as never,
      staleFence,
    );

    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, lastError: true },
    });
    expect(row.status).toBe("COMPLETED");
    expect(row.lastError).not.toBe("late_failure");
    provenCase("mirun.fence.stale_worker_cannot_write");
  });

  it("a failed byte fetch never leaves a derived asset claiming READY", async () => {
    analyzer.reset();
    storage.reset();
    storage.mode = "fail";
    const evidenceId = await newEvidence(own);
    const part = await newPart(evidenceId);
    const asset = await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        evidencePartId: part.id,
        assetKind: "image_thumbnail",
        status: "PENDING",
      },
      select: { id: true },
    });
    try {
      await derivedProcessor.processDerivedAssetJob(
        job(DERIVED_ENTRY, asset.id),
      );
    } catch {
      // A throw is an acceptable outcome — BullMQ retries. What must NOT
      // happen is a durable row that says the artifact exists.
    } finally {
      storage.mode = "ok";
    }

    const row = await prisma.evidencePartDerivedAsset.findUniqueOrThrow({
      where: { id: asset.id },
      select: { status: true, storageKey: true, derivedSha256: true },
    });
    expect(row.status).not.toBe("READY");
    expect(row.derivedSha256).toBeNull();
    provenCase("miderived.failure.no_false_ready");
  });

  it("a chunk already embedded is not re-embedded, so a replay costs nothing", async () => {
    analyzer.reset();
    const driver = embedDriver();
    const anchorId = await driver.seed({ teamId: own.teamId, fixture: own });
    await driver.execute(anchorId, own.teamId);

    const first = await prisma.$queryRawUnsafe<
      Array<{ v: string | null; updated: boolean }>
    >(
      `SELECT "embedding_vector"::text AS v, ("embedding_vector" IS NOT NULL) AS updated
         FROM "evidence_semantic_chunks" WHERE "id" = $1::uuid`,
      anchorId,
    );
    expect(first[0]?.updated).toBe(true);

    // The batch is selected from CURRENT state — `embedding_vector IS NULL` —
    // so a replayed job finds nothing to do rather than re-embedding work the
    // workspace has already been charged for.
    await driver.execute(anchorId, own.teamId);
    const second = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(
      `SELECT "embedding_vector"::text AS v
         FROM "evidence_semantic_chunks" WHERE "id" = $1::uuid`,
      anchorId,
    );
    expect(second[0]?.v).toBe(first[0]?.v);
    provenCase("miembed.replay.costs_nothing");
  });

  it("a workspace whose AI policy forbids embeddings is refused, whatever the wire says", async () => {
    analyzer.reset();
    const driver = embedDriver();
    const anchorId = await driver.seed({ teamId: own.teamId, fixture: own });
    await prisma.workspaceAiPolicy.update({
      where: { teamId: own.teamId },
      data: { embeddingsAllowed: false },
    });
    try {
      await driver.execute(anchorId, own.teamId);
    } finally {
      await prisma.workspaceAiPolicy.update({
        where: { teamId: own.teamId },
        data: { embeddingsAllowed: true },
      });
    }
    expect(await driver.readState(anchorId)).toBe("PENDING");
    provenCase("miembed.policy.reloaded_and_enforced");
  });
});
