/**
 * PRO-R3-04 — redaction page-preview processor.
 *
 * The PDF region editor drew on a blank frame: nothing rendered the page.
 * This consumes the `redaction-page-preview` queue and renders ONE page of a
 * PDF redaction project's record to a PNG the editor draws on.
 *
 * Same contract as the derivative render it mirrors:
 *   - the payload carries only the `RedactionPagePreview` id; tenant, project,
 *     page and source binding are reloaded from persistence and must agree;
 *   - atomic QUEUED→RENDERING claim, every later write fenced by that claim;
 *   - the source is read within the ONE redaction byte budget and compared
 *     with the sealed digest before a pixel of it is rendered;
 *   - a record that has left service gains no new derived bytes;
 *   - structural problems FAIL the row (no retry storm); transient storage
 *     errors release the claim and throw for the BullMQ retry;
 *   - the image is stored under the redaction prefix, never the original key.
 *
 * The image is a working aid for people who may author regions on the
 * project. It is not a redacted copy and is never published.
 */

import type { Job } from "bullmq";
import { createHash } from "node:crypto";
import {
  JOB_NAMES,
  QueuePayloadRejected,
  REDACTION_PAGE_PREVIEW_MAX_PAGES,
  REDACTION_SOURCE_BYTE_BUDGET,
  decodeJobPayload,
  getWorkEntryOrThrow,
  type RedactionPagePreviewJobPayload,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { artifactLockFor } from "../object-retention.js";
import { getObjectRange, putObjectBuffer, s3 } from "../storage.js";
import { s3DerivedObjectStore, type DerivedObjectStore } from "../derived-storage-intent.js";
import { pngDimensions, preparePagePreviewWrite, reconcilePagePreviewStoragePointers } from "./redaction-page-preview-storage.js";
import { derivedProductionRefusal } from "./redaction-derivative-writer.js";
import { PDF_RASTER_SCALE, loadPdfRasterCanvas } from "./redaction-derivative.processor.js";
import {
  REDACTION_PAGE_PREVIEW_LEASE_MS,
  claimPagePreviewForRender,
  markPagePreviewFailedWorker,
  markPagePreviewReadyWorker,
  releasePagePreviewClaim,
} from "./redaction-page-preview-writer.js";

const SOURCE_READ_BUDGET_BYTES = REDACTION_SOURCE_BYTE_BUDGET;
const REDACTION_S3_PREFIX = "redactions";
/** The longest edge of a preview, in pixels: an oversized page is scaled down to it. */
export const PAGE_PREVIEW_MAX_EDGE_PX = 2400;

const REGISTRY_ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW);
const EXPECT = {
  jobName: REGISTRY_ENTRY.workName,
  schemaVersion: REGISTRY_ENTRY.schemaVersion,
};

export async function processRedactionPagePreviewJob(
  job: Job<RedactionPagePreviewJobPayload>,
): Promise<void> {
  if (job.name && job.name !== REGISTRY_ENTRY.workName) {
    logger.warn({ jobId: job.id, jobName: job.name }, "redaction_page_preview.job_name_mismatch");
    return;
  }

  let previewId: string;
  try {
    const decoded = decodeJobPayload(EXPECT, job.data);
    previewId = decoded.commandId;
    if (decoded.discardedAuthorityFields.length > 0) {
      logger.warn(
        { jobId: job.id, previewId, discarded: decoded.discardedAuthorityFields },
        "redaction_page_preview.payload_authority_fields_discarded",
      );
    }
  } catch (err) {
    logger.warn(
      { jobId: job.id, code: err instanceof QueuePayloadRejected ? err.code : "malformed" },
      "redaction_page_preview.payload_rejected",
    );
    return;
  }

  const claim = await claimPagePreviewForRender(previewId);
  if (!claim.claimed) {
    logger.info({ previewId, reason: claim.reason }, "redaction_page_preview.claim_skipped");
    return;
  }
  const { teamId } = claim;
  let claimedAt = claim.claimedAt;
  const fail = (reason: string) =>
    markPagePreviewFailedWorker({ previewId, teamId, failureReason: reason, claimedAt });

  try {
    // ── reload ALL authoritative truth from persistence ────────────────────
    const preview = await prisma.redactionPagePreview.findUnique({
      where: { id: previewId },
      select: {
        id: true,
        teamId: true,
        projectId: true,
        evidenceId: true,
        pageIndex: true,
        project: { select: { id: true, teamId: true, evidenceId: true, artifactKind: true } },
      },
    });
    if (!preview || !preview.project) {
      await fail("preview_missing");
      return;
    }
    if (
      preview.teamId !== teamId ||
      preview.project.teamId !== teamId ||
      preview.project.evidenceId !== preview.evidenceId
    ) {
      await fail("tenant_mismatch");
      return;
    }
    if (preview.project.artifactKind !== "PDF") {
      await fail("unsupported_media");
      return;
    }
    if (
      !Number.isInteger(preview.pageIndex) ||
      preview.pageIndex < 0 ||
      preview.pageIndex >= REDACTION_PAGE_PREVIEW_MAX_PAGES
    ) {
      await fail("page_out_of_range");
      return;
    }

    const evidence = await prisma.evidence.findFirst({
      where: { id: preview.evidenceId, teamId },
      select: { storageBucket: true, storageKey: true, fileSha256: true, sizeBytes: true },
    });
    if (!evidence?.storageBucket || !evidence.storageKey) {
      await fail("source_object_missing");
      return;
    }
    if (
      evidence.sizeBytes !== null &&
      evidence.sizeBytes !== undefined &&
      Number(evidence.sizeBytes) > SOURCE_READ_BUDGET_BYTES
    ) {
      await fail("source_too_large");
      return;
    }
    const refusedBeforeRender = await derivedProductionRefusal(preview.evidenceId);
    if (refusedBeforeRender) {
      await fail(refusedBeforeRender);
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
    if (source.length >= SOURCE_READ_BUDGET_BYTES) {
      await fail("source_too_large");
      return;
    }
    if (evidence.fileSha256) {
      const digest = createHash("sha256").update(source).digest("hex");
      if (digest !== evidence.fileSha256.toLowerCase()) {
        await fail("source_digest_mismatch");
        return;
      }
    }

    // ── render the one page ────────────────────────────────────────────────
    const rendered = await renderPdfPagePreview(source, preview.pageIndex);
    if (!rendered.ok) {
      await fail(rendered.reason);
      return;
    }

    // ── store to the redaction prefix (never the original key) ────────────
    const refusedBeforeStore = await derivedProductionRefusal(preview.evidenceId);
    if (refusedBeforeStore) {
      await fail(refusedBeforeStore);
      return;
    }
    // NEW-RG-33-1 (DEC-04 / DEC-16) — the preview is stored under the record's
    // Object Lock and counted in workspace usage (derived storage).
    // closure3/store (FV2-RESIDUAL-4) — its bytes are ADMITTED under the
    // workspace capacity lock and DECLARED on the row (pointer + size) before
    // any byte is sent, so they count from then on whatever fails later; a key
    // that already holds the object is never written again. Refused: FAILED
    // `storage_limit`, nothing stored; the API queues it again once the
    // workspace has room.
    const outSha = createHash("sha256").update(rendered.png).digest("hex");
    const contentKey = `${REDACTION_S3_PREFIX}/${teamId}/previews/${preview.projectId}/page-${preview.pageIndex}-${outSha.slice(0, 16)}.png`;
    const step = await preparePagePreviewWrite({
      previewId,
      teamId,
      evidenceId: preview.evidenceId,
      claimedAt,
      bucket: evidence.storageBucket,
      contentKey,
      bytes: rendered.png.length,
      store: await pagePreviewObjectStore(),
    });
    if (step.kind === "claim_lost") {
      logger.info({ previewId }, "redaction_page_preview.claim_lost_before_store");
      return;
    }
    if (step.kind === "refused") {
      await fail(step.reason);
      return;
    }
    // Every later write is fenced on the claim the admission renewed.
    claimedAt = step.claimedAt;

    let byteSize = rendered.png.length;
    let width = rendered.width;
    let height = rendered.height;
    if (step.kind === "write") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, step.writeDeadlineAt - Date.now()));
      timer.unref?.();
      try {
        if (Date.now() >= step.writeDeadlineAt) throw new PreviewWriteDeadline();
        await putObjectBuffer({
          lock: await artifactLockFor(preview.evidenceId),
          bucket: step.bucket,
          key: step.key,
          body: rendered.png,
          contentType: "image/png",
          abortSignal: controller.signal,
        });
      } catch (err) {
        // The declaration keeps counting whether or not the PUT landed.
        throw controller.signal.aborted ? new PreviewWriteDeadline() : err;
      } finally {
        clearTimeout(timer);
      }
    } else {
      // REUSE: the object is already stored under this key (an earlier
      // attempt's PUT whose answer or READY write was lost). Its own size and
      // dimensions are what the row records.
      byteSize = step.byteSize;
      const dims = pngDimensions(
        await getObjectRange({ bucket: step.bucket, key: step.key, range: "bytes=0-31" }).catch(() => null),
      );
      if (dims) ({ width, height } = dims);
    }

    const done = await markPagePreviewReadyWorker({
      previewId,
      teamId,
      storageBucket: step.bucket,
      storageKey: step.key,
      byteSize,
      width,
      height,
      claimedAt,
    });
    if (!done.ok) {
      logger.warn({ previewId, reason: done.reason }, "redaction_page_preview.ready_rejected");
      // The record left service mid-render: settle the row FAILED and keep the
      // pointer of the object already stored, so destruction finds it.
      if (done.reason.startsWith("evidence_ineligible:")) {
        await markPagePreviewFailedWorker({
          previewId,
          teamId,
          failureReason: done.reason,
          claimedAt,
          storedObject: { bucket: step.bucket, key: step.key, byteSize },
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      err instanceof PreviewWriteDeadline ||
      (err as { retriable?: boolean } | null)?.retriable === true ||
      /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|5\d\d|SlowDown|InternalError/i.test(msg)
    ) {
      // Give the claim back first, or the retry finds RENDERING and no-ops.
      // A declared pointer stays on the row (still counted): the retry reuses
      // the object if the PUT landed, or the reconciler proves the key empty.
      await releasePagePreviewClaim(previewId, claimedAt);
      throw err;
    }
    logger.warn({ previewId, err: msg.slice(0, 300) }, "redaction_page_preview.render_failed");
    await fail("renderer_failed");
  }
}

/** A preview PUT that reached the end of its renewed claim's write window. */
class PreviewWriteDeadline extends Error {
  readonly retriable = true;
  constructor() {
    super("page_preview_put_deadline_exceeded");
  }
}

/** The store the admission lists a preview key with (the worker's S3 client). */
async function pagePreviewObjectStore(): Promise<DerivedObjectStore> {
  return s3DerivedObjectStore(s3 as never);
}

export type PdfPagePreviewResult =
  | { ok: true; png: Buffer; width: number; height: number; pageCount: number }
  | { ok: false; reason: "page_out_of_range" | "renderer_empty_output" };

/**
 * One PDF page as a PNG, on the worker's one PDF.js build and the same canvas
 * and scale the redacted copy is rasterised with, so a region drawn over the
 * preview lands on the same share of the page in the copy. `pageIndex` is
 * 0-based (the index a PDF_PAGE_RECT region stores).
 */
export async function renderPdfPagePreview(source: Buffer, pageIndex: number): Promise<PdfPagePreviewResult> {
  const canvasModule = await loadPdfRasterCanvas();
  const { closePdf, openPdf } = await import("../pdf/pdfjs-runtime.js");
  const pdf = await openPdf(source, { disableFontFace: true });
  try {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) {
      return { ok: false, reason: "page_out_of_range" };
    }
    const page = await pdf.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height, 1);
    const scale = Math.min(PDF_RASTER_SCALE, PAGE_PREVIEW_MAX_EDGE_PX / longest);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = canvasModule.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    // A page with no background of its own is white on paper.
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    const png = canvas.toBuffer("image/png");
    if (!png || png.length === 0) return { ok: false, reason: "renderer_empty_output" };
    return { ok: true, png, width, height, pageCount: pdf.numPages };
  } finally {
    await closePdf(pdf);
  }
}

// ── stranded-row recovery (driven by RedactionStrandedReconciler in index) ───
export async function reconcileStrandedRedactionPagePreviews(input: {
  olderThanMs?: number;
  batchSize?: number;
  enqueue: (payload: RedactionPagePreviewJobPayload) => Promise<{ enqueued: boolean }>;
  /**
   * closure3/store (FV2-RESIDUAL-4) — the store the declared-pointer
   * reconciliation lists keys with (default: the worker's S3 client); null
   * skips that step this tick (the declarations keep counting).
   */
  store?: (() => Promise<DerivedObjectStore>) | null;
}): Promise<{ scanned: number; reenqueued: number }> {
  // The same cron-locked sweep judges preview declarations whose holder's
  // window has closed: a key proven empty stops counting, a stored object
  // stays counted (sized to every version). Fail-isolated: the re-enqueue
  // below runs whatever happens here.
  if (input.store !== null) {
    try {
      await reconcilePagePreviewStoragePointers({ store: await (input.store ?? pagePreviewObjectStore)() });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
        "redaction_page_preview.storage_pointer_reconcile_unavailable",
      );
    }
  }
  const cutoff = new Date(Date.now() - (input.olderThanMs ?? 5 * 60_000));
  const leaseExpired = new Date(Date.now() - REDACTION_PAGE_PREVIEW_LEASE_MS);
  const stranded = await prisma.redactionPagePreview.findMany({
    where: {
      OR: [
        { state: "QUEUED", updatedAt: { lt: cutoff } },
        { state: "RENDERING", renderStartedAt: { lt: leaseExpired } },
      ],
    },
    select: { id: true },
    take: Math.min(input.batchSize ?? 100, 500),
    orderBy: { updatedAt: "asc" },
  });
  let reenqueued = 0;
  for (const row of stranded) {
    const res = await input.enqueue({ previewId: row.id });
    if (res.enqueued) reenqueued++;
  }
  if (stranded.length > 0) {
    logger.info({ scanned: stranded.length, reenqueued }, "redaction_page_preview.reconciled");
  }
  return { scanned: stranded.length, reenqueued };
}
