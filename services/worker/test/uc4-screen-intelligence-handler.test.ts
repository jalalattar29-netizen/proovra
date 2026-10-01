/**
 * UC-4 — the reconstruct_screen job HANDLER (processReconstructScreenJob).
 *
 * UC-TQ-003: the handler had no behavioural test at all. This suite drives the
 * real handler with its I/O ports replaced (DB rows, object store, ffmpeg,
 * tesseract, the persistence orchestrator), so it runs in the DB-free CI unit
 * job and pins the wiring the orchestrator relies on:
 *   * the claim/fence contract (a refused claim never runs, terminal writes
 *     carry the fence);
 *   * DER-001 — the generation comes from the run's own key;
 *   * DER-008 — policy-off and engine-missing are reported differently;
 *   * DER-005 — tool versions are probed, not constants;
 *   * DER-014 — source reads are pinned to the recorded version and bounded;
 *   * DER-010 — a personal (NULL-team) record is read through its owner's
 *     personal workspace;
 *   * DER-013 — a trashed/destroyed record is refused before any work.
 * The orchestrator itself is proven against real PostgreSQL in
 * uc4-screen-intelligence-persistence.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const state = vi.hoisted(() => ({
  runKey: "reconstruct_screen:11111111-1111-4111-8111-111111111111" as string | null,
  parts: [] as Array<Record<string, unknown>>,
  partsSql: [] as string[],
  eligibility: { eligible: true } as { eligible: boolean; reason?: string },
  claim: { ok: true, fence: 1 } as { ok: true; fence: number } | { ok: false; reason: string },
  ocrAllowed: true,
  tesseract: { ok: true, tesseractPath: "tesseract", version: "5.3.4" } as
    | { ok: true; tesseractPath: string; version: string | null }
    | { ok: false; reason: string },
  objects: new Map<string, Buffer>(),
  streamCalls: [] as Array<{ bucket: string; key: string; versionId?: string | null }>,
  orchestratorCalls: [] as Array<{ input: any; deps: any }>,
  orchestratorResult: {
    ok: true,
    status: "COMPLETE",
    coverage: "COMPLETE",
    ocrEnabled: true,
    ocrStatus: "ENABLED",
    generation: 1,
    keyframeCount: 1,
    observationCount: 1,
    blockCount: 1,
    derivedBytes: 10,
    descriptorAssetId: "d",
    descriptorSha256: "e".repeat(64),
    supersededAssetCount: 0,
    limitations: [],
  } as any,
  completed: [] as Array<unknown[]>,
  failed: [] as Array<unknown[]>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/FROM "evidence_parts"/.test(sql)) {
        state.partsSql.push(sql);
        return state.parts;
      }
      return [];
    }),
    captureSession: { findFirst: vi.fn(async () => null) },
  },
}));

vi.mock("../src/storage.js", () => ({
  getObjectStream: vi.fn(async (p: { bucket: string; key: string; versionId?: string | null }) => {
    state.streamCalls.push(p);
    const bytes = state.objects.get(`${p.bucket}::${p.key}`) ?? Buffer.alloc(0);
    // Deliver in small chunks so a bounded reader must stop mid-stream.
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 4) chunks.push(bytes.subarray(i, i + 4));
    return Readable.from(chunks);
  }),
  getObjectRange: vi.fn(async () => {
    throw new Error("unversioned range read must not be used");
  }),
  putObjectBuffer: vi.fn(async ({ key }: { key: string }) => ({ versionId: `v-${key}` })),
  deleteObject: vi.fn(async () => undefined),
}));

vi.mock("../src/queue.js", () => ({
  enqueueSearchIndexingJob: vi.fn(async () => ({ enqueued: true })),
}));

vi.mock("../src/tesseract-capability.js", () => ({
  detectTesseractCapability: vi.fn(async () => state.tesseract),
}));

vi.mock("../src/tesseract-ocr-provider.js", () => ({
  TESSERACT_PAGE_SEGMENTATION_MODE: 6,
  createTesseractOcrProvider: vi.fn(async (lang: string) => ({
    name: "tesseract",
    version: state.tesseract.ok ? state.tesseract.version ?? "unknown" : "unavailable",
    local: true,
    extract: vi.fn(async () => ({ regions: [], language: lang })),
  })),
}));

vi.mock("../src/ffmpeg-derived-assets.js", () => ({
  produceVideoKeyframes: vi.fn(async () => ({ status: "unsupported", reason: "test" })),
  getFfmpegVersion: vi.fn(async () => "7.0.2-static"),
  pngDimensions: vi.fn(() => null),
}));

vi.mock("@proovra/shared-runtime", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared-runtime")>()),
  evaluateEffectiveLegalHold: vi.fn(async () => ({ held: false })),
}));

vi.mock("@proovra/shared-runtime/media-intelligence", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared-runtime/media-intelligence")>()),
  getMediaIntelligenceRun: vi.fn(async (runId: string, teamId: string) => ({
    id: runId,
    teamId,
    evidenceId: "11111111-1111-4111-8111-111111111111",
    kind: "reconstruct_screen",
    status: "PENDING",
    attemptCount: 0,
    idempotencyKey: state.runKey,
    lastError: null,
    startedAtUtc: null,
    completedAtUtc: null,
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
  })),
  markRunProcessing: vi.fn(async () => state.claim),
  markRunCompleted: vi.fn(async (...args: unknown[]) => {
    state.completed.push(args);
    return { ok: true };
  }),
  markRunFailed: vi.fn(async (...args: unknown[]) => {
    state.failed.push(args);
    return { ok: true };
  }),
  resolveWorkspaceOcrAllowed: vi.fn(async () => state.ocrAllowed),
  evaluateDerivedProductionEligibility: vi.fn(async () => state.eligibility),
  runAndPersistScreenIntelligence: vi.fn(async (input: unknown, deps: unknown) => {
    state.orchestratorCalls.push({ input, deps });
    return state.orchestratorResult;
  }),
}));

import { processReconstructScreenJob } from "../src/screen-intelligence.handler.js";

const TEAM = "22222222-2222-4222-8222-222222222222";
const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";

function job() {
  return processReconstructScreenJob({ jobId: "j1", teamId: TEAM, evidenceId: EVIDENCE, runId: RUN });
}

beforeEach(() => {
  state.runKey = `reconstruct_screen:${EVIDENCE}`;
  state.parts = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      storage_bucket: "b",
      storage_key: "originals/seg-0",
      storage_version_id: "ver-7",
      size_bytes: 40n,
      mime_type: "video/mp4",
      sha256: "a".repeat(64),
      part_index: 0,
    },
  ];
  state.partsSql = [];
  state.eligibility = { eligible: true };
  state.claim = { ok: true, fence: 1 };
  state.ocrAllowed = true;
  state.tesseract = { ok: true, tesseractPath: "tesseract", version: "5.3.4" };
  state.objects = new Map([["b::originals/seg-0", Buffer.alloc(40, 1)]]);
  state.streamCalls = [];
  state.orchestratorCalls = [];
  state.completed = [];
  state.failed = [];
});

describe("processReconstructScreenJob — claim + fence", () => {
  it("runs the orchestrator once and completes with the claim's fence", async () => {
    state.claim = { ok: true, fence: 4 };
    const res = await job();
    expect(res.ok).toBe(true);
    expect(state.orchestratorCalls).toHaveLength(1);
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]![0]).toBe(RUN);
    expect(state.completed[0]![3]).toBe(4); // the fence
  });

  it("a refused claim (lease held / terminal) never runs and writes no terminal state", async () => {
    state.claim = { ok: false, reason: "max_retries_exceeded" };
    await job();
    expect(state.orchestratorCalls).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
    expect(state.failed).toHaveLength(0);
  });

  it("a structural orchestrator failure is recorded FAILED with the fence and drained", async () => {
    state.claim = { ok: true, fence: 2 };
    state.orchestratorResult = { ok: false, reason: "descriptor_too_large" };
    const res = await job();
    expect(res.ok).toBe(true);
    expect(state.failed[0]![2]).toBe("screen_reconstruction:descriptor_too_large");
    expect(state.failed[0]![4]).toBe(2);
    state.orchestratorResult = { ...state.orchestratorResult, ok: true };
  });
});

describe("processReconstructScreenJob — DER-001 generation", () => {
  it("runs the generation named by the run's own idempotency key, with the run id as lineage", async () => {
    state.orchestratorResult = { ok: true, coverage: "COMPLETE", blockCount: 0, limitations: [] };
    state.runKey = `reconstruct_screen:${EVIDENCE}:g3`;
    await job();
    expect(state.orchestratorCalls[0]!.input.generation).toBe(3);
    expect(state.orchestratorCalls[0]!.input.runId).toBe(RUN);
  });

  it("the legacy per-evidence key is generation 1", async () => {
    await job();
    expect(state.orchestratorCalls[0]!.input.generation).toBe(1);
  });
});

describe("processReconstructScreenJob — DER-008 OCR status", () => {
  it("policy allows OCR but the engine is missing → RUNTIME_UNAVAILABLE (never 'disabled by policy')", async () => {
    state.tesseract = { ok: false, reason: "tesseract_not_installed" };
    await job();
    const ocr = state.orchestratorCalls[0]!.deps.ocr;
    expect(ocr.enabled).toBe(false);
    expect(ocr.status).toBe("RUNTIME_UNAVAILABLE");
  });

  it("policy off → DISABLED_BY_POLICY and the engine is not even probed", async () => {
    state.ocrAllowed = false;
    const { detectTesseractCapability } = await import("../src/tesseract-capability.js");
    vi.mocked(detectTesseractCapability).mockClear();
    await job();
    const ocr = state.orchestratorCalls[0]!.deps.ocr;
    expect(ocr.status).toBe("DISABLED_BY_POLICY");
    expect(detectTesseractCapability).not.toHaveBeenCalled();
  });

  it("policy on + engine present → ENABLED with the language and page-segmentation parameters recorded", async () => {
    await job();
    const ocr = state.orchestratorCalls[0]!.deps.ocr;
    expect(ocr.status).toBe("ENABLED");
    expect(ocr.enabled).toBe(true);
    expect(ocr.language).toBeTruthy();
    expect(ocr.parameters).toEqual({ psm: 6 });
  });
});

describe("processReconstructScreenJob — DER-005 tool versions", () => {
  it("records the probed ffmpeg and tesseract versions", async () => {
    await job();
    expect(state.orchestratorCalls[0]!.deps.toolVersions).toEqual({
      ffmpeg: "7.0.2-static",
      tesseract: "5.3.4",
    });
  });
});

describe("processReconstructScreenJob — DER-014 pinned, bounded source read", () => {
  it("passes the recorded version + size into the orchestrator and reads exactly that version, bounded", async () => {
    await job();
    const { input, deps } = state.orchestratorCalls[0]!;
    expect(input.parts[0]).toMatchObject({ storageVersionId: "ver-7", sizeBytes: 40 });
    const bytes: Buffer = await deps.getSourceBytes({
      bucket: "b",
      key: "originals/seg-0",
      maxBytes: 10,
      versionId: "ver-7",
    });
    expect(bytes.length).toBe(10);
    expect(state.streamCalls.at(-1)).toMatchObject({ key: "originals/seg-0", versionId: "ver-7" });
  });
});

describe("processReconstructScreenJob — DER-006 output object version", () => {
  it("hands the VersionId the PUT returned back to the orchestrator", async () => {
    await job();
    const { deps } = state.orchestratorCalls[0]!;
    const put = await deps.putKeyframeObject({ bucket: "b", key: "derived-assets/x.webp", body: Buffer.from("x"), contentType: "image/webp" });
    expect(put).toEqual({ versionId: "v-derived-assets/x.webp" });
  });
});

describe("processReconstructScreenJob — DER-010 personal records", () => {
  it("reads source parts through the record's workspace INCLUDING a NULL-team record of the personal workspace owner", async () => {
    await job();
    const sql = state.partsSql[0]!;
    expect(sql).toMatch(/"team_id" IS NULL/);
    expect(sql).toMatch(/"is_personal" = true/);
  });
});

describe("processReconstructScreenJob — DER-013 lifecycle", () => {
  it("a trashed record is refused before any work: run FAILED (drained), orchestrator never runs", async () => {
    state.eligibility = { eligible: false, reason: "evidence_trashed" };
    const res = await job();
    expect(res.ok).toBe(true);
    expect(state.orchestratorCalls).toHaveLength(0);
    expect(state.failed[0]![2]).toBe("evidence_ineligible:evidence_trashed");
  });
});
