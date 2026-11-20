/**
 * PRO-R3-04 — the page image the PDF region editor draws on.
 *
 * The editor drew regions on a blank frame. This is the API half of the
 * `RenderRedactionPagePreview` job: it owns the `RedactionPagePreview` row
 * (one per project and page) and answers the editor's read.
 *
 *   - The first ask for a page commits the row QUEUED, THEN enqueues its id
 *     through the canonical enqueue. A lost enqueue leaves the row QUEUED and
 *     the worker's RedactionStrandedReconciler re-enqueues it.
 *   - PENDING while the row is QUEUED or RENDERING.
 *   - READY answers a short-lived presigned GET of the PREVIEW object only.
 *     Bucket and key never leave the server, and the original is never
 *     addressed here.
 *   - A page the worker could not render answers UNAVAILABLE with its bounded
 *     reason; a transient render failure is queued again on a later ask.
 *
 * Authorization is the route's: the region-authoring capability and the
 * project's record reach. This service is workspace-scoped by `teamId`.
 */

import type { PrismaClient } from "@prisma/client";
import { JOB_NAMES, REDACTION_PAGE_PREVIEW_MAX_PAGES } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { enqueueCanonicalWork } from "../../queue/canonical-queue-client.js";
import { presignGetObject } from "../../storage.js";
import { assertFeatureEntitlement } from "../packaging/entitlement.service.js";
import {
  assertWorkspaceAllowsStorageGrowth,
  resolveEnforcementScopeForRequester,
} from "../billing-enforcement.service.js";

/** How long the presigned preview URL lives. */
export const REDACTION_PAGE_PREVIEW_URL_TTL_SECONDS = 300;
/** The storage response's Cache-Control for a preview image (signed into the URL). */
export const REDACTION_PAGE_PREVIEW_CACHE_CONTROL = "private, no-store, max-age=0";
/** A QUEUED row older than this is enqueued again on a read (the add collapses onto a live job). */
const REQUEUE_QUEUED_AFTER_MS = 15_000;
/** A transiently FAILED page is tried again on a read after this long. */
const RETRY_FAILED_AFTER_MS = 60_000;
/**
 * Worker failure reasons that a later attempt can cure. `storage_limit` is the
 * worker's derived-storage refusal (NEW-RG-33-1): once the workspace has room
 * again (the gate below admits the retry), the page can be rendered.
 */
const RETRYABLE_FAILURE_REASONS: ReadonlySet<string> = new Set(["renderer_failed", "source_object_empty", "storage_limit"]);

/**
 * NEW-RG-29-1 (DEC-04 / DEC-16) — a stored preview is derived storage the
 * meter counts (sumDerivedAssetStorageBytes), so rendering one is new growth.
 * The canonical API storage gate, scoped like the sibling redacted-copy gate
 * (redaction-derivative.service.ts): refused when the workspace has no byte of
 * room left. The PNG's size is unknown until rendered; the worker checks the
 * exact bytes again before it stores them (workspaceAllowsDerivedArtifact).
 */
async function previewStorageRefusal(
  prisma: PrismaClient,
  teamId: string,
  evidenceId: string,
): Promise<Extract<RedactionPagePreviewAnswer, { ok: false }> | null> {
  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId },
    select: { ownerUserId: true, teamId: true },
  });
  if (!evidence) return null;
  try {
    const scope = await resolveEnforcementScopeForRequester({
      ownerUserId: evidence.ownerUserId,
      teamId: evidence.teamId ?? teamId,
    });
    await assertWorkspaceAllowsStorageGrowth({ scope, incomingBytes: 1n });
    return null;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "STORAGE_LIMIT_REACHED") {
      return { ok: false, status: 409, body: { denial: "STORAGE_LIMIT_REACHED" } };
    }
    throw err;
  }
}

export type RedactionPagePreviewAnswer =
  | { ok: true; state: "PENDING" }
  | {
      ok: true;
      state: "READY";
      url: string;
      width: number | null;
      height: number | null;
      expiresAtUtc: string;
      /** For the route's access record; never sent to the client. */
      evidenceId: string;
    }
  | { ok: true; state: "UNAVAILABLE"; reason: string }
  | { ok: false; status: 400 | 403 | 404 | 409; body: Record<string, unknown> };

type Enqueue = (previewId: string) => Promise<{ enqueued: boolean }>;

/**
 * THE producer of RenderRedactionPagePreview: the row id, through the
 * canonical enqueue. Never throws; a refused or timed-out enqueue leaves the
 * row QUEUED for the worker's reconciler.
 */
export async function enqueueRedactionPagePreviewRender(previewId: string): Promise<{ enqueued: boolean }> {
  const outcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW,
    commandId: previewId,
    traceId: "redaction_page_preview",
  });
  return { enqueued: outcome.enqueued };
}

export async function readRedactionPagePreview(input: {
  prisma?: PrismaClient;
  teamId: string;
  projectId: string;
  /** 0-based: the index a PDF_PAGE_RECT region stores. */
  pageIndex: number;
  actorUserId: string;
  /** Test seam; production uses the canonical enqueue. */
  enqueue?: Enqueue;
  presign?: typeof presignGetObject;
  now?: Date;
}): Promise<RedactionPagePreviewAnswer> {
  const prisma = input.prisma ?? defaultPrisma;
  const enqueue: Enqueue = input.enqueue ?? ((previewId) => enqueueRedactionPagePreviewRender(previewId));
  const presign = input.presign ?? presignGetObject;
  const now = input.now ?? new Date();

  if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0 || input.pageIndex >= REDACTION_PAGE_PREVIEW_MAX_PAGES) {
    return {
      ok: false,
      status: 400,
      body: { denial: "PREVIEW_PAGE_OUT_OF_RANGE", maxPages: REDACTION_PAGE_PREVIEW_MAX_PAGES },
    };
  }
  const project = await prisma.redactionProject.findFirst({
    where: { id: input.projectId, teamId: input.teamId },
    select: { id: true, evidenceId: true, artifactKind: true },
  });
  if (!project) return { ok: false, status: 404, body: { denial: "PROJECT_NOT_FOUND" } };
  // Caveat 4 (2026-11-20, DEC-05) — the preview is the record's own unredacted
  // content. Trash, destruction review and destruction end ordinary access to
  // the record, so they end it to its page images too (already-rendered ones
  // included), answered like a missing project.
  const readable = await prisma.evidence.count({
    where: {
      id: project.evidenceId,
      deletedAt: null,
      lifecycleState: { notIn: ["TRASHED", "PENDING_DESTRUCTION", "DESTROYED"] },
    },
  });
  if (readable === 0) return { ok: false, status: 404, body: { denial: "PROJECT_NOT_FOUND" } };
  if (project.artifactKind !== "PDF") {
    return { ok: false, status: 409, body: { denial: "UNSUPPORTED_REDACTION_MEDIA" } };
  }

  const where = { projectId_pageIndex: { projectId: project.id, pageIndex: input.pageIndex } };
  let row = await prisma.redactionPagePreview.findUnique({ where });

  if (!row) {
    // Rendering a page is new work on the current plan (PRO-089), like every
    // redaction write; a page already rendered stays readable.
    const entitled = await assertFeatureEntitlement({
      prisma,
      teamId: input.teamId,
      key: "FEATURE_REDACTION",
      actorUserId: input.actorUserId,
    });
    if (!entitled.ok) {
      return { ok: false, status: 403, body: { denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_REDACTION" } };
    }
    const storageRefusal = await previewStorageRefusal(prisma, input.teamId, project.evidenceId);
    if (storageRefusal) return storageRefusal;
    try {
      row = await prisma.redactionPagePreview.create({
        data: {
          teamId: input.teamId,
          projectId: project.id,
          evidenceId: project.evidenceId,
          pageIndex: input.pageIndex,
          state: "QUEUED",
        },
      });
    } catch (err) {
      // Two editors asked for the same page at once: the unique (project,
      // page) row is the other one's, and it is already queued.
      if ((err as { code?: string } | null)?.code !== "P2002") throw err;
      row = await prisma.redactionPagePreview.findUnique({ where });
      if (!row) throw err;
      return answerFor(row, presign, now);
    }
    await enqueue(row.id);
    return { ok: true, state: "PENDING" };
  }

  if (row.state === "QUEUED" && now.getTime() - row.updatedAt.getTime() > REQUEUE_QUEUED_AFTER_MS) {
    await enqueue(row.id);
  } else if (
    row.state === "FAILED" &&
    RETRYABLE_FAILURE_REASONS.has(row.failureReason ?? "") &&
    now.getTime() - row.updatedAt.getTime() > RETRY_FAILED_AFTER_MS
  ) {
    // A retry renders new bytes too: same storage gate as the first ask.
    const storageRefusal = await previewStorageRefusal(prisma, input.teamId, project.evidenceId);
    if (storageRefusal) return storageRefusal;
    const reset = await prisma.redactionPagePreview.updateMany({
      where: { id: row.id, state: "FAILED", updatedAt: row.updatedAt },
      data: { state: "QUEUED", renderStartedAt: null, failureReason: null },
    });
    if (reset.count === 1) await enqueue(row.id);
    return { ok: true, state: "PENDING" };
  }
  return answerFor(row, presign, now);
}

async function answerFor(
  row: {
    state: string;
    storageBucket: string | null;
    storageKey: string | null;
    width: number | null;
    height: number | null;
    failureReason: string | null;
    evidenceId: string;
  },
  presign: typeof presignGetObject,
  now: Date,
): Promise<RedactionPagePreviewAnswer> {
  if (row.state === "READY" && row.storageBucket && row.storageKey) {
    const url = await presign({
      bucket: row.storageBucket,
      key: row.storageKey,
      expiresInSeconds: REDACTION_PAGE_PREVIEW_URL_TTL_SECONDS,
      // Caveat 4 — the browser keeps no copy of the unredacted page once the
      // five-minute link lapses: a later look asks the route again, which
      // re-checks the viewer's role, workspace, case reach and the record.
      responseCacheControl: REDACTION_PAGE_PREVIEW_CACHE_CONTROL,
    });
    return {
      ok: true,
      state: "READY",
      url,
      width: row.width,
      height: row.height,
      expiresAtUtc: new Date(now.getTime() + REDACTION_PAGE_PREVIEW_URL_TTL_SECONDS * 1000).toISOString(),
      evidenceId: row.evidenceId,
    };
  }
  if (row.state === "FAILED" || row.state === "READY") {
    return { ok: true, state: "UNAVAILABLE", reason: row.failureReason ?? "preview_unavailable" };
  }
  return { ok: true, state: "PENDING" };
}
