/**
 * UC-4 — processReconstructScreenJob against a REAL PostgreSQL (UC-TQ-003).
 *
 * The handler, the run tracker, the orchestrator and the derived-asset writer
 * all run for real against the database; only the object store (in memory),
 * ffmpeg (a deterministic keyframe producer) and the OCR engine are replaced.
 * Proves, end to end through the durable run lifecycle:
 *   * happy path: a PENDING run is claimed, produces generation 1, COMPLETED;
 *   * DER-001/006: a regeneration run (…:g2) produces generation 2, the first
 *     generation stays readable as SUPERSEDED, both runs are COMPLETED;
 *   * lease-lost fence: a run held by another worker is not touched;
 *   * OCR disabled by policy (no policy row ⇒ fail-closed) is PARTIAL and says
 *     DISABLED_BY_POLICY;
 *   * DER-010: a Personal record stored with team_id NULL is produced under its
 *     owner's personal workspace.
 *
 * DB-dependent: runs where TEST_DATABASE_URL points at a disposable migrated
 * database (the same convention as every API integration suite). The DB-free
 * behaviour of the handler is covered in CI's worker unit job by
 * uc4-screen-intelligence-handler.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const DB_URL = process.env.TEST_DATABASE_URL;
const runIf = DB_URL ? describe : describe.skip;

const store = vi.hoisted(() => ({ objs: new Map<string, Buffer>() }));
const frames = vi.hoisted(() => ({ value: [] as Array<{ offsetMs: number; rows: string[] }> }));

vi.mock("../src/db.js", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { Pool } = await import("pg");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://invalid/none" });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), __pool: pool };
});

vi.mock("../src/storage.js", () => ({
  getObjectStream: vi.fn(async ({ bucket, key }: { bucket: string; key: string }) => {
    const v = store.objs.get(`${bucket}::${key}`);
    if (!v) throw new Error("not_found");
    return Readable.from([v]);
  }),
  putObjectBuffer: vi.fn(async ({ bucket, key, body }: { bucket: string; key: string; body: Buffer }) => {
    store.objs.set(`${bucket}::${key}`, body);
  }),
  deleteObject: vi.fn(async ({ bucket, key }: { bucket: string; key: string }) => {
    store.objs.delete(`${bucket}::${key}`);
  }),
}));

vi.mock("../src/queue.js", () => ({
  enqueueSearchIndexingJob: vi.fn(async () => ({ enqueued: true })),
}));

vi.mock("../src/ffmpeg-derived-assets.js", async (orig) => ({
  ...(await orig<typeof import("../src/ffmpeg-derived-assets.js")>()),
  getFfmpegVersion: vi.fn(async () => "test-ffmpeg"),
  produceVideoKeyframes: vi.fn(async () => ({
    status: "ok",
    boundsReached: false,
    keyframes: frames.value.map((f, index) => {
      const bytes = Buffer.from(JSON.stringify({ rows: f.rows }), "utf8");
      return {
        index,
        offsetMs: f.offsetMs,
        bytes,
        contentType: "image/webp",
        derivedSha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        ocrBytes: bytes,
        ocrWidthPx: null,
        ocrHeightPx: null,
      };
    }),
  })),
}));

vi.mock("../src/tesseract-capability.js", () => ({
  detectTesseractCapability: vi.fn(async () => ({ ok: true, tesseractPath: "tesseract", version: "5.3.4" })),
}));

vi.mock("../src/tesseract-ocr-provider.js", () => ({
  TESSERACT_PAGE_SEGMENTATION_MODE: 6,
  createTesseractOcrProvider: vi.fn(async (lang: string) => ({
    name: "tesseract",
    version: "5.3.4",
    local: true,
    extract: vi.fn(async ({ imageRef }: { imageRef: string }) => {
      const { readFile } = await import("node:fs/promises");
      const parsed = JSON.parse((await readFile(imageRef)).toString("utf8")) as { rows: string[] };
      return {
        regions: parsed.rows.map((text, i) => ({ text, kind: "TEXT" as const, rowOrder: i })),
        language: lang,
      };
    }),
  })),
}));

import { prisma } from "../src/db.js";
import { processReconstructScreenJob } from "../src/screen-intelligence.handler.js";
import {
  enqueueMediaIntelligenceRun,
  readScreenReconstructionDescriptor,
} from "@proovra/shared-runtime/media-intelligence";
import { screenReconstructionIdempotencyKey } from "@proovra/shared";

const BUCKET = "proovra-test-assets";
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

runIf("UC-4 processReconstructScreenJob (live PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    const mod = (await import("../src/db.js")) as unknown as { __pool?: { end(): Promise<void> } };
    await mod.__pool?.end();
  });
  beforeEach(() => {
    frames.value = [
      { offsetMs: 0, rows: ["A", "B"] },
      { offsetMs: 1500, rows: ["B", "C"] },
    ];
  });

  async function seed(opts: { personal?: boolean; ocrAllowed?: boolean } = {}) {
    const user = await prisma.user.create({
      data: { provider: "EMAIL", providerUserId: `uc4h-${randomUUID()}` },
    });
    const org = await prisma.organization.create({ data: { name: "UC4H Org" } });
    const team = await prisma.team.create({
      data: opts.personal
        ? {
            name: "UC4H Personal",
            ownerUserId: user.id,
            organizationId: org.id,
            isPersonal: true,
            workspaceKind: "PERSONAL",
          }
        : { name: "UC4H Team", ownerUserId: user.id, organizationId: org.id, workspaceKind: "ORGANIZATION" },
    });
    if (opts.ocrAllowed) {
      await prisma.workspaceAiPolicy.create({
        data: { teamId: team.id, aiEnabled: true, ocrAllowed: true } as never,
      });
    }
    const evidence = await prisma.evidence.create({
      data: {
        teamId: opts.personal ? null : team.id,
        organizationId: org.id,
        ownerUserId: user.id,
        type: "VIDEO",
        // A derivable source is a SEALED record (derived-production eligibility).
        status: "SIGNED",
      } as never,
    });
    const bytes = Buffer.from(`segment-${randomUUID()}`);
    const key = `originals/${evidence.id}/part-0`;
    store.objs.set(`${BUCKET}::${key}`, bytes);
    await prisma.evidencePart.create({
      data: {
        evidenceId: evidence.id,
        partIndex: 0,
        storageBucket: BUCKET,
        storageKey: key,
        sha256: sha256Hex(bytes),
        sizeBytes: BigInt(bytes.byteLength),
        mimeType: "video/mp4",
        artifactClass: "ORIGINAL",
      },
    });
    return { teamId: team.id, evidenceId: evidence.id };
  }

  async function newRun(teamId: string, evidenceId: string, generation: number) {
    const r = await enqueueMediaIntelligenceRun(
      {
        teamId,
        evidenceId,
        kind: "reconstruct_screen",
        idempotencyKey: screenReconstructionIdempotencyKey(evidenceId, generation),
      },
      prisma,
    );
    if (!r.ok) throw new Error("tracker_unavailable");
    return r.run.id;
  }

  const runStatus = async (id: string) =>
    (await prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true } }));

  const current = async (teamId: string, evidenceId: string) =>
    readScreenReconstructionDescriptor(teamId, evidenceId, {
      prisma,
      getObjectBytes: async ({ bucket, key }) => store.objs.get(`${bucket}::${key}`)!,
    });

  it("happy path → generation 1 COMPLETED, then a regeneration run produces generation 2 and supersedes (not deletes) generation 1", async () => {
    const { teamId, evidenceId } = await seed({ ocrAllowed: true });
    const run1 = await newRun(teamId, evidenceId, 1);
    await processReconstructScreenJob({ jobId: "j", teamId, evidenceId, runId: run1 });
    expect((await runStatus(run1)).status).toBe("COMPLETED");
    const g1 = await current(teamId, evidenceId);
    expect(g1!.descriptor.generation!.generation).toBe(1);
    expect(g1!.descriptor.ocrStatus).toBe("ENABLED");
    expect(g1!.descriptor.blocks.map((b) => b.text)).toEqual(["A", "B", "C"]);

    frames.value = [{ offsetMs: 0, rows: ["A", "Z"] }];
    const run2 = await newRun(teamId, evidenceId, 2);
    expect(run2).not.toBe(run1);
    await processReconstructScreenJob({ jobId: "j2", teamId, evidenceId, runId: run2 });
    expect((await runStatus(run2)).status).toBe("COMPLETED");
    expect((await runStatus(run1)).status).toBe("COMPLETED"); // history intact

    const g2 = await current(teamId, evidenceId);
    expect(g2!.descriptor.generation!.generation).toBe(2);
    expect(g2!.descriptor.generation!.runId).toBe(run2);
    expect(g2!.descriptor.generation!.supersedes!.descriptorAssetId).toBe(g1!.assetId);
    expect(g2!.descriptor.blocks.map((b) => b.text)).toEqual(["A", "Z"]);
    const g1Row = await prisma.evidencePartDerivedAsset.findUniqueOrThrow({ where: { id: g1!.assetId } });
    expect(g1Row.status).toBe("SUPERSEDED");
    expect(store.objs.has(`${g1Row.storageBucket}::${g1Row.storageKey}`)).toBe(true);
  });

  it("lease-lost fence: a run another worker holds is not claimed and nothing is written", async () => {
    const { teamId, evidenceId } = await seed({ ocrAllowed: true });
    const run = await newRun(teamId, evidenceId, 1);
    await prisma.mediaIntelligenceRun.update({
      where: { id: run },
      data: { status: "PROCESSING", attemptCount: 1, startedAtUtc: new Date() },
    });
    await processReconstructScreenJob({ jobId: "j", teamId, evidenceId, runId: run });
    expect((await runStatus(run)).status).toBe("PROCESSING");
    expect(await prisma.evidencePartDerivedAsset.count({ where: { evidenceId } })).toBe(0);
  });

  it("OCR disabled by policy (no policy row, fail-closed) → PARTIAL, DISABLED_BY_POLICY, no text", async () => {
    const { teamId, evidenceId } = await seed({ ocrAllowed: false });
    const run = await newRun(teamId, evidenceId, 1);
    await processReconstructScreenJob({ jobId: "j", teamId, evidenceId, runId: run });
    expect((await runStatus(run)).status).toBe("COMPLETED");
    const d = await current(teamId, evidenceId);
    expect(d!.descriptor.coverage).toBe("PARTIAL");
    expect(d!.descriptor.ocrStatus).toBe("DISABLED_BY_POLICY");
    expect(await prisma.evidenceExtractedText.count({ where: { evidenceId } })).toBe(0);
  });

  it("DER-013: a trashed record's run is FAILED as ineligible and produces nothing", async () => {
    const { teamId, evidenceId } = await seed({ ocrAllowed: true });
    const run = await newRun(teamId, evidenceId, 1);
    await prisma.evidence.update({ where: { id: evidenceId }, data: { deletedAt: new Date(), lifecycleState: "TRASHED" as never } });
    await processReconstructScreenJob({ jobId: "j", teamId, evidenceId, runId: run });
    expect(await runStatus(run)).toEqual({ status: "FAILED", lastError: "evidence_ineligible:evidence_trashed" });
    expect(await prisma.evidencePartDerivedAsset.count({ where: { evidenceId } })).toBe(0);
  });

  it("DER-010: a Personal (NULL-team) record is produced under its owner's personal workspace", async () => {
    const { teamId, evidenceId } = await seed({ personal: true, ocrAllowed: true });
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { teamId: true } });
    expect(ev.teamId).toBeNull();
    const run = await newRun(teamId, evidenceId, 1);
    await processReconstructScreenJob({ jobId: "j", teamId, evidenceId, runId: run });
    expect((await runStatus(run)).status).toBe("COMPLETED");
    const d = await current(teamId, evidenceId);
    expect(d!.descriptor.blocks.map((b) => b.text)).toEqual(["A", "B", "C"]);
    const rows = await prisma.evidencePartDerivedAsset.findMany({ where: { evidenceId }, select: { teamId: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.teamId === teamId)).toBe(true);
  });
});
