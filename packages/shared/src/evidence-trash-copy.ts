/**
 * ET-COM-02 (owner decision 2026-09-30) — trash does not free plan capacity.
 *
 * A trashed record is still stored and can be restored, so it keeps its place
 * in the plan's record allowance (and its original funding). Since the FREE
 * three-record contract (owner decision 2026-10-14) a FINALIZED record keeps
 * it for good: final purge does not return a slot either. Every trash confirmation — web and native, single and
 * bulk — says so with this one sentence, so the promise cannot drift between
 * surfaces or away from the rule the server enforces
 * (`allowanceSlotEvidenceWhere`, @proovra/shared-runtime).
 */
export const TRASH_KEEPS_PLAN_CAPACITY_COPY =
  "Deleting a record does not restore an evidence slot. A finalized record keeps its place in your plan's record allowance — Trash, the retention archive and final purge included.";

/**
 * TRASH -> RETENTION ARCHIVE -> PURGE (owner decision 2026-10-14) — what
 * deleting a record does over time, in the one sentence every deletion
 * confirmation (web and native, single and bulk) shows. It never says
 * "permanently deleted": nothing is purged while a retention period or legal
 * hold still applies.
 */
export const TRASH_LIFECYCLE_COPY =
  "The record stays in Trash for 90 days and can be restored there. After that it moves to the retention archive while its preservation requirements still apply, where it can still be restored. Evidence is preserved for eight years from sealing, longer under an Enterprise retention policy or a legal hold, and it cannot be permanently deleted before every retention period and legal hold ends.";

/**
 * The Retention Archive explainer (web and native). States the actual policy
 * (owner decision 2026-10-15): eight years from sealing, extended — never
 * shortened — by an Enterprise retention policy or a legal hold.
 */
export const RETENTION_ARCHIVE_EXPLAINER_COPY =
  "Records that left Trash while their retention protection still applies. Evidence is preserved for eight years from sealing, longer under an Enterprise retention policy or a legal hold. These records are preserved, not deleted, and cannot be permanently deleted before every retention period and legal hold ends.";

/**
 * The Billing allowance line for an account holding records in Trash: it says
 * why the held count is higher than the active library shows. `null` when
 * nothing is in Trash (or the server did not say).
 */
export function recordsInTrashAllowanceCopy(recordsInTrash: number | null | undefined): string | null {
  if (typeof recordsInTrash !== "number" || !Number.isFinite(recordsInTrash) || recordsInTrash <= 0) return null;
  const n = Math.floor(recordsInTrash);
  return `Includes ${n.toLocaleString()} record${n === 1 ? "" : "s"} in Trash — deleting a record does not restore an evidence slot.`;
}
