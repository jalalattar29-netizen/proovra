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
