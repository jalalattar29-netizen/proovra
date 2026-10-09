/**
 * OPS-011 — THE BULK-ACTION ITEM STATUS CONTRACT, ONCE.
 *
 * The API's runner writes `BulkOperationalActionItemStatus` (PENDING,
 * COMPLETED, FAILED, SKIPPED). The web counted a target as moved only when its
 * status was "SUCCEEDED" — a word the API never writes — so every fully
 * successful bulk run was reported as "0 of N updated", while native read
 * COMPLETED correctly. Both clients now read this list and this predicate, and
 * an API unit test pins the list to the database enum.
 */
export const BULK_ACTION_ITEM_STATUSES = ["PENDING", "COMPLETED", "FAILED", "SKIPPED"] as const;
export type BulkActionItemStatus = (typeof BULK_ACTION_ITEM_STATUSES)[number];

/** Did the runner apply the action to this target? */
export function bulkActionItemSucceeded(status: string | null | undefined): boolean {
  return status === "COMPLETED";
}

/**
 * Nothing is left to do for this target: the action was applied, or the
 * runner skipped it because there was nothing to change. Only targets that are
 * NOT settled stay selected for a retry.
 */
export function bulkActionItemSettled(status: string | null | undefined): boolean {
  return status === "COMPLETED" || status === "SKIPPED";
}
