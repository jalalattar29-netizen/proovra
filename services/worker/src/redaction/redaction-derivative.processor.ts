/**
 * PHASE 12B WAVE 2A — redaction-derivative render processor.
 *
 * Consumes the dedicated `redaction-derivative` BullMQ queue. The job payload
 * carries ONLY { derivativeId } — the processor reloads EVERY authoritative
 * fact from persistence (tenant, version state, regions, source binding) and
 * fails closed on any mismatch. It never trusts payload fields, never mutates
 * the original Evidence row/object, and completes exclusively through the ONE
 * worker-side writer (claim → READY/FAILED with stale-transition rejection).
 *
 * Shipping scope: IMAGE (sharp composite) + PDF (pdfjs rasterize → black-rect
 * composite → pdfkit reassemble = flattened DESTRUCTIVE raster, no recoverable
 * text). VIDEO/AUDIO are FUTURE_NOT_SHIPPING — the API refuses them before a
 * row exists; a row that still arrives here (tamper/legacy) FAILS safely.
 *
 * Queue conventions (mirror derived-assets.processor):
 *   - shared prisma from ./db.js (never a private client);
 *   - structural problems → mark FAILED + return (no BullMQ retry storm);
 *   - transient store errors → throw (BullMQ backoff);
 *   - bounded source read budget.
 */

import type { Job } from "bullmq";
import { createHash } from "node:crypto";
import {
  JOB_NAMES,
  QueuePayloadRejected,
  decodeJobPayload,
  getWorkEntryOrThrow,
  type RedactionDerivativeJobPayload,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getObjectRange, putObjectBuffer } from "../storage.js";
import {
  claimDerivativeForRender,
  markDerivativeFailedWorker,
  markDerivativeReadyWorker,
} from "./redaction-derivative-writer.js";

const SOURCE_READ_BUDGET_BYTES = 50 * 1024 * 1024; // 50MB, matches MI extract
const REDACTION_S3_PREFIX = "redactions";
export const REDACTION_RENDER_ENGINE = "redaction-render-v1";
const PDF_RASTER_SCALE = 2;

type NormalizedRect = { x: number; y: number; width: number; height: number; page?: number };

// PHASE 12 POINT 4 PASS C2 — the payload shape has ONE definition
// (@proovra/shared); re-exported here for the existing local importers.
export type { RedactionDerivativeJobPayload };

const REGISTRY_ENTRY = getWorkEntryOrThrow(
  JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
);
const EXPECT = {
  jobName: REGISTRY_ENTRY.workName,
  schemaVersion: REGISTRY_ENTRY.schemaVersion,
};

export async function processRedactionDerivativeJob(
  job: Job<RedactionDerivativeJobPayload>,
): Promise<void> {
  // PHASE 12 POINT 5 — validate the job NAME and the payload SCHEMA before any
  // database access. A job that landed on this queue under a different name, or
  // carrying an unrecognised schema version, is refused here rather than being
  // interpreted optimistically. `decoded.discardedAuthorityFields` names any
  // tenant/policy/storage field that arrived on the wire — it is logged and
  // then never read, because every one of those facts is reloaded below.
  if (job.name && job.name !== REGISTRY_ENTRY.workName) {
    logger.warn(
      { jobId: job.id, jobName: job.name },
      "redaction_derivative.job_name_mismatch",
    );
    return;
  }

  let derivativeId: string;
  try {
    const decoded = decodeJobPayload(EXPECT, job.data);
    derivativeId = decoded.commandId;
    if (decoded.discardedAuthorityFields.length > 0) {
      logger.warn(
        {
          jobId: job.id,
          derivativeId,
          discarded: decoded.discardedAuthorityFields,
        },
        "redaction_derivative.payload_authority_fields_discarded",
      );
    }
  } catch (err) {
    logger.warn(
      {
        jobId: job.id,
        code: err instanceof QueuePayloadRejected ? err.code : "malformed",
      },
      "redaction_derivative.payload_rejected",
    );
    return; // structurally invalid — nothing to fail against, and no mutation
  }

  // ── atomic claim: only ONE worker enters RENDERING; replays lose the race ──
  const claim = await claimDerivativeForRender(derivativeId);
  if (!claim.claimed) {
    logger.info({ derivativeId, reason: claim.reason }, "redaction_derivative.claim_skipped");
    return;
  }
  const { teamId } = claim;
  const fail = (reason: string, preview?: string) =>
    markDerivativeFailedWorker({ derivativeId, teamId, failureReason: reason, errorPreview: preview });

  try {
    // ── reload ALL authoritative truth from persistence ────────────────────
    const derivative = await prisma.redactionDerivative.findUnique({
      where: { id: derivativeId },
      select: {
        id: true,
        teamId: true,
        versionId: true,
        version: {
          select: {
            id: true,
            teamId: true,
            state: true,
            project: {
              select: { id: true, teamId: true, artifactKind: true, evidenceId: true },
            },
          },
        },
      },
    });
    if (!derivative || !derivative.version) {
      await fail("derivative_missing");
      return;
    }
    const version = derivative.version;
    // Tenant coherence — every row must agree on the workspace.
    if (
      derivative.teamId !== teamId ||
      version.teamId !== teamId ||
      version.project.teamId !== teamId
    ) {
      await fail("tenant_mismatch");
      return;
    }
    if (version.state !== "APPROVED" && version.state !== "PUBLISHED") {
      await fail("version_not_approved");
      return;
    }
    const artifactKind = version.project.artifactKind;
    if (artifactKind !== "IMAGE" && artifactKind !== "PDF") {
      await fail("unsupported_media");
      return;
    }

    // Approved regions — the authoritative WHAT-to-redact.
    const regions = await prisma.redactionRegion.findMany({
      where: { versionId: version.id, teamId },
      select: { geometry: true },
    });
    const rects: NormalizedRect[] = [];
    for (const r of regions) {
      const g = r.geometry as Record<string, unknown> | null;
      const x = num(g?.x), y = num(g?.y), w = num(g?.width), h = num(g?.height);
      if (x === null || y === null || w === null || h === null) {
        await fail("region_invalid");
        return;
      }
      const page = num(g?.page);
      rects.push({ x, y, width: w, height: h, ...(page !== null ? { page } : {}) });
    }
    if (artifactKind === "PDF" && rects.some((r) => r.page === undefined)) {
      // Page identity is REQUIRED for page-aware PDF redaction — fail closed
      // rather than guess a page and ship an unredacted region.
      await fail("region_page_missing");
      return;
    }

    // Source binding — the immutable original object.
    const evidence = await prisma.evidence.findFirst({
      where: { id: version.project.evidenceId, teamId },
      select: { storageBucket: true, storageKey: true, fileSha256: true },
    });
    if (!evidence?.storageBucket || !evidence.storageKey) {
      await fail("source_object_missing");
      return;
    }

    // ── fetch + verify the source (transient store errors THROW for retry) ─
    const source = await getObjectRange({
      bucket: evidence.storageBucket,
      key: evidence.storageKey,
      range: `bytes=0-${SOURCE_READ_BUDGET_BYTES - 1}`,
    });
    if (!source || source.length === 0) {
      await fail("source_object_empty");
      return;
    }
    if (evidence.fileSha256) {
      const digest = createHash("sha256").update(source).digest("hex");
      if (digest !== evidence.fileSha256.toLowerCase()) {
        await fail("source_digest_mismatch");
        return;
      }
    }

    // ── render ─────────────────────────────────────────────────────────────
    let output: Buffer;
    let contentType: string;
    let extension: string;
    if (artifactKind === "IMAGE") {
      output = await renderRedactedImage(source, rects);
      contentType = "image/png";
      extension = "png";
    } else {
      output = await renderRedactedPdf(source, rects);
      contentType = "application/pdf";
      extension = "pdf";
    }
    if (!output || output.length === 0) {
      await fail("renderer_empty_output");
      return;
    }
    const outSha = createHash("sha256").update(output).digest("hex");
    // Hard immutability guard — the derivative NEVER equals the original bytes
    // (a silent copy would advertise an unredacted file as redacted).
    if (rects.length > 0 && outSha === createHash("sha256").update(source).digest("hex")) {
      await fail("renderer_identity_output");
      return;
    }

    // ── store to a DISTINCT prefix (never the original key) ───────────────
    const outKey = `${REDACTION_S3_PREFIX}/${teamId}/${version.id}/${outSha.slice(0, 16)}.${extension}`;
    await putObjectBuffer({
      bucket: evidence.storageBucket,
      key: outKey,
      body: output,
      contentType,
    });

    // ── ONE completion writer (stale/replayed transitions rejected) ────────
    const done = await markDerivativeReadyWorker({
      derivativeId,
      teamId,
      storageBucket: evidence.storageBucket,
      storageKey: outKey,
      byteSize: output.length,
      fileSha256: outSha,
      contentType,
      renderEngine: REDACTION_RENDER_ENGINE,
    });
    if (!done.ok) {
      logger.warn({ derivativeId, reason: done.reason }, "redaction_derivative.ready_rejected");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Transient storage/connectivity problems → throw for BullMQ retry;
    // everything else fails closed against the row.
    if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|5\d\d|SlowDown|InternalError/i.test(msg)) {
      throw err;
    }
    await fail("renderer_failed", msg.slice(0, 300));
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── IMAGE — sharp composite of opaque rects over normalized geometry ─────────
async function renderRedactedImage(source: Buffer, rects: NormalizedRect[]): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const img = sharp(source, { failOn: "none" }).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("image_dimensions_unreadable");
  const boxes = rects
    .map((r) => {
      const x = Math.max(0, Math.floor(r.x * width));
      const y = Math.max(0, Math.floor(r.y * height));
      const w = Math.min(width - x, Math.max(1, Math.ceil(r.width * width)));
      const h = Math.min(height - y, Math.max(1, Math.ceil(r.height * height)));
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="black"/>`;
    })
    .join("");
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}</svg>`,
  );
  // Flattened PNG output — pixels are destroyed, not overlaid metadata.
  return img.composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}

// ── PDF — rasterize each page, burn rects, reassemble (flattened raster) ─────
async function renderRedactedPdf(source: Buffer, rects: NormalizedRect[]): Promise<Buffer> {
  const canvasModule = (await import("@napi-rs/canvas")) as unknown as {
    createCanvas: (w: number, h: number) => {
      getContext: (t: "2d") => {
        fillStyle: string;
        fillRect: (x: number, y: number, w: number, h: number) => void;
      } & Record<string, unknown>;
      toBuffer: (mime?: string) => Buffer;
    };
    DOMMatrix?: typeof globalThis.DOMMatrix;
    ImageData?: typeof globalThis.ImageData;
    Path2D?: typeof globalThis.Path2D;
  };
  if (canvasModule.DOMMatrix && !globalThis.DOMMatrix) globalThis.DOMMatrix = canvasModule.DOMMatrix;
  if (canvasModule.ImageData && !globalThis.ImageData) globalThis.ImageData = canvasModule.ImageData;
  if (canvasModule.Path2D && !globalThis.Path2D) globalThis.Path2D = canvasModule.Path2D;

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (o: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getViewport: (o: { scale: number }) => { width: number; height: number };
          render: (o: Record<string, unknown>) => { promise: Promise<void> };
        }>;
        destroy?: () => Promise<void> | void;
      }>;
    };
  };
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(source),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const { default: PDFDocument } = (await import("pdfkit")) as unknown as {
    default: new (o: Record<string, unknown>) => {
      addPage: (o: Record<string, unknown>) => unknown;
      image: (b: Buffer, x: number, y: number, o: Record<string, unknown>) => unknown;
      end: () => void;
      on: (ev: string, cb: (c?: Buffer) => void) => void;
    };
  };
  const doc = new PDFDocument({ autoFirstPage: false, compress: true });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolveDone, rejectDone) => {
    doc.on("data", (c) => c && chunks.push(c));
    doc.on("end", () => resolveDone(Buffer.concat(chunks)));
    doc.on("error", () => rejectDone(new Error("pdf_assembly_failed")));
  });

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: PDF_RASTER_SCALE });
    const w = Math.max(1, Math.floor(viewport.width));
    const h = Math.max(1, Math.floor(viewport.height));
    const canvas = canvasModule.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Burn this page's rects INTO the raster (destructive; the text layer is
    // gone because the output is a flattened image-only PDF).
    for (const r of rects) {
      if (r.page !== pageNo) continue;
      ctx.fillStyle = "black";
      ctx.fillRect(
        Math.max(0, Math.floor(r.x * w)),
        Math.max(0, Math.floor(r.y * h)),
        Math.max(1, Math.ceil(r.width * w)),
        Math.max(1, Math.ceil(r.height * h)),
      );
    }
    const png = canvas.toBuffer("image/png");
    // Point-size page matching the raster scale back to PDF units.
    doc.addPage({ size: [w / PDF_RASTER_SCALE, h / PDF_RASTER_SCALE], margin: 0 });
    doc.image(png, 0, 0, { width: w / PDF_RASTER_SCALE, height: h / PDF_RASTER_SCALE });
  }
  await pdf.destroy?.();
  doc.end();
  return finished;
}

// ── stranded-QUEUED reconciler (interval + cron-lock; registered in index) ───
export async function reconcileStrandedRedactionDerivatives(input: {
  olderThanMs?: number;
  batchSize?: number;
  enqueue: (payload: RedactionDerivativeJobPayload) => Promise<{ enqueued: boolean }>;
}): Promise<{ scanned: number; reenqueued: number }> {
  const cutoff = new Date(Date.now() - (input.olderThanMs ?? 5 * 60_000));
  const stranded = await prisma.redactionDerivative.findMany({
    where: { state: "QUEUED", updatedAt: { lt: cutoff } },
    select: { id: true },
    take: Math.min(input.batchSize ?? 100, 500),
    orderBy: { updatedAt: "asc" },
  });
  let reenqueued = 0;
  for (const row of stranded) {
    const res = await input.enqueue({ derivativeId: row.id });
    if (res.enqueued) reenqueued++;
  }
  if (stranded.length > 0) {
    logger.info({ scanned: stranded.length, reenqueued }, "redaction_derivative.reconciled");
  }
  return { scanned: stranded.length, reenqueued };
}
