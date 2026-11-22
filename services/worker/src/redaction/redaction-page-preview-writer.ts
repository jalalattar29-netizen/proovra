/**
 * PRO-R3-04 — the ONE redaction page-preview completion authority.
 *
 * Mirrors `redaction-derivative-writer.ts`: the claim and the READY/FAILED
 * transitions happen here and only here, with the DB state machine as the
 * arbiter.
 *   - claim: atomic QUEUED→RENDERING (or an expired RENDERING lease);
 *   - every later write matches the instant THIS claim stamped
 *     (`renderStartedAt`), so a worker whose lease was taken over can neither
 *     release, complete nor fail the render that replaced it;
 *   - READY refuses a key equal to the ORIGINAL object and a record that has
 *     left service.
 */

import { getWorkEntryOrThrow, JOB_NAMES } from "@proovra/shared";

import { prisma } from "../db.js";
import { derivedProductionRefusal } from "./redaction-derivative-writer.js";

export const REDACTION_PAGE_PREVIEW_LEASE_MS =
  getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW).claim?.leaseMs ?? 20 * 60 * 1000;

/** The `renderStartedAt` this claim stamped. */
export type PagePreviewClaimToken = Date;

export async function claimPagePreviewForRender(
  previewId: string,
): Promise<
  | {
      claimed: true;
      teamId: string;
      claimedAt: PagePreviewClaimToken;
      /**
       * closure3 review L1 — when the row last changed before this claim (the
       * previous claim stamp of a taken-over render, else its last update):
       * no earlier holder of the row wrote after it. Null when unknown.
       */
      priorActivityAt: Date | null;
    }
  | { claimed: false; reason: "not_found" | "not_queued" }
> {
  const row = await prisma.redactionPagePreview.findUnique({
    where: { id: previewId },
    select: { id: true, teamId: true, state: true, updatedAt: true, renderStartedAt: true },
  });
  if (!row) return { claimed: false, reason: "not_found" };
  const now = new Date();
  // The row must still be as read (it changed no later than the instant read,
  // compared by range: a SQL-written timestamp keeps microseconds), so the
  // prior activity returned is the row's real last change.
  const unchangedSince =
    row.updatedAt instanceof Date ? { updatedAt: { lt: new Date(row.updatedAt.getTime() + 1) } } : {};
  const res = await prisma.redactionPagePreview.updateMany({
    where: {
      id: previewId,
      ...unchangedSince,
      OR: [
        { state: "QUEUED" },
        { state: "RENDERING", renderStartedAt: { lt: new Date(now.getTime() - REDACTION_PAGE_PREVIEW_LEASE_MS) } },
      ],
    },
    data: { state: "RENDERING", renderStartedAt: now },
  });
  if (res.count !== 1) return { claimed: false, reason: "not_queued" };
  const priorActivityAt =
    row.state === "RENDERING" && row.renderStartedAt instanceof Date
      ? row.renderStartedAt
      : row.updatedAt instanceof Date
        ? row.updatedAt
        : null;
  return { claimed: true, teamId: row.teamId, claimedAt: now, priorActivityAt };
}

/** Give a claim back after a TRANSIENT failure, so the BullMQ retry can claim it. */
export async function releasePagePreviewClaim(
  previewId: string,
  claimedAt: PagePreviewClaimToken,
): Promise<boolean> {
  const res = await prisma.redactionPagePreview.updateMany({
    where: { id: previewId, state: "RENDERING", renderStartedAt: claimedAt },
    data: { state: "QUEUED", renderStartedAt: null },
  });
  return res.count === 1;
}

export async function markPagePreviewReadyWorker(input: {
  previewId: string;
  teamId: string;
  storageBucket: string;
  storageKey: string;
  byteSize: number;
  width: number;
  height: number;
  claimedAt: PagePreviewClaimToken;
  /** closure3 review L1 — a reconciler marker kept on the READY row (never shown). */
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.redactionPagePreview.findFirst({
    where: { id: input.previewId, teamId: input.teamId },
    select: { id: true, evidenceId: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  // IMMUTABILITY — a preview never points at the original object.
  const evidence = await prisma.evidence.findFirst({
    where: { id: row.evidenceId, teamId: input.teamId },
    select: { storageKey: true, storageBucket: true },
  });
  if (
    evidence &&
    evidence.storageBucket === input.storageBucket &&
    evidence.storageKey === input.storageKey
  ) {
    return { ok: false, reason: "original_object_collision" };
  }
  // A record that left service while the page rendered gains no READY preview.
  const leftService = await derivedProductionRefusal(row.evidenceId);
  if (leftService) return { ok: false, reason: leftService };
  const res = await prisma.redactionPagePreview.updateMany({
    where: { id: input.previewId, state: "RENDERING", renderStartedAt: input.claimedAt },
    data: {
      state: "READY",
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      byteSize: BigInt(input.byteSize),
      width: input.width,
      height: input.height,
      failureReason: input.note ?? null,
    },
  });
  if (res.count !== 1) return { ok: false, reason: "stale_transition" };
  return { ok: true };
}

export async function markPagePreviewFailedWorker(input: {
  previewId: string;
  teamId: string;
  failureReason: string;
  /** Absent only for a row that was never claimed: such a write fails a QUEUED row and nothing else. */
  claimedAt?: PagePreviewClaimToken;
  /** An object this render already stored, kept on the row so destruction finds it. */
  storedObject?: { bucket: string; key: string; byteSize: number };
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await prisma.redactionPagePreview.updateMany({
    where: input.claimedAt
      ? { id: input.previewId, teamId: input.teamId, state: "RENDERING", renderStartedAt: input.claimedAt }
      : { id: input.previewId, teamId: input.teamId, state: "QUEUED" },
    data: {
      state: "FAILED",
      failureReason: input.failureReason.slice(0, 120),
      ...(input.storedObject
        ? {
            storageBucket: input.storedObject.bucket,
            storageKey: input.storedObject.key,
            byteSize: BigInt(input.storedObject.byteSize),
          }
        : {}),
    },
  });
  if (res.count !== 1) return { ok: false, reason: "stale_transition" };
  return { ok: true };
}
