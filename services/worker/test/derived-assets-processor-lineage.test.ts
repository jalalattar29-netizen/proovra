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
  writes: [] as Array<Record<string, unknown>>,
  storage: { allowed: true } as { allowed: true } | { allowed: false; reason: "storage_limit" },
  storageAsks: [] as Array<{ evidenceId: string; incomingBytes: bigint | number; reservation?: Record<string, unknown> }>,
  released: [] as Array<Record<string, unknown>>,
  legalHold: false,
}));

// WS-SCHED / PRO-W1-05 — the workspace storage gate (the real one is proven in
// its own suites); here only its verdict and the bytes it was asked about.
vi.mock("../src/workspace-billing.js", () => ({
  workspaceAllowsDerivedArtifact: vi.fn(
    async (p: { evidenceId: string; incomingBytes: bigint | number; reservation: Record<string, unknown> }) => {
      s.storageAsks.push(p);
      return s.storage;
    },
  ),
  // M676 follow-up — the same gate, returning the hold the job renews.
  reserveDerivedArtifactStorage: vi.fn(
    async (p: { evidenceId: string; incomingBytes: bigint | number; reservation: Record<string, unknown> }) => {
      s.storageAsks.push(p);
      if (!s.storage.allowed) return s.storage;
      return {
        allowed: true,
        hold: { key: { ...p.reservation, evidenceId: p.evidenceId }, reservedAtUtc: new Date(0), writeDeadlineAt: Date.now() + 17 * 60_000 },
      };
    },
  ),
  renewDerivedArtifactReservation: vi.fn(async (hold: { writeDeadlineAt: number }) => ({ ...hold, writeDeadlineAt: Date.now() + 17 * 60_000 })),
  // M676 — an admitted job that ends without its settling write gives the
  // reservation back.
  releaseDerivedArtifactReservation: vi.fn(async (key: Record<string, unknown>) => {
    s.released.push(key);
  }),
  // FINAL-VERIFY-2 closure — a holder that never started a write gives back
  // its reservation (and its intent, when it holds one).
  releaseUnwrittenDerivedArtifactHold: vi.fn(async (hold: { key: Record<string, unknown> }) => {
    s.released.push(hold.key);
  }),
}));

vi.mock("../src/canonical-job.js", () => ({
  decodeCanonicalJob: () => ({ commandId: s.request.id }),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidencePartDerivedAsset: { findUnique: vi.fn(async () => s.request), findFirst: vi.fn(async () => null) },
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
    return { versionId: `ver-of-${key.slice(-8)}` };
  }),
  deleteObject: vi.fn(async ({ key }: { key: string }) => {
    s.deletes.push(key);
  }),
  deleteObjectVersions: vi.fn(async ({ key }: { key: string }) => {
    s.deletes.push(key);
    return { deleted: true, deletedVersions: 1, retainedVersions: 0, deleteMarkerOnly: false, failed: 0 };
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
  recordDerivedAsset: vi.fn(async (input: Record<string, unknown>) => {
    s.writes.push(input);
    return { ok: true, id: s.request.id, previousStorage: null, supersededAssetId: null };
  }),
}));

// M676 follow-up — the record's hold state (an unsettled object is deleted only without one).
vi.mock("@proovra/shared-runtime", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared-runtime")>()),
  evaluateEffectiveLegalHold: vi.fn(async () => ({ held: s.legalHold })),
}));

import * as mi from "@proovra/shared-runtime/media-intelligence";
import * as billing from "../src/workspace-billing.js";
import * as storage from "../src/storage.js";
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
  s.storage = { allowed: true };
  s.storageAsks = [];
  s.released = [];
  s.legalHold = false;
});

describe("derived-assets processor — storage admission (WS-SCHED PRO-W1-05)", () => {
  it("asks the workspace storage gate for the exact derived size before writing", async () => {
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("COMPLETED");
    expect(s.storageAsks).toEqual([
      {
        evidenceId: s.request.evidenceId,
        incomingBytes: Buffer.from("webm-proxy-bytes").byteLength,
        // M676 — the admitted bytes are reserved on the row this job settles.
        reservation: {
          teamId: s.request.teamId,
          evidenceId: s.request.evidenceId,
          evidencePartId: s.request.evidencePartId,
          assetKind: "low_res_proxy",
          variantKey: "default",
        },
        // FINAL-VERIFY-2 closure — the declared write target (its durable intent).
        target: {
          bucket: "b",
          key: s.puts[0],
          derivedSha256: sha(Buffer.from("webm-proxy-bytes")),
          contentType: "video/webm",
        },
      },
    ]);
    // Settled by its own COMPLETED write (which clears the reservation): no
    // separate release.
    expect(s.released).toEqual([]);
  });

  it("M676: an admitted job whose settling write fails gives its reservation back", async () => {
    vi.mocked(mi.recordDerivedAsset).mockResolvedValueOnce({ ok: false, reason: "upsert_failed:x" });
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.released).toEqual([
      {
        teamId: s.request.teamId,
        evidenceId: s.request.evidenceId,
        evidencePartId: s.request.evidencePartId,
        assetKind: "low_res_proxy",
        variantKey: "default",
      },
    ]);
  });

  it("over the limit: FAILED storage_limit, nothing written under the lock, no COMPLETED row", async () => {
    s.storage = { allowed: false, reason: "storage_limit" };
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.puts).toEqual([]);
    expect(s.writes.every((w) => w.status !== "COMPLETED")).toBe(true);
    expect(s.writes.at(-1)).toMatchObject({ status: "FAILED", lastError: "storage_limit" });
  });
});

describe("derived-assets processor — the reservation is renewed, fenced and never outlived (M676 follow-up)", () => {
  const KEY = () => ({
    teamId: s.request.teamId,
    evidenceId: s.request.evidenceId,
    evidencePartId: s.request.evidencePartId,
    assetKind: "low_res_proxy",
    variantKey: "default",
  });
  const PROXY = Buffer.from("webm-proxy-bytes");

  it("renews the reservation before the PUT and again before the settle", async () => {
    vi.mocked(billing.renewDerivedArtifactReservation).mockClear();
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("COMPLETED");
    expect(vi.mocked(billing.renewDerivedArtifactReservation)).toHaveBeenCalledTimes(2);
  });

  it("a reservation cleared or expired before the PUT: nothing is written, no COMPLETED row, the job is retried", async () => {
    vi.mocked(billing.renewDerivedArtifactReservation).mockResolvedValueOnce(null);
    await expect(processDerivedAssetJob(job as never)).rejects.toThrow("derived_storage_reservation_lost_before_put");
    expect(s.puts).toEqual([]);
    expect(s.writes.every((w) => w.status !== "COMPLETED")).toBe(true);
    expect(s.writes.at(-1)).toMatchObject({ status: "FAILED", lastError: "storage_reservation_lost_before_put" });
    // FINAL-VERIFY-2 closure — nothing was written: the hold (and its intent) is given back.
    expect(s.released).toEqual([KEY()]);
  });

  it("a reservation lost before the settle: the written object is not recorded as uploaded; it is deleted, then the row is FAILED", async () => {
    vi.mocked(billing.renewDerivedArtifactReservation)
      .mockImplementationOnce(async (hold) => ({ ...hold, writeDeadlineAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(null);
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.puts).toHaveLength(1);
    expect(s.writes.every((w) => w.status !== "COMPLETED")).toBe(true);
    expect(vi.mocked(storage.deleteObjectVersions)).toHaveBeenLastCalledWith({
      bucket: "b",
      key: s.puts[0],
      versionId: `ver-of-${s.puts[0]!.slice(-8)}`,
    });
    expect(s.writes.at(-1)).toMatchObject({ status: "FAILED", lastError: "storage_reservation_lost_before_settle" });
  });

  it("a PUT still in flight at the reservation's write deadline is aborted; its key is disposed and the row FAILED", async () => {
    vi.mocked(billing.renewDerivedArtifactReservation).mockImplementationOnce(async (hold) => ({ ...hold, writeDeadlineAt: Date.now() + 100 }));
    let signal: AbortSignal | undefined;
    vi.mocked(storage.putObjectBuffer).mockImplementationOnce(
      (async (p: { key: string; abortSignal?: AbortSignal }) => {
        s.puts.push(p.key);
        signal = p.abortSignal;
        return new Promise((_, reject) => p.abortSignal?.addEventListener("abort", () => reject(new Error("Request aborted"))));
      }) as never,
    );
    await expect(processDerivedAssetJob(job as never)).rejects.toThrow("derived_put_deadline_exceeded");
    expect(signal?.aborted).toBe(true);
    // The version is unknown (the answer never came): the key is removed when no row references it.
    expect(vi.mocked(storage.deleteObjectVersions)).toHaveBeenLastCalledWith({ bucket: "b", key: s.puts[0], versionId: null });
    expect(s.writes.every((w) => w.status !== "COMPLETED")).toBe(true);
    expect(s.writes.at(-1)).toMatchObject({ status: "FAILED", lastError: "derived_put_deadline_exceeded" });
    expect(s.released).toEqual([KEY()]);
  });

  it("a failed settle after a successful write: the written version is deleted before the reservation is released", async () => {
    vi.mocked(mi.recordDerivedAsset).mockResolvedValueOnce({ ok: false, reason: "upsert_failed:x" });
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(vi.mocked(storage.deleteObjectVersions)).toHaveBeenLastCalledWith({
      bucket: "b",
      key: s.puts[0],
      versionId: `ver-of-${s.puts[0]!.slice(-8)}`,
    });
    expect(s.released).toEqual([KEY()]);
  });

  it("a failed settle whose object cannot be deleted (Object Lock / hold): the bytes stay COUNTED on their own FAILED row with the pointer", async () => {
    s.legalHold = true;
    vi.mocked(mi.recordDerivedAsset).mockResolvedValueOnce({ ok: false, reason: "upsert_failed:x" });
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    const retained = s.writes.at(-1)!;
    expect(retained).toMatchObject({
      status: "FAILED",
      assetKind: "low_res_proxy",
      variantKey: `default~u${sha(PROXY).slice(0, 12)}`,
      storageBucket: "b",
      storageKey: s.puts[0],
      storageVersionId: `ver-of-${s.puts[0]!.slice(-8)}`,
      sizeBytes: PROXY.byteLength,
      derivedSha256: sha(PROXY),
    });
    // Counted by its own row: only then is the reservation given back.
    expect(s.released).toEqual([KEY()]);
  });

  it("a failed settle whose object can be neither deleted nor recorded keeps the reservation (never a silent release)", async () => {
    s.legalHold = true;
    vi.mocked(mi.recordDerivedAsset)
      .mockResolvedValueOnce({ ok: false, reason: "upsert_failed:x" })
      .mockResolvedValueOnce({ ok: false, reason: "upsert_failed:y" });
    const res = await processDerivedAssetJob(job as never);
    expect(res.status).toBe("FAILED");
    expect(s.released).toEqual([]);
  });
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
    const sourceRead = (done.generationParameters as { sourceRead: Record<string, unknown> }).sourceRead;
    expect(sourceRead.wholeSource).toBe(false);
    expect(sourceRead.bytesRead).toBe(50 * 1024 * 1024);
    expect(sourceRead.digestMatchesRecorded).toBeNull();
    // AUD-38 (2026-10-20): an unverified (prefix) read never stamps the
    // ORIGINAL digest on the derivative as if it had been checked.
    expect(done.sourceSha256AtGeneration).toBeNull();
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
  it("records the stored object VERSION the PUT returned on the derived row", async () => {
    await processDerivedAssetJob(job as never);
    const done = s.writes.find((w) => w.status === "COMPLETED")!;
    expect(s.puts).toHaveLength(1);
    expect(done.storageKey).toBe(s.puts[0]);
    expect(done.storageVersionId).toBe(`ver-of-${s.puts[0]!.slice(-8)}`);
  });

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
