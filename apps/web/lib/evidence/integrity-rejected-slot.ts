/**
 * Free audit B4-F-001 — an integrity-rejected (FAILED_HASH_MISMATCH) record
 * with no report no longer occupies one of the plan's included records (the
 * Free meter shows 2/3 plus the failed record). Said on that record's view so
 * the owner knows what to do next. Only for a plan-funded record with no issued
 * report: a credit-funded one, or one whose report exists, is not described.
 */
export const INTEGRITY_REJECTED_SLOT_COPY =
  "This record failed its integrity check and does not use one of your included records. Capture it again as a new record; move this one to Trash to free its storage.";

export function integrityRejectedSlotNote(input: {
  status: string | null | undefined;
  recordFunding: string | null | undefined;
  reportAvailable: boolean;
}): string | null {
  if (input.status !== "FAILED_HASH_MISMATCH") return null;
  if (input.recordFunding !== "PLAN") return null;
  if (input.reportAvailable) return null;
  return INTEGRITY_REJECTED_SLOT_COPY;
}
