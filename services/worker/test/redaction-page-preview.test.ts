/**
 * PRO-R3-04 — the redaction page-preview render (worker).
 *
 * The PDF region editor drew on a blank frame because nothing rendered the
 * page. These drive the REAL page render on a PDF built here, and the REAL
 * processor and writer over a mocked prisma / storage TRANSPORT:
 *   - the requested page (not the first) is what is rendered, at the scale the
 *     redacted copy uses, and an oversized page is scaled down;
 *   - a page that does not exist fails with a named reason;
 *   - a source over the redaction byte budget, or one that no longer matches
 *     the sealed digest, is refused before a pixel is rendered or stored;
 *   - the stored object is under the redaction prefix, never the original key,
 *     and READY is written only by the claim holder;
 *   - a transient storage failure releases the claim and rethrows for retry;
 *   - a record that has left service gains no preview.
 */
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, REDACTION_SOURCE_BYTE_BUDGET, getWorkEntryOrThrow } from "@proovra/shared";

const DB = vi.hoisted(() => ({
  preview: null as Record<string, unknown> | null,
  evidence: null as Record<string, unknown> | null,
  lifecycle: { deleted_at: null, status: "SIGNED", lifecycle_state: "ACTIVE" } as Record<string, unknown>,
  stranded: [] as Array<{ id: string }>,
  strandedWhere: null as Record<string, unknown> | null,
}));
const STORE = vi.hoisted(() => ({
  source: null as Buffer | null,
  readError: null as Error | null,
  reads: 0,
  puts: [] as Array<{ bucket: string; key: string; body: Buffer; contentType: string }>,
  /** What the row declared when each PUT was sent. */
  declaredAtPut: [] as Array<{ storageKey: unknown; byteSize: unknown; state: unknown }>,
  putError: null as Error | null,
  /** The stored object a ranged read of a preview key returns (reuse). */
  storedPreview: null as Buffer | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    redactionPagePreview: {
      findUnique: async () => DB.preview,
      findFirst: async (args: { where: { teamId?: string } }) =>
        DB.preview && (!args.where.teamId || args.where.teamId === DB.preview.teamId) ? DB.preview : null,
      findMany: async (args: { where: Record<string, unknown> }) => {
        DB.strandedWhere = args.where;
        return DB.stranded;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = DB.preview;
        if (!row) return { count: 0 };
        const matches = (where: Record<string, unknown>): boolean => {
          if (Array.isArray(where.OR)) return (where.OR as Array<Record<string, unknown>>).some(matches);
          if (where.teamId && where.teamId !== row.teamId) return false;
          if (where.state !== row.state) return false;
          const at = row.renderStartedAt as Date | null | undefined;
          const want = where.renderStartedAt as Date | { lt: Date } | undefined;
          if (want instanceof Date) return at instanceof Date && at.getTime() === want.getTime();
          if (want?.lt) return at instanceof Date && at < want.lt;
          return true;
        };
        if (!matches(args.where)) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    evidence: { findFirst: async () => DB.evidence },
    // The derived-production lifecycle rule reads the record's state raw.
    $queryRawUnsafe: async () => [DB.lifecycle],
  },
}));
// NEW-RG-33-1 / closure3/store (FV2-RESIDUAL-4) — the preview storage
// admission (capacity lock, write-ahead declaration, reuse of a stored key) is
// proven against a real PostgreSQL and object store where it lives
// (api test closure3-redaction-page-preview-storage.integration.test.ts);
// here, what the processor does with each of its answers.
const GATE = vi.hoisted(() => ({
  verdict: { allowed: true } as { allowed: true } | { allowed: false; reason: "storage_limit" | "evidence_not_found" },
  asked: [] as Array<{ evidenceId: string; incomingBytes: bigint | number; declaredAtPut?: unknown }>,
  /** Set: the key already holds an object of this size (reuse). */
  reuse: null as null | { bytes: number },
  claimLost: false,
  /** Calls of the declared-pointer reconciliation (its own behaviour is proven in the api suite). */
  sweeps: [] as Array<{ store: unknown }>,
  sweepError: null as Error | null,
}));
vi.mock("../src/workspace-billing.js", () => ({}));
vi.mock("../src/redaction/redaction-page-preview-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/redaction/redaction-page-preview-storage.js")>();
  return {
    pngDimensions: actual.pngDimensions,
    PAGE_PREVIEW_DECLARATION_UNPROVEN: actual.PAGE_PREVIEW_DECLARATION_UNPROVEN,
    reconcilePagePreviewStoragePointers: async (p: { store: unknown }) => {
      GATE.sweeps.push(p);
      if (GATE.sweepError) throw GATE.sweepError;
      return { scanned: 0, cleared: 0, kept: 0, skipped: 0 };
    },
    preparePagePreviewWrite: async (p: { evidenceId: string; bytes: number; bucket: string; contentKey: string; claimedAt: Date }) => {
      GATE.asked.push({ evidenceId: p.evidenceId, incomingBytes: p.bytes });
      if (GATE.claimLost) return { kind: "claim_lost" };
      if (!GATE.verdict.allowed) return { kind: "refused", reason: GATE.verdict.reason };
      const renewed = new Date(p.claimedAt.getTime() + 1);
      const row = DB.preview!;
      if (GATE.reuse) {
        Object.assign(row, { storageBucket: p.bucket, storageKey: p.contentKey, byteSize: BigInt(GATE.reuse.bytes), renderStartedAt: renewed });
        return { kind: "reuse", bucket: p.bucket, key: p.contentKey, byteSize: GATE.reuse.bytes, claimedAt: renewed };
      }
      // The declaration the real admission writes before any byte is sent.
      Object.assign(row, { storageBucket: p.bucket, storageKey: p.contentKey, byteSize: BigInt(p.bytes), renderStartedAt: renewed });
      return { kind: "write", bucket: p.bucket, key: p.contentKey, claimedAt: renewed, writeDeadlineAt: Date.now() + 60_000, byteSize: p.bytes, unproven: false };
    },
  };
});
vi.mock("../src/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock("../src/object-retention.js", () => ({ artifactLockFor: async () => null }));
vi.mock("../src/storage.js", () => ({
  getObjectRange: async (p: { key: string; range?: string }) => {
    if (p.key.startsWith("redactions/")) return STORE.storedPreview ? STORE.storedPreview.subarray(0, 32) : null;
    STORE.reads += 1;
    if (STORE.readError) throw STORE.readError;
    return STORE.source;
  },
  putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer; contentType: string }) => {
    STORE.declaredAtPut.push({ storageKey: DB.preview?.storageKey, byteSize: DB.preview?.byteSize, state: DB.preview?.state });
    if (STORE.putError) throw STORE.putError;
    STORE.puts.push(p);
    return undefined;
  },
  s3: {},
}));

import {
  PAGE_PREVIEW_MAX_EDGE_PX,
  processRedactionPagePreviewJob,
  reconcileStrandedRedactionPagePreviews,
  renderPdfPagePreview,
} from "../src/redaction/redaction-page-preview.processor.js";
import { REDACTION_PAGE_PREVIEW_LEASE_MS } from "../src/redaction/redaction-page-preview-writer.js";
import { pngDimensions } from "../src/redaction/redaction-page-preview-storage.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW);

/** Pages painted edge to edge, each in its own colour. */
function pdfOf(pages: Array<{ size: [number, number]; fill: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const chunks: Buffer[] = [];
    d.on("data", (c: Buffer) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.on("error", reject);
    for (const p of pages) {
      d.addPage({ size: p.size, margin: 0 });
      d.rect(0, 0, p.size[0], p.size[1]).fill(p.fill);
    }
    d.end();
  });
}

async function centrePixel(png: Buffer): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

const A4: [number, number] = [595.28, 841.89];
let twoPages: Buffer;

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "rpp-p-1",
    name: ENTRY.workName,
    attemptsMade: 0,
    data: { commandId: "p-1", traceId: "t", schemaVersion: ENTRY.schemaVersion },
    ...overrides,
  } as never;
}

function seed(overrides: Record<string, unknown> = {}) {
  DB.preview = {
    id: "p-1",
    teamId: "team-1",
    projectId: "proj-1",
    evidenceId: "ev-1",
    pageIndex: 1,
    state: "QUEUED",
    renderStartedAt: null,
    project: { id: "proj-1", teamId: "team-1", evidenceId: "ev-1", artifactKind: "PDF" },
    ...overrides,
  };
}

beforeEach(async () => {
  twoPages ??= await pdfOf([
    { size: A4, fill: "#c81e1e" },
    { size: A4, fill: "#1e3ac8" },
  ]);
  DB.preview = null;
  DB.lifecycle = { deleted_at: null, status: "SIGNED", lifecycle_state: "ACTIVE" };
  DB.stranded = [];
  DB.strandedWhere = null;
  STORE.source = twoPages;
  STORE.readError = null;
  STORE.reads = 0;
  STORE.puts = [];
  STORE.declaredAtPut = [];
  STORE.putError = null;
  STORE.storedPreview = null;
  GATE.verdict = { allowed: true };
  GATE.asked = [];
  GATE.reuse = null;
  GATE.claimLost = false;
  GATE.sweeps = [];
  GATE.sweepError = null;
  DB.evidence = {
    storageBucket: "bkt",
    storageKey: "orig/key.pdf",
    fileSha256: createHash("sha256").update(twoPages).digest("hex"),
    sizeBytes: BigInt(twoPages.length),
  };
});

describe("renderPdfPagePreview", () => {
  it("renders the REQUESTED page at the redacted copy's scale", async () => {
    const first = await renderPdfPagePreview(twoPages, 0);
    const second = await renderPdfPagePreview(twoPages, 1);
    if (!first.ok || !second.ok) throw new Error("render failed");
    expect(second.pageCount).toBe(2);
    // A4 at scale 2 — the scale renderRedactedPdfCounted rasterises with.
    expect([second.width, second.height]).toEqual([Math.floor(A4[0] * 2), Math.floor(A4[1] * 2)]);
    expect(second.png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const [r1, , b1] = await centrePixel(first.png);
    const [r2, , b2] = await centrePixel(second.png);
    expect(r1).toBeGreaterThan(150);
    expect(b1).toBeLessThan(80);
    expect(b2).toBeGreaterThan(150);
    expect(r2).toBeLessThan(80);
  });

  it("refuses a page that does not exist, by name", async () => {
    expect(await renderPdfPagePreview(twoPages, 2)).toEqual({ ok: false, reason: "page_out_of_range" });
    expect(await renderPdfPagePreview(twoPages, -1)).toEqual({ ok: false, reason: "page_out_of_range" });
    expect(await renderPdfPagePreview(twoPages, 0.5)).toEqual({ ok: false, reason: "page_out_of_range" });
  });

  it("scales an oversized page down to the preview's longest edge, keeping its shape", async () => {
    const poster = await pdfOf([{ size: [4000, 2000], fill: "#22aa22" }]);
    const out = await renderPdfPagePreview(poster, 0);
    if (!out.ok) throw new Error("render failed");
    expect(out.width).toBeLessThanOrEqual(PAGE_PREVIEW_MAX_EDGE_PX);
    expect(out.width).toBeGreaterThan(PAGE_PREVIEW_MAX_EDGE_PX - 2);
    expect(Math.abs(out.width / out.height - 2)).toBeLessThan(0.01);
  });
});

describe("processRedactionPagePreviewJob", () => {
  it("renders the page, stores it under the redaction prefix and completes READY with its size", async () => {
    seed();
    await processRedactionPagePreviewJob(job());
    expect(STORE.puts).toHaveLength(1);
    const put = STORE.puts[0]!;
    expect(put.bucket).toBe("bkt");
    expect(put.key).toMatch(/^redactions\/team-1\/previews\/proj-1\/page-1-[0-9a-f]{16}\.png$/);
    expect(put.key).not.toBe("orig/key.pdf");
    expect(put.contentType).toBe("image/png");
    expect(DB.preview).toMatchObject({
      state: "READY",
      storageBucket: "bkt",
      storageKey: put.key,
      byteSize: BigInt(put.body.length),
      width: Math.floor(A4[0] * 2),
      height: Math.floor(A4[1] * 2),
      failureReason: null,
    });
    // The stored bytes are the SECOND page (pageIndex 1).
    const [r, , b] = await centrePixel(put.body);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
  });

  it("asks the storage admission with the rendered PNG's exact size, and the PUT is sent only once the bytes are DECLARED on the row (NEW-RG-33-1, FV2-RESIDUAL-4)", async () => {
    seed();
    await processRedactionPagePreviewJob(job());
    expect(STORE.puts).toHaveLength(1);
    expect(GATE.asked).toHaveLength(1);
    expect(GATE.asked[0]!.evidenceId).toBe("ev-1");
    expect(BigInt(GATE.asked[0]!.incomingBytes)).toBe(BigInt(STORE.puts[0]!.body.length));
    expect(STORE.declaredAtPut, "counted before any byte is sent").toEqual([
      { storageKey: STORE.puts[0]!.key, byteSize: BigInt(STORE.puts[0]!.body.length), state: "RENDERING" },
    ]);
  });

  it("a key that already holds the object is never written again: READY with the STORED size and dimensions (FV2-RESIDUAL-4)", async () => {
    seed();
    const stored = await sharp({ create: { width: 321, height: 123, channels: 3, background: "#fff" } }).png().toBuffer();
    STORE.storedPreview = stored;
    GATE.reuse = { bytes: stored.length };
    await processRedactionPagePreviewJob(job());
    expect(STORE.puts, "no second version").toHaveLength(0);
    expect(DB.preview).toMatchObject({ state: "READY", byteSize: BigInt(stored.length), width: 321, height: 123 });
  });

  it("a claim lost at admission writes nothing; a failed PUT gives the claim back and KEEPS the declaration counted (FV2-RESIDUAL-4)", async () => {
    seed();
    GATE.claimLost = true;
    await processRedactionPagePreviewJob(job());
    expect(STORE.puts).toHaveLength(0);
    expect(STORE.declaredAtPut).toHaveLength(0);
    expect(DB.preview?.state, "the row is the new holder's").toBe("RENDERING");

    seed();
    GATE.claimLost = false;
    STORE.putError = new Error("503 SlowDown");
    await expect(processRedactionPagePreviewJob(job())).rejects.toThrow(/SlowDown/);
    expect(DB.preview).toMatchObject({ state: "QUEUED", renderStartedAt: null });
    expect(DB.preview?.storageKey, "the PUT may have landed: the bytes stay declared").toMatch(/^redactions\/team-1\/previews\//);
    expect(DB.preview?.byteSize).toBe(STORE.declaredAtPut[0]!.byteSize);
  });

  it("a workspace with no storage room gains no preview: nothing stored, the row FAILS storage_limit (NEW-RG-33-1)", async () => {
    seed();
    GATE.verdict = { allowed: false, reason: "storage_limit" };
    await processRedactionPagePreviewJob(job());
    expect(STORE.puts).toHaveLength(0);
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "storage_limit" });
    expect(DB.preview?.storageKey ?? null).toBeNull();
  });

  it("refuses a source over the redaction byte budget without reading or storing anything", async () => {
    seed();
    DB.evidence = { ...DB.evidence, sizeBytes: BigInt(REDACTION_SOURCE_BYTE_BUDGET + 1) };
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "source_too_large" });
    expect(STORE.reads).toBe(0);
    expect(STORE.puts).toHaveLength(0);
  });

  it("refuses bytes that no longer match the sealed digest", async () => {
    seed();
    DB.evidence = { ...DB.evidence, fileSha256: "0".repeat(64) };
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "source_digest_mismatch" });
    expect(STORE.puts).toHaveLength(0);
  });

  it("fails a page past the end of the document, and a page index past the cap", async () => {
    seed({ pageIndex: 7 });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "page_out_of_range" });
    expect(STORE.puts).toHaveLength(0);

    seed({ pageIndex: 200 });
    STORE.reads = 0;
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "page_out_of_range" });
    expect(STORE.reads).toBe(0);
  });

  it("fails closed on a tenant mismatch, a project that is not a PDF and a record that left service", async () => {
    seed({ project: { id: "proj-1", teamId: "team-2", evidenceId: "ev-1", artifactKind: "PDF" } });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "tenant_mismatch" });

    seed({ project: { id: "proj-1", teamId: "team-1", evidenceId: "ev-1", artifactKind: "IMAGE" } });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "FAILED", failureReason: "unsupported_media" });

    seed();
    DB.lifecycle = { deleted_at: new Date(), status: "SIGNED", lifecycle_state: "TRASHED" };
    await processRedactionPagePreviewJob(job());
    expect(DB.preview?.state).toBe("FAILED");
    expect(String(DB.preview?.failureReason)).toMatch(/^evidence_ineligible:/);
    expect(STORE.reads).toBe(0);
    expect(STORE.puts).toHaveLength(0);
  });

  it("a transient storage failure gives the claim back and rethrows for the retry", async () => {
    seed();
    STORE.readError = new Error("connect ECONNREFUSED 127.0.0.1:9000");
    await expect(processRedactionPagePreviewJob(job())).rejects.toThrow(/ECONNREFUSED/);
    expect(DB.preview).toMatchObject({ state: "QUEUED", renderStartedAt: null });
    // The retry renders it.
    STORE.readError = null;
    await processRedactionPagePreviewJob(job());
    expect(DB.preview?.state).toBe("READY");
  });

  it("a replayed job, a live claim, a wrong job name and a payload carrying authority fields change nothing", async () => {
    seed({ state: "READY", storageKey: "redactions/x.png" });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview?.state).toBe("READY");
    expect(STORE.puts).toHaveLength(0);

    const liveAt = new Date();
    seed({ state: "RENDERING", renderStartedAt: liveAt });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview).toMatchObject({ state: "RENDERING", renderStartedAt: liveAt });

    seed();
    await processRedactionPagePreviewJob(job({ name: JOB_NAMES.RENDER_REDACTION_DERIVATIVE }));
    expect(DB.preview?.state).toBe("QUEUED");
    await processRedactionPagePreviewJob(
      job({ data: { commandId: "p-1", traceId: "t", schemaVersion: ENTRY.schemaVersion, teamId: "team-2" } }),
    );
    expect(DB.preview?.state).toBe("QUEUED");
    await processRedactionPagePreviewJob(job({ data: { previewId: "p-1" } }));
    expect(DB.preview?.state).toBe("QUEUED");
    expect(STORE.reads).toBe(0);
  });

  it("an expired RENDERING lease is taken over and rendered", async () => {
    seed({ state: "RENDERING", renderStartedAt: new Date(Date.now() - REDACTION_PAGE_PREVIEW_LEASE_MS - 1000) });
    await processRedactionPagePreviewJob(job());
    expect(DB.preview?.state).toBe("READY");
  });
});

describe("pngDimensions", () => {
  it("reads a PNG's width and height from its header, and nothing else", async () => {
    const png = await sharp({ create: { width: 17, height: 9, channels: 4, background: "#000" } }).png().toBuffer();
    expect(pngDimensions(png.subarray(0, 32))).toEqual({ width: 17, height: 9 });
    expect(pngDimensions(png.subarray(0, 20))).toBeNull();
    expect(pngDimensions(Buffer.alloc(32))).toBeNull();
    expect(pngDimensions(null)).toBeNull();
  });
});

describe("reconcileStrandedRedactionPagePreviews", () => {
  it("re-enqueues old QUEUED rows and expired RENDERING leases by id, and reports what it enqueued", async () => {
    DB.stranded = [{ id: "p-1" }, { id: "p-2" }];
    const sent: string[] = [];
    const out = await reconcileStrandedRedactionPagePreviews({
      enqueue: async (p) => {
        sent.push(p.previewId);
        return { enqueued: p.previewId === "p-1" };
      },
    });
    expect(sent).toEqual(["p-1", "p-2"]);
    expect(out).toEqual({ scanned: 2, reenqueued: 1 });
    const or = (DB.strandedWhere as { OR: Array<Record<string, unknown>> }).OR;
    expect(or.map((c) => c.state)).toEqual(["QUEUED", "RENDERING"]);
    expect(or[0]).toHaveProperty("updatedAt.lt");
    expect(or[1]).toHaveProperty("renderStartedAt.lt");
    // closure3/store — the same cron-locked sweep judges preview declarations
    // against the worker's store.
    expect(GATE.sweeps).toHaveLength(1);
    expect(GATE.sweeps[0]!.store).toBeTruthy();
  });

  it("the declared-pointer reconciliation is fail-isolated and can be skipped; re-enqueueing always runs (FV2-RESIDUAL-4)", async () => {
    DB.stranded = [{ id: "p-1" }];
    GATE.sweepError = new Error("store unreachable");
    const sent: string[] = [];
    const enqueue = async (p: { previewId: string }) => {
      sent.push(p.previewId);
      return { enqueued: true };
    };
    expect(await reconcileStrandedRedactionPagePreviews({ enqueue })).toEqual({ scanned: 1, reenqueued: 1 });
    expect(GATE.sweeps).toHaveLength(1);
    expect(await reconcileStrandedRedactionPagePreviews({ enqueue, store: null })).toEqual({ scanned: 1, reenqueued: 1 });
    expect(GATE.sweeps, "store: null skips the step").toHaveLength(1);
    expect(sent).toEqual(["p-1", "p-1"]);
  });
});
