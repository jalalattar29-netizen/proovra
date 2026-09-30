/**
 * ET-COM-02 (owner decision 2026-09-30) — trash does not free plan capacity.
 *
 * A trashed record is still stored and can be restored, so it keeps its place
 * in the plan's record allowance (and its original funding) until it is
 * permanently destroyed. Every trash confirmation — web and native, single and
 * bulk — says so with this one sentence, so the promise cannot drift between
 * surfaces or away from the rule the server enforces
 * (`allowanceSlotEvidenceWhere`, @proovra/shared-runtime).
 */
export const TRASH_KEEPS_PLAN_CAPACITY_COPY =
  "Moving a record to trash does not free plan capacity. It keeps its place in your plan's record allowance until it is permanently destroyed.";

/**
 * The Billing allowance line for an account holding records in Trash: it says
 * why the held count is higher than the active library shows. `null` when
 * nothing is in Trash (or the server did not say).
 */
export function recordsInTrashAllowanceCopy(recordsInTrash: number | null | undefined): string | null {
  if (typeof recordsInTrash !== "number" || !Number.isFinite(recordsInTrash) || recordsInTrash <= 0) return null;
  const n = Math.floor(recordsInTrash);
  return `Includes ${n.toLocaleString()} record${n === 1 ? "" : "s"} in Trash — trash does not free plan capacity.`;
}
