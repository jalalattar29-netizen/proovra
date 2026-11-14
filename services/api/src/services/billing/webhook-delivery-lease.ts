export const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;

export type WebhookDuplicateDisposition =
  | "DEDUPLICATE"
  | "RETRY_LATER"
  | "RECLAIM";

/**
 * A webhook id is not proof that its side effects finished. RECEIVED is a
 * short processing lease; after it expires, a provider redelivery may reclaim
 * the row left behind by a dead process. FAILED is immediately retryable and
 * only PROCESSED is a durable deduplication result.
 */
export function webhookDuplicateDisposition(input: {
  processingStatus?: string | null;
  receivedAt?: Date | null;
  now?: Date;
}): WebhookDuplicateDisposition {
  if (input.processingStatus === "PROCESSED") return "DEDUPLICATE";
  if (input.processingStatus === "FAILED") return "RECLAIM";

  const receivedAtMs = input.receivedAt?.getTime();
  const nowMs = (input.now ?? new Date()).getTime();
  if (
    input.processingStatus === "RECEIVED" &&
    receivedAtMs !== undefined &&
    nowMs - receivedAtMs < WEBHOOK_PROCESSING_LEASE_MS
  ) {
    return "RETRY_LATER";
  }

  return "RECLAIM";
}

/**
 * AUDIT F-06 (2026-11-14) — the final status write of a delivery is fenced by
 * the lease it claimed. `claimedAt` is the `receivedAt` this delivery wrote
 * when it created or reclaimed the row. A handler that stalled past
 * WEBHOOK_PROCESSING_LEASE_MS may have been reclaimed by a redelivery, which
 * rewrote `receivedAt`; the stale handler's PROCESSED/FAILED then matches no
 * row and leaves the reclaimer's outcome in place.
 */
export function webhookLeaseFence(claimedAt: Date): {
  processingStatus: "RECEIVED";
  receivedAt: Date;
} {
  return { processingStatus: "RECEIVED", receivedAt: claimedAt };
}
