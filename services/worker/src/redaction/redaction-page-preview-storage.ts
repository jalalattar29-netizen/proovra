/**
 * closure3/store (FV2-RESIDUAL-4 / NEW-RG-33-1, DEC-04 / DEC-16) — THE STORAGE
 * OF A REDACTION PAGE PREVIEW IS ADMITTED, DECLARED AND RECONCILED.
 *
 * A page preview is a stored PNG under the record's artifact lock (Object
 * Lock) that the canonical meter counts (`sumDerivedAssetStorageBytes`: every
 * `redaction_page_previews` row with a storage pointer, both hosts). It was
 * admitted check-then-write (`workspaceAllowsDerivedArtifact`, no reservation)
 * and counted only from READY, so:
 *   - two concurrent renders could jointly exceed the allowance;
 *   - an upload whose READY write failed (database down, claim taken over,
 *     the process died, the answer lost) left a locked object that nothing
 *     counted;
 *   - a retry re-uploaded the same content-addressed key, adding a second
 *     version that the row's one pointer did not count.
 *
 * The derived-asset intent table cannot hold a preview: its identity is an
 * evidence PART (NOT NULL) and both the reconciler's reference check and its
 * adoption work on `evidence_part_derived_assets` only. A preview intent there
 * would look unreferenced to an older reconciler image during a rollout,
 * which deletes an unlocked unreferenced version. The preview row therefore
 * is its own durable intent, with the same rules:
 *
 *   ADMIT (write-ahead): under the workspace capacity lock (the lock every
 *     storage admission takes), fenced on this render's claim, the row's
 *     pointer and size are written BEFORE any byte is sent, and the claim is
 *     renewed. From that commit the meter counts the bytes; no TTL ever stops
 *     counting them. Refused: FAILED `storage_limit`, nothing written.
 *   REUSE: a key that already holds versions is never written again (no
 *     second version); the row counts every stored version of its key.
 *   RESOLVE ONLY BY PROOF: a pointer leaves a row only when a listing of its
 *     key shows nothing stored (no version, no incomplete upload) after the
 *     holder's window closed (`reconcilePagePreviewStoragePointers`). Nothing
 *     here ever deletes an object, so a locked object is never deleted, and
 *     READY is written only after a successful PUT or a listing that proves
 *     the object exists.
 */
import type { PrismaClient } from "@prisma/client";
import {
  DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS,
  DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS,
  lockWorkspaceCapacityTx,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../db.js";
import type { DerivedObjectStore } from "../derived-storage-intent.js";
import { logger } from "../logger.js";
import { assertWorkspaceStorageAvailable, resolveWorkspaceScopeForEvidence } from "../workspace-billing.js";
import { REDACTION_PAGE_PREVIEW_LEASE_MS } from "./redaction-page-preview-writer.js";

type Client = PrismaClient;

/** How long a store listing of one preview key may take. */
const PREVIEW_STORE_CALL_MS = 60_000;
/** A preview PUT stops this long before the renewed claim could be taken over. */
export const PAGE_PREVIEW_WRITE_SAFETY_MARGIN_MS = DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS;
/** After a holder's window closed, how long before its pointer may be judged. */
export const PAGE_PREVIEW_POINTER_RECONCILE_GRACE_MS = DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS;

/** Bounded like the worker's other capacity-lock transactions. */
const ADMISSION_TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

class PreviewClaimLost extends Error {
  constructor() {
    super("page_preview_claim_lost");
  }
}

export type PagePreviewStorageStep =
  /** The key already holds the object: no upload; READY may be written with these bytes. */
  | { kind: "reuse"; bucket: string; key: string; byteSize: number; claimedAt: Date }
  /** Admitted and declared: upload now, before `writeDeadlineAt` (local epoch-ms). */
  | { kind: "write"; bucket: string; key: string; claimedAt: Date; writeDeadlineAt: number }
  | { kind: "refused"; reason: "storage_limit" | "evidence_not_found" }
  | { kind: "claim_lost" };

const sum = (versions: Array<{ sizeBytes: number }>) =>
  versions.reduce((n, v) => n + Math.max(0, Math.trunc(Number(v.sizeBytes) || 0)), 0);

/**
 * Before a page preview is uploaded: decide where it goes and hold its bytes.
 *
 * The target is the row's own pointer when it has one (an earlier attempt of
 * this row declared it), else the content-addressed key. The target is listed
 * first:
 *   - versions exist → REUSE: the claim is renewed and the row counts every
 *     stored version of the key (bytes that exist are counted, never refused);
 *   - nothing stored → ADMIT under the capacity lock: the row's own earlier
 *     declaration (proven empty) is dropped, the bytes are asserted against
 *     usage plus every reservation, and the pointer, the size and a renewed
 *     claim stamp are written in that one transaction.
 * An incomplete upload on the key, or a listing that fails, throws (the
 * caller releases the claim; the declaration keeps counting).
 */
export async function preparePagePreviewWrite(input: {
  previewId: string;
  teamId: string;
  evidenceId: string;
  claimedAt: Date;
  bucket: string;
  contentKey: string;
  bytes: number;
  store: DerivedObjectStore;
  client?: Client;
}): Promise<PagePreviewStorageStep> {
  const db = input.client ?? (defaultPrisma as unknown as Client);
  const row = await db.redactionPagePreview.findFirst({
    where: { id: input.previewId, teamId: input.teamId, state: "RENDERING", renderStartedAt: input.claimedAt },
    select: { storageBucket: true, storageKey: true },
  });
  if (!row) return { kind: "claim_lost" };
  const declared = row.storageBucket && row.storageKey ? { bucket: row.storageBucket, key: row.storageKey } : null;
  const target = declared ?? { bucket: input.bucket, key: input.contentKey };

  const signal = AbortSignal.timeout(PREVIEW_STORE_CALL_MS);
  const uploads = await input.store.listMultipartUploads(target, signal);
  if (uploads.length > 0) {
    const err: Error & { retriable?: boolean } = new Error("page_preview_key_has_incomplete_upload");
    err.retriable = true;
    throw err;
  }
  const versions = await input.store.listVersions(target, signal);
  const renewedAt = new Date();

  if (versions.length > 0) {
    const stored = sum(versions);
    const res = await db.redactionPagePreview.updateMany({
      where: { id: input.previewId, teamId: input.teamId, state: "RENDERING", renderStartedAt: input.claimedAt },
      data: { storageBucket: target.bucket, storageKey: target.key, byteSize: BigInt(stored), renderStartedAt: renewedAt },
    });
    if (res.count !== 1) return { kind: "claim_lost" };
    return { kind: "reuse", bucket: target.bucket, key: target.key, byteSize: stored, claimedAt: renewedAt };
  }

  const ev = await db.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { ownerUserId: true, teamId: true },
  });
  if (!ev) return { kind: "refused", reason: "evidence_not_found" };
  const scope = await resolveWorkspaceScopeForEvidence({ ownerUserId: ev.ownerUserId, teamId: ev.teamId });
  const fence = { id: input.previewId, teamId: input.teamId, state: "RENDERING", renderStartedAt: input.claimedAt };
  // The write deadline is measured from BEFORE the stamp is sent.
  const sentAt = Date.now();
  try {
    await db.$transaction(async (tx) => {
      await lockWorkspaceCapacityTx(tx as never, scope);
      // This row's own earlier declaration was just listed empty: it is not
      // counted against the bytes that replace it.
      const own = await tx.redactionPagePreview.updateMany({
        where: fence,
        data: { storageBucket: null, storageKey: null, byteSize: null },
      });
      if (own.count !== 1) throw new PreviewClaimLost();
      await assertWorkspaceStorageAvailable({ scope, incomingBytes: input.bytes, usageOptions: { client: tx as never } });
      const held = await tx.redactionPagePreview.updateMany({
        where: fence,
        data: { storageBucket: target.bucket, storageKey: target.key, byteSize: BigInt(input.bytes), renderStartedAt: renewedAt },
      });
      if (held.count !== 1) throw new PreviewClaimLost();
    }, ADMISSION_TRANSACTION);
  } catch (err) {
    if (err instanceof PreviewClaimLost) return { kind: "claim_lost" };
    if ((err as { code?: string }).code === "STORAGE_LIMIT_REACHED") {
      // Refused, nothing written. An earlier declaration of this row was
      // proven empty above: it stops counting (fenced on the same claim).
      if (declared) {
        await db.redactionPagePreview
          .updateMany({
            where: { ...fence, storageBucket: declared.bucket, storageKey: declared.key },
            data: { storageBucket: null, storageKey: null, byteSize: null },
          })
          .catch(() => undefined);
      }
      return { kind: "refused", reason: "storage_limit" };
    }
    throw err;
  }
  return {
    kind: "write",
    bucket: target.bucket,
    key: target.key,
    claimedAt: renewedAt,
    writeDeadlineAt: sentAt + REDACTION_PAGE_PREVIEW_LEASE_MS - PAGE_PREVIEW_WRITE_SAFETY_MARGIN_MS,
  };
}

/** Width and height from a PNG's IHDR (the first 24 bytes), or null. */
export function pngDimensions(head: Buffer | null | undefined): { width: number; height: number } | null {
  if (!head || head.length < 24) return null;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!head.subarray(0, 8).equals(signature) || head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export type PagePreviewPointerReconcileResult = {
  scanned: number;
  /** Pointers whose key was proven empty: the declaration stopped counting. */
  cleared: number;
  /** Pointers whose key holds versions: kept, sized to every stored version. */
  kept: number;
  /** Rows left as they were (an incomplete upload, a listing error, a fence lost). */
  skipped: number;
};

/**
 * THE RECONCILER of preview declarations. A row that is not READY but carries
 * a pointer (a render that declared its bytes and then failed, was released,
 * died, or lost its answer) is judged once its holder's window has closed:
 * the claim lease plus the grace after the last claim stamp (RENDERING) or
 * after the row's last change (QUEUED / FAILED). Its key is listed:
 *   - nothing stored (no version, no incomplete upload): the pointer is
 *     cleared, fenced on the row being exactly as it was read;
 *   - versions stored: the pointer is kept and the size becomes the sum of
 *     every stored version of the key (a lost answer that still landed, a
 *     second version, a version under Object Lock), fenced the same way;
 *   - anything else: nothing changes (still counted).
 * It never deletes an object and never writes READY.
 */
export async function reconcilePagePreviewStoragePointers(input: {
  store: DerivedObjectStore;
  client?: Client;
  limit?: number;
  graceMs?: number;
  now?: () => Date;
}): Promise<PagePreviewPointerReconcileResult> {
  const db = input.client ?? (defaultPrisma as unknown as Client);
  const now = (input.now?.() ?? new Date()).getTime();
  const closedBefore = new Date(now - REDACTION_PAGE_PREVIEW_LEASE_MS - (input.graceMs ?? PAGE_PREVIEW_POINTER_RECONCILE_GRACE_MS));
  const rows = await db.redactionPagePreview.findMany({
    where: {
      storageKey: { not: null },
      OR: [
        { state: { in: ["QUEUED", "FAILED"] }, updatedAt: { lt: closedBefore } },
        { state: "RENDERING", renderStartedAt: { lt: closedBefore } },
      ],
    },
    select: { id: true, state: true, updatedAt: true, renderStartedAt: true, storageBucket: true, storageKey: true, byteSize: true },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(500, Math.trunc(input.limit ?? 50))),
  });
  const result: PagePreviewPointerReconcileResult = { scanned: rows.length, cleared: 0, kept: 0, skipped: 0 };
  for (const row of rows) {
    if (!row.storageBucket || !row.storageKey) continue;
    const target = { bucket: row.storageBucket, key: row.storageKey };
    // Fenced on the row still being as judged: same state and pointer, and no
    // holder activity since the window closed (a claim, a retry reset or any
    // transition moves these past `closedBefore`). Compared by range, not by
    // exact instant: a timestamp written by SQL keeps microseconds the client
    // does not read back.
    const fence = {
      id: row.id,
      state: row.state,
      storageBucket: row.storageBucket,
      storageKey: row.storageKey,
      ...(row.state === "RENDERING" ? { renderStartedAt: { lt: closedBefore } } : { updatedAt: { lt: closedBefore } }),
    };
    try {
      const signal = AbortSignal.timeout(PREVIEW_STORE_CALL_MS);
      const uploads = await input.store.listMultipartUploads(target, signal);
      if (uploads.length > 0) {
        result.skipped += 1;
        continue;
      }
      const versions = await input.store.listVersions(target, signal);
      if (versions.length === 0) {
        const res = await db.redactionPagePreview.updateMany({
          where: fence,
          data: { storageBucket: null, storageKey: null, byteSize: null },
        });
        if (res.count === 1) result.cleared += 1;
        else result.skipped += 1;
        continue;
      }
      // Kept (counted). Writing the size also moves `updatedAt`, so a row
      // whose object exists is judged again only after another window.
      const res = await db.redactionPagePreview.updateMany({ where: fence, data: { byteSize: BigInt(sum(versions)) } });
      if (res.count === 1) result.kept += 1;
      else result.skipped += 1;
    } catch (err) {
      result.skipped += 1;
      logger.warn(
        { previewId: row.id, err: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
        "redaction_page_preview.storage_pointer_kept",
      );
    }
  }
  if (result.scanned > 0) logger.info(result, "redaction_page_preview.storage_pointers_reconciled");
  return result;
}
