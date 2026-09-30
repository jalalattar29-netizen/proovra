/**
 * Phase-31 derived-asset processor — generation lineage, lifecycle and
 * never-delete (UC-DER-005 / 006 / 010 / 013 / 014).
 *
 * Drives the REAL `processDerivedAssetJob` with its boundaries replaced: the
 * request row + source part (DB), the object store, the ffmpeg producers and
 * the canonical derived-asset writer (captured, so every write is asserted).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const s = vi.hoisted(() => ({
  request: {
    id: "55555555-5555-4555-8555-555555555555",
    teamId: "22222222-2222-4222-8222-222222222222",
    evidenceId: "11111111-1111-4111-8111-111111111111",
    evidencePartId: "44444444-4444-4444-8444-444444444444",
    assetKind: "low_res_proxy",
    status: "PENDING",
  },
  part: null as null | Record<string, unknown>,
  partsSql: [] as string[],
  eligibility: { eligible: true } as { eligible: boolean; reason?: string },
  objects: new Map<string, Buffer>(),
  streamCalls: [] as Array<Record<string, unknown>>,
  puts: [] as string[],
  deletes: [] as string[],
  writes: [] as Array<Record<string, any>>,
}));

vi.mock("../src/canonical-job.js", () => ({
  decodeCanonicalJob: () => ({ commandId: s.request.id }),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidencePartDerivedAsset: { findUnique: vi.fn(async () => s.request) },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/FROM "evidence_parts" p/.test(sql)) {
        s.partsSql.push(sql);
        return s.part ? [s.part] : [];
      }
      return [];
    }),
  },
}));

vi.mock("../src/storage.js", () => ({
  getObjectStream: vi.fn(async (p: { bucket: string; key: string; versionId?: string | null }) => {
    s.streamCalls.push(p);
    const v = s.objects.get(`${p.bucket}::${p.key}`) ?? Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for (let i = 0; i < v.length; i += 65536) chunks.push(v.subarray(i, i + 65536));
    return Readable.from(chunks);
  }),
  getObjectRange: vi.fn(async () => {
    throw new Error("unversioned range read must not be used");
  }),
  putObjectBuffer: vi.fn(async ({ key }: { key: string }) => {
    s.puts.push(key);
  }),
  deleteObject: vi.fn(async ({ key }: { key: string }) => {
    s.deletes.push(key);
  }),
}));

vi.mock("../src/ffmpeg-derived-assets.js", async (orig) => {
  const bytes = Buffer.from("webm-proxy-bytes");
  const ok = {
    status: "ok",
    bytes,
    contentType: "video/webm",
    widthPx: null,
    heightPx: null,
    derivedSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    ...(await orig<typeof import("../src/ffmpeg-derived-assets.js")>()),
    produceLowResProxy: vi.fn(async () => ok),
    produceVideoFrame: vi.fn(async () => ok),
    produceAudioWaveform: vi.fn(async () => ok),
    getFfmpegVersion: vi.fn(async () => "7.0.2-static"),
  };
});

vi.mock("@proovra/shared-runtime/media-intelligence", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared-runtime/media-intelligence")>()),
  evaluateDerivedProductionEligibility: vi.fn(async () => s.eligibility),
  recordDerivedAsset: vi.fn(async (input: Record<string, any>) => {
    s.writes.push(input);
    return { ok: true, id: s.request.id, previousStorage: null, supersededAssetId: null };
  }),
}));

import { processDerivedAssetJob } from "../src/derived-assets.processor.js";

const job = { id: "j", name: "generate-derived-asset", data: {}, attemptsMade: 0, opts: { attempts: 3 } };
const ORIGINAL = Buffer.from("an-original-video-of-forty-two-bytes-long!");

beforeEach(() => {
  s.request.status = "PENDING";
  s.part = {
    id: s.request.evidencePartId,
    storage_bucket: "b",
    storage_key: "originals/v",
    storage_version_id: "ver-9",
    size_bytes: BigInt(ORIGINAL.length),
    mime_type: "video/mp4",
    sha256: sha(ORIGINAL),
  };
  s.partsSql = [];
  s.eligibility = { eligible: true };
  s.objects = new Map([["b::originals/v", ORIGINAL]]);
  s.streamCalls = [];
  s.puts = [];
  s.deletes = [];
  s.writes = [];
});

describe("derived-assets processor — lineage (DER-005 / DER-014)", () => {
  it("reads the RECORDED version, records the probed tool version and readable generation parameters", async () => {
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("COMPLETED");
    expect(s.streamCalls[0]).toMatchObject({ key: "originals/v", versionId: "ver-9" });
    const done = s.writes.find((w) => w.status === "COMPLETED")!;
    expect(done.engineVersion).toBe("ffmpeg-7.0.2-static");
    expect(done.sourceSha256AtGeneration).toBe(sha(ORIGINAL));
    expect(done.generationParameters).toMatchObject({
      producer: "proovra-worker/derived-assets",
      tool: { name: "ffmpeg", version: "7.0.2-static" },
      producerParameters: { maxDurationSeconds: 30, heightPx: 480 },
      sourceRead: {
        storageVersionId: "ver-9",
        bytesRead: ORIGINAL.length,
        readSha256: sha(ORIGINAL),
        wholeSource: true,
        digestMatchesRecorded: true,
      },
    });
  });

  it("a source larger than the read budget is recorded as a PREFIX read, never as the whole part", async () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 3);
    s.objects.set("b::originals/v", big);
    s.part = { ...s.part!, size_bytes: BigInt(big.length), sha256: sha(big) };
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("COMPLETED");
    const done = s.writes.find((w) => w.status === "COMPLETED")!;
    expect(done.generationParameters.sourceRead.wholeSource).toBe(false);
    expect(done.generationParameters.sourceRead.bytesRead).toBe(50 * 1024 * 1024);
    expect(done.generationParameters.sourceRead.digestMatchesRecorded).toBeNull();
  });

  it("bytes that do not match the recorded ORIGINAL digest are refused (FAILED, nothing stored)", async () => {
    s.part = { ...s.part!, sha256: "0".repeat(64) };
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.puts).toEqual([]);
    expect(s.writes.at(-1)).toMatchObject({ status: "FAILED", lastError: "source_digest_mismatch" });
  });
});

describe("derived-assets processor — never deletes a prior generation (DER-006)", () => {
  it("does not delete any object when a regeneration completes", async () => {
    await processDerivedAssetJob(job as never);
    expect(s.deletes).toEqual([]);
  });
});

describe("derived-assets processor — lifecycle (DER-013) and workspace (DER-010)", () => {
  it("a trashed record gets no derived bytes and no COMPLETED row", async () => {
    s.eligibility = { eligible: false, reason: "evidence_trashed" };
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.puts).toEqual([]);
    expect(s.streamCalls).toEqual([]);
    expect(s.writes.every((w) => w.status !== "COMPLETED")).toBe(true);
    expect(s.writes.at(-1)).toMatchObject({ lastError: "evidence_ineligible:evidence_trashed" });
  });

  it("reads the source through the record's workspace, including a Personal NULL-team record", async () => {
    await processDerivedAssetJob(job as never);
    expect(s.partsSql[0]).toMatch(/"team_id" IS NULL/);
    expect(s.partsSql[0]).toMatch(/"is_personal" = true/);
  });
});
